/**
 * qa/selftest-297a.mjs — 2.97 (a): the rules green and the check ahead survive a changed lane copy. A lane copy that is a
 * git checkout is read at the lane's commit (what lands), so a session editing it after a green check does not cost the
 * land run its green; a branch that moved to changed inputs still loses it, and one log line names the input. With
 * rules.ahead on, every land run says whether the check ahead started and why not; `rules show` prints the last outcome.
 * Scaffolding as qa/selftest-296c.mjs (a studio copy, a made-up engine repo, stand-ins for the land script and the rules check).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, queueUnityOf, readJsonFile as readJson, writeIn as write } from './kit.mjs';

export async function selftest297A({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s297a-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: the helpers below get a cut-down environment; PowerShell (used to read a process's start time and to list a
  // process tree) needs Windows' own system variables, which any real shell has. Pass those through as they are.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.5', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_USAGE_FUNCTIONS: 'off', STUDIO_TEST_FREEMEM_MB: '64000',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-297a-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  const S = path.join(tmpRoot, `297a-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-297a.jsonl');
  const envOf = () => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S });
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const run = (args, code = null) => {
    const f = code ? path.join(S, `.probe-297a-${++pn}.mjs`) : null;
    if (f) fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, f ? [f] : args, { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 300000 });
    if (f) { try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ } }
    return r;
  };
  const probe = (code) => { const r = run(null, code); const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop(); try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; } };
  const resetState = () => { for (const x of ['train', 'engine', 'comm', 'gates', 'tmp', 'locks']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.writeFileSync(evFile, ''); };

  // One engine repo per case; T-1's lane copy is a git worktree of it in the studio's .lanes/engine/T-1 on port/a, whose
  // commit has the rules input Data/x.txt (v1). No other folder has Data, so the check reads it from the lane.
  let rn = 0;
  const engineRepo = () => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    write(R, 'Game/Sim/Fees/Fees.cs', 'class Fees { }\n');
    g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    g(R, 'checkout', '-q', '-b', 'dev');
    g(R, 'worktree', 'add', '-q', GW, 'port/main');
    g(R, 'checkout', '-q', '-B', 'port/a', 'port/main');
    write(R, 'Game/Sim/Fees/A.cs', 'a\n'); write(R, 'Data/x.txt', 'v1\n');
    g(R, 'add', '-A'); g(R, 'commit', '-qm', 'port/a work');
    const heads = { 'port/a': g(R, 'rev-parse', 'port/a').stdout.trim() };
    g(R, 'checkout', '-q', 'dev');
    const lane = path.join(S, '.lanes', 'engine', 'T-1');
    fs.rmSync(lane, { recursive: true, force: true });
    g(R, 'worktree', 'prune');
    g(R, 'worktree', 'add', '-q', lane, 'port/a');
    return { R, GW, heads, lane };
  };
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, green: process.env.STUDIO_RULES_GREEN || '' }) + '\\n');
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); process.exit(2); } }
console.log('landed ' + srcs.join(' '));
`);
  // The rules check's stand-in: records the input it read in its throwaway checkout, and passes.
  const rulesStub = path.join(T, 'rules-stub.mjs');
  fs.writeFileSync(rulesStub, `import fs from 'node:fs'; import path from 'node:path';
const ctl = process.argv[2];
let x = ''; try { x = fs.readFileSync(path.join(process.env.STUDIO_RULES_DIR, 'Data', 'x.txt'), 'utf8').trim(); } catch { x = 'none'; }
fs.appendFileSync(ctl + '-rules.jsonl', JSON.stringify({ x }) + '\\n');
`);
  const cfgFor = (E, ctl, ahead) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, rules: { test: `node "${fwd(rulesStub)}" "${fwd(ctl)}"`, inputs: ['Data'], ...(ahead ? { ahead: true } : {}) } });
  const lines = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const queue = queueUnityOf(S);
  // deps.markRunning runs after the rules check, right before the land run: <ctl>-edit.mjs, when there, changes the lane then.
  const TRAIN = (ctl) => `import fs from 'node:fs'; import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const logs = []; const edit = ${JSON.stringify(`${ctl}-edit.mjs`)};
const deps = { board: () => ({ inProgress: [], backlog: [], done: [] }), handBack: () => {}, markRunning: async () => {} };
if (fs.existsSync(edit)) { const { default: f } = await import('file:///' + edit.replace(/\\\\/g, '/').replace(/^\\/+/, '')); deps.markRunning = f; }
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps });
console.log(JSON.stringify({ ok: r.ok, landed: r.landed, logs: logs.filter((l) => /rules|ahead/.test(l)) }));`;
  const gitLine = `import { spawnSync } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path';
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8', windowsHide: true });`;
  const J = (x) => JSON.stringify(x).slice(0, 2800);

  try {
    // ================= (a1) the lane copy is edited after the check; its commit is what lands =================
    {
      resetState();
      const E = engineRepo();
      const ctl = path.join(T, 'ctl-edit');
      setEngines({ unity: cfgFor(E, ctl, true) });
      fs.writeFileSync(`${ctl}-edit.mjs`, `${gitLine}
export default () => { fs.writeFileSync(path.join(${JSON.stringify(E.lane)}, 'Data', 'x.txt'), 'v2 (not committed)\\n'); fs.writeFileSync(path.join(${JSON.stringify(E.lane)}, 'Data', 'new.txt'), 'scratch\\n'); };`);
      queue(E, [['T-1', 'port/a']]);
      const r1 = probe(TRAIN(ctl));
      const runs = lines(`${ctl}-runs.jsonl`);
      const rr = lines(`${ctl}-rules.jsonl`);
      await guard('2.97 (a1) a lane copy edited after a green rules check (Data/x.txt changed, Data/new.txt added in the working files, nothing committed) keeps the green: T-1 lands and its land run gets STUDIO_RULES_GREEN=1; the check read the input from the lane\'s commit (v1) (fails before this fix: the live folder changed, the green was lost without a word and the land run ran its own rules stage)', () => [
        r1.landed?.join() === 'T-1' && runs.length === 1 && runs[0].green === '1' && rr.length === 1 && rr[0].x === 'v1' && !r1.logs?.some((l) => /not told the rules are green/.test(l)), J({ r1, runs, rr })]);
      await guard('2.97 (a2) rules.ahead on, the green used and no other lane queued: one log line says the check ahead did not start because no lane waits for the next train, and that is its last outcome (fails before this fix: the outcome was kept nowhere)', () => {
        const last = readJson(path.join(S, '.studio', 'engine', 'unity-ahead-last.json'));
        return [r1.logs?.filter((l) => /the check ahead did not start: no lane waits for the next train/.test(l)).length === 1 && last?.outcome === 'not-started' && /no lane waits/.test(last.why || ''), J({ r1, last })];
      });
    }
    // ================= (a3) the queued branch moved to a commit with a changed input =================
    {
      resetState();
      const E = engineRepo();
      const ctl = path.join(T, 'ctl-moved');
      setEngines({ unity: cfgFor(E, ctl, true) });
      fs.writeFileSync(`${ctl}-edit.mjs`, `${gitLine}
export default () => { const d = ${JSON.stringify(E.lane)}; fs.writeFileSync(path.join(d, 'Data', 'x.txt'), 'v3\\n'); git(d, 'commit', '-qam', 'later work'); };`);
      queue(E, [['T-1', 'port/a']]);
      const r1 = probe(TRAIN(ctl));
      const runs = lines(`${ctl}-runs.jsonl`);
      const why = r1.logs?.find((l) => /not told the rules are green/.test(l)) || '';
      await guard('2.97 (a3) the lane\'s branch moved after the check to a commit whose input differs: the green is refused (no STUDIO_RULES_GREEN), and one log line says why, naming Data/x.txt and the lane copy at its new commit, and that the land run runs its own rules stage (fails before this fix: refused without a word)', () => [
        runs.length === 1 && runs[0].green === '' && /the rules check passed in this train, but this land run is not told the rules are green: an input changed since the check: Data\/x\.txt changed \(.*\.lanes\/engine\/T-1 at [0-9a-f]{10}\); it runs its own rules stage/.test(why), J({ r1, runs })]);
      await guard('2.97 (a4) rules.ahead on and the green lost: the log says the check ahead did not start because the rules green was not used, with the same reason (fails before this fix: there was no check ahead line at all)', () => [
        r1.logs?.some((l) => /the check ahead did not start: the rules green was not used: an input changed since the check: Data\/x\.txt changed/.test(l)), J({ r1 })]);
      const sh = run([path.join(S, 'harness', 'engine-rules.mjs'), 'show', '--engine', 'unity']);
      await guard('2.97 (a5) rules show prints the check ahead: rules.ahead on, and the last one did not start, with why, its train and time (fails before this fix: rules show said nothing of the check ahead)', () => [
        /check ahead \(rules\.ahead\): on; last: did not start: the rules green was not used: an input changed since the check: Data\/x\.txt changed .*, train \S+, \d{4}-\d\d-\d\dT\d\d:\d\d/.test(out(sh)), out(sh).slice(-1500)]);
    }
  } finally {
    for (const r of fs.readdirSync(T).filter((n) => /^repo-/.test(n))) g(path.join(T, r), 'worktree', 'prune');
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
  }
}
