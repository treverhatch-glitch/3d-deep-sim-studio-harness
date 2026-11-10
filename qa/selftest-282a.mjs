/**
 * qa/selftest-282a.mjs — 2.82: native-engine mode, the rules check before the land run, land stages, the engine flow.
 *
 *   rules     the engine's cheap rules check runs on the batch as it would land, before the long land run; the lane
 *             that turns it red is handed back (cause "rules") and the rest lands on one run; a check that is red on
 *             the target itself judges nobody (harness/engine-rules.mjs, harness/unity-train.mjs)
 *   stages    a land command says what each of its stages took (STUDIO_LAND_RESULT); it goes on the engine.land event
 *   native    a native-engine studio: the verdict, the kickoff lines, the default track of a builder task, and the web
 *             presentation and porting steps that are off (harness/native.mjs)
 *   flow      the scorecard's engine block; the Edit Mode plan after a green .NET run (harness/score.mjs, unity.mjs)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest282A({ dir, root, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const T = path.join(tmpRoot, `s282a-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const harnessRoot = root || dir;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-282a-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file, engine settings) ----
  const S = path.join(tmpRoot, `282a-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(S, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* the checks below need no package */ }
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setGame = (game) => write(S, 'studio/game.json', `${JSON.stringify(game, null, 2)}\n`);
  const setEngines = (engines) => setGame({ engines });
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-282a.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-282a-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 240000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'engine-shots', 'comm', 'gates', 'tmp']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true }); fs.writeFileSync(evFile, ''); };

  // ---- a made-up engine repo: the target port/main lives in the land script's gate worktree ----
  let rn = 0;
  const engineRepo = (lanes, { shared = {} } = {}) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    for (const [f, t] of Object.entries(shared)) write(R, f, t);
    write(R, 'base.txt', 'base\n');
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
  // The land script: records each run (its sources, whether the harness said the rules were green), writes its stages
  // where the harness asked, then merges the sources into the gate worktree.
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, rulesGreen: process.env.STUDIO_RULES_GREEN || '', result: Boolean(process.env.STUDIO_LAND_RESULT), editArgs: process.env.STUDIO_UNITY_EDITMODE_ARGS || '' }) + '\\n');
if (process.env.STUDIO_LAND_RESULT) fs.writeFileSync(process.env.STUDIO_LAND_RESULT, JSON.stringify({ gates: { merge: { status: 'pass' }, rules: { status: 'pass', seconds: 12 }, edit: { status: 'pass', seconds: 95 }, play: { status: 'pass', seconds: 300 } } }));
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); console.log('conflict ' + s); process.exit(2); } }
console.log('landed ' + srcs.join(' '));
`);
  // The rules check: needs its private input, fails on a tree with rules-bad.txt, and counts its runs.
  const rulesStub = path.join(T, 'rules-stub.mjs');
  fs.writeFileSync(rulesStub, `import fs from 'node:fs';
