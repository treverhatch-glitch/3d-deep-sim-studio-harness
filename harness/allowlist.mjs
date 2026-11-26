/**
 * harness/allowlist.mjs — what a launched agent may run without asking (2.30c, #15).
 *
 * One list, used twice: the launcher passes it to Claude Code (--allowedTools), and every kickoff
 * prints it, so an agent knows up front instead of finding out by a refused command. The list is the
 * one 2.23 set (node, npm, npx, ffmpeg, blender, dotnet since 2.80, read-only git plus add/commit, ls, mkdir, cp, mv).
 * 2.99 (D): a studio entry whose program path has a space gives quoted Bash rules and PowerShell call-operator rules.
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
 * path without editing the harness. 2.99 (D): an optional third element { "roles": [...] } limits an entry to those roles.
 * Returns { entries, problems }: no file is no problem, a bad file is one problem, a bad entry is skipped and named.
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
    const skip = (why) => problems.push(`studio/allowlist.json entry ${i + 1} skipped: ${why}`);
    const ok = Array.isArray(row) && (row.length === 2 || row.length === 3) && typeof row[0] === 'string' && typeof row[1] === 'string' && row[0].trim() && row[1].trim() && row[1].length <= 300 && !/[\r\n]/.test(row[0] + row[1]);
    if (!ok) return skip('it needs a label and a one-line pattern of at most 300 characters');
    const roles = row[2] === undefined ? null : row[2]?.roles;
    if (roles !== null && !(Array.isArray(roles) && roles.length && roles.every((r) => typeof r === 'string' && r.trim()))) return skip('its third element must be { "roles": ["<role>", ...] }');
    if (opensUp(row[1])) return skip('its pattern starts with a wildcard (name the command: at least 3 characters before the first *)');
    const r = entryRules(row[1]);
    if (r.problem) return skip(r.problem);
    entries.push(roles ? [row[0], row[1], { roles }] : [row[0], row[1]]);
  });
  return { entries, problems };
}

// A rule that is a wildcard from (nearly) its first character would allow any command: at least 3 characters of the
// command's own name (quotes, spaces and PowerShell's & not counted) come before the first `*`.
const opensUp = (rule) => rule.trim().startsWith('*') || rule.split('*')[0].replace(/[\s"'&]/g, '').length < 3;

/**
 * 2.99 (D): the rules one pattern gives, per tool: { Bash: [...], PowerShell: [...] } or { problem }. Claude Code matches
 * a rule against the command text as typed, so a program path with a space must be in the rule quoted, the way it runs:
 * "…" and '…' for Bash, & "…" and & '…' for PowerShell, each with / and \ (Windows takes both). The arguments stay as
 * written. A program path written quoted, or ending in .exe/.cmd/.bat/.com, is found; any other pattern is Bash only.
 */
