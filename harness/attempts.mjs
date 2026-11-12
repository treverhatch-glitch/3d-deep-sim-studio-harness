/**
 * harness/attempts.mjs — the attempt ledger: one file per task (.studio/attempts/<task>.json) that remembers each
 * failed or owner-only hand-back, and one eligibility verdict (2.81 (b1), from the R2 trial; docs/RUN-UNATTENDED.md).
 *
 * Live studio: 244 sessions / 52.8 h strictly unsuccessful, 76 owner-only pauses, 50 claim-expired hand-backs; tasks were
 * relaunched against the same unchanged blocker. A relaunch can't do better when nothing it was waiting on changed.
 *
 * An attempt = { n, at, agent, mainTip, laneHead, endLabel, reasonKey, blockers, ownerOnly, signature, cleared? }.
 * signature = first 16 hex of sha1(JSON of { reasonKey, mainTip, blockers (open ids, sorted, unique), ownerOnly }).
 * sameBlocker() computes that signature again from the CURRENT facts (the studio main branch's tip now, the task's holds
 * and what is done now, the attempt's reasonKey); equal = nothing changed, so a new session would meet the same wall.
 *
 * holdReason() (task-hold.mjs) asks sameBlocker(), so `task next`, `task start`, the supervisor and the Line Producer
 * agree. eligibility() adds the budget and round-cap refusals for the callers that offer tasks (nextFor, the supervisor);
 * startTask keeps its own refusals and stays the authority.
 *
 * Not recorded as a failure: a hand-back the harness or a person caused (busy.mjs harnessCaused/personCaused, a `cause`),
 * refreshes, session caps, usage stops: the breaker's own rule (breaker.mjs isFailureNote). No git (or no commit yet) =
 * no verdict. A task.done, `unblock` or `unpark` marks the last attempt cleared. STUDIO_ATTEMPTS=off disables it all.
 * The ledger only reads and writes its own files: it never releases a lock or a claim.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, STUDIO_STATE_DIR } from './event.mjs';
import { mainRoot } from './worktree.mjs';
import { readHolds, holdReason } from './task-hold.mjs';
import { overBudget } from './task-budget.mjs';
import { capRefusal } from './round-cap.mjs';
import { withFileLock, writeAtomic } from './fsafe.mjs';

export const ATTEMPTS_DIR = () => path.join(STUDIO_STATE_DIR, 'attempts');
export const attemptsOff = (env = process.env) => /^(off|0|false|no)$/i.test(env.STUDIO_ATTEMPTS || '');
/**
 * STUDIO_ATTEMPTS: `record` (default): the ledger is written and `task next`/the supervisor offer a same-blocker task
 * last, after every other eligible one, but nothing is refused (the loop park, the breaker, the tier-up and the
 * usage-limit paths keep their own counts); `refuse`: holdReason also refuses the relaunch while the signature is
 * unchanged; `off`: nothing is written or read.
 */
