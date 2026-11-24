/**
 * qa/selftest-298a.mjs — 2.98 (a): the daily full land run in parts (engines.<x>.fullLand.parts), each its own land run
 * with STUDIO_LAND_PART and its own time limit, a result per part kept by target tree, and a back-off after a try that
 * gave no result (fullLand.backoffHours): never two full runs in a row with no result. With lanes waiting and the run
 * overdue, one part at the end of a train. Each part is sampled under its own kind.
 *
 * The scaffolding (a studio copy, a made-up engine repo, a stand-in land script that records what it was told) is
 * qa/selftest-286b.mjs's, cut down.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, queueUnityOf, readJsonFile as readJson, readRunsJsonl as runsOf, writeIn as write } from './kit.mjs';

export async function selftest298A({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s298a-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: PowerShell (the process list a train cancel reads) needs Windows' own system variables, which any real shell
  // has; from this cut-down environment it ran into its time limit (P-370). Passed through as they are, as in 284u.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-298a-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file, engine settings) ----
  const S = path.join(tmpRoot, `298a-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-298a.jsonl');
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code) => {
    const f = path.join(S, `.probe-298a-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S }, encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'gates', 'tmp', 'locks']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true }); fs.writeFileSync(evFile, ''); };

  // ---- a made-up engine repo: the target port/main lives in the land script's gate worktree ----
  let rn = 0;
  const engineRepo = (lanes = {}) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
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
  // The land script stand-in: records what it was told and the full-run record's "at" as the run starts. <ctl>-slow-<part>
  // (or -slow-whole) makes that part outlast its time limit. STUDIO_LAND_PROBE=1: land nothing.
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const E = process.env;
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
let rec = {}; try { rec = JSON.parse(fs.readFileSync(path.join(E.STUDIO_MAIN_ROOT, '.studio', 'engine', 'unity-full-land.json'), 'utf8')); } catch {}
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, landFull: E.STUDIO_LAND_FULL ?? null, part: E.STUDIO_LAND_PART ?? null, probe: E.STUDIO_LAND_PROBE ?? null, recAt: rec.at ?? null }) + '\\n');
if (fs.existsSync(ctl + '-slow-' + (E.STUDIO_LAND_PART || 'whole'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); process.exit(2); } }
if (E.STUDIO_LAND_PROBE === '1') { console.log('[land-probe] honoured'); git(gw, 'reset', '-q', '--hard', before); process.exit(0); }
console.log('landed ' + srcs.join(' '));
`);
  const PARTS = ['edit', 'play-a', 'play-b'];
  const cfgFor = (E, ctl, fullLand) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, rules: false, ...(fullLand ? { fullLand } : {}) });
  const queue = queueUnityOf(S);
  const recFile = path.join(S, '.studio', 'engine', 'unity-full-land.json');
  const fullAge = (hours, extra = {}) => { fs.mkdirSync(path.dirname(recFile), { recursive: true }); fs.writeFileSync(recFile, JSON.stringify({ at: new Date(Date.now() - hours * 3600000).toISOString(), id: 'old', ...extra })); };
  const fullRec = () => readJson(recFile);
  const TRAIN = `import { runUnityTrain, unityStatusText, fullLandDue } from ${u('harness/unity-train.mjs')};
const logs = [];
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps: { handBack: () => {} } });
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, landed: r.landed, full: r.full || null, fullParts: r.fullParts || null, fullLand: r.fullLand || 0, message: r.message, logs: logs.filter((l) => /full run/.test(l)), status: unityStatusText(process.cwd(), { engine: 'unity' }), due: fullLandDue(process.cwd(), 'unity', {}, process.env, Date.now(), { start: false }) }));`;
  const kindsSampled = () => { const d = path.join(S, '.studio', 'engine', 'unity-samples'); try { return fs.readdirSync(d).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8').split('\n')[0].slice(2)).kind; } catch { return null; } }).filter(Boolean); } catch { return []; } };

  try {
    // ---- (a1) three parts, each its own run; a full pass only when all three are green on one tree; (a5) each its own kind ----
    {
      resetState();
      const E = engineRepo();
      const ctl = path.join(T, 'ctl-a1');
      setEngines({ unity: cfgFor(E, ctl, { parts: PARTS }) });
      fullAge(30);
      const old = fullRec().at;
      const r = probe(TRAIN);
      const runs = runsOf(ctl);
      const rec = fullRec();
      await guard('2.98 (a1) with fullLand.parts [edit, play-a, play-b] the land command runs three times on the target alone, in order, each with STUDIO_LAND_FULL=1 and its STUDIO_LAND_PART; the full pass is recorded only after the third is green (fails before this fix: one run, no part named)', () => [
        runs.length === 3 && runs.map((x) => x.part).join() === PARTS.join() && runs.every((x) => x.landFull === '1' && x.probe === '1' && x.recAt === old)
          && rec?.id !== 'old' && Date.now() - Date.parse(rec?.at) < 600000 && !rec?.parts && rec?.tries?.length === 3 && r.full?.complete === true,
        JSON.stringify({ r, runs, rec }).slice(0, 2500)]);
      const kinds = kindsSampled();
      await guard('2.98 (a5) each part is sampled under its own kind: land with-rules play-full part-edit, part-play-a, part-play-b (fails before this fix: one kind for the whole run, so its floor came from the whole run\'s peak)', () => [
        PARTS.every((p) => kinds.includes(`land with-rules play-full part-${p}`)), JSON.stringify(kinds)]);
    }
    {
      resetState();
      const E = engineRepo();
      const ctl = path.join(T, 'ctl-a1-tree');
      setEngines({ unity: cfgFor(E, ctl, { parts: PARTS }) });
      fullAge(30, { tree: '0123456789abcdef0123456789abcdef01234567', parts: { edit: { at: 'x' }, 'play-a': { at: 'x' } } });
      probe(TRAIN);
      const runs = runsOf(ctl);
      await guard('2.98 (a1b) parts that passed on another tree of the target do not count: all three run again (fails before this fix: no part was kept at all)', () => [
        runs.map((x) => x.part).join() === PARTS.join() && fullRec()?.id !== 'old', JSON.stringify({ runs, rec: fullRec() }).slice(0, 2500)]);
    }

    // ---- (a3) a part that hits its time limit is a try: no second run straight after; (a2) the passed part is not run again ----
    {
      resetState();
      const E = engineRepo();
      const ctl = path.join(T, 'ctl-a3');
      fs.writeFileSync(`${ctl}-slow-play-a`, '1');
      setEngines({ unity: cfgFor(E, ctl, { parts: PARTS, partTimeoutMin: 0.05 }) });
      fullAge(30);
      const r1 = probe(TRAIN);
      const runs1 = runsOf(ctl);
      const rec1 = fullRec();
      const r2 = probe(TRAIN);
      const runs2 = runsOf(ctl);
      const hours = (Date.parse(rec1?.next) - Date.now()) / 3600000;
      await guard('2.98 (a3) part play-a outlasts its 3 s limit (fullLand.partTimeoutMin): edit passed, play-b does not run, the try is recorded (part, minutes, outcome timeout) and the next try is about 12 h away; a second train straight after, queue empty, runs nothing, and train status names the next try and why (fails before this fix: a timed-out full run was due again at once and ran again)', () => [
        runs1.map((x) => x.part).join() === 'edit,play-a' && r1.full?.status === 'error' && rec1?.tries?.map((x) => `${x.part}:${x.outcome}`).join() === 'edit:pass,play-a:timeout' && rec1?.parts?.edit && hours > 11.5 && hours <= 12
          && runs2.length === 2 && r2.runs === 0 && /does not start: it backs off until/.test(r2.message || '') && /Daily full land run: the next try is not before .*part play-a hit its time limit/.test(r2.status || '') && r2.due?.why === '' && r2.due?.wait,
        JSON.stringify({ r1, runs1, rec1, r2 }).slice(0, 3000)]);
      fs.rmSync(`${ctl}-slow-play-a`, { force: true });
      fs.writeFileSync(recFile, JSON.stringify({ ...fullRec(), next: new Date(Date.now() - 60000).toISOString() }));
      const r3 = probe(TRAIN);
      const runs3 = runsOf(ctl).slice(2);
      await guard('2.98 (a2) once the back-off is over, the next train on the same target tree runs only the missing parts (play-a, play-b), not edit, which passed on that tree, and then records the full pass (fails before this fix: a cut-short full run started again from the beginning)', () => [
        runs3.map((x) => x.part).join() === 'play-a,play-b' && r3.full?.complete === true && fullRec()?.id !== 'old' && !fullRec()?.next, JSON.stringify({ r3, runs3, rec: fullRec() }).slice(0, 2500)]);
    }

    // ---- (a4) lanes waiting and the run overdue: at most one part, at the end of the train ----
    {
      resetState();
      const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } });
      const ctl = path.join(T, 'ctl-a4');
      setEngines({ unity: cfgFor(E, ctl, { parts: PARTS }) });
      fullAge(50);
      queue(E, [['T-981', 'feat/a']]);
      const r = probe(TRAIN);
      const runs = runsOf(ctl);
      await guard('2.98 (a4) overdue (50 h) with a lane waiting: the lane lands first, then one part (edit) runs at the end of the train; the full pass is not recorded and edit is kept on the target\'s tree (fails before this fix: the whole full run ran at the end of every train)', () => [
        runs.length === 2 && runs[0].landFull === null && runs[1].part === 'edit' && r.landed?.join() === 'T-981' && r.full?.when === 'end' && r.full?.part === 'edit' && fullRec()?.id === 'old' && fullRec()?.parts?.edit,
        JSON.stringify({ r, runs, rec: fullRec() }).slice(0, 2500)]);
    }

    // ---- (a6) no parts: one whole run, with the same back-off ----
    {
      resetState();
      const E = engineRepo();
      const ctl = path.join(T, 'ctl-a6');
      fs.writeFileSync(`${ctl}-slow-whole`, '1');
      setEngines({ unity: cfgFor(E, ctl, { partTimeoutMin: 0.05 }) });
      fullAge(30);
      const r1 = probe(TRAIN);
      const r2 = probe(TRAIN);
      const runs = runsOf(ctl);
      await guard('2.98 (a6) with no parts the full run is one whole run (no STUDIO_LAND_PART); it times out, counts as a try, and the train straight after runs nothing and says when the next try is (fails before this fix: it ran again at once)', () => [
        runs.length === 1 && runs[0].landFull === '1' && runs[0].part === null && r1.full?.status === 'error' && fullRec()?.tries?.[0]?.outcome === 'timeout' && fullRec()?.tries?.[0]?.part === null
          && r2.runs === 0 && /the whole run hit its time limit/.test(r2.status || ''),
        JSON.stringify({ r1, r2, runs, rec: fullRec() }).slice(0, 2500)]);
    }
  } finally {
    for (const x of [S, T]) { try { fs.rmSync(x, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ } }
  }
}
