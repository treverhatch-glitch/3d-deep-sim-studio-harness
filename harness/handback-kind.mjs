/**
 * harness/handback-kind.mjs — 2.85: which hand-backs count against a task.
 *
 * A crew's first 16 hours on 2.84 had 73 hand-backs; 30 were the Director's flow pass "handing back" a task that was
 * finished and waiting in a train's queue, and three more were sessions refused by `task done` for the same harness
 * check none of them could fix. Both kinds counted toward the watchdog's "handed back 3 times in 2 h" park and the
 * scorecard. One answer, used by the watchdog's park (busy.mjs loopHandBacks), the crew breaker (crew-watch.mjs) and
 * the scorecard's hand-back line (score.mjs): handBackKind(). A hand-back is 'real' only when a session gave the work
 * back or failed; it is not real when
 *   - the harness caused it (the claim ran out, the land lock, a merge the main checkout refused): 'harness';
 *   - a person stopped or paused the session, or the session reported the task impossible: 'person';
 *   - the session stopped at its usage limit (the caller passes busy.mjs's LIMIT_STOP): 'limit';
 *   - its note says the work is ready and waits for a train: 'ready';
 *   - the session's `task done` was refused for the same reason as the session before it on the task, with no new
 *     commit in between (sameRefusalAgain): a harness refusal the session could not act on, 'refused'.
 * A claim released quietly while the task waits for a train (task.claim.released, director-flow.mjs) is no hand-back.
 * No imports: the supervisor and the crew watchdog load this.
 */

/** A hand-back the harness caused, not the work: never counts toward parking. */
export const HARNESS_CAUSE = /claim ran out|couldn't be added to \S+ in the main checkout|land lock|kept moving while|index\.lock|merge worktree|done is running|queued to land/i;
export const harnessCaused = (e) => e?.meta?.cause === 'harness' || HARNESS_CAUSE.test(String(e?.msg || ''));
/**
 * 2.58.3 (N1): a hand-back because a person (or the Producer) stopped or paused the session: the note says
 * "a stop, not a failure" (STOP_NOTE). Not the task looping, and not the harness's fault (the health share stays clean).
 */
export const STOP_NOTE = 'a stop, not a failure';
export const PERSON_CAUSE = /\ba stop, not a failure\b/i;
// PU-58 (2.78.0): the honest exit (task impossible) is a report, not a failure: it counts nowhere as a hand-back.
export const IMPOSSIBLE_NOTE = /(?:^|Handed back [^:]+:\s*)Impossible as written/i;
export const impossibleExit = (e) => e?.meta?.cause === 'impossible' || IMPOSSIBLE_NOTE.test(String(e?.msg || ''));
export const personCaused = (e) => e?.meta?.cause === 'person' || PERSON_CAUSE.test(String(e?.msg || '')) || impossibleExit(e);

/**
 * 2.84: events that say a task's work is finished and waits for a train (it counts as progress, not as nothing): its lane
 * was checked and queued (task done --train, or a lane's plain done), or a hand-back whose note says the work is ready
 * for the train. No outcome is recorded for that kind of hand-back, so its note is read (the words "ready ... train", not
 * "not ready"). The agent's own launcher records a hand-back by the session's name, so the task is what is matched.
 */
