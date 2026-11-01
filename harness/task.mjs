#!/usr/bin/env node
/**
 * harness/task.mjs — Markdown Task Queue Manager (`studio/NEXT.md`)
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actor, emitEvent, REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents } from './event.mjs';
import { claim, release, status as lockStatus, listLocks, SHARED_OWNERS } from './lock.mjs';
import { checkDone, taskType, joinWaveIfGameplay, taskBase, lastFullRecord, taskChanges, startedAt } from './done-check.mjs';
import { splitEolOnly, eolNote } from './eol-only.mjs';
import { isGameCode } from '../scripts/check-function-size.mjs';
import { summarize as summarizeVerdict } from './verdict-split.mjs';
import { readBible, crossedLayersIn, readIdea, writeIdea, latestReview, LAYERS } from './bible.mjs';
import { writeFocus } from './focus.mjs';
import { causeOf, isAccepted } from './cause-store.mjs';
import { holdReason, setHold, readHolds, laneList, gameFolders, updateHolds } from './task-hold.mjs';
import { stopIfOverBudget } from './task-budget.mjs';
import { applyRescue, rescueOf } from './rescue.mjs';
import { savePatch } from './wip.mjs';
import { inLaneCopy, catchUp, carryTaskBranch, deliver, laneDiff, mainRoot, laneDirty, unmerged } from './worktree.mjs';
import { recordPass, clearPass, withLandLock, judgeVerifyReuse } from './merge-lane.mjs';
import { isEngineChurn, engineGates, relatedTestsOn } from './game-gates.mjs';
import { isMechanic, originOf, devSays } from './intent.mjs';
import { checkBreaker, isFailureNote, reasonKey, unblockTask } from './breaker.mjs';
import { claimActive, claimOwner } from './busy.mjs';
import { startSummary, carryForward } from './carry.mjs';
import { openPending, readPending } from './pending-review.mjs';
import { isDecider, propose, SIZE_CAP } from './proposed.mjs';
import { attachTricks } from './cheatsheet.mjs';
import { readBaseline, recordBaseline, setTrunk, trunkState, judgeRed } from './baseline.mjs';
import { recordAlive } from './proc-identity.mjs';
import { withFileLock, writeAtomic } from './fsafe.mjs';

export const NEXT_FILE = path.join(REPO_ROOT, 'studio', 'NEXT.md');
// 2.30c (#13): finished tasks live in studio/DONE.md, so NEXT.md (read by every agent) holds only open work.
export const DONE_FILE = path.join(REPO_ROOT, 'studio', 'DONE.md');
export const CURRENT_TASK_FILE = path.join(REPO_ROOT, 'studio', 'CURRENT_TASK.md');

// 2.58.0 (P-057): the line the harness writes, plus the drifts people make by hand, read as the same task and put back
// in shape by the next write: an ASCII "-" (or "--", "–") for the "—", a role without backticks, "[X]", a "*" bullet,
// a lower-case priority. Anything else that isn't the harness's own heading or note is kept (see UNREADABLE below).
const TASK_LINE_RE = /^[-*]\s+\[([ xX>~])\]\s+\*\*([A-Z]+-\d+)\*\*\s+\[([Pp][0-3])\]\s+\((`?)([^`()]+?)\4\)\s+(?:—|–|--?)\s+(.+)$/;
/** The section kept lines go under, at the end of NEXT.md or DONE.md (2.58.0, P-057). */
export const UNREADABLE_HEADING = '## UNREADABLE (kept by the harness: fix the format)';
const UNREADABLE_NOTE = '_The harness couldn\'t read these lines as tasks, so it keeps them here instead of dropping them. Rewrite each like a task line ("- [ ] **T-123** [P1] (`builder`) — Title"; it then counts as waiting work), or delete it._';
// 2.58.0 (P-052): which way a task was moving when a board write was cut off (see parseNextQueue).
const MOVES_FILE = path.join(STUDIO_STATE_DIR, 'board-move.json');

/**
 * The board: studio/NEXT.md (open work) and studio/DONE.md (finished). Non-enumerable extras: readIds (what this
 * snapshot saw), unreadable ({ next, done }: lines kept, see UNREADABLE_HEADING), duplicates (ids found open and done).
 *
 * 2.58.0 (P-052): a task moves between the two files in two writes, and the file that GAINS it is written first
 * (DONE.md on done, NEXT.md on reopen; writeNextQueueRaw). An agent killed between them leaves the task in both
 * files, never in neither. Read, it shows once: the copy the cut-off write was moving it to wins, so the move counts
 * as made (done stays done, and the watcher frees the claim the killed done kept; a reopen stays reopened). Which
 * way it was moving is in .studio/board-move.json, written before the first of the two writes and removed after the
 * last. A task in both files with no such note (a hand edit, a merge) counts as done: it stays findable, and
 * `task reopen` brings it back. The next board write keeps only the winning copy.
 */
export function parseNextQueue() {
  const files = readBoardFiles();
  const next = parseQueueText(files.next);
  const doneFile = parseQueueText(files.done, 'done');
  const tasks = { inProgress: next.inProgress, backlog: next.backlog, done: next.done };
  // Older studios kept DONE in NEXT.md: those still count, and move to DONE.md on the next write.
  const seen = new Set(tasks.done.map((t) => t.id));
  for (const t of doneFile.done) if (!seen.has(t.id)) tasks.done.push(t), seen.add(t.id);
  const both = [...new Set([...tasks.inProgress, ...tasks.backlog].map((t) => t.id).filter((id) => seen.has(id)))];
  if (both.length) {
    const moves = readMoves();
    for (const id of both) {
      if (moves[id] === 'open') tasks.done = tasks.done.filter((t) => t.id !== id);
      else for (const sec of ['inProgress', 'backlog']) tasks[sec] = tasks[sec].filter((t) => t.id !== id);
    }
  }
  // 2.30p: remember which tasks this snapshot saw, so a later write can keep tasks added since.
  Object.defineProperty(tasks, 'readIds', { value: new Set([...tasks.inProgress, ...tasks.backlog, ...tasks.done].map((t) => t.id)), enumerable: false });
  Object.defineProperty(tasks, 'unreadable', { value: { next: next.unreadable, done: doneFile.unreadable }, enumerable: false });
  Object.defineProperty(tasks, 'duplicates', { value: both, enumerable: false });
  return tasks;
}

/**
 * Both board files as one consistent snapshot: NEXT.md is read again after DONE.md, and the pair re-read if it
 * changed meanwhile (a reader without the board lock could otherwise see a task in neither file mid-move).
 */
function readBoardFiles() {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  let next = read(NEXT_FILE);
  let done = null;
  for (let i = 0; i < 5; i++) {
    done = read(DONE_FILE);
    const again = read(NEXT_FILE);
    if (again === next) break;
    next = again;
  }
  return { next, done };
}
function readMoves() {
  try {
    const m = JSON.parse(fs.readFileSync(MOVES_FILE, 'utf8'))?.moves;
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}

function parseQueueText(raw, start = 'backlog') {
  const tasks = { inProgress: [], backlog: [], done: [], unreadable: [] };
  if (raw === null || raw === undefined) return tasks;
  const lines = String(raw).replace(/\r\n/g, '\n').split('\n');
  let section = start;
  let kept = false; // inside the UNREADABLE section: lines already kept (warned about once)
  const seen = { open: new Set(), done: new Set() };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^##\s+IN_PROGRESS/i.test(trimmed)) {
      section = 'inProgress';
      kept = false;
      continue;
    }
    if (/^##\s+BACKLOG/i.test(trimmed)) {
      section = 'backlog';
      kept = false;
      continue;
    }
    if (/^##\s+DONE/i.test(trimmed)) {
      section = 'done';
      kept = false;
      continue;
    }
    if (/^##\s+UNREADABLE\b/i.test(trimmed)) {
      // A kept line fixed in place counts as this file's work: waiting in NEXT.md, finished in DONE.md.
      section = start;
      kept = true;
      continue;
    }
    // The harness's own title, its "Managed by" note and the _placeholder_ lines are rewritten on every write.
    if (/^#\s/.test(trimmed) || /^>\s*Managed by\b/i.test(trimmed) || /^_.*_$/.test(trimmed)) continue;

    const m = trimmed.match(TASK_LINE_RE);
    if (m) {
      const [, rawMark, id, priority, , role, title] = m;
      const mark = rawMark.toLowerCase();
      const kind = section === 'done' ? 'done' : 'open';
      // The same id twice in one file: the first is the task, the second is kept (never two tasks with one id).
      if (!seen[kind].has(id)) {
        seen[kind].add(id);
        tasks[section].push({
          id,
          priority: priority.toUpperCase(),
          role: role.trim(),
          title: title.trim(),
          status: section === 'done' || mark === 'x' ? 'done' : section === 'inProgress' || mark === '>' ? 'in_progress' : 'backlog',
        });
        continue;
      }
    }
    // 2.58.0 (P-057): never dropped. A line the harness can't read (another format, a note, a heading of its own)
    // used to vanish on the next write; it is kept under UNREADABLE_HEADING and named in a warning.
    tasks.unreadable.push({ line: line.replace(/\s+$/, ''), fresh: !kept });
  }
  return tasks;
}

function formatTaskLine(t, mark) {
  return `- [${mark}] **${t.id}** [${t.priority}] (\`${t.role}\`) — ${t.title}`;
}

// After the file's last section (which ends with a blank line).
const unreadableBlock = (kept) => (kept.length ? [UNREADABLE_HEADING, UNREADABLE_NOTE, ...kept.map((u) => u.line), ''] : []);

/**
 * 2.57.0 (PU-16, P-038): one agent at a time reads, changes and writes the board (NEXT.md and DONE.md), under a
 * short lock of its own (.studio/locks/board.mutex). Ten agents starting ten tasks at once used to overwrite each
 * other's moves: 7 held their claims while the board showed 4 in progress. Re-entrant; synchronous `fn` only.
 * Every change to the board goes through here: read inside `fn`, change, writeNextQueue.
 */
export function withBoard(fn) {
  return withFileLock('board', fn, { dir: path.join(STUDIO_STATE_DIR, 'locks'), timeoutMs: Number(process.env.STUDIO_BOARD_LOCK_WAIT_MS || 15000), what: 'The board (studio/NEXT.md)' });
}

/**
 * 2.30p: every board write re-reads the board first. A task on disk that the caller's snapshot never saw (another
 * agent added it meanwhile) is kept, never overwritten. 2.57.0: under the board lock (it was the land lock, which a
 * landing holds for minutes, after which the write went ahead unlocked). 2.58.0: lines the harness can't read are
 * taken from the file as it is now and kept (P-057).
 */
export function writeNextQueue(tasks) {
  withBoard(() => {
    const disk = parseNextQueue();
    if (tasks.readIds) {
      const mine = new Set([...tasks.inProgress, ...tasks.backlog, ...tasks.done].map((t) => t.id));
      for (const sec of ['inProgress', 'backlog', 'done']) {
        for (const t of disk[sec]) if (!mine.has(t.id) && !tasks.readIds.has(t.id)) { tasks[sec].push(t); mine.add(t.id); }
      }
    }
    // A task in both files with no move note (a hand edit) is kept as done: say so, once (this write settles it).
    const moves = disk.duplicates.length ? readMoves() : {};
    const settled = disk.duplicates.filter((id) => !moves[id] && tasks.done.some((t) => t.id === id));
    writeNextQueueRaw(tasks, disk.unreadable);
    if (settled.length) {
      console.warn(`[board] ${settled.join(', ')} ${settled.length === 1 ? 'was' : 'were'} in both studio/NEXT.md and studio/DONE.md; kept as done (to reopen: npm run task -- reopen <ID> --reason "...")`);
      try { emitEvent({ type: 'board.settled', agent: actor(), status: 'warn', msg: `${settled.join(', ')}: in both studio/NEXT.md and studio/DONE.md with no record of a move; kept as done` }); } catch { /* the warning above stands */ }
    }
  });
}

function renderNext(tasks, kept) {
  return [
    '# Studio Task Queue (`studio/NEXT.md`)',
    '',
    '> Managed by `node harness/task.mjs`. One line per task so agents and the Zero-Token HUB can parse it without context bloat.',
    '',
    '## IN_PROGRESS',
    ...(tasks.inProgress.length
      ? tasks.inProgress.map((t) => formatTaskLine(t, '>'))
      : ['_No task currently in progress. Run `node harness/task.mjs next`._']),
    '',
    '## BACKLOG',
    ...(tasks.backlog.length
      ? tasks.backlog.map((t) => formatTaskLine(t, ' '))
      : ['_Backlog is empty._']),
    '',
    '## DONE',
    `_${tasks.done.length ? `${tasks.done.length} finished task${tasks.done.length === 1 ? ' is' : 's are'}` : 'Finished tasks are'} in \`studio/DONE.md\` (newest first). This file keeps only open work._`,
    '',
    ...unreadableBlock(kept),
  ].join('\n');
}
function renderDone(done, kept) {
  return [
    '# Finished tasks (`studio/DONE.md`)',
    '',
    '> Managed by `node harness/task.mjs`. Newest first. Open work is in `studio/NEXT.md`; agents don\'t need to read this file.',
    '',
    '## DONE',
    ...(done.length ? done.map((t) => formatTaskLine(t, 'x')) : ['_No completed tasks yet._']),
    '',
    ...unreadableBlock(kept),
  ].join('\n');
}

function writeNextQueueRaw(tasks, kept = { next: [], done: [] }) {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const wasNext = read(NEXT_FILE);
  let wasDone = read(DONE_FILE);
  const onDisk = { next: parseQueueText(wasNext), done: parseQueueText(wasDone, 'done') };
  const nextOpen = new Set([...onDisk.next.inProgress, ...onDisk.next.backlog].map((t) => t.id));
  const inDoneFile = new Set(onDisk.done.done.map((t) => t.id));
  const open = [...tasks.inProgress, ...tasks.backlog];
  // 2.58.0 (P-052): the file that gains a task is written first; the one that loses it last. A move both ways in
  // one write (one task done, another reopened) first writes DONE.md still holding the reopened one.
  const toDone = tasks.done.filter((t) => !inDoneFile.has(t.id)).map((t) => t.id);
  const toOpen = open.filter((t) => inDoneFile.has(t.id)).map((t) => t.id);
  const moves = {};
  for (const id of toDone) if (nextOpen.has(id)) moves[id] = 'done';
  for (const id of toOpen) moves[id] = 'open';
  const moving = Object.keys(moves).length > 0;
  if (moving) writeAtomic(MOVES_FILE, `${JSON.stringify({ moves, at: new Date().toISOString(), pid: process.pid })}\n`, { fsync: false });
  if (toDone.length) {
    const first = renderDone([...tasks.done, ...onDisk.done.done.filter((t) => toOpen.includes(t.id))], kept.done);
    if (first !== wasDone) writeAtomic(DONE_FILE, first);
    wasDone = first;
  }
  // 2.57.0 (PU-16): replaced whole (temp file + rename): an agent reading mid-write saw half a board ("Task not found").
  writeAtomic(NEXT_FILE, renderNext(tasks, kept.next));
  const doneText = renderDone(tasks.done, kept.done);
  if (wasDone !== doneText) writeAtomic(DONE_FILE, doneText);
  if (moving || fs.existsSync(MOVES_FILE)) try { fs.rmSync(MOVES_FILE, { force: true }); } catch { /* stale notes only matter for a task in both files */ }
  // 2.58.0 (P-057): say once which lines were set aside (they stay in the file, under UNREADABLE).
  const fresh = [...kept.next.filter((u) => u.fresh).map((u) => ['studio/NEXT.md', u.line]), ...kept.done.filter((u) => u.fresh).map((u) => ['studio/DONE.md', u.line])];
  if (fresh.length) {
    const list = fresh.map(([f, l]) => `${f}: ${l.length > 120 ? `${l.slice(0, 117)}...` : l}`);
    console.warn(`[board] ${fresh.length} line${fresh.length === 1 ? '' : 's'} on the board ${fresh.length === 1 ? 'isn\'t a task' : 'aren\'t tasks'} the harness can read; kept under "${UNREADABLE_HEADING}" at the end of the file:\n${list.map((l) => `  ${l}`).join('\n')}`);
    try { emitEvent({ type: 'board.unreadable', agent: actor(), to: 'producer', status: 'warn', target: fresh[0][0], msg: `Kept ${fresh.length} board line(s) the harness can't read under "## UNREADABLE" (fix their format): ${list.join(' | ')}`.slice(0, 600) }); } catch { /* the warning above stands */ }
  }
}

