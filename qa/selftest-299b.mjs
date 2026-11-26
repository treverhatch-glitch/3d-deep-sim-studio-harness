/**
 * qa/selftest-299b.mjs — 2.99 (b): an agent's own engine run on the one editor slot, and the check ahead's batch.
 * 1. An agent's own land run of a lane that adds nothing is refused with the train's empty-lane words; an agent's land
 *    or Unity editor run does not start while the engine train runs or lanes wait for it; it stops at its own time limit
 *    (engines.<x>.agentLandMin) with a result that is not red. A person's run and the train's own run are never held back.
 * 2. With rules.shards keep "reads" the next train picks its batch the normal way and reuses the check ahead's shard
 *    greens; without, the checked set only when the normal pick is not larger; a green never answers another tree.
 * Scaffolding as qa/selftest-294a.mjs and 295a.mjs (a studio copy, a made-up engine repo, stand-ins for the scripts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, eventTypesOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, queueUnityOf, readJsonFile as readJson, writeIn as write } from './kit.mjs';

export async function selftest299B({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s299b-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: PowerShell (the process list a train cancel reads) needs Windows' own system variables, which any real shell
  // has; from this cut-down environment it ran into its time limit (P-370). Passed through as they are, as in 284u.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI|AHEAD_)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.5', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_USAGE_FUNCTIONS: 'off', STUDIO_TEST_FREEMEM_MB: '64000',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-299b-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  const AGENT = { STUDIO_ROLE: 'engine-porter', STUDIO_LOCK_OWNER: 'engine-porter-s1' };
  const PERSON = { STUDIO_ROLE: '', STUDIO_LOCK_OWNER: 'overseer' };

  const S = path.join(tmpRoot, `299b-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-299b.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventTypesOf(eventsFileOf(evFile));
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-299b-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'comm', 'gates', 'tmp', 'locks', 'line', 'engine-ram.json']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.writeFileSync(evFile, ''); };
  const J = (x) => JSON.stringify(x).slice(0, 2800);
  const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
  const gone = async (pid) => { for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => { setTimeout(r, 200); }); return !alive(pid); };
  const ctlOf = (n) => path.join(T, `ctl-${n}`);
  const queue = queueUnityOf(S);

  // The engine repo: two system folders, one system named by files, a file no system owns.
  let rn = 0;
  const engineRepo = (lanes) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    for (const [f, t] of Object.entries({ 'Sim/Move/Move.cs': 'class Move { }\n', 'Sim/Fees/Fees.cs': 'class Fees { }\n', 'Game/Core/Unit.Bank.cs': 'class Bank { }\n', 'notes.txt': 'n\n' })) write(R, f, t);
    g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    g(R, 'checkout', '-q', '-b', 'dev');
    g(R, 'worktree', 'add', '-q', GW, 'port/main');
    const heads = {};
    for (const [br, files] of Object.entries(lanes)) {
      g(R, 'checkout', '-q', '-B', br, 'port/main');
      for (const [f, t] of Object.entries(files)) write(R, f, t);
      g(R, 'add', '-A'); g(R, 'commit', '-qm', `${br} work`, '--allow-empty');
      heads[br] = g(R, 'rev-parse', br).stdout.trim();
      g(R, 'checkout', '-q', 'dev');
    }
    return { R, GW, heads };
  };

  // The land script's stand-in: records each run; <ctl>-sleep holds ms to wait first (its pid in <ctl>-pid); <ctl>-wait
  // holds N: it waits until the check ahead has run N rules commands (a condition, never a fixed sleep). Then it merges.
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, green: process.env.STUDIO_RULES_GREEN ?? null }) + '\\n');
if (fs.existsSync(ctl + '-sleep')) { fs.writeFileSync(ctl + '-pid', String(process.pid)); nap(Number(fs.readFileSync(ctl + '-sleep', 'utf8'))); }
if (fs.existsSync(ctl + '-wait')) {
  const want = Number(fs.readFileSync(ctl + '-wait', 'utf8'));
  const n = () => { try { return fs.readFileSync(ctl + '-rules.jsonl', 'utf8').split('\\n').filter((l) => l.includes('"ahead":true')).length; } catch { return 0; } };
  for (const until = Date.now() + 90000; Date.now() < until && n() < want; nap(100));
  fs.rmSync(ctl + '-wait', { force: true });
}
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); process.exit(2); } }
console.log('landed ' + srcs.join(' '));
`);
  // The tests' stand-in: one filter per run (ALL for the whole command); records the run and whether it is the check ahead.
  const rulesStub = path.join(T, 'rules-stub.mjs');
  fs.writeFileSync(rulesStub, `import fs from 'node:fs';
const [ctl, filter = 'ALL'] = process.argv.slice(2);
const ahead = /-ahead-/.test(process.env.STUDIO_RULES_DIR || '');
fs.appendFileSync(ctl + '-rules.jsonl', JSON.stringify({ filter, ahead, commit: process.env.STUDIO_RULES_COMMIT || null }) + '\\n');
console.log('  Passed Game.Rules.Tests.FeesTests.Charges [3 ms]');
`);
  const landRuns = (ctl) => { try { return fs.readFileSync(`${ctl}-runs.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const rulesRuns = (ctl) => { try { return fs.readFileSync(`${ctl}-rules.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const cfgFor = (E, ctl, extra = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, batchMax: 1, ...extra });
  const GATE = (task, branch) => `import { runUnityGate } from ${u('harness/unity-gate.mjs')};
const r = await runUnityGate({ engine: 'unity', task: ${JSON.stringify(task)}, branch: ${JSON.stringify(branch)} });
console.log(JSON.stringify({ status: r.status, ok: r.ok, code: r.code, why: r.why }));`;
  const TRAIN = `import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const logs = [];
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps: { handBack: () => {} } });
console.log(JSON.stringify({ ok: r.ok, landed: r.landed, dropped: r.dropped, batch: r.batch, rules: r.rules || null, logs: logs.filter((l) => /rules|ahead|takes the set|batch|road|shard/.test(l)) }));`;

  // ================= 1 (a) an empty lane =================
  {
    resetState();
    const E = engineRepo({ 'feat/empty': {}, 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' } });
    const ctl = ctlOf('empty');
    setEngines({ unity: cfgFor(E, ctl) });
    const r = probe(GATE('T-101', 'feat/empty'), AGENT);
    const land = evs(/^engine\.land$/).pop() || {};
    await guard('2.99 (b1a) an agent\'s own land run of a lane whose tree adds nothing over the target is refused with the train\'s words ("empty lane: nothing to land") and what to do instead, not red (refused, exit 3), and the land command never ran (fails before this fix: the agent\'s run held the only engine slot for the whole land command, landing nothing)', () => [
      r.status === 'refused' && r.code === 3 && /^empty lane: nothing to land \(its tree adds nothing over port\/main\): feat\/empty changes no file/.test(r.why || '') && /npm run engine -- check --task T-101, then npm run task -- done T-101 --train/.test(r.why) && !landRuns(ctl).length && land.status === 'warn', J({ r, land })]);
  }

  // ================= 1 (b) the train goes first =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' }, 'feat/b': { 'notes.txt': 'n2\n' } });
    const ctl = ctlOf('first');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-112', 'feat/b']]);
    const agent = probe(GATE('T-111', 'feat/a'), AGENT);
    const n0 = landRuns(ctl).length;
    const editor = probe(`import { acquireHeavy } from ${u('harness/heavy.mjs')};
try { acquireHeavy(process.cwd(), 'unity gate EditMode (engine/x)', { kind: 'unity' }); console.log(JSON.stringify({ took: true })); } catch (e) { console.log(JSON.stringify({ code: e.code, trainFirst: Boolean(e.trainFirst), msg: e.message })); }`, AGENT);
    const person = probe(GATE('T-111', 'feat/a'), PERSON);
    await guard('2.99 (b1b) while a lane waits for the engine train, an agent\'s own land run and its Unity editor run (machine:heavy kind unity, as node harness/unity.mjs gate takes it) do not start: refused, not red, with "the train goes first" and the instruction (check --task, then task done --train); a person\'s own run with the same queue runs and passes (fails before this fix: the agent\'s run started and the train waited for it)', () => [
      agent.status === 'refused' && /1 lane\(s\) wait for the unity train: the train goes first\. The train is the real verify: run npm run engine -- check --task T-111, then npm run task -- done T-111 --train/.test(agent.why || '') && n0 === 0
        && editor.code === 'HEAVY_BUSY' && editor.trainFirst && /the train goes first/.test(editor.msg) && person.status === 'pass' && landRuns(ctl).length === 1, J({ agent, editor, person })]);
    resetState();
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
    fs.mkdirSync(path.join(S, '.studio', 'locks'), { recursive: true });
    fs.writeFileSync(path.join(S, '.studio', 'locks', 'unity-train.lock'), JSON.stringify({ pid: sleeper.pid, at: Date.now(), id: '20261126-000000-1', by: 'line-producer' }));
    const busy = probe(GATE('T-112', 'feat/b'), AGENT);
    try { sleeper.kill(); } catch { /* started here */ }
    const ended = await gone(sleeper.pid);
    await guard('2.99 (b1c) while an engine train runs (its lock held by a live process) and no lane is queued, an agent\'s own land run is refused with the train named; the stand-in train process is gone after (fails before this fix: the run waited for the slot and took it between the train\'s runs)', () => [
      busy.status === 'refused' && /the unity train 20261126-000000-1 runs: the train goes first/.test(busy.why || '') && landRuns(ctl).length === 1 && ended, J({ busy, ended })]);
  }

  // ================= 1 (c) the agent's own time limit; (d) never the train's or a person's run =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' }, 'feat/b': { 'notes.txt': 'n2\n' } });
    const ctl = ctlOf('limit');
    setEngines({ unity: cfgFor(E, ctl, { agentLandMin: 0.03 }) });
    fs.writeFileSync(`${ctl}-sleep`, '60000');
    const r = probe(GATE('T-121', 'feat/a'), AGENT);
    const pid = Number(fs.readFileSync(`${ctl}-pid`, 'utf8'));
    const ended = await gone(pid);
    const land = evs(/^engine\.land$/).pop() || {};
    await guard('2.99 (b1d) an agent\'s own land run stops at engines.unity.agentLandMin (0.03 min here): "not-run", not red, saying it is not a failure of the work and that the train is the real verify; the engine.land event is a warning and the land command\'s process is gone (by pid) (fails before this fix: the run held the slot up to the land run\'s own 120 min)', () => [
      r.status === 'not-run' && r.code === null && /^stopped at the time limit of an agent's own land run \(0\.03 min, engines\.unity\.agentLandMin\): not a failure of your work\. The train is the real verify/.test(r.why || '') && ended && land.status === 'warn' && land.meta?.status === 'not-run', J({ r, pid, ended, land })]);
    fs.writeFileSync(`${ctl}-sleep`, '3000');
    const person = probe(GATE('T-121', 'feat/a'), PERSON);
    queue(E, [['T-122', 'feat/b']]);
    fs.writeFileSync(`${ctl}-sleep`, '3000');
    const train = probe(TRAIN, AGENT);
    await guard('2.99 (b1e) what is never held back or stopped: a person\'s own land run outlives the agents\' 0.03 min limit and passes; the train\'s own land run, started from a worker session with its lane queued, is neither refused nor stopped and lands T-122 (a guard of what must not change: it holds before and after this fix)', () => [
      person.status === 'pass' && train.landed?.join() === 'T-122', J({ person, train })]);
  }

  try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep takes it */ }
}
