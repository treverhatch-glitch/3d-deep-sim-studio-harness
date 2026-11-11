/**
 * qa/selftest-283b.mjs — 2.83: the engine train: a branch that lands alone, one more run before blame, blame by evidence.
 *
 * A crew's 26 hours on the engine train showed: a switch-over batched with a port; a lane handed back "first not green"
 * that was never run by itself (the red was a test that fails under load); three land runs to find one lane whose
 * failing test only it had changed; a lane handed back that could not be restarted until the train ended; a landed
 * change to the land script that never ran; a task closed on its studio half; input files copied by hand; and landed
 * worktrees piling up. Each check here holds one of the fixes (harness/unity-train.mjs, unity-gate.mjs, task.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest283B({ dir, root, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const T = path.join(tmpRoot, `s283b-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const harnessRoot = root || dir;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-283b-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file, engine settings) ----
  const S = path.join(tmpRoot, `283b-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(S, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* the checks below need no package */ }
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setGame = (game) => write(S, 'studio/game.json', `${JSON.stringify(game, null, 2)}\n`);
  const setEngines = (engines) => setGame({ engines });
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-283b.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-283b-${++pn}.mjs`);
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
  // The land script stand-in. It records each run (sources, what the harness told it, the train lock's lanes), merges the
  // sources into the gate worktree, then judges the merged tree: a file "<stage>-bad.txt" makes that stage red with the
  // test name the file holds; "<ctl>-flaky" holds how many runs still fail in a stage ("2 play Some.Test.Name").
  // A red run puts the gate worktree back where it was, as a real land script does.
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const lock = (() => { try { return JSON.parse(fs.readFileSync(path.join(process.env.STUDIO_MAIN_ROOT || '.', '.studio', 'locks', 'unity-train.lock'), 'utf8')).lanes || []; } catch { return null; } })();
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, rulesGreen: process.env.STUDIO_RULES_GREEN || '', rulesMode: process.env.STUDIO_RULES_MODE || '', full: process.env.STUDIO_LAND_FULL || '', editArgs: process.env.STUDIO_UNITY_EDITMODE_ARGS || '', lock }) + '\\n');
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
const stages = (bad) => { if (process.env.STUDIO_LAND_RESULT) fs.writeFileSync(process.env.STUDIO_LAND_RESULT, JSON.stringify({ gates: Object.fromEntries(['merge', 'rules', 'edit', 'play', 'build'].map((n, i, all) => [n, bad && all.indexOf(bad) < i ? null : { status: n === bad ? 'fail' : 'pass', seconds: 10 }]).filter(([, v]) => v)) })); };
const red = (stage, test) => { git(gw, 'reset', '-q', '--hard', before); stages(stage); console.log('  Failed ' + test + ' [3 ms]'); console.log('1 test failed'); process.exit(1); };
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); console.log('conflict ' + s); process.exit(2); } }
let fl = null; try { fl = fs.readFileSync(ctl + '-flaky', 'utf8').trim().split(' '); } catch {}
if (fl && Number(fl[0]) > 0) { fs.writeFileSync(ctl + '-flaky', [Number(fl[0]) - 1, fl[1], fl[2]].join(' ')); red(fl[1], fl[2]); }
for (const st of ['edit', 'play']) { const f = path.join(gw, st + '-bad.txt'); if (fs.existsSync(f)) red(st, fs.readFileSync(f, 'utf8').trim()); }
stages(null);
console.log('landed ' + srcs.join(' '));
`);
  const rulesStub = path.join(T, 'rules-stub.mjs');
  fs.writeFileSync(rulesStub, `import fs from 'node:fs';
if (fs.existsSync('rules-bad.txt')) { console.log('  Failed Rules.Economy.FeesAddUp [3 ms]'); console.log('1 test failed'); process.exit(1); }
console.log('Passed!');
`);
  const runsOf = (ctl) => { try { return fs.readFileSync(`${ctl}-runs.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const cfgFor = (E, ctl, extra = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, rules: false, ...extra });
  const queue = (E, lanes) => { fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true }); fs.writeFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), JSON.stringify(lanes.map(([task, branch, more], i) => ({ task, agent: `porter-${i}`, branch, head: E.heads[branch], at: new Date(Date.now() + i).toISOString(), ...(more || {}) })))); };
  const TRAIN = `import { runUnityTrain, readUnityQueue } from ${u('harness/unity-train.mjs')};
const handed = [];
const r = await runUnityTrain({ root: process.cwd(), log: () => {}, deps: { handBack: (lane, note, extra) => handed.push({ task: lane.task, note, extra: extra || null }) } });
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, landed: r.landed, dropped: r.dropped, deferred: r.deferred, rules: r.rules || null, flaky: r.flaky || null, alone: r.alone || null, fullLand: r.fullLand || 0, landScript: r.landScript || null, handed, queue: readUnityQueue(process.cwd()).map((e) => e.task) }));`;
  const noFull = { STUDIO_ENGINE_FULL_LAND_HOURS: 'off' };
  const evs = (re) => events().filter((e) => re.test(e.type));

  // ---- 1. a branch that lands alone ----
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n' }, 'feat/c': { 'c.txt': 'c\n' } });
    const ctl = path.join(T, 'ctl-alone');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-801', 'feat/a'], ['T-802', 'feat/b', { alone: true }], ['T-803', 'feat/c']]);
    const t1 = probe(TRAIN, noFull); const t2 = probe(TRAIN, noFull); const t3 = probe(TRAIN, noFull);
    const runs = runsOf(ctl);
    await guard('2.83 land alone: with A, B (marked alone) and C queued, the first engine train lands only A and stops before B, the second gives B a land run of its own, the third lands C (fails before this fix: one land run took A, B and C together, so a switch-over was judged inside a batch)', () => [
      t1.landed?.join() === 'T-801' && t1.queue?.join() === 'T-802,T-803' && t2.landed?.join() === 'T-802' && t2.alone === 'T-802' && t2.queue?.join() === 'T-803' && t3.landed?.join() === 'T-803' && runs.length === 3 && runs.map((r) => r.srcs.join('+')).join(' ') === 'feat/a feat/b feat/c',
      JSON.stringify({ t1, t2, t3, runs }).slice(0, 2500)]);
    // The flag from the board: task alone <ID> on marks the record; queueing reads it.
    write(S, '.studio/engine/tasks.json', JSON.stringify({ 'T-804': { engine: 'unity', track: 'engine:unity', branch: 'feat/a' } }));
    const E2 = engineRepo({ 'feat/a': { 'a2.txt': 'a\n' } });
    setEngines({ unity: cfgFor(E2, ctl) });
    const al = spawnSync(process.execPath, ['harness/task.mjs', 'alone', 'T-804', 'on'], { windowsHide: true, cwd: S, encoding: 'utf8', env: envOf() });
    const q = probe(`import { queueUnityTask, readUnityQueue } from ${u('harness/unity-train.mjs')};
