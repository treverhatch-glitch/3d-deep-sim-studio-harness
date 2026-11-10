#!/usr/bin/env node
/**
 * harness/stall.mjs — 2.30o: end a session that has stopped producing work.
 *
 * In the Marina run a Director planning session read about 2M tokens, wrote about 11.5k, ran 56 minutes
 * and landed nothing: session-cap only counts context and turns, so a session that keeps re-reading never
 * tripped it. Now every heartbeat (and every watchdog pass) asks:
 *   - progress: did the session write a file, commit, or change a task's state since its last progress?
 *     (fingerprint = HEAD + `git status --porcelain` of its working copy + its task.* events)
 *   - stall: no progress for STUDIO_STALL_MIN minutes (15; Producer/Director/planner: STUDIO_STALL_PLAN_MIN, 8)
 *   - burn: over the last STUDIO_STALL_RATIO_WINDOW_TOKENS (300000) input tokens the input:output ratio
 *     passed STUDIO_STALL_RATIO (120:1) with no progress in that window. 2.77.3 (B-109): the input counted here is
 *     uncached input plus cache creation only: a cache read is the same context re-read on every turn (an Opus turn
 *     re-reads ~100k tokens), not new work, and it ended a session after 4 min ("read 2169593, wrote 267"). And no burn
 *     verdict in the first STUDIO_STALL_GRACE_MIN (15) minutes of a session. STUDIO_STALL_RATIO=0 turns the check off.
 *   - wall clock: the session ran longer than STUDIO_SESSION_MAX_MIN (90; planning roles
 *     STUDIO_SESSION_PLAN_MAX_MIN, 25)
 * A stalled session is ended and its task handed back with the reason (event session.stall). 0 turns a
 * limit off; STUDIO_STALL=off turns the whole check off.
 * 2.73.1 (B-68): a session waiting on its own verify (npm run verify, detached or in-process: .studio/verify-running/
 * <agent>.json or a full*.json it owns, with a live process and no result yet) or on its own background `task done`
 * (.studio/done-running/, any task, by agent) is busy, not stalled: the stall clock is held and the wall-clock cap
 * may run over while it waits. Bounded: a verify counts for at most STUDIO_STALL_VERIFY_MAX_MIN (60) minutes from its
 * start (a done for STUDIO_DONE_RUNNING_MAX_MIN, 90), and the wall-clock cap stretches by at most
 * STUDIO_STALL_VERIFY_MAX_MIN in all; after that the clocks run as before, so a hung verify can't keep a session alive.
 * 2.64.0: each observation also runs the drift checks (driftCheck below: the same gate failing the same way 3 times,
 * verify runs with no new diff, edits outside the task's lane and claims). Those only raise a Check to the Producer.
 *
 *   node harness/stall.mjs check [--json]     every running session's stall state and drift Checks (read-only)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { doneRunning } from './busy.mjs';
import { pidAlive } from './proc-identity.mjs';
import { laneOf, laneList } from './task-hold.mjs';
import { listLocks } from './lock.mjs';
import { boardStates } from './train-deps.mjs';

import { PLANNING_ROLES } from './planning-roles.mjs';
export { PLANNING_ROLES };
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
export function stallLimits(role, env = process.env) {
  const plan = PLANNING_ROLES.has(String(role || '').toLowerCase());
  return {
    stallMin: plan ? num(env.STUDIO_STALL_PLAN_MIN, 8) : num(env.STUDIO_STALL_MIN, 15),
    maxMin: plan ? num(env.STUDIO_SESSION_PLAN_MAX_MIN, 25) : num(env.STUDIO_SESSION_MAX_MIN, 90),
    ratio: num(env.STUDIO_STALL_RATIO, 120),
    ratioWindow: num(env.STUDIO_STALL_RATIO_WINDOW_TOKENS, 300000),
    graceMin: num(env.STUDIO_STALL_GRACE_MIN, 15),
    busyMaxMin: num(env.STUDIO_STALL_VERIFY_MAX_MIN, 60),
  };
}

/**
 * 2.73.1 (B-68): what the session is waiting on that it started itself, or null: its own running verify (the detached
 * run's record .studio/verify-running/<agent>.json with no result for its runId and a live host process, or a
 * full*.json in-process record it owns with a live pid) or its own background task done (.studio/done-running/<task>.json
 * naming it, or its task's). { kind: 'verify'|'task done', since, pid, file }. A verify older than
 * STUDIO_STALL_VERIFY_MAX_MIN (60) minutes, or a done past STUDIO_DONE_RUNNING_MAX_MIN (90), doesn't count.
 */
