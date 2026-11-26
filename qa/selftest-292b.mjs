/**
 * qa/selftest-292b.mjs — 2.92: when the target is red by itself, one task to fix it, once per distinct red. The rules check
 * on a red target, the daily full land run and the owed full rules run each file one engine-porter task through
 * harness/engine-target-red.mjs; the same red files nothing more; a green target or a closed task starts over.
 * The studio copy and the stand-ins for the land script and the rules check are qa/selftest-291a.mjs's, cut down.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, eventTypesOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, queueUnityOf, writeIn as write } from './kit.mjs'

export async function selftest292B({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s292b-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-292b-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  const S = path.join(tmpRoot, `292b-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json', 'studio/handoffs']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-292b.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventTypesOf(eventsFileOf(evFile));
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-292b-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'comm', 'gates', 'tmp', 'locks']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true }); fs.writeFileSync(evFile, ''); };
  const nextFile = path.join(S, 'studio', 'NEXT.md');
  const board = () => fs.readFileSync(nextFile, 'utf8').replace(/\r\n/g, '\n');
  const redTasks = () => board().split('\n').filter((l) => /Fix: \S+ is red by itself/.test(l));
  const recOf = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'engine', 'unity-target-red.json'), 'utf8')).reds; } catch { return []; } };
  const idOf = (line) => /\*\*([A-Z]+-\d+)\*\*/.exec(line || '')?.[1];

  let rn = 0;
  const engineRepo = (lanes, { pinBad = false } = {}) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    for (const [f, t] of Object.entries({ 'Sim/Move.cs': 'class Move { }\n', 'pins/web.json': '{ "commit": "c0ffee1" }\n', 'vectors/pin.txt': pinBad ? 'beef000\n' : 'c0ffee1\n' })) write(R, f, t);
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
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const E = process.env;
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
for (const s of srcs) git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s);
if (E.STUDIO_LAND_FULL === '1' && fs.existsSync(ctl + '-fullred')) {
  git(gw, 'reset', '-q', '--hard', before);
  if (E.STUDIO_LAND_RESULT) fs.writeFileSync(E.STUDIO_LAND_RESULT, JSON.stringify({ gates: { merge: { status: 'pass', seconds: 1 }, edit: { status: 'fail', seconds: 1 } } }));
  for (const n of fs.readFileSync(ctl + '-fullred', 'utf8').trim().split(';')) console.log('  Failed ' + n + ' [3 ms]');
  process.exit(1);
}
if (E.STUDIO_LAND_PROBE === '1') git(gw, 'reset', '-q', '--hard', before);
console.log('landed ' + srcs.join(' '));
`);
  const rulesStub = path.join(T, 'rules-stub.mjs');
  fs.writeFileSync(rulesStub, `import fs from 'node:fs'; import path from 'node:path';
const cwd = process.cwd();
const rd = (f) => fs.readFileSync(path.join(cwd, f), 'utf8');
const ok = rd('pins/web.json').includes(rd('vectors/pin.txt').trim());
console.log('  ' + (ok ? 'Passed' : 'Failed') + ' Game.Rules.Tests.PinTests.VectorsMatchPin [3 ms]');
console.log('  Passed Game.Rules.Tests.MoveTests.Walks [3 ms]');
if (!ok) { console.log('Failed!  - Failed: 1, Passed: 1'); process.exit(1); }
console.log('Passed!  - Failed: 0, Passed: 2');
`);
  const cfgFor = (E, ctl, extra = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, rules: { test: `node "${fwd(rulesStub)}"` }, ...extra });
  const queue = queueUnityOf(S);
  const TRAIN = `import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const r = await runUnityTrain({ root: process.cwd(), log: () => {}, deps: { handBack: () => {} } });
