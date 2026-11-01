#!/usr/bin/env node
/**
 * harness/jobs.mjs — 2.65.0: one completion event for every long job, and a way to wait for it.
 *
 * The crew's orchestrator (an agent outside the harness) polled logs to learn when a verify, a train or a Unity build
 * had finished. Each of those already logged its own event (gates.run, task.train.*, engine.land, agent.session.end),
 * each in its own shape. Now every long job also ends with ONE uniform event beside its own (nothing is removed):
 *
 *   { type: 'job.done', status: 'ok'|'warn'|'error', task?, durationMs,
 *     meta: { kind, id, code, result, ms, tail, log } }
 *
 *   kind        verify (a full verify: scripts/run-gates.mjs), train (harness/train.mjs runTrain), game-gates (the game's
 *               checks run on their own: harness/game-gates.mjs), heavy (node harness/heavy.mjs run), unity-gate (the
 *               Unity land gate, also each Unity train's land run), unity-test / unity-build (harness/unity.mjs gate /
 *               build), session (an agent session ended: harness/agent.mjs)
 *   id          which one: the verify's owner or head, the train id, the heavy label, the agent's name
 *   code        the exit code (null when there is none); result: pass | fail | busy | ... in words
 *   tail        the last lines that matter (at most 600 characters); log: where the whole output is, when kept
 *
 *   npm run events -- wait --type job.done [--match kind=train] [--match task=T-012] [--since <iso>|last|now]
 *                          [--timeout <min>] [--cursor <name>]
 *       blocks until a matching event is in .studio/events.jsonl and prints it as one JSON line (exit 0); prints
 *       {"timeout":true,...} and exits 2 when --timeout minutes (default 60) pass first. --type takes a trailing * (job.*).
 *       --match key=value compares the event's meta field (kind=train is meta.kind, id= is the job's id), else its
 *       own field (task=T-012), dotted paths too (meta.code=0); value a|b matches either. --since: events after that time; now (the default) only new ones;
 *       last: after the last event this cursor returned (--cursor, default STUDIO_LOCK_OWNER or "default"; kept in
 *       .studio/events-wait/<cursor>.json), so nothing that ended between two waits is missed.
 *   npm run events -- tail [--type <t>] [--n 20]      the newest events, one JSON line each
 *
 * Polling is cheap: the log's size is checked every STUDIO_EVENTS_WAIT_POLL_MS (1000) and only the new bytes are read;
 * a roll-over (STUDIO_EVENTS_MAX_MB) is followed into the rolled file. No imports beyond event.mjs, so any CLI may use
 * jobDone() without an import cycle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitEvent, getEventPaths, rolledEventFiles, readRecentEvents, STUDIO_STATE_DIR } from './event.mjs';

export const JOB_KINDS = ['verify', 'train', 'game-gates', 'heavy', 'unity-gate', 'unity-test', 'unity-build', 'session'];

const secs = (ms) => (ms >= 120000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`);

/**
 * Record that a job ended. Never throws (the event log is a help, never a blocker). result: words (pass, fail, busy,
 * refused, ...); without one, code 0 is pass and anything else fail. Returns the event, or null.
 */
export function jobDone({ kind, id = null, code = null, result = null, ms = null, tail = '', log = null, task = null, agent = null, extra = {} } = {}) {
  try {
    const res = String(result || (code === 0 ? 'pass' : code === null || code === undefined ? 'done' : 'fail'));
    const status = /^(pass|ok|done|landed|skipped)$/i.test(res) ? 'ok' : /^(busy|refused|nothing|held|stopped)$/i.test(res) ? 'warn' : 'error';
    const t = String(tail || '').trim();
    return emitEvent({
      type: 'job.done',
      agent: agent || process.env.STUDIO_LOCK_OWNER || kind,
      task: task || null,
      status,
      durationMs: Number.isFinite(ms) ? ms : null,
      msg: `${kind}${id ? ` ${id}` : ''}: ${res}${code !== null && code !== undefined ? ` (exit ${code})` : ''}${Number.isFinite(ms) ? ` after ${secs(ms)}` : ''}`.slice(0, 300),
      meta: { kind, id: id === null || id === undefined ? null : String(id).slice(0, 120), code: code ?? null, result: res, ms: Number.isFinite(ms) ? ms : null, tail: t.length > 600 ? t.slice(-600) : t, log: log || null, ...extra },
    });
  } catch {
    return null;
  }
}

