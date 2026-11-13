/**
 * qa/selftest-285b.mjs — 2.85 (b): the engine train's rules check within the memory there is, and a clearer account of it.
 *
 * A crew's machine ran three test hosts at once (7.3 + 4.1 + 2.4 GB) and free RAM fell to 3.7 GB with three agents working; in
 * its first 16 hours the rules check took 341 minutes for 10 batches, more than the land runs it protects. Here: how many parts
 * of a split check run at once is decided by free RAM (harness/rules-parts.mjs); the engine.rules event and `train status` say
 * the mode, why it was full (naming the unmapped paths) and what it cost; a green full check is not run twice for the same tree,
 * also across a cancel and restart; a red part is named in the hand-back. Scaffolding as qa/selftest-284t.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest285B({ dir, root, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const T = path.join(tmpRoot, `s285b-${process.pid}`);
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
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-285b-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file, engine settings) ----
  const S = path.join(tmpRoot, `285b-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-285b.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const evs = (re) => events().filter((e) => re.test(e.type));
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-285b-${++pn}.mjs`);
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
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, landed: r.landed, dropped: r.dropped, rules: r.rules || null, handed, logs: logs.filter((l) => /rules|split|part|cached/i.test(l)) }));`;
  const STATUS = `import { unityStatusText } from ${u('harness/unity-train.mjs')};
console.log(JSON.stringify({ text: unityStatusText(process.cwd(), { engine: 'unity' }) }));`;
  const rulesRuns = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const sleepStub = path.join(T, 'sleep-stub.mjs');
  fs.writeFileSync(sleepStub, `import fs from 'node:fs';
const [log, filter] = process.argv.slice(2);
const a = Date.now();
await new Promise((r) => setTimeout(r, 700));
fs.appendFileSync(log, JSON.stringify({ filter, a, b: Date.now() }) + '\\n');
console.log('Passed!');
`);
  const rulesStub = path.join(T, 'rules-stub.mjs');
  fs.writeFileSync(rulesStub, `import fs from 'node:fs';
const [log, filter] = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify({ filter: filter ?? null }) + '\\n');
if (fs.existsSync('Sim/Loans/rules-bad.txt') && fs.readFileSync('Sim/Loans/rules-bad.txt', 'utf8').trim() === filter) { console.log('  Failed Rules.Loans.InterestAdds [3 ms]'); console.log('1 test failed'); process.exit(1); }
console.log('Passed!');
`);

  // ================= 1. the scheduler: free RAM decides how many at once =================
  {
    const P = await import(pathToFileURL(path.join(S, 'harness', 'rules-parts.mjs')).href);
    const mk = (n, bad = -1) => Array.from({ length: n }, (_, i) => ({ filter: `F${i}`, bad: i === bad }));
    const start = (p) => new Promise((res) => setTimeout(() => res({ status: p.bad ? 'red' : 'pass', filter: p.filter }), 40));
    const lines = [];
    const plenty = await P.runParts({ parts: mk(5), start, max: 3, gb: 4, floorGb: 3, freeGb: () => 100, log: (m) => lines.push(m), pollMs: 10 });
    const little = await P.runParts({ parts: mk(5), start, max: 3, gb: 4, floorGb: 3, freeGb: () => 5, pollMs: 10 });
    const sum = (r) => r.results.map((x) => `${x.filter}:${x.status}`).join();
    await guard('2.85 (b) split memory, plenty of RAM: five parts, splitMax 3, 100 GB free, 3 GB floor, 4 GB a part: three run at once (never more), every start is logged with its reason (fails before this fix: there was no limit to decide anything)', () => [
      plenty.atOnce === 3 && plenty.results.length === 5 && plenty.results.every((x) => x?.status === 'pass') && lines.filter((l) => /starts/.test(l)).length === 5 && lines.some((l) => /3 at once\): 100 GB free - 3 GB floor >= 4 GB per part/.test(l)),
      JSON.stringify({ plenty, lines }).slice(0, 2000)]);
    await guard('2.85 (b) split memory, little RAM: 5 GB free less the 3 GB floor is under the 4 GB a part needs, so one part runs at a time (the first always starts); the results are the same as with plenty of RAM (fails before this fix: the number at once was not a decision)', () => [
      little.atOnce === 1 && sum(little) === sum(plenty), JSON.stringify({ little, plenty }).slice(0, 1500)]);
    // Free RAM is read again before each start: 100 GB for the second part, then 4 GB: the third waits, so two at most.
    const reads = [100, 4, 4, 4, 4, 4, 4, 4];
    const lines2 = [];
    const again = await P.runParts({ parts: mk(4), start, max: 4, gb: 4, floorGb: 3, freeGb: () => reads.shift() ?? 4, log: (m) => lines2.push(m), pollMs: 10 });
    await guard('2.85 (b) split memory, read again before each start: free RAM is 100 GB for the second start and 4 GB after, so the third part waits for a running one to finish (two at once, not four) and the wait is logged once', () => [
      again.atOnce === 2 && again.results.every((x) => x?.status === 'pass') && lines2.filter((l) => /waits/.test(l)).length >= 1 && lines2.filter((l) => /part 3 of 4 waits/.test(l)).length === 1,
      JSON.stringify({ again, lines2 }).slice(0, 2000)]);
    const redRun = await P.runParts({ parts: mk(4, 1), start, max: 1, gb: 4, floorGb: 0, freeGb: () => 100, pollMs: 10 });
    await guard('2.85 (b) split memory: after a red part no new part starts (the third and fourth were never started)', () => [
      redRun.results[1]?.status === 'red' && redRun.results[2] === null && redRun.results[3] === null, JSON.stringify(redRun).slice(0, 800)]);
  }

  // ================= 2. a real split run: parts overlap with RAM, never without =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'Sim/Fees/a.cs': 'a\n', 'Sim/Loans/b.cs': 'b\n', 'Sim/Bonds/c.cs': 'c\n' } });
    const run = (name, freeGb, extraFocus = {}) => {
      const rlog = path.join(T, `sleep-${name}.jsonl`);
      fs.rmSync(rlog, { force: true });
      const r = probe(`import { runRulesAt, rulesSelection } from ${u('harness/engine-rules.mjs')};
const stub = ${JSON.stringify(`node "${fwd(sleepStub)}" "${fwd(rlog)}"`)};
const focus = { test: stub + ' "{filter}"', map: [{ match: '^Sim/([A-Za-z]+)/', filter: 'Category=$1' }], smoke: 'Category=Smoke', join: '|', fullEveryHours: 24, ignore: [], split: true, splitMax: 3, splitGb: 4, ...${JSON.stringify(extraFocus)} };
const cfg = { command: stub + ' ALL', inputs: [], timeoutMin: 5, env: {}, paths: [], focus, share: [], maxLanes: 0, lfs: false, source: 'test' };
const sel = rulesSelection({ changed: ['Sim/Fees/a.cs', 'Sim/Loans/b.cs', 'Sim/Bonds/c.cs'], cfg });
const x = runRulesAt({ engine: 'unity', repo: ${JSON.stringify(fwd(E.R))}, sha: ${JSON.stringify(E.heads['feat/a'])}, cfg, sel, root: process.cwd(), id: ${JSON.stringify(name)}, useCache: false, freeGb: () => ${freeGb}, log: (m) => console.error(m) });
console.log(JSON.stringify({ status: x.status, atOnce: x.splitAtOnce, groups: (x.groups || []).map((g) => g.filter + ':' + g.status).sort(), parts: sel.parts?.length }));`);
      const iv = rulesRuns(rlog).sort((p, q) => p.a - q.a);
      const overlap = iv.some((x, i) => iv.slice(i + 1).some((y) => y.a < x.b));
      return { r, overlap, n: iv.length };
    };
    const plenty = run('plenty', 100);
    const little = run('little', 3);
    await guard('2.85 (b) split run with the real command runner: with plenty of free RAM the parts of one rules check overlap in time (atOnce above 1, up to splitMax); with too little free RAM they never do (atOnce 1); the status and the groups run are the same either way (fails before this fix: parts always ran in sequence, with no say about RAM)', () => [
      plenty.r.status === 'pass' && plenty.r.parts === 4 && plenty.r.atOnce >= 2 && plenty.r.atOnce <= 3 && plenty.overlap && plenty.n === 4
        && little.r.status === 'pass' && little.r.atOnce === 1 && !little.overlap && little.n === 4 && plenty.r.groups.join() === little.r.groups.join(),
      JSON.stringify({ plenty, little }).slice(0, 2000)]);
  }

  // ================= 3. mode, why, parts, cost on the event and in train status =================
  {
    resetState();
    const unmapped = ['Misc/a.txt', 'Misc/b.txt', 'Misc/c.txt', 'Misc/d.txt', 'Misc/e.txt', 'Misc/f.txt', 'Misc/g.txt'];
    const E = engineRepo({ 'feat/a': Object.fromEntries(unmapped.map((f) => [f, 'x\n'])) });
    const ctl = path.join(T, 'ctl-why');
    const rlog = path.join(T, 'rules-why.jsonl');
    fs.mkdirSync(path.join(S, '.studio', 'engine'), { recursive: true });
    fs.writeFileSync(path.join(S, '.studio', 'engine', 'unity-rules.json'), JSON.stringify({ trees: {}, runs: [], lastFullAt: new Date().toISOString() }));
    const stub = `node "${fwd(rulesStub)}" "${fwd(rlog)}"`;
    setEngines({ unity: cfgFor(E, ctl, { rules: { test: `${stub} ALL`, focus: { test: `${stub} "{filter}"`, map: [{ match: '^Sim/([A-Za-z]+)/', filter: 'Category=$1' }], smoke: 'Category=Smoke', join: '|' } } }) });
    queue(E, [['T-501', 'feat/a']]);
    const r = probe(TRAIN);
    const re = evs(/^engine\.rules$/)[0];
    const st = probe(STATUS);
    const m = re?.meta || {};
    await guard('2.85 (b) engine.rules event: it carries mode, why, parts, ms and splitAtOnce, and a full run because paths match no rules.focus.map entry names up to 5 of them (not the seventh), so a studio can extend the map; the train result has the same (fails before this fix: the event had no why, parts or splitAtOnce, and the why named only the first path)', () => [
      r.landed?.join() === 'T-501' && m.mode === 'full' && /Misc\/a\.txt/.test(m.why) && /Misc\/e\.txt/.test(m.why) && !/Misc\/f\.txt|Misc\/g\.txt/.test(m.why.replace(/, \.\.\./, '')) && m.parts === 1 && Number.isFinite(m.ms) && m.splitAtOnce === 1
        && r.rules?.mode === 'full' && /Misc\/e\.txt/.test(r.rules.why || ''),
      JSON.stringify({ r, m }).slice(0, 2500)]);
    await guard('2.85 (b) train status: the last train\'s rules line shows the mode and why it was full (with the unmapped paths), its runs and seconds (fails before this fix: status printed no rules line)', () => [
      /Last .* rules check: full: .*Misc\/a\.txt.*Misc\/e\.txt/.test(st.text || ''), JSON.stringify(st).slice(0, 1500)]);
  }

  // ================= 4. the same tree is not checked twice, also after a cancel and restart =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'lane-a.txt': 'a\n' }, 'feat/b': { 'lane-b.txt': 'b\n' } });
    const ctl = path.join(T, 'ctl-twice');
    const rlog = path.join(T, 'rules-twice.jsonl');
    fs.rmSync(rlog, { force: true });
    fs.writeFileSync(`${ctl}-cancel`, '1');
    setEngines({ unity: cfgFor(E, ctl, { killedExits: [77], rules: { test: `node "${fwd(rulesStub)}" "${fwd(rlog)}" ALL` } }) });
    queue(E, [['T-511', 'feat/a'], ['T-512', 'feat/b']]);
    const r1 = probe(TRAIN);
    const n1 = rulesRuns(rlog).length;
    fs.rmSync(`${ctl}-cancel`, { force: true });
    fs.rmSync(path.join(S, '.studio', 'train', 'unity-cancel.json'), { force: true });
    const r2 = probe(TRAIN);
    const n2 = rulesRuns(rlog).length;
    const land = runsOf(ctl);
    await guard('2.85 (b) the same tree is not checked twice: a train cancelled during its land run is started again with the same batch on the same target tip: the rules check is not run again (the kept result in .studio/engine answers, "cached" in the log), and the land run is told STUDIO_RULES_GREEN=1 and STUDIO_RULES_MODE=full (the first run was green in full mode on exactly this tree)', () => [
      n1 === 2 && n2 === n1 && r1.landed?.length === 0 && land.length === 2 && land[0].rulesGreen === '1' && land[1].rulesGreen === '1' && land[1].rulesMode === 'full' && r2.landed?.join() === 'T-511,T-512' && r2.logs.some((l) => /cached/.test(l)),
      JSON.stringify({ n1, n2, r1: r1.landed, r2, land }).slice(0, 2500)]);
  }

  // ================= 5. a red part is named =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'Sim/Fees/a.cs': 'a\n' }, 'feat/b': { 'Sim/Loans/b.cs': 'b\n', 'Sim/Loans/rules-bad.txt': 'Category=Loans\n' } });
    const ctl = path.join(T, 'ctl-redpart');
    const rlog = path.join(T, 'rules-redpart.jsonl');
    fs.mkdirSync(path.join(S, '.studio', 'engine'), { recursive: true });
    fs.writeFileSync(path.join(S, '.studio', 'engine', 'unity-rules.json'), JSON.stringify({ trees: {}, runs: [], lastFullAt: new Date().toISOString() }));
    const stub = `node "${fwd(rulesStub)}" "${fwd(rlog)}"`;
    setEngines({ unity: cfgFor(E, ctl, { rules: { test: `${stub} ALL`, focus: { test: `${stub} "{filter}"`, map: [{ match: '^Sim/([A-Za-z]+)/', filter: 'Category=$1' }], smoke: 'Category=Smoke', join: '|', split: true } } }) });
    queue(E, [['T-521', 'feat/a'], ['T-522', 'feat/b']]);
    const r = probe(TRAIN);
    const d = (r.dropped || [])[0] || {};
    await guard('2.85 (b) a red split part names itself: the lane that turns the batch red is handed back with the part (Category=Loans, "part 2 of 3" is not needed: the filter and its command) and the failing test (Rules.Loans.InterestAdds), not only "the rules check is red" (fails before this fix: the reason named the joined filter command and no part)', () => [
      d.task === 'T-522' && d.cause === 'rules' && /part Category=Loans/.test(d.why) && /Failing in part Category=Loans: Rules\.Loans\.InterestAdds/.test(d.why) && r.landed?.join() === 'T-521',
      JSON.stringify({ r }).slice(0, 2500)]);
  }
}
