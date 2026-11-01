#!/usr/bin/env node
/**
 * harness/self-triage.mjs — 2.65.0 (hands-off by default): routine stops fixed from a fixed list, without a person.
 *
 *   node harness/self-triage.mjs status        the list, and what it did in the last 24 h
 *   node harness/self-triage.mjs pass          one pass now (the watchdog runs it on every pass)
 *
 * The list is data (harness/self-triage.json). Each fix is deterministic (a script, no model), is logged as one
 * selftriage.<fix> event naming its cause (agent "self-triage"), and runs at most once per cause per "onceHours" (6):
 * a cause that comes back inside that window was not routine, so it stays stopped for a person (one
 * selftriage.declined event says so). A stop whose cause is not on the list is never touched. STUDIO_SELF_TRIAGE=off
 * turns the whole list off; "on": false one fix.
 *   reap-orphans   a machine:heavy holder whose root died with its tree still running: kill the leftovers
 *                  (heavy.mjs killHolderTree, the same kill as `heavy.mjs stop`) and free the slot.
 *   rerun-timeout  a game check that timed out under load (its load factor was above 1: the B-17 timeout line) runs once
 *                  more at the cap, STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR (3) x its base; never past the cap
 *                  (harness/game-gates.mjs asks timeoutRerun).
 *   switch-tool    the supervisor halted because two sessions ended with exit 127/9009 (the tool isn't on PATH): when
 *                  another tool of the budget order is on PATH and not out of quota, the missing one is marked out for
 *                  onceHours (budget.mjs's quota file, so pickTool takes the next) and the halt is cleared as
 *                  `npm run studio:resume` clears it, by "self-triage" with the cause. A custom command (STUDIO_<ROLE>_CMD)
 *                  has no other tool: it stays halted.
 *   restart-hub    the War Room hub stopped answering (it answered on an earlier pass) while no supervisor runs (a
 *                  running supervisor restarts the hub itself): start it again.
 *   close-rescues  rescue tasks of a task that has landed are closed (task done does it on landing; this is the sweep).
 * Only static imports of event.mjs and fsafe.mjs: supervisor.mjs, game-gates.mjs and watchdog.mjs import this module,
 * and everything else is imported inside the functions (no import cycle with a CLI that uses top-level await).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { writeAtomic } from './fsafe.mjs';

export const SELF_TRIAGE_REL = 'harness/self-triage.json';
export const SELF = 'self-triage';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const off = (v) => /^(off|0|false|no)$/i.test(String(v || ''));
const stateFile = (root) => path.join(root, '.studio', 'self-triage.json');

/** The list (harness/self-triage.json), with its defaults. */
export function readTriage(env = process.env) {
  const j = readJson(path.join(HERE, 'self-triage.json')) || {};
  const fixes = j.fixes && typeof j.fixes === 'object' ? j.fixes : {};
  return { onceHours: Math.max(0, num(j.onceHours, 6)), fixes, allOff: off(env.STUDIO_SELF_TRIAGE) };
}
/** Is this fix on the list and on? */
export function fixOn(fix, cfg = readTriage()) {
  return !cfg.allOff && Boolean(cfg.fixes[fix]) && cfg.fixes[fix].on !== false;
}

/**
 * May `fix` run for `cause` now (not run for that cause within onceHours)? { ok, last }. The record is in the main
 * checkout's .studio/self-triage.json (lane copies and train copies share it).
 */
export function mayApply(fix, cause, { root = REPO_ROOT, now = Date.now(), cfg = readTriage() } = {}) {
  if (!fixOn(fix, cfg)) return { ok: false, why: STUDIO_OFF(cfg, fix) };
  const st = readJson(stateFile(root)) || {};
  const last = Date.parse(st.fixes?.[`${fix}|${cause}`]?.at || '') || 0;
  if (last && now - last < cfg.onceHours * 3600000) return { ok: false, last, why: `already fixed once at ${new Date(last).toISOString().slice(11, 16)} UTC (at most once per cause per ${cfg.onceHours} h): it came back, so a person decides` };
  return { ok: true, last };
}
const STUDIO_OFF = (cfg, fix) => (cfg.allOff ? 'STUDIO_SELF_TRIAGE=off' : `${fix} is not on the self-triage list (or "on": false)`);