// ---- matching -------------------------------------------------------------------------------------

const getPath = (o, p) => String(p).split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
/**
 * A --match value: the event's meta field first (kind=train, id=<train id>: job.done keeps its own id there, the event's
 * top-level id is the log's), else the event's own field (task=T-012, agent=...), or a dotted path (meta.code=0).
 */
export function fieldOf(e, key) {
  if (key.includes('.')) return getPath(e, key);
  if (e?.meta && e.meta[key] !== undefined && e.meta[key] !== null) return e.meta[key];
  return e ? e[key] : undefined;
}
/** Parse "key=value" strings into [{ key, values }]. */
export function parseMatches(list = []) {
  return list.map((m) => { const i = String(m).indexOf('='); return i > 0 ? { key: String(m).slice(0, i).trim(), values: String(m).slice(i + 1).split('|') } : null; }).filter(Boolean);
}
export function typeMatches(type, want) {
  if (!want) return true;
  const w = String(want);
  return w.endsWith('*') ? String(type || '').startsWith(w.slice(0, -1)) : type === w;
}
/** Does an event match { type, matches, after (ms) }? */
export function eventMatches(e, { type = null, matches = [], after = 0 } = {}) {
  if (!e || typeof e !== 'object') return false;
  if (after && !((Date.parse(e.ts) || 0) > after)) return false;
  if (!typeMatches(e.type, type)) return false;
  return matches.every((m) => { const v = fieldOf(e, m.key); return v !== undefined && v !== null && m.values.includes(String(v)); });
}

// ---- cursors --------------------------------------------------------------------------------------

