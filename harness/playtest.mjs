/**
 * harness/playtest.mjs — the newest playable engine build in one fixed folder (studio/game.json engines.<x>.playtest:
 * { "dir", "exe", "build": "<command with {out}>", "shortcut": true | "<folder>" | false, "feedback", "keep": 3, "nightly" }).
 * Builds come from green land runs: the land script writes the built executable's path as gates.build.output in its
 * result (STUDIO_LAND_RESULT); recordLandBuild keeps it in .studio/engine/<x>-land-builds.json. When the target moved
 * past the newest build, playtest.build builds the tip (train lock and machine:heavy slot held, as a land run takes it).
 *   npm run engine -- playtest [--engine <x>] [--if-moved] [--dry-run] [--json]
 * Promote: a copy in <dir>/<date>-<short commit>/ (never over a folder), PLAYTEST.md there and in <dir>, a shortcut with
 * the same name every time, the record .studio/engine/<x>-playtest.json, one engine.playtest event; the newest `keep`
 * promoted folders stay. The land run's own build folders are only read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, actor, emitEvent, readRecentEvents } from './event.mjs';
import { enginesConfig, engineTarget } from './engine-tracks.mjs';
import { readJson, writeAtomic } from './fsafe.mjs';
import { flagOf, quoteArg as q } from './helpers.mjs';
import { landings } from './landings.mjs';
import { readSwitches } from './switches.mjs';

const short = (s) => String(s || '').slice(0, 7);
const git = (repo, ...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const gitOut = (repo, ...a) => { const r = git(repo, ...a); return r.status === 0 ? String(r.stdout || '').trim() : ''; };
const writeJson = (f, v) => writeAtomic(f, `${JSON.stringify(v, null, 2)}\n`);
const buildsFile = (root, engine) => path.join(root, '.studio', 'engine', `${engine}-land-builds.json`);
export const playtestFile = (root, engine) => path.join(root, '.studio', 'engine', `${engine}-playtest.json`);
const FOLDER_RE = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{7}(-\d+)?$/;
const OK_STATUS = /^(pass|passed|ok|green|success|succeeded|done)$/i;

/** engines.<x>.playtest checked: { dir (absolute), exe, build, shortcut, feedback, keep, nightly }, { bad }, or null when unset. */
export function playtestConfig(engine, { root = REPO_ROOT } = {}) {
  const p = enginesConfig(root)[engine]?.playtest;
  if (p === undefined || p === null || p === false) return null;
  const where = `engines.${engine}.playtest`;
  if (typeof p !== 'object' || Array.isArray(p)) return { bad: `${where} is not an object like { "dir": "<folder>" }` };
  if (typeof p.dir !== 'string' || !p.dir.trim()) return { bad: `${where}.dir is missing: the fixed folder the owner plays from` };
  if (p.build !== undefined && (typeof p.build !== 'string' || !p.build.includes('{out}'))) return { bad: `${where}.build must be a command with {out} (the folder it builds into)` };
  if (p.shortcut !== undefined && ![true, false].includes(p.shortcut) && typeof p.shortcut !== 'string') return { bad: `${where}.shortcut is true, false or a folder` };
  const keep = p.keep === undefined ? 3 : Number(p.keep);
  if (!Number.isInteger(keep) || keep < 1) return { bad: `${where}.keep must be a whole number of 1 or more` };
  return { dir: path.resolve(root, p.dir.trim()), exe: typeof p.exe === 'string' && p.exe.trim() ? p.exe.trim() : null, build: p.build || null, shortcut: p.shortcut === undefined ? true : p.shortcut, feedback: typeof p.feedback === 'string' ? p.feedback.trim() : '', keep, nightly: p.nightly === true };
}

/** The green land runs' builds, oldest first: [{ at, commit, output, tasks }]. */
export function readLandBuilds(root, engine) { const j = readJson(buildsFile(root, engine)); return Array.isArray(j) ? j.filter((b) => b && b.output && b.at) : []; }

/**
 * After a green land run: keep its built executable (gates.build.output, or stages.build.output; relative to the land
 * command's folder) with the commit the run made ("commit", else that folder's HEAD). A build whose status is not green is not kept.
 */
