#!/usr/bin/env node
/**
 * harness/tester.mjs — 2.79 (t): the game tester. An agent session (role qa-playtester, a vision-capable model) that plays
 * the game's real build in a real browser the way a player would, checks the Game Bible against what is actually in the
 * game, and reports with screenshots. The owner: "a genuine playtester (someone playing) ... they should work with the
 * line producer", "their runs shouldn't stop other parts of production. It's a test to be sure that the game bible is
 * being applied into actual gameplay and to catch what is/isn't in the game as well as gameplay bugs".
 *
 * Who starts it: the Line Producer (harness/line-producer.mjs testerPass, on the supervisor's loop), never a person by
 * hand: a run is due when BOTH STUDIO_TESTER_EVERY_HOURS (24) have passed since the last run (or since the tester's first
 * look) AND STUDIO_TESTER_MIN_LANDINGS (10) game landings (task.train.landed / lane.merged) happened since; or when anyone
 * asked (`npm run tester -- now`). STUDIO_TESTER=off stops the schedule (on demand still works). One run at a time.
 *
 * It never blocks production: it takes no machine:heavy slot and no train or gate slot, waits (never preempts) while the
 * machine is starved (the Line's rig check: CPU over STUDIO_LINE_CPU_BUSY_PCT, no RAM room) or while every gate slot is
 * taken, the train runs or waits, or a quiet hold is on. Its session gets its own seat (the launcher's extra allowance),
 * so a builder isn't displaced. Its verdicts hold nothing: no task hold, no gate, no blocked plan slice or landing. Its
 * output is information: a report, bug tasks (P1, deduplicated), one inbox item, one Studio Status line.
 *
 * A run:
 *   1. the harness picks a plan from a seeded RNG over the game's (mode, style, goal) (docs/TESTER.md), writes the brief
 *      (what landed since the last run, a rotating regression area, the Bible's features, every
 *      STUDIO_TESTER_COMPARE_EVERY (3)rd run the genre references) to .studio/tester/runs/<id>/brief.md;
 *   2. builds the game at the studio branch's commit in its own clean copy (.studio/tester-wt) as a normal child process
 *      (the game's "tester".build, else the cartridge's browser contract) and keeps the dist in the run folder;
 *   3. starts the agent through the launcher (harness/agent.mjs startAgent: a lane copy like a builder's; the tool from
 *      STUDIO_TESTER_TOOLS, default the studio's builder tool; "claude,agy" alternates runs between two model families);
 *   4. the agent drives the build with qa/tester-drive.mjs, writes report.md and summary.json, and runs
 *      `npm run tester -- finish` (a run whose session ended without it is finished on the next pass);
 *   5. finish publishes qa/reports/tester/<id>/ (report, summary.json, screenshots, action log), files each bug as a task
 *      (its images in studio/proof/<task>/ with the repro steps and the replay command), and tells the Producer, the
 *      Director and the orchestrator (studio/producer/INBOX.md, a tester.report event, a Studio Status notice).
 * Also (wirePass): a landed module no game code imports (a task.unwired note at its done-check) gets ONE follow-up "Wire
 * <module> into the game" task (P2, once per module; STUDIO_TESTER_WIRE_TASKS=off: none).
 *
 *   npm run tester -- status [--json]        last run, next due, last verdicts
 *   npm run tester -- now [--by <you>] [--seed <n>]   ask for a run (the Line starts it, or this does when no supervisor runs)
 *   npm run tester -- brief                  the current run's brief (the tester agent reads this first)
 *   npm run tester -- finish                 the tester agent's last step: publish, file bugs, notify
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent, readRecentEvents } from './event.mjs';
import { gameTesterConfig, DEFAULT_STYLES, DEFAULT_GOALS, DEFAULT_AREAS } from './tester-config.mjs';

export const TESTER_AGENT = 'game-tester';
export const TESTER_ROLE = 'qa-playtester';
export const STATUSES = ['working', 'broken', 'missing', 'not-reached'];
export const VERDICTS = ['green', 'amber', 'red'];
const OFF = /^(off|0|false|no)$/i;
const num = (v, d) => { const s = String(v ?? '').trim(); const n = Number(s); return s !== '' && Number.isFinite(n) ? n : d; };
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`); fs.renameSync(tmp, f); };
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true });

export const testerDir = (root) => path.join(root, '.studio', 'tester');
export const stateFile = (root) => path.join(testerDir(root), 'state.json');
export const runDir = (root, id) => path.join(testerDir(root), 'runs', id);
export const reportDir = (root, id) => path.join(root, 'qa', 'reports', 'tester', id);
const lockFile = (root) => path.join(testerDir(root), 'run.lock');

async function mainRootOf() { try { return (await import('./worktree.mjs')).mainRoot(); } catch { return REPO_ROOT; } }

/** The settings (all STUDIO_TESTER_*), read once per call. */
export function testerSettings(env = process.env) {
  const builder = String(env.STUDIO_BUILDER_TOOL || env.STUDIO_AGENT_TOOL || 'claude').trim() || 'claude';
  const tools = String(env.STUDIO_TESTER_TOOLS || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    on: !OFF.test(String(env.STUDIO_TESTER ?? '').trim()),
    everyHours: Math.max(0, num(env.STUDIO_TESTER_EVERY_HOURS, 24)),
    minLandings: Math.max(0, num(env.STUDIO_TESTER_MIN_LANDINGS, 10)),
    compareEvery: OFF.test(String(env.STUDIO_TESTER_COMPARE_EVERY ?? '').trim()) ? 0 : Math.max(0, Math.round(num(env.STUDIO_TESTER_COMPARE_EVERY, 3))),
    tools: tools.length ? tools : [builder],
    wireTasks: !OFF.test(String(env.STUDIO_TESTER_WIRE_TASKS ?? '').trim()),
    buildTimeoutMin: Math.max(1, num(env.STUDIO_TESTER_BUILD_TIMEOUT_MIN, 20)),
  };
}

export const readTesterState = (root) => readJson(stateFile(root), {}) || {};
export const writeTesterState = (root, s) => writeJson(stateFile(root), s);

/** Game landings since `since` (ms): [{ task, at }], one per task (a train landing names its lanes in meta.lanes). */
export function landingsSince(events, since = 0) {
  const out = new Map();
  for (const e of events || []) {
    const at = Date.parse(e.ts) || 0;
    if (at < since) continue;
    const ids = e.type === 'lane.merged' ? (e.task ? [String(e.task)] : []) : e.type === 'task.train.landed' ? (Array.isArray(e.meta?.lanes) ? e.meta.lanes.map((x) => String(typeof x === 'object' ? x?.task : x)) : e.task ? [String(e.task)] : []) : [];
    for (const id of ids) if (/^T-\d+$/.test(id) && !out.has(id)) out.set(id, { task: id, at: e.ts });
  }
  return [...out.values()];
}

