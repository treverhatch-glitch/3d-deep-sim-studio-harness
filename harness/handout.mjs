/**
 * harness/handout.mjs — dependency-aware handout (2.30c, #12).
 *
 * Before the supervisor starts an agent on a task, two things beyond the holds (task-hold.mjs) are
 * checked, so a fresh session isn't spent on work that can't move:
 *   - an --after prerequisite that is done but whose work is still on an unmerged lane branch
 *     (.studio/lane-branches.json) — the task would start without it;
 *   - a folder or file the task works in (its lane) that another agent holds (path: locks).
 * Such a task is skipped, marked "waiting on X" (shown in the War Room queue), and the next task in
 * the same group is tried instead, so the lane keeps moving.
 */
import fs from 'node:fs';
import path from 'node:path';
import { STUDIO_STATE_DIR } from './event.mjs';
import { readHolds, lanesClash } from './task-hold.mjs';

const WAIT_FILE = () => path.join(STUDIO_STATE_DIR, 'handout-waiting.json');
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};

/**
 * Why this task should not be handed out now, as { owner, why }, or null.
 * deps: { locks: listLocks(), unmerged(branch) => count, lane } — injectable for tests.
 */
export function handoutBlock(taskId, q, { locks = [], unmerged = () => 0, lane = null, holds = readHolds(), branches = readJson(path.join(STUDIO_STATE_DIR, 'lane-branches.json'), {}) } = {}) {
  const done = new Set(q.done.map((t) => t.id));
  for (const pre of holds[taskId]?.after || []) {
    if (!done.has(pre) || !branches[pre]) continue;
    let n = 0;
    try {
      n = unmerged(branches[pre]);
    } catch {}
    if (n > 0) return { owner: pre, why: `waiting on ${pre}: done, but ${n} commit${n === 1 ? '' : 's'} on ${branches[pre]} not merged yet` };
  }
  if (lane) {
    const held = locks.find((l) => l.key.startsWith('path:') && lanesClash(l.key.slice(5), lane) && !locks.some((t) => t.key === `task:${taskId}` && t.owner === l.owner));
    if (held) return { owner: held.owner, why: `waiting on ${held.owner}: it holds ${held.key}` };
  }
  return null;
}

/** The supervisor's marks for the War Room ("waiting on X"); replaced every pass. */
export function writeWaiting(map) {
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  fs.writeFileSync(WAIT_FILE(), `${JSON.stringify({ at: new Date().toISOString(), tasks: map }, null, 2)}\n`);
}
export function readWaiting(maxAgeMs = 5 * 60000) {
  const w = readJson(WAIT_FILE(), null);
  if (!w || Date.now() - Date.parse(w.at) > maxAgeMs) return {};
  return w.tasks || {};
}
