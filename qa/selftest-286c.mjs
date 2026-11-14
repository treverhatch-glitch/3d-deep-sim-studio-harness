/**
 * qa/selftest-286c.mjs — 2.86 (c): the rules check before an engine land run, by convention and per part.
 *
 * A crew ran every rules check for two days in full mode, twice per train (the target, then the batch), about 20 minutes
 * each: a port adds a new rule system folder no hand-written rules.focus.map entry lists, and the kept result was keyed by
 * the whole tree plus every input, so the target was run again every train. Here: rules.focus.auto derives one map entry
 * per system folder; results are kept per part under what the part reads; a part new in the batch is not run on the
 * target; a red batch is narrowed with the red part only; `npm run engine -- rules-plan` says what would run.
 * Scaffolding as qa/selftest-285b.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest286C({ dir, root, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const T = path.join(tmpRoot, `s286c-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const harnessRoot = root || dir;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-286c-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file, engine settings) ----
  const S = path.join(tmpRoot, `286c-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-286c.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const evs = (re) => events().filter((e) => re.test(e.type));
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-286c-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'engine-shots', 'comm', 'gates', 'tmp', 'locks']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true }); fs.writeFileSync(evFile, ''); };

  // ---- a made-up engine repo: the target port/main lives in the land script's gate worktree ----
  let rn = 0;
  const engineRepo = (lanes, { shared = {} } = {}) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    for (const [f, t] of Object.entries(shared)) write(R, f, t);
    write(R, 'base.txt', 'base\n');
    write(R, '.gitignore', 'TestResults*.xml\n');
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
  // The land script stand-in. It records each run (sources and every variable the harness tells a land script), merges
  // the sources into the gate worktree and judges the merged tree:
  //   "<stage>-bad.txt" (edit, play) makes that stage red with the test name it holds ("rev:" + the name reversed, so the
  //     name itself appears in no file a lane changes); "compile-bad.txt" holds a compiler error line.
  //   <ctl>-flaky "N stage name": the next N runs fail in that stage on that test. <ctl>-kill "N code": the next N runs
  //   exit with that code. <ctl>-cancel: writes the train's cancel file (the id from the train lock), then exits 77.
  //   <ctl>-names: how a red names its tests: "out" (default, a dotnet line), "xml" (an NUnit 3 results file in the gate
  //   worktree and a summary only) or "json" (a "failures" list in the stage report and a summary only).
  //   <ctl>-compile: what STUDIO_LAND_ONLY=compile does: "honour" (default: merge, compile, put the tree back, exit 0 or
  //   1 with the compiler line), "unknown" (exit 9: a code the land contract does not know) or "ignore" (land as usual).
  // A red run puts the gate worktree back where it was, as a real land script does.
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const E = process.env;
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const opt = (k) => { try { return fs.readFileSync(ctl + '-' + k, 'utf8').trim(); } catch { return null; } };
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, only: E.STUDIO_LAND_ONLY ?? null, retry: E.STUDIO_LAND_RETRY ?? null, retryStage: E.STUDIO_LAND_RETRY_STAGE ?? null, retryTests: E.STUDIO_LAND_RETRY_TESTS ?? null, rulesGreen: E.STUDIO_RULES_GREEN ?? null, rulesMode: E.STUDIO_RULES_MODE ?? null, playMode: E.STUDIO_PLAY_MODE ?? null, playFilter: E.STUDIO_PLAY_FILTER ?? null, playArgs: E.STUDIO_UNITY_PLAYMODE_ARGS ?? null }) + '\\n');
const kill = opt('kill');
if (kill) { const [n, code] = kill.split(' '); if (Number(n) > 0) { fs.writeFileSync(ctl + '-kill', (Number(n) - 1) + ' ' + code); process.exit(Number(code)); } }
if (opt('cancel') !== null) {
  let id = null; try { id = JSON.parse(fs.readFileSync(path.join(E.STUDIO_MAIN_ROOT, '.studio', 'locks', 'unity-train.lock'), 'utf8')).id; } catch {}
  fs.mkdirSync(path.join(E.STUDIO_MAIN_ROOT, '.studio', 'train'), { recursive: true });
  fs.writeFileSync(path.join(E.STUDIO_MAIN_ROOT, '.studio', 'train', 'unity-cancel.json'), JSON.stringify({ train: id, by: 'a person', at: new Date().toISOString() }));
  process.exit(77);
}
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
const names = opt('names') || 'out';
const stages = (bad, failures) => { if (E.STUDIO_LAND_RESULT) fs.writeFileSync(E.STUDIO_LAND_RESULT, JSON.stringify({ gates: Object.fromEntries(['merge', 'edit', 'play', 'build'].map((n, i, all) => [n, bad && all.indexOf(bad) < i ? null : { status: n === bad ? 'fail' : 'pass', seconds: 10 }]).filter(([, v]) => v)), ...(failures ? { failures } : {}) })); };
const red = (stage, test0) => {
  const test = test0.startsWith('rev:') ? test0.slice(4).split('').reverse().join('') : test0;
  git(gw, 'reset', '-q', '--hard', before);
  if (names === 'xml') { fs.writeFileSync(path.join(gw, 'TestResults-' + Date.now() + '.xml'), '<?xml version="1.0"?>\\n<test-run result="Failed"><test-suite type="Assembly"><test-case id="1001" name="X" fullname="' + test.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '" runstate="Runnable" result="Failed"><failure><message>expected 2</message></failure></test-case></test-suite></test-run>\\n'); stages(stage); console.log('Tests: 1 failed, 40 passed'); }
  else if (names === 'json') { stages(stage, [test]); console.log('Tests: 1 failed, 40 passed'); }
  else { stages(stage); console.log('  Failed ' + test + ' [3 ms]'); console.log('1 test failed'); }
  process.exit(1);
};
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); console.log('conflict ' + s); process.exit(2); } }
if (E.STUDIO_LAND_ONLY === 'compile') {
  const cm = opt('compile') || 'honour';
  if (cm === 'unknown') { git(gw, 'reset', '-q', '--hard', before); console.log('no such step'); process.exit(9); }
  if (cm === 'honour') {
    const bad = path.join(gw, 'compile-bad.txt');
    const line = fs.existsSync(bad) ? fs.readFileSync(bad, 'utf8').trim() : '';
    git(gw, 'reset', '-q', '--hard', before);
    if (line) { console.log(line); console.log('[engine-gate] FAIL compile-error'); process.exit(1); }
    console.log('compiles'); process.exit(0);
  }
}
const fl = opt('flaky');
if (fl) { const p = fl.split(' '); if (Number(p[0]) > 0) { fs.writeFileSync(ctl + '-flaky', [Number(p[0]) - 1, p[1], p.slice(2).join(' ')].join(' ')); red(p[1], p.slice(2).join(' ')); } }
if (fs.existsSync(path.join(gw, 'compile-bad.txt'))) { const line = fs.readFileSync(path.join(gw, 'compile-bad.txt'), 'utf8').trim(); git(gw, 'reset', '-q', '--hard', before); stages('edit'); console.log(line); console.log('[engine-gate] FAIL compile-error'); process.exit(1); }
for (const st of ['edit', 'play']) { const f = path.join(gw, st + '-bad.txt'); if (fs.existsSync(f)) red(st, fs.readFileSync(f, 'utf8').trim()); }
stages(null);
console.log('landed ' + srcs.join(' '));
`);
  const runsOf = (ctl) => { try { return fs.readFileSync(`${ctl}-runs.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const cfgFor = (E, ctl, extra = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, rules: false, ...extra });
  const queue = (E, lanes) => { fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true }); fs.writeFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), JSON.stringify(lanes.map(([task, branch], i) => ({ task, agent: `porter-${i}`, branch, head: E.heads[branch], at: new Date(Date.now() + i).toISOString() })))); };
  const TRAIN = `import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const handed = []; const logs = [];
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps: { handBack: (lane, note, extra) => handed.push({ task: lane.task, note, extra: extra || null }) } });
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, landed: r.landed, dropped: r.dropped, rules: r.rules || null, handed, logs: logs.filter((l) => /rules|split|part|cached|kept/i.test(l)) }));`;
  const rulesRuns = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  // The rules test stand-in: it records its filter and the system folders of the checkout it ran in; it is red when a
  // system folder holds rules-bad.txt whose text is the filter it was given.
  const rulesStub = path.join(T, 'rules-stub.mjs');
  fs.writeFileSync(rulesStub, `import fs from 'node:fs';
const [log, filter] = process.argv.slice(2);
const sims = fs.existsSync('Sim') ? fs.readdirSync('Sim').filter((n) => fs.statSync('Sim/' + n).isDirectory()).sort() : [];
fs.appendFileSync(log, JSON.stringify({ filter: filter ?? null, sims }) + '\\n');
for (const n of sims) { const f = 'Sim/' + n + '/rules-bad.txt'; if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim() === filter) { console.log('  Failed Rules.' + n + '.AddsUp [3 ms]'); console.log('1 test failed'); process.exit(1); } }
console.log('Passed!');
`);
  const freshFull = () => { fs.mkdirSync(path.join(S, '.studio', 'engine'), { recursive: true }); fs.writeFileSync(path.join(S, '.studio', 'engine', 'unity-rules.json'), JSON.stringify({ trees: {}, runs: [], lastFullAt: new Date().toISOString() })); };
  const AUTO = { root: 'Sim', paths: ['Sim/{name}/', 'Sim/{name}.meta', 'Tests/Sim/{name}', 'tools/port/{name}/'], filter: 'Category={name}' };
  const rulesCfg = (rlog, focusExtra = {}, extra = {}) => { const stub = `node "${fwd(rulesStub)}" "${fwd(rlog)}"`; return { test: `${stub} ALL`, focus: { test: `${stub} "{filter}"`, smoke: 'Category=Smoke', join: '|', split: true, ...focusExtra }, ...extra }; };
  const startFiles = { 'Sim/Fees/fees.cs': 'f\n', 'Sim/Loans/loans.cs': 'l\n', 'Tests/Sim/FeesTests.cs': 't\n', 'tools/port/fees/v.json': '{}\n' };

  // ================= 1. a batch that adds a new system: focus by convention, and no run of it on the target =================
  {
    resetState(); freshFull();
    const E = engineRepo({ 'feat/academy': { 'Sim/Academy/academy.cs': 'a\n', 'Sim/Academy.meta': 'm\n', 'Tests/Sim/AcademyTests.cs': 't\n', 'tools/port/academy/v.json': '{}\n' } }, { shared: startFiles });
    const ctl = path.join(T, 'ctl-new');
    const rlog = path.join(T, 'rules-new.jsonl');
    setEngines({ unity: cfgFor(E, ctl, { rules: rulesCfg(rlog, { auto: AUTO }) }) });
    queue(E, [['T-601', 'feat/academy']]);
    const r = probe(TRAIN);
    const rr = rulesRuns(rlog);
    const re = evs(/^engine\.rules$/)[0]?.meta || {};
    await guard('2.86 (c) rules.focus.auto: a batch that adds a new system folder (Sim/Academy, its .meta, its test file and its port folder; no map entry names it) runs in focus with Category=Academy and the smoke filter, each a part, and the land run is told the rules are green (fails before this fix: the new folder matched no rules.focus.map entry, so every port ran the full command twice)', () => [
      r.landed?.join() === 'T-601' && re.mode === 'focus' && /Category=Academy/.test(re.filter || '') && rr.every((x) => x.filter !== 'ALL') && rr.some((x) => x.filter === 'Category=Academy') && runsOf(ctl)[0]?.rulesGreen === '1',
      JSON.stringify({ r, rr, re }).slice(0, 2500)]);
    await guard('2.86 (c) a part new in the batch is not run on the target: Category=Academy ran only in a checkout that has Sim/Academy; the target ran the smoke part alone, and the log says the new part was not run there (fails before this fix: the target was always run first with the batch\'s whole command)', () => [
      rr.filter((x) => x.filter === 'Category=Academy').length === 1 && rr.filter((x) => x.filter === 'Category=Academy').every((x) => x.sims.includes('Academy'))
        && rr.filter((x) => !x.sims.includes('Academy')).map((x) => x.filter).join() === 'Category=Smoke' && r.logs.some((l) => /Category=Academy are new in the batch/.test(l)) && re.newParts === 1,
      JSON.stringify({ rr, logs: r.logs }).slice(0, 2500)]);
  }

  // ================= 2. hand-written entries win; a bad auto config is named; the rules.paths hint =================
  {
    resetState();
    const E = engineRepo({}, { shared: startFiles });
    setEngines({ unity: cfgFor(E, path.join(T, 'ctl-cfg'), { rules: rulesCfg(path.join(T, 'rules-cfg.jsonl'), { auto: AUTO, map: [{ match: '^(Sim/Dock/|tools/port/dock/)', filter: 'Category=DockNav|Category=Guest' }] }) }) });
    const x = probe(`import { rulesConfig, rulesSelection } from ${u('harness/engine-rules.mjs')};
const cfg = rulesConfig('unity', { root: process.cwd() });
const sel = rulesSelection({ changed: ['Sim/Dock/dock.cs', 'tools/port/dock/v.json', 'Sim/Fees/b.cs', 'Tests/Sim/MapNavTests.cs'], cfg, autoNames: ['Fees', 'Dock', 'Map', 'MapNav'] });
console.log(JSON.stringify({ mode: sel.mode, filters: sel.filters, why: sel.why }));`);
    await guard('2.86 (c) a hand-written rules.focus.map entry wins over rules.focus.auto: Sim/Dock and tools/port/dock take the entry\'s filter (Category=DockNav|Category=Guest), not the auto one (Category=Dock); Sim/Fees takes auto\'s; Tests/Sim/MapNavTests.cs is MapNav\'s, not Map\'s (the longest name wins) (fails before this fix: the entry\'s prefixes sit in a group its filter does not use, and a group with a slash made the entry match nothing, as a crew\'s 38 entries did; and Sim/Fees matched no map entry: a full run)', () => [
      x.mode === 'focus' && JSON.stringify(x.filters) === JSON.stringify(['Category=DockNav|Category=Guest', 'Category=Fees', 'Category=MapNav', 'Category=Smoke']), JSON.stringify(x).slice(0, 1500)]);
    const bads = [
      [{ root: 'Sim', paths: ['Sim/x/'], filter: 'Category={name}' }, /path template "Sim\/x\/" has no \{name\}/],
      ['yes', /it is not an object/],
      [{ root: '../Sim', paths: ['Sim/{name}/'], filter: 'Category={name}' }, /"root" "\.\.\/Sim" is not a folder inside the repo/],
      [{ root: 'Sim', paths: ['Sim/{name}/'], filter: 'Category=All' }, /"filter" must be a string with \{name\}/],
    ];
    const got = [];
    for (const [auto] of bads) {
      setEngines({ unity: cfgFor(E, path.join(T, 'ctl-cfg'), { rules: rulesCfg(path.join(T, 'rules-cfg.jsonl'), { auto, map: [] }) }) });
      got.push(probe(`import { rulesConfig, rulesSelection } from ${u('harness/engine-rules.mjs')};
const cfg = rulesConfig('unity', { root: process.cwd() });
const sel = rulesSelection({ changed: ['Sim/Fees/b.cs'], cfg, autoNames: ['Fees'] });
console.log(JSON.stringify({ bad: cfg.focusBad || [], focus: Boolean(cfg.focus), mode: sel.mode, why: sel.why }));`));
    }
    await guard('2.86 (c) a bad rules.focus.auto is named in plain words (a template with no {name}, not an object, a root outside the repo, a filter with no {name}), left out, and the run is full with the reason (fails before this fix: the setting was not read, so nothing said what was wrong)', () => [
      got.every((g, i) => g.bad.length === 1 && bads[i][1].test(g.bad[0]) && /rules\.focus\.auto is not usable/.test(g.bad[0]) && g.mode === 'full' && /rules\.focus\.auto is not usable/.test(g.why)), JSON.stringify(got).slice(0, 2500)]);
    setEngines({ unity: cfgFor(E, path.join(T, 'ctl-cfg'), { rules: rulesCfg(path.join(T, 'rules-cfg.jsonl'), { auto: AUTO }) }) });
    const h = probe(`import { rulesConfig, rulesSelection } from ${u('harness/engine-rules.mjs')};
const cfg = rulesConfig('unity', { root: process.cwd() });
const ui = rulesSelection({ changed: ['Art/Lights.meta', 'Ui/Panel.cs'], cfg, autoNames: ['Fees'] });
const mixed = rulesSelection({ changed: ['Art/Lights.meta', 'Sim/Common.cs'], cfg, autoNames: ['Fees'] });
console.log(JSON.stringify({ ui: [ui.mode, ui.why], mixed: [mixed.mode, mixed.why] }));`);
    await guard('2.86 (c) paths the check cannot read: a batch changing only art and UI paths (under no map entry and no auto root) still runs in full, and its why names the one setting that would have skipped it, rules.paths; a batch with an unmapped path under the auto root does not get that hint (fails before this fix: the why named only the unmapped paths)', () => [
      h.ui?.[0] === 'full' && /rules\.paths is not set/.test(h.ui[1]) && h.mixed?.[0] === 'full' && !/rules\.paths is not set/.test(h.mixed[1]), JSON.stringify(h).slice(0, 1500)]);
  }

  // ================= 3. a second train on the same target: kept parts are not calibrated again =================
  {
    resetState(); freshFull();
    const E = engineRepo({ 'feat/a': { 'Sim/Fees/a.cs': 'a\n' } }, { shared: startFiles });
    fs.appendFileSync(path.join(E.R, '.git', 'info', 'exclude'), 'Rules~/\n');
    write(E.R, 'Rules~/fees/f.json', '{"fee":1}\n');
    write(E.R, 'Rules~/loans/l.json', '{"rate":1}\n');
    const ctl = path.join(T, 'ctl-second');
    const rlog = path.join(T, 'rules-second.jsonl');
    setEngines({ unity: cfgFor(E, ctl, { rules: rulesCfg(rlog, { auto: { ...AUTO, inputs: ['Rules~/{name}/'] } }, { inputs: ['Rules~'] }) }) });
    queue(E, [['T-611', 'feat/a']]);
    const r1 = probe(TRAIN);
    const n1 = rulesRuns(rlog).length;
    // Another system's inputs change (a port elsewhere), then a second branch of the same system on the new target.
    write(E.R, 'Rules~/loans/l.json', '{"rate":2}\n');
    g(E.R, 'checkout', '-q', '-B', 'feat/b', 'port/main'); write(E.R, 'Sim/Fees/b.cs', 'b\n'); g(E.R, 'add', '-A'); g(E.R, 'commit', '-qm', 'b'); g(E.R, 'checkout', '-q', 'dev');
    E.heads['feat/b'] = g(E.R, 'rev-parse', 'feat/b').stdout.trim();
    fs.writeFileSync(evFile, '');
    queue(E, [['T-612', 'feat/b']]);
    const r2 = probe(TRAIN);
    const rr2 = rulesRuns(rlog).slice(n1);
    await guard('2.86 (c) a second train on the same target runs no calibration for a kept part although the inputs changed for another system: the first train ran Category=Fees on the target and the batch; after Rules~/loans changed, the second train runs Category=Fees once (its batch) and says the target\'s Fees part is kept; the smoke part (it reads everything) runs again (fails before this fix: the key held every input, so the target was run again in full every train)', () => [
      r1.landed?.join() === 'T-611' && r2.landed?.join() === 'T-612' && rr2.filter((x) => x.filter === 'Category=Fees').length === 1 && rr2.filter((x) => x.filter === 'ALL').length === 0
        && r2.logs.some((l) => /rules part Category=Fees pass kept for .*the target/.test(l)) && (r2.rules?.reused || 0) >= 1,
      JSON.stringify({ n1, rr2, r2 }).slice(0, 2500)]);
  }

  // ================= 4. a red batch: only the red part runs while narrowing =================
  {
    resetState(); freshFull();
    const E = engineRepo({ 'feat/a': { 'Sim/Fees/a.cs': 'a\n' }, 'feat/b': { 'Sim/Loans/b.cs': 'b\n' }, 'feat/c': { 'Sim/Fees/c.cs': 'c\n', 'Sim/Fees/rules-bad.txt': 'Category=Fees\n' }, 'feat/d': { 'Sim/Bonds/d.cs': 'd\n' } }, { shared: startFiles });
    const ctl = path.join(T, 'ctl-red');
    const rlog = path.join(T, 'rules-red.jsonl');
    setEngines({ unity: cfgFor(E, ctl, { rules: rulesCfg(rlog, { auto: AUTO }) }) });
    queue(E, [['T-621', 'feat/a'], ['T-622', 'feat/b'], ['T-623', 'feat/c'], ['T-624', 'feat/d']]);
    const r = probe(TRAIN);
    const rr = rulesRuns(rlog);
    // The batch's run is the first one with Sim/Bonds in it; the narrowing runs are the ones without Sim/Bonds after it.
    const firstBatch = rr.findIndex((x) => x.sims.includes('Bonds'));
    const narrowing = rr.slice(firstBatch).filter((x) => !x.sims.includes('Bonds'));
    await guard('2.86 (c) a red batch re-runs only the red part while narrowing: the batch is red in Category=Fees; every prefix runs Category=Fees alone (never Loans, Bonds or the smoke filter), T-623 is handed back naming the part, the other three land; after the drop the parts kept green are not run again (fails before this fix: every prefix ran the whole check)', () => [
      r.dropped?.length === 1 && r.dropped[0].task === 'T-623' && /part Category=Fees/.test(r.dropped[0].why) && r.landed?.join() === 'T-621,T-622,T-624'
        && narrowing.length >= 1 && narrowing.every((x) => x.filter === 'Category=Fees') && rr.filter((x) => x.filter === 'Category=Bonds').length === 1,
      JSON.stringify({ rr, r }).slice(0, 2500)]);
  }

  // ================= 5. rules-plan: the plan, and nothing runs =================
  {
    resetState(); freshFull();
    const E = engineRepo({ 'feat/a': { 'Sim/Fees/a.cs': 'a\n' }, 'feat/n': { 'Sim/Docks/n.cs': 'n\n' } }, { shared: startFiles });
    const rlog = path.join(T, 'rules-plan.jsonl');
    setEngines({ unity: cfgFor(E, path.join(T, 'ctl-plan'), { rules: rulesCfg(rlog, { auto: AUTO }) }) });
    const tip0 = g(E.R, 'rev-parse', 'port/main').stdout.trim();
    const p = spawnSync(process.execPath, [path.join(S, 'harness', 'engine.mjs'), 'rules-plan', '--branch', 'feat/a', '--branch', 'feat/n'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 120000 });
    const text = out(p);
    await guard('2.86 (c) npm run engine -- rules-plan --branch a --branch b prints the plan and runs nothing: focus and why, each part (Category=Fees runs on the target and the batch; Category=Docks is new in the batch; the smoke part), the expected minutes; no rules test ran and no branch moved (fails before this fix: there was no rules-plan command)', () => [
      p.status === 0 && /Rules check plan for feat\/a \+ feat\/n/.test(text) && /: focus/.test(text) && /Category=Fees: target runs; batch runs/.test(text) && /Category=Docks: target new in the batch/.test(text) && /Category=Smoke/.test(text) && /expected:/.test(text)
        && rulesRuns(rlog).length === 0 && g(E.R, 'rev-parse', 'port/main').stdout.trim() === tip0 && g(E.R, 'branch', '--list', 'unity/*').stdout.trim() === '',
      text.slice(0, 2500)]);
  }

  // ================= 6. without the new settings: the 2.85 keys and runs =================
  {
    resetState(); freshFull();
    const E = engineRepo({ 'feat/a': { 'Sim/Fees/a.cs': 'a\n' } }, { shared: startFiles });
    const ctl = path.join(T, 'ctl-old');
    const rlog = path.join(T, 'rules-old.jsonl');
    const rc = rulesCfg(rlog, { map: [{ match: '^Sim/([A-Za-z]+)/', filter: 'Category=$1' }] });
    setEngines({ unity: cfgFor(E, ctl, { rules: rc }) });
    queue(E, [['T-631', 'feat/a']]);
    const r = probe(TRAIN);
    const rr = rulesRuns(rlog);
    const kept = JSON.parse(fs.readFileSync(path.join(S, '.studio', 'engine', 'unity-rules.json'), 'utf8'));
    await guard('2.86 (c) without rules.focus.auto or rules.focus.shared nothing changes: the map-only check runs the target then the batch with the same parts as 2.85 (Fees, smoke; twice), keeps whole-tree keys only (no per-part results), and the event has no reuse count (a guard of unchanged behaviour: it holds before and after this change)', () => [
      r.landed?.join() === 'T-631' && rr.map((x) => x.filter).join() === 'Category=Fees,Category=Smoke,Category=Fees,Category=Smoke' && !kept.parts && Object.keys(kept.trees).length === 2
        && Object.keys(kept.trees).every((x) => /^[0-9a-f]{40}\|[0-9a-f]{12}\|focus:[0-9a-f]{12}$/.test(x)) && evs(/^engine\.rules$/)[0]?.meta?.reused === undefined,
      JSON.stringify({ rr, keys: Object.keys(kept.trees), r }).slice(0, 2500)]);
  }
}
