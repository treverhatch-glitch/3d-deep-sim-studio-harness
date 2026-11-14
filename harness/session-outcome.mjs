/**
 * harness/session-outcome.mjs — 2.67.2: what a launched session did for its task, and the no-work rule.
 *
 * A supervisor run started 20 sessions in 35 minutes, landed nothing and used 1.24M tokens. Sessions ended within 36 s to
 * 3 min; one ended "pass (exit 0)" with no work. From the code, a session ends with no work when:
 *   - its `task start` is refused for a reason the supervisor's pre-launch filter doesn't see (the claim is another
 *     owner's live work, the board lock is busy, the studio is stopped, the task's budget is spent): the agent is told
 *     "If it refuses, pick another task" and, as a one-task session, stops;
 *   - it never runs task start at all (it decides the task is already done, or blocked, and stops);
 *   - it claims the task but commits nothing, or commits but its task done is refused by the done-check (a bug task's
 *     "Regression saved") and it stops at the blocker.
 * Before 2.67.2 a session that never claimed its task left no hand-back, so the loop park (STUDIO_LOOP_HANDBACKS, hand-
 * backs only) never counted it, and the supervisor started the same task again a minute later.
 *
 * sessionOutcome() reads the session's own evidence (events since it started, commits tagged with the task) and says
 * { task, claimed, commits, done, noWork, stuck, why }; agent.mjs cleanUp records it on agent.session.end
 * (meta.outcome). noWorkInARow() counts a task's no-work exits in a row (since its last done or unpark); at
 * STUDIO_NO_WORK_EXITS (default 2; 0 turns it off) the launcher parks the task with the reason for the Producer or an
 * outside agent (npm run task -- unpark <ID> --by <name>) instead of relaunching it blindly.
 *
 * No imports beyond handback-kind.mjs (none of its own): agent.mjs passes the events, the commit count and the park in.
 *
 * 2.85: holdIfSameRefusal(). Three sessions in four minutes were started on one task, each refused by `task done` for the
 * same harness check none of them could fix, each handed it back; then the watchdog parked it "handed back 3 times".
 * Now, when a session's `task done` is refused for the same reason as the session before it on the task, and it made no
 * new commit, the task is held at once for the overseer and the Producer (rank 2: a planner, the overseer or the owner
 * lifts it; never a worker). The Director's flow pass lifts it by itself once `task done --check` no longer gives that
 * reason (director-flow.mjs liftSameRefusalHolds).
 */
import { sameRefusalAgain } from './handback-kind.mjs';

const since = (e, t0) => (Date.parse(e.ts) || 0) >= t0;