export function entryRules(pattern) {
  const m = /^\s*(["'])([^"']+)\1((?:\s.*)?)$/.exec(pattern) || /^\s*()([^\s"'][^"']*?\.(?:exe|cmd|bat|com))((?:\s.*)?)$/i.exec(pattern);
  if (!m || !/\s/.test(m[2])) return { Bash: [pattern], PowerShell: [] };
  if (/[*?$`]/.test(m[2])) return { problem: 'its program path holds a wildcard, $ or a backtick (name one program)' };
  const paths = [...new Set([m[2].replace(/\\/g, '/'), m[2].replace(/\//g, '\\')])];
  const out = { Bash: paths.flatMap((p) => [`"${p}"${m[3]}`, `'${p}'${m[3]}`]), PowerShell: paths.flatMap((p) => [`& "${p}"${m[3]}`, `& '${p}'${m[3]}`]) };
  return [...out.Bash, ...out.PowerShell].some(opensUp) ? { problem: 'its program name is too short (at least 3 characters)' } : out;
}

/** Whether one rule's pattern matches one command, as Claude Code documents it: `*` is any text, and a trailing ` *` (the
 * only `*`) also matches the bare command. PowerShell matches without case. */
export function ruleMatches(pattern, command, { ci = false } = {}) {
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\s\\S]*');
  const bare = pattern.endsWith(' *') && pattern.indexOf('*') === pattern.length - 1;
  return new RegExp(`^${bare ? `${esc(pattern.slice(0, -2))}(?: [\\s\\S]*)?` : esc(pattern)}$`, ci ? 'i' : '').test(command);
}

/** The built-in list plus the studio's entries for this role (an entry with roles is left out for another role or none).
 * ALLOWED stays the built-in list alone. */
export const allowed = (root = REPO_ROOT, role = null) => [...ALLOWED, ...studioAllowed(root).entries.filter(([, , o]) => !o || o.roles.includes(role))];
/**
 * 2.79.1: an engine pass works in a worktree of the engine's repo that is not its working folder, so it runs git there
 * as `git -C <that folder> …`. Those forms are allowed for that one folder: status, diff, log, add and commit (and
 * nothing else: no push, no checkout or switch of another branch, no reset).
 */
export const engineGitVerbs = ['status', 'diff', 'log', 'add', 'commit'];
/** 2.98: git verbs that only read, for an agy porter's engine worktree (agy-allow.mjs, regex form only). */
export const engineGitReadVerbs = ['show', 'rev-parse', 'merge-base', 'ls-files', 'grep'];
export const engineGitPatterns = (dir) => {
  const d = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return d ? engineGitVerbs.flatMap((v) => [`git -C ${d} ${v}`, `git -C ${d} ${v} *`]) : [];
};
/** Claude Code's --allowedTools patterns, one per argument (P-066: the launcher passes each as its own argument, so no
 * shell or quoting can split "Bash(git log *)" at its space). 2.99 (D): for this role, with PowerShell rules for a spaced program path. */
export const allowedToolsList = ({ engineDir = null, root = REPO_ROOT, role = null } = {}) => {
  const rules = allowed(root, role).map(([, p]) => entryRules(p));
  return [...rules.flatMap((r) => r.Bash.map((p) => `Bash(${p})`)), ...rules.flatMap((r) => r.PowerShell.map((p) => `PowerShell(${p})`)), ...engineGitPatterns(engineDir).map((p) => `Bash(${p})`)];
};
/** The same list as one comma-separated value (the printed launch line, for a person's shell). */
export const allowedTools = (root = REPO_ROOT) => allowedToolsList({ root }).join(',');
/** The kickoff's paragraph: exactly what runs without a prompt, and what doesn't. */
export function allowedNote(root = REPO_ROOT, role = null) {
  // M5 (2.58.3): each Bash call is matched as a whole, so a chain or a prefix stops for approval even when every part
  // is on the list (the crew lost turns to "cat A ; cat B", "head -5; …", "cd ../.. && …", "STUDIO_LOCK_OWNER=x git …").
  // 2.99 (D): a studio entry is allowed only as spelled in its rules, so the note shows the spelling, one line per entry.
  const own = allowed(root, role).slice(ALLOWED.length).map(([n, p]) => { const r = entryRules(p); return `- ${n}: Bash \`${r.Bash[0]}\`${r.PowerShell.length ? `; PowerShell \`${r.PowerShell[0]}\`` : ' (Bash tool only)'}`; });
  return `You may run, without asking: ${allowed(root, role).map(([n]) => `\`${n}\``).join(', ')}. Anything else (git push, git reset, rm, curl, installing tools) is not on the list: it stops for a person's yes, so don't plan around it; hand back with a note instead.`
    + ` One command per Bash call: no \`;\`, \`&&\` or \`||\` chains, no \`cd … &&\` first, and no \`VAR=x\` prefix in front of a command (your \`$STUDIO_LOCK_OWNER\` is already set; pass \`--agent <you>\` where a command takes it). A chained or prefixed line stops for approval even when each part is allowed.`
    + ` Read files with your Read, Grep and Glob tools (or your tool's own file reader), not \`cat\`, \`head\`, \`tail\` or \`grep\` in Bash.`
    + (own.length ? `\nAllowed tool commands (type them exactly like this; * stands for the rest):\n${own.join('\n')}` : '');
}