export function recordLandBuild(engine, stageFile, { cwd = REPO_ROOT, tasks = [], root = REPO_ROOT, now = Date.now() } = {}) {
  const j = readJson(stageFile);
  const b = j && typeof j === 'object' ? (j.gates?.build || j.stages?.build) : null;
  if (!b || typeof b.output !== 'string' || !b.output.trim() || (b.status && !OK_STATUS.test(String(b.status)))) return null;
  const output = path.resolve(cwd, b.output.trim());
  const commit = typeof j.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(j.commit) ? j.commit : gitOut(cwd, 'rev-parse', 'HEAD') || null;
  const rec = { at: new Date(now).toISOString(), commit, output, tasks: tasks.filter(Boolean) };
  writeJson(buildsFile(root, engine), [...readLandBuilds(root, engine), rec].slice(-30));
  return rec;
}

/** The executable in a folder: `name` when given, else the first .exe / .x86_64 / .app (three levels down at most). */
export function findExe(dir, name = null, depth = 3) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return null; }
  const hit = ents.find((e) => (name ? e.name === name : /\.(exe|x86_64|app)$/i.test(e.name)) && (e.isFile() || /\.app$/i.test(e.name)));
  if (hit) return path.join(dir, hit.name);
  if (depth <= 1) return null;
  for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.')) { const f = findExe(path.join(dir, e.name), name, depth - 1); if (f) return f; }
  return null;
}

/** The engines whose playtest is set: [names]. */
export const playtestEngines = (root = REPO_ROOT) => Object.keys(enginesConfig(root)).filter((e) => playtestConfig(e, { root })).sort();

/**
 * Where the engine stands: { repo, target, tip, tipAt, ignore, newest (build on disk), fresh, behind: { commits, tasks } }.
 * fresh: the newest build is of the tip, or the tip differs from it only in engines.<x>.rules.ignore paths.
 */