/**
 * Is a run due? Pure. f: { on, now, ref (ms: the last run's start, else the first look), landings, everyHours,
 * minLandings, asked: { by, at } | null, running }. { due, why, next: { at, landingsNeeded } }.
 */
export function testerDue(f) {
  const nextAt = f.ref ? new Date(f.ref + f.everyHours * 3600000).toISOString() : null;
  const need = Math.max(0, (f.minLandings ?? 10) - (f.landings ?? 0));
  const next = { at: nextAt, landingsNeeded: need };
  if (f.running) return { due: false, why: 'a run is going (one at a time)', next };
  if (f.asked) return { due: true, why: `asked by ${f.asked.by || 'someone'} (npm run tester -- now)`, next };
  if (!f.on) return { due: false, why: 'STUDIO_TESTER=off: runs only on demand (npm run tester -- now)', next };
  const hours = f.ref ? (f.now - f.ref) / 3600000 : 0;
  if (hours < f.everyHours) return { due: false, why: `${Math.floor(hours)} of ${f.everyHours} h since the last run (STUDIO_TESTER_EVERY_HOURS), ${f.landings} of ${f.minLandings} landings`, next };
  if (need > 0) return { due: false, why: `${f.landings} of ${f.minLandings} game landings since the last run (STUDIO_TESTER_MIN_LANDINGS)`, next };
  return { due: true, why: `${Math.floor(hours)} h and ${f.landings} landings since the last run`, next };
}

/** A small seeded RNG (mulberry32): the same seed, the same plan. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const nameOf = (x) => (typeof x === 'string' ? x : x?.name || null);

/** The run's plan from the config's lists and a seed: { seed, mode, query, style, goal }. */
export function pickPlan(cfg = {}, seed = 1) {
  const r = mulberry32(seed);
  const pick = (a) => (a.length ? a[Math.floor(r() * a.length)] : null);
  const modes = cfg.modes?.length ? cfg.modes : [];
  const m = pick(modes);
  return { seed: seed >>> 0, mode: nameOf(m), query: m && typeof m === 'object' && typeof m.query === 'string' ? m.query : null, style: nameOf(pick(cfg.styles?.length ? cfg.styles : DEFAULT_STYLES)), goal: nameOf(pick(cfg.goals?.length ? cfg.goals : DEFAULT_GOALS)) };
}

/**
 * What the tester builds and plays: studio/game.json "tester", else the cartridge's browser contract (qa.mjs), said so.
 * { source, fallback?, build, dist, page, url, testids, modes, styles, goals, areas, copy? }.
 */
export async function testerConfig(root = REPO_ROOT) {
  const g = gameTesterConfig(root);
  const lists = (c) => ({ ...c, styles: c.styles?.length ? c.styles : DEFAULT_STYLES, goals: c.goals?.length ? c.goals : DEFAULT_GOALS, areas: c.areas?.length ? c.areas.map(nameOf) : DEFAULT_AREAS });
  if (g) return lists(g);
  const fallback = 'studio/game.json has no "tester" object, so the tester uses the cartridge\'s browser contract (qa.mjs); declare one for the real game (docs/TESTER.md)';
  try {
    const { loadCartridge } = await import('./cartridge.mjs');
    const cart = await loadCartridge();
    const b = cart?.browser || {};
    if (b.dist) return lists({ source: `cartridges/${cart.name}/qa.mjs browser { dist, build }`, fallback, build: b.build || null, dist: b.dist, page: b.distPage || 'index.html', url: null, testids: false, modes: [] });
    if (b.url) return lists({ source: `cartridges/${cart.name}/qa.mjs browser.url`, fallback, build: null, dist: null, page: null, url: b.url, testids: false, modes: [] });
    if (b.page) return lists({ source: `cartridges/${cart.name}/qa.mjs browser.page`, fallback, build: null, dist: null, page: b.page, url: null, testids: false, query: b.query || b.playQuery || '', copy: [path.dirname(b.page), `cartridges/${cart.name}`, 'assets/approved', 'public'], modes: [] });
  } catch { /* no cartridge */ }
  return lists({ source: 'none', fallback: `${fallback}; the cartridge declares no browser build either`, build: null, dist: null, page: null, url: null, testids: false, modes: [] });
}

/** The Game Bible's features (harness/bible.mjs readBible): kept layers, approved ideas, system specs, controls. */
export async function bibleFeatures() {
  const out = [];
  try {
    const bm = await import('./bible.mjs');
    const b = bm.readBible();
    if (b) {
      for (const l of bm.LAYERS) { const v = b.layers?.[l.id]; if (v?.answer === 'yes' || v?.answer === 'explore') out.push({ id: `layer:${l.id}`, name: l.label, kind: 'layer', phase: v.phase || null, note: v.answer === 'explore' ? 'explore' : '' }); }
      for (const i of bm.readIdeas().filter((x) => ['approved', 'scheduled'].includes(x.stage))) out.push({ id: `idea:${i.id}`, name: i.title, kind: 'idea', phase: i.place?.phase || null });
    }
    const sys = path.join(bm.BIBLE_DIR, 'systems');
    if (fs.existsSync(sys)) for (const f of fs.readdirSync(sys).filter((n) => n.endsWith('.md') && n !== 'README.md').sort()) {
      const head = (fs.readFileSync(path.join(sys, f), 'utf8').match(/^#\s+(.+)$/m) || [])[1];
      out.push({ id: `system:${f.replace(/\.md$/, '')}`, name: head || f, kind: 'system', phase: null });
    }
    const c = readJson(path.join(bm.BIBLE_DIR, 'controls.json'), null);
    for (const x of Array.isArray(c?.controls) ? c.controls : []) if (x?.id) out.push({ id: `control:${x.id}`, name: x.name || x.id, kind: 'control', phase: null });
  } catch { /* no Bible */ }
  return out;
}

/** The Bible's genre references: its references answer, REFERENCES.md and studio/references/ (file names). */
export async function bibleReferences(root = REPO_ROOT) {
  const out = [];
  try {
    const bm = await import('./bible.mjs');
    const b = bm.readBible();
    const r = b?.answers?.references;
    for (const x of Array.isArray(r) ? r : String(r || '').split('\n')) if (String(x).trim()) out.push(`Bible: ${String(x).trim()}`);
    const md = path.join(bm.BIBLE_DIR, 'REFERENCES.md');
    if (fs.existsSync(md)) out.push('studio/bible/REFERENCES.md');
  } catch {}
  const d = path.join(root, 'studio', 'references');
  try { for (const f of fs.readdirSync(d).filter((n) => !/^(APPROVALS|README)\.md$/i.test(n)).sort().slice(0, 40)) out.push(`studio/references/${f}`); } catch {}
  return out;
}

/** The landed tasks' titles and plan items, from their task.added events. */
export function landedFeatures(landed, events) {
  const added = new Map((events || []).filter((e) => e.type === 'task.added' && e.task).map((e) => [e.task, e]));
  return landed.map((l) => {
    const a = added.get(l.task);
    const title = String(a?.msg || '').replace(/^Queued T-\d+ \[[^\]]*\] \([^)]*\):\s*/, '') || '(title not in the recent events)';
    const m = a?.meta || {};
    const plan = [m.phase ? `phase ${m.phase}` : '', m.serves || '', m.idea ? `idea ${m.idea}` : '', m.slice ? `slice ${m.slice}` : ''].filter(Boolean).join(', ');
    return { task: l.task, title, plan, at: l.at };
  });
}

