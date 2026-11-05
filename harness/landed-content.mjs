/**
 * harness/landed-content.mjs — 2.78.1 (d): is a branch's work already on main, whatever its commit hashes say?
 *
 * Two places asked "are these commits landed?" by hash only, and a landing under other hashes (a rescue or another task
 * carrying the work, a rebase, a merge of main after the check) kept a task or its dependants waiting:
 *   bringsNothing(root, { base, head })     head adds nothing to base: it is an ancestor of base; or every one of its
 *                                           own non-merge commits has an equal patch on base (git cherry: all "-"); or
 *                                           merging it into base changes nothing (git merge-tree --write-tree gives
 *                                           base's own tree; git 2.38+). { nothing, how, why }
 *   onlyMainMerges(root, { main, checked, head })
 *                                           after a landing of `checked`: the lane's commits not on main are merges
 *                                           only, each with a parent on main (merges of main), and together they bring
 *                                           nothing beyond main (bringsNothing by tree or ancestry). { ok, commits, why }
 *   gitMainRoot(root), mainRefOf(root)      the main checkout (from a lane copy too: git's common dir) and its branch.
 * Read-only git (no index, no files). Never throws: a git error is "not shown", so the old wait stays.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');

/** The main checkout of the repository `root` is in (a lane copy shares its git's common dir). */
export function gitMainRoot(root) {
  const common = out(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  if (!common) return root;
  return path.basename(common) === '.git' ? path.dirname(common) : root;
}

/** The main checkout's branch as a ref (refs/heads/<name>), or '' when it can't be read. */
export function mainRefOf(root) {
  const b = out(git(gitMainRoot(root), 'symbolic-ref', '--short', 'HEAD'));
  return b ? `refs/heads/${b}` : '';
}

const treeOf = (root, rev) => out(git(root, 'rev-parse', '--verify', '--quiet', `${rev}^{tree}`));

/** Does `head` bring nothing to `base`? { nothing, how: 'ancestor'|'patch'|'tree'|null, why } */
export function bringsNothing(root, { base, head } = {}) {
  try {
    if (!base || !head) return { nothing: false, how: null, why: 'no base or head' };
    if (!treeOf(root, base) || !treeOf(root, head)) return { nothing: false, how: null, why: `${!treeOf(root, base) ? base : head} is not a commit here` };
    if (git(root, 'merge-base', '--is-ancestor', head, base).status === 0) return { nothing: true, how: 'ancestor', why: `${String(head).slice(0, 12)} is already in ${base}` };
    const ch = git(root, 'cherry', base, head);
    if (ch.status === 0) {
      const lines = String(ch.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (lines.length && lines.every((l) => l.startsWith('-'))) return { nothing: true, how: 'patch', why: `each of its ${lines.length} commit(s) has an equal patch on ${base} (git cherry)` };
    }
    const mt = git(root, 'merge-tree', '--write-tree', '--no-messages', base, head);
    if (mt.status === 0) {
      const t = String(mt.stdout || '').split('\n')[0].trim();
      if (t && t === treeOf(root, base)) return { nothing: true, how: 'tree', why: `merging it into ${base} changes no file (git merge-tree)` };
      return { nothing: false, how: null, why: 'merging it into main would change files' };
    }
    return { nothing: false, how: null, why: mt.status === 1 ? 'it conflicts with main' : 'git merge-tree --write-tree is not available (git 2.38+)' };
  } catch (e) { return { nothing: false, how: null, why: e.message }; }
}

/**
 * After `checked` landed on `main`: are the lane's other commits (on `head`, not on main) merges of main only, adding
 * nothing beyond main? { ok, commits: [sha], why }
 */
export function onlyMainMerges(root, { main, checked, head } = {}) {
  try {
    if (!main || !checked || !head || checked === head) return { ok: false, commits: [], why: 'nothing after the checked head' };
    if (git(root, 'merge-base', '--is-ancestor', checked, main).status !== 0) return { ok: false, commits: [], why: 'the checked head is not on main' };
    const rl = git(root, 'rev-list', '--parents', head, '--not', checked, main);
    if (rl.status !== 0) return { ok: false, commits: [], why: 'git rev-list failed' };
    const rows = String(rl.stdout || '').split('\n').map((s) => s.trim().split(/\s+/)).filter((r) => r[0]);
    if (!rows.length) return { ok: false, commits: [], why: 'no commit beyond main' };
    const notMerge = rows.filter((r) => r.length < 3);
    if (notMerge.length) return { ok: false, commits: rows.map((r) => r[0]), why: `${notMerge.length} commit(s) after the check are not merges (${notMerge.slice(0, 3).map((r) => r[0].slice(0, 8)).join(', ')})` };
    const foreign = rows.filter((r) => !r.slice(1).some((p) => git(root, 'merge-base', '--is-ancestor', p, main).status === 0));
    if (foreign.length) return { ok: false, commits: rows.map((r) => r[0]), why: `merge ${foreign[0][0].slice(0, 8)} has no parent on main` };
    const b = bringsNothing(root, { base: main, head });
    if (!b.nothing || b.how === 'patch') return { ok: false, commits: rows.map((r) => r[0]), why: `the merges bring something beyond main (${b.why})` };
    return { ok: true, commits: rows.map((r) => r[0]), why: `the ${rows.length} commit(s) after the check are merges of main that bring nothing beyond it (${b.why})` };
  } catch (e) { return { ok: false, commits: [], why: e.message }; }
}