async function standing(engine, root, events) {
  const tm = await import('./unity-train.mjs');
  const cfg = engineTarget(engine, { root })?.cfg || {};
  const repo = tm.unityRepo(cfg, root, engine);
  const target = typeof cfg.target === 'string' ? cfg.target : null;
  const tip = repo && target ? gitOut(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${target}^{commit}`) : '';
  const tipAt = tip ? gitOut(repo, 'log', '-1', '--format=%cI', tip) : '';
  const ignore = (Array.isArray(cfg.rules?.ignore) ? cfg.rules.ignore : []).map((x) => String(x || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean);
  const newest = readLandBuilds(root, engine).filter((b) => fs.existsSync(b.output)).pop() || null;
  const isAnc = (a, b) => Boolean(a && b) && git(repo, 'merge-base', '--is-ancestor', a, b).status === 0;
  let fresh = false;
  if (newest && tip && newest.commit) {
    if (tip.startsWith(newest.commit) || newest.commit === tip) fresh = true;
    else if (isAnc(newest.commit, tip)) {
      const ch = gitOut(repo, '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', newest.commit, tip).split('\n').filter(Boolean);
      fresh = ch.length > 0 && ignore.length > 0 && ch.every((p) => ignore.some((x) => p === x || p.startsWith(`${x}/`)));
    }
  }
  let behind = { commits: 0, tasks: [] };
  if (newest && tip && !fresh) {
    const commits = newest.commit && isAnc(newest.commit, tip) ? Number(gitOut(repo, 'rev-list', '--count', `${newest.commit}..${tip}`)) || 0 : null;
    const after = landings(events, 'engine', { after: Date.parse(newest.at) || 0 }).filter((l) => l.engine === engine && !(newest.tasks || []).includes(l.task) && !(l.e?.meta?.head && newest.commit && isAnc(l.e.meta.head, newest.commit)));
    behind = { commits, tasks: [...new Set(after.map((l) => l.task))] };
  }
  return { cfg, repo, target, tip, tipAt, ignore, newest, fresh, behind, tm };
}

/** Task titles from the board (open and done): { id: title }. */
async function titles() {
  try { const t = (await import('./task.mjs')).parseNextQueue(); return Object.fromEntries([...t.inProgress, ...t.backlog, ...t.done].map((x) => [x.id, String(x.title || '')])); } catch { return {}; }
}

/** What is known red or open on the engine, from what the harness already keeps (15 lines at most). */
async function knownLines(root, engine, cfg, tm, open) {
  const L = [];
  try { const l = (await import('./engine-target-red.mjs')).targetRedLine(root, engine); if (l) L.push(l); } catch { /* none */ }
  try { const f = tm.readFullBaseline(root, engine).failing; if (f.length) L.push(`Red on the target in the daily full run: ${f.length} test(s): ${f.slice(0, 3).join(', ')}${f.length > 3 ? ', ...' : ''}`); } catch { /* none */ }
  try { const k = tm.knownRedOf(root, engine, cfg).names; if (k.length) L.push(`Known red (listed flaky tests red on the target alone): ${k.slice(0, 3).join(', ')}`); } catch { /* none */ }
  try { L.push(...tm.flakeLines(root, engine)); } catch { /* none */ }
  try { for (const [task, h] of Object.entries(tm.readHandbacks(root, engine))) if (open.has(task)) L.push(`${task} was handed back by the engine train: ${String(h?.reason || 'no reason kept').slice(0, 140)}`); } catch { /* none */ }
  return L.slice(0, 15);
}

/** PLAYTEST.md: what this build is, systems ON, what landed since the last one, what is known red or open, where to say what you found. */
export function playtestNotes(n) {
  const L = [`# Playtest build: ${n.label}`, ''];
  L.push(`This is ${n.target || 'the target'} at ${short(n.commit)}, built ${String(n.builtAt).slice(0, 16).replace('T', ' ')} UTC. The target last moved ${n.tipAt ? n.tipAt.slice(0, 16).replace('T', ' ') : 'at an unknown time'}.`);
  if (n.behindText) L.push(n.behindText);
  else L.push('It is the newest there is: nothing that changes the game landed after it.');
  L.push(`Start it: double-click "${n.shortcutName}" (in ${n.dir}${n.desktop ? ' and on the Desktop' : ''}), or open ${n.exeRel}.`, '');
  if (n.switches && !n.switches.bad) {
    const s = n.switches;
    L.push(`## Systems ON: ${s.on.length} of ${s.total}`, '');
    L.push(`On: ${s.on.join(', ') || 'none yet'}.`);
    if (s.off.length) L.push(`Still off: ${s.off.map((o) => `${o.name}${o.task ? ` (${o.task.id})` : ''}`).join(', ')}.`);
    if (s.missing) L.push(`Not in the engine yet: ${s.missing}.`);
    L.push('');
  }
  L.push('## Landed since the last playtest build', '');
  if (n.first) L.push('This is the first playtest build.');
  else if (!n.landed.length) L.push('No task landed since the last playtest build.');
  else for (const t of n.landed) L.push(`- ${t.id}${t.title ? `: ${t.title.slice(0, 120)}` : ''}`);
  L.push('', '## Known red or open', '');
  if (n.known.length) for (const k of n.known) L.push(`- ${k}`);
  else L.push('Nothing the harness knows is red, and no task handed back by the engine train is open.');
  L.push('', '## What you found', '', n.feedback || 'Tell the studio what you found (npm run task -- add "<what you saw>").', '');
  return L.join('\n');
}

/** The shortcut's content: a .cmd on Windows, a .sh elsewhere. { name, text } */
export function shortcutOf({ label, engine, exe, platform = process.platform }) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const dir = P.dirname(exe);
  if (platform === 'win32') return { name: `Playtest ${label}.cmd`, text: `@echo off\r\nrem Made by npm run engine -- playtest: starts the newest playtest build. It is rewritten at every promote.\r\ncd /d "${dir.replace(/%/g, '%%')}"\r\nstart "" "${P.basename(exe).replace(/%/g, '%%')}"\r\n` };
  const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  return { name: `playtest-${engine}.sh`, text: `#!/bin/sh\n# Made by npm run engine -- playtest: starts the newest playtest build. It is rewritten at every promote.\ncd ${sq(dir)} && exec ./${sq(P.basename(exe))}\n` };
}

