/**
 * qa/selftest-230q.mjs — the 2.30q checks, run by qa/selftest.mjs on a copy of the repo.
 * #5 landing through a merge worktree + compare-and-swap ref (the main checkout's dirty index no longer
 *    refuses the land), #6 busy tasks are not stalls and harness-caused hand-backs don't park, filing noise
 *    capped, #7 the budget stop blocks every launch path (custom launchers too), #8 self-reported usage in an
 *    untracked ledger bucket, compact harness output, stable prompt prefix check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest230q({ dir, run, report, tmpRoot }) {
  let n = 0;
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const probe = (code, env = {}, cwd = dir) => {
    const f = path.join(tmpRoot, `p230q-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(cwd, `node "${f}"`, env);
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: out(r) }; }
  };
  const base = { STUDIO_LOCK_OWNER: 'builder-q1', STUDIO_DONE_UNCOMMITTED: 'allow', STUDIO_DONE_NOOP: 'allow', STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG_LAUNCH: 'off', STUDIO_GAMEDEV_WAKE_DIRECTOR: 'off', STUDIO_DEV_CYCLE_WAKE: 'off', STUDIO_VISUAL_GATE: 'off' };
  const g = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });

  // ---- #5: land through the merge worktree ----
  const mkRepo = (name) => {
    const r = path.join(tmpRoot, `q5-${name}-${process.pid}`);
    fs.rmSync(r, { recursive: true, force: true });
    fs.mkdirSync(r, { recursive: true });
    g(r, 'init', '-q', '-b', 'marina');
    g(r, 'config', 'user.email', 'q@t'); g(r, 'config', 'user.name', 'q');
    fs.writeFileSync(path.join(r, '.gitignore'), '.studio/\n.lanes/\n');
    fs.writeFileSync(path.join(r, 'f.txt'), 'one\n'); fs.writeFileSync(path.join(r, 'other.txt'), 'x\n');
    g(r, 'add', '-A'); g(r, 'commit', '-qm', 'a');
    g(r, 'branch', 'lane/b');
    const w = path.join(r, '.lanes', 'b');
    g(r, 'worktree', 'add', '-q', w, 'lane/b');
    fs.writeFileSync(path.join(w, 'f.txt'), 'lane\n'); fs.writeFileSync(path.join(w, 'new.txt'), 'new\n');
    g(w, 'add', '-A'); g(w, '-c', 'user.email=q@t', '-c', 'user.name=q', 'commit', '-qm', 'lane work');
    return r;
  };
  const land = (r, env = {}) => probe(`import { landFastForward } from ${u('harness/worktree.mjs')};
console.log(JSON.stringify(landFastForward(${JSON.stringify(r)}, 'marina', 'lane/b', { taskId: 'T-900' })));`, { ...base, ...env });

  // A: the main checkout has its own uncommitted edit to a file the lane changed (12 refusals in the Marina run).
  const rA = mkRepo('dirty');
  fs.writeFileSync(path.join(rA, 'f.txt'), 'my own edit\n');
  fs.writeFileSync(path.join(rA, 'other.txt'), 'unrelated edit\n');
  const oldWay = g(rA, 'merge', '--ff-only', 'lane/b');
  const a = land(rA);
  const tipA = g(rA, 'rev-parse', 'marina').stdout.trim();
  const laneA = g(rA, 'rev-parse', 'lane/b').stdout.trim();
  const stash = g(rA, 'stash', 'list').stdout;
  const showStash = g(rA, 'stash', 'show', '-p', 'stash@{0}').stdout;
  const statusA = g(rA, 'status', '--porcelain').stdout.trim();
  report('2.30q #5: the old in-checkout merge --ff-only refuses a dirty main checkout (the Marina failure); the new landing succeeds through the merge worktree', oldWay.status !== 0 && a.ok === true && tipA === laneA && fs.existsSync(path.join(rA, '.studio', 'merge-wt', '.git')), `${out(oldWay).slice(0, 200)} | ${JSON.stringify(a)}`);
  report('2.30q #5: the main checkout follows the land (files, index) and its own overlapping edit is kept in a named stash, unrelated edits untouched', fs.readFileSync(path.join(rA, 'f.txt'), 'utf8') === 'lane\n' && fs.existsSync(path.join(rA, 'new.txt')) && /studio land T-900/.test(stash) && /my own edit/.test(showStash) && fs.readFileSync(path.join(rA, 'other.txt'), 'utf8') === 'unrelated edit\n' && statusA === 'M other.txt', `${stash} | ${statusA}`);

  // B: STUDIO_LAND_STASH=off refuses and leaves the branch where it was.
  const rB = mkRepo('nostash');
  fs.writeFileSync(path.join(rB, 'f.txt'), 'mine\n');
  const tipB0 = g(rB, 'rev-parse', 'marina').stdout.trim();
  const b = land(rB, { STUDIO_LAND_STASH: 'off' });
  report('2.30q #5: STUDIO_LAND_STASH=off refuses with the file names and the branch does not move', b.ok === false && /f\.txt/.test(b.message || '') && g(rB, 'rev-parse', 'marina').stdout.trim() === tipB0 && fs.readFileSync(path.join(rB, 'f.txt'), 'utf8') === 'mine\n', JSON.stringify(b));

  // C: a held index.lock in the main checkout is waited out (another agent's git command), not a refusal.
  const rC = mkRepo('lock');
  const lockF = path.join(rC, '.git', 'index.lock');
  fs.writeFileSync(lockF, '');
  const remover = path.join(tmpRoot, `q5-rm-${process.pid}.cjs`);
  fs.writeFileSync(remover, `setTimeout(() => require('fs').rmSync(${JSON.stringify(lockF)}, { force: true }), 1500);`);
  const child = (await import('node:child_process')).spawn(process.execPath, [remover], { detached: true, stdio: 'ignore' });
  child.unref();
  const c = land(rC);
  report('2.30q #5: an index.lock held for 1.5 s in the main checkout is waited out and the land completes', c.ok === true && g(rC, 'rev-parse', 'marina').stdout.trim() === g(rC, 'rev-parse', 'lane/b').stdout.trim() && fs.readFileSync(path.join(rC, 'f.txt'), 'utf8') === 'lane\n', JSON.stringify(c));

  // D: the branch moved (not a fast-forward any more): refused, nothing changes.
  const rD = mkRepo('moved');
  fs.writeFileSync(path.join(rD, 'z.txt'), 'z\n'); g(rD, 'add', 'z.txt'); g(rD, 'commit', '-qm', 'moved');
  const tipD = g(rD, 'rev-parse', 'marina').stdout.trim();
  const d = land(rD);
  report('2.30q #5: a branch that moved since the rebase is refused (rebase again), never overwritten', d.ok === false && /not ahead|moved/.test(d.message || '') && g(rD, 'rev-parse', 'marina').stdout.trim() === tipD, JSON.stringify(d));

  // ---- #6: busy, not stalled ----
  const busy = probe(`import { markDoneRunning, clearDoneRunning, doneRunning, taskBusy, harnessCaused } from ${u('harness/busy.mjs')};
import path from 'node:path';
const dir = path.join(process.cwd(), '.studio');
await markDoneRunning('T-901', 'grokbot-3');
const during = (await taskBusy('T-901')).busy;
const rec = doneRunning('T-901', { dir });
await clearDoneRunning('T-901');
const after = (await taskBusy('T-901')).busy;
const fs = await import('node:fs');
fs.mkdirSync(path.join(dir, 'done-running'), { recursive: true });
fs.writeFileSync(path.join(dir, 'done-running', 'T-902.json'), JSON.stringify({ task: 'T-902', pid: 999999, at: new Date().toISOString() }));
const dead = (await taskBusy('T-902')).busy;
console.log(JSON.stringify({ during, rec: Boolean(rec), after, dead,
  h: [harnessCaused({ msg: "Handed back T-046: The claim ran out with no running session on it: handed back by the Director's flow pass" }), harnessCaused({ msg: "T-122 not done yet: Your work couldn't be added to marina in the main checkout: x" }), harnessCaused({ meta: { cause: 'harness' } }), harnessCaused({ msg: 'Handed back T-017: 2 Pro tries failed (784 s max turns)' })] }));`, base);
  report('2.30q #6: a running task done marks its task busy; cleared or with a dead pid it is not', busy.during === true && busy.rec === true && busy.after === false && busy.dead === false, JSON.stringify(busy));
  report('2.30q #6: claim-ran-out and main-checkout refusals are harness-caused; a real failure is not', JSON.stringify(busy.h) === '[true,true,true,false]', JSON.stringify(busy));

  // parkIfLooping ignores harness-caused hand-backs.
  const park = probe(`import { emitEvent } from ${u('harness/event.mjs')};
import { parkIfLooping } from ${u('harness/agent.mjs')};
for (let i = 0; i < 4; i++) emitEvent({ type: 'task.paused', agent: 'director', task: 'T-903', msg: "Handed back T-903: The claim ran out with no running session on it: handed back by the Director's flow pass so a free builder can take it." });
const a = parkIfLooping('T-903');
for (let i = 0; i < 3; i++) emitEvent({ type: 'task.paused', agent: 'b', task: 'T-904', msg: 'Handed back T-904: the water shader still fails' });
const b = parkIfLooping('T-904');
console.log(JSON.stringify({ a, b: Boolean(b) }));`, base);
  report('2.30q #6: four claim-ran-out hand-backs do not park a task; three real failures still do', park.a === null && park.b === true, JSON.stringify(park));

  // The watchdog's own count ignores them too (watchdogPass step 2), and a busy task is never parked.
  const wd = probe(`import { emitEvent, readRecentEvents } from ${u('harness/event.mjs')};
import { setWatchdog, watchdogPass } from ${u('harness/watchdog.mjs')};
import { markDoneRunning } from ${u('harness/busy.mjs')};
import { readHolds } from ${u('harness/task-hold.mjs')};
setWatchdog(true, 'selftest');
for (let i = 0; i < 3; i++) emitEvent({ type: 'task.paused', agent: 'director', task: 'T-905', msg: "Handed back T-905: The claim ran out with no running session on it" });
for (let i = 0; i < 3; i++) emitEvent({ type: 'task.paused', agent: 'b', task: 'T-906', msg: 'Handed back T-906: real failure' });
await markDoneRunning('T-906', 'grokbot-9');
for (let i = 0; i < 3; i++) emitEvent({ type: 'task.paused', agent: 'b', task: 'T-907', msg: 'Handed back T-907: real failure' });
const r = await watchdogPass(Date.now(), { events: readRecentEvents(5000) });
const h = readHolds();
console.log(JSON.stringify({ p5: Boolean(h['T-905']?.parked), p6: Boolean(h['T-906']?.parked), p7: Boolean(h['T-907']?.parked), acts: r.actions.map((a) => a.kind) }));`, { ...base, STUDIO_GAMEDEV_SKIP: 'stall,refill,milestones,launch,landing,tiers,review,cycle', STUDIO_WATCHDOG_IDLE_HOURS: '0' });
  report('2.30q #6: the watchdog parks only real loops: not harness-caused hand-backs, not a task whose done is running', wd.p5 === false && wd.p6 === false && wd.p7 === true, JSON.stringify(wd));

  // The stall check: a session waiting on its own done is busy.
  const st = probe(`import { observe } from ${u('harness/stall.mjs')};
import { markDoneRunning, clearDoneRunning } from ${u('harness/busy.mjs')};
const now = Date.now();
const s = { agent: 'builder-s1', role: 'builder', task: 'T-908', startedAt: new Date(now - 40 * 60000).toISOString() };
observe(s, { now: now - 39 * 60000 });
await markDoneRunning('T-908', 'builder-s1');
const busy = observe(s, { now });
await clearDoneRunning('T-908');
const s2 = { ...s, agent: 'builder-s2' };
observe(s2, { now: now - 39 * 60000 });
const idle = observe(s2, { now });
console.log(JSON.stringify({ busy: busy.stalled, idle: idle.stalled, kind: idle.kind }));`, { ...base, STUDIO_SESSION_MAX_MIN: '0' });
  report('2.30q #6: a session 39 min quiet while its task done runs is not stalled; the same session with no done is', st.busy === false && st.idle === true && st.kind === 'no-progress', JSON.stringify(st));

  // Filing noise: one key at most once per hour.
  const mf = probe(`import { mayFile } from ${u('harness/gamedev-loop.mjs')};
const st = {}; const t = Date.now();
console.log(JSON.stringify([mayFile(st, 'review:unchanged', t), mayFile(st, 'review:unchanged', t + 30 * 60000), mayFile(st, 'visual:T-1', t + 30 * 60000), mayFile(st, 'review:unchanged', t + 61 * 60000)]));`, base);
  report('2.30q #6: a review or visual filing key files at most once per hour', JSON.stringify(mf) === '[true,false,true,true]', JSON.stringify(mf));

  // ---- #7: the budget stop ----
  const bs = probe(`import fs from 'node:fs'; import path from 'node:path';
import { budgetStopFor, pickTool } from ${u('harness/budget.mjs')};
const d = path.join(process.cwd(), '.studio'); fs.mkdirSync(d, { recursive: true });
const until = new Date(Date.now() + 3600000).toISOString();
fs.writeFileSync(path.join(d, 'tool-quota.json'), JSON.stringify({ gemini: { until, why: 'spend guard: gemini at 100% of its credit meter', guard: true } }));
const r = {
  custom: budgetStopFor({ tool: 'custom', model: 'gemini-3.1-pro-preview', cmd: '/x/hermes_agent.sh {kickoff} {model}' }).stopped,
  flash: budgetStopFor({ tool: 'custom', model: 'gemini-3-flash-preview' }).stopped,
  cmd: budgetStopFor({ tool: 'custom', model: 'unknown', cmd: 'gemini --yolo -p {kickoff}' }).stopped,
  claude: budgetStopFor({ tool: 'claude', model: 'claude-sonnet-4-5' }).stopped,
  grok: budgetStopFor({ tool: 'custom', model: 'grok-4', cmd: '/x/hermes_agent.sh' }).stopped,
  off: budgetStopFor({ tool: 'custom', model: 'gemini-3.1-pro-preview' }, Date.now(), { STUDIO_BUDGET_STOP: 'off' }).stopped,
};
fs.writeFileSync(path.join(d, 'tool-quota.json'), '{}');
fs.writeFileSync(path.join(d, 'credit.json'), JSON.stringify({ gemini: { used: 295, guard: 295 } }));
r.credit = budgetStopFor({ tool: 'custom', model: 'gemini-3.1-pro-preview' }).stopped;
fs.writeFileSync(path.join(d, 'credit.json'), JSON.stringify({ gemini: { used: 10, guard: 295 } }));
r.under = budgetStopFor({ tool: 'custom', model: 'gemini-3.1-pro-preview' }).stopped;
console.log(JSON.stringify(r));`, base);
  report('2.30q #7: a gemini mark stops custom-launcher sessions on any gemini model or a gemini command, not claude or grok; STUDIO_BUDGET_STOP=off opts out', bs.custom === true && bs.flash === true && bs.cmd === true && bs.claude === false && bs.grok === false && bs.off === false, JSON.stringify(bs));
  report('2.30q #7: a credit meter at its guard stops launches before any mark is written; under the guard it does not', bs.credit === true && bs.under === false, JSON.stringify(bs));

  const sa = probe(`import fs from 'node:fs'; import path from 'node:path';
import { startAgent, runAgent } from ${u('harness/agent.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
const d = path.join(process.cwd(), '.studio');
fs.writeFileSync(path.join(d, 'credit.json'), '{}');
fs.writeFileSync(path.join(d, 'tool-quota.json'), JSON.stringify({ gemini: { until: new Date(Date.now() + 3600000).toISOString(), why: 'spend guard' } }));
const a = startAgent({ role: 'builder', agent: 'builder-q7', tool: 'custom', model: 'gemini-3.1-pro-preview' });
const b = startAgent({ role: 'producer', agent: 'producer-q7', model: 'gemini-3.1-pro-preview' });
const c = await runAgent({ role: 'builder', agent: 'builder-q7b', tool: 'custom', model: 'gemini-3.1-pro-preview', refreshes: 1 });
const again = startAgent({ role: 'builder', agent: 'builder-q7c', tool: 'custom', model: 'gemini-3.1-pro-preview' });
const ev = readRecentEvents(500);
console.log(JSON.stringify({ a: [a.ok, a.skipped], b: [b.ok, b.skipped], c: [c.ok, c.skipped], again: again.skipped, skips: ev.filter((e) => e.type === 'launch.skipped').length, starts: ev.filter((e) => e.type === 'agent.session.start').length }));`, { ...base, STUDIO_PRODUCER_TOOL: 'custom', STUDIO_BUILDER_CMD: 'node -e 0 {kickoff}', STUDIO_PRODUCER_CMD: 'node -e 0 {kickoff}', STUDIO_AGENT_CMD: 'node -e 0' });
  report('2.30q #7: startAgent and a refresh relaunch (runAgent) never start a session under the budget stop', sa.a?.[0] === false && sa.a?.[1] === true && sa.b?.[0] === false && sa.c?.[0] === false && sa.c?.[1] === true && sa.starts === 0, JSON.stringify(sa));
  report('2.30q #7: the skip is logged, once per role/tool/model per 10 min (not one event per attempt)', sa.again === true && sa.skips === 2, JSON.stringify(sa));

  // ---- #8: usage self-report and the untracked ledger bucket ----
  const us = probe(`import { parseUsage, reportUsage } from ${u('harness/task.mjs')};
import { emitEvent, readRecentEvents } from ${u('harness/event.mjs')};
import { ledgerMetrics } from ${u('harness/ledger.mjs')};
const p = [parseUsage('grok-4:180k/12k'), parseUsage('grok-4-fast:1.2M/30000,gemini-3-flash-preview:900/100'), parseUsage('grok-4:abc/1'), parseUsage('')];
reportUsage('T-910', 'grokbot-3', 'grok-4:180k/12k');
emitEvent({ type: 'task.done', agent: 'grokbot-3', task: 'T-910', msg: 'done' });
emitEvent({ type: 'task.done', agent: 'grokbot-5', task: 'T-911', msg: 'done' });
emitEvent({ type: 'agent.session.end', agent: 'builder-1', model: 'gemini-3.1-pro-preview', tokensIn: 400000, tokensOut: 9000, msg: 'end' });
const m = ledgerMetrics({ events: readRecentEvents(1000), now: Date.now(), logs: [] });
console.log(JSON.stringify({ p0: p[0].list, p1: p[1].list?.map((x) => x.tokensIn), bad: Boolean(p[2].error && p[3].error), rows: m.rows.filter((r) => r.untracked).map((r) => [r.model, r.tokensIn, r.tokensOut]), u: m.untracked }));`, base);
  report('2.30q #8: --usage parses <model>:<in>/<out> (k/M, several models) and refuses a malformed value', JSON.stringify(us.p0) === '[{"model":"grok-4","tokensIn":180000,"tokensOut":12000}]' && JSON.stringify(us.p1) === '[1200000,900]' && us.bad === true, JSON.stringify(us));
  report('2.30q #8: self-reported usage lands in the untracked bucket; a done with no usage at all is counted and named', JSON.stringify(us.rows) === '[["grok-4",180000,12000]]' && us.u?.reported === 1 && us.u.unreportedDone === 1 && us.u.unreportedAgents?.[0] === 'grokbot-5', JSON.stringify(us));
  const led = run(dir, 'node harness/ledger.mjs', base);
  report('2.30q #8: npm run ledger shows the untracked line with the model and the unreported done', /Untracked \(outside the harness, self-reported\): 1 reports, in 180k, out 12k \(grok-4\); 1 task\(s\) done with no usage at all \(grokbot-5\)/.test(led.stdout), led.stdout.slice(0, 900));

  // task done --usage through the CLI (bad value: nothing closed, nothing logged).
  const bad = run(dir, 'node harness/task.mjs done T-001 --agent builder-q1 --usage grok-4', base);
  report('2.30q #8: task done --usage with a bad value refuses before closing anything', bad.status !== 0 && /--usage wants/.test(out(bad)), out(bad).slice(0, 300));

  // Compact output: gates and the task list.
  const full = run(dir, 'node scripts/run-gates.mjs --only purity,isolation', { ...base, STUDIO_COMPACT_OUTPUT: 'off' });
  const comp = run(dir, 'node scripts/run-gates.mjs --only purity,isolation', { ...base, STUDIO_COMPACT_OUTPUT: 'on' });
  report('2.30q #8: compact verify prints less, keeps PASS lines, writes each gate log to .studio/gates/out', comp.status === 0 && full.status === 0 && out(comp).length < out(full).length && /PASS purity/.test(out(comp)) && fs.existsSync(path.join(dir, '.studio', 'gates', 'out', 'purity.log')), `${out(full).length} -> ${out(comp).length}`);
  const lf = run(dir, 'node harness/task.mjs list', base);
  const lc = run(dir, 'node harness/task.mjs list', { ...base, STUDIO_COMPACT_OUTPUT: 'on' });
  const la = run(dir, 'node harness/task.mjs list --all', { ...base, STUDIO_COMPACT_OUTPUT: 'on' });
  report('2.30q #8: task list is trimmed in a launched session (--all still prints the whole board)', lc.status === 0 && lc.stdout.length < lf.stdout.length && /trimmed/.test(lc.stdout) && la.stdout === lf.stdout, `${lf.stdout.length} -> ${lc.stdout.length}`);

  const vl = probe(`import { volatileLeaks } from ${u('harness/prompt-layout.mjs')};
import { kickoffParts } from ${u('harness/kickoff.mjs')};
const k = kickoffParts({ role: 'builder', agent: 'builder-auto-64', model: 'gemini-3.1-pro-preview', launched: true });
console.log(JSON.stringify({ clean: volatileLeaks(k.stable, { agent: 'builder-auto-64', model: 'gemini-3.1-pro-preview', task: 'T-142' }), leak: volatileLeaks('You are builder-auto-64 on T-142 at 2026-10-24T05:20', { agent: 'builder-auto-64', task: 'T-142' }) }));`, base);
  report('2.30q #8: the builder kickoff stable prefix carries no agent, model, task or time; a leak is named', Array.isArray(vl.clean) && vl.clean.length === 0 && vl.leak?.length === 3, JSON.stringify(vl));

  // ---- drain ----
  const dOn = run(dir, 'node harness/task.mjs drain on --by selftest --why upgrade', base);
  const dSt = run(dir, 'node harness/task.mjs drain status', base);
  const t0 = Date.now();
  const dDone = run(dir, 'node harness/task.mjs done T-001 --agent builder-q1', { ...base, STUDIO_DRAIN_WAIT_MIN: '0.03', STUDIO_DRAIN_POLL_MS: '200' });
  const waited = Date.now() - t0;
  const board = fs.readFileSync(path.join(dir, 'studio', 'NEXT.md'), 'utf8');
  report('2.30q drain: drain on makes status exit 3 and a new done wait, then refuse with nothing closed', dOn.status === 0 && dSt.status === 3 && /Drain on/.test(dSt.stdout) && dDone.status !== 0 && /Drain is still on/.test(out(dDone)) && waited >= 1500 && !/\[x\][^\n]*T-001/.test(board), `${dSt.status} ${waited} ${out(dDone).slice(0, 300)}`);
  fs.mkdirSync(path.join(dir, '.studio', 'done-running'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.studio', 'done-running', 'T-920.json'), JSON.stringify({ task: 'T-920', agent: 'b', pid: process.pid, at: new Date().toISOString() }));
  const wt = probe(`import { runningDones } from ${u('harness/busy.mjs')};
console.log(JSON.stringify((await runningDones()).map((x) => x.task)));`, base);
  const dWait = run(dir, 'node harness/task.mjs drain wait --max 0.01', { ...base, STUDIO_DRAIN_POLL_MS: '100' });
  fs.rmSync(path.join(dir, '.studio', 'done-running', 'T-920.json'), { force: true });
  const dWait2 = run(dir, 'node harness/task.mjs drain wait', base);
  const dOff = run(dir, 'node harness/task.mjs drain off --by selftest', base);
  const dSt2 = run(dir, 'node harness/task.mjs drain status', base);
  report('2.30q drain: drain wait blocks while a done is running and returns when none is; drain off resumes', JSON.stringify(wt) === '["T-920"]' && dWait.status === 1 && dWait2.status === 0 && dOff.status === 0 && dSt2.status === 0, `${JSON.stringify(wt)} ${out(dWait)} ${out(dWait2)}`);
}
