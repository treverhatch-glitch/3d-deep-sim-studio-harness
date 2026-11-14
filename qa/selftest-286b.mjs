/**
 * qa/selftest-286b.mjs — 2.86 (b): what an engine train does with a red land run. A red on tests the studio lists as flaky is
 * run again by name (engines.<x>.flakyRetries), then on the target alone (a probe: no branch); red there too, nobody is handed
 * back and the lanes wait for the target. The known-red contract (off by default). The daily full run is its own run on the
 * target alone, never a step of a red. No confirm run after a clean prefix proof; a recorded green probe is not run again;
 * engines.<x>.batchAlone; and the shape of a crew's 6-branch train, counted in land runs.
 *
 * The scaffolding (a studio copy, a made-up engine repo, a stand-in land script that records what it was told) is
 * qa/selftest-285a.mjs's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest286B({ dir, root, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const T = path.join(tmpRoot, `s286b-${process.pid}`);
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
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-286b-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file, engine settings) ----
  const S = path.join(tmpRoot, `286b-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-286b.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const evs = (re) => events().filter((e) => re.test(e.type));
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-286b-${++pn}.mjs`);
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
  // The land script stand-in (qa/selftest-285a.mjs's, plus): <ctl>-flaky "stage name count" fails that test in the first `count`
  // runs; <ctl>-alwaysred "stage name" fails it on every run, the target alone included (the target's own red); "<stage>-bad.txt"
  // in the merged tree fails that stage on the test it holds ("rev:" + the name reversed). Names in STUDIO_LAND_KNOWN_RED are left
  // out of the verdict when <ctl>-honour exists. STUDIO_LAND_PROBE=1: land nothing. Each run is recorded.
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const E = process.env;
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const opt = (k) => { try { return fs.readFileSync(ctl + '-' + k, 'utf8').trim(); } catch { return null; } };
let lock = {}; try { lock = JSON.parse(fs.readFileSync(path.join(E.STUDIO_MAIN_ROOT, '.studio', 'locks', 'unity-train.lock'), 'utf8')); } catch {}
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, before, only: E.STUDIO_LAND_ONLY ?? null, landFull: E.STUDIO_LAND_FULL ?? null, probe: E.STUDIO_LAND_PROBE ?? null, retry: E.STUDIO_LAND_RETRY ?? null, retryTests: E.STUDIO_LAND_RETRY_TESTS ?? null, knownRed: E.STUDIO_LAND_KNOWN_RED ?? null, playMode: E.STUDIO_PLAY_MODE ?? null, now: lock.now ?? null }) + '\\n');
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); console.log('conflict ' + s); process.exit(2); } }
if (E.STUDIO_LAND_ONLY === 'compile') { git(gw, 'reset', '-q', '--hard', before); console.log('compiles'); process.exit(0); }
const order = ['merge', 'edit', 'play', 'build'];
let reds = [];
const fl = opt('flaky');
if (fl) { const [st, name, count] = fl.split(' '); const n = Number(opt('flakycount') || 0); fs.writeFileSync(ctl + '-flakycount', String(n + 1)); if (n < Number(count)) reds.push([st, [name]]); }
const ar = opt('alwaysred');
if (ar) { const [st, name] = ar.split(' '); reds.push([st, [name]]); }
for (const st of ['edit', 'play']) { const f = path.join(gw, st + '-bad.txt'); if (fs.existsSync(f)) { const t = fs.readFileSync(f, 'utf8').trim(); reds.push([st, [t.startsWith('rev:') ? t.slice(4).split('').reverse().join('') : t]]); } }
if (E.STUDIO_LAND_PROBE === '1' && opt('moveonprobe') !== null) { fs.writeFileSync(path.join(gw, 'moved.txt'), String(Date.now())); git(gw, 'add', '-A'); git(gw, 'commit', '-qm', 'a script that ignores STUDIO_LAND_PROBE'); console.log('landed anyway'); process.exit(0); }
if (E.STUDIO_LAND_PROBE === '1' && opt('noack') === null) console.log('[land-probe] honoured');
if (opt('honour') !== null && E.STUDIO_LAND_KNOWN_RED) { const k = E.STUDIO_LAND_KNOWN_RED.split(';'); reds = reds.map(([st, n]) => [st, n.filter((x) => !k.includes(x))]).filter(([, n]) => n.length); }
const stages = (bad) => { if (E.STUDIO_LAND_RESULT) fs.writeFileSync(E.STUDIO_LAND_RESULT, JSON.stringify({ gates: Object.fromEntries(order.map((n, i) => [n, bad && order.indexOf(bad) < i ? null : { status: n === bad ? 'fail' : 'pass', seconds: 10 }]).filter(([, v]) => v)) })); };
if (reds.length) {
  reds.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  git(gw, 'reset', '-q', '--hard', before);
  stages(reds[0][0]);
  if (opt('quiet') === null) for (const [, names] of reds) for (const n of names) console.log('  Failed ' + n + ' [3 ms]');
  console.log(reds.reduce((k, [, n]) => k + n.length, 0) + ' test(s) failed');
  process.exit(1);
}
stages(null);
if (E.STUDIO_LAND_PROBE === '1') { git(gw, 'reset', '-q', '--hard', before); console.log('target alone: green, nothing landed'); process.exit(0); }
console.log('landed ' + srcs.join(' '));
`);
  const runsOf = (ctl) => { try { return fs.readFileSync(`${ctl}-runs.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const cfgFor = (E, ctl, extra = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, rules: false, ...extra });
  const queue = (E, lanes) => { fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true }); fs.writeFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), JSON.stringify(lanes.map(([task, branch], i) => ({ task, agent: `porter-${i}`, branch, head: E.heads[branch], at: new Date(Date.now() + i).toISOString() })))); };
  const queueNow = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), 'utf8')); } catch { return []; } };
  const fullAge = (hours) => { fs.mkdirSync(path.join(S, '.studio', 'engine'), { recursive: true }); fs.writeFileSync(path.join(S, '.studio', 'engine', 'unity-full-land.json'), JSON.stringify({ at: new Date(Date.now() - hours * 3600000).toISOString(), id: 'old' })); };
  const fullRec = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'engine', 'unity-full-land.json'), 'utf8')); } catch { return null; } };
  const handbacks = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'unity-handbacks.json'), 'utf8')); } catch { return {}; } };
  const tipOf = (E) => g(E.R, 'rev-parse', 'port/main').stdout.trim();
  const TRAIN = `import { runUnityTrain, readUnityQueue, unityStatusText } from ${u('harness/unity-train.mjs')};
const handed = []; const logs = [];
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps: { handBack: (lane, note, extra) => handed.push({ task: lane.task, note, extra: extra || null }) } });
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, landed: r.landed, dropped: r.dropped, deferred: r.deferred, waitTarget: r.waitTarget || null, full: r.full || null, fullLand: r.fullLand || 0, fullRedOnTarget: r.fullRedOnTarget || null, batch: r.batch || null, message: r.message, handed, logs: logs.filter((l) => /full|blame plan|target alone|recorded green|not run again|no run of|confirm|by name/.test(l)), queue: readUnityQueue(process.cwd()).map((e) => e.task), status: unityStatusText(process.cwd(), { engine: 'unity' }) }));`;
  const rev = (s) => `rev:${s.split('').reverse().join('')}`;
  const FLAKY = 'Game.Slice.PlayTests.TurnTests.RunsInOrderOnScreen';
  const NOFULL = { STUDIO_ENGINE_FULL_LAND_HOURS: 'off' };

  // ================= 1. a red on a listed flaky test passes on the second retry =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n' } });
    const ctl = path.join(T, 'ctl-flaky-2nd');
    fs.writeFileSync(`${ctl}-flaky`, `play ${FLAKY} 2`);
    setEngines({ unity: cfgFor(E, ctl, { flakyTests: [FLAKY] }) });
    queue(E, [['T-601', 'feat/a'], ['T-602', 'feat/b']]);
    const r = probe(TRAIN, NOFULL);
    const runs = runsOf(ctl);
    const re = evs(/^task\.train\.unity\.retry$/);
    const fe = evs(/^task\.train\.unity\.flaky$/);
    await guard('2.86 (b) a red on a listed flaky test only is run again by name up to engines.<x>.flakyRetries (default 2) times: red, retry 1 red, retry 2 green: both lanes land on that run, nobody is handed back; two retry events (meta n 1 and 2), one flaky event (meta retry 2) (fails before this fix: one retry only, then the batch was searched by land runs and a lane was handed back)', () => [
      r.landed?.join() === 'T-601,T-602' && !r.dropped?.length && !r.handed?.length && r.runs === 3 && runs.length === 3 && runs[1].retryTests === FLAKY && runs[2].retryTests === FLAKY
        && re.length === 2 && re[0].meta?.n === 1 && re[1].meta?.n === 2 && fe.length === 1 && fe[0].meta?.retry === 2 && !runs.some((x) => x.probe),
      JSON.stringify({ r, runs, re: re.map((e) => e.meta), fe: fe.map((e) => e.meta) }).slice(0, 3000)]);
  }

  // ================= 2. red on every retry and red on the target alone: the target is red =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n' } });
    const ctl = path.join(T, 'ctl-target-red');
    fs.writeFileSync(`${ctl}-alwaysred`, `play ${FLAKY}`);
    setEngines({ unity: cfgFor(E, ctl, { flakyTests: [FLAKY] }) });
    queue(E, [['T-611', 'feat/a'], ['T-612', 'feat/b']]);
    const tip0 = tipOf(E);
    const r = probe(TRAIN, NOFULL);
    const runs = runsOf(ctl);
    const rot = evs(/^engine\.red_on_target$/);
    const wt = evs(/^task\.train\.unity\.waiting_target$/);
    const q = queueNow();
    await guard('2.86 (b) red on all retries, then the same test run on the target alone (no branch: STUDIO_LAND_PROBE=1, its branch a ref at the target\'s tip, STUDIO_LAND_RETRY_TESTS the name) is red too: nobody is handed back, no hand-back record, both lanes stay queued (marked waitTarget, same order), one engine.red_on_target to the planner naming the test and asking for a fix task, the target did not move; 4 runs (fails before this fix: after one retry the lanes were searched and one was handed back for the target\'s own red)', () => [
      !r.landed?.length && !r.dropped?.length && !r.handed?.length && Object.keys(handbacks()).length === 0 && r.runs === 4 && runs.length === 4
        && runs[3].probe === '1' && runs[3].retryTests === FLAKY && runs[3].srcs.length === 1 && /^unity-train\/.*-target$/.test(runs[3].srcs[0]) && runs[3].before === tip0 && tipOf(E) === tip0
        && q.map((e) => e.task).join() === 'T-611,T-612' && q.every((e) => e.waitTarget?.target === tip0 && e.waitTarget.tests?.includes(FLAKY))
        && rot.length === 1 && rot[0].to === 'planner' && rot[0].msg.includes(FLAKY) && /fix task/.test(rot[0].msg) && wt.length === 1 && r.waitTarget?.tests?.includes(FLAKY)
        && /2 Unity lane\(s\) wait for the target to move/.test(r.status || ''),
      JSON.stringify({ r, runs, rot: rot.map((e) => [e.to, e.msg]), q }).slice(0, 3000)]);
    await guard('2.86 (b) the known-red contract is off by default: the probe found the target red and still no run was told STUDIO_LAND_KNOWN_RED and there is no task.train.unity.known_red event (fails before this fix: no probe at all, so the check above failed first)', () => [
      runs.length === 4 && runs[3].probe === '1' && runs.every((x) => x.knownRed === null) && evs(/^task\.train\.unity\.known_red$/).length === 0,
      JSON.stringify(runs).slice(0, 1500)]);
    // The next train, the target not moved: the waiting lanes sit out; no run, no second page.
    fs.writeFileSync(evFile, '');
    const r2 = probe(TRAIN, NOFULL);
    await guard('2.86 (b) the next train while the target has not moved: the lanes that wait for the target are not taken (no land run, the batch line says they wait for the target), and engine.red_on_target is not written again (fails before this fix: the same lanes were run and blamed again)', () => [
      r2.runs === 0 && runsOf(ctl).length === 4 && /2 wait for the target/.test(r2.message || '') && evs(/^engine\.red_on_target$/).length === 0 && queueNow().length === 2,
      JSON.stringify({ r2 }).slice(0, 2000)]);
  }

  // ================= 3. the target alone is green: blame goes on =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n', 'play-bad.txt': `${rev(FLAKY)}\n` } });
    const ctl = path.join(T, 'ctl-probe-green');
    setEngines({ unity: cfgFor(E, ctl, { flakyTests: [FLAKY] }) });
    queue(E, [['T-621', 'feat/a'], ['T-622', 'feat/b']]);
    const r = probe(TRAIN, NOFULL);
    const runs = runsOf(ctl);
    const pe = evs(/^task\.train\.unity\.probe$/);
    await guard('2.86 (b) the probe passes on the target alone: blame goes on, by name (the probe showed the land script honours STUDIO_LAND_PROBE): [a] by name green, T-622 alone by name red (the confirm, 2.83), nothing landed by them; T-622 is handed back, T-621 lands on one complete run; one task.train.unity.probe event; no engine.red_on_target (fails before this fix: there was no probe)', () => [
      r.landed?.join() === 'T-621' && r.dropped?.map((d) => d.task).join() === 'T-622' && runs.length === 7 && runs.filter((x) => x.probe === '1').length === 3 && runs[6].retryTests === null && runs[6].srcs.join() === 'feat/a'
        && pe.length === 1 && evs(/^engine\.red_on_target$/).length === 0 && r.logs?.some((l) => /the target alone is green/.test(l)),
      JSON.stringify({ r, runs: runs.map((x) => [x.srcs, x.probe, x.retryTests]) }).slice(0, 3000)]);
  }

  // ================= 4. the known-red contract, on =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n' }, 'feat/c': { 'c.txt': 'c\n' } });
    const ctl = path.join(T, 'ctl-known-red');
    fs.writeFileSync(`${ctl}-alwaysred`, `play ${FLAKY}`);
    fs.writeFileSync(`${ctl}-honour`, '1');
    setEngines({ unity: cfgFor(E, ctl, { flakyTests: [FLAKY], knownRedHours: 24 }) });
    queue(E, [['T-631', 'feat/a'], ['T-632', 'feat/b']]);
    const r = probe(TRAIN, NOFULL);
    const runs = runsOf(ctl);
    const kr = evs(/^task\.train\.unity\.known_red$/);
    await guard('2.86 (b) known-red on (engines.<x>.knownRedHours 24): after the probe found the flaky test red on the target alone, one more run by name tells the land script STUDIO_LAND_KNOWN_RED=<the name>; a script that honours it lands the batch; the use is a task.train.unity.known_red event naming the test and the probe\'s train (fails before this fix: no such contract)', () => [
      r.landed?.join() === 'T-631,T-632' && !r.dropped?.length && runs.length === 5 && runs[3].probe === '1' && runs[4].knownRed === FLAKY && runs.slice(0, 4).every((x) => x.knownRed === null)
        && kr.length === 1 && kr[0].meta?.tests?.join() === FLAKY && kr[0].meta.probes?.[0]?.train && evs(/^engine\.red_on_target$/).length === 0,
      JSON.stringify({ r, runs: runs.map((x) => [x.probe, x.knownRed, x.retryTests]), kr: kr.map((e) => e.meta) }).slice(0, 3000)]);
    fs.writeFileSync(evFile, '');
    fs.rmSync(`${ctl}-runs.jsonl`, { force: true });
    queue(E, [['T-633', 'feat/c']]);
    const r2 = probe(TRAIN, NOFULL);
    const runs2 = runsOf(ctl);
    await guard('2.86 (b) known-red on, the next train: its first land run is told the known-red name at once and lands on one run; one known_red event (fails before this fix: no such contract)', () => [
      r2.landed?.join() === 'T-633' && r2.runs === 1 && runs2[0]?.knownRed === FLAKY && evs(/^task\.train\.unity\.known_red$/).length === 1,
      JSON.stringify({ r2, runs2 }).slice(0, 2000)]);
  }

  // ================= 5. the daily full run: on the target alone, never a step of a red =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } });
    const ctl = path.join(T, 'ctl-full-idle');
    setEngines({ unity: cfgFor(E, ctl) });
    fullAge(30);
    const tip0 = tipOf(E);
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    const fe = evs(/^task\.train\.unity\.full_land$/);
    await guard('2.86 (b) the full run is due (30 h, fullLandHours 24) and the queue is empty: the train runs it on the target alone (STUDIO_LAND_FULL=1, STUDIO_LAND_PROBE=1, its branch a ref at the target\'s tip), the target does not move, the full-run clock restarts, one full_land event with no tasks (fails before this fix: with no branch queued no full run ever ran)', () => [
      runs.length === 1 && runs[0].landFull === '1' && runs[0].probe === '1' && /-target$/.test(runs[0].srcs[0]) && tipOf(E) === tip0 && fullRec()?.id !== 'old' && Date.now() - Date.parse(fullRec()?.at) < 600000
        && fe.length === 1 && fe[0].meta?.tasks?.length === 0 && r.full?.status === 'pass',
      JSON.stringify({ r, runs, fe: fe.map((e) => e.meta), rec: fullRec() }).slice(0, 2500)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n', 'edit-bad.txt': `${rev('Game.Made.Up.Tests.BrokenTests.Breaks')}\n` }, 'feat/c': { 'c.txt': 'c\n' } });
    const ctl = path.join(T, 'ctl-full-not-in-steps');
    setEngines({ unity: cfgFor(E, ctl) });
    fullAge(30);
    queue(E, [['T-651', 'feat/a'], ['T-652', 'feat/b'], ['T-653', 'feat/c']]);
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    await guard('2.86 (b) the full run is due (30 h) but branches are queued: no run of the train is a full run (not the batch, not a bisect step); T-652 is handed back, T-651 and T-653 land, and the full run stays due (fails before this fix: the first land run of the batch was the daily full run)', () => [
      runs.length >= 3 && runs.every((x) => x.landFull === null) && r.dropped?.map((d) => d.task).join() === 'T-652' && r.landed?.slice().sort().join() === 'T-651,T-653' && fullRec()?.id === 'old',
      JSON.stringify({ r, runs: runs.map((x) => [x.srcs, x.landFull]) }).slice(0, 2500)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } });
    const ctl = path.join(T, 'ctl-full-overdue');
    setEngines({ unity: cfgFor(E, ctl) });
    fullAge(50);
    queue(E, [['T-661', 'feat/a']]);
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    await guard('2.86 (b) the full run is overdue (50 h, past fullLandMaxHours = 2 x 24): at the start of the train, before any lane, it runs on the target alone; then the lane lands on an ordinary run (no STUDIO_LAND_FULL) (fails before this fix: the full run rode the lane\'s land run)', () => [
      runs.length === 2 && runs[0].landFull === '1' && runs[0].probe === '1' && runs[1].landFull === null && runs[1].probe === null && runs[1].srcs.join() === 'feat/a' && r.landed?.join() === 'T-661' && r.full?.overdue === true,
      JSON.stringify({ r, runs }).slice(0, 2500)]);
  }

  // ================= 6. the search by name; complete runs when no test is named =================
  {
    resetState();
    const BAD = 'Game.Made.Up.Tests.BrokenTests.Breaks';
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n', 'edit-bad.txt': `${rev(BAD)}\n` }, 'feat/c': { 'c.txt': 'c\n' }, 'feat/d': { 'd.txt': 'd\n' } });
    const ctl = path.join(T, 'ctl-by-name');
    setEngines({ unity: cfgFor(E, ctl, { landProbe: true }) });
    queue(E, [['T-671', 'feat/a'], ['T-672', 'feat/b'], ['T-673', 'feat/c'], ['T-674', 'feat/d']]);
    const tip0 = tipOf(E);
    const r = probe(TRAIN, NOFULL);
    const runs = runsOf(ctl);
    const byName = runs.filter((x) => x.probe === '1');
    const be = evs(/^task\.train\.unity\.bisect$/);
    await guard('2.86 (b) the search by name: [a,b,c,d] red on a named test; [a,b] by name red, [a] by name green, b alone by name red (the confirm, kept), each with STUDIO_LAND_PROBE=1 and only the failing test, none landing or moving the target; b is handed back; a, c, d land on ONE complete run: 5 runs, 2 complete; the log says "by name: 1 test(s), does not land" (fails before this fix: every step was a complete land run, 5 complete runs)', () => [
      r.runs === 5 && runs.length === 5 && byName.length === 3 && byName.every((x) => x.retryTests === BAD && x.before === tip0)
        && runs[4].retryTests === null && runs[4].probe === null && r.dropped?.map((d) => d.task).join() === 'T-672' && r.landed?.join() === 'T-671,T-673,T-674'
        && be.length === 1 && be[0].meta?.byName === true && r.logs?.filter((l) => /by name: 1 test\(s\), does not land/.test(l)).length === 3,
      JSON.stringify({ n: r.runs, landed: r.landed, dropped: r.dropped?.map((d) => d.task), logs: r.logs, runs: runs.map((x) => [x.srcs, x.probe, x.retryTests, x.before === tip0]), be: be.map((e) => e.meta) }).slice(0, 3000)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n', 'edit-bad.txt': `${rev('Game.Made.Up.Tests.BrokenTests.Breaks')}\n` } });
    const ctl = path.join(T, 'ctl-no-names');
    fs.writeFileSync(`${ctl}-quiet`, '1');
    setEngines({ unity: cfgFor(E, ctl, { landProbe: true }) });
    queue(E, [['T-675', 'feat/a'], ['T-676', 'feat/b']]);
    const r = probe(TRAIN, NOFULL);
    const runs = runsOf(ctl);
    await guard('2.86 (b) a red that names no test (here the land script prints no names): every step is a complete run as before: [a,b] red, [a] lands, b alone red (the confirm) and is handed back; no run is told STUDIO_LAND_PROBE and the bisect event says byName false (fails before this fix: the bisect event did not say how its steps ran)', () => [
      evs(/^task\.train\.unity\.bisect$/)[0]?.meta?.byName === false && r.runs === 3 && runs.every((x) => x.probe === null && x.retryTests === null) && r.landed?.join() === 'T-675' && r.dropped?.map((d) => d.task).join() === 'T-676' && runs[2].srcs.join() === 'feat/b'
        && !fs.existsSync(path.join(S, '.studio', 'train', 'unity-probe.json')) && fs.existsSync(path.join(S, '.studio', 'train', 'unity-flakes.json')) === false,
      JSON.stringify({ r, runs }).slice(0, 2000)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n' } });
    const ctl = path.join(T, 'ctl-moves');
    fs.writeFileSync(`${ctl}-alwaysred`, `play ${FLAKY}`);
    fs.writeFileSync(`${ctl}-moveonprobe`, '1');
    setEngines({ unity: cfgFor(E, ctl, { flakyTests: [FLAKY] }) });
    queue(E, [['T-677', 'feat/a'], ['T-678', 'feat/b']]);
    const tip0 = tipOf(E);
    const r = probe(TRAIN, NOFULL);
    const pm = evs(/^task\.train\.unity\.probe_moved_target$/);
    let pj = null; try { pj = JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'unity-probe.json'), 'utf8')); } catch { /* checked below */ }
    await guard('2.86 (b) a land script that commits on a probe anyway (it ignores STUDIO_LAND_PROBE): the train sees the target moved, stops with nobody handed back and both lanes still queued, writes task.train.unity.probe_moved_target (blocked, to the producer) and withdraws by-name steps (.studio/train/unity-probe.json revoked) (fails before this fix: there was no probe)', () => [
      tipOf(E) !== tip0 && !r.landed?.length && !r.dropped?.length && !r.handed?.length && r.deferred?.length === 2 && queueNow().length === 2 && pm.length === 1 && pm[0].status === 'blocked' && pj?.revoked === true,
      JSON.stringify({ r, pm: pm.map((e) => e.msg), pj }).slice(0, 2500)]);
  }

  // ================= 7. a recorded green probe is not run again =================
  {
    resetState();
    const E = engineRepo({ 'feat/b': { 'b.txt': 'b\n', 'play-bad.txt': `${rev(FLAKY)}\n` } });
    const ctl = path.join(T, 'ctl-green-record');
    setEngines({ unity: cfgFor(E, ctl, { flakyTests: [FLAKY] }) });
    queue(E, [['T-681', 'feat/b']]);
    const r1 = probe(TRAIN, NOFULL);
    const n1 = runsOf(ctl).length;
    queue(E, [['T-681', 'feat/b']]);
    fs.writeFileSync(evFile, '');
    const r2 = probe(TRAIN, NOFULL);
    const runs = runsOf(ctl);
    const gr = evs(/^task\.train\.unity\.green_reused$/);
    await guard('2.86 (b) the green record: train 1 ran the probe on the target alone (green, recorded in .studio/train/unity-green.json) and handed T-681 back; train 2 on the same target needs the same probe: it is not run again (task.train.unity.green_reused, the log says "not run again"), so train 2 takes one land run fewer (fails before this fix: no probe, no record)', () => [
      r1.dropped?.[0]?.task === 'T-681' && n1 === 4 && runs.filter((x) => x.probe === '1').length === 1 && r2.runs === 3 && runs.length === 7 && r2.dropped?.[0]?.task === 'T-681'
        && gr.length === 1 && r2.logs?.some((l) => /not run again/.test(l)),
      JSON.stringify({ r1: r1.runs, r2, gr: gr.map((e) => e.meta) }).slice(0, 2500)]);
  }

  // ================= 8. engines.<x>.batchAlone =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'Assets/Tests/PlayMode/Long/WeekDriverTests.cs': 'class WeekDriverTests {}\n' }, 'feat/c': { 'c.txt': 'c\n' } });
    const ctl = path.join(T, 'ctl-batch-alone');
    setEngines({ unity: cfgFor(E, ctl, { batchAlone: ['^Assets/Tests/PlayMode/Long/'] }) });
    queue(E, [['T-691', 'feat/a'], ['T-692', 'feat/b'], ['T-693', 'feat/c']]);
    const r1 = probe(TRAIN, NOFULL);
    const r2 = probe(TRAIN, NOFULL);
    const r3 = probe(TRAIN, NOFULL);
    await guard('2.86 (b) engines.<x>.batchAlone: T-692 changes a path under Assets/Tests/PlayMode/Long/, so it lands alone: train 1 takes T-691 and stops before it (the batch line names the path), train 2 lands T-692 by itself, train 3 T-693 (fails before this fix: all three rode one land run)', () => [
      r1.landed?.join() === 'T-691' && /stops before T-692, which lands alone \(it changes Assets\/Tests\/PlayMode\/Long\/WeekDriverTests\.cs/.test(r1.batch || '') && r2.landed?.join() === 'T-692' && /T-692 lands alone/.test(r2.batch || '') && r3.landed?.join() === 'T-693',
      JSON.stringify({ r1: [r1.landed, r1.batch], r2: [r2.landed, r2.batch], r3: [r3.landed, r3.batch] }).slice(0, 2000)]);
  }

  // ================= 9. the shape of a crew's 6-branch train (made-up names) =================
  // Six branches, one dropped before the land run (here: never queued). Of five: the second makes the listed flaky test red every
  // time; the first and the fifth change files in the test's assembly folder (the 2.85 rules tie them, wrongly); the full run is due
  // (30 h). The crew's train took 7 land runs, one of them the 2.6 h daily full run inside the bisect.
  {
    resetState();
    const LOAD = 'Game.Cargo.Tests.LoadTests.FitsTheHold';
    const cargo = { 'Assets/Cargo/Tests/Cargo.Tests.asmdef': '{ "name": "Cargo.Tests" }\n', 'Assets/Cargo/Tests/LoadTests.cs': 'namespace Game.Cargo.Tests { public class LoadTests { } }\n' };
    const E = engineRepo({
      'feat/fees': { 'Assets/Cargo/Tests/Support/Pallets.cs': 'namespace Game.Cargo.Support { static class Pallets {} }\n' },
      'feat/turn': { 'Assets/Ui/Turn.cs': 'class Turn {}\n', 'play-bad.txt': `${rev(LOAD)}\n` },
      'feat/grass': { 'Assets/Art/Grass.txt': 'grass\n' },
      'feat/planes': { 'Assets/Art/Planes.txt': 'planes\n' },
      'feat/inbox': { 'Assets/Cargo/Tests/Support/Crates.cs': 'namespace Game.Cargo.Support { static class Crates {} }\n' },
    }, { shared: cargo });
    const ctl = path.join(T, 'ctl-crew-shape');
    setEngines({ unity: cfgFor(E, ctl, { flakyTests: [LOAD] }) });
    fullAge(30);
    queue(E, [['T-701', 'feat/fees'], ['T-702', 'feat/turn'], ['T-703', 'feat/grass'], ['T-704', 'feat/planes'], ['T-705', 'feat/inbox']]);
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    const byName = runs.filter((x) => x.retryTests);
    const be = evs(/^task\.train\.unity\.blame$/);
    await guard('2.86 (b) the crew\'s 6-branch shape, recorded outcomes: 9 land runs, only 2 of them complete (the batch, then the four survivors); 7 by name (2 retries, the probe on the target alone, apart, two bisect steps, the confirm), 5 of which land nothing; none is the daily full run; T-702 is handed back, T-701, T-703, T-704, T-705 land on one complete run (fails before this fix: 7 complete land runs, one of them the daily full run inside the bisect)', () => [
      r.runs === 9 && runs.length === 9 && byName.length === 7 && runs.filter((x) => x.probe === '1').length === 5 && runs.filter((x) => !x.retryTests).length === 2 && runs.every((x) => x.landFull === null) && runs[8].srcs.join() !== ''
        && be[0]?.meta?.plan === 'apart' && r.dropped?.map((d) => d.task).join() === 'T-702' && r.landed?.slice().sort().join() === 'T-701,T-703,T-704,T-705',
      JSON.stringify({ r, runs: runs.map((x) => [x.srcs.join('+'), x.retryTests ? 'byname' : '', x.probe, x.landFull]) }).slice(0, 3000)]);
  }

  // ================= 10. the plan is one pure function; bisect-plan prints it =================
  {
    const r = probe(`import { nextStep, bisectPlan } from ${u('harness/unity-train.mjs')};
const flaky = (n) => n === 'F';
console.log(JSON.stringify({
  first: nextStep({ lanes: ['A', 'B'] }),
  retry2: nextStep({ lanes: ['A', 'B'], results: [{ kind: 'land', group: ['A', 'B'], status: 'red', failures: ['F'] }, { kind: 'retry', group: ['A', 'B'], status: 'red', failures: ['F'] }], flaky }),
  probe: nextStep({ lanes: ['A', 'B'], results: [{ kind: 'land', group: ['A', 'B'], status: 'red', failures: ['F'] }, { kind: 'retry', group: ['A', 'B'], status: 'red', failures: ['F'] }, { kind: 'retry', group: ['A', 'B'], status: 'red', failures: ['F'] }], flaky }),
  proven: nextStep({ lanes: ['A', 'B'], results: [{ kind: 'land', group: ['A', 'B'], status: 'red', failures: ['F'] }], flaky, targetRed: ['F'] }),
  prefix: nextStep({ lanes: ['A', 'B'], results: [{ kind: 'land', group: ['A', 'B'], status: 'red', failures: ['X'] }, { kind: 'bisect', group: ['A'], status: 'pass' }], ties: null }),
  byName: nextStep({ lanes: ['A', 'B', 'C'], results: [{ kind: 'land', group: ['A', 'B', 'C'], status: 'red', failures: ['X'] }], ties: null, byNameOk: true }),
  noNames: nextStep({ lanes: ['A', 'B', 'C'], results: [{ kind: 'land', group: ['A', 'B', 'C'], status: 'red', failures: [] }], ties: null, byNameOk: true }),
  survivors: nextStep({ lanes: ['A', 'B', 'C'], results: [{ kind: 'land', group: ['A', 'B', 'C'], status: 'red', failures: ['X'] }, { kind: 'bisect', group: ['A'], status: 'pass', byName: true }, { kind: 'bisect', group: ['A', 'B'], status: 'red', byName: true, failures: ['X'] }, { kind: 'confirm', group: ['B'], status: 'red', byName: true, failures: ['X'] }], ties: null, byNameOk: true }),
  flakyPrefix: nextStep({ lanes: ['A', 'B'], results: [{ kind: 'land', group: ['A', 'B'], status: 'red', failures: ['F'] }, { kind: 'retry', group: ['A', 'B'], status: 'red', failures: ['F'] }, { kind: 'retry', group: ['A', 'B'], status: 'red', failures: ['F'] }, { kind: 'probe', group: [], status: 'pass' }, { kind: 'bisect', group: ['A'], status: 'pass' }], ties: null, flaky }),
  crewOld: bisectPlan({ lanes: ['A', 'B', 'C', 'D'], red: ['B'] }),
}));`);
    await guard('2.86 (b) nextStep is pure and says each step\'s kind of run: no result yet: land all (complete); a flaky-only red after 1 retry: retry 2 (by name); after 2: probe the target alone (group [], by name, does not land); red names a probe already found red on this tip: wait for the target at once; a culprit after a green prefix is still confirmed alone (2.83); with byNameOk the first narrowing step is by name and lands nothing, with no names it is complete; after a by-name hand-back the survivors (A, C) are the next round; bisectPlan of 4 lanes with the second bad: 5 runs, 2 complete (fails before this fix: there was no plan function)', () => [
      r.first?.step === 'land' && r.first.group.join() === 'A,B' && r.first.run === 'complete' && r.retry2?.step === 'retry' && r.retry2.n === 2 && r.retry2.run === 'name' && r.probe?.step === 'probe' && r.probe.group.length === 0 && r.probe.tests.join() === 'F' && r.probe.lands === false
        && r.proven?.step === 'wait-target' && r.prefix?.step === 'confirm' && r.prefix.group.join() === 'B' && r.prefix.run === 'complete' && r.flakyPrefix?.step === 'confirm'
        && r.byName?.step === 'bisect' && r.byName.run === 'name' && r.byName.lands === false && r.noNames?.step === 'bisect' && r.noNames.run === 'complete'
        && r.survivors?.step === 'handback' && r.survivors.lanes.join() === 'B' && r.survivors.rounds?.[0]?.join() === 'A,C'
        && r.crewOld?.filter((x) => x.status).length === 5 && r.crewOld.filter((x) => x.run === 'complete').length === 2,
      JSON.stringify(r).slice(0, 2500)]);
    const cli = spawnSync(process.execPath, [path.join(S, 'harness', 'engine.mjs'), 'bisect-plan', '--lanes', 'A,B,C,D', '--red', 'B'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 120000 });
    await guard('2.86 (b) npm run engine -- bisect-plan --lanes A,B,C,D --red B prints the steps with their kind of run and minutes: "5 land run(s): 2 complete, 3 by name; about 135 min" (fails before this fix: no such command)', () => [
      cli.status === 0 && /handback B/.test(out(cli)) && /\[by name, ~5 min, does not land\]/.test(out(cli)) && /5 land run\(s\): 2 complete, 3 by name; about 135 min/.test(out(cli)),
      out(cli).slice(0, 1500)]);
  }
}
