/**
 * qa/selftest-2583n.mjs — 2.58.3 (N1-N4), from a crew's logs (harness 2.56.0, Windows):
 *   N1 a person's `agent stop` (or pause) was recorded as a crash (session.end "exit 1", stoppedBy null), so two stops
 *      in a row halted the supervisor for 5 hours, and the stop's hand-back counted toward parking and the breaker;
 *   N2 a task claimed by an agent working outside the launcher was handed back when its claim ran out while that
 *      agent was still working on it, and the supervisor gave it to a new builder (duplicate agents);
 *   N3 the watchdog parked a task again 10 s after a person unparked it, and parked it three times at once;
 *   N4 rescue steps nobody could pick up (supervisor halted, no launcher) escalated and shelved the task.
 * Each check fails on 2.58.2.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest2583N({ dir, run, report, tmpRoot }) {
  const SLOW = Number(process.env.STUDIO_SELFTEST_SLOW) || (process.platform === 'win32' ? 2.5 : 1);
  // No tool set for any role: a supervise() pass in a probe can never start a real agent.
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_AGENT_TOOL: '', STUDIO_BUILDER_TOOL: '', STUDIO_BUILDER_CMD: '', STUDIO_AGENT_CMD: '', STUDIO_WATCHDOG_LAUNCH: 'off', STUDIO_GAMEDEV_WAKE_DIRECTOR: 'off', STUDIO_DEV_CYCLE_WAKE: 'off' };
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const until = (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms && !fn()) nap(100);
    return fn();
  };
  let n = 0;
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p2583n-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...base, ...env });
    try { return JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop()); } catch { return { error: out(r) }; }
  };
  const stateDir = path.join(dir, '.studio');
  const agentsDir = path.join(stateDir, 'agents');
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const readEvents = (f = path.join(stateDir, 'events.jsonl')) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const task = (title, env = {}) => (run(dir, `node harness/task.mjs add "${title}" --role builder`, { ...base, ...env }).stdout.match(/"id":\s*"(T-\d+)"/) || [])[1];
  const locksOf = (agent, env = {}) => (JSON.parse(run(dir, 'node harness/lock.mjs list', { ...base, ...env }).stdout || '{}').locks || []).filter((l) => l.owner === agent).map((l) => l.key);
  const guard = (name, fn) => { try { const [ok, detail] = fn(); report(name, ok, detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const minAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

  // ---------- N1: a person's stop is a stop, not a crash ----------
  {
    const launch = (agent, id) => {
      run(dir, `node harness/agent.mjs start --role builder --agent ${agent} --task ${id} --detach`, { ...base, STUDIO_HEARTBEAT_SEC: '1', STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} wait' });
      return until(() => locksOf(agent).includes(`task:${id}`), 20000 * SLOW);
    };
    const ended = (agent) => readJson(path.join(agentsDir, `${agent}.json`))?.status === 'ended';
    const ta = task('N1 stop probe');
    const tb = task('N1 pause probe');
    const upA = launch('stopn-1', ta);
    const st = run(dir, 'node harness/agent.mjs stop stopn-1 --by hatch', base);
    until(() => ended('stopn-1') && !locksOf('stopn-1').length, 20000 * SLOW);
    const upB = launch('stopn-2', tb);
    const pa = run(dir, 'node harness/agent.mjs pause stopn-2 --by hatch', base);
    until(() => ended('stopn-2') && !locksOf('stopn-2').length, 20000 * SLOW);
    const ev = readEvents();
    const endA = ev.filter((e) => e.type === 'agent.session.end' && e.agent === 'stopn-1').pop();
    const endB = ev.filter((e) => e.type === 'agent.session.end' && e.agent === 'stopn-2').pop();
    const pausedA = ev.filter((e) => e.type === 'task.paused' && e.task === ta).pop();
    const recA = readJson(path.join(agentsDir, 'stopn-1.json'));
    guard('N1: agent stop by name records who stopped it: session.end meta.stoppedBy, reason "stopped by hatch", not an error, no failover (evidence: "human stopped builder-s16" then session.end exit 1, stoppedBy null)', () => [
      upA && endA?.meta?.stoppedBy === 'hatch' && endA.status !== 'error' && /stopped by hatch/.test(endA.meta?.reason || '') && recA?.stoppedBy === 'hatch' && !ev.some((e) => e.type === 'agent.failover' && e.agent === 'stopn-1') && !fs.existsSync(path.join(agentsDir, 'stopn-1.stop')),
      JSON.stringify({ upA, st: out(st).slice(-300), endA, rec: recA && { reason: recA.reason, stoppedBy: recA.stoppedBy } })]);
    guard('N1: agent pause is recorded the same way (stoppedBy, paused by, not an error)', () => [
      upB && endB?.meta?.stoppedBy === 'hatch' && endB.status !== 'error' && /paused by hatch/.test(endB.meta?.reason || ''),
      JSON.stringify({ upB, pa: out(pa).slice(-300), endB })]);
    // The stop's hand-back: marked person-caused (never a loop, never a failure); three of them park nothing.
    const pm = JSON.stringify(pausedA?.msg || '');
    const c = probe(`import { emitEvent } from ${u('harness/event.mjs')};
import { parkIfLooping } from ${u('harness/agent.mjs')};
import { personCaused, loopHandBacks } from ${u('harness/busy.mjs')};
import { escalationFor } from ${u('harness/model-tiers.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
import { readHolds } from ${u('harness/task-hold.mjs')};
const id = ${JSON.stringify(ta)};
for (let i = 0; i < 2; i++) emitEvent({ type: 'task.paused', agent: 'stopn-x', task: id, msg: ${pm} });
const park = parkIfLooping(id);
console.log(JSON.stringify({ person: personCaused({ msg: ${pm} }), counted: loopHandBacks(id, readRecentEvents(20000)).length, park, esc: escalationFor(id), parked: Boolean(readHolds()[id]?.parked) }));`);
    guard('N1: the stop\'s hand-back says "a stop, not a failure": person-caused, no breaker reason, and three of them neither park the task (loop park, watchdog count) nor move it a model tier up', () => [
      /a stop, not a failure/.test(pausedA?.msg || '') && !pausedA?.meta?.reasonKey && c.person === true && c.counted === 0 && c.park === null && c.esc === null && c.parked === false,
      JSON.stringify({ pausedA, c })]);
    // The supervisor: two stopped sessions in a row don't halt it; two real exit-1 crashes still do.
    const sup = probe(`import { emitEvent } from ${u('harness/event.mjs')};
import { supervise } from ${u('harness/supervisor.mjs')};
const from = Date.now() - 3600000;
const stopped = await supervise({ dryRun: true }, { startedAt: from, names: ['stopn-1', 'stopn-2'] });
for (const a of ['crashn-1', 'crashn-2']) emitEvent({ type: 'agent.session.end', agent: a, status: 'error', msg: a + ' ended (exit 1)', meta: { role: 'builder', tool: 'custom', code: 1, reason: 'exit 1' } });
const crashed = await supervise({ dryRun: true }, { startedAt: from, names: ['crashn-1', 'crashn-2'] });
console.log(JSON.stringify({ stopped: stopped.why, crashed: crashed.why }));`);
    guard('N1: two stopped sessions in a row don\'t halt the supervisor; two real exit-1 crashes still do (evidence: "Supervisor stopped starting agents: two sessions in a row ended with exit 1 (builder-s16, qa-playtester-s3)")', () => [
      Array.isArray(sup.stopped) && !sup.stopped.some((w) => /halted/.test(w)) && (sup.crashed || []).some((w) => /halted: two sessions in a row ended with exit 1 \(crashn-1, crashn-2\)/.test(w)),
      JSON.stringify(sup)]);
  }

  // ---------- N2: a live owner's expired claim is not handed back ----------
  {
    const evFile = path.join(stateDir, 'events-2583n-n2.jsonl');
    const env = { AGENT_EVENTS_FILE: evFile, STUDIO_FLOW_IDLE_MIN: '999' };
    const tc = task('N2 live owner', env);
    const td = task('N2 silent owner', env);
    const te = task('N2 watcher probe', env);
    const tf = task('N2 supervisor probe', env);
    run(dir, `node harness/task.mjs start ${tc} --agent opus-n2`, env);
    run(dir, `node harness/task.mjs start ${td} --agent quiet-n2`, env);
    run(dir, `node harness/task.mjs start ${te} --agent opus-n2`, env);
    run(dir, `node harness/task.mjs start ${tf} --agent opus-n2`, env);
    // The claims ran out (an hour after task start); the starts were 70 min ago.
    const lockDir = path.join(stateDir, 'locks');
    for (const f of fs.readdirSync(lockDir).filter((x) => x.endsWith('.lock'))) {
      const l = readJson(path.join(lockDir, f));
      if (l && [tc, td, te, tf].map((x) => `task:${x}`).includes(l.key)) fs.writeFileSync(path.join(lockDir, f), JSON.stringify({ ...l, claimedAt: minAgo(70), expiresAt: minAgo(10) }));
    }
    const lines = readEvents(evFile).map((e) => (e.type === 'task.start' ? { ...e, ts: minAgo(70) } : e));
    lines.push({ ts: minAgo(45), type: 'agent.now', agent: 'quiet-n2', msg: 'reading the brief' });
    lines.push({ ts: minAgo(10), type: 'gates.run', agent: 'opus-n2', msg: 'gates run by opus-n2' });
    fs.writeFileSync(evFile, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const r = probe(`import { flowPass } from ${u('harness/director-flow.mjs')};
import { watchPass } from ${u('harness/watch.mjs')};
import { parseNextQueue } from ${u('harness/task.mjs')};
const ids = ${JSON.stringify({ tc, td, te, tf })};
const w = watchPass({ dryRun: true });
const f = await flowPass({ fill: false });
const q = parseNextQueue();
const where = (id) => q.inProgress.some((t) => t.id === id) ? 'in_progress' : q.backlog.some((t) => t.id === id) ? 'backlog' : 'other';
console.log(JSON.stringify({ tc: where(ids.tc), td: where(ids.td), busy: f.busy || [], actions: f.actions, watch: w.findings.filter((x) => [ids.te, ids.td].includes(x.task)).map((x) => ({ kind: x.kind, task: x.task, msg: x.msg })) }));`, env);
    guard('N2: an expired claim whose owner was active 10 min ago is kept by the Director\'s flow pass, and the reason names the owner (evidence: "The claim ran out with no running session on it: handed back by the Director\'s flow pass" while opus-bot ran gates)', () => [
      r.tc === 'in_progress' && (r.busy || []).some((b) => b.id === tc && /opus-n2/.test(b.why) && /10 min ago/.test(b.why)),
      JSON.stringify(r)]);
    guard('N2: an owner silent for 45 min is handed back as before', () => [r.td === 'backlog' && (r.actions || []).some((a) => a.includes(`handed back ${td}`)), JSON.stringify(r)]);
    guard('N2: the watcher\'s requeue keeps a live owner\'s task too (and still requeues a silent owner\'s)', () => [
      (r.watch || []).some((x) => x.task === te && x.kind === 'kept' && /opus-n2/.test(x.msg)) && (r.watch || []).some((x) => x.task === td && x.kind === 'requeued'),
      JSON.stringify(r.watch)]);
    // Handed back anyway (an older pass, the watcher before this fix): the supervisor doesn't give it to a new agent.
    const s = probe(`import { pauseTask } from ${u('harness/task.mjs')};
import { emitEvent } from ${u('harness/event.mjs')};
import { supervise } from ${u('harness/supervisor.mjs')};
import { setHold } from ${u('harness/task-hold.mjs')};
const tf = ${JSON.stringify(tf)};
pauseTask(tf, 'director', "The claim ran out with no running session on it: handed back by the Director's flow pass so a free builder can take it.", { force: true });
setHold(${JSON.stringify(td)}, { parked: { by: 'selftest', why: 'out of the way' } }, { by: 'selftest' });
const live = await supervise({ dryRun: true }, { startedAt: Date.now() - 3600000, names: [] });
emitEvent({ type: 'gates.run', agent: 'nobody', msg: 'x' });
console.log(JSON.stringify({ why: live.why }));`, env);
    guard('N2: a task handed back because its claim ran out while its owner is still active is held for that owner by the supervisor (evidence: T-057 started by builder-s29, then "Task T-057 already claimed by builder-s29" for opus-bot)', () => [
      (s.why || []).some((w) => new RegExp(`held: .*${tf} waits for opus-n2`).test(w)),
      JSON.stringify(s)]);
  }

  // ---------- N3: the watchdog honours an unpark and parks once ----------
  {
    const evFile = path.join(stateDir, 'events-2583n-n3.jsonl');
    const env = { AGENT_EVENTS_FILE: evFile, STUDIO_GAMEDEV_SKIP: 'stall,refill,milestones,launch,landing,tiers,review,cycle', STUDIO_WATCHDOG_IDLE_HOURS: '0' };
    const ev = [];
    for (const m of [50, 40, 30]) ev.push({ ts: minAgo(m), type: 'task.paused', agent: 'b-n3', task: 'T-981', msg: 'Handed back T-981: the shader still fails' });
    ev.push({ ts: minAgo(20), type: 'task.hold', agent: 'hatch', task: 'T-981', msg: 'hatch unparked T-981' });
    ev.push({ ts: minAgo(10), type: 'task.paused', agent: 'b-n3', task: 'T-981', msg: 'Handed back T-981: the shader still fails' });
    for (const m of [50, 40, 30]) ev.push({ ts: minAgo(m), type: 'task.paused', agent: 'b-n3', task: 'T-982', msg: 'Handed back T-982: real failure' });
    for (const m of [50, 40, 30]) ev.push({ ts: minAgo(m), type: 'task.paused', agent: 'b-n3', task: 'T-983', msg: 'Handed back T-983: real failure' });
    fs.writeFileSync(evFile, `${ev.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const code = (which) => `import { setWatchdog, watchdogPass } from ${u('harness/watchdog.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
import { readHolds } from ${u('harness/task-hold.mjs')};
setWatchdog(true, 'selftest');
const events = readRecentEvents(5000);
const runs = await Promise.all([0, 1, 2].map(() => watchdogPass(Date.now(), { events })));
console.log(JSON.stringify({ which: ${JSON.stringify(which)}, parks: runs.flatMap((r) => r.actions).filter((a) => a.kind === 'park').map((a) => a.task), holds: readHolds() }));`;
    const a = probe(code('in-process'), env);
    // And three processes at the same moment (the supervisor's, the watcher's and the hub's passes).
    const f = path.join(tmpRoot, `p2583n-par-${process.pid}.mjs`);
    fs.writeFileSync(f, code('process'));
    const { spawn } = await import('node:child_process');
    const procs = [0, 1, 2].map(() => new Promise((res) => {
      const c = spawn(process.execPath, [f], { cwd: dir, env: { ...process.env, ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let o = '';
      c.stdout.on('data', (d) => (o += d));
      c.on('exit', () => res(o));
    }));
    await Promise.all(procs);
    const all = readEvents(evFile);
    const parkEv = (id) => all.filter((e) => e.type === 'task.hold' && e.task === id && /watchdog parked/.test(e.msg || '')).length;
    guard('N3: an unpark resets the watchdog\'s hand-back count (evidence: "hatch unparked T-031" then 10 s later "watchdog parked T-031: handed back 3 times in 2 h")', () => [
      !a.holds?.['T-981']?.parked && !(a.parks || []).includes('T-981'),
      JSON.stringify({ a, ev981: all.filter((e) => e.task === 'T-981').map((e) => e.msg) })]);
    guard('N3: watchdog passes running at the same moment park a task once, with one event (evidence: "watchdog parked T-012" three times within 6 s)', () => [
      a.holds?.['T-982']?.parked?.by === 'watchdog' && (a.parks || []).filter((t) => t === 'T-982').length === 1 && parkEv('T-982') === 1 && parkEv('T-983') === 1 && all.filter((e) => e.type === 'watchdog.action' && e.task === 'T-983' && /parked/.test(e.msg || '')).length === 1,
      JSON.stringify({ parks: a.parks, e982: parkEv('T-982'), e983: parkEv('T-983') })]);
  }

  // ---------- N4: rescues nobody can pick up don't escalate ----------
  {
    const evFile = path.join(stateDir, 'events-2583n-n4.jsonl');
    const env = { AGENT_EVENTS_FILE: evFile, STUDIO_GAMEDEV_SKIP: 'stall,refill,milestones,launch,landing,tiers,review,cycle', STUDIO_WATCHDOG_IDLE_HOURS: '0', STUDIO_RESCUE_MODELS: 'gpt-6,gemini-3-pro', STUDIO_RESCUE_MODEL: '', STUDIO_TIER_TOP_MODEL: '' };
    const stuck = task('N4 stuck task', env);
    const rescue = task(`Rescue: ${stuck} stuck (probe)`, env);
    const r = probe(`import fs from 'node:fs';
import { setWatchdog, watchdogPass } from ${u('harness/watchdog.mjs')};
import { readHolds } from ${u('harness/task-hold.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
import { STATUS_FILE } from ${u('harness/supervisor.mjs')};
import { selfIdentity } from ${u('harness/proc-identity.mjs')};
setWatchdog(true, 'selftest');
const H = 3600000, M = 60000, t0 = Date.now();
const rescue = ${JSON.stringify(rescue)};
const sup = (halted) => fs.writeFileSync(STATUS_FILE, JSON.stringify({ pid: process.pid, identity: selfIdentity(), status: 'running', startedAt: new Date(t0).toISOString(), ...(halted ? { halted: { at: new Date(t0).toISOString(), why: 'two sessions in a row ended with exit 1 (b-1, b-2)' } } : {}) }));
const state = () => ({ sup: Boolean(readHolds()[rescue]?.parked?.superseded), asks: readRecentEvents(5000).filter((e) => e.type === 'agent.ask' && e.agent === 'watchdog' && /waiting/.test(e.msg || '')).map((e) => e.msg) });
// No launcher at all (no supervisor, auto-start off), two hours on: the clock is stopped.
fs.rmSync(STATUS_FILE, { force: true });
await watchdogPass(t0 + 2 * H);
const none = state();
// The supervisor halted: still stopped, and the Producer is told once.
sup(true);
await watchdogPass(t0 + 2 * H + 5 * M);
await watchdogPass(t0 + 2 * H + 10 * M);
const halted = state();
// Starting again: the wait counts from the last time nothing could pick it up, not from when it was queued.
sup(false);
await watchdogPass(t0 + 2 * H + 20 * M);
const resumed = state();
await watchdogPass(t0 + 2 * H + 75 * M);
const later = state();
fs.rmSync(STATUS_FILE, { force: true });
const shelved = readRecentEvents(5000).some((e) => e.type === 'task.shelved');
const step2 = readRecentEvents(5000).filter((e) => e.type === 'task.rescue').map((e) => e.msg);
console.log(JSON.stringify({ none, halted, resumed, later, shelved, step2 }));`, env);
    guard('N4: while no launcher runs or the supervisor is halted, a queued rescue\'s pick-up clock is stopped (no escalation, no shelving) and the Producer is told once per reason (evidence: "Watchdog T-044 was stuck (nobody picked the rescue up in 60 min)"; T-016 shelved while the supervisor was halted)', () => [
      r.none && !r.none.sup && r.none.asks.length === 1 && /no launcher is running/.test(r.none.asks[0]) && !r.halted.sup && r.halted.asks.length === 2 && /waiting: the supervisor is halted/.test(r.halted.asks[1]) && !r.shelved,
      JSON.stringify(r)]);
    guard('N4: once agents can start again the rescue waits its full time from then, then moves to the next step as before', () => [
      r.resumed && !r.resumed.sup && r.later?.sup === true && (r.step2 || []).some((m) => new RegExp(`${stuck}: rescue step \\d T-\\d+ queued`).test(m)),
      JSON.stringify(r)]);
  }
}