export function syncCurrentTaskCheckpoint(activeTask, note = '') {
  const ts = new Date().toISOString();
  const content = `# Active Session State (\`studio/CURRENT_TASK.md\`)

## CHECKPOINT
- **Timestamp**: ${ts}
- **Active Task ID**: ${activeTask ? activeTask.id : 'NONE'}
- **Assigned Role**: \`${activeTask ? activeTask.role : 'producer'}\`
- **Priority**: ${activeTask ? activeTask.priority : 'N/A'}
- **Summary**: ${activeTask ? activeTask.title : 'Idle — waiting for next task from studio/NEXT.md'}

## STATUS
- **Phase**: ${activeTask ? 'IN_PROGRESS' : 'READY'}
- **Last Note**: ${note || (activeTask ? 'Task started via harness/task.mjs' : 'Ready to pull from studio/NEXT.md')}
`;
  writeAtomic(CURRENT_TASK_FILE, content, { fsync: false });
}

export const HANDOFF_DIR = path.join(REPO_ROOT, 'studio', 'handoffs');
const handoffFile = (id) => path.join(HANDOFF_DIR, `${id}.md`);

/** Notes left on a task by agents who stopped working on it, oldest first. */
export function readTaskHandoff(taskId) {
  try {
    return fs.readFileSync(handoffFile(taskId), 'utf8');
  } catch {
    return null;
  }
}

/** The studio-wide stop: while it is on, no task can be started. Agents finish their step, hand back and wait. */
export const STOP_FILE = path.join(STUDIO_STATE_DIR, 'STOP.json');
/**
 * The stop, or null when the studio runs. 2.57.0 (PU-16, P-041): a STOP file that exists but can't be read (half
 * written, or held by another program) counts as stopped: failing open let tasks start during a stop.
 */