/** Record a fix: the state file and one selftriage.<fix> event. */
export function recordFix(fix, cause, { root = REPO_ROOT, now = Date.now(), msg = '', meta = {}, task } = {}) {
  const f = stateFile(root);
  const st = readJson(f) || {};
  st.fixes = { ...(st.fixes || {}), [`${fix}|${cause}`]: { at: new Date(now).toISOString(), msg: String(msg).slice(0, 200) } };
  // Forget entries older than a week.
  for (const [k, v] of Object.entries(st.fixes)) if (now - (Date.parse(v.at) || 0) > 7 * 86400000) delete st.fixes[k];
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); writeAtomic(f, `${JSON.stringify(st, null, 2)}\n`, { fsync: false }); } catch {}
  try { emitEvent({ type: `selftriage.${fix}`, agent: SELF, to: 'producer', ...(task ? { task } : {}), status: 'ok', msg: `Self-triage (${fix}): ${msg}`.slice(0, 600), meta: { fix, cause, ...meta } }); } catch {}
}
/** A cause on the list that can't be fixed again (or has no fix now): one selftriage.declined event per cause and window. */
export function declineFix(fix, cause, why, { root = REPO_ROOT, now = Date.now(), cfg = readTriage() } = {}) {
  const f = stateFile(root);
  const st = readJson(f) || {};
  const k = `${fix}|${cause}`;
  const last = Date.parse(st.declined?.[k] || '') || 0;
  if (last && now - last < cfg.onceHours * 3600000) return false;
  st.declined = { ...(st.declined || {}), [k]: new Date(now).toISOString() };
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); writeAtomic(f, `${JSON.stringify(st, null, 2)}\n`, { fsync: false }); } catch {}
  try { emitEvent({ type: 'selftriage.declined', agent: SELF, to: 'human', status: 'blocked', msg: `Self-triage left this for a person (${fix}, ${cause}): ${why}`.slice(0, 600), meta: { fix, cause, why } }); } catch {}
  return true;
}

// ---- rerun-timeout (asked by harness/game-gates.mjs) ----

/**
 * A game check timed out: run it once more? { rerun, ms, why }. Only under load (timing.factor > 1: the B-17 line
 * printed it) and only up to the cap (STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR x base): a check that already ran at the cap
 * gets nothing longer. Records the fix (once per check per onceHours) when it says yes.
 */
export function timeoutRerun({ gate, timing, base, root = REPO_ROOT, env = process.env, now = Date.now() } = {}) {
  const cfg = readTriage(env);
  if (!fixOn('rerun-timeout', cfg)) return { rerun: false, why: STUDIO_OFF(cfg, 'rerun-timeout') };
  if (!(Number(timing?.factor) > 1)) return { rerun: false, why: 'it timed out with no load measured (load factor 1): not a load timeout' };
  const cap = Math.round(Number(base) * Math.max(1, num(env.STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR, 3)));
  if (!(cap > Number(timing.ms))) return { rerun: false, why: `it already ran at the cap (${Math.round(cap / 1000)} s, STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR x the base)` };
  const cause = String(gate || 'game check');
  const may = mayApply('rerun-timeout', cause, { root, now, cfg });
  if (!may.ok) { declineFix('rerun-timeout', cause, may.why, { root, now, cfg }); return { rerun: false, why: may.why }; }
  recordFix('rerun-timeout', cause, { root, now, msg: `${cause} timed out after ${Math.round(timing.ms / 1000)} s under load (factor ${timing.factor}${timing.why ? `: ${String(timing.why).slice(0, 160)}` : ''}); running it once more at the cap, ${Math.round(cap / 1000)} s`, meta: { gate: cause, timeoutMs: timing.ms, rerunMs: cap, baseMs: Number(base), factor: timing.factor } });
  return { rerun: true, ms: cap, why: `self-triage: timed out under load (factor ${timing.factor}); once more at the cap, ${Math.round(cap / 1000)} s` };
}

// ---- switch-tool (a supervisor halt) ----

const PROGRAM = { nim: 'aider', claude: 'claude', codex: 'codex', agy: 'agy', gemini: 'gemini', cursor: 'cursor-agent' };
// Test hook: STUDIO_TEST_ON_PATH=<a,b> stands in for the PATH lookup (the programs listed are on PATH, no others).
const defaultOnPath = (prog) => (process.env.STUDIO_TEST_ON_PATH !== undefined
  ? process.env.STUDIO_TEST_ON_PATH.split(',').map((x) => x.trim()).includes(prog)
  : spawnSync(process.platform === 'win32' ? 'where' : 'which', [prog], { encoding: 'utf8', windowsHide: true }).status === 0);

