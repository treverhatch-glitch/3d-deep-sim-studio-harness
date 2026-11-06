/**
 * harness/telemetry.mjs — 2.79 (f): per-session / per-tick diagnostics keep their data, not their event noise.
 *
 * A diagnostic nobody reads one event at a time (a gate timeout that was scaled for load, a machine sample, a prompt
 * prefix that leaks something volatile) used to write one events.jsonl line per occurrence: over 6 days that was 1739,
 * 629 and 436 lines of the 35,600 the crew's run wrote. emitSampled() counts them in .studio/telemetry/<type>.json
 * (count, top keys, the last one's facts) and writes ONE `<type>.summary` event per STUDIO_TELEMETRY_HOUR_MIN (60)
 * minutes, with the count, the top keys and the last one. The summary is written by the first occurrence after the hour,
 * or by flushTelemetry() (the supervisor's pass calls it), so a quiet type still reports.
 *
 * Only types NOTHING reads per event are routed here (see docs/METRICS.md "Telemetry"): hotspot.overlap, task.overlap,
 * skill.follow, watch.report, agent.heartbeat, trigger.would_drop and thread.would_route are read by plan-waves,
 * next-board, scorecard, retro, metrics and the threads shadow report, so they stay one event each.
 *
 * STUDIO_TELEMETRY=full writes the per-event lines again (for debugging), and the counter files are left alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { STUDIO_STATE_DIR, emitEvent } from './event.mjs';
import { withFileLock, writeAtomic } from './fsafe.mjs';

const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
export const telemetryFull = (env = process.env) => String(env.STUDIO_TELEMETRY || '').trim().toLowerCase() === 'full';
const dirOf = () => path.join(STUDIO_STATE_DIR, 'telemetry');
const fileOf = (type) => path.join(dirOf(), `${type.replace(/[^\w.-]/g, '_')}.json`);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const TOP = 10;

function summaryEvent(type, c, now) {
  const top = Object.entries(c.keys || {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, TOP);
  const topText = top.slice(0, 3).map(([k, n]) => `${k} x${n}`).join(', ');
  return {
    type: `${type}.summary`, agent: c.agent || 'telemetry',
    msg: `${type}: ${c.count} in ${Math.max(1, Math.round((now - Date.parse(c.since)) / 60000))} min${topText ? ` (${topText})` : ''}${c.last?.msg ? `; last: ${String(c.last.msg).slice(0, 160)}` : ''}`.slice(0, 400),
    meta: { count: c.count, since: c.since, until: new Date(now).toISOString(), top: Object.fromEntries(top), ...(c.last?.meta ? { last: c.last.meta } : {}) },
  };
}

/** Write the summaries that are due (a counter older than the hour). Returns the types summarised. Never throws. */
export function flushTelemetry({ env = process.env, now = Date.now(), emit = emitEvent, all = false } = {}) {
  const done = [];
  try {
    const hourMs = num(env.STUDIO_TELEMETRY_HOUR_MIN, 60) * 60000;
    for (const n of fs.existsSync(dirOf()) ? fs.readdirSync(dirOf()) : []) {
      if (!n.endsWith('.json')) continue;
      const f = path.join(dirOf(), n);
      const type = n.slice(0, -5);
      let ev = null;
      withFileLock(`telemetry-${type}`, () => {
        const c = readJson(f);
        if (!c || !(c.count > 0) || !(all || now - Date.parse(c.since) >= hourMs)) return;
        ev = summaryEvent(type, c, now);
        writeAtomic(f, `${JSON.stringify({ count: 0, keys: {}, since: new Date(now).toISOString() })}\n`);
      }, { timeoutMs: 1000 });
      if (ev) { emit(ev); done.push(type); }
    }
  } catch { /* a diagnostic, never a blocker */ }
  return done;
}

/**
 * Count one occurrence of `ev` ({ type, agent, msg, meta, ... } as emitEvent takes it) under `key`; emit the hour's
 * summary when it is due. STUDIO_TELEMETRY=full (or a counter file that can't be written) emits `ev` as before.
 */
export function emitSampled(ev, key = '', { env = process.env, now = Date.now(), emit = emitEvent } = {}) {
  if (telemetryFull(env)) return emit(ev);
  const type = ev.type;
  try {
    let due = null;
    withFileLock(`telemetry-${type}`, () => {
      const f = fileOf(type);
      const c = readJson(f) || { count: 0, keys: {}, since: new Date(now).toISOString() };
      if (!(c.count > 0)) c.since = new Date(now).toISOString();
      c.count += 1;
      const k = String(key || 'all').slice(0, 80);
      c.keys[k] = (c.keys[k] || 0) + 1;
      c.agent = ev.agent || c.agent;
      c.last = { msg: ev.msg || '', meta: ev.meta || null, at: new Date(now).toISOString() };
      if (now - Date.parse(c.since) >= num(env.STUDIO_TELEMETRY_HOUR_MIN, 60) * 60000) {
        due = summaryEvent(type, c, now);
        writeAtomic(f, `${JSON.stringify({ count: 0, keys: {}, since: new Date(now).toISOString() })}\n`);
      } else writeAtomic(f, `${JSON.stringify(c)}\n`);
    }, { timeoutMs: 1000 });
    if (due) emit(due);
  } catch {
    return emit(ev); // the counter can't be kept: write the event, as before
  }
  return undefined;
}
