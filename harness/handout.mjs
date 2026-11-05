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
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents, getEventPaths, rolledEventFiles } from './event.mjs';
import { readHolds, lanesClash } from './task-hold.mjs';
import { bringsNothing, gitMainRoot, mainRefOf } from './landed-content.mjs';

const WAIT_FILE = () => path.join(STUDIO_STATE_DIR, 'handout-waiting.json');
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};

/**
 * 2.77.3 (B-114): a task the board closed as landed (its last closing event is task.done, a merge-train landing or a lane
 * merge; a forced done or a reopen after it doesn't count) is landed, whatever an old lane branch's commit hashes say: a
 * rescue lands the same work under new hashes, and the dead branch would otherwise hold its dependants for ever.
 */
export function landedOnBoard(taskId, events = readRecentEvents(20000)) {
  return closingOnBoard(taskId, events) === true;
}
/** The board's last closing record for a task in `events`: true (a landing), false (forced or reopened), null (none). */
function closingOnBoard(taskId, events) {
  let last = null;
  for (const e of events) {
    if (e.task !== taskId && !(e.type === 'task.train.landed' && Array.isArray(e.meta?.lanes) && e.meta.lanes.map(String).includes(taskId))) continue;
    if (['task.done', 'task.train.landed', 'lane.merged'].includes(e.type)) last = true;
    else if (['task.forced', 'task.reopened'].includes(e.type)) last = false;
  }
  return last;
}

// The rescue title (harness/rescue.mjs RESCUE_RE; not imported: that module pulls in the budget and routing).
const RESCUE_OF = /^Rescue:\s*(T-\d+)\b/;
const evidenceOn = (env = process.env) => !/^(off|0|false|no)$/i.test(String(env.STUDIO_DEP_LANDED_EVIDENCE ?? '').trim());
const contentCache = new Map();
/** Does `branch` bring nothing to main (its work landed under other hashes)? Cached per branch and main tip. */
function branchOnMain(branch, root) {
  try {
    const top = gitMainRoot(root);
    const main = mainRefOf(top);
    if (!main || !branch) return false;
    const tip = (rev) => String(spawnSync('git', ['rev-parse', '--verify', '--quiet', rev], { cwd: top, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
    const key = `${tip(main)}|${tip(`refs/heads/${branch}`) || tip(branch)}`;
    if (!contentCache.has(key)) contentCache.set(key, bringsNothing(top, { base: main, head: tip(`refs/heads/${branch}`) || branch }).nothing);
    return contentCache.get(key);
  } catch { return false; }
}
// Every task's last closing record in the whole event history (rolled files included, newest first up to
// STUDIO_DEP_HISTORY_MB, default 200): read only when the window has none for a dependency. Rolled files never change,
// so each is read once per process; the live file again only when its size changed.
const histCache = new Map();
const CLOSING = /"type":"(task\.done|task\.train\.landed|lane\.merged|task\.forced|task\.reopened)"/;
function closingsIn(file) {
  let st = null;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${st.size}|${st.mtimeMs}`;
  const c = histCache.get(file);
  if (c && c.key === key) return c.map;
  const map = new Map();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    if (!CLOSING.test(line)) continue;
    let e = null;
    try { e = JSON.parse(line); } catch { continue; }
    const ids = e.type === 'task.train.landed' && Array.isArray(e.meta?.lanes) ? e.meta.lanes.map(String) : e.task ? [String(e.task)] : [];
    for (const id of ids) map.set(id, ['task.forced', 'task.reopened'].includes(e.type) ? false : true);
  }
  histCache.set(file, { key, map, size: st.size });
  return map;
}
function closingInHistory(taskId, env = process.env) {
  try {
    const { primary } = getEventPaths();
    let budget = (Number(env.STUDIO_DEP_HISTORY_MB) > 0 ? Number(env.STUDIO_DEP_HISTORY_MB) : 200) * 1024 * 1024;
    for (const f of [primary, ...rolledEventFiles(primary)]) {
      if (!(budget > 0)) break;
      const m = closingsIn(f);
      if (!m) continue;
      budget -= histCache.get(f)?.size || 0;
      if (m.has(taskId)) return m.get(taskId);
    }
  } catch {}
  return null;
}

/**
 * 2.78.1 (d, B-114 on 2.78.0): has a done dependency's work landed? landedOnBoard looked only at the last 20000 events
 * and only at the dependency's own closing record, so "T-124 waiting on T-152: done, but 14 commits on lane/… not merged"
 * still showed for a T-152 that landed long ago through another task. Yes when any of:
 *   - its last closing record in the window is a landing (landedOnBoard, 2.77.3);
 *   - a done rescue of it ("Rescue: <ID>") landed;
 *   - its lane branch brings nothing to main: every commit's patch is on main, or merging it changes no file (a rescue
 *     or another task carried the work under new hashes: harness/landed-content.mjs bringsNothing);
 *   - the window holds no closing record for it, and its last one in the whole event history (rolled files too, up to
 *     STUDIO_DEP_HISTORY_MB) is a landing (it closed before the last 20000 events).
 * A forced done (or a reopen) as its last record, with commits not on main, still waits, as in 2.77.3; so does a done
 * task with no record at all.
 * STUDIO_DEP_LANDED_EVIDENCE=off: landedOnBoard only (2.78.0).
 */
export function depLanded(taskId, { q = { done: [] }, branch = null, events = readRecentEvents(20000), root = REPO_ROOT, env = process.env } = {}) {
  const st = closingOnBoard(taskId, events);
  if (st === true) return true;
  if (!evidenceOn(env)) return false;
  for (const t of q.done || []) if ((RESCUE_OF.exec(String(t.title || '')) || [])[1] === taskId && (closingOnBoard(t.id, events) ?? closingInHistory(t.id, env)) === true) return true;
  if (branch && branchOnMain(branch, root)) return true;
  if (st === null && closingInHistory(taskId, env) === true) return true;
  return false;
}

/**
 * Why this task should not be handed out now, as { owner, why }, or null.
 * deps: { locks: listLocks(), unmerged(branch) => count, lane } — injectable for tests.
 */
export function handoutBlock(taskId, q, { locks = [], unmerged = () => 0, lane = null, holds = readHolds(), branches = readJson(path.join(STUDIO_STATE_DIR, 'lane-branches.json'), {}), landed = null } = {}) {
  const done = new Set(q.done.map((t) => t.id));
  let events = null;
  for (const pre of holds[taskId]?.after || []) {
    if (!done.has(pre) || !branches[pre]) continue;
    let n = 0;
    try {
      n = unmerged(branches[pre]);
    } catch {}
    if (!(n > 0)) continue;
    // 2.77.3 (B-114); 2.78.1 (d): a landing under other hashes, a rescue's, or one older than the event window counts.
    if (landed ? landed(pre) : depLanded(pre, { q, branch: branches[pre], events: (events = events || readRecentEvents(20000)) })) continue;
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