/** The halt's cause on the list: { fix, cause } or null (unknown: a person decides). */
export function haltCause(halted, cfg = readTriage()) {
  if (!halted) return null;
  const st = cfg.fixes['switch-tool'] || {};
  const codes = Array.isArray(st.codes) ? st.codes.map(Number) : [127, 9009];
  let words = null;
  try { words = new RegExp(st.words || "wasn't found", 'i'); } catch { words = /wasn't found/i; }
  if (codes.includes(Number(halted.code)) || (halted.missing === true) || words.test(String(halted.why || ''))) return { fix: 'switch-tool', cause: `tool-missing:${halted.tool || 'unknown'}` };
  return null;
}

/**
 * A halted supervisor (its status file's "halted"): fix it if its cause is on the list. Returns { fixed, fix, cause,
 * why }. Injectable for tests: onPath(program), resumeFile (where studio:resume writes), budget (the budget module).
 */
export async function triageHalt(halted, { root = REPO_ROOT, now = Date.now(), env = process.env, onPath = defaultOnPath, resumeFile = path.join(STUDIO_STATE_DIR, 'supervisor-resume'), budget = null } = {}) {
  const cfg = readTriage(env);
  const c = haltCause(halted, cfg);
  if (!c) return { fixed: false, why: `not on the self-triage list: ${String(halted?.why || 'no reason recorded').slice(0, 200)}` };
  if (!fixOn(c.fix, cfg)) return { fixed: false, ...c, why: STUDIO_OFF(cfg, c.fix) };
  if (fs.existsSync(resumeFile)) return { fixed: false, pending: true, ...c, why: 'a resume is already waiting for the supervisor\'s next pass' };
  const tool = String(halted.tool || '');
  if (halted.custom || !tool || tool === 'the agent tool') {
    const why = `${tool || 'the tool'} is a custom command (STUDIO_<ROLE>_CMD): there is no other tool to switch to`;
    declineFix(c.fix, c.cause, why, { root, now, cfg });
    return { fixed: false, ...c, why };
  }
  const may = mayApply(c.fix, c.cause, { root, now, cfg });
  if (!may.ok) { declineFix(c.fix, c.cause, may.why, { root, now, cfg }); return { fixed: false, ...c, why: may.why }; }
  const b = budget || (await import('./budget.mjs'));
  const order = [...new Set(['claude', 'codex', 'agy', ...((b.readBudget().order) || [])].map(String))];
  const base = (t) => t.split(':')[0];
  const next = order.find((t) => base(t) !== tool && !b.exhaustedUntil(t, now) && !b.exhaustedUntil(base(t), now) && onPath(PROGRAM[base(t)] || base(t)));
  if (!next) {
    const why = `${tool} isn't on PATH and no other tool in the budget order (${order.join(', ')}) is on PATH and in quota`;
    declineFix(c.fix, c.cause, why, { root, now, cfg });
    return { fixed: false, ...c, why };
  }
  const hours = Math.max(1, cfg.onceHours);
  b.markExhausted(tool, `self-triage: ${tool} was not found on PATH (exit ${halted.code}); switched to the next tool in the budget order`, now);
  // Hold the mark for the window, not markExhausted's default hour, so the missing tool isn't tried again at once.
  try {
    const q = readJson(b.QUOTA_FILE) || {};
    if (q[tool]) { q[tool].until = new Date(now + hours * 3600000).toISOString(); q[tool].selfTriage = true; fs.writeFileSync(b.QUOTA_FILE, `${JSON.stringify(q, null, 2)}\n`); }
  } catch {}
  const why = `${tool} not on PATH (two sessions ended with exit ${halted.code}): ${tool} marked out for ${hours} h, ${next} takes over`;
  fs.mkdirSync(path.dirname(resumeFile), { recursive: true });
  fs.writeFileSync(resumeFile, `${JSON.stringify({ by: SELF, why: `self-triage: ${why}`.slice(0, 300), via: SELF, at: new Date(now).toISOString() })}\n`);
  recordFix(c.fix, c.cause, { root, now, msg: `cleared the supervisor's halt: ${why}`, meta: { from: tool, to: next, code: halted.code, halt: String(halted.why || '').slice(0, 300) } });
  return { fixed: true, ...c, to: next, why };
}

// ---- reap-orphans ----

/** Gone machine:heavy holders whose trees still run: kill the leftovers, free the slot. Injectable: heavy, kill opts. */
export async function reapPass({ root = null, now = Date.now(), env = process.env, heavy = null, killOpts = {} } = {}) {
  const cfg = readTriage(env);
  if (!fixOn('reap-orphans', cfg)) return [];
  const h = heavy || (await import('./heavy.mjs'));
  const r0 = root || (await h.heavyRoot());
  const list = killOpts.listProcs || (await import('./proc-identity.mjs')).listProcesses;
  let procs = [];
  try { procs = list(); } catch { return []; }
  const actions = [];
  for (const rec of h.heavyRecords(r0, { env }).filter((x) => !x.live && h.holderGone(x))) {
    const t = h.holderTree(rec, procs);
    if (!t.members.length) continue;
    const cause = `${rec.label || 'heavy work'}:${rec.pid}`;
    const may = mayApply('reap-orphans', cause, { root: r0, now, cfg });
    if (!may.ok) { declineFix('reap-orphans', cause, may.why, { root: r0, now, cfg }); continue; }
    const k = h.killHolderTree(rec, { ...killOpts, listProcs: list });
    let freed = false;
    try { const f = path.join(h.heavyDir(r0), rec.file); const cur = readJson(f); if (cur?.pid === rec.pid && cur.at === rec.at) fs.rmSync(f, { force: true }); freed = !fs.existsSync(f) || readJson(f)?.pid !== rec.pid; } catch {}
    const msg = `${h.describeHolder(rec)} was gone with ${k.members.length} process(es) of its tree still running: killed ${k.killed.length}${k.survivors.length ? `, still running ${k.survivors.join(', ')}` : ''}${freed ? '; slot freed' : ''}`;
    recordFix('reap-orphans', cause, { root: r0, now, msg, meta: { label: rec.label || null, pid: rec.pid, killed: k.killed, survivors: k.survivors, freed } });
    actions.push({ kind: 'selftriage', msg: `self-triage reaped ${msg}` });
  }
  return actions;
}

// ---- restart-hub ----

const defaultHubUp = (port) => fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
const defaultSpawnHub = (root) => {
  const log = fs.openSync(path.join(root, '.studio', 'hub.log'), 'a');
  const p = spawn(process.execPath, [path.join(root, 'hub', 'server.mjs')], { cwd: root, stdio: ['ignore', log, log], env: process.env, detached: process.platform !== 'win32', windowsHide: true });
  p.unref();
  return p.pid;
};

/** The hub: remember it answered; when it stops answering and no supervisor runs, start it again (once per window). */
export async function hubPass({ root = REPO_ROOT, now = Date.now(), env = process.env, hubUp = defaultHubUp, spawnHub = defaultSpawnHub, supervisorAlive = null } = {}) {
  const cfg = readTriage(env);
  if (!fixOn('restart-hub', cfg)) return [];
  const port = Number(env.HUB_PORT || 3847);
  const f = stateFile(root);
  const up = await hubUp(port);
  const st = readJson(f) || {};
  if (up) {
    st.hubSeenAt = new Date(now).toISOString();
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); writeAtomic(f, `${JSON.stringify(st, null, 2)}\n`, { fsync: false }); } catch {}
    return [];
  }
  const seen = Date.parse(st.hubSeenAt || '') || 0;
  if (!seen || now - seen > 86400000) return []; // never up here (nobody runs a hub), or long ago: not a stop
  let sup = supervisorAlive;
  if (sup === null) {
    try {
      const { readStatus } = await import('./supervisor.mjs');
      const { pidAlive } = await import('./proc-identity.mjs');
      const s = readStatus();
      sup = Boolean(s?.status === 'running' && s.pid && pidAlive(s.pid, s.identity, { eperm: false }));
    } catch { sup = false; }
  }
  if (sup) return []; // the supervisor restarts the hub itself (its step 1)
  const cause = `hub-down:${port}`;
  const may = mayApply('restart-hub', cause, { root, now, cfg });
  if (!may.ok) { declineFix('restart-hub', cause, may.why, { root, now, cfg }); return []; }
  let pid = null;
  try { pid = spawnHub(root); } catch (e) { declineFix('restart-hub', cause, `couldn't start it: ${String(e.message || e).slice(0, 120)}`, { root, now, cfg }); return []; }
  const msg = `the War Room hub (port ${port}) stopped answering (last seen ${new Date(seen).toISOString().slice(11, 16)} UTC) and no supervisor runs: started it again${pid ? ` (pid ${pid})` : ''}`;
  recordFix('restart-hub', cause, { root, now, msg, meta: { port, pid } });
  return [{ kind: 'selftriage', msg: `self-triage: ${msg}` }];
}