/** The brief the tester agent reads first. */
export function testerBrief(r) {
  const L = [`# Game tester run ${r.id}`, '', '> Written by harness/tester.mjs. You are the studio\'s game tester: play the real build in a real browser the way a player would, and report what is and isn\'t in the game, with screenshots. You write a report and a summary; the harness files your bugs as tasks and tells the Producer, the Director and the orchestrator. Never edit game code, the Bible, the board, a check or the harness.', ''];
  L.push('## Your run', `- Run folder: \`${r.dir}\` (everything you write goes here)`, r.url ? `- The game: ${r.url} (the game's own server)` : `- The build: \`${r.dist}\`${r.page ? `, page \`${r.page}\`` : ''} (from ${r.source}${r.sha ? ` at ${r.sha.slice(0, 8)}` : ''})`);
  if (r.fallback) L.push(`- Note: ${r.fallback}.`);
  L.push(`- Plan (seed ${r.plan.seed}; repeat it with \`npm run tester -- now --seed ${r.plan.seed}\`): start mode **${r.plan.mode || 'the default start'}**${r.plan.query ? ` (\`open --query "${r.plan.query}"\`)` : ''}, play style **${r.plan.style}**, goal **${r.plan.goal}**. Play that way; try what a player of that style would try, not a script.`, `- Data-testids: ${r.testids ? 'the game marks its controls with data-testid: click by --testid first' : 'not declared: click by --text or --xy'}`, '');
  L.push('## 1. New since the last run (test these first)', ...(r.landed.length ? r.landed.map((f) => `- ${f.task}: ${f.title}${f.plan ? ` (${f.plan})` : ''}`) : ['- Nothing landed since the last run: spend the time on the regression area and the Bible.']), '');
  L.push(`## 2. Regression area this run: **${r.area}**`, `Areas rotate run by run over: ${r.areas.join(', ')}. Grade each area you reached green (playable), amber (playable with problems) or red (not playable).`, '');
  L.push('## 3. The Game Bible: is it in the game?', 'For each feature, say in summary.json "bible" whether it is `working` (in the game and working), `broken` (in the game but broken), `missing` (not in the game) or `not-reached` (not reached this run), with a screenshot for every working or broken one.', ...(r.bible.length ? r.bible.map((b) => `- \`${b.id}\` ${b.name}${b.phase ? ` (phase ${b.phase})` : ''}${b.note ? ` [${b.note}]` : ''}`) : ['- The Bible lists no features yet (studio/bible/bible.json): say so in the report.']), '');
  if (r.compare) L.push('## 4. Compare with the genre (this run)', 'Put the game\'s screens and flows next to the Bible\'s references and list where it drifts from the Bible or misses what the genre expects: under "## Compared with the genre" in report.md and as "compare" (a list of lines) in summary.json.', ...(r.references.length ? r.references.map((x) => `- ${x}`) : ['- No references are listed in the Bible: say so.']), '');
  L.push('## How to play (one command per call; the driver keeps the browser open between calls)', '```', 'node qa/tester-drive.mjs serve', `node qa/tester-drive.mjs open${r.plan.query ? ` --query "${r.plan.query}"` : ''}`, 'node qa/tester-drive.mjs click --testid <id>      (or --text "<label>", or --xy 640,360)', 'node qa/tester-drive.mjs key Space --times 3', 'node qa/tester-drive.mjs drag --from 100,100 --to 300,200', 'node qa/tester-drive.mjs wait 2000', 'node qa/tester-drive.mjs shot <name>             saves shots/<name>.png: open it with your file reader and look at it', 'node qa/tester-drive.mjs console                 page errors and console errors since the page opened', 'node qa/tester-drive.mjs state                   window.__sim / window.__view, when the game exposes them', 'node qa/tester-drive.mjs close', '```', 'Every action is logged with its step number in actions.jsonl. A bug names the step where it shows; `node qa/tester-drive.mjs replay <run folder>/actions.jsonl --to <step>` replays the run to it and takes a screenshot (the repro).', '');
  L.push('## What to write, then finish', '1. `report.md` in the run folder: what you did, what you saw, a verdict per area, each Bible feature\'s status, the bugs.', '2. `summary.json` in the run folder:', '```json', JSON.stringify({ verdicts: Object.fromEntries(r.areas.slice(0, 2).map((a) => [a, 'green|amber|red'])), bible: { [r.bible[0]?.id || 'layer:<id>']: { status: 'working|broken|missing|not-reached', shot: 'shots/<name>.png', note: '…' } }, bugs: [{ title: 'what a player sees go wrong, in a few words', area: r.area, step: 12, steps: ['open --query …', 'click --testid …'], expected: '…', actual: '…', images: ['shots/<name>.png'] }], ...(r.compare ? { compare: ['…'] } : {}) }, null, 2), '```', '3. `npm run tester -- finish`: it publishes the report, files each bug as a task (P1, with your steps, the replay command and the images) and tells the Producer, the Director and the orchestrator. Then stop.');
  return `${L.join('\n')}\n`;
}

/** A gate slot free now (machine:heavy below its slots, no train running or waiting, no quiet hold): { free, why }. */
export async function gateSlotFree(root, env = process.env) {
  try {
    const h = await import('./heavy.mjs');
    if ((await import('./train-daemon.mjs')).trainLockHeld(root, env)) return { free: false, why: 'the merge train is running' };
    if (h.trainWaiting(root, { env })) return { free: false, why: 'the merge train waits for a slot' };
    if (h.quietHolding(root)) return { free: false, why: 'a quiet hold is on (a flake re-run or a chain-breaker push)' };
    let profile = null;
    try { profile = (await import('./heavy-budget.mjs')).machineProfile(root, { env }); } catch {}
    const slots = h.heavySlotsAt(root, env, profile);
    const used = h.heavyHolders(root, { env }).length + h.laneChecksRunning(root, env);
    if (slots > 0 && used >= slots) return { free: false, why: `every gate slot is taken (${used} of ${slots})` };
    return { free: true, why: slots > 0 ? `${used} of ${slots} gate slots taken` : 'no slot limit' };
  } catch (e) { return { free: false, why: `the slots couldn't be read (${e.message})` }; }
}

/** The machine is starved (the Line's rig check): { starved, why }. */
export function starvedRig(rig) {
  if (!rig) return { starved: false, why: 'no rig reading' };
  if (rig.cpuHold) return { starved: true, why: `CPU ${Math.round((rig.cpuBusy || 0) * 100)}% busy (STUDIO_LINE_CPU_BUSY_PCT)` };
  if (rig.known && Number.isFinite(rig.byRam) && rig.byRam <= 0) return { starved: true, why: 'no RAM room for another session' };
  return { starved: false, why: '' };
}

function takeLock(root, id, { stale = false } = {}) {
  fs.mkdirSync(testerDir(root), { recursive: true });
  if (stale) { try { fs.rmSync(lockFile(root), { force: true }); } catch {} }
  try { const fd = fs.openSync(lockFile(root), 'wx'); fs.writeSync(fd, JSON.stringify({ pid: process.pid, run: id, at: new Date().toISOString() })); fs.closeSync(fd); return true; } catch { return false; }
}
const dropLock = (root) => { try { fs.rmSync(lockFile(root), { force: true }); } catch {} };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Start a run: the plan, the brief, the build (a child process; inline: here, waiting). Returns the run record. */
export async function startRun({ root, env = process.env, now = Date.now(), by = 'line-producer', seed = null, inline = false, deps = {} } = {}) {
  const st = readTesterState(root);
  const n = (Number(st.runs) || 0) + 1;
  const id = `${new Date(now).toISOString().slice(0, 10)}-r${n}`;
  if (!takeLock(root, id)) {
    // A lock left by a process that died before it recorded its run (no run going, the lock's process gone) is freed.
    const l = readJson(lockFile(root), null);
    if (st.current || (l && alive(l.pid) && l.pid !== process.pid) || !takeLock(root, id, { stale: true })) return { error: 'another run is starting or going (.studio/tester/run.lock)' };
  }
  try {
    const s = testerSettings(env);
    const cfg = deps.config || await testerConfig(root);
    const sd = Number.isFinite(Number(seed)) && seed !== null ? Number(seed) >>> 0 : crypto.randomBytes(4).readUInt32BE(0);
    const plan = pickPlan(cfg, sd);
    const areas = cfg.areas;
    const area = areas[(Number(st.areaIdx) || 0) % areas.length];
    const events = deps.events || readRecentEvents(20000);
    const since = Date.parse(st.last?.at || '') || 0;
    const landed = landedFeatures(landingsSince(events, since), events);
    const compare = s.compareEvery > 0 && n % s.compareEvery === 0;
    const dir = runDir(root, id);
    fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
    const sha = (deps.sha !== undefined ? deps.sha : git(root, 'rev-parse', 'HEAD').stdout.trim()) || null;
    const pickTool = s.tools[(n - 1) % s.tools.length];
    const [tool, ...mm] = pickTool.split(':');
    const run = { id, n, at: new Date(now).toISOString(), by, plan, area, areas, compare, sha, tool, model: mm.join(':') || null, source: cfg.source, fallback: cfg.fallback || null, url: cfg.url || null, page: cfg.url ? null : cfg.page || 'index.html', dist: cfg.url ? null : path.join(dir, 'dist'), testids: Boolean(cfg.testids), dir, landed, bible: deps.bible || await bibleFeatures(), references: compare ? (deps.references || await bibleReferences(root)) : [] };
    writeJson(path.join(dir, 'run.json'), { ...run, config: { build: cfg.build || null, dist: cfg.dist || null, url: cfg.url || null, copy: cfg.copy || null } });
    fs.writeFileSync(path.join(dir, 'brief.md'), testerBrief(run));
    const next = { ...st, runs: n, areaIdx: (Number(st.areaIdx) || 0) + 1, asked: null, current: { id, n, at: run.at, phase: 'building', dir, tool, model: run.model, by } };
    if (!cfg.url && (cfg.build || cfg.dist || cfg.copy)) {
      if (inline || deps.inlineBuild) { await buildRun(root, id, env); }
      else {
        const child = (deps.spawnBuild || spawnBuild)(root, id, env);
        next.current.buildPid = child?.pid || null;
      }
    } else if (cfg.url) writeJson(path.join(dir, 'build.json'), { ok: true, why: `the game's own server (${cfg.url})`, at: new Date().toISOString() });
    else writeJson(path.join(dir, 'build.json'), { ok: false, why: cfg.fallback || 'no build declared', at: new Date().toISOString() });
    writeTesterState(root, next);
    emitEvent({ type: 'tester.started', agent: TESTER_AGENT, msg: `Game tester run ${id} started (${by}): ${plan.mode || 'default start'}, ${plan.style}, ${plan.goal}; area ${area}; ${landed.length} feature(s) landed since the last run`, meta: { run: id, plan, area, compare } });
    return { ok: true, run: next.current };
  } catch (e) { dropLock(root); return { error: e.message }; }
}

/** `node harness/tester.mjs build --run <id>`, detached, its output in the run's build.log. */
export function spawnBuild(root, id, env = process.env) {
  const dir = runDir(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(path.join(dir, 'build.log'), 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'build', '--run', id], { cwd: root, env: { ...env, STUDIO_MAIN_ROOT: root }, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  child.unref();
  try { fs.closeSync(fd); } catch {}
  return { pid: child.pid };
}

/** Build the game at the run's commit in the tester's own clean copy and keep its dist in the run folder. */
export async function buildRun(root, id, env = process.env) {
  const dir = runDir(root, id);
  const run = readJson(path.join(dir, 'run.json'), {});
  const cfg = run.config || {};
  const t0 = Date.now();
  const done = (ok, why, extra = {}) => { const r = { ok, why, ms: Date.now() - t0, at: new Date().toISOString(), ...extra }; writeJson(path.join(dir, 'build.json'), r); return r; };
  let tree = root;
  if (run.sha) {
    let r = null;
    try { r = (await import('./whole-game.mjs')).wholeCopy(run.sha, root, { name: 'tester-wt', exclude: 'tester' }); } catch (e) { r = { error: e.message }; }
    if (!r?.dir) return done(false, `the clean copy at ${String(run.sha).slice(0, 8)} couldn't be made: ${r?.error || 'unknown'}`);
    tree = r.dir;
  }
  if (cfg.build) {
    const b = spawnSync(cfg.build, { cwd: tree, shell: true, encoding: 'utf8', windowsHide: true, timeout: testerSettings(env).buildTimeoutMin * 60000, maxBuffer: 64 * 1024 * 1024, env: { ...env, CI: 'true' } });
    try { fs.appendFileSync(path.join(dir, 'build.log'), `$ ${cfg.build}\n${b.stdout || ''}${b.stderr || ''}\n`); } catch {}
    if (b.status !== 0) return done(false, b.error?.code === 'ETIMEDOUT' ? `the build ran past STUDIO_TESTER_BUILD_TIMEOUT_MIN` : `the build failed (exit ${b.status}): ${String(b.stderr || b.stdout || '').trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`);
  }
  const dest = path.join(dir, 'dist');
  fs.rmSync(dest, { recursive: true, force: true });
  if (cfg.dist) {
    const src = path.join(tree, cfg.dist);
    if (!fs.existsSync(src)) return done(false, `the build made no ${cfg.dist}`);
    fs.cpSync(src, dest, { recursive: true });
  } else if (Array.isArray(cfg.copy)) {
    for (const part of cfg.copy) { const src = path.join(tree, part); if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, part), { recursive: true, filter: (f) => !/[\\/](node_modules|\.git)$/.test(f) }); }
  }
  return done(true, `built${cfg.build ? ` with "${cfg.build}"` : ''} at ${String(run.sha || 'the working tree').slice(0, 8)}`);
}

/** Start the tester agent for a built run (the launcher: a lane copy like a builder's, its own seat). */
export async function launchRun(root, st, { env = process.env, deps = {} } = {}) {
  const cur = st.current;
  const ag = deps.agent || await import('./agent.mjs');
  const agent = ag.nextAgentName(TESTER_ROLE);
  const r = ag.startAgent({ role: TESTER_ROLE, agent, tool: cur.tool, ...(cur.model ? { model: cur.model } : {}), note: `Game tester run ${cur.id}: read your brief first (npm run tester -- brief), play, write report.md and summary.json in ${cur.dir}, then npm run tester -- finish.`, by: 'harness (game tester)', extra: 1 }, { detach: true });
  if (!r?.ok) return { started: false, why: String(r?.message || 'not started').replace(/^Not started: /, '') };
  writeTesterState(root, { ...st, current: { ...cur, phase: 'playing', agent: r.agent || agent, launchedAt: new Date().toISOString() } });
  emitEvent({ type: 'tester.launched', agent: TESTER_AGENT, msg: `Game tester run ${cur.id}: ${r.agent || agent} plays the build (${r.tool || cur.tool}${r.model && r.model !== 'unknown' ? `, ${r.model}` : ''})`, meta: { run: cur.id, agent: r.agent || agent, tool: r.tool || cur.tool } });
  return { started: true, agent: r.agent || agent };
}

const normTitle = (t) => String(t || '').trim().replace(/^(bug|fix)\s*:\s*/i, '').replace(/\s+/g, ' ').toLowerCase();

/** summary.json, normalized: { verdicts, bible, bugs, compare, problems: [] }. */
export function readSummary(dir) {
  const raw = readJson(path.join(dir, 'summary.json'), null);
  const problems = [];
  if (!raw || typeof raw !== 'object') return { verdicts: {}, bible: {}, bugs: [], compare: [], problems: ['the tester wrote no summary.json'], missing: true };
  const verdicts = {};
  for (const [k, v] of Object.entries(raw.verdicts || {})) { const w = String(v || '').toLowerCase(); if (VERDICTS.includes(w)) verdicts[k] = w; else problems.push(`verdict "${v}" for ${k} isn't green, amber or red`); }
  const bible = {};
  for (const [k, v] of Object.entries(raw.bible || {})) { const s = String((v && typeof v === 'object' ? v.status : v) || '').toLowerCase(); if (STATUSES.includes(s)) bible[k] = { status: s, ...(v?.shot ? { shot: String(v.shot) } : {}), ...(v?.note ? { note: String(v.note).slice(0, 300) } : {}) }; else problems.push(`Bible status "${s}" for ${k}`); }
  const bugs = (Array.isArray(raw.bugs) ? raw.bugs : []).filter((b) => b && String(b.title || '').trim()).map((b) => ({ title: String(b.title).trim().slice(0, 140), area: b.area ? String(b.area) : null, step: Number.isInteger(Number(b.step)) ? Number(b.step) : null, steps: (Array.isArray(b.steps) ? b.steps : []).map(String).slice(0, 30), expected: b.expected ? String(b.expected).slice(0, 400) : '', actual: b.actual ? String(b.actual).slice(0, 400) : '', images: (Array.isArray(b.images) ? b.images : []).map(String).filter((x) => !/^[a-z]+:\/\//i.test(x)).slice(0, 6) }));
  return { verdicts, bible, bugs, compare: (Array.isArray(raw.compare) ? raw.compare : []).map(String).slice(0, 40), problems };
}

/** The image a summary names, inside the run folder only (a path outside it is ignored). */
function runFile(dir, p) {
  const f = path.resolve(dir, String(p || ''));
  return f.startsWith(path.resolve(dir) + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : null;
}

/** File one bug as a task (deduplicated against open tasks with the same title): { task, duplicate, proof }. */
export async function fileBug(root, bug, run, { deps = {} } = {}) {
  const tm = deps.task || await import('./task.mjs');
  const board = tm.parseNextQueue();
  const open = [...(board.inProgress || []), ...(board.backlog || [])];
  const same = open.find((t) => normTitle(t.title) === normTitle(bug.title));
  if (same) return { task: same.id, duplicate: true };
  const title = /^(bug|fix)\b/i.test(bug.title) ? bug.title : `Bug: ${bug.title}`;
  const replay = `node qa/tester-drive.mjs replay qa/reports/tester/${run.id}/actions.jsonl${bug.step ? ` --to ${bug.step}` : ''}`;
  const r = tm.addTask({ title, role: 'builder', priority: 'P1', agent: TESTER_AGENT, meta: { promoted: true, origin: 'game-tester', testerRun: run.id, ...(bug.area ? { area: bug.area } : {}), scope: `Found by the game tester (run ${run.id}). ${bug.actual ? `Actual: ${bug.actual}. ` : ''}${bug.expected ? `Expected: ${bug.expected}. ` : ''}Repro: ${replay}`.slice(0, 600), replay } });
  if (!r?.id || r.error) return { error: r?.message || r?.error || 'not added' };
  if (r.duplicate) return { task: r.id, duplicate: true };
  const proof = path.join(root, 'studio', 'proof', r.id);
  fs.mkdirSync(proof, { recursive: true });
  const imgs = [];
  for (const p of bug.images) { const f = runFile(run.dir, p); if (f) { const d = path.join(proof, path.basename(f)); fs.copyFileSync(f, d); imgs.push(rel(root, d)); } }
  const md = [`# ${r.id}: ${title}`, '', `Found by the game tester, run ${run.id} (report: qa/reports/tester/${run.id}/report.md).`, '', bug.area ? `Area: ${bug.area}` : '', bug.actual ? `Actual: ${bug.actual}` : '', bug.expected ? `Expected: ${bug.expected}` : '', '', '## Repro steps', ...(bug.steps.length ? bug.steps.map((s, i) => `${i + 1}. ${s}`) : ['(none written: see the action log)']), '', '## Replay', '```', replay, '```', '', '## Images', ...(imgs.length ? imgs.map((x) => `- ${x}`) : ['- none']), ''].filter((l, i, a) => l !== '' || a[i - 1] !== '');
  fs.writeFileSync(path.join(proof, `tester-${run.id}.md`), `${md.join('\n')}\n`);
  return { task: r.id, duplicate: false, proof: rel(root, path.join(proof, `tester-${run.id}.md`)), images: imgs };
}

/** One inbox item (Producer, Director, orchestrator), one tester.report event, one Studio Status line. */
export async function notifyRun(root, s, { deps = {} } = {}) {
  let orch = 'the orchestrator';
  try { const c = (await import('./communicator.mjs')).readCommConfig(root); orch = c.agents?.orchestrator || (c.names?.orchestrator ? `@${c.names.orchestrator}` : orch); } catch {}
  const v = Object.entries(s.verdicts);
  const counts = STATUSES.map((k) => [k, Object.values(s.bible).filter((b) => b.status === k).length]).filter(([, c]) => c).map(([k, c]) => `${c} ${k}`).join(', ');
  const bugs = s.bugs.filter((b) => b.task);
  const line = `Game tester run ${s.run} (${s.tool || 'agent'}): ${v.length ? v.map(([a, x]) => `${a} ${x}`).join(', ') : 'no verdicts'}; ${bugs.length} bug${bugs.length === 1 ? '' : 's'}${bugs.length ? ` (${bugs.map((b) => `${b.task}${b.duplicate ? ' (open already)' : ''}`).join(', ')})` : ''}; Bible: ${counts || 'not graded'}. Report: ${s.report}`;
  const f = path.join(root, 'studio', 'producer', 'INBOX.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, '# Producer inbox\n\n> Messages from people in the War Room. The Producer reads new ones in its briefing (`npm run handoff`).\n\n');
  fs.appendFileSync(f, `- [${new Date().toISOString().slice(0, 16).replace('T', ' ')}] **game tester** (to the Producer, the Director and ${orch}): ${line.replace(/\n+/g, ' ')}\n`);
  emitEvent({ type: 'tester.report', agent: TESTER_AGENT, to: 'producer', status: v.some(([, x]) => x === 'red') ? 'warn' : undefined, msg: line.slice(0, 600), meta: { cc: ['director', orch], run: s.run, verdicts: s.verdicts, report: s.report, bugs: bugs.map((b) => b.task) } });
  try { (deps.queueNotice || (await import('./comm-notice.mjs')).queueNotice)({ key: `tester:${s.run}`, kind: 'tester', text: `${line} (for the Producer, the Director and ${orch})`, root }); } catch {}
  return line;
}

/** Finish a run: publish the report, file the bugs, notify, free the lock. Idempotent. */
export async function finishRun({ root, id = null, by = TESTER_AGENT, env = process.env, deps = {} } = {}) {
  void env;
  const st = readTesterState(root);
  const runId = id || st.current?.id;
  if (!runId) return { error: 'no run is going' };
  const dir = runDir(root, runId);
  const run = readJson(path.join(dir, 'run.json'), null);
  if (!run) return { error: `no run ${runId}` };
  if (run.finished) return { ok: true, already: true, summary: readJson(path.join(reportDir(root, runId), 'summary.json'), null) };
  try { spawnSync(process.execPath, [path.join(root, 'qa', 'tester-drive.mjs'), 'close', '--run', dir], { cwd: root, windowsHide: true, timeout: 15000 }); } catch {}
  const build = readJson(path.join(dir, 'build.json'), null);
  const sm = readSummary(dir);
  if (build && !build.ok) { sm.problems.unshift(`the build failed: ${build.why}`); for (const a of run.areas) sm.verdicts[a] ||= 'red'; }
  const out = reportDir(root, runId);
  fs.mkdirSync(out, { recursive: true });
  for (const f of ['report.md', 'actions.jsonl', 'brief.md', 'build.json', 'run.json']) if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(out, f));
  if (fs.existsSync(path.join(dir, 'shots'))) fs.cpSync(path.join(dir, 'shots'), path.join(out, 'shots'), { recursive: true });
  if (!fs.existsSync(path.join(out, 'report.md'))) fs.writeFileSync(path.join(out, 'report.md'), `# Game tester run ${runId}\n\nThe tester wrote no report.${sm.problems.length ? `\n\n${sm.problems.map((p) => `- ${p}`).join('\n')}` : ''}\n`);
  const runRec = { id: runId, dir };
  for (const b of sm.bugs) { try { Object.assign(b, await fileBug(root, b, runRec, { deps })); } catch (e) { b.error = e.message; } }
  const summary = { run: runId, at: new Date().toISOString(), by, tool: run.tool, plan: run.plan, area: run.area, verdicts: sm.verdicts, bible: sm.bible, bugs: sm.bugs, compare: sm.compare, problems: sm.problems, report: `qa/reports/tester/${runId}/report.md` };
  writeJson(path.join(out, 'summary.json'), summary);
  writeJson(path.join(dir, 'run.json'), { ...run, finished: summary.at });
  await notifyRun(root, summary, { deps });
  const now = readTesterState(root);
  writeTesterState(root, { ...now, current: now.current?.id === runId ? null : now.current, last: { id: runId, at: run.at, endedAt: summary.at, tool: run.tool, verdicts: summary.verdicts, report: summary.report, bugs: sm.bugs.map((b) => b.task).filter(Boolean) } });
  dropLock(root);
  return { ok: true, summary };
}

/**
 * One look (the Line Producer's pass): advance the run that is going, or start one that is due when the machine and a
 * gate slot allow. act false: only says what it would do. Never takes a slot, holds a task or stops anything.
 */
export async function testerPass({ root, now = Date.now(), env = process.env, act = true, rig = null, inline = false, deps = {} } = {}) {
  root ||= await mainRootOf();
  const s = testerSettings(env);
  let st = readTesterState(root);
  if (!st.since && act) { st = { ...st, since: new Date(now).toISOString() }; writeTesterState(root, st); }
  const cur = st.current;
  if (cur) {
    if (cur.phase === 'building') {
      const b = readJson(path.join(cur.dir, 'build.json'), null);
      if (!b) {
        if (cur.buildPid && alive(cur.buildPid) && now - Date.parse(cur.at) < (s.buildTimeoutMin + 5) * 60000) return { state: 'building', run: cur.id, line: `tester: run ${cur.id} building` };
        if (act) writeJson(path.join(cur.dir, 'build.json'), { ok: false, why: 'the build process ended without a result', at: new Date(now).toISOString() });
        else return { state: 'building', run: cur.id };
        return testerPass({ root, now, env, act, rig, inline, deps });
      }
      if (!b.ok) { if (!act) return { state: 'build-failed', run: cur.id, why: b.why }; const f = await finishRun({ root, id: cur.id, by: 'line-producer', env, deps }); return { state: 'finished', run: cur.id, why: `build failed: ${b.why}`, finished: f.ok, line: `tester: run ${cur.id} build failed` }; }
      const starved = starvedRig(rig);
      if (starved.starved) return { state: 'built', waiting: true, run: cur.id, why: starved.why, line: `tester: run ${cur.id} waits (${starved.why})` };
      if (!act) return { state: 'built', run: cur.id, why: 'would start the tester agent' };
      const l = await launchRun(root, st, { env, deps });
      return l.started ? { state: 'playing', run: cur.id, agent: l.agent, started: true, line: `tester: run ${cur.id} playing (${l.agent})` } : { state: 'built', waiting: true, run: cur.id, why: l.why, line: `tester: run ${cur.id} waits to start (${l.why})` };
    }
    if (cur.phase === 'playing') {
      let running = true;
      try { const list = deps.sessions ? deps.sessions() : (await import('./agent.mjs')).sessions(); const se = list.find((x) => x.agent === cur.agent); running = se ? Boolean(se.running) : now - Date.parse(cur.launchedAt || cur.at) < 5 * 60000; } catch {}
      if (running) return { state: 'playing', run: cur.id, agent: cur.agent, line: `tester: run ${cur.id} playing (${cur.agent})` };
      if (!act) return { state: 'ended', run: cur.id, why: 'would finish the run' };
      const f = await finishRun({ root, id: cur.id, by: 'line-producer', env, deps });
      return { state: 'finished', run: cur.id, finished: Boolean(f.ok), line: `tester: run ${cur.id} finished` };
    }
  }
  const events = deps.events || readRecentEvents(20000);
  const ref = Date.parse(st.last?.at || '') || Date.parse(st.since || '') || now;
  const landed = landingsSince(events, ref).length;
  const due = testerDue({ on: s.on, now, ref, landings: landed, everyHours: s.everyHours, minLandings: s.minLandings, asked: st.asked || null, running: Boolean(cur) });
  if (!due.due) return { state: 'idle', due: false, why: due.why, next: due.next };
  const starved = starvedRig(rig);
  if (starved.starved) return { state: 'due', waiting: true, why: `${due.why}; waits: ${starved.why}`, line: `tester: due, waits (${starved.why})` };
  const gate = deps.gateFree ? await deps.gateFree() : await gateSlotFree(root, env);
  if (!gate.free) return { state: 'due', waiting: true, why: `${due.why}; its build waits for a free gate slot: ${gate.why}`, line: `tester: due, waits (${gate.why})` };
  if (!act) return { state: 'due', why: `${due.why}: would start a run` };
  const r = await startRun({ root, env, now, by: st.asked?.by || 'line-producer', seed: st.asked?.seed ?? null, inline, deps });
  if (r.error) return { state: 'due', waiting: true, why: r.error };
  // An inline build (or no build at all) is done now: go on to the launch in the same look.
  if (readJson(path.join(r.run.dir, 'build.json'), null)) return testerPass({ root, now, env, act, rig, inline, deps });
  return { state: 'building', run: r.run.id, started: true, why: due.why, line: `tester: run ${r.run.id} building` };
}

/**
 * Wire-it tasks: a landed task whose done-check noted game code nothing imports (task.unwired) gets one "Wire <module>
 * into the game" task per module still unreached on the main checkout (P2, once per module, deduplicated by title).
 * deps: { events, filesOf(task) -> [files], unreached(files) -> [files], task: { addTask, parseNextQueue } }.
 */
export async function wirePass({ root, now = Date.now(), env = process.env, act = true, deps = {} } = {}) {
  root ||= await mainRootOf();
  if (!testerSettings(env).wireTasks) return { on: false, added: [], why: 'STUDIO_TESTER_WIRE_TASKS=off' };
  const events = deps.events || readRecentEvents(20000);
  const st = readTesterState(root);
  const wired = st.wired || {};
  const seen = st.wireSeen || {};
  const landed = new Set(landingsSince(events, 0).map((l) => l.task));
  for (const e of events) if (e.type === 'task.done' && e.task) landed.add(String(e.task));
  const notes = new Map();
  for (const e of events) if (e.type === 'task.unwired' && e.task && landed.has(e.task) && !seen[e.task]) notes.set(e.task, e);
  if (!notes.size) return { on: true, added: [], why: 'no landed task with unwired game code' };
  const reach = deps.unreached || (await import('./reachability.mjs')).unreached;
  const tm = deps.task || await import('./task.mjs');
  const open = (() => { try { const b = tm.parseNextQueue(); return [...(b.inProgress || []), ...(b.backlog || [])]; } catch { return []; } })();
  const added = [];
  for (const [task, e] of notes) {
    let files = [];
    try { files = deps.filesOf ? deps.filesOf(task) : []; } catch {}
    if (!files.length) files = (String(e.msg || '').replace(/^T-\d+:\s*/, '').match(/^(.+?) (?:is|are) not reached/) || [])[1]?.replace(/ and \d+ more$/, '').split(', ').map((x) => x.trim()).filter(Boolean) || [];
    let still = [];
    try { still = reach(files); } catch { still = []; }
    for (const mod of still) {
      const title = `Wire ${mod} into the game`;
      if (wired[mod] || open.some((t) => normTitle(t.title) === normTitle(title))) continue;
      if (!act) { added.push({ module: mod, task: null, of: task }); continue; }
      const r = tm.addTask({ title, role: 'builder', priority: 'P2', agent: 'line-producer', meta: { promoted: true, infra: true, origin: 'line-producer', wireOf: task, scope: `${mod} landed with ${task} but nothing in the game imports it (its done-check said so): import it from the game's entry point or the system that should use it, and show it working in the game` } });
      if (r?.id && !r.error) { wired[mod] = { task: r.id, of: task, at: new Date(now).toISOString() }; added.push({ module: mod, task: r.id, of: task, duplicate: Boolean(r.duplicate) }); }
    }
    if (act) seen[task] = new Date(now).toISOString();
  }
  if (act) writeTesterState(root, { ...readTesterState(root), wired, wireSeen: seen });
  if (act) for (const a of added.filter((x) => x.task && !x.duplicate)) emitEvent({ type: 'line.wire_task', agent: 'line-producer', to: 'producer', task: a.task, msg: `Line Producer: ${a.task} wires ${a.module} into the game (it landed with ${a.of}, and nothing in the game imports it)`, meta: { module: a.module, of: a.of } });
  return { on: true, added, why: added.length ? `${added.length} wire task(s)` : 'every unwired module has its task already' };
}

/** `tester -- status`: the last run, the next one, the run going. */
export async function testerStatus({ root, env = process.env, now = Date.now() } = {}) {
  root ||= await mainRootOf();
  const s = testerSettings(env);
  const st = readTesterState(root);
  const ref = Date.parse(st.last?.at || '') || Date.parse(st.since || '') || now;
  const landed = landingsSince(readRecentEvents(20000), ref).length;
  const due = testerDue({ on: s.on, now, ref, landings: landed, everyHours: s.everyHours, minLandings: s.minLandings, asked: st.asked || null, running: Boolean(st.current) });
  const cfg = await testerConfig(root);
  return { on: s.on, settings: s, last: st.last || null, current: st.current || null, asked: st.asked || null, landingsSince: landed, due, config: { source: cfg.source, fallback: cfg.fallback || null, build: cfg.build || null, dist: cfg.dist || null, url: cfg.url || null, areas: cfg.areas } };
}

export function statusText(t) {
  const L = [`Game tester: ${t.on ? 'scheduled' : 'on demand only (STUDIO_TESTER=off)'}; the game: ${t.config.source}${t.config.fallback ? ` (${t.config.fallback})` : ''}`];
  L.push(t.last ? `Last run: ${t.last.id} (${t.last.tool || '?'}), ended ${String(t.last.endedAt || '').slice(0, 16).replace('T', ' ')}: ${Object.entries(t.last.verdicts || {}).map(([a, v]) => `${a} ${v}`).join(', ') || 'no verdicts'}; bugs ${t.last.bugs?.join(', ') || 'none'}; ${t.last.report}` : 'Last run: none yet');
  if (t.current) L.push(`Going: ${t.current.id} (${t.current.phase}${t.current.agent ? `, ${t.current.agent}` : ''})`);
  L.push(`Next: ${t.due.due ? `due now (${t.due.why})` : t.due.why}${t.due.next?.at ? `; not before ${t.due.next.at.slice(0, 16).replace('T', ' ')}` : ''}${t.due.next?.landingsNeeded ? ` and ${t.due.next.landingsNeeded} more landing(s)` : ''}`);
  return L.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try { (await import('./dotenv.mjs')).loadDotEnv(path.join(REPO_ROOT, '.env')); } catch {}
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const cmd = argv[0] || 'status';
  const root = await mainRootOf();
  if (cmd === 'build') { const r = await buildRun(root, flag('run')); console.log(r.ok ? r.why : `build failed: ${r.why}`); process.exitCode = r.ok ? 0 : 1; }
  else if (cmd === 'status' || cmd === 'plan') {
    const t = await testerStatus({ root });
    if (cmd === 'plan') { const { rigNow } = await import('./line-producer.mjs'); t.pass = await testerPass({ root, act: false, rig: await rigNow({}) }); }
    console.log(argv.includes('--json') ? JSON.stringify(t, null, 2) : `${statusText(t)}${t.pass ? `\nThis pass would: ${t.pass.why || t.pass.state}` : ''}`);
  } else if (cmd === 'now') {
    const by = flag('by') || process.env.STUDIO_LOCK_OWNER || 'a person';
    const seed = flag('seed') !== null ? Number(flag('seed')) : null;
    const st = readTesterState(root);
    if (st.current) { console.log(`A run is going already: ${st.current.id} (${st.current.phase}).`); }
    else {
      writeTesterState(root, { ...st, asked: { by, at: new Date().toISOString(), ...(Number.isFinite(seed) ? { seed } : {}) } });
      let supervised = false;
      try { const s = (await import('./supervisor.mjs')).readStatus(); const { pidAlive } = await import('./proc-identity.mjs'); supervised = s?.status === 'running' && pidAlive(s.pid, s.identity); } catch {}
      const { lineMode, rigNow } = await import('./line-producer.mjs');
      if (supervised && lineMode() === 'on') console.log('Asked: the Line Producer starts the run on its next pass (npm run tester -- status).');
      else {
        const r = await testerPass({ root, inline: true, rig: await rigNow({}) });
        console.log(`No supervisor runs, so this started it: ${r.line || r.why || r.state}`);
      }
    }
  } else if (cmd === 'brief') {
    const st = readTesterState(root);
    if (!st.current) { console.log('No tester run is going.'); process.exitCode = 1; }
    else { const f = path.join(st.current.dir, 'brief.md'); console.log(`Run ${st.current.id}: ${f}\n`); console.log(fs.readFileSync(f, 'utf8')); }
  } else if (cmd === 'finish') {
    const r = await finishRun({ root, id: flag('run'), by: process.env.STUDIO_LOCK_OWNER || TESTER_AGENT });
    if (r.error) { console.error(r.error); process.exitCode = 1; }
    else console.log(r.already ? 'Already finished.' : `Published ${r.summary.report}; ${r.summary.bugs.filter((b) => b.task).length} bug task(s): ${r.summary.bugs.map((b) => b.task).filter(Boolean).join(', ') || 'none'}.${r.summary.problems.length ? `\nProblems: ${r.summary.problems.join('; ')}` : ''}`);
  } else { console.error('Usage: npm run tester -- status [--json] | now [--by <you>] [--seed <n>] | brief | finish | plan'); process.exitCode = 1; }
}
