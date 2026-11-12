/**
 * qa/selftest-284t.mjs — 2.84 (t): the engine train's land runs: read the failing tests from the results files, blame
 * by a test's namespace, retry only what failed, skip Play Mode by risk, compile first, retry a land the operating
 * system killed, and bound the rules check's memory (one command per focus group, slices of a big batch).
 *
 * A crew measured one day on 2.83: 16 branches cost about 9 hours of train time; 23 land runs, 35% passed; a passing
 * run took 51 minutes. The scaffolding (a studio copy, a made-up engine repo, a stand-in land script that records what
 * it was told) is qa/selftest-283b.mjs's and qa/selftest-284h.mjs's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest284T({ dir, root, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const T = path.join(tmpRoot, `s284t-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const harnessRoot = root || dir;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-284t-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file, engine settings) ----
  const S = path.join(tmpRoot, `284t-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(S, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* the checks below need no package */ }
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-284t.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const evs = (re) => events().filter((e) => re.test(e.type));
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-284t-${++pn}.mjs`);
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
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, only: E.STUDIO_LAND_ONLY ?? null, retry: E.STUDIO_LAND_RETRY ?? null, retryStage: E.STUDIO_LAND_RETRY_STAGE ?? null, retryTests: E.STUDIO_LAND_RETRY_TESTS ?? null, rulesGreen: E.STUDIO_RULES_GREEN ?? null, playMode: E.STUDIO_PLAY_MODE ?? null, playFilter: E.STUDIO_PLAY_FILTER ?? null, playArgs: E.STUDIO_UNITY_PLAYMODE_ARGS ?? null }) + '\\n');
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
  const TRAIN = `import { runUnityTrain, readUnityQueue } from ${u('harness/unity-train.mjs')};
const handed = []; const logs = [];
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps: { handBack: (lane, note, extra) => handed.push({ task: lane.task, note, extra: extra || null }) } });
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, compileRuns: r.compileRuns || 0, landed: r.landed, dropped: r.dropped, deferred: r.deferred, flaky: r.flaky || null, killed: r.killed || null, cancelled: r.cancelled || null, playMode: r.playMode ?? null, rules: r.rules || null, handed, logs: logs.filter((l) => /STUDIO_LAND_ONLY|killed|cancel|slice|play stage skipped|not safe/.test(l)), queue: readUnityQueue(process.cwd()).map((e) => e.task) }));`;
  const rev = (s) => `rev:${s.split('').reverse().join('')}`;

  // ================= 1. failing tests from the results files =================
  for (const mode of ['xml', 'json']) {
    resetState();
    const TEST = 'Game.Economy.Tests.FeesTests.AddsUpOnPayday';
    const E = engineRepo({ 'feat/a': { 'Assets/Hangar/Doors.cs': 'class Doors {}\n' }, 'feat/b': { 'Assets/Economy/Tests/FeesTests.cs': 'namespace Game.Economy.Tests { public class FeesTests {} }\n', 'edit-bad.txt': `${rev(TEST)}\n` }, 'feat/c': { 'Assets/Ui/Menu.cs': 'class Menu {}\n' } });
    const ctl = path.join(T, `ctl-results-${mode}`);
    fs.writeFileSync(`${ctl}-names`, mode);
    // A results file from before this land run, with another failing test: it must not count.
    const old = path.join(E.GW, 'TestResults-old.xml');
    fs.writeFileSync(old, '<test-run><test-case id="9" name="Stale" fullname="Game.Hangar.Tests.Old.Stale" result="Failed"></test-case></test-run>\n');
    const hourAgo = new Date(Date.now() - 3600000);
    fs.utimesSync(old, hourAgo, hourAgo);
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-301', 'feat/a'], ['T-302', 'feat/b'], ['T-303', 'feat/c']]);
    const r = probe(TRAIN);
    const d = (r.dropped || [])[0] || {};
    const ev = evs(/^task\.train\.unity\.evidence$/)[0];
    await guard(`2.84 (t) failing tests from ${mode === 'xml' ? 'an NUnit results file the land leaves (Unity\'s default place, TestResults*.xml in the gate worktree)' : 'the "failures" list of the land\'s stage report (STUDIO_LAND_RESULT)'}: the land prints only a summary, the train still reads ${TEST}, blames T-302 by evidence and lands T-301 and T-303 on the second run; an older results file from before the run (Game.Hangar.Tests.Old.Stale) is ignored (fails before this fix: no test name was found in the output, so the train searched by land runs: four runs)`, () => [
      r.landed?.slice().sort().join() === 'T-301,T-303' && r.runs === 2 && r.dropped?.length === 1 && d.task === 'T-302' && d.cause === 'evidence' && d.why.includes(TEST) && !d.why.includes('Old.Stale')
        && ev && ev.meta?.tests?.join() === TEST && ev.meta.suspect === 'T-302',
      JSON.stringify({ r, ev: ev?.meta }).slice(0, 2500)]);
  }
  {
    const r = probe(`import { resultFiles, resultFailures, nunitFailures } from ${u('harness/unity-gate.mjs')};
