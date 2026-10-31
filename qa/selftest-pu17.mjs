/**
 * qa/selftest-pu17.mjs — PU-17 (P-039, P-045): agent stop checks the process at kill time, with no extra process
 * calls on launch or in listings; a stop during start-up stops the launcher.
 *
 * A session record left "running" after a crash or a reboot can name a process number the OS has given to another
 * program since; stopping the agent killed that program (on Windows with its whole tree). The launcher now writes
 * down when each process started (in-process: the spawn time), and only the kill path asks the OS (once) what the
 * number's start time is now (harness/proc-identity.mjs). The first version asked the OS at every launch and in
 * every listing (PowerShell on Windows, about a second each) and failed five selftests on Windows CI (P-045).
 *
 * The OS reader is swapped for a stub (STUDIO_PROC_IDENTITY_STUB, a pid -> start map) where a test needs a given
 * answer or a slow one (STUDIO_PROC_IDENTITY_DELAY_MS); every read is counted (STUDIO_PROC_IDENTITY_LOG). Under the
 * stub the listings take the Windows rule on any OS, so the Windows logic is tested everywhere. A sleeping node
 * stands in for the unrelated program.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftestPU17({ dir, run, report }) {
  const SLOW = Number(process.env.STUDIO_SELFTEST_SLOW) || (process.platform === 'win32' ? 2.5 : 1);
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off' };
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const stateDir = path.join(dir, '.studio');
  const agentsDir = path.join(stateDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const stubFile = path.join(stateDir, 'pu17-stub.json');
  const logFile = path.join(stateDir, 'pu17-reads.jsonl');
  // The reader's call log is always on; the stub only where a test sets it.
  const env = (stub = null, delay = 0) => {
    if (stub) fs.writeFileSync(stubFile, JSON.stringify(stub));
    return { ...base, STUDIO_PROC_IDENTITY_LOG: logFile, ...(stub ? { STUDIO_PROC_IDENTITY_STUB: stubFile } : {}), ...(delay ? { STUDIO_PROC_IDENTITY_DELAY_MS: String(delay) } : {}) };
  };
  const reads = () => {
    try {
      return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const clearReads = () => fs.rmSync(logFile, { force: true });
  const procs = [];
  // The unrelated program: a node that sleeps for ten minutes. Killed in the finally block below.
  const stranger = () => {
    const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)'], { stdio: 'ignore', windowsHide: true });
    c.spawnedAt = Date.now();
    procs.push(c);
    return c;
  };
  // The strangers are this process's children: a killed one stays a zombie (and kill -0 still finds it) until the
  // event loop reaps it, so ask the ChildProcess, after letting the loop run.
  const done = (c) => c.exitCode !== null || c.signalCode !== null;
  const running = async (c) => {
    await new Promise((r) => setTimeout(r, 400));
    return !done(c);
  };
  const exited = (c, ms = 5000 * SLOW) => (done(c) ? Promise.resolve(true) : new Promise((r) => {
    const t = setTimeout(() => r(false), ms);
    c.once('exit', () => { clearTimeout(t); r(true); });
  }));
  // A process that isn't this one's child: gone, or a zombie nobody reaped yet (Linux).
  const pidGone = (pid) => {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code !== 'EPERM') return true;
    }
    try {
      return /^\S+\s+\(.*\)\s+Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      return false;
    }
  };
  const until = (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms && !fn()) nap(100);
    return fn();
  };
  const task = (title, agent) => {
    const id = (run(dir, `node harness/task.mjs add "${title}" --role builder`, base).stdout.match(/"id":\s*"(T-\d+)"/) || [])[1];
    if (agent) {
      run(dir, `node harness/task.mjs start ${id} --agent ${agent}`, base);
      run(dir, `node harness/lock.mjs claim path:docs/pu17-${agent} --owner ${agent}`, base);
    }
    return id;
  };
  const minAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
  const record = (agent, fields) => fs.writeFileSync(path.join(agentsDir, `${agent}.json`), JSON.stringify({ agent, role: 'builder', tool: 'claude', model: 'fake-1', status: 'running', startedAt: minAgo(50), ...fields }, null, 2));
  const readRec = (agent) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(agentsDir, `${agent}.json`), 'utf8'));
    } catch {
      return null;
    }
  };
  const board = () => JSON.parse(run(dir, 'node harness/task.mjs list --all', base).stdout || '{}');
  const backInQueue = (id) => {
    const q = board();
    return (q.backlog || []).some((t) => t.id === id) && !(q.inProgress || []).some((t) => t.id === id);
  };
  const locksOf = (agent) => (JSON.parse(run(dir, 'node harness/lock.mjs list', base).stdout || '{}').locks || []).filter((l) => l.owner === agent).map((l) => l.key);
  const ended = (agent) => readRec(agent)?.status === 'ended';
  const events = (type) => {
    try {
      return fs.readFileSync(path.join(stateDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === type);
    } catch {
      return [];
    }
  };
  const S = 1_790_000_000_000; // a start time on record, for the stub's answers

  try {
    // 1. The compare itself: the recorded start is the spawn time, so the OS's creation time may differ by up to the
    //    tolerance (3 s); a start a process measured itself may be later than the OS's by Node's own start-up.
    {
      const f = path.join(dir, '.probe-pu17-same.mjs');
      fs.writeFileSync(f, `import { sameProcess, START_TOLERANCE_MS, winStartsFrom } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness/proc-identity.mjs')).href)};
const S = ${S};
// Windows' reader output: PowerShell's own line is the reference. Shifted by a whole time zone (7 h), it is taken back out.
const tz = winStartsFrom(['self|900', '900|' + (S + 40 - 7 * 3600000) + '|powershell.exe', '123|' + (S - 5000 - 7 * 3600000) + '|node.exe', '456||System'].join('\\r\\n'), S);
const ok = winStartsFrom(['self|900', '900|' + (S + 40) + '|powershell.exe', '123|' + (S - 5000) + '|node.exe'].join('\\n'), S);
const win = { tz123: tz.get(123)?.start - (S - 5000), tzCmd: tz.get(123)?.cmd, tz456: tz.get(456)?.error || null, ok123: ok.get(123)?.start - (S - 5000) };
console.log(JSON.stringify({ win, tol: START_TOLERANCE_MS, plus1: sameProcess({ start: S }, { start: S + 1000 }), minus1: sameProcess({ start: S }, { start: S - 1000 }), plus60: sameProcess({ start: S }, { start: S + 60000 }), minus60: sameProcess({ start: S }, { start: S - 60000 }), selfEarly8: sameProcess({ start: S, self: true }, { start: S - 8000 }), selfLate8: sameProcess({ start: S, self: true }, { start: S + 8000 }), procSame: sameProcess({ start: S, proc: 'linux:5@b' }, { start: S + 99000, proc: 'linux:5@b' }), procOther: sameProcess({ start: S, proc: 'linux:5@b' }, { start: S, proc: 'linux:6@b' }), unreadable: sameProcess({ start: S }, { error: 'timeout' }), noRecord: sameProcess({}, { start: S }) }));`);
      const r = run(dir, `node ${path.basename(f)}`, base);
      let v = {};
      try { v = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
      report('PU-17: a start 1 s off the recorded one is the same process and 60 s off is another (tolerance 3 s, either way); a self-measured start may be 8 s late; /proc ticks compare exactly; unreadable or nothing on record decides nothing; Windows creation times shifted by a time zone are corrected against PowerShell\'s own',
        v.win?.tz123 === 0 && v.win?.tzCmd === 'node.exe' && v.win?.tz456 === 'no creation time' && v.win?.ok123 === 0 && v.tol === 3000 && v.plus1 === true && v.minus1 === true && v.plus60 === false && v.minus60 === false && v.selfEarly8 === true && v.selfLate8 === false && v.procSame === true && v.procOther === false && v.unreadable === null && v.noRecord === null, `${JSON.stringify(v)}\n${out(r)}`);
    }

    // 2. A real launch under a slow reader (the stub delays every read by 1.5 s, like a slow PowerShell): the launch
    //    and every listing never call the reader, so the launch takes as long as with no delay; agent stop calls it
    //    exactly once (against the OS's real start time, via the stub's fallthrough) and still ends the agent.
    {
      const delay = Math.round(1500 * SLOW);
      const launch = (agent, id, extra) => {
        const t0 = Date.now();
        const r = run(dir, `node harness/agent.mjs start --role builder --agent ${agent} --task ${id} --detach`, { ...extra, STUDIO_HEARTBEAT_SEC: '1', STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} wait' });
        const ok = until(() => Boolean(readRec(agent)?.pid), 15000 * SLOW);
        return { ms: Date.now() - t0, ok, r };
      };
      const stopAndWait = (agent, extra) => {
        const st = run(dir, `node harness/agent.mjs stop ${agent} --by selftest`, extra);
        until(() => !locksOf(agent).length && ended(agent), 15000 * SLOW);
        return st;
      };
      const idA = task('PU-17 launch fast');
      const fast = launch('launch-a', idA, env({}));
      until(() => locksOf('launch-a').some((k) => k === `task:${idA}`), 10000 * SLOW);
      stopAndWait('launch-a', env({}));
      clearReads();
      const idB = task('PU-17 launch slow');
      const slowEnv = env({}, delay);
      const slow = launch('launch-b', idB, slowEnv);
      until(() => locksOf('launch-b').some((k) => k === `task:${idB}`), 10000 * SLOW);
      const rec = readRec('launch-b');
      // Listings: agent list, studio:status, and a probe for sessions(), task.mjs's holder check (a non-owner's
      // hand-back is refused while the holder runs) and the HUD.
      const t1 = Date.now();
      const list = run(dir, 'node harness/agent.mjs list', slowEnv);
      run(dir, 'node harness/supervisor.mjs status', slowEnv);
      const f = path.join(dir, '.probe-pu17-list.mjs');
      fs.writeFileSync(f, `import { sessions } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness/agent.mjs')).href)};
import { pauseTask } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness/task.mjs')).href)};
import { buildHudState } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness/hud.mjs')).href)};
const running = sessions().find((s) => s.agent === 'launch-b')?.running;
const handBack = pauseTask(${JSON.stringify(idB)}, 'producer-x', 'probe: is the holder running?');
const hud = buildHudState();
console.log(JSON.stringify({ running, refused: handBack?.error || null, hudAgents: (hud.agents || []).length }));`);
      const probe = run(dir, `node ${path.basename(f)}`, slowEnv);
      const listMs = Date.now() - t1;
      let pr = {};
      try { pr = JSON.parse(String(probe.stdout).trim().split('\n').filter((l) => l.startsWith('{')).pop()); } catch {}
      const before = reads().length;
      const st = stopAndWait('launch-b', slowEnv);
      const after = reads();
      const agentGone = until(() => pidGone(rec?.pid), 10000 * SLOW);
      report(`PU-17 (P-045): with the reader slowed by ${delay} ms, a launch and the listings (agent list, studio:status, sessions(), the task holder check, the HUD) never call it, and the launch is no slower (${slow.ms} ms against ${fast.ms} ms with no delay)`,
        fast.ok && slow.ok && before === 0 && pr.running === true && pr.refused === 'locked' && slow.ms < fast.ms + Math.round(delay * 2 / 3) && /launch-b/.test(list.stdout),
        `fast=${JSON.stringify({ ms: fast.ms, ok: fast.ok })} slow=${JSON.stringify({ ms: slow.ms, ok: slow.ok })} reads=${before} listMs=${listMs} probe=${JSON.stringify(pr)}\n${out(slow.r)}\n${out(probe).slice(-800)}`);
      report('PU-17: a launched session records the spawn time of the agent and of its launcher, and agent stop reads the OS exactly once, finds the same process and ends it; the launcher hands the task back',
        Boolean(rec?.identity?.pid?.start && rec?.identity?.supervisor?.start) && Math.abs(rec.identity.pid.start - Date.parse(rec.startedAt)) < 2000 && after.length === 1 && after[0].pids?.[0] === rec.pid && st.status === 0 && /Stopping launch-b; the launcher hands its work back/.test(st.stdout) && agentGone && locksOf('launch-b').length === 0 && backInQueue(idB),
        `${JSON.stringify(rec?.identity)} reads=${JSON.stringify(after)} gone=${agentGone} locks=${locksOf('launch-b')}\n${out(st)}`);
    }

    // 3. A stale record whose pid now belongs to another program (it started an hour after the agent did). The
    //    heartbeat is fresh, so only the start time can tell: nothing is killed and the work is handed back.
    {
      const p = stranger();
      const id = task('PU-17 reused pid', 'reused-1');
      const notIt = { start: p.spawnedAt - 3600000 };
      record('reused-1', { pid: p.pid, supervisor: p.pid, identity: { pid: notIt, supervisor: notIt }, lastBeat: minAgo(1), task: id });
      clearReads();
      const st = run(dir, 'node harness/agent.mjs stop reused-1 --by selftest', env());
      const up = await running(p);
      const ev = events('agent.pid_reused').filter((e) => e.meta?.session === 'reused-1');
      report('PU-17 (P-039): agent stop on a record whose pid now belongs to another program (start time an hour off, read once from the OS) leaves that program running, ends the session, hands its task back and frees its claims',
        st.status === 0 && up && reads().length === 1 && /belongs to another program/.test(st.stdout) && backInQueue(id) && locksOf('reused-1').length === 0 && ended('reused-1') && ev.length === 1 && ev[0].meta?.verified === true,
        `alive=${up} reads=${reads().length} back=${backInQueue(id)} locks=${locksOf('reused-1')} ended=${ended('reused-1')} events=${JSON.stringify(ev)}\n${out(st)}`);
    }

    // 4. The same program (its start matches the spawn time on record, read from the OS): still stopped, even with an
    //    old heartbeat. Its launcher is gone (pid and launcher are one process here), so the stop hands the work back.
    {
      const p = stranger();
      const id = task('PU-17 matching pid', 'live-1');
      const me = { start: p.spawnedAt };
      record('live-1', { pid: p.pid, supervisor: p.pid, identity: { pid: me, supervisor: me }, lastBeat: minAgo(40), task: id });
      clearReads();
      const st = run(dir, 'node harness/agent.mjs stop live-1 --by selftest', env());
      const gone = await exited(p);
      report('PU-17: a process whose OS start time matches the spawn time on record is stopped as before (one read), and with no launcher left its task is handed back and its claims freed',
        st.status === 0 && gone && reads().length === 1 && /Stopping live-1/.test(st.stdout) && backInQueue(id) && locksOf('live-1').length === 0 && ended('live-1'),
        `gone=${gone} reads=${reads().length} back=${backInQueue(id)} locks=${locksOf('live-1')}\n${out(st)}`);
    }

    // 5. The tolerance and the reader failing, through the stub: 1 s off is the same process (killed, even with a
    //    stale heartbeat); 60 s off is another (spared). Unreadable falls back to the old rule: killed on a fresh
    //    heartbeat; spared and ended as dead on a stale one.
    {
      const p1 = stranger();
      const p2 = stranger();
      const p3 = stranger();
      const p4 = stranger();
      const id2 = task('PU-17 sixty seconds off', 'tol-60');
      const id4 = task('PU-17 unreadable stale', 'err-stale');
      const rec = { start: S };
      record('tol-1', { pid: p1.pid, supervisor: p1.pid, identity: { pid: rec, supervisor: rec }, lastBeat: minAgo(40) });
      record('tol-60', { pid: p2.pid, supervisor: p2.pid, identity: { pid: rec, supervisor: rec }, lastBeat: minAgo(40), task: id2 });
      record('err-fresh', { pid: p3.pid, supervisor: p3.pid, identity: { pid: rec, supervisor: rec }, lastBeat: minAgo(1) });
      record('err-stale', { pid: p4.pid, supervisor: p4.pid, identity: { pid: rec, supervisor: rec }, lastBeat: minAgo(40), task: id4 });
      const stub = { [p1.pid]: S + 1000, [p2.pid]: S + 60000, [p3.pid]: 'timeout', [p4.pid]: 'timeout' };
      clearReads();
      const r1 = run(dir, 'node harness/agent.mjs stop tol-1 --by selftest', env(stub));
      const r2 = run(dir, 'node harness/agent.mjs stop tol-60 --by selftest', env(stub));
      const r3 = run(dir, 'node harness/agent.mjs stop err-fresh --by selftest', env(stub));
      const r4 = run(dir, 'node harness/agent.mjs stop err-stale --by selftest', env(stub));
      const k1 = await exited(p1);
      const k3 = await exited(p3);
      const up2 = await running(p2);
      const up4 = await running(p4);
      const ev = events('agent.pid_reused');
      const e2 = ev.filter((e) => e.meta?.session === 'tol-60');
      const e4 = ev.filter((e) => e.meta?.session === 'err-stale');
      report('PU-17: at kill time a start 1 s off the record is the same process (stopped), 60 s off is another program (spared, its task handed back)',
        r1.status === 0 && k1 && /Stopping tol-1/.test(r1.stdout) && r2.status === 0 && up2 && /belongs to another program/.test(r2.stdout) && backInQueue(id2) && ended('tol-60') && e2.length === 1 && e2[0].meta?.verified === true,
        `killed1=${k1} alive60=${up2} back=${backInQueue(id2)}\n${out(r1)}\n---\n${out(r2)}`);
      report('PU-17: when the start time can\'t be read (a reader timeout), the old rule decides: a fresh heartbeat is stopped, a stale one is spared and its session ended as dead (task handed back, event says unverified)',
        r3.status === 0 && k3 && /Stopping err-fresh/.test(r3.stdout) && r4.status === 0 && up4 && /nothing was killed/.test(r4.stdout) && backInQueue(id4) && ended('err-stale') && locksOf('err-stale').length === 0 && e4.length === 1 && e4[0].meta?.verified === false && reads().length === 4,
        `killedFresh=${k3} aliveStale=${up4} back=${backInQueue(id4)} reads=${reads().length}\n${out(r3)}\n---\n${out(r4)}`);
    }

    // 6. A stop while the session is still starting (its record names a launcher and no agent yet): the launcher is
    //    checked once and stopped with what it started, the task goes back, and it can't restart straight away.
    {
      const childFile = path.join(stateDir, 'pu17-launcher-child.txt');
      fs.rmSync(childFile, { force: true });
      const code = `const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{stdio:'ignore',windowsHide:true});require('fs').writeFileSync(${JSON.stringify(childFile)},String(c.pid));setTimeout(()=>{},600000);`;
      const L = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore', windowsHide: true });
      L.spawnedAt = Date.now();
      procs.push(L);
      until(() => fs.existsSync(childFile) && fs.readFileSync(childFile, 'utf8').trim(), 10000 * SLOW);
      const gc = Number(fs.readFileSync(childFile, 'utf8').trim());
      const id = task('PU-17 stop while starting', 'boot-1');
      fs.writeFileSync(path.join(agentsDir, 'boot-1.json'), JSON.stringify({ agent: 'boot-1', role: 'builder', tool: 'claude', model: 'fake-1', task: id, lane: null, status: 'running', starting: true, supervisor: L.pid, identity: { supervisor: { start: L.spawnedAt } }, startedAt: new Date(L.spawnedAt).toISOString() }, null, 2));
      clearReads();
      const st = run(dir, 'node harness/agent.mjs stop boot-1 --by selftest', env());
      const lGone = await exited(L);
      const gcGone = until(() => pidGone(gc), 5000 * SLOW);
      const again = run(dir, `node harness/task.mjs start ${id} --agent other-1`, base);
      report('PU-17 (P-045): agent stop while a session is still starting (a launcher, no agent yet) checks the launcher once, stops it and what it started, hands the task back, and the task can\'t restart straight away',
        st.status === 0 && /still starting, so its launcher was stopped and its work handed back/.test(st.stdout) && /won't restart before/.test(st.stdout) && reads().length === 1 && lGone && gcGone && backInQueue(id) && locksOf('boot-1').length === 0 && ended('boot-1') && again.status !== 0 && /can restart after/.test(again.stderr),
        `reads=${reads().length} launcherGone=${lGone} childGone=${gcGone} back=${backInQueue(id)} locks=${locksOf('boot-1')}\n${out(st)}\n---\n${out(again)}`);
    }

    // 7. Listings take no OS query: under the stub (the Windows rule) a reused number with a fresh heartbeat still
    //    lists as running, as before PU-17, and agent list doesn't read; only agent stop finds out. On Linux without
    //    the stub, a /proc start that differs from the record lists as not running (a file read, no child process).
    {
      const p = stranger();
      const q = stranger();
      record('ghost-1', { pid: p.pid, supervisor: p.pid, identity: { pid: { start: S }, supervisor: { start: S } }, lastBeat: minAgo(1) });
      record('ghost-2', { pid: q.pid, supervisor: q.pid, identity: { pid: { start: S, proc: 'linux:1@other-boot' }, supervisor: { start: S, proc: 'linux:1@other-boot' } }, lastBeat: minAgo(1) });
      clearReads();
      const f = path.join(dir, '.probe-pu17-alive.mjs');
      fs.writeFileSync(f, `import { sessions } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness/agent.mjs')).href)};
console.log(JSON.stringify(Object.fromEntries(sessions().filter((s) => s.agent.startsWith('ghost-')).map((s) => [s.agent, s.running]))));`);
      const parse = (r) => { try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return {}; } };
      const stubbed = parse(run(dir, `node ${path.basename(f)}`, env({ [p.pid]: S + 3600000 }, 1500)));
      const real = parse(run(dir, `node ${path.basename(f)}`, env()));
      const linux = process.platform === 'linux';
      report(`PU-17 (P-045): listings never ask the OS for start times: under the stub (the Windows rule) a reused number with a fresh heartbeat lists as running, as before; ${linux ? 'on Linux a /proc start that differs from the record lists as not running' : 'on this OS a number in use lists as running'}`,
        reads().length === 0 && stubbed['ghost-1'] === true && stubbed['ghost-2'] === true && real['ghost-1'] === true && real['ghost-2'] === !linux,
        `reads=${reads().length} stub=${JSON.stringify(stubbed)} real=${JSON.stringify(real)}`);
      for (const a of ['ghost-1', 'ghost-2']) fs.writeFileSync(path.join(agentsDir, `${a}.json`), JSON.stringify({ ...readRec(a), status: 'ended' }, null, 2));
    }

    // 8. studio:stop reads the supervisor's start once and signals its pid only while it is still the supervisor.
    {
      const p = stranger();
      const q = stranger();
      const sf = path.join(stateDir, 'supervisor.json');
      const status = (pid, identity) => fs.writeFileSync(sf, JSON.stringify({ pid, identity, status: 'running', startedAt: minAgo(30), lastLoop: minAgo(1) }, null, 2));
      status(p.pid, { start: p.spawnedAt - 3600000, self: true });
      clearReads();
      const a = run(dir, 'node harness/supervisor.mjs stop', env());
      const up = await running(p);
      const readsA = reads().length;
      const after = JSON.parse(fs.readFileSync(sf, 'utf8'));
      status(q.pid, { start: q.spawnedAt, self: true });
      const b = run(dir, 'node harness/supervisor.mjs stop', env());
      const killed = await exited(q);
      report('PU-17: studio:stop leaves a program that took the supervisor\'s old pid alone (one read; supervisor.json marked stopped) and still signals the real supervisor',
        a.status === 0 && up && readsA === 1 && /Not signalled/.test(a.stdout) && after.status === 'stopped' && b.status === 0 && killed, `alive=${up} reads=${readsA} status=${after.status} killed=${killed}\n${out(a)}\n---\n${out(b)}`);
    }
  } finally {
    for (const c of procs) {
      try {
        if (process.platform !== 'win32' && c.spawnargs?.includes('-e') && String(c.spawnargs.at(-1)).includes('writeFileSync')) process.kill(-c.pid);
      } catch {}
      try {
        c.kill();
      } catch {}
    }
    try {
      run(dir, 'node harness/agent.mjs stop-all --by selftest', base);
    } catch {}
  }
}
