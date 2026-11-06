/**
 * harness/trailers.mjs — 2.79.1: does git read a commit's "Golden-Reason:" line as a trailer?
 *
 * The merge train (harness/train.mjs) reads trailers the way git does (%(trailers)). A "Golden-Reason: why" line right
 * under the subject, or in the middle of the body, is not a trailer to git, so the train handed T-322 back three times
 * while the builder believed it had added one. misplacedTrailers() finds those lines with `git interpret-trailers
 * --parse` (the same parser), so `task done` / `task done --check` and the train's hand-back share one answer.
 */
import { spawnSync } from 'node:child_process';

const git = (cwd, args, input) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });

/** Commits in base..head whose message has a `key:` line that git does not parse as a trailer: [{ sha, subject }]. */
export function misplacedTrailers(cwd, base, head = 'HEAD', key = 'Golden-Reason') {
  const log = git(cwd, ['log', '--format=%H%x1f%B%x1e', `${base}..${head}`]);
  if (log.status !== 0) return [];
  const lineRe = new RegExp(`^${key}:[ \\t]*\\S`, 'im');
  const out = [];
  for (const rec of String(log.stdout).split('\x1e')) {
    const [sha, ...rest] = rec.replace(/^\s+/, '').split('\x1f');
    const msg = rest.join('\x1f').replace(/\r\n?/g, '\n');
    if (!sha || !lineRe.test(msg)) continue;
    const parsed = git(cwd, ['interpret-trailers', '--parse'], msg.trimEnd() + '\n');
    const read = parsed.status === 0 && lineRe.test(String(parsed.stdout).replace(/\r\n?/g, '\n'));
    if (!read) out.push({ sha: sha.trim(), subject: msg.split('\n')[0].slice(0, 100) });
  }
  return out;
}

/** The refusal text for those commits: where the line must go and the command that fixes the last commit. */
export function misplacedTrailerText(found, key = 'Golden-Reason') {
  const list = found.slice(0, 3).map((f) => `${f.sha.slice(0, 8)} "${f.subject}"`).join(', ');
  return `${found.length === 1 ? 'A commit has' : `${found.length} commits have`} a "${key}:" line that git does not read as a trailer (${list}), so the merge train would not see it. `
    + `It must go after a blank line, then ${key}: <why> as the last paragraph of the commit message (no text after it). `
    + `Fix the last commit with: git commit --amend (edit the message so it ends with a blank line and the ${key}: line; for an older commit, git rebase -i or a new commit with -m "${key}: <why>").`;
}