export function readStop() {
  let raw;
  try {
    raw = fs.readFileSync(STOP_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    raw = null;
  }
  try {
    const s = JSON.parse(raw);
    if (s && typeof s === 'object') return s;
  } catch { /* torn or empty */ }
  return { by: 'unknown', reason: 'the stop file .studio/STOP.json is there but unreadable (half-written?), so the studio counts as stopped', at: null, unreadable: true };
}
export function setStop(by = 'war-room-human', reason = '') {
  const s = { by, reason: String(reason || '').slice(0, 300), at: new Date().toISOString() };
  writeAtomic(STOP_FILE, `${JSON.stringify(s, null, 2)}\n`);
  emitEvent({ type: 'studio.stopped', agent: by, to: 'producer', status: 'blocked', msg: `Studio stopped by ${by}${s.reason ? `: ${s.reason}` : ''}. No new tasks start until it resumes.` });
  return s;
}
export function clearStop(by = 'war-room-human') {
  const was = readStop();
  fs.rmSync(STOP_FILE, { force: true });
  if (was) emitEvent({ type: 'studio.resumed', agent: by, to: 'producer', msg: `Studio resumed by ${by}` });
  return was;
}

const PRI = { P0: 0, P1: 1, P2: 2, P3: 3 };
/**
 * The next task for one agent: what it already holds, else the most urgent unclaimed task for its
 * role (or with no role), never another agent's work in progress.
 */
export function nextFor({ role = null, agent = null } = {}, q = parseNextQueue()) {
  const held = agent ? q.inProgress.find((t) => lockStatus(`task:${t.id}`).lock?.owner === agent) : null;
  if (held) return { task: held, held: true };
  // 2.58.5 (H-5): nor a task handed back by the harness while its owner is still at work on it (liveOwner).
  let evs = null;
  const open = q.backlog
    .map((t, i) => [t, i])
    .filter(([t]) => !lockStatus(`task:${t.id}`).locked && (!role || t.role === role || !t.role) && !holdReason(t.id, q) && !liveOwner(t.id, agent, (evs ||= readRecentEvents(20000)), { waiting: true }))
    .sort((a, b) => (PRI[a[0].priority] ?? 9) - (PRI[b[0].priority] ?? 9) || a[1] - b[1]);
  return { task: open[0]?.[0] || null, held: false };
}

/** Everything known about one task, for agents and people: status, owner, meta, hand-off notes, checklist. */
export function showTask(taskId, q = parseNextQueue()) {
  const lane = q.inProgress.some((t) => t.id === taskId) ? 'in progress' : q.backlog.some((t) => t.id === taskId) ? 'waiting' : q.done.some((t) => t.id === taskId) ? 'done' : null;
  if (!lane) return null;
  const task = [...q.inProgress, ...q.backlog, ...q.done].find((t) => t.id === taskId);
  const events = readRecentEvents(50000).filter((e) => e.task === taskId);
  const meta = events.find((e) => e.type === 'task.added')?.meta || {};
  const handoff = path.join(HANDOFF_DIR, `${taskId}.md`);
  const check = lane === 'done' ? null : checkDone(task);
  return {
    ...task,
    lane,
    type: taskType(task),
    owner: lockStatus(`task:${taskId}`).lock?.owner || null,
    meta,
    history: events.slice(-12).map((e) => `${String(e.ts).slice(0, 16)} ${e.type} ${e.agent}: ${e.msg}`),
    handoff: fs.existsSync(handoff) ? fs.readFileSync(handoff, 'utf8') : null,
    brief: fs.existsSync(path.join(STUDIO_STATE_DIR, 'briefs', `${taskId}.md`)) ? `.studio/briefs/${taskId}.md` : null,
    checklist: check ? check.checks.map((c) => `[${c.ok ? 'x' : ' '}] ${c.label}${c.ok ? '' : `: ${c.why}`}`) : null,
  };
}

/**
 * 2.58.5 (H-5): another agent's claim on this task ran out while that agent is still at work on it (harness/busy.mjs
 * claimActive: active in the last STUDIO_CLAIM_ACTIVE_MIN, or its lane copy holds the task's unlanded commits).
 * Returns that claimActive result, or null. On 2.58.3 only the flow pass, the watcher and the supervisor asked; a crew
 * builder's own `task start` took such a task (T-067 built in lane opus-14, taken by builder-s30 and builder-s44).
 */
export function liveOwner(taskId, agent, events = null, { waiting = false } = {}) {
  try {
    const evs = events || readRecentEvents(20000);
    // A waiting task counts only when the harness handed it back from that owner (orphaned); one whose owner's own
    // hand-back was cut off (no task.paused logged) is anyone's.
    if (waiting && !claimOwner(taskId, evs)?.orphaned) return null;
    const a = claimActive(taskId, { root: mainRoot(), orphaned: true, events: evs });
    return a.busy && a.owner && a.owner !== agent ? a : null;
  } catch { return null; }
}

export function startTask(taskId, agent = null, { model = null, force = false } = {}) {
  if (!agent) return { error: 'owner-required', message: 'Pass --agent <unique-name> so the task lock has an owner.' };
  const stop = readStop();
  if (stop) return { error: 'stopped', message: `The studio is stopped (by ${stop.by}${stop.reason ? `: ${stop.reason}` : ''}). Don't start work: finish or hand back what you hold (task pause <ID> --note "..."), then wait. A person resumes it with: npm run task -- resume --by <name>` };
  // Dependencies, parking and a stop's cooldown (harness/task-hold.mjs). Work already in progress may continue.
  const held = holdReason(taskId, parseNextQueue());
  if (held && !force && !parseNextQueue().inProgress.some((t) => t.id === taskId)) return { error: 'held', message: `${taskId} can't start yet: ${held}. Pick another task (npm run task -- next), or a person releases it.` };
  // 2.31.0: a task that used its budget (sessions, claimed minutes, tokens; harness/task-budget.mjs) is
  // parked and refused, even for a re-claim of work in progress: re-claiming is how a task loops.
  const overWhy = stopIfOverBudget(taskId, { by: 'budget' });
  if (overWhy) return { error: 'over-budget', message: `${taskId} can't start: ${overWhy}` };
  // 2.58.5 (H-5): a claim that ran out under an owner still at work is that owner's (--force: a person reassigns it).
  if (!force && !lockStatus(`task:${taskId}`).locked) {
    const live = liveOwner(taskId, agent, null, { waiting: !parseNextQueue().inProgress.some((t) => t.id === taskId) });
    if (live) {
      emitEvent({ type: 'task.lock_denied', agent, task: taskId, status: 'blocked', msg: `Task ${taskId}: ${live.why}` });
      return { error: 'locked', lock: { owner: live.owner }, message: `${taskId} is ${live.owner}'s: ${live.why}. Pick another task (npm run task -- next); a person can reassign it with --force.` };
    }
  }
  const lockRes = claim(`task:${taskId}`, agent);
  if (!lockRes.ok) {
    if (lockRes.reason === 'owner-required') return { error: 'owner-required', message: lockRes.message };
    emitEvent({ type: 'task.lock_denied', agent, task: taskId, status: 'blocked', msg: lockRes.lock?.owner ? `Task ${taskId} already claimed by ${lockRes.lock.owner}` : `Task ${taskId}: ${lockRes.message || 'claim refused'}` });
    return { error: 'locked', lock: lockRes.lock || null, ...(lockRes.message ? { message: lockRes.message } : {}) };
  }

  // 2.57.0 (PU-16, P-038): the move to IN_PROGRESS is read, made and written under the board lock.
  // 2.58.0 (P-055): whatever goes wrong there (the board lock busy, EPERM/EACCES from another program holding a
  // board file on Windows, a full disk), a claim this call made is released: it used to stay, with the task still
  // waiting, and `next` skipped the task for an hour. A claim the agent already held (a re-start) is kept.
  let target = null;
  let moved = false;
  try {
    withBoard(() => {
      const q = parseNextQueue();
      target = q.inProgress.find((t) => t.id === taskId) || null;
      if (!target) {
        const idx = q.backlog.findIndex((t) => t.id === taskId);
        if (idx === -1) return;
        [target] = q.backlog.splice(idx, 1);
        target.status = 'in_progress';
        q.inProgress.unshift(target);
      }
      writeNextQueue(q);
      moved = true;
    });
  } catch (err) {
    if (!lockRes.reused) { try { release(`task:${taskId}`, agent); } catch { /* the watcher frees it (claim on a waiting task) */ } }
    if (err.code === 'ELOCKBUSY') return { error: 'busy', message: err.message };
    emitEvent({ type: 'task.lock_denied', agent, task: taskId, status: 'blocked', msg: `Task ${taskId}: the board couldn't be updated (${err.code || err.message}); claim released` });
    return { error: 'board', message: `${taskId} wasn't started: the board (studio/NEXT.md) couldn't be updated (${err.code && !String(err.message || '').startsWith(err.code) ? `${err.code}: ` : ''}${String(err.message || err).slice(0, 200)}). ${lockRes.reused ? 'Your claim is kept.' : 'The claim was released.'} Nothing else changed: run the command again in a moment.` };
  }
  if (!target || !moved) {
    release(`task:${taskId}`, agent); // not on the board (or not waiting): no claim on it either
    return null;
  }
  // In a lane copy (2.29): start from the studio's latest work, plus any earlier agent's unmerged work on this task.
  let carried = null;
  if (inLaneCopy()) {
    catchUp();
    carried = carryTaskBranch(target.id);
  }
  syncCurrentTaskCheckpoint(target, `Started ${target.id} (${target.role}) — owner ${agent}`);
  const handoff = readTaskHandoff(target.id);
  // The commit the work starts from, for the size ratchet (harness/done-check.mjs sizeGrowth).
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout?.trim() || null;
  emitEvent({ type: 'task.start', agent, model, task: target.id, status: 'editing', msg: `${handoff ? 'Picked up' : 'Started'} ${target.id}: ${target.title}`, meta: head ? { head } : {} });
  // 2.54.0 (PU-06): what was already red at claim (kept from the first claim when a task is picked up again).
  try { if (!readBaseline(target.id)) recordBaseline(target.id); } catch {}
  // One page for the agent: what done means, the steps, notes, lanes, lessons, commands.
  let brief = null;
  try {
    brief = writeFocus(target.id, agent)?.file || null;
  } catch {
    // the brief is a help, never a blocker
  }
  return { ...target, owner: agent, ...(brief ? { brief } : {}), ...(handoff ? { handoff } : {}), ...(carried ? { carried } : {}) };
}

/**
 * 2.30n: who is acting. --agent first, then the lane copy's own name (<main>/.lanes/<agent>), and only then
 * STUDIO_LOCK_OWNER. In the Marina run a shared tool gateway handed every builder shell the same
 * environment, so one builder took on another's identity from an inherited STUDIO_LOCK_OWNER.
 */
export function whoAmI(flags = {}, root = REPO_ROOT, env = process.env) {
  if (typeof flags.agent === 'string' && flags.agent) return flags.agent;
  const m = String(root).replace(/\\/g, '/').match(/\/\.lanes\/([^/]+)$/);
  if (m) {
    if (env.STUDIO_LOCK_OWNER && env.STUDIO_LOCK_OWNER !== m[1]) console.error(`[task] STUDIO_LOCK_OWNER=${env.STUDIO_LOCK_OWNER} doesn't match this lane copy (${m[1]}); acting as ${m[1]}. Pass --agent to be explicit.`);
    return m[1];
  }
  return env.STUDIO_LOCK_OWNER || null;
}

/** 2.58.3 (O4): task types that are code work; their uncommitted game files are refused even with no claimed paths. */
const CODE_TYPES = ['change', 'chore', 'bug', 'system', 'whole', 'balance', 'fun'];

/**
 * Only the lock owner can finish a claimed task, and only once the done-check for its type passes
 * (harness/done-check.mjs). force skips both; a skipped check is logged and the Producer gets a
 * P1 task to run it.
 */
export function completeTask(taskId, note = '', agent = null, { force = false, reason = '', acceptedBy = '', noop = '', checkOnly = false, trainCheck = false } = {}) {
  // 2.59.0: trainCheck runs every check task done runs before the game's checks (board, done-check, the committed lane
  // copy, protected files, secrets, hooks, weakened tests) and stops there: nothing is closed or landed. The merge train
  // (harness/train.mjs) lands the lane after ONE full verify of main + the lanes, which stands for the game's checks and
  // the "full verify after the last change" check. Never forced.
  if (trainCheck && force) return { error: 'train-force', message: 'A forced done never goes through the merge train; run it without --train (STUDIO_TRAIN=off).' };
  // 2.30n: a builder in a lane copy (.lanes/<agent>) launched without STUDIO_MAIN_ROOT used to be
  // "done" with its work never merged (T-028 in the Marina run). Refuse, forced or not.
  if (/[\\/]\.lanes[\\/][^\\/]+$/.test(REPO_ROOT) && !inLaneCopy()) {
    return { error: 'no-main-root', message: `This is a lane copy (${REPO_ROOT}) but STUDIO_MAIN_ROOT isn't set, so task done can't merge your work into the studio's branch. Relaunch with STUDIO_MAIN_ROOT=<the main checkout>, or run task done there. Nothing was closed.` };
  }
  const lock = lockStatus(`task:${taskId}`);
  if (lock.locked && lock.lock.owner !== agent && !force) {
    return { error: 'locked', lock: lock.lock, message: `Task ${taskId} is claimed by ${lock.lock.owner}. Finish it as that owner or pass --force.` };
  }
  let q = parseNextQueue();
  let idx = q.inProgress.findIndex((t) => t.id === taskId);
  let target = null;
  if (idx !== -1) {
    [target] = q.inProgress.splice(idx, 1);
  } else {
    idx = q.backlog.findIndex((t) => t.id === taskId);
    if (idx !== -1) [target] = q.backlog.splice(idx, 1);
  }
  if (!target) return null;

  // 2.30m: a build task must change code. T-017 in the Marina run was closed with no change at all
  // (the agent judged the existing code good enough). Zero code changes since the task started are
  // refused unless the task is marked no-op with a reason (task done <ID> --no-op "<why>").
  if (!force && target.role === 'builder' && ['change', 'chore', 'system', 'bug', 'fun', 'balance'].includes(taskType(target)) && process.env.STUDIO_DONE_NOOP !== 'allow') {
    if (noop && String(noop).trim().length >= 10) {
      emitEvent({ type: 'task.noop', agent: agent || target.role, task: target.id, msg: `${target.id} closed as no-op: ${String(noop).trim().slice(0, 300)}` });
      note = `${note ? `${note}; ` : ''}no-op: ${String(noop).trim().slice(0, 200)}`;
    } else {
      // 2.33.0: from the FIRST start since the task was last done/reopened (taskBase), not the newest: a
      // re-claim after a hand-back used to reset the baseline and refuse real work as "no code changed"
      // (3 false refusals in the Marina run). In a lane copy, the lane's unlanded commits count too.
      const start = taskBase(target.id);
      if (start) {
        const isCode = (f) => f && !/^(studio|\.studio|\.lanes|qa\/reports)\//.test(f) && !isEngineChurn(f);
        const committed = spawnSync('git', ['diff', '--name-only', `${start}..HEAD`], { cwd: REPO_ROOT, encoding: 'utf8' });
        const working = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
        const lane = (() => { try { return laneDiff()?.changed || []; } catch { return []; } })();
        if (committed.status === 0) {
          const files = [...committed.stdout.split('\n'), ...(working.stdout || '').split('\n').filter((l) => l.length > 3).map((l) => l.slice(3)), ...lane].filter(isCode);
          if (!files.length) {
            emitEvent({ type: 'task.not_done', agent: agent || target.role, task: target.id, status: 'blocked', msg: `${target.id} not done yet: no code changed since it started` });
            return { error: 'no-change', message: `${target.id} is a build task and no code changed since it started (${String(start).slice(0, 7)}). Make the change and commit it, or, if the work truly is already there, close it with: task done ${target.id} --no-op "<what already does it, and where>".` };
          }
        }
      }
    }
  }

  // 2.30o: a render task (Godot, graphics, scene ...) needs a passing visual result (before/after captures from
  // fixed cameras, not blank, not near-identical): harness/verdict-split.mjs + harness/visual-proof.mjs.
  if (!force && process.env.STUDIO_VISUAL_GATE !== 'off') {
    const track = readRecentEvents(20000).filter((e) => e.type === 'task.added' && e.task === target.id).pop()?.meta?.track;
    const vs = summarizeVerdict(target.id, { ...target, track });
    if (!vs.ok) {
      emitEvent({ type: 'task.not_done', agent: agent || target.role, task: target.id, status: 'blocked', msg: `${target.id} not done yet: ${vs.why.slice(0, 200)}` });
      return { error: 'visual', verdict: vs, message: `${target.id} is not done: ${vs.why}\nChecked: ${vs.passed.join(', ') || 'nothing'}; unchecked: ${vs.unchecked.join(', ') || 'none'}.` };
    }
  }

  const check = checkDone(target);
  // 2.38.0: notes that don't block (built but not wired, in warn mode), shown and logged once per done.
  for (const n of check.notes || []) {
    console.warn(`[done] note: ${n} (STUDIO_REACHABILITY=fail makes this a failing check)`);
    emitEvent({ type: 'task.unwired', agent: agent || target.role, task: target.id, status: 'warn', msg: `${target.id}: ${n}`.slice(0, 400) });
  }
  // 2.33.0: task done --check runs every cheap precondition and stops before the game gates. A missing
  // full verify is reported, not refused: running it is the next step.
  const VERIFY_LABEL = 'Full verify green after the last change';
  // 2.59.0: in a train check the train's own verify (of main + this lane, --all for a "whole" task) stands for these two.
  const TRAIN_VERIFIED = new Set([VERIFY_LABEL, 'The verify ran on the whole game (--all), not scoped to your files']);
  const blocking = check.checks?.length ? check.checks.filter((c) => !c.ok && !(checkOnly && c.label === VERIFY_LABEL) && !(trainCheck && TRAIN_VERIFIED.has(c.label))) : check.ok ? [] : [{ why: check.missing[0] }];
  if (!check.ok && !force && blocking.length) {
    emitEvent({ type: 'task.not_done', agent: agent || target.role, task: target.id, status: 'blocked', msg: `${target.id} not done yet: ${check.missing[0]}` });
    return {
      error: 'not-done',
      check,
      message: [
        `${target.id} is a "${check.type}" task. Done means: ${check.means}.`,
        ...(check.checks?.length ? check.checks.map((c) => `  [${c.ok ? 'x' : ' '}] ${c.label}${c.ok ? '' : `: ${c.why}`}`) : check.missing.map((m) => `  missing: ${m}`)),
        check.skill ? `How: ${check.skill}` : '',
        'To finish anyway: --force (logged, and the Producer gets a task to run the check).',
      ].filter(Boolean).join('\n'),
    };
  }

  // 2.33.0: checked BEFORE the game gates (seconds, not 10+ minutes): a refusal for uncommitted files
  // used to come only after the full game checks had run.
  // 2.30k: done means committed. Uncommitted changes in the task's claimed files (or the game's
  // folders when it claimed none) are refused, so they aren't later committed under another task
  // (T-013 in the Marina run was accepted with its diff left uncommitted).
  if (!force && !inLaneCopy() && process.env.STUDIO_DONE_UNCOMMITTED !== 'allow') {
    const owner = lock.locked ? lock.lock.owner : agent;
    let scope = owner ? listLocks().filter((l) => l.owner === owner && l.key.startsWith('path:')).map((l) => l.key.slice(5)).filter(Boolean) : [];
    const claimedPaths = scope.length > 0;
    if (!scope.length) {
      const f = gameFolders();
      scope = [f.renderer, f.sim].filter(Boolean);
    }
    if (scope.length) {
      const st = spawnSync('git', ['status', '--porcelain', '--', ...scope], { cwd: REPO_ROOT, encoding: 'utf8' });
      const lines = st.status === 0 ? st.stdout.split('\n').filter(Boolean).filter((l) => !isEngineChurn(l.slice(3))) : [];
      // 2.58.3 (O3, crew P-035): a tracked file whose only difference is line endings (a test snapshot rewritten on
      // Windows) isn't uncommitted work: named in a note, never a refusal. Content changes, new and deleted files still are.
      const { real, eol } = splitEolOnly(REPO_ROOT, lines);
      if (eol.length) {
        console.warn(`[done] note: ${eolNote(eol)}`);
        if (!checkOnly) emitEvent({ type: 'task.eol_ignored', agent: agent || target.role, task: target.id, status: 'warn', msg: `${target.id}: ${eolNote(eol)}`.slice(0, 400), meta: { files: eol.slice(0, 20) } });
      }
      let dirty = real.map((l) => l.slice(3));
      // 2.58.3 (O4): with no claimed paths the check falls back to the game folders, where files another agent left on
      // the main checkout refused tasks that changed only studio/ docs. A task that isn't code work, claimed no paths
      // and whose own commits touch no game code is not refused for them: the Producer gets a note and an event.
      if (dirty.length && !claimedPaths && !CODE_TYPES.includes(check.type)) {
        const inScope = (f) => isGameCode(f) || scope.some((s0) => f === s0.replace(/\/+$/, '') || f.startsWith(`${s0.replace(/\/+$/, '')}/`));
        let ownGame = null;
        try { ownGame = taskChanges(target.id, startedAt(target.id)).committed.filter(inScope); } catch { ownGame = null; }
        if (ownGame && !ownGame.length) {
          const strays = `${dirty.length} uncommitted file${dirty.length === 1 ? '' : 's'} in the game folders (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ` and ${dirty.length - 3} more` : ''}) left by someone else on the main checkout`;
          console.warn(`[done] note: ${strays}; not ${target.id}'s (it claimed no paths and its commits touch no game code), so it isn't refused. The Producer is told.`);
          if (!checkOnly) emitEvent({ type: 'checkout.strays', agent: agent || target.role, task: target.id, to: 'producer', status: 'warn', msg: `${target.id} closed past ${strays}: find whose they are (git status), then have them committed or set aside`.slice(0, 400), meta: { files: dirty.slice(0, 20) } });
          dirty = [];
        }
      }
      if (dirty.length) {
        emitEvent({ type: 'task.not_done', agent: agent || target.role, task: target.id, status: 'blocked', msg: `${target.id} not done yet: ${dirty.length} uncommitted change${dirty.length === 1 ? '' : 's'} (${dirty.slice(0, 3).join(', ')})` });
        return { error: 'uncommitted', dirty, message: `${target.id} is not done: these changes aren't committed yet:\n${dirty.slice(0, 10).map((d) => `  ${d}`).join('\n')}\nCommit them (git add <files> && git commit -m "${target.id}: …"), then run task done again.` };
      }
    }
  }

  // 2.59.0: the train lands committed work only, from a lane copy (the same refusal deliver makes, made up front).
  if (trainCheck) {
    if (!inLaneCopy()) return { error: 'not-lane', message: `${target.id}: the merge train lands lane copies; in the main checkout task done closes the task directly.` };
    const { dirty, eol } = laneDirty(REPO_ROOT);
    if (eol.length) console.warn(`[task done] note: ${eolNote(eol)}`);
    if (dirty.length) return { error: 'uncommitted', dirty, message: `Commit your work first: ${dirty.length} uncommitted file(s) in your copy (${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}). Only committed work reaches the studio. Then run task done again.` };
  }

  if (checkOnly) {
    const verifyNeeded = Boolean(check.checks?.some((c) => !c.ok && c.label === VERIFY_LABEL));
    return { checkOnly: true, ok: true, id: target.id, verifyNeeded, message: `${target.id}: every quick check passes.${verifyNeeded ? ' Next: npm run verify (it is scoped to your lane), then task done.' : ' Next: task done (it runs the game checks and lands the work).'}` };
  }

  // 2.58.0 (PU-34, P-047): a verify record is a file anyone can write, so task done runs the two checks that matter
  // most again itself, forced or not (well under a second each): the protected files (changed only with the owner's
  // signed approval) and the secret scan (no key or token in what would be committed). The same scripts the
  // `protected` and `secrets` gates run (studio/gates.json), called directly so a changed gate command can't skip them.
  // 2.58.2 (PU-29): and the two that catch a check being dodged: commits that skipped the git hooks (--no-verify) and
  // tests weakened without the owner's approval. With no base branch they judge from the task's start commit.
  {
    const failed = [];
    const SAFETY = [
      ['protected', 'qa/protected-check.mjs', [], 'only the owner approves it; hand the task back with a note saying which file and why'],
      ['secrets', 'scripts/secret-scan.mjs', [], 'take it out of the files (and rotate it)'],
      ['hooks', 'harness/hook-stamp.mjs', ['check'], 're-commit those commits with the hooks (the output says how); never --no-verify'],
      ['weakened-tests', 'harness/test-weakening.mjs', [], 'put the test back, or hand the task back with a note saying which test and why; only the owner approves weakening a test'],
    ];
    const start = taskBase(target.id);
    const safetyEnv = { ...process.env, ...(start ? { STUDIO_TASK_BASE: start } : {}) };
    for (const [id, rel, args] of SAFETY) {
      const file = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(file)) { failed.push({ id, rel, why: `${rel} is missing` }); continue; }
      const r = spawnSync(process.execPath, [file, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env: safetyEnv, maxBuffer: 32 * 1024 * 1024 });
      if (r.status !== 0) failed.push({ id, rel, why: `${r.stderr || ''}${r.stdout || ''}`.trim().split('\n').slice(-12).join('\n') || `exit ${r.status}` });
    }
    for (const [id, name] of [['hooks', 'STUDIO_HOOKS_CHECK'], ['weakened-tests', 'STUDIO_WEAKENED_TESTS']]) {
      if (/^(off|0|false|no)$/i.test(String(process.env[name] || ''))) emitEvent({ type: 'safety.off', agent: agent || target.role, task: target.id, msg: `${target.id} closed with the ${id} check off (${name}=off)` });
    }
    if (failed.length) {
      emitEvent({ type: 'task.not_done', agent: agent || target.role, task: target.id, status: 'blocked', msg: `${target.id} not done yet: the ${failed.map((f) => f.id).join(' and ')} check failed` });
      const how = Object.fromEntries(SAFETY.map(([id, , , h]) => [id, h]));
      return { error: 'safety', failed, message: `${target.id} is not done: ${failed.map((f) => `the ${f.id} check fails (node ${f.rel}):\n${f.why.split('\n').map((l) => `  ${l}`).join('\n')}\n  Fix: ${how[f.id]}.`).join('\n')}\nThese run at every task done, forced or not.` };
    }
  }

  if (trainCheck) {
    const g = (...a) => { const r = spawnSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };
    return { trainReady: true, id: target.id, type: check.type, all: check.type === 'whole', head: g('rev-parse', 'HEAD'), tree: g('rev-parse', 'HEAD^{tree}'), branch: g('symbolic-ref', '--short', 'HEAD') };
  }

  // 2.30n: the studio game's own checks and, for files in a Godot project, the engine gate. Before
  // 2.30n only example-sim was gated, so the real game never was. STUDIO_DONE_GAME_GATES=skip turns it off.
  if (!force && process.env.STUDIO_DONE_GAME_GATES !== 'skip') {
    const owner = lock.locked ? lock.lock.owner : agent;
    const claimed = owner ? listLocks().filter((l) => l.owner === owner && l.key.startsWith('path:')).map((l) => l.key.slice(5)).filter(Boolean) : [];
    const lanePaths = laneList(readHolds()[target.id]?.lane);
    // 2.30p: in a lane copy the diff against the studio's branch picks the gates (path-scoped gates);
    // its files also feed the engine gate. Outside a lane copy the diff is unknown and every gate runs.
    const ld = laneDiff();
    // 2.33.0: outside a lane copy, the caller's STUDIO_GATE_CHANGED (an explicit list) is used instead of dropped.
    const callerChanged = String(process.env.STUDIO_GATE_CHANGED || '').split(',').filter(Boolean);
    const changed = ld?.changed?.length ? ld.changed : callerChanged.length ? callerChanged : null;
    const paths = [...new Set([...claimed, ...lanePaths, ...(changed || [])])];
    const ggEnv = { ...process.env };
    delete ggEnv.STUDIO_GATE_CHANGED;
    // 2.43.0: the game's checks that passed in a full verify are not run a second time at done (on a real 236k-line
    // game that was another 6 minutes per task, right after the same checks passed).
    // 2.58.5 (H-3): on by default, keyed on the tree: a green full verify whose tree (HEAD^{tree} when it started, with a
    // clean tree start to end) is the tree being landed counts, so task done doesn't run the game's checks again (under
    // load the second run timed out or flaked: 600 s, then e2e timeouts that passed alone in 48 s). A partial, dirty,
    // failing, old (24 h, STUDIO_DONE_REUSE_MAX_H), narrower (scoped to fewer files, no engine gate, related tests only)
    // or other-tree record never counts (merge-lane.mjs judgeVerifyReuse). The safety checks above always ran.
    // STUDIO_DONE_REUSE_VERIFY=off always runs them; =on also lets a record from before 2.58.5 count by its commit.
    const reuseEnv = String(process.env.STUDIO_DONE_REUSE_VERIFY || '');
    const reuse = (() => {
      if (/^(off|0|false|no)$/i.test(reuseEnv)) return null;
      const rec = lastFullRecord();
      if (!rec) return null;
      const gitOut = (...a) => { const r = spawnSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };
      const tree = gitOut('rev-parse', 'HEAD^{tree}');
      const recTree = rec.head && /^[0-9a-f]{40,64}$/.test(String(rec.head)) ? gitOut('rev-parse', '--verify', '--quiet', `${rec.head}^{tree}`) : '';
      const st = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', '.', ':(exclude)studio'], { cwd: REPO_ROOT, encoding: 'utf8' });
      const clean = st.status === 0 && !String(st.stdout || '').trim();
      const hadPaths = Array.isArray(rec.gatePaths) ? rec.gatePaths : rec.scoped ? rec.changed || [] : [];
      return { rec, ...judgeVerifyReuse(rec, { tree, recTree: recTree || null, clean, changed, needEngine: engineGates(paths).map((e) => e.project), hadEngine: engineGates(hadPaths).map((e) => e.project), relatedNow: relatedTestsOn(), optIn: /^(on|1|true|yes)$/i.test(reuseEnv), maxAgeH: Number(process.env.STUDIO_DONE_REUSE_MAX_H || 24) }) };
    })();
    let plan = null;
    if (reuse?.ok) {
      // The checks this done would have run, and the scope that pass covers (for deliver's re-check after a rebase).
      const pr = spawnSync(process.execPath, [path.join(REPO_ROOT, 'harness', 'game-gates.mjs'), '--plan', ...(paths.length ? ['--paths', paths.join(',')] : []), ...(changed ? ['--changed', changed.join(',')] : [])], { cwd: REPO_ROOT, encoding: 'utf8', env: ggEnv, maxBuffer: 32 * 1024 * 1024 });
      try { plan = JSON.parse((pr.stdout || '').trim().split('\n').pop()); } catch { plan = null; }
      if (!Array.isArray(plan?.gates)) plan = null;
    }
    const reused = plan ? reuse.rec : null;
    if (reused) {
      console.log(`[task done] ${reuse.why}: not run again (STUDIO_DONE_REUSE_VERIFY)`);
      emitEvent({ type: 'gates.reused', agent: agent || target.role, task: target.id, msg: `${target.id}: game checks from the verify on tree ${String(reused.tree || reused.head).slice(0, 8)} reused at done` });
    } else if (reuse?.ok) console.log('[task done] running the game\'s checks: which ones a verify covers could not be read (game-gates --plan)');
    else if (reuse) console.log(`[task done] running the game's checks: the last verify can't stand in for them (${reuse.why})`);
    // Game checks run now (not reused) take the next free gate slot ahead of verifies (merge-lane.mjs withGateSlot).
    ggEnv.STUDIO_GATE_PRIORITY = 'landing';
    const gg = reused ? { status: 0, stdout: JSON.stringify({ ok: true, rows: plan.gates.map((id) => ({ id, ok: true, reused: true })), skipped: plan.skipped, scope: plan.scope }) } : spawnSync(process.execPath, [path.join(REPO_ROOT, 'harness', 'game-gates.mjs'), '--json', ...(paths.length ? ['--paths', paths.join(',')] : []), ...(changed ? ['--changed', changed.join(',')] : [])], { cwd: REPO_ROOT, encoding: 'utf8', env: ggEnv, maxBuffer: 32 * 1024 * 1024 });
    let res = null;
    try { res = JSON.parse((gg.stdout || '').trim().split('\n').pop()); } catch {}
    if (res?.skipped?.length) {
      for (const sk of res.skipped) console.log(`[task done] skipped gate ${sk.id}: ${sk.why}`);
      emitEvent({ type: 'gates.skipped', agent: agent || target.role, task: target.id, msg: `${target.id}: skipped ${res.skipped.map((x) => x.id).join(', ')} (outside the change's paths)` });
    }
    // Record the pass so deliver can reuse it after a rebase that only brings in other tracks' files.
    if (gg.status === 0 && ld) recordPass(mainRoot(), target.id, { head: ld.head, base: ld.base, changed: ld.changed, scope: res?.scope ?? null, ran: (res?.rows || []).map((r) => r.id), skipped: (res?.skipped || []).map((x) => x.id) });
    if (gg.status !== 0) {
      const failed = res?.failed?.length ? res.failed : [{ id: 'game-gates', why: `${(gg.stderr || gg.stdout || '').trim().slice(0, 300)}` }];
      emitEvent({ type: 'task.not_done', agent: agent || target.role, task: target.id, status: 'blocked', msg: `${target.id} not done yet: ${failed.map((f) => f.id).join(', ')} failed` });
      return { error: 'game-gates', failed, message: `${target.id} is not done: the game's checks fail.\n${failed.map((f) => `  FAIL ${f.id}: ${f.why}`).join('\n')}\nFix it, commit, and run task done again (node harness/game-gates.mjs${paths.length ? ` --paths ${paths.join(',')}` : ''} runs them).` };
    }
  }

  // Forced past a failing check: the owner's uncommitted work in its claimed folders is saved as a patch
  // first, so it isn't lost or committed later under another task (test #3: 12 forced, several with work
  // left uncommitted that later tasks committed).
  let forcedPatch = null;
  if (!check.ok) {
    const owner = lock.locked ? lock.lock.owner : agent;
    const claims = owner ? listLocks().filter((l) => l.owner === owner && l.key.startsWith('path:')).map((l) => l.key) : [];
    if (claims.length) {
      try {
        forcedPatch = savePatch(owner, taskId, claims, { suffix: '-forced' });
      } catch {}
    }
  }

  // 2.30p: the board is re-read right before it is written (under the land lock) and only this task's
  // move to DONE is applied, so tasks other agents queued while the gates ran are never overwritten.
  let landed = false;
  const writeBoard = () => withBoard(() => {
    const fresh = parseNextQueue();
    fresh.inProgress = fresh.inProgress.filter((t) => t.id !== target.id);
    fresh.backlog = fresh.backlog.filter((t) => t.id !== target.id);
    fresh.done = fresh.done.filter((t) => t.id !== target.id);
    target.status = 'done';
    if (note) target.title = `${target.title} _(✓ ${note})_`;
    fresh.done.unshift(target);
    writeNextQueue(fresh);
    q = fresh;
    landed = true;
  });

  // In a lane copy (2.29), done is when the work reaches the studio's branch: committed, rebased on the
  // latest, checked again if that moved, then added. Forced or not, uncommitted work is refused here.
  if (inLaneCopy()) {
    // 2.58.5 (H-3): the re-check after a rebase is a landing too: its game checks take the next free gate slot first.
    const hadPriority = process.env.STUDIO_GATE_PRIORITY;
    process.env.STUDIO_GATE_PRIORITY = 'landing';
    let d;
    try { d = deliver(taskId, { onLanded: writeBoard }); } finally { if (hadPriority === undefined) delete process.env.STUDIO_GATE_PRIORITY; else process.env.STUDIO_GATE_PRIORITY = hadPriority; }
    if (d && !d.ok) {
      emitEvent({ type: 'task.not_done', agent: agent || target.role, task: target.id, status: 'blocked', msg: `${target.id} not done yet: ${d.message.split('.')[0]}` });
      return { error: 'not-delivered', message: d.message };
    }
  }

  if (!landed) {
    try {
      withLandLock(mainRoot(), writeBoard);
    } catch (err) {
      if (err.code !== 'LAND_BUSY') throw err;
      writeBoard(); // still a fresh re-read and merge, just without the lock
    }
  }
  clearPass(mainRoot(), taskId);
  if (lock.locked) release(`task:${taskId}`, lock.lock.owner);

  const nextActive = q.inProgress[0] || null;
  syncCurrentTaskCheckpoint(nextActive, `Completed ${target.id}${note ? `: ${note}` : ''}`);
  emitEvent({ type: 'task.done', agent: agent || target.role, task: target.id, status: 'done', to: 'producer', msg: `Completed ${target.id}: ${target.title}` });
  // 2.35.0: a finished rescue acts on its decision (retry unparks the stuck task, split keeps it parked, needs-person asks).
  if (taskType(target) === 'rescue') { try { applyRescue(target, { by: agent || 'rescue' }); } catch { /* the rescue's own record stays */ } }
  joinWaveIfGameplay(target, agent || target.role);

  if (!check.ok) {
    // 2.30d (#9): a forced done is "done (pending)": the lane moves on, an approval card waits for a
    // person or a reviewer from another model family to close or reopen it (npm run task -- review).
    const forcer = agent || target.role;
    const forcedModel = readRecentEvents(20000).filter((e) => e.task === target.id && e.type === 'task.start' && e.model).pop()?.model || process.env.STUDIO_AGENT_MODEL || null;
    if (!(acceptedBy && reason)) openPending({ task: target.id, title: target.title, by: forcer, model: forcedModel, reason: reason || 'no reason given', missing: check.missing[0], type: check.type, patch: forcedPatch });
    // Forced past a failing check: tell the Producer, and give it a task to run the check.
    emitEvent({
      type: 'task.forced',
      agent: agent || target.role,
      task: target.id,
      status: 'forced',
      to: 'producer',
      msg: `Forced ${target.id} done without: ${check.missing[0]}${reason ? ` (reason: ${reason})` : ''}${acceptedBy ? `, accepted by ${acceptedBy}` : ''}${forcedPatch ? `; uncommitted work saved to ${forcedPatch}` : ''}`,
      meta: { type: check.type, missing: check.missing, reason: reason || null, acceptedBy: acceptedBy || null, patch: forcedPatch },
    });
    // A person already accepted it with a reason: logged, no follow-up task (the run report lists it).
    if (acceptedBy && reason) return { ...target, forced: true, check, followUp: null, acceptedBy };
    // A person accepted this cause for the run: logged, no new card (harness/causes.mjs).
    const cause = causeOf(check.missing[0]);
    if (isAccepted(cause)) return { ...target, forced: true, check, followUp: null, acceptedCause: cause };
    // The same cause already has an open check task: this task joins it instead of adding another.
    const open = [...q.inProgress, ...q.backlog].find((t) => /^Check forced done /.test(t.title) && causeOf(t.title.replace(/^[^:]*\): /, '')) === cause);
    if (open) {
      withBoard(() => {
        const q2 = parseNextQueue();
        const same = [...q2.inProgress, ...q2.backlog].find((t) => t.id === open.id);
        const m = same?.title.match(/^Check forced done (.+?) \(([^)]+)\): (.+)$/);
        if (!m) return;
        const ids = m[1].split(/,\s*/);
        if (!ids.includes(target.id)) same.title = `Check forced done ${[...ids, target.id].join(', ')} (${m[2]}): ${m[3]}`;
        writeNextQueue(q2);
      });
      return { ...target, forced: true, check, followUp: open.id, joined: true };
    }
    const followUp = addTask({ title: `Check forced done ${target.id} (${check.type}): ${check.missing[0]}`, role: 'producer', priority: 'P1' });
    return { ...target, forced: true, check, followUp: followUp.id, patch: forcedPatch };
  }
  return target;
}

