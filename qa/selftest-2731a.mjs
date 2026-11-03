/**
 * qa/selftest-2731a.mjs — 2.73.1 (helper a): the stall watchdog vs a session's own verify, halts, the run clock.
 *   B-68     a session waiting on its own verify (.studio/verify-running/<agent>.json or a full*.json it owns, live
 *            process, no result) or its own background task done (.studio/done-running/, any task, by agent) is busy,
 *            not stalled: the stall clock is held and the wall-clock cap stretches, bounded by
 *            STUDIO_STALL_VERIFY_MAX_MIN (60); a finished, dead or too-old verify counts for nothing
 *   B-66 a   sessions that end within STUDIO_HALT_SAME_DEATH_SEC (5) of each other count as one end for the "two in a
 *            row" halt; ends the launcher caused itself (stall, idle, budget) never count
 *   B-66 b   agent.session.end records meta.exitCause (signal vs exit code vs the launcher's own kill)
 *   B-66 c   the supervisor's builder halt doesn't stop the train daemon; drain and "Stop all" still do
 *   extend   `npm run studio:extend -- --until …` moves a running supervisor's end time (no restart), logged; refused
 *            for a worker session and for an agent without a person's permission
 * Each check fails on 2.73.0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest2731A({ dir, run, report, tmpRoot, root }) {
  void run; void root;
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_HEAVY_SLOTS: '0', STUDIO_HOOKS_CHECK: 'off',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', STUDIO_REPORT_WEBHOOK: '', STUDIO_UPGRADE_WATCH_MIN: 'off',
    STUDIO_DRIFT: 'off', STUDIO_STALL: '', STUDIO_STALL_MIN: '', STUDIO_STALL_PLAN_MIN: '', STUDIO_SESSION_MAX_MIN: '', STUDIO_SESSION_PLAN_MAX_MIN: '', STUDIO_STALL_VERIFY_MAX_MIN: '', STUDIO_DONE_RUNNING_MAX_MIN: '90',
    STUDIO_HALT_SAME_DEATH_SEC: '', STUDIO_TRAIN: '', STUDIO_TRAIN_AUTO: '', STUDIO_TRAIN_MIN: '1', STUDIO_TRAIN_WAIT_MIN: '', STUDIO_MACHINE_SCAN: 'off', STUDIO_RESUME_BY: '', STUDIO_TZ: '',
    STUDIO_BUILDER_CMD: '', STUDIO_PRODUCER_CMD: '', STUDIO_AGENT_CMD: '', STUDIO_AGENT_TOOL: '', STUDIO_THREADS: '', STUDIO_DIGEST: '', STUDIO_LANELESS: 'shared', STUDIO_REHEARSAL: '',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2731a-${process.pid}.pem`), ...ident,
  };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `2731a-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-2731a.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    made.push(S);
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  // A probe script lives outside the studio copy (so it never changes the copy's git status) and runs with cwd = copy.
  const probe = (S, env, name, code) => {
    const f = path.join(tmpRoot, `probe-2731a-${name}-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { cwd: S, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });
    const t = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(t), _err: r.stderr?.slice(-1500) }; } catch { return { _err: `${out(r).slice(-2500)}` }; }
  };
  const M = 60000;

  // ---- B-68: a session waiting on its own verify ----
  await guard('2.73.1 (B-68): a builder waiting on its own running verify (.studio/verify-running/<agent>.json, live host, no result; or an in-process full*.json it owns) is not ended by the stall watchdog after STUDIO_STALL_MIN (15) quiet minutes; once the verify has its result the stall clock runs again from then; a verify whose process is gone, or older than STUDIO_STALL_VERIFY_MAX_MIN (60), counts for nothing (fails on 2.73.0: only task done held the clock, so the builder was ended mid-verify)', async () => {
    const { S, env } = studio('verify');
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    const r = probe(S, env, 'verify', `import fs from 'node:fs'; import path from 'node:path';
import { observe } from ${u(S, 'harness/stall.mjs')};
const root = path.resolve('.'); const M = 60000; const now = Date.now(); const iso = (t) => new Date(t).toISOString();
const vdir = path.join(root, '.studio', 'verify-running'); fs.mkdirSync(vdir, { recursive: true });
const sess = (agent, startedAt) => ({ agent, role: 'builder', startedAt: iso(startedAt), task: 'T-1' });
const w = (f, o) => fs.writeFileSync(path.join(vdir, f), JSON.stringify(o));
const r = {};
const a = sess('builder-v1', now - 40 * M); observe(a, { now: now - 40 * M, cwd: root });
w('builder-v1.json', { runId: 'r1', owner: 'builder-v1', startedAt: iso(now - 20 * M), state: 'running', hostPid: process.pid });
r.running = observe(a, { now, cwd: root });
w('builder-v1.result.json', { runId: 'r1', code: 0, endedAt: iso(now + M) });
r.finished = observe(a, { now: now + 16 * M, cwd: root });
const b = sess('builder-v2', now - 70 * M); observe(b, { now: now - 70 * M, cwd: root });
w('builder-v2.json', { runId: 'r2', owner: 'builder-v2', startedAt: iso(now - 61 * M), state: 'running', hostPid: process.pid });
r.tooOld = observe(b, { now, cwd: root });
const c = sess('builder-v3', now - 40 * M); observe(c, { now: now - 40 * M, cwd: root });
w('full.json', { pid: process.pid, owner: 'builder-v3', root, args: [], startedAt: iso(now - 10 * M) });
r.full = observe(c, { now, cwd: root });
const d = sess('builder-v4', now - 40 * M); observe(d, { now: now - 40 * M, cwd: root });
w('builder-v4.json', { runId: 'r4', owner: 'builder-v4', startedAt: iso(now - 10 * M), state: 'running', hostPid: ${dead} });
r.dead = observe(d, { now, cwd: root });
console.log(JSON.stringify(r));
`);
    const ok = r.running?.stalled === false && r.finished?.stalled === true && r.finished.kind === 'no-progress'
      && r.tooOld?.stalled === true && r.tooOld.kind === 'no-progress' && r.full?.stalled === false && r.dead?.stalled === true;
    return [ok, JSON.stringify(r).slice(0, 2500)];
  });

  await guard('2.73.1 (B-68): a planning session waiting on its own background task done (a done-running record naming it, for a task it was not started on) is held past its 25-min wall-clock cap, by at most STUDIO_STALL_VERIFY_MAX_MIN (60) minutes; past cap + 60 it is ended (wall-clock) even while it still waits (fails on 2.73.0: only the session\'s own task\'s done counted, and never against the wall-clock cap)', async () => {
    const { S, env } = studio('done');
    const r = probe(S, env, 'done', `import fs from 'node:fs'; import path from 'node:path';
import { observe } from ${u(S, 'harness/stall.mjs')};
const root = path.resolve('.'); const M = 60000; const now = Date.now(); const iso = (t) => new Date(t).toISOString();
const dd = path.join(root, '.studio', 'done-running'); fs.mkdirSync(dd, { recursive: true });
const p = { agent: 'producer-w1', role: 'producer', startedAt: iso(now - 26 * M), task: null };
observe(p, { now: now - 26 * M, cwd: root });
fs.writeFileSync(path.join(dd, 'T-9.json'), JSON.stringify({ task: 'T-9', agent: 'producer-w1', pid: process.pid, at: iso(now - 5 * M) }));
const r = {};
r.waiting = observe(p, { now, cwd: root });
r.capped = observe(p, { now: now + 61 * M, cwd: root });
fs.rmSync(path.join(dd, 'T-9.json'));
const q = { agent: 'producer-w2', role: 'producer', startedAt: iso(now - 26 * M), task: null };
observe(q, { now: now - 26 * M, cwd: root });
r.notWaiting = observe(q, { now, cwd: root });
console.log(JSON.stringify(r));
`);
    const ok = r.waiting?.stalled === false && /task done/.test(r.waiting.waiting || '') && r.capped?.stalled === true && r.capped.kind === 'wall-clock' && /\+60 min/.test(r.capped.why)
      && r.notWaiting?.stalled === true && r.notWaiting.kind === 'wall-clock';
    return [ok, JSON.stringify(r).slice(0, 2500)];
  });

  // ---- B-66: halts ----
  const deps = `{ sessions: () => [], startAgent: () => ({ ok: false, message: 'test' }), launchableRoles: () => [], nextAgentName: () => 'x-1' }`;
  const { S: HS, env: henv, ev: hev } = studio('halt');
  const putEnds = (list) => fs.appendFileSync(hev, list.map((e) => `${JSON.stringify({ id: `evt_${++n}`, ts: new Date(e.at).toISOString(), type: 'agent.session.end', agent: e.agent, status: 'error', msg: `${e.agent} ended (exit 1)`, meta: { role: 'builder', tool: 'claude', code: e.code || 1, reason: `exit ${e.code || 1}`, ...(e.cause ? { exitCause: { kind: e.cause, code: e.code || 1, signal: null, at: new Date(e.at).toISOString(), ranSec: e.ran ?? 3240 } } : {}) } })}\n`).join(''));
  const now0 = Date.now();
  putEnds([{ agent: 'builder-a1', at: now0 - 5 * M, cause: 'exit' }, { agent: 'builder-a2', at: now0 - 5 * M + 800, cause: 'exit' }]);
  // Two that crashed at launch in the same second (ran 4 s): each counts.
  putEnds([{ agent: 'builder-d1', at: now0 - 2 * M, cause: 'exit', ran: 4 }, { agent: 'builder-d2', at: now0 - 2 * M + 200, cause: 'exit', ran: 4 }]);
  putEnds([{ agent: 'builder-b1', at: now0 - 8 * M, cause: 'stall' }, { agent: 'builder-b2', at: now0 - 4 * M, cause: 'idle' }]);
  putEnds([{ agent: 'builder-c1', at: now0 - 3 * M, code: 127, cause: 'exit' }, { agent: 'builder-c2', at: now0 - 3 * M + 300, code: 127, cause: 'exit' }]);
  const halt = probe(HS, henv, 'halt1', `import { supervise } from ${u(HS, 'harness/supervisor.mjs')};
const now = Date.now(); const M = 60000;
const A = { startedAt: now - 10 * M, names: ['builder-a1', 'builder-a2', 'builder-a3'] };
const B = { startedAt: now - 10 * M, names: ['builder-b1', 'builder-b2'] };
const r = {};
try { await supervise({ watcher: true, dryRun: true, deps: ${deps} }, A, now); } catch (e) { r.errA = e.message; }
r.A1 = A.halted || null;
try { await supervise({ watcher: true, dryRun: true, deps: ${deps} }, B, now); } catch (e) { r.errB = e.message; }
r.B = B.halted || null;
const C = { startedAt: now - 10 * M, names: ['builder-c1', 'builder-c2'] };
try { await supervise({ watcher: true, dryRun: true, deps: ${deps} }, C, now); } catch (e) { r.errC = e.message; }
r.C = C.halted || null;
const D = { startedAt: now - 10 * M, names: ['builder-d1', 'builder-d2'] };
try { await supervise({ watcher: true, dryRun: true, deps: ${deps} }, D, now); } catch (e) { r.errD = e.message; }
r.D = D.halted || null;
console.log(JSON.stringify(r));
`);
  await guard('2.73.1 (B-66 a): two builders that end in the same second (within STUDIO_HALT_SAME_DEATH_SEC, 5) count as ONE end for the "two sessions in a row ended with exit N" halt, and ends the launcher caused itself (meta.exitCause stall, idle) never count; two same-second ends with exit 127 (the tool is missing), or two that crashed at launch (ran 4 s), still halt (fails on 2.73.0: the same-second pair halted the supervisor, and so did two watchdog ends)', async () => [halt.A1 === null && halt.B === null && halt.C?.code === 127 && halt.D?.code === 1 && !halt.errA && !halt.errB && !halt.errC && !halt.errD, JSON.stringify(halt).slice(0, 2500)]);
  putEnds([{ agent: 'builder-a3', at: now0 - M }]);
  const halt2 = probe(HS, henv, 'halt2', `import { supervise, trainDaemonTick } from ${u(HS, 'harness/supervisor.mjs')};
import { trainDaemonPass } from ${u(HS, 'harness/train-daemon.mjs')};
import { setDrain } from ${u(HS, 'harness/busy.mjs')};
import path from 'node:path';
const root = path.resolve('.');
const now = Date.now(); const M = 60000;
const A = { startedAt: now - 10 * M, names: ['builder-a1', 'builder-a2', 'builder-a3'] };
const r = {};
try { await supervise({ watcher: true, dryRun: true, deps: ${deps} }, A, now); } catch (e) { r.errA = e.message; }
r.halted = A.halted || null;
let spawned = 0;
const facts = { root, queue: [{ task: 'T-1', agent: 'builder-q', dir: '/x', head: 'h1', at: new Date(now - M).toISOString() }], lock: null, running: null, room: { ok: true }, winddown: null, stopped: null, spawnTrain: () => { spawned += 1; return { pid: 424242 }; } };
r.tick = await trainDaemonTick(A, {}, facts);
r.train = A.train;
r.plain = await trainDaemonPass({ ...facts, halted: { why: 'something else stopped the studio' } });
await setDrain(true, 'Dana', 'upgrade');
r.drain = await trainDaemonPass({ ...facts, halted: A.halted });
await setDrain(false, 'Dana');
r.stopAll = await trainDaemonPass({ ...facts, halted: A.halted, stopped: 'by Dana' });
r.spawned = spawned;
console.log(JSON.stringify(r));
`);
  const hev2 = events(hev).filter((e) => e.type === 'supervisor.halted' && (e.meta?.causes || []).some((c) => c.agent === 'builder-a3'));
  await guard('2.73.1 (B-66 a/b): a third end after the same-second pair halts as usual, naming the pair as one ("builder-a1 + builder-a2 together"), with scope builders and each end\'s cause in the halt (meta.causes) (fails on 2.73.0: the halt had come one end earlier and named no causes)', async () => [
    halt2.halted && /builder-a1 \+ builder-a2 together/.test(halt2.halted.why) && halt2.halted.scope === 'builders' && (halt2.halted.causes || []).length === 3
      && hev2.length === 1 && (hev2[0].meta?.causes || []).length === 3,
    JSON.stringify({ halted: halt2.halted, ev: hev2 }).slice(0, 2500)]);
  await guard('2.73.1 (B-66 c): the supervisor\'s builder halt doesn\'t stop the train daemon: trainDaemonTick on the halted supervisor starts the train for the queued lane (saying the halt stops new sessions, not trains); a halt with no scope, drain on and "Stop all" still keep it from starting one (fails on 2.73.0: "not starting a train: halted", and drain was not checked)', async () => [
    halt2.tick?.started === true && halt2.train?.started === true && /not trains/.test(halt2.tick.why || '') && halt2.plain?.started === false && /halted/.test(halt2.plain.why || '')
      && halt2.drain?.started === false && /drain is on/.test(halt2.drain.why || '') && halt2.stopAll?.started === false && /Stop all/.test(halt2.stopAll.why || '') && halt2.spawned === 1,
    JSON.stringify(halt2).slice(0, 2500)]);

  // ---- B-66 b: the exit cause on a real session end ----
  await guard('2.73.1 (B-66 b): agent.session.end records how the process ended (meta.exitCause): a session killed by a signal from outside reads kind signal with SIGKILL (Windows: an exit code reads kind exit with that code), and the launcher\'s own kills map to stall/idle/budget, a stop to stopped (fails on 2.73.0: only "exit 1", the signal was dropped)', async () => {
    const { S, env, ev } = studio('cause');
    const win = process.platform === 'win32';
    const s = spawnSync(process.execPath, ['harness/agent.mjs', 'start', '--role', 'builder', '--agent', 'bu-2731a', '--tool', 'claude', '--model', 'm-1'], { cwd: S, encoding: 'utf8', env: { ...process.env, ...env, STUDIO_BUILDER_CMD: win ? 'exit 3' : 'kill -KILL $$' }, timeout: 120000 });
    const end = events(ev).filter((e) => e.type === 'agent.session.end' && e.agent === 'bu-2731a').pop();
    const c = end?.meta?.exitCause || null;
    const unit = probe(S, env, 'cause', `import { exitCause } from ${u(S, 'harness/agent.mjs')};
console.log(JSON.stringify({ stall: exitCause({ code: 1, exit: { killedBy: { kind: 'stall', why: 'no file write for 16 min' } } }), stop: exitCause({ code: 1, exit: {}, stop: { by: 'Dana', kind: 'stop' } }), plain: exitCause({ code: 2, exit: {} }) }));`);
    const ok = c && (win ? c.kind === 'exit' && c.code === 3 : c.kind === 'signal' && c.signal === 'SIGKILL' && /SIGKILL/.test(end.meta.reason || '')) && unit.stall?.kind === 'stall' && unit.stop?.kind === 'stopped' && unit.plain?.kind === 'exit' && unit.plain.code === 2;
    return [ok, `${out(s).slice(-800)}\n${JSON.stringify({ end: end?.meta && { reason: end.meta.reason, exitCause: c }, unit }).slice(0, 2000)}`];
  });

  // ---- studio:extend ----
  await guard('2.73.1: `npm run studio:extend -- --until +3h --by <name>` moves a RUNNING supervisor\'s end time without a restart: a person\'s request is written down (supervisor.extend_asked), the next pass applies it (supervisor.extended, from/to; the status record\'s opts.until) so a supervisor past its old --until keeps going; `--until none` removes the end time; refused for a worker session, for an agent without a person\'s permission, for a time that has passed and when no supervisor runs (fails on 2.73.0: no such command)', async () => {
    const { S, env, ev } = studio('extend');
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
    try {
      const st = path.join(S, '.studio', 'supervisor.json');
      const oldUntil = new Date(Date.now() - 2 * M).toISOString();
      fs.writeFileSync(st, JSON.stringify({ pid: sleeper.pid, status: 'running', startedAt: new Date(Date.now() - 60 * M).toISOString(), opts: { until: oldUntil } }));
      const ext = (args, extra = {}) => spawnSync(process.execPath, ['harness/supervisor.mjs', 'extend', ...args], { cwd: S, encoding: 'utf8', env: { ...process.env, ...env, ...extra } });
      const worker = ext(['--until', '+3h', '--by', 'Dana'], { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s9' });
      const agentNoPerm = ext(['--until', '+3h', '--by', 'Dana'], { CLAUDECODE: '1' });
      const past = ext(['--until', '2001-01-01T00:00:00Z', '--by', 'Dana']);
      const fileAfterRefusals = fs.existsSync(path.join(S, '.studio', 'supervisor-extend.json'));
      const person = ext(['--until', '+3h', '--by', 'Dana', '--why', 'run to the owner\'s count']);
      const asked = events(ev).filter((e) => e.type === 'supervisor.extend_asked');
      // The loop's pass: past its old end time, with "Stop all" on so the pass ends right after the time check.
      fs.writeFileSync(path.join(S, '.studio', 'STOP.json'), JSON.stringify({ by: 'Dana', reason: 'test', at: new Date().toISOString() }));
      const loop = probe(S, env, 'loop', `import { supervise } from ${u(S, 'harness/supervisor.mjs')};
const now = Date.now();
const opts = { until: Date.parse(${JSON.stringify(oldUntil)}), deps: ${deps}, dryRun: true };
const state = { startedAt: now - 3600000, names: [], opts: { until: ${JSON.stringify(oldUntil)} } };
const r1 = await supervise(opts, state, now);
const r2 = await supervise(opts, state, now);
console.log(JSON.stringify({ r1, r2, until: opts.until, stateUntil: state.opts.until, extended: state.extended || null }));
`);
      const extended = events(ev).filter((e) => e.type === 'supervisor.extended');
      const none = ext(['--until', 'none', '--by', 'Dana']);
      const loop2 = probe(S, env, 'loop2', `import { supervise } from ${u(S, 'harness/supervisor.mjs')};
const now = Date.now();
const opts = { until: now - 1000, deps: ${deps}, dryRun: true };
const state = { startedAt: now - 3600000, names: [], opts: {} };
const r = await supervise(opts, state, now);
console.log(JSON.stringify({ r, until: opts.until }));
`);
      fs.rmSync(st, { force: true });
      const noSup = ext(['--until', '+3h', '--by', 'Dana']);
      const threeH = Date.now() + 3 * 3600000;
      const ok = worker.status === 1 && /builder/.test(out(worker)) && agentNoPerm.status === 1 && /permission/.test(out(agentNoPerm)) && past.status === 1 && /has passed/.test(out(past)) && !fileAfterRefusals
        && person.status === 0 && asked.length === 1 && asked[0].meta?.by === 'Dana' && asked[0].meta?.from === oldUntil
        && loop.r1 && !loop.r1.stop && !(loop.r1.why || []).some((w) => /time is up/.test(w)) && Math.abs(loop.until - threeH) < 5 * M && loop.stateUntil === new Date(loop.until).toISOString() && loop.extended?.by === 'Dana'
        && extended.length === 1 && extended[0].meta?.from === oldUntil && extended[0].meta?.to === loop.stateUntil
        && none.status === 0 && loop2.until === null && !loop2.r?.stop && noSup.status === 1 && /no supervisor is running/.test(out(noSup));
      return [ok, JSON.stringify({ worker: out(worker).slice(-300), agentNoPerm: out(agentNoPerm).slice(-300), past: out(past).slice(-200), person: out(person).slice(-400), asked: asked.map((e) => e.meta), loop, extended: extended.map((e) => e.meta), none: out(none).slice(-200), loop2, noSup: out(noSup).slice(-200) }).slice(0, 3000)];
    } finally { try { sleeper.kill(); } catch {} }
  });

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch {} }
}
