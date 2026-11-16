/**
 * qa/selftest-290b.mjs — 2.90 (t): the engine train's speed limit, from two timelines of a studio's day. A batch where two
 * branches each compile alone but not together is searched with the cheap compile command, not land runs; a red that one
 * changed file explains (engines.<x>.blame) skips the search; engines.<x>.preQueue refuses a branch before it is queued;
 * rules.first runs one test filter before everything else in the rules check.
 *
 * The scaffolding (a studio copy, a made-up engine repo, a stand-in land script that records what it was told) is
 * qa/selftest-286b.mjs's. The stand-ins for the compile command and the rules check behave like dotnet where it matters:
 * they take arguments they do not know, write their own files (obj/, bin/, TestResults/) and print the compiler's or the
 * test runner's own lines, with absolute paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, eventTypesOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, queueUnityOf, readRunsJsonl as runsOf, writeIn as write } from './kit.mjs';

export async function selftest290B({ dir, root, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = gEnvOf(ident);
  const g = gitUserCrlfOf(gEnv);
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s290b-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  void root;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_USAGE_FUNCTIONS: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-290b-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file, engine settings) ----
  const S = path.join(tmpRoot, `290b-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-290b.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventTypesOf(eventsFileOf(evFile));
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-290b-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'comm', 'gates', 'tmp', 'locks']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true }); fs.writeFileSync(evFile, ''); };

  // ---- a made-up engine repo: the shared state class, the pin file and the vectors recorded at it ----
  const STATE = (one, two) => `namespace Game.Sim {\nclass State {\n  int a;\n  // one\n${one}  // 1\n  // 2\n  // 3\n  // 4\n  // 5\n  // 6\n  // two\n${two}}\n}\n`;
  const shared = { 'Sim/State.cs': STATE('', ''), 'Sim/Sim.csproj': '<Project />\n', 'pins/web.json': '{ "commit": "c0ffee1" }\n', 'vectors/pin.txt': 'c0ffee1\n', 'Tests/PinTests.cs': 'namespace Game.Rules.Tests { class PinTests { } }\n' };
  let rn = 0;
  const engineRepo = (lanes) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    for (const [f, t] of Object.entries(shared)) write(R, f, t);
    write(R, '.gitignore', 'obj/\nbin/\nTestResults/\n');
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

  // The compile command's stand-in (dotnet build): any arguments; obj/ and bin/ written in its folder; a field declared twice in
  // one class is error CS0102 at its absolute path, printed twice with the project in brackets, as dotnet does.
  const compileStub = path.join(T, 'compile-stub.mjs');
  fs.writeFileSync(compileStub, `import fs from 'node:fs'; import path from 'node:path';
const cwd = process.cwd();
if (process.env.STUB_COMPILE_LOG) fs.appendFileSync(process.env.STUB_COMPILE_LOG, JSON.stringify({ args: process.argv.slice(2), cwd }) + '\\n');
fs.mkdirSync(path.join(cwd, 'obj'), { recursive: true }); fs.writeFileSync(path.join(cwd, 'obj', 'project.assets.json'), '{}');
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['obj', 'bin', '.git'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.cs')) files.push(p); } };
walk(cwd);
const errs = [];
for (const f of files.sort()) {
  let cls = ''; const seen = new Set();
  fs.readFileSync(f, 'utf8').split('\\n').forEach((l, i) => {
    const c = /class\\s+(\\w+)/.exec(l); if (c) { cls = c[1]; seen.clear(); }
    const m = /^\\s*int\\s+(\\w+);/.exec(l);
    if (m) { if (seen.has(m[1])) errs.push(f + '(' + (i + 1) + ',7): error CS0102: The type \\'' + cls + '\\' already contains a definition for \\'' + m[1] + '\\' [' + path.join(cwd, 'Sim', 'Sim.csproj') + ']'); seen.add(m[1]); }
  });
}
if (errs.length) { for (const e of [...errs, ...errs]) console.log(e); console.log('Build FAILED.'); console.log('    ' + errs.length + ' Error(s)'); process.exit(1); }
fs.mkdirSync(path.join(cwd, 'bin'), { recursive: true }); fs.writeFileSync(path.join(cwd, 'bin', 'Sim.dll'), 'x');
console.log('Build succeeded.');
`);
  // The land script's stand-in: merges the branches into the gate worktree, then its "dotnet" stage: the compile, then the pin
  // test (the vectors must be recorded at the pinned commit). Each run is recorded; STUDIO_LAND_PROBE=1 lands nothing.
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const E = process.env;
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, probe: E.STUDIO_LAND_PROBE ?? null, rulesGreen: E.STUDIO_RULES_GREEN ?? null }) + '\\n');
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); console.log('conflict ' + s); process.exit(2); } }
const stages = (bad) => { if (E.STUDIO_LAND_RESULT) fs.writeFileSync(E.STUDIO_LAND_RESULT, JSON.stringify({ gates: Object.fromEntries(['merge', 'dotnet', 'play'].map((n, i, o) => [n, bad && o.indexOf(bad) < i ? null : { status: n === bad ? 'fail' : 'pass', seconds: 10 }]).filter(([, v]) => v)) })); };
const red = (text) => { git(gw, 'reset', '-q', '--hard', before); stages('dotnet'); console.log(text); process.exit(1); };
const c = spawnSync(process.execPath, [${JSON.stringify(compileStub)}, 'tools/SimTests', '--nologo'], { cwd: gw, encoding: 'utf8' });
if (c.status !== 0) red(c.stdout);
const rd = (f) => fs.readFileSync(path.join(gw, f), 'utf8');
if (!rd('pins/web.json').includes(rd('vectors/pin.txt').trim())) red('  Failed Game.Rules.Tests.PinTests.VectorsMatchPin [3 ms]\\n1 test(s) failed');
stages(null);
if (E.STUDIO_LAND_PROBE === '1') { git(gw, 'reset', '-q', '--hard', before); console.log('[land-probe] honoured'); process.exit(0); }
console.log('landed ' + srcs.join(' '));
`);
  // The rules check's stand-in (dotnet test): any arguments; "--filter X" runs the tests whose name holds X; TestResults/ written.
  const rulesStub = path.join(T, 'rules-stub.mjs');
  fs.writeFileSync(rulesStub, `import fs from 'node:fs'; import path from 'node:path';
const [ctl, ...args] = process.argv.slice(2);
const fi = args.indexOf('--filter'); const filter = fi >= 0 ? args[fi + 1] : '';
const cwd = process.cwd();
const rd = (f) => fs.readFileSync(path.join(cwd, f), 'utf8');
fs.appendFileSync(ctl + '-rules.jsonl', JSON.stringify({ filter, mode: process.env.STUDIO_RULES_MODE || null, commit: process.env.STUDIO_RULES_COMMIT || null }) + '\\n');
fs.mkdirSync(path.join(cwd, 'TestResults'), { recursive: true }); fs.writeFileSync(path.join(cwd, 'TestResults', 'r.trx'), '<x/>');
const tests = [['Game.Rules.Tests.PinTests.VectorsMatchPin', rd('pins/web.json').includes(rd('vectors/pin.txt').trim())], ['Game.Rules.Tests.MoveTests.Walks', true]].filter(([n]) => !filter || n.includes(filter));
const bad = tests.filter(([, ok]) => !ok);
for (const [n, ok] of tests) console.log('  ' + (ok ? 'Passed' : 'Failed') + ' ' + n + ' [3 ms]');
if (bad.length) { console.log('Failed!  - Failed: ' + bad.length + ', Passed: ' + (tests.length - bad.length)); process.exit(1); }
console.log('Passed!  - Failed: 0, Passed: ' + tests.length);
`);
  const cfgFor = (E, ctl, extra = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, rules: false, ...extra });
  const queue = queueUnityOf(S);
  const TRAIN = `import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const handed = []; const logs = [];
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps: { handBack: (lane, note, extra) => handed.push({ task: lane.task, note, extra: extra || null }) } });
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, landed: r.landed, dropped: r.dropped, handed, compile: r.compile || null, rules: r.rules || null, logs: logs.filter((l) => /compile search|blame plan|rules\\.first/.test(l)) }));`;
  const PIN = 'Game.Rules.Tests.PinTests.VectorsMatchPin';
  const ONE = '  int X;\n';

  // ================= A. two branches that compile alone but not together =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'Sim/State.cs': STATE(ONE, '') }, 'feat/c': { 'Sim/State.cs': STATE('', ONE) } });
    const ctl = path.join(T, 'ctl-compile');
    const clog = path.join(T, 'compile-log.jsonl');
    setEngines({ unity: cfgFor(E, ctl, { quickCheck: `node "${fwd(compileStub)}" tools/SimTests --nologo`, compileFirst: false }) });
    queue(E, [['T-001', 'feat/a'], ['T-002', 'feat/b'], ['T-003', 'feat/c']]);
    const r = probe(TRAIN, { STUB_COMPILE_LOG: clog });
    const runs = runsOf(ctl);
    const calls = (() => { try { return fs.readFileSync(clog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
    const note = r.handed?.find((h) => h.task === 'T-003')?.note || '';
    const ce = evs(/^task\.train\.unity\.compile_search$/);
    await guard('2.90 (t) A: three branches, the second and third each add the same field to one shared class (each compiles alone, not together): the compile search runs the studio\'s quickCheck on the merged batch, the target and merged prefixes (4 compile runs, each in a throwaway checkout, with the command\'s own arguments), and the batch then needs ONE land run: T-001 and T-002 land on it, T-003 is handed back before any land run (fails on 2.89: 4 land runs, as the studio\'s timeline)', () => [
      r.runs === 1 && runs.length === 1 && runs[0].srcs.join() !== '' && r.landed?.join() === 'T-001,T-002' && r.dropped?.map((d) => d.task).join() === 'T-003' && r.dropped[0].cause === 'compile'
        && r.compile?.runs === 4 && calls.length >= 4 && calls.slice(0, 4).every((c) => c.args.join(' ') === 'tools/SimTests --nologo' && !c.cwd.startsWith(fwd(E.R))) && ce.length === 1 && ce[0].meta?.left?.join() === 'T-003',
      JSON.stringify({ r, runs, calls }).slice(0, 3000)]);
    await guard('2.90 (t) A: the hand-back of T-003 names the branch it does not compile with (T-002, which goes on in this train, not T-001, which changes no file the compiler names), the compiler\'s own line once (error CS0102 at Sim/State.cs, the checkout folder and project suffix taken out), the plain fix (bring the target in, keep one declaration) and the one command; the hand-back record keeps the compiler\'s file (fails on 2.89: T-003 was handed back after a land-run bisect, its text "the land command is red")', () => [
      /does not compile together with T-002 \(feat\/b\), which go on in this train/.test(note) && !/T-001/.test(note.split('\n')[0]) && /keep one/.test(note) && /task done T-003 --train again/.test(note)
        && (note.match(/error CS0102/g) || []).length === 1 && /^ {2}Sim\/State\.cs\(\d+,7\): error CS0102/m.test(note) && !note.includes(fwd(S)) && !/\.csproj\]/.test(note)
        && (() => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'unity-handbacks.json'), 'utf8'))['T-003']?.files?.includes('Sim/State.cs'); } catch { return false; } })(),
      note.slice(0, 2000)]);
    const left = fs.existsSync(path.join(S, '.studio', 'tmp')) ? fs.readdirSync(path.join(S, '.studio', 'tmp')).filter((x) => x.startsWith('compile-')) : [];
    await guard('2.90 (t) A: the compile checkouts are gone after the train (none left in .studio/tmp, none left in the engine repo\'s worktree list) and the engine repo\'s branches are untouched', () => [
      left.length === 0 && !/compile-/.test(g(E.R, 'worktree', 'list').stdout) && g(E.R, 'rev-parse', 'feat/c').stdout.trim() === E.heads['feat/c'],
      JSON.stringify({ left, wt: g(E.R, 'worktree', 'list').stdout })]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'Sim/State.cs': STATE(ONE, '') }, 'feat/c': { 'Sim/State.cs': STATE('', ONE) } });
    const ctl = path.join(T, 'ctl-compile-off');
    setEngines({ unity: cfgFor(E, ctl, { quickCheck: `node "${fwd(compileStub)}"`, compileSearch: false }) });
    queue(E, [['T-004', 'feat/a'], ['T-005', 'feat/b'], ['T-006', 'feat/c']]);
    const r = probe(TRAIN);
    await guard('2.90 (t) A: engines.unity.compileSearch false turns the search off: the batch is searched by land runs as before (4 land runs, T-006 handed back, "only a compile error" in the blame plan)', () => [
      r.runs === 4 && r.landed?.join() === 'T-004,T-005' && r.dropped?.map((d) => d.task).join() === 'T-006' && !r.compile && r.logs?.some((l) => /only a compile error/.test(l)),
      JSON.stringify(r).slice(0, 2500)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n' } });
    g(E.GW, 'checkout', '-q', 'port/main');
    write(E.GW, 'Sim/Broken.cs', 'class Broken {\n  int y;\n  int y;\n}\n'); g(E.GW, 'add', '-A'); g(E.GW, 'commit', '-qm', 'a target that does not compile with the quick check');
    const ctl = path.join(T, 'ctl-compile-target');
    setEngines({ unity: cfgFor(E, ctl, { quickCheck: `node "${fwd(compileStub)}"` }) });
    queue(E, [['T-007', 'feat/a'], ['T-008', 'feat/b']]);
    const r = probe(TRAIN);
    await guard('2.90 (t) A: the compile command red on the target itself judges nobody: no lane is handed back for it (the land run decides, here red for everyone), the log says so', () => [
      r.compile?.targetRed === true && !r.dropped?.some((d) => d.cause === 'compile') && r.logs?.some((l) => /on the target itself/.test(l)),
      JSON.stringify(r).slice(0, 2500)]);
  }

  // ================= B1. a red the pin file explains (engines.<x>.blame) =================
  const BLAME = [{ test: 'PinTests\\.', touches: 'pins/*.json', say: 'Re-record the vectors at the new pin in the same branch' }];
  const B4 = () => engineRepo({ 'feat/p': { 'p.txt': 'p\n' }, 'feat/pin': { 'pins/web.json': '{ "commit": "beef002" }\n' }, 'feat/q': { 'q.txt': 'q\n' }, 'feat/r': { 'r.txt': 'r\n' } });
  {
    resetState();
    const E = B4();
    const ctl = path.join(T, 'ctl-blame');
    setEngines({ unity: cfgFor(E, ctl, { blame: BLAME }) });
    queue(E, [['T-011', 'feat/p'], ['T-012', 'feat/pin'], ['T-013', 'feat/q'], ['T-014', 'feat/r']]);
    const r = probe(TRAIN);
    const be = evs(/^task\.train\.unity\.blame$/);
    const note = r.handed?.find((h) => h.task === 'T-012')?.note || '';
    await guard('2.90 (t) B1: four branches, the second moves the pin without re-recording the vectors; engines.unity.blame ties the pin test to pins/*.json: the blame plan is "without T-012" (rule blame), 2 land runs, T-011, T-013, T-014 land on the second, T-012 is handed back with the evidence and the studio\'s line (fails on 2.89: no lane was tied, 5 land runs)', () => [
      r.runs === 2 && r.landed?.join() === 'T-011,T-013,T-014' && r.dropped?.map((d) => d.task).join() === 'T-012' && be[0]?.meta?.plan === 'without' && be[0].meta.rule === 'blame'
        && /pins\/web\.json/.test(note) && /Re-record the vectors at the new pin/.test(note) && new RegExp(PIN.replace(/\./g, '\\.')).test(note),
      JSON.stringify({ r, be: be.map((e) => e.meta) }).slice(0, 3000)]);
  }
  {
    resetState();
    const E = B4();
    const ctl = path.join(T, 'ctl-blame-bad');
    setEngines({ unity: cfgFor(E, ctl, { blame: [{ test: '(', touches: 'pins/*.json' }, { test: 'Other', touches: '../x' }] }) });
    queue(E, [['T-015', 'feat/p'], ['T-016', 'feat/pin']]);
    const r = probe(TRAIN);
    await guard('2.90 (t) B1: blame entries that are not usable (a bad regex, a path outside the repo) are left out and change nothing: the search by land runs as before', () => [
      r.landed?.join() === 'T-015' && r.dropped?.map((d) => d.task).join() === 'T-016' && r.runs >= 3 && evs(/^task\.train\.unity\.blame$/)[0]?.meta?.plan === 'bisect',
      JSON.stringify(r).slice(0, 2500)]);
  }

  void tipOf;
}
