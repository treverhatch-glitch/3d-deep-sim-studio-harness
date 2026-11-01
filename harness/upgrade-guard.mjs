#!/usr/bin/env node
/**
 * harness/upgrade-guard.mjs — 2.58.5 (H-4): the board is committed before a harness upgrade, never stashed.
 *
 * On a crew's PC the 2.58.2 upgrade stashed the dirty main checkout ("pre-2.58.2-upgrade") and the board went with it:
 * DONE.md rows for four finished tasks and five NEXT.md tasks added that morning, never committed. A finished task
 * reopened and seven crew sessions were spent on it. The board files are plain studio state that other agents write
 * all day; a stash hides them, a merge keeps both sides.
 *
 *   npm run upgrade -- --check      exit 1 while a board file is uncommitted (names them and the command to commit
 *                                   them); also names stash entries that hold board changes (restore by merge, below)
 *   npm run upgrade -- --snapshot   copy the board files to .studio/board-snapshots/<time>/ (gitignored), then check
 *
 * Board files: studio/NEXT.md, studio/DONE.md, studio/task-holds.json, studio/pending-review.json, studio/handoffs/.
 * It never stashes, commits or changes a tracked file itself. docs/RELEASE.md "Taking a harness update" has the steps.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BOARD_FILES = ['studio/NEXT.md', 'studio/DONE.md', 'studio/task-holds.json', 'studio/pending-review.json', 'studio/handoffs'];
const git = (args, cwd = ROOT) => spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Board files with uncommitted changes (modified, staged, new or deleted): [{ file, state }], or null when not a git checkout. */
export function dirtyBoard(root = ROOT) {
  const r = git(['status', '--porcelain', '--untracked-files=all', '--', ...BOARD_FILES], root);
  if (r.status !== 0) return null;
  return r.stdout.split('\n').filter((l) => l.length > 3).map((l) => ({ state: l.slice(0, 2), file: l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '') }));
}

/** Stash entries that hold changes to board files: [{ ref, sha, message, files }]. */
export function stashesWithBoard(root = ROOT) {
  const list = git(['stash', 'list', '--format=%gd%x1f%H%x1f%gs'], root);
  if (list.status !== 0) return [];
  const out = [];
  for (const line of list.stdout.split('\n').filter(Boolean)) {
    const [ref, sha, message] = line.split('\x1f');
    // The stash's tracked changes against the commit it was made on, plus its untracked files (third parent), if any.
    const files = new Set(git(['diff', '--name-only', `${sha}^1`, sha, '--', ...BOARD_FILES], root).stdout.split('\n').filter(Boolean));
    if (git(['rev-parse', '--verify', '--quiet', `${sha}^3`], root).status === 0) {
      for (const f of git(['ls-tree', '-r', '--name-only', `${sha}^3`, '--', ...BOARD_FILES], root).stdout.split('\n').filter(Boolean)) files.add(f);
    }
    if (files.size) out.push({ ref, sha, message, files: [...files] });
  }
  return out;
}

/** Copy the board files as they are now to .studio/board-snapshots/<time>/; returns that folder (repo-relative). */
export function snapshotBoard(root = ROOT, now = new Date()) {
  const rel = path.posix.join('.studio', 'board-snapshots', now.toISOString().replace(/[:.]/g, '-'));
  const dest = path.join(root, rel);
  for (const f of BOARD_FILES) {
    const src = path.join(root, f);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    fs.cpSync(src, path.join(dest, f), { recursive: true });
  }
  return rel;
}

export function checkUpgrade(root = ROOT) {
  const dirty = dirtyBoard(root);
  const stashes = stashesWithBoard(root);
  const lines = [];
  if (dirty === null) return { ok: false, dirty: [], stashes, lines: ['[upgrade] not a git checkout: nothing to check'] };
  if (dirty.length) {
    lines.push(`[upgrade] STOP: ${dirty.length} board file(s) are not committed, and an upgrade must never stash them:`);
    for (const d of dirty) lines.push(`  ${d.state} ${d.file}`);
    lines.push('[upgrade] Commit the board first (it is studio state; other agents keep writing it):');
    lines.push(`  git add -- ${BOARD_FILES.join(' ')}`);
    lines.push('  git commit -m "board: snapshot before harness upgrade"');
    lines.push('[upgrade] Then run npm run upgrade -- --check again. (--snapshot also copies them to .studio/board-snapshots/.)');
  } else lines.push('[upgrade] OK: every board file is committed.');
  if (stashes.length) {
    lines.push(`[upgrade] note: ${stashes.length} stash entr${stashes.length === 1 ? 'y holds' : 'ies hold'} board changes that may not be on the board now:`);
    for (const s of stashes) lines.push(`  ${s.ref} ${s.sha.slice(0, 10)} "${s.message}": ${s.files.join(', ')}`);
    lines.push('[upgrade] Restore by merge, never by dropping or checking out a side: commit the board as it is now, then');
    lines.push('  git stash apply <sha>   (a three-way merge; resolve each board conflict by keeping the rows from both sides)');
    lines.push('  and commit. Drop the entry only after the board has every row (git stash list shows it until then).');
  }
  return { ok: dirty.length === 0, dirty, stashes, lines };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  if (a.includes('--help') || a.includes('-h')) {
    console.log('Usage: npm run upgrade -- --check | --snapshot   (before taking a harness update: the board must be committed, never stashed; docs/RELEASE.md)');
    process.exit(0);
  }
  if (a.includes('--snapshot')) {
    try { console.log(`[upgrade] board copied to ${snapshotBoard()}`); } catch (e) { console.error(`[upgrade] could not copy the board: ${e.message}`); process.exit(1); }
  }
  const r = checkUpgrade();
  for (const l of r.lines) (r.ok ? console.log : console.error)(l);
  process.exit(r.ok ? 0 : 1);
}
