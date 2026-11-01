/**
 * harness/merge-tree.mjs — 2.65.1: the one place that asks git whether two commits would conflict.
 *
 * `npm run lanes` (harness/lanes.mjs, the conductor's table) and the queue-time prediction of `task done --train`
 * (harness/train-predict.mjs) each ran `git merge-tree --write-tree --name-only` with their own version check and
 * parsing, so the table and the queue could disagree about the same pair (a conflict only in the manifest's
 * "unionFiles", which the train merges with git's union driver, was a conflict in one and none in the other). Both use
 * this module now:
 *
 *   gitVersion(cwd)          git's version, read once per process ([major, minor, patch] or null)
 *   mergeTreeSupport(cwd)    { ok, version, why }: merge-tree --write-tree needs git 2.38+
 *   mergeTree(root, a, b, { unionFiles })
 *                            in memory, no index, no files: { clean, tree, files, union, error }; a conflict only inside
 *                            unionFiles is clean (listed in `union`)
 *   placesFor(root, ours, theirs, files)
 *                            file:line places of those conflicted files (hotspots.mjs conflictPlaces), at most 12
 *   placeText(c)             "file:line, ..." (or the file names), for one line of output
 *
 * Test hook: STUDIO_TEST_GIT_VERSION=<"git version x.y.z"> stands in for `git version` (not cached).
 * Only static imports of merge-lane.mjs and hotspots.mjs, neither of which imports a module whose CLI uses top-level
 * await.
 */
import { spawnSync } from 'node:child_process';
import { matchAny } from './merge-lane.mjs';
import { conflictPlaces } from './hotspots.mjs';

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');

let cachedVersion; // undefined: not read yet in this process
/** git's version as [major, minor, patch] (from `git version`), or null. Read once per process; `text` parses that. */
export function gitVersion(cwd = process.cwd(), text = null, env = process.env) {
  const parse = (s) => { const m = String(s || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/); return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null; };
  if (text !== null && text !== undefined) return parse(text);
  if (env.STUDIO_TEST_GIT_VERSION) return parse(env.STUDIO_TEST_GIT_VERSION);
  if (cachedVersion === undefined) cachedVersion = parse(out(git(cwd, 'version')));
  return cachedVersion;
}

/** Does this git have `merge-tree --write-tree` (2.38+)? { ok, version, why } */
export function mergeTreeSupport(cwd = process.cwd(), text = null, env = process.env) {
  const v = gitVersion(cwd, text, env);
  if (!v) return { ok: false, version: null, why: 'git\'s version could not be read' };
  const ok = v[0] > 2 || (v[0] === 2 && v[1] >= 38);
  return { ok, version: v.join('.'), why: ok ? '' : `git ${v.join('.')} has no merge-tree --write-tree (2.38+)` };
}

/**
 * Merge `a` and `b` in memory. { clean, tree, files: [conflicted, not union], union: [conflicted, union only], error }.
 * A conflict only inside unionFiles is clean (the train merges those with the union driver).
 */
export function mergeTree(root, a, b, { unionFiles = [] } = {}) {
  const r = git(root, 'merge-tree', '--write-tree', '--name-only', '--no-messages', a, b);
  const lines = String(r.stdout || '').split('\n');
  if (r.status === 0) return { clean: true, tree: lines[0].trim(), files: [], union: [] };
  if (r.status !== 1) return { clean: false, error: `${r.stderr || r.stdout || `exit ${r.status}`}`.trim().split('\n').slice(-2).join(' '), files: [], union: [] };
  const conflicted = [...new Set(lines.slice(1).map((s) => s.trim()).filter(Boolean))];
  const union = conflicted.filter((f) => unionFiles.length && matchAny(f, unionFiles));
  const files = conflicted.filter((f) => !union.includes(f));
  return { clean: files.length === 0, tree: lines[0].trim(), files, union };
}

/** file:line places of these conflicted files (hotspots.mjs conflictPlaces), at most 12; [] when they can't be read. */
export function placesFor(root, ours, theirs, files) {
  try { return conflictPlaces(root, ours, theirs).filter((p) => files.includes(p.file)).slice(0, 12); } catch { return []; }
}

/** One conflict ({ files, places }) as "file:line, ..." (the file names when no places), at most six. */
export const placeText = (c) => (c.places?.length ? c.places.map((p) => `${p.file}:${p.line}`) : c.files).slice(0, 6).join(', ') + ((c.places?.length || c.files.length) > 6 ? ', …' : '');