export const attemptsMode = (env = process.env) => (attemptsOff(env) ? 'off' : /^(refuse|strict|hard)$/i.test(env.STUDIO_ATTEMPTS || '') ? 'refuse' : 'record');
export const attemptsRefuse = (env = process.env) => attemptsMode(env) === 'refuse';
const KEEP = 50;
const fileOf = (taskId) => path.join(ATTEMPTS_DIR(), `${String(taskId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

/** HEAD of a git checkout, or null (no git, no commit, or `root` sits inside some other repo). Never throws. */
export function gitTip(root = mainRoot()) {
  try {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel', 'HEAD'], { windowsHide: true, cwd: root, encoding: 'utf8', timeout: 8000 });
    if (r.status !== 0) return null;
    const [top, sha] = String(r.stdout || '').trim().split(/\r?\n/);
    if (!/^[0-9a-f]{40}$/.test(sha || '') || !top) return null;
    // The same folder in two spellings is one folder: git prints forward slashes and the long name, a Windows temp path
    // can be the 8.3 short name (RUNNER~1), and the drive letter's case varies. The native realpath resolves all three.
    const canon = (p) => { let r; try { r = fs.realpathSync.native(p); } catch { r = path.resolve(p); } return process.platform === 'win32' ? r.toLowerCase() : r; };
    if (canon(top) !== canon(root)) return null;
    return sha;
  } catch { return null; }
}

export const signatureOf = ({ reasonKey = '', mainTip = null, blockers = [], ownerOnly = false } = {}) =>
  crypto.createHash('sha1').update(JSON.stringify({ reasonKey: String(reasonKey || ''), mainTip: mainTip || null, blockers: [...new Set(blockers || [])].sort(), ownerOnly: Boolean(ownerOnly) })).digest('hex').slice(0, 16);

export function readAttempts(taskId) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(taskId), 'utf8'));
    return { task: taskId, attempts: Array.isArray(j.attempts) ? j.attempts : [] };
  } catch { return { task: taskId, attempts: [] }; }
}
export const lastAttempt = (taskId) => readAttempts(taskId).attempts.at(-1) || null;

/**
 * Append one attempt. fields: { agent, endLabel ('hand-back'|'owner-only'|'claim-expired'|'done'|'breaker'|'cap'|'merge-conflict' (2.84)),
 * reasonKey, blockers, ownerOnly, mainTip?, laneHead? }. Returns the attempt, or null when the ledger is off.
 */
export function recordAttempt(taskId, fields = {}) {
  if (!taskId || attemptsOff()) return null;
  const mainTip = fields.mainTip !== undefined ? fields.mainTip : gitTip(mainRoot());
  const laneHead = fields.laneHead !== undefined ? fields.laneHead : gitTip(REPO_ROOT);
  const blockers = [...new Set(fields.blockers || [])].sort();
  const ownerOnly = Boolean(fields.ownerOnly);
  const reasonKey = String(fields.reasonKey || '');
  try {
    return withFileLock('attempts', () => {
      const cur = readAttempts(taskId);
      const a = { n: (cur.attempts.at(-1)?.n || 0) + 1, at: new Date().toISOString(), agent: fields.agent || null, mainTip, laneHead, endLabel: fields.endLabel || 'hand-back', reasonKey, blockers, ownerOnly, signature: signatureOf({ reasonKey, mainTip, blockers, ownerOnly }) };
      fs.mkdirSync(ATTEMPTS_DIR(), { recursive: true });
      writeAtomic(fileOf(taskId), `${JSON.stringify({ task: taskId, attempts: [...cur.attempts, a].slice(-KEEP) }, null, 2)}\n`);
      return a;
    }, { dir: path.join(STUDIO_STATE_DIR, 'locks'), what: 'The attempt ledger (.studio/attempts)' });
  } catch { return null; /* a record, never a blocker */ }
}

/** task.done / unblock / unpark: the last attempt no longer holds the task back. Returns true when something was cleared. */
export function clearAttempts(taskId) {
  try {
    return withFileLock('attempts', () => {
      const cur = readAttempts(taskId);
      const last = cur.attempts.at(-1);
      if (!last || last.cleared) return false;
      last.cleared = true;
      writeAtomic(fileOf(taskId), `${JSON.stringify(cur, null, 2)}\n`);
      return true;
    }, { dir: path.join(STUDIO_STATE_DIR, 'locks'), what: 'The attempt ledger (.studio/attempts)' });
  } catch { return false; }
}

/** Does an uncleared failure attempt exist? (a cheap check before any git call) */
export const hasActiveAttempt = (taskId) => { const a = lastAttempt(taskId); return Boolean(a && !a.cleared && a.endLabel !== 'done'); };

/**
 * The last recorded failure attempt's signature against the signature of the current facts.
 * nowFacts: { mainTip?, holds?, done? (Set of done ids), reasonKey? (2.84) }. Returns { same, n, since, mainTip, reasonKey }.
 */
export function sameBlocker(taskId, nowFacts = {}) {
  const no = { same: false, n: 0, since: null };
  if (attemptsOff()) return no;
  // 2.84 (m): nowFacts.reasonKey: judge the last attempt recorded for THAT reason (a launch's merge conflict), not only the
  // very last one (the session's own hand-back comes after it), as long as no cleared or done attempt follows it.
  const last = nowFacts.reasonKey !== undefined ? (() => {
    const all = readAttempts(taskId).attempts;
    for (let i = all.length - 1; i >= 0; i -= 1) {
      if (all[i].cleared || all[i].endLabel === 'done') return null;
      if (all[i].reasonKey === nowFacts.reasonKey) return all[i];
    }
    return null;
  })() : lastAttempt(taskId);
  if (!last || last.cleared || last.endLabel === 'done' || !last.mainTip) return no;
  const tip = nowFacts.mainTip !== undefined ? nowFacts.mainTip : gitTip(mainRoot());
  if (!tip) return { ...no, n: last.n, since: last.at };
  const holds = nowFacts.holds || readHolds();
  const done = nowFacts.done || new Set();
  const blockers = [...new Set([...(last.blockers || []), ...(holds[taskId]?.after || [])])].filter((id) => !done.has(id));
  const sig = signatureOf({ reasonKey: last.reasonKey, mainTip: tip, blockers, ownerOnly: last.ownerOnly });
  return { same: sig === last.signature, n: last.n, since: last.at, mainTip: last.mainTip, reasonKey: last.reasonKey };
}

/**
 * The one verdict for "may this task be offered / started": the first refusal among holdReason (holds, parks, waits,
 * the same-blocker clause), the task budget (read only: overBudget, nothing is parked here) and the round cap
 * (capRefusal, for `agent`). Returns { kind: 'held'|'over-budget'|'round-cap', why } or null.
 * `q` is parseNextQueue(); `events` may be passed to save a re-read of the log per task.
 */
export function eligibility(taskId, { agent = null, q, role = null, now = Date.now(), holds, events } = {}) {
  const held = holdReason(taskId, q, now, holds, role);
  if (held) return { kind: 'held', why: held };
  const b = overBudget(taskId, { events, now }); // startTask applies the budget even to a re-claim
  if (b.over) return { kind: 'over-budget', why: b.why };
  const cap = agent ? capRefusal(taskId, agent, { events, now }) : '';
  if (cap) return { kind: 'round-cap', why: cap };
  return null;
}

/**
 * 2.84: the words `task start` prints for an eligibility verdict (held, over budget, round cap). One place, so the
 * launcher's refusal says what `task start` would have said.
 */
export function startRefusalWords(taskId, v) {
  if (!v) return '';
  if (v.kind === 'held') return `${taskId} can't start yet: ${v.why}. Pick another task (npm run task -- next), or a person releases it.`;
  if (v.kind === 'round-cap') return `${taskId} can't start: ${v.why}.`;
  return `${taskId} can't start: ${v.why}`;
}

/**
 * 2.84: would `task start <taskId>` by `agent` (a session of `role`) be refused now? The launcher asks before it starts
 * a session for a named task (the supervisor's picks, agent start --task): a session whose first step is refused only
 * costs money. Work already in progress may continue (as task start: its hold does not apply). Returns
 * { kind, why, message } or null. Never throws.
 */
export function startRefusal(taskId, { agent = null, role = null, q, now = Date.now(), holds, events } = {}) {
  try {
    const inProgress = Boolean(q?.inProgress?.some((t) => t.id === taskId));
    let v = eligibility(taskId, { agent, q, role, now, holds, events });
    if (v?.kind === 'held' && inProgress) {
      const b = overBudget(taskId, { events, now });
      const cap = !b.over && agent ? capRefusal(taskId, agent, { events, now }) : '';
      v = b.over ? { kind: 'over-budget', why: b.why } : cap ? { kind: 'round-cap', why: cap } : null;
    }
    return v ? { ...v, message: startRefusalWords(taskId, v) } : null;
  } catch { return null; }
}