/**
 * 2.59.0: close a task a merge train landed (harness/train.mjs): its lane's checked head is in the train's verified
 * head, which main now contains. The board move, the claim, the events and the follow-ups are task done's; its checks
 * ran in the train's lane check (trainCheck) and the train's verify. Returns the task, null (not on the board) or
 * { error, message }.
 */
export function closeTrainTask(taskId, agent, { train, head, laneHead, record = null, note = '' } = {}) {
  const lock = lockStatus(`task:${taskId}`);
  if (lock.locked && lock.lock.owner !== agent) return { error: 'locked', message: `${taskId} is claimed by ${lock.lock.owner} now, not ${agent}` };
  const root = mainRoot();
  const anc = (a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: root }).status === 0;
  const mainTip = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  if (!head || !laneHead || !anc(laneHead, head) || !anc(head, mainTip)) return { error: 'not-landed', message: `${taskId}'s lane (${String(laneHead).slice(0, 8)}) is not in the studio's branch through train ${train}` };
  // The train's verify: clean and full, with no red required check but one already red when this task was claimed.
  if (record && (record.dirty !== false || record.partial || judgeRed((record.rows || []).map((r) => ({ ...r, required: r.required !== false })), readBaseline(taskId) || { red: [] }).fresh.length)) return { error: 'not-verified', message: `train ${train}'s verify record is not a clean, green full verify` };
  let target = null;
  let q = null;
  const writeBoard = () => withBoard(() => {
    const fresh = parseNextQueue();
    target = fresh.inProgress.find((t) => t.id === taskId) || fresh.backlog.find((t) => t.id === taskId) || null;
    if (!target) return;
    fresh.inProgress = fresh.inProgress.filter((t) => t.id !== taskId);
    fresh.backlog = fresh.backlog.filter((t) => t.id !== taskId);
    fresh.done = fresh.done.filter((t) => t.id !== taskId);
    target.status = 'done';
    if (note) target.title = `${target.title} _(✓ ${note})_`;
    fresh.done.unshift(target);
    writeNextQueue(fresh);
    q = fresh;
  });
  try { withLandLock(root, writeBoard); } catch (err) { if (err.code !== 'LAND_BUSY') throw err; writeBoard(); }
  if (!target) return null;
  clearPass(root, taskId);
  if (lock.locked) release(`task:${taskId}`, lock.lock.owner);
  syncCurrentTaskCheckpoint(q.inProgress[0] || null, `Completed ${target.id}${note ? `: ${note}` : ''}`);
  emitEvent({ type: 'task.done', agent: agent || target.role, task: target.id, status: 'done', to: 'producer', msg: `Completed ${target.id}: ${target.title} (merge train ${train})`, meta: { train } });
  if (taskType(target) === 'rescue') { try { applyRescue(target, { by: agent || 'rescue' }); } catch { /* the rescue's own record stays */ } }
  joinWaveIfGameplay(target, agent || target.role);
  return target;
}

/** 2.59.0: what the merge train needs from the board (harness/train.mjs never imports this module). */
export function trainDeps(busyMod, { forDone = false } = {}) {
  return {
    close: (lane, ctx) => {
      const t = closeTrainTask(lane.task, lane.agent, { train: ctx.train, head: ctx.head, laneHead: lane.head, record: ctx.record, note: lane.note || '' });
      return t?.error ? { ok: false, message: t.message } : t ? { ok: true, target: t } : { ok: false, message: `${lane.task} is not on the board` };
    },
    handBack: (lane, note) => pauseTask(lane.task, lane.agent, note, { force: true }),
    stopped: () => { const s = readStop(); return s ? `by ${s.by}${s.reason ? `: ${s.reason}` : ''}` : null; },
    ...(forDone ? {} : {
      waitForDrain: () => busyMod.waitForDrain(),
      markRunning: (t, a) => { busyMod.markDoneRunning(t, a).catch(() => {}); },
      clearRunning: (t) => { busyMod.clearDoneRunning(t).catch(() => {}); },
    }),
  };
}