import fs from 'node:fs'; import path from 'node:path';
const b = ${JSON.stringify(path.join(T, 'results-glob'))};
fs.mkdirSync(path.join(b, 'Logs'), { recursive: true }); fs.mkdirSync(path.join(b, 'out', 'a'), { recursive: true });
fs.writeFileSync(path.join(b, 'Logs', 'play-results.xml'), '<test-case fullname="A.B.Play" result="Error"/><test-case fullname="A.B.Ok" result="Passed"/>');
fs.writeFileSync(path.join(b, 'out', 'a', 'edit.xml'), '<test-case name="E" fullname="A.B.Edit" result="Failed">');
fs.writeFileSync(path.join(b, 'Logs', 'other.txt'), 'x');
const files = resultFiles(['Logs/*results*.xml', ${JSON.stringify(fwd(path.join(T, 'results-glob')))} + '/out/*/edit.xml', 'missing/*.xml'], { base: b, sinceMs: Date.now() - 60000 });
const none = resultFiles(['Logs/*results*.xml'], { base: b, sinceMs: Date.now() + 3600000 });
console.log(JSON.stringify({ n: files.length, names: resultFailures(files), none: none.length, err: nunitFailures('<test-case fullname="X.Y.Z" result="Error"><test-case fullname="X.Y.W" result="Skipped">') }));`);
    await guard('2.84 (t) results files, the reader: relative and absolute patterns with * in one segment find the files, result="Failed" and result="Error" both count, Passed and Skipped do not, and a file older than the run is left out (fails before this fix: there was no results reader)', () => [
      r.n === 2 && r.names?.join() === 'A.B.Edit,A.B.Play' && r.none === 0 && r.err?.join() === 'X.Y.Z', JSON.stringify(r).slice(0, 1500)]);
  }

  // ================= 2. evidence by namespace or class file =================
  {
    resetState();
    const TEST = 'Game.Hangar.Tests.DoorTimingTests.OpensOnTime';
    const E = engineRepo({
      'feat/a': { 'Assets/Economy/Fees.cs': 'class Fees {}\n' },
      'feat/b': { 'Assets/Hangar/Tests/DoorHelpers.cs': 'namespace Game.Hangar.Tests\n{\n  static class DoorHelpers { }\n}\n', 'edit-bad.txt': `${rev(TEST)}\n` },
      'feat/c': { 'Assets/Economy/Tests/LoansTests.cs': 'namespace Game.Economy.Tests { class LoansTests {} }\n' },
    });
    const ctl = path.join(T, 'ctl-namespace');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-311', 'feat/a'], ['T-312', 'feat/b'], ['T-313', 'feat/c']]);
    const r = probe(TRAIN);
    const d = (r.dropped || [])[0] || {};
    const ev = evs(/^task\.train\.unity\.evidence$/)[0];
    const note = (r.handed || [])[0]?.note || '';
    await guard('2.84 (t) evidence by namespace: the failing test\'s class (DoorTimingTests) is in no file a lane changes, but only T-312 changes a test file declaring its namespace Game.Hangar.Tests; the train runs the batch without T-312, lands T-311 and T-313 on that run, and the hand-back note and the evidence event both name the test, the suspect, the file that ties them and the red stage (fails before this fix: the class rule found nothing and the train searched by land runs: four runs)', () => [
      r.landed?.slice().sort().join() === 'T-311,T-313' && r.runs === 2 && d.task === 'T-312' && d.cause === 'evidence'
        && note.includes(TEST) && note.includes('T-312') && note.includes('Assets/Hangar/Tests/DoorHelpers.cs') && /in its edit stage/.test(note)
        && ev?.meta?.suspect === 'T-312' && ev.meta.tests?.join() === TEST && ev.meta.files?.includes('Assets/Hangar/Tests/DoorHelpers.cs') && ev.meta.stage === 'edit' && ev.meta.rule === 'namespace',
      JSON.stringify({ r, ev: ev?.meta }).slice(0, 2500)]);
  }
  {
    resetState();
    const TEST = 'Game.Hangar.Tests.DoorTimingTests.OpensOnTime';
    const E = engineRepo({
      'feat/a': { 'Assets/Hangar/Tests/RampTests.cs': 'namespace Game.Hangar.Tests { class RampTests {} }\n' },
      'feat/b': { 'Assets/Hangar/Tests/DoorHelpers.cs': 'namespace Game.Hangar.Tests { static class DoorHelpers {} }\n', 'edit-bad.txt': `${rev(TEST)}\n` },
    });
    const ctl = path.join(T, 'ctl-namespace-two');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-316', 'feat/a'], ['T-317', 'feat/b']]);
    const r = probe(TRAIN);
    const bis = evs(/^task\.train\.unity\.bisect$/);
    await guard('2.84 (t) evidence by namespace, two lanes in the namespace: no single suspect, so no evidence run; the search by land runs starts and its bisect event says which tests were red (fails before this fix: the bisect event named no test)', () => [
      evs(/^task\.train\.unity\.evidence$/).length === 0 && r.dropped?.[0]?.task === 'T-317' && bis.length >= 1 && bis.every((e) => e.meta?.tests?.includes(TEST) && e.msg.includes(`red: ${TEST}`)),
      JSON.stringify({ r, bis: bis.map((e) => [e.msg, e.meta]) }).slice(0, 2500)]);
  }

  // ================= 3. retry only what failed =================
  {
    resetState();
    const TEST = 'Game.PlayTests.Hangar.DoorsOpenOnArrival';
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n' } });
    const ctl = path.join(T, 'ctl-retry-names');
    fs.writeFileSync(`${ctl}-flaky`, `1 play ${TEST}`);
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-321', 'feat/a'], ['T-322', 'feat/b']]);
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    const fe = evs(/^task\.train\.unity\.flaky$/)[0];
    await guard('2.84 (t) retry only what failed: a batch red in Play Mode on one named test is run again with STUDIO_LAND_RETRY=1, STUDIO_LAND_RETRY_STAGE=play, STUDIO_LAND_RETRY_TESTS=<the name> and STUDIO_UNITY_PLAYMODE_ARGS=-testFilter "<the name>"; it passes, both lanes land, the flaky event carries the test (fails before this fix: the whole land ran again with none of these variables)', () => [
      r.landed?.join() === 'T-321,T-322' && r.runs === 2 && runs.length === 2 && runs[0].retry === null && runs[0].retryTests === null
        && runs[1].retry === '1' && runs[1].retryStage === 'play' && runs[1].retryTests === TEST && runs[1].playArgs === `-testFilter "${TEST}"` && fe?.meta?.tests?.join() === TEST,
      JSON.stringify({ r, runs, fe: fe?.meta }).slice(0, 2500)]);
  }
  {
    resetState();
    const TEST = 'Game.PlayTests.Doors.Opens(1,2)';
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } });
    const ctl = path.join(T, 'ctl-retry-unsafe');
    fs.writeFileSync(`${ctl}-flaky`, `1 play ${TEST}`);
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-326', 'feat/a']]);
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    await guard('2.84 (t) retry, an unsafe name: a failed test whose name holds a comma (a parameterized case) is not put on a command line: the retry is the whole land as in 2.83 (no STUDIO_LAND_RETRY*, no Unity filter), and it says so (fails before this fix: there was no retry by name to fall back from)', () => [
      r.landed?.join() === 'T-326' && runs.length === 2 && runs[1].retry === null && runs[1].retryTests === null && runs[1].playArgs === null && r.flaky?.length === 1 && r.logs?.some((l) => /not safe on a command line/.test(l)),
      JSON.stringify({ r, runs }).slice(0, 2000)]);
  }
  {
    resetState();
    const TEST = 'Game.Tests.Clock.TicksOnTime';
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n' } });
    const ctl = path.join(T, 'ctl-retry-known');
    fs.writeFileSync(`${ctl}-flaky`, `1 edit ${TEST}`);
    setEngines({ unity: cfgFor(E, ctl, { flakyTests: ['Game.Tests.Clock.*', 'Other.Exact.Name'] }) });
    queue(E, [['T-331', 'feat/a'], ['T-332', 'feat/b']]);
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    await guard('2.84 (t) engines.<x>.flakyTests: a batch red in Edit Mode (not a retry stage) whose only failure matches a listed prefix (Game.Tests.Clock.*) is retried with that test named (no Play Mode filter for an edit stage), passes, and lands; nobody is handed back (fails before this fix: an edit-stage red was never retried, so the train searched by land runs)', () => [
      r.landed?.join() === 'T-331,T-332' && r.runs === 2 && !r.dropped?.length && runs[1]?.retry === '1' && runs[1].retryStage === 'edit' && runs[1].retryTests === TEST && runs[1].playArgs === null && r.flaky?.[0]?.known === true,
      JSON.stringify({ r, runs }).slice(0, 2000)]);
  }
  {
    const r = probe(`import { engineFlow, engineText } from ${u('harness/score.mjs')};