const r = queueUnityTask(process.cwd(), { engine: 'unity', task: 'T-804', agent: 'b1' });
console.log(JSON.stringify({ ok: r.ok, message: r.message, entry: readUnityQueue(process.cwd()).find((e) => e.task === 'T-804') || null }));`);
    await guard('2.83 land alone, from the board: `task alone <ID> on` marks the task\'s engine record, and its branch is queued as alone without any flag at task done', () => [
      al.status === 0 && /lands alone/.test(out(al)) && q.ok === true && q.entry?.alone === true,
      `${out(al).slice(-400)} ${JSON.stringify(q).slice(0, 900)}`]);
  }

  // ---- 2. one more run before anyone is blamed ----
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/c': { 'c.txt': 'c\n' } });
    const ctl = path.join(T, 'ctl-flaky');
    fs.writeFileSync(`${ctl}-flaky`, '1 play Game.Tests.PanelTests.DrawsALoan');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-811', 'feat/a'], ['T-812', 'feat/c']]);
    const r = probe(TRAIN, noFull);
    const runs = runsOf(ctl);
    await guard('2.83 a red in a stage that fails under load: the batch is run once more before anyone is blamed; it passes, both lanes land, nobody is handed back, and the train says which stage and test failed the first time (fails before this fix: the red went straight to a search by land runs, which handed back a lane that had never been run by itself)', () => [
      r.landed?.join() === 'T-811,T-812' && !r.dropped?.length && !r.handed?.length && r.runs === 2 && runs.length === 2 && r.flaky?.length === 1 && r.flaky[0].stage === 'play' && /DrawsALoan/.test(JSON.stringify(r.flaky)) && evs(/task\.train\.unity\.flaky$/).length === 1,
      JSON.stringify({ r, runs, types: [...new Set(events().map((e) => e.type))] }).slice(0, 2500)]);
  }

  // ---- 3. blame by evidence ----
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'Assets/Tests/FeesPanelTests.cs': 'class FeesPanelTests { void DrawsALoan() {} }\n', 'edit-bad.txt': 'Game.Tests.FeesPanelTests.DrawsALoan\n' }, 'feat/c': { 'c.txt': 'c\n' } });
    const ctl = path.join(T, 'ctl-evidence');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-821', 'feat/a'], ['T-822', 'feat/b'], ['T-823', 'feat/c']]);
    const r = probe(TRAIN, noFull);
    const runs = runsOf(ctl);
    const d = (r.dropped || [])[0];
    await guard('2.83 blame by evidence: a batch of three is red on a test whose class only B\'s branch changes; the train runs the batch without B, lands A and C on that one run, and hands B back with the evidence (2 land runs, cause "evidence") (fails before this fix: a search by land runs: three or more runs, and the first lanes landed only after them)', () => [
      r.landed?.slice().sort().join() === 'T-821,T-823' && r.dropped?.length === 1 && d.task === 'T-822' && d.cause === 'evidence' && /Blame by evidence/.test(d.why) && /FeesPanelTests\.cs/.test(d.why) && r.runs === 2 && runs.length === 2 && /feat\/a|unity-train/.test(runs[1].srcs.join()) && r.handed?.length === 1,
      JSON.stringify({ r, runs }).slice(0, 2500)]);
  }

  // ---- 4. no blame by elimination ----
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/c': { 'c.txt': 'c\n' } });
    const ctl = path.join(T, 'ctl-elim');
    fs.writeFileSync(`${ctl}-flaky`, '1 edit Game.Tests.Unrelated.Thing'); // red once, in a stage that is not tried again, on a test no lane changes
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-831', 'feat/a'], ['T-832', 'feat/c']]);
    const r = probe(TRAIN, noFull);
    const runs = runsOf(ctl);
    await guard('2.83 no blame by elimination: a batch of two is red once on a test neither lane changes; the search lands the first lane, and the second, the one left, is run by itself before any hand-back; it passes and lands (fails before this fix: the lane left over was handed back as "first not green" without ever being run by itself)', () => [
      r.landed?.join() === 'T-831,T-832' && !r.dropped?.length && !r.handed?.length && runs.length === 3 && runs[2].srcs.join() === 'feat/c',
      JSON.stringify({ r, runs }).slice(0, 2500)]);
  }

  // ---- 5. a full land run once a day; the owner's Edit Mode arguments ----
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/c': { 'c.txt': 'c\n' } }, { shared: { 'Assets/x.txt': 'x\n' } });
    const ctl = path.join(T, 'ctl-full');
    setEngines({ unity: cfgFor(E, ctl, { rules: `node "${fwd(rulesStub)}"`, editModeArgs: '-testCategory "!Slow"' }) });
    // No record: the clock starts and the first run is an ordinary one. Then the record is made 25 hours old.
    queue(E, [['T-840', 'feat/a']]);
    const r0 = probe(TRAIN, { STUDIO_ENGINE_FULL_LAND_HOURS: '24' });
    const clockFile = path.join(S, '.studio', 'engine', 'unity-full-land.json');
    const clock = (() => { try { return JSON.parse(fs.readFileSync(clockFile, 'utf8')); } catch { return null; } })();
    fs.writeFileSync(clockFile, JSON.stringify({ at: new Date(Date.now() - 25 * 3600000).toISOString(), id: null, clock: 'started' }));
    const E1 = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/c': { 'c.txt': 'c\n' } }, { shared: { 'Assets/x.txt': 'x\n' } });
    const ctl1 = path.join(T, 'ctl-full-1');
    setEngines({ unity: cfgFor(E1, ctl1, { rules: `node "${fwd(rulesStub)}"`, editModeArgs: '-testCategory "!Slow"' }) });
    queue(E1, [['T-841', 'feat/a']]);
    const r1 = probe(TRAIN, { STUDIO_ENGINE_FULL_LAND_HOURS: '24' });
    queue(E1, [['T-842', 'feat/c']]);
    const r2 = probe(TRAIN, { STUDIO_ENGINE_FULL_LAND_HOURS: '24' });
    const runs0 = runsOf(ctl);
    const runs = runsOf(ctl1);
    await guard('2.83 a full land run: a studio with no full run on record starts the clock and its first land run is an ordinary one (shortcuts given); once the last full run (or the clock\'s start) is older than STUDIO_ENGINE_FULL_LAND_HOURS, the land command is told nothing that lets it skip its own tests (STUDIO_LAND_FULL=1, no STUDIO_RULES_GREEN, no Edit Mode arguments) although the rules check was green; once that run passed, the next land run gets the shortcuts again, with the owner\'s own Edit Mode arguments (engines.unity.editModeArgs) (fails before this fix: every land run got the shortcuts, so a difference between the two runtimes could go unseen for good)', () => [
      r0.landed?.join() === 'T-840' && r0.fullLand === 0 && runs0[0]?.full === '' && runs0[0].rulesGreen === '1' && clock?.clock === 'started' && Number.isFinite(Date.parse(clock.at))
        && r1.landed?.join() === 'T-841' && r1.fullLand === 1 && runs[0]?.full === '1' && runs[0].rulesGreen === '' && runs[0].editArgs === '' && r1.rules?.ran === true
        && r2.landed?.join() === 'T-842' && r2.fullLand === 0 && runs[1]?.full === '' && runs[1].rulesGreen === '1' && runs[1].rulesMode === 'full' && runs[1].editArgs === '-testCategory "!Slow"',
      JSON.stringify({ r0, clock, r1, r2, runs0, runs }).slice(0, 3000)]);
  }

  // ---- 6. a lane handed back is out of the train at once ----
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'rules-bad.txt': 'x\n' } });
    const ctl = path.join(T, 'ctl-release');
    setEngines({ unity: cfgFor(E, ctl, { rules: `node "${fwd(rulesStub)}"` }) });
    queue(E, [['T-851', 'feat/a'], ['T-852', 'feat/b']]);
    const r = probe(TRAIN, noFull);
    const runs = runsOf(ctl);
    await guard('2.83 handed back means out of the train: while the land run of the rest is going, the train\'s own record no longer lists the lane the rules check handed back, so its fix can be started at once (fails before this fix: it stayed listed until the train ended, and task start said "in the train, which is landing it now")', () => [
      r.landed?.join() === 'T-851' && r.dropped?.[0]?.task === 'T-852' && runs.length === 1 && Array.isArray(runs[0].lock) && runs[0].lock.includes('T-851') && !runs[0].lock.includes('T-852'),
      JSON.stringify({ r, runs }).slice(0, 2000)]);
  }

  // ---- 7. the land command runs another copy of its script ----
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } }, { shared: { 'tools/land.mjs': '// the land script, as landed\n' } });
    const slice = path.join(T, 'slice-wt');
    g(E.R, 'branch', 'old-work', 'port/main'); g(E.R, 'worktree', 'add', '-q', slice, 'old-work');
    write(slice, 'tools/land.mjs', '// an older land script\n'); g(slice, 'add', '-A'); g(slice, 'commit', '-qm', 'old script');
    const ctl = path.join(T, 'ctl-script');
    const D = (land) => { setEngines({ unity: { ...cfgFor(E, ctl), land } }); return probe(`import { unityTrainSettings, landScriptDrift } from ${u('harness/unity-train.mjs')};
