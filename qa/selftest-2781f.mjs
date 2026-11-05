/**
 * qa/selftest-2781f.mjs — 2.78.1 (f): the crew's run on 2.78.0 (B-121, B-117, M7) and the Line Producer's
 * "Unity twins", "rig-aware scheduling" and "chain-breaker push".
 *   B-121  the supervisor launched a builder on a task that was in a Unity train: a task in any train (an engine's queue,
 *          or a running train's lanes) counts as in progress for launching.
 *   B-117  (a) each heavy waiter admitted by its own copy of STUDIO_HEAVY_SLOTS (4-5 verifies ran with slots=2): the main
 *          checkout's .env counts too, the lower wins. (b) an engine land has its own line (STUDIO_ENGINE_SLOTS) and
 *          gives way to the game's merge train (its verify, its slot priority, a quiet hold).
 *   rig    a running engine train's RAM counts in the room for builders between its land runs.
 *   push   a chain-breaker queued for the train holds new builder verifies back (bounded).
 *   twins  a landed game task whose files have an engine twin gets one twin task (studio/game.json engines.<x>.twins).
 *   M7     playtest:stage1 stepped the template cartridge, not the studio's game, and passed in ~33 ms: it now says what it
 *          stepped and warns (STUDIO_PLAYTEST_GAME_CHECK warn, the default), or fails (fail); off is 2.78.0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2781F({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '150', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2781f-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_config_node_options: '', npm_lifecycle_event: '', CLAUDECODE: '',
  };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `2781f-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules|reports)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, '.env'), { force: true });
    const ev = path.join(S, '.studio', 'events-2781f.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    fs.rmSync(path.join(S, 'studio', 'beta.json'), { force: true });
    made.push(S);
    return { S, env: { ...base, AGENT_EVENTS_FILE: ev, STUDIO_MAIN_ROOT: S } };
  };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const probe = (S, code, env, ms = 60000) => {
    const f = path.join(S, `.probe-2781f-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...process.env, ...env }, encoding: 'utf8', timeout: ms });
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    let j = null; try { j = JSON.parse(l); } catch {}
    return { j, text: `${r.stdout || ''}${r.stderr || ''}`, status: r.status };
  };
  // In a probe: take a slot without inheriting this process's own hold (acquireHeavy sets STUDIO_HEAVY_HELD while held).
  const TAKE = `const take = (H, root, label, o = {}) => { try { const lk = H.acquireHeavy(root, label, { ...o, env: { ...process.env, STUDIO_HEAVY_HELD: '', ...(o.env || {}) } }); return { ok: true, lk }; } catch (e) { return { ok: false, code: e.code || 'ERR', msg: String(e.message || e).slice(0, 400) }; } };`;
  // A machine scan (the engine line needs one: it is what keeps an engine land and game work apart): 64 GB, 32 threads, no GPU.
  const scan = { STUDIO_MACHINE_SCAN: '', STUDIO_TEST_MACHINE: JSON.stringify({ at: new Date().toISOString(), os: { platform: 'linux' }, ram: { totalGb: 64, freeGb: 60 }, cores: { logical: 32 }, gpus: [] }) };
  const st = studio('a');
  const S = st.S;

  // ---- B-117 (a): the slot count is the machine's ----
  await guard('2.78.1 (f, B-117a): a verify whose own environment says STUDIO_HEAVY_SLOTS=4 (a session started before the owner lowered it) is held to the main checkout\'s .env value 1: with one heavy job running it waits (HEAVY_BUSY), and with no .env value it takes a second slot as before (fails on 2.78.0: each waiter admitted by its own copy, so it took a second slot)', async () => {
    const p = probe(S, `import fs from 'node:fs'; import path from 'node:path';
import * as H from ${u(S, 'harness/heavy.mjs')};
${TAKE}
const root = process.cwd();
const r = {};
const a = take(H, root, 'builder verify A', { kind: 'verify' });
fs.writeFileSync(path.join(root, '.env'), 'STUDIO_HEAVY_SLOTS=1\\n');
const b = take(H, root, 'builder verify B', { kind: 'verify' });
r.withEnvFile = b.ok ? 'took it' : b.code; r.msg = b.msg || ''; if (b.ok) b.lk.release();
r.slotsAt = H.heavySlotsAt(root, process.env);
fs.rmSync(path.join(root, '.env'), { force: true });
const c = take(H, root, 'builder verify C', { kind: 'verify' });
r.noEnvFile = c.ok ? 'took it' : c.code; if (c.ok) c.lk.release();
if (a.ok) a.lk.release();
console.log(JSON.stringify(r));
`, { ...st.env, STUDIO_HEAVY_SLOTS: '4' });
    const r = p.j || {};
    return [r.withEnvFile === 'HEAVY_BUSY' && /builder verify A/.test(r.msg) && r.slotsAt === 1 && r.noEnvFile === 'took it', `${JSON.stringify(r)}\n${p.text.slice(-500)}`];
  });

  // ---- B-117 (b): the engine line ----
  await guard('2.78.1 (f, B-117b): with STUDIO_HEAVY_SLOTS=1, an engine land (acquireHeavy engine: unity) takes the engine line and a builder\'s verify still gets the one game slot beside it; a second engine land waits (STUDIO_ENGINE_SLOTS 1); with STUDIO_ENGINE_SLOTS=off, or no machine scan (the slot count is then the only guard), the land takes the game slot as before (fails on 2.78.0: the land took the only game slot and the verify waited)', async () => {
    const p = probe(S, `import * as H from ${u(S, 'harness/heavy.mjs')};
${TAKE}
const root = process.cwd();
const land = { kind: 'unity', engine: 'unity', env: { STUDIO_GATE_PRIORITY: 'landing' } };
const r = {};
const e1 = take(H, root, 'unity land 1', land);
r.land = e1.ok ? 'took it' : e1.code;
const v = take(H, root, 'builder verify', { kind: 'verify' });
r.verify = v.ok ? 'took it' : v.code; r.verifyMsg = v.msg || '';
const e2 = take(H, root, 'unity land 2', { kind: 'heavy', engine: 'unity', env: { STUDIO_GATE_PRIORITY: 'landing' } });
r.land2 = e2.ok ? 'took it' : e2.code; r.land2Msg = e2.msg || ''; if (e2.ok) e2.lk.release();
r.claimEngine = H.heavyHolders(root).find((h) => /unity land 1/.test(h.label))?.claim?.engine || null;
if (v.ok) v.lk.release(); if (e1.ok) e1.lk.release();
const o1 = take(H, root, 'unity land (line off)', { ...land, env: { ...land.env, STUDIO_ENGINE_SLOTS: 'off' } });
const o2 = take(H, root, 'builder verify (line off)', { kind: 'verify' });
r.offVerify = o2.ok ? 'took it' : o2.code; if (o2.ok) o2.lk.release(); if (o1.ok) o1.lk.release();
const s1 = take(H, root, 'unity land (no scan)', { ...land, machine: null });
const s2 = take(H, root, 'builder verify (no scan)', { kind: 'verify', machine: null });
r.noScanVerify = s2.ok ? 'took it' : s2.code; if (s2.ok) s2.lk.release(); if (s1.ok) s1.lk.release();
console.log(JSON.stringify(r));
`, { ...st.env, STUDIO_HEAVY_SLOTS: '1', STUDIO_HEAVY_MAX_UNITY: 'off', ...scan });
    const r = p.j || {};
    return [r.land === 'took it' && r.verify === 'took it' && r.claimEngine === 'unity' && r.land2 === 'HEAVY_BUSY' && /engine line is full/.test(r.land2Msg) && r.offVerify === 'HEAVY_BUSY' && r.noScanVerify === 'HEAVY_BUSY', `${JSON.stringify(r)}\n${p.text.slice(-500)}`];
  });
  await guard('2.78.1 (f, B-117b): an engine land gives way to the game\'s merge train: it waits while a train verify (a landing verify) holds a slot, and while a quiet hold is up (a flake check\'s quiet re-run), naming them; a game landing still goes through the hold (fails on 2.78.0: the land is a landing, so it started beside the train\'s verify and through the quiet hold)', async () => {
    const p = probe(S, `import * as H from ${u(S, 'harness/heavy.mjs')};
${TAKE}
const root = process.cwd();
const land = { kind: 'unity', engine: 'unity', env: { STUDIO_GATE_PRIORITY: 'landing' } };
const r = {};
const tv = take(H, root, 'train verify', { kind: 'verify', owner: 'train-t1', env: { STUDIO_GATE_PRIORITY: 'landing', STUDIO_LOCK_OWNER: 'train-t1' } });
const e1 = take(H, root, 'unity land', land);
r.besideTrain = e1.ok ? 'took it' : e1.code; r.besideMsg = e1.msg || ''; if (e1.ok) e1.lk.release();
if (tv.ok) tv.lk.release();
H.clearTrainWait(root);
H.markQuietHold(root, { ms: 120000, owner: 'train-t2-flake', file: 'a.test.mjs', why: 'the quiet re-run of a.test.mjs' });
const e2 = take(H, root, 'unity land', land);
r.duringHold = e2.ok ? 'took it' : e2.code; r.holdMsg = e2.msg || ''; if (e2.ok) e2.lk.release();
const g = take(H, root, 'train check', { kind: 'verify', env: { STUDIO_GATE_PRIORITY: 'landing' } });
r.gameLanding = g.ok ? 'took it' : g.code; if (g.ok) g.lk.release();
H.clearQuietHold(root); H.clearTrainWait(root);
console.log(JSON.stringify(r));
`, { ...st.env, STUDIO_HEAVY_SLOTS: '3' });
    const r = p.j || {};
    return [r.besideTrain === 'HEAVY_BUSY' && /merge train verifying/.test(r.besideMsg) && r.duringHold === 'HEAVY_BUSY' && /quiet/.test(r.holdMsg) && r.gameLanding === 'took it', `${JSON.stringify(r)}\n${p.text.slice(-500)}`];
  });
  await guard('2.78.1 (f, B-117b): the Unity land gate (harness/unity-gate.mjs runUnityGate) takes the engine line: its land command runs while a builder\'s verify holds the only game slot, and the slot record it ran under names engine "unity" (fails on 2.78.0: the land waited for the game slot and was refused)', async () => {
    writeIn(S, 'land-2781f.mjs', "import fs from 'node:fs'; import path from 'node:path'; const d = path.join(process.cwd(), '.studio', 'locks'); const recs = fs.readdirSync(d).filter((f) => /^machine-heavy-\\d+\\.lock$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))); fs.writeFileSync('land-saw-2781f.json', JSON.stringify(recs.map((x) => ({ label: x.label, engine: x.claim?.engine || null })))); process.exit(0);\n");
    const gf = path.join(S, 'studio', 'game.json');
    const had = fs.existsSync(gf);
    const g = had ? JSON.parse(fs.readFileSync(gf, 'utf8')) : {};
    writeIn(S, 'studio/game.json', `${JSON.stringify({ ...g, engines: { ...(g.engines || {}), unity: { land: 'node land-2781f.mjs' } } }, null, 2)}\n`);
    const p = probe(S, `import * as H from ${u(S, 'harness/heavy.mjs')};
import { runUnityGate } from ${u(S, 'harness/unity-gate.mjs')};
${TAKE}
const root = process.cwd();
const v = take(H, root, 'builder verify', { kind: 'verify' });
const res = await runUnityGate({ engine: 'unity', env: { ...process.env, STUDIO_HEAVY_HELD: '', STUDIO_GATE_PRIORITY: 'landing' } });
if (v.ok) v.lk.release();
console.log(JSON.stringify({ verify: v.ok, status: res.status, why: String(res.why || '').slice(0, 300) }));
`, { ...st.env, STUDIO_HEAVY_SLOTS: '1', ...scan });
    if (had) writeIn(S, 'studio/game.json', `${JSON.stringify(g, null, 2)}\n`); else fs.rmSync(gf, { force: true });
    let saw = null; try { saw = JSON.parse(fs.readFileSync(path.join(S, 'land-saw-2781f.json'), 'utf8')); } catch {}
    const r = p.j || {};
    return [r.verify && r.status === 'pass' && Array.isArray(saw) && saw.some((x) => x.engine === 'unity') && saw.some((x) => x.label === 'builder verify'), `${JSON.stringify(r)} saw=${JSON.stringify(saw)}\n${p.text.slice(-500)}`];
  });

  // ---- rig-aware: an engine train's RAM between its land runs ----
  await guard('2.78.1 (f, rig): a running Unity train (its lock live, no land holding a slot right now) takes 8 GB off the room for builders: the supervisor\'s session cap and the Line Producer\'s heavy-budget rig both count it, and a land that holds its slot is not counted twice (fails on 2.78.0: only machine:heavy claims counted)', async () => {
    const p = probe(S, `import fs from 'node:fs'; import path from 'node:path';
import * as HB from ${u(S, 'harness/heavy-budget.mjs')};
import { rigNow } from ${u(S, 'harness/line-producer.mjs')};
const root = process.cwd();
const profile = { at: Date.now(), ram: { totalGb: 32, freeGb: 30 }, cores: { logical: 28 } };
const lockF = path.join(root, '.studio', 'locks', 'unity-train.lock');
const r = {};
r.before = HB.sessionCap({ configured: 60, profile, holders: [], root, heavyRoot: root }).byRam;
r.rigBefore = (await rigNow({ env: { ...process.env, STUDIO_LINE_RIG: 'heavy' }, deps: { profile, holders: [] } })).byRam;
fs.mkdirSync(path.dirname(lockF), { recursive: true });
fs.writeFileSync(lockF, JSON.stringify({ pid: process.pid, at: Date.now(), id: 'u1', by: 'line-producer', lanes: ['T-214'] }));
const cap = HB.sessionCap({ configured: 60, profile, holders: [], root, heavyRoot: root });
r.during = cap.byRam; r.why = cap.why || '';
r.rigDuring = (await rigNow({ env: { ...process.env, STUDIO_LINE_RIG: 'heavy' }, deps: { profile, holders: [] } })).byRam;
const landing = [{ pid: process.pid, at: Date.now(), label: 'unity land', claim: { kind: 'unity', ramGb: 8, cpuThreads: 4, engine: 'unity' } }];
r.reserveWhileLanding = HB.engineTrainReserve(root, landing).gb;
fs.rmSync(lockF, { force: true });
console.log(JSON.stringify(r));
`, st.env);
    const r = p.j || {};
    // 32 GB - 4 GB reserve = 28 GB: 46 sessions at 0.6 GB; with the train's 8 GB: 20 GB, 33. The rig at 1 GB a builder: 28, then 20.
    return [r.before === 46 && r.during === 33 && r.rigBefore === 28 && r.rigDuring === 20 && r.reserveWhileLanding === 0 && /unity train/.test(r.why), `${JSON.stringify(r)}\n${p.text.slice(-400)}`];
  });

  // ---- B-121: a task in any train counts as in progress ----
  await guard('2.78.1 (f, B-121): a task whose branch is queued for the Unity train, or that is a lane of a running engine train, is held from a new launch (holdReason names the train); a task in no train is not (fails on 2.78.0: only the web train\'s queue counted, so the supervisor started a builder on it)', async () => {
    writeIn(S, '.studio/train/unity-queue.json', `${JSON.stringify([{ task: 'T-214', branch: 'unity/pass-14', head: 'abc', at: new Date().toISOString() }])}\n`);
    writeIn(S, '.studio/locks/godot-train.lock', JSON.stringify({ pid: process.pid, at: Date.now(), id: 'g1', by: 'line-producer', lanes: ['T-215'] }));
    const p = probe(S, `import { holdReason } from ${u(S, 'harness/task-hold.mjs')};
const q = { inProgress: [], backlog: [{ id: 'T-214', role: 'engine-porter', title: 'Pass 14' }, { id: 'T-215', role: 'engine-porter', title: 'Port 15' }, { id: 'T-216', role: 'engine-porter', title: 'Pass 16' }], done: [] };
console.log(JSON.stringify({ a: holdReason('T-214', q, Date.now(), {}), b: holdReason('T-215', q, Date.now(), {}), c: holdReason('T-216', q, Date.now(), {}) }));
`, st.env);
    fs.rmSync(path.join(S, '.studio', 'train', 'unity-queue.json'), { force: true });
    fs.rmSync(path.join(S, '.studio', 'locks', 'godot-train.lock'), { force: true });
    const r = p.j || {};
    return [/queued for the unity train/.test(r.a || '') && /in the godot train g1/.test(r.b || '') && r.c === null, `${JSON.stringify(r)}\n${p.text.slice(-400)}`];
  });

  // ---- chain-breaker push ----
  await guard('2.78.1 (f, push): a chain-breaker queued for the merge train leaves a quiet hold (tag chain-breaker): a builder\'s verify waits naming it, the train\'s landing check goes; queued longer than STUDIO_LINE_CHAIN_HOLD_MIN, or no chain-breaker queued, clears it; act false writes nothing (fails on 2.78.0: no push, builders\' verifies took the machine)', async () => {
    const p = probe(S, `import * as H from ${u(S, 'harness/heavy.mjs')};
import { chainBreakerPush } from ${u(S, 'harness/line-producer.mjs')};
${TAKE}
const root = process.cwd();
const now = Date.now();
const cbs = [{ task: 'T-173', n: 4, waiting: ['T-180', 'T-181', 'T-182', 'T-183'] }];
const r = {};
const dry = await chainBreakerPush({ chainBreakers: cbs, now, act: false, deps: { root, quiet: true, trainQueue: [{ task: 'T-173', at: new Date(now - 5 * 60000).toISOString() }] } });
r.dryHold = Boolean(H.quietHolding(root)); r.dry = dry.holding;
const on = await chainBreakerPush({ chainBreakers: cbs, now, act: true, deps: { root, quiet: true, trainQueue: [{ task: 'T-173', at: new Date(now - 5 * 60000).toISOString() }] } });
r.on = on.holding; r.hold = H.quietHolding(root)?.tag || null;
const b = take(H, root, 'builder verify', { kind: 'verify' });
r.builder = b.ok ? 'took it' : b.code; r.builderMsg = b.msg || ''; if (b.ok) b.lk.release();
const t = take(H, root, 'train check', { kind: 'verify', env: { STUDIO_GATE_PRIORITY: 'landing' } });
r.train = t.ok ? 'took it' : t.code; if (t.ok) t.lk.release();
H.clearTrainWait(root);
const old = await chainBreakerPush({ chainBreakers: cbs, now, act: true, deps: { root, quiet: true, trainQueue: [{ task: 'T-173', at: new Date(now - 90 * 60000).toISOString() }] } });
r.old = old.holding; r.oldWhy = old.why; r.afterOld = Boolean(H.quietHolding(root));
console.log(JSON.stringify(r));
`, { ...st.env, STUDIO_HEAVY_SLOTS: '3' });
    const r = p.j || {};
    return [r.dry === true && r.dryHold === false && r.on === true && r.hold === 'chain-breaker' && r.builder === 'HEAVY_BUSY' && /chain-breaker T-173/.test(r.builderMsg) && r.train === 'took it' && r.old === false && /STUDIO_LINE_CHAIN_HOLD_MIN/.test(r.oldWhy) && r.afterOld === false, `${JSON.stringify(r)}\n${p.text.slice(-500)}`];
  });

  // ---- Unity twins ----
  await guard('2.78.1 (f, twins): with studio/game.json engines.unity.twins listing game/demo/sim/**, a landed game task that changed game/demo/sim/fuel.mjs gets ONE Unity twin task (engine-porter, track engine:unity, branch unity/twin-t-401, --after the task and the open twin T-390), a landed docs-only task is reported "no twin needed", the first look only starts the record, and no twins listed means none (fails on 2.78.0: no twin pass)', async () => {
    const G = path.join(tmpRoot, `2781f-twins-${process.pid}-${++n}`);
    fs.mkdirSync(G, { recursive: true });
    gitIn(G, 'init', '-q', '-b', 'main');
    writeIn(G, 'README.md', 'x\n'); gitIn(G, 'add', '-A'); gitIn(G, 'commit', '-qm', 'start');
    writeIn(G, 'game/demo/sim/fuel.mjs', 'export const fuel = 1;\n'); gitIn(G, 'add', '-A'); gitIn(G, 'commit', '-qm', 'T-401: fuel ladder step 3');
    writeIn(G, 'docs/fuel.md', 'fuel\n'); gitIn(G, 'add', '-A'); gitIn(G, 'commit', '-qm', 'T-402 docs for the fuel ladder');
    writeIn(G, 'game/demo/sim/other.mjs', 'x\n'); gitIn(G, 'add', '-A'); gitIn(G, 'commit', '-qm', 'T-4010: another task');
    made.push(G);
    const p = probe(S, `import { twinPass } from ${u(S, 'harness/line-producer.mjs')};
const G = ${JSON.stringify(G)};
const t0 = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const events = [
  { type: 'task.added', task: 'T-401', ts: iso(t0 - 9000), msg: 'Queued T-401 [P1] (builder): Fuel ladder step 3', meta: {} },
  { type: 'task.added', task: 'T-402', ts: iso(t0 - 9000), msg: 'Queued T-402 [P1] (builder): Fuel docs', meta: {} },
  { type: 'task.done', task: 'T-401', ts: iso(t0 + 1000), msg: 'Completed T-401: Fuel ladder step 3 (merge train x)' },
  { type: 'task.done', task: 'T-402', ts: iso(t0 + 1000), msg: 'Completed T-402: Fuel docs' },
];
const calls = [];
const addTask = (o) => { calls.push(o); return { id: 'T-500' }; };
const queue = { inProgress: [], backlog: [{ id: 'T-390', title: 'Unity twin of T-380: fuel step 2' }], done: [] };
const engines = { unity: { twins: ['game/demo/sim/**'] } };
const none = await twinPass({ now: t0, act: true, deps: { root: G, engines: {}, events, queue, addTask } });
const first = await twinPass({ now: t0, act: true, deps: { root: G, engines, events: [], queue, addTask } });
const second = await twinPass({ now: t0 + 2000, act: true, deps: { root: G, engines, events, queue, addTask } });
const third = await twinPass({ now: t0 + 3000, act: true, deps: { root: G, engines, events, queue, addTask } });
console.log(JSON.stringify({ none: none.on, first: first.checked.length, second: second.checked, third: third.checked.length, calls }));
`, st.env);
    const r = p.j || {};
    const c = (r.calls || [])[0] || {};
    const docs = (r.second || []).find((x) => x.task === 'T-402');
    const ok = r.none === false && r.first === 0 && (r.calls || []).length === 1 && c.role === 'engine-porter' && c.meta?.track === 'engine:unity' && c.meta?.twinOf === 'T-401' && c.meta?.branch === 'unity/twin-t-401'
      && JSON.stringify(c.meta?.after) === JSON.stringify(['T-401', 'T-390']) && /^Unity twin of T-401: Fuel ladder step 3$/.test(c.title || '') && docs && docs.need === false && r.third === 0;
    return [ok, `${JSON.stringify(r).slice(0, 1500)}\n${p.text.slice(-400)}`];
  });

  // ---- M7: stage 1 says what it stepped; on the template while the studio has a game: warn (default), fail, off ----
  {
    writeIn(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'unit', command: 'node -e "process.exit(0)"' }] }, null, 2)}\n`);
    // --out: two runs in the same second share a report name (the run id is per second).
    const run = (extra, out) => spawnSync(process.execPath, ['qa/playtest.mjs', '--stage', '1', '--quiet', '--out', out], { cwd: S, windowsHide: true, encoding: 'utf8', env: { ...process.env, ...st.env, ...extra }, timeout: 60000 });
    const rep = (out) => { try { return JSON.parse(fs.readFileSync(path.join(S, out), 'utf8')); } catch { return null; } };
    const txt = (r) => `${r.stdout || ''}${r.stderr || ''}`;
    await guard('2.78.1 (f, M7): by default (STUDIO_PLAYTEST_GAME_CHECK warn) stage 1 in a studio whose game (STUDIO_GAME demo, with its own checks) isn\'t a cartridge still passes, says it stepped 300 ticks of example-sim and not demo, prints "WARN QA-STAGE1-NOT-THE-GAME: stage 1 played the template, not the studio\'s game", records studioGame, ofStudioGame false and the warning, and task done\'s check for a playtest task shows it as WARN; without a studio game there is no warning (fails on 2.78.0: it passed on the template silently, nothing recorded)', async () => {
      const w = run({ STUDIO_GAME: 'demo' }, 'qa/out-2781f-warn.json');
      const t = run({ STUDIO_GAME: '' }, 'qa/out-2781f-none.json');
      const rw = rep('qa/out-2781f-warn.json'); const rt = rep('qa/out-2781f-none.json');
      // done-check reads the newest stage 1 report in qa/reports: the one the warn run wrote, put back as the newest.
      const d = path.join(S, 'qa', 'reports');
      const newest = path.join(d, 'qa_9999-zz-2781f.json');
      if (rw) fs.writeFileSync(newest, JSON.stringify(rw));
      const dc = probe(S, `import { checkDone } from ${u(S, 'harness/done-check.mjs')};
const r = checkDone({ id: 'T-777', title: 'Playtest: a seeded run of the game', role: 'qa-playtester' }, 0);
console.log(JSON.stringify({ type: r.type, warnings: r.warnings || [], ok: r.ok }));
`, { ...st.env, STUDIO_GAME: 'demo' });
      fs.rmSync(newest, { force: true });
      const ok = w.status === 0 && /PASS: stepped 300 tick\(s\) of cartridge example-sim/.test(txt(w)) && /the studio's game is demo \(NOT played\)/.test(txt(w))
        && /WARN QA-STAGE1-NOT-THE-GAME: stage 1 played the template, not the studio's game/.test(txt(w))
        && rw?.passed === true && rw.stage1.studioGame === 'demo' && rw.stage1.ofStudioGame === false && rw.stage1.gameCheck === 'warn' && rw.stage1.warnings?.[0]?.id === 'QA-STAGE1-NOT-THE-GAME'
        && t.status === 0 && !/WARN QA-STAGE1/.test(txt(t)) && (rt?.stage1?.warnings || []).length === 0
        && dc.j?.type === 'playtest' && dc.j.warnings.some((x) => /^QA-STAGE1-NOT-THE-GAME: stage 1 played the template/.test(x));
      return [ok, `warn: ${w.status} ${txt(w).slice(-500)}\nnone: ${t.status} ${txt(t).slice(-200)}\ndone-check: ${JSON.stringify(dc.j)} ${dc.j ? '' : dc.text.slice(-400)}`];
    });
    await guard('2.78.1 (f, M7): STUDIO_PLAYTEST_GAME_CHECK=fail makes it the failure (exit 1, finding QA-STAGE1-NOT-THE-GAME, "NOT played"), off is the 2.78.0 pass with no warning, and a 0-tick stage still fails QA-STAGE1-RAN-NOTHING in the default warn mode (fails on 2.78.0: no fail mode, it passed)', async () => {
      const f = run({ STUDIO_GAME: 'demo', STUDIO_PLAYTEST_GAME_CHECK: 'fail' }, 'qa/out-2781f-fail.json');
      const o = run({ STUDIO_GAME: 'demo', STUDIO_PLAYTEST_GAME_CHECK: 'off' }, 'qa/out-2781f-off.json');
      const z = probe(S, `import { runStage1ProgrammaticQA } from ${u(S, 'qa/playtest.mjs')};
const r = await runStage1ProgrammaticQA({ seed: 1, ticks: 0.4 });
console.log(JSON.stringify({ passed: r.passed, ids: r.findings.map((x) => x.id), gameCheck: r.gameCheck }));
`, { ...st.env, STUDIO_GAME: 'demo' });
      const rf = rep('qa/out-2781f-fail.json'); const ro = rep('qa/out-2781f-off.json');
      const ok = f.status === 1 && /NOT played/.test(txt(f)) && rf?.stage1?.findings?.some((x) => x.id === 'QA-STAGE1-NOT-THE-GAME') && rf.stage1.gameCheck === 'fail'
        && o.status === 0 && !/WARN QA-STAGE1/.test(txt(o)) && (ro?.stage1?.warnings || []).length === 0 && ro?.stage1?.gameCheck === 'off'
        && z.j?.passed === false && z.j.ids.includes('QA-STAGE1-RAN-NOTHING') && z.j.gameCheck === 'warn';
      return [ok, `fail: ${f.status} ${txt(f).slice(-300)}\noff: ${o.status} ${txt(o).slice(-200)}\nzero: ${JSON.stringify(z.j)} ${z.j ? '' : z.text.slice(-300)}`];
    });
  }

  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch {} }
}