/** Run playtest.build for the tip: the train lock (never beside a train) and the machine:heavy slot, as a land run takes it. */
async function buildTip({ engine, pt, st, root, env, log, by }) {
  const staging = path.join(pt.dir, `.building-${short(st.tip)}-${process.pid}`);
  const r = await st.tm.withUnityTrainLock(root, { id: 'playtest-build', by, engine }, async () => {
    const { acquireHeavy } = await import('./heavy.mjs');
    const { landHeavyOpts } = await import('./unity-gate.mjs');
    const { hroot, heavyOpts } = await landHeavyOpts(engine, { env, log });
    let lk;
    try { lk = acquireHeavy(hroot, `${engine} playtest build`, heavyOpts); } catch (err) { if (err.code !== 'HEAVY_BUSY') throw err; return { ok: false, why: `the machine:heavy slot stayed busy (${String(err.message).replace(/^\[heavy\]\s*/, '').slice(0, 160)})` }; }
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      const cwd = st.cfg.cwd ? path.resolve(root, st.cfg.cwd) : st.repo;
      const timeoutMin = Number(st.cfg.timeoutMin || env.STUDIO_UNITY_GATE_TIMEOUT_MIN || 120);
      log(`[playtest] building ${st.target} at ${short(st.tip)} with engines.${engine}.playtest.build in ${cwd}; up to ${timeoutMin} min`);
      const { runLimitedSync } = await import('./run-limited.mjs');
      const x = runLimitedSync(pt.build.split('{out}').join(q(staging)), { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeoutMs: timeoutMin * 60000, env: { ...env, STUDIO_PLAYTEST_COMMIT: st.tip, STUDIO_HEAVY_HELD: process.env.STUDIO_HEAVY_HELD || '' } });
      const exe = x.status === 0 ? findExe(staging, pt.exe) : null;
      if (x.status !== 0 || !exe) {
        const tail = `${x.stdout || ''}${x.stderr || ''}`.trim().split('\n').slice(-2).join(' ').slice(0, 200);
        fs.rmSync(staging, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
        return { ok: false, why: x.status !== 0 ? `the build command ${x.error?.code === 'ETIMEDOUT' ? `timed out after ${timeoutMin} min` : `exited ${x.status ?? x.signal}`}${tail ? `: ${tail}` : ''}` : `the build command made no ${pt.exe || 'executable'} in {out}` };
      }
      return { ok: true, staging, exe };
    } finally { lk.release(); }
  }, { waitMs: 0, engine });
  return r.busy ? { ok: false, train: true, why: `an engine train is running (${r.busy.id || '?'}): nothing is built beside it` } : r;
}

/** Copy (or move a fresh build) into a new <dir>/<date>-<short>/ folder; never over one that exists. */
function newFolder(dir, builtAt, commit) {
  const base = `${String(builtAt).slice(0, 10)}-${short(commit) || '0000000'}`;
  let name = base;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i += 1) name = `${base}-${i}`;
  return path.join(dir, name);
}

/** Remove promoted folders past `keep` (only folders this command made, inside dir). A folder in use is left and named. */
function prune(pt, promoted) {
  const removed = []; const left = [];
  const keepN = promoted.slice(-pt.keep);
  for (const p of promoted.slice(0, -pt.keep)) {
    const abs = path.join(pt.dir, p.folder);
    if (!FOLDER_RE.test(p.folder)) continue;
    try { fs.rmSync(abs, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 }); removed.push(p.folder); } catch (err) { left.push({ ...p, why: err.code || 'in use' }); }
  }
  return { promoted: [...left, ...keepN], removed, left: left.map((p) => p.folder) };
}

/**
 * npm run engine -- playtest. { ok, action: 'promoted' | 'unchanged' | 'nothing' | 'dry-run', lines, ... }.
 * ifMoved: nothing to do when the promoted build is already the newest there is.
 */
