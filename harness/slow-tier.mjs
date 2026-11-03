/**
 * harness/slow-tier.mjs — 2.69.0 (p): the nightly slow tier.
 *
 * A game's manifest (a protected file) may mark test globs slow ("slowTests": ["<glob>", ...]) or whole checks
 * ("tier": "slow" on a gate). Verifies and merge trains skip them (harness/game-gates.mjs planGameGates passes
 * STUDIO_TEST_EXCLUDE to the game's test command), so landing never waits for them. This module runs them on main:
 *   npm run gates -- --tier slow     (scripts/run-gates.mjs hands the run to slowTierCli)
 *   the supervisor, once a day at STUDIO_SLOW_HOUR (local hour, default 3; off = never), slowTierPass
 * Each failure is one bug task (builder, P1, "Bug: slow tier: ..."), deduped by check and test name: a failure whose
 * task is still open is not filed again (.studio/slow-tier.json keeps what was filed). At most STUDIO_SLOW_MAX_TASKS (10)
 * new tasks per run; the rest are named in the run's event. Nothing here can block a landing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { emitEvent } from './event.mjs';

const stateFile = (root) => path.join(root, '.studio', 'slow-tier.json');
const OFF = /^(off|0|false|no|never)$/i;

export function readSlowState(root) {
  try { const j = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); return j && typeof j === 'object' ? { filed: {}, ...j } : { filed: {} }; } catch { return { filed: {} }; }
}
function updateSlowState(root, fn) {
  const s = readSlowState(root);
  fn(s);
  try { fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true }); fs.writeFileSync(stateFile(root), JSON.stringify(s, null, 2)); } catch {}
  return s;
}

/** STUDIO_SLOW_HOUR: the local hour (0-23) the supervisor starts the slow tier; default 3; off: never. */
export function slowHour(env = process.env) {
  const v = String(env.STUDIO_SLOW_HOUR ?? '').trim();
  if (OFF.test(v)) return null;
  const n = Number(v);
  return v !== '' && Number.isInteger(n) && n >= 0 && n <= 23 ? n : 3;
}
const localDate = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Is the daily slow run due now? { due, why }. Once per local day, from STUDIO_SLOW_HOUR on, never two at once. */
export function slowTierDue(root, { now = Date.now(), env = process.env, declared = true } = {}) {
  const hour = slowHour(env);
  if (hour === null) return { due: false, why: 'STUDIO_SLOW_HOUR=off' };
  if (!declared) return { due: false, why: 'the game declares no slow tier' };
  if (new Date(now).getHours() < hour) return { due: false, why: `before ${hour}:00` };
  const s = readSlowState(root);
  if (s.running?.pid && alive(s.running.pid)) return { due: false, why: `a slow run is going (pid ${s.running.pid})` };
  if (s.lastStart?.date === localDate(now)) return { due: false, why: `already started today (${s.lastStart.at})` };
  return { due: true, why: `the daily slow tier (STUDIO_SLOW_HOUR ${hour})` };
}

/** One key per failure of a slow run's failed checks: the test names, else the failing files, else the check. */
export function failureKeys(rows = []) {
  const out = [];
  for (const r of rows.filter((x) => x && !x.ok && x.required !== false)) {
    const tests = Array.isArray(r.failures) && r.failures.length ? r.failures : Array.isArray(r.failingFiles) && r.failingFiles.length ? r.failingFiles : [''];
    for (const t of tests) out.push({ key: `${r.id}${t ? ` > ${t}` : ''}`, gate: r.id, test: t || null, why: String(r.why || '').slice(0, 300) });
  }
  return out;
}

export const slowTaskTitle = (f, main = 'main') => `Bug: slow tier: ${f.test ? `${f.test} (${f.gate})` : `${f.gate} fails`} on ${main}`.slice(0, 200);

/**
 * File one bug task per NEW failure: a key whose filed task is still open is skipped. deps: fileTask({ title, failure })
 * -> { id } | { error }, isOpen(taskId) -> bool. Returns { filed: [{ key, task }], known: [{ key, task }], over: [key] }.
 */