const cursorFile = (name) => path.join(STUDIO_STATE_DIR, 'events-wait', `${String(name || 'default').replace(/[^\w.-]/g, '_')}.json`);
export function readCursor(name) {
  try { return JSON.parse(fs.readFileSync(cursorFile(name), 'utf8')); } catch { return null; }
}
function writeCursor(name, e) {
  try {
    const f = cursorFile(name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify({ ts: e.ts, id: e.id || null, type: e.type, at: new Date().toISOString() })}\n`);
  } catch {}
}
/** --since as a time in ms (exclusive). now: the moment the wait starts; last: the cursor's last event. */
export function sinceMs(since, { cursor = 'default', now = Date.now() } = {}) {
  const s = String(since || 'now').trim();
  if (/^now$/i.test(s)) return { ms: now, why: 'new events only' };
  if (/^last$/i.test(s)) {
    const c = readCursor(cursor);
    const t = Date.parse(c?.ts);
    return Number.isFinite(t) ? { ms: t, id: c.id || null, why: `after the last event cursor "${cursor}" returned (${c.ts})` } : { ms: now, why: `cursor "${cursor}" has no last event yet: new events only` };
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? { ms: t, why: `after ${s}` } : { ms: now, error: `--since wants an ISO time, last or now; got "${s}"` };
}

// ---- reading only what is new ---------------------------------------------------------------------

function readFrom(file, offset) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return { lines: [], size: offset }; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { lines: [], size };
    const buf = Buffer.allocUnsafe(size - offset);
    let got = 0;
    while (got < buf.length) { const n = fs.readSync(fd, buf, got, buf.length - got, offset + got); if (n <= 0) break; got += n; }
    const text = buf.toString('utf8', 0, got);
    const end = text.lastIndexOf('\n');
    if (end < 0) return { lines: [], size: offset }; // a line still being written: read it next time
    return { lines: text.slice(0, end).split('\n').filter((l) => l.trim()), size: offset + Buffer.byteLength(text.slice(0, end + 1)) };
  } finally {
    fs.closeSync(fd);
  }
}
const parse = (l) => { try { const e = JSON.parse(l); return e && typeof e === 'object' && !Array.isArray(e) ? e : null; } catch { return null; } };

/**
 * Wait for the first event matching { type, matches } written after `since` (ms). Resolves { ok: true, event } or
 * { ok: false, timeout: true }. Events already in the log after `since` count (the newest 20,000 are looked at first).
 */
export async function waitForEvent({ type = null, matches = [], since = Date.now(), skipId = null, timeoutMs = 60 * 60000, pollMs = Number(process.env.STUDIO_EVENTS_WAIT_POLL_MS) > 0 ? Number(process.env.STUDIO_EVENTS_WAIT_POLL_MS) : 1000, file = getEventPaths().primary } = {}) {
  const want = { type, matches, after: since };
  const hit = (e) => e && (!skipId || e.id !== skipId) && eventMatches(e, want);
  let offset = 0;
  try { offset = fs.statSync(file).size; } catch { offset = 0; }
  if (since < Date.now()) {
    const found = readRecentEvents(20000).filter(hit);
    if (found.length) return { ok: true, event: found[0] };
  }
  const end = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    if (size < offset) {
      // Rolled over: the rest of the old log is now the newest rolled file.
      const rolled = rolledEventFiles(file)[0];
      if (rolled) { const r = readFrom(rolled, offset); const e = r.lines.map(parse).find(hit); if (e) return { ok: true, event: e }; }
      offset = 0;
    }
    const r = readFrom(file, offset);
    offset = r.size;
    const e = r.lines.map(parse).find(hit);
    if (e) return { ok: true, event: e };
    if (Date.now() >= end) return { ok: false, timeout: true };
    await new Promise((res) => setTimeout(res, Math.min(pollMs, Math.max(10, end - Date.now()))));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const all = (k) => argv.flatMap((a, i) => (a === k && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
  const cmd = argv[0];
  if (cmd === 'wait') {
    const cursor = opt('--cursor') || process.env.STUDIO_LOCK_OWNER || 'default';
    const s = sinceMs(opt('--since') || 'now', { cursor });
    if (s.error) { console.error(`[events] ${s.error}`); process.exit(1); }
    const min = opt('--timeout') !== null ? Number(opt('--timeout')) : 60;
    if (!(min >= 0)) { console.error('[events] --timeout wants minutes (a number)'); process.exit(1); }
    const matches = parseMatches(all('--match'));
    const type = opt('--type');
    if (!type && !matches.length) { console.error('Usage: npm run events -- wait --type <type> [--match key=value] [--since <iso>|last|now] [--timeout <min>] [--cursor <name>]'); process.exit(1); }
    const r = await waitForEvent({ type, matches, since: s.ms, skipId: s.id || null, timeoutMs: min * 60000 });
    if (!r.ok) { console.log(JSON.stringify({ timeout: true, type, match: all('--match'), since: new Date(s.ms).toISOString(), minutes: min })); process.exit(2); }
    writeCursor(cursor, r.event);
    console.log(JSON.stringify(r.event));
    process.exit(0);
  }
  if (cmd === 'tail') {
    const n = Number(opt('--n')) > 0 ? Number(opt('--n')) : 20;
    const type = opt('--type');
    for (const e of readRecentEvents(type ? 20000 : n).filter((x) => typeMatches(x.type, type)).slice(-n)) console.log(JSON.stringify(e));
    process.exit(0);
  }
  console.log('Usage: npm run events -- wait --type <type> [--match key=value]... [--since <iso>|last|now] [--timeout <min>] [--cursor <name>]\n       npm run events -- tail [--type <type>] [--n 20]\njob.done kinds: ' + JOB_KINDS.join(', '));
  process.exit(cmd ? 1 : 0);
}
