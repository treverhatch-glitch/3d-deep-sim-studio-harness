/**
 * harness/trailers.mjs — 2.79.1: does git read a commit's "Golden-Reason:" line as a trailer?
 *
 * The merge train (harness/train.mjs) reads trailers the way git does (%(trailers)). A "Golden-Reason: why" line right
 * under the subject, or in the middle of the body, is not a trailer to git, so the train handed T-322 back three times
 * while the builder believed it had added one. misplacedTrailers() finds those lines with `git interpret-trailers
 * --parse` (the same parser), so `task done` / `task done --check` and the train's hand-back share one answer.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const git = (cwd, args, input) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });

/**
 * Commits in base..head whose message has a `key:` line that git does not parse as a trailer: [{ sha, subject }].
 * 2.85 (B-138): `only({ sha, subject, tasks, agents })` keeps the commits to judge (tasks and agents: the commit's
 * Studio-Task and Studio-Agent trailers); without it every commit in the range is judged.
 */
export function misplacedTrailers(cwd, base, head = 'HEAD', key = 'Golden-Reason', { only = null } = {}) {
  const log = git(cwd, ['log', '--format=%H%x1f%(trailers:key=Studio-Task,valueonly,separator=%x2C)%x1f%(trailers:key=Studio-Agent,valueonly,separator=%x2C)%x1f%B%x1e', `${base}..${head}`]);
  if (log.status !== 0) return [];
  const lineRe = new RegExp(`^${key}:[ \\t]*\\S`, 'im');
  const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const rec of String(log.stdout).split('\x1e')) {
    const [sha, tasks, agents, ...rest] = rec.replace(/^\s+/, '').split('\x1f');
    const msg = rest.join('\x1f').replace(/\r\n?/g, '\n');
    if (!sha || !lineRe.test(msg)) continue;
    if (only && !only({ sha: sha.trim(), subject: msg.split('\n')[0], tasks: list(tasks), agents: list(agents) })) continue;
    const parsed = git(cwd, ['interpret-trailers', '--parse'], msg.trimEnd() + '\n');
    const read = parsed.status === 0 && lineRe.test(String(parsed.stdout).replace(/\r\n?/g, '\n'));
    if (!read) out.push({ sha: sha.trim(), subject: msg.split('\n')[0].slice(0, 100) });
  }
  return out;
}

/**
 * 2.85 (B-138): which commits are a task's own, for a check run from the main checkout (where base..HEAD holds every
 * commit that landed since the task started, other roles' board commits too): a commit whose Studio-Task trailer names the
 * task, else (no Studio-Task) one by an agent that claimed the task (its Studio-Agent trailer) or whose subject starts with
 * the task's id. A commit that can't be tied to the task is not judged.
 */
export const ownCommitOf = (taskId, owners = []) => {
  const who = new Set(owners.filter(Boolean));
  const lead = new RegExp(`^\\W*${String(taskId).replace(/[^\w-]/g, '')}(?![\\w-])`);
  return (c) => (c.tasks.length ? c.tasks.includes(taskId) : c.agents.some((a) => who.has(a)) || lead.test(c.subject || ''));
};

/** The refusal text for those commits: where the line must go and the exact fix, in one sentence. */
export function misplacedTrailerText(found, key = 'Golden-Reason') {
  const list = found.slice(0, 3).map((f) => `${f.sha.slice(0, 8)} "${f.subject}"`).join(', ');
  // 2.85: one sentence an agent can act on: which commit, and the message shape git reads as a trailer.
  return `${found.length === 1 ? 'Commit' : 'Commits'} ${list} ${found.length === 1 ? 'has' : 'have'} a "${key}:" line git does not read as a trailer, so the merge train would not see it: fix it with git commit --amend (an older commit: git rebase -i, reword) so the message ends with a blank line, then ${key}: <why> as the last paragraph of the commit message, on one line with no text after it.`;
}

/**
 * 2.85 (B-138): put a misplaced `key:` line into the message's trailer block. Used by the commit-msg hook before it adds
 * the Studio-* trailers: a message whose "Golden-Reason:" sat in the body (or wrapped onto a second line) got those
 * trailers as a new last paragraph, and its Golden-Reason was left above a blank line where git doesn't read it. The line
 * (with its unindented wrapped lines up to a blank line or another "Key:" line) is joined into one line and moved to the
 * end, after a blank line, before the other trailers already there. Returns the message, unchanged when nothing is misplaced.
 */
export function fixTrailerBlock(message, key = 'Golden-Reason', { parse = (m) => git(process.cwd(), ['interpret-trailers', '--parse'], m) } = {}) {
  const msg = String(message || '').replace(/\r\n?/g, '\n');
  const lines = msg.split('\n');
  const lineRe = new RegExp(`^${key}:[ \\t]*\\S`, 'i');
  const body = lines.filter((l) => !l.startsWith('#'));
  if (!body.some((l) => lineRe.test(l))) return message;
  const p = parse(body.join('\n').trimEnd() + '\n');
  if (p.status === 0 && new RegExp(`^${key}:[ \\t]*\\S`, 'im').test(String(p.stdout || ''))) return message;
  const taken = [];
  const rest = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lineRe.test(lines[i]) || lines[i].startsWith('#')) { rest.push(lines[i]); continue; }
    let one = lines[i].trim();
    while (i + 1 < lines.length && lines[i + 1].trim() && !/^[A-Za-z][\w-]*:\s/.test(lines[i + 1]) && !lines[i + 1].startsWith('#')) { i += 1; one += ` ${lines[i].trim()}`; }
    taken.push(one);
  }
  // The message's own text (comments, which git drops, stay at the end) and its last paragraph.
  const comments = [];
  while (rest.length && (rest[rest.length - 1].startsWith('#') || !rest[rest.length - 1].trim())) { const l = rest.pop(); if (l.startsWith('#')) comments.unshift(l); }
  let start = rest.length;
  while (start > 0 && rest[start - 1].trim()) start -= 1;
  const last = rest.slice(start);
  const isBlock = start > 0 && last.length && last.every((l) => /^[A-Za-z][\w-]*:\s/.test(l) || /^\s/.test(l));
  const head = isBlock ? rest.slice(0, start) : rest;
  while (head.length && !head[head.length - 1].trim()) head.pop();
  const out = [...head, '', ...taken, ...(isBlock ? last : []), ...(comments.length ? ['', ...comments] : [])];
  return `${out.join('\n')}\n`;
}

if (process.argv[1] && /trailers\.mjs$/.test(process.argv[1].replace(/\\/g, '/')) && process.argv[2] === 'fix' && process.argv[3]) {
  // `node harness/trailers.mjs fix <message file>` (the commit-msg hook): never fails the commit.
  try {
    const f = process.argv[3];
    const before = fs.readFileSync(f, 'utf8');
    const after = fixTrailerBlock(before);
    if (after !== before) { fs.writeFileSync(f, after); process.stderr.write('[commit-msg] note: moved the Golden-Reason line into the trailer block (the last paragraph), where git reads it\n'); }
  } catch { /* the train still judges the trailers */ }
}
