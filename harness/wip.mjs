/**
 * harness/wip.mjs — uncommitted work saved as a patch in .studio/wip/<task>-<agent>.patch, so a hand-back,
 * a stop or a forced done never loses it. Used by the launcher and by task done --force.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, STUDIO_STATE_DIR } from './event.mjs';

export const WIP_DIR = path.join(STUDIO_STATE_DIR, 'wip');

/** The uncommitted changes under `claims` (path:… keys; every change when there are none) as a patch file. */
export function savePatch(agent, taskId, claims, { suffix = '', cwd = REPO_ROOT } = {}) {
  const paths = claims.filter((k) => k.startsWith('path:')).map((k) => k.slice(5)).filter(Boolean);
  const scope = paths.length ? ['--', ...paths] : [];
  const tracked = spawnSync('git', ['diff', 'HEAD', ...scope], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || '';
  const untracked = (spawnSync('git', ['ls-files', '--others', '--exclude-standard', ...scope], { cwd, encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean);
  const extra = untracked.map((f) => spawnSync('git', ['diff', '--no-index', '--', '/dev/null', f], { cwd, encoding: 'utf8' }).stdout || '').join('');
  const patch = tracked + extra;
  if (!patch.trim()) return null;
  fs.mkdirSync(WIP_DIR, { recursive: true });
  const file = path.join(WIP_DIR, `${taskId || 'no-task'}-${agent}${suffix}.patch`);
  fs.writeFileSync(file, patch);
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}
