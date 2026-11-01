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

const diff = (cwd, args) => spawnSync('git', ['-c', 'core.quotepath=off', 'diff', '--no-ext-diff', '--no-color', '--no-textconv', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

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