export function busyWait(session, { dir = STUDIO_STATE_DIR, now = Date.now(), env = process.env, alive = pidAlive } = {}) {
  const agent = String(session?.agent || '');
  if (!agent) return null;
  const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const vmax = num(env.STUDIO_STALL_VERIFY_MAX_MIN, 60) * 60000;
  const fresh = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) && now - t >= -60000 && now - t < vmax; };
  const vdir = path.join(dir, 'verify-running');
  if (/^[\w.-]+$/.test(agent)) {
    const st = rd(path.join(vdir, `${agent}.json`));
    const res = rd(path.join(vdir, `${agent}.result.json`));
    if (st?.runId && (!st.owner || st.owner === agent) && res?.runId !== st.runId && st.state !== 'done' && fresh(st.startedAt)) {
      // A run still starting has no host yet: the process that asked for it (by) stands in for a minute.
      const pid = st.hostPid || (now - Date.parse(st.startedAt) < 60000 ? st.by : null);
      if (pid && alive(pid)) return { kind: 'verify', since: st.startedAt, pid, file: `verify-running/${agent}.json` };
    }
  }
  let names = [];
  try { names = fs.readdirSync(vdir).filter((f) => /^full(\.[0-9a-f]+)?\.json$/.test(f)); } catch {}
  for (const f of names) {
    const r = rd(path.join(vdir, f));
    if (r?.owner === agent && r.pid && fresh(r.startedAt) && alive(r.pid, r.identity)) return { kind: 'verify', since: r.startedAt, pid: r.pid, file: `verify-running/${f}` };
  }
  const own = session.task ? doneRunning(session.task, { dir, now, env }) : null;
  if (own) return { kind: 'task done', since: own.at, pid: own.pid, file: `done-running/${own.task || session.task}.json` };
  let dones = [];
  try { dones = fs.readdirSync(path.join(dir, 'done-running')).filter((f) => f.endsWith('.json')); } catch {}
  for (const f of dones) {
    const r = rd(path.join(dir, 'done-running', f));
    if (r?.agent !== agent) continue;
    const d = doneRunning(f.slice(0, -5), { dir, now, env });
    if (d) return { kind: 'task done', since: d.at, pid: d.pid, file: `done-running/${f}` };
  }
  return null;
}

const DIR = path.join(STUDIO_STATE_DIR, 'stall');
const stateFile = (agent) => path.join(DIR, `${agent}.json`);
export function readStall(agent) {
  try { return JSON.parse(fs.readFileSync(stateFile(agent), 'utf8')); } catch { return null; }
}
function writeStall(agent, s) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(stateFile(agent), `${JSON.stringify(s, null, 2)}\n`);
}
export const clearStall = (agent) => fs.rmSync(stateFile(agent), { force: true });

/** What the session has produced so far, as one hash. */
export function progressFingerprint(agent, cwd = REPO_ROOT, events = readRecentEvents(5000)) {
  const g = (...a) => spawnSync('git', a, { windowsHide: true, cwd, encoding: 'utf8' });
  const head = g('rev-parse', 'HEAD').stdout?.trim() || '';
  const st = g('status', '--porcelain', '--untracked-files=all').stdout || '';
  // mtimes of changed files, so a rewrite of an already-dirty file counts as a write
  const times = st.split('\n').filter(Boolean).map((l) => l.slice(3).trim()).map((f) => { try { return `${f}:${fs.statSync(path.join(cwd, f)).mtimeMs}`; } catch { return f; } });
  // Not a git checkout: the newest file times stand in (bounded walk).
  if (!head) {
    let seen = 0;
    const walk = (d, depth) => {
      if (depth > 4 || seen > 5000) return;
      let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (/^(node_modules|\.git|\.studio|\.lanes)$/.test(e.name)) continue;
        const p = path.join(d, e.name); seen++;
        if (e.isDirectory()) walk(p, depth + 1);
        else { try { times.push(`${p}:${fs.statSync(p).mtimeMs}`); } catch {} }
      }
    };
    walk(cwd, 0);
    times.sort();
  }
  const ev = events.filter((e) => e.agent === agent && /^(task\.|verdict\.|visual\.)/.test(e.type || '')).length;
  return crypto.createHash('sha1').update(`${head}\n${times.join('\n')}\n${ev}`).digest('hex');
}

/**
 * Pure verdict. s = { role, startedAt, lastProgressAt, tokensIn, tokensOut, windowIn, windowOut }
 * (window* = tokens since the last progress). Returns { stalled, kind, why }.
 */