/** A task's no-work limit: STUDIO_NO_WORK_EXITS (default 2); 0 or off: never parks. */
export function noWorkLimit(env = process.env) {
  const raw = String(env.STUDIO_NO_WORK_EXITS ?? '').trim() || '2';
  if (/^(off|false|no)$/i.test(raw)) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * What this session did for `task`. events: recent events (oldest first); commits: how many commits since the session
 * started carry the task's id. counts: false for a session a person stopped, that refreshed, hit a usage limit or a
 * provider error (those have their own handling and aren't "no work").
 */
export function sessionOutcome({ agent, task, startedAt, events = [], commits = 0, counts = true }) {
  if (!task) return null;
  const t0 = Date.parse(startedAt) || 0;
  const mine = events.filter((e) => e.task === task && since(e, t0));
  const done = mine.some((e) => e.type === 'task.done');
  const claimed = mine.some((e) => e.type === 'task.start' && e.agent === agent);
  const refused = mine.filter((e) => (e.type === 'task.start_refused' || e.type === 'task.lock_denied') && e.agent === agent).pop();
  const notDone = mine.filter((e) => e.type === 'task.not_done' && e.agent === agent).pop();
  const clip = (m) => String(m || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  let why = '';
  if (!done) {
    if (refused && !claimed) why = `its task start was refused: ${clip(refused.msg)}`;
    else if (!claimed) why = `it never claimed ${task} (no task start ran in the session)`;
    else if (notDone) why = `task done was refused${commits ? ` after ${commits} commit(s)` : ''}: ${clip(notDone.msg).replace(new RegExp(`^${task} not done yet:\\s*`), '')}`;
    else if (!commits) why = `it claimed ${task} but committed nothing and didn't call task done`;
    else why = `it made ${commits} commit(s) but didn't call task done`;
  }
  // PU-58: a session that took the impossible exit (task impossible) did what it was asked to do: not no-work, not stuck.
  const impossible = !done && mine.some((e) => e.type === 'task.impossible' && e.agent === agent);
  if (impossible) return { task, claimed, commits, done, noWork: false, stuck: false, counts: false, impossible: true, why: '' };
  const noWork = !done && !commits;
  const stuck = !done && Boolean(notDone);
  // 2.86: refused by the hooks check only, for commits that are not the task's own (task.not_done meta.foreign, task.mjs):
  // the harness's refusal, not the session's work. It counts toward no task's park, hold or breaker (handback-kind.mjs).
  if (!done && notDone?.meta?.foreign && !commits) return { task, claimed, commits, done, noWork, stuck, counts: false, foreignRefusal: true, why };
  return { task, claimed, commits, done, noWork, stuck, counts: Boolean(counts), why };
}

/**
 * How many of this task's sessions in a row ended with no work (no done, and no commit or a refused task done),
 * newest first, stopping at one that did work or at the task's last done / unpark / unblock.
 */
export function noWorkInARow(task, events = []) {
  let n = 0;
  const why = [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.task === task && (e.type === 'task.done' || e.type === 'task.unblocked' || (e.type === 'task.hold' && /unparked/.test(e.msg || '')))) break;
    const o = e.type === 'agent.session.end' ? e.meta?.outcome : null;
    if (!o || o.task !== task || !o.counts) continue;
    if (!(o.noWork || o.stuck)) break;
    n += 1;
    why.push(`${e.agent}: ${o.why}`);
  }
  return { n, why };
}

/**
 * After a session's end is recorded: park the task when it has ended with no work STUDIO_NO_WORK_EXITS times in a row.
 * park(task, parked, { by, msg }) is busy.mjs parkOnce; ask(msg) tells the Producer. Returns the reason, or null.
 */
export function parkIfNoWork(task, events, { park, ask = () => {}, env = process.env, now = Date.now() } = {}) {
  const limit = noWorkLimit(env);
  if (!task || !limit) return null;
  const run = noWorkInARow(task, events);
  if (run.n < limit) return null;
  const why = `${run.n} sessions in a row ended with no work (STUDIO_NO_WORK_EXITS=${limit}); the last: ${run.why[0]}. Fix what stops it (or say what the task needs), then npm run task -- unpark ${task} --by <name>`;
  if (!park(task, { by: 'launcher', why, at: new Date(now).toISOString() }, { by: 'launcher', msg: `Parked ${task}: ${why}`.slice(0, 600) })) return null;
  ask(`${task} is parked: ${why}`.slice(0, 600));
  return why;
}

/**
 * 2.85: after a session's end is recorded: hold its task when this refusal of `task done` is the same as the last
 * session's (handback-kind.mjs sameRefusalAgain). park(task, parked, { by, msg, to, meta }) is busy.mjs parkOnce.
 * Returns { task, why } when this call held it, else null.
 */
export function holdIfSameRefusal(agent, events, { park, now = Date.now() } = {}) {
  const end = [...events].reverse().find((e) => e.type === 'agent.session.end' && e.agent === agent);
  const s = end ? sameRefusalAgain(end, events) : null;
  if (!s) return null;
  // 2.86: a refusal for commits that are not the task's own is held too, as the harness's hold (not the task's failure).
  const why = `${s.foreign ? 'a harness hold, not the task\'s failure: ' : ''}task done is refused for the same reason twice: ${s.reason}`.replace(/\s+/g, ' ').slice(0, 600);
  const at = new Date(now).toISOString();
  const key = s.key.slice(0, 120);
  // Lifted once for this very reason and refused again: the lift check does not see the refusal (it runs in the main
  // checkout; a lane's refusal may not show there), so this hold waits for a planner or the overseer.
  const again = events.some((e) => e.type === 'task.hold' && e.task === s.task && e.meta?.lifted && e.meta?.key === key);
  const parked = { by: 'harness', why, reason: 'same-refusal', key, rank: 2, byRole: 'producer', addressedTo: ['overseer', 'producer'], at, checkedAt: at, ...(again ? { noAutoLift: true } : {}), ...(s.foreign ? { harness: true } : {}) };
  const msg = `Held ${s.task} for the overseer and the Producer: ${why} (${s.prev}, then ${agent}, no new commit). ${again ? 'It was lifted once and the same refusal came back, so it stays held: fix the cause' : 'It lifts by itself once task done --check no longer gives that reason; or fix the cause'}, then npm run task -- unpark ${s.task} --by <name>`.slice(0, 900);
  if (!park(s.task, parked, { by: 'harness', msg, to: 'producer', status: 'blocked', meta: { reason: 'same-refusal', addressedTo: ['overseer', 'producer'], key: parked.key, ...(s.foreign ? { harness: true, cause: 'harness' } : {}) } })) return null;
  return { task: s.task, why };
}
