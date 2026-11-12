/**
 * harness/eol-only.mjs — 2.58.3 (crew P-035): tracked files whose only difference is line endings.
 *
 * On Windows a tool that rewrites a committed file with other line endings (a test runner's snapshot, an editor)
 * leaves it "modified" in `git status` though nothing in it changed. The harness's dirty checks (task done, the
 * lane copy's "Commit your work first", the verify record's clean-tree flag, onboard --sync) skip such a file and
 * name it in a note ("line endings only, ignored").
 *
 * Only a tracked file modified in the index and/or the working tree (status M), whose diff ignoring a CR at the end
 * of a line is empty, counts. Real content changes, binary files, mode changes,
 * untracked files (??), additions, deletions, renames and conflicts never do.
 */
import { spawnSync } from 'node:child_process';

const diff = (cwd, args) => spawnSync('git', ['-c', 'core.quotepath=off', 'diff', '--no-ext-diff', '--no-color', '--no-textconv', ...args], { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/**
 * One side (the index against HEAD, or the working tree against the index) differs only in line endings: its diff
 * ignoring a CR at the end of a line prints nothing at all. (With `* text=auto` git status says M while even the plain
 * diff is empty, the crew's case.) A mode change or a binary file still prints a header, so it counts as real.
 */
function sideIsEol(cwd, file, cached) {
  const loose = diff(cwd, [...(cached ? ['--cached'] : []), '--ignore-cr-at-eol', '--', file]);
  return loose.status === 0 && !loose.stdout.trim();
}

/** The path of a `git status --porcelain` line (v1), or null when it is quoted (git escaped it) or a rename. */
function porcelainPath(line) {
  const p = line.slice(3);
  if (p.includes(' -> ') || p.startsWith('"')) return null;
  return p;
}

/** True when this porcelain line is a tracked file whose only change is line endings. */
export function isEolOnlyLine(cwd, line) {
  if (!line || line.length < 4) return false;
  const x = line[0];
  const y = line[1];
  if (!/[ M]/.test(x) || !/[ M]/.test(y) || (x === ' ' && y === ' ')) return false;
  const file = porcelainPath(line);
  if (!file) return false;
  if (x === 'M' && !sideIsEol(cwd, file, true)) return false;
  if (y === 'M' && !sideIsEol(cwd, file, false)) return false;
  return true;
}

/**
 * Split `git status --porcelain` lines into the ones that count and the line-ending-only files:
 * { real: [line…], eol: [path…] }. At most `limit` files are diffed (the rest count as real: never a silent pass).
 */
export function splitEolOnly(cwd, lines, { limit = 200 } = {}) {
  const real = [];
  const eol = [];
  let checked = 0;
  for (const line of lines) {
    if (line && line.length > 3 && checked < limit && /^[ M][ M]/.test(line)) {
      checked += 1;
      if (isEolOnlyLine(cwd, line)) { eol.push(line.slice(3)); continue; }
    }
    real.push(line);
  }
  return { real, eol };
}

/** The note shown when files were skipped. */
export const eolNote = (eol) => `${eol.length} file${eol.length === 1 ? '' : 's'} differ${eol.length === 1 ? 's' : ''} in line endings only, ignored (${eol.slice(0, 3).join(', ')}${eol.length > 3 ? ` and ${eol.length - 3} more` : ''}); add \`* text=auto\` or \`*.snap text eol=lf\` to .gitattributes to stop it`;

/**
 * 2.84 (m): PHANTOM entries. A tracked file that a `.gitattributes` line routes through a filter (Git LFS, a clean
 * filter) while it was committed as a plain blob shows as modified in every checkout although nobody touched it: git
 * cleans the working file before comparing, and the cleaned bytes are not the committed blob. `task done` refused a
 * crew's task for one such file ("1 uncommitted file(s) ... URP.png: commit them first"). A path counts as phantom
 * only when it is reported as modified (` M`, `M `, `MM`; never added, deleted, untracked, renamed or conflicted) and its
 * working-tree bytes, unfiltered, hash to the blob HEAD holds for it (git hash-object --no-filters = HEAD:<path>).
 * At most `limit` paths are hashed; beyond that every line counts as real (never a silent pass). Never throws.
 * { real: [line…], phantom: [path…] }: real keeps the input lines; phantom holds repo-relative paths.
 */
export function splitPhantom(cwd, lines, { limit = 200 } = {}) {
  const all = (lines || []).filter(Boolean);
  try {
    // Only an UNSTAGED modification (" M") can be a phantom: once something is staged for the path, a commit would
    // change the committed blob, so it counts as the session's.
    const cand = all.filter((l) => l.length > 3 && l.slice(0, 2) === ' M' && porcelainPath(l));
    if (!cand.length || cand.length > limit) return { real: all, phantom: [] };
    const git = (args, input) => spawnSync('git', ['-c', 'core.quotepath=off', ...args], { windowsHide: true, cwd, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
    const top = git(['rev-parse', '--show-toplevel']);
    if (top.status !== 0) return { real: all, phantom: [] };
    const root = top.stdout.trim();
    const paths = cand.map(porcelainPath);
    // The committed blobs (ls-tree --full-tree takes repo-relative paths from any folder; -z keeps names as they are).
    const ls = spawnSync('git', ['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', ...paths], { windowsHide: true, cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (ls.status !== 0) return { real: all, phantom: [] };
    const blob = new Map();
    for (const rec of String(ls.stdout || '').split('\0')) {
      const m = rec.match(/^\d+ blob ([0-9a-f]{40,64})\t(.+)$/s);
      if (m) blob.set(m[2], m[1]);
    }
    const known = paths.filter((p) => blob.has(p));
    if (!known.length) return { real: all, phantom: [] };
    // The working-tree bytes as they are, no clean filter and no line-ending rule (one call for all the paths).
    const ho = spawnSync('git', ['hash-object', '--no-filters', '--stdin-paths'], { windowsHide: true, cwd: root, encoding: 'utf8', input: `${known.join('\n')}\n`, maxBuffer: 64 * 1024 * 1024 });
    if (ho.status !== 0) return { real: all, phantom: [] };
    const hashes = String(ho.stdout || '').trim().split(/\r?\n/);
    if (hashes.length !== known.length) return { real: all, phantom: [] };
    const same = new Set(known.filter((p, i) => hashes[i] === blob.get(p)));
    const real = [];
    const phantom = [];
    for (const l of all) {
      const p = l.length > 3 && /^[ M][ M]/.test(l) ? porcelainPath(l) : null;
      if (p && same.has(p)) phantom.push(p); else real.push(l);
    }
    return { real, phantom };
  } catch { return { real: all, phantom: [] }; }
}

/** 2.84 (m): the one line a command prints when it dropped phantom files (said once per command). */
export const phantomNote = (phantom) => `ignored ${phantom.length} file(s) git reports as modified whose content equals the committed version (a filter or line-ending rule): ${phantom.slice(0, 3).join(', ')}${phantom.length > 3 ? ` and ${phantom.length - 3} more` : ''}`;
