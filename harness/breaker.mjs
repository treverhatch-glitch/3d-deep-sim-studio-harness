/**
 * harness/breaker.mjs — circuit breakers on hand-backs (2.30c, #8).
 *
 * A task handed back twice in a row for the same reason won't be fixed by a third fresh session
 * (test #2: one task went to 12 sessions, each refused by the same command). After one failed
 * hand-back, a second with the same reason parks the task with that reason and raises a War Room
 * card. Nothing else waits: other tasks and lanes keep starting. `npm run task -- unblock <ID>`
 * (or Unblock on the card) clears it.
 *
 * Not failures, so never counted: refreshes (session cap, context), a person's stop or pause.
 * STUDIO_BREAKER=off turns it off.
 */
import { emitEvent, readRecentEvents } from './event.mjs';
import { setHold, readHolds } from './task-hold.mjs';

const NOT_A_FAILURE = /\brefresh|session cap|turn ceiling|context (?:is |reached|at)|studio was stopped|paused from the war room|stopped by|out of (?:quota|usage)|usage limit|running low/i;
export const isFailureNote = (note) => Boolean(String(note || '').trim()) && !NOT_A_FAILURE.test(String(note));

/**
 * The reason, as a comparable key: the first line that says what failed, with numbers, ids, paths,
 * hashes and times taken out, so "verify failed: golden (run 3)" and "verify failed: golden (run 4)" match.
 */
export function reasonKey(note) {
  const lines = String(note || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /fail|refus|error|can't|cannot|blocked|missing|broken|red\b|not pass|doesn't|won't/i.test(l)) || lines[0] || '';
  return line
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, '#')
    .replace(/[\w./-]*\/[\w./-]+/g, 'path')
    .replace(/\b[a-z]+-\d+\b/g, 'id')
    .replace(/\d+(?:[.:]\d+)*/g, 'n')
    .replace(/[^a-z#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Called on every hand-back (task.mjs pauseTask). Returns the park reason when the breaker trips. */
export function checkBreaker(taskId, note, who = 'launcher', now = Date.now()) {
  if (/^(off|0|false|no)$/i.test(process.env.STUDIO_BREAKER || '')) return null;
  if (!isFailureNote(note)) return null;
  const key = reasonKey(note);
  if (!key) return null;
  const evs = readRecentEvents(20000).filter((e) => e.task === taskId);
  // Count only hand-backs since the task was last done, unblocked or unparked.
  const reset = evs.filter((e) => e.type === 'task.done' || e.type === 'task.unblocked' || (e.type === 'task.hold' && /unparked/.test(e.msg || ''))).pop();
  const prior = evs.filter((e) => e.type === 'task.paused' && e.meta?.reasonKey && (!reset || e.ts > reset.ts));
  const last = prior.at(-2); // the newest is this hand-back itself (emitted just before)
  if (!last || last.meta.reasonKey !== key) return null;
  if (readHolds()[taskId]?.parked) return null;
  const why = String(note).split('\n').map((l) => l.trim()).filter(Boolean)[0].slice(0, 200);
  const parkWhy = `circuit breaker: handed back twice for the same reason ("${why}"). Fix that, then npm run task -- unblock ${taskId} --by <name>`;
  setHold(taskId, { parked: { by: 'breaker', why: parkWhy, reason: why, at: new Date(now).toISOString(), breaker: true } }, { by: 'breaker', msg: `Parked ${taskId}: ${parkWhy}` });
  emitEvent({ type: 'task.breaker', agent: 'breaker', to: 'producer', task: taskId, status: 'blocked', msg: `${taskId} parked by the circuit breaker: handed back twice for "${why}" (last by ${who}). Other work keeps going.`, meta: { reasonKey: key, reason: why } });
  return parkWhy;
}

/** Clear a breaker (or any park): the task can start again, and the hand-back count starts over. */
export function unblockTask(taskId, by = 'human', note = '') {
  const h = readHolds()[taskId];
  if (!h?.parked) return { ok: false, message: `${taskId} isn't parked or tripped; nothing to unblock.` };
  setHold(taskId, { parked: null }, { by, msg: `${by} unblocked ${taskId}${note ? `: ${note}` : ''}` });
  emitEvent({ type: 'task.unblocked', agent: by, task: taskId, msg: `${by} unblocked ${taskId}${h.parked.breaker ? ` (breaker: ${h.parked.reason})` : ''}${note ? `: ${note}` : ''}` });
  return { ok: true, message: `${taskId} can start again${h.parked.breaker ? '; the breaker count starts over' : ''}.` };
}

/** Open breaker cards for the War Room: one per tripped task. */
export function breakerCards(holds = readHolds()) {
  return Object.entries(holds).filter(([, h]) => h.parked?.breaker).map(([id, h]) => ({ ts: h.parked.at, agent: 'breaker', task: id, msg: `Parked by the circuit breaker: handed back twice for "${h.parked.reason}". Other work keeps going.`, action: { type: 'unblock', task: id, label: 'Unblock' } }));
}
