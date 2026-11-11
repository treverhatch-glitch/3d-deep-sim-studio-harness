/**
 * harness/allowlist.mjs — what a launched agent may run without asking (2.30c, #15).
 *
 * One list, used twice: the launcher passes it to Claude Code (--allowedTools), and every kickoff
 * prints it, so an agent knows up front instead of finding out by a refused command. The list is the
 * one 2.23 set (node, npm, npx, ffmpeg, blender, dotnet since 2.80, read-only git plus add/commit, ls, mkdir, cp, mv).
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './event.mjs';

export const ALLOWED = [
  ['node', 'node *'],
  ['npm', 'npm *'],
  ['npx', 'npx *'],
  ['ffmpeg', 'ffmpeg *'],
  ['blender', 'blender *'],
  ['dotnet', 'dotnet *'], // 2.80.0: a Unity studio's .NET sim tests (the crew carried this as a local patch)
  ['git status', 'git status*'],
  ['git diff', 'git diff *'],
  ['git add', 'git add *'],
  ['git commit', 'git commit *'],
  ['git log', 'git log *'],
  ['git show', 'git show *'],
  ['ls', 'ls *'],
  ['mkdir', 'mkdir *'],
  ['cp', 'cp *'],
  ['mv', 'mv *'],
];

/**
 * 2.83: a studio's own entries. studio/allowlist.json: an array of [label, pattern] string pairs (at most 50, a pattern
 * at most 300 characters and on one line), appended to the built-in list, so a studio can allow a tool by its full install
 * path without editing the harness. Returns { entries, problems }; a missing file is no entries and no problem, a file
 * that is not valid is no entries and one problem; a bad pair is skipped and named. Never throws.
 */
export function studioAllowed(root = REPO_ROOT) {
  const file = path.join(root, 'studio', 'allowlist.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { entries: [], problems: [] }; }
  let data;
  try { data = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) { return { entries: [], problems: [`studio/allowlist.json is not valid JSON (${String(e.message).slice(0, 80)}); ignored`] }; }
  if (!Array.isArray(data)) return { entries: [], problems: ['studio/allowlist.json must be an array of [label, pattern] pairs; ignored'] };
  const entries = [];
  const problems = [];
  if (data.length > 50) problems.push(`studio/allowlist.json has ${data.length} entries; only the first 50 are read`);
  data.slice(0, 50).forEach((row, i) => {
    const ok = Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && typeof row[1] === 'string' && row[0].trim() && row[1].trim() && row[1].length <= 300 && !/[\r\n]/.test(row[0] + row[1]);
    if (ok) entries.push([row[0], row[1]]);
    else problems.push(`studio/allowlist.json entry ${i + 1} skipped: it needs a label and a one-line pattern of at most 300 characters`);
  });
  return { entries, problems };
}
/** The built-in list plus the studio's entries (studio/allowlist.json). ALLOWED stays the built-in list alone. */
export const allowed = (root = REPO_ROOT) => [...ALLOWED, ...studioAllowed(root).entries];
/** Claude Code's --allowedTools patterns, one per argument (P-066: the launcher passes each as its own argument, so no
 * shell or quoting can split "Bash(git log *)" at its space). */
/**
 * 2.79.1: an engine pass works in a worktree of the engine's repo that is not its working folder, so it runs git there
 * as `git -C <that folder> …`. Those forms are allowed for that one folder: status, diff, log, add and commit (and
 * nothing else: no push, no checkout or switch of another branch, no reset).
 */
export const engineGitVerbs = ['status', 'diff', 'log', 'add', 'commit'];
export const engineGitPatterns = (dir) => {
  const d = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return d ? engineGitVerbs.flatMap((v) => [`git -C ${d} ${v}`, `git -C ${d} ${v} *`]) : [];
};
export const allowedToolsList = ({ engineDir = null, root = REPO_ROOT } = {}) => [...allowed(root).map(([, p]) => `Bash(${p})`), ...engineGitPatterns(engineDir).map((p) => `Bash(${p})`)];
/** The same list as one comma-separated value (the printed launch line, for a person's shell). */
export const allowedTools = (root = REPO_ROOT) => allowedToolsList({ root }).join(',');
/** The kickoff's paragraph: exactly what runs without a prompt, and what doesn't. */
export function allowedNote(root = REPO_ROOT) {
  // M5 (2.58.3): each Bash call is matched as a whole, so a chain or a prefix stops for approval even when every part
  // is on the list (the crew lost turns to "cat A ; cat B", "head -5; …", "cd ../.. && …", "STUDIO_LOCK_OWNER=x git …").
  return `You may run, without asking: ${allowed(root).map(([n]) => `\`${n}\``).join(', ')}. Anything else (git push, git reset, rm, curl, installing tools) is not on the list: it stops for a person's yes, so don't plan around it; hand back with a note instead.`
    + ` One command per Bash call: no \`;\`, \`&&\` or \`||\` chains, no \`cd … &&\` first, and no \`VAR=x\` prefix in front of a command (your \`$STUDIO_LOCK_OWNER\` is already set; pass \`--agent <you>\` where a command takes it). A chained or prefixed line stops for approval even when each part is allowed.`
    + ` Read files with your Read, Grep and Glob tools (or your tool's own file reader), not \`cat\`, \`head\`, \`tail\` or \`grep\` in Bash.`;
}