const land = (mode) => ({ type: 'engine.land', ts: '2026-11-12T10:00:00Z', meta: { status: 'pass', ms: 600000, ...(mode ? { playMode: mode } : {}), stages: mode === 'skip' ? [{ name: 'edit', status: 'pass', seconds: 300 }] : [{ name: 'play', status: 'pass', seconds: 600 }] } });
const fl = (tests) => ({ type: 'task.train.unity.flaky', ts: '2026-11-12T10:00:00Z', meta: { tests } });
const en = engineFlow([land('focus'), land(null), land('skip'), land('skip'), fl(['A.B.Slow', 'A.B.Other']), fl(['A.B.Slow']), fl(['A.B.Slow'])]);
console.log(JSON.stringify({ play: en.play, flaky: en.flaky, lines: engineText(en).filter((l) => /Play stage|Flaky retries/.test(l)) }));`);
    await guard('2.84 (t) scorecard: "Flaky retries: N (top: <test> ×k)" counts the engine trains\' flaky events and the test seen most; the Play stage line counts the land runs told to skip it (fails before this fix: neither was counted)', () => [
      r.flaky?.retries === 3 && r.flaky.top?.test === 'A.B.Slow' && r.flaky.top.times === 3 && r.play?.skipped === 2 && r.play.focused === 1 && r.play.full === 1
        && r.lines?.[0] === '  Play stage: 1 focused, 1 full, 2 skipped; median minutes focused 10, full 10' && r.lines?.[1] === '  Flaky retries: 3 (top: A.B.Slow ×3)',
      JSON.stringify(r).slice(0, 1500)]);
  }

  // ================= 4. Play Mode by risk: skip =================
  {
    const r = probe(`import { playSelection } from ${u('harness/engine-rules.mjs')};
