/**
 * qa/selftest-290b.mjs — 2.90 (t): the engine train's speed limit, from two timelines of a studio's day. A batch where two
 * branches each compile alone but not together is searched with the cheap compile command, not land runs; a red that one
 * changed file explains (engines.<x>.blame) skips the search; engines.<x>.preQueue refuses a branch before it is queued;
 * rules.first runs one test filter before everything else in the rules check; two land runs at once on two gate copies;
 * the rules check's timeout follows the suite and a check that judges nobody is seen.
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
const start = Date.now();
process.on('exit', () => fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, probe: E.STUDIO_LAND_PROBE ?? null, rulesGreen: E.STUDIO_RULES_GREEN ?? null, start, end: Date.now() }) + '\\n'));
if (E.STUDIO_LAND_PROBE === '1') console.log('[land-probe] honoured');
if (Number(E.LAND_STUB_MS) > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(E.LAND_STUB_MS));
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); console.log('conflict ' + s); process.exit(2); } }
const stages = (bad) => { if (E.STUDIO_LAND_RESULT) fs.writeFileSync(E.STUDIO_LAND_RESULT, JSON.stringify({ gates: Object.fromEntries(['merge', 'dotnet', 'play'].map((n, i, o) => [n, bad && o.indexOf(bad) < i ? null : { status: n === bad ? 'fail' : 'pass', seconds: 10 }]).filter(([, v]) => v)) })); };
const red = (text) => { git(gw, 'reset', '-q', '--hard', before); stages('dotnet'); console.log(text); process.exit(1); };
const c = spawnSync(process.execPath, [${JSON.stringify(compileStub)}, 'tools/SimTests', '--nologo'], { cwd: gw, encoding: 'utf8' });
if (c.status !== 0) red(c.stdout);
const rd = (f) => fs.readFileSync(path.join(gw, f), 'utf8');
if (!rd('pins/web.json').includes(rd('vectors/pin.txt').trim())) red('  Failed Game.Rules.Tests.PinTests.VectorsMatchPin [3 ms]\\n1 test(s) failed');
stages(null);
if (E.STUDIO_LAND_PROBE === '1' && fs.existsSync(ctl + '-moveonprobe')) { git(gw, 'update-ref', 'refs/heads/port/main', 'HEAD'); process.exit(0); }
if (E.STUDIO_LAND_PROBE === '1') { git(gw, 'reset', '-q', '--hard', before); process.exit(0); }
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
if (Number(process.env.RULES_STUB_MS) > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.RULES_STUB_MS));
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
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, rounds: r.rounds, parallel: r.parallel, landed: r.landed, dropped: r.dropped, handed, compile: r.compile || null, rules: r.rules || null, logs: logs.filter((l) => /compile search|blame plan|rules\\.first|up to [0-9.]+ min|rules check|not run again/.test(l)) }));`;
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
    const { compilerLines } = await import('../harness/engine-compile.mjs');
    const win = compilerLines('C:\\ws\\compile-1\\Sim\\State.cs(13,7): error CS0102: The type \'State\' already contains a definition for \'X\' [C:\\ws\\compile-1\\Sim\\Sim.csproj]\n', 'C:\\ws\\compile-1');
    const nix = compilerLines('/ws/compile-1/Sim/State.cs(13,7): error CS0102: The type \'State\' already contains a definition for \'X\' [/ws/compile-1/Sim/Sim.csproj]\n', '/ws/compile-1');
    await guard('2.90 (t) A: the compiler\'s line names the file as git does on every system: a Windows compiler\'s Sim\\State.cs is given as Sim/State.cs, the message after it untouched (fails before this fix: the hand-back on Windows said Sim\\State.cs, a path no branch changed)', () => [
      win.length === 1 && win[0] === 'Sim/State.cs(13,7): error CS0102: The type \'State\' already contains a definition for \'X\'' && nix[0] === win[0], JSON.stringify({ win, nix })]);
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

  // ================= B2. engines.<x>.preQueue: refused before it is queued =================
  {
    resetState();
    const E = engineRepo({ 'feat/p': { 'p.txt': 'p\n' }, 'feat/pin': { 'pins/web.json': '{ "commit": "beef002" }\n' }, 'feat/pinok': { 'pins/web.json': '{ "commit": "beef003" }\n', 'vectors/pin.txt': 'beef003\n' } });
    const ctl = path.join(T, 'ctl-prequeue');
    const pqLog = path.join(T, 'prequeue-log.jsonl');
    // The pin check's stand-in: any arguments, its own output folder, and the systems to re-record named on red.
    const pinCheck = path.join(T, 'pin-check.mjs');
    fs.writeFileSync(pinCheck, `import fs from 'node:fs'; import path from 'node:path';
const cwd = process.cwd();
fs.appendFileSync(${JSON.stringify(pqLog)}, JSON.stringify({ args: process.argv.slice(2), commit: process.env.STUDIO_LANE_COMMIT || null, dir: process.env.STUDIO_LANE_DIR || null, web: process.env.PIN_WEB || null, bad: process.env['BAD NAME'] || null }) + '\\n');
fs.mkdirSync(path.join(cwd, 'obj'), { recursive: true }); fs.writeFileSync(path.join(cwd, 'obj', 'pin.txt'), 'x');
const pin = JSON.parse(fs.readFileSync(path.join(cwd, 'pins/web.json'), 'utf8')).commit;
const rec = fs.readFileSync(path.join(cwd, 'vectors/pin.txt'), 'utf8').trim();
if (pin !== rec) { console.log('vectors recorded at ' + rec + ', the pin is ' + pin); console.log('re-record: Movement, Fees'); process.exit(1); }
console.log('vectors match the pin');
`);
    setEngines({ unity: cfgFor(E, ctl, { preQueue: [{ touches: 'pins/*.json', run: `node "${fwd(pinCheck)}" --all-systems`, say: 'Re-record the vectors at the new pin and commit them in this branch.', env: { PIN_WEB: 'the/web/checkout', 'BAD NAME': 'x', N: 3 } }] }) });
    const Q = (task, branch) => `import { queueUnityTask } from ${u('harness/unity-train.mjs')};
const r = queueUnityTask(process.cwd(), { engine: 'unity', task: ${JSON.stringify(task)}, branch: ${JSON.stringify(branch)}, agent: 'porter-a' });
console.log(JSON.stringify({ ok: r.ok, error: r.error || null, message: r.message }));`;
    const bad = probe(Q('T-021', 'feat/pin'));
    const n1 = runsOf(pqLog.replace(/-log\.jsonl$/, '')).length;
    const calls1 = (() => { try { return fs.readFileSync(pqLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
    const plain = probe(Q('T-022', 'feat/p'));
    const ok = probe(Q('T-023', 'feat/pinok'));
    const calls = (() => { try { return fs.readFileSync(pqLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
    const q = (() => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), 'utf8')).map((e) => e.task); } catch { return []; } })();
    void n1;
    await guard('2.90 (t) B2: engines.unity.preQueue: a branch that changes pins/web.json without the vectors is refused at queueing, with the check\'s own last lines (the systems to re-record) and the studio\'s line, and the one command; the check ran once in a throwaway checkout of the branch\'s head (STUDIO_LANE_COMMIT, its own arguments), not in the engine repo (fails on 2.89: the branch was queued and found red by a land run)', () => [
      bad.ok === false && bad.error === 'pre-queue' && /changes pins\/web\.json/.test(bad.message) && /re-record: Movement, Fees/.test(bad.message) && /Re-record the vectors at the new pin and commit them in this branch, then task done T-021 --train again\./.test(bad.message)
        && calls1.length === 1 && calls1[0].commit === E.heads['feat/pin'] && calls1[0].args.join() === '--all-systems' && calls1[0].dir && !calls1[0].dir.startsWith(fwd(E.R)) && evs(/^task\.train\.unity\.pre_queue$/).some((e) => e.status === 'blocked' && e.task === 'T-021'),
      JSON.stringify({ bad, calls1 }).slice(0, 2500)]);
    await guard('2.90 (t) B2: a branch that changes no matching file is queued without running the check; one that moves the pin and re-records the vectors passes it and is queued; the queue holds T-022 and T-023, not T-021; no checkout is left in .studio/tmp', () => [
      plain.ok === true && ok.ok === true && calls.length === 2 && calls[1].commit === E.heads['feat/pinok'] && q.join() === 'T-022,T-023'
        && !(fs.existsSync(path.join(S, '.studio', 'tmp')) && fs.readdirSync(path.join(S, '.studio', 'tmp')).some((x) => x.startsWith('prequeue-'))),
      JSON.stringify({ plain, ok, calls, q }).slice(0, 2500)]);
    await guard('2.90 (t) B2: a preQueue entry\'s "env" reaches its command (the path to the web checkout a pin test reads), string values under plain names only (fails before this fix: the command got none of the studio\'s settings, so a test that needs one could not run before queueing)', () => [
      calls1[0]?.web === 'the/web/checkout' && calls1[0]?.bad === null && calls[1]?.web === 'the/web/checkout', JSON.stringify({ calls }).slice(0, 800)]);
  }

  // ================= B3. rules.first: one test filter before everything else =================
  const rulesCfg = (ctl) => ({ test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" --nologo`, first: 'PinTests', focus: { test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" --nologo --filter "{filter}"` } });
  const B3 = () => engineRepo({ 'feat/p': { 'p.txt': 'p\n' }, 'feat/pin': { 'pins/web.json': '{ "commit": "beef002" }\n' }, 'feat/q': { 'q.txt': 'q\n' } });
  const rulesRuns = (ctl) => { try { return fs.readFileSync(`${ctl}-rules.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  {
    resetState();
    const E = B3();
    const ctl = path.join(T, 'ctl-first');
    setEngines({ unity: cfgFor(E, ctl, { rules: rulesCfg(ctl) }) });
    queue(E, [['T-031', 'feat/p'], ['T-032', 'feat/pin'], ['T-033', 'feat/q']]);
    const r = probe(TRAIN);
    const rr = rulesRuns(ctl);
    const why = r.dropped?.find((d) => d.task === 'T-032')?.why || '';
    await guard('2.90 (t) B3: rules.first "PinTests": the rules check\'s very first run is that filter on the batch (red at once), then the target (green), then prefixes by that filter only; T-032 is refused naming rules.first and the failing test; the full command runs only on T-031 + T-033 (2.93: that batch is green, so never on the target), never on a tree with T-032; one land run lands T-031, T-033 (fails on 2.89: the first rules run was the full command on the target)', () => [
      rr[0]?.filter === 'PinTests' && rr[0].mode === 'first' && rr.filter((x) => x.filter === 'PinTests').length === 5 && rr.filter((x) => !x.filter).length === 1
        && r.dropped?.map((d) => d.task).join() === 'T-032' && r.dropped[0].cause === 'rules' && /rules\.first PinTests/.test(why) && why.includes(PIN)
        && r.runs === 1 && r.landed?.join() === 'T-031,T-033',
      JSON.stringify({ r, rr }).slice(0, 3000)]);
  }
  {
    resetState();
    const E = B3();
    const ctl = path.join(T, 'ctl-first-blame');
    setEngines({ unity: cfgFor(E, ctl, { rules: rulesCfg(ctl), blame: BLAME }) });
    queue(E, [['T-034', 'feat/p'], ['T-035', 'feat/pin'], ['T-036', 'feat/q']]);
    const r = probe(TRAIN);
    const rr = rulesRuns(ctl);
    const why = r.dropped?.find((d) => d.task === 'T-035')?.why || '';
    await guard('2.90 (t) B1+B3: with engines.unity.blame too, the rules check leaves the one branch that changes pins/*.json out at once: 3 runs of the first filter (batch red, target green, the batch without T-035 green), no prefix search; the full command once, on T-034 + T-036 (2.93: green, so not on the target); T-035 refused naming the blame entry and the studio\'s line; T-034 and T-036 land on one land run (fails on 2.89: no rules.first, no blame in the rules check)', () => [
      rr.filter((x) => x.filter === 'PinTests').length === 3 && rr.filter((x) => !x.filter).length === 1 && r.dropped?.map((d) => d.task).join() === 'T-035'
        && /engines\.unity\.blame ties/.test(why) && /Re-record the vectors/.test(why) && r.runs === 1 && r.landed?.join() === 'T-034,T-036',
      JSON.stringify({ r, rr }).slice(0, 3000)]);
  }
  {
    resetState();
    const E = B3();
    const ctl = path.join(T, 'ctl-first-nofocus');
    setEngines({ unity: cfgFor(E, ctl, { rules: { test: `node "${fwd(rulesStub)}" "${fwd(ctl)}"`, first: 'PinTests' } }) });
    const r = probe(`import { rulesConfig } from ${u('harness/engine-rules.mjs')};
const c = rulesConfig('unity', { root: process.cwd() });
console.log(JSON.stringify({ first: c.first, bad: c.focusBad || [] }));`);
    await guard('2.90 (t) B3: rules.first without rules.focus.test (the command a filter runs with) is left out and said, not guessed', () => [
      r.first === null && r.bad?.some((b) => /rules\.first needs rules\.focus\.test/.test(b)),
      JSON.stringify(r).slice(0, 1500)]);
    void E;
  }

  // ================= D. two land runs at once (engines.<x>.gates, train parallel) =================
  // The second gate copy: its own detached worktree of the engine repo and its own land command (same stand-in, its own record).
  const gate2Of = (E) => { const GW2 = `${E.GW}-two`; g(E.R, 'worktree', 'add', '-q', '--detach', GW2, 'port/main'); return GW2; };
  const twoGates = (E, ctl, extra = {}) => { const GW2 = gate2Of(E); return cfgFor(E, ctl, { landProbe: true, gates: [{ land: `node "${fwd(landStub)}" "${fwd(GW2)}" "${fwd(ctl)}-two" {branch}`, cwd: fwd(E.R), gateWorktree: fwd(GW2) }], ...extra }); };
  const D4 = () => engineRepo({ 'feat/p': { 'p.txt': 'p\n' }, 'feat/q': { 'q.txt': 'q\n' }, 'feat/r': { 'r.txt': 'r\n' }, 'feat/pin': { 'pins/web.json': '{ "commit": "beef002" }\n' } });
  const PAR = { STUDIO_HEAVY_SLOTS: '2', STUDIO_ENGINE_SLOTS: '2', STUDIO_HEAVY_MAX_UNITY: '2', STUDIO_HEAVY_WAIT_MIN: '1', LAND_STUB_MS: '400' };
  const parallelCmd = (args, env = {}) => spawnSync(process.execPath, [path.join(S, 'harness', 'task.mjs'), 'train', ...args], { windowsHide: true, cwd: S, env: envOf(env), encoding: 'utf8', timeout: 120000 });
  const statusOf = (env = {}) => out(spawnSync(process.execPath, [path.join(S, 'harness', 'task.mjs'), 'train', 'status', '--engine', 'unity'], { windowsHide: true, cwd: S, env: envOf(env), encoding: 'utf8', timeout: 120000 }));
  let oneGate = null;
  {
    resetState();
    const E = D4();
    const ctl = path.join(T, 'ctl-d-off');
    setEngines({ unity: twoGates(E, ctl) });
    queue(E, [['T-041', 'feat/p'], ['T-042', 'feat/q'], ['T-043', 'feat/r'], ['T-044', 'feat/pin']]);
    const r = probe(TRAIN, PAR);
    oneGate = r;
    await guard('2.90 (t) parallel: off by default: with a second gate configured and room for two runs, the train uses one gate (no run on the second gate\'s record), T-044 is handed back, T-041..T-043 land; the rounds are counted (5: the batch, two steps by name, the confirm, the survivors)', () => [
      runsOf(`${ctl}-two`).length === 0 && r.parallel === undefined && r.landed?.join() === 'T-041,T-042,T-043' && r.dropped?.map((d) => d.task).join() === 'T-044' && r.rounds === 5,
      JSON.stringify(r).slice(0, 2500)]);
  }
  {
    resetState();
    const E = D4();
    const ctl = path.join(T, 'ctl-d-refuse');
    setEngines({ unity: twoGates(E, ctl) });
    const w = parallelCmd(['parallel', 'on', '--engine', 'unity', '--by', 'builder-s2']);
    const lp = parallelCmd(['parallel', 'on', '--engine', 'unity', '--by', 'line-producer'], { STUDIO_ROLE: 'line-producer', STUDIO_LOCK_OWNER: 'line-producer' });
    const st = statusOf(PAR);
    await guard('2.90 (t) parallel: `train parallel on` by a worker\'s name is refused with the reason and changes nothing; the Line Producer (its role and name) may; train status then says it is on, who set it and when, and that the next red search uses both gates', () => [
      w.status !== 0 && /worker/.test(out(w)) && /not changed/.test(out(w)) && lp.status === 0 && /Two land runs at once: on \(by line-producer at \d{4}-/.test(st) && /uses both gates/.test(st),
      JSON.stringify({ w: out(w), lp: out(lp), st }).slice(0, 2500)]);
  }
  {
    resetState();
    const E = D4();
    const ctl = path.join(T, 'ctl-d-on');
    setEngines({ unity: twoGates(E, ctl) });
    parallelCmd(['parallel', 'on', '--engine', 'unity', '--by', 'producer']);
    queue(E, [['T-045', 'feat/p'], ['T-046', 'feat/q'], ['T-047', 'feat/r'], ['T-048', 'feat/pin']]);
    const r = probe(TRAIN, PAR);
    const r1 = runsOf(ctl); const r2 = runsOf(`${ctl}-two`);
    const pe = evs(/^task\.train\.unity\.parallel$/);
    const overlap = r2.some((b) => r1.some((a) => a.probe === '1' && a.start < b.end && b.start < a.end));
    await guard('2.90 (t) parallel: on, the land script honours the probe, two runs admitted: the search after the red runs two steps by name at once, one on each gate (their times overlap, both told STUDIO_LAND_PROBE=1, neither moved the target), and finishes in fewer rounds than one gate (4 against 5) while landing exactly what one gate lands (T-045..T-047; T-048 handed back) (fails before part D: one gate, no rounds counted)', () => [
      r.landed?.join() === 'T-045,T-046,T-047' && r.dropped?.map((d) => d.task).join() === 'T-048' && oneGate?.landed?.join() === 'T-041,T-042,T-043'
        && r.rounds === 4 && r.rounds < oneGate.rounds && r.parallel === 1 && r2.length === 1 && r2[0].probe === '1' && overlap && pe.length === 1,
      JSON.stringify({ rounds: r.rounds, parallel: r.parallel, runs: r.runs, landed: r.landed, dropped: r.dropped?.map((d) => d.task), r1, r2, pe: pe.length, raw: String(r._raw || "").slice(0, 600) }).slice(0, 3000)]);
  }
  {
    resetState();
    const E = D4();
    const ctl = path.join(T, 'ctl-d-revoked');
    setEngines({ unity: twoGates(E, ctl, { landProbe: false }) });
    parallelCmd(['parallel', 'on', '--engine', 'unity', '--by', 'producer']);
    fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true });
    fs.writeFileSync(path.join(S, '.studio', 'train', 'unity-probe.json'), JSON.stringify({ honoured: false, revoked: true, why: 'made up' }));
    queue(E, [['T-051', 'feat/p'], ['T-052', 'feat/pin']]);
    const r = probe(TRAIN, PAR);
    const st = statusOf(PAR);
    await guard('2.90 (t) parallel: on but the probe record is revoked: one gate (no run on the second), the search by complete land runs as before, and train status says in one line why the second gate is not used', () => [
      runsOf(`${ctl}-two`).length === 0 && r.parallel === undefined && r.dropped?.map((d) => d.task).join() === 'T-052' && /Two land runs at once: on .*not used now: the land script has not shown it honours STUDIO_LAND_PROBE/.test(st),
      JSON.stringify({ r, st }).slice(0, 2500)]);
  }
  {
    resetState();
    const E = D4();
    const ctl = path.join(T, 'ctl-d-oneslot');
    setEngines({ unity: twoGates(E, ctl) });
    parallelCmd(['parallel', 'on', '--engine', 'unity', '--by', 'producer']);
    queue(E, [['T-055', 'feat/p'], ['T-056', 'feat/q'], ['T-057', 'feat/r'], ['T-058', 'feat/pin']]);
    const r = probe(TRAIN, { ...PAR, STUDIO_ENGINE_SLOTS: '1' });
    await guard('2.90 (t) parallel: on, but the machine budget admits one engine land run (STUDIO_ENGINE_SLOTS=1): one gate, the same result and rounds as with it off', () => [
      runsOf(`${ctl}-two`).length === 0 && r.parallel === undefined && r.landed?.join() === 'T-055,T-056,T-057' && r.rounds === 5,
      JSON.stringify(r).slice(0, 2500)]);
  }
  {
    resetState();
    const E = D4();
    const ctl = path.join(T, 'ctl-d-kindcap');
    setEngines({ unity: twoGates(E, ctl) });
    parallelCmd(['parallel', 'on', '--engine', 'unity', '--by', 'producer']);
    queue(E, [['T-061', 'feat/p'], ['T-062', 'feat/pin']]);
    const { STUDIO_HEAVY_MAX_UNITY, ...noCap } = PAR; void STUDIO_HEAVY_MAX_UNITY;
    const r = probe(TRAIN, noCap);
    const st = statusOf(noCap);
    await guard('2.90 (t) parallel: on, slots for two, but the Unity editor cap left at its default of one (STUDIO_HEAVY_MAX_UNITY): one gate, and train status names the cap', () => [
      runsOf(`${ctl}-two`).length === 0 && r.parallel === undefined && r.dropped?.map((d) => d.task).join() === 'T-062' && /admits 1 engine land run.*STUDIO_HEAVY_MAX_UNITY/.test(st),
      JSON.stringify({ r, st }).slice(0, 2500)]);
  }
  {
    resetState();
    const E = D4();
    const ctl = path.join(T, 'ctl-d-crash');
    const cfg = twoGates(E, ctl);
    cfg.gates[0].land = 'node -e "process.exit(4)"';
    setEngines({ unity: cfg });
    parallelCmd(['parallel', 'on', '--engine', 'unity', '--by', 'producer']);
    queue(E, [['T-065', 'feat/p'], ['T-066', 'feat/q'], ['T-067', 'feat/r'], ['T-068', 'feat/pin']]);
    const r = probe(TRAIN, PAR);
    await guard('2.90 (t) parallel: the second gate fails to run (its command errors): its step has no answer and runs again on one gate; the train lands exactly what one gate lands (T-065..T-067, T-068 handed back) and nothing is left half done (no queue entry, no integration ref)', () => [
      r.landed?.join() === 'T-065,T-066,T-067' && r.dropped?.map((d) => d.task).join() === 'T-068'
        && !g(E.R, 'for-each-ref', '--format=%(refname)', 'refs/heads/unity-train/').stdout.trim() && (() => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), 'utf8')).length === 0; } catch { return true; } })(),
      JSON.stringify(r).slice(0, 2500)]);
  }
  {
    resetState();
    const E = D4();
    const ctl = path.join(T, 'ctl-d-moved');
    setEngines({ unity: twoGates(E, ctl) });
    fs.writeFileSync(`${ctl}-two-moveonprobe`, '1');
    parallelCmd(['parallel', 'on', '--engine', 'unity', '--by', 'producer']);
    queue(E, [['T-071', 'feat/p'], ['T-072', 'feat/q'], ['T-073', 'feat/r'], ['T-074', 'feat/pin']]);
    const r = probe(TRAIN, PAR);
    let pj = null; try { pj = JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'unity-probe.json'), 'utf8')); } catch { /* checked below */ }
    const q = (() => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), 'utf8')).map((e) => e.task); } catch { return []; } })();
    await guard('2.90 (t) parallel: the second gate\'s script moves the target during a run that must land nothing: the train stops as a single run would (nobody handed back, every lane still queued), the probe record is revoked (so by-name steps and the second gate are off) and a probe_moved_target event is written', () => [
      !r.dropped?.length && !r.landed?.length && q.join() === 'T-071,T-072,T-073,T-074' && pj?.revoked === true && evs(/^task\.train\.unity\.probe_moved_target$/).length === 1,
      JSON.stringify({ r, q, pj }).slice(0, 2500)]);
  }

  // ================= E. the rules check's timeout follows the suite, and a check that judges nobody is seen =================
  const rulesE = (ctl, extra = {}) => ({ test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" --nologo`, ...extra });
  const SLOW = { RULES_STUB_MS: '4500', STUDIO_ENGINE_RULES_DEFAULT_MIN: '0.05' };
  const cacheOf = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'engine', 'unity-rules.json'), 'utf8')); } catch { return {}; } };
  const E2 = () => engineRepo({ 'feat/q': { 'q.txt': 'q\n' }, 'feat/pin': { 'pins/web.json': '{ "commit": "beef002" }\n' }, 'feat/pin2': { 'pins/web.json': '{ "commit": "beef009" }\n' } });
  {
    resetState();
    const E = E2();
    const ctl = path.join(T, 'ctl-e-record');
    setEngines({ unity: cfgFor(E, ctl, { rules: rulesE(ctl) }) });
    fs.mkdirSync(path.join(S, '.studio', 'engine'), { recursive: true });
    fs.writeFileSync(path.join(S, '.studio', 'engine', 'unity-rules.json'), JSON.stringify({ trees: {}, runs: [{ at: '2026-11-13T10:00:00.000Z', status: 'pass', ms: 25 * 60000, mode: 'full' }] }));
    queue(E, [['T-081', 'feat/q']]);
    const r = probe(TRAIN);
    await guard('2.90 (t) rules timeout: (a) no rules.timeoutMin set and a passing full run of 25 min on record: the next run\'s timeout is 37.5 min, above the default 30, and the log line says which timeout applied and why (fails on 2.89: 30 min whatever the record)', () => [
      r.logs?.some((l) => /up to 37\.5 min \(1\.5 x the longest passing full run on record \(25 min\)\)/.test(l)) && r.landed?.join() === 'T-081',
      JSON.stringify(r.logs).slice(0, 2000)]);
  }
  {
    resetState();
    const E = E2();
    const ctl = path.join(T, 'ctl-e-double');
    setEngines({ unity: cfgFor(E, ctl, { rules: rulesE(ctl) }) });
    queue(E, [['T-082', 'feat/pin']]);
    const r1 = probe(TRAIN, SLOW);
    const raised = cacheOf().raise?.full;
    const ne = evs(/^task\.train\.unity\.rules_no_judge$/);
    queue(E, [['T-083', 'feat/q'], ['T-084', 'feat/pin2']]);
    const r2 = probe(TRAIN, SLOW);
    const rr = rulesRuns(ctl);
    await guard('2.90 (t) rules timeout: (b) unset, the default timed out on the batch (2.93: it runs first; 3 s against a 4.5 s suite): that train judges no lane, says so in a warn event with the timeout advice (not the inputs advice), and the next run\'s timeout is doubled; the next train\'s check runs with it, passes on the target and judges the lanes: T-084 (the pin moved, vectors not re-recorded) is refused by the rules check, T-083 lands on one land run (fails on 2.89: every train timed out the same way and judged no lane)', () => [
      r1.rules?.skipped && raised?.min === 0.1 && raised.from === 0.05 && ne.length === 1 && ne[0].status === 'warn' && /raise engines\.unity\.rules\.timeoutMin, or make the run smaller with rules\.focus/.test(ne[0].msg) && !/rules\.inputs/.test(ne[0].msg)
        && r2.logs?.some((l) => /up to 0\.1 min \(doubled: a full run timed out on the batch after 0\.05 min/.test(l)) && r2.rules?.ran === true && r2.dropped?.map((d) => `${d.task}:${d.cause}`).join() === 'T-084:rules' && r2.landed?.join() === 'T-083' && r2.runs === 1
        && !cacheOf().raise?.full && !cacheOf().noJudge && rr.length >= 3,
      JSON.stringify({ r1: r1.rules, raised, r2: { rules: r2.rules, landed: r2.landed, dropped: r2.dropped, runs: r2.runs, logs: r2.logs }, ne: ne.map((e) => e.msg) }).slice(0, 3000)]);
  }
  {
    resetState();
    const E = E2();
    const ctl = path.join(T, 'ctl-e-set');
    setEngines({ unity: cfgFor(E, ctl, { rules: rulesE(ctl, { timeoutMin: 0.05 }) }) });
    queue(E, [['T-085', 'feat/pin']]);
    const r1 = probe(TRAIN, { RULES_STUB_MS: '4500' });
    const n1 = rulesRuns(ctl).length;
    queue(E, [['T-086', 'feat/pin']]);
    const r2 = probe(TRAIN, { RULES_STUB_MS: '4500' });
    const n2 = rulesRuns(ctl).length;
    const ne = evs(/^task\.train\.unity\.rules_no_judge$/);
    const st = out(spawnSync(process.execPath, [path.join(S, 'harness', 'task.mjs'), 'train', 'status', '--engine', 'unity'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 120000 }));
    const lp = probe(`import { rulesIdleLine } from ${u('harness/unity-train.mjs')};\nconsole.log(JSON.stringify({ line: rulesIdleLine(process.cwd(), 'unity') }));`);
    await guard('2.90 (t) rules timeout: (c) a timeout the studio set (rules.timeoutMin 0.05) is used as it is: it timed out on the batch and no raise was recorded, the log says "the studio\'s" (fails on 2.89: a value under 1 min was raised to 1)', () => [
      r1.rules?.skipped && !cacheOf().raise && r1.logs?.some((l) => /up to 0\.05 min \(engines\.unity\.rules\.timeoutMin, the studio's\)/.test(l)),
      JSON.stringify({ r1: r1.rules, logs: r1.logs, cache: cacheOf().raise || null }).slice(0, 2500)]);
    await guard('2.90 (t) rules timeout: (d) the same tree with the same timeout is not run a second time (2.93: the batch runs first, so the same branch is queued again on the same target): the next train does not run the rules command (its record unchanged), says "not run again" and the land run decides (fails on 2.89: the same 30 minutes were spent on every train)', () => [
      n1 >= 1 && n2 === n1 && r2.rules?.skipped && /not run again: this tree timed out after 0\.05 min/.test(r2.rules.skipped) && r2.runs >= 1,
      JSON.stringify({ n1, n2, r2: r2.rules }).slice(0, 2500)]);
    await guard('2.90 (t) rules timeout: (e) after two trains in a row that judged no lane: two rules_no_judge events (warn, to the producer), the second saying "2 trains in a row"; train status says the rules check judged no lane on the last 2 trains with the minutes spent and the one change; the Line Producer reads the same line (fails on 2.89: only the train\'s log said it)', () => [
      ne.length === 2 && ne.every((e) => e.status === 'warn' && e.to === 'producer') && /2 trains in a row/.test(ne[1].msg)
        && /judged no lane on the last 2 trains \(\d+ min spent on it since \d{4}-.*Change: raise engines\.unity\.rules\.timeoutMin/.test(st) && /judged no lane on the last 2 trains/.test(lp.line || ''),
      JSON.stringify({ ne: ne.map((e) => [e.status, e.to, e.msg]), st, lp }).slice(0, 2500)]);
  }
  void tipOf;
}
