/**
 * qa/selftest-279e.mjs — 2.79 (e): the engine port's land, bisect, check, slot and pictures (harness side, any engine).
 *   preland   engines.<x>.preLand runs per lane in a checkout of the lane's commit before the long land run; a non-zero exit
 *             hands that lane back (cause precheck, the command's last lines) and the land run never sees it
 *   bisect    a red batch's failing test names are its signature; the bisect stops after STUDIO_ENGINE_BISECT_MAX runs and
 *             hands back the lanes still in the red range; with no readable names it is the full search it was
 *   check     npm run engine -- check runs engines.<x>.quickCheck in the lane copy under one machine-wide lock; task done
 *             of an engine-porter task runs it and refuses on red
 *   slot      an engine train starts while a web train runs when the engine slot is free; a taken slot, the line off or
 *             "window": "quiet" keep the old wait; an owner-set STUDIO_ENGINE_SLOTS opens the engine line with no scan
 *   shots     a green land with engines.<x>.shots writes before/after folders, a compare page and one notice; none: nothing
 * Fake engine commands (node scripts) stand in for the engine, as in selftest-277u.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest279E({ dir, run, report, tmpRoot, root }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const T = path.join(tmpRoot, `s279e-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const harnessRoot = root || dir;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-279e-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file, engine settings) ----
  const S = path.join(tmpRoot, `279e-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(S, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch {}
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const gameBefore = readJson(path.join(S, 'studio', 'game.json')) || {};
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ ...gameBefore, engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-279e.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-279e-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 240000 });
    try { fs.rmSync(f, { force: true }); } catch {}
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'engine-shots', 'comm', 'gates']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true }); fs.rmSync(path.join(S, 'qa', 'reports', 'engine-compare'), { recursive: true, force: true }); fs.rmSync(path.join(S, 'studio', 'proof'), { recursive: true, force: true }); fs.writeFileSync(evFile, ''); };

  // ---- a made-up engine repo: target port/main lives in the land script's gate worktree ----
  let rn = 0;
  const engineRepo = (lanes, { shared = {} } = {}) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    write(R, 'pin.txt', 'bundle-2\n');
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
  // The land script: records each run's sources, fails when a source's tree has bad.txt (printing the plan's failure
  // lines), else merges the sources into the gate worktree. SHOT_V: writes a shot (a PNG name) into <repo>/shots/.
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs }) + '\\n');
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
for (const s of srcs) {
  const files = git(gw, 'ls-tree', '-r', '--name-only', 'refs/heads/' + s).stdout.split('\\n');
  if (files.includes('bad.txt')) {
    console.log('[land] running tests');
    if (process.env.LAND_PLAN === 'names') { console.log('Failed : Suite.TestAlpha'); console.log('  Failed Suite.TestBeta [3 ms]'); console.log('<test-case id="1" name="TestGamma" fullname="Suite.TestGamma" result="Failed" />'); }
    console.log('3 tests failed');
    process.exit(1);
  }
}
if (process.env.SHOT_V) { fs.mkdirSync(path.join(process.cwd(), 'shots'), { recursive: true }); fs.writeFileSync(path.join(process.cwd(), 'shots', 'hangar.png'), process.env.SHOT_V); }
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); console.log('conflict ' + s); process.exit(2); } }
console.log('landed ' + srcs.join(' '));
`);
  const runsOf = (ctl) => { try { return fs.readFileSync(`${ctl}-runs.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const cfgFor = (E, ctl, extra = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, ...extra });
  const queue = (E, lanes) => { fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true }); fs.writeFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), JSON.stringify(lanes.map(([task, branch], i) => ({ task, agent: `porter-${i}`, branch, head: E.heads[branch], at: new Date(Date.now() + i).toISOString() })))); };
  const TRAIN = `import { runUnityTrain, readUnityQueue } from ${u('harness/unity-train.mjs')};
const handed = [];
const r = await runUnityTrain({ root: process.cwd(), log: () => {}, deps: { handBack: (lane, note, extra) => handed.push({ task: lane.task, note, extra: extra || null }) } });
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, landed: r.landed, dropped: r.dropped, deferred: r.deferred, handed, queue: readUnityQueue(process.cwd()).map((e) => e.task) }));`;

  // ================= 1. preLand =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'pin.txt': 'bundle-1\n' }, 'feat/b': { 'b.txt': 'b\n' } });
    const ctl = path.join(T, 'ctl-pre');
    const check = path.join(T, 'precheck.mjs');
    fs.writeFileSync(check, `import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true }).stdout.trim();
if (head !== process.env.STUDIO_LANE_COMMIT || path.resolve(process.cwd()) !== path.resolve(process.env.STUDIO_LANE_DIR) || !fs.existsSync(path.join(process.env.STUDIO_ENGINE_REPO, '.git'))) { console.error('wrong checkout: ' + head + ' vs ' + process.env.STUDIO_LANE_COMMIT); process.exit(1); }
const lane = fs.readFileSync(path.join(process.env.STUDIO_LANE_DIR, 'pin.txt'), 'utf8').trim();
const want = process.env.LAND_BUNDLE;
if (lane !== want) { console.error('pin mismatch: the lane pins ' + lane + ' but the land would use ' + want); process.exit(1); }
console.log('pin ok');
`);
    setEngines({ unity: cfgFor(E, ctl, { preLand: `node "${fwd(check)}"` }) });
    queue(E, [['T-901', 'feat/a'], ['T-902', 'feat/b']]);
    const r = probe(TRAIN, { LAND_BUNDLE: 'bundle-2' });
    const runs = runsOf(ctl);
    const ev = events().find((e) => e.type === 'task.train.unity.dropped' && e.task === 'T-901');
    await guard('2.79 (e) preLand: a lane whose pin differs from what the land would use is refused BEFORE the land run (the command runs in a checkout of its commit with STUDIO_LANE_COMMIT/DIR/ENGINE_REPO) and handed back with the command\'s last line and cause precheck; the land run lands only the other lane (fails on 2.78.2: preLand is ignored, both lanes land in one run)', () => [
      r.landed?.join() === 'T-902' && r.runs === 1 && runs.length === 1 && runs[0].srcs.join() === 'feat/b' && r.dropped?.length === 1 && r.dropped[0].task === 'T-901' && r.dropped[0].cause === 'precheck'
        && /pin mismatch: the lane pins bundle-1 but the land would use bundle-2/.test(r.dropped[0].why) && r.handed?.[0]?.task === 'T-901' && r.handed[0].extra?.cause === 'precheck' && ev?.meta?.cause === 'precheck',
      JSON.stringify({ r, runs, ev }).slice(0, 2500)]);
    resetState();
    const E2 = engineRepo({ 'feat/a': { 'pin.txt': 'bundle-1\n' } });
    setEngines({ unity: cfgFor(E2, ctl, { preLand: `node "${fwd(check)}"` }) });
    queue(E2, [['T-903', 'feat/a']]);
    const ok = probe(TRAIN, { LAND_BUNDLE: 'bundle-1' });
    await guard('2.79 (e) preLand guard: a lane whose pin matches lands as before (passes on 2.78.2 too)', () => [ok.landed?.join() === 'T-903' && !ok.dropped?.length && ok.runs === 1, JSON.stringify(ok).slice(0, 1200)]);
  }

  // ================= 2. bisect on the failure signature =================
  const bisectScenario = (name, plan, max) => {
    resetState();
    const lanes = { 'feat/a': { 'bad.txt': 'x\n' }, 'feat/b': { 'b.txt': 'b\n' }, 'feat/c': { 'c.txt': 'c\n' }, 'feat/d': { 'd.txt': 'd\n' } };
    const E = engineRepo(lanes);
    const ctl = path.join(T, `ctl-${name}`);
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-911', 'feat/a'], ['T-912', 'feat/b'], ['T-913', 'feat/c'], ['T-914', 'feat/d']]);
    const r = probe(TRAIN, { LAND_PLAN: plan, ...(max ? { STUDIO_ENGINE_BISECT_MAX: String(max) } : {}) });
    return { r, runs: runsOf(ctl), ev: events().filter((e) => e.type === 'task.train.unity.bisect') };
  };
  {
    const b = bisectScenario('names', 'names', 1);
    await guard('2.79 (e) bisect: a red batch whose run names its failing tests is bisected only STUDIO_ENGINE_BISECT_MAX (1) time: the red subset [T-911, T-912] fails with the batch\'s names, so the search stops there and hands back both lanes (the culprit is among them) instead of re-running T-911 alone; the other lanes land (fails on 2.78.2: 4 land runs, only T-911 handed back)', () => [
      b.r.runs === 3 && b.r.dropped?.map((d) => d.task).join() === 'T-911,T-912' && b.r.landed?.join() === 'T-913,T-914' && b.ev.some((e) => e.meta?.capped === true) && /Suite\.TestAlpha/.test(b.r.dropped?.[0]?.why || ''),
      JSON.stringify({ runs: b.r.runs, landed: b.r.landed, dropped: b.r.dropped?.map((d) => d.task), srcs: b.runs.map((x) => x.srcs.join('+')) }).slice(0, 2000)]);
    const d = bisectScenario('default', 'names', null);
    await guard('2.79 (e) bisect default: with STUDIO_ENGINE_BISECT_MAX at its default (3) a four-lane batch is still narrowed to the single culprit T-911 (two bisect runs) (passes on 2.78.2 too)', () => [
      d.r.dropped?.map((x) => x.task).join() === 'T-911' && d.r.landed?.length === 3,
      JSON.stringify({ runs: d.r.runs, landed: d.r.landed, dropped: d.r.dropped?.map((x) => x.task) }).slice(0, 1500)]);
    const n = bisectScenario('nonames', 'plain', 1);
    await guard('2.79 (e) bisect guard: a red run that prints no test names (just "3 tests failed") keeps today\'s full search whatever the cap: T-911 alone is handed back after 4 land runs (passes on 2.78.2 too)', () => [
      n.r.runs === 4 && n.r.dropped?.map((x) => x.task).join() === 'T-911' && n.r.landed?.length === 3, JSON.stringify({ runs: n.r.runs, landed: n.r.landed, dropped: n.r.dropped?.map((x) => x.task) }).slice(0, 1500)]);
    const names = probe(`import { failingTests } from ${u('harness/unity-gate.mjs')};
console.log(JSON.stringify({ n: failingTests('Failed : Suite.A\\r\\n  Failed Suite.B [3 ms]\\r\\n[  FAILED  ] Suite.C\\r\\n<test-case name="D" fullname="Suite.D" result="Failed" />\\n<test-case name="E" fullname="Suite.E" result="Passed" />\\nFailed : Suite.A') }));`);
    await guard('2.79 (e) bisect names: failing test names are read from "Failed : X", "Failed X [ms]", "[  FAILED  ] X" and NUnit result tags (CRLF too), sorted and unique (fails on 2.78.2: no parser)', () => [names.n?.join() === 'Suite.A,Suite.B,Suite.C,Suite.D', JSON.stringify(names)]);
  }

  // ================= 3. the porter's quick check =================
  {
    resetState();
    const E = engineRepo({ 'feat/q': { 'q.txt': 'q\n' } });
    const qlog = path.join(T, 'qc-log.jsonl');
    const qc = path.join(T, 'qc.mjs');
    fs.writeFileSync(qc, `import fs from 'node:fs';
const t0 = Date.now();
if (process.env.QC_PLAN === 'red') { console.log('Sim.cs(3,4): error CS1002: ; expected'); process.exit(1); }
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.QC_MS || 0));
fs.appendFileSync(${JSON.stringify(qlog)}, JSON.stringify({ t0, t1: Date.now(), cwd: process.cwd(), engine: process.env.STUDIO_ENGINE }) + '\\n');
`);
    const lane = path.join(S, '.lanes', 'engine', 'T-950');
    fs.mkdirSync(lane, { recursive: true });
    setEngines({ unity: { ...cfgFor(E, path.join(T, 'ctl-q')), quickCheck: `node "${fwd(qc)}"` } });
    const chk = (extra = {}, args = '--engine unity --task T-950') => spawnSync(process.execPath, [path.join(S, 'harness', 'engine.mjs'), 'check', ...args.split(' ')], { windowsHide: true, cwd: S, env: { ...envOf(), ...extra }, encoding: 'utf8', timeout: 120000 });
    const pass = chk();
    const red = chk({ QC_PLAN: 'red' });
    setEngines({ unity: cfgFor(E, path.join(T, 'ctl-q')) });
    const none = chk();
    setEngines({ unity: { ...cfgFor(E, path.join(T, 'ctl-q')), quickCheck: `node "${fwd(qc)}"` } });
    const logs = () => { try { return fs.readFileSync(qlog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    await guard('2.79 (e) check: `npm run engine -- check` runs engines.<x>.quickCheck in the porter\'s lane copy (.lanes/engine/<task>) and exits 0 on a pass, 1 on a red with the command\'s last lines, 0 "SKIP" with none configured (fails on 2.78.2: no check command)', () => [
      pass.status === 0 && /PASS unity/.test(out(pass)) && logs().length === 1 && fs.realpathSync(logs()[0].cwd) === fs.realpathSync(lane) && logs()[0].engine === 'unity'
        && red.status === 1 && /RED unity/.test(out(red)) && /error CS1002/.test(out(red)) && none.status === 0 && /SKIP unity/.test(out(none)),
      JSON.stringify({ pass: out(pass).slice(-300), red: out(red).slice(-300), none: out(none).slice(-300), logs: logs() }).slice(0, 2000)]);
    // Two at once: one runs at a time, the second waits with a status line.
    fs.rmSync(qlog, { force: true });
    const spawnCheck = () => new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(S, 'harness', 'engine.mjs'), 'check', '--engine', 'unity', '--task', 'T-950'], { windowsHide: true, cwd: S, env: { ...envOf(), QC_MS: '1500' } });
      let text = '';
      c.stdout.on('data', (d) => { text += d; }); c.stderr.on('data', (d) => { text += d; });
      c.on('close', (code) => resolve({ code, text }));
    });
    const [c1, c2] = await Promise.all([spawnCheck(), spawnCheck()]);
    const L = logs().sort((a, b) => a.t0 - b.t0);
    await guard('2.79 (e) check lock: two porters\' checks never overlap (the lock engine-check:<engine>); the second prints a "waiting for" status line and then runs (fails on 2.78.2: no check command)', () => [
      c1.code === 0 && c2.code === 0 && L.length === 2 && L[0].t1 <= L[1].t0 && /waiting for .*unity check/.test(`${c1.text}${c2.text}`),
      JSON.stringify({ L, c1: c1.text.slice(-300), c2: c2.text.slice(-300) }).slice(0, 2000)]);
    // task done of an engine-porter task: refused on red, passes on green.
    const task = (cmd, env = {}) => run(S, `node harness/task.mjs ${cmd}`, envOf(env));
    const add = task('add "Pass 7: compile the sim" --role engine-porter --track engine:unity --branch feat/q --scope Assets/Sim --size 2');
    const id = (String(add.stdout).match(/"id":\s*"(T-\d+)"/) || [])[1];
    if (id) {
      task(`start ${id} --agent porter-279e`);
      fs.mkdirSync(path.join(S, '.lanes', 'engine', id), { recursive: true });
      const done = task(`done ${id} --agent porter-279e --train`, { QC_PLAN: 'red' });
      const q = readJson(path.join(S, '.studio', 'train', 'unity-queue.json')) || [];
      await guard('2.79 (e) check at done: `task done` of an engine-porter task runs the engine\'s quickCheck and refuses on red with the command\'s last lines: nothing is queued for the train (fails on 2.78.2: done went on to queue it)', () => [
        done.status !== 0 && /quick check failed/.test(out(done)) && /error CS1002/.test(out(done)) && !q.some((e) => e.task === id),
        out(done).slice(-1200)]);
    } else report('2.79 (e) check at done: the engine-porter task could not be added', false, out(add).slice(-800));
  }

  // ================= 4. the engine slot =================
  {
    const wp = probe(`const lp = await import(${u('harness/line-producer.mjs')});
const now = Date.now();
const f = { engine: 'unity', label: 'Unity', heavyKind: 'unity', queued: 1, oldestAt: new Date(now - 5 * 60000).toISOString(), running: false, startedRecently: 0, auto: true, webTrain: true, webQueued: 3, heavy: [{ kind: 'train', label: 'train verify' }], freeGb: 4, floorGb: 12, floorFrom: 'x', cpuBusy: 0.95, expectedMin: 26, now, engineSlots: 1, slotFree: true, window: 'slot' };
const w = (patch, env = {}) => lp.engineWindow({ ...f, ...patch }, env);
console.log(JSON.stringify({ free: w({}), taken: w({ slotFree: false, engineHolders: ['unity land (T-9)'] }), off: w({ engineSlots: 0 }), quiet: w({ window: 'quiet' }), envQuiet: w({}, { STUDIO_ENGINE_WINDOW: 'quiet' }), person: w({ auto: false }) }));`);
    await guard('2.79 (e) slot: with the engine slot free the engine train starts although a web train runs, web lanes wait, a game verify holds RAM and the CPU is busy (it needs no `train auto off`); a taken slot waits naming the holder; the line off, "window": "quiet" and STUDIO_ENGINE_WINDOW=quiet keep the old quiet window; trainAuto false still leaves it to a person (fails on 2.78.2: "the web train is running")', () => [
      wp.free?.start === true && /slot is free/.test(wp.free.why) && wp.taken?.start === false && /slot is taken \(unity land \(T-9\)/.test(wp.taken.why) && wp.off?.start === false && /web train/.test(wp.off.why)
        && wp.quiet?.start === false && /web train/.test(wp.quiet.why) && wp.envQuiet?.start === false && wp.person?.start === false && wp.person.wait === false,
      JSON.stringify(wp).slice(0, 2500)]);
    resetState();
    fs.mkdirSync(path.join(S, '.studio', 'locks'), { recursive: true });
    const E = engineRepo({ 'feat/s': { 's.txt': 's\n' } });
    setEngines({ unity: cfgFor(E, path.join(T, 'ctl-slot')) });
    queue(E, [['T-931', 'feat/s']]);
    fs.writeFileSync(path.join(S, '.studio', 'locks', 'train.lock'), JSON.stringify({ pid: process.pid, at: Date.now(), id: 'web-279e', by: 'train' }));
    fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true });
    fs.writeFileSync(path.join(S, '.studio', 'train', 'queue.json'), JSON.stringify([{ task: 'T-940', agent: 'b', branch: 'lane/t-940', head: 'abc', at: new Date().toISOString() }]));
    const PASS = `const lp = await import(${u('harness/line-producer.mjs')});
const rows = await lp.enginePass({ dryRun: true, deps: { rigBudget: async () => ({ running: [{ kind: 'train', label: 'train verify' }], freeGb: 5 }), machine: { cpu: { busy: 0.9 } } } });
console.log(JSON.stringify({ rows }));`;
    const free = probe(PASS);
    const holder = path.join(S, '.studio', 'locks', 'machine-heavy-1.lock');
    fs.writeFileSync(holder, JSON.stringify({ pid: process.pid, at: Date.now(), label: 'unity land (T-9)', claim: { kind: 'unity', engine: 'unity', label: 'unity land (T-9)' } }));
    const taken = probe(PASS);
    fs.rmSync(holder, { force: true });
    const quiet = probe(PASS, { STUDIO_ENGINE_WINDOW: 'quiet' });
    fs.rmSync(path.join(S, '.studio', 'locks', 'train.lock'), { force: true });
    await guard('2.79 (e) slot pass: the Line Producer\'s engine pass starts the queued engine train (row start true, "slot is free") while the web train lock is held, web lanes are queued and the machine is busy; a live engine land holding machine:heavy takes the slot (start false); STUDIO_ENGINE_WINDOW=quiet restores the wait (fails on 2.78.2: "the web train is running")', () => [
      free.rows?.[0]?.start === true && /slot is free/.test(free.rows[0].why) && taken.rows?.[0]?.start === false && /slot is taken/.test(taken.rows[0].why) && quiet.rows?.[0]?.start === false && /web train/.test(quiet.rows[0].why),
      JSON.stringify({ free, taken, quiet }).slice(0, 2500)]);
    const ah = probe(`import * as H from ${u('harness/heavy.mjs')};
const take = (root, label, o = {}) => { try { const lk = H.acquireHeavy(root, label, { ...o, env: { ...process.env, STUDIO_HEAVY_HELD: '', ...(o.env || {}) } }); return { ok: true, lk }; } catch (e) { return { ok: false, code: e.code || 'ERR' }; } };
const root = process.cwd();
const v = take(root, 'game verify', { kind: 'verify' });
const land = { kind: 'unity', engine: 'unity', env: { STUDIO_GATE_PRIORITY: 'landing' } };
const withSlots = take(root, 'unity land', { ...land, env: { ...land.env, STUDIO_ENGINE_SLOTS: '1' } });
const r = { verify: v.ok ? 'took it' : v.code, set: withSlots.ok ? 'took it' : withSlots.code };
if (withSlots.ok) withSlots.lk.release();
const unset = take(root, 'unity land', land);
r.unset = unset.ok ? 'took it' : unset.code; if (unset.ok) unset.lk.release();
if (v.ok) v.lk.release();
console.log(JSON.stringify(r));`, { STUDIO_HEAVY_SLOTS: '1', STUDIO_MACHINE_SCAN: 'off', STUDIO_HEAVY_MAX_UNITY: 'off', STUDIO_ENGINE_SLOTS: '' });
    await guard('2.79 (e) slot heavy: with no machine scan and STUDIO_ENGINE_SLOTS set by the owner, an engine land takes the engine\'s own slot while a game verify holds the only game slot; with it unset the land shares the game slots and waits as before (fails on 2.78.2: the set case waited too)', () => [
      ah.verify === 'took it' && ah.set === 'took it' && ah.unset === 'HEAVY_BUSY', JSON.stringify(ah)]);
  }

  // ================= 5. before/after pictures =================
  {
    resetState();
    const lanes = { 'feat/p': { 'p.txt': 'p\n' }, 'feat/q': { 'q.txt': 'q\n' }, 'feat/r': { 'r.txt': 'r\n' } };
    const E = engineRepo(lanes);
    const ctl = path.join(T, 'ctl-shots');
    setEngines({ unity: cfgFor(E, ctl, { shots: 'shots' }) });
    queue(E, [['T-921', 'feat/p']]);
    const one = probe(TRAIN, { SHOT_V: 'v1' });
    const page1 = path.join(S, 'qa', 'reports', 'engine-compare', 'T-921.html');
    const notices = () => { try { return fs.readFileSync(path.join(S, '.studio', 'comm', 'notices.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    const n1 = notices().length;
    queue(E, [['T-922', 'feat/q']]);
    const two = probe(TRAIN, { SHOT_V: 'v2' });
    const page2 = path.join(S, 'qa', 'reports', 'engine-compare', 'T-922.html');
    const read = (rel) => { try { return fs.readFileSync(path.join(S, rel), 'utf8'); } catch { return null; } };
    await guard('2.79 (e) shots: a green land with engines.<x>.shots copies the new shots to studio/proof/<task>/engine-after/ and the previous green land\'s to engine-before/, writes qa/reports/engine-compare/<task>.html (before | after per file name), keeps the new shots as the next "before" and queues ONE Studio Status line with the page path (fails on 2.78.2: nothing written)', () => [
      one.landed?.join() === 'T-921' && two.landed?.join() === 'T-922' && fs.existsSync(page1) && read('studio/proof/T-921/engine-after/hangar.png') === 'v1' && !fs.existsSync(path.join(S, 'studio', 'proof', 'T-921', 'engine-before', 'hangar.png'))
        && read('studio/proof/T-922/engine-before/hangar.png') === 'v1' && read('studio/proof/T-922/engine-after/hangar.png') === 'v2' && read('.studio/engine-shots/unity/last/hangar.png') === 'v2'
        && /hangar\.png/.test(read('qa/reports/engine-compare/T-922.html') || '') && /engine-before\/hangar\.png/.test(read('qa/reports/engine-compare/T-922.html') || '') && /engine-after\/hangar\.png/.test(read('qa/reports/engine-compare/T-922.html') || '')
        && n1 === 1 && notices().length === 2 && /qa\/reports\/engine-compare\/T-922\.html/.test(notices()[1].text) && fs.existsSync(page2),
      JSON.stringify({ one: one.landed, two: two.landed, notices: notices(), page2: read('qa/reports/engine-compare/T-922.html')?.slice(0, 600) }).slice(0, 2500)]);
    resetState();
    const E3 = engineRepo({ 'feat/r': { 'r.txt': 'r\n' } });
    setEngines({ unity: cfgFor(E3, ctl) });
    queue(E3, [['T-923', 'feat/r']]);
    const three = probe(TRAIN, { SHOT_V: 'v3' });
    await guard('2.79 (e) shots guard: with no "shots" in the engine config nothing is written for the land (no page, no proof folder, no notice) (passes on 2.78.2 too)', () => [
      three.landed?.join() === 'T-923' && !fs.existsSync(path.join(S, 'qa', 'reports', 'engine-compare', 'T-923.html')) && !fs.existsSync(path.join(S, 'studio', 'proof', 'T-923')) && notices().length === 0 && !fs.existsSync(path.join(S, '.studio', 'engine-shots')),
      JSON.stringify(three).slice(0, 1200)]);
  }

  for (const x of [S, T]) { try { fs.rmSync(x, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch {} }
}
