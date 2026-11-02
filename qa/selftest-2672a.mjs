/**
 * qa/selftest-2672a.mjs — 2.67.2 (helper a): stop the false alarms.
 *   B-50  a lane's full verify no longer refuses another checkout's (the "already running" record is per checkout); a
 *         train's verify refused as busy waits and runs again, bounded; a train whose verifies ran no check defers its
 *         lanes: nobody handed back, never "main itself is red".
 *   hold  a task held for landing (task hold) stays out of trains; `task train leave` takes a lane out of the queue,
 *         recorded (who, why), never by a worker; npm run lanes and train status show both.
 *   health  a launched session's end records what it did for its task and why there was no work (task start refused,
 *         never claimed, ...); after STUDIO_NO_WORK_EXITS (2) no-work exits in a row the task is parked with that
 *         reason; a bug task's done-check refusal and brief name the regression file, its missing fields and the
 *         fails-before command.
 * A made-up studio: one sleeping gate, lane copies made with harness/worktree.mjs, a docs-only change per lane.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest2672A({ dir, run, report, tmpRoot }) {
  const SLOW = Number(process.env.STUDIO_SELFTEST_SLOW) || (process.platform === 'win32' ? 2.5 : 1);
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' });
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const until = (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !fn()) nap(50); return fn(); };
  const guard = (name, fn) => { try { const [ok, detail] = fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const events = path.join(dir, '.studio', 'events-2672a.jsonl');
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const env = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '',
    STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', STUDIO_GAME: '', STUDIO_REACHABILITY: 'off', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '',
    STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_TRAIN: '', STUDIO_TRAIN_BISECT: '', STUDIO_HOOKS_CHECK: 'off', STUDIO_COMPACT_OUTPUT: 'off',
    STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_LOCK_OWNER: '', STUDIO_HEAVY_SLOTS: '2', STUDIO_HEAVY_HELD: '', STUDIO_HEAVY_POLL_MS: '100',
    STUDIO_HEAVY_WAIT_MIN: '', STUDIO_RAM_FLOOR_GB: '0', STUDIO_TEST_LOADAVG: '0', STUDIO_TRAIN_BUSY_WAIT_MIN: '', STUDIO_NO_WORK_EXITS: '', STUDIO_ROLE: '',
    STUDIO_TRAIN_WAIT_MIN: '0', STUDIO_TRAIN_MIN: '1', npm_lifecycle_event: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2672a-${process.pid}.pem`),
    AGENT_EVENTS_FILE: events, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
  let n = 0;
  const probe = (code, extra = {}, cwd = dir) => {
    const f = path.join(tmpRoot, `p2672a-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(cwd, `node "${f}"`, { ...env, ...extra });
    fs.rmSync(f, { force: true });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r).slice(-3000) }; } catch { return { _out: out(r).slice(-3000) }; }
  };
  const sleepF = path.join(tmpRoot, `sleep-2672a-${process.pid}.mjs`);
  fs.writeFileSync(sleepF, 'setTimeout(() => {}, Number(process.argv[2] || 1000));\n');
  const kids = [];

  // ---- the studio: one gate that sleeps a little; a git checkout on main ----
  write(dir, 'studio/gates.json', `${JSON.stringify({ gates: [{ id: 'slow', command: `node "${sleepF}" ${Math.round(2500 * SLOW)}`, required: true, lite: true, cache: false }] }, null, 2)}\n`);
  for (const d of ['.studio/train', '.studio/verify-running', '.studio/agents']) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
  const addTask = (title) => (out(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
  const laneProbe = path.join(tmpRoot, `lane-2672a-${process.pid}.mjs`);
  fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${u('harness/worktree.mjs')};\nconsole.log(JSON.stringify(createLaneCopy(process.argv[2], { task: process.argv[3] })));\n`);
  /** A task with its lane copy and one docs-only commit (no claim: the train is given the lane, or it is queued by hand). */
  const lane = (agent, title) => {
    const id = addTask(title);
    const made = run(dir, `node "${laneProbe}" ${agent} ${id}`, env);
    const ld = path.join(dir, '.lanes', agent);
    write(ld, `docs/notes-${agent}.md`, `# ${title}\n`);
    g(ld, 'add', '-A');
    const c = g(ld, 'commit', '-qm', `${id}: ${title}`, '--no-verify');
    const head = (g(ld, 'rev-parse', 'HEAD').stdout || '').trim();
    const branch = (g(ld, 'rev-parse', '--abbrev-ref', 'HEAD').stdout || '').trim();
    return { task: id, agent, dir: ld, head, branch, ok: c.status === 0 && fs.existsSync(ld), log: `${out(made)}\n${out(c)}` };
  };

  try {
    // ---------- B-50 (a): a lane's full verify doesn't refuse another checkout's ----------
    {
      const la = lane('lane-a', 'Docs: lane a notes');
      const laneEnv = { ...env, STUDIO_MAIN_ROOT: dir, STUDIO_LOCK_OWNER: 'lane-a' };
      const first = spawn(process.execPath, ['scripts/run-gates.mjs', '--no-detach'], { cwd: la.dir, env: { ...process.env, ...laneEnv }, stdio: 'ignore' });
      kids.push(first);
      const vdir = path.join(dir, '.studio', 'verify-running');
      const upA = until(() => { try { return fs.readdirSync(vdir).filter((x) => /^full.*\.json$/.test(x)).some((x) => readJson(path.join(vdir, x))?.owner === 'lane-a'); } catch { return false; } }, 15000 * SLOW);
      const sameLane = run(la.dir, 'node scripts/run-gates.mjs --no-detach', { ...laneEnv, STUDIO_LOCK_OWNER: 'lane-a2' });
      const mainRun = run(dir, 'node scripts/run-gates.mjs --no-detach', { ...env, STUDIO_LOCK_OWNER: 'main-b' });
      until(() => first.exitCode !== null, 20000 * SLOW);
      guard('2.67.2 B-50 (a): a full verify in a lane copy (its .studio/ is the main checkout\'s) doesn\'t refuse a full verify of the main checkout, which runs and passes; a second full verify of the same lane is still refused (2.67.1: "a full verify of this checkout is already running: lane-a\'s", for every lane and the train)', () => [
        la.ok && upA && mainRun.status === 0 && !/refused: a full verify of this checkout is already running/.test(out(mainRun)) && /PASS slow/.test(out(mainRun))
          && sameLane.status === 1 && /refused: a full verify of this checkout is already running: lane-a/.test(out(sameLane)),
        JSON.stringify({ la: la.ok ? 'ok' : la.log.slice(-600), upA, main: out(mainRun).slice(-800), same: out(sameLane).slice(-500) })]);
    }

    // ---------- B-50 (b): a train's verify refused as busy waits and runs again, and is not red ----------
    {
      const stub = path.join(tmpRoot, `stub-2672a-${process.pid}`);
      write(stub, 'scripts/run-gates.mjs', `import fs from 'node:fs';\nconst f = ${JSON.stringify(path.join(tmpRoot, `stub-count-${process.pid}.txt`))};\nlet k = 0; try { k = Number(fs.readFileSync(f, 'utf8')) || 0; } catch {}\nfs.writeFileSync(f, String(k + 1));\nconsole.error("[verify] refused: a full verify of this checkout is already running: builder-s74's (pid 1, no options, started 1 min ago, log .lanes/builder-s74/.studio/verify-running/x.log). Nothing was run and no verify record was written.");\nprocess.exit(1);\n`);
      const vt = probe(`import fs from 'node:fs';
import { verifyTree } from ${u('harness/train.mjs')};
const logs = [];
const v = verifyTree({ dir: ${JSON.stringify(stub)}, root: process.cwd() }, { id: 'busy-1', n: 1, tree: 'a'.repeat(40), changed: [], all: false, seen: new Map(), tasks: [], log: (m) => logs.push(m) });
let calls = 0; try { calls = Number(fs.readFileSync(${JSON.stringify(path.join(tmpRoot, `stub-count-${process.pid}.txt`))}, 'utf8')); } catch {}
console.log(JSON.stringify({ ok: v.ok, noCheck: v.noCheck || false, busy: v.busy || '', why: v.why, calls, logs: logs.join(' | ') }));`, { STUDIO_TRAIN_BUSY_WAIT_MIN: String(0.05 * SLOW) });
      guard('2.67.2 B-50 (b): verifyTree: a run refused before any gate ("already running") is marked busy and no-check, waits and runs again within STUDIO_TRAIN_BUSY_WAIT_MIN (saying so), and its reason says "ran no check", not "failed" (2.67.1: one refusal read as a red verify)', () => [
        vt.ok === false && vt.noCheck === true && /already running: builder-s74/.test(vt.busy) && vt.calls >= 2 && /busy, not red/.test(vt.logs) && /ran no check/.test(vt.why) && !/^failed/.test(vt.why),
        JSON.stringify(vt).slice(0, 2000)]);
    }

    // ---------- B-50 (c): a train whose verifies ran no check: nobody handed back, never redMain ----------
    {
      const lb = lane('lane-b', 'Docs: lane b notes');
      const lc = lane('lane-c', 'Docs: lane c notes');
      const lockF = path.join(dir, '.studio', 'locks', 'machine-heavy-1.lock');
      const holder = spawn(process.execPath, ['harness/heavy.mjs', 'run', '--label', 'builder-s74-verify', '--', 'node', `"${sleepF}"`, String(120000)], { cwd: dir, env: { ...process.env, ...env, STUDIO_HEAVY_SLOTS: '1' }, stdio: 'ignore' });
      kids.push(holder);
      const up = until(() => readJson(lockF)?.label === 'builder-s74-verify', 15000 * SLOW);
      const tr = probe(`import { runTrain } from ${u('harness/train.mjs')};
const handed = [];
const logs = [];
const lanes = ${JSON.stringify([lb, lc].map(({ task, agent, dir: d, head, branch }) => ({ task, agent, dir: d, head, branch, prechecked: true })))};
const r = await runTrain({ lanes, by: 'tester', now: true, deps: { handBack: (l) => handed.push(l.task) }, log: (m) => logs.push(m) });
console.log(JSON.stringify({ ok: r.ok, redMain: Boolean(r.redMain), noCheck: r.noCheck || null, landed: r.landed, dropped: r.dropped.map((d) => d.task), deferred: r.deferred.map((d) => ({ task: d.task, why: d.why })), handed, verifies: r.verifies, message: r.message, logs: logs.slice(-12).join(' | ') }));`, { STUDIO_HEAVY_SLOTS: '1', STUDIO_HEAVY_WAIT_MIN: String(0.02 * SLOW), STUDIO_TRAIN_BUSY_WAIT_MIN: String(0.06 * SLOW) });
      try { holder.kill(); } catch {}
      until(() => readJson(lockF)?.label !== 'builder-s74-verify', 10000 * SLOW);
      const redEv = evs().filter((e) => e.type === 'task.train.red_main' || e.type === 'task.train.dropped');
      guard('2.67.2 B-50 (c): a train whose verify can\'t start (machine:heavy held past its wait) defers its lanes as busy, not red: no lane handed back, redMain never set, a task.train.no_check event, the log says busy and that it ran the verify again (2.67.1: "each lane is verified alone", then "main itself is red")', () => [
        lb.ok && lc.ok && up && tr.redMain === false && Array.isArray(tr.dropped) && tr.dropped.length === 0 && tr.handed?.length === 0 && tr.landed?.length === 0
          && tr.deferred?.length === 2 && tr.deferred.every((d) => /busy, not red/.test(d.why)) && /did not run/.test(tr.noCheck?.why || '') && !redEv.length
          && evs().some((e) => e.type === 'task.train.no_check') && /busy, not red/.test(tr.logs),
        JSON.stringify({ up, tr, redEv: redEv.map((e) => e.msg) }).slice(0, 3000)]);

      // ---------- hold: a held task stays out of a train; train leave ----------
      const probeQ = (code) => probe(`import { enqueue, readQueue, runTrain } from ${u('harness/train.mjs')};\n${code}`);
      run(dir, `node harness/task.mjs hold ${lb.task} --by tester --why "for landing after the release"`, env);
      const dry = probeQ(`for (const l of ${JSON.stringify([lb, lc].map(({ task, agent, dir: d, head, branch }) => ({ task, agent, dir: d, head, branch, prechecked: true })))}) enqueue(process.cwd(), l);
const r = await runTrain({ by: 'tester', now: true, dryRun: true, deps: {}, log: () => {} });
console.log(JSON.stringify({ message: r.message, deferred: r.deferred, queue: readQueue(process.cwd()).map((e) => e.task) }));`);
      const lanesJ = (() => { try { return JSON.parse(run(dir, 'node harness/lanes.mjs --json --no-stamps', env).stdout); } catch { return {}; } })();
      const rowB = (lanesJ.lanes || []).find((r) => r.task === lb.task);
      const status = run(dir, 'node harness/task.mjs train status', env);
      guard('2.67.2 hold: a task held for landing (task hold) stays out of a queued train: deferred with the hold\'s reason, still queued; npm run lanes marks it out (queued.out) and train status says OUT OF TRAINS (2.67.1: T-146 held "for landing" still ran in train 15\'s tree)', () => [
        new RegExp(`would go in one train \\(${lc.task}\\)`).test(dry.message || '') && (dry.deferred || []).some((d) => d.task === lb.task && /held for landing by tester: for landing after the release/.test(d.why))
          && dry.queue?.includes(lb.task) && rowB?.queued?.out === true && new RegExp(`${lb.task}.*OUT OF TRAINS`).test(out(status)),
        JSON.stringify({ dry, rowB, status: out(status).slice(-600) }).slice(0, 2500)]);
      const worker = run(dir, `node harness/task.mjs train leave ${lc.task} --by builder-s9 --why "try"`, env);
      const left = run(dir, `node harness/task.mjs train leave ${lc.task} --by conductor --why "lands after the art pass"`, env);
      const q2 = probeQ('console.log(JSON.stringify({ queue: readQueue(process.cwd()).map((e) => e.task) }));');
      const rec = readJson(path.join(dir, '.studio', 'train', 'left.json')) || [];
      const lanesJ2 = (() => { try { return JSON.parse(run(dir, 'node harness/lanes.mjs --json --no-stamps', env).stdout); } catch { return {}; } })();
      const rowC = (lanesJ2.lanes || []).find((r) => r.task === lc.task || r.agent === 'lane-c');
      guard('2.67.2 hold: npm run task -- train leave <ID> --by --why takes a lane out of the queue on purpose, recorded (.studio/train/left.json, task.train.left, who and why); a worker is refused; npm run lanes shows who took it out (2.67.1: no such command; the crew called dequeue() by hand)', () => [
        worker.status === 1 && /worker/.test(out(worker)) && left.status === 0 && !q2.queue?.includes(lc.task) && q2.queue?.includes(lb.task)
          && rec.some((x) => x.task === lc.task && x.by === 'conductor' && /art pass/.test(x.why)) && evs().some((e) => e.type === 'task.train.left' && e.task === lc.task)
          && (!rowC || rowC.left?.by === 'conductor'),
        JSON.stringify({ worker: out(worker).slice(-300), left: out(left).slice(-300), q2, rec, rowC }).slice(0, 2000)]);
    }

    // ---------- session health: the outcome on session end, the no-work park ----------
    {
      const t = addTask('Fix the widget count off by one');
      const sess = (agent) => `fs.mkdirSync(AGENTS_DIR, { recursive: true });
fs.writeFileSync(AGENTS_DIR + '/${agent}.json', JSON.stringify({ agent: '${agent}', role: 'builder', tool: 'claude', model: 'model-x', task: '${t}', status: 'running', startedAt: new Date(Date.now() - 2000).toISOString() }));`;
      const end = (agent) => probe(`import fs from 'node:fs';
import { cleanUp, AGENTS_DIR } from ${u('harness/agent.mjs')};
${sess(agent)}
cleanUp('${agent}', { code: 0, log: '', role: 'builder', tool: 'claude', model: 'model-x' });
console.log(JSON.stringify({ ok: true }));`);
      const e1 = end('nw-1');
      const holds1 = readJson(path.join(dir, 'studio', 'task-holds.json'))?.tasks?.[t] || {};
      // The second session's task start is refused: another owner holds the claim.
      run(dir, `node harness/lock.mjs claim task:${t} --owner other-owner`, env);
      const st = run(dir, `node harness/task.mjs start ${t} --agent nw-2`, { ...env, STUDIO_LOCK_OWNER: 'nw-2' });
      run(dir, `node harness/lock.mjs release task:${t} --owner other-owner`, env);
      const e2 = end('nw-2');
      const ends = evs().filter((e) => e.type === 'agent.session.end' && ['nw-1', 'nw-2'].includes(e.agent));
      const o1 = ends.find((e) => e.agent === 'nw-1')?.meta?.outcome;
      const o2 = ends.find((e) => e.agent === 'nw-2')?.meta?.outcome;
      const holds2 = readJson(path.join(dir, 'studio', 'task-holds.json'))?.tasks?.[t] || {};
      guard('2.67.2 health: a launched session\'s end records its outcome for its task (claimed, commits, done) and why there was no work: "never claimed", "its task start was refused: locked …" (a task.start_refused event); the first no-work exit doesn\'t park (2.67.1: "pass (exit 0)", nothing recorded)', () => [
        st.status === 1 && o1 && o1.task === t && o1.claimed === false && o1.commits === 0 && o1.done === false && o1.noWork === true && /never claimed/.test(o1.why)
          && o2 && /task start was refused: locked/.test(o2.why) && evs().some((e) => e.type === 'task.start_refused' && e.task === t && e.agent === 'nw-2')
          && !holds1.parked && /no work on/.test(ends.find((e) => e.agent === 'nw-2')?.msg || ''),
        JSON.stringify({ st: out(st).slice(-300), o1, o2, holds1, e1: e1._out?.slice(-400), e2: e2._out?.slice(-400) }).slice(0, 2500)]);
      const next = run(dir, `node harness/task.mjs holds`, env);
      guard('2.67.2 health: after STUDIO_NO_WORK_EXITS (2) no-work exits in a row the task is parked by the launcher with the reason (so the supervisor doesn\'t relaunch it blindly) and the Producer is asked (2.67.1: 20 sessions in 35 min, nothing landed)', () => [
        holds2.parked?.by === 'launcher' && /2 sessions in a row ended with no work/.test(holds2.parked.why) && /task start was refused/.test(holds2.parked.why)
          && evs().some((e) => e.type === 'agent.ask' && e.task === t && /no work/.test(e.msg || '')),
        JSON.stringify({ holds2, holds: out(next).slice(-500) }).slice(0, 2000)]);

      // ---------- the regression refusal and the bug brief say exactly what to add ----------
      run(dir, `node harness/task.mjs unpark ${t} --by tester`, env);
      const s3 = run(dir, `node harness/task.mjs start ${t} --agent fixer-1`, { ...env, STUDIO_LOCK_OWNER: 'fixer-1' });
      nap(1100);
      write(dir, `qa/regressions/${t}.json`, `${JSON.stringify({ id: t, seed: 7, description: 'count off by one', fixed: true })}\n`);
      const dc = run(dir, `node harness/done-check.mjs ${t}`, { ...env, STUDIO_LOCK_OWNER: 'fixer-1' });
      const brief = (() => { try { return fs.readFileSync(path.join(dir, '.studio', 'briefs', `${t}.md`), 'utf8'); } catch { return ''; } })();
      guard('2.67.2 health: a bug task\'s "Regression saved" refusal names the file written since the claim and what it lacks (tick, sha256), the path qa/regressions/<ID>.json, the pin command and the fails-before command; its focus brief has the same steps (2.67.1: a generic line; T-132 committed a fix and stopped there)', () => [
        s3.status === 0 && dc.status !== 0 && new RegExp(`qa/regressions/${t}\\.json \\(missing tick \\(an integer\\), sha256`).test(out(dc)) && new RegExp(`node qa/fails-before\\.mjs qa/regressions/${t}\\.json`).test(out(dc))
          && /check-regressions\.mjs --update/.test(out(dc)) && /## The regression this bug needs/.test(brief) && new RegExp(`qa/fails-before\\.mjs qa/regressions/${t}\\.json`).test(brief),
        JSON.stringify({ s3: out(s3).slice(-300), dc: out(dc).slice(-1500), brief: brief.slice(-900) }).slice(0, 3000)]);
    }
  } finally {
    for (const k of kids) { try { k.kill(); } catch {} }
    for (const f of [sleepF, laneProbe]) { try { fs.rmSync(f, { force: true }); } catch {} }
  }
}