console.log(JSON.stringify({ landed: r.landed, dropped: r.dropped, rules: r.rules || null, full: r.full || null }));`;
  const call = (o, env = {}) => probe(`import { targetRedTask } from ${u('harness/engine-target-red.mjs')};\nconsole.log(JSON.stringify({ r: targetRedTask(process.cwd(), ${JSON.stringify({ engine: 'unity', target: 'port/main', train: 'u-9', ...o })}) }));`, env);
  const clear = (source) => probe(`import { targetRedClear } from ${u('harness/engine-target-red.mjs')};\ntargetRedClear(process.cwd(), 'unity', ${JSON.stringify(source)});\nconsole.log('{}');`);
  const A = 'Game.Sim.Tests.AddsUp', B = 'Game.Sim.Tests.TakesAway', C = 'Game.Sim.Tests.Scales', D = 'Game.Sim.Tests.Rounds', X = 'Game.Sim.Tests.Other';
  const warn = () => evs(/^task\.train\.unity\.target_red_task$/);

  // ---- 1. a train whose rules check is red on the target ----
  resetState();
  const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n' } }, { pinBad: true });
  const ctl = path.join(T, 'ctl-1');
  setEngines({ unity: cfgFor(E, ctl) });
  queue(E, [['T-001', 'feat/a']]);
  const r1 = probe(TRAIN);
  const t1 = redTasks();
  await guard('2.92 a rules check red on the target files exactly one task: engine-porter, P1, track engine:unity, a "Fix:" title naming the target, the count and the first failing test, one warn event, the record holds it, and the train still landed its lane (fails before this fix: nobody was asked to fix the target)', () => [
    r1.rules?.skipped && r1.landed?.join() === 'T-001' && t1.length === 1 && /\[P1\] \(`engine-porter`\)/.test(t1[0]) && t1[0].includes('Fix: port/main is red by itself on 1 rule test(s): Game.Rules.Tests.PinTests.VectorsMatchPin')
      && warn().length === 1 && warn()[0].status === 'warn' && recOf().length === 1 && recOf()[0].task === idOf(t1[0]) && recOf()[0].source === 'rules'
      && fs.readFileSync(path.join(S, 'studio', 'handoffs', `${idOf(t1[0])}.md`), 'utf8').includes('PinTests.VectorsMatchPin'),
    JSON.stringify({ r1, t1, rec: recOf(), w: warn().map((e) => e.msg) }).slice(0, 2500)]);
  queue(E, [['T-002', 'feat/b']]);
  const r2 = probe(TRAIN);
  await guard('2.92 the same red in the next train files nothing more: still one task on the board and one event (fails before this fix: no task at all; a naive fix would file one per train)', () => [
    r2.landed?.join() === 'T-002' && redTasks().length === 1 && warn().length === 1,
    JSON.stringify({ r2, t: redTasks(), n: warn().length }).slice(0, 1500)]);
  const st = out(spawnSync(process.execPath, [path.join(S, 'harness', 'task.mjs'), 'train', 'status', '--engine', 'unity'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 120000 }));
  await guard('2.92 train status prints one line "Target red: T-xxx (1 test(s), since <time>)" while the task is open (fails before this fix: no such line)', () => [
    new RegExp(`^Target red: ${idOf(redTasks()[0])} \\(1 test\\(s\\), since \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d\\)$`, 'm').test(st),
    st.slice(-1200)]);

  // ---- 2. the module's own rules ----
  resetState(); fs.rmSync(path.join(S, 'studio', 'handoffs'), { recursive: true, force: true });
  const base0 = redTasks().length;
  call({ source: 'rules', tests: [A, B] });
  const first = redTasks().at(-1);
  await guard('2.92 a red naming two tests files one task whose title counts them (fails before this fix: no task)', () => [
    redTasks().length === base0 + 1 && /on 2 rule test\(s\): Game\.Sim\.Tests\.AddsUp/.test(first) && recOf().length === 1,
    JSON.stringify({ first, rec: recOf() })]);
  call({ source: 'rules', tests: [X] });
  await guard('2.92 a different red files a second task and a second record (fails before this fix: one red hid every later one)', () => [
    redTasks().length === base0 + 2 && recOf().length === 2, JSON.stringify(recOf())]);
  call({ source: 'full-land', tests: [A, B, C, D] });
  call({ source: 'rules', tests: [A] });
  await guard('2.92 a longer list and a shorter list that overlap an open red by half or more are the same red: no task is added and the record keeps the newer list (fails before this fix: every changed list filed a task)', () => [
    redTasks().length === base0 + 2 && recOf().find((x) => x.source === 'rules' && x.task === idOf(first))?.tests.join() === [A].join() && recOf().length === 2,
    JSON.stringify(recOf())]);
  // The first task is finished (marked done), the other dropped (its line is gone): the same reds file new tasks.
  const second = redTasks().at(-1);
  fs.writeFileSync(nextFile, board().split('\n').filter((l) => l !== second && l !== first).join('\n'));
  fs.appendFileSync(path.join(S, 'studio', 'DONE.md'), `${first.replace('- [ ]', '- [x]')}\n`);
  const nBefore = redTasks().length;
  const cA = call({ source: 'rules', tests: [A, B] });
  const cX = call({ source: 'rules', tests: [X] });
  await guard('2.92 a task that is done or dropped is no longer open: the red seen again files a new task for each (fails before this fix: no task)', () => [
    redTasks().length === nBefore + 2 && !recOf().some((x) => [idOf(first), idOf(second)].includes(x.task)),
    JSON.stringify({ cA: cA.r || cA._raw, cX: cX.r || cX._raw,  rec: recOf().length, t: redTasks().map((l) => l.slice(0, 16)) })]);
  const open = recOf().length;
  clear('rules');
  call({ source: 'rules', tests: [A, B] });
  await guard('2.92 a green target clears that source\'s records and closes no task: the same red afterwards is recorded again against the task still open for it (the board does not queue the same title twice), and files a new task only once that is closed (fails before this fix: no record to clear)', () => [
    open === 2 && recOf().length === 1 && redTasks().length === nBefore + 2,
    JSON.stringify({ rec: recOf(), t: redTasks().length })]);
  const n0 = redTasks().length;
  call({ source: 'rules', tests: ['Game.Sim.Tests.Quiet'] }, { STUDIO_ENGINE_TARGET_RED_TASK: 'off' });
  await guard('2.92 STUDIO_ENGINE_TARGET_RED_TASK=off files nothing and says nothing (fails before this fix: no setting)', () => [
    redTasks().length === n0 && !recOf().some((x) => x.tests.includes('Game.Sim.Tests.Quiet')), JSON.stringify(recOf())]);
  const w0 = warn().length;
  const bad = call({ source: 'rules', tests: ['Game.Sim.Tests.NoAdd'] }, { STUDIO_ROLE: 'builder' });
  await guard('2.92 a task the board will not take is one warn event saying so, no record, and no throw (fails before this fix: no event)', () => [
    bad.r === null && redTasks().length === n0 && warn().length === w0 + 1 && warn().at(-1).status === 'warn' && /no fix task was filed/.test(warn().at(-1).msg) && !recOf().some((x) => x.tests.includes('Game.Sim.Tests.NoAdd')),
    JSON.stringify({ bad, w: warn().at(-1)?.msg })]);
  resetState();
  call({ source: 'rules', tests: [], why: 'the rules check failed (exit 1)\nsecond line' });
  call({ source: 'rules', tests: [], why: 'the rules check failed (exit 1)\nsecond line' });
  await guard('2.92 a red with no test names is keyed by its source and the first line of why: one task titled "the rules check fails to build", not two', () => [
    redTasks().length >= 1 && redTasks().filter((l) => l.includes('the rules check fails to build')).length === 1 && recOf().length === 1,
    JSON.stringify({ rec: recOf() })]);

  // ---- 3. the daily full land run and the owed full rules run ----
  resetState();
  const E3 = engineRepo({});
  const ctl3 = path.join(T, 'ctl-3');
  fs.writeFileSync(`${ctl3}-fullred`, `${C};${D}`);
  setEngines({ unity: cfgFor(E3, ctl3, { rules: false }) });
  fs.mkdirSync(path.join(S, '.studio', 'engine'), { recursive: true });
  fs.writeFileSync(path.join(S, '.studio', 'engine', 'unity-full-land.json'), JSON.stringify({ at: new Date(Date.now() - 60 * 3600000).toISOString(), id: 'old' }));
  const before3 = redTasks().length;
  const r3 = probe(TRAIN, { STUDIO_ENGINE_FULL_LAND_HOURS: '24' });
  const t3 = redTasks().slice(before3);
  await guard('2.92 the daily full land run red on the target alone files one task naming its tests, source full-land (fails before this fix: the director was told but no task was filed)', () => [
    t3.length === 1 && t3[0].includes(`on 2 rule test(s): ${D}`) && recOf().length === 1 && recOf()[0].source === 'full-land' && warn().length === 1,
    JSON.stringify({ r3, t3, rec: recOf() }).slice(0, 2000)]);
  fs.rmSync(`${ctl3}-fullred`, { force: true });
  fs.writeFileSync(path.join(S, '.studio', 'engine', 'unity-full-land.json'), JSON.stringify({ at: new Date(Date.now() - 60 * 3600000).toISOString(), id: 'old' }));
  probe(TRAIN, { STUDIO_ENGINE_FULL_LAND_HOURS: '24' });
  await guard('2.92 the full land run green again clears the full-land record (fails before this fix: no record)', () => [recOf().length === 0, JSON.stringify(recOf())]);
  const E4 = engineRepo({}, { pinBad: true });
  const ctl4 = path.join(T, 'ctl-4');
  setEngines({ unity: cfgFor(E4, ctl4) });
  const FULL = `import { fullRulesRun, rulesConfig } from ${u('harness/engine-rules.mjs')};