export function stallVerdict(s, now = Date.now(), lim = stallLimits(s.role)) {
  const ran = (now - Date.parse(s.startedAt)) / 60000;
  const quiet = (now - Date.parse(s.lastProgressAt || s.startedAt)) / 60000;
  // 2.73.1 (B-68): waiting on its own verify or task done (s.busy, set by observe) stretches the wall-clock cap, by at
  // most STUDIO_STALL_VERIFY_MAX_MIN in all.
  const stretch = s.busy ? Math.max(0, num(lim.busyMaxMin, 60)) : 0;
  if (lim.maxMin > 0 && ran >= lim.maxMin + stretch) return { stalled: true, kind: 'wall-clock', why: `ran ${Math.round(ran)} min, past the ${lim.maxMin} min cap for a ${s.role} session${stretch ? ` (+${stretch} min while it waits on its own ${s.busy.kind}, STUDIO_STALL_VERIFY_MAX_MIN)` : ''}` };
  if (lim.stallMin > 0 && quiet >= lim.stallMin) return { stalled: true, kind: 'no-progress', why: `no file write, commit or task change for ${Math.round(quiet)} min (limit ${lim.stallMin})` };
  const wi = Number(s.windowIn || 0); const wo = Number(s.windowOut || 0);
  if (lim.ratio > 0 && lim.ratioWindow > 0 && ran >= num(lim.graceMin, 15) && wi >= lim.ratioWindow && wi / Math.max(1, wo) >= lim.ratio) return { stalled: true, kind: 'read-burn', why: `read ${wi} tokens and wrote ${wo} (${Math.round(wi / Math.max(1, wo))}:1, limit ${lim.ratio}:1) with no progress` };
  return { stalled: false, kind: null, why: '', ranMin: Math.round(ran), quietMin: Math.round(quiet) };
}

/**
 * One observation for a running session (called from the launcher's heartbeat and the watchdog).
 * tokens = { in, out } so far. Updates .studio/stall/<agent>.json and returns the verdict.
 */
export function observe(session, { tokens = { in: 0, out: 0 }, cwd = REPO_ROOT, now = Date.now(), events } = {}) {
  // 2.64.0: the drift checks ride the same observation (heartbeat and watchdog). They only raise Check events.
  // At most once per STUDIO_DRIFT_EVERY_S (120 s) per session, like the watchdog's pass: each check runs git (status,
  // log) synchronously, and on Windows a heartbeat that ran them every beat held the launcher up (CI #49: sessions
  // ended late, a supervisor test's lanes never started).
  const every = Number(process.env.STUDIO_DRIFT_EVERY_S ?? 120) * 1000;
  let driftFresh = false;
  try { driftFresh = readDrift(session.agent)?.startedAt === session.startedAt && now - fs.statSync(driftFile(session.agent)).mtimeMs < every; } catch {}
  if (!driftFresh && !/^off$/i.test(process.env.STUDIO_DRIFT || '')) {
    events = events || readRecentEvents(5000); // read once for both checks
    try { driftCheck(session, { cwd, now, events }); } catch { /* a help, never a crash */ }
  }
  if (/^off$/i.test(process.env.STUDIO_STALL || '')) return { stalled: false, kind: null, why: 'STUDIO_STALL=off' };
  const fp = progressFingerprint(session.agent, cwd, events);
  const prev = readStall(session.agent);
  const fresh = !prev || prev.startedAt !== session.startedAt;
  // 2.77.3 (B-109): the burn ratio counts uncached input + cache creation (tokens.fresh from logTokens), not cache reads.
  tokens = { ...tokens, in: tokens.fresh ?? tokens.in };
  let s = fresh ? { agent: session.agent, role: session.role, startedAt: session.startedAt, fp, lastProgressAt: session.startedAt, baseIn: 0, baseOut: 0 } : prev;
  // 2.76.0 (B-83, the crew's W-0070): fewer tokens than the last observation means the count started over (a new Claude
  // session inside this launcher run: logTokens counts only the newest one). The window starts again from here, so the
  // old session's base can neither kill the new one nor hide a real burn behind a base it never reaches. The
  // no-progress clock is kept (the crew's local patch reset it to the session's start, which could end a long session
  // on its next beat).
  if (!fresh && Number(tokens.in) < Number(prev.tokensIn || 0)) s = { ...s, baseIn: Number(tokens.in) || 0, baseOut: Number(tokens.out) || 0, recounted: new Date(now).toISOString() };
  // 2.30q (#6): a session waiting on its own task done (gates, landing) is busy, not stalled. 2.73.1 (B-68): so is one
  // waiting on its own verify, and a done of any task it runs (busyWait above, bounded by STUDIO_STALL_VERIFY_MAX_MIN).
  let doing = null;
  try { doing = busyWait(session, { now }); } catch { doing = null; }
  if (!fresh && (fp !== prev.fp || doing)) s = { ...s, fp, lastProgressAt: new Date(now).toISOString(), baseIn: tokens.in, baseOut: tokens.out };
  // While it waits, the wall-clock cap stretches (stallVerdict): never past the cap + STUDIO_STALL_VERIFY_MAX_MIN.
  s.busy = doing ? { kind: doing.kind, since: doing.since, pid: doing.pid, file: doing.file } : null;
  s.tokensIn = tokens.in; s.tokensOut = tokens.out;
  s.windowIn = tokens.in - (s.baseIn || 0); s.windowOut = tokens.out - (s.baseOut || 0);
  const v = stallVerdict(s, now);
  if (!v.stalled && s.busy) v.waiting = `on its own ${s.busy.kind} (pid ${s.busy.pid}, since ${String(s.busy.since || '').slice(11, 16)})`;
  s.verdict = v;
  writeStall(session.agent, s);
  return v;
}

