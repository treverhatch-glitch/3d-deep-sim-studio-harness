/**
 * harness/holdout-dir.mjs — 2.78.0 (PU-54): where the held-out cases live. No imports beyond node: the path guard hook
 * (.claude/hooks/guard-paths.mjs) and harness/holdout.mjs both use it.
 *
 * STUDIO_HOLDOUT_DIR, else <main checkout's parent>/<main checkout's folder name>-holdout. The main checkout is
 * STUDIO_MAIN_ROOT, else the folder above `.lanes/<agent>` when `start` is inside a lane copy, else `start`.
 * It is outside every checkout on purpose: a lane copy links studio/ to the main checkout's, so anything under studio/
 * is readable from a lane.
 */
import path from 'node:path';

const norm = (p) => String(p).replace(/\\/g, '/');

export function mainRootOf(start, env = process.env) {
  if (env.STUDIO_MAIN_ROOT) return path.resolve(env.STUDIO_MAIN_ROOT);
  const m = norm(path.resolve(start)).match(/^(.*?)\/\.lanes\/[^/]+(\/.*)?$/);
  return m ? path.resolve(m[1]) : path.resolve(start);
}

export function holdoutDir(start, env = process.env) {
  if (env.STUDIO_HOLDOUT_DIR) return path.resolve(env.STUDIO_HOLDOUT_DIR);
  const main = mainRootOf(start, env);
  return path.join(path.dirname(main), `${path.basename(main)}-holdout`);
}

/** Does this session belong to a builder or a lane copy? Reviewer, Producer, Director and the owner never do. */
export function isBuilderSession(start, env = process.env) {
  const role = String(env.STUDIO_ROLE || '').toLowerCase();
  if (/^(reviewer|producer|director|owner)$/.test(role)) return false;
  if (role === 'builder') return true;
  if (/\/\.lanes\/[^/]+/.test(norm(path.resolve(start)))) return true;
  return Boolean(env.STUDIO_MAIN_ROOT) && path.resolve(env.STUDIO_MAIN_ROOT) !== path.resolve(start);
}
