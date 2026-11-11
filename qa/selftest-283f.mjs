/**
 * qa/selftest-283f.mjs — 2.83 (f): the Line Producer and the alerts stop saying the same thing for hours.
 *
 *   dangling   a dependency on a task that is on no list holds only that task; the Producer is asked once, with the fix
 *   gate       one task gating more than STUDIO_CHAIN_GATE_N builder tasks for STUDIO_CHAIN_GATE_MIN minutes: one event, then every 120 min
 *   lead       the builders-low alert leads with the planner's own reason
 *   wake       the Producer's queue-below-target and "stalled" wakes back off while a train or a chain gate is the only blocker
 *   blocked    a plan_blocked reason is said when it changes, else at most every 30 minutes
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest283F({ dir, root, report, tmpRoot }) {
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  // ---- a studio copy: the state files (.studio/line/state.json, asks-posted.json, emit files) are its own ----
  const S = path.join(tmpRoot, `283f-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  try { fs.symlinkSync(path.join(root || dir, 'node_modules'), path.join(S, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* the checks need no package */ }
  fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const evFile = path.join(S, '.studio', 'events-283f.jsonl');
  const env = { ...clean, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, STUDIO_TASK_BUDGET: 'off', STUDIO_WATCHDOG: 'off', CI: '', NODE_OPTIONS: '' };
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, extra = {}) => {
    const f = path.join(S, `.probe-283f-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000 });
    try { fs.rmSync(f, { force: true }); } catch { /* swept later */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['line', 'asks-posted.json', 'emit-seen.json', 'queue-depth.json']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true }); fs.writeFileSync(evFile, ''); };
  const LP = u('harness/line-producer.mjs');
  // A plan's facts: task rows and holds as gatherFacts would make them.
  const FACTS = `
const T0 = Date.parse('2026-03-03T10:00:00Z');
const row = (id, state, block, role = 'builder') => ({ id, title: id, role, priority: 'P2', meta: {}, state, ...(block ? { block } : {}) });
const facts = (tasks, over = {}) => ({ now: T0, tasks, holds: {}, done: new Set(), sessions: [], pace: { maxAgents: 3, perRole: { builder: 3 }, label: 'Test' }, rig: { known: false }, models: {}, ...over });
`;

  // ================= 1. a dependency on a task that is on no list =================
  await guard('2.83 dangling: a task that waits for an id on neither list is held for that reason only: the plan still runs the ready work and does not say it "can\'t run"; with nothing else to run it still says so; the Producer is asked ONCE per (task, missing id) with the fix "npm run task -- after T-2 --remove T-9", not again on the next pass (fails before this fix: every pass said "the chain can\'t finish" and nothing asked)', () => {
    resetState();
    const r = probe(`${FACTS}
import { linePlan, askDangling } from ${LP};
const dang = [{ task: 'T-2', on: 'T-9' }];
const withWork = linePlan(facts([row('T-1', 'ready'), row('T-2', 'blocked', { kind: 'chain', why: 'waits for T-9' })], { dangling: dang }));
const alone = linePlan(facts([row('T-2', 'blocked', { kind: 'chain', why: 'waits for T-9' })], { dangling: dang }));
const posts = [];
const state = {};
const emit = (e) => posts.push(e);
const a1 = askDangling({ dangling: dang, state, now: T0, deps: { emit, askRoot: process.cwd() } });
const a2 = askDangling({ dangling: dang, state, now: T0 + 3600000, deps: { emit, askRoot: process.cwd() } });
const gone = askDangling({ dangling: [], state, now: T0 + 7200000, deps: { emit, askRoot: process.cwd() } });
console.log(JSON.stringify({ reasons: withWork.reasons, order: withWork.order, skipped: !withWork.order.includes('T-2'), aloneReasons: alone.reasons, a1, a2, gone, posts: posts.map((e) => ({ type: e.type, to: e.to, task: e.task, msg: e.msg })) }));`);
    return [r.reasons?.length === 0 && r.order?.join() === 'T-1' && r.skipped && r.aloneReasons?.some((x) => /T-2 waits for T-9/.test(x))
      && r.a1?.length === 1 && r.a2?.length === 0 && r.posts?.length === 1 && r.posts[0].type === 'agent.ask' && r.posts[0].to === 'producer' && /npm run task -- after T-2 --remove T-9/.test(r.posts[0].msg), JSON.stringify(r)];
  });

  // ================= 2. one lane in a train gates the line =================
  await guard('2.83 chain gate: T-548 in a Unity train gates 5 builder tasks: the plan names it with where it is; line.chain_gate fires once only after more than STUDIO_CHAIN_GATE_N tasks have waited STUDIO_CHAIN_GATE_MIN minutes (not at 59 min, not with 3 tasks), and repeats only after 120 more minutes (fails before this fix: no such event, only the same plan_blocked line)', () => {
    resetState();
    const r = probe(`${FACTS}
import { linePlan, chainGateStep, chainGateText } from ${LP};
const mk = (n) => {
  const tasks = [row('T-548', 'running')];
  const holds = {};
  for (let i = 1; i <= n; i++) { tasks.push(row('T-' + i, 'blocked', { kind: 'chain', why: 'waits for T-548' })); holds['T-' + i] = { after: ['T-548'] }; }
  return linePlan(facts(tasks, { holds, inTrain: { 'T-548': 'a Unity train' } }));
};
const p5 = mk(5), p3 = mk(3);
const fires = [];
let gs = {};
const step = (min, p) => { const s = chainGateStep({ gates: p.gates, gateState: gs, now: T0 + min * 60000 }); gs = s.gateState; if (s.fire.length) fires.push({ min, text: chainGateText(s.fire[0], T0 + min * 60000) }); };
for (const m of [0, 30, 59]) step(m, p5);
const before = fires.length;
step(61, p5); step(62, p5); step(180, p5);
const afterFirst = fires.length;
step(182, p5); step(300, p5);
const g3 = chainGateStep({ gates: p3.gates, gateState: {}, now: T0 }); const g3late = chainGateStep({ gates: p3.gates, gateState: g3.gateState, now: T0 + 500 * 60000 });
console.log(JSON.stringify({ gate: p5.gates[0], before, afterFirst, total: fires.length, mins: fires.map((f) => f.min), text: fires[0]?.text, threeFire: g3late.fire.length }));`);
    return [r.gate?.task === 'T-548' && r.gate.n === 5 && /Unity train/.test(r.gate.where) && r.before === 0 && r.afterFirst === 1 && r.total === 2 && r.mins?.join() === '61,182' && r.threeFire === 0
      && /T-548 gates 5 builder tasks/.test(r.text) && /in a Unity train/.test(r.text) && /since \d\d:\d\d/.test(r.text) && /split off the parts that do not need it, or remove the dependency: npm run task -- after <ID> --remove T-548/i.test(r.text), JSON.stringify(r)];
  });

  // ================= 3. the builders-low alert leads with the planner's reason =================
  await guard('2.83 lead: "0 of 3 builders busy for 8 h 14 min" now leads with the planner\'s own reason ("all ready work waits on T-548, which is in a Unity train since ..., 3 parked, 2 held"), read from the status file the planner wrote, not recomputed (fails before this fix: the alert listed the first unrelated waits)', () => {
    resetState();
    const r = probe(`${FACTS}
import fs from 'node:fs';
import path from 'node:path';
import { linePlan, chainGateStep, planLead } from ${LP};
import { readLineStatus, alertsNow } from ${u('harness/communicator.mjs')};
const tasks = [row('T-548', 'running')];
const holds = {};
for (let i = 1; i <= 5; i++) { tasks.push(row('T-' + i, 'blocked', { kind: 'chain', why: 'waits for T-548' })); holds['T-' + i] = { after: ['T-548'] }; }
for (let i = 20; i < 23; i++) tasks.push(row('T-' + i, 'blocked', { kind: 'park', why: 'parked by someone' }));
for (let i = 30; i < 32; i++) tasks.push(row('T-' + i, 'blocked', { kind: 'held', why: 'held' }));
const p = linePlan(facts(tasks, { holds, inTrain: { 'T-548': 'a Unity train' } }));
const gs = chainGateStep({ gates: p.gates, gateState: {}, now: T0 - 70 * 60000 });
const step2 = chainGateStep({ gates: p.gates, gateState: gs.gateState, now: T0 });
const { lead, blocker } = planLead(p, { gateState: step2.gateState, active: step2.active });
const now = T0 + 9 * 3600000;
fs.mkdirSync(path.join(process.cwd(), '.studio', 'line'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), '.studio', 'line', 'status.json'), JSON.stringify({ at: new Date(now).toISOString(), builders: { running: 0, target: 3 }, blocked: [{ task: 'T-20', why: 'parked by someone' }], text: 'Line: 0/3', lead }));
const line = readLineStatus(process.cwd(), now);
const f = { now, events: [], line, workers: [], stopFiles: [], blockers: [], crewPaused: [], queue: [], held: [], asks: [], needs: [], unendedTrains: [], supRunning: true, sup: {}, trainLock: null };
const al = alertsNow(f, { state: { lowSince: new Date(now - (8 * 60 + 14) * 60000).toISOString() } }).find((a) => a.key === 'builders-low');
console.log(JSON.stringify({ lead, blocker, text: al?.text }));`);
    return [/^all ready work waits on T-548, which is in a Unity train since \d\d:\d\d \(5 tasks\); 3 parked, 2 held$/.test(r.lead || '') && r.blocker?.key === 'T-548|in a Unity train'
      && /^0 of 3 builders busy for 8 h 14 min: all ready work waits on T-548, which is in a Unity train/.test(r.text || '') && !/blocked: /.test(r.text || ''), JSON.stringify(r)];
  });

  // ================= 4. the Producer wake backs off =================
  await guard('2.83 wake: while the planner says everything startable waits on a task in a train, the Producer is woken once, then at most once per STUDIO_PRODUCER_BLOCKED_WAKE_MIN (queue-below-target and "stalled" share that), one agent.wake.skipped per 30 min says why, and a changed or landed blocker wakes at once (fails before this fix: a wake every pass)', async () => {
    resetState();
    const r = probe(`
import { producerWakeBackoff } from ${LP};
import { queueDepthPass } from ${u('harness/queue-depth.mjs')};
import fs from 'node:fs';
const T0 = Date.parse('2026-03-03T10:00:00Z');
const st = (key) => ({ at: new Date(T0).toISOString(), blocker: key ? { key, text: 'all ready work waits on ' + key } : null });
const ev = []; const emit = (e) => ev.push(e.type);
const at = (min, key, kind = 'stalled') => producerWakeBackoff({ now: T0 + min * 60000, kind, status: { ...st(key), at: new Date(T0 + min * 60000).toISOString() }, emit, env: {} }).skip;
const seq = [at(0, 'T-548|train'), at(10, 'T-548|train'), at(20, 'T-548|train', 'queue-below-target'), at(45, 'T-548|train'), at(61, 'T-548|train'), at(62, 'T-548|train'), at(63, 'T-549|train'), at(64, 'T-549|train'), at(65, null), at(66, 'T-549|train')];
const skipEvents = ev.filter((t) => t === 'agent.wake.skipped').length;
// the queue-depth wake itself
let wakes = 0;
const q = { inProgress: [], backlog: [], done: [] };
const status = (m) => ({ at: new Date(T0 + 200 * 60000 + m * 60000).toISOString(), blocker: { key: 'T-700|train', text: 'all ready work waits on T-700' } });
const run = async (m) => queueDepthPass({ q, cap: 3, now: T0 + 200 * 60000 + m * 60000, env: { STUDIO_REFILL_WAKE: 'on', STUDIO_QUEUE_DEPTH_ASK_MIN: '1' }, deps: { holds: {}, events: [], wake: async () => { wakes++; return { started: true }; }, lineStatus: status(m) } });
const a = await run(0); const b = await run(5); const c = await run(10);
console.log(JSON.stringify({ seq, skipEvents, wakes, qd: [a.woke?.skipped || false, b.woke?.skipped || false, c.woke?.skipped || false] }));`, { STUDIO_REFILL_WAKE: 'on' });
    return [r.seq?.join() === 'false,true,true,true,false,true,false,true,false,false' && r.skipEvents === 3 /* skips at 10 and 45 min, then one for the new blocker at 64 min */ && r.wakes === 1 && r.qd?.join() === 'false,true,true', JSON.stringify(r)];
  });

  // ================= 5. plan_blocked is said on change =================
  await guard('2.83 plan_blocked: the same reason text is said once, not again within 30 minutes, said again after 30 minutes, and at once when the text changes (a task id or a count) (fails before this fix: said on every change of the note file, 166 in 26 h)', () => {
    resetState();
    const r = probe(`
import { planBlockedDue } from ${LP};
const T0 = Date.parse('2026-03-03T10:00:00Z');
let st = {};
const say = (min, key) => { const d = planBlockedDue(key, st, T0 + min * 60000); if (d.emit) st = { ...st, blocked: d.blocked }; return d.emit; };
const seq = [say(0, 'A: 5 wait'), say(1, 'A: 5 wait'), say(29, 'A: 5 wait'), say(31, 'A: 5 wait'), say(32, 'A: 6 wait'), say(33, 'A: 5 wait')];
console.log(JSON.stringify({ seq }));`);
    return [r.seq?.join() === 'true,false,false,true,true,true', JSON.stringify(r)];
  });

  try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch { /* the OS cleans its temp folder */ }
}
