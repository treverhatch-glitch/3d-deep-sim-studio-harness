/**
 * harness/allowlist.mjs — what a launched agent may run without asking (2.30c, #15).
 *
 * One list, used twice: the launcher passes it to Claude Code (--allowedTools), and every kickoff
 * prints it, so an agent knows up front instead of finding out by a refused command. The list is the
 * one 2.23 set (node, npm, npx, ffmpeg, blender, read-only git plus add/commit, ls, mkdir, cp, mv).
 */
export const ALLOWED = [
  ['node', 'node *'],
  ['npm', 'npm *'],
  ['npx', 'npx *'],
  ['ffmpeg', 'ffmpeg *'],
  ['blender', 'blender *'],
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
/** Claude Code's --allowedTools value. */
export const allowedTools = () => ALLOWED.map(([, p]) => `Bash(${p})`).join(',');
/** The kickoff's paragraph: exactly what runs without a prompt, and what doesn't. */
export function allowedNote() {
  return `You may run, without asking: ${ALLOWED.map(([n]) => `\`${n}\``).join(', ')}. Anything else (git push, git reset, rm, curl, installing tools) is not on the list: it stops for a person's yes, so don't plan around it; hand back with a note instead.`;
}
