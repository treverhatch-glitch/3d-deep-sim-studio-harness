/**
 * harness/check-reads.mjs — 2.78.2 (g, item 16): which committed studio files the studio's own required checks read,
 * as the checks themselves define it. scripts/check-docs.mjs, scripts/verify-session.mjs and scripts/check-reviewer.mjs
 * take their lists from here, and the merge train's landing over main's non-code commits (harness/train.mjs
 * nonCodeReaders) asks the same lists. So a check that starts reading another file says so here, and the train stops
 * treating that file as one no check reads.
 */

/** check-docs: folder names it never walks into (any depth). */
export const DOCS_SKIP_DIRS = ['node_modules', '.git', '.studio', '.lanes', 'dist', 'harness-notes', 'retros', 'daily', 'reviews', 'research', 'meetings', 'handoffs'];
/** check-docs: free text people and agents write (test #2: a Producer note ending "npm run verify:" turned the docs gate red). */
export const DOCS_SKIP_FILES = ['CHANGELOG.md', 'docs/ROADMAP.md', 'studio/producer/LOG.md', 'studio/producer/INBOX.md', 'studio/PITFALLS.md', 'studio/PITFALLS-ARCHIVE.md', 'studio/HARNESS-TASKS.md'];
/** 2.78.2 (c): agent-written logs, reviews, handoffs and notes are free text too: check-docs never reads them. */
export const DOCS_SKIP_PREFIXES = ['studio/producer/', 'studio/reviews/', 'studio/handoffs/', 'studio/notes/'];
/** verify-session: files that must exist (a delete turns it red). */
export const SESSION_REQUIRED = ['AGENTS.md', 'studio/CURRENT_TASK.md', 'studio/NEXT.md', 'studio/memory/failures.md', 'docs/READ-FIRST.md', 'studio/MASTER.md', 'studio/PLAN.md'];
/** check-reviewer: the review files it judges (each reviewer's model family against the implementer's). */
export const REVIEWS_DIR = 'studio/reviews';

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');

/** Does check-docs read this repo-relative file (a Markdown file it walks to and doesn't skip)? */
export function docsReads(rel) {
  const f = norm(rel);
  if (!f.endsWith('.md')) return false;
  const dirs = f.split('/').slice(0, -1);
  if (dirs.some((d) => DOCS_SKIP_DIRS.includes(d))) return false;
  if (DOCS_SKIP_PREFIXES.some((p) => f.startsWith(p))) return false;
  return !DOCS_SKIP_FILES.includes(f);
}

/** The studio checks (gate ids) that read this repo-relative file, by the lists above. [] when none of them does. */
export function studioCheckReaders(rel) {
  const f = norm(rel);
  const ids = [];
  if (docsReads(f)) ids.push('docs');
  if (SESSION_REQUIRED.includes(f)) ids.push('session');
  if (f.startsWith(`${REVIEWS_DIR}/`)) ids.push('reviewer');
  return ids;
}