/**
 * 2.76.0 (B-83): the lines of the newest Claude session in a log (stream-json lines carry "session_id"). A log that
 * holds two sessions (a second Claude process in one launcher run, a wrapper that restarts it) is cut to the last one;
 * lines without a session id (the launcher's own, another tool's) are kept. A log with no session id is returned whole.
 */
export function newestSessionPart(log) {
  const text = String(log || '');
  const ids = [...text.matchAll(/"session_id"\s*:\s*"([^"]+)"/g)];
  if (!ids.length) return text;
  const id = ids[ids.length - 1][1];
  if (ids.every((m) => m[1] === id)) return text;
  return text.split('\n').filter((l) => !/"session_id"\s*:/.test(l) || l.includes(`"${id}"`)).join('\n');
}

/**
 * 2.76.0 (B-83): the part of an agent log this session wrote: from byte `from` (the log's size when the session
 * started, recorded as the session's logFrom) to the end, at most `bytes` of its tail. The log is appended to across
 * sessions under one name, so the whole file counted the earlier sessions' tokens too. Never throws ('' on error).
 */
export function readLogFrom(file, from = 0, bytes = 2 * 1024 * 1024) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(Number(from) > 0 && Number(from) <= size ? Number(from) : 0, size - bytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

/** 2.76.0 (B-83): a new session under this name starts with no stall record (the last session's is dropped). */
export function resetStall(agent) {
  try { clearStall(agent); } catch { /* a guard, never a crash */ }
}

/** Cumulative tokens from a stream-json log (each assistant message's usage), for a live session. 2.76.0 (B-83): only
 * the newest Claude session's lines count (newestSessionPart). */
export function logTokens(log) {
  let tin = 0; let tfresh = 0; let tout = 0; const seen = new Set();
  for (const l of newestSessionPart(log).split(/\r?\n/)) {
    const t = l.trim();
    if (!t.startsWith('{')) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    const u = o.message?.usage || o.usage;
    if (!u) continue;
    const id = o.message?.id;
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    const plain = (u.input_tokens ?? u.prompt_tokens ?? 0) + (u.cache_creation_input_tokens || 0);
    tfresh += plain;
    tin += plain + (u.cache_read_input_tokens || u.cached_input_tokens || 0);
    tout += u.output_tokens ?? u.completion_tokens ?? 0;
  }
  // in = everything read (as before); fresh = without cache reads, which is what the read-burn ratio uses (2.77.3, B-109).
  return { in: tin, fresh: tfresh, out: tout };
}

/**
 * 2.30o: an idle session ends itself. idleSince = when it last held no task (null while it holds one).
 * Any role by default (STUDIO_IDLE_EXIT_ROLES, '*'); minutes: STUDIO_IDLE_EXIT_MIN (5, 0 = off). A session that
 * writes, commits or changes a task (stall.mjs progress) is not idle, so a planning pass that is writing stays.
 * Separate from the watchdog's whole-studio idle stop: this frees one slot.
 */
export function idleVerdict({ role, startedAt, idleSince }, now = Date.now(), env = process.env) {
  const roles = String(env.STUDIO_IDLE_EXIT_ROLES ?? '*').split(',').map((x) => x.trim()).filter(Boolean);
  const min = num(env.STUDIO_IDLE_EXIT_MIN, 5);
  if (!min || !(roles.includes('*') || roles.includes(String(role))) || !idleSince) return { exit: false };
  const since = Math.max(Date.parse(idleSince), Date.parse(startedAt || idleSince));
  const m = (now - since) / 60000;
  return m >= min ? { exit: true, why: `no task claimed for ${Math.round(m)} min (limit ${min})` } : { exit: false, idleMin: Math.round(m) };
}

/**
 * Log a stall once per session. 2.73.2 (B-72): the launcher's heartbeat and the watchdog's pass (the supervisor's, every few
 * minutes) both end a stalled session; the watchdog's guard read the listing's "stalled" (a heartbeat-age flag, not
 * this verdict), so "Ended builder-s122" was logged and the kill tried on every pass, 4 times in 6 minutes. The first
 * caller records the end in the session's stall state (ended: { at, by, kind, why }, for this startedAt) and logs it;
 * every later call for the same session returns false and logs nothing. by: 'launcher' or 'watchdog'.
 */
export function logStall(session, v, { by = 'launcher', now = Date.now() } = {}) {
  const prev = readStall(session.agent);
  const same = prev && prev.startedAt === session.startedAt;
  if (same && prev.ended) return false;
  const ended = { at: new Date(now).toISOString(), by, kind: v.kind || null, why: String(v.why || '').slice(0, 300) };
  try { writeStall(session.agent, { ...(same ? prev : { agent: session.agent, role: session.role, startedAt: session.startedAt }), ended }); } catch { /* the log below still goes out */ }
  emitEvent({ type: 'session.stall', agent: 'watchdog', to: 'producer', task: session.task || undefined, status: 'warn', msg: `Ended ${session.agent} (${session.role}${session.task ? `, ${session.task}` : ''}): ${v.why}`, meta: { kind: v.kind, target: session.agent, role: session.role, by } });
  return true;
}

/** 2.73.2 (B-72): the stall end recorded for this session (logStall), or null. */
export function stallEndOf(agent, startedAt) {
  const st = readStall(agent);
  return st && st.startedAt === startedAt && st.ended ? st.ended : null;
}

/*
 * 2.64.0: deterministic drift checks. Per running session, three signals that it is going round in circles or off
 * its brief, each raised ONCE per session as a "Check" event to the Producer (drift.check). They never stop, kill,
 * hand back or edit anything: the Producer (or a person) looks. No model judges here: research on long-running agents
 * found a model-based progress monitor hurt structured tasks. An optional advisory hook (setDriftAdvisor, used only
 * with STUDIO_DRIFT_ADVISOR=on) may add a note to a Check that was already raised; it can't raise, stop or clear one.
 *   gate-loop       the same gate failed with the same signature (gate id + its normalised output) STUDIO_DRIFT_SAME_FAIL
 *                   (3) times in the session's own verify runs
 *   verify-no-diff  STUDIO_DRIFT_SAME_DIFF (2) verify runs in a row with no change to its working copy since the verify
 *                   before (files dated after a verify or rewritten by it are "unknown", never "unchanged")
 *   out-of-scope    a file it edited (uncommitted, or committed under its own Studio-Agent trailer) outside its task's
 *                   lane and its claimed paths. No lane and no claim (the whole game) is not judged.
 * 2.65.0 (crew feedback 5) adds two:
 *   no-heartbeat      listed running, but its record has no heartbeat at all STUDIO_DRIFT_NOHEARTBEAT_MIN (5) minutes
 *                     after it started (a session whose tool never started, e.g. not on PATH)
 *   borrowed-commits  its lane holds commits of another OPEN task's unlanded lane (it merged that lane wholesale, or
 *                     carries commits tagged Studio-Task: <that task>): its own work now depends on unlanded work
 * STUDIO_DRIFT=off turns them off. State: .studio/drift/<agent>.json.
 */
// Files the harness writes for any task (the board, hand-offs, notes), and regression replays: never "out of scope".
const DRIFT_SCOPE_ALWAYS = ['studio/NEXT.md', 'studio/DONE.md', 'studio/CURRENT_TASK.md', 'studio/handoffs', 'studio/notes', 'studio/daily', 'studio/logs', 'studio/producer', 'qa/regressions'];
const DRIFT_DIR = path.join(STUDIO_STATE_DIR, 'drift');
const driftFile = (agent) => path.join(DRIFT_DIR, `${String(agent).replace(/[^\w.-]/g, '_')}.json`);
export function readDrift(agent) {
  try { return JSON.parse(fs.readFileSync(driftFile(agent), 'utf8')); } catch { return null; }
}
const advisor = { fn: null };
/** The optional advisory hook (off unless STUDIO_DRIFT_ADVISOR=on): fn({ session, signal, detail }) -> a short note. */
export function setDriftAdvisor(fn) { advisor.fn = typeof fn === 'function' ? fn : null; }

const h8 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
/** A failure's output, normalised: numbers, times, hex ids and paths' drive letters don't make it "different". */
export function failureSignature(text, lines = 40) {
  const tail = String(text || '').replace(/\r/g, '').trimEnd().split('\n').slice(-lines).join('\n');
  return h8(tail.replace(/\b[0-9a-f]{7,40}\b/gi, '#').replace(/\d+(\.\d+)?/g, '#').replace(/[A-Za-z]:\\/g, '/').replace(/\\/g, '/').replace(/[ \t]+/g, ' '));
}
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
const under = (f, p) => { const a = norm(f).toLowerCase(); const b = norm(p).toLowerCase(); return Boolean(b) && (a === b || a.startsWith(`${b}/`)); };

/** The working copy's changed files: [{ file, mtime|null }], plus HEAD and its commit time. */
function workingState(cwd) {
  const g = (...a) => spawnSync('git', a, { windowsHide: true, cwd, encoding: 'utf8' });
  const head = g('rev-parse', 'HEAD').stdout?.trim() || '';
  const headAt = (Number(g('log', '-1', '--format=%ct').stdout?.trim()) || 0) * 1000;
  const files = (g('status', '--porcelain', '--untracked-files=all').stdout || '').split('\n').filter((l) => l.length > 3)
    .map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '').trim())
    .filter((f) => !/^(\.studio|\.lanes|node_modules)\//.test(f))
    .map((f) => { let mtime = null; try { mtime = fs.statSync(path.join(cwd, f)).mtimeMs; } catch {} return { file: f, mtime }; });
  return { head, headAt, files };
}

