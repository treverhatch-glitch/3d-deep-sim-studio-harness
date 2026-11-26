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

  // The land script's stand-in: records each run; <ctl>-sleep holds ms to wait first (its pid in <ctl>-pid); with
  // <ctl>-waitdone it waits until the check ahead is done (a condition, never a fixed sleep). Then it merges.
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, green: process.env.STUDIO_RULES_GREEN ?? null }) + '\\n');
if (fs.existsSync(ctl + '-sleep')) { fs.writeFileSync(ctl + '-pid', String(process.pid)); nap(Number(fs.readFileSync(ctl + '-sleep', 'utf8'))); }
if (fs.existsSync(ctl + '-waitdone')) {
  const done = () => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(path.join(S, '.studio', 'engine', 'unity-rules-ahead-out.json'))}, 'utf8')).state === 'done'; } catch { return false; } };
  for (const until = Date.now() + 90000; Date.now() < until && !done(); nap(100));
  fs.rmSync(ctl + '-waitdone', { force: true });
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
console.log(JSON.stringify({ ok: r.ok, id: r.id, landed: r.landed, dropped: r.dropped, batch: r.batch, rules: r.rules || null, logs: logs.filter((l) => /rules|ahead|takes the set|batch|road|shard/.test(l)) }));`;

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
    // No train for this engine (no target): the agent's own run is the verify, so the limit does not apply.
    const { target: _t, ...noTrain } = cfgFor(E, ctl, { agentLandMin: 0.03 });
    setEngines({ unity: noTrain });
    fs.writeFileSync(`${ctl}-sleep`, '4000');
    const solo = probe(GATE('T-121', 'feat/a'), AGENT);
    await guard('2.99 (b1f) an engine with no train (no engines.unity.target): an agent\'s own land run that takes longer than agentLandMin is not cut, because there the agent\'s run is the verify (fails before this fix: a studio that lands without a train had every agent land run over 45 min ended as "not-run")', () => [
      solo.status !== 'not-run' && !/time limit of an agent's own land run/.test(solo.why || ''), J({ solo })]);
    setEngines({ unity: cfgFor(E, ctl, { agentLandMin: 0.03 }) });
    fs.writeFileSync(`${ctl}-sleep`, '3000');
    const person = probe(GATE('T-121', 'feat/a'), PERSON);
    queue(E, [['T-122', 'feat/b']]);
    fs.writeFileSync(`${ctl}-sleep`, '3000');
    const train = probe(TRAIN, AGENT);
    await guard('2.99 (b1e) what is never held back or stopped: a person\'s own land run outlives the agents\' 0.03 min limit and passes; the train\'s own land run, started from a worker session with its lane queued, is neither refused nor stopped and lands T-122 (a guard of what must not change: it holds before and after this fix)', () => [
      person.status === 'pass' && train.landed?.join() === 'T-122', J({ person, train })]);
  }

  // ================= 2: the check ahead and the next batch =================
  const AUTOS = [{ root: 'Sim', paths: ['Sim/{name}/'], filter: 'Cat={name}' }, { from: 'Game/Core/Unit.{name}.cs', paths: ['Game/Core/Unit.{name}.'], filter: 'Core.{name}' }];
  const shardRules = (ctl) => ({ test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" ALL`, ahead: true,
    focus: { test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" "{filter}"`, smoke: 'Smoke', auto: AUTOS, fullEveryHours: 0 },
    shards: { filters: ['Listed'], rest: 'Rest', keep: 'reads' } });
  const wholeRules = (ctl) => ({ test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" ALL`, ahead: true });
  const lanes3 = { 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' }, 'feat/b': { 'Sim/Fees/Fees.cs': 'class Fees { int b; }\n' }, 'feat/c': { 'Game/Core/Unit.Bank.cs': 'class Bank { int c; }\n' } };
  const aheadLast = () => readJson(path.join(S, '.studio', 'engine', 'unity-ahead-last.json')) || {};
  // Train 1 lands T-201 while the check ahead runs T-202 to the end; then T-203 is queued (after the check ahead began).
  const firstTrain = (rules, n) => {
    resetState();
    const E = engineRepo(lanes3);
    const ctl = ctlOf(n);
    setEngines({ unity: cfgFor(E, ctl, { rules: rules(ctl) }) });
    queue(E, [['T-201', 'feat/a'], ['T-202', 'feat/b']]);
    fs.writeFileSync(`${ctl}-waitdone`, '1');
    const r1 = probe(TRAIN);
    const n1 = rulesRuns(ctl).length;
    return { E, ctl, r1, n1, ahead: rulesRuns(ctl).filter((x) => x.ahead).map((x) => x.filter) };
  };
  {
    const { E, ctl, r1, n1, ahead } = firstTrain(shardRules, 'reads');
    queue(E, [['T-202', 'feat/b'], ['T-203', 'feat/c']]);
    setEngines({ unity: cfgFor(E, ctl, { batchMax: 2, rules: shardRules(ctl) }) });
    const r2 = probe(TRAIN);
    const next = rulesRuns(ctl).slice(n1).map((x) => x.filter);
    const last = aheadLast();
    const show = out(spawnSync(process.execPath, ['harness/engine-rules.mjs', 'show', '--engine', 'unity'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 60000 }));
    await guard('2.99 (b2a) check ahead with rules.shards.keep "reads": the next train takes the normal batch (T-202 and T-203, queued after the check ahead began), reuses the shard greens kept from train 1 and from the check ahead (Cat=Move, Cat=Fees) and runs only the others (Smoke, Core.Bank, Listed, Rest); its log and rules show say the check ahead lent 1 shard green (fails before this fix: the train took only T-202, the set checked ahead, and T-203 rode the train after)', () => [
      r1.landed?.join() === 'T-201' && ahead.includes('Cat=Fees') && r2.landed?.join() === 'T-202,T-203' && [...next].sort().join() === ['Core.Bank', 'Listed', 'Rest', 'Smoke'].join()
        && r2.logs?.some((l) => /ran for T-202; the normal pick \(T-202, T-203\) goes: with rules\.shards\.keep "reads"/.test(l)) && r2.logs?.some((l) => /1 shard green\(s\) kept by what they read went to train/.test(l))
        && last.lent?.shards === 1 && last.lent.to === r2.id && /last lent 1 shard green\(s\) to train/.test(show), J({ r1: r1.landed, ahead, next, last, landed: r2.landed, id: r2.id, show: show.slice(-600) })]);
    await guard('2.99 (b2c) what must not happen: the check ahead\'s green is never used for a tree it did not check: only a train of exactly the checked set (T-202) takes its result; a train with T-203 never says its result came from the check ahead, and the shard T-203 changes (Core.Bank) runs again on that new tree (a guard of what must not change: it holds before and after this fix)', () => [
      (r2.landed?.join() === 'T-202' || !r2.logs?.some((l) => /the batch's result came from the check ahead|finished some shards, this train ran the rest/.test(l))) && (!r2.landed?.includes('T-203') || next.includes('Core.Bank')), J({ next, landed: r2.landed })]);
  }
  {
    const { E, ctl, n1 } = firstTrain(wholeRules, 'whole-larger');
    queue(E, [['T-202', 'feat/b'], ['T-203', 'feat/c']]);
    setEngines({ unity: cfgFor(E, ctl, { batchMax: 2, rules: wholeRules(ctl) }) });
    const r2 = probe(TRAIN);
    const next = rulesRuns(ctl).slice(n1);
    const w = firstTrain(wholeRules, 'whole-same');
    queue(w.E, [['T-203', 'feat/c'], ['T-202', 'feat/b']]);
    const r3 = probe(TRAIN);
    const next3 = rulesRuns(w.ctl).slice(w.n1);
    await guard('2.99 (b2b) without reads-keyed shards: a normal pick larger than the set checked ahead goes (T-202, T-203), and its rules check runs on its own tree (one run, not from the check ahead); a normal pick that is not larger (T-203 first, batchMax 1) gives way to the checked set (T-202), which takes the check ahead\'s result and runs no rules test; each log says which road and why (fails before this fix: the checked set was always taken, so the larger batch shrank to T-202)', () => [
      r2.landed?.join() === 'T-202,T-203' && next.length === 1 && !next[0].ahead && r2.logs?.some((l) => /the normal pick \(T-202, T-203\) is larger, so it goes/.test(l)) && !r2.logs?.some((l) => /the batch's result came from the check ahead/.test(l))
        && r3.landed?.join() === 'T-202' && !next3.length && r3.logs?.some((l) => /this train takes that set: the normal pick \(1 lane\(s\)\) is not larger/.test(l)) && r3.logs?.some((l) => /the batch's result came from the check ahead/.test(l)), J({ r2, next, r3, next3 })]);
  }

  try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep takes it */ }
}