// ---- close-rescues ----

/** Rescue tasks of tasks that have landed: closed (the sweep behind task done's own close). */
export async function rescueSweep({ now = Date.now(), env = process.env } = {}) {
  const cfg = readTriage(env);
  if (!fixOn('close-rescues', cfg)) return [];
  const { rescueOf, closeRescuesFor } = await import('./rescue.mjs');
  const { parseNextQueue, dropTask } = await import('./task.mjs');
  const q = parseNextQueue();
  const done = new Set(q.done.map((t) => t.id));
  const actions = [];
  for (const stuck of [...new Set([...q.backlog, ...q.inProgress].map((t) => rescueOf(t.title)).filter((id) => id && done.has(id)))]) {
    const closed = closeRescuesFor(stuck, { by: SELF, why: 'has landed', board: { parseNextQueue, dropTask } }).filter((r) => r.action === 'closed');
    if (!closed.length) continue;
    recordFix('close-rescues', `landed:${stuck}`, { now, task: stuck, msg: `${stuck} has landed: closed its rescue task${closed.length === 1 ? '' : 's'} ${closed.map((r) => r.id).join(', ')}`, meta: { stuck, closed: closed.map((r) => r.id) } });
    for (const r of closed) actions.push({ kind: 'selftriage', task: r.id, msg: `self-triage closed ${r.id}: ${stuck} has landed` });
  }
  return actions;
}

