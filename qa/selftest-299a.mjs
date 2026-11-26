/**
 * qa/selftest-299a.mjs — 2.99 (a): what one red lane costs. A land group that is part of the checked batch (a lane was
 * dropped after a red land run) is checked again on its own tree, kept shards reused, and told the rules are green; the
 * by-name run after a red never widens (the lane's own new tests, one stage, a time box). Scaffolding as
 * qa/selftest-297a.mjs: a studio copy, a made-up engine repo, stand-ins for the land script and the rules tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, queueUnityOf, writeIn as write } from './kit.mjs';

export async function selftest299A({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s299a-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: the helpers below get a cut-down environment; PowerShell (used to read a process's start time and to list a
  // process tree) needs Windows' own system variables, which any real shell has. Pass those through as they are.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.5', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off', STUDIO_ENGINE_RETRY_STAGES: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_USAGE_FUNCTIONS: 'off', STUDIO_TEST_FREEMEM_MB: '64000',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-299a-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  const S = path.join(tmpRoot, `299a-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-299a.jsonl');
  const envOf = () => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S });
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code) => {
    const f = path.join(S, `.probe-299a-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 400000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'comm', 'gates', 'tmp', 'locks']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.writeFileSync(evFile, ''); };
  const events = (re) => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => re.test(e.type || '')); } catch { return []; } };

  // The engine repo: Sim/<system> folders (rules.focus.auto systems), Game/Rules (no shard takes it), Art (rules.ignore).
  // A file holding "LANDRED <stage> <test>" makes the land run red in that stage on that test.
  let rn = 0;
  const engineRepo = (lanes, { lanesDir = {} } = {}) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    for (const [f, t] of Object.entries({ 'Sim/Move/Move.cs': 'class Move { }\n', 'Sim/Fees/Fees.cs': 'class Fees { }\n', 'Game/Rules/Core.cs': 'class Core { }\n', 'Game/Tests/CoreTests.cs': 'class CoreTests { }\n', 'Art/View/V.txt': 'v\n' })) write(R, f, t);
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
    for (const [task, br] of Object.entries(lanesDir)) {
      const d = path.join(S, '.lanes', 'engine', task);
      fs.rmSync(d, { recursive: true, force: true });
      g(R, 'worktree', 'prune');
      g(R, 'worktree', 'add', '-q', '--detach', d, br);
    }
    return { R, GW, heads };
  };
  // The land script's stand-in: records what it was told, merges, and is red in a stage when the merged tree says so.
  // A by-name run (STUDIO_LAND_PROBE=1) judges only the named tests; <ctl>-slow makes such a run hang (to be cut).
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const E = process.env;
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const pick = (k) => E[k] ?? null;
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, green: pick('STUDIO_RULES_GREEN'), mode: pick('STUDIO_RULES_MODE'), probe: pick('STUDIO_LAND_PROBE'), play: pick('STUDIO_PLAY_MODE'), playFilter: pick('STUDIO_PLAY_FILTER'), stage: pick('STUDIO_LAND_RETRY_STAGE'), tests: pick('STUDIO_LAND_RETRY_TESTS') }) + '\\n');
if (E.STUDIO_LAND_PROBE === '1' && fs.existsSync(ctl + '-slow')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); process.exit(2); } }
const named = E.STUDIO_LAND_RETRY_TESTS ? E.STUDIO_LAND_RETRY_TESTS.split(';') : null;
const reds = git(gw, 'grep', '-h', '-o', '-E', 'LANDRED [a-z]+ [A-Za-z0-9_.]+', 'HEAD').stdout.split('\\n').filter(Boolean).map((l) => l.split(' ')).filter(([, , t]) => !named || named.includes(t));
const stages = { merge: { status: 'pass' }, dotnet: { status: E.STUDIO_RULES_GREEN === '1' ? 'skipped' : 'pass' } };
for (const [, st] of reds) stages[st] = { status: 'fail' };
if (E.STUDIO_LAND_RESULT) fs.writeFileSync(E.STUDIO_LAND_RESULT, JSON.stringify({ stages, failures: reds.map(([, , t]) => t), ...(E.STUDIO_LAND_PROBE === '1' ? { probe: true } : {}) }));
if (reds.length || E.STUDIO_LAND_PROBE === '1') git(gw, 'reset', '-q', '--hard', before);
if (E.STUDIO_LAND_PROBE === '1') console.log('[land-probe] honoured');
process.exit(reds.length ? 1 : 0);
`);
  // The rules tests' stand-in, one filter per run: Cat=Fees (and the whole run) is red when a Sim/Fees file holds
  // NEEDS_V2 and Fees.cs has no V2, or Fees.cs holds BAD.
  const rulesStub = path.join(T, 'rules-stub.mjs');
  fs.writeFileSync(rulesStub, `import fs from 'node:fs'; import path from 'node:path';
const [ctl, filter = 'ALL'] = process.argv.slice(2);
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const fees = read(path.join('Sim', 'Fees', 'Fees.cs'));
const needs = fs.readdirSync(path.join('Sim', 'Fees')).some((f) => read(path.join('Sim', 'Fees', f)).includes('NEEDS_V2'));
const bad = (filter === 'ALL' || filter === 'Cat=Fees') && ((needs && !fees.includes('V2')) || fees.includes('BAD'));
fs.appendFileSync(ctl + '-rules.jsonl', JSON.stringify({ filter }) + '\\n');
console.log('  ' + (bad ? 'Failed' : 'Passed') + ' Game.Rules.FeesTests.Charges [3 ms]');
process.exit(bad ? 1 : 0);
`);
  const rulesOf = (ctl, { rest = false, inputs = null } = {}) => ({
    test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" ALL`,
    focus: { test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" "{filter}"`, auto: [{ root: 'Sim', paths: ['Sim/{name}/'], filter: 'Cat={name}' }], fullEveryHours: 0 },
    shards: { keep: 'reads', ...(rest ? { rest: 'Rest' } : {}) }, ignore: ['Art'], ...(inputs ? { inputs } : {}),
  });
  const cfgFor = (E, ctl, rules, extra = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, batchMax: 8, rules, ...extra });
  const lines = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const queue = queueUnityOf(S);
  // deps.markRunning runs after the rules check, right before the land run: <ctl>-edit.mjs, when there, runs then.
  const TRAIN = (ctl) => `import fs from 'node:fs'; import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const logs = []; const handed = []; const edit = ${JSON.stringify(`${ctl}-edit.mjs`)};
const deps = { board: () => ({ inProgress: [], backlog: [], done: [] }), handBack: (lane, note, extra) => handed.push({ task: lane.task, cause: extra?.cause || null, note: String(note).slice(0, 400) }), markRunning: async () => {} };
if (fs.existsSync(edit)) { const { default: f } = await import('file:///' + edit.replace(/\\\\/g, '/').replace(/^\\/+/, '')); let once = false; deps.markRunning = () => { if (!once) { once = true; f(); } }; }
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps });
console.log(JSON.stringify({ ok: r.ok, landed: r.landed, dropped: r.dropped, handed, runs: r.runs, logs: logs.filter((l) => /rules|by name|blame|own new tests|cut|shard|without/.test(l)) }));`;
  const J = (x) => JSON.stringify(x).slice(0, 2800);
  // The red lane T-2 (port/v): view files, and a new test class whose file says the land run is red on it in Edit Mode.
  const RED_VIEW = { 'Art/View/V.txt': 'v2\n', 'Art/View/ViewTests.cs': 'class ViewTests { } // LANDRED edit Game.View.Tests.ViewTests.Shows\n' };
  const RULES_LANE = { 'Game/Rules/Bank.cs': 'class Bank { }\n' };

  try {
    // ================= (a1) a view-only red lane is dropped: no shard re-runs, the land run is told green =================
    {
      resetState();
      const E = engineRepo({ 'port/a': RULES_LANE, 'port/v': RED_VIEW });
      const ctl = path.join(T, 'ctl-a1');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl)) });
      queue(E, [['T-1', 'port/a'], ['T-2', 'port/v']]);
      const r1 = probe(TRAIN(ctl));
      const runs = lines(`${ctl}-runs.jsonl`);
      const rr = lines(`${ctl}-rules.jsonl`);
      const again = r1.logs?.find((l) => /checked again on its tree/.test(l)) || '';
      await guard('2.99 (a1) a red view-only lane dropped (shards kept by reads, the lane under rules.ignore): the land run without it gets STUDIO_RULES_GREEN=1 with STUDIO_RULES_MODE=focus, no rules shard runs again, and one log line says "2 of 2 shards kept, 0 re-run" (fails before this fix: "the batch changed", the land run ran its own rules stage)', () => [
        r1.landed?.join() === 'T-1' && r1.handed?.map((h) => h.task).join() === 'T-2' && runs.length === 2 && runs[1].srcs.join() === 'port/a' && runs[1].green === '1' && runs[1].mode === 'focus' && rr.length === 2 && /2 of 2 shards kept, 0 re-run \([0-9.]+ min\): green/.test(again) && r1.logs?.some((l) => /told the rules are green by the check of its own tree/.test(l)) && !r1.logs?.some((l) => /not told the rules are green/.test(l)), J({ r1, runs, rr })]);
    }
    // ================= (a2) with rules.shards.rest the kept full pass of the tree answers first: no second check =================
    {
      resetState();
      const E = engineRepo({ 'port/a': RULES_LANE, 'port/v': RED_VIEW });
      const ctl = path.join(T, 'ctl-a2');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { rest: true })) });
      queue(E, [['T-1', 'port/a'], ['T-2', 'port/v']]);
      const r1 = probe(TRAIN(ctl));
      const runs = lines(`${ctl}-runs.jsonl`);
      const rr = lines(`${ctl}-rules.jsonl`);
      await guard('2.99 (a2) with rules.shards.rest, the batch without the view-only lane has the same rules tree (less rules.ignore): the kept full pass answers, the land run is told green (mode full), no check runs again and one log line names that road (fails before this fix: it did not; the 2.96 road already answered, and this check pins that no second check runs ahead of it)', () => [
        r1.landed?.join() === 'T-1' && runs[1]?.green === '1' && runs[1]?.mode === 'full' && rr.length === 3 && r1.logs?.some((l) => /a tree with a kept full rules pass/.test(l)) && !r1.logs?.some((l) => /checked again on its tree/.test(l)), J({ r1, runs, rr })]);
    }
    // ================= (b) the dropped lane touched a shard's files: only that shard re-runs =================
    {
      resetState();
      const E = engineRepo({ 'port/a': { ...RULES_LANE, 'Sim/Move/Move.cs': 'class Move { int x; }\n' }, 'port/v': { ...RED_VIEW, 'Sim/Fees/Fees.cs': 'class Fees { int y; }\n' } });
      const ctl = path.join(T, 'ctl-b');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl)) });
      queue(E, [['T-1', 'port/a'], ['T-2', 'port/v']]);
      const r1 = probe(TRAIN(ctl));
      const runs = lines(`${ctl}-runs.jsonl`);
      const rr = lines(`${ctl}-rules.jsonl`).map((x) => x.filter);
      await guard('2.99 (b) the dropped lane changed Sim/Fees: the check of the land run\'s tree runs Cat=Fees again and keeps Cat=Move ("1 of 2 shards kept, 1 re-run"), then the land run is told green (fails before this fix: no check, the land run ran its own rules stage)', () => [
        r1.landed?.join() === 'T-1' && runs[1]?.green === '1' && rr.join() === 'Cat=Fees,Cat=Move,Cat=Fees' && r1.logs?.some((l) => /1 of 2 shards kept, 1 re-run .*: green/.test(l)), J({ r1, runs, rr })]);
    }
    // ================= (c) the check of the land run's tree is red: a rules red, never told green =================
    {
      resetState();
      const E = engineRepo({ 'port/a': { ...RULES_LANE, 'Sim/Fees/FeesTest.cs': 'class FeesTest { } // NEEDS_V2\n' }, 'port/v': { ...RED_VIEW, 'Sim/Fees/Fees.cs': 'class Fees { } // V2\n' } });
      const ctl = path.join(T, 'ctl-c');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl)) });
      queue(E, [['T-1', 'port/a'], ['T-2', 'port/v']]);
      const r1 = probe(TRAIN(ctl));
      const runs = lines(`${ctl}-runs.jsonl`);
      const h1 = r1.handed?.find((h) => h.task === 'T-1');
      await guard('2.99 (c) the batch without the red lane is red in the rules check of its own tree: T-1 is handed back as a rules red (cause rules), no land run of it runs at all, and the lane left (T-2) is judged on its own (fails before this fix: the land run of T-1 ran its own rules stage, about two hours, to find the same red)', () => [
        !r1.landed?.length && h1?.cause === 'rules' && /refused before the land run: the rules check/.test(h1.note) && !runs.some((x) => x.srcs.join() === 'port/a') && r1.handed?.some((h) => h.task === 'T-2'), J({ handed: r1.handed, runs, landed: r1.landed })]);
    }
    // ================= (i) the target moved in files the tests read: told green only after a passing check =================
    {
      resetState();
      const E = engineRepo({ 'port/a': RULES_LANE });
      const ctl = path.join(T, 'ctl-i');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl)) });
      fs.writeFileSync(`${ctl}-edit.mjs`, `import { spawnSync } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path';
export default () => { const d = ${JSON.stringify(E.GW)}; fs.writeFileSync(path.join(d, 'Sim', 'Fees', 'Fees.cs'), 'class Fees { } // BAD\\n'); spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'target moves'], { cwd: d, windowsHide: true }); };`);
      queue(E, [['T-1', 'port/a']]);
      const r1 = probe(TRAIN(ctl));
      const runs = lines(`${ctl}-runs.jsonl`);
      await guard('2.99 (i) the target moved after the check in a file a shard reads, and the check of the land run\'s tree is red on the target itself: the land run is not told green (no STUDIO_RULES_GREEN) and runs its own rules stage (fails before this fix: not covered; the green must never stand on a target the tests read differently)', () => [
        runs.length === 1 && runs[0].green === null && r1.logs?.some((l) => /checked again on its tree: .*re-run/.test(l)) && r1.logs?.some((l) => /not told the rules are green/.test(l)), J({ r1, runs })]);
    }
    // ================= (a3) the dropped lane's own input files do not cost the others their green =================
    {
      resetState();
      const E = engineRepo({ 'port/a': RULES_LANE, 'port/v': { ...RED_VIEW, 'Data/v.txt': 'lane input\n' } }, { lanesDir: { 'T-2': 'port/v' } });
      const ctl = path.join(T, 'ctl-a3');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { inputs: ['Data'] })) });
      fs.writeFileSync(`${ctl}-edit.mjs`, `import fs from 'node:fs'; import path from 'node:path';
export default () => { fs.writeFileSync(path.join(${JSON.stringify(path.join(S, '.lanes', 'engine', 'T-2'))}, 'Data', 'v.txt'), 'edited after the check\\n'); };`);
      queue(E, [['T-1', 'port/a'], ['T-2', 'port/v']]);
      const r1 = probe(TRAIN(ctl));
      const runs = lines(`${ctl}-runs.jsonl`);
      await guard('2.99 (a3) the dropped lane brought its own rules input (Data/v.txt in its lane copy, then edited): the land run without it is checked on the inputs it lands with, told green, and no log line says an input changed (fails before this fix: the green was lost as "the batch changed")', () => [
        r1.landed?.join() === 'T-1' && runs[1]?.green === '1' && !r1.logs?.some((l) => /an input changed/.test(l)), J({ r1, runs })]);
    }
  } finally {
    for (const r of fs.readdirSync(T).filter((n) => /^repo-/.test(n))) g(path.join(T, r), 'worktree', 'prune');
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
  }
  void events;
}
