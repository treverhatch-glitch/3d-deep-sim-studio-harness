/**
 * qa/selftest-285a.mjs — 2.85 (a): the engine train's land runs: the daily full land run is visible and the compile check carries
 * only what a compile needs (B-137); a red full run does not blame a branch for what the target already fails; the suspect first
 * (one tied branch: the batch without it; several: apart from the untied ones) and no repeat of an unchanged red; a UI batch's Play
 * Mode plan names the paths its map lacks, and `npm run engine -- play-plan` shows it without a train.
 *
 * The scaffolding (a studio copy, a made-up engine repo, a stand-in land script that records what it was told) is
 * qa/selftest-284t.mjs's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest285A({ dir, root, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const T = path.join(tmpRoot, `s285a-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  void root;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-285a-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file, engine settings) ----
  const S = path.join(tmpRoot, `285a-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-285a.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const evs = (re) => events().filter((e) => re.test(e.type));
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-285a-${++pn}.mjs`);
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
  // The land script stand-in (qa/selftest-284t.mjs's, cut down). It records each run: every variable the harness tells a land script,
  // and what the train's lock says it is doing now; with <ctl>-status, also `train status` as a person sees it. It merges the sources
  // into the gate worktree and judges the merged tree: "<stage>-bad.txt" (edit, play) fails that stage on the test it holds ("rev:" +
  // the name reversed, so the name itself is in no file a lane changes); <ctl>-fullred "stage A;B" fails those tests ONLY on a full
  // land run (STUDIO_LAND_FULL=1): the target's own red. A red run prints every failing test and puts the gate worktree back.
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const E = process.env;
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const opt = (k) => { try { return fs.readFileSync(ctl + '-' + k, 'utf8').trim(); } catch { return null; } };
let lock = {}; try { lock = JSON.parse(fs.readFileSync(path.join(E.STUDIO_MAIN_ROOT, '.studio', 'locks', 'unity-train.lock'), 'utf8')); } catch {}
let status = null;
if (opt('status') !== null) { try { const m = await import(pathToFileURL(path.join(E.STUDIO_MAIN_ROOT, 'harness', 'unity-train.mjs')).href); status = m.unityStatusText(E.STUDIO_MAIN_ROOT, { engine: 'unity' }); } catch (e) { status = 'ERR ' + e.message; } }
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, only: E.STUDIO_LAND_ONLY ?? null, landFull: E.STUDIO_LAND_FULL ?? null, retry: E.STUDIO_LAND_RETRY ?? null, retryTests: E.STUDIO_LAND_RETRY_TESTS ?? null, rulesGreen: E.STUDIO_RULES_GREEN ?? null, rulesMode: E.STUDIO_RULES_MODE ?? null, playMode: E.STUDIO_PLAY_MODE ?? null, playFilter: E.STUDIO_PLAY_FILTER ?? null, playArgs: E.STUDIO_UNITY_PLAYMODE_ARGS ?? null, editArgs: E.STUDIO_UNITY_EDITMODE_ARGS ?? null, now: lock.now ?? null, full: lock.full ?? null, status }) + '\\n');
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); console.log('conflict ' + s); process.exit(2); } }
if (E.STUDIO_LAND_ONLY === 'compile') { git(gw, 'reset', '-q', '--hard', before); console.log('compiles'); process.exit(0); }
const order = ['merge', 'edit', 'play', 'build'];
const reds = [];
const fr = opt('fullred');
if (fr && E.STUDIO_LAND_FULL === '1') { const [st, ...n] = fr.split(' '); reds.push([st, n.join(' ').split(';')]); }
for (const st of ['edit', 'play']) { const f = path.join(gw, st + '-bad.txt'); if (fs.existsSync(f)) { const t = fs.readFileSync(f, 'utf8').trim(); reds.push([st, [t.startsWith('rev:') ? t.slice(4).split('').reverse().join('') : t]]); } }
const stages = (bad) => { if (E.STUDIO_LAND_RESULT) fs.writeFileSync(E.STUDIO_LAND_RESULT, JSON.stringify({ gates: Object.fromEntries(order.map((n, i) => [n, bad && order.indexOf(bad) < i ? null : { status: n === bad ? 'fail' : 'pass', seconds: 10 }]).filter(([, v]) => v)) })); };
if (reds.length) {
  reds.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  git(gw, 'reset', '-q', '--hard', before);
  stages(reds[0][0]);
  for (const [, names] of reds) for (const n of names) console.log('  Failed ' + n + ' [3 ms]');
  console.log(reds.reduce((k, [, n]) => k + n.length, 0) + ' test(s) failed');
  process.exit(1);
}
stages(null);
console.log('landed ' + srcs.join(' '));
`);
  const runsOf = (ctl) => { try { return fs.readFileSync(`${ctl}-runs.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const cfgFor = (E, ctl, extra = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, rules: false, ...extra });
  const queue = (E, lanes) => { fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true }); fs.writeFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), JSON.stringify(lanes.map(([task, branch], i) => ({ task, agent: `porter-${i}`, branch, head: E.heads[branch], at: new Date(Date.now() + i).toISOString() })))); };
  // The daily full run is due: the last full run that passed is two days old (and took `minutes`).
  const fullDue = (minutes = null) => { fs.mkdirSync(path.join(S, '.studio', 'engine'), { recursive: true }); fs.writeFileSync(path.join(S, '.studio', 'engine', 'unity-full-land.json'), JSON.stringify({ at: new Date(Date.now() - 48 * 3600000).toISOString(), id: 'old', ...(minutes ? { minutes } : {}) })); };
  const fullRec = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'engine', 'unity-full-land.json'), 'utf8')); } catch { return null; } };
  const baselineOf = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'unity-full-baseline.json'), 'utf8')); } catch { return null; } };
  const setBaseline = (failing) => { fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true }); fs.writeFileSync(path.join(S, '.studio', 'train', 'unity-full-baseline.json'), JSON.stringify({ at: new Date().toISOString(), target: 'x', failing, source: 'a test' })); };
  const TRAIN = `import { runUnityTrain, readUnityQueue, unityStatusText } from ${u('harness/unity-train.mjs')};
const handed = []; const logs = [];
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps: { handBack: (lane, note, extra) => handed.push({ task: lane.task, note, extra: extra || null }) } });
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, compileRuns: r.compileRuns || 0, landed: r.landed, dropped: r.dropped, deferred: r.deferred, fullLand: r.fullLand || 0, fullRedOnTarget: r.fullRedOnTarget || null, playUnmatched: r.playUnmatched || null, handed, logs: logs.filter((l) => /full|blame plan|play stage|known red|evidence/.test(l)), queue: readUnityQueue(process.cwd()).map((e) => e.task), status: unityStatusText(process.cwd(), { engine: 'unity' }) }));`;
  const rev = (s) => `rev:${s.split('').reverse().join('')}`;
  const cargo = {
    'Assets/Cargo/Tests/Cargo.Tests.asmdef': '{ "name": "Cargo.Tests" }\n',
    'Assets/Cargo/Tests/LoadTests.cs': 'namespace Game.Cargo.Tests { public class LoadTests { } }\n',
  };

  // ================= 1. the daily full land run is visible; the compile check carries only what a compile needs (B-137) =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n' } });
    const ctl = path.join(T, 'ctl-full-visible');
    fs.writeFileSync(`${ctl}-status`, '1');
    setEngines({ unity: cfgFor(E, ctl, { compileFirst: true }) });
    queue(E, [['T-501', 'feat/a'], ['T-502', 'feat/b']]);
    fullDue(42);
    const r = probe(TRAIN, { STUDIO_PLAY_FILTER: 'Leaked', STUDIO_LAND_RETRY: '1', STUDIO_RULES_MODE: 'focus' });
    const runs = runsOf(ctl);
    const fe = evs(/^task\.train\.unity\.full_land$/);
    const le = evs(/^engine\.land$/);
    const ce = evs(/^task\.train\.unity\.compile$/);
    const [c, l] = runs;
    await guard('2.85 (a) B-137, the compile check: with compileFirst on the day the full run is due, the compile run gets STUDIO_LAND_ONLY=compile and none of STUDIO_LAND_FULL, STUDIO_RULES_MODE, STUDIO_LAND_RETRY, STUDIO_PLAY_FILTER, STUDIO_UNITY_PLAYMODE_ARGS or an Edit Mode plan; the land run after it gets STUDIO_LAND_FULL=1; the compile event says "passed in N s; the land run starts now" (fails before this fix: the compile run was told STUDIO_LAND_FULL=1, the same variables as the full land run, so a log showed a full run where a compile check stood)', () => [
      runs.length === 2 && c.only === 'compile' && c.landFull === null && c.rulesMode === null && c.retry === null && c.playFilter === null && c.playArgs === null && c.editArgs === null
        && l.only === null && l.landFull === '1' && ce.length === 1 && /passed in \d+ s; the land run starts now/.test(ce[0].msg) && r.landed?.join() === 'T-501,T-502',
      JSON.stringify({ r, runs, ce: ce.map((e) => e.msg) }).slice(0, 2500)]);
    await guard('2.85 (a) B-137, the daily full run is said everywhere: one task.train.unity.full_land event at its start (meta train, why, tasks, minutes of the last full run), engine.land meta.full true, the train\'s "now" line during the land run reads "land run, the daily full run: every test runs, expect about 42 min", and train status says so plainly (fails before this fix: nothing said a land run was the daily full run)', () => [
      fe.length === 1 && fe[0].meta?.train && /older than/.test(fe[0].meta.why || '') && fe[0].meta.tasks?.join() === 'T-501,T-502' && fe[0].meta.minutes === 42
        && le.length === 1 && le[0].meta?.full === true && /land run, the daily full run: every test runs, expect about 42 min/.test(l.now || '') && l.full?.minutes === 42
        && /is the daily full run .*every test runs, expect about 42 min/.test(l.status || ''),
      JSON.stringify({ fe: fe.map((e) => e.meta), le: le.map((e) => e.meta), l }).slice(0, 2500)]);
    await guard('2.85 (a) B-137, never the previous stage while the next runs: during the compile check the "now" line says compile check; during the land run it no longer says "compile check:" but that the compile passed and the land run, the daily full run, starts now; the full run\'s minutes are kept for the next one (fails before this fix: the "now" line said "compile check" through the whole land run)', () => [
      /^compile check: T-501, T-502/.test(c.now || '') && !/^compile check:/.test(l.now || '') && /compile check passed in \d+ s; land run, the daily full run/.test(l.now || '') && fullRec()?.minutes >= 1 && fullRec()?.id !== 'old',
      JSON.stringify({ c: c?.now, l: l?.now, rec: fullRec() }).slice(0, 1500)]);
  }

  // ================= 2. a red full run does not blame a branch for what the target already fails =================
  const TARGET_RED = 'Game.Cargo.Tests.LoadTests.FitsTheHold';
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'Assets/Hangar/Doors.cs': 'class Doors {}\n' }, 'feat/b': { 'Assets/Ui/Menu.cs': 'class Menu {}\n' } }, { shared: cargo });
    const ctl = path.join(T, 'ctl-full-target-red');
    fs.writeFileSync(`${ctl}-fullred`, `play ${TARGET_RED}`);
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-511', 'feat/a'], ['T-512', 'feat/b']]);
    fullDue();
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    const tr = evs(/^engine\.full_red_on_target$/);
    const b = baselineOf();
    await guard('2.85 (a) a full run red only on a test no branch is tied to: the batch is not blamed nor bisected; it lands on the second run, an ordinary one (no STUDIO_LAND_FULL); the name goes to .studio/train/unity-full-baseline.json; one engine.full_red_on_target event (warn, to the director, the test named, "a fix task"); the full-run clock counts as served; train status shows "Known red on the target in the full run: 1 test(s)" (fails before this fix: the red full run was searched by land runs and a branch was handed back for the target\'s own failure)', () => [
      r.landed?.join() === 'T-511,T-512' && !r.dropped?.length && !r.handed?.length && r.runs === 2 && runs.length === 2 && runs[0].landFull === '1' && runs[1].landFull === null
        && b?.failing?.join() === TARGET_RED && b.target && tr.length === 1 && tr[0].status === 'warn' && tr[0].to === 'director' && tr[0].msg.includes(TARGET_RED) && /fix task/.test(tr[0].msg)
        && fullRec()?.served && Date.now() - Date.parse(fullRec().at) < 600000 && /Known red on the target in the full run: 1 test\(s\): Game\.Cargo\.Tests\.LoadTests\.FitsTheHold/.test(r.status || ''),
      JSON.stringify({ r, runs, tr: tr.map((e) => [e.msg, e.to, e.status]), b, rec: fullRec() }).slice(0, 3000)]);
    // The same red the next day: still not blamed, and the director is not told again about the same names.
    fs.writeFileSync(evFile, '');
    fs.rmSync(`${ctl}-runs.jsonl`, { force: true });
    const E2 = engineRepo({ 'feat/c': { 'Assets/Ui/Bar.cs': 'class Bar {}\n' } }, { shared: cargo });
    setEngines({ unity: cfgFor(E2, ctl) });
    queue(E2, [['T-513', 'feat/c']]);
    fullDue();
    const r2 = probe(TRAIN);
    await guard('2.85 (a) the same target red in the next full run: the lane lands on the ordinary run again, and engine.full_red_on_target is not written a second time for the same names (fails before this fix: the lone lane was handed back for the target\'s failure)', () => [
      r2.landed?.join() === 'T-513' && !r2.dropped?.length && evs(/^engine\.full_red_on_target$/).length === 0 && baselineOf()?.failing?.join() === TARGET_RED,
      JSON.stringify({ r2, ev: events().map((e) => e.type) }).slice(0, 2000)]);
  }
  {
    resetState();
    const TIED = 'Game.Economy.Tests.ShopTests.AddsUpOnPayday';
    const E = engineRepo({
      'feat/a': { 'Assets/Hangar/Doors.cs': 'class Doors {}\n' },
      'feat/b': { 'Assets/Economy/Tests/ShopTests.cs': 'namespace Game.Economy.Tests { public class ShopTests {} }\n', 'edit-bad.txt': `${rev(TIED)}\n` },
      'feat/c': { 'Assets/Ui/Menu.cs': 'class Menu {}\n' },
    }, { shared: cargo });
    const ctl = path.join(T, 'ctl-full-tied-plus-base');
    fs.writeFileSync(`${ctl}-fullred`, `edit ${TARGET_RED}`);
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-521', 'feat/a'], ['T-522', 'feat/b'], ['T-523', 'feat/c']]);
    fullDue();
    setBaseline([TARGET_RED]);
    const r = probe(TRAIN);
    const d = r.dropped || [];
    await guard('2.85 (a) a full run red on a branch-tied failure plus a baseline failure: only the tied branch (T-522, whose file names ShopTests) is handed back, by evidence; the baseline\'s test is not counted against anyone, so T-521 and T-523 land (fails before this fix: the two failures had no single suspect, the search by land runs blamed the first prefix that was red on the target\'s own test)', () => [
      d.length === 1 && d[0].task === 'T-522' && d[0].cause === 'evidence' && r.landed?.slice().sort().join() === 'T-521,T-523' && r.handed?.length === 1 && r.handed[0].note.includes(TIED)
        && r.logs?.some((l) => /not counted against anyone/.test(l)),
      JSON.stringify({ r }).slice(0, 3000)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } }, { shared: cargo });
    const ctl = path.join(T, 'ctl-full-clears');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-531', 'feat/a']]);
    fullDue();
    setBaseline([TARGET_RED]);
    const r = probe(TRAIN);
    const ce = evs(/^engine\.full_baseline_cleared$/);
    await guard('2.85 (a) the baseline clears when the name passes: a green full run removes the target\'s known-red test from the baseline, writes engine.full_baseline_cleared naming it, and train status no longer shows a known red (fails before this fix: there was no baseline to clear)', () => [
      r.landed?.join() === 'T-531' && baselineOf()?.failing?.length === 0 && ce.length === 1 && ce[0].meta?.tests?.join() === TARGET_RED && !/Known red on the target/.test(r.status || ''),
      JSON.stringify({ r, b: baselineOf(), ce: ce.map((e) => e.meta) }).slice(0, 2000)]);
  }

  // ================= 3. the suspect first, and no repeat of an unchanged red =================
  const LOAD = 'Game.Cargo.Tests.LoadTests.FitsTheHold';
  {
    resetState();
    const E = engineRepo({
      'feat/a': { 'Assets/Hangar/Doors.cs': 'class Doors {}\n' },
      'feat/b': { 'Assets/Cargo/Tests/Support/Crates.cs': 'namespace Game.Cargo.Support { static class Crates {} }\n', 'edit-bad.txt': `${rev(LOAD)}\n` },
      'feat/c': { 'Assets/Ui/Menu.cs': 'class Menu {}\n' },
      'feat/d': { 'Assets/Ui/Bar.cs': 'class Bar {}\n' },
    }, { shared: cargo });
    const ctl = path.join(T, 'ctl-suspect-asm');
    setEngines({ unity: cfgFor(E, ctl, { fullLandHours: 'off' }) });
    queue(E, [['T-541', 'feat/a'], ['T-542', 'feat/b'], ['T-543', 'feat/c'], ['T-544', 'feat/d']]);
    const r = probe(TRAIN, { STUDIO_ENGINE_FULL_LAND_HOURS: 'off' });
    const be = evs(/^task\.train\.unity\.blame$/);
    const d = (r.dropped || [])[0] || {};
    await guard('2.85 (a) the suspect first: the failing test\'s class and namespace name no file a lane changes, but only T-542 changes a file in the test\'s assembly folder (the .asmdef beside LoadTests.cs); the next land run is the batch without T-542 (not a halving search): two runs, T-541, T-543, T-544 land, T-542 is handed back by evidence with the failing name; task.train.unity.blame says plan "without", the suspect and the rule, and the log line says it (fails before this fix: no rule tied the lane, so the train bisected: four or more runs)', () => [
      r.runs === 2 && r.landed?.slice().sort().join() === 'T-541,T-543,T-544' && d.task === 'T-542' && d.cause === 'evidence' && r.handed?.[0]?.note.includes(LOAD)
        && be.length === 1 && be[0].meta?.plan === 'without' && be[0].meta.suspect === 'T-542' && /assembly/.test(be[0].meta.rule || '') && be[0].meta.next?.join() === 'T-541,T-543,T-544'
        && r.logs?.some((l) => /blame plan: exactly one branch is tied/.test(l)),
      JSON.stringify({ r, be: be.map((e) => e.meta) }).slice(0, 3000)]);
  }
  {
    resetState();
    const E = engineRepo({
      'feat/a': { 'Assets/Cargo/Tests/Support/Pallets.cs': 'namespace Game.Cargo.Support { static class Pallets {} }\n' },
      'feat/b': { 'Assets/Cargo/Tests/Support/Crates.cs': 'namespace Game.Cargo.Support { static class Crates {} }\n', 'edit-bad.txt': `${rev(LOAD)}\n` },
      'feat/c': { 'Assets/Ui/Menu.cs': 'class Menu {}\n' },
      'feat/d': { 'Assets/Ui/Bar.cs': 'class Bar {}\n' },
    }, { shared: cargo });
    const ctl = path.join(T, 'ctl-suspect-apart');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-551', 'feat/a'], ['T-552', 'feat/b'], ['T-553', 'feat/c'], ['T-554', 'feat/d']]);
    const r = probe(TRAIN, { STUDIO_ENGINE_FULL_LAND_HOURS: 'off' });
    const be = evs(/^task\.train\.unity\.blame$/);
    await guard('2.85 (a) two tied branches: T-551 and T-552 both change the test\'s assembly folder; the untied T-553 and T-554 land first on the second run (plan "apart" in task.train.unity.blame, with the tied and the next lanes), then only the tied two are searched: T-552 is handed back, T-551 lands (fails before this fix: the whole batch of four was bisected and the untied lanes waited for it)', () => [
      be[0]?.meta?.plan === 'apart' && be[0].meta.tied?.join() === 'T-551,T-552' && be[0].meta.next?.join() === 'T-553,T-554' && r.landed?.slice(0, 2).join() === 'T-553,T-554'
        && r.dropped?.length === 1 && r.dropped[0].task === 'T-552' && r.landed?.includes('T-551'),
      JSON.stringify({ r, be: be.map((e) => e.meta) }).slice(0, 3000)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'Assets/Cargo/Tests/Support/Crates.cs': 'namespace Game.Cargo.Support { static class Crates {} }\n', 'edit-bad.txt': `${rev(LOAD)}\n` } }, { shared: cargo });
    const ctl = path.join(T, 'ctl-unchanged');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-561', 'feat/a']]);
    const r0 = probe(TRAIN, { STUDIO_ENGINE_FULL_LAND_HOURS: 'off' });
    // The target moves (a file the red's evidence does not name); the branch only merges the target in.
    write(E.GW, 'other.txt', 'other\n'); g(E.GW, 'add', '-A'); g(E.GW, 'commit', '-qm', 'target moves');
    const mergeTarget = () => { g(E.R, 'checkout', '-q', 'feat/a'); g(E.R, 'merge', '-q', '--no-ff', '-m', 'bring the target in', 'port/main'); g(E.R, 'checkout', '-q', 'dev'); };
    mergeTarget();
    const Q = (extra) => probe(`import { queueUnityTask, dequeueUnity } from ${u('harness/unity-train.mjs')};
const r = queueUnityTask(process.cwd(), { engine: 'unity', task: 'T-561', agent: 'porter-0', ${extra} });
if (r.ok) dequeueUnity(process.cwd(), 'T-561', 'unity');
console.log(JSON.stringify({ ok: r.ok, error: r.error || null, message: r.message }));`);
    const refused = Q("branch: 'feat/a'");
    const forced = Q("branch: 'feat/a', again: true");
    const rq = evs(/^task\.train\.unity\.requeued_unchanged$/);
    // The target changes the failing test's own file: the same red may not repeat, so the branch is queued.
    write(E.GW, 'Assets/Cargo/Tests/LoadTests.cs', 'namespace Game.Cargo.Tests { public class LoadTests { int fixedOnTarget; } }\n'); g(E.GW, 'add', '-A'); g(E.GW, 'commit', '-qm', 'target fixes the test');
    mergeTarget();
    const after = Q("branch: 'feat/a'");
    // A commit of its own: queued.
    const E2 = E;
    g(E2.R, 'checkout', '-q', 'feat/a'); write(E2.R, 'fix.txt', 'fix\n'); g(E2.R, 'add', '-A'); g(E2.R, 'commit', '-qm', 'a fix'); g(E2.R, 'checkout', '-q', 'dev');
    const own = Q("branch: 'feat/a'");
    await guard('2.85 (a) no repeat of an unchanged red: after train X handed T-561 back, a branch that only merged the target in (and the target changed none of the red\'s evidence files) is refused by the engine queue path with "nothing changed since train ... the same red would repeat" and the impossible command; --again queues it anyway with a task.train.unity.requeued_unchanged event; once the target changed the failing test\'s own file (merged in), or the branch has a commit of its own, it is queued (fails before this fix: the unchanged branch was queued and the same red repeated, three times in one crew\'s log)', () => [
      r0.dropped?.[0]?.task === 'T-561' && refused.ok === false && refused.error === 'unchanged' && /nothing changed since Unity train \S+ handed feat\/a back for .*the same red would repeat/.test(refused.message) && /task -- impossible T-561/.test(refused.message)
        && forced.ok === true && rq.length === 1 && rq[0].task === 'T-561' && after.ok === true && own.ok === true,
      JSON.stringify({ r0: r0.dropped, refused, forced, rq: rq.length, after, own }).slice(0, 2500)]);
  }

  // ================= 4. a UI branch runs only its own panel's Play Mode tests plus a smoke =================
  const playCfg = { map: [{ match: '^Assets/UI/Panels/([A-Za-z]+)/', filter: 'Game.PlayTests.Panels.$1' }, { match: '^Assets/Tests/PlayMode/Panels/([A-Za-z]+)Shot', filter: 'Game.PlayTests.Panels.$1' }], smoke: 'Game.PlayTests.Smoke', ignore: ['\\.md$'], skip: ['^Assets/Sim/'] };
  {
    const r = probe(`import { playSelection } from ${u('harness/engine-rules.mjs')};
const cfg = { play: { focus: ${JSON.stringify(playCfg)} } };
console.log(JSON.stringify({
  panel: playSelection({ changed: ['Assets/UI/Panels/Shop/ShopPanel.cs', 'Assets/Tests/PlayMode/Panels/ShopShotTests.cs', 'docs/shop.md'], cfg }),
  two: playSelection({ changed: ['Assets/UI/Panels/Shop/ShopPanel.cs', 'Assets/UI/Panels/Maps/MapsPanel.cs'], cfg }),
  unmapped: playSelection({ changed: ['Assets/UI/Panels/Shop/ShopPanel.cs', 'Assets/UI/Hud.cs', 'Assets/Scenes/Main.unity', 'Assets/Sim/Shop.cs'], cfg }),
}));`);
    await guard('2.85 (a) play focus per panel: a batch whose paths all match map entries (or ignore) runs focus with its own panel\'s filter plus smoke; two panels give both filters plus smoke; a path no entry takes makes it full, and the reason and the result NAME every unmatched path (up to 5), a play.focus.skip path in a mixed batch said as such (fails before this fix: only the first unmatched path was named)', () => [
      r.panel?.mode === 'focus' && r.panel.filter === 'Game.PlayTests.Panels.Shop;Game.PlayTests.Smoke' && r.two?.filter === 'Game.PlayTests.Panels.Shop;Game.PlayTests.Panels.Maps;Game.PlayTests.Smoke'
        && r.unmapped?.mode === 'full' && r.unmapped.unmatched?.join() === 'Assets/UI/Hud.cs,Assets/Scenes/Main.unity,Assets/Sim/Shop.cs' && /3 changed path\(s\) match no play\.focus\.map entry: Assets\/UI\/Hud\.cs, Assets\/Scenes\/Main\.unity, Assets\/Sim\/Shop\.cs \(play\.focus\.skip/.test(r.unmapped.why),
      JSON.stringify(r).slice(0, 2000)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'Assets/UI/Panels/Shop/ShopPanel.cs': 'class ShopPanel {}\n' }, 'feat/b': { 'Assets/UI/Hud.cs': 'class Hud {}\n' } });
    const ctl = path.join(T, 'ctl-play-panel');
    setEngines({ unity: cfgFor(E, ctl, { play: { focus: playCfg } }) });
    const cli = (args) => spawnSync(process.execPath, [path.join(S, 'harness', 'engine.mjs'), 'play-plan', ...args], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 120000 });
    const p1 = cli(['--paths', 'Assets/UI/Panels/Maps/MapsPanel.cs,README.md']);
    const p2 = cli(['--branch', 'feat/b']);
    const p3 = cli(['--branch', 'feat/a', '--json']);
    let j3 = null; try { j3 = JSON.parse(String(p3.stdout).trim().split('\n').pop()); } catch { /* checked below */ }
    await guard('2.85 (a) npm run engine -- play-plan: --paths prints the focus plan and its filter; --branch reads the branch\'s changes against the target and names the unmapped path with what to do; --json gives the selection; nothing is queued or run (fails before this fix: there was no play-plan command)', () => [
      p1.status === 0 && /focus with the filter Game\.PlayTests\.Panels\.Maps;Game\.PlayTests\.Smoke/.test(out(p1)) && p2.status === 0 && /: full/.test(out(p2)) && /Assets\/UI\/Hud\.cs; add an entry/.test(out(p2))
        && j3?.selection?.mode === 'focus' && j3.changed?.join() === 'Assets/UI/Panels/Shop/ShopPanel.cs' && runsOf(ctl).length === 0 && !fs.existsSync(path.join(S, '.studio', 'train', 'unity-queue.json')),
      JSON.stringify({ p1: out(p1), p2: out(p2), p3: out(p3) }).slice(0, 2500)]);
    queue(E, [['T-571', 'feat/a']]);
    const r1 = probe(TRAIN, { STUDIO_ENGINE_FULL_LAND_HOURS: 'off' });
    queue(E, [['T-572', 'feat/b']]);
    const r2 = probe(TRAIN, { STUDIO_ENGINE_FULL_LAND_HOURS: 'off' });
    const runs = runsOf(ctl);
    const done = evs(/^task\.train\.unity\.done$/).pop();
    await guard('2.85 (a) play focus per panel through the train: the panel branch lands with STUDIO_PLAY_MODE=focus and its panel filter plus smoke; a branch with an unmapped path lands with the full stage, and the train\'s log line and its done event meta (playUnmatched) name that path (fails before this fix: the full stage said nothing about which path had no map entry)', () => [
      r1.landed?.join() === 'T-571' && runs[0]?.playMode === 'focus' && runs[0].playFilter === 'Game.PlayTests.Panels.Shop;Game.PlayTests.Smoke'
        && r2.landed?.join() === 'T-572' && runs[1]?.playMode === 'full' && r2.logs?.some((l) => /play stage in full: .*Assets\/UI\/Hud\.cs/.test(l)) && done?.meta?.playUnmatched?.join() === 'Assets/UI/Hud.cs',
      JSON.stringify({ r1, r2, runs, done: done?.meta }).slice(0, 2500)]);
  }
}
