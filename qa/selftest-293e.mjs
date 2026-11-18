/**
 * qa/selftest-293e.mjs — 2.93 (e): a studio command past its time limit is ended with everything it started
 * (harness/run-limited.mjs); each engine train records where its time went (minutes on the done event and the last-train
 * file, a line in train status and in the score); agy's "tools auto-denied" ending is a harness-side cause.
 * The scaffolding (a studio copy, a made-up engine repo, a land script stand-in) is qa/selftest-293a.mjs's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, eventTypesOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, importInDirOf, out, queueUnityOf, writeIn as write } from './kit.mjs';

export async function selftest293E({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const imp = importInDirOf(dir);
  const T = path.join(tmpRoot, `s293e-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const WRAP = path.join(dir, 'harness', 'run-limited.mjs');
  const { runLimitedSync } = await imp('harness/run-limited.mjs');

  // A command that starts a child (the "compiler") and waits: the child writes its marker file after 1.5 s if it survives.
  const treeScript = path.join(T, 'tree.mjs');
  fs.writeFileSync(treeScript, `import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'setTimeout(() => require("fs").writeFileSync(process.argv[1], "alive"), 1500)', process.argv[2]], { stdio: 'ignore' });
setTimeout(() => {}, 60000);
`);
  const treeCmd = (marker) => `node "${fwd(treeScript)}" "${fwd(marker)}"`;

  // ---- the wrapper ----
  {
    const r = spawnSync(process.execPath, [WRAP, '5000', '--', 'node -e "console.log(\'out-line\'); console.error(\'err-line\'); process.exit(7)"'], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    await guard('2.93 (e) wrapper: a command that ends in time has its output and exit code passed through unchanged (stdout, stderr, exit 7)', () => [
      r.status === 7 && /out-line/.test(r.stdout) && /err-line/.test(r.stderr) && !/run-limited/.test(r.stderr), `${r.status} ${out(r)}`]);
  }
  {
    const mk = path.join(T, 'mark-wrap.txt');
    const r = spawnSync(process.execPath, [WRAP, '500', '--', treeCmd(mk)], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    await guard('2.93 (e) wrapper: a command that starts a child and waits past the limit is ended WITH its child: exit 124, one marker line on stderr, and the child never wrote its file (fails before this fix: spawnSync\'s time-out ended only the shell and the child lived on)', () => [
      r.status === 124 && /\[run-limited\] ended after [\d.]+ min: the time limit/.test(r.stderr) && !fs.existsSync(mk), `${r.status} ${out(r)} marker=${fs.existsSync(mk)}`]);
  }
  {
    const mk = path.join(T, 'mark-sync.txt');
    const r = runLimitedSync(treeCmd(mk), { timeoutMs: 500, encoding: 'utf8', windowsHide: true });
    await guard('2.93 (e) runLimitedSync: a time-out looks the way spawnSync\'s does (error.code ETIMEDOUT, signal SIGTERM, status null) and the child is gone', () => [
      r.error?.code === 'ETIMEDOUT' && r.signal === 'SIGTERM' && r.status === null && !fs.existsSync(mk), `${r.error?.code} ${r.signal} ${r.status} marker=${fs.existsSync(mk)}`]);
  }
  {
    const a = runLimitedSync('node -e "console.log(\'plain\'); process.exit(3)"', { encoding: 'utf8', windowsHide: true });
    const b = runLimitedSync('node -e "console.log(\'plain\')"', { timeoutMs: 0, encoding: 'utf8', windowsHide: true });
    const c = runLimitedSync('node -e "console.log(\'timed\'); process.exit(4)"', { timeoutMs: 20000, encoding: 'utf8', windowsHide: true });
    await guard('2.93 (e) runLimitedSync: with no limit (undefined, 0) it is a plain shell run with its own output and exit code; with a limit that is not reached the exit code and output are the command\'s', () => [
      a.status === 3 && /plain/.test(a.stdout) && !a.error && b.status === 0 && /plain/.test(b.stdout) && c.status === 4 && /timed/.test(c.stdout) && !c.error, JSON.stringify([a.status, b.status, c.status, c.error?.code])]);
  }

  // ---- a compile that runs past the queue door's limit leaves nothing holding its checkout ----
  {
    const R = path.join(T, 'repo-compile');
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'main'); write(R, 'a.txt', 'a\n'); g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    const sha = g(R, 'rev-parse', 'HEAD').stdout.trim();
    const mk = path.join(T, 'mark-compile.txt');
    const { compileAt } = await imp('harness/engine-compile.mjs');
    const root = path.join(T, 'compile-root');
    const r = compileAt({ repo: R, sha, cmd: { command: treeCmd(mk), timeoutMin: 0.01 }, root, id: 'q-293e' });
    const left = fs.existsSync(path.join(root, '.studio', 'tmp')) ? fs.readdirSync(path.join(root, '.studio', 'tmp')) : [];
    await guard('2.93 (e) compile: a compile command that runs past its limit is reported as timed out, its child is ended and the checkout folder is gone at once (fails before this fix: the child lived on holding the folder; 292a needed a long removal retry)', () => [
      r.status === 'error' && /timed out/.test(r.why) && !fs.existsSync(mk) && left.length === 0, JSON.stringify({ r, left, marker: fs.existsSync(mk) })]);
  }

  // ---- the arithmetic and the texts, through the smallest seams ----
  {
    const { engineFlow, engineText } = await imp('harness/score.mjs');
    const done = (total, extra = {}) => ({ type: 'task.train.unity.done', meta: { runs: 1, ...(total === null ? {} : { minutes: { total, compile: 0, rules: total / 10, wait: total / 5, land: total / 2 } }), ...extra } });
    const evs = [{ type: 'engine.land', meta: { status: 'pass', ms: 60000 } }, done(100), done(200), done(300), done(null)];
    const en = engineFlow(evs);
    const text = engineText(en).join('\n');
    await guard('2.93 (e) score: the engine section has a trains line (count, median minutes, rules check, land runs, waiting) and the same numbers in JSON; a train without times is left out of the medians and counted ("1 earlier train(s) have no times")', () => [
      en.trains.n === 3 && en.trains.medianMin === 200 && en.trains.rulesMin === 20 && en.trains.landMin === 100 && en.trains.waitMin === 40 && en.trains.untimed === 1
        && /trains: 3, median 200 min \(rules check 20, land runs 100, waiting 40\); 1 earlier train\(s\) have no times/.test(text), JSON.stringify(en.trains) + text.slice(-300)]);
  }
  {
    const hb = await imp('harness/handback-kind.mjs');
    const busy = await imp('harness/busy.mjs');
    const t0 = Date.now();
    const note = 'porter-agy (agy, gemini-3) stopped: agy could not use its tools: headless mode denied the "read_file", "command" permission(s) for lack of an allow-rule (this session\'s folders: a, b). No uncommitted work.';
    const plain = 'porter-agy (agy, gemini-3) stopped: exit code 1. No uncommitted work.';
    const mk = (n, msg) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, type: 'task.paused', task: 'T-9', agent: 'porter-agy', ts: new Date(t0 - (n - i) * 600000).toISOString(), msg: `Handed back porter-agy: ${msg}` }));
    const denied = mk(3, note);
    await guard('2.93 (e) agy permissions: three hand-backs that end with agy\'s "tools auto-denied" reason are the harness-side kind "tool-permission": none counts toward the park (loopHandBacks 0), the breaker\'s harnessKind is true, the scorecard words name it; three ordinary ones still count 3 (fails before this fix: they were "real")', () => [
      hb.handBackKind(denied[0], denied) === 'tool-permission' && hb.harnessKind('tool-permission') && busy.loopHandBacks('T-9', denied).length === 0 && busy.loopHandBacks('T-9', mk(3, plain)).length === 3
        && hb.sessionEndKind({ meta: { toolDenied: note } }) === 'tool-permission' && /tool permission problem 1/.test(hb.harnessKindWords({ 'tool-permission': 1 })), hb.handBackKind(denied[0], denied)]);
  }

  // ---- a studio copy and a made-up engine repo: the land command's time-out, and a train's minutes ----
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_USAGE_FUNCTIONS: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-293e-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  const S = path.join(tmpRoot, `293e-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-293e.jsonl');
  fs.writeFileSync(evFile, '');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventTypesOf(eventsFileOf(evFile));
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code) => {
    const f = path.join(S, `.probe-293e-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };

  {
    const mk = path.join(T, 'mark-land.txt');
    setEngines({ unity: { land: treeCmd(mk), timeoutMin: 0.01 } });
    const r = probe(`import { runUnityGate } from ${u('harness/unity-gate.mjs')};
const res = await runUnityGate({ engine: 'unity', env: { ...process.env } });
console.log(JSON.stringify({ status: res.status, why: String(res.why || '') }));`);
    await guard('2.93 (e) land: a land command that outlives its limit gives the result it always gave (status error, "timed out after 0.01 min") and its child is ended too (fails before this fix: the child lived on)', () => [
      r.status === 'error' && /timed out after 0\.01 min/.test(r.why) && !fs.existsSync(mk), JSON.stringify(r) + ` marker=${fs.existsSync(mk)}`]);
  }

  {
    const R = path.join(T, 'repo-train');
    const GW = path.join(T, 'gate-train');
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main'); write(R, 'Sim/Move.cs', 'class Move { }\n'); g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    g(R, 'checkout', '-q', '-b', 'dev'); g(R, 'worktree', 'add', '-q', GW, 'port/main');
    g(R, 'checkout', '-q', '-B', 'feat/m', 'port/main'); write(R, 'Sim/Move.cs', 'class Move { int x; }\n'); g(R, 'add', '-A'); g(R, 'commit', '-qm', 'feat/m work');
    const head = g(R, 'rev-parse', 'feat/m').stdout.trim();
    g(R, 'checkout', '-q', 'dev');
    const landStub = path.join(T, 'land-train.mjs');
    fs.writeFileSync(landStub, `import { spawnSync } from 'node:child_process';
const [gw, ...srcs] = process.argv.slice(2);
for (const s of srcs) spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s], { cwd: gw, windowsHide: true });
console.log('landed ' + srcs.join(' '));
`);
    setEngines({ unity: { land: `node "${fwd(landStub)}" "${fwd(GW)}" {branch}`, target: 'port/main', cwd: fwd(R), gateWorktree: fwd(GW), timeoutMin: 5, rules: false } });
    for (const x of ['train', 'engine', 'gates', 'tmp', 'locks']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true });
    queueUnityOf(S)({ R, GW, heads: { 'feat/m': head } }, [['T-001', 'feat/m']]);
    // The land call is the real one; the clock jumps 3.5 min over it and the result says 1 min of that was waiting.
    const r = probe(`import { runUnityTrain } from ${u('harness/unity-train.mjs')};
import { runUnityGate } from ${u('harness/unity-gate.mjs')};
const real = Date.now; let skew = 0; Date.now = () => real() + skew;
const land = async (a) => { const x = await runUnityGate(a); skew += 210000; return { ...x, ms: 210000, waitMs: 60000 }; };
const r = await runUnityTrain({ root: process.cwd(), log: () => {}, deps: { land, handBack: () => {} } });
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, landed: r.landed }));`);
    const done = evs(/^task\.train\.unity\.done$/).pop()?.meta || {};
    let last = {};
    try { last = JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'unity-last.json'), 'utf8')); } catch { /* reported below */ }
    const m = done.minutes || {};
    const sums = (x) => x && x.wait === 1 && x.land === 2.5 && x.compile === 0 && x.rules === 0 && x.total >= 3.5 && x.total < 3.9;
    await guard('2.93 (e) train: the done event and unity-last.json carry minutes { total, compile, rules, wait, land } and landRuns that add up (a land run of 3.5 min with 1 min waiting: wait 1, land 2.5, total about 3.5, 1 land run)', () => [
      r.landed?.join() === 'T-001' && sums(m) && sums(last.minutes) && done.landRuns === 1 && last.landRuns === 1 && m.wait + m.land + m.compile + m.rules <= m.total, JSON.stringify({ r, done: m, last: last.minutes })]);
    const st = probe(`import { unityStatusText } from ${u('harness/unity-train.mjs')};
console.log(JSON.stringify({ text: unityStatusText(process.cwd(), { engine: 'unity' }) }));`);
    write(S, '.studio/train/unity-last.json', JSON.stringify({ ...last, minutes: { total: 250, compile: 1, rules: 91, wait: 35, land: 118 }, landRuns: 2 }));
    const st2 = probe(`import { unityStatusText } from ${u('harness/unity-train.mjs')};
console.log(JSON.stringify({ text: unityStatusText(process.cwd(), { engine: 'unity' }) }));`);
    write(S, '.studio/train/unity-last.json', JSON.stringify({ ...last, minutes: { total: 100, compile: 0, rules: 0, wait: 0, land: 100 }, landRuns: 1 }));
    const st3 = probe(`import { unityStatusText } from ${u('harness/unity-train.mjs')};
console.log(JSON.stringify({ text: unityStatusText(process.cwd(), { engine: 'unity' }) }));`);
    await guard('2.93 (e) train status: one line for the last train ("Last train took 250 min: compile 1, rules check 91, waiting for the machine 35, land runs 118 (2); the rest 5."); parts of 0 are left out and no "rest" under 1 minute', () => [
      /Last train took \d+ min: waiting for the machine 1, land runs 3 \(1\)\./.test(st.text || '') && st2.text?.includes('Last train took 250 min: compile 1, rules check 91, waiting for the machine 35, land runs 118 (2); the rest 5.') && st3.text?.includes('Last train took 100 min: land runs 100 (1).'),
      JSON.stringify([st.text, st2.text, st3.text]).slice(-1800)]);
  }

  for (const d of [S, T]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the temp sweep removes it */ } }
}