/** The copy as it stood at a verify at time t: { fp, known } (known false when anything changed after t). */
function stateAt(ws, t, skip = new Set()) {
  let known = ws.head ? ws.headAt <= t : true;
  const parts = [`HEAD ${ws.head}`];
  for (const { file, mtime } of ws.files) {
    if (skip.has(file)) { known = false; continue; }
    if (mtime === null || mtime > t) { known = false; parts.push(`${file}:?`); } else parts.push(`${file}:${mtime}`);
  }
  return { fp: h8(parts.sort().join('\n')), known };
}

/** Files the session committed (its own Studio-Agent trailer) since its first observation. */
function ownCommits(cwd, base, agent) {
  if (!base) return [];
  const r = spawnSync('git', ['log', '--no-merges', '--format=%x1e%(trailers:key=Studio-Agent,valueonly,separator=%x2C)', '--name-only', `${base}..HEAD`], { windowsHide: true, cwd, encoding: 'utf8' });
  if (r.status !== 0) return [];
  const out = [];
  for (const block of r.stdout.split('\x1e').slice(1)) {
    const [who, ...names] = block.trim().split('\n');
    if (String(who || '').split(',').map((x) => x.trim()).includes(agent)) out.push(...names.filter(Boolean));
  }
  return out;
}

/** The session's scope: its task's lane (or the launcher's lane) and its path claims. [] = the whole game. */
export function sessionScope(session, { events, locks = listLocks() } = {}) {
  const held = locks.filter((l) => l.owner === session.agent);
  const task = held.find((l) => l.key.startsWith('task:'))?.key.slice(5) || session.task || null;
  let lane = session.lane || null;
  if (!lane && task) { try { lane = laneOf(task, events); } catch {} }
  const paths = [...laneList(lane || ''), ...held.filter((l) => l.key.startsWith('path:')).map((l) => l.key.slice(5))].map(norm).filter(Boolean);
  return { task, paths: [...new Set(paths)] };
}