import path from 'node:path';
fs.appendFileSync(${JSON.stringify(fwd(path.join(T, 'rules-runs.txt')))}, (process.env.STUDIO_RULES_COMMIT || '?') + '\\n');
if (path.resolve(process.cwd()) !== path.resolve(process.env.STUDIO_RULES_DIR || '')) { console.log('wrong folder'); process.exit(1); }
if (!fs.existsSync('Private~/key.txt')) { console.log('Failed : Rules.NeedsItsPrivateInput'); process.exit(1); }
if (fs.existsSync('rules-bad.txt')) { console.log('  Failed Rules.Economy.FeesAddUp [3 ms]'); console.log('1 test failed'); process.exit(1); }
console.log('Passed!');
`);
  const rulesRuns = () => { try { return fs.readFileSync(path.join(T, 'rules-runs.txt'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  const runsOf = (ctl) => { try { return fs.readFileSync(`${ctl}-runs.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const cfgFor = (E, ctl, extra = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, ...extra });
  const queue = (E, lanes) => { fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true }); fs.writeFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), JSON.stringify(lanes.map(([task, branch], i) => ({ task, agent: `porter-${i}`, branch, head: E.heads[branch], at: new Date(Date.now() + i).toISOString() })))); };
  const TRAIN = `import { runUnityTrain, readUnityQueue } from ${u('harness/unity-train.mjs')};
const handed = [];
const r = await runUnityTrain({ root: process.cwd(), log: () => {}, deps: { handBack: (lane, note, extra) => handed.push({ task: lane.task, note, extra: extra || null }) } });
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, landed: r.landed, dropped: r.dropped, deferred: r.deferred, rules: r.rules || null, handed, queue: readUnityQueue(process.cwd()).map((e) => e.task) }));`;

  // ================= 1. the rules check before the land run =================
  {
    resetState();
    const asm = (name) => JSON.stringify({ name, includePlatforms: ['Editor'], defineConstraints: ['UNITY_INCLUDE_TESTS'] });
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'rules-bad.txt': 'x\n' }, 'feat/c': { 'c.txt': 'c\n' } }, { shared: {
      'Assets/Tests/EditMode/Rules.Tests.asmdef': asm('Game.Rules.Tests'), 'Assets/Tests/EditMode/FeesTests.cs': 'class FeesTests {}\n',
      'Assets/Tests/EditModeArt/Art.Tests.asmdef': asm('Game.Art.Tests'), 'Assets/Tests/EditModeArt/ArtTests.cs': 'class ArtTests {}\n',
      'tools/SimTests/SimTests.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="../../Assets/Tests/EditMode/**/*.cs" /></ItemGroup></Project>\n',
    } });
    write(E.GW, 'Private~/key.txt', 'k\n'); // a git-ignored input the tests read: it lives in the land script's worktree only
    const ctl = path.join(T, 'ctl-rules');
    setEngines({ unity: cfgFor(E, ctl, { rules: { test: `node "${fwd(rulesStub)}"`, inputs: ['Private~'] } }) });
    queue(E, [['T-901', 'feat/a'], ['T-902', 'feat/b'], ['T-903', 'feat/c']]);
    const before = rulesRuns();
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    const dropped = (r.dropped || []).find((d) => d.task === 'T-902');
    const evRules = events().find((e) => e.type === 'engine.rules');
    const evLand = events().find((e) => e.type === 'engine.land');
    await guard('2.82 rules check: of three queued lanes the one that turns the cheap rules check red is handed back BEFORE the land run (cause "rules", the failing test named, the check ran in a throwaway checkout with its private input copied from the land script\'s worktree), and the other two land on ONE land run that is told the rules are green (STUDIO_RULES_GREEN=1) (fails on 2.81.0: no rules check, all three go to the land run)', () => [
      r.landed?.join() === 'T-901,T-903' && r.runs === 1 && runs.length === 1 && runs[0].rulesGreen === '1' && dropped?.cause === 'rules' && /Rules\.Economy\.FeesAddUp/.test(dropped.why) && /is red with feat\/b/.test(dropped.why)
        && r.handed?.some((h) => h.task === 'T-902' && h.extra?.cause === 'rules') && r.rules?.ran === true && r.rules.dropped?.join() === 'T-902' && evRules?.meta?.dropped?.join() === 'T-902' && evRules.meta.kept?.join() === 'T-901,T-903'
        && !fs.existsSync(path.join(E.R, 'Private~')) && !(() => { try { return fs.readdirSync(path.join(S, '.studio', 'tmp')); } catch { return []; } })().some((n) => n.startsWith('rules-')),
      JSON.stringify({ r, runs, evRules: evRules?.meta }).slice(0, 2800)]);
    await guard('2.82 land stages: the land command wrote what each stage took where the harness asked (STUDIO_LAND_RESULT), and the stages are on the engine.land event in its order (merge, rules 12 s, edit 95 s, play 300 s); a Unity land is also told which Edit Mode assemblies the editor still has to run after the .NET tests (STUDIO_UNITY_EDITMODE_ARGS: the art tests only)', () => [
      runs[0]?.result === true && runs[0].editArgs === '-assemblyNames Game.Art.Tests' && evLand?.meta?.stages?.map((s) => `${s.name}:${s.status}:${s.seconds}`).join() === 'merge:pass:null,rules:pass:12,edit:pass:95,play:pass:300',
      JSON.stringify(evLand?.meta || null)]);
    // The same trees again: the kept results answer, nothing runs twice.
    const E2runs = rulesRuns() - before;
    const again = probe(`import { rulesConfig, runRulesAt } from ${u('harness/engine-rules.mjs')};
const cfg = rulesConfig('unity', { root: process.cwd(), repo: ${JSON.stringify(fwd(E.R))}, ref: 'port/main' });
const a = runRulesAt({ engine: 'unity', repo: ${JSON.stringify(fwd(E.R))}, sha: ${JSON.stringify(E.heads['feat/a'])}, cfg, from: [${JSON.stringify(fwd(E.GW))}], root: process.cwd(), id: 't' });
console.log(JSON.stringify({ status: a.status, cached: a.cached === true, failures: a.failures || [], source: cfg.source, inputs: cfg.inputs }));`);
    await guard('2.82 rules check, kept results: a tree is run once (the first lane\'s commit was judged while the batch was narrowed, so asking again answers from .studio/engine/unity-rules.json without a run); the batch of three took 5 runs (the target, the batch, two prefixes, the batch without the culprit)', () => [
      again.status === 'pass' && again.cached === true && rulesRuns() - before === E2runs && E2runs === 5 && again.inputs.join() === 'Private~',
      JSON.stringify({ again, E2runs })]);
    // The inputs are not in the tree: with another private input the kept result no longer answers.
    write(E.GW, 'Private~/key.txt', 'k2\n');
    const b2 = rulesRuns();
    const changed = probe(`import { rulesConfig, runRulesAt } from ${u('harness/engine-rules.mjs')};
const cfg = rulesConfig('unity', { root: process.cwd(), repo: ${JSON.stringify(fwd(E.R))}, ref: 'port/main' });
const a = runRulesAt({ engine: 'unity', repo: ${JSON.stringify(fwd(E.R))}, sha: ${JSON.stringify(E.heads['feat/a'])}, cfg, from: [${JSON.stringify(fwd(E.GW))}], root: process.cwd(), id: 't' });
console.log(JSON.stringify({ status: a.status, cached: a.cached === true, failures: a.failures || [], source: cfg.source, inputs: cfg.inputs }));`);
    await guard('2.82 rules check, kept results and inputs: the git-ignored inputs are part of what a kept result is valid for, so after the private input changed the same tree is run again instead of answered from the kept result (fails before this fix: the result was kept per tree and command only, and a changed input got yesterday\'s answer)', () => [
      changed.status === 'pass' && changed.cached === false && rulesRuns() - b2 === 1,
      JSON.stringify({ changed, ran: rulesRuns() - b2 })]);
  }
  {
    // The inputs change between the rules check and the land run: the land run is not told the rules are green.
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } });
    write(E.GW, 'Private~/key.txt', 'k\n');
    const moving = path.join(T, 'rules-moving.mjs');
    fs.writeFileSync(moving, `import fs from 'node:fs';
if (!fs.existsSync('Private~/key.txt')) { console.log('Failed : Rules.NeedsItsPrivateInput'); process.exit(1); }
if (fs.existsSync('a.txt')) fs.appendFileSync(process.argv[2], 'repacked\\n'); // someone re-packs the input while the batch is checked
console.log('Passed!');
`);
    const ctl = path.join(T, 'ctl-moving');
    setEngines({ unity: cfgFor(E, ctl, { rules: { test: `node "${fwd(moving)}" "${fwd(path.join(E.GW, 'Private~', 'key.txt'))}"`, inputs: ['Private~'] } }) });
    queue(E, [['T-921', 'feat/a']]);
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    await guard('2.82 rules check, inputs that moved: the private input changed after the batch was checked green, so the land run is NOT told the rules are green (no STUDIO_RULES_GREEN: a land script that trusts the flag runs its own rule tests on the inputs it really has); the lane still lands', () => [
      r.landed?.join() === 'T-921' && r.rules?.ran === true && !r.dropped?.length && runs.length === 1 && runs[0].rulesGreen === '',
      JSON.stringify({ r, runs }).slice(0, 1500)]);
  }
  {
    // The calibration: the check is red on the target itself (its input is named nowhere), so it judges nobody.
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'rules-bad.txt': 'x\n' } });
    const ctl = path.join(T, 'ctl-calib');
    setEngines({ unity: cfgFor(E, ctl, { rules: `node "${fwd(rulesStub)}"` }) });
    queue(E, [['T-911', 'feat/a'], ['T-912', 'feat/b']]);
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    await guard('2.82 rules check, calibration: a check that is red on the landed target itself (here its input is missing in a clean checkout) judges no lane: nobody is handed back, the reason names the fix (rules.inputs), and the land run decides as before, without STUDIO_RULES_GREEN', () => [
      r.landed?.join() === 'T-911,T-912' && !r.dropped?.length && runs.length === 1 && runs[0].rulesGreen === '' && /judges no lane/.test(r.rules?.skipped || '') && /rules\.inputs/.test(r.rules.skipped),
      JSON.stringify({ r, runs }).slice(0, 2000)]);
  }
  {
    // The narrowing, as plain logic: two culprits among five lanes, a run limit, a target the check can't run on.
    const r = probe(`import { rulesGate, rulesConfig } from ${u('harness/engine-rules.mjs')};
const lanes = ['A', 'B', 'C', 'D', 'E'].map((x) => ({ task: 'T-' + x, branch: 'feat/' + x.toLowerCase(), head: x }));
const chain = (tip, ls) => ({ head: [tip, ...ls.map((l) => l.head)].join('+') });
const cfg = { command: 'check', inputs: [], timeoutMin: 1 };
const mk = (bad, calls) => ({ sha }) => { calls.push(sha); return bad.some((b) => sha.split('+').includes(b)) ? { status: 'red', why: 'red', ms: 1000, failures: ['Suite.' + bad.find((b) => sha.split('+').includes(b))] } : { status: 'pass', why: 'ok', ms: 1000 }; };
const c1 = []; const two = rulesGate({ engine: 'unity', repo: '.', tip: 'T', lanes, chain, cfg, root: process.cwd(), env: {}, run: mk(['B', 'D'], c1) });
const c2 = []; const green = rulesGate({ engine: 'unity', repo: '.', tip: 'T', lanes, chain, cfg, root: process.cwd(), env: {}, run: mk([], c2) });
const c3 = []; const capped = rulesGate({ engine: 'unity', repo: '.', tip: 'T', lanes, chain, cfg, root: process.cwd(), env: { STUDIO_ENGINE_RULES_MAX_RUNS: '3' }, run: mk(['B', 'D'], c3) });
const cant = rulesGate({ engine: 'unity', repo: '.', tip: 'T', lanes, chain, cfg, root: process.cwd(), env: {}, run: () => ({ status: 'error', why: 'the rules check could not run: ENOENT', ms: 0 }) });
const none = rulesGate({ engine: 'unity', repo: '.', tip: 'T', lanes, chain, cfg: null, root: process.cwd(), env: {} });
console.log(JSON.stringify({
  two: { kept: two.kept.map((l) => l.task), dropped: two.dropped.map((d) => d.lane.task), green: two.green, runs: two.runs, why0: two.dropped[0]?.why || '' },
  green: { kept: green.kept.length, dropped: green.dropped.length, green: green.green, runs: green.runs },
  capped: { kept: capped.kept.map((l) => l.task), dropped: capped.dropped.map((d) => d.lane.task), green: capped.green || null, runs: capped.runs, why: capped.why },
  cant: { skipped: cant.skipped === true, kept: cant.kept.length, why: cant.why }, none: { skipped: none.skipped === true, kept: none.kept.length },
  off: rulesConfig('unity', { root: process.cwd(), env: { STUDIO_ENGINE_RULES: 'off' } }),
}));`);
    await guard('2.82 rules check, narrowing: with two culprits among five lanes both are found with the cheap check and the other three are green together (never more than 12 runs); a green batch takes two runs (the target, the batch); at the run limit the lanes left go to the land run unjudged, nobody else dropped; a check that can\'t run on the target, or no check at all, keeps every lane; STUDIO_ENGINE_RULES=off: no check', () => [
      r.two?.kept.join() === 'T-A,T-C,T-E' && r.two.dropped.join() === 'T-B,T-D' && r.two.green === 'T+A+C+E' && r.two.runs <= 12 && /is red with feat\/b on top of T-A/.test(r.two.why0) && /Suite\.B/.test(r.two.why0)
        && r.green?.kept === 5 && r.green.dropped === 0 && r.green.green === 'T+A+B+C+D+E' && r.green.runs === 2
        && r.capped?.runs === 3 && r.capped.green === null && /the land run decides/.test(r.capped.why) && r.capped.kept.length + r.capped.dropped.length === 5
        && r.cant?.skipped && r.cant.kept === 5 && /judges no lane/.test(r.cant.why) && r.none?.skipped && r.none.kept === 5 && r.off === null,
      JSON.stringify(r).slice(0, 2500)]);
  }
  {
    // Where the command comes from: the owner's setting, the Unity default when the target has tools/SimTests, the SDK path.
    const E = engineRepo({}, { shared: { 'tools/SimTests/SimTests.csproj': '<Project />\n' } });
    const E0 = engineRepo({});
    const r = probe(`import { rulesConfig } from ${u('harness/engine-rules.mjs')};
import fs from 'node:fs';
const set = (rules) => fs.writeFileSync('studio/game.json', JSON.stringify({ engines: { unity: rules === undefined ? {} : { rules } } }));
const at = (repo, env = {}) => rulesConfig('unity', { root: process.cwd(), env, repo, ref: 'port/main' });
set(undefined);
const dflt = at(${JSON.stringify(fwd(E.R))}); const sdk = at(${JSON.stringify(fwd(E.R))}, { STUDIO_DOTNET: 'C:/Program Files/dotnet/dotnet.exe' }); const noFolder = at(${JSON.stringify(fwd(E0.R))});
set('make rules'); const own = at(${JSON.stringify(fwd(E0.R))});
set({ test: 'make rules', inputs: ['Rules~/', '../outside', '/abs', 'Saves~'], timeoutMin: 7 }); const obj = at(${JSON.stringify(fwd(E0.R))});
set(false); const no = at(${JSON.stringify(fwd(E.R))});
console.log(JSON.stringify({ dflt, sdk: sdk?.command, noFolder, own, obj, no }));`);
    await guard('2.82 rules check, its command: unset, a Unity engine whose target branch has tools/SimTests gets `dotnet test tools/SimTests` (STUDIO_DOTNET replaces the program), and one without that folder gets none; the owner\'s "rules" is one command or { test, inputs, timeoutMin } (an input outside the checkout is dropped); "rules": false turns the default off', () => [
      r.dflt?.command === 'dotnet test tools/SimTests' && /default/.test(r.dflt.source) && r.sdk === '"C:/Program Files/dotnet/dotnet.exe" test tools/SimTests' && r.noFolder === null
        && r.own?.command === 'make rules' && r.own.timeoutMin === 30 && r.obj?.inputs.join() === 'Rules~,Saves~' && r.obj.timeoutMin === 7 && r.no === null,
      JSON.stringify(r).slice(0, 1800)]);
  }

  // ================= 2. native-engine mode =================
  {
    resetState();
    const mk = (name, game, folders = []) => { const R = path.join(T, `native-${name}`); write(R, 'studio/game.json', JSON.stringify(game)); for (const f of folders) fs.mkdirSync(path.join(R, f), { recursive: true }); return fwd(R); };
    const roots = {
      only: mk('only', { game: 'demo', engines: { unity: {} } }),
      web: mk('web', { game: 'demo', engines: { unity: {} } }, ['game/demo']),
      said: mk('said', { game: 'demo', native: 'unity', engines: { unity: {}, godot: {} } }, ['game/demo']),
      no: mk('no', { game: 'demo', native: false, engines: { unity: {} } }),
      two: mk('two', { game: 'demo', engines: { unity: {}, godot: {} } }),
      template: mk('template', { engines: { unity: {} } }),
      cart: mk('cart', { game: 'demo', cartridge: 'demo', engines: { unity: {} } }),
      twins: mk('twins', { game: 'demo', engines: { unity: { twins: ['web/demo/sim/**'] } } }),
      wrong: mk('wrong', { game: 'demo', native: 'unreal', engines: { unity: {} } }),
    };
    const r = probe(`import { nativeVerdict, nativeEngine, nativeBrief } from ${u('harness/native.mjs')};
const roots = ${JSON.stringify(roots)};
const v = Object.fromEntries(Object.entries(roots).map(([k, root]) => [k, nativeVerdict(root, {})]));
console.log(JSON.stringify({ v, envOff: nativeEngine(roots.only, { STUDIO_NATIVE: 'off' }), envOn: nativeEngine(roots.web, { STUDIO_NATIVE: 'unity' }), envBad: nativeEngine(roots.web, { STUDIO_NATIVE: 'godot' }), brief: nativeBrief(roots.said, {}), none: nativeBrief(roots.web, {}) }));`);
    await guard('2.82 native mode, the verdict: native when studio/game.json says "native": "<engine>", or names a game and exactly one engine with no web game; never by inference for a studio with a web game folder, a cartridge, engine twins, two engines, or no game of its own (the template); "native": false and STUDIO_NATIVE=off turn it off, STUDIO_NATIVE=<a configured engine> turns it on, a name that is no configured engine is refused with the reason; the kickoff lines exist only in a native studio', () => [
      r.v?.only?.native && r.v.only.engine === 'unity' && r.v.said?.native && r.v.said.from === 'studio/game.json "native"' && !r.v.web.native && /web game \(game\/demo\)/.test(r.v.web.why) && !r.v.no.native && !r.v.two.native
        && !r.v.template.native && /no game of its own/.test(r.v.template.why) && !r.v.cart.native && !r.v.twins.native && !r.v.wrong.native && /names no engine/.test(r.v.wrong.why)
        && r.envOff === null && r.envOn === 'unity' && r.envBad === null && /native unity/.test(r.brief) && /Build each feature once/.test(r.brief) && /no port tasks/.test(r.brief) && r.none === '',
      JSON.stringify(r).slice(0, 2500)]);
  }
  {
    resetState();
    const E = engineRepo({});
    const ctl = path.join(T, 'ctl-native');
    setGame({ game: 'demo', native: 'unity', engines: { unity: cfgFor(E, ctl, { twins: ['web/demo/sim/**'] }) } });
    const add = (args) => run(S, `node harness/task.mjs add ${args} --agent producer-1`, envOf({ STUDIO_ROLE: 'producer' }));
    const a1 = add('"Add fuel pricing to the apron"');
    const a2 = add('"Fix the fee rounding in the web rules" --track web');
    const a3 = add('"Write up the pricing decisions" --type docs');
    const added = events().filter((e) => e.type === 'task.added');
    const trackOf = (re) => added.find((e) => re.test(e.msg || e.meta?.title || JSON.stringify(e)))?.meta?.track ?? null;
    const k = run(S, 'node harness/kickoff.mjs --role producer --agent prod-1 --model m', envOf()).stdout;
    const kq = run(S, 'node harness/kickoff.mjs --role qa-playtester --agent qa-1 --model m', envOf()).stdout;
    const off = probe(`import { testerPass, twinPass } from ${u('harness/line-producer.mjs')};
import { queueLandingBuild } from ${u('harness/landing-build.mjs')};
import { queueDrift } from ${u('harness/engine.mjs')};
const t = await testerPass({ act: false, deps: { root: process.cwd() } });
const tw = await twinPass({ act: false, deps: { root: process.cwd() } });
const lb = await queueLandingBuild({ root: process.cwd(), tasks: ['T-1'], spawn: () => { throw new Error('a worker was started'); } });
const d = await queueDrift({ by: 'producer-1' });
console.log(JSON.stringify({ t: { state: t.state, why: t.why }, tw: { on: tw.on, why: tw.why }, lb: { queued: lb.queued, why: lb.why }, d: { ok: d.ok, message: d.message } }));`);
    const cli = run(S, 'node harness/engine.mjs native', envOf());
    await guard('2.82 native mode, what changes: a builder task with no --track goes on the engine track (said once), --track web stays a web task and a docs task gets no track; the Producer\'s kickoff says one build per feature and no port tasks (the game tester\'s doesn\'t); the game tester\'s schedule, engine twins, the web landing build and the port queue each say they are off because the studio is native; npm run engine -- native prints the verdict (fails on 2.81.0: the task gets a web lane, a twin task is added, the web build is queued)', () => [
      a1.status === 0 && /this studio is native unity, so a builder task goes on engine:unity/.test(out(a1)) && trackOf(/fuel pricing/) === 'engine:unity' && trackOf(/fee rounding/) === 'web' && !/native unity/.test(out(a3)) && !/^engine:/.test(String(trackOf(/pricing decisions/) || ''))
        && /This studio is native unity/.test(k) && /no port tasks/.test(k) && !/native unity/.test(kq)
        && off.t?.state === 'off' && /native unity/.test(off.t.why) && off.tw?.on === false && /native unity/.test(off.tw.why) && off.lb?.queued === false && /native unity/.test(off.lb.why) && off.d?.ok === false && /native unity/.test(off.d.message)
        && cli.status === 0 && /this studio is native unity/.test(out(cli)),
      JSON.stringify({ a1: out(a1).slice(-300), a2: out(a2).slice(-200), a3: out(a3).slice(-200), tracks: added.map((e) => e.meta?.track ?? null), off, cli: out(cli).slice(-300), k: k.slice(-500) }).slice(0, 2800)]);
    // The same studio without "native": nothing changes (a guard for studios that upgrade).
    setGame({ game: 'demo', engines: { unity: cfgFor(E, ctl) } });
    fs.mkdirSync(path.join(S, 'game', 'demo'), { recursive: true });
    fs.writeFileSync(evFile, '');
    const b1 = add('"Add fuel pricing to the hall"');
    const kb = run(S, 'node harness/kickoff.mjs --role producer --agent prod-1 --model m', envOf()).stdout;
    await guard('2.82 native mode, guard: a studio with a web game and one engine that never said "native" is unchanged: the builder task gets no engine track and the kickoff carries no native line', () => [
      b1.status === 0 && !/native/.test(out(b1)) && !events().some((e) => e.type === 'task.added' && /^engine:/.test(String(e.meta?.track || ''))) && !/native unity/.test(kb),
      JSON.stringify({ b1: out(b1).slice(-300), kb: kb.slice(-200) })]);
    fs.rmSync(path.join(S, 'game', 'demo'), { recursive: true, force: true });
  }

  // ================= 3. the engine flow on the scorecard, and the Edit Mode plan =================
  {
    const t0 = Date.parse('2026-03-03T00:00:00Z');
    const ev = (min, type, meta, extra = {}) => ({ ts: new Date(t0 + min * 60000).toISOString(), type, meta, ...extra });
    const st = (rules, edit, play) => [{ name: 'rules', status: rules[0], seconds: rules[1] }, ...(edit ? [{ name: 'edit', status: edit[0], seconds: edit[1] }] : []), ...(play ? [{ name: 'play', status: play[0], seconds: play[1] }] : [])];
    const log = [
      ev(0, 'engine.land', { engine: 'unity', status: 'pass', ms: 60 * 60000, stages: st(['pass', 600], ['pass', 1800], ['pass', 1200]) }),
      ev(70, 'task.train.unity.landed', { lanes: ['T-1', 'T-2'] }),
      ev(80, 'engine.land', { engine: 'unity', status: 'red', ms: 20 * 60000, stages: st(['fail', 1200]) }),
      ev(110, 'engine.land', { engine: 'unity', status: 'red', ms: 50 * 60000, stages: st(['pass', 600], ['pass', 1200], ['fail', 1200]) }),
      ev(170, 'engine.land', { engine: 'unity', status: 'refused', ms: 30 * 60000 }),
      ev(200, 'engine.rules', { engine: 'unity', runs: 3, ms: 90000, kept: ['T-5'], dropped: ['T-6'] }),
    ];
    const r = probe(`import { engineFlow, engineText } from ${u('harness/score.mjs')};
const en = engineFlow(${JSON.stringify(log)});
console.log(JSON.stringify({ en, text: engineText(en, { minutesPerLanded: 320.3, passPct: 16.4 }), none: engineFlow([]) }));`);
    const en = r.en || {};
    const stage = (n) => (en.stages || []).find((s) => s.name === n) || {};
    await guard('2.82 engine flow on the scorecard: from 4 land runs (160 machine minutes) and 2 landed lanes it counts 80 land-run minutes per landed lane, 25% passed, 25% refused (30 min waiting), 43.8% of the minutes in red runs, the stages\' median minutes and where red runs failed first (rules 1, play 1), and the rules check\'s refused lane; the text shows the change since the last record; no land run: no block', () => [
      en.runs === 4 && en.landedLanes === 2 && en.minutesPerLanded === 80 && en.passPct === 25 && en.refusedPct === 25 && en.waitMin === 30 && en.redMinutesPct === 43.8 && en.passMedianMin === 60
        && stage('rules').medianMin === 10 && stage('rules').failedFirst === 1 && stage('edit').medianMin === 30 && stage('play').failedFirst === 1 && en.rules?.refused === 1 && en.rules.runs === 3
        && (r.text || []).some((l) => /Land-run minutes per landed lane: 80 \(was 320\.3\)/.test(l)) && (r.text || []).some((l) => /1 lane\(s\) refused before they cost a land run/.test(l)) && r.none === null,
      JSON.stringify(r).slice(0, 2500)]);
    const P = path.join(T, 'unity-proj');
    const asm = (name, extra = {}) => JSON.stringify({ name, includePlatforms: ['Editor'], defineConstraints: ['UNITY_INCLUDE_TESTS'], ...extra });
    write(P, 'Assets/Tests/EditMode/Rules.Tests.asmdef', asm('Game.Rules.Tests'));
    write(P, 'Assets/Tests/EditMode/FeesTests.cs', 'class FeesTests {}\n');
    write(P, 'Assets/Tests/EditModeArt/Art.Tests.asmdef', asm('Game.Art.Tests'));
    write(P, 'Assets/Tests/EditModeArt/ArtTests.cs', 'class ArtTests {}\n');
    write(P, 'Assets/Tests/PlayMode/Play.Tests.asmdef', JSON.stringify({ name: 'Game.Play.Tests', defineConstraints: ['UNITY_INCLUDE_TESTS'] }));
    write(P, 'Assets/Tests/PlayMode/PlayTests.cs', 'class PlayTests {}\n');
    write(P, 'tools/SimTests/SimTests.csproj', '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="../../Assets/Tests/EditMode/**/*.cs" /></ItemGroup></Project>\n');
    const p = probe(`import { editModePlan } from ${u('harness/unity.mjs')};
import fs from 'node:fs';
const P = ${JSON.stringify(fwd(P))};
const part = editModePlan(P);
fs.writeFileSync(P + '/tools/SimTests/SimTests.csproj', '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="../../Assets/Tests/**/*.cs" /></ItemGroup></Project>');
const all = editModePlan(P);
fs.writeFileSync(P + '/tools/SimTests/SimTests.csproj', '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="../../Assets/Other/**/*.cs" /></ItemGroup></Project>');
const none = editModePlan(P);
console.log(JSON.stringify({ part: { covered: part.covered, uncovered: part.uncovered, args: part.args, skip: part.skip }, all: { skip: all.skip, args: all.args }, none: { skip: none.skip, args: none.args, why: none.why } }));`);
    await guard('2.82 Edit Mode plan: after a green .NET run the editor only has to run the Edit Mode test assemblies the .NET project doesn\'t compile (here the art tests: -assemblyNames Game.Art.Tests; the rules tests ran in .NET; Play Mode assemblies are not listed); when .NET compiles all of them the editor has none left (skip), when it compiles none the editor runs them all (no arguments)', () => [
      p.part?.covered.join() === 'Game.Rules.Tests' && p.part.uncovered.join() === 'Game.Art.Tests' && p.part.args.join(' ') === '-assemblyNames Game.Art.Tests' && p.part.skip === false
        && p.all?.skip === true && p.all.args.length === 0 && p.none?.skip === false && p.none.args.length === 0 && /runs them all/.test(p.none.why),
      JSON.stringify(p).slice(0, 1500)]);
  }

  for (const d of [S, T]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch { /* best effort */ } }
}
