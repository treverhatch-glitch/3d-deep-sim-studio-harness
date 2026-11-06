/**
 * harness/owner-only.mjs — 2.78.2 (d): a hand-back that names a step only the owner can do waits for the owner.
 *
 * Builders kept retrying steps nobody but the owner (or the orchestrator holding the owner's say-so) can do: a protected
 * file's re-pin, a qa.mjs expectation, a signed approval, a hooks restamp the hooks refuse. About ten sessions and a
 * million tokens went on it in the 2.78.1 run, each fresh session reading the same refusal. When a hand-back note, or the
 * end of a session's log, carries one of the harness's own refusals for such a step, the task is parked with reason
 * "owner-only" at the orchestrator's rank (task-hold.mjs parkRank 3: the orchestrator or the owner lifts it, a worker
 * can't), an event goes to the orchestrator (to: orchestrator; the Communicator turns it into an alert), and the
 * supervisor (which reads parks through holdReason) starts no builder on it until it is unparked.
 *
 * Nothing here lets a worker approve anything: it only stops the retries.
 */
import { emitEvent } from './event.mjs';
import { setHold, readHolds } from './task-hold.mjs';

/**
 * The phrases matched, each the harness's own refusal text (or a builder's own words for the same step), with the step it
 * names. Case-insensitive, on text with CRLF turned into LF. Kept narrow: a hint every failing check prints (the hooks'
 * "approve -- hooks" line) is NOT here, because a builder can still fix that one itself.
 */
export const OWNER_ONLY_PHRASES = [
  // qa/protected-check.mjs's last line, task.mjs's safety check, gate-fix.mjs's hint for the protected gate.
  { step: 'a protected file changed (re-pin, scenario expectation, controls list, gate)', rx: /Only the owner can approve these|protected files? changed without the owner'?s signed approval|only the owner approves it; hand the task back/i },
  // approve.mjs: no owner key on this machine, or the owner proxy without the owner's yes; reclassify.mjs's refusal.
  { step: 'a signed approval', rx: /no owner key at |signs approvals only |needs the owner'?s signature|a permission line isn'?t one/i },
  // test-weakening.mjs / task.mjs: a weakened test.
  { step: 'weakening a test', rx: /only the owner approves weakening a test/i },
  // hook-stamp.mjs: a commit the hooks refuse that only the owner can accept as it is.
  { step: 'a hooks approval or restamp', rx: /exceptions are the owner'?s call|(?:hooks|restamp)[^.\n]{0,80}\bonly the owner\b/i },
  // A builder's own hand-back wording for the same thing.
  { step: 'an owner-only step', rx: /\bowner[- ]only (?:step|change|approval|re-?pin)\b|\bneeds? (?:the )?owner'?s? (?:signature|signed approval|approval|re-?pin|release)\b|\bwaits? for the owner\b|\bonly the owner (?:can|may) (?:approve|sign|re-?pin|change|accept)\b/i },
];

/**
 * 2.79 (d): the structured owner step. The places that write the harness's own refusal (task done's safety checks)
 * put a code on the task.not_done event (meta.ownerStep); a hand-back that follows carries it (meta.ownerStep on the
 * task.paused event), and the Line Producer and the model pools read that field, never the words of a note ("the protected
 * gate now PASSES" is not a protected step).
 */
export const OWNER_STEP_PROTECTED = 'protected-file';
export const OWNER_STEP_CODES = { protected: OWNER_STEP_PROTECTED, 'weakened-tests': 'weakened-test' };
/** The owner step for the failed safety checks' ids (the first that has one), or null. */
export const ownerStepOfChecks = (ids = []) => { for (const id of ids) if (OWNER_STEP_CODES[id]) return OWNER_STEP_CODES[id]; return null; };
/**
 * The owner step a hand-back of this task carries: the newest harness refusal (task.not_done) since the task's last start,
 * when it names one and no approval has come since. A later refusal of another kind, or a done that passed, clears it.
 */
export function ownerStepForHandBack(taskId, events) {
  const mine = (events || []).filter((e) => e.task === taskId || (e.type && /^approval\./.test(e.type) && String(e.msg || '').includes(taskId)));
  let from = -1;
  mine.forEach((e, i) => { if (e.type === 'task.start') from = i; });
  const since = mine.slice(from + 1);
  let refusal = -1;
  since.forEach((e, i) => { if (e.type === 'task.not_done') refusal = i; });
  if (refusal < 0) return null;
  const step = since[refusal].meta?.ownerStep || null;
  if (!step) return null;
  if (since.slice(refusal + 1).some((e) => /^approval\.(protected|proposal)$/.test(e.type) || e.type === 'task.done')) return null;
  return step;
}

/** { step, phrase } for the first owner-only phrase in the text, or null. */
export function ownerOnlyStep(text = '') {
  const t = String(text || '').replace(/\r\n/g, '\n');
  for (const { step, rx } of OWNER_ONLY_PHRASES) {
    const m = t.match(rx);
    if (m) return { step, phrase: m[0].trim().slice(0, 120) };
  }
  return null;
}

/** Is this task parked for the owner already (by this module)? */
export const parkedOwnerOnly = (taskId, holds = readHolds()) => Boolean(holds[taskId]?.parked?.ownerOnly);

/**
 * Park the task for the owner and page the orchestrator. Returns { parked, step, phrase, why } or null (no phrase, or
 * the task is parked already: a park by a person or the breaker stays as it is).
 */
export function parkIfOwnerOnly(taskId, note, { who = 'launcher', now = Date.now() } = {}) {
  if (!taskId) return null;
  const hit = ownerOnlyStep(note);
  if (!hit) return null;
  if (readHolds()[taskId]?.parked) return null;
  const why = `owner-only: ${hit.step} ("${hit.phrase}"). Waits for the owner or the orchestrator; no builder starts on it until npm run task -- unpark ${taskId} --by <name>`;
  setHold(taskId, { parked: { by: 'harness', why, reason: 'owner-only', at: new Date(now).toISOString(), rank: 3, byRole: 'orchestrator', ownerOnly: true, step: hit.step } }, { by: 'harness', msg: `Parked ${taskId}: ${why}`.slice(0, 400) });
  emitEvent({ type: 'task.owner_only', agent: 'harness', to: 'orchestrator', task: taskId, status: 'blocked', msg: `${taskId} waits for the owner: ${who}'s hand-back names an owner-only step (${hit.step}: "${hit.phrase}"). No builder is relaunched on it until it is unparked (npm run task -- unpark ${taskId} --by <name>).`.slice(0, 500), meta: { step: hit.step, phrase: hit.phrase, by: who } });
  return { parked: true, step: hit.step, phrase: hit.phrase, why };
}
