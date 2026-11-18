/**
 * qa/selftest-293a.mjs — 2.93: the rules check runs the batch first and asks the target only for a red; a landed tree keeps
 * its green for the next train (the checked full green, or the land run's own rules gate, rules.landGate); a kept full
 * green answers a focus question; a rules run outside the train never turns full because the hours are due, and waits
 * while an engine land is queued. The time limit still learns from the batch and doubles after a timeout.
 *
 * The scaffolding (a studio copy, a made-up engine repo, stand-ins for the land script and the rules check that record
 * what they were told) is qa/selftest-291a.mjs's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, eventTypesOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, queueUnityOf, readRunsJsonl as runsOf, writeIn as write } from './kit.mjs';

export async function selftest293A({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s293a-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_USAGE_FUNCTIONS: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-293a-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file, engine settings) ----
  const S = path.join(tmpRoot, `293a-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-293a.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventTypesOf(eventsFileOf(evFile));
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-293a-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'comm', 'gates', 'tmp', 'locks', 'line']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true }); fs.writeFileSync(evFile, ''); };

  // ---- a made-up engine repo: two systems, the pin file and the vectors recorded at it ----
  let rn = 0;
  const engineRepo = (lanes, { pinBad = false } = {}) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    for (const [f, t] of Object.entries({ 'Sim/Move.cs': 'class Move { }\n', 'Sim/Fees.cs': 'class Fees { }\n', 'pins/web.json': '{ "commit": "c0ffee1" }\n', 'vectors/pin.txt': pinBad ? 'beef000\n' : 'c0ffee1\n', 'notes.txt': 'n\n' })) write(R, f, t);
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
  const tipOf = (E) => g(E.R, 'rev-parse', 'port/main').stdout.trim();

  // The land script's stand-in: merges the branches; <ctl>-refuse: exits 3 (refused, the lanes stay queued). It writes the
  // result file with its own copy of the rules tests as the gate "dotnet": skipped when told a full green, else pass.
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const E = process.env;
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
process.on('exit', () => fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, probe: E.STUDIO_LAND_PROBE ?? null, rulesGreen: E.STUDIO_RULES_GREEN ?? null, rulesMode: E.STUDIO_RULES_MODE ?? null, before }) + '\\n'));
if (fs.existsSync(ctl + '-refuse')) { console.log('refused'); process.exit(3); }
const told = E.STUDIO_RULES_GREEN === '1' && (E.STUDIO_RULES_MODE === 'full' || fs.existsSync(ctl + '-skip'));
if (E.STUDIO_LAND_RESULT) fs.writeFileSync(E.STUDIO_LAND_RESULT, JSON.stringify({ gates: { merge: { status: 'pass', seconds: 1 }, dotnet: { status: told ? 'skipped' : 'pass', seconds: told ? 0 : 40 } } }));
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); process.exit(2); } }
if (E.STUDIO_LAND_PROBE === '1') { git(gw, 'reset', '-q', '--hard', before); process.exit(0); }
console.log('landed ' + srcs.join(' '));
`);
  // The rules check's stand-in (dotnet test): "--filter X" runs the tests whose name holds X; it records each run.
  const rulesStub = path.join(T, 'rules-stub.mjs');
  fs.writeFileSync(rulesStub, `import fs from 'node:fs'; import path from 'node:path';
const [ctl, ...args] = process.argv.slice(2);
const fi = args.indexOf('--filter'); const filter = fi >= 0 ? args[fi + 1] : '';
const rd = (f) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
fs.appendFileSync(ctl + '-rules.jsonl', JSON.stringify({ filter, mode: process.env.STUDIO_RULES_MODE || null, commit: process.env.STUDIO_RULES_COMMIT || null, at: Date.now() }) + '\\n');
if (Number(process.env.RULES_STUB_MS) > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.RULES_STUB_MS));
const tests = [['Game.Rules.Tests.PinTests.VectorsMatchPin', rd('pins/web.json').includes(rd('vectors/pin.txt').trim())], ['Game.Rules.Tests.MoveTests.Walks', true], ['Game.Rules.Tests.FeesTests.Charges', !rd('Sim/Fees.cs').includes('BAD')]].filter(([n]) => !filter || n.includes(filter));
const bad = tests.filter(([, ok]) => !ok);
for (const [n, ok] of tests) console.log('  ' + (ok ? 'Passed' : 'Failed') + ' ' + n + ' [3 ms]');
if (bad.length) { console.log('Failed!  - Failed: ' + bad.length + ', Passed: ' + (tests.length - bad.length)); process.exit(1); }
console.log('Passed!  - Failed: 0, Passed: ' + tests.length);
`);
  const cfgFor = (E, ctl, extra = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, rules: false, ...extra });
  const fullRules = (ctl, extra = {}) => ({ test: `node "${fwd(rulesStub)}" "${fwd(ctl)}"`, ...extra });
  const focusRules = (ctl, extra = {}) => ({ test: `node "${fwd(rulesStub)}" "${fwd(ctl)}"`, focus: { test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" --filter "{filter}"`, map: [{ match: '^Sim/([A-Za-z]+)\\.cs$', filter: '$1Tests' }], fullEveryHours: 24 }, ...extra });
  const rulesRuns = (ctl) => { try { return fs.readFileSync(`${ctl}-rules.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const queue = queueUnityOf(S);
  const engineDir = path.join(S, '.studio', 'engine');
  const cacheOf = () => { try { return JSON.parse(fs.readFileSync(path.join(engineDir, 'unity-rules.json'), 'utf8')); } catch { return {}; } };
  const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const lastFull = (h) => { fs.mkdirSync(engineDir, { recursive: true }); fs.writeFileSync(path.join(engineDir, 'unity-rules.json'), JSON.stringify({ trees: {}, runs: [], lastFullAt: hoursAgo(h) })); };
  const fresh = () => Date.now() - Date.parse(cacheOf().lastFullAt || 0) < 600000;
  const TRAIN = `import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const handed = []; const logs = [];
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps: { handBack: (lane, note, extra) => handed.push({ task: lane.task, note, extra: extra || null }) } });
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, landed: r.landed, dropped: r.dropped, deferred: r.deferred, handed, rules: r.rules || null, logs: logs.filter((l) => /rules|green|kept|full/.test(l)) }));`;
  const cli = (args, env = {}) => spawnSync(process.execPath, [path.join(S, 'harness', 'engine-rules.mjs'), ...args], { windowsHide: true, cwd: S, env: envOf(env), encoding: 'utf8', timeout: 120000 });
  const J = (x) => JSON.stringify(x).slice(0, 2800);

  // ================= 1. the batch first =================
  {
    resetState();
    const E = engineRepo({ 'feat/m': { 'Sim/Move.cs': 'class Move { int x; }\n' } });
    const ctl = path.join(T, 'ctl-green');
    setEngines({ unity: cfgFor(E, ctl, { rules: focusRules(ctl) }) });
    lastFull(2);
    const tip0 = tipOf(E);
    queue(E, [['T-001', 'feat/m']]);
    const r = probe(TRAIN);
    const rr = rulesRuns(ctl);
    await guard('2.93 a green batch runs nothing on the target: one rules run (MoveTests on the batch head, not the target), the lane lands told green (fails before this fix: the target ran first, two runs for one answer)', () => [
      rr.length === 1 && rr[0].commit !== tip0 && rr[0].filter === 'MoveTests' && r.rules?.runs === 1 && r.landed?.join() === 'T-001' && runsOf(ctl)[0]?.rulesGreen === '1', J({ r, rr, tip0 })]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/ok': { 'notes.txt': 'n2\n' }, 'feat/pin': { 'vectors/pin.txt': 'beef000\n' } });
    const ctl = path.join(T, 'ctl-red');
    setEngines({ unity: cfgFor(E, ctl, { rules: fullRules(ctl) }) });
    const tip0 = tipOf(E);
    queue(E, [['T-011', 'feat/ok'], ['T-012', 'feat/pin']]);
    const r = probe(TRAIN);
    const rr = rulesRuns(ctl);
    await guard('2.93 a red batch with no kept target result: the batch runs first (red), then the target (green), then the prefix narrows it as before: T-012 is handed back with cause rules and the failing test, T-011 lands (fails before this fix: the target ran first, before the batch)', () => [
      rr.length === 3 && rr[0].commit !== tip0 && rr[1].commit === tip0 && rr[2].commit !== tip0 && r.dropped?.map((d) => `${d.task}:${d.cause}`).join() === 'T-012:rules'
        && /PinTests/.test(r.handed?.[0]?.note || '') && r.landed?.join() === 'T-011', J({ r, rr, tip0 })]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/m': { 'Sim/Move.cs': 'class Move { int x; }\n' } }, { pinBad: true });
    const ctl = path.join(T, 'ctl-target-red');
    setEngines({ unity: cfgFor(E, ctl, { rules: fullRules(ctl) }) });
    const tip0 = tipOf(E);
    queue(E, [['T-021', 'feat/m']]);
    const r = probe(TRAIN);
    const rr = rulesRuns(ctl);
    const tr = evs(/^task\.train\.unity\.target_red_task$/);
    const nj = evs(/^task\.train\.unity\.rules_no_judge$/);
    await guard('2.93 a red batch on a red target: the batch runs, then the target (red too): the check judges no lane (rules_no_judge), nobody is handed back, the lane goes to the land run, and the 2.92 fix task for the target is filed (fails before this fix: the order was the target first)', () => [
      rr.length === 2 && rr[0].commit !== tip0 && rr[1].commit === tip0 && r.rules?.skipped && !r.handed?.length && r.landed?.join() === 'T-021' && nj.length === 1 && tr.length === 1 && cacheOf().noJudge?.n === 1,
      J({ r, rr, tr: tr.map((e) => e.msg), nj: nj.map((e) => e.msg) })]);
  }

  // ================= 2. a kept green for the landed tree =================
  {
    resetState();
    const E = engineRepo({ 'feat/m': { 'Sim/Move.cs': 'class Move { int x; }\n' }, 'feat/pin': { 'vectors/pin.txt': 'beef000\n' } });
    const ctl = path.join(T, 'ctl-told');
    setEngines({ unity: cfgFor(E, ctl, { rules: fullRules(ctl) }) });
    queue(E, [['T-031', 'feat/m']]);
    const r1 = probe(TRAIN);
    const t1 = tipOf(E);
    const n1 = rulesRuns(ctl).length;
    queue(E, [['T-032', 'feat/pin']]);
    const r2 = probe(TRAIN);
    const rr = rulesRuns(ctl).slice(n1);
    await guard('2.93 a landing told green (the land script skipped its own rules gate) lands exactly the checked full green: the train says it is the full pass of the new target, and the next train\'s red batch takes the target\'s answer from that kept result: one rules run (the batch), none on the target, T-032 handed back (fails before this fix: no line said the landed tree was answered)', () => [
      r1.landed?.join() === 'T-031' && runsOf(ctl)[0]?.rulesGreen === '1' && r1.logs?.some((l) => l.includes(`the checked full rules pass landed unchanged: it is the full pass of ${t1.slice(0, 8)}`))
        && rr.length === 1 && rr[0].commit !== t1 && r2.logs?.some((l) => l.includes(`rules pass cached for ${t1.slice(0, 10)}`)) && r2.dropped?.map((d) => d.task).join() === 'T-032',
      J({ r1: r1.logs, r2, rr, t1 })]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/m': { 'Sim/Move.cs': 'class Move { int x; }\n' }, 'feat/f': { 'Sim/Fees.cs': 'class Fees { BAD }\n' } });
    const ctl = path.join(T, 'ctl-gate');
    setEngines({ unity: cfgFor(E, ctl, { rules: focusRules(ctl, { landGate: 'dotnet' }) }) });
    lastFull(2);
    const at0 = cacheOf().lastFullAt;
    queue(E, [['T-041', 'feat/m']]);
    const r1 = probe(TRAIN);
    const t1 = tipOf(E);
    const landKept = Object.values(cacheOf().trees || {}).filter((x) => x.land);
    await guard('2.93 rules.landGate "dotnet": a focus green lands, the land script runs its own rules tests (its gate passed), so the landed tree gets a kept full pass and lastFullAt is written, said in one log line (fails before this fix: the next train ran the target again)', () => [
      r1.landed?.join() === 'T-041' && runsOf(ctl)[0]?.rulesMode === 'focus' && landKept.length === 1 && landKept[0].mode === 'full' && cacheOf().lastFullAt !== at0 && fresh()
        && r1.logs?.some((l) => l.includes(`the land run's dotnet gate passed: kept as a full rules pass of ${t1.slice(0, 8)}`)), J({ r1, landKept })]);
    const n1 = rulesRuns(ctl).length;
    queue(E, [['T-042', 'feat/f']]);
    const r2 = probe(TRAIN);
    const rr = rulesRuns(ctl).slice(n1);
    await guard('2.93 a kept full pass answers a focus question: the next batch is red on FeesTests (focus), and the target\'s FeesTests answer comes from the kept full pass of its tree: one rules run (the batch), T-042 handed back (fails before this fix: a focus key never found a full result, the target ran FeesTests)', () => [
      rr.length === 1 && rr[0].filter === 'FeesTests' && rr[0].commit !== t1 && r2.dropped?.map((d) => d.task).join() === 'T-042' && r2.logs?.some((l) => l.includes(`cached for ${t1.slice(0, 10)}`)), J({ r2, rr })]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/m': { 'Sim/Move.cs': 'class Move { int x; }\n' } });
    const ctl = path.join(T, 'ctl-skip');
    setEngines({ unity: cfgFor(E, ctl, { rules: focusRules(ctl, { landGate: 'dotnet' }) }) });
    fs.writeFileSync(`${ctl}-skip`, '1');
    lastFull(2);
    const at0 = cacheOf().lastFullAt;
    queue(E, [['T-051', 'feat/m']]);
    const r = probe(TRAIN);
    await guard('2.93 rules.landGate skipped (the land script trusted the focus green): nothing is recorded for the landed tree and lastFullAt stays (as before this fix: the contrast)', () => [
      r.landed?.join() === 'T-051' && !Object.values(cacheOf().trees || {}).some((x) => x.land) && cacheOf().lastFullAt === at0 && !r.logs?.some((l) => /gate passed: kept/.test(l)), J({ r, c: cacheOf() })]);
  }

  // ================= 3. rules runs outside the train =================
  {
    resetState();
    const E = engineRepo({ 'feat/m': { 'Sim/Move.cs': 'class Move { int x; }\n' } });
    const ctl = path.join(T, 'ctl-cli');
    setEngines({ unity: cfgFor(E, ctl, { rules: focusRules(ctl) }) });
    lastFull(30);
    const a = cli(['--ref', 'feat/m']);
    const b = cli(['--ref', 'feat/m', '--full']);
    const rr = rulesRuns(ctl);
    await guard('2.93 a rules check outside the train (engine-rules --ref) with the full run due (30 h, fullEveryHours 24) runs the focus filter the branch maps to, not the full suite; with --full it is the full suite (fails before this fix: the hours made a person\'s check the full suite)', () => [
      a.status === 0 && b.status === 0 && rr.length === 2 && rr[0].mode === 'focus' && rr[0].filter === 'MoveTests' && rr[1].mode === 'full' && rr[1].filter === '', J({ rr, a: out(a).slice(-600) })]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/m': { 'Sim/Move.cs': 'class Move { int x; }\n' } });
    const ctl = path.join(T, 'ctl-held');
    setEngines({ unity: cfgFor(E, ctl, { rules: fullRules(ctl) }) });
    const r = probe(`import { markQuietHold, clearQuietHold } from ${u('harness/heavy.mjs')};
import { spawnSync } from 'node:child_process';
const h = markQuietHold(process.cwd(), { ms: 3000, tag: 'engine-land', owner: 'line-producer', why: 'the Unity land is queued: new verifies wait until it holds its slot' });
const c = spawnSync(process.execPath, ['harness/engine-rules.mjs', '--ref', 'feat/m'], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, STUDIO_HEAVY_WAIT_MIN: '1' } });
clearQuietHold(process.cwd(), 'engine-land');
console.log(JSON.stringify({ until: h.until, code: c.status, err: String(c.stderr || '').slice(-1500) }));`);
    const rr = rulesRuns(ctl);
    await guard('2.93 a rules run outside the train waits while an engine land is queued (the Line Producer\'s engine-land hold): one line says what it waits for, the rules command starts only after the hold ends, then passes (fails before this fix: it started at once and took the memory the land run needed)', () => [
      r.code === 0 && /the rules check waits: the Unity land is queued/.test(r.err || '') && rr.length === 1 && rr[0].at >= r.until, J({ r, rr })]);
  }

  // ================= 4. the time limit =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'notes.txt': 'n2\n' }, 'feat/b': { 'Sim/Move.cs': 'class Move { int y; }\n' } });
    const ctl = path.join(T, 'ctl-tmo');
    setEngines({ unity: cfgFor(E, ctl, { rules: fullRules(ctl) }) });
    const SLOW = { RULES_STUB_MS: '4500', STUDIO_ENGINE_RULES_DEFAULT_MIN: '0.05' };
    queue(E, [['T-061', 'feat/a']]);
    const r1 = probe(TRAIN, SLOW);
    const raised = cacheOf().raise?.full;
    queue(E, [['T-062', 'feat/b']]);
    const r2 = probe(TRAIN, SLOW);
    const tm = probe(`import { rulesTimeout, rulesConfig } from ${u('harness/engine-rules.mjs')};
console.log(JSON.stringify(rulesTimeout(process.cwd(), 'unity', rulesConfig('unity', { root: process.cwd(), env: { ...process.env, STUDIO_ENGINE_RULES_DEFAULT_MIN: '0.05' } }), 'full')));`);
    await guard('2.93 the time limit with the batch first: the batch timed out (3 s against a 4.5 s suite) with no limit set: that train judges no lane with the timeout advice and the next limit is doubled, said as a timeout on the batch; the next train runs with it and passes; then the limit follows that passing batch run (1.5 x) (fails before this fix: a timeout raised the limit only when it was on the target)', () => [
      r1.rules?.skipped && raised?.min === 0.1 && raised.where === 'the batch' && /timed out on the batch/.test(r1.rules.skipped) && /raise engines\.unity\.rules\.timeoutMin/.test(r1.rules.skipped)
        && r2.logs?.some((l) => /up to 0\.1 min \(doubled: a full run timed out on the batch after 0\.05 min/.test(l)) && r2.landed?.join() === 'T-062' && !cacheOf().raise?.full
        && tm.min > 0.05 && /1\.5 x the longest passing full run/.test(tm.why || ''), J({ r1: r1.rules, raised, r2: { rules: r2.rules, logs: r2.logs }, tm })]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'notes.txt': 'n2\n' } });
    const ctl = path.join(T, 'ctl-tmo-again');
    setEngines({ unity: cfgFor(E, ctl, { rules: fullRules(ctl, { timeoutMin: 0.05 }) }) });
    fs.writeFileSync(`${ctl}-refuse`, '1');
    queue(E, [['T-071', 'feat/a']]);
    const r1 = probe(TRAIN, { RULES_STUB_MS: '4500' });
    const n1 = rulesRuns(ctl).length;
    const r2 = probe(TRAIN, { RULES_STUB_MS: '4500' });
    const n2 = rulesRuns(ctl).length;
    await guard('2.93 a tree that timed out is not run again with a limit no larger: the same batch on the same target (the land refused, the lane stayed queued) is not run a second time; the train says "not run again" (as before this fix, now for the batch head)', () => [
      n1 === 1 && n2 === 1 && r1.deferred?.length === 1 && /not run again: this tree timed out after 0\.05 min/.test(r2.rules?.skipped || ''), J({ n1, n2, r1: r1.rules, r2: r2.rules })]);
  }
  try { fs.rmSync(S, { recursive: true, force: true }); fs.rmSync(T, { recursive: true, force: true }); } catch { /* the sweep takes it */ }
}
