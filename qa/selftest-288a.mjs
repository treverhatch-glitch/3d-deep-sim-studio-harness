/**
 * qa/selftest-288a.mjs — 2.88 (l): which tasks landed, read one way (harness/landings.mjs).
 * The module: web, engine, landed, closed and forced on a made-up log with web, engine, closed-only and forced-only
 * tasks, both shapes of a meta.lanes entry, the windows, the no-landing-record fallback, and upgrade-baseline's copy.
 * The callers 2.88 changed: brief-status "Landed", health's landings and morning list, the dev cycle's brief, the
 * game-dev loop's landing step and score's engine lanes with a hyphenated engine name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { guardCap3000Of, importInDirOf, out } from './kit.mjs';

const T0 = Date.parse('2026-03-03T10:00:00Z');
const at = (m) => new Date(T0 + m * 60000).toISOString();
// T-001 web (lane.merged), T-002 and T-003 web (a train, a string and an object lane), T-004 and T-005 engine (two
// engines, one with a hyphen), T-006 closed with no landing, T-007 forced with no landing.
const LOG = [
  { ts: at(1), type: 'task.train.start', meta: { lanes: ['T-002', 'T-003'] } },
  { ts: at(2), type: 'lane.merged', task: 'T-001', agent: 'builder-a', msg: 'T-001: lane added to main' },
  { ts: at(3), type: 'task.done', task: 'T-001', msg: 'Completed T-001: first web change' },
  { ts: at(4), type: 'task.train.landed', meta: { lanes: ['T-002', { task: 'T-003' }] }, msg: 'train: main moved' },
  { ts: at(5), type: 'task.done', task: 'T-002', msg: 'Completed T-002: second web change' },
  { ts: at(6), type: 'task.train.unity.queued', task: 'T-004' },
  { ts: at(7), type: 'task.train.unity.landed', meta: { lanes: ['T-004'] } },
  { ts: at(8), type: 'task.done', task: 'T-004', msg: 'Completed T-004: an engine change' },
  { ts: at(9), type: 'task.train.my-engine.landed', meta: { lanes: [{ task: 'T-005' }] } },
  { ts: at(10), type: 'task.done', task: 'T-006', msg: 'Completed T-006: a plan, no branch' },
  { ts: at(11), type: 'task.forced', task: 'T-007', msg: 'T-007 forced' },
];

export async function selftest288A({ dir, report, tmpRoot }) {
  const guard = guardCap3000Of(report);
  const imp = importInDirOf(dir);
  const L = await imp('harness/landings.mjs');
  const ids = (m, w) => L.landedTasks(LOG, m, w).join(',');

  await guard('2.88 (l) landings: on a log with web, engine, closed-only and forced-only tasks, web is T-001..T-003, engine T-004 and T-005 (a hyphenated engine name too), landed both, closed every task.done and forced T-007; an object lane counts as its .task; train starts and queue records count for nothing', () => {
    const r = { web: ids('web'), engine: ids('engine'), landed: ids('landed'), closed: ids('closed'), forced: ids('forced'), mix: ids(['landed', 'closed']), start: L.tasksOf(LOG[0], 'landed').length, queued: L.tasksOf(LOG[5], ['landed', 'closed', 'forced']).length };
    const eng = L.landings(LOG, 'engine').map((l) => `${l.task}@${l.engine}`).join(',');
    return [r.web === 'T-001,T-002,T-003' && r.engine === 'T-004,T-005' && r.landed === 'T-001,T-002,T-003,T-004,T-005' && r.closed === 'T-001,T-002,T-004,T-006' && r.forced === 'T-007'
      && r.mix === 'T-001,T-002,T-003,T-004,T-005,T-006' && r.start === 0 && r.queued === 0 && eng === 'T-004@unity,T-005@my-engine', JSON.stringify({ r, eng })];
  });
  await guard('2.88 (l) landings: windows (since inclusive, after and before strict), each record with its time and kind, and an unknown measure is refused', () => {
    const since = ids('landed', { since: T0 + 4 * 60000 }); const after = ids('landed', { after: T0 + 4 * 60000 }); const before = ids('landed', { before: T0 + 4 * 60000 });
    const one = L.landings(LOG, 'web', { since: T0 + 4 * 60000 })[1];
    let threw = ''; try { L.tasksOf(LOG[1], 'merged'); } catch (e) { threw = e.message; }
    return [since === 'T-002,T-003,T-004,T-005' && after === 'T-004,T-005' && before === 'T-001' && one.task === 'T-003' && one.kind === 'web' && one.at === T0 + 4 * 60000 && one.ts === at(4) && /unknown measure "merged"/.test(threw), JSON.stringify({ since, after, before, one: { ...one, e: undefined }, threw })];
  });
  await guard('2.88 (l) landings: landedMeasure is landed for a log with any landing record and closed for a log with none (a studio with no lanes or trains), and brief-status and health then list its closes as before', async () => {
    const noLanes = LOG.filter((e) => /^task\.(done|forced)$/.test(e.type));
    const B = await imp('harness/brief-status.mjs'); const H = await imp('harness/health.mjs');
    const f = await B.briefFacts({ root: dir, since: at(0), now: T0 + 3600000, events: noLanes });
    const h = H.health(noLanes, { since: 0, now: T0 + 3600000 });
    return [L.landedMeasure(LOG) === 'landed' && L.landedMeasure(noLanes) === 'closed' && f.landed.join(',') === 'T-001,T-002,T-004,T-006' && h.landings === 4, JSON.stringify({ m: [L.landedMeasure(LOG), L.landedMeasure(noLanes)], landed: f.landed, landings: h.landings })];
  });
  await guard("2.88 (l) landings: upgrade-baseline.mjs's standalone copy (it imports no harness file) counts the same tasks as tasksOf(e, ['web', 'closed']), object lanes included", async () => {
    const B = await imp('harness/upgrade-baseline.mjs');
    const got = B.baselineMeasures(LOG, T0, T0 + 3600000).landedPerHour;
    const want = new Set(LOG.flatMap((e) => L.tasksOf(e, ['web', 'closed']))).size;
    return [got?.n === want && want === 5, JSON.stringify({ got, want })];
  });

  // ---- the callers 2.88 changed ----
  await guard('2.88 (l) brief-status: "Landed" lists what reached main or an engine target, not a plan closed with no branch or a forced close (fails on 2.87: it listed T-006, T-007 and, from the object lane, "[object Object]", and missed T-005)', async () => {
    const B = await imp('harness/brief-status.mjs');
    const f = await B.briefFacts({ root: dir, since: at(0), now: T0 + 3600000, events: LOG });
    return [f.landed.join(',') === 'T-001,T-002,T-003,T-004,T-005', JSON.stringify(f.landed)];
  });
  await guard('2.88 (l) health: landings count engine landings (one task, once) and the morning list names them (fails on 2.87: 1 landing, from lane.merged only)', async () => {
    const H = await imp('harness/health.mjs');
    const h = H.health(LOG, { since: 0, now: T0 + 3600000 });
    const n = await H.needsYou(LOG, { since: 0 });
    return [h.landings === 5 && n.landed.join(',') === 'T-001,T-002,T-003,T-004,T-005', JSON.stringify({ landings: h.landings, landed: n.landed })];
  });
  await guard('2.88 (l) score: the engine flow counts the lanes of an engine whose name has a hyphen (fails on 2.87: \\w+ missed task.train.my-engine.landed, 1 lane)', async () => {
    const S = await imp('harness/score.mjs');
    const lands = [{ ts: at(6), type: 'engine.land', meta: { status: 'pass', ms: 60000 } }, { ts: at(8), type: 'engine.land', meta: { status: 'pass', ms: 60000 } }, { ts: at(9), type: 'engine.land', meta: { status: 'red', ms: 60000 } }];
    const f = S.engineFlow([...LOG, ...lands]);
    return [f?.landedLanes === 2, JSON.stringify({ landedLanes: f?.landedLanes })];
  });

  // ---- the dev cycle and the game-dev loop, run for real in this copy ----
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const evFile = path.join(dir, '.studio', 'events-288a.jsonl');
  fs.mkdirSync(path.dirname(evFile), { recursive: true });
  const env = { ...process.env, ...clean, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: dir, STUDIO_TASK_BUDGET: 'off', STUDIO_WATCHDOG: 'off', CI: '', NODE_OPTIONS: '' };
  const probe = (name, code, extra = {}) => {
    const f = path.join(dir, `.probe-288a-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', timeout: 180000 });
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  await guard("2.88 (l) dev cycle: the brief's landed list is the tasks that landed since the last cycle, with their close's words, not the plan closed with no branch (fails on 2.87: it listed every task.done, T-006 among them, and missed T-003 and T-005)", () => {
    const r = probe('cycle', `
import fs from 'node:fs';
import { cyclePass } from './harness/dev-cycle.mjs';
const evs = ${JSON.stringify(LOG)};
const res = await cyclePass({ now: ${T0} + 3600000, force: true, events: evs, wakeFn: () => ({ started: false }) });
const text = fs.readFileSync(res.brief, 'utf8');
console.log(JSON.stringify({ ran: res.ran, lines: text.split('\\n').filter((l) => /^- T-00\\d: /.test(l)) }));`);
    const lines = r.lines || [];
    return [r.ran === true && lines.join('|') === '- T-001: Completed T-001: first web change|- T-002: Completed T-002: second web change|- T-003: landed|- T-004: Completed T-004: an engine change|- T-005: landed', JSON.stringify(r)];
  });
  await guard('2.88 (l) game-dev loop: the landing step (layout gate, visual results) runs after landings on main or an engine target, and not after a plan closed with no branch (fails on 2.87: it ran after T-006 and named it)', () => {
    const g = path.join(dir, 'game', 'probe288');
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, 'studio.layout.json'), JSON.stringify({ rules: [], layout: 'game/probe288/layout.json' }));
    fs.writeFileSync(path.join(g, 'layout.json'), '{}');
    const code = (evs) => `
import fs from 'node:fs';
import path from 'node:path';
import { STUDIO_STATE_DIR } from './harness/event.mjs';
import { gamedevPass } from './harness/gamedev-loop.mjs';
fs.rmSync(path.join(STUDIO_STATE_DIR, 'layout-last.json'), { force: true });
fs.writeFileSync(path.join(STUDIO_STATE_DIR, 'gamedev.json'), JSON.stringify({ lastPass: ${T0} + 5 * 60000 }));
await gamedevPass(${T0} + 3600000, { events: ${JSON.stringify(evs)} });
let after = null; try { after = JSON.parse(fs.readFileSync(path.join(STUDIO_STATE_DIR, 'layout-last.json'), 'utf8')).after; } catch {}
console.log(JSON.stringify({ after }));`;
    const xenv = { STUDIO_GAME: 'probe288', STUDIO_GAMEDEV_SKIP: 'stall,refill,milestones,launch,tiers,review,cycle' };
    // The last pass was at minute 5: T-001..T-003 landed before it, then only the plan T-006 closed (or, in `all`, T-004 and T-005 landed too).
    const planOnly = probe('loop1', code(LOG.filter((e) => e.task === 'T-006' || Date.parse(e.ts) <= T0 + 5 * 60000)), xenv);
    const all = probe('loop2', code(LOG), xenv);
    return [planOnly.after === null && (all.after || []).join(',') === 'T-004,T-005', JSON.stringify({ planOnly, all, tmp: Boolean(tmpRoot) })];
  });
}