/**
 * Hand a task back: the agent is out of usage, being swapped, or stuck. The task goes to the top of
 * the queue, the claim is released, and the note tells the next agent where things stand.
 * The watcher (harness/watch.mjs) does the same for claims that expired with no word.
 */
/** Is this lock owner a launcher session that is still running? Unknown owners (hand-run agents) count as running. */
function holderRunning(owner) {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(path.join(STUDIO_STATE_DIR, 'agents', `${owner}.json`), 'utf8'));
  } catch {
    return true; // not a launcher session: it may be running by hand
  }
  if (s.status !== 'running') return false;
  // PU-17 (P-039): no OS query here; on Linux a /proc start that differs from the one recorded at launch means dead.
  return recordAlive(s);
}
/** 2.30c (#4): a hand-back note is at most this many characters (20 lines). */
export const HANDBACK_MAX = 2400;
/** Is `lock` (a claim, or null) the claim `expect` describes: 'none', or { owner, claimedAt }? */
export function sameClaim(lock, expect) {
  if (expect === 'none' || expect === null) return !lock;
  return Boolean(lock) && lock.owner === expect.owner && String(lock.claimedAt || '') === String(expect.claimedAt || '');
}

/**
 * `expect` (2.58.0, P-054): the claim the caller decided on ('none', or { owner, claimedAt } from listLocks). It is
 * checked again under the board lock, and the hand-back is skipped ({ error: 'claim-changed' }) if the claim changed
 * meanwhile. The watcher decides from a read made at the start of its pass; a `git status` later (seconds on a big
 * repo), it used to hand back a task an agent had just re-claimed, releasing that fresh claim, and a third agent
 * then started the same task.
 */
export function pauseTask(taskId, agent = null, note = '', { force = false, expect } = {}) {
  let lock = lockStatus(`task:${taskId}`);
  // Anyone may hand back a task whose holder's session has ended (test #2: dead agents' tasks sat
  // claimed for up to an hour, and the Producer had to wait for the claim to expire).
  if (lock.locked && lock.lock.owner !== agent && !force && holderRunning(lock.lock.owner)) {
    return { error: 'locked', message: `Task ${taskId} is claimed by ${lock.lock.owner}, which is still running. Only that owner can hand it back (or stop it: npm run agent -- stop ${lock.lock.owner}).` };
  }
  let q = null;
  let target = null;
  let changed;
  withBoard(() => {
    q = parseNextQueue();
    const idx = q.inProgress.findIndex((t) => t.id === taskId);
    if (idx === -1) return;
    if (expect !== undefined) {
      const now = lockStatus(`task:${taskId}`);
      if (!sameClaim(now.lock || null, expect)) { changed = now.lock || null; return; }
      lock = now;
    }
    [target] = q.inProgress.splice(idx, 1);
    target.status = 'backlog';
    q.backlog.unshift(target);
    writeNextQueue(q);
    // Released under the board lock: a start waiting for it then sees the task waiting and no claim.
    if (lock.locked) release(`task:${taskId}`, lock.lock.owner);
  });
  if (changed !== undefined) return { error: 'claim-changed', lock: changed, message: `${taskId} was not handed back: ${changed ? `${changed.owner} claimed it ${changed.claimedAt ? `at ${String(changed.claimedAt).slice(11, 19)}` : 'just now'}` : 'its claim was released'} after this decision was made.` };
  if (!target) return null;
  const who = agent || lock.lock?.owner || 'unknown';
  // The agent is stopping: free its folder and file claims too, unless it still holds another task.
  const freed = [];
  const mine = listLocks().filter((l) => l.owner === who);
  if (!mine.some((l) => l.key.startsWith('task:'))) for (const l of mine) if (release(l.key, who).ok !== false) freed.push(l.key);
  // A hand-back note is for the next agent, who shouldn't have to read the last one's logs: 20 lines
  // at most, in a fixed shape (done, not done, files, next step, proof). Longer notes are cut.
  const capLines = String(note || '').split('\n');
  if (capLines.length > 20 || String(note || '').length > HANDBACK_MAX) note = `${capLines.slice(0, 20).join('\n').slice(0, 2400)}\n(Cut to 20 lines. Keep hand-back notes short: done, not done, files touched, next step, proof.)`;
  if (freed.length) note = `${note || 'No note left.'}\nReleased claims: ${freed.join(', ')}`;
  fs.mkdirSync(HANDOFF_DIR, { recursive: true });
  const file = handoffFile(taskId);
  const head = fs.existsSync(file) ? '' : `# Handoff notes for ${target.id}: ${target.title}\n\nNewest last. Read these before you pick the task up.\n`;
  fs.appendFileSync(file, `${head}\n## ${new Date().toISOString()} · ${who}\n${note || 'No note left.'}\n`);
  syncCurrentTaskCheckpoint(q.inProgress[0] || null, `Paused ${target.id}: ${note || 'handed back'}`);
  emitEvent({ type: 'task.paused', agent: who, task: target.id, status: 'paused', msg: `Handed back ${target.id}: ${note || 'no note'}`, meta: isFailureNote(note) ? { reasonKey: reasonKey(note) } : {} });
  // 2.30c (#8): a second hand-back for the same reason parks the task with a card; other lanes go on.
  const tripped = checkBreaker(target.id, note, who);
  // "blocked by T-12" (or "waits for", "needs T-12 first") in the note: hold the task until T-12 is done,
  // so it isn't picked up again only to be handed back for the same reason (Jed's run).
  const deps = [...String(note || '').matchAll(/\b(?:blocked (?:by|on)|waits? (?:for|on)|needs|after)\s+((?:T-\d+(?:\s*(?:,|and)\s*)?)+)/gi)].flatMap((m) => m[1].match(/T-\d+/g) || []);
  const open = deps.filter((d) => d !== target.id && !q.done.some((t) => t.id === d) && [...q.inProgress, ...q.backlog].some((t) => t.id === d));
  if (open.length) setHold(target.id, { after: [...new Set([...(readHolds()[target.id]?.after || []), ...open])] }, { by: who, msg: `${target.id} waits for ${open.join(', ')} (from ${who}'s hand-back note)` });
  return { ...target, handoffFile: path.relative(REPO_ROOT, file), waitsFor: open, ...(tripped ? { parked: tripped } : {}) };
}

export const PRODUCER_NAME = () => process.env.STUDIO_PRODUCER_NAME || 'producer';

/**
 * 2.58.0 (P-053): how long a task claim must be old, and the board quiet, before the watcher treats a claim on a
 * task that isn't in progress as left behind (STUDIO_CLAIM_LEAK_GRACE_SEC, 60). A `task done` or `pause` moves the
 * task on the board first and frees the claim a moment later; a `task start` claims a moment before the move.
 */
export const claimLeakGraceMs = () => {
  const v = Number(process.env.STUDIO_CLAIM_LEAK_GRACE_SEC);
  return (process.env.STUDIO_CLAIM_LEAK_GRACE_SEC !== undefined && process.env.STUDIO_CLAIM_LEAK_GRACE_SEC !== '' && Number.isFinite(v) ? Math.max(0, v) : 60) * 1000;
};

/**
 * 2.58.0 (P-053): free a `task:` claim nobody can be using: its task is done, waiting, or not on the board (a
 * `task done` killed after its board write kept it, and heartbeats renewed it; a killed start or pause). Under the
 * board lock, and only if the claim is still the one the caller saw (`expect`: { owner, claimedAt }) and the task is
 * still not in progress. Returns { released, where, owner } or { released: false, why }.
 */
export function releaseLeakedClaim(taskId, expect) {
  return withBoard(() => {
    const q = parseNextQueue();
    if (q.inProgress.some((t) => t.id === taskId)) return { released: false, why: 'in progress' };
    const l = lockStatus(`task:${taskId}`).lock || null;
    if (!l || !sameClaim(l, expect)) return { released: false, why: 'changed' };
    const where = q.done.some((t) => t.id === taskId) ? 'done' : q.backlog.some((t) => t.id === taskId) ? 'waiting' : 'not on the board';
    const r = release(`task:${taskId}`, l.owner);
    return r.released ? { released: true, where, owner: l.owner } : { released: false, why: r.reason || 'not released' };
  });
}

/** When either board file last changed (ms), for the watcher's grace. */
export function boardChangedAt() {
  let t = 0;
  for (const f of [NEXT_FILE, DONE_FILE]) { try { t = Math.max(t, fs.statSync(f).mtimeMs); } catch { /* not written yet */ } }
  return t;
}

/** meta: { size: 1-5 (how hard), causedBy: 'T-012' (the task whose work caused this bug) } */
/**
 * Reopen finished work that turned out wrong. Counts as a bug against the model that closed it
 * (harness/scorecard.mjs). The reason goes into the task's handoff notes.
 */
export function reopenTask(taskId, reason = '', agent = PRODUCER_NAME()) {
  let target = null;
  let freed = null;
  withBoard(() => {
    const q = parseNextQueue();
    const idx = q.done.findIndex((t) => t.id === taskId);
    if (idx === -1) return;
    [target] = q.done.splice(idx, 1);
    target.title = target.title.replace(/\s*_\(✓ .*\)_$/, '');
    target.status = 'backlog';
    q.backlog.unshift(target);
    writeNextQueue(q);
    // 2.58.0 (P-053): a claim left on the finished task (its `task done` was killed after the board write) would
    // keep every agent off the reopened task. A claim younger than the grace is a start in flight: left alone.
    const l = lockStatus(`task:${taskId}`).lock;
    if (l && Date.now() - (Date.parse(l.claimedAt || '') || 0) >= claimLeakGraceMs() && release(`task:${taskId}`, l.owner).released) freed = l.owner;
  });
  if (!target) return null;
  if (freed) reason = `${reason || 'No reason given.'}\n(${freed}'s claim, left from when it was done, was released.)`;
  fs.mkdirSync(HANDOFF_DIR, { recursive: true });
  const file = handoffFile(taskId);
  const head = fs.existsSync(file) ? '' : `# Handoff notes for ${target.id}: ${target.title}\n\nNewest last. Read these before you pick the task up.\n`;
  fs.appendFileSync(file, `${head}\n## ${new Date().toISOString()} · ${agent} (reopened)\n${reason || 'No reason given.'}\n`);
  emitEvent({ type: 'task.reopened', agent, task: target.id, status: 'reopened', msg: `Reopened ${target.id}: ${reason || 'no reason given'}` });
  return target;
}

/**
 * The Game Bible's rules for new tasks. No Bible: everything is allowed (a project that hasn't run
 * intake). With one, build tasks (type "change"):
 *   - wait until a person signs the Bible (throwaway prototypes with --prototype are allowed),
 *   - say which phase they belong to (--phase 1|2|3), and that phase must be open,
 *   - say what they serve (--serves pillar:<name> or layer:<kept layer>) or come from an approved idea,
 *   - can't touch a crossed-out layer.
 * Any task with --idea needs that idea approved. Warns when the Director hasn't reviewed lately.
 */
export function gateTask({ title, role = 'builder', meta = {} }) {
  const b = readBible();
  const warnings = [];
  if (meta.idea) {
    const idea = readIdea(meta.idea);
    if (!idea) return { ok: false, message: `No idea ${meta.idea} on the Idea Board.` };
    if (!['approved', 'scheduled'].includes(idea.stage)) return { ok: false, message: `${meta.idea} is "${idea.stage}". Ideas go captured, shaped, placed, then approved by the Director before they become work (npm run idea -- show ${meta.idea}).` };
  }
  if (!b || !['change', 'system'].includes(taskType({ title, role }))) return { ok: true, warnings };
  const notLayers = new Set(String(meta.notLayer || '').split(',').filter(Boolean));
  const crossed = crossedLayersIn(title, b).filter((l) => !notLayers.has(l.id));
  if (crossed.length) return { ok: false, message: `"${title}" touches a crossed-out layer: ${crossed.map((l) => `${l.label} (the word "${l.word}")`).join(', ')} (studio/bible/NOT-DOING.md). If the task really is about that, only a person brings the layer back: npm run bible -- layer ${crossed[0].id} yes --by <name>. If the word means something else here, reword the title, or add --not-layer ${crossed[0].id} (logged for the Director's drift report).` };
  if (notLayers.size) emitEvent({ type: 'task.scope_override', agent: meta.by || PRODUCER_NAME(), to: 'director', msg: `"${title}" queued with --not-layer ${[...notLayers].join(',')}: the title matched a crossed-out layer's keyword, and the author says it is not about that layer` });
  if (meta.prototype || meta.infra || /^prototype\b/i.test(title)) return { ok: true, warnings };
  if (b.signed && b.amended) return { ok: false, message: `The Game Bible changed after ${b.signed.by} signed it (${b.amended.changes.map((c) => c.field).join(', ')}). New build tasks wait until a person re-signs the new design: npm run bible -- sign --by <name> [--via "<where they approved>"]. Work already queued carries on.` };
  if (!b.signed) return { ok: false, message: 'The Game Bible is not signed yet, so this is still pre-production: build tasks wait. Allowed now: studies, storyboards, docs, throwaway prototypes (--prototype) and tooling that isn\'t game content (--infra). See npm run bible -- check.' };
  const phase = Number(meta.phase);
  if (![1, 2, 3].includes(phase)) return { ok: false, message: 'Build tasks say which part of the game they are for: --phase 1 (early), 2 (mid) or 3 (endgame).' };
  const openFloors = (b.phase?.floors || []).map(f => f.n);
  if (phase > (b.phase?.open || 1) && !openFloors.includes(phase)) {
    const openList = [b.phase?.open || 1, ...openFloors].filter(Boolean).sort();
    return { ok: false, message: `Phase ${phase} isn't open yet (open: ${[...new Set(openList)].join(', ')}). Finish and prove the earlier phase first; designing later phases is fine as a study or docs task.` };
  }
  const serves = String(meta.serves || '');
  const pillarOk = /^pillar:/i.test(serves) && (b.pillars || []).some((p) => p.name.toLowerCase().startsWith(serves.slice(7).trim().toLowerCase()) && serves.slice(7).trim());
  const layerId = /^layer:/i.test(serves) ? serves.slice(6).trim() : null;
  const layerOk = layerId && b.layers?.[layerId]?.answer === 'yes';
  if (!pillarOk && !layerOk && !meta.idea) {
    const kept = LAYERS.filter((l) => b.layers?.[l.id]?.answer === 'yes').map((l) => `layer:${l.id}`);
    return { ok: false, message: `Say what this serves: --serves ${[...(b.pillars || []).map((p) => `pillar:${p.name}`), ...kept].slice(0, 6).join(' | ')} (or --idea <approved idea>).${layerId && b.layers?.[layerId]?.answer === 'no' ? ` ${layerId} is crossed out.` : ''}` };
  }
  const r = latestReview();
  const since = r ? r.at : 0;
  const builds = readRecentEvents(5000).filter((e) => e.type === 'task.added' && e.meta?.build && Date.parse(e.ts) > since).length;
  if (!r || Date.now() - r.at > 24 * 3600 * 1000 || builds >= 10) warnings.push(`The Director hasn't reviewed ${r ? `in ${builds >= 10 ? `${builds} build tasks` : 'over a day'}` : 'yet'}. Before generating more tasks: npm run director -- ping --reason "new tasks for Phase ${phase}"`);
  return { ok: true, warnings };
}

/**
 * 2.33.0: a task id is never reused. The next id is one past the highest ever issued: on the board, in the
 * event log (a task dropped from the board keeps its number there), and in <main>/.studio/task-counter,
 * chosen under a short lock so two agents adding at once get different ids. In the Marina run a dropped
 * T-172 was handed out again, so the log's T-172 meant two tasks.
 */