import { spawnSync } from 'node:child_process';
const repo = ${JSON.stringify(E4.R)};
const tip = spawnSync('git', ['rev-parse', 'port/main'], { cwd: repo, encoding: 'utf8', windowsHide: true }).stdout.trim();
const cfg = rulesConfig('unity', { root: process.cwd(), repo, ref: 'port/main' });
const r = fullRulesRun({ engine: 'unity', repo, tip, cfg, root: process.cwd(), id: 'u-8' });
console.log(JSON.stringify({ status: r.status }));`;
  const f1 = probe(FULL);
  await guard('2.92 the owed full rules run red on the target files one task, source full-rules, naming the failing test (fails before this fix: it was only kept for train status)', () => [
    f1.status === 'red' && recOf().length === 1 && recOf()[0].source === 'full-rules' && recOf()[0].tests.join() === 'Game.Rules.Tests.PinTests.VectorsMatchPin' && idOf(redTasks().find((l) => l.includes('PinTests.VectorsMatchPin'))) === recOf()[0].task,
    JSON.stringify({ f1, rec: recOf() }).slice(0, 1500)]);
  write(E4.GW, 'vectors/pin.txt', 'c0ffee1\n'); g(E4.GW, 'add', '-A'); g(E4.GW, 'commit', '-qm', 'fix pin');
  const f2 = probe(FULL);
  await guard('2.92 the owed full rules run green clears the full-rules record', () => [f2.status === 'pass' && recOf().length === 0, JSON.stringify({ f2, rec: recOf() })]);
  try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep takes it */ }
}