const s = unityTrainSettings(process.cwd(), 'unity'); const d = landScriptDrift(s, process.cwd());
console.log(JSON.stringify({ d: d && { rel: d.rel, branch: d.branch, missing: d.missing || false }, err: s.error || null }));`); };
    const other = D(`node "${fwd(path.join(slice, 'tools', 'land.mjs'))}" {branch}`);
    const same = D(`node "${fwd(path.join(E.GW, 'tools', 'land.mjs'))}" {branch}`);
    const none = D(`node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`);
    await guard('2.83 the land script that runs: a land command that names a script in another worktree of the engine repo, where it differs from the target branch\'s copy, is reported (the file and the branch it is on); the target\'s own copy, or a script outside the repo, is not (a crew landed a change to its land script and nothing changed: the command ran an old copy)', () => [
      other.d?.rel === 'tools/land.mjs' && other.d.branch === 'old-work' && same.d === null && none.d === null && !other.err,
      JSON.stringify({ other, same, none }).slice(0, 1500)]);
  }

  // ---- 8. a task with work in two repositories ----
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } });
    const ctl = path.join(T, 'ctl-half');
    setEngines({ unity: cfgFor(E, ctl) });
    write(S, '.studio/engine/tasks.json', JSON.stringify({ 'T-861': { engine: 'unity', track: 'engine:unity', branch: 'feat/a' }, 'T-862': { engine: 'unity', track: 'engine:unity', branch: 'port/main' } }));
    const r = probe(`const t = await import(${u('harness/task.mjs')});