export function allocateTaskId(q = parseNextQueue()) {
  const num = (id) => (/^T-(\d+)$/.test(String(id || '')) ? Number(String(id).slice(2)) : 0);
  const root = mainRoot();
  const counter = path.join(root, '.studio', 'task-counter');
  const pick = () => {
    let max = 0;
    for (const t of [...q.inProgress, ...q.backlog, ...q.done]) max = Math.max(max, num(t.id));
    for (const e of readRecentEvents(0)) if (e.type === 'task.added') max = Math.max(max, num(e.task));
    try { max = Math.max(max, Number(fs.readFileSync(counter, 'utf8').trim()) || 0); } catch {}
    const next = max + 1;
    writeAtomic(counter, `${next}\n`, { fsync: false });
    return `T-${String(next).padStart(3, '0')}`;
  };
  try {
    return withLandLock(root, pick, { name: 'task-id', waitMs: 10000 });
  } catch (err) {
    if (err.code !== 'LAND_BUSY') throw err;
    return pick();
  }
}

/**
 * 2.58.5 (H-5): `task add ... --start --agent X` queues the task and starts it for X in one step. The claim is taken
 * before the task appears on the board, so there is no moment when it waits unclaimed (on 2.58.3 the supervisor
 * started builder-s32 on T-074 in the seconds between opus-bot's `task add` and its `task start`). The result is the
 * started task, or the queued one with `startError` when it couldn't start (a hold, the budget, a stop).
 */
export function addTask(opts) {
  const startFor = opts?.startFor || null;
  if (!startFor) return addTaskInner(opts);
  if (SHARED_OWNERS.has(String(startFor).trim().toLowerCase())) return { error: 'owner-required', message: `--start needs a unique --agent (e.g. claude-a), not "${startFor}".` };
  const created = addTaskInner(opts);
  if (!created?.id || created.error || created.proposed) return created;
  // Already in progress (the same title, already queued and started): only its holder carries on.
  const started = startTask(created.id, startFor, { model: opts.model || null });
  const out = { ...created };
  if (started && !started.error) return { ...out, status: 'in_progress', owner: startFor, ...(started.brief ? { brief: started.brief } : {}), started: true };
  if (!created.duplicate) { try { release(`task:${created.id}`, startFor); } catch { /* the watcher frees a claim on a waiting task */ } }
  return { ...out, started: false, startError: started?.message || (started?.lock?.owner ? `claimed by ${started.lock.owner}` : 'not started') };
}