const cfg = { play: { focus: { map: [{ match: '^Assets/Scripts/([A-Za-z]+)/', filter: 'Game.PlayTests.$1' }], smoke: 'Game.PlayTests.Smoke', skip: ['^Assets/Sim/', '^tools/rules-port/'], ignore: ['\\\\.md$'] } } };
const only = { play: { focus: { skip: ['^Assets/Sim/'] } } };
console.log(JSON.stringify({
  skip: playSelection({ changed: ['Assets/Sim/Fees.cs', 'tools/rules-port/x.py', 'README.md'], cfg }),
  fullRun: playSelection({ changed: ['Assets/Sim/Fees.cs'], cfg, full: true, fullWhy: 'a full land run' }),
  mixed: playSelection({ changed: ['Assets/Sim/Fees.cs', 'Assets/Scripts/Hangar/Doors.cs'], cfg }),
  focus: playSelection({ changed: ['Assets/Scripts/Hangar/Doors.cs'], cfg }),
  skipOnly: playSelection({ changed: ['Assets/Sim/Fees.cs'], cfg: only }),
  skipOnlyOther: playSelection({ changed: ['Assets/Scenes/Main.unity'], cfg: only }),
}));`);
    await guard('2.84 (t) play.focus.skip, the decision: every changed path (after ignore) matching a skip pattern gives mode "skip"; never on a full land run; one path outside skip goes on to the focus map as before (here: no map entry, so full); focus still works; a config with only skip works (fails before this fix: there was no skip mode)', () => [
      r.skip?.mode === 'skip' && r.skip.filter === '' && r.fullRun?.mode === 'full' && r.mixed?.mode === 'full' && r.focus?.mode === 'focus' && r.focus.filter === 'Game.PlayTests.Hangar;Game.PlayTests.Smoke'
        && r.skipOnly?.mode === 'skip' && r.skipOnlyOther?.mode === 'full',
      JSON.stringify(r).slice(0, 2000)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'Assets/Sim/Fees.cs': 'class Fees {}\n' }, 'feat/b': { 'tools/rules-port/port.py': 'x = 1\n' } });
    const ctl = path.join(T, 'ctl-skip');
    setEngines({ unity: cfgFor(E, ctl, { play: { focus: { map: [{ match: '^Assets/Scripts/([A-Za-z]+)/', filter: 'Game.PlayTests.$1' }], skip: ['^Assets/Sim/', '^tools/rules-port/'] } } }) });
    queue(E, [['T-341', 'feat/a'], ['T-342', 'feat/b']]);
    const r = probe(TRAIN, { STUDIO_PLAY_FILTER: 'Leaked', STUDIO_UNITY_PLAYMODE_ARGS: '-testFilter "Leaked"' });
    const runs = runsOf(ctl);
    const le = evs(/^engine\.land$/);
    await guard('2.84 (t) play.focus.skip through the engine train: a batch whose every path matches skip lands with STUDIO_PLAY_MODE=skip and neither STUDIO_PLAY_FILTER nor STUDIO_UNITY_PLAYMODE_ARGS (even when the train\'s environment held them); engine.land says playMode skip (fails before this fix: the play stage was told full)', () => [
      r.landed?.join() === 'T-341,T-342' && runs.length === 1 && runs[0].playMode === 'skip' && runs[0].playFilter === null && runs[0].playArgs === null && r.playMode === 'skip' && le.length === 1 && le[0].meta?.playMode === 'skip',
      JSON.stringify({ r, runs, le: le.map((e) => e.meta) }).slice(0, 2000)]);
  }

  // ================= 5. compile first =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n' } });
    const ctl = path.join(T, 'ctl-compile-green');
    setEngines({ unity: cfgFor(E, ctl, { compileFirst: true }) });
    queue(E, [['T-351', 'feat/a'], ['T-352', 'feat/b']]);
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    const ce = evs(/^task\.train\.unity\.compile$/);
    const le = evs(/^engine\.land$/);
    await guard('2.84 (t) compile first, green: with engines.unity.compileFirst the land command runs once with STUDIO_LAND_ONLY=compile (and the other variables, here STUDIO_PLAY_MODE), then the real land run without it; one compile event (pass, seconds), one engine.land event whose stages begin with compile (fails before this fix: there was no compile run)', () => [
      r.landed?.join() === 'T-351,T-352' && r.runs === 1 && r.compileRuns === 1 && runs.length === 2 && runs[0].only === 'compile' && runs[0].playMode === 'full' && runs[1].only === null
        && ce.length === 1 && ce[0].meta?.status === 'pass' && Number.isFinite(ce[0].meta.seconds) && le.length === 1 && le[0].meta?.stages?.[0]?.name === 'compile',
      JSON.stringify({ r, runs, ce: ce.map((e) => e.meta), le: le.map((e) => e.meta) }).slice(0, 2500)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'Assets/Scripts/Broken.cs': 'class Broken { int x }\n', 'compile-bad.txt': 'Assets/Scripts/Broken.cs(1,22): error CS1002: ; expected\n' } });
    const ctl = path.join(T, 'ctl-compile-red');
    setEngines({ unity: cfgFor(E, ctl, { compileFirst: true }) });
    queue(E, [['T-356', 'feat/a'], ['T-357', 'feat/b']]);
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    const full = runs.filter((x) => x.only === null);
    const d = (r.dropped || [])[0] || {};
    await guard('2.84 (t) compile first, red: the compile run of the batch is red on a compiler error in a file only T-357 changes; T-357 is handed back by evidence naming the file and the compile check, and the only full land run is T-356\'s, alone (fails before this fix: the batch\'s compile error cost a full land run)', () => [
      r.landed?.join() === 'T-356' && d.task === 'T-357' && d.cause === 'evidence' && /compile check/.test(d.why) && /Broken\.cs/.test(d.why) && full.length === 1 && full[0].srcs.join() === 'feat/a' && r.runs === 1,
      JSON.stringify({ r, runs }).slice(0, 2500)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n', 'edit-bad.txt': `${rev('Zz.Qq.Ww')}\n` }, 'feat/c': { 'c.txt': 'c\n' } });
    const ctl = path.join(T, 'ctl-compile-unknown');
    fs.writeFileSync(`${ctl}-compile`, 'unknown');
    setEngines({ unity: cfgFor(E, ctl, { compileFirst: true }) });
    queue(E, [['T-361', 'feat/a'], ['T-362', 'feat/b'], ['T-363', 'feat/c']]);
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    const ignored = evs(/^task\.train\.unity\.compile$/).filter((e) => e.meta?.status === 'ignored');
    await guard('2.84 (t) compile first, a land script that does not honour it: the compile-only run exits 9 (a code the land contract does not name); the train logs once that the script does not honour STUDIO_LAND_ONLY, goes on with the real land run, and asks no more in this train though the search runs the land again (fails before this fix: there was no compile run)', () => [
      runs.filter((x) => x.only === 'compile').length === 1 && runs.length >= 3 && ignored.length === 1 && r.logs?.filter((l) => /does not honour STUDIO_LAND_ONLY/.test(l)).length === 1 && r.dropped?.[0]?.task === 'T-362' && r.landed?.length === 2,
      JSON.stringify({ r, runs }).slice(0, 2500)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n' } });
    const ctl = path.join(T, 'ctl-compile-ignore');
    fs.writeFileSync(`${ctl}-compile`, 'ignore');
    setEngines({ unity: cfgFor(E, ctl, { compileFirst: true }) });
    queue(E, [['T-366', 'feat/a'], ['T-367', 'feat/b']]);
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    await guard('2.84 (t) compile first, a land script that lands anyway: the "compile" run landed the batch; the train sees the target holds both branches, counts it as the land run, closes both and says the script does not honour STUDIO_LAND_ONLY (fails before this fix: there was no compile run)', () => [
      r.landed?.join() === 'T-366,T-367' && runs.length === 1 && runs[0].only === 'compile' && r.runs === 1 && r.logs?.some((l) => /does not honour STUDIO_LAND_ONLY.*landed the branches/.test(l)),
      JSON.stringify({ r, runs }).slice(0, 2000)]);
  }

  // ================= 6. a land killed by the operating system =================
  {
    const r = probe(`import { mapUnityExit } from ${u('harness/unity-gate.mjs')};
