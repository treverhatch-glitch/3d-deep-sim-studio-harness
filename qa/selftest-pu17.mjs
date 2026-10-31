/**
 * qa/selftest-pu17.mjs — 2.57.0 (PU-17, P-039): agent stop checks the process is still the agent before killing it.
 *
 * A session record left "running" after a crash or a reboot can name a process number the OS has since given to
 * another program; stopping the agent killed that program (on Windows with its whole tree). The launcher now
 * records each process's identity (start time, command line) next to its pid, and every kill and alive check
 * compares it. Every check here uses real processes: a sleeping node stands in for the unrelated program.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftestPU17({ dir, run, report }) {
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off' };
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const wait = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);
  const { readIdentity, pidExists } = await import(pathToFileURL(path.join(dir, 'harness', 'proc-identity.mjs')).href);
  const agentsDir = path.join(dir, '.studio', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const procs = [];
  // The unrelated program: a node that sleeps for ten minutes. Killed in the finally block below.
  const stranger = () => {
    const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)'], { stdio: 'ignore' });
    procs.push(c);
    return c;
  };
  // The strangers are this process's children: a killed one stays a zombie (and kill -0 still finds it) until
  // the event loop reaps it, so ask the ChildProcess, after letting the loop run.
  const done = (c) => c.exitCode !== null || c.signalCode !== null;
  const running = async (c) => {
    await new Promise((r) => setTimeout(r, 400));
    return !done(c);
  };
  const exited = (c, ms = 5000) => (done(c) ? Promise.resolve(true) : new Promise((r) => {
    const t = setTimeout(() => r(false), ms);
    c.once('exit', () => { clearTimeout(t); r(true); });
  }));
  const task = (title, agent) => {
    const id = (run(dir, `node harness/task.mjs add "${title}" --role builder`, env).stdout.match(/"id":\s*"(T-\d+)"/) || [])[1];
    if (agent) {
      run(dir, `node harness/task.mjs start ${id} --agent ${agent}`, env);
      run(dir, `node harness/lock.mjs claim path:docs/pu17-${agent} --owner ${agent}`, env);
    }
    return id;
  };
  const record = (agent, fields) => {
    const now = Date.now();
    fs.writeFileSync(path.join(agentsDir, `${agent}.json`), JSON.stringify({ agent, role: 'builder', tool: 'claude', model: 'fake-1', status: 'running', startedAt: new Date(now - 50 * 60000).toISOString(), ...fields }, null, 2));
  };
  const minAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
  const board = () => JSON.parse(run(dir, 'node harness/task.mjs list --all', env).stdout || '{}');
  const backInQueue = (id) => {
    const q = board();
    return (q.backlog || []).some((t) => t.id === id) && !(q.inProgress || []).some((t) => t.id === id);
  };
  const locksOf = (agent) => (JSON.parse(run(dir, 'node harness/lock.mjs list', env).stdout || '{}').locks || []).filter((l) => l.owner === agent).map((l) => l.key);
  const ended = (agent) => JSON.parse(fs.readFileSync(path.join(agentsDir, `${agent}.json`), 'utf8')).status === 'ended';
  const events = (type) => {
    try {
      return fs.readFileSync(path.join(dir, '.studio', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === type);
    } catch {
      return [];
    }
  };

  try {
    // 1. A stale record whose pid now belongs to another program (its start time differs). The heartbeat is fresh,
    //    so only the identity can tell: agent stop kills nothing and hands the work back.
    {
      const p = stranger();
      const real = readIdentity(p.pid);
      const id = task('PU-17 reused pid', 'reused-1');
      const notIt = { start: `${real?.start || 'x'}-an-earlier-program`, cmd: 'claude -p' };
      record('reused-1', { pid: p.pid, supervisor: p.pid, identity: { pid: notIt, supervisor: notIt }, lastBeat: minAgo(1), task: id });
      const st = run(dir, 'node harness/agent.mjs stop reused-1 --by selftest', env);
      const up = await running(p);
      const ev = events('agent.pid_reused').filter((e) => e.meta?.session === 'reused-1');
      report('2.57.0 (PU-17, P-039): agent stop on a record whose pid now belongs to another program (different start time) leaves that program running, ends the session, hands its task back and frees its claims',
        Boolean(real?.start) && st.status === 0 && up && /belongs to another program/.test(st.stdout) && backInQueue(id) && locksOf('reused-1').length === 0 && ended('reused-1') && ev.length === 1 && ev[0].meta?.verified === true,
        `identity=${JSON.stringify(real)} alive=${up} back=${backInQueue(id)} locks=${locksOf('reused-1')} ended=${ended('reused-1')} events=${JSON.stringify(ev)}\n${out(st)}`);
    }

    // 2a. The same program (identity matches): still stopped, even with an old heartbeat. Its launcher is gone
    //     (pid and supervisor are the same process here), so the stop hands the work back itself.
    {
      const p = stranger();
      const id = task('PU-17 matching pid', 'live-1');
      const me = readIdentity(p.pid);
      record('live-1', { pid: p.pid, supervisor: p.pid, identity: { pid: me, supervisor: me }, lastBeat: minAgo(40), task: id });
      const st = run(dir, 'node harness/agent.mjs stop live-1 --by selftest', env);
      const gone = await exited(p);
      report('2.57.0 (PU-17): a process that is still the agent (same start time) is stopped as before, and with no launcher left its task is handed back and its claims freed',
        st.status === 0 && gone && /Stopping live-1/.test(st.stdout) && backInQueue(id) && locksOf('live-1').length === 0 && ended('live-1'), `gone=${gone} back=${backInQueue(id)} locks=${locksOf('live-1')}\n${out(st)}`);
    }

    // 2b. A real launch records the identity of the agent and of its launcher, and agent stop still ends it.
    {
      const id = task('PU-17 real launch');
      const wenv = { ...env, STUDIO_HEARTBEAT_SEC: '1', STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} wait' };
      run(dir, `node harness/agent.mjs start --role builder --agent real-1 --task ${id} --detach`, wenv);
      const t0 = Date.now();
      while (Date.now() - t0 < 10000 && !locksOf('real-1').some((k) => k === `task:${id}`)) wait(300);
      const rec = JSON.parse(fs.readFileSync(path.join(agentsDir, 'real-1.json'), 'utf8'));
      const st = run(dir, 'node harness/agent.mjs stop real-1 --by selftest', env);
      const t1 = Date.now();
      while (Date.now() - t1 < 10000 && (pidExists(rec.pid) || locksOf('real-1').length)) wait(300);
      report('2.57.0 (PU-17): a launched session records its process identity (start time and command line) for the agent and its launcher, and agent stop still ends it and the launcher hands the task back',
        Boolean(rec.identity?.pid?.start && rec.identity?.supervisor?.start && rec.identity?.pid?.cmd) && st.status === 0 && /Stopping real-1/.test(st.stdout) && !pidExists(rec.pid) && locksOf('real-1').length === 0 && backInQueue(id),
        `${JSON.stringify(rec.identity)} alive=${pidExists(rec.pid)} locks=${locksOf('real-1')}\n${out(st)}`);
    }

    // 3. An old record (no identity, written before 2.57.0) with an old heartbeat: the number may be anyone's now,
    //    so nothing is killed and the session is treated as dead (P-039's repro). With a fresh heartbeat it is killed.
    {
      const p = stranger();
      const id = task('PU-17 old record', 'old-1');
      record('old-1', { pid: p.pid, supervisor: p.pid, lastBeat: minAgo(40), task: id });
      const st = run(dir, 'node harness/agent.mjs stop old-1 --by selftest', env);
      const up = await running(p);
      const ev = events('agent.pid_reused').filter((e) => e.meta?.session === 'old-1');
      const q = stranger();
      record('old-2', { pid: q.pid, supervisor: q.pid, lastBeat: minAgo(1) });
      const st2 = run(dir, 'node harness/agent.mjs stop old-2 --by selftest', env);
      const killed = await exited(q);
      report('2.57.0 (PU-17, P-039): a record with no process identity and a heartbeat older than the stall threshold is not killed (its task is handed back, its claims freed); with a fresh heartbeat it is killed as before',
        st.status === 0 && up && /nothing was killed/.test(st.stdout) && backInQueue(id) && locksOf('old-1').length === 0 && ended('old-1') && ev.length === 1 && ev[0].meta?.verified === false && st2.status === 0 && killed,
        `alive=${up} back=${backInQueue(id)} locks=${locksOf('old-1')} events=${JSON.stringify(ev)} freshKilled=${killed}\n${out(st)}\n---\n${out(st2)}`);
    }

    // 4. The alive check: a reused number reads as dead (agent list, the slot caps, task.mjs's holder check, the
    //    watcher's markGone), a matching one as running, and markGone kills nothing.
    {
      const p = stranger();
      const q = stranger();
      const id = task('PU-17 alive check', 'ghost-1');
      const real = readIdentity(p.pid);
      record('ghost-1', { pid: p.pid, supervisor: p.pid, identity: { pid: { start: `${real?.start}-before`, cmd: null }, supervisor: { start: `${real?.start}-before`, cmd: null } }, lastBeat: minAgo(1), task: id });
      const qi = readIdentity(q.pid);
      record('alive-1', { pid: q.pid, supervisor: q.pid, identity: { pid: qi, supervisor: qi }, lastBeat: minAgo(1) });
      const f = path.join(dir, '.probe-pu17-alive.mjs');
      fs.writeFileSync(f, `import { sessions, markGone } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness/agent.mjs')).href)};
import { pauseTask } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness/task.mjs')).href)};
const running = Object.fromEntries(sessions().filter((s) => ['ghost-1', 'alive-1'].includes(s.agent)).map((s) => [s.agent, s.running]));
const handBack = pauseTask(${JSON.stringify(id)}, 'producer-x', 'probe: the holder is gone');
const gone = markGone();
console.log(JSON.stringify({ running, handBack: handBack ? (handBack.error || 'ok') : null, gone }));`);
      const r = run(dir, `node ${path.basename(f)}`, env);
      let res = {};
      try { res = JSON.parse(String(r.stdout).trim().split('\n').filter((l) => l.startsWith('{')).pop()); } catch {}
      const up = [await running(p), await running(q)];
      report('2.57.0 (PU-17, P-039): the alive check compares the recorded identity: a reused number is not running (a non-owner may hand its task back, the watcher marks it ended, nothing is killed); a matching one is',
        res.running?.['ghost-1'] === false && res.running?.['alive-1'] === true && res.handBack === 'ok' && res.gone?.includes('ghost-1') && !res.gone?.includes('alive-1') && up[0] && up[1],
        `${JSON.stringify(res)} alive=${up}\n${out(r).slice(-1500)}`);
    }

    // 5. studio:stop signals the supervisor's pid only while it is still the supervisor.
    {
      const p = stranger();
      const q = stranger();
      const sf = path.join(dir, '.studio', 'supervisor.json');
      const status = (pid, identity) => fs.writeFileSync(sf, JSON.stringify({ pid, identity, status: 'running', startedAt: minAgo(30), lastLoop: minAgo(1) }, null, 2));
      const pi = readIdentity(p.pid);
      status(p.pid, { start: `${pi?.start}-before`, cmd: null });
      const a = run(dir, 'node harness/supervisor.mjs stop', env);
      const up = await running(p);
      status(q.pid, readIdentity(q.pid));
      const b = run(dir, 'node harness/supervisor.mjs stop', env);
      const killed = await exited(q);
      report('2.57.0 (PU-17): studio:stop leaves a program that took the supervisor\'s old pid alone, and still signals the real supervisor',
        a.status === 0 && up && /Not signalled/.test(a.stdout) && b.status === 0 && killed, `alive=${up} killed=${killed}\n${out(a)}\n---\n${out(b)}`);
    }
  } finally {
    for (const c of procs) {
      try {
        c.kill();
      } catch {}
    }
    try {
      run(dir, 'node harness/agent.mjs stop-all --by selftest', env);
    } catch {}
  }
}