export function fileFailures(root, failures, { fileTask, isOpen = () => false, main = 'main', env = process.env, log = () => {} } = {}) {
  const cap = Number(env.STUDIO_SLOW_MAX_TASKS) > 0 ? Number(env.STUDIO_SLOW_MAX_TASKS) : 10;
  const res = { filed: [], known: [], over: [] };
  const s = readSlowState(root);
  for (const f of failures) {
    const prev = s.filed?.[f.key];
    if (prev?.task && isOpen(prev.task)) { res.known.push({ key: f.key, task: prev.task }); continue; }
    if (res.filed.length >= cap) { res.over.push(f.key); continue; }
    let t = null;
    try { t = fileTask?.({ title: slowTaskTitle(f, main), failure: f }); } catch (e) { log(`[slow-tier] ${f.key}: task not filed: ${e.message}`); }
    if (t?.id && !t.error && !t.proposed) res.filed.push({ key: f.key, task: t.id, duplicate: Boolean(t.duplicate) });
    else log(`[slow-tier] ${f.key}: no task filed (${t?.message || t?.error || 'no board here'})`);
  }
  updateSlowState(root, (st) => { st.filed = st.filed || {}; for (const x of res.filed) st.filed[x.key] = { task: x.task, at: new Date().toISOString() }; });
  return res;
}

/** The default deps: the board (harness/task.mjs, imported only when a failure is filed). */
async function boardDeps() {
  const { addTask, parseNextQueue } = await import('./task.mjs');
  return {
    fileTask: ({ title, failure }) => addTask({ title, role: 'builder', priority: 'P1', agent: 'slow-tier', meta: { type: 'bug', promoted: true, origin: 'harness', why: `the nightly slow tier: ${failure.key} fails on main`, slowTier: { key: failure.key, gate: failure.gate } } }),
    isOpen: (id) => { try { const q = parseNextQueue(); return [...q.inProgress, ...q.backlog].some((t) => t.id === id); } catch { return true; } },
  };
}

/**
 * Run the slow tier on the checkout at `root` (main): the game's slow checks and slow test globs only
 * (game-gates with STUDIO_GATE_TIER=slow), then one bug task per new failure. Returns { ok, none?, failures, filed,
 * known, over, ms, log }.
 */
export async function runSlowTier({ root, env = process.env, log = (m) => console.log(m), deps = null } = {}) {
  const gg = await import('./game-gates.mjs');
  const game = await gg.studioGame();
  const tier = game ? gg.slowTierOf(game) : null;
  if (!tier || gg.slowTierOff(env)) {
    log(`[slow-tier] nothing to run: ${gg.slowTierOff(env) ? 'STUDIO_SLOW_TIER=off (every test runs in every verify)' : 'the game declares no slow tier ("slowTests": [<globs>] or "tier": "slow" on a check in its studio.gates.json)'}`);
    let canaries = null; // 2.72.0 (b): a game with canaries and no slow tier still gets its nightly canary run
    if (game && !gg.slowTierOff(env) && gg.declaredGates(game).some((g) => g.canary)) { try { canaries = (await (await import('./canaries.mjs')).runCanaries({ root, env, log })).counts; } catch (err) { log(`[slow-tier] note: canaries not run (${err.message})`); } }
    return { ok: true, none: true, failures: [], filed: [], known: [], over: [], canaries };
  }
  const t0 = Date.now();
  const head = (spawnSync('git', ['rev-parse', 'HEAD'], { windowsHide: true, cwd: root, encoding: 'utf8' }).stdout || '').trim() || null;
  const main = (spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { windowsHide: true, cwd: root, encoding: 'utf8' }).stdout || '').trim() || 'main';
  const at = new Date().toISOString();
  updateSlowState(root, (s) => { s.lastStart = { at, date: localDate(Date.now()), head }; s.running = { pid: process.pid, at }; });
  log(`[slow-tier] running the slow tier on ${main} at ${String(head || '?').slice(0, 8)}: ${[...tier.gates, ...(tier.globs.length ? [`tests ${tier.globs.join(', ')}`] : [])].join('; ')}`);
  const runEnv = { ...env, STUDIO_GATE_TIER: 'slow', STUDIO_LOCK_OWNER: env.STUDIO_LOCK_OWNER || 'slow-tier' };
  for (const k of ['STUDIO_GATE_CHANGED', 'STUDIO_GATE_PATHS', 'STUDIO_GATE_RELATED', 'STUDIO_GATE_RELATED_ONLY', 'STUDIO_WHOLE_GAME', 'STUDIO_GATE_FOCUS', 'STUDIO_GATE_INCOMING_FILE', 'STUDIO_TEST_EXCLUDE']) delete runEnv[k];
  const r = spawnSync(process.execPath, [path.join(root, 'harness', 'game-gates.mjs'), '--json'], { cwd: root, env: runEnv, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const logFile = path.join(root, '.studio', 'slow-tier-last.log');
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, text); } catch {}
  let j = null;
  try { j = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch {}
  const rows = Array.isArray(j?.rows) ? j.rows : [];
  const failures = j ? failureKeys(rows) : [{ key: 'slow tier', gate: 'slow tier', test: null, why: `game-gates gave no result (exit ${r.status})` }];
  const ok = r.status === 0 && Boolean(j?.ok);
  let filed = { filed: [], known: [], over: [] };
  if (!ok && failures.length) filed = fileFailures(root, failures, { ...(deps || (await boardDeps())), main, env, log });
  const ms = Date.now() - t0;
  updateSlowState(root, (s) => { s.running = null; s.lastRun = { at: new Date().toISOString(), date: localDate(Date.now()), head, ok, ran: rows.map((x) => x.id), failed: failures.map((f) => f.key), filed: filed.filed.map((f) => f.task), ms }; });
  const msg = ok ? `slow tier green on ${main} at ${String(head || '?').slice(0, 8)} (${rows.map((x) => x.id).join(', ') || 'nothing ran'}) in ${Math.round(ms / 1000)} s`
    : `slow tier red on ${main} at ${String(head || '?').slice(0, 8)}: ${failures.length} failure(s); filed ${filed.filed.map((f) => f.task).join(', ') || 'none'}${filed.known.length ? `; already filed: ${filed.known.map((f) => f.task).join(', ')}` : ''}${filed.over.length ? `; ${filed.over.length} more not filed (STUDIO_SLOW_MAX_TASKS)` : ''}`;
  log(`[slow-tier] ${msg}; log .studio/slow-tier-last.log`);
  for (const f of filed.filed) log(`[slow-tier] filed ${f.task}: ${f.key}`);
  for (const f of filed.known) log(`[slow-tier] ${f.key}: already filed as ${f.task} (still open)`);
  try { emitEvent({ type: 'gates.slow_tier', agent: 'slow-tier', to: ok ? null : 'producer', status: ok ? 'ok' : 'warn', msg: msg.slice(0, 500), meta: { head, ok, failures: failures.map((f) => f.key).slice(0, 50), filed: filed.filed, known: filed.known, over: filed.over, ms } }); } catch {}
  // 2.72.0 (b): the game checks' must-fail canaries (harness/canaries.mjs), report only: never changes the tier's result.
  let canaries = null;
  try { canaries = (await (await import('./canaries.mjs')).runCanaries({ root, env, log })).counts; } catch (err) { log(`[slow-tier] note: canaries not run (${err.message})`); }
  return { ok, failures, ...filed, ms, log: '.studio/slow-tier-last.log', canaries };
}