function addTaskInner({ title, role = 'builder', priority = 'P1', agent = PRODUCER_NAME(), meta = {}, startFor = null }) {
  // 2.35.0: a rescuer splitting a stuck task (it holds "Rescue: T-x" and the new title names T-x) queues directly.
  if (!meta.promoted && agent && !isDecider(agent, process.env)) {
    try {
      const board = parseNextQueue();
      const held = listLocks().filter((l) => l.owner === agent && l.key.startsWith('task:')).map((l) => l.key.slice(5));
      const stuck = held.map((id) => [...board.inProgress, ...board.backlog].find((t) => t.id === id)).filter(Boolean).map((t) => rescueOf(t.title)).filter(Boolean);
      if (stuck.some((sid) => new RegExp(`\\b${sid}\\b`).test(title))) meta = { ...meta, promoted: true, origin: 'rescue' };
    } catch {}
  }
  // 2.43.0: the same title already open (backlog or in progress) is that task, not a second one: a repeated
  // add (an agent retrying a command whose output it lost) used to queue a duplicate.
  try {
    const norm = (x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const board = parseNextQueue();
    const same = [...board.inProgress, ...board.backlog].find((t) => norm(t.title) === norm(title));
    if (same) return { id: same.id, priority: same.priority, role: same.role, title: same.title, status: board.inProgress.includes(same) ? 'in-progress' : 'backlog', duplicate: true, warnings: [`already queued as ${same.id}: not added again`] };
  } catch {}
  // 2.30d (#6): only the Director, Producer and planner (and people) add to the live queue; anyone
  // else's add waits in studio/proposed.json with a one-line reason until the Producer promotes it.
  if (!meta.promoted && !isDecider(agent, process.env)) {
    const pr = propose({ title, role, priority, agent, meta, why: meta.why });
    if (pr) return pr;
  }
  if (meta.why) meta = { ...meta, why: undefined };
  const gate = gateTask({ title, role, meta });
  if (!gate.ok) {
    emitEvent({ type: 'task.refused', agent, status: 'blocked', msg: `Not queued: ${title}. ${gate.message}` });
    return { error: 'gated', message: gate.message };
  }
  if (['change', 'system'].includes(taskType({ title, role }))) meta = { ...meta, build: true };
  const newTask = {
    id: allocateTaskId(parseNextQueue()),
    priority: priority.toUpperCase(),
    role,
    title,
    status: 'backlog',
  };
  // 2.30 (J2): every task says whose idea it is; an agent's own mechanic waits for the dev's yes.
  // A rescue's split pieces are parts of a task already in the plan, not new mechanics: no dev "yes" needed.
  const fromRescue = meta.origin === 'rescue';
  meta = { ...meta, origin: originOf({ origin: meta.origin, agent, asked: meta.asked }), ...(fromRescue ? { rescueSplit: true } : {}) };
  // 2.58.5 (H-5): --start claims the id before the task is on the board (no window for another agent's pick).
  if (startFor) {
    const c = claim(`task:${newTask.id}`, startFor);
    if (!c.ok) return { error: 'locked', message: `${newTask.id} couldn't be claimed for ${startFor}: ${c.message || c.reason}. Nothing was queued.` };
  }
  try {
    withBoard(() => {
      const q = parseNextQueue();
      q.backlog.push(newTask);
      writeNextQueue(q);
    });
  } catch (err) {
    if (startFor) { try { release(`task:${newTask.id}`, startFor); } catch { /* not queued: the watcher frees it */ } }
    throw err;
  }
  if (meta.after?.length) setHold(newTask.id, { after: meta.after });
  if (meta.origin === 'agent-proposed' && !fromRescue && isMechanic(title, meta)) {
    setHold(newTask.id, { needsYes: { by: agent, at: new Date().toISOString() } });
    newTask.needsYes = true;
  }
  emitEvent({
    type: 'task.added',
    agent,
    task: newTask.id,
    msg: `Queued ${newTask.id} [${newTask.priority}] (${newTask.role}): ${newTask.title}`,
    meta,
  });
  // 2.30d (#5): a builder task bigger than size 3 gets a linked planner task to split it, and waits for it.
  let split = null;
  if (role === 'builder' && Number(meta.size) > SIZE_CAP && !meta.splitOf) {
    split = addTask({ title: `Split ${newTask.id} into builder tasks of size ${SIZE_CAP} or less: ${title}`.slice(0, 200), role: 'planner', priority: newTask.priority, agent, meta: { splitOf: newTask.id, infra: true, origin: meta.origin === 'dev-asked' ? 'dev' : undefined, asked: meta.asked, promoted: true } });
    if (split?.id) {
      setHold(newTask.id, { after: [...new Set([...(readHolds()[newTask.id]?.after || []), split.id])] }, { by: agent, msg: `${newTask.id} (size ${meta.size}) waits for its split ${split.id}` });
      emitEvent({ type: 'task.split_needed', agent, task: newTask.id, to: 'planner', msg: `${newTask.id} is size ${meta.size} (builder cap ${SIZE_CAP}): ${split.id} splits it`, meta: { split: split.id, size: meta.size } });
    }
  }
  // 2.30d: up to 3 cheat sheet tricks are matched and pre-approved when the task is added (logged).
  let tricks = null;
  if (process.env.STUDIO_AUTO_TRICKS !== '0') {
    try {
      const r = attachTricks(newTask.id, { title, tags: [role, meta.type, meta.part, meta.track].filter(Boolean), by: agent, max: meta.tricks ?? null });
      tricks = r.tricks?.length ? r.tricks.map((t) => t.id || t.text.slice(0, 40)) : null;
    } catch {
      // the cheat sheet is a help, never a blocker
    }
  }
  if (meta.idea) {
    const idea = readIdea(meta.idea);
    writeIdea({ ...idea, stage: 'scheduled', tasks: [...new Set([...(idea.tasks || []), newTask.id])], history: [...(idea.history || []), { stage: 'scheduled', at: new Date().toISOString(), by: agent, note: newTask.id }] });
  }
  const extra = { ...(split?.id ? { split: split.id } : {}), ...(tricks ? { tricks } : {}) };
  return gate.warnings.length ? { ...newTask, ...extra, warnings: gate.warnings } : { ...newTask, ...extra };
}

/** Take a waiting task off the queue (2.30, J11). Work in progress is handed back first. The why is kept. */
export function dropTask(id, { by = actor(), why } = {}) {
  if (typeof why !== 'string' || !why.trim()) return { ok: false, message: 'Say why it is dropped: --why "…" (kept in the event log and the task\'s notes).' };
  let t = null;
  const refused = withBoard(() => {
    const q = parseNextQueue();
    if (q.inProgress.some((x) => x.id === id)) return { ok: false, message: `${id} is in progress. Pause it first (npm run task -- pause ${id} --note "…"), then drop it.` };
    const i = q.backlog.findIndex((x) => x.id === id);
    if (i === -1) return { ok: false, message: `${id} isn't waiting in the queue.` };
    [t] = q.backlog.splice(i, 1);
    writeNextQueue(q);
    return null;
  });
  if (refused) return refused;
  setHold(id, { needsYes: null, parked: null, after: null });
  fs.mkdirSync(HANDOFF_DIR, { recursive: true });
  fs.appendFileSync(handoffFile(id), `\n## ${new Date().toISOString()} · ${by} (dropped)\n${why}\nTitle was: ${t.title}\n`);
  emitEvent({ type: 'task.dropped', agent: by, task: id, msg: `${by} dropped ${id} (${t.title}): ${why}`, meta: { task: t } });
  return { ok: true, message: `${id} is off the queue. Its title and why are in the event log; re-add it with task add if needed.` };
}

/** Move a waiting task: --to top|bottom|<position from 1>, or --before <T-ID> (2.30, J11). */
export function reorderTask(id, { to, before, by = actor() } = {}) {
  let q = null;
  let at;
  const refused = withBoard(() => {
    q = parseNextQueue();
    const i = q.backlog.findIndex((t) => t.id === id);
    if (i === -1) return { ok: false, message: `${id} isn't waiting in the queue (only waiting tasks move).` };
    const [t] = q.backlog.splice(i, 1);
    if (typeof before === 'string') at = q.backlog.findIndex((x) => x.id === before);
    else if (to === 'top') at = 0;
    else if (to === 'bottom') at = q.backlog.length;
    else if (Number(to) >= 1) at = Math.min(q.backlog.length, Number(to) - 1);
    if (at === undefined || at < 0) return { ok: false, message: 'Usage: npm run task -- reorder <TASK_ID> --to top|bottom|<position> | --before <TASK_ID> --by <name>' };
    q.backlog.splice(at, 0, t);
    writeNextQueue(q);
    return null;
  });
  if (refused) return refused;
  emitEvent({ type: 'task.reordered', agent: by, task: id, msg: `${by} moved ${id} to position ${at + 1} of ${q.backlog.length}` });
  return { ok: true, message: `${id} is now number ${at + 1} of ${q.backlog.length} waiting.` };
}

/**
 * 2.30q (#8): parse and log self-reported usage. spec: "<model>:<in>/<out>[,<model>:<in>/<out>]" (k/M suffixes ok).
 * One usage.reported event per model, provider "self-report", tracked false.
 */
export function parseUsage(spec) {
  const num = (x) => { const m = String(x).trim().match(/^(\d+(?:\.\d+)?)([kKmM]?)$/); return m ? Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1)) : NaN; };
  const out = [];
  for (const part of String(spec ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(.+):([^:/]+)\/([^:/]+)$/);
    if (!m || !Number.isFinite(num(m[2])) || !Number.isFinite(num(m[3]))) return { error: `--usage wants <model>:<in>/<out> (e.g. grok-4:180k/12k), got "${part}". Nothing was closed.` };
    out.push({ model: m[1].trim(), tokensIn: num(m[2]), tokensOut: num(m[3]) });
  }
  return out.length ? { list: out } : { error: '--usage wants <model>:<in>/<out> (e.g. grok-4:180k/12k). Nothing was closed.' };
}
export function reportUsage(task, agent, spec) {
  const p = parseUsage(spec);
  if (p.error) return p;
  for (const u of p.list) emitEvent({ type: 'usage.reported', agent: agent || 'unknown', task, model: u.model, provider: 'self-report', tokensIn: u.tokensIn, tokensOut: u.tokensOut, msg: `${agent || 'an agent'} reported ${u.tokensIn} in / ${u.tokensOut} out on ${u.model} for ${task} (untracked: outside the harness)`, meta: { tracked: false, source: 'self' } });
  return { ok: true, list: p.list };
}

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[k] = next;
        i++;
      } else {
        flags[k] = true;
      }
    } else {
      flags._.push(a);
    }
  }
  return flags;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const flags = parseFlags(process.argv.slice(2));
  const [cmd = 'next', arg1] = flags._;
  const q = parseNextQueue();

  if (cmd === 'next') {
    const role = typeof flags.role === 'string' ? flags.role : process.env.STUDIO_ROLE || null;
    const agent = typeof flags.agent === 'string' ? flags.agent : process.env.STUDIO_LOCK_OWNER || null;
    const { task, held } = nextFor({ role, agent }, q);
    if (!task) {
      console.log(role ? `Nothing waiting for the ${role} role.` : 'No unclaimed tasks waiting.');
      process.exit(0);
    }
    if (held) console.error(`You already hold ${task.id}; finish it or hand it back first.`);
    console.log(JSON.stringify(task, null, 2));
    process.exit(0);
  }

  if (cmd === 'show') {
    const t = arg1 && showTask(arg1, q);
    if (!t) {
      console.error(arg1 ? `No task ${arg1}.` : 'Usage: npm run task -- show <TASK_ID>');
      process.exit(1);
    }
    console.log(JSON.stringify(t, null, 2));
    process.exit(0);
  }

  if (cmd === 'drain') {
    const b = await import('./busy.mjs');
    const sub = arg1 || 'status';
    if (sub === 'on' || sub === 'off') {
      const r = await b.setDrain(sub === 'on', typeof flags.by === 'string' ? flags.by : process.env.STUDIO_LOCK_OWNER || 'human', typeof flags.why === 'string' ? flags.why : '');
      emitEvent({ type: 'studio.drain', agent: r.by, to: 'producer', msg: `Drain ${sub} (${r.by})${sub === 'on' ? ': new task done landings wait; running ones finish' : ': landings resume'}` });
      const run = await b.runningDones();
      console.log(`Drain ${sub}.${sub === 'on' ? ` ${run.length} done(s) still running${run.length ? `: ${run.map((x) => x.task).join(', ')}` : ''}; npm run task -- drain wait blocks until none.` : ''}`);
      process.exit(0);
    }
    if (sub === 'wait') {
      const max = Number(flags.max || 60) * 60000; const t0 = Date.now();
      for (;;) {
        const run = await b.runningDones();
        if (!run.length) { console.log('No task done is running.'); process.exit(0); }
        if (Date.now() - t0 > max) { console.error(`Still running after ${Math.round(max / 60000)} min: ${run.map((x) => x.task).join(', ')}`); process.exit(1); }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.STUDIO_DRAIN_POLL_MS ?? 10000));
      }
    }
    const d = await b.readDrain(); const run = await b.runningDones();
    console.log(`Drain ${d.on ? `on (by ${d.by}, ${d.at})` : 'off'}; ${run.length} done(s) running${run.length ? `: ${run.map((x) => x.task).join(', ')}` : ''}.`);
    process.exit(d.on ? 3 : 0);
  }

  if (cmd === 'list') {
    // 2.30q (#8): in a launched session (STUDIO_COMPACT_OUTPUT=on) or with --mine, only the tasks that matter to
    // this agent: what it holds, in progress, and the next few for its role; --all prints the whole board.
    if (!flags.all && (flags.mine || /^(on|1|true|yes)$/i.test(process.env.STUDIO_COMPACT_OUTPUT || ''))) {
      const role = typeof flags.role === 'string' ? flags.role : process.env.STUDIO_ROLE || null;
      const n = Number(flags.limit || 8);
      const slim = (t) => ({ id: t.id, title: t.title, role: t.role, priority: t.priority });
      console.log(JSON.stringify({ inProgress: q.inProgress.map(slim), backlog: q.backlog.filter((t) => !role || t.role === role || !t.role).slice(0, n).map(slim), backlogTotal: q.backlog.length, doneTotal: q.done.length, note: 'trimmed: --all for the whole board, task show <ID> for one task' }, null, 2));
      process.exit(0);
    }
    console.log(JSON.stringify(q, null, 2));
    process.exit(0);
  }

  if (cmd === 'stop') {
    const s = setStop(typeof flags.by === 'string' ? flags.by : 'human', typeof flags.reason === 'string' ? flags.reason : '');
    // In a child process: agent.mjs imports this module, so importing it here, while this module is still
    // running as the command, never settles (2.24-2.26: the command stopped nothing and exited 13).
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'harness', 'agent.mjs'), 'stop-all', '--by', s.by, '--reason', s.reason || ''], { cwd: REPO_ROOT, encoding: 'utf8', env: process.env });
    const stopped = String(r.stdout || '').trim().split(/\s+/).filter(Boolean);
    console.log(`Studio stopped by ${s.by}. No task can start${stopped.length ? `; ${stopped.join(', ')} handed back their work and stopped` : ''}. Resume: npm run task -- resume --by <name>`);
    process.exit(0);
  }
  if (cmd === 'resume') {
    console.log(clearStop(typeof flags.by === 'string' ? flags.by : 'human') ? 'Studio resumed. Agents can start tasks again.' : 'The studio was not stopped.');
    process.exit(0);
  }
  if (cmd === 'trunk') {
    // 2.54.0 (PU-06): the game's trunk is red (only fix tasks start) or green again.
    const sub = flags._[1];
    if (!sub || sub === 'status') {
      const t = trunkState();
      console.log(t.red ? `Trunk red (${t.source}${t.by ? `, ${t.by}` : ''}): ${t.why}. Only fix tasks start.` : `Trunk green${t.source === 'manual' && t.by ? ` (marked by ${t.by})` : ''}. All tasks can start.`);
      process.exit(0);
    }
    const r = setTrunk(sub, { by: typeof flags.by === 'string' ? flags.by : null, why: typeof flags.why === 'string' ? flags.why : '' });
    console.log(r.ok ? (sub === 'red' ? 'Trunk marked red: only fix tasks start until it is green.' : 'Trunk marked green: all tasks can start.') : r.message);
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'start') {
    const targetId = arg1 || q.backlog[0]?.id;
    if (!targetId) {
      console.error('Usage: node harness/task.mjs start <TASK_ID> --agent <unique-name>');
      process.exit(1);
    }
    const started = startTask(targetId, whoAmI(flags), { model: typeof flags.model === 'string' ? flags.model : null, force: Boolean(flags.force) });
    if (!started) {
      console.error(`Task "${targetId}" not found.`);
      process.exit(1);
    }
    if (started.error) {
      console.error(started.error === 'locked' && started.lock?.owner && !started.message ? `Task "${targetId}" is claimed by ${started.lock.owner}. Pick another task.` : started.message || `Task "${targetId}" can't be claimed right now. Pick another task.`);
      process.exit(1);
    }
    // 2.30c (#4): short output. The brief's path and a 10-line summary; the carry-forward note (newest
    // notes, at most 3k characters) replaces re-reading the whole hand-off history.
    if (started.brief) console.error(`Your brief: ${started.brief} (read it instead of the repo)\n${startSummary(started)}`);
    if (started.carried) console.error(`The earlier agent's commits on ${started.carried} are merged into your copy.`);
    if (started.handoff) console.error(`Picking up where someone else stopped. Carry-forward note (newest, at most 3k characters; all of it in studio/handoffs/${started.id}.md):\n${carryForward(started.handoff, started.id)}`);
    const { handoff, ...rest } = started;
    console.log(JSON.stringify({ ...rest, ...(handoff ? { handoffFile: `studio/handoffs/${started.id}.md` } : {}) }, null, 2));
    process.exit(0);
  }

  if (cmd === 'pause') {
    const targetId = arg1;
    if (targetId && flags.usage !== undefined) { const u = reportUsage(targetId, whoAmI(flags), flags.usage); if (u.error) { console.error(u.error); process.exit(1); } }
    const res = targetId && pauseTask(targetId, whoAmI(flags), typeof flags.note === 'string' ? flags.note : '', { force: Boolean(flags.force) });
    if (!res) {
      if (!targetId) console.error('Usage: node harness/task.mjs pause <TASK_ID> --agent <owner> --note "where you stopped and what is left"');
      else {
        // Say why (Jed's run: a bare usage line for a task that was already back in the queue or done).
        const q = parseNextQueue();
        const where = q.backlog.some((t) => t.id === targetId) ? 'is already in the queue (not in progress), so there is nothing to hand back' : q.done.some((t) => t.id === targetId) ? 'is done; to send it back use npm run task -- reopen ' + targetId + ' --reason "…"' : 'is not on the board (studio/NEXT.md)';
        console.error(`${targetId} ${where}.`);
      }
      process.exit(1);
    }
    if (res.error) {
      console.error(res.message);
      process.exit(1);
    }
    console.log(`${res.id} is back at the top of the queue${res.waitsFor?.length ? `, held until ${res.waitsFor.join(', ')} ${res.waitsFor.length === 1 ? 'is' : 'are'} done (from your note)` : ''}. Notes: ${res.handoffFile}`);
    process.exit(0);
  }

  if (cmd === 'reopen') {
    const res = arg1 && reopenTask(arg1, typeof flags.reason === 'string' ? flags.reason : '', typeof flags.agent === 'string' ? flags.agent : PRODUCER_NAME());
    if (!res) {
      console.error('Usage: node harness/task.mjs reopen <TASK_ID> --reason "what was wrong" (the task must be done)');
      process.exit(1);
    }
    console.log(`${res.id} is back at the top of the queue. It counts as a bug against the model that closed it.`);
    process.exit(0);
  }

  if (cmd === 'done') {
    const targetId = arg1 || q.inProgress[0]?.id;
    if (!targetId) {
      console.error('Usage: node harness/task.mjs done <TASK_ID> --agent <owner> [--check] [--train] [--note "..."] [--force --reason "<10+ chars>"]');
      process.exit(1);
    }
    // 2.32.0: once the studio has an owner key (harness/approve.mjs), a forced done needs the owner's signed
    // approval for this task, and --accepted-by comes from that approval, never from a flag an agent types.
    if (flags.force || flags['accepted-by']) {
      const { forceApproved } = await import('./approve.mjs');
      const fa = forceApproved(targetId);
      if (fa && !fa.ok) {
        console.error(`${targetId} can't be forced closed without the owner's approval. Hand it back (task pause ${targetId} --note "…") and ask; the owner runs: npm run approve -- force ${targetId} --reason "…". Nothing was closed.`);
        process.exit(1);
      }
      if (fa?.ok) { flags.force = true; flags['accepted-by'] = `${fa.by} (signed approval ${fa.file})`; if (typeof flags.reason !== 'string' || flags.reason.trim().length < 10) flags.reason = fa.reason; }
    }
    // 2.30n: a forced done says why (10+ characters); "no reason given" taught the Producer nothing.
    if (flags.force && String(typeof flags.reason === 'string' ? flags.reason : '').trim().length < 10) {
      console.error(`--force needs --reason "<why the check can't pass yet>" (10+ characters). Nothing was closed.`);
      process.exit(1);
    }
    // 2.30q (#8): --usage <model>:<in>/<out> (comma-separated for several models): a builder launched outside
    // the harness reports its own tokens; the ledger shows them as untracked (self-reported).
    if (flags.usage !== undefined) { const u = reportUsage(targetId, whoAmI(flags), flags.usage); if (u.error) { console.error(u.error); process.exit(1); } }
    // 2.30q (#6): while done runs (gates, landing: often 10+ min), the task counts as busy for the
    // Director's flow pass, the stall check and the watchdog (harness/busy.mjs).
    if (flags.check) {
      const pre = completeTask(targetId, '', whoAmI(flags), { checkOnly: true, noop: typeof flags['no-op'] === 'string' ? flags['no-op'] : '' });
      if (!pre) { console.error(`Task "${targetId}" not found.`); process.exit(1); }
      console.log(pre.error ? pre.message : pre.message);
      process.exit(pre.error ? 1 : 0);
    }
    const noopFlag = typeof flags['no-op'] === 'string' ? flags['no-op'] : '';
    // 2.59.0: the merge train's lane check (harness/train.mjs runs it in the lane's own copy): one JSON line, nothing closed.
    if (flags['train-check']) {
      const pre = completeTask(targetId, '', whoAmI(flags), { trainCheck: true, noop: noopFlag });
      const res = !pre ? { ok: false, error: 'not-found', message: `Task "${targetId}" not found.` } : pre.error ? { ok: false, error: pre.error, message: pre.message } : { ok: true, ...pre };
      console.log(JSON.stringify({ train: 'check', ...res }));
      process.exit(res.ok ? 0 : 1);
    }
    // 2.59.0: --train: check the lane now and queue it for the next merge train (npm run task -- train lands it).
    if (flags.train) {
      if (flags.force) { console.error('--train and --force don\'t go together: a forced done never goes through the merge train. Nothing was queued.'); process.exit(1); }
      const pre = completeTask(targetId, '', whoAmI(flags), { trainCheck: true, noop: noopFlag });
      if (!pre) { console.error(`Task "${targetId}" not found.`); process.exit(1); }
      if (pre.error) { console.error(pre.message); process.exit(1); }
      const { enqueue } = await import('./train.mjs');
      const e = enqueue(mainRoot(), { task: pre.id, agent: whoAmI(flags), dir: REPO_ROOT, branch: pre.branch, head: pre.head, all: pre.all, note: typeof flags.note === 'string' ? flags.note : '' });
      emitEvent({ type: 'task.train.queued', agent: whoAmI(flags), task: pre.id, to: 'producer', msg: `${pre.id} is checked and waits for the next merge train (${pre.branch} at ${String(pre.head).slice(0, 8)})`, meta: { head: pre.head, branch: pre.branch } });
      console.log(`${pre.id} is checked and queued for the next merge train (${e.branch} at ${String(e.head).slice(0, 8)}). npm run task -- train lands it (one full verify for every lane in the train); until then it stays in progress.`);
      process.exit(0);
    }
    const busyMod = await import('./busy.mjs');
    // 2.30q: drain on: a new done waits here (before its marker, so drain wait doesn't wait for it).
    { const w = await busyMod.waitForDrain(); if (!w.ok) { console.error(w.message); process.exit(1); } }
    await busyMod.markDoneRunning(targetId, whoAmI(flags)).catch(() => {});
    // 2.34.0: when a done started, so the health report can time each done (the Marina notes asked for it).
    emitEvent({ type: 'task.done.start', agent: whoAmI(flags), task: targetId, msg: `${targetId}: task done started`, meta: { at: Date.now() } });
    let done;
    try {
      // 2.59.0: in a lane copy with commits to land, task done is a one-lane merge train (harness/train.mjs): the same
      // checks, then main moves only after a green full verify of exactly the tree it ends at (the lane's own verify of
      // that tree counts). STUDIO_TRAIN=off, --force, or no commits of its own: the old path (deliver).
      const { trainOn } = await import('./train.mjs');
      let laneBranch = '';
      try { laneBranch = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim(); } catch {}
      const viaTrain = inLaneCopy() && trainOn() && !flags.force && !flags['accepted-by'] && laneBranch && unmerged(laneBranch) > 0;
      if (viaTrain) {
        const pre = completeTask(targetId, '', whoAmI(flags), { trainCheck: true, noop: noopFlag });
        if (!pre || pre.error) done = pre;
        else {
          const { runTrain } = await import('./train.mjs');
          const r = await runTrain({ root: mainRoot(), lanes: [{ task: pre.id, agent: whoAmI(flags), dir: REPO_ROOT, branch: pre.branch, head: pre.head, all: pre.all, prechecked: true, note: typeof flags.note === 'string' ? flags.note : '' }], oneLane: true, by: whoAmI(flags) || 'task-done', waitMs: Number(process.env.STUDIO_TRAIN_WAIT_MIN ?? 120) * 60000, deps: trainDeps(busyMod, { forDone: true }) });
          if (r.landed.includes(pre.id) && !r.unclosed?.length) done = r.closed?.[0] || { id: pre.id, status: 'done' };
          else {
            const why = r.unclosed?.[0]?.why || r.dropped[0]?.why || r.deferred[0]?.why || (r.landed.includes(pre.id) ? 'it landed but stays open: its copy gained commits after the check (they land with the next task done)' : r.message);
            emitEvent({ type: 'task.not_done', agent: whoAmI(flags), task: pre.id, status: 'blocked', msg: `${pre.id} not done yet: ${String(why).split('\n')[0].slice(0, 300)}` });
            done = { error: 'not-delivered', message: `${pre.id} is not done: ${why}` };
          }
        }
      } else {
        done = completeTask(targetId, flags.note || '', whoAmI(flags), { force: Boolean(flags.force), reason: typeof flags.reason === 'string' ? flags.reason : '', acceptedBy: typeof flags['accepted-by'] === 'string' ? flags['accepted-by'] : '', noop: noopFlag });
      }
    } finally {
      await busyMod.clearDoneRunning(targetId).catch(() => {});
    }
    if (!done) {
      console.error(`Task "${targetId}" not found.`);
      process.exit(1);
    }
    if (done.error) {
      console.error(done.message);
      process.exit(1);
    }
    if (done.forced) console.error(done.followUp ? `Forced past the ${done.check.type} check. The Producer has ${done.followUp} to run it. (With --reason "..." --accepted-by <person>, a person's acceptance is logged instead.)` : `Forced past the ${done.check.type} check, accepted by ${done.acceptedBy}; logged for the run report.`);
    console.log(JSON.stringify(done, null, 2));
    process.exit(0);
  }

  // 2.59.0: the merge train (harness/train.mjs): land the queued lanes on one full verify.
  if (cmd === 'train') {
    const tr = await import('./train.mjs');
    if (arg1 === 'status' || flags.status) {
      const qd = tr.readQueue(mainRoot());
      console.log(qd.length ? `${qd.length} lane(s) wait for the next train:\n${qd.map((e) => `  ${e.task}  ${e.agent}  ${e.branch} at ${String(e.head).slice(0, 8)} (queued ${String(e.at).slice(0, 16)})`).join('\n')}` : 'No lane waits for a train (task done <ID> --train queues one).');
      process.exit(0);
    }
    if (arg1 && arg1 !== 'run') { console.error('Usage: npm run task -- train [--max N] [--dry-run] [--by <name>] [--wait <min>] | train status'); process.exit(1); }
    const busyMod = await import('./busy.mjs');
    const by = typeof flags.by === 'string' ? flags.by : whoAmI(flags) || process.env.STUDIO_LOCK_OWNER || 'human';
    const r = await tr.runTrain({ root: mainRoot(), max: flags.max ? Number(flags.max) : 0, dryRun: Boolean(flags['dry-run']), by, waitMs: Number(flags.wait || 0) * 60000, deps: trainDeps(busyMod) });
    (r.ok ? console.log : console.error)(r.message);
    console.log(JSON.stringify({ train: r.id, landed: r.landed, dropped: r.dropped, deferred: r.deferred, verifies: r.verifies ?? 0, reused: r.reused ?? 0, ...(r.redMain ? { redMain: true } : {}), ...(r.busy ? { busy: r.busy } : {}) }, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  // Holds: dependencies, parking, blocks and lanes (harness/task-hold.mjs).
  if (cmd === 'unblock') {
    if (!arg1) {
      console.error('Usage: npm run task -- unblock <TASK_ID> --by <name> [--note "what was fixed"]');
      process.exit(1);
    }
    const r = unblockTask(arg1, typeof flags.by === 'string' ? flags.by : process.env.STUDIO_LOCK_OWNER || 'human', typeof flags.note === 'string' ? flags.note : '');
    (r.ok ? console.log : console.error)(r.message);
    process.exit(r.ok ? 0 : 1);
  }
  // 2.30l: which game the studio builds (lanes and file guesses read it); the gates' cartridge is unchanged.
  if (cmd === 'game') {
    const { activeGame, setActiveGame } = await import('./cartridge.mjs');
    const name = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
    if (name) {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
        console.error('Usage: npm run task -- game [<name>] --by <name>');
        process.exit(1);
      }
      setActiveGame(name);
      emitEvent({ type: 'game.set', agent: actor(), msg: `The studio's game is ${name}` });
    }
    const g = activeGame();
    const f = gameFolders();
    console.log(`Game: ${g.name || 'none'} (from ${g.from || 'nothing'}); renderer ${f.renderer || 'none'}, sim ${f.sim || 'none'}.`);
    process.exit(0);
  }
  if (['block', 'park', 'unpark', 'lane', 'holds'].includes(cmd)) {
    const by = typeof flags.by === 'string' ? flags.by : actor();
    const all = [...q.inProgress, ...q.backlog, ...q.done];
    if (cmd === 'holds') {
      const h = readHolds();
      const rows = Object.entries(h).map(([id, x]) => `${id}: ${[x.parked ? `parked (${x.parked.by}: ${x.parked.why || ''})` : '', x.after?.length ? `after ${x.after.join(', ')}` : '', x.until ? `until ${x.until}` : '', x.cooldownUntil ? `cooldown until ${x.cooldownUntil.slice(11, 16)}` : '', 'lane' in x ? `lane ${x.lane || 'whole game'}` : ''].filter(Boolean).join('; ')}`);
      console.log(rows.length ? rows.join('\n') : 'No holds: every waiting task can start.');
      process.exit(0);
    }
    if (!arg1 || !all.some((t) => t.id === arg1)) {
      console.error(`Usage: npm run task -- ${cmd} <TASK_ID> ${cmd === 'block' ? '--until <T-ID|ISO time> ' : cmd === 'lane' ? '<folder|none> ' : ''}--by <name>${cmd === 'park' ? ' --why "…" [--until T-ID|phase:N|time]' : ''}`);
      process.exit(1);
    }
    if (cmd === 'park') {
      if (typeof flags.why !== 'string') {
        console.error('Say why it is parked: --why "…" (the Producer and Director read it).');
        process.exit(1);
      }
      const until = typeof flags.until === 'string' ? flags.until : null;
      if (until && !/^[A-Z]+-\d+$/.test(until) && !/^phase:\d+$/i.test(until) && !Number.isFinite(Date.parse(until))) {
        console.error('--until takes a task id (T-011), phase:2 (when Phase 2 opens) or a time (2026-10-22T09:00).');
        process.exit(1);
      }
      const stamp = until && Number.isFinite(Date.parse(until)) && !/^[A-Z]+-\d+$/.test(until) && !/^phase:/i.test(until) ? new Date(Date.parse(until)).toISOString() : until;
      setHold(arg1, { parked: { by, why: flags.why, at: new Date().toISOString(), ...(stamp ? { until: stamp } : {}) } }, { by, msg: `${by} parked ${arg1}${stamp ? ` until ${stamp}` : ''}: ${flags.why}` });
      console.log(stamp ? `${arg1} is parked until ${stamp}; then it can start on its own.` : `${arg1} is parked: it won't start until someone runs npm run task -- unpark ${arg1} --by <name> (or park it with --until T-ID|phase:N|time).`);
    } else if (cmd === 'unpark') {
      setHold(arg1, { parked: null }, { by, msg: `${by} unparked ${arg1}` });
      console.log(`${arg1} can start again.`);
    } else if (cmd === 'block') {
      const u = typeof flags.until === 'string' ? flags.until : '';
      if (/^[A-Z]+-\d+$/.test(u)) setHold(arg1, { after: [...new Set([...(readHolds()[arg1]?.after || []), u])], why: typeof flags.why === 'string' ? flags.why : undefined }, { by, msg: `${by}: ${arg1} waits for ${u}` });
      else if (Number.isFinite(Date.parse(u))) setHold(arg1, { until: new Date(Date.parse(u)).toISOString(), why: typeof flags.why === 'string' ? flags.why : undefined }, { by, msg: `${by} blocked ${arg1} until ${u}` });
      else {
        console.error('--until takes a task id (T-011) or a time (2026-10-22T09:00).');
        process.exit(1);
      }
      console.log(`${arg1} is blocked until ${u}.`);
    } else {
      const folder = flags._[2];
      if (!folder) {
        console.error(`Usage: npm run task -- lane ${arg1} <folder|none> --by <name>`);
        process.exit(1);
      }
      const lane = folder === 'none' ? null : laneList(folder).join(',') || null;
      if (lane && /^(harness|hub|qa|scripts)(\/|$)/.test(lane) && fs.existsSync(path.join(STUDIO_STATE_DIR, 'harness-frozen'))) {
        console.error(`${lane} is harness code, and this clone's harness is frozen.`);
        process.exit(1);
      }
      updateHolds((all2) => { all2[arg1] = { ...(all2[arg1] || {}), lane }; });
      emitEvent({ type: 'task.lane', agent: by, task: arg1, msg: `${by}: ${arg1} works in ${lane || 'the whole game'}` });
      console.log(`${arg1} works in ${lane || 'the whole game (no other builder runs beside it)'}.`);
    }
    process.exit(0);
  }

  // 2.30 (J2): the dev's yes lets an agent-proposed mechanic start.
  if (cmd === 'yes') {
    const t = [...q.inProgress, ...q.backlog].find((x) => x.id === arg1);
    if (!t) {
      console.error('Usage: npm run task -- yes <TASK_ID> --by <dev> [--quote "…" --source "…" when relayed]');
      process.exit(1);
    }
    const who = devSays(typeof flags.by === 'string' ? flags.by : null, { quote: flags.quote || '', source: flags.source || '' });
    if (!who.ok) {
      console.error(who.message);
      process.exit(1);
    }
    setHold(arg1, { needsYes: null }, { by: flags.by, msg: `${flags.by} said yes to ${arg1}${who.relayedBy ? ` (relayed by ${who.relayedBy}: "${flags.quote}", ${flags.source})` : ''}` });
    emitEvent({ type: 'task.dev_yes', agent: flags.by, task: arg1, msg: `${flags.by} said yes to ${arg1}: ${t.title}`, meta: who.relayedBy ? { relayedBy: who.relayedBy, quote: flags.quote, source: flags.source } : {} });
    console.log(`${arg1} can start.`);
    process.exit(0);
  }
  // 2.30 (J11): steer the queue without hand-editing NEXT.md.
  if (cmd === 'drop' || cmd === 'reorder') {
    const by = typeof flags.by === 'string' ? flags.by : actor();
    const r = cmd === 'drop' ? dropTask(arg1, { by, why: flags.why }) : reorderTask(arg1, { to: flags.to, before: flags.before, by });
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(r.message);
    process.exit(0);
  }

  // 2.30d (#9): close or reopen a forced "done (pending)" task: a person, or a reviewer from another model family.
  if (cmd === 'review' || cmd === 'pending') {
    const { closePending, listPending } = await import('./pending-review.mjs');
    if (cmd === 'pending' || !arg1) {
      const list = listPending();
      console.log(list.length ? list.map((p) => `${p.task} done (pending) — forced by ${p.by}${p.model ? ` on ${p.model}` : ''}: ${p.reason} [missing: ${p.missing}]`).join('\n') : 'No forced tasks waiting for review.');
      process.exit(0);
    }
    const r = closePending(arg1, { by: typeof flags.by === 'string' ? flags.by : null, model: typeof flags.model === 'string' ? flags.model : null, verdict: flags.reopen ? 'reopen' : flags.close ? 'close' : null, note: typeof flags.note === 'string' ? flags.note : '' });
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    if (r.verdict === 'reopen') reopenTask(arg1, `Forced done reviewed and reopened by ${r.by}: ${r.note || r.reason}`, r.by);
    console.log(r.message);
    process.exit(0);
  }
  // 2.30d (#6): the proposed list, and the Producer promoting it in batches.
  if (cmd === 'proposed' || cmd === 'promote') {
    const { listProposed, promote } = await import('./proposed.mjs');
    if (cmd === 'proposed') {
      const list = listProposed();
      console.log(list.length ? list.map((p) => `${p.id} [${p.priority}] (${p.role}) ${p.title} — ${p.agent}: ${p.why}`).join('\n') : 'Nothing proposed.');
      process.exit(0);
    }
    const ids = flags.all ? 'all' : flags._.slice(1).join(',').split(/[,\s]+/).filter(Boolean);
    const r = promote(ids, { by: typeof flags.by === 'string' ? flags.by : actor(), drop: flags.drop ? String(flags.drop).split(',') : [], addTask });
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(r.message);
    process.exit(0);
  }

  if (cmd === 'add') {
    // --start/--claim are switches: a title word the parser took as their value is part of the title.
    const title = [...flags._.slice(1), ...['start', 'claim'].filter((k) => typeof flags[k] === 'string').map((k) => flags[k])].join(' ');
    if (!title) {
      console.error('Usage: node harness/task.mjs add "<Task Title>" [--role builder] [--priority P1] [--type bug|chore|study|balance|fun|playtest|review|docs|idea] [--size 1-5] [--caused-by T-012] [--phase 1|2|3 --serves pillar:<name>|layer:<id>] [--idea I-001] [--part sim|renderer|both] [--lane <folder>] [--paths a.js,b.js] [--after T-011] [--track web|engine:<name>] [--prototype | --infra] [--origin dev|agent] [--asked "<the dev\'s words>"] [--mechanic] [--tricks 1-6] [--start --agent <you>]');
      process.exit(1);
    }
    // --type bug|chore|study|balance|fun|playtest|review|docs puts the matching prefix on the title.
    const type = typeof flags.type === 'string' ? flags.type.toLowerCase() : '';
    if (type && !['bug', 'chore', 'study', 'balance', 'fun', 'playtest', 'review', 'docs', 'idea', 'system'].includes(type)) {
      console.error(`Unknown --type "${flags.type}". Use bug, chore, study, balance, fun, playtest, review, docs, idea or system.`);
      process.exit(1);
    }
    const prefix = type && !title.toLowerCase().startsWith(type) ? `${type[0].toUpperCase()}${type.slice(1)}: ` : '';
    const size = flags.size !== undefined ? Number(flags.size) : null;
    if (size !== null && !(size >= 1 && size <= 5)) {
      console.error('--size is how hard the task is, 1 (trivial) to 5 (big).');
      process.exit(1);
    }
    const causedBy = typeof flags['caused-by'] === 'string' ? flags['caused-by'] : null;
    if (flags.part !== undefined && !['sim', 'renderer', 'both'].includes(flags.part)) {
      console.error('--part is which part of the game it touches: sim (rules and state), renderer (what is drawn and shown) or both. Renderer work closes with screenshots someone else checked; renderer bugs with a browser regression.');
      process.exit(1);
    }
    // 2.58.5 (H-5): --start queues it and claims it for --agent in one step.
    const startFor = flags.start || flags.claim ? whoAmI(flags) : null;
    if ((flags.start || flags.claim) && !startFor) {
      console.error('--start needs --agent <unique-name> (or STUDIO_LOCK_OWNER): the task is claimed for that agent as it is queued.');
      process.exit(1);
    }
    const created = addTask({
      title: `${prefix}${title}`,
      role: flags.role || 'builder',
      priority: flags.priority || 'P1',
      agent: typeof flags.agent === 'string' ? flags.agent : actor(),
      ...(startFor ? { startFor, model: typeof flags.model === 'string' ? flags.model : null } : {}),
      meta: {
        ...(size ? { size } : {}),
        ...(flags.tricks !== undefined ? { tricks: Math.max(1, Math.min(6, Math.round(Number(flags.tricks)) || 3)) } : {}),
        ...(causedBy ? { causedBy } : {}),
        ...(flags.phase !== undefined ? { phase: Number(flags.phase) } : {}),
        ...(typeof flags.serves === 'string' ? { serves: flags.serves } : {}),
        ...(typeof flags.idea === 'string' ? { idea: flags.idea } : {}),
        ...(typeof flags.part === 'string' ? { part: flags.part } : {}),
        ...(typeof flags.lane === 'string' ? { lane: flags.lane.replace(/\/+$/, '') } : {}),
        ...(typeof flags.paths === 'string' && laneList(flags.paths).length ? { paths: laneList(flags.paths) } : {}),
        ...(typeof flags.track === 'string' ? { track: flags.track } : {}),
        ...(typeof flags.after === 'string' ? { after: flags.after.split(/[,\s]+/).filter((x) => /^[A-Z]+-\d+$/.test(x)) } : {}),
        ...(flags.prototype ? { prototype: true } : {}),
        ...(flags.infra ? { infra: true } : {}),
        ...(typeof flags['not-layer'] === 'string' ? { notLayer: flags['not-layer'] } : {}),
        ...(typeof flags.origin === 'string' ? { origin: flags.origin } : {}),
        ...(typeof flags.asked === 'string' ? { asked: flags.asked } : {}),
        ...(flags.mechanic ? { mechanic: true } : {}),
        ...(type ? { type } : {}),
        ...(typeof flags.why === 'string' ? { why: flags.why } : {}),
        ...(typeof flags['split-of'] === 'string' ? { splitOf: flags['split-of'] } : {}),
      },
    });
    if (created.proposed) {
      console.log(`Proposed ${created.id} (not on the live queue yet): ${created.message}`);
      process.exit(0);
    }
    if (created.error) {
      console.error(`Not queued. ${created.message}`);
      process.exit(1);
    }
    for (const w of created.warnings || []) console.error(`note: ${w}`);
    if (startFor && created.started) console.error(`Started ${created.id} for ${startFor}${created.brief ? `. Your brief: ${created.brief}` : ''}`);
    if (startFor && created.started === false) console.error(`note: queued but not started for ${startFor}: ${created.startError}`);
    if (created.split) console.error(`note: size ${size} is over the builder cap of ${SIZE_CAP}; ${created.split} (planner) splits it first.`);
    if (created.tricks) console.error(`note: pre-approved cheat sheet tricks: ${created.tricks.join(', ')}`);
    console.log(JSON.stringify(created, null, 2));
    process.exit(0);
  }

  console.log('Usage: node harness/task.mjs [next | list | start <ID> [--model m] | pause <ID> --note "..." | done <ID> | add "<Title>" [--after T-x] | park|unpark|unblock <ID> | block <ID> --until <T-ID|time> | lane <ID> <folder|a.js,b.js|none> | holds | yes <ID> --by <dev> | drop <ID> --why "…" | reorder <ID> --to top|bottom|<n> | --before <ID>]');
}
