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
// 2.86: "it never got going (launch failure": a session that died before its first turn or on a permission prompt.
export const HARNESS_CAUSE = /claim ran out|couldn't be added to \S+ in the main checkout|land lock|kept moving while|index\.lock|merge worktree|done is running|queued to land|never got going \(launch failure/i;
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
 * 2.83 (moved here in 2.86 so every counter reads it from one place; busy.mjs re-exports it): a refresh hand-off, a
 * session that reached its turn or context cap and hands its task to a fresh session by design. agent.mjs writes "A fresh
 * session continues from this hand-back".
 */
export const REFRESH_NOTE = /\bA fresh session continues from this hand-back\b/i;
export const refreshCaused = (e) => e?.meta?.cause === 'refresh' || REFRESH_NOTE.test(String(e?.msg || ''));

/**
 * 2.86: sessions that end for the harness's reasons, not the task's. A crew's first day on 2.85 had 35 refresh hand-offs
 * (most with no work: the brief alone filled the old 60 % mark) and the watchdog parked brand-new tasks for them; hooks
 * refusals for a commit that was not the task's and sessions that died on a permission prompt counted too. These kinds
 * never count toward the watchdog's park, the same-refusal hold, the crew breaker or the task's session and minute
 * budget; the scorecard shows them by kind.
 *   refresh          the session handed off at a refresh check and had done work: a fresh session continues it
 *   refresh-no-work  the same, with no commit, no saved uncommitted work and no file edit
 *   launch           the session died before its first turn, on a permission prompt, or never started (spawn error)
 *   foreign-refusal  `task done` was refused by the hooks check only, for commits that are not the task's own
 *   no-lane-copy     a start refused because no lane copy could be made (agent.start_refused, no session ran)
 */
export const HARNESS_KINDS = ['refresh', 'refresh-no-work', 'launch', 'foreign-refusal', 'no-lane-copy'];
export const harnessKind = (kind) => HARNESS_KINDS.includes(kind);
/** 2.86: the words a launch failure's hand-back carries (agent.mjs), so a reader without the session end still knows it. */
export const LAUNCH_NOTE = /\bit never got going \(launch failure\b/i;
const commitsOf = (o) => (Number(o?.commits) || 0) + (Number(o?.engineCommits) || 0);

/**
 * 2.86: why a session ended, when the reason is the harness's: one of HARNESS_KINDS, or null (the task's own end: work,
 * a failure, a refusal it can act on). `end` is an agent.session.end (meta.refreshed, meta.refreshNoWork, meta.launchFailure,
 * meta.outcome from harness/agent.mjs cleanUp). Older ends (before 2.86) are read from their outcome and reason.
 */
export function sessionEndKind(end) {
  const m = end?.meta || {};
  const o = m.outcome || null;
  if (m.launchFailure) return 'launch';
  if (m.refreshed || /^refreshed \(session cap\)/.test(String(m.reason || ''))) {
    if (typeof m.refreshNoWork === 'boolean') return m.refreshNoWork ? 'refresh-no-work' : 'refresh';
    return o && !o.done && !commitsOf(o) && !/Uncommitted work saved/.test(String(end?.msg || '')) ? 'refresh-no-work' : 'refresh';
  }
  if (o?.foreignRefusal && !commitsOf(o)) return 'foreign-refusal';
  return null;
}

/**
 * 2.86: a hand-back's harness kind, from the hand-back itself when its session end is not written yet (the launcher hands
 * back before it records the end): a refresh note, a launch-failure note, or a `task done` refusal for foreign commits as
 * the agent's newest refusal on the task (task.not_done meta.foreign) with no commit after it. Else from the session end.
 */
function harnessKindOf(e, events) {
  const end = endFor(e, events);
  const k = end ? sessionEndKind(end) : null;
  if (k) return k;
  if (LAUNCH_NOTE.test(noteOf(e)) || e?.meta?.cause === 'launch') return 'launch';
  if (refreshCaused(e)) return /Uncommitted work saved/.test(noteOf(e)) ? 'refresh' : 'refresh-no-work';
  const t = ts(e);
  const nd = events.filter((x) => x.type === 'task.not_done' && x.task === e.task && x.agent === e.agent && ts(x) <= t && t - ts(x) <= 3 * 3600000).sort((a, b) => ts(a) - ts(b)).pop();
  if (nd?.meta?.foreign) return 'foreign-refusal';
  return null;
}

/**
 * 2.85: what kind of hand-back a task.paused event is: 'real' | 'harness' | 'person' | 'limit' | 'ready' | 'refused', and
 * (2.86) one of HARNESS_KINDS. events: the log around it (for the session's end). limit: the usage-limit note (busy.mjs passes
 * budget.mjs LIMIT_STOP).
 */
export function handBackKind(e, events = [], { limit = null } = {}) {
  // 2.86: first, so a refresh or a launch failure is shown as itself (a launch failure's note also reads as harness-caused).
  const hk = harnessKindOf(e, events);
  if (hk) return hk;
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

/** 2.86: a start the launcher refused because no lane copy could be made (no session ran): 'no-lane-copy'. */
export const noLaneCopyRefusal = (e) => e?.type === 'agent.start_refused' && (/lane copy/i.test(String(e?.meta?.error || '')) || /no lane copy could be made/i.test(String(e?.msg || '')) || Boolean(e?.meta?.dir && e?.meta?.error));

/**
 * 2.85: the scorecard's hand-back counts in [from, to]: { real, byKind: { kind: n }, released } (released: claims let go
 * while their task waited for a train, task.claim.released). 2.86: harness: { kind: n }, the attempts that ended for a
 * harness reason (HARNESS_KINDS: the hand-backs of those kinds, plus starts refused for want of a lane copy).
 */
export function handBackTally(events = [], { from = 0, to = Infinity, limit = null } = {}) {
  const byKind = {};
  const harness = {};
  let released = 0;
  const all = [...events].sort((a, b) => ts(a) - ts(b));
  for (const e of all) {
    const t = ts(e);
    if (t < from || t > to) continue;
    if (e.type === 'task.claim.released') { released += 1; continue; }
    if (noLaneCopyRefusal(e)) { harness['no-lane-copy'] = (harness['no-lane-copy'] || 0) + 1; continue; }
    if (e.type !== 'task.paused' || !e.task) continue;
    const k = handBackKind(e, all, { limit });
    byKind[k] = (byKind[k] || 0) + 1;
    if (harnessKind(k)) harness[k] = (harness[k] || 0) + 1;
  }
  return { real: byKind.real || 0, byKind, released, harness };
}

/** 2.86: the words for the scorecard: "refresh 3, refresh with no work 2, launch failure 1" (none: "none"). */
const KIND_WORDS = { refresh: 'refresh', 'refresh-no-work': 'refresh with no work', launch: 'launch failure', 'foreign-refusal': 'refused for commits not its own', 'no-lane-copy': 'no lane copy' };
export const harnessKindWords = (harness = {}) => HARNESS_KINDS.filter((k) => harness[k]).map((k) => `${KIND_WORDS[k]} ${harness[k]}`).join(', ') || 'none';