/**
 * One drift observation for a running session. Returns the Checks raised by this call ([] mostly). Never acts on the
 * session. env: STUDIO_DRIFT, STUDIO_DRIFT_SAME_FAIL, STUDIO_DRIFT_SAME_DIFF, STUDIO_DRIFT_ADVISOR.
 */
export function driftCheck(session, { cwd = REPO_ROOT, now = Date.now(), events, env = process.env, locks } = {}) {
  if (/^off$/i.test(env.STUDIO_DRIFT || '') || !session?.agent || !session.startedAt) return [];
  const sameFail = num(env.STUDIO_DRIFT_SAME_FAIL, 3);
  const sameDiff = num(env.STUDIO_DRIFT_SAME_DIFF, 2);
  events = events || readRecentEvents(5000);
  const prev = readDrift(session.agent);
  let st = prev && prev.startedAt === session.startedAt ? prev : { agent: session.agent, startedAt: session.startedAt, seen: Date.parse(session.startedAt) || 0, fails: {}, last: null, sameDiff: 0, raised: {}, base: null };
  let ws = null;
  const working = () => (ws = ws || workingState(cwd));
  if (st.base === null) st.base = working().head || '';
  const raised = [];
  const scope = sessionScope(session, { events, locks: locks || listLocks() });
  const raise = (signal, why, detail) => {
    if (st.raised[signal]) return;
    st.raised[signal] = new Date(now).toISOString();
    let advice = null;
    if (/^on$/i.test(env.STUDIO_DRIFT_ADVISOR || '') && advisor.fn) {
      try { advice = String(advisor.fn({ session, signal, detail }) || '').trim().slice(0, 300) || null; } catch {}
    }
    const ev = { type: 'drift.check', agent: 'watchdog', to: 'producer', task: scope.task || undefined, status: 'warn', msg: `Check ${session.agent} (${session.role || 'agent'}${scope.task ? `, ${scope.task}` : ''}): ${why}. Nothing was stopped; look at it, then nudge, re-scope or hand it back.${advice ? ` Advice (not a verdict): ${advice}` : ''}`.slice(0, 600), meta: { signal, target: session.agent, role: session.role || null, ...detail, ...(advice ? { advice } : {}) } };
    emitEvent(ev);
    raised.push({ signal, why, detail });
  };

  // 2.65.0: listed running (agent.mjs sessions(): running) with no heartbeat ever (the launcher's record writes one at
  // once; a "starting" placeholder that never became a session has none).
  const nobeat = num(env.STUDIO_DRIFT_NOHEARTBEAT_MIN, 5);
  const ranMin = (now - (Date.parse(session.startedAt) || now)) / 60000;
  if (nobeat > 0 && session.running === true && !session.lastBeat && ranMin >= nobeat) raise('no-heartbeat', `it is listed running but has never sent a heartbeat ${Math.round(ranMin)} min after it started (limit ${nobeat}); its tool may never have started (not on PATH, a crash at launch)`, { minutes: Math.round(ranMin) });
  // 2.65.0: commits of another open task's unlanded lane in this one.
  if (!st.raised['borrowed-commits'] && scope.task) {
    const b = borrowedCommits(cwd, scope.task);
    if (b.length) raise('borrowed-commits', `its lane holds commits of ${b.map((x) => `${x.task}'s`).join(', ')} unlanded lane (${b.map((x) => `${x.task}: ${x.commits.length} commit(s)${x.via === 'trailer' ? ', tagged' : ', merged'}`).join('; ')}): its work now depends on work that hasn't landed. Land ${b.map((x) => x.task).join(', ')} first (--after), or take those commits out`, { borrowed: b.map((x) => ({ task: x.task, commits: x.commits.slice(0, 10), via: x.via })) });
  }

  // (a) and (b): the session's own verify runs since the last observation.
  const mine = events.filter((e) => e.type === 'gates.run' && e.agent === session.agent && (Date.parse(e.ts) || 0) > st.seen).sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
  for (const v of mine) {
    const t = Date.parse(v.ts) || 0;
    st.seen = Math.max(st.seen, t);
    for (const id of (Array.isArray(v.meta?.failed) ? v.meta.failed : []).map(String)) {
      let out = '';
      try { out = fs.readFileSync(path.join(cwd, '.studio', 'gates', 'out', `${id.replace(/[^\w.-]/g, '_')}.log`), 'utf8'); } catch {}
      const key = `${id}#${out ? failureSignature(out) : 'no-output'}`;
      st.fails[key] = (st.fails[key] || 0) + 1;
      if (st.fails[key] >= sameFail) raise('gate-loop', `gate ${id} failed ${st.fails[key]} times with the same output in this session`, { gate: id, signature: key.split('#')[1], count: st.fails[key] });
    }
    const skip = new Set([...(v.meta?.changedByVerify || []), ...(st.last?.changed || [])].map(String));
    const s = stateAt(working(), t, skip);
    if (st.last && st.last.known && s.known && st.last.fp === s.fp) st.sameDiff += 1;
    else st.sameDiff = 0;
    st.last = { at: v.ts, fp: s.fp, known: s.known, changed: (v.meta?.changedByVerify || []).map(String) };
    if (sameDiff > 0 && st.sameDiff >= sameDiff) raise('verify-no-diff', `${st.sameDiff + 1} verify runs in a row with no change to its working copy in between`, { runs: st.sameDiff + 1 });
  }

  // (c) edits outside the brief's scope.
  if (!st.raised['out-of-scope'] && scope.paths.length) {
    const edited = [...new Set([...working().files.map((f) => f.file), ...ownCommits(cwd, st.base, session.agent)].map(norm))];
    const extra = String(env.STUDIO_DRIFT_SCOPE_ALLOW || '').split(',').map(norm).filter(Boolean);
    const allowed = [...scope.paths, ...DRIFT_SCOPE_ALWAYS, ...extra];
    const out = edited.filter((f) => !allowed.some((p) => under(f, p)));
    if (out.length) raise('out-of-scope', `edited ${out.length} file(s) outside its scope (${scope.paths.join(', ')}): ${out.slice(0, 5).join(', ')}${out.length > 5 ? ', …' : ''}`, { files: out.slice(0, 20), scope: scope.paths });
  }

  fs.mkdirSync(DRIFT_DIR, { recursive: true });
  fs.writeFileSync(driftFile(session.agent), `${JSON.stringify(st, null, 2)}\n`);
  return raised;
}