/** `npm run gates -- --tier slow` (scripts/run-gates.mjs): exit 1 when the slow tier is red. */
export async function slowTierCli(argv = [], { root = process.cwd(), env = process.env } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: npm run gates -- --tier slow   (the game\'s slow checks and slow tests, on this checkout; one bug task per new failure)'); return 0; }
  const res = await runSlowTier({ root, env });
  return res.ok ? 0 : 1;
}

/**
 * The supervisor's daily hook: when due, start `node scripts/run-gates.mjs --tier slow` in the main checkout, detached
 * (it outlives the pass; its output goes to .studio/slow-tier.log). Returns { started, why }.
 */
export async function slowTierPass({ root, now = Date.now(), env = process.env, dryRun = false, start = null } = {}) {
  let declared = false;
  try { const gg = await import('./game-gates.mjs'); const game = await gg.studioGame(); declared = Boolean(game && (gg.slowTierOf(game) || gg.declaredGates(game).some((g) => g.canary))) && !gg.slowTierOff(env); } catch {} // 2.72.0 (b): canaries alone make it due
  const d = slowTierDue(root, { now, env, declared });
  if (!d.due) return { started: false, why: d.why };
  if (dryRun) return { started: false, why: `due (${d.why}); dry run` };
  updateSlowState(root, (s) => { s.lastStart = { at: new Date(now).toISOString(), date: localDate(now), by: 'supervisor' }; });
  const script = path.join(root, 'scripts', 'run-gates.mjs');
  let pid = null;
  try {
    if (start) pid = start({ root, script });
    else {
      const fd = fs.openSync(path.join(root, '.studio', 'slow-tier.log'), 'a');
      const child = spawn(process.execPath, [script, '--tier', 'slow'], { cwd: root, env: { ...env, STUDIO_LOCK_OWNER: 'slow-tier' }, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
      child.unref();
      fs.closeSync(fd);
      pid = child.pid;
    }
  } catch (e) { return { started: false, why: `could not start it: ${e.message}` }; }
  try { emitEvent({ type: 'gates.slow_tier_start', agent: 'supervisor', msg: `started the nightly slow tier (${d.why}); output .studio/slow-tier.log`, meta: { pid } }); } catch {}
  return { started: true, pid, why: d.why };
}