const open = t.engineHalfOpen('T-861'); const landed = t.engineHalfOpen('T-862'); const web = t.engineHalfOpen('T-999');
const c = t.closeTrainTask('T-861', 'bld-1', { train: 'tr-1', head: 'x', laneHead: 'y' });
const { readUnityQueue } = await import(${u('harness/unity-train.mjs')});
console.log(JSON.stringify({ open, landed, web, c, queued: readUnityQueue(process.cwd()).map((e) => e.task) }));`);
    await guard('2.83 two repositories, one task: when the merge train lands a task\'s studio half while its engine branch still holds commits the engine\'s target doesn\'t have, the task is not closed: it stays open, an event says so, and its engine branch is queued for the engine train (fails before this fix: the task was closed on its first half and its engine half was orphaned)', () => [
      r.open?.branch === 'feat/a' && r.open.ahead === 1 && r.landed === null && r.web === null && r.c?.halfLanded === true && r.queued?.includes('T-861') && evs(/^task\.half_landed$/).length === 1 && !evs(/^task\.done$/).length,
      JSON.stringify(r).slice(0, 1800)]);
  }

  // ---- 9. a lane's new shared input files reach the engine folder; a landed lane's worktree goes ----
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } }, { shared: { '.gitignore': 'Packs~/\n' } });
    const ctl = path.join(T, 'ctl-share');
    setEngines({ unity: cfgFor(E, ctl, { rules: { test: `node "${fwd(rulesStub)}"`, share: ['Packs~'] } }) });
    const lane = path.join(S, '.lanes', 'engine', 'T-871');
    fs.mkdirSync(path.dirname(lane), { recursive: true });
    g(E.R, 'worktree', 'add', '-q', lane, 'feat/a');
    write(lane, 'Packs~/abc123.bin', 'pack\n');
    write(E.R, 'Packs~/old.bin', 'old\n');
    const q = probe(`import { queueUnityTask } from ${u('harness/unity-train.mjs')};
const r = queueUnityTask(process.cwd(), { engine: 'unity', task: 'T-871', agent: 'b1', branch: 'feat/a' });
console.log(JSON.stringify({ ok: r.ok, message: r.message }));`);
    const shared = fs.existsSync(path.join(E.R, 'Packs~', 'abc123.bin')) && fs.readFileSync(path.join(E.R, 'Packs~', 'old.bin'), 'utf8') === 'old\n';
    const r = probe(TRAIN, noFull);
    await guard('2.83 shared inputs and cleanup: queueing a lane copies its new content-addressed input files (engines.<x>.rules.share) into the engine\'s input folder without touching what is there, and when the lane lands its engine worktree is removed (fails before this fix: the overseer copied the files by hand before every such landing, and landed worktrees of 3 GB each piled up)', () => [
      q.ok === true && shared && r.landed?.join() === 'T-871' && !fs.existsSync(lane) && evs(/^engine\.lane\.removed$/).length === 1,
      JSON.stringify({ q, shared, r, laneStill: fs.existsSync(lane) }).slice(0, 2000)]);
  }
}
