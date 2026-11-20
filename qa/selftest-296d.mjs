/**
 * qa/selftest-296d.mjs — 2.96 (d): each engine-train landing is posted once to the studio's webhook; the daily test-cost
 * report (rules.times, npm run engine -- test-cost); play-plan --propose for the paths no play.focus.map entry takes;
 * the refill wakes the Producer when no open task can start. No webhook is called: the Communicator gets a stand-in fetch
 * that writes each request to a file.
 *
 * The scaffolding (a studio copy, a made-up engine repo) is qa/selftest-295d.mjs's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, queueUnityOf, writeIn as write } from './kit.mjs';

export async function selftest296D({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s296d-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: the helpers below get a cut-down environment; PowerShell (used to read a process's start time and to list a
  // process tree) needs Windows' own system variables, which any real shell has. Pass those through as they are.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_REPORT_WEBHOOK: '', STUDIO_COMM_WEBHOOK: '', STUDIO_COMM: '', STUDIO_COMM_DISK_GB: '0',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-296d-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  const S = path.join(tmpRoot, `296d-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json', '.env']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-296d.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, AGENT_EVENTS_MIRROR: '', STUDIO_MAIN_ROOT: S, ...extra });
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code, extra = {}) => {
    const f = path.join(S, `.probe-296d-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envOf(extra), encoding: 'utf8', timeout: 240000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  const node = (args, extra = {}) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, env: envOf(extra), encoding: 'utf8', timeout: 120000 });

  try {
    // ---- a made-up engine repo with two systems, one switched on ----
    const R = path.join(T, 'repo');
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    write(R, 'Systems/Fees.sys', 'name: Fees\non: true\n');
    write(R, 'Systems/MapNav.sys', 'name: MapNav\non: false\n');
    g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    const engineCfg = (extra = {}) => ({ unity: { land: 'node -e "0" {branch}', target: 'port/main', cwd: fwd(R), rules: false, progress: 'node -e "console.log(\'Fees ported: 40 percent\')"', switches: { files: 'Systems/*.sys', name: '^name: (.+)$', on: '^on: true', total: 3 }, ...extra } });

    // ---- (1) the landing post ----
    const hookUrl = 'http://127.0.0.1:9/api/webhooks/4242/tok296dNotARealToken';
    const capFile = path.join(T, 'posts.jsonl');
    const commDir = path.join(S, '.studio', 'comm');
    const nowMs = Date.now();
    const landed = (ids, ageMin, id) => ({ id, ts: new Date(nowMs - ageMin * 60000).toISOString(), type: 'task.train.unity.landed', agent: 'unity-train', status: 'ok', msg: 'Unity train x: moved', meta: { train: 'x', engine: 'unity', lanes: ids } });
    const ids10 = Array.from({ length: 10 }, (_, i) => `T-${i + 1}`);
    const titles = Object.fromEntries(ids10.map((t, i) => [t, `Port system number ${i + 1} with a very plain title`]));
    const evsAll = [
      landed(ids10, 5, 'evt_land_a'),
      { id: 'evt_web', ts: new Date(nowMs - 12 * 3600000).toISOString(), type: 'lane.merged', agent: 'merge', task: 'T-99', status: 'ok', meta: {} },
      { id: 'evt_old', ts: new Date(nowMs - 30 * 3600000).toISOString(), type: 'lane.merged', agent: 'merge', task: 'T-98', status: 'ok', meta: {} },
    ];
    const passCode = (events, extra = '') => `import fs from 'node:fs'; import { communicatorPass } from ${u('harness/communicator.mjs')};
const cap = ${JSON.stringify(capFile)};
const fetchImpl = async (url, init) => { fs.appendFileSync(cap, JSON.stringify({ url, body: JSON.parse(init.body) }) + '\\n'); return { ok: true, status: 204 }; };
const deps = { events: ${JSON.stringify(events)}, needs: [], beta: { on: false }, machine: null, delegated: false, inProgress: [], engines: [], fetchImpl, landing: { titles: ${JSON.stringify(titles)} } };
const now = ${nowMs};
const r1 = await communicatorPass({ now, deps });
const r2 = await communicatorPass({ now: now + 60000, deps });
${extra}
console.log(JSON.stringify({ r1: { posted: r1.posted, kind: r1.kind, why: r1.why }, r2: { posted: r2.posted, kind: r2.kind } }));`;
    const fresh = () => { fs.rmSync(commDir, { recursive: true, force: true }); fs.rmSync(capFile, { force: true }); fs.mkdirSync(commDir, { recursive: true }); fs.writeFileSync(path.join(commDir, 'state.json'), JSON.stringify({ t0: new Date(nowMs - 3600000).toISOString(), lastStatusAt: new Date(nowMs).toISOString() })); };
    const posts = () => { try { return fs.readFileSync(capFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

    setEngines(engineCfg());
    fresh();
    const a = probe(passCode(evsAll), { STUDIO_COMM_WEBHOOK: hookUrl });
    const pa = posts();
    const textA = String(pa[0]?.body?.text || '');
    await guard('2.96 (d1) a landing is posted once with its tasks and titles (8, then "and 2 more"), the 24-hour count, the progress line and "Systems ON: 1 of 3", and not a second time on the next pass (fails before this fix: nothing was posted when a train landed)', () => [
      pa.length === 1 && a.r1?.kind === 'landing' && a.r2?.kind === null && /Unity landing \d\d:\d\d: 10 tasks landed/.test(textA) && /- T-1 Port system number 1 with/.test(textA) && /- T-8 /.test(textA) && !/- T-9 /.test(textA) && /and 2 more/.test(textA)
        && /11 landed in the last 24 hours\./.test(textA) && /Fees ported: 40 percent/.test(textA) && /Systems ON: 1 of 3/.test(textA), JSON.stringify({ a, posts: pa.length, textA })]);

    setEngines(engineCfg({ announce: false }));
    fresh();
    const off = probe(passCode(evsAll), { STUDIO_COMM_WEBHOOK: hookUrl });
    await guard('2.96 (d2) engines.<x>.announce: false posts nothing for the landing (fails before this fix: there was no switch)', () => [posts().length === 0 && off.r1?.kind === null, JSON.stringify({ off, posts: posts().length })]);

    setEngines(engineCfg());
    fresh();
    const noHook = probe(passCode(evsAll), { STUDIO_COMM_WEBHOOK: '', STUDIO_REPORT_WEBHOOK: '' });
    await guard('2.96 (d3) with no webhook set nothing is posted and nothing is called', () => [posts().length === 0 && noHook.r1?.posted === false, JSON.stringify({ noHook, posts: posts().length })]);

    setEngines(engineCfg({ progress: 'node -e "process.exit(3)"' }));
    fresh();
    const badProg = probe(passCode(evsAll), { STUDIO_COMM_WEBHOOK: hookUrl });
    const textB = String(posts()[0]?.body?.text || '');
    await guard('2.96 (d4) a progress command that fails is left out of the post, which is still posted with the rest', () => [
      posts().length === 1 && /Systems ON: 1 of 3/.test(textB) && !/Fees ported/.test(textB) && !/exit 3/.test(textB), JSON.stringify({ badProg, textB })]);

    // ---- (2) the test-cost report ----
    const trx = (rows) => `<?xml version="1.0" encoding="UTF-8"?>\r\n<TestRun id="x" xmlns="http://example.invalid/trx">\r\n<Results>\r\n${rows.map(([n, d]) => `  <UnitTestResult executionId="e" duration="${d}"\r\n    testName="${n}" outcome="Passed" />`).join('\r\n')}\r\n</Results>\r\n</TestRun>\r\n`;
    const TRX = trx([['Game.Sim.FeesTests.Rounding', '00:34:36.5000000'], ['Game.Sim.MapNavTests.Costs &amp; Tolls', '00:13:36.0000000'], ['Game.Sim.FeesTests.Quick', '00:00:00.0120000']]);
    const NUNIT = '<test-run><test-suite><test-case id="1" name="Rounding" fullname="Game.Sim.FeesTests.Rounding" duration="12.5" result="Passed"/><test-case name="Old" time="3"/></test-suite></test-run>';
    const JUNIT = '<testsuite><testcase classname="Game.Sim.Ticks" name="Order" time="7.25"/><testcase name="Alone" time="0.5"/></testsuite>';
    const parsed = probe(`import { parseTimes } from ${u('harness/rules-times.mjs')};
console.log(JSON.stringify({ trx: parseTimes(${JSON.stringify(TRX)}), nunit: parseTimes(${JSON.stringify(NUNIT)}), junit: parseTimes(${JSON.stringify(JUNIT)}) }));`);
    const has = (list, name, sec) => (list || []).some((x) => x.name === name && Math.abs(x.seconds - sec) < 0.001);
    await guard('2.96 (d5) times are read from .trx (CRLF, attributes over two lines, &amp;), NUnit (duration or time) and JUnit (classname and name) with small regexes (fails before this fix: no test time was read from any result file)', () => [
      has(parsed.trx, 'Game.Sim.FeesTests.Rounding', 2076.5) && has(parsed.trx, 'Game.Sim.MapNavTests.Costs & Tolls', 816) && has(parsed.trx, 'Game.Sim.FeesTests.Quick', 0.012) && parsed.trx.length === 3
        && has(parsed.nunit, 'Game.Sim.FeesTests.Rounding', 12.5) && has(parsed.nunit, 'Old', 3) && has(parsed.junit, 'Game.Sim.Ticks.Order', 7.25) && has(parsed.junit, 'Alone', 0.5), JSON.stringify(parsed)]);

    const stub = path.join(T, 'tests-stub.mjs');
    fs.writeFileSync(stub, `import fs from 'node:fs'; import path from 'node:path';
fs.mkdirSync(path.join('out', 'results'), { recursive: true });
fs.writeFileSync(path.join('out', 'results', 'run.trx'), ${JSON.stringify(TRX)});
console.log('  Passed Game.Sim.FeesTests.Rounding [3 ms]');
`);
    setEngines({ unity: { ...engineCfg().unity, rules: { test: `node "${fwd(stub)}"`, times: 'out/**/*.trx' } } });
    fs.rmSync(path.join(S, '.studio', 'engine'), { recursive: true, force: true });
    const shaR = g(R, 'rev-parse', 'port/main').stdout.trim();
    const ran = probe(`import { rulesConfig, runRulesAt } from ${u('harness/engine-rules.mjs')};
const cfg = rulesConfig('unity', { root: process.cwd() });
const r = runRulesAt({ engine: 'unity', repo: ${JSON.stringify(fwd(R))}, sha: ${JSON.stringify(shaR)}, cfg, root: process.cwd(), id: 'train-296', useCache: false });
console.log(JSON.stringify({ status: r.status, why: r.why }));`);
    const kept = (() => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'engine', 'unity-times.json'), 'utf8')); } catch { return null; } })();
    await guard('2.96 (d6) after a rules run the tests are kept for the day with the train and the command (fails before this fix: nothing was kept)', () => [
      ran.status === 'pass' && kept?.runs?.length === 1 && kept.runs[0].train === 'train-296' && kept.runs[0].tests[0][0] === 'Game.Sim.FeesTests.Rounding' && kept.runs[0].tests[0][1] === 2076.5 && kept.runs[0].count === 3, JSON.stringify({ ran, kept })]);

    // an old result file (older than the command) is never counted; a name used in two commands of one train is listed
    const oldDir = path.join(T, 'old-checkout');
    write(oldDir, 'out/old.trx', TRX);
    const past = new Date(Date.now() - 3600000);
    fs.utimesSync(path.join(oldDir, 'out', 'old.trx'), past, past);
    const reportP = probe(`import fs from 'node:fs'; import path from 'node:path'; import { timesRead, recordTimes, costReport, costText, costDigestLines } from ${u('harness/rules-times.mjs')};
const root = process.cwd();
const stale = timesRead(${JSON.stringify(oldDir)}, 'out/*.trx', { since: Date.now() - 60000 }).length;
const fresh = timesRead(${JSON.stringify(oldDir)}, 'out/*.trx', { since: 0 }).length;
fs.rmSync(path.join(root, '.studio', 'engine', 'unity-times.json'), { force: true });
const dirA = ${JSON.stringify(path.join(T, 'ck-a'))}; const dirB = ${JSON.stringify(path.join(T, 'ck-b'))}; const dirC = ${JSON.stringify(path.join(T, 'ck-c'))};
const put = (d, n, rows) => { fs.mkdirSync(path.join(d, 'out'), { recursive: true }); fs.writeFileSync(path.join(d, 'out', 'r.trx'), rows.map(([t, s]) => '<UnitTestResult testName="' + t + '" duration="00:00:' + String(s).padStart(2, '0') + '.0000000" />').join('\\n')); };
put(dirA, 'a', [['Fees.Rounding', 50], ['Fees.Other', 10]]);
put(dirB, 'b', [['Fees.Rounding', 50], ['MapNav.Costs', 40]]);
put(dirC, 'c', [['Fees.Rounding', 50]]);
const g = 'out/*.trx';
recordTimes(root, 'unity', { dir: dirA, train: 'tr1', command: 'rules.first', since: 0 });
recordTimes(root, 'unity', { dir: dirB, train: 'tr1', command: 'Cat=Fees', since: 0 });
recordTimes(root, 'unity', { dir: dirC, train: 'tr2', command: 'Cat=Fees', since: 0 });
fs.writeFileSync(path.join(root, '.studio', 'engine', 'unity-rules.json'), JSON.stringify({ trees: {}, partStats: { 'Cat=Fees': { peakGb: 2.25 }, 'Cat=Move': { peakGb: 7 }, Rest: { seconds: 5 } } }));
const r = await costReport(root, 'unity', { events: [] });
const lines = await costDigestLines(root, { events: [] });
console.log(JSON.stringify({ stale, fresh, r, text: costText(r), lines }));`);
    const rp = reportP.r || {};
    await guard('2.96 (d7) a result file older than the command is not counted (fails before this fix: a stale file from an earlier run would be)', () => [reportP.stale === 0 && reportP.fresh === 3, JSON.stringify({ stale: reportP.stale, fresh: reportP.fresh })]);
    await guard('2.96 (d8) the long report lists the slowest tests with their share of the test time (Fees.Rounding 150 s of 200 s is 75%), the test that ran in two commands of one train (tr1, not tr2), the shards by measured memory (7 GB first), and zero ratchet hand-backs', () => [
      rp.slowest?.[0]?.name === 'Fees.Rounding' && rp.slowest[0].seconds === 150 && rp.slowest[0].share === 75 && rp.slowest.length === 3 && rp.twice?.length === 1 && rp.twice[0].train === 'tr1' && rp.twice[0].name === 'Fees.Rounding' && rp.twice[0].commands.join() === 'rules.first,Cat=Fees'
        && rp.heavy?.[0]?.filter === 'Cat=Move' && rp.heavy[0].peakGb === 7 && rp.heavy.length === 2 && rp.ratchets === 0 && /Hand-backs of kind ratchet in the last 24 hours: 0\./.test(reportP.text || '') && /75%\) Fees\.Rounding/.test(reportP.text || ''), JSON.stringify(reportP)]);
    // the digest: the block is short and the whole digest stays under the cap
    const digestP = probe(`import { buildDigest, MAX_WORDS } from ${u('harness/digest.mjs')};
const d = await buildDigest({ events: [] });
const block = d.text.split('\\n').filter((l) => /^Test cost/.test(l));
console.log(JSON.stringify({ block, words: d.words, max: MAX_WORDS }));`);
    await guard('2.96 (d9) the daily digest gets the test-cost block, at most 3 lines, pointing to npm run engine -- test-cost, and the digest stays under its 200-word cap', () => [
      digestP.block?.length === 1 && /Test cost \(unity, 24 h\): slowest Rounding 2\.5 min \(75%\); 1 ran twice in a train; npm run engine -- test-cost/.test(digestP.block[0]) && digestP.words < digestP.max, JSON.stringify(digestP)]);
    const cli = node(['harness/engine.mjs', 'test-cost', '--engine', 'unity']);
    await guard('2.96 (d10) npm run engine -- test-cost --engine unity prints the long form', () => [cli.status === 0 && /Test cost for unity/.test(out(cli)) && /Slowest tests:/.test(out(cli)) && /Ran more than once in one train \(1\):/.test(out(cli)), out(cli).slice(0, 600)]);

    // ---- (3) Play Mode map gaps ----
    const E1 = path.join(T, 'repo-train');
    const GW = path.join(T, 'gate-train');
    fs.mkdirSync(E1, { recursive: true });
    g(E1, 'init', '-q', '-b', 'port/main');
    write(E1, 'base.txt', 'base\n');
    g(E1, 'add', '-A'); g(E1, 'commit', '-qm', 'start');
    g(E1, 'checkout', '-q', '-b', 'dev');
    g(E1, 'worktree', 'add', '-q', GW, 'port/main');
    g(E1, 'checkout', '-q', '-B', 'feat/gap', 'port/main');
    for (const f of ['Game/Net/Sync.cs', 'Game/Net/Client.cs', 'Game/Net/Server.cs', 'Game/Net/Pack.cs', 'Docs2/a.txt', 'Docs2/b.txt', 'Game/Ui/Hud.cs']) write(E1, f, `${f}\n`);
    g(E1, 'add', '-A'); g(E1, 'commit', '-qm', 'gap work');
    const gapHead = g(E1, 'rev-parse', 'feat/gap').stdout.trim();
    g(E1, 'checkout', '-q', 'dev');
    const landStub = path.join(T, 'land-stub.mjs');
    fs.writeFileSync(landStub, `import { spawnSync } from 'node:child_process';
const [gw, ...srcs] = process.argv.slice(2);
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: gw, encoding: 'utf8', windowsHide: true });
for (const s of srcs) { const m = git('merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) process.exit(2); }
console.log('landed ' + srcs.join(' '));
`);
    const playFocus = { map: [{ match: '^Game/Ui/', filter: 'Game.PlayTests.Ui' }], smoke: 'Game.PlayTests.Smoke', skip: ['^Sim/Rules/'] };
    const trainCfg = (extra = {}) => ({ unity: { land: `node "${fwd(landStub)}" "${fwd(GW)}" {branch}`, target: 'port/main', cwd: fwd(E1), gateWorktree: fwd(GW), timeoutMin: 5, rules: false, play: { focus: playFocus }, ...extra } });
    setEngines(trainCfg());
    fs.rmSync(path.join(S, '.studio', 'engine'), { recursive: true, force: true });
    queueUnityOf(S)({ heads: { 'feat/gap': gapHead } }, [['T-961', 'feat/gap']]);
    const train = probe(`import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const logs = [];
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps: { handBack: () => {} } });
console.log(JSON.stringify({ ok: r.ok, landed: r.landed, logs: logs.filter((l) => /play stage/.test(l)) }));`, { STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_UNITY_EDITMODE_PLAN: 'off' });
    const gaps = (() => { try { return fs.readFileSync(path.join(S, '.studio', 'engine', 'unity-play-gaps.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
    await guard('2.96 (d11) a train whose Play Mode stage ran in full for unmapped paths keeps all of them (6 here, not the 5 the log names) with its train id (fails before this fix: only 5 paths were named and none was kept)', () => [
      train.landed?.join() === 'T-961' && train.logs?.some((l) => /play stage in full/.test(l)) && gaps.length === 1 && /^[\w-]+$/.test(gaps[0].train) && gaps[0].paths.length === 6 && !gaps[0].paths.includes('Game/Ui/Hud.cs') && gaps[0].paths.includes('Docs2/b.txt'), JSON.stringify({ train, gaps })]);
    const digestG = probe(`import { buildDigest, MAX_WORDS } from ${u('harness/digest.mjs')};
const d = await buildDigest({ events: [] });
console.log(JSON.stringify({ line: d.text.split('\\n').filter((l) => /^Play Mode ran in full/.test(l)), words: d.words, max: MAX_WORDS }));`);
    await guard('2.96 (d12) the digest says how often Play Mode ran in full for unmapped paths in 24 h, names the top 3 folders and the command, within the word cap', () => [
      digestG.line?.length === 1 && digestG.line[0] === 'Play Mode ran in full 1 time in 24 h for unmapped paths: Game/Net/, Docs2/; npm run engine -- play-plan --propose' && digestG.words < digestG.max, JSON.stringify(digestG)]);

    // --propose: skip where the rules tests judge the folder (a map entry or an auto folder) or play.focus.skip takes it, else a map entry to fill in
    setEngines(trainCfg({ rules: { test: 'node -e "0"', focus: { test: 'node -e "0" {filter}', map: [{ match: '^Sim/Fees/', filter: 'Cat=Fees' }], auto: [{ root: 'Sim/Core', paths: ['Sim/Core/{name}/'], filter: 'Core.{name}' }] } } }));
    const propPaths = ['Sim/Fees/Fees.cs', 'Sim/Fees/Round.cs', 'Sim/Core/Bank/Bank.cs', 'Sim/Rules/A.cs', 'Game/Net/Sync.cs', 'Game/Net/Client.cs', 'Game/Net/Pack.cs', 'Docs2/x.md', 'Game/Ui/Hud.cs'];
    const prop = node(['harness/engine.mjs', 'play-plan', '--propose', '--paths', propPaths.join(',')]);
    const propJson = node(['harness/engine.mjs', 'play-plan', '--propose', '--json', '--paths', propPaths.join(',')]);
    let groups = []; try { groups = JSON.parse(String(propJson.stdout).trim().split('\n').pop()); } catch { /* checked below */ }
    const grp = (f) => groups.find((x) => x.folder === f) || {};
    await guard('2.96 (d13) play-plan --propose groups the unmapped paths by folder with counts and proposes skip (rules map, rules auto folder, play.focus.skip) or a map entry with the filter left to fill in; a mapped folder is not listed (fails before this fix: the command had no --propose)', () => [
      prop.status === 0 && groups.length === 5 && grp('Sim/Fees/').kind === 'skip' && grp('Sim/Fees/').count === 2 && grp('Sim/Core/Bank/').kind === 'skip' && grp('Sim/Rules/').kind === 'skip'
        && grp('Game/Net/').kind === 'map' && grp('Game/Net/').count === 3 && grp('Game/Net/').entry?.match === '^Game/Net/' && grp('Game/Net/').entry?.filter === '<the Play Mode tests for this folder>' && grp('Docs2/').kind === 'map' && !groups.some((x) => x.folder === 'Game/Ui/')
        && /Game\/Net\/ \(3 paths; /.test(out(prop)) && /add to engines\.unity\.play\.focus\.map: \{"match":"\^Game\/Net\/","filter":"<the Play Mode tests for this folder>"\}/.test(out(prop)) && /add to engines\.unity\.play\.focus\.skip: "\^Sim\/Fees\/"/.test(out(prop)), JSON.stringify({ out: out(prop).slice(0, 1500), groups })]);
    const propRec = node(['harness/engine.mjs', 'play-plan', '--propose']);
    await guard('2.96 (d14) without --paths or --branch --propose reads the paths the trains kept (the 6 from the run above)', () => [propRec.status === 0 && /Play Mode map gaps for unity \(the Play Mode stages of the last 7 days\): 6 path\(s\) in 2 folder\(s\)\./.test(out(propRec)) && /Game\/Net\/ \(4 paths/.test(out(propRec)), out(propRec).slice(0, 800)]);

    // ---- (4) a busy line: the refill looks at what can start ----
    const tasks5 = Array.from({ length: 5 }, (_, i) => ({ id: `T-97${i}`, title: `Port item ${i}`, role: 'builder' }));
    const refill = (canStart, extra = '') => probe(`import { refillPass } from ${u('harness/producer-refill.mjs')};
const wakes = []; const added = [];
const deps = { queue: { inProgress: [], backlog: ${JSON.stringify(tasks5)}, done: [] }, canStart: ${canStart}, events: [], add: (x) => { added.push(x.title); return { id: 'T-new' }; }, wake: async (why) => { wakes.push(why); return { started: true }; } };
const r1 = await refillPass({ min: 4, deps });
${extra}
console.log(JSON.stringify({ wakes, added, why: r1.why, stuck: Boolean(r1.stuck) }));`, { STUDIO_REFILL_WAKE: '' });
    const none = refill('async () => false', "const r2 = await refillPass({ min: 4, deps: { ...deps, events: undefined } });");
    await guard('2.96 (d15) with 5 open builder tasks and none that can start, the refill wakes the Producer with "nothing can start: 5 open tasks wait for the engine train or for another task. Propose the next ready work from the plan." and adds no task; a second pass in the same hour does not wake again (fails before this fix: 5 open tasks counted as enough and nobody was asked)', () => [
      none.wakes?.length === 1 && none.wakes[0] === 'nothing can start: 5 open tasks wait for the engine train or for another task. Propose the next ready work from the plan.' && none.added?.length === 0 && none.stuck === true, JSON.stringify(none)]);
    const can = refill('async () => true');
    await guard('2.96 (d16) when the open tasks can start the refill does nothing, as before', () => [can.wakes?.length === 0 && can.added?.length === 0 && /5 builder tasks open \(min 4\)/.test(can.why || '') && can.stuck === false, JSON.stringify(can)]);
    const some = refill('async (t) => t.id === "T-970"');
    await guard('2.96 (d17) when only 1 of 5 open tasks can start the Producer is asked with the count and the cause', () => [some.wakes?.length === 1 && some.wakes[0].startsWith('only 1 of 5 open tasks can start: the other 4 wait for the engine train or for another task.'), JSON.stringify(some)]);

    // the real check: a task queued for the engine train, one that waits for another task, one parked, one free
    fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true });
    fs.writeFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), JSON.stringify([{ task: 'T-971', agent: 'porter-0', branch: 'feat/gap', head: gapHead, at: new Date().toISOString() }]));
    write(S, 'studio/task-holds.json', JSON.stringify({ tasks: { 'T-972': { after: ['T-970'] }, 'T-973': { parked: { by: 'producer', why: 'later' } } } }));
    const real = probe(`import { stuckCounts } from ${u('harness/producer-refill.mjs')};
const q = { inProgress: [], backlog: ${JSON.stringify(tasks5.slice(0, 4))}, done: [] };
console.log(JSON.stringify(await stuckCounts({ queue: q })));`);
    await guard('2.96 (d18) a task queued for an engine train, a task waiting for another task and a parked task are not counted as able to start (4 open, 1 can start)', () => [real.open === 4 && real.startable === 1, JSON.stringify(real)]);
    fs.rmSync(path.join(S, 'studio', 'task-holds.json'), { force: true });
    fs.rmSync(path.join(S, '.studio', 'train'), { recursive: true, force: true });

    // the alert says the same cause
    const linePath = path.join(S, '.studio', 'line');
    fs.mkdirSync(linePath, { recursive: true });
    const alertP = (stuck) => probe(`import fs from 'node:fs'; import { commFacts, alertsNow } from ${u('harness/communicator.mjs')};
const now = Date.now();
fs.writeFileSync('.studio/line/status.json', JSON.stringify({ at: new Date(now).toISOString(), builders: { running: 0, target: 5 } }));
const f = await commFacts({ root: process.cwd(), now, state: {}, deps: { events: [], needs: [], beta: { on: false }, machine: null, delegated: false, inProgress: [], engines: [], stuck: ${JSON.stringify(stuck)} } });
const a = alertsNow(f, { state: { lowSince: new Date(now - 20 * 60000).toISOString() } });
console.log(JSON.stringify({ text: a.find((x) => x.key === 'builders-low')?.text || null }));`);
    const al1 = alertP({ open: 5, startable: 0 });
    const al2 = alertP({ open: 5, startable: 3 });
    await guard('2.96 (d19) the builders-low alert says "nothing can start" and that it is not a fault when no open task can start, and keeps its old words when some can', () => [
      /^0 of 5 builders busy for 20 min: nothing can start\. 5 open tasks wait for the engine train or for another task, so this is not a fault\./.test(al1.text || '') && /^Only 0 of 5 builders busy/.test(al2.text || '') && !/nothing can start/.test(al2.text || ''), JSON.stringify({ al1, al2 })]);
    // ---- (A) end ----
  } finally {
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
  }
}