export async function playtest({ engine = null, ifMoved = false, dryRun = false, root = REPO_ROOT, env = process.env, log = () => {}, by = actor(), platform = process.platform, events = null } = {}) {
  const names = playtestEngines(root);
  if (!engine) {
    if (names.length !== 1) return { ok: false, action: 'nothing', lines: [names.length ? `Several engines set a playtest (${names.join(', ')}): name one with --engine <x>.` : 'No engine sets a playtest: add engines.<x>.playtest { "dir": "<folder>" } to studio/game.json (docs/NATIVE-ENGINE.md).'] };
    [engine] = names;
  }
  const pt = playtestConfig(engine, { root });
  if (!pt) return { ok: false, action: 'nothing', lines: [`engines.${engine}.playtest is not set in studio/game.json: there is no playtest folder (docs/NATIVE-ENGINE.md).`] };
  if (pt.bad) return { ok: false, action: 'nothing', lines: [`The playtest setting is not usable: ${pt.bad}.`] };
  const evs = events || readRecentEvents(20000);
  const st = await standing(engine, root, evs);
  const label = engineTarget(engine, { root })?.label || engine;
  const rec = readJson(playtestFile(root, engine)) || {};
  const last = rec.last && fs.existsSync(path.join(pt.dir, rec.last.folder || '\0')) ? rec.last : null;
  const lines = [];
  const canBuild = Boolean(pt.build && st.tip);
  // The newest there is: a fresh build, else the tip when it can be built, else the newest build.
  const newestCommit = st.newest && (st.fresh || !canBuild) ? st.newest.commit : canBuild ? st.tip : null;
  if (ifMoved && last && newestCommit && last.commit === newestCommit) return { ok: true, action: 'unchanged', lines: [`The playtest build is already the newest there is (${short(last.commit)} in ${path.join(pt.dir, last.folder)}): nothing to do.`] };
  let cand = st.newest && (st.fresh || !canBuild) ? { commit: st.newest.commit, builtAt: st.newest.at, exe: st.newest.output, src: path.dirname(st.newest.output), tasks: st.newest.tasks || [], source: 'land' } : null;
  if (!cand && canBuild) {
    if (dryRun) return { ok: true, action: 'dry-run', lines: [`Would build ${st.target} at ${short(st.tip)} with engines.${engine}.playtest.build (${st.newest ? `the newest land build ${short(st.newest.commit)} is behind it` : 'there is no land build on disk'}), then promote it into ${pt.dir}.`] };
    const b = await buildTip({ engine, pt, st, root, env, log, by });
    if (b.ok) cand = { commit: st.tip, builtAt: new Date().toISOString(), exe: b.exe, src: b.staging, tasks: [], source: 'build', move: true };
    else {
      lines.push(`The tip was not built: ${b.why}.${st.newest ? ' The newest land build is promoted instead.' : ''}`);
      if (st.newest) cand = { commit: st.newest.commit, builtAt: st.newest.at, exe: st.newest.output, src: path.dirname(st.newest.output), tasks: st.newest.tasks || [], source: 'land' };
    }
  }
  if (!cand) return { ok: ifMoved, action: 'nothing', lines: [...lines, `No playable ${label} build yet: a green land run must write the built executable's path as gates.build.output in its result (STUDIO_LAND_RESULT)${pt.build ? '' : ', or set engines.' + engine + '.playtest.build'}.`] };
  const behindNow = cand.source === 'land' && !st.fresh && st.tip && cand.commit !== st.tip;
  const tl = await titles();
  const behindText = behindNow ? (st.behind.tasks.length ? `It is ${st.behind.tasks.length} landing(s) behind ${st.target}: ${st.behind.tasks.map((t) => `${t}${tl[t] ? ` (${tl[t].slice(0, 60)})` : ''}`).join(', ')}.` : `${st.target} has ${st.behind.commits ?? 'some'} commit(s) this build does not have.`) : '';
  if (behindText) lines.push(behindText.replace(/^It is/, `The build ${short(cand.commit)} is`));
  if (ifMoved && last && last.commit === cand.commit) return { ok: true, action: 'unchanged', lines: [...lines, `The playtest build is already the newest there is (${short(last.commit)}): nothing to do.`] };
  if (dryRun) return { ok: true, action: 'dry-run', lines: [...lines, `Would promote ${short(cand.commit)} (${cand.exe}) into ${pt.dir}.`] };

  // Promote.
  fs.mkdirSync(pt.dir, { recursive: true });
  const dest = newFolder(pt.dir, cand.builtAt, cand.commit);
  const exeRel = path.relative(cand.src, cand.exe);
  if (cand.move) { try { fs.renameSync(cand.src, dest); } catch { fs.cpSync(cand.src, dest, { recursive: true }); fs.rmSync(cand.src, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); } } else fs.cpSync(cand.src, dest, { recursive: true });
  const exe = path.join(dest, exeRel);
  const sc = shortcutOf({ label, engine, exe, platform });
  const shortcuts = [path.join(pt.dir, sc.name)];
  let desk = null;
  if (pt.shortcut === true) { try { desk = (await import('./boot.mjs')).desktopDir({ env, platform }); } catch { desk = null; } if (!desk) lines.push('No Desktop folder was found: the shortcut is only in the playtest folder.'); }
  else if (typeof pt.shortcut === 'string') { desk = path.resolve(root, pt.shortcut); if (!fs.existsSync(desk)) { lines.push(`The shortcut folder ${desk} does not exist: the shortcut is only in the playtest folder.`); desk = null; } }
  if (desk) shortcuts.push(path.join(desk, sc.name));
  for (const f of shortcuts) fs.writeFileSync(f, sc.text, platform === 'win32' ? {} : { mode: 0o755 });
  // What landed since the previous playtest build: engine landings after it, up to this build.
  const prev = rec.last || null;
  const isAnc = (a, b) => Boolean(a && b && st.repo) && git(st.repo, 'merge-base', '--is-ancestor', a, b).status === 0;
  const landed = prev ? [...new Set(landings(evs, 'engine', { after: Date.parse(prev.builtAt) || 0 }).filter((l) => l.engine === engine && !(prev.tasks || []).includes(l.task) && (cand.source === 'build' || (cand.tasks || []).includes(l.task) || l.at <= Date.parse(cand.builtAt) || isAnc(l.e?.meta?.head, cand.commit))).map((l) => l.task))].map((id) => ({ id, title: tl[id] || '' })) : [];
  let open = new Set();
  try { const t = (await import('./task.mjs')).parseNextQueue(); open = new Set([...t.inProgress, ...t.backlog].map((x) => x.id)); } catch { /* none open */ }
  const sw = await readSwitches(engine, { root }).catch(() => null);
  const notes = playtestNotes({ label, target: st.target, commit: cand.commit, builtAt: cand.builtAt, tipAt: st.tipAt, behindText, shortcutName: sc.name, dir: pt.dir, desktop: Boolean(desk), exeRel: path.relative(pt.dir, exe), switches: sw, first: !prev, landed, known: await knownLines(root, engine, st.cfg, st.tm, open), feedback: pt.feedback });
  fs.writeFileSync(path.join(dest, 'PLAYTEST.md'), notes);
  fs.writeFileSync(path.join(pt.dir, 'PLAYTEST.md'), notes);
  const entry = { folder: path.basename(dest), commit: cand.commit, builtAt: cand.builtAt, at: new Date().toISOString(), exe, source: cand.source, tasks: cand.tasks || [], ...(behindNow ? { behind: st.behind } : {}) };
  const pr = prune(pt, [...(Array.isArray(rec.promoted) ? rec.promoted : []), entry]);
  writeJson(playtestFile(root, engine), { last: entry, promoted: pr.promoted, shortcuts });
  lines.push(`Promoted ${short(cand.commit)} (${cand.source === 'build' ? 'built now from the tip' : 'a green land run\'s build'}) to ${dest}; notes in ${path.join(pt.dir, 'PLAYTEST.md')}; shortcut ${shortcuts.join(' and ')}.`);
  if (pr.removed.length) lines.push(`Removed older playtest folders: ${pr.removed.join(', ')} (keep ${pt.keep}).`);
  if (pr.left.length) lines.push(`Left in place (in use or locked; removed on a later run): ${pr.left.join(', ')}.`);
  try { emitEvent({ type: 'engine.playtest', agent: by, to: 'human', track: `engine:${engine}`, status: behindNow ? 'warn' : 'ok', msg: `${label} playtest build ${short(cand.commit)} is ready in ${dest}${behindNow ? ` (${behindText.replace(/^It is /, '')})` : ''}`.slice(0, 400), meta: { engine, commit: cand.commit, folder: entry.folder, source: cand.source, behind: behindNow ? st.behind.tasks.length : 0 } }); } catch { /* a record only */ }
  return { ok: true, action: 'promoted', lines, folder: dest, exe, commit: cand.commit, source: cand.source, behind: behindNow ? st.behind : null, shortcuts, removed: pr.removed, left: pr.left };
}