export const READY_FOR_TRAIN = /(?<!\bnot\s)(?<!n't\s)\bready\b[^.\n]{0,40}\btrain\b/i;
const noteOf = (e) => String(e?.msg || '').replace(/^Handed back [^:]*:/, '');
export const readyForTrain = (e) => e.type === 'task.train.queued' || e.type === 'task.done.queued' || (e.type === 'task.paused' && READY_FOR_TRAIN.test(noteOf(e)));

/**
 * 2.85: a hand-back note that says the work is finished: the 2.84 "ready ... train" reading, "ready to queue", a
 * "READY" of its own, or a note that starts "Done"/"Finished" and whose "Not done" part (if any) is only about queueing
 * it ("task done --train refused", "not queued"). A note with work left ("Not done: the panel's filters") is not.
 */
const LEFT = /\b(?:not done|not finished|left|todo|remaining)\s*:\s*([^|\n]*)/gi;
export const saysReady = (text) => {
  const t = String(text || '').replace(/^Handed back [^:]*:\s*/, '');
  if (/^\s*(?:not|isn't|is not)\s+(?:yet\s+)?(?:done|ready|finished)\b/i.test(t)) return false;
  if (READY_FOR_TRAIN.test(t) || /(?<!\bnot\s)\bready to (?:queue|land)\b/i.test(t) || /(?<![\w-])READY\b/.test(t)) return true;
  if (!/^\s*(?:done|finished)\b/i.test(t)) return false;
  for (const m of t.matchAll(LEFT)) if (!/task done|queue|train|refus|trailer/i.test(m[1])) return false;
  return true;
};

/** 2.85: the reason of a session's outcome.why "task done was refused[ after N commit(s)]: <reason>", or null. */
export function refusalOf(why) {
  const m = String(why || '').match(/^task done was refused(?: after \d+ commit\(s\))?:\s*([\s\S]+)$/);
  return m ? m[1].trim() : null;
}
/** The reason as a comparable key, as the supervisor's start back-off compares refusals: case, numbers, hashes out. */
export const refusalKey = (reason) => String(reason || '').toLowerCase().replace(/\b[0-9a-f]{7,40}\b/g, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 240);

const ts = (e) => Date.parse(e?.ts) || 0;
const newCommits = (o) => (Number(o?.commits) || 0) + (Number(o?.engineCommits) || 0);

/**
 * 2.85: did this session's `task done` meet the same refusal as the session before it on the same task, with no new
 * commit in between? `end` is an agent.session.end with meta.outcome; `events` oldest first (any order is sorted).
 * Returns { task, reason, key, prev } (prev: the earlier agent) or null.
 */
export function sameRefusalAgain(end, events = []) {
  const o = end?.meta?.outcome;
  if (!o?.task || o.done || o.counts === false) return null;
  const reason = refusalOf(o.why);
  if (!reason || newCommits(o) > 0) return null;
  const key = refusalKey(reason);
  const before = events.filter((e) => e !== end && e.type === 'agent.session.end' && e.meta?.outcome?.task === o.task && e.meta.outcome.counts !== false && ts(e) <= ts(end) && !(e.agent === end.agent && e.ts === end.ts)).sort((a, b) => ts(a) - ts(b)).pop();
  if (!before) return null;
  // A done or an unpark between the two ends starts over.
  if (events.some((e) => e.task === o.task && ts(e) > ts(before) && ts(e) < ts(end) && (e.type === 'task.done' || (e.type === 'task.hold' && /unparked/.test(e.msg || ''))))) return null;
  const prevReason = refusalOf(before.meta.outcome.why);
  if (!prevReason || refusalKey(prevReason) !== key) return null;
  return { task: o.task, reason, key, prev: before.agent };
}

/** The session end that belongs to a hand-back: the same agent's next agent.session.end on that task (within 30 min). */
function endFor(e, events) {
  const t = ts(e);
  return events.filter((x) => x.type === 'agent.session.end' && x.agent === e.agent && ts(x) >= t && ts(x) - t <= 30 * 60000 && (x.meta?.outcome?.task || x.task) === e.task).sort((a, b) => ts(a) - ts(b))[0] || null;
}

/**
 * 2.85: what kind of hand-back a task.paused event is: 'real' | 'harness' | 'person' | 'limit' | 'ready' | 'refused'.
 * events: the log around it (for the session's end). limit: the usage-limit note (busy.mjs passes budget.mjs LIMIT_STOP).
 */
export function handBackKind(e, events = [], { limit = null } = {}) {
  if (harnessCaused(e)) return 'harness';
  if (personCaused(e)) return 'person';
  if (limit && limit.test(String(e?.msg || ''))) return 'limit';
  if (READY_FOR_TRAIN.test(noteOf(e))) return 'ready';
  const end = endFor(e, events);
  if (end && sameRefusalAgain(end, events)) return 'refused';
  return 'real';
}
export const realHandBack = (e, events = [], opts = {}) => handBackKind(e, events, opts) === 'real';

/** 2.85: a session end that is a harness refusal the session could not act on (the same refusal twice): not "no work" for the crew breaker. */
export const sessionEndRefusedAgain = (end, events = []) => Boolean(sameRefusalAgain(end, events));

/**
 * 2.85: the scorecard's hand-back counts in [from, to]: { real, byKind: { kind: n }, released } (released: claims let go
 * while their task waited for a train, task.claim.released).
 */
export function handBackTally(events = [], { from = 0, to = Infinity, limit = null } = {}) {
  const byKind = {};
  let released = 0;
  const all = [...events].sort((a, b) => ts(a) - ts(b));
  for (const e of all) {
    const t = ts(e);
    if (t < from || t > to) continue;
    if (e.type === 'task.claim.released') { released += 1; continue; }
    if (e.type !== 'task.paused' || !e.task) continue;
    const k = handBackKind(e, all, { limit });
    byKind[k] = (byKind[k] || 0) + 1;
  }
  return { real: byKind.real || 0, byKind, released };
}
