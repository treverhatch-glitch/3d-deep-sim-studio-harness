/**
 * qa/selftest-296b.mjs — 2.96 (b): a red rules check is narrowed by its failing tests only, one green per tree is used
 * everywhere, a batch over rules.maxLanes ends with one whole check, blame reads the failure's own words, and count
 * ratchets are handed back as what they are. A red took 169 to 413 minutes because every narrowing step ran the whole
 * suite although the failing test was known after the first run. Here the tests' stand-in prints failing tests the way
 * `dotnet test` does and runs only the tests a FullyQualifiedName~ filter names; a filter that names none says so.
 * Scaffolding as qa/selftest-295a.mjs (a studio copy, a made-up engine repo, stand-ins for the land script and the tests).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, eventTypesOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, queueUnityOf, readJsonFile as readJson, writeIn as write } from './kit.mjs';

export async function selftest296B({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s296b-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: PowerShell (the process list a train cancel reads) needs Windows' own system variables, which any real shell
  // has; from this cut-down environment it ran into its time limit (P-370). Passed through as they are, as in 284u.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.5', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_TEST_FREEMEM_MB: '64000',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-296b-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  const S = path.join(tmpRoot, `296b-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-296b.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventTypesOf(eventsFileOf(evFile));
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-296b-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'comm', 'gates', 'tmp', 'locks', 'line']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.writeFileSync(evFile, ''); };
  const cache = () => readJson(path.join(S, '.studio', 'engine', 'unity-rules.json')) || {};

  // The engine repo: three systems under Sim, one data folder per system under tools/port, an item list a count test reads.
  let rn = 0;
  const engineRepo = (lanes) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    for (const [f, t] of Object.entries({ 'Sim/Fees/Fees.cs': 'class Fees { }\n', 'Sim/Move/Move.cs': 'class Move { }\n', 'Sim/Bank/Bank.cs': 'class Bank { }\n', 'tools/port/fees/a.json': '{}\n', 'tools/port/mapnav/x.json': '{}\n', 'Game/Items.txt': 'a\nb\nc\n', 'notes.txt': 'n\n' })) write(R, f, t);
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
    return { R, GW, heads, tip: g(R, 'rev-parse', 'port/main').stdout.trim() };
  };

  // The land script's stand-in: records what it was told, then merges the branches.
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, green: process.env.STUDIO_RULES_GREEN ?? null, mode: process.env.STUDIO_RULES_MODE ?? null }) + '\\n');
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); process.exit(2); } }
if (fs.existsSync(gw + '/LANDBAD')) { git(gw, 'reset', '-q', '--hard', before); console.log('  Failed Game.Land.Smoke [1 ms]'); console.log('[gate] FAIL'); process.exit(1); }
console.log('landed ' + srcs.join(' '));
`);
  // The tests' stand-in, as dotnet test prints: "Failed <name> [3 ms]" and its message. ALL runs every test; a filter runs
  // the tests a FullyQualifiedName~ term names (none: "No test matches"). A Fees file with CRASH ends the run after Fees.
  const rulesStub = path.join(T, 'rules-stub.mjs');
  fs.writeFileSync(rulesStub, `import fs from 'node:fs'; import path from 'node:path';
const [ctl, filter = 'ALL'] = process.argv.slice(2);
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const data = () => { for (const d of fs.readdirSync(path.join('tools', 'port'))) for (const f of fs.readdirSync(path.join('tools', 'port', d))) { const m = /BAD SAY=(\\w+)/.exec(read(path.join('tools', 'port', d, f))); if (m) return 'data of system ' + m[1] + ' differs'; } return ''; };
const tests = [
  { name: 'Game.Tests.Fees.FeesTests.Works', bad: () => (read('Sim/Fees/Fees.cs').includes('BAD') ? 'the fees total is wrong' : ''), crash: () => read('Sim/Fees/Fees.cs').includes('CRASH') },
  { name: 'Game.Tests.Move.MoveTests.Works', bad: () => (read('Sim/Move/Move.cs').includes('BAD') ? 'the path is wrong' : '') },
  { name: 'Game.Tests.Data.DataTests.Check', bad: data },
  { name: 'Game.Tests.CountTests.AtLeast', bad: () => (read('Game/Items.txt').includes('MORE') ? 'expected at least 3 items, there are 4' : '') },
];
const sel = filter === 'ALL' ? tests : tests.filter((t) => filter.split('|').some((x) => { const m = /^\\s*FullyQualifiedName~(.+?)\\s*$/.exec(x); return m && t.name.includes(m[1]); }));
fs.appendFileSync(ctl + '-rules.jsonl', JSON.stringify({ filter, commit: process.env.STUDIO_RULES_COMMIT || null, mode: process.env.STUDIO_RULES_MODE || null }) + '\\n');
if (!sel.length) { console.log('No test matches the given testcase filter ' + filter); process.exit(0); }
let failed = 0;
for (const t of sel) {
  const why = t.bad();
  if (!why) { console.log('  Passed ' + t.name + ' [1 ms]'); continue; }
  failed += 1;
  console.log('  Failed ' + t.name + ' [3 ms]'); console.log('  Error Message:'); console.log('   ' + why);
  if (t.crash && t.crash()) { console.log('The active test run was aborted: the test host crashed'); break; }
}
process.exit(failed ? 1 : 0);
`);
  const rulesOf = (ctl, extra = {}) => ({
    test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" ALL`,
    focus: { test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" "{filter}"`, map: [{ match: '^Sim/(\\w+)/', filter: 'Category=$1' }], fullEveryHours: 0 },
    byName: true,
    ...extra,
  });
  const cfgFor = (E, ctl, rules, more = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, batchMax: 3, rules, ...more });
  const rulesRuns = (ctl) => { try { return fs.readFileSync(`${ctl}-rules.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const landRuns = (ctl) => { try { return fs.readFileSync(`${ctl}-runs.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const queue = queueUnityOf(S);
  const ctlOf = (n) => path.join(T, `ctl-${n}`);
  const J = (x) => JSON.stringify(x).slice(0, 2800);
  // The batch check alone (rulesGate), the lanes merged as the train merges them.
  const GATE = `import { rulesConfig, rulesGate } from ${u('harness/engine-rules.mjs')};
import { chainOnTarget } from ${u('harness/unity-train.mjs')};
const cfg = rulesConfig('unity', { root: process.cwd() });
const repo = process.env.REPO; const logs = [];
const lanes = JSON.parse(process.env.LANES);
const r = rulesGate({ engine: 'unity', repo, tip: process.env.TIP, lanes, cfg, from: [repo], root: process.cwd(), id: process.env.GID || 'g', owe: true, log: (m) => logs.push(String(m)), chain: (t, ls) => chainOnTarget(repo, t, ls, 'g296', 'unity') });
console.log(JSON.stringify({ kept: r.kept.map((l) => l.task), dropped: r.dropped.map((d) => ({ task: d.lane.task, why: d.why.split('\\n')[0], ratchet: Boolean(d.ratchet) })), green: Boolean(r.green), runs: r.runs, filtered: r.filtered || null, whole: r.wholeRuns || null, runsSaid: r.runsSaid || null, why: r.why, logs: logs.filter((l) => /by name|left out|named|narrowing|rules runs|as before/.test(l)) }));`;
  const gate = (E, ls, extra = {}) => probe(GATE, { REPO: E.R, TIP: E.tip, LANES: JSON.stringify(ls.map((b) => ({ task: b.replace(/^feat\//, ''), branch: b, head: E.heads[b] }))), ...extra });
  const TRAIN = `import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const handed = []; const logs = [];
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps: { handBack: (lane, note, extra) => handed.push({ task: lane.task, note: String(note).slice(0, 900), extra: extra || null }) } });
console.log(JSON.stringify({ ok: r.ok, landed: r.landed, dropped: r.dropped, handed, rules: r.rules || null, logs: logs.filter((l) => /rules|slices|green/.test(l)) }));`;
  const evRules = () => evs(/^engine\.rules$/);
  const FEES = 'FullyQualifiedName~Game.Tests.Fees.FeesTests.Works';

  try {
    // ================= (b1) narrowing by the failing tests, then one whole check =================
    {
      resetState();
      const E = engineRepo({ 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' }, 'feat/c': { 'notes.txt': 'n2\n' }, 'feat/bad': { 'Sim/Fees/Fees.cs': 'class Fees { BAD }\n' } });
      const ctl = ctlOf('narrow');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl)) });
      const pre = gate(E, ['feat/a', 'feat/c'], { GID: 'pre' });
      const n0 = rulesRuns(ctl).length;
      const r1 = gate(E, ['feat/a', 'feat/bad', 'feat/c']);
      const rr = rulesRuns(ctl).slice(n0).map((x) => x.filter);
      const ev = evRules().pop() || {};
      await guard('2.96 (b1) a red check with a named failing test narrows by that test only: the batch runs the whole suite once (red on FeesTests.Works), the target and every prefix run only FullyQualifiedName~Game.Tests.Fees.FeesTests.Works, feat/bad is handed back, and the survivors\' tree already has a whole green from an earlier check, so it is not run again (fails before this fix: every narrowing step and the survivors re-ran the whole 80-minute suite)', () => [
        pre.green && r1.dropped?.map((d) => d.task).join() === 'bad' && r1.kept?.join() === 'a,c' && r1.green === true && rr[0] === 'ALL' && rr.slice(1).length >= 2 && rr.slice(1).every((f) => f === FEES)
          && /green without it \(the failing tests by name\)/.test(r1.dropped[0].why) && r1.whole?.runs === 1, J({ pre: pre.green, r1, rr })]);
      await guard('2.96 (b2) the saved-minutes line: the check\'s log and the engine.rules event say how many runs were by name and how many whole, with the minutes of each (fails before this fix: the cost of narrowing was not said)', () => [
        /^\d+ run\(s\) of the failing tests by name \([\d.]+ min\), 1 whole run\(s\) \([\d.]+ min\)$/.test(r1.runsSaid || '') && r1.logs?.some((l) => /rules runs: \d+ run\(s\) of the failing tests by name/.test(l))
          && ev.meta?.filtered?.runs === rr.length - 1 && ev.meta?.whole?.runs === 1 && /run\(s\) of the failing tests by name/.test(ev.msg || ''), J({ said: r1.runsSaid, meta: ev.meta, msg: ev.msg })]);
    }

    // ================= (b3) a new failing test in the whole check is narrowed again =================
    {
      resetState();
      const E = engineRepo({ 'feat/f': { 'Sim/Fees/Fees.cs': 'class Fees { BAD CRASH }\n' }, 'feat/m': { 'Sim/Move/Move.cs': 'class Move { BAD }\n' }, 'feat/c': { 'notes.txt': 'n2\n' } });
      const ctl = ctlOf('again');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl)) });
      const r1 = gate(E, ['feat/f', 'feat/m', 'feat/c']);
      const rr = rulesRuns(ctl).map((x) => x.filter);
      const MOVE = 'FullyQualifiedName~Game.Tests.Move.MoveTests.Works';
      const iAll = rr.map((f, i) => (f === 'ALL' ? i : -1)).filter((i) => i >= 0);
      await guard('2.96 (b3) the whole check on the survivors shows a test the first run never reached (its run ended at the crash): that test is narrowed again by name, its lane handed back, and a last whole check is green; the target is asked about each failing test once, by name (fails before this fix: each step was a whole run)', () => [
        r1.dropped?.map((d) => d.task).join() === 'f,m' && r1.kept?.join() === 'c' && r1.green === true && iAll.length === 3
          && rr.slice(iAll[0] + 1, iAll[1]).every((f) => f === FEES) && rr.slice(iAll[1] + 1, iAll[2]).every((f) => f === MOVE) && rr.slice(iAll[1] + 1, iAll[2]).length >= 2, J({ r1, rr })]);
    }

    // ================= (b4) blame by the failure's own words =================
    {
      resetState();
      const E = engineRepo({ 'feat/f': { 'tools/port/fees/a.json': '{ "ok": 1 }\n' }, 'feat/n': { 'tools/port/mapnav/x.json': 'BAD SAY=MapNav\n' }, 'feat/c': { 'notes.txt': 'n2\n' } });
      const ctl = ctlOf('words');
      const blame = [{ test: 'Tests\\.Data\\.', names: 'data of system (\\w+) differs', touches: ['tools/port/{name}/'], say: 'Each system keeps its data in tools/port/<system>.' }];
      setEngines({ unity: { ...cfgFor(E, ctl, rulesOf(ctl)), blame } });
      const r1 = gate(E, ['feat/f', 'feat/n', 'feat/c']);
      const rr = rulesRuns(ctl).map((x) => x.filter);
      const DATA = 'FullyQualifiedName~Game.Tests.Data.DataTests.Check';
      await guard('2.96 (b4) engines.<x>.blame with "names" reads "data of system MapNav differs" in the failure, so the lane that changes tools/port/mapnav (letter case aside) is left out at once: one run of the failing test without it is green, it is handed back with the rule\'s words and no prefix search runs (fails before this fix: blame matched only by paths, and naming the lane took a search of whole runs)', () => [
        r1.dropped?.map((d) => d.task).join() === 'n' && r1.kept?.join() === 'f,c' && r1.green && rr.join() === ['ALL', DATA, DATA, 'ALL'].join()
          && /reads MapNav in the failure of Game\.Tests\.Data\.DataTests\.Check/.test(r1.dropped[0].why) && /Each system keeps its data/.test(r1.dropped[0].why), J({ r1, rr })]);
      // The words name the wrong system: the culprit changes mapnav, the message says Fees.
      const E2 = engineRepo({ 'feat/f': { 'tools/port/fees/a.json': '{ "ok": 1 }\n' }, 'feat/n': { 'tools/port/mapnav/x.json': 'BAD SAY=Fees\n' }, 'feat/c': { 'notes.txt': 'n2\n' } });
      const ctl2 = ctlOf('words-wrong');
      setEngines({ unity: { ...cfgFor(E2, ctl2, rulesOf(ctl2)), blame } });
      const r2 = gate(E2, ['feat/f', 'feat/n', 'feat/c']);
      await guard('2.96 (b5) when the words name the wrong lane (the message says Fees, feat/f changes tools/port/fees, the red comes from feat/n), the run without the suspect is still red: the suspect is not handed back, the search by name finds feat/n, and feat/f lands (fails before this fix: there was no blame by words to go wrong)', () => [
        r2.dropped?.map((d) => d.task).join() === 'n' && r2.kept?.join() === 'f,c' && r2.green && r2.logs?.some((l) => /named f, but the batch without it is red: narrowing as before/.test(l)), J(r2)]);
    }

    // ================= (b6) the system filter names the first suspect =================
    {
      resetState();
      const E = engineRepo({ 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' }, 'feat/bad': { 'Sim/Fees/Fees.cs': 'class Fees { BAD }\n' }, 'feat/c': { 'notes.txt': 'n2\n' } });
      const ctl = ctlOf('system');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { focus: { test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" "{filter}"`, auto: { root: 'Sim', paths: ['Sim/{name}/'], filter: 'FullyQualifiedName~Game.Tests.{name}' }, fullEveryHours: 0 } })) });
      const r1 = gate(E, ['feat/a', 'feat/bad', 'feat/c']);
      const rr = rulesRuns(ctl).map((x) => x.filter);
      await guard('2.96 (b6) with no blame rule, a failing test that one system\'s focus filter takes (FullyQualifiedName~Game.Tests.Fees) makes the lane that changes Sim/Fees the first suspect: the target and one run without it, both by name, then the whole check: feat/bad is handed back with no search (fails before this fix: the prefix search)', () => [
        r1.dropped?.map((d) => d.task).join() === 'bad' && r1.green && rr.join() === ['ALL', FEES, FEES, 'ALL'].join() && /taken by the rules\.focus filter FullyQualifiedName~Game\.Tests\.Fees/.test(r1.dropped[0].why), J({ r1, rr })]);
    }

    // ================= (b7) a filter that runs no test is never a green =================
    {
      resetState();
      const E = engineRepo({ 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' }, 'feat/bad': { 'Sim/Fees/Fees.cs': 'class Fees { BAD }\n' } });
      const ctl = ctlOf('none');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { byName: 'Nope~{test}' })) });
      const r1 = gate(E, ['feat/a', 'feat/bad']);
      const rr = rulesRuns(ctl).map((x) => x.filter);
      await guard('2.96 (b7) a by-name filter that runs no test ("No test matches") is not taken as green: the check says so and narrows with whole runs, and still hands back the right lane (fails before this fix: no by-name runs; guards that a wrong filter can never hand a lane back)', () => [
        r1.dropped?.map((d) => d.task).join() === 'bad' && r1.kept?.join() === 'a' && rr[1] === 'Nope~Game.Tests.Fees.FeesTests.Works' && rr.slice(2).every((f) => f === 'ALL') && r1.logs?.some((l) => /ran no test.*whole runs/.test(l)), J({ r1, rr })]);
    }

    // ================= (b8) count ratchets, and the green after a drop reaches the land run =================
    {
      resetState();
      const E = engineRepo({ 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' }, 'feat/more': { 'Game/Items.txt': 'a\nb\nc\nMORE\n' } });
      const ctl = ctlOf('ratchet');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { ratchets: ['CountTests\\.AtLeast'] })) });
      queue(E, [['T-301', 'feat/a'], ['T-302', 'feat/more']]);
      const r1 = probe(TRAIN);
      const land = landRuns(ctl);
      const h = (r1.handed || []).find((x) => x.task === 'T-302') || {};
      const rt = evs(/^engine\.ratchet$/);
      const kind = probe(`import { handBackKind } from ${u('harness/handback-kind.mjs')};
const e = { type: 'task.paused', task: 'T-302', agent: 'porter-1', msg: ${JSON.stringify(`Handed back T-302: ${h.note || ''}`)}, meta: { handBackCause: 'ratchet' } };
console.log(JSON.stringify({ kind: handBackKind(e, [e]), plain: handBackKind({ ...e, msg: 'Handed back T-302: red', meta: {} }, []) }));`);
      await guard('2.96 (b8) a red only on a count ratchet (rules.ratchets) is narrowed by name like any red and handed back with cause ratchet and the words "a count ratchet tripped (Game.Tests.CountTests.AtLeast): this is not a behaviour regression; raise the count in this branch and queue again"; one engine.ratchet event counts it; handBackKind calls it ratchet (fails before this fix: it read as a behaviour regression and cost hours of land runs)', () => [
        h.extra?.cause === 'ratchet' && /a count ratchet tripped \(Game\.Tests\.CountTests\.AtLeast\): this is not a behaviour regression; raise the count in this branch and queue again/.test(h.note || '') && rt.length === 1 && rt[0].task === 'T-302'
          && kind.kind === 'ratchet' && kind.plain === 'real', J({ h, rt: rt.map((e) => e.msg), kind })]);
      await guard('2.96 (b9) after the drop, the whole check of the lane left is green, so its land run is told STUDIO_RULES_GREEN=1 and STUDIO_RULES_MODE=full (a guard of unchanged behaviour: it holds before and after this change)', () => [
        r1.landed?.join() === 'T-301' && land.length === 1 && land[0].green === '1' && land[0].mode === 'full', J({ land, r1: { landed: r1.landed, rules: r1.rules } })]);
    }

    // ================= (b10) a batch over rules.maxLanes: slices, then one whole check =================
    {
      resetState();
      const E = engineRepo({ 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' }, 'feat/c': { 'notes.txt': 'n2\n' } });
      const ctl = ctlOf('slices');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { maxLanes: 1 })) });
      queue(E, [['T-311', 'feat/a'], ['T-312', 'feat/c']]);
      const r1 = probe(TRAIN);
      const land = landRuns(ctl);
      const show = spawnSync(process.execPath, ['harness/engine-rules.mjs', 'show'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 60000 });
      const status = spawnSync(process.execPath, ['harness/unity-train.mjs', 'status'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 60000 });
      const start = evs(/^task\.train\.unity\.start$/).pop() || {};
      await guard('2.96 (b10) a batch of 2 over rules.maxLanes 1 is checked in 2 slices and then once whole; green, the land run is told STUDIO_RULES_GREEN=1; the start event, the log and train status say it in plain words, and rules show warns that batchMax 3 is above maxLanes 1 (fails before this fix: a sliced check never told the land run, which ran the whole suite itself, silently)', () => [
        r1.landed?.join() === 'T-311,T-312' && land.length === 1 && land[0].green === '1' && rulesRuns(ctl).map((x) => x.filter).join() === 'ALL,ALL,ALL'
          && /more than rules\.maxLanes 1: the rules check runs in slices, then once on the whole batch/.test(start.msg || '') && r1.logs?.some((l) => /the rules check runs in 2 slices, then once on the whole batch/.test(l))
          && /2 slices \(rules\.maxLanes\), then once on the whole batch: green, so the land run was told the rules are green/.test(out(status)) && /WARNING: engines\.unity\.batchMax 3 is above rules\.maxLanes 1/.test(out(show)), J({ r1: { landed: r1.landed, rules: r1.rules, logs: r1.logs }, land, start: start.msg, status: out(status).slice(-800), show: out(show).slice(-600) })]);
    }

    // ================= (b11) one green per tree: the owed full run and the check ahead =================
    {
      resetState();
      const E = engineRepo({ 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' }, 'feat/bad': { 'Sim/Fees/Fees.cs': 'class Fees { BAD }\n' } });
      const ctl = ctlOf('owed');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { focus: { test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" "{filter}"`, map: [{ match: '^Sim/(\\w+)/', filter: 'Category=$1' }], fullEveryHours: 24 } })) });
      const OWED = `import { rulesConfig, fullRulesOwed, runRulesAt, rulesCacheKeys, rulesKey } from ${u('harness/engine-rules.mjs')};
import { aheadVerdict } from ${u('harness/rules-ahead.mjs')};
import fs from 'node:fs'; import path from 'node:path';
const root = process.cwd(); const repo = process.env.REPO; const cfg = rulesConfig('unity', { root });
const owed = () => fullRulesOwed(root, 'unity', cfg, { repo, tip: process.env.TIP, from: [repo] });
const before = owed();
const r = runRulesAt({ engine: 'unity', repo, sha: process.env.TIP, cfg, from: [repo], root, id: 'o' });
const after = owed();
const keys = rulesCacheKeys(root, 'unity');
const g1 = runRulesAt({ engine: 'unity', repo, sha: process.env.A, cfg, from: [repo], root, id: 'ah' });
const r1 = runRulesAt({ engine: 'unity', repo, sha: process.env.BAD, cfg, from: [repo], root, id: 'ah' });
const f = (k) => path.join(root, '.studio', 'engine', 'unity-rules-ahead' + k + '.json');
fs.writeFileSync(f(''), JSON.stringify({ train: 't-old', pid: 999999, tasks: ['a'], heads: [], head: process.env.TIP, next: process.env.A, key: 'k', baseKey: 'b', at: new Date().toISOString(), told: 0 }));
fs.writeFileSync(f('-out'), JSON.stringify({ pid: 999999, state: 'done', status: 'pass', lines: [], before: keys }));
await aheadVerdict(root, 'unity', { keep: false, why: 'the land run did not land the batch' });
const trees = JSON.parse(fs.readFileSync(path.join(root, '.studio', 'engine', 'unity-rules.json'), 'utf8')).trees;
console.log(JSON.stringify({ before: before.why, run: r.status, after: after.why, kept: Boolean(after.kept), g1: g1.status, r1: r1.status, green: Boolean(trees[rulesKey({ repo, sha: process.env.A, cfg })]), red: Boolean(trees[rulesKey({ repo, sha: process.env.BAD, cfg })]) }));`;
      const o = probe(OWED, { REPO: E.R, TIP: E.tip, A: E.heads['feat/a'], BAD: E.heads['feat/bad'] });
      await guard('2.96 (b11) a full rules run is not owed on a target tree that has a kept whole green (same command and inputs): owed before the green, not owed after it (fails before this fix: it was owed, so the train scheduled the owed run, its event and its log line on a tree that already had its green)', () => [
        Boolean(o.before) && o.run === 'pass' && o.after === '' && o.kept === true, J(o)]);
      await guard('2.96 (b12) a check ahead ended because its batch did not land unchanged keeps the exact-tree green it finished (a fact about that tree) and forgets its red (fails before this fix: every result of a dropped check ahead was forgotten)', () => [
        o.g1 === 'pass' && o.r1 === 'red' && o.green === true && o.red === false, J(o)]);
    }

    // ================= (b13) pieces: the filter, the system filter reading, land narrowing by name =================
    {
      const p = probe(`import { nameFilter, filterTakes, blameList, blameSuspect } from ${u('harness/engine-rules.mjs')};
import { nextStep } from ${u('harness/unity-train.mjs')};
const cfg = { byName: { test: 'dotnet test --filter "{filter}"', each: 'FullyQualifiedName~{test}', join: '|' } };
const nf = nameFilter(cfg, ['Game.Tests.A.Works(1,"x")', 'Game.Tests.B.Works']);
const unsafe = nameFilter(cfg, ['Game.Tests.A.Works\`1']);
const ft = [filterTakes('FullyQualifiedName~Tests.Fees', 'Game.Tests.Fees.X'), filterTakes('Category=Fees', 'Game.Tests.Fees.X'), filterTakes('Tests.Fees&FullyQualifiedName!~Slow', 'Game.Tests.Fees.Slow'), filterTakes('Name=Works|ClassName=Other', 'Game.Tests.Fees.Works')];
console.log(JSON.stringify({ nf, unsafe, ft, bad: blameList([{ test: 'x', names: 'nogroup', touches: 'a/' }]).errors.length }));`);
      const q = probe(`import { nextStep } from ${u('harness/unity-train.mjs')};
console.log(JSON.stringify({ st0: nextStep({ lanes: ['a', 'b', 'c'], results: [{ kind: 'land', group: ['a', 'b', 'c'], status: 'red', failures: ['Game.Tests.Fees.X'] }], ties: null, byNameOk: true }) }));`);
      await guard('2.96 (b13) the failing tests become one filter (FullyQualifiedName~ each, joined by |, a parameter list cut off); a name unsafe on a command line gives no filter (the old way); the filter reader takes ~, =, !~, & and |, and never judges a property it cannot see (Category); a blame "names" without a group is refused', () => [
        p.nf?.filter === 'FullyQualifiedName~Game.Tests.A.Works|FullyQualifiedName~Game.Tests.B.Works' && p.nf?.command === `dotnet test --filter "${p.nf?.filter}"` && p.unsafe === null
          && p.ft?.join() === 'true,false,false,true' && p.bad === 1, J(p)]);
      const byNameOf = (rules) => { setEngines({ unity: { land: 'x', target: 'port/main', rules } }); return probe(`import { rulesConfig } from ${u('harness/engine-rules.mjs')};
const c = rulesConfig('unity', { root: process.cwd() }); console.log(JSON.stringify({ b: c.byName || null, bad: c.focusBad || [] }));`); };
      const dn = byNameOf({ test: 'dotnet test tools/SimTests', focus: { test: 'dotnet test tools/SimTests --filter "{filter}"', smoke: 'Category=Smoke', map: [], auto: { root: 'Game/Sim', paths: ['Game/Sim/{name}/'], filter: 'FullyQualifiedName~Tests.Sim.{name}' } } });
      const other = byNameOf({ test: 'run-tests', focus: { test: 'run-tests --only "{filter}"', auto: { root: 'Game/Sim', paths: ['Game/Sim/{name}/'], filter: 'Sim.{name}' } } });
      const off = byNameOf({ test: 'dotnet test tools/SimTests', byName: false, focus: { test: 'dotnet test tools/SimTests --filter "{filter}"', auto: { root: 'Game/Sim', paths: ['Game/Sim/{name}/'], filter: 'Sim.{name}' } } });
      const own = byNameOf({ test: 'run-tests', byName: { each: 'Name={test}', join: ' or ' }, focus: { test: 'run-tests --only "{filter}"', auto: { root: 'Game/Sim', paths: ['Game/Sim/{name}/'], filter: 'Sim.{name}' } } });
      await guard('2.96 (b17) rules.byName: unset, it is on with FullyQualifiedName~{test} joined by | when rules.focus.test is dotnet test (the runner the default fits), off for another runner (2.95 narrowing), false turns it off, and { each, join } sets the studio\'s own form (fails before this fix: there was no rules.byName)', () => [
        dn.b?.each === 'FullyQualifiedName~{test}' && dn.b?.join === '|' && /--filter "\{filter\}"/.test(dn.b?.test || '') && other.b === null && off.b === null && own.b?.each === 'Name={test}' && own.b?.join === ' or ' && !dn.bad.length, J({ dn, other, off, own })]);
      await guard('2.96 (b14) a red land run narrows by name where the land script runs only named tests: the search steps carry the failing tests, run by name and land nothing (2.86\'s by-name steps, which 2.96 keeps; a guard of unchanged behaviour: it holds before and after this change)', () => [
        q.st0?.step === 'bisect' && q.st0?.run === 'name' && q.st0?.lands === false && q.st0?.tests?.join() === 'Game.Tests.Fees.X', J(q.st0)]);
    }

    // ================= (b16) a land red drops a lane: a kept whole green of the tree left still reaches the land run =================
    {
      resetState();
      const E = engineRepo({ 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' }, 'feat/lb': { 'LANDBAD': 'x\n' } });
      const ctl = ctlOf('landred');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl)) });
      const pre = gate(E, ['feat/a'], { GID: 'pre' });
      queue(E, [['T-321', 'feat/a'], ['T-322', 'feat/lb']]);
      const r1 = probe(TRAIN);
      const land = landRuns(ctl);
      const alone = land.find((x) => x.srcs.join() === 'feat/a') || {};
      await guard('2.96 (b16) the rules check is green on the batch, its land run is red and the land search drops a lane; the land run of feat/a alone is told STUDIO_RULES_GREEN=1 because its exact tree has a kept whole rules green (fails before this fix: only the batch the rules check named was told green, so the land ran the whole suite again on a tree that had passed it)', () => [
        pre.green && r1.landed?.join() === 'T-321' && land[0]?.green === '1' && alone.green === '1' && alone.mode === 'full', J({ land, r1: { landed: r1.landed, dropped: r1.dropped, logs: r1.logs } })]);
    }

    // ================= (b15) none of it set: 2.95's runs =================
    {
      resetState();
      const E = engineRepo({ 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' }, 'feat/bad': { 'Sim/Fees/Fees.cs': 'class Fees { BAD }\n' }, 'feat/c': { 'notes.txt': 'n2\n' } });
      const ctl = ctlOf('plain');
      setEngines({ unity: cfgFor(E, ctl, { test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" ALL` }) });
      const r1 = gate(E, ['feat/a', 'feat/bad', 'feat/c']);
      const rr = rulesRuns(ctl).map((x) => x.filter);
      const ev = evRules().pop() || {};
      await guard('2.96 (b15) a studio with no rules.focus.test (so no rules.byName) narrows a red as 2.95 did: every step is the whole command, the hand-back says "it is green without it" with no by-name words, and the event has no by-name counts (a guard of unchanged behaviour: it holds before and after this change)', () => [
        r1.dropped?.map((d) => d.task).join() === 'bad' && rr.every((f) => f === 'ALL') && rr.length >= 4 && !/by name/.test(r1.dropped[0].why) && !ev.meta?.filtered && r1.runsSaid === null && !cache().parts, J({ r1, rr, meta: ev.meta })]);
    }
  } finally {
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep takes it */ }
  }
}
