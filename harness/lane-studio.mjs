/**
 * harness/lane-studio.mjs — 2.60.1 (B-40): a lane copy's studio/ is the main checkout's.
 *
 * In a lane copy (.lanes/<agent>) `studio/` is a link (a junction on Windows) to the main checkout's studio/, so every
 * agent sees one board. That also means an edit to studio/game.json inside a lane lands straight in main's checkout,
 * uncommitted, and a lane's commits can never carry studio/ config. The rule: studio/ in a lane is main's; only the
 * board commands (npm run task, lock, proof, ...) write there; a config change is handed back with a note for the owner
 * or the Producer to make on main (a protected file needs the owner's signed approval as always).
 *
 *   - .claude/hooks/lane-studio-guard.mjs (a Claude Code PreToolUse hook) denies Edit/Write/MultiEdit/NotebookEdit of
 *     studio config (isStudioConfig) when the session runs in a lane copy (laneContext);
 *   - task done in a lane copy warns, naming the files, when main's studio config changed while the task was worked
 *     and isn't committed on main (mainConfigChanges).
 *
 * Planned for 2.64: a config proposal file in the lane (studio-proposals/<task>.json: the JSON keys to set) that the
 * merge train applies to main's studio/ in the same landing, under the protected-file rules.
 *
 * No imports from the rest of the harness: the hook loads this file on every edit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Studio config: top-level studio/*.json, studio/bible/*.json, keys, approvals and presets. Board .md files are not. */
export const isStudioConfig = (rel) => /^studio\/([^/]+\.json|bible\/[^/]+\.json|(keys|approvals|presets)\/.+)$/i.test(String(rel || '').replace(/\\/g, '/'));
/** Records the board commands write (and may leave uncommitted on main): not config changes. */
export const STUDIO_RECORDS = ['studio/task-holds.json', 'studio/pending-review.json', 'studio/task-types.json'];
export const isStudioRecord = (rel) => STUDIO_RECORDS.includes(String(rel || '').replace(/\\/g, '/'));

export const SANCTIONED = 'studio/ in a lane copy is the main checkout\'s (a link): only the board commands (npm run task, lock, proof …) write there. A config change goes to the owner or the Producer on main: hand the task back with a note naming the change (npm run task -- pause <ID> --note "…"); a protected file also needs the owner\'s signed approval.';

const norm = (p) => { const s = path.resolve(String(p)).replace(/\\/g, '/'); return process.platform === 'win32' ? s.toLowerCase() : s; };

/**
 * Is this session in a lane copy? The way harness/worktree.mjs tells: STUDIO_MAIN_ROOT names another checkout, or the
 * folder is <main>/.lanes/<name> and <main> is a git checkout. { lane, dir, main }.
 */
export function laneContext({ env = process.env, dir = env.CLAUDE_PROJECT_DIR || process.cwd() } = {}) {
  const here = path.resolve(dir);
  const m = here.replace(/\\/g, '/').match(/^(.*)\/\.lanes\/[^/]+$/);
  const fromPath = m && fs.existsSync(path.join(m[1], '.git')) ? path.resolve(m[1]) : null;
  const main = env.STUDIO_MAIN_ROOT ? path.resolve(env.STUDIO_MAIN_ROOT) : fromPath;
  return { lane: Boolean(main) && norm(main) !== norm(here), dir: here, main: main || here };
}

/** The studio-relative path of a file in this lane copy or in the main checkout, or null. */
export function studioRel(file, ctx) {
  if (!file) return null;
  const abs = norm(path.isAbsolute(String(file)) ? file : path.join(ctx.dir, String(file)));
  for (const root of [ctx.dir, ctx.main]) {
    const r = norm(root);
    if (abs.startsWith(`${r}/`)) {
      const rel = abs.slice(r.length + 1);
      if (/^studio\//i.test(rel)) return rel;
    }
  }
  return null;
}

/** The PreToolUse decision for an edit tool, or null. */
export function decideEdit(tool, input = {}, { env = process.env, dir } = {}) {
  if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(String(tool || ''))) return null;
  if (/^(off|0|false|no)$/i.test(String(env.STUDIO_LANE_STUDIO_GUARD || ''))) return null;
  const ctx = laneContext({ env, ...(dir ? { dir } : {}) });
  if (!ctx.lane) return null;
  const rel = studioRel(input.file_path || input.notebook_path || input.path, ctx);
  if (!rel || !isStudioConfig(rel)) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${rel} is studio config, and this session runs in a lane copy: the edit would land straight in the main checkout, uncommitted, and the lane's commits can't carry it. ${SANCTIONED}` } };
}

/**
 * Studio config files that changed in the main checkout since `since` (ms) and aren't committed there: [rel]. Records
 * the board commands write are left out.
 */
export function mainConfigChanges(main, since = 0) {
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'studio'], { cwd: main, encoding: 'utf8' });
  if (r.status !== 0) return [];
  const out = [];
  for (const line of String(r.stdout || '').split('\n').filter((l) => l.length > 3)) {
    const rel = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop();
    if (!isStudioConfig(rel) || isStudioRecord(rel)) continue;
    let m = 0;
    try { m = fs.statSync(path.join(main, rel)).mtimeMs; } catch { m = Date.now(); } // deleted: count it
    if (m >= since) out.push(rel);
  }
  return out;
}

/** The warning task done prints in a lane copy, or ''. */
export function laneConfigWarning(taskId, main, since) {
  const files = mainConfigChanges(main, since);
  if (!files.length) return '';
  return `WARNING: the main checkout's studio config changed while ${taskId} was worked, and it isn't committed on main: ${files.join(', ')}. studio/ in a lane is main's (a link), so an edit made here went straight to main. If this lane (or its agent) made it, it does NOT land with the lane: say so in the task's note so the owner or the Producer commits or reverts it on main. ${SANCTIONED.split(': ').slice(1).join(': ')}`;
}
