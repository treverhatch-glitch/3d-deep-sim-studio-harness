/**
 * qa/selftest-2782a.mjs — 2.78.2 (a): a merge train outlives whoever started it, and a person can cancel one (W-0090).
 *   - A lane's plain `task done` runs the quick checks, queues the lane and exits 0 with "queued" and how to follow it,
 *     while the game check is still to run; the train lands it afterwards in a process of its own (no supervisor here:
 *     task done started one, detached). STUDIO_DONE_QUEUE=0 keeps the old inline train. With a supervisor and the train
 *     daemon on, task done starts nothing (the daemon's pass does).
 *   - `task train` from an agent's shell runs its train detached and follows it: ending the starter's whole process tree
 *     and group mid-verify (what Claude Code does at its 10-minute limit) doesn't stop the train: it lands, its life
 *     record ends "done", no task.train.died.
 *   - A session whose task done queued its lane ends without a launcher verify or hand-back for it (trainQueued).
 *   - `task train cancel [<id>] --by <you> [--why "…"]`: a person stops a running train in its verify: its checks are
 *     stopped, it ends, nothing lands, nobody is handed back, the lane stays queued, the lock is freed, one
 *     task.train.cancelled with who and why. A worker is refused. A train that doesn't end by itself in
 *     STUDIO_TRAIN_CANCEL_WAIT_S is ended and recorded as cancelled (not died).
 * A tiny studio: a game whose one check is a node script that sleeps TRAIN_SLEEP_MS and counts its runs; lane copies
 * (git worktrees) made by the harness. Windows' detach (taskkill /T on the starter) is not exercised here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2782A({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const SLOW = process.platform === 'win32' ? 3 : 1;
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const readIn = (cwd, rel) => { try { return JSON.parse(fs.readFileSync(path.join(cwd, rel), 'utf8')); } catch { return null; } };
  const textIn = (cwd, rel) => { try { return fs.readFileSync(path.join(cwd, rel), 'utf8'); } catch { return ''; } };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => { const t0 = Date.now(); for (;;) { let v = false; try { v = fn(); } catch {} if (v) return true; if (Date.now() - t0 > ms) return false; await wait(250); } };
  const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; } try { if (/\)\s+Z\s/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false; } catch {} return true; };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_RAM_FLOOR_GB: '0', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off', STUDIO_TEST_LOADAVG: '0',
    STUDIO_VISUAL_GATE: 'off', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_LANE_LIVE_MIN: '0', STUDIO_LANDING_BUILD: 'off', STUDIO_TRAIN_PIPELINE: 'off',
    STUDIO_FLAKE_TRIAGE: 'off', STUDIO_WHOLE_GAME: 'off', STUDIO_SLOW_TIER: 'off', STUDIO_HEAVY_WAIT_MIN: '5', STUDIO_VERIFY_KEY_DIR: path.join(tmpRoot, 'verify-keys-2782a'),
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2782a-${process.pid}.pem`),
  };
  let n = 0;
  const made = [];
  const kids = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `2782a-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, '.env'), { force: true });
    const ev = path.join(S, '.studio', 'events-2782a.jsonl');
    writeIn(S, '.studio/events-2782a.jsonl', '');
    writeIn(S, 'studio/gates.json', `${JSON.stringify({ gates: [
      { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
      { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
      { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
    ] }, null, 2)}\n`);
    writeIn(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs' }] }, null, 2)}\n`);
    writeIn(S, 'game/demo/check.mjs', [
      "import fs from 'node:fs';",
      "if (process.env.TRAIN_MARK) fs.appendFileSync(process.env.TRAIN_MARK, `${process.pid} ${process.cwd()}\\n`);",
      "const ms = Number(process.env.TRAIN_SLEEP_MS || 0);",
      "if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);",
      "console.log('notes ok');", ''].join('\n'));
    writeIn(S, 'game/demo/notes/shared.md', '# Shared\n');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    const mark = path.join(S, '.studio', 'runs-2782a.txt');
    const env = { ...base, AGENT_EVENTS_FILE: ev, STUDIO_MAIN_ROOT: S, TRAIN_MARK: mark };
    const evs = () => textIn(S, '.studio/events-2782a.jsonl').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const runs = () => textIn(S, '.studio/runs-2782a.txt').split('\n').filter(Boolean).length;
    const mainHas = (rel) => g(S, 'cat-file', '-e', `main:${rel}`).status === 0;
    const doneIds = () => textIn(S, 'studio/DONE.md');
    const isDone = (id) => new RegExp(`\\b${id}\\b`).test(doneIds()) && !new RegExp(`\\b${id}\\b`).test(textIn(S, 'studio/NEXT.md').split(/^## Done/m)[0]);
    const queue = () => (readIn(S, '.studio/train/queue.json') || []).map((e) => e.task);
    return { S, env, evs, runs, mainHas, isDone, queue };
  };
  const node = (cwd, args, env, timeout = 240000) => spawnSync(process.execPath, args, { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout });
  const task = (cwd, line, env, timeout) => node(cwd, ['harness/task.mjs', ...line], env, timeout);
  const probe = (S, code, env) => { const f = path.join(S, `.probe-2782a-${++n}.mjs`); fs.writeFileSync(f, code); const r = node(S, [f], env); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  /** A task, its lane copy (.lanes/<agent>) made by the harness, the task started there, one note committed. */
  const lane = (st, agent, title, rel, text) => {
    const { S, env } = st;
    const a = task(S, ['add', title, '--role', 'builder', '--priority', 'P1'], env);
    const id = (out(a).match(/"id":\s*"(T-\d+)"/) || [])[1];
    const lp = path.join(S, `.lane-2782a-${++n}.mjs`);
    fs.writeFileSync(lp, `import { createLaneCopy } from ${u(S, 'harness/worktree.mjs')};\nconsole.log(JSON.stringify(createLaneCopy(process.argv[2], { task: process.argv[3] })));\n`);
    const mk = node(S, [lp, agent, id], env);
    const ld = path.join(S, '.lanes', agent);
    const as = { ...env, STUDIO_LOCK_OWNER: agent };
    const s1 = task(ld, ['start', id, '--agent', agent], as);
    writeIn(ld, rel, text);
    g(ld, 'add', '--', rel);
    const c = g(ld, 'commit', '-qm', `${id}: ${title}`, '--no-verify');
    return { id, agent, dir: ld, as, ok: Boolean(id) && fs.existsSync(ld) && s1.status === 0 && c.status === 0, log: `${out(a).slice(-300)}\n${out(mk).slice(-300)}\n${out(s1).slice(-400)}\n${out(c)}` };
  };
  const lifeOf = (S, id) => readIn(S, `.studio/train/${id}/life.json`);
  const trainIds = (S) => { try { return fs.readdirSync(path.join(S, '.studio', 'train'), { withFileTypes: true }).filter((e) => e.isDirectory() && /^\d{8}-\d{6}-\d+/.test(e.name)).map((e) => e.name); } catch { return []; } };
  const killTree = async (S, pid) => {
    // What an agent tool does to a command it ends: its whole tree (parent ids) and its process group.
    const h = await import(pathToFileURL(path.join(S, 'harness', 'heavy.mjs')).href);
    return h.killHolderTree({ pid, tree: { root: pid, groups: process.platform === 'win32' ? [] : [pid] } }, { self: process.pid, graceMs: 500 });
  };

  try {
    // ---- 1. a lane's plain task done queues and returns; a detached train lands it ----
    {
      const st = studio('queue');
      const { S, env } = st;
      const a = lane(st, 'bld-q1', 'Docs: note q1', 'game/demo/notes/q1.md', '# Q1\n');
      const sleepMs = 6000 * SLOW;
      const t0 = Date.now();
      const dn = task(a.dir, ['done', a.id, '--agent', a.agent], { ...a.as, TRAIN_SLEEP_MS: String(sleepMs) });
      const took = Date.now() - t0;
      const atReturn = { main: st.mainHas('game/demo/notes/q1.md'), queued: st.queue().includes(a.id), done: st.isDone(a.id), runs: st.runs() };
      const tidOf = () => trainIds(S).find((t) => lifeOf(S, t)?.lanes?.some((l) => l.task === a.id));
      const landed = await until(() => st.mainHas('game/demo/notes/q1.md') && st.isDone(a.id) && tidOf() && lifeOf(S, tidOf())?.ended, 120000 * SLOW);
      const evs = st.evs();
      const tid = tidOf();
      const life = tid ? lifeOf(S, tid) : null;
      // STUDIO_DONE_QUEUE=0: the train runs in task done itself, as before.
      const b = lane(st, 'bld-q2', 'Docs: note q2', 'game/demo/notes/q2.md', '# Q2\n');
      const dn0 = task(b.dir, ['done', b.id, '--agent', b.agent], { ...b.as, STUDIO_DONE_QUEUE: '0' });
      await guard('2.78.2 (a, W-0090): a lane\'s plain `task done` runs the quick checks, queues the lane and exits 0 with "queued" and how to follow it (train status) before any game check ran and without landing; a train it started detached (no supervisor runs) then lands it (main has the note, the task closes, the train\'s life record ends "done", its pid is not task done\'s); STUDIO_DONE_QUEUE=0 still lands inline ("status": "done") (fails on 2.78.1: task done ran the train inline: it returned only after the verify, "status": "done", nothing queued)', () => [
        a.ok && b.ok && dn.status === 0 && /queued/.test(out(dn)) && /"status": "queued"/.test(out(dn)) && /train status/.test(out(dn)) && /started for it, detached/.test(out(dn))
          && !atReturn.main && !atReturn.done && atReturn.queued && atReturn.runs === 0 && took < sleepMs + 60000
          && landed && life?.ended?.how === 'done' && life.pid && life.pid !== dn.pid
          && evs.some((e) => e.type === 'task.train.queued' && e.task === a.id && e.meta?.viaDone) && evs.some((e) => e.type === 'task.done' && e.task === a.id) && !evs.some((e) => e.type === 'task.train.died')
          && dn0.status === 0 && /"status": "done"/.test(out(dn0)) && st.mainHas('game/demo/notes/q2.md'),
        JSON.stringify({ a: a.ok ? 'ok' : a.log, b: b.ok, took, atReturn, landed, tid, life, dn: out(dn).slice(-1500), daemonLog: textIn(S, '.studio/train/daemon.log').slice(-1500), dn0: out(dn0).slice(-600) }).slice(0, 6000)]);
    }

    // ---- 1b. with a supervisor and the train daemon on, task done leaves the train to the daemon ----
    {
      const st = studio('kick');
      const { S, env } = st;
      const r = probe(S, `import { kickTrain } from ${u(S, 'harness/train-detach.mjs')};
const spawned = [];
const deps = { supervisor: () => ({ pid: process.pid }), auto: () => ({ on: true }), trainOn: () => true, spawn: (o) => { spawned.push(o.args.slice(1)); return { ok: true, pid: 4242 }; } };
const withSup = await kickTrain(process.cwd(), { by: 'bld-k', waitMin: 7, deps });
const autoOff = await kickTrain(process.cwd(), { by: 'bld-k', waitMin: 7, deps: { ...deps, auto: () => ({ on: false, why: 'train auto is off' }) } });
const noSup = await kickTrain(process.cwd(), { by: 'bld-k', waitMin: 7, deps: { ...deps, supervisor: () => null } });
console.log(JSON.stringify({ withSup, autoOff, noSup, spawned }));
`, env);
      const j = r.j || {};
      await guard('2.78.2 (a): after a queued task done, a running supervisor with the train daemon on starts the train (nothing spawned); with train auto off or no supervisor ONE train starts detached (train-daemon.mjs run --wait <STUDIO_TRAIN_LOCK_WAIT_MIN>) (fails on 2.78.1: harness/train-detach.mjs is missing)', () => [
        j.withSup?.how === 'daemon' && j.autoOff?.how === 'spawned' && j.noSup?.how === 'spawned' && j.spawned?.length === 2 && j.spawned.every((x) => x[0] === 'run' && x[1] === '--wait' && x[2] === '7'),
        out(r).slice(-1500)]);
    }

    // ---- 2. task train from an agent's shell survives the shell's end ----
    {
      const st = studio('detach');
      const { S, env } = st;
      const a = lane(st, 'bld-d1', 'Docs: note d1', 'game/demo/notes/d1.md', '# D1\n');
      const qd = task(a.dir, ['done', a.id, '--agent', a.agent, '--train'], a.as);
      const shellEnv = { ...process.env, ...ident, ...env, CLAUDECODE: '1', STUDIO_LOCK_OWNER: 'opus-1', TRAIN_SLEEP_MS: String(8000 * SLOW) };
      const c = spawn(process.execPath, ['harness/task.mjs', 'train', '--now', '--by', 'opus-1'], { cwd: S, env: shellEnv, windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore' });
      kids.push(c);
      const started = await until(() => st.runs() >= 1, 60000 * SLOW);
      const lock = readIn(S, '.studio/locks/train.lock');
      const killed = await killTree(S, c.pid);
      const starterGone = await until(() => !alive(c.pid), 15000);
      const trainAliveAfter = lock?.pid ? alive(lock.pid) : false;
      const landed = await until(() => st.mainHas('game/demo/notes/d1.md') && st.isDone(a.id) && lifeOf(S, lock?.id)?.ended, 120000 * SLOW);
      const life = lock?.id ? lifeOf(S, lock.id) : null;
      const evs = st.evs();
      await guard('2.78.2 (a): `task train` from an agent\'s shell (CLAUDECODE) runs its train detached: ending the starter\'s whole process tree and group mid-verify leaves the train running; it lands the lane, its life record ends "done" and no task.train.died is recorded (fails on 2.78.1: the train ran in the starter and died with it)', () => [
        a.ok && qd.status === 0 && started && lock?.pid && lock.pid !== c.pid && starterGone && trainAliveAfter && landed && life?.ended?.how === 'done' && !evs.some((e) => e.type === 'task.train.died'),
        JSON.stringify({ a: a.ok, qd: out(qd).slice(-300), started, lock, killed: killed?.killed, starterGone, trainAliveAfter, landed, life, runsLog: fs.existsSync(path.join(S, '.studio', 'train', 'runs')) ? fs.readdirSync(path.join(S, '.studio', 'train', 'runs')) : [] }).slice(0, 4000)]);
    }

    // ---- 3. a session whose task done queued its lane ends without the launcher's verify or hand-back ----
    {
      const st = studio('session');
      const { S, env } = st;
      writeIn(S, '.studio/train/queue.json', JSON.stringify([{ task: 'T-501', agent: 'bld-s1', branch: 'lane/bld-s1', head: 'a'.repeat(40), at: new Date().toISOString() }]));
      const r = probe(S, `import { trainQueued } from ${u(S, 'harness/agent.mjs')};
const sd = ${JSON.stringify(path.join(S, '.studio'))};
console.log(JSON.stringify({ mine: trainQueued('T-501', { agent: 'bld-s1', stateDir: sd }), byBranch: trainQueued('T-501', { agent: 'bld-zz', branch: 'lane/bld-s1', stateDir: sd }), other: trainQueued('T-501', { agent: 'bld-s2', branch: 'lane/bld-s2', stateDir: sd }), otherTask: trainQueued('T-502', { agent: 'bld-s1', stateDir: sd }) }));
`, env);
      const src = textIn(S, 'harness/agent.mjs');
      const loop = src.slice(src.indexOf('const queuedForTrain = [];'), src.indexOf('const hasCommit = workCommitted('));
      await guard('2.78.2 (a): at a session\'s end the launcher leaves a task whose lane that session queued for the train (agent or lane branch in the queue) to the train: no launcher verify, no second task done, no hand-back (fails on 2.78.1: no trainQueued; the launcher ran autoFinish, a full verify, on the queued task)', () => [
        r.j?.mine === true && r.j.byBranch === true && r.j.other === false && r.j.otherTask === false && /trainQueued\(id, \{ agent, branch: s0\.copy\?\.branch/.test(loop) && /continue;/.test(loop),
        `${out(r).slice(-800)}\n${loop.slice(0, 600)}`]);
    }

    // ---- 4. train cancel: a person stops a running train cleanly ----
    {
      const st = studio('cancel');
      const { S, env } = st;
      const a = lane(st, 'bld-c1', 'Docs: note c1', 'game/demo/notes/c1.md', '# C1\n');
      const qc = task(a.dir, ['done', a.id, '--agent', a.agent, '--train'], a.as);
      const c = spawn(process.execPath, ['harness/task.mjs', 'train', '--now', '--by', 'tester', '--foreground'], { cwd: S, env: { ...process.env, ...ident, ...env, TRAIN_SLEEP_MS: String(600000) }, windowsHide: true, stdio: 'ignore' });
      kids.push(c);
      const started = await until(() => st.runs() >= 1, 60000 * SLOW);
      const lock = readIn(S, '.studio/locks/train.lock');
      const worker = task(S, ['train', 'cancel', '--by', 'builder-x', '--why', 'mine'], { ...env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-x' });
      const t0 = Date.now();
      const cn = task(S, ['train', 'cancel', '--by', 'pat', '--why', 'red chain too long'], env);
      const took = Date.now() - t0;
      const ended = await until(() => c.exitCode !== null, 30000 * SLOW);
      const life = lock?.id ? lifeOf(S, lock.id) : null;
      const evs = st.evs();
      const cancelled = evs.filter((e) => e.type === 'task.train.cancelled');
      const board = textIn(S, 'studio/NEXT.md');
      await guard('2.78.2 (a): `task train cancel --by pat --why "…"` stops a train in its verify: its checks are stopped and it ends at once (well under the check\'s 10 min), nothing lands, nobody is handed back (the task stays in progress, no task.paused), the lane stays queued, the lock is freed, ONE task.train.cancelled names pat and the why, the train records cancel_ended; a worker is refused (fails on 2.78.1: there is no train cancel)', () => [
        a.ok && qc.status === 0 && started && lock?.id && cn.status === 0 && /cancelled/.test(out(cn)) && took < 60000 * SLOW && ended
          && !st.mainHas('game/demo/notes/c1.md') && !st.isDone(a.id) && st.queue().includes(a.id) && !fs.existsSync(path.join(S, '.studio', 'locks', 'train.lock'))
          && !evs.some((e) => e.type === 'task.paused' && e.task === a.id) && board.includes(a.id)
          && cancelled.length === 1 && cancelled[0].meta?.by === 'pat' && cancelled[0].meta?.why === 'red chain too long' && cancelled[0].meta?.how === 'clean' && evs.some((e) => e.type === 'task.train.cancel_ended')
          && life?.ended?.how === 'done' && !evs.some((e) => e.type === 'task.train.died')
          && worker.status !== 0 && /Refused/.test(out(worker)),
        JSON.stringify({ a: a.ok, qc: out(qc).slice(-300), started, lock, cn: out(cn).slice(-800), took, ended, life, queue: st.queue(), cancelled, worker: out(worker).slice(-300) }).slice(0, 5000)]);
    }

    // ---- 4b. a train that doesn't end by itself is ended and recorded as cancelled ----
    {
      const st = studio('cancel-force');
      const { S, env } = st;
      const a = lane(st, 'bld-c2', 'Docs: note c2', 'game/demo/notes/c2.md', '# C2\n');
      const qc = task(a.dir, ['done', a.id, '--agent', a.agent, '--train'], a.as);
      const c = spawn(process.execPath, ['harness/task.mjs', 'train', '--now', '--by', 'tester', '--foreground'], { cwd: S, env: { ...process.env, ...ident, ...env, TRAIN_SLEEP_MS: String(600000) }, windowsHide: true, stdio: 'ignore' });
      kids.push(c);
      const started = await until(() => st.runs() >= 1, 60000 * SLOW);
      const lock = readIn(S, '.studio/locks/train.lock');
      // The train's children are left running (a hang the kill can't reach) and no wait: cancel ends the train itself.
      const r = probe(S, `import { cancelTrain } from ${u(S, 'harness/train-cancel.mjs')};
const r = await cancelTrain(process.cwd(), { by: 'pat', why: 'hung', waitMs: 0, kill: { children: async () => ({ killed: [] }) } });
console.log(JSON.stringify(r));
`, env);
      const ended = await until(() => c.exitCode !== null || c.signalCode !== null, 30000 * SLOW);
      const life = lock?.id ? lifeOf(S, lock.id) : null;
      const evs = st.evs();
      const cancelled = evs.filter((e) => e.type === 'task.train.cancelled');
      await guard('2.78.2 (a): a cancelled train that doesn\'t end within STUDIO_TRAIN_CANCEL_WAIT_S is ended with its tree: its life record says cancelled (by pat), its lock is freed, its lane stays queued, the event says how "ended", and no task.train.died is recorded (fails on 2.78.1: harness/train-cancel.mjs is missing)', () => [
        a.ok && qc.status === 0 && started && r.j?.ok === true && r.j.how === 'ended' && ended && life?.ended?.how === 'cancelled' && life.ended.by === 'pat'
          && !fs.existsSync(path.join(S, '.studio', 'locks', 'train.lock')) && st.queue().includes(a.id) && !st.isDone(a.id)
          && cancelled.length === 1 && cancelled[0].meta?.how === 'ended' && !evs.some((e) => e.type === 'task.train.died'),
        JSON.stringify({ a: a.ok, started, lock, r: out(r).slice(-800), ended, life, queue: st.queue(), cancelled }).slice(0, 4000)]);
    }
  } finally {
    for (const c of kids) { try { if (c.exitCode === null) process.kill(c.pid, 'SIGKILL'); } catch {} }
    // Every train process the checks started (detached) and their checks.
    for (const S of made) {
      for (const f of ['train.lock', 'train-next.lock']) { const l = readIn(S, `.studio/locks/${f}`); if (l?.pid && l.pid !== process.pid) { try { await killTree(S, l.pid); } catch {} } }
      const d = readIn(S, '.studio/train/daemon.json'); if (d?.pid) { try { await killTree(S, d.pid); } catch {} }
    }
    for (const S of made) {
      try { g(S, 'worktree', 'prune'); } catch {}
      try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch {}
    }
  }
}
