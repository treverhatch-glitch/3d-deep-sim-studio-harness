/**
 * qa/selftest-291a.mjs — 2.91: a full run never goes ahead of a waiting batch, and a rules pass survives a target move the
 * rules tests cannot see. The daily full land run and the full rules run (rules.focus.fullEveryHours) run on the target
 * alone: when the queue is empty, or, overdue, at the end of a train after the batch's rounds. A red owed full rules run
 * blames no lane and is not run again while the target is unchanged. rules.paths and rules.ignore let a green stand
 * when the target moved only where the rules tests do not read (a land script's own record commit).
 *
 * The scaffolding (a studio copy, a made-up engine repo, stand-ins for the land script and the rules check that record
 * what they were told) is qa/selftest-290b.mjs's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, eventTypesOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, queueUnityOf, readRunsJsonl as runsOf, writeIn as write } from './kit.mjs';

export async function selftest291A({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s291a-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-291a-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  const LAND24 = { STUDIO_ENGINE_FULL_LAND_HOURS: '24' };

  // ---- a studio copy (its own git, events file, engine settings) ----
  const S = path.join(tmpRoot, `291a-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-291a.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventTypesOf(eventsFileOf(evFile));
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-291a-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'comm', 'gates', 'tmp', 'locks', 'line']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true }); fs.writeFileSync(evFile, ''); };

  // ---- a made-up engine repo: two systems, the pin file and the vectors recorded at it, a docs folder ----
  let rn = 0;
  const engineRepo = (lanes, { pinBad = false } = {}) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    for (const [f, t] of Object.entries({ 'Sim/Move.cs': 'class Move { }\n', 'Sim/Fees.cs': 'class Fees { }\n', 'pins/web.json': '{ "commit": "c0ffee1" }\n', 'vectors/pin.txt': pinBad ? 'beef000\n' : 'c0ffee1\n', 'docs/readme.md': 'docs\n', 'notes.txt': 'n\n' })) write(R, f, t);
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
  const tipOf = (E) => g(E.R, 'rev-parse', 'port/main').stdout.trim();
  // A commit on the target in the gate worktree (a land script's own record, or a real change).
  const commitOnTarget = (E, files, msg) => { for (const [f, t] of Object.entries(files)) write(E.GW, f, t); g(E.GW, 'add', '-A'); g(E.GW, 'commit', '-qm', msg); };

  // The land script's stand-in: merges the branches into the gate worktree; STUDIO_LAND_PROBE=1 lands nothing. With
  // <ctl>-record it commits its own record of a landing under docs/runs/, as a real land script may.
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const E = process.env;
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
const start = Date.now();
process.on('exit', () => fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, probe: E.STUDIO_LAND_PROBE ?? null, landFull: E.STUDIO_LAND_FULL ?? null, rulesGreen: E.STUDIO_RULES_GREEN ?? null, before, start, end: Date.now() }) + '\\n'));
if (E.STUDIO_LAND_PROBE === '1') console.log('[land-probe] honoured');
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); console.log('conflict ' + s); process.exit(2); } }
if (E.STUDIO_LAND_PROBE === '1') { git(gw, 'reset', '-q', '--hard', before); process.exit(0); }
if (fs.existsSync(ctl + '-record')) { fs.mkdirSync(path.join(gw, 'docs', 'runs'), { recursive: true }); fs.writeFileSync(path.join(gw, 'docs', 'runs', start + '.md'), 'landed ' + srcs.join(' ') + '\\n'); git(gw, 'add', '-A'); git(gw, 'commit', '-qm', 'land record'); }
console.log('landed ' + srcs.join(' '));
`);
  // The rules check's stand-in (dotnet test): "--filter X" runs the tests whose name holds X. With <ctl>-move.json it commits
  // those files on the target once while it runs (the target moving between the check and the land run).
  const rulesStub = path.join(T, 'rules-stub.mjs');
  fs.writeFileSync(rulesStub, `import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [ctl, ...args] = process.argv.slice(2);
const fi = args.indexOf('--filter'); const filter = fi >= 0 ? args[fi + 1] : '';
const cwd = process.cwd();
const rd = (f) => fs.readFileSync(path.join(cwd, f), 'utf8');
fs.appendFileSync(ctl + '-rules.jsonl', JSON.stringify({ filter, mode: process.env.STUDIO_RULES_MODE || null, commit: process.env.STUDIO_RULES_COMMIT || null }) + '\\n');
if (fs.existsSync(ctl + '-move.json')) {
  const mv = JSON.parse(fs.readFileSync(ctl + '-move.json', 'utf8')); fs.rmSync(ctl + '-move.json');
  for (const [f, t] of Object.entries(mv.files)) { fs.mkdirSync(path.dirname(path.join(mv.gw, f)), { recursive: true }); fs.writeFileSync(path.join(mv.gw, f), t); }
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: mv.gw, encoding: 'utf8' });
  git('add', '-A'); git('commit', '-qm', 'a record of the last run');
}
const tests = [['Game.Rules.Tests.PinTests.VectorsMatchPin', rd('pins/web.json').includes(rd('vectors/pin.txt').trim())], ['Game.Rules.Tests.MoveTests.Walks', true]].filter(([n]) => !filter || n.includes(filter));
const bad = tests.filter(([, ok]) => !ok);
for (const [n, ok] of tests) console.log('  ' + (ok ? 'Passed' : 'Failed') + ' ' + n + ' [3 ms]');
if (bad.length) { console.log('Failed!  - Failed: ' + bad.length + ', Passed: ' + (tests.length - bad.length)); process.exit(1); }
console.log('Passed!  - Failed: 0, Passed: ' + tests.length);
`);
  const cfgFor = (E, ctl, extra = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, rules: false, ...extra });
  const fullRules = (ctl, extra = {}) => ({ test: `node "${fwd(rulesStub)}" "${fwd(ctl)}"`, ...extra });
  const focusRules = (ctl, extra = {}) => ({ test: `node "${fwd(rulesStub)}" "${fwd(ctl)}"`, focus: { test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" --filter "{filter}"`, map: [{ match: '^Sim/([A-Za-z]+)\\.cs$', filter: '$1Tests' }], fullEveryHours: 24 }, ...extra });
  const rulesRuns = (ctl) => { try { return fs.readFileSync(`${ctl}-rules.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const queue = queueUnityOf(S);
  const engineDir = path.join(S, '.studio', 'engine');
  const cacheOf = () => { try { return JSON.parse(fs.readFileSync(path.join(engineDir, 'unity-rules.json'), 'utf8')); } catch { return {}; } };
  const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const lastFull = (h) => { fs.mkdirSync(engineDir, { recursive: true }); fs.writeFileSync(path.join(engineDir, 'unity-rules.json'), JSON.stringify({ trees: {}, runs: [], lastFullAt: hoursAgo(h) })); };
  const landAge = (h) => { fs.mkdirSync(engineDir, { recursive: true }); fs.writeFileSync(path.join(engineDir, 'unity-full-land.json'), JSON.stringify({ at: hoursAgo(h), id: 'old' })); };
  const landRec = () => { try { return JSON.parse(fs.readFileSync(path.join(engineDir, 'unity-full-land.json'), 'utf8')); } catch { return null; } };
  const TRAIN = `import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const handed = []; const logs = [];
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps: { handBack: (lane, note, extra) => handed.push({ task: lane.task, note, extra: extra || null }) } });
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, message: r.message, landed: r.landed, dropped: r.dropped, handed, full: r.full || null, fullRules: r.fullRules || null, rules: r.rules || null, logs: logs.filter((l) => /full|rules|green/.test(l)) }));`;
  const LP = `import { enginePass } from ${u('harness/line-producer.mjs')};
import { rulesIdleLine } from ${u('harness/unity-train.mjs')};
const rows = await enginePass({ dryRun: true, deps: { root: process.cwd(), rigBudget: async () => ({ running: [], freeGb: 64 }), machine: { cpu: { busy: 0.05 } }, webTrain: false, sessions: async () => [] } });
console.log(JSON.stringify({ row: rows.find((x) => x.engine === 'unity') || null, idle: rulesIdleLine(process.cwd(), 'unity') }));`;
  const J = (x) => JSON.stringify(x).slice(0, 2800);

  // ================= 1a. the daily full land run never goes ahead of a waiting batch =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } });
    const ctl = path.join(T, 'ctl-land-overdue');
    setEngines({ unity: cfgFor(E, ctl, { rules: fullRules(ctl) }) });
    landAge(60);
    queue(E, [['T-001', 'feat/a']]);
    const r = probe(TRAIN, LAND24);
    const runs = runsOf(ctl);
    const fe = evs(/^task\.train\.unity\.full_land$/);
    await guard('2.91 full land run overdue (60 h, past 2 x 24) with a lane waiting: the lane\'s land run goes first and is told STUDIO_RULES_GREEN=1; the full run comes after it, on the target alone (STUDIO_LAND_FULL=1, STUDIO_LAND_PROBE=1) at the target as the landing left it; the log and a full_land event say it waits for the end of the train, a second full_land event says it runs now at the end (fails before this fix: the overdue full run went first, a 3 h run ahead of the batch, and its record commit cost the batch its green)', () => [
      runs.length === 2 && runs[0].srcs.join() === 'feat/a' && runs[0].landFull === null && runs[0].rulesGreen === '1' && runs[1].landFull === '1' && runs[1].probe === '1' && runs[1].start >= runs[0].end
        && runs[1].before === tipOf(E) && runs[1].before !== runs[0].before && r.landed?.join() === 'T-001' && r.full?.when === 'end' && landRec()?.id !== 'old'
        && fe.length === 2 && fe[0].meta?.waits === 'end' && fe[1].meta?.when === 'end' && r.logs?.some((l) => /it runs at the end of this train, after the batch's rounds/.test(l)),
      J({ r, runs, fe: fe.map((e) => e.meta) })]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } });
    const ctl = path.join(T, 'ctl-land-due');
    setEngines({ unity: cfgFor(E, ctl) });
    landAge(30);
    queue(E, [['T-002', 'feat/a']]);
    const r = probe(TRAIN, LAND24);
    const runs = runsOf(ctl);
    const fe = evs(/^task\.train\.unity\.full_land$/);
    await guard('2.91 full land run due but not overdue (30 h) with a lane waiting: one land run (the lane\'s), no full run in this train, the clock untouched; the full_land event says it waits for an empty queue (fails before this fix: nothing said why the due full run did not run)', () => [
      runs.length === 1 && runs[0].landFull === null && r.landed?.join() === 'T-002' && !r.full && landRec()?.id === 'old' && fe.length === 1 && fe[0].meta?.waits === 'empty-queue',
      J({ r, runs, fe: fe.map((e) => e.meta) })]);
    const r2 = probe(TRAIN, LAND24);
    const runs2 = runsOf(ctl);
    await guard('2.91 full land run due, then the queue is empty: the next train runs it on the target alone at once and says it runs now because no lane waits (fails before this fix: the event did not say when or why it runs now)', () => [
      runs2.length === 2 && runs2[1].landFull === '1' && runs2[1].probe === '1' && r2.full?.when === 'idle' && r2.full?.status === 'pass' && landRec()?.id !== 'old'
        && evs(/^task\.train\.unity\.full_land$/).some((e) => e.meta?.when === 'idle' && /no lane waits/.test(e.msg)),
      J({ r2, runs2 })]);
  }

  // ================= 1b. the full rules run is owed, not made the batch's check =================
  {
    resetState();
    const E = engineRepo({ 'feat/m': { 'Sim/Move.cs': 'class Move { int x; }\n' } });
    const ctl = path.join(T, 'ctl-rules-due');
    setEngines({ unity: cfgFor(E, ctl, { rules: focusRules(ctl) }) });
    lastFull(30);
    const at0 = cacheOf().lastFullAt;
    queue(E, [['T-011', 'feat/m']]);
    const r = probe(TRAIN);
    const rr = rulesRuns(ctl);
    const re = evs(/^task\.train\.unity\.rules_full$/);
    await guard('2.91 full rules run due (30 h, fullEveryHours 24) with a lane waiting: the train\'s rules check is the focus run the batch maps to (MoveTests, on the batch only: 2.93 runs nothing on the target when the batch is green), never the full suite; lastFullAt unchanged; the lane lands told green; a rules_full event says the full run waits for an empty queue (fails before this fix: the check became the full suite on the target and again on the batch head)', () => [
      rr.length === 1 && rr.every((x) => x.mode === 'focus' && x.filter === 'MoveTests') && cacheOf().lastFullAt === at0 && r.landed?.join() === 'T-011' && runsOf(ctl)[0]?.rulesGreen === '1'
        && re.length === 1 && re[0].meta?.waits === 'empty-queue' && !r.fullRules,
      J({ r, rr, re: re.map((e) => e.meta) })]);
    const lp1 = probe(LP);
    const r2 = probe(TRAIN);
    const rr2 = rulesRuns(ctl);
    const lp2 = probe(LP);
    await guard('2.91 the owed full rules run at idle: with the queue empty the Line Producer would start a train with no lane for it; that train runs the full command on the target alone, passes, writes lastFullAt; then nothing is owed and the Line Producer starts nothing (fails before this fix: an owed full rules run never ran outside a batch)', () => [
      lp1.row?.start === true && lp1.row?.queued === 0 && rr2.length === 2 && rr2[1].mode === 'full' && rr2[1].filter === '' && rr2[1].commit === tipOf(E)
        && r2.fullRules?.status === 'pass' && r2.fullRules?.when === 'idle' && Date.now() - Date.parse(cacheOf().lastFullAt) < 600000 && lp2.row?.start === false,
      J({ lp1: lp1.row, r2, rr2, lp2: lp2.row })]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/m': { 'Sim/Move.cs': 'class Move { int x; }\n' } });
    const ctl = path.join(T, 'ctl-rules-overdue');
    setEngines({ unity: cfgFor(E, ctl, { rules: focusRules(ctl) }) });
    lastFull(60);
    const tip0 = tipOf(E);
    queue(E, [['T-012', 'feat/m']]);
    const r = probe(TRAIN);
    const rr = rulesRuns(ctl);
    await guard('2.91 full rules run overdue (60 h, past rules.focus.fullEveryMaxHours = 2 x 24): the batch\'s check is focus, the lane lands told green, and after it the full command runs once on the target as the landing left it; lastFullAt written (fails before this fix: the full suite ran twice ahead of the batch)', () => [
      rr.length === 2 && rr[0].mode === 'focus' && rr[1].mode === 'full' && rr[1].commit === tipOf(E) && tipOf(E) !== tip0
        && r.landed?.join() === 'T-012' && runsOf(ctl)[0]?.rulesGreen === '1' && r.fullRules?.when === 'end' && r.fullRules?.status === 'pass' && Date.now() - Date.parse(cacheOf().lastFullAt) < 600000,
      J({ r, rr })]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/m': { 'Sim/Move.cs': 'class Move { int x; }\n' } }, { pinBad: true });
    const ctl = path.join(T, 'ctl-rules-red');
    setEngines({ unity: cfgFor(E, ctl, { rules: focusRules(ctl) }) });
    lastFull(60);
    queue(E, [['T-013', 'feat/m']]);
    const r = probe(TRAIN);
    const n1 = rulesRuns(ctl).length;
    const re = evs(/^task\.train\.unity\.rules_full$/).filter((e) => e.meta?.status);
    const lp1 = probe(LP);
    const r2 = probe(TRAIN);
    const n2 = rulesRuns(ctl).length;
    await guard('2.91 a red owed full rules run (the target fails PinTests, the focus run does not see it): the lane lands and nobody is handed back; the red is kept for the target (fullRed), a warn rules_full event goes to the producer, train status and the Line Producer read the line; with the queue empty the Line Producer starts nothing and a train started by hand runs no rules test while the target is unchanged (fails before this fix: the full check on the target judged no lane every train)', () => [
      r.landed?.join() === 'T-013' && !r.dropped?.length && !r.handed?.length && r.fullRules?.status === 'red' && cacheOf().fullRed?.tip === tipOf(E) && !cacheOf().noJudge
        && re.length === 1 && re[0].status === 'warn' && re[0].to === 'producer' && /no lane is blamed/.test(re[0].msg) && /full rules run on the target alone is red/.test(lp1.idle || '')
        && lp1.row?.start === false && n2 === n1 && !r2.fullRules && /No unity branch/i.test(r2.message || ''),
      J({ r, r2, n1, n2, re: re.map((e) => [e.status, e.msg]), lp1 })]);
    commitOnTarget(E, { 'docs/readme.md': 'docs changed\n' }, 'docs');
    const lp2 = probe(LP);
    commitOnTarget(E, { 'vectors/pin.txt': 'c0ffee1\n' }, 'the vectors re-recorded');
    const lp3 = probe(LP);
    const r3 = probe(TRAIN);
    await guard('2.91 the red owed full rules run waits for the target to change: a commit the full key sees (no rules.paths: any) makes it owed again; the fix lands and the idle train passes it and clears the red line', () => [
      lp2.row?.start === true && lp3.row?.start === true && r3.fullRules?.status === 'pass' && !cacheOf().fullRed && !probe(LP).idle,
      J({ lp2: lp2.row, lp3: lp3.row, r3 })]);
  }

  // ================= 2. a rules pass survives a target move the rules tests cannot see =================
  const moved = async (name, rules, files, want, why) => {
    resetState();
    const E = engineRepo({ 'feat/m': { 'Sim/Move.cs': 'class Move { int x; }\n' } });
    const ctl = path.join(T, `ctl-moved-${name}`);
    setEngines({ unity: cfgFor(E, ctl, { rules: fullRules(ctl, rules) }) });
    fs.writeFileSync(`${ctl}-move.json`, JSON.stringify({ gw: fwd(E.GW), files }));
    const tip0 = tipOf(E);
    queue(E, [['T-021', 'feat/m']]);
    const r = probe(TRAIN);
    const runs = runsOf(ctl);
    const said = r.logs?.filter((l) => /the rules green stands/.test(l)) || [];
    await guard(why, () => [
      runs.length === 1 && runs[0].before !== tip0 && r.rules?.ran === true && r.landed?.join() === 'T-021' && runs[0].rulesGreen === (want ? '1' : null)
        && said.length === (want ? 1 : 0) && (!want || (said[0].includes(tip0.slice(0, 8)) && said[0].includes(runs[0].before.slice(0, 8)))),
      J({ r, runs, tip0 })]);
  };
  await moved('paths', { paths: ['Sim', 'pins', 'vectors'] }, { 'docs/runs/1.md': 'run\n' }, true, '2.91 rules.paths set, the target moved between the check and the land run by a record commit under docs/ only: the land run is still told STUDIO_RULES_GREEN=1 and one log line names both tips (fails before this fix: any target move lost the green and the land script ran its own copy of the rules tests)');
  await moved('none', {}, { 'docs/runs/1.md': 'run\n' }, false, '2.91 without rules.paths or rules.ignore the same record-only move loses the green, as before (the check cannot know what its tests read)');
  await moved('ignore', { ignore: ['docs/runs'] }, { 'docs/runs/1.md': 'run\n' }, true, '2.91 rules.ignore ["docs/runs"], the target moved only under docs/runs: STUDIO_RULES_GREEN=1 stands, one log line (fails before this fix: no rules.ignore, the green was lost)');
  await moved('ignore-out', { ignore: ['docs/runs'] }, { 'docs/runs/1.md': 'run\n', 'notes.txt': 'n2\n' }, false, '2.91 rules.ignore ["docs/runs"], a move that also changes notes.txt (outside it): no STUDIO_RULES_GREEN, no log line (as before this fix: the contrast)');

  // After a landing whose only extra commit is the land script's record, the next train reuses the kept result for the target.
  // 2.93: the target is asked only for a red batch, so the second lane breaks the pin (PinTests red).
  const kept = async (name, rules, extra, want, why) => {
    resetState();
    const E = engineRepo({ 'feat/m': { 'Sim/Move.cs': 'class Move { int x; }\n' }, 'feat/f': { 'Sim/Fees.cs': 'class Fees { int y; }\n', 'vectors/pin.txt': 'beef000\n' } });
    const ctl = path.join(T, `ctl-kept-${name}`);
    setEngines({ unity: cfgFor(E, ctl, { rules: fullRules(ctl, rules) }) });
    fs.writeFileSync(`${ctl}-record`, '1');
    queue(E, [['T-031', 'feat/m']]);
    const r1 = probe(TRAIN);
    if (extra) commitOnTarget(E, extra, 'another change');
    const t1 = tipOf(E);
    const n1 = rulesRuns(ctl).length;
    queue(E, [['T-032', 'feat/f']]);
    const r2 = probe(TRAIN);
    const rr = rulesRuns(ctl).slice(n1);
    await guard(why, () => [
      r1.landed?.join() === 'T-031' && r2.dropped?.map((d) => d.task).join() === 'T-032' && (want ? rr.length === 1 && rr.every((x) => x.commit !== t1) && r2.logs?.some((l) => l.includes(`cached for ${t1.slice(0, 10)}`)) : rr.length === 2 && rr[1].commit === t1),
      J({ r1: r1.landed, r2, rr, t1 })]);
  };
  await kept('paths', { paths: ['Sim', 'pins', 'vectors'] }, null, true, '2.91 kept result with rules.paths: the land script committed its own record under docs/runs after the landing; the next train, red on its batch, reuses the kept pass for the target (the rules command runs only on the new batch) (passes before this fix too: it proves the rules.paths key already did so)');
  await kept('ignore', { ignore: ['docs/runs'] }, null, true, '2.91 kept result with rules.ignore ["docs/runs"]: the record-only commit keeps the kept pass of the target: the next red batch asks it and runs nothing on the target (fails before this fix: no rules.ignore, the target ran again)');
  await kept('ignore-out', { ignore: ['docs/runs'] }, { 'notes.txt': 'n3\n' }, false, '2.91 kept result with rules.ignore: a further commit outside docs/runs (notes.txt) makes the target a new tree for the check: the red batch runs it on the target (as before this fix: the contrast)');
  {
    resetState();
    const E = engineRepo({});
    setEngines({ unity: cfgFor(E, path.join(T, 'ctl-cfg'), { rules: focusRules(path.join(T, 'ctl-cfg'), { ignore: ['docs/runs', 'docs/*.md', '../x', '/abs'] }) }) });
    const r = probe(`import { rulesConfig } from ${u('harness/engine-rules.mjs')};
const c = rulesConfig('unity', { root: process.cwd() });
console.log(JSON.stringify({ ignore: c.ignore, bad: c.focusBad || [], max: c.focus?.fullEveryMaxHours ?? null }));`);
    await guard('2.91 rules.ignore takes plain repo paths only: a glob, a path with .. and an absolute path are left out and named; rules.focus.fullEveryMaxHours defaults to 2 x fullEveryHours', () => [
      r.ignore?.join() === 'docs/runs' && r.bad?.filter((b) => /rules\.ignore/.test(b)).length === 3 && r.max === 48, J(r)]);
  }
}
