/**
 * harness/producer-wake.mjs — the Producer starts only when something happened (2.30c, #11).
 *
 * A Producer session costs a fresh start each time (its kickoff, the briefing). Launched on a clock
 * it often found nothing new. Now the supervisor and the watcher's check-in start it only:
 *   - on an event since its last start: a task done, forced or parked by a breaker, a War Room card
 *     (an agent's ask, a Watch: task, an escalation, a question or intent card), or a task queued for it;
 *   - at most once per 15 min (STUDIO_PRODUCER_MIN_MIN), unless it is urgent (a P0 task for the
 *     Producer, an escalation, a stopped studio's cards);
 *   - when asked and nothing changed, the wait doubles (15, 30, 60 ... up to 4 h) until something does.
 * A person starting it from the War Room is never held back. State: .studio/producer-wake.json.
 * STUDIO_PRODUCER_WAKE=always turns this off.
 */
import fs from 'node:fs';
import path from 'node:path';
import { STUDIO_STATE_DIR, readRecentEvents } from './event.mjs';

const FILE = () => path.join(STUDIO_STATE_DIR, 'producer-wake.json');
const BASE = () => Number(process.env.STUDIO_PRODUCER_MIN_MIN ?? 15) * 60000;
const CAP = 4 * 3600000;
const TRIGGER = new Set(['task.done', 'task.forced', 'task.breaker', 'agent.ask', 'watch.alert', 'closedloop.escalate', 'route.exhausted', 'ask.opened', 'ask.created', 'intent.echo', 'supervisor.halted', 'agent.finish_refused']);
const URGENT = new Set(['closedloop.escalate', 'supervisor.halted']);

export function readWake() {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    return { lastLaunch: 0, interval: BASE() };
  }
}
function writeWake(w) {
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  fs.writeFileSync(FILE(), `${JSON.stringify(w, null, 2)}\n`);
}

const isTrigger = (e) => TRIGGER.has(e.type) || (e.type === 'task.added' && /\(producer\)/.test(e.msg || '')) || (e.type === 'task.hold' && /^Parked /.test(e.msg || ''));

/**
 * Should the Producer start now? `queue` is parseNextQueue() (a P0 Producer task is urgent).
 * Read-only unless `commit` is set: then a refusal for "nothing changed" doubles the wait.
 */
export function producerWake({ now = Date.now(), events = readRecentEvents(5000), queue = null, commit = false } = {}) {
  if (/^always$/i.test(process.env.STUDIO_PRODUCER_WAKE || '')) return { wake: true, why: 'STUDIO_PRODUCER_WAKE=always' };
  const w = readWake();
  const since = events.filter((e) => Date.parse(e.ts) > (w.lastLaunch || 0) && isTrigger(e) && e.agent !== 'producer' && !/^prod/i.test(String(e.agent || '')));
  const urgentTask = (queue?.backlog || []).some((t) => t.role === 'producer' && t.priority === 'P0');
  const urgent = urgentTask || since.some((e) => URGENT.has(e.type) || e.meta?.urgent);
  const interval = w.interval || BASE();
  const waited = now - (w.lastLaunch || 0);
  if (!since.length && !urgentTask) {
    const next = Math.min(CAP, interval * 2);
    if (commit && waited >= interval) writeWake({ ...w, interval: next, quietSince: w.quietSince || new Date(now).toISOString() });
    return { wake: false, why: `nothing changed since its last start; next look in ${Math.round((waited >= interval ? next : interval - waited) / 60000)} min` };
  }
  if (!urgent && waited < BASE()) return { wake: false, why: `${since.length} event(s) waiting, but it started ${Math.round(waited / 60000)} min ago (at most once per ${Math.round(BASE() / 60000)} min unless urgent)` };
  return { wake: true, urgent, why: since.length ? `${urgent ? 'urgent: ' : ''}${since.length} event(s) since its last start (${[...new Set(since.map((e) => e.type))].slice(0, 4).join(', ')})` : 'urgent: a P0 task for the Producer is waiting' };
}

/** The Producer was started: reset the wait. */
export function producerLaunched(now = Date.now()) {
  writeWake({ lastLaunch: now, interval: BASE(), quietSince: null });
}
