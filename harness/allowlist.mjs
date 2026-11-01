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
/** Claude Code's --allowedTools patterns, one per argument (P-066: the launcher passes each as its own argument, so no
 * shell or quoting can split "Bash(git log *)" at its space). */
export const allowedToolsList = () => ALLOWED.map(([, p]) => `Bash(${p})`);
/** The same list as one comma-separated value (the printed launch line, for a person's shell). */
export const allowedTools = () => allowedToolsList().join(',');
/** The kickoff's paragraph: exactly what runs without a prompt, and what doesn't. */
export function allowedNote() {
  // M5 (2.58.3): each Bash call is matched as a whole, so a chain or a prefix stops for approval even when every part
  // is on the list (the crew lost turns to "cat A ; cat B", "head -5; …", "cd ../.. && …", "STUDIO_LOCK_OWNER=x git …").
  return `You may run, without asking: ${ALLOWED.map(([n]) => `\`${n}\``).join(', ')}. Anything else (git push, git reset, rm, curl, installing tools) is not on the list: it stops for a person's yes, so don't plan around it; hand back with a note instead.`
    + ` One command per Bash call: no \`;\`, \`&&\` or \`||\` chains, no \`cd … &&\` first, and no \`VAR=x\` prefix in front of a command (your \`$STUDIO_LOCK_OWNER\` is already set; pass \`--agent <you>\` where a command takes it). A chained or prefixed line stops for approval even when each part is allowed.`
    + ` Read files with your Read, Grep and Glob tools (or your tool's own file reader), not \`cat\`, \`head\`, \`tail\` or \`grep\` in Bash.`;
}
