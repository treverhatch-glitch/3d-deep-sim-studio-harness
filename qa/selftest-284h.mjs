/**
 * qa/selftest-284h.mjs — 2.84 (h): the engine train's batch window, and the Play Mode focus.
 *
 * A crew measured: a land run takes 22 to 40 minutes whatever the batch size, six branches on one run landed at the
 * owner's pace, but most trains started with one branch; and the Play Mode stage became the longest stage of a land.
 * The batch window (harness/line-producer.mjs engineBatchWait, enginePass) lets the automatic start wait a few minutes
 * for a fuller batch while work is still coming; the Play Mode focus (harness/engine-rules.mjs playSelection, the train
 * in harness/unity-train.mjs) tells the land script which Play Mode tests the batch's changes need. The scaffolding (a
 * studio copy, a made-up engine repo, a stand-in land script) is qa/selftest-283b.mjs's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest284H({ dir, root, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const T = path.join(tmpRoot, `s284h-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const harnessRoot = root || dir;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-284h-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file, engine settings) ----
  const S = path.join(tmpRoot, `284h-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(S, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* the checks below need no package */ }
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setGame = (game) => write(S, 'studio/game.json', `${JSON.stringify(game, null, 2)}\n`);
  const setEngines = (engines) => setGame({ engines });
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-284h.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-284h-${++pn}.mjs`);
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
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, rulesGreen: process.env.STUDIO_RULES_GREEN || '', rulesMode: process.env.STUDIO_RULES_MODE || '', full: process.env.STUDIO_LAND_FULL || '', editArgs: process.env.STUDIO_UNITY_EDITMODE_ARGS || '', lock, playMode: process.env.STUDIO_PLAY_MODE ?? null, playFilter: process.env.STUDIO_PLAY_FILTER ?? null, playArgs: process.env.STUDIO_UNITY_PLAYMODE_ARGS ?? null }) + '\\n');
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
const stages = (bad) => { if (process.env.STUDIO_LAND_RESULT) fs.writeFileSync(process.env.STUDIO_LAND_RESULT, JSON.stringify({ gates: Object.fromEntries(['merge', 'rules', 'edit', 'play', 'build'].map((n, i, all) => [n, bad && all.indexOf(bad) < i ? null : { status: n === bad ? 'fail' : 'pass', seconds: 10 }]).filter(([, v]) => v)) })); };
const red = (stage, test) => { git(gw, 'reset', '-q', '--hard', before); stages(stage); console.log('  Failed ' + test + ' [3 ms]'); console.log('1 test failed'); process.exit(1); };
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); console.log('conflict ' + s); process.exit(2); } }
let fl = null; try { fl = fs.readFileSync(ctl + '-flaky', 'utf8').trim().split(' '); } catch {}
if (fl && Number(fl[0]) > 0) { fs.writeFileSync(ctl + '-flaky', [Number(fl[0]) - 1, fl[1], fl[2]].join(' ')); red(fl[1], fl[2]); }
if (fs.existsSync(path.join(gw, 'compile-bad.txt'))) { const line = fs.readFileSync(path.join(gw, 'compile-bad.txt'), 'utf8').trim(); git(gw, 'reset', '-q', '--hard', before); stages('edit'); console.log(line); console.log('[engine-gate] FAIL compile-error'); process.exit(1); }
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
const handed = []; const logs = [];
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps: { handBack: (lane, note, extra) => handed.push({ task: lane.task, note, extra: extra || null }) } });
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, landed: r.landed, dropped: r.dropped, flaky: r.flaky || null, fullLand: r.fullLand || 0, playMode: r.playMode ?? null, playFilter: r.playFilter ?? null, handed, logs: logs.filter((l) => /play focus/.test(l)), queue: readUnityQueue(process.cwd()).map((e) => e.task) }));`;
  const noFull = { STUDIO_ENGINE_FULL_LAND_HOURS: 'off' };
  const evs = (re) => events().filter((e) => re.test(e.type));

  const landEvents = () => evs(/^engine\.land$/).map((e) => ({ playMode: e.meta?.playMode ?? null, playFilter: e.meta?.playFilter ?? null }));
  const PLAY = { focus: { map: [{ match: '^Assets/Scripts/([A-Za-z]+)/', filter: 'Game.PlayTests.$1' }], smoke: 'Game.PlayTests.Smoke', join: ';' } };
  const mapped = { 'feat/a': { 'Assets/Scripts/Economy/Fees.cs': 'class Fees {}\n' }, 'feat/b': { 'Assets/Scripts/Hangar/Doors.cs': 'class Doors {}\n', 'Assets/Scripts/Economy/Loans.cs': 'class Loans {}\n' } };
  const want = 'Game.PlayTests.Economy;Game.PlayTests.Hangar;Game.PlayTests.Smoke';

  // ================= 1. the batch window: the pure decision =================
  {
    const now = Date.parse('2026-11-12T10:00:00Z');
    const ago = (m) => new Date(now - m * 60000).toISOString();
    const r = probe(`import { engineBatchWait, engineBatchRules } from ${u('harness/line-producer.mjs')};
const now = ${now}; const ago = (m) => new Date(now - m * 60000).toISOString();
const W = (queue, rules, working) => engineBatchWait({ engine: 'unity', label: 'Unity', queue, rules, working, now });
const two = [{ task: 'T-1', at: ago(5) }, { task: 'T-2', at: ago(2) }];
console.log(JSON.stringify({
  defaults: engineBatchRules({}, {}), fromCfg: engineBatchRules({ batchMin: 4, batchWaitMin: 12 }, {}), fromEnv: engineBatchRules({ batchMin: 4, batchWaitMin: 12 }, { STUDIO_ENGINE_BATCH_MIN: '2', STUDIO_ENGINE_BATCH_WAIT_MIN: '0' }),
  dflt: W(two, { min: 1, waitMin: 0 }, ['T-9']),
  waits: W(two, { min: 4, waitMin: 12 }, ['T-8', 'T-9']),
  full: W([...two, { task: 'T-3', at: ago(1) }, { task: 'T-4', at: ago(0) }], { min: 4, waitMin: 12 }, ['T-9']),
  timeUp: W([{ task: 'T-1', at: ago(13) }, { task: 'T-2', at: ago(2) }], { min: 4, waitMin: 12 }, ['T-9']),
  nobody: W(two, { min: 4, waitMin: 12 }, []),
  aloneHead: W([{ task: 'T-1', at: ago(1), alone: true }, { task: 'T-2', at: ago(1) }], { min: 4, waitMin: 12 }, ['T-9']),
  aloneBehind: W([{ task: 'T-1', at: ago(1) }, { task: 'T-2', at: ago(1), alone: true }, { task: 'T-3', at: ago(1) }], { min: 3, waitMin: 12 }, ['T-9']),
}));`);
    await guard('2.84 batch window, the decision: with the defaults (batchMin 1, batchWaitMin 0) it never waits; with batchMin 4 and batchWaitMin 12 it waits while 2 of 4 are queued, the oldest 5 min, and sessions still work, and says so in plain words ("waiting up to 12 min for more Unity branches: 2 of 4 queued, the oldest for 5 min, 2 sessions still working on Unity tasks"); it stops waiting at 4 queued, after 12 min, or when no session works on the engine; an alone branch at the head never waits, one behind others does not count toward batchMin; the env overrides the config (fails before this fix: no batch window, every train started with whatever one branch was queued)', () => [
      r.defaults?.min === 1 && r.defaults.waitMin === 0 && r.fromCfg?.min === 4 && r.fromCfg.waitMin === 12 && r.fromEnv?.min === 2 && r.fromEnv.waitMin === 0
        && r.dflt?.wait === false && r.waits?.wait === true && /^waiting up to 12 min for more Unity branches: 2 of 4 queued, the oldest for 5 min, 2 sessions still working on Unity tasks/.test(r.waits.why)
        && r.full?.wait === false && r.timeUp?.wait === false && r.nobody?.wait === false && /nothing more is coming/.test(r.nobody.why)
        && r.aloneHead?.wait === false && /lands alone/.test(r.aloneHead.why) && r.aloneBehind?.wait === true && r.aloneBehind.counted === 2,
      JSON.stringify(r).slice(0, 3000)]);
    void ago;
  }

  // ================= 2. the batch window through enginePass =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } });
    const ctl = path.join(T, 'ctl-batch');
    const base = Date.now();
    const PASS = (cfgExtra, queueSpec, working) => `import fs from 'node:fs'; import path from 'node:path';
const lp = await import(${u('harness/line-producer.mjs')});
const now = Date.now();
fs.writeFileSync(path.join(process.cwd(), 'studio', 'game.json'), JSON.stringify({ engines: { unity: ${JSON.stringify(cfgFor(E, ctl))} } }).replace('"rules":false', '"rules":false' + ${JSON.stringify(cfgExtra)}));
fs.mkdirSync(path.join(process.cwd(), '.studio', 'train'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), '.studio', 'train', 'unity-queue.json'), JSON.stringify(${JSON.stringify(queueSpec)}.map(([task, mins, alone]) => ({ task, agent: 'p', branch: 'feat/a', head: 'x', at: new Date(${base} - mins * 60000).toISOString(), ...(alone ? { alone: true } : {}) }))));
fs.rmSync(path.join(process.cwd(), '.studio', 'line', 'engine-trains.json'), { force: true });
const started = [];
const rows = await lp.enginePass({ now, deps: { root: process.cwd(), rigBudget: async () => ({ running: [], freeGb: 64 }), machine: { cpu: { busy: 0.05 } }, webTrain: false, startTrain: async (e) => { started.push(e); return { pid: 1 }; },
  sessions: async () => ${JSON.stringify(working)}.map((task, i) => ({ agent: 'b' + i, role: 'builder', task, running: true })), engineTask: (t) => (/^T-(9\\d|1)$/.test(t) ? { task: t, engine: 'unity', track: 'engine:unity' } : null) } });
console.log(JSON.stringify({ start: rows[0]?.start, started: started.length, why: rows[0]?.why, batchWait: rows[0]?.batchWait || false }));`;
    const win = ',"batchMin":4,"batchWaitMin":12';
    const dflt = probe(PASS('', [['T-1', 5]], ['T-91', 'T-92']));
    const w1 = probe(PASS(win, [['T-1', 5], ['T-2', 2]], ['T-91', 'T-92', 'T-1', 'T-50']));
    const w2 = probe(PASS(win, [['T-1', 5], ['T-2', 2]], ['T-91', 'T-92']));
    const waitEvents = evs(/^task\.train\.unity\.batch_wait$/);
    const filled = probe(PASS(win, [['T-1', 7], ['T-2', 3], ['T-3', 1], ['T-4', 0]], ['T-91']));
    const timeUp = probe(PASS(win, [['T-1', 13], ['T-2', 3]], ['T-91']));
    const nobody = probe(PASS(win, [['T-1', 5], ['T-2', 2]], ['T-1', 'T-50']));
    const alone = probe(PASS(win, [['T-1', 1, true], ['T-2', 0]], ['T-91']));
    const ev0 = waitEvents[0];
    await guard('2.84 batch window through enginePass: with no batch settings a queued branch starts the train at once; with batchMin 4, batchWaitMin 12 and two sessions on Unity tasks (a session whose task is queued, or on a web task, does not count) two queued branches wait, with ONE task.train.unity.batch_wait event over two passes carrying the numbers; the wait ends when 4 are queued, when the oldest has waited 12 min, and when no session works on a Unity task any more; an alone branch at the head starts at once (fails before this fix: the Line Producer started a train for the first branch queued, every time)', () => [
      dflt.start === true && dflt.started === 1
        && w1.start === false && w1.started === 0 && w1.batchWait === true && /2 of 4 queued/.test(w1.why) && /2 sessions still working/.test(w1.why)
        && w2.start === false && w2.started === 0 && waitEvents.length === 1 && ev0.meta?.counted === 2 && ev0.meta.batchMin === 4 && ev0.meta.batchWaitMin === 12 && ev0.meta.working?.join() === 'T-91,T-92'
        && filled.start === true && filled.started === 1 && timeUp.start === true && timeUp.started === 1 && nobody.start === true && nobody.started === 1 && alone.start === true && alone.started === 1,
      JSON.stringify({ dflt, w1, w2, waitEvents: waitEvents.map((e) => e.meta), filled, timeUp, nobody, alone }).slice(0, 3000)]);
  }

  // ================= 3. the Play Mode selection: the pure decision =================
  {
    const r = probe(`import { playSelection, rulesSelection } from ${u('harness/engine-rules.mjs')};
const cfg = { play: ${JSON.stringify(PLAY)} };
const S = (changed, extra = {}) => playSelection({ changed, cfg, ...extra });
const rc = { command: 'all', paths: [], focus: { test: 'run {filter}', map: [{ match: '^Sim/([A-Za-z]+)/', filter: 'Category=$1' }], smoke: 'Category=Smoke', join: '|' } };
console.log(JSON.stringify({
  all: S(['Assets/Scripts/Economy/Fees.cs', 'Assets/Scripts/Hangar/Doors.cs', 'Assets/Scripts/Economy/Loans.cs']),
  one: S(['Assets/Scripts/Economy/Fees.cs', 'Assets/Art/logo.png']),
  full: S(['Assets/Scripts/Economy/Fees.cs'], { full: true, fullWhy: 'a full land run' }),
  none: playSelection({ changed: ['Assets/Scripts/Economy/Fees.cs'], cfg: {} }),
  unknown: S(null),
  odd: playSelection({ changed: ['Assets/Scripts/Economy/Fees.cs'], cfg: { play: { focus: { map: [{ match: '^Assets/Scripts/([A-Za-z]+)/', filter: 'Game.$1&&echo' }] } } } }),
  quote: playSelection({ changed: ['Assets/Scripts/Economy/Fees.cs'], cfg: { play: { focus: { map: [{ match: '^Assets/Scripts/([A-Za-z]+)/', filter: 'Game."$1"' }] } } } }),
  rules: rulesSelection({ changed: ['Sim/Fees/a.cs', 'Sim/Loans/b.cs'], cfg: rc }),
  rulesOff: rulesSelection({ changed: ['Sim/Fees/a.cs', 'Other/x.cs'], cfg: rc }),
}));`);
    await guard('2.84 play focus, the decision (harness/engine-rules.mjs playSelection, the mapping shared with rulesSelection): every changed path mapped gives focus with the matching filters plus smoke, de-duplicated, joined by ";"; one unmapped path, a full land run, no play.focus or unknown paths give full with no filter; a filter with a character outside [A-Za-z0-9_.;|~=!()* -] is refused (full, refused: true); the rules focus still selects as before (fails before this fix: there was no play selection at all)', () => [
      r.all?.mode === 'focus' && r.all.filter === want && r.one?.mode === 'full' && r.one.filter === '' && /Assets\/Art\/logo\.png/.test(r.one.why)
        && r.full?.mode === 'full' && r.none?.mode === 'full' && r.unknown?.mode === 'full' && r.odd?.mode === 'full' && r.odd.refused === true && r.quote?.mode === 'full' && r.quote.refused === true
        && r.rules?.mode === 'focus' && r.rules.filter === 'Category=Fees|Category=Loans|Category=Smoke' && r.rules.command === 'run Category=Fees|Category=Loans|Category=Smoke' && r.rulesOff?.mode === 'full',
      JSON.stringify(r).slice(0, 3000)]);
  }

  // ================= 4. the Play Mode focus through the engine train =================
  {
    resetState();
    const E = engineRepo(mapped);
    const ctl = path.join(T, 'ctl-play-focus');
    setEngines({ unity: cfgFor(E, ctl, { play: PLAY }) });
    queue(E, [['T-901', 'feat/a'], ['T-902', 'feat/b']]);
    const r = probe(TRAIN, noFull);
    const runs = runsOf(ctl);
    const le = landEvents();
    await guard('2.84 play focus, all paths mapped: a batch of two whose every changed path matches engines.unity.play.focus.map lands on one run whose land command gets STUDIO_PLAY_MODE=focus, STUDIO_PLAY_FILTER with the joined filter, and STUDIO_UNITY_PLAYMODE_ARGS=-testFilter "<filter>"; the train result and the engine.land event say playMode focus and the filter (fails before this fix: the land command was told nothing, so every land ran every Play Mode test)', () => [
      r.landed?.join() === 'T-901,T-902' && runs.length === 1 && runs[0].playMode === 'focus' && runs[0].playFilter === want && runs[0].playArgs === `-testFilter "${want}"`
        && r.playMode === 'focus' && r.playFilter === want && le.length === 1 && le[0].playMode === 'focus' && le[0].playFilter === want,
      JSON.stringify({ r, runs, le }).slice(0, 2500)]);
  }
  {
    resetState();
    const E = engineRepo({ ...mapped, 'feat/c': { 'Assets/Art/logo.png': 'png\n' } });
    const ctl = path.join(T, 'ctl-play-unmapped');
    setEngines({ unity: cfgFor(E, ctl, { play: PLAY }) });
    queue(E, [['T-911', 'feat/a'], ['T-912', 'feat/c']]);
    const r = probe(TRAIN, noFull);
    const runs = runsOf(ctl);
    await guard('2.84 play focus, one unmapped path: a batch with one path no map entry matches gets STUDIO_PLAY_MODE=full and no STUDIO_PLAY_FILTER or STUDIO_UNITY_PLAYMODE_ARGS (fails before this fix: STUDIO_PLAY_MODE was never set)', () => [
      r.landed?.join() === 'T-911,T-912' && runs.length === 1 && runs[0].playMode === 'full' && runs[0].playFilter === null && runs[0].playArgs === null && r.playMode === 'full',
      JSON.stringify({ r, runs }).slice(0, 2000)]);
  }
  {
    resetState();
    const E = engineRepo(mapped);
    const ctl = path.join(T, 'ctl-play-full');
    setEngines({ unity: cfgFor(E, ctl, { play: PLAY }) });
    fs.mkdirSync(path.join(S, '.studio', 'engine'), { recursive: true });
    fs.writeFileSync(path.join(S, '.studio', 'engine', 'unity-full-land.json'), JSON.stringify({ at: new Date(Date.now() - 25 * 3600000).toISOString(), id: null }));
    queue(E, [['T-921', 'feat/a']]);
    const r = probe(TRAIN, { STUDIO_ENGINE_FULL_LAND_HOURS: '24' });
    const runs = runsOf(ctl);
    await guard('2.84 play focus, a full land run due: although every path is mapped, the daily full land run (STUDIO_LAND_FULL=1) gets STUDIO_PLAY_MODE=full and no filter (fails before this fix: STUDIO_PLAY_MODE was never set)', () => [
      r.landed?.join() === 'T-921' && r.fullLand === 1 && runs.length === 1 && runs[0].full === '1' && runs[0].playMode === 'full' && runs[0].playFilter === null && runs[0].playArgs === null,
      JSON.stringify({ r, runs }).slice(0, 2000)]);
  }
  {
    resetState();
    const E = engineRepo(mapped);
    const ctl = path.join(T, 'ctl-play-none');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-931', 'feat/a']]);
    const r = probe(TRAIN, { ...noFull, STUDIO_PLAY_FILTER: 'Leaked.From.Outside', STUDIO_UNITY_PLAYMODE_ARGS: '-testFilter "Leaked"' });
    const runs = runsOf(ctl);
    await guard('2.84 play focus, no config: with no engines.unity.play.focus the land command gets STUDIO_PLAY_MODE=full (as docs/NATIVE-ENGINE.md says) and no filter, even when the train\'s own environment held one (fails before this fix: STUDIO_PLAY_MODE was never set and an outside filter passed straight through)', () => [
      r.landed?.join() === 'T-931' && runs.length === 1 && runs[0].playMode === 'full' && runs[0].playFilter === null && runs[0].playArgs === null,
      JSON.stringify({ r, runs }).slice(0, 2000)]);
  }
  {
    resetState();
    const E = engineRepo(mapped);
    const ctl = path.join(T, 'ctl-play-retry');
    fs.writeFileSync(`${ctl}-flaky`, '1 play Game.PlayTests.Economy.OpensTheLedger');
    setEngines({ unity: cfgFor(E, ctl, { play: PLAY }) });
    queue(E, [['T-941', 'feat/a'], ['T-942', 'feat/b']]);
    const r = probe(TRAIN, noFull);
    const runs = runsOf(ctl);
    await guard('2.84 play focus, the retry: a batch red once in the play stage is run again (2.83 retryStages) with the SAME STUDIO_PLAY_FILTER and Unity arguments, passes and lands (fails before this fix: neither run was given a filter)', () => [
      r.landed?.join() === 'T-941,T-942' && r.runs === 2 && runs.length === 2 && r.flaky?.length === 1 && runs.every((x) => x.playMode === 'focus' && x.playFilter === want && x.playArgs === `-testFilter "${want}"`),
      JSON.stringify({ r, runs }).slice(0, 2000)]);
  }
  {
    resetState();
    const E = engineRepo(mapped);
    const ctl = path.join(T, 'ctl-play-odd');
    setEngines({ unity: cfgFor(E, ctl, { play: { focus: { map: [{ match: '^Assets/Scripts/([A-Za-z]+)/', filter: 'Game.PlayTests.$1" & echo hi & "' }] } } }) });
    queue(E, [['T-951', 'feat/a']]);
    const r = probe(TRAIN, noFull);
    const runs = runsOf(ctl);
    await guard('2.84 play focus, an odd filter: a filter with characters outside [A-Za-z0-9_.;|~=!()* -] (a quote, an ampersand) is refused: the play stage runs in full (STUDIO_PLAY_MODE=full, no filter, no Unity arguments) and the train logs why (fails before this fix: no play focus existed; a naive one would put the quote on the editor\'s command line)', () => [
      r.landed?.join() === 'T-951' && runs.length === 1 && runs[0].playMode === 'full' && runs[0].playFilter === null && runs[0].playArgs === null && r.logs?.some((l) => /play focus: refused the filter/.test(l) && /runs in full/.test(l)),
      JSON.stringify({ r, runs }).slice(0, 2000)]);
  }

  // ================= 5. the scorecard lines =================
  {
    const r = probe(`import { engineFlow, engineText } from ${u('harness/score.mjs')};
const ev = (status, tasks, play, mode, secs) => ({ type: 'engine.land', ts: '2026-11-12T10:00:00Z', meta: { status, ms: 1800000, ...(tasks > 1 ? { tasks: Array.from({ length: tasks }, (_, i) => 'T-' + i) } : {}), ...(mode ? { playMode: mode, playFilter: mode === 'focus' ? 'X' : '' } : {}), ...(play ? { stages: [{ name: 'edit', status: 'pass', seconds: 600 }, { name: 'play', status: 'pass', seconds: secs }] } : {}) } });
const en = engineFlow([ev('pass', 1, true, null, 2400), ev('pass', 6, true, 'focus', 480), ev('red', 3, true, 'full', 1800), ev('refused', 4, false, null, 0), ev('pass', 2, true, 'focus', 600)]);
console.log(JSON.stringify({ en: { branchesPerRun: en.branchesPerRun, play: en.play }, lines: engineText(en).filter((l) => /Branches per land run|Play stage/.test(l)) }));`);
    await guard('2.84 scorecard: the engine block prints "Branches per land run: median N (K runs)" from the engine.land events\' task lists (refused runs left out) and "Play stage: N focused, M full; median minutes focused X, full Y" from the stage reports (a run with no playMode counts as full) (fails before this fix: neither line existed, so the batch window and the play focus could not be judged)', () => [
      r.en?.branchesPerRun?.runs === 4 && r.en.play?.focused === 2 && r.en.play.full === 2
        && r.lines?.[0] === '  Branches per land run: median 3 (4 runs)' && r.lines?.[1] === '  Play stage: 2 focused, 2 full; median minutes focused 10, full 40',
      JSON.stringify(r).slice(0, 2000)]);
  }
}
