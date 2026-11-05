/**
 * harness/reviewer-scope.mjs — 2.77.3 (M4): a reviewer reads, and writes one review file.
 *
 * A launched Gemini reviewer went beyond its brief: it queued a full `npm run verify` and held a lock on studio/reviews
 * for 90+ min, and the pre-commit lock check refused every main commit that carried a file from that folder. Now:
 *   - verifyRefusal: a reviewer session (STUDIO_ROLE=reviewer, or an agent named reviewer-…) can't start a verify or any
 *     other gate run (scripts/run-gates.mjs: npm run verify, npm run gates, --tier, --wait). It reads the verify record
 *     the builder's or the train's run left (`node harness/done-check.mjs <ID>` shows it) instead.
 *   - note folders (STUDIO_LOCK_NOTE_DIRS, default studio/reviews; off = none): each note there is its own file, so a
 *     lock on one can't protect anybody's edit. harness/lock.mjs refuses a by-hand claim of the whole folder (claim the
 *     one file you write), and the pre-commit check (checkStaged) notes, rather than refuses, another owner's lock on a
 *     file in one.
 */
const REVIEWER_NAME = /^reviewer(-|_|\d|$)/i;
const OFF = /^(off|0|false|no|none)$/i;

/** Is this shell a reviewer session? */
export function isReviewer(env = process.env) {
  const role = String(env.STUDIO_ROLE || '').trim();
  if (role) return /^reviewer$/i.test(role);
  return REVIEWER_NAME.test(String(env.STUDIO_LOCK_OWNER || '').trim());
}

/** Why this shell may not run the gates, or ''. */
export function verifyRefusal(env = process.env) {
  if (!isReviewer(env)) return '';
  const who = String(env.STUDIO_LOCK_OWNER || '').trim() || 'this reviewer session';
  return `${who} is a reviewer: a reviewer reads the change and the verify record its builder or the merge train left (node harness/done-check.mjs <ID> shows it), and writes its review file only (studio/reviews/<date>-<ID>-<you>.md). It never runs npm run verify or the gates (a reviewer's 90-minute verify held studio/reviews and blocked commits, 2.77.3 M4). Missing a verify result? Say so in the review (verdict: changes, "no green verify") and the builder runs it`;
}

/** The note folders (repo-relative, forward slashes, lower case for comparison). */
export function noteDirs(env = process.env) {
  const raw = env.STUDIO_LOCK_NOTE_DIRS;
  if (raw !== undefined && OFF.test(String(raw).trim())) return [];
  const list = raw === undefined || String(raw).trim() === '' ? ['studio/reviews'] : String(raw).split(',');
  return list.map((d) => d.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()).filter(Boolean);
}

/** The note folder a repo-relative path is (exactly) or lies in: { dir, isDir }, or null. */
export function inNoteDir(rel, env = process.env) {
  const p = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
  for (const d of noteDirs(env)) {
    if (p === d) return { dir: d, isDir: true };
    if (p.startsWith(`${d}/`)) return { dir: d, isDir: false };
  }
  return null;
}