console.log(JSON.stringify({ reboot: mapUnityExit(1073807364).status, ctrlc: mapUnityExit(3221225786).status, sigkill: mapUnityExit(null, { signal: 'SIGKILL' }).status, sigterm: mapUnityExit(null, { signal: 'SIGTERM' }).status,
  timeout: mapUnityExit(null, { signal: 'SIGTERM', timedOut: true, timeoutMin: 5 }).status, hup: mapUnityExit(null, { signal: 'SIGHUP' }).status, own: mapUnityExit(77, { killedExits: [77] }).status, ownOff: mapUnityExit(1073807364, { killedExits: [] }).status,
  contract: mapUnityExit(1073807364, { exits: { 1: { status: 'red' } } }).status, contractNamed: mapUnityExit(1073807364, { exits: { 1073807364: { status: 'error', why: 'x' } } }).status }));`);
    await guard('2.84 (t) killed, the mapping: exit 0x40010004 (a reboot) and 0xC000013A, and SIGKILL or SIGTERM the harness did not send by a time-out, are "killed"; a time-out stays an error; engines.<x>.killedExits replaces the list; a land contract that names the code wins (fails before this fix: all were "error")', () => [
      r.reboot === 'killed' && r.ctrlc === 'killed' && r.sigkill === 'killed' && r.sigterm === 'killed' && r.timeout === 'error' && r.hup === 'error' && r.own === 'killed' && r.ownOff === 'error' && r.contract === 'killed' && r.contractNamed === 'error',
      JSON.stringify(r)]);
  }
  for (const [times, name] of [[1, 'once'], [2, 'twice']]) {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n' } });
    const ctl = path.join(T, `ctl-killed-${name}`);
    fs.writeFileSync(`${ctl}-kill`, `${times} 77`);
    setEngines({ unity: cfgFor(E, ctl, { killedExits: [77] }) });
    queue(E, [['T-371', 'feat/a'], ['T-372', 'feat/b']]);
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    const kr = evs(/^task\.train\.unity\.killed_retry$/);
    const kd = evs(/^task\.train\.unity\.killed$/);
    if (times === 1) {
      await guard('2.84 (t) killed once: a land run that exits with a killed code is tried once more (task.train.unity.killed_retry, after STUDIO_ENGINE_KILLED_RETRY_SEC) and lands both branches; nobody is handed back (fails before this fix: "nobody is blamed", the train ended and every branch waited for another train)', () => [
        r.landed?.join() === 'T-371,T-372' && runs.length === 2 && kr.length === 1 && !r.dropped?.length && !r.handed?.length,
        JSON.stringify({ r, runs, kr: kr.length }).slice(0, 2000)]);
    } else {
      await guard('2.84 (t) killed twice: the retry is killed too; the train ends with both branches still queued, nobody handed back, a task.train.unity.killed event and the result\'s killed record (fails before this fix: no retry, and a kill was an "error")', () => [
        !r.landed?.length && runs.length === 2 && kr.length === 1 && kd.length === 1 && !r.handed?.length && r.queue?.join() === 'T-371,T-372' && r.killed && r.deferred?.length === 2,
        JSON.stringify({ r, runs, kr: kr.length, kd: kd.length }).slice(0, 2000)]);
    }
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } });
    const ctl = path.join(T, 'ctl-cancel');
    fs.writeFileSync(`${ctl}-cancel`, '1');
    setEngines({ unity: cfgFor(E, ctl, { killedExits: [77] }) });
    queue(E, [['T-376', 'feat/a']]);
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    await guard('2.84 (t) killed by a person\'s cancel: the cancel file (.studio/train/unity-cancel.json) names this train, so the killed run is not retried; the lane stays queued, nobody is handed back, and a task.train.unity.cancelled event is written (fails before this fix: the cancel file was not read)', () => [
      runs.length === 1 && evs(/^task\.train\.unity\.killed_retry$/).length === 0 && evs(/^task\.train\.unity\.cancelled$/).length === 1 && r.queue?.join() === 'T-376' && !r.handed?.length && r.cancelled,
      JSON.stringify({ r, runs }).slice(0, 2000)]);
  }

  // ================= 7. the rules check's memory =================
  const rulesStub = path.join(T, 'rules-stub.mjs');
  fs.writeFileSync(rulesStub, `import fs from 'node:fs';