/**
 * 2.65.0: commits in this lane (not on main, not on its own first-parent line) that belong to another OPEN task's
 * lane: shared with that task's branch (.studio/lane-branches.json) or queued head (.studio/train/queue.json), or
 * tagged Studio-Task: <that task> and not this one. Returns [{ task, commits: [sha], via: 'branch'|'trailer' }].
 */
export function borrowedCommits(cwd, task, { stateDir = STUDIO_STATE_DIR, boardRoot = REPO_ROOT } = {}) {
  const g = (...a) => { const r = spawnSync('git', a, { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); return r.status === 0 ? String(r.stdout || '').trim() : ''; };
  const board = boardStates(boardRoot);
  if (!board) return [];
  const common = g('rev-parse', '--path-format=absolute', '--git-common-dir');
  const mainDir = common && path.basename(common) === '.git' ? path.dirname(common) : boardRoot;
  const mr = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { windowsHide: true, cwd: mainDir, encoding: 'utf8' });
  const main = mr.status === 0 ? mr.stdout.trim() : '';
  if (!main || !g('rev-parse', '--verify', '-q', `refs/heads/${main}`)) return [];
  const mine = new Set(g('rev-list', `refs/heads/${main}..HEAD`).split('\n').filter(Boolean));
  if (!mine.size) return [];
  const own = new Set(g('rev-list', '--first-parent', `refs/heads/${main}..HEAD`).split('\n').filter(Boolean));
  const others = new Map();
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  for (const [k, v] of Object.entries(readJson(path.join(stateDir, 'lane-branches.json'), {}))) if (/^[A-Z]+-\d+$/.test(k) && typeof v === 'string' && v) others.set(k, [...(others.get(k) || []), `refs/heads/${v}`]);
  for (const e of readJson(path.join(stateDir, 'train', 'queue.json'), [])) if (e?.task && /^[0-9a-f]{40}$/.test(String(e.head || ''))) others.set(e.task, [...(others.get(e.task) || []), e.head]);
  const found = new Map();
  const add = (t, c, via) => { const f = found.get(t) || { task: t, commits: [], via }; if (!f.commits.includes(c)) f.commits.push(c); found.set(t, f); };
  for (const [t, heads] of others) {
    if (t === task || !board.open.has(t)) continue;
    for (const h of heads) {
      if (!g('rev-parse', '--verify', '-q', `${h}^{commit}`)) continue;
      for (const c of g('rev-list', `${h}`, `^refs/heads/${main}`).split('\n').filter(Boolean)) if (mine.has(c) && !own.has(c)) add(t, c, 'branch');
    }
  }
  const log = g('log', '--no-merges', '--format=%x1e%H%x09%(trailers:key=Studio-Task,valueonly,separator=%x2C)', `refs/heads/${main}..HEAD`);
  for (const block of log.split('\x1e').filter(Boolean)) {
    const [sha, tags = ''] = block.trim().split('\t');
    const ids = tags.split(/[,\s]+/).filter((x) => /^[A-Z]+-\d+$/.test(x));
    if (!ids.length || ids.includes(task)) continue;
    for (const t of ids) if (board.open.has(t) && !found.has(t)) add(t, sha, 'trailer');
  }
  return [...found.values()];
}

// The CLI loads agent.mjs (which imports this file) without a top-level await, so the import cycle can settle.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) import('./agent.mjs').then(({ sessions }) => {
  const rows = sessions().filter((s) => s.running).map((s) => ({ agent: s.agent, role: s.role, ...(readStall(s.agent)?.verdict || { stalled: false, why: 'not observed yet' }), checks: Object.keys(readDrift(s.agent)?.startedAt === s.startedAt ? readDrift(s.agent).raised || {} : {}) }));
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows));
  else console.log(rows.length ? rows.map((r) => `${r.agent} (${r.role}): ${r.stalled ? `STALLED ${r.why}` : `ok${r.quietMin != null ? `, quiet ${r.quietMin} min` : ''}${r.waiting ? `, waiting ${r.waiting}` : ''}`}${r.checks.length ? `; Check raised: ${r.checks.join(', ')}` : ''}`).join('\n') : 'No running sessions.');
});
