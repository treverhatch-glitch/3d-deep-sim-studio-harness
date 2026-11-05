/**
 * harness/train-refresh.mjs — 2.76.0 (B-81): the train refreshes a lane whose harness is behind main, instead of
 * handing it back.
 *
 * The crew's evidence: `upgrade --merge` printed "lanes: not refreshed (lanes refresh gave no result (exit 143))", and the
 * next train handed T-155 back: "[hooks] FAIL this lane copy runs its own harness, and main has changed 122 harness
 * file(s) since the lane branched from it". Nothing was wrong with the lane; its refresh hadn't run. Now, before a lane's
 * checks, the train looks at its harness (hook-stamp.mjs laneHarnessDrift, run in the lane copy) and, when main has
 * changed harness files since the lane branched, refreshes it the way `npm run lanes -- refresh` does (main merged in,
 * never a rebase; its commits re-stamped through the hooks; a conflict aborted and named), without the targeted tests:
 * the train's full verify runs right after. Only a real conflict (or a failed re-stamp) hands the lane back, with that
 * reason. A lane with uncommitted work is left alone (its agent is at it). STUDIO_TRAIN_REFRESH=off turns it off.
 *
 * 2.78.0 (B-105): the merge leaves the lane's studio/ link out (lanes.mjs protectSharedLinks), and a builder's verify
 * (scripts/run-gates.mjs) calls this too (by: 'harness') instead of telling the builder to rebase and restamp.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** How many harness files main changed since the lane branched (0: current; null: can't tell). */
export function laneHarnessBehind(root, dir) {
  const script = path.join(root, 'harness', 'hook-stamp.mjs');
  if (!dir || !fs.existsSync(dir) || !fs.existsSync(script)) return null;
  const code = `const m = await import(${JSON.stringify(pathToFileURL(script).href)}); const d = m.laneHarnessDrift(process.cwd()); console.log(JSON.stringify({ n: d ? d.files.length : null }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, encoding: 'utf8', env: { ...process.env, STUDIO_MAIN_ROOT: root }, windowsHide: true, timeout: 60000 });
  try { return JSON.parse(String(r.stdout || '').trim().split('\n').pop()).n; } catch { return null; }
}

/**
 * Refresh a stale lane before its checks. { refreshed, handBack?, why, head? }: refreshed true when main was merged in
 * (the caller reads the lane's head again); handBack with a why when it conflicts or its re-stamp fails.
 */
export async function refreshStaleLane(root, lane, { log = () => {}, env = process.env, by = 'train' } = {}) {
  if (/^(off|0|false|no)$/i.test(String(env.STUDIO_TRAIN_REFRESH || ''))) return { refreshed: false, why: 'STUDIO_TRAIN_REFRESH=off' };
  if (!lane?.dir || !fs.existsSync(lane.dir)) return { refreshed: false, why: 'no lane copy' };
  const n = laneHarnessBehind(root, lane.dir);
  if (!n) return { refreshed: false, why: n === 0 ? 'its harness is current' : "can't tell" };
  const { refreshLane } = await import('./lanes.mjs');
  // The train acts here, not the agent that called it (a worker's name would be refused): by "train", in a clean env.
  const clean = { ...env, STUDIO_ROLE: '', STUDIO_LOCK_OWNER: '' };
  const r = await refreshLane(root, { ...lane }, { by, busyOk: true, tests: false, env: clean, log });
  if (r.status === 'ok') {
    log(`[train] ${lane.task}: its lane copy ran a harness ${n} file(s) behind main; refreshed it first (${r.why})`);
    return { refreshed: true, why: r.why, head: r.head };
  }
  if (r.status === 'conflict' || r.status === 'red') return { refreshed: false, handBack: true, why: `its lane copy runs a harness ${n} file(s) behind main and the train's refresh couldn't bring it up to date: ${r.why}` };
  // refused (uncommitted work, a merge in progress, …): leave it; the checks say what they say.
  return { refreshed: false, why: r.why };
}