/** The daily tick: `playtest --if-moved` for each engine with playtest.nightly, started on its own (a build can take long). */
export function nightlyPlaytests({ root = REPO_ROOT, env = process.env } = {}) {
  const started = [];
  for (const engine of playtestEngines(root)) {
    if (!playtestConfig(engine, { root }).nightly) continue;
    try {
      fs.mkdirSync(path.join(root, '.studio', 'engine'), { recursive: true });
      const out = fs.openSync(path.join(root, '.studio', 'engine', `${engine}-playtest.log`), 'a');
      const c = spawn(process.execPath, [path.join(root, 'harness', 'playtest.mjs'), '--engine', engine, '--if-moved'], { cwd: root, env, detached: true, stdio: ['ignore', out, out], windowsHide: true });
      c.unref();
      fs.closeSync(out);
      started.push({ engine, pid: c.pid });
    } catch { /* tried again tomorrow */ }
  }
  return started;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = flagOf(argv);
  const r = await playtest({ engine: flag('engine'), ifMoved: argv.includes('--if-moved'), dryRun: argv.includes('--dry-run'), by: flag('by') || actor(), log: (m) => console.error(m) });
  console[r.ok ? 'log' : 'error'](argv.includes('--json') ? JSON.stringify(r) : r.lines.join('\n'));
  process.exit(r.ok ? 0 : 1);
}
