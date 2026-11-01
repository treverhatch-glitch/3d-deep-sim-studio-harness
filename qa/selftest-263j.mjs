/**
 * qa/selftest-263j.mjs — 2.63.0 (helper j): the Unity merge train (harness/unity-train.mjs).
 *   1. two Unity-track tasks queued with task done --train land on ONE run of the land command ({branches}), and close;
 *   2. a red train (a land command that takes one {branch}: the harness builds unity-train/<id> from refs only) hands
 *      back exactly the culprit by prefix bisection; green prefixes land and close;
 *   3. a conflict: two branches that conflict in git: the first lands, the second waits (stays queued, not handed
 *      back); a branch the land command reports as a conflict (exit 2) is handed back, the rest land;
 *   4. a refusal (exit 3) blames nobody: the branches stay queued; a refusal that clears is tried again and lands;
 *   5. one Unity train at a time (a second is refused, naming the first; train status shows it running and the queue
 *      length), and every land run of both trains holds machine:heavy.
 * The land command is a stub: it reads the branch list, refuses while a "busy" file exists, fails when a marked
 * branch is included, returns 2 for a marked conflict, else merges the branches in its own gate worktree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export async function selftest263J({ dir, run, report, tmpRoot }) {
  const SLOW = Number(process.env.STUDIO_SELFTEST_SLOW) || (process.platform === 'win32' ? 2.5 : 1);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const until = (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !fn()) nap(50); return fn(); };
  const guard = (name, fn) => { try { const [ok, detail] = fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const events = path.join(dir, '.studio', 'events-263j.jsonl');
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_HEAVY_SLOTS: '1', STUDIO_HEAVY_HELD: '', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '', STUDIO_GATE_PRIORITY: '', STUDIO_LOCK_OWNER: '', STUDIO_GAME: '', STUDIO_TRAIN: '', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_DONE_GAME_GATES: 'skip', STUDIO_VISUAL_GATE: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_UNCOMMITTED: 'allow', STUDIO_REACHABILITY: 'off', STUDIO_HOOKS_CHECK: 'off', STUDIO_WEAKENED_TESTS: 'off', STUDIO_DONE_UNITY_GATE: '', npm_lifecycle_event: '', AGENT_EVENTS_FILE: events };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  const h = (cwd, ref) => g(cwd, 'rev-parse', ref).stdout.trim();
  const anc = (cwd, a, b) => g(cwd, 'merge-base', '--is-ancestor', a, b).status === 0;

  // The Unity repo: a porters' checkout on "dev", the land script's own gate worktree on the target "port/main".
  const uni = path.join(tmpRoot, `port-263j-${process.pid}`);
  const gw = path.join(tmpRoot, `port-263j-gate-${process.pid}`);
  fs.mkdirSync(uni, { recursive: true });
  g(uni, 'init', '-q', '-b', 'port/main');
  g(uni, 'config', 'user.name', 'porter'); g(uni, 'config', 'user.email', 'porter@example.test'); g(uni, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(uni, 'Rules.cs'), 'line one\nline two\n');
  g(uni, 'add', '-A'); g(uni, 'commit', '-qm', 'start');
  g(uni, 'checkout', '-q', '-b', 'dev');
  g(uni, 'worktree', 'add', '-q', gw, 'port/main');
  const branch = (name, file, text) => {
    g(uni, 'checkout', '-q', '-B', name, 'port/main');
    fs.writeFileSync(path.join(uni, file), text);
    g(uni, 'add', '-A'); g(uni, 'commit', '-qm', `${name} work`);
    g(uni, 'checkout', '-q', 'dev');
    return h(uni, name);
  };
  const ctl = (f) => path.join(tmpRoot, `263j-${process.pid}-${f}`);
  const runsLog = ctl('runs.jsonl');
  const stub = ctl('land.mjs');
  fs.writeFileSync(stub, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [gw, ...srcs] = process.argv.slice(2);
const ctl = (f) => ${JSON.stringify(ctl(''))} + f;
const read = (f) => { try { return fs.readFileSync(ctl(f), 'utf8').split('\\n').map((s) => s.trim()).filter(Boolean); } catch { return []; } };
const locks = ${JSON.stringify(path.join(dir, '.studio', 'locks'))};
const heavy = fs.readdirSync(locks).filter((f) => /^machine-heavy-\\d+\\.lock$/.test(f)).map((f) => { try { return JSON.parse(fs.readFileSync(locks + '/' + f, 'utf8')).label; } catch { return '?'; } });
fs.appendFileSync(ctl('runs.jsonl'), JSON.stringify({ srcs, heavy, held: Boolean(process.env.STUDIO_HEAVY_HELD) }) + '\\n');
const git = (...a) => spawnSync('git', a, { cwd: gw, encoding: 'utf8' });
if (fs.existsSync(ctl('slow'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(fs.readFileSync(ctl('slow'), 'utf8')));
if (fs.existsSync(ctl('busy'))) { if (fs.readFileSync(ctl('busy'), 'utf8').trim() === 'once') fs.rmSync(ctl('busy')); console.log('refused: an editor is open'); process.exit(3); }
const has = (b) => srcs.some((s) => git('merge-base', '--is-ancestor', b, s).status === 0);
for (const b of read('conflict')) if (has(b)) { console.log('conflict landing ' + b); process.exit(2); }
for (const b of read('red')) if (has(b)) { console.log('EditMode: 1 failed (' + b + ')'); process.exit(1); }
for (const s of srcs) { const m = git('merge', '--no-ff', '-m', 'land ' + s, s); if (m.status !== 0) { git('merge', '--abort'); console.log('conflict ' + s); process.exit(2); } }
console.log('landed ' + srcs.join(' '));
process.exit(0);
`);
  const runs = () => { try { return fs.readFileSync(runsLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const resetCtl = () => { for (const f of ['runs.jsonl', 'red', 'conflict', 'busy', 'slow']) fs.rmSync(ctl(f), { force: true }); };

  const gameJson = path.join(dir, 'studio', 'game.json');
  const gameBefore = fs.existsSync(gameJson) ? fs.readFileSync(gameJson, 'utf8') : null;
  const setUnity = (unity) => fs.writeFileSync(gameJson, JSON.stringify({ ...(gameBefore ? JSON.parse(gameBefore) : {}), engines: { unity } }, null, 2));
  const MANY = { land: `node "${stub}" "${gw}" {branch}`, landMany: `node "${stub}" "${gw}" {branches}`, target: 'port/main', cwd: uni, gateWorktree: gw };
  const ONE = { land: `node "${stub}" "${gw}" {branch}`, target: 'port/main', cwd: uni, gateWorktree: gw };

  const task = (cmd, env = {}) => run(dir, `node harness/task.mjs ${cmd}`, { ...base, ...env });
  let k = 0;
  /** A Unity-track task with its own branch, started and queued with task done --train. */
  const unityTask = (name, file, text, { queue = true } = {}) => {
    const agent = `porter-263j-${++k}`;
    const id = (task(`add "Plan the Unity port of the ${name} rules" --role engine-porter --track engine:unity`).stdout.match(/"id":\s*"(T-\d+)"/) || [])[1];
    task(`start ${id} --agent ${agent}`);
    const br = `feat/${name}`;
    const head = branch(br, file, text);
    const q = queue ? task(`done ${id} --agent ${agent} --train --branch ${br}`) : null;
    return { id, agent, br, head, q };
  };
  const train = (env = {}) => {
    const r = task('train --unity --by producer-263j', env);
    let j = null;
    try { j = JSON.parse(String(r.stdout).slice(String(r.stdout).indexOf('{\n'))); } catch {}
    return { code: r.status, j, text: out(r) };
  };
  const doneMd = () => { try { return fs.readFileSync(path.join(dir, 'studio', 'DONE.md'), 'utf8'); } catch { return ''; } };
  const isDone = (id) => new RegExp(`\\*\\*${id}\\*\\*`).test(doneMd());
  const evs = () => { try { return fs.readFileSync(events, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return {}; } }); } catch { return []; } };
  const handedBack = () => evs().filter((e) => e.type === 'task.train.unity.dropped').map((e) => e.task);
  const queue = () => readJson(path.join(dir, '.studio', 'train', 'unity-queue.json')) || [];
  const leftRefs = () => g(uni, 'for-each-ref', '--format=%(refname)', 'refs/heads/unity-train/').stdout.trim();
  const kids = [];

  try {
    // ---------- 1. two Unity tasks, ONE land run ----------
    {
      setUnity(MANY);
      resetCtl();
      const a = unityTask('dock', 'Dock.cs', 'dock\n');
      const b = unityTask('crane', 'Crane.cs', 'crane\n');
      const queued = queue().map((e) => e.task);
      const r = train();
      const rs = runs();
      const tip = h(uni, 'port/main');
      guard('2.63.0 (j1): two Unity-track tasks queued with task done --train land on ONE run of the land command (both branches in its {branches}, in order); the target contains both and both tasks close (2.60.0: no Unity train)', () => [
        a.q?.status === 0 && b.q?.status === 0 && queued.join() === [a.id, b.id].join() && r.code === 0 && rs.length === 1 && rs[0].srcs.join(' ') === `${a.br} ${b.br}`
          && anc(uni, a.head, tip) && anc(uni, b.head, tip) && isDone(a.id) && isDone(b.id) && queue().length === 0 && r.j?.runs === 1,
        JSON.stringify({ q: [out(a.q || {}).slice(-400), out(b.q || {}).slice(-300)], queued, r: r.text.slice(-900), rs, done: [isDone(a.id), isDone(b.id)] }).slice(0, 3000)]);
    }

    // ---------- 2. red: prefix bisection hands back exactly the culprit ----------
    {
      setUnity(ONE);
      resetCtl();
      const t = [unityTask('berth', 'Berth.cs', 'berth\n'), unityTask('tide', 'Tide.cs', 'tide\n'), unityTask('pilot', 'Pilot.cs', 'pilot\n'), unityTask('tug', 'Tug.cs', 'tug\n')];
      fs.writeFileSync(ctl('red'), `${t[2].br}\n`);
      const before = handedBack().length;
      const r = train();
      const rs = runs();
      const tip = h(uni, 'port/main');
      const back = handedBack().slice(before);
      guard('2.63.0 (j2): a red Unity train (land command with one {branch}: the harness hands it one integration branch made from refs only) hands back exactly the culprit by prefix bisection (4 runs: all, first half green and landed, the culprit red, the rest green); the others land and close; no unity-train/* ref is left', () => [
        rs.length === 4 && /^unity-train\//.test(rs[0].srcs[0]) && back.join() === t[2].id && r.j?.dropped?.map((d) => d.task).join() === t[2].id
          && [0, 1, 3].every((i) => isDone(t[i].id) && anc(uni, t[i].head, tip)) && !isDone(t[2].id) && !anc(uni, t[2].head, tip) && /prefix bisection/.test(r.j?.dropped?.[0]?.why || '') && /EditMode: 1 failed/.test(r.j?.dropped?.[0]?.why || '') && !leftRefs() && queue().length === 0,
        JSON.stringify({ r: r.text.slice(-1500), rs, back, refs: leftRefs() }).slice(0, 3000)]);
    }

    // ---------- 3. conflicts: a git conflict waits; a reported conflict is handed back ----------
    {
      setUnity(MANY);
      resetCtl();
      const e = unityTask('quay', 'Rules.cs', 'line one\nquay version\n');
      const f = unityTask('pier', 'Rules.cs', 'line one\npier version\n');
      const r1 = train();
      const waits = queue().map((x) => x.task);
      const backBefore = handedBack();
      // Its next train: what it conflicted with has landed, so it conflicts with the target now: handed back from
      // refs, before any land run.
      const n3 = runs().length;
      const r3 = train();
      guard('2.63.0 (j3): two queued branches that conflict with each other: the first lands, the second waits for the next Unity train (still queued, not handed back); in that next train it conflicts with the target (what it conflicted with landed) and is handed back with "merge the target into it", found from refs before any land run', () => [
        r1.j?.landed?.join() === e.id && r1.j?.deferred?.map((d) => d.task).join() === f.id && waits.join() === f.id && !backBefore.includes(f.id) && !isDone(f.id)
          && r3.j?.dropped?.map((d) => d.task).join() === f.id && /conflicts with the target/.test(r3.j?.dropped?.[0]?.why || '') && runs().length === n3 && queue().length === 0 && !isDone(f.id),
        JSON.stringify({ r1: r1.text.slice(-900), waits, r3: r3.text.slice(-900) }).slice(0, 3000)]);
      const before = handedBack().length;
      const gq = unityTask('lock', 'Lock.cs', 'lock\n');
      const hq = unityTask('weir', 'Weir.cs', 'weir\n');
      fs.writeFileSync(ctl('conflict'), `${gq.br}\n`);
      const r2 = train();
      const back = handedBack().slice(before);
      guard('2.63.0 (j3b): a branch the land command reports as a conflict (exit 2) is found by prefix bisection and handed back; the other lands and closes', () => [
        back.join() === gq.id && r2.j?.landed?.join() === hq.id && /merge conflict/.test(r2.j?.dropped?.[0]?.why || '') && isDone(hq.id) && !isDone(gq.id),
        JSON.stringify({ r2: r2.text.slice(-1200), back }).slice(0, 3000)]);
    }

    // ---------- 4. refused (3): nobody is blamed, retried ----------
    {
      setUnity(MANY);
      resetCtl();
      const a = unityTask('buoy', 'Buoy.cs', 'buoy\n');
      const b = unityTask('mast', 'Mast.cs', 'mast\n');
      fs.writeFileSync(ctl('busy'), 'always');
      const before = handedBack().length;
      const r1 = train({ STUDIO_UNITY_TRAIN_RETRIES: '0' });
      const kept = queue().map((x) => x.task);
      const openAfter1 = !isDone(a.id) && !isDone(b.id);
      const st = task('train status');
      fs.writeFileSync(ctl('busy'), 'once');
      const n0 = runs().length;
      const r2 = train({ STUDIO_UNITY_TRAIN_RETRIES: '1', STUDIO_UNITY_TRAIN_RETRY_MIN: '0.001' });
      guard('2.63.0 (j4): a refused land run (exit 3: an editor open) blames nobody: no hand-back, both branches stay queued and in progress (exit 3, "the next Unity train tries again"); a refusal that clears is tried again in the same train and both land', () => [
        r1.code === 3 && handedBack().length === before && kept.join() === [a.id, b.id].join() && openAfter1 && r1.j?.refused && /refused/.test(r1.j?.deferred?.[0]?.why || '') && /2 Unity branch\(es\) wait/.test(out(st))
          && r2.code === 0 && runs().length - n0 === 2 && r2.j?.landed?.join() === [a.id, b.id].join() && isDone(a.id) && isDone(b.id),
        JSON.stringify({ c1: r1.code, j1: r1.j, kept, st: out(st).slice(0, 600), c2: r2.code, j2: r2.j, runs: runs().length - n0 }).slice(0, 3000)]);
    }

    // ---------- 5. one Unity train at a time; machine:heavy for every run ----------
    {
      setUnity(MANY);
      resetCtl();
      const a = unityTask('slip', 'Slip.cs', 'slip\n');
      fs.writeFileSync(ctl('slow'), String(Math.round(5000 * SLOW)));
      const c = spawn(process.execPath, ['harness/task.mjs', 'train', '--unity', '--by', 'first-263j'], { cwd: dir, env: { ...process.env, ...base }, stdio: 'ignore' });
      kids.push(c);
      const lockF = path.join(dir, '.studio', 'locks', 'unity-train.lock');
      const up = until(() => readJson(lockF)?.by === 'first-263j' && runs().length === 1, 20000 * SLOW);
      const b = unityTask('jetty', 'Jetty.cs', 'jetty\n');
      const second = train();
      const st = task('train status');
      const finished = until(() => !fs.existsSync(lockF), 30000 * SLOW);
      fs.rmSync(ctl('slow'), { force: true });
      const third = train();
      const rs = runs();
      guard('2.63.0 (j5): one Unity train at a time: a second is refused while the first runs, naming it; train status shows the running train and the queue length; every land run of both trains held machine:heavy (labelled "unity train")', () => [
        up && /Another Unity train is running \([^)]*by first-263j/.test(second.text) && second.code !== 0 && /Unity train running: .* by first-263j/.test(out(st)) && /1 Unity branch\(es\) wait/.test(out(st)) && finished
          && third.j?.landed?.join() === b.id && isDone(a.id) && rs.length === 2 && rs.every((x) => x.held && x.heavy.length === 1 && /^unity train /.test(x.heavy[0])),
        JSON.stringify({ up, second: second.text.slice(-500), st: out(st).slice(-600), finished, third: third.text.slice(-400), rs }).slice(0, 3000)]);
    }
  } finally {
    for (const c of kids) { try { if (c.exitCode === null) c.kill(); } catch {} }
    if (gameBefore === null) fs.rmSync(gameJson, { force: true }); else fs.writeFileSync(gameJson, gameBefore);
    try { g(uni, 'worktree', 'remove', '--force', gw); } catch {}
    for (const p of [uni, gw]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
    resetCtl();
    try { fs.rmSync(stub, { force: true }); } catch {}
  }
}