const [log, filter] = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify({ filter: filter ?? null, lanes: fs.readdirSync('.').filter((n) => /^lane-/.test(n)).sort() }) + '\\n');
if (fs.existsSync('rules-bad.txt')) { console.log('  Failed Rules.Economy.FeesAddUp [3 ms]'); console.log('1 test failed'); process.exit(1); }
console.log('Passed!');
`);
  const rulesRuns = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'Sim/Fees/a.cs': 'a\n' }, 'feat/b': { 'Sim/Loans/b.cs': 'b\n' } });
    const ctl = path.join(T, 'ctl-split');
    const rlog = path.join(T, 'rules-split.jsonl');
    fs.mkdirSync(path.join(S, '.studio', 'engine'), { recursive: true });
    fs.writeFileSync(path.join(S, '.studio', 'engine', 'unity-rules.json'), JSON.stringify({ trees: {}, runs: [], lastFullAt: new Date().toISOString() }));
    const stub = `node "${fwd(rulesStub)}" "${fwd(rlog)}"`;
    setEngines({ unity: cfgFor(E, ctl, { rules: { test: `${stub} ALL`, focus: { test: `${stub} "{filter}"`, map: [{ match: '^Sim/([A-Za-z]+)/', filter: 'Category=$1' }], smoke: 'Category=Smoke', join: '|', split: true } } }) });
    queue(E, [['T-381', 'feat/a'], ['T-382', 'feat/b']]);
    const r = probe(TRAIN);
    const rr = rulesRuns(rlog);
    const re = evs(/^engine\.rules$/)[0];
    await guard('2.84 (t) rules.focus.split: in focus mode the rules check runs one command per filter group (Category=Fees, Category=Loans, then smoke) in sequence, never the joined filter; the result and the engine.rules event carry per-group seconds; the batch lands with the rules green (fails before this fix: one command with "Category=Fees|Category=Loans|Category=Smoke" held every system\'s data at once)', () => [
      r.landed?.join() === 'T-381,T-382' && rr.length === 6 && rr.every((x) => x.filter && !x.filter.includes('|')) && rr.slice(3).map((x) => x.filter).join() === 'Category=Fees,Category=Loans,Category=Smoke'
        && r.rules?.groups?.length === 3 && r.rules.groups.every((x) => Number.isFinite(x.seconds)) && re?.meta?.groups?.length === 3 && runsOf(ctl)[0]?.rulesGreen === '1',
      JSON.stringify({ r, rr, re: re?.meta }).slice(0, 2500)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'lane-a.txt': 'a\n' }, 'feat/b': { 'lane-b.txt': 'b\n' }, 'feat/c': { 'lane-c.txt': 'c\n', 'rules-bad.txt': 'x\n' } });
    const ctl = path.join(T, 'ctl-maxlanes');
    const rlog = path.join(T, 'rules-max.jsonl');
    setEngines({ unity: cfgFor(E, ctl, { rules: { test: `node "${fwd(rulesStub)}" "${fwd(rlog)}" ALL`, maxLanes: 2 } }) });
    queue(E, [['T-391', 'feat/a'], ['T-392', 'feat/b'], ['T-393', 'feat/c']]);
    const r = probe(TRAIN);
    const rr = rulesRuns(rlog);
    const re = evs(/^engine\.rules$/);
    const land = runsOf(ctl);
    await guard('2.84 (t) rules.maxLanes: a batch of three with maxLanes 2 is checked as two slices on the same target (T-391+T-392, then T-393); no rules run ever holds all three; the red slice hands back only its own lane (cause rules); the rest lands, without STUDIO_RULES_GREEN (a sliced check never saw the batch as one tree); one engine.rules event per slice (fails before this fix: one run held the whole batch)', () => [
      rr.length >= 3 && rr.every((x) => x.lanes.length <= 2) && rr.some((x) => x.lanes.join() === 'lane-a.txt,lane-b.txt') && rr.some((x) => x.lanes.join() === 'lane-c.txt')
        && r.dropped?.length === 1 && r.dropped[0].task === 'T-393' && r.dropped[0].cause === 'rules' && r.landed?.join() === 'T-391,T-392' && land.length === 1 && land[0].rulesGreen === null
        && re.length === 2 && re.map((e) => e.meta?.slice).join() === '1/2,2/2' && r.rules?.sliced === 2,
      JSON.stringify({ r, rr, re: re.map((e) => e.meta), land }).slice(0, 2500)]);
  }
}