// ---- the pass (the watchdog runs it) ----

/** One pass over the list: a halted supervisor, orphaned heavy trees, the hub, landed lanes' rescues. Never throws. */
export async function selfTriagePass({ now = Date.now(), env = process.env, deps = {} } = {}) {
  const cfg = readTriage(env);
  if (cfg.allOff) return [];
  const actions = [];
  const step = async (name, fn) => { try { actions.push(...((await fn()) || [])); } catch (e) { actions.push({ kind: 'error', msg: `self-triage ${name}: ${String(e.message || e).slice(0, 160)}` }); } };
  await step('halt', async () => {
    const { readStatus } = deps.supervisor || (await import('./supervisor.mjs'));
    const s = readStatus();
    if (!s?.halted || s.status !== 'running') return [];
    const r = await triageHalt(s.halted, { now, env, ...(deps.halt || {}) });
    return r.fixed ? [{ kind: 'selftriage', msg: `self-triage cleared the supervisor's halt: ${r.why}` }] : [];
  });
  await step('reap', () => reapPass({ now, env, ...(deps.reap || {}) }));
  await step('hub', () => hubPass({ now, env, ...(deps.hub || {}) }));
  await step('rescues', () => rescueSweep({ now, env }));
  return actions;
}

/** What self-triage did since `since` (selftriage.* events), for the digest and status. */
export function triageDone(since, events = readRecentEvents(20000)) {
  return events.filter((e) => /^selftriage\./.test(e.type || '') && (Date.parse(e.ts) || 0) >= since);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'pass') {
    const a = await selfTriagePass();
    console.log(a.length ? a.map((x) => x.msg).join('\n') : 'Self-triage: nothing to fix.');
    process.exit(0);
  }
  if (cmd !== 'status') { console.log('Usage: node harness/self-triage.mjs status | pass'); process.exit(2); }
  const cfg = readTriage();
  console.log(`Self-triage (${SELF_TRIAGE_REL}; each fix at most once per cause per ${cfg.onceHours} h${cfg.allOff ? '; OFF: STUDIO_SELF_TRIAGE=off' : ''}):`);
  for (const [k, v] of Object.entries(cfg.fixes)) console.log(`  ${v.on === false ? 'off' : 'on '} ${k}: ${v.what || ''}`);
  const done = triageDone(Date.now() - 86400000);
  console.log(done.length ? `Last 24 h:\n${done.map((e) => `  ${String(e.ts).slice(11, 16)} ${e.msg}`).join('\n')}` : 'Last 24 h: nothing.');
}
