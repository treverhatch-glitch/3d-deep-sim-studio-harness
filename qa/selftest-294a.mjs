/**
 * qa/selftest-294a.mjs — 2.94: the next batch's rules check runs beside the current land run (engines.<x>.rules.ahead).
 * Off: nothing starts. On: the next train finds the kept result (or waits for the run still going) and runs no test
 * again; a red land run or a cancel ends the check ahead with its processes and keeps nothing; not enough memory: not
 * started; a red ahead hands nobody back by itself.
 *
 * The scaffolding (a studio copy, a made-up engine repo, stand-ins for the land script and the rules check) is
 * qa/selftest-293a.mjs's. The land stand-in waits for the check ahead's state file (a condition, never a fixed sleep).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, eventTypesOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, queueUnityOf, readJsonFile as readJson, writeIn as write } from './kit.mjs';

export async function selftest294A({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s294a-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: PowerShell (the process list a train cancel reads) needs Windows' own system variables, which any real shell
  // has; from this cut-down environment it ran into its time limit (P-370). Passed through as they are, as in 284u.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.5', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_TEST_FREEMEM_MB: '64000',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-294a-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  const S = path.join(tmpRoot, `294a-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-294a.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventTypesOf(eventsFileOf(evFile));
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probeFile = (code) => { const f = path.join(S, `.probe-294a-${++pn}.mjs`); fs.writeFileSync(f, code); return f; };
  const probe = (code, env = {}) => {
    const f = probeFile(code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'comm', 'gates', 'tmp', 'locks', 'line']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.writeFileSync(evFile, ''); };

  let rn = 0;
  const engineRepo = (lanes) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    for (const [f, t] of Object.entries({ 'Sim/Move.cs': 'class Move { }\n', 'Sim/Fees.cs': 'class Fees { }\n', 'notes.txt': 'n\n' })) write(R, f, t);
    g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    g(R, 'checkout', '-q', '-b', 'dev');
    g(R, 'worktree', 'add', '-q', GW, 'port/main');
    const heads = {};
    for (const [br, files] of Object.entries(lanes)) {
      g(R, 'checkout', '-q', '-B', br, 'port/main');
      for (const [f, t] of Object.entries(files)) write(R, f, t);
      g(R, 'add', '-A'); g(R, 'commit', '-qm', `${br} work`);
      heads[br] = g(R, 'rev-parse', br).stdout.trim();
      g(R, 'checkout', '-q', 'dev');
    }
    return { R, GW, heads };
  };
  const lanes2 = { 'feat/a': { 'Sim/Move.cs': 'class Move { int a; }\n' }, 'feat/b': { 'notes.txt': 'n2\n' } };

  // The land script's stand-in. <ctl>-wait names the check ahead's state to wait for ("any": not waiting any more,
  // "running", "done"); <ctl>-waitpid also waits for the ahead's rules command to start. Then <ctl>-red: exit 1 (red);
  // <ctl>-hang: record and hang until a cancel ends it. Else it merges the branches.
  const outFile = path.join(S, '.studio', 'engine', 'unity-rules-ahead-out.json');
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, rulesGreen: process.env.STUDIO_RULES_GREEN ?? null }) + '\\n');
if (fs.existsSync(ctl + '-wait')) {
  const want = fs.readFileSync(ctl + '-wait', 'utf8').trim();
  const ok = (o) => o && (want === 'any' ? o.state !== 'waiting' : o.state === want || (want === 'running' && o.state === 'done'));
  for (const until = Date.now() + 90000; Date.now() < until; nap(100)) { const o = rd(${JSON.stringify(outFile)}); if (ok(o) && (!fs.existsSync(ctl + '-waitpid') || fs.existsSync(ctl + '-ahead-pid'))) { fs.writeFileSync(ctl + '-seen.json', JSON.stringify(o)); break; } }
  fs.rmSync(ctl + '-wait', { force: true });
}
if (fs.existsSync(ctl + '-red')) { fs.rmSync(ctl + '-red', { force: true }); console.log('Failed Game.Tests.Land.Red'); process.exit(1); }
if (fs.existsSync(ctl + '-hang')) { fs.writeFileSync(ctl + '-started', JSON.stringify({ pid: process.pid })); setTimeout(() => {}, 180000); }
else {
  const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
  for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); process.exit(2); } }
  console.log('landed ' + srcs.join(' '));
}
`);
  // The rules check's stand-in: records each run; a run of the check ahead (its folder's name says so) records its pid
  // and takes AHEAD_STUB_MS.
  const rulesStub = path.join(T, 'rules-stub.mjs');
  fs.writeFileSync(rulesStub, `import fs from 'node:fs'; import path from 'node:path';
const [ctl] = process.argv.slice(2);
const ahead = /-ahead-/.test(process.env.STUDIO_RULES_DIR || '');
fs.appendFileSync(ctl + '-rules.jsonl', JSON.stringify({ ahead, commit: process.env.STUDIO_RULES_COMMIT || null, pid: process.pid }) + '\\n');
if (ahead) { fs.writeFileSync(ctl + '-ahead-pid', String(process.pid)); if (Number(process.env.AHEAD_STUB_MS) > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.AHEAD_STUB_MS)); }
const bad = fs.readFileSync(path.join(process.cwd(), 'Sim/Fees.cs'), 'utf8').includes('BAD');
console.log('  ' + (bad ? 'Failed' : 'Passed') + ' Game.Rules.Tests.FeesTests.Charges [3 ms]');
process.exit(bad ? 1 : 0);
`);
  const cfgFor = (E, ctl, rules) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, batchMax: 1, rules });
  const rulesOf = (ctl, extra = {}) => ({ test: `node "${fwd(rulesStub)}" "${fwd(ctl)}"`, ...extra });
  const rulesRuns = (ctl) => { try { return fs.readFileSync(`${ctl}-rules.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const queue = queueUnityOf(S);
  const qTasks = () => (readJson(path.join(S, '.studio', 'train', 'unity-queue.json')) || []).map((e) => e.task);
  const cacheTrees = () => Object.keys(readJson(path.join(S, '.studio', 'engine', 'unity-rules.json'))?.trees || {});
  const aheadFiles = () => { try { return fs.readdirSync(path.join(S, '.studio', 'engine')).filter((f) => f.includes('rules-ahead')); } catch { return []; } };
  const outcomes = () => evs(/^task\.train\.unity\.rules_ahead$/).map((e) => e.meta?.outcome);
  const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
  const gone = async (pids) => { for (let i = 0; i < 150 && pids.some(alive); i++) await new Promise((r) => { setTimeout(r, 200); }); return !pids.some(alive); };
  const TRAIN = `import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const handed = []; const logs = [];
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps: { handBack: (lane, note, extra) => handed.push({ task: lane.task, extra: extra || null }) } });
console.log(JSON.stringify({ ok: r.ok, landed: r.landed, dropped: r.dropped, handed, rules: r.rules || null, logs: logs.filter((l) => /rules|ahead|takes the set/.test(l)) }));`;
  const J = (x) => JSON.stringify(x).slice(0, 2800);
  const ctlOf = (n) => path.join(T, `ctl-${n}`);

  // ================= (a) off =================
  {
    resetState();
    const E = engineRepo(lanes2);
    const ctl = ctlOf('off');
    setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl)) });
    queue(E, [['T-101', 'feat/a'], ['T-102', 'feat/b']]);
    const r1 = probe(TRAIN);
    const files1 = aheadFiles();
    const r2 = probe(TRAIN);
    const rr = rulesRuns(ctl);
    await guard('2.94 (a) rules.ahead unset: nothing runs beside the land run (no ahead file, no rules_ahead event, no ahead line); each train runs its own rules check once, as in 2.93 (two runs for two trains)', () => [
      r1.landed?.join() === 'T-101' && r2.landed?.join() === 'T-102' && !files1.length && !aheadFiles().length && !outcomes().length && rr.length === 2 && rr.every((x) => !x.ahead)
        && ![...(r1.logs || []), ...(r2.logs || [])].some((l) => /check ahead/.test(l)), J({ r1, r2, rr, files1 })]);
  }

  // ================= (b) on, the land run lands green =================
  {
    resetState();
    const E = engineRepo(lanes2);
    const ctl = ctlOf('green');
    setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { ahead: true })) });
    queue(E, [['T-111', 'feat/a'], ['T-112', 'feat/b']]);
    fs.writeFileSync(`${ctl}-wait`, 'done');
    const r1 = probe(TRAIN);
    const n1 = rulesRuns(ctl).length;
    const r2 = probe(TRAIN);
    const rr = rulesRuns(ctl);
    await guard('2.94 (b) rules.ahead on, the land run of T-111 lands: the check ahead runs T-112 on the checked head beside it (started, kept green), and the next train answers its rules check from it: the rules command ran twice in all (the batch, the check ahead), never a third time, and T-112 lands told green (fails before this fix: nothing was checked while the land run ran)', () => [
      r1.landed?.join() === 'T-111' && n1 === 2 && rr.length === 2 && rr[1].ahead && r2.landed?.join() === 'T-112' && r2.rules?.runs === 0
        && (fs.readFileSync(`${ctl}-runs.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop() || {}).rulesGreen === '1'
        && r1.logs?.some((l) => /the check ahead started: T-112/.test(l)) && r2.logs?.some((l) => /the batch's result came from the check ahead of train/.test(l))
        && outcomes().join() === 'started,kept-green' && !aheadFiles().length, J({ r1, r2, rr, ev: outcomes() })]);
  }

  // ================= (c) the land run is red =================
  {
    resetState();
    const E = engineRepo(lanes2);
    const ctl = ctlOf('red-running');
    setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { ahead: true })) });
    queue(E, [['T-121', 'feat/a'], ['T-122', 'feat/b']]);
    fs.writeFileSync(`${ctl}-wait`, 'running'); fs.writeFileSync(`${ctl}-waitpid`, '1'); fs.writeFileSync(`${ctl}-red`, '1');
    const r1 = probe(TRAIN, { AHEAD_STUB_MS: '120000' });
    const seen = readJson(`${ctl}-seen.json`) || {};
    const stubPid = Number(fs.readFileSync(`${ctl}-ahead-pid`, 'utf8'));
    const ended = await gone([seen.pid, stubPid].filter(Boolean));
    await guard('2.94 (c) the land run is red while the check ahead runs: T-121 is handed back, the check ahead is ended with its process tree (the child and its rules command are gone), nothing of it is kept and one log line says why (fails before this fix: no check ahead existed to end)', () => [
      r1.handed?.map((h) => h.task).join() === 'T-121' && seen.state === 'running' && seen.pid > 0 && ended && !aheadFiles().length && outcomes().join() === 'started,dropped'
        && r1.logs?.some((l) => /the check ahead was ended: the land run ended red; nothing of it is kept/.test(l)) && qTasks().join() === 'T-122', J({ r1, seen, stubPid, ended, ev: outcomes() })]);
  }
  {
    resetState();
    const E = engineRepo(lanes2);
    const ctl = ctlOf('red-done');
    setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { ahead: true })) });
    queue(E, [['T-131', 'feat/a'], ['T-132', 'feat/b']]);
    fs.writeFileSync(`${ctl}-wait`, 'done'); fs.writeFileSync(`${ctl}-red`, '1');
    const r1 = probe(TRAIN);
    const trees = cacheTrees();
    const kept = Object.values(readJson(path.join(S, '.studio', 'engine', 'unity-rules.json'))?.trees || {});
    await guard('2.94 (c) a check ahead that finished green before the land run turned red is dropped (the event says so, the next train does not wait for it); 2.96: its exact-tree green stays kept as a fact about that tree, so the rules file holds the batch\'s own result and that green (fails before this fix: no check ahead existed)', () => [
      r1.handed?.map((h) => h.task).join() === 'T-131' && rulesRuns(ctl).length === 2 && trees.length === 2 && kept.every((x) => x.status === 'pass') && outcomes().join() === 'started,dropped' && !aheadFiles().length, J({ r1, trees, kept, ev: outcomes() })]);
  }

  // ================= (d) not enough memory =================
  {
    resetState();
    const E = engineRepo(lanes2);
    const ctl = ctlOf('ram');
    setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { ahead: true })) });
    queue(E, [['T-141', 'feat/a'], ['T-142', 'feat/b']]);
    fs.writeFileSync(`${ctl}-wait`, 'any');
    const r1 = probe(TRAIN, { STUDIO_TEST_FREEMEM_MB: '1000' });
    // 2.95: changed on purpose: a check ahead that does not start is an event (outcome not-started, with the reason).
    await guard('2.94 (d) free RAM minus the floor under what one rules run takes (1 GB against the default 4): the check ahead is not started and the train\'s log says so; one rules run in all; 2.95: one rules_ahead event, outcome not-started, with the memory reason (fails before this fix: no check ahead existed)', () => [
      r1.landed?.join() === 'T-141' && rulesRuns(ctl).length === 1 && outcomes().join() === 'not-started' && /under the 4 GB one rules run takes/.test(evs(/^task\.train\.unity\.rules_ahead$/)[0]?.meta?.why || '') && !aheadFiles().length
        && r1.logs?.some((l) => /the check ahead was not started: free RAM minus the floor is 1 GB with the land run going, under the 4 GB one rules run takes/.test(l)), J({ r1 })]);
  }

  // ================= (e) still running when the next train starts =================
  {
    resetState();
    const E = engineRepo(lanes2);
    const ctl = ctlOf('wait');
    setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { ahead: true })) });
    queue(E, [['T-151', 'feat/a'], ['T-152', 'feat/b']]);
    fs.writeFileSync(`${ctl}-wait`, 'running'); fs.writeFileSync(`${ctl}-waitpid`, '1');
    const r1 = probe(TRAIN, { AHEAD_STUB_MS: '12000' });
    const st = spawnSync(process.execPath, ['harness/unity-train.mjs', 'status'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 60000 });
    const r2 = probe(TRAIN);
    const rr = rulesRuns(ctl);
    await guard('2.94 (e) a check ahead still running when the next train starts, for exactly its tree: train status says "Checking the next batch ahead: T-152", the train waits for it instead of starting the same tests, and the rules command ran twice in all (the batch, the check ahead); T-152 lands (fails before this fix: the tests ran again)', () => [
      r1.landed?.join() === 'T-151' && /Checking the next batch ahead: T-152, since \d+ min/.test(out(st)) && r2.logs?.some((l) => /still runs for this batch's tree: this train waits for it/.test(l))
        && rr.length === 2 && r2.landed?.join() === 'T-152' && r2.rules?.runs === 0 && outcomes().join() === 'started,kept-green', JSON.stringify({ st: out(st).slice(-400), r1l: r1.landed, n: rr.length, ev: outcomes(), r2l: r2.landed, runs: r2.rules?.runs })]);
  }

  // ================= (f) a red ahead hands nobody back =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'Sim/Move.cs': 'class Move { int a; }\n' }, 'feat/bad': { 'Sim/Fees.cs': 'class Fees { BAD }\n' } });
    const ctl = ctlOf('red-ahead');
    setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { ahead: true })) });
    queue(E, [['T-161', 'feat/a'], ['T-162', 'feat/bad']]);
    fs.writeFileSync(`${ctl}-wait`, 'done');
    const r1 = probe(TRAIN);
    const q1 = qTasks();
    const ev1 = outcomes();
    const r2 = probe(TRAIN);
    await guard('2.94 (f) the check ahead is red on T-162: it is kept as a red for that tree and nobody is handed back by it (T-162 stays queued after the first train); the next train judges it as 2.93 does and hands it back with cause rules (fails before this fix: no check ahead existed)', () => [
      r1.landed?.join() === 'T-161' && !r1.handed?.length && !r1.dropped?.length && q1.join() === 'T-162' && ev1.join() === 'started,kept-red'
        && r2.dropped?.map((d) => `${d.task}:${d.cause}`).join() === 'T-162:rules' && rulesRuns(ctl).length === 2, J({ r1, r2, q1, ev1 })]);
  }

  // ================= (g) train cancel =================
  {
    resetState();
    const E = engineRepo(lanes2);
    const ctl = ctlOf('cancel');
    setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { ahead: true })) });
    queue(E, [['T-171', 'feat/a'], ['T-172', 'feat/b']]);
    fs.writeFileSync(`${ctl}-wait`, 'running'); fs.writeFileSync(`${ctl}-waitpid`, '1'); fs.writeFileSync(`${ctl}-hang`, '1');
    const pf = probeFile(TRAIN);
    const child = spawn(process.execPath, [pf], { windowsHide: true, cwd: S, env: envOf({ AHEAD_STUB_MS: '120000' }), stdio: 'ignore' });
    let started = null;
    for (let i = 0; i < 450 && !started; i++) { await new Promise((r) => { setTimeout(r, 200); }); started = readJson(`${ctl}-started`); }
    const seen = readJson(`${ctl}-seen.json`) || {};
    const stubPid = Number(fs.existsSync(`${ctl}-ahead-pid`) ? fs.readFileSync(`${ctl}-ahead-pid`, 'utf8') : 0);
    const c = spawnSync(process.execPath, ['harness/task.mjs', 'train', 'cancel', '--engine', 'unity', '--by', 'overseer', '--why', 'a test'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 120000 });
    const ended = await gone([seen.pid, stubPid].filter(Boolean));
    const trainGone = await gone([child.pid]);
    try { if (started?.pid && alive(started.pid)) process.kill(started.pid); } catch { /* started by this test */ }
    try { if (!trainGone) child.kill(); } catch { /* started by this test */ }
    try { fs.rmSync(pf, { force: true }); } catch { /* left for the sweep */ }
    await guard('2.94 (g) train cancel while the check ahead runs: the check ahead is ended with its process tree (the child and its rules command are gone), its files are removed and the event says dropped (fails before this fix: no check ahead existed)', () => [
      Boolean(started) && seen.state === 'running' && stubPid > 0 && ended && trainGone && !aheadFiles().length && outcomes().join() === 'started,dropped', J({ started, seen, stubPid, ended, trainGone, c: out(c).slice(-600), ev: outcomes() })]);
  }
  try { fs.rmSync(S, { recursive: true, force: true }); fs.rmSync(T, { recursive: true, force: true }); } catch { /* the sweep takes it */ }
}
