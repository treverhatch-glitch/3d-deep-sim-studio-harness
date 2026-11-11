#!/usr/bin/env node
/**
 * harness/task.mjs — Markdown Task Queue Manager (`studio/NEXT.md`)
 */

import fs from 'node:fs';
import { postAsk } from './ask-post.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actor, emitEvent, REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents } from './event.mjs';
import { claim, release, status as lockStatus, listLocks, SHARED_OWNERS } from './lock.mjs';
import { ensureResearchTemplate, researchRel } from './research.mjs';
import { checkDone, taskType, joinWaveIfGameplay, taskBase, lastFullRecord, taskChanges, startedAt, typeOf, titleType, skipGameChecks } from './done-check.mjs';
import { judgeClaims, recordClaimVerdict, claimLines } from './said-vs-did.mjs';
import { validateAnchorIds, readAnchors } from './anchors.mjs';
import { splitEolOnly, eolNote, splitPhantom, phantomNote } from './eol-only.mjs';
import { isGameCode } from '../scripts/check-function-size.mjs';
import { summarize as summarizeVerdict, renderDecision } from './verdict-split.mjs';
import { visualGate } from './visual-capture.mjs';
import { readBible, crossedLayersIn, readIdea, writeIdea, latestReview, LAYERS } from './bible.mjs';
import { writeFocus } from './focus.mjs';
import { causeOf, isAccepted } from './cause-store.mjs';
import { inferLaneAtAdd, laneRequired, holdReason, setHold, readHolds, laneList, gameFolders, updateHolds, holdRefusal, parkRank, unparkRefusal, laneRefusal, laneEntries } from './task-hold.mjs';
import { stopIfOverBudget } from './task-budget.mjs';
import { applyRescue, rescueOf, closeRescuesFor } from './rescue.mjs';
import { savePatch } from './wip.mjs';
import { laneConfigWarning } from './lane-studio.mjs';
import { overlapCheck } from './task-overlap.mjs';
import { engineTask as engineTaskOf, engineRepo, engineTarget, engineOfTrack, engineTrainVerdict as engineTrainVerdictOf, readTrack, defaultEngineTrack } from './engine-tracks.mjs';
import { nativeEngine, webCodeNamed } from './native.mjs';
/** Task types that are studio work, not a change to the game (they never get the native engine's track by default). */
const NON_CHANGE_TYPES = new Set(['chore', 'study', 'research', 'review', 'docs', 'idea', 'playtest']);
import { misplacedTrailers, misplacedTrailerText } from './trailers.mjs';
import { inferLaneFromText } from './lane-infer.mjs';
import { inLaneCopy, catchUp, carryTaskBranch, carryTaskBranchEx, deliver, laneDiff, mainRoot, laneDirty, unmerged, landFastForward, mainBranch as mainBranchOf, taskOnBoard } from './worktree.mjs';
import { laneConfigBefore } from './config-proposal.mjs';
import { recordPass, clearPass, withLandLock, judgeVerifyReuse } from './merge-lane.mjs';
import { recordTrust } from './gate-trust.mjs';
import { isEngineChurn, engineGates, relatedTestsOn } from './game-gates.mjs';
import { isMechanic, originOf, devSays } from './intent.mjs';
import { checkBreaker, isFailureNote, reasonKey, unblockTask } from './breaker.mjs';
import { parkIfOwnerOnly, ownerStepOfChecks, ownerStepForHandBack } from './owner-only.mjs';
import { canaryEnd, isCanary, recordCanary, modelFor } from './canary.mjs';
import { claimActive, claimOwner } from './busy.mjs';
import { startSummary, carryForward } from './carry.mjs';
import { openPending, readPending } from './pending-review.mjs';
import { isDecider, propose, SIZE_CAP } from './proposed.mjs';
import { attachTricks } from './cheatsheet.mjs';
import { readBaseline, recordBaseline, setTrunk, trunkState, judgeRed } from './baseline.mjs';
import { recordAlive } from './proc-identity.mjs';
import { withFileLock, writeAtomic, readJson } from './fsafe.mjs';
import { factsFor, splitFacts, recordGateRefusal } from './handback-facts.mjs';
import { assetGateApplies, assetGateText, fileAssetHandoff } from './asset-gate.mjs';
import { reviewsAtDone } from './asset-review.mjs';
import { checkStamped, stampWrite, watchCommand } from './workaround.mjs';
import { gateEnv } from './gate-env.mjs';
import { shrinkAtDone } from './ratchet.mjs';
import { capRefusal } from './round-cap.mjs';
import { eligibility, recordAttempt, clearAttempts, sameBlocker, startRefusalWords } from './attempts.mjs';
import { pinRefusal } from './task-pin.mjs';
import { TASK_LINE_RE } from './board-line.mjs';

export const NEXT_FILE = path.join(REPO_ROOT, 'studio', 'NEXT.md');
// 2.30c (#13): finished tasks live in studio/DONE.md, so NEXT.md (read by every agent) holds only open work.
export const DONE_FILE = path.join(REPO_ROOT, 'studio', 'DONE.md');
export const CURRENT_TASK_FILE = path.join(REPO_ROOT, 'studio', 'CURRENT_TASK.md');

// 2.58.0 (P-057): the line the harness writes, plus the drifts people make by hand, read as the same task and put back
// in shape by the next write: an ASCII "-" (or "--", "–") for the "—", a role without backticks, "[X]", a "*" bullet,
// a lower-case priority. Anything else that isn't the harness's own heading or note is kept (see UNREADABLE below).
// 2.84: the pattern lives in harness/board-line.mjs, so a reader that only lists ids (the overseer's sheet) uses the same one.
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
/** 2.68.0 (m): the disk-low warning on `task start` (harness/machine.mjs diskWarning; '' when the disk is fine). */
async function startDiskWarning() {
  try { const w = await (await import('./machine.mjs')).diskWarning(); if (w) console.error(`Warning: ${w}.`); } catch {}
}

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
  // 2.71.0 (z): a board file changed by something other than the harness since its last write (a hand edit) is a
  // detected workaround (harness/workaround.mjs); every write is stamped first. Under the board lock; never a refusal.
  try { checkStamped(NEXT_FILE, { text: wasNext }); checkStamped(DONE_FILE, { text: wasDone }); } catch { /* evidence only */ }
  const put = (file, text) => { try { stampWrite(file, text); } catch { /* the write goes ahead unstamped */ } writeAtomic(file, text); };
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
    if (first !== wasDone) put(DONE_FILE, first);
    wasDone = first;
  }
  // 2.57.0 (PU-16): replaced whole (temp file + rename): an agent reading mid-write saw half a board ("Task not found").
  put(NEXT_FILE, renderNext(tasks, kept.next));
  const doneText = renderDone(tasks.done, kept.done);
  if (wasDone !== doneText) put(DONE_FILE, doneText);
  if (moving || fs.existsSync(MOVES_FILE)) try { fs.rmSync(MOVES_FILE, { force: true }); } catch { /* stale notes only matter for a task in both files */ }
  // 2.58.0 (P-057): say once which lines were set aside (they stay in the file, under UNREADABLE).
  const fresh = [...kept.next.filter((u) => u.fresh).map((u) => ['studio/NEXT.md', u.line]), ...kept.done.filter((u) => u.fresh).map((u) => ['studio/DONE.md', u.line])];
  if (fresh.length) {
    const list = fresh.map(([f, l]) => `${f}: ${l.length > 120 ? `${l.slice(0, 117)}...` : l}`);
    console.warn(`[board] ${fresh.length} line${fresh.length === 1 ? '' : 's'} on the board ${fresh.length === 1 ? 'isn\'t a task' : 'aren\'t tasks'} the harness can read; kept under "${UNREADABLE_HEADING}" at the end of the file:\n${list.map((l) => `  ${l}`).join('\n')}`);
    try { emitEvent({ type: 'board.unreadable', agent: actor(), to: 'producer', status: 'warn', target: fresh[0][0], msg: `Kept ${fresh.length} board line(s) the harness can't read under "## UNREADABLE" (fix their format): ${list.join(' | ')}`.slice(0, 600) }); } catch { /* the warning above stands */ }
  }
}

/**
 * 2.78.1 (e): studio/CURRENT_TASK.md is imported into every Claude Code session's context by CLAUDE.md
 * (@studio/CURRENT_TASK.md), ahead of the launch prompt, and a lane copy reads the main checkout's through its studio/
 * link. Rewritten (with the time and the task) by every launched session's task start, done and pause, it made each
 * session's prompt differ before the stable marker: a prompt-cache miss for every session of every role. It is one
 * agent's checkpoint (a hand-run session's), so a launched session (STUDIO_ROLE set by the launcher) leaves it as it is.
 * STUDIO_CURRENT_TASK_FILE: auto (the default: hand-run sessions only), on (every session, as before), off (never).
 */
export function currentTaskWrites(env = process.env) {
  const v = String(env.STUDIO_CURRENT_TASK_FILE || 'auto').toLowerCase();
  if (/^(off|0|false|no|never)$/.test(v)) return false;
  if (/^(on|1|true|yes|always)$/.test(v)) return true;
  return !String(env.STUDIO_ROLE || '').trim();
}

export function syncCurrentTaskCheckpoint(activeTask, note = '') {
  if (!currentTaskWrites()) return;
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
export function setStop(by = 'owner', reason = '') {
  const s = { by, reason: String(reason || '').slice(0, 300), at: new Date().toISOString() };
  writeAtomic(STOP_FILE, `${JSON.stringify(s, null, 2)}\n`);
  emitEvent({ type: 'studio.stopped', agent: by, to: 'producer', status: 'blocked', msg: `Studio stopped by ${by}${s.reason ? `: ${s.reason}` : ''}. No new tasks start until it resumes.` });
  return s;
}
export function clearStop(by = 'owner') {
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
    // 2.81 (b1): one verdict (harness/attempts.mjs eligibility: the holds, the budget, the round cap), so next stops
    // offering what start refuses; a task whose last failed hand-back met a blocker that has not changed is offered last.
    .filter(([t]) => !lockStatus(`task:${t.id}`).locked && (!role || t.role === role || !t.role) && !eligibility(t.id, { q, agent, role: role || process.env.STUDIO_ROLE || null, events: (evs ||= readRecentEvents(20000)) }) && !liveOwner(t.id, agent, (evs ||= readRecentEvents(20000)), { waiting: true }))
    .map(([t, i]) => [t, i, (() => { try { return sameBlocker(t.id, { done: new Set((q.done || []).map((x) => x.id)) }).same ? 1 : 0; } catch { return 0; } })()])
    .sort((a, b) => a[2] - b[2] || (PRI[a[0].priority] ?? 9) - (PRI[b[0].priority] ?? 9) || a[1] - b[1]);
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
    const a = claimActive(taskId, { root: mainRoot(), orphaned: true, events: evs, asker: agent }); // 2.76.0 (B-90): never its own copy
    return a.busy && a.owner && a.owner !== agent ? a : null;
  } catch { return null; }
}

export function startTask(taskId, agent = null, { model = null, force = false } = {}) {
  if (!agent) return { error: 'owner-required', message: 'Pass --agent <unique-name> so the task lock has an owner.' };
  // 2.77.0 (n, B-92): a session the launcher started on a task works only that task (harness/task-pin.mjs); --force too.
  const pinWhy = pinRefusal(taskId, { action: 'start' });
  if (pinWhy) return { error: 'pinned', message: pinWhy };
  const stop = readStop();
  if (stop) return { error: 'stopped', message: `The studio is stopped (by ${stop.by}${stop.reason ? `: ${stop.reason}` : ''}). Don't start work: finish or hand back what you hold (task pause <ID> --note "..."), then wait. A person resumes it with: npm run task -- resume --by <name>` };
  // Dependencies, parking and a stop's cooldown (harness/task-hold.mjs). Work already in progress may continue.
  const held = holdReason(taskId, parseNextQueue(), Date.now(), undefined, process.env.STUDIO_ROLE || null);
  if (held && !force && !parseNextQueue().inProgress.some((t) => t.id === taskId)) return { error: 'held', message: startRefusalWords(taskId, { kind: 'held', why: held }) }; // 2.84: the launcher says the same words
  // 2.77.0 (P9.2): a task in progress whose lane is queued for the merge train is its lane agent's: another agent can't
  // claim it (the supervisor's or a hand-started builder's --task) until it lands or leaves the queue. --force: a person.
  if (!force) {
    let tq = null;
    try { tq = JSON.parse(fs.readFileSync(path.join(STUDIO_STATE_DIR, 'train', 'queue.json'), 'utf8')).find((e) => e?.task === taskId) || null; } catch {}
    const mine = lockStatus(`task:${taskId}`).lock?.owner === agent;
    if (tq && tq.agent && tq.agent !== agent && !mine) {
      emitEvent({ type: 'task.lock_denied', agent, task: taskId, status: 'blocked', msg: `Task ${taskId}: queued for the merge train (lane of ${tq.agent})` });
      return { error: 'queued', message: `${taskId} can't start: its lane (${tq.agent}, ${tq.branch || 'its branch'} at ${String(tq.head || '').slice(0, 8)}) is queued for the merge train${tq.released ? ` and released by ${tq.released.by}` : ''}; it lands with the next train. Pick another task (npm run task -- next); npm run task -- train leave ${taskId} --by <name> takes it out of the queue first.` };
    }
  }
  // 2.31.0: a task that used its budget (sessions, claimed minutes, tokens; harness/task-budget.mjs) is
  // parked and refused, even for a re-claim of work in progress: re-claiming is how a task loops.
  const overWhy = stopIfOverBudget(taskId, { by: 'budget' });
  if (overWhy) return { error: 'over-budget', message: `${taskId} can't start: ${overWhy}` };
  // 2.72.0 (b): handed back by the two-round cap in this agent's session: no third attempt here (harness/round-cap.mjs).
  const capWhy = force ? '' : capRefusal(taskId, agent);
  if (capWhy) { emitEvent({ type: 'task.lock_denied', agent, task: taskId, status: 'blocked', msg: `Task ${taskId}: refused by the round cap` }); return { error: 'round-cap', message: `${taskId} can't start: ${capWhy}.` }; }
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
  let mixedSkipped = null;
  if (inLaneCopy()) {
    catchUp();
    const cx = carryTaskBranchEx(target.id);
    carried = cx.carried;
    mixedSkipped = cx.mixed?.line || null;
  }
  syncCurrentTaskCheckpoint(target, `Started ${target.id} (${target.role}) — owner ${agent}`);
  const handoff = readTaskHandoff(target.id);
  // The commit the work starts from, for the size ratchet (harness/done-check.mjs sizeGrowth).
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8' }).stdout?.trim() || null;
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
  const research = researchAtStart(target);
  return { ...target, owner: agent, ...(brief ? { brief } : {}), ...(handoff ? { handoff } : {}), ...(carried ? { carried } : {}), ...(mixedSkipped ? { mixedSkipped } : {}), ...(research ? { research } : {}) };
}

/** 2.71.0 (y): a research task's write-up template, written where the task is worked (harness/research.mjs). */
function researchAtStart(target) {
  try {
    if (taskType(target) !== 'research') return null;
    const rel = ensureResearchTemplate(target);
    return rel || researchRel(target.id);
  } catch { return null; }
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
export function completeTask(taskId, note = '', agent = null, { force = false, reason = '', acceptedBy = '', noop = '', checkOnly = false, trainCheck = false, unityTrainCheck = false, claims = [] } = {}) {
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
  // 2.79.1: a "Golden-Reason:" line git doesn't read as a trailer (right under the subject, mid-body) is refused here,
  // before the train hands the lane back for "no Golden-Reason trailer" (harness/trailers.mjs; the train uses it too).
  if (!force) {
    try {
      const lane = inLaneCopy();
      const start = lane ? mainBranchOf(mainRoot()) : taskBase(target.id);
      const found = start ? misplacedTrailers(REPO_ROOT, start, 'HEAD', 'Golden-Reason') : [];
      if (found.length) {
        const why = misplacedTrailerText(found, 'Golden-Reason');
        emitEvent({ type: 'task.not_done', agent: agent || target.role, task: target.id, status: 'blocked', msg: `${target.id} not done yet: ${why}`.slice(0, 600) });
        return { error: 'trailer-misplaced', message: `${target.id} is not done: ${why}` };
      }
    } catch { /* a check that can't run never blocks */ }
  }

  // 2.77.0 (u): an engine pass whose work lives in the engine's own repo: the studio-repo checks (no code changed, the
  // game's checks) don't judge it; its done check looks at its branch there and its engine's land run is its verify.
  const extEngine = (() => { try { const r = engineTaskOf(target.id); return r && engineRepo(r.engine) ? r : null; } catch { return null; } })();

  // 2.60.1 (B-40): studio/ in a lane copy is main's: main's studio config changed while this task was worked and not
  // committed there doesn't land with the lane. Said loudly, never a refusal.
  if (inLaneCopy()) {
    try {
      const warn = laneConfigWarning(target.id, mainRoot(), startedAt(target.id));
      if (warn) { console.warn(`[done] ${warn}`); if (!checkOnly) emitEvent({ type: 'lane.studio_config', agent: agent || target.role, task: target.id, to: 'producer', status: 'warn', msg: `${target.id}: ${warn}`.slice(0, 600) }); }
    } catch { /* a note only */ }
  }

  // 2.30m: a build task must change code. T-017 in the Marina run was closed with no change at all
  // (the agent judged the existing code good enough). Zero code changes since the task started are
  // refused unless the task is marked no-op with a reason (task done <ID> --no-op "<why>").
  if (!force && !extEngine && target.role === 'builder' && ['change', 'chore', 'system', 'bug', 'fun', 'balance'].includes(taskType(target)) && process.env.STUDIO_DONE_NOOP !== 'allow') {
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
        const committed = spawnSync('git', ['diff', '--name-only', `${start}..HEAD`], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8' });
        const working = spawnSync('git', ['status', '--porcelain'], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8' });
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
  const vTrack = !force && process.env.STUDIO_VISUAL_GATE !== 'off' ? readRecentEvents(20000).filter((e) => e.type === 'task.added' && e.task === target.id).pop()?.meta?.track : null;
  const vGate = !force && process.env.STUDIO_VISUAL_GATE !== 'off' ? visualGate({ ...target, track: vTrack }) : { on: false, note: '' };
  if (vGate.note) console.warn(`[done] ${vGate.note}`); // 2.79.1 (d): no capture command here: the gate is off by itself, said once
  if (vGate.on) {
    const track = vTrack;
    const vs = summarizeVerdict(target.id, { ...target, track });
    // 2.60.1 (B-38): why it is (not) a render task, and the evidence warning for a non-render title.
    if (vs.renderBy === 'owner' || (vs.renderBy === 'evidence' && vs.renderWhy)) {
      const line = vs.renderBy === 'owner' ? vs.renderWhy : `visual proof ${vs.render ? 'needed' : 'not needed'}: ${vs.renderWhy}`;
      console.warn(`[done] ${line}`);
      if (!checkOnly && !vs.render) emitEvent({ type: 'task.visual_skipped', agent: agent || target.role, task: target.id, msg: `${target.id}: ${line}`.slice(0, 400), meta: { by: vs.renderBy } });
    }
    if (vs.warn) { console.warn(`[done] WARN ${target.id} ${vs.warn}`); if (!checkOnly) emitEvent({ type: 'task.visual_recommended', agent: agent || target.role, task: target.id, status: 'warn', msg: `${target.id} ${vs.warn}`.slice(0, 400) }); }
    if (!vs.ok) {
      emitEvent({ type: 'task.not_done', agent: agent || target.role, task: target.id, status: 'blocked', msg: `${target.id} not done yet: ${vs.why.slice(0, 200)}` });
      return { error: 'visual', verdict: vs, message: `${target.id} is not done: ${vs.why}\nChecked: ${vs.passed.join(', ') || 'nothing'}; unchecked: ${vs.unchecked.join(', ') || 'none'}.` };
    }
  }

  const check = checkDone(target, undefined, { noop: noop && String(noop).trim().length >= 10 });
  // 2.81 (b2): said-vs-did (harness/said-vs-did.mjs), only when the builder makes a claim (--claim "<command> => <last
  // line>"; none: judged as before). The note's file claims are diffed against the task's commits and edits; the command
  // is re-run on the closing path only (--check and the train's lane check skip the re-run: the train's verify follows).
  // A mismatch is review.verdict {claim-mismatch} and the label `claim`.
  if (!force && claims.length) {
    let judged = null;
    try { judged = judgeClaims(target.id, { claims, note, base: taskBase(target.id) || null, rerun: !checkOnly && !trainCheck && !unityTrainCheck && !/^(off|0|false|no)$/i.test(String(process.env.STUDIO_CLAIMS || '')) }); } catch { judged = null; }
    if (judged && !judged.ok) {
      if (!checkOnly) recordClaimVerdict(target.id, judged, { agent: agent || target.role });
      emitEvent({ type: 'task.not_done', agent: agent || target.role, task: target.id, status: 'blocked', msg: `${target.id} not done yet: claim: ${judged.mismatches[0]}`.slice(0, 600) });
      return { error: 'claim', claims: judged, message: [`${target.id} is not done: what the note says does not match what the harness sees.`, ...claimLines(judged), 'Fix the work or the note (the claim is checked again at the next done); a claim the harness cannot re-run is listed with "?" and never counts as green.'].join('\n') };
    }
    if (judged?.unverifiable?.length) for (const u of judged.unverifiable) console.warn(`[done] claim not verifiable: ${u}`);
    if (judged) check.claims = judged.results.map((r) => ({ cmd: r.cmd || null, verdict: r.verdict }));
  }
  // 2.78.1 (f, M7): warnings that don't block (a playtest report that played the template, not the studio's game).
  for (const w of check.warnings || []) {
    console.warn(`[done] WARN ${w}`);
    emitEvent({ type: 'task.warn', agent: agent || target.role, task: target.id, status: 'warn', msg: `${target.id}: WARN ${w}`.slice(0, 400) });
  }
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
    // 2.60.1 (B-33): name the check that blocks. check.missing[0] can be a row this run doesn't require (the verify, which
    // the train's own verify covers under --train): T-059 was refused "full verify ran on another commit" while another
    // check was what failed. Exempt rows are listed as covered, not as open.
    const first = blocking[0];
    const blocker = first.label ? `${first.label}: ${first.why}` : first.why;
    const exempt = (c) => !c.ok && trainCheck && TRAIN_VERIFIED.has(c.label);
    emitEvent({ type: 'task.not_done', agent: agent || target.role, task: target.id, status: 'blocked', msg: `${target.id} not done yet: ${blocker}`.slice(0, 600) });
    return {
      error: 'not-done',
      check,
      blocking,
      message: [
        `${target.id} is not done: ${blocker}`,
        `${target.id} is a "${check.type}" task (${check.typeSource}). Done means: ${check.means}.`,
        check.typeIgnored ? `  note: ${check.typeIgnored}` : '',
        ...(check.checks?.length ? check.checks.map((c) => (exempt(c) ? `  (the train's verify covers this) ${c.label}` : `  [${c.ok ? 'x' : ' '}] ${c.label}${c.ok ? '' : `: ${c.why}`}`)) : check.missing.map((m) => `  missing: ${m}`)),
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
  if (!force && !extEngine && !inLaneCopy() && process.env.STUDIO_DONE_UNCOMMITTED !== 'allow') {
    const owner = lock.locked ? lock.lock.owner : agent;
    let scope = owner ? listLocks().filter((l) => l.owner === owner && l.key.startsWith('path:')).map((l) => l.key.slice(5)).filter(Boolean) : [];
    const claimedPaths = scope.length > 0;
    if (!scope.length) {
      const f = gameFolders();
      scope = [f.renderer, f.sim].filter(Boolean);
    }
    if (scope.length) {
      const st = spawnSync('git', ['status', '--porcelain', '--', ...scope], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8' });
      const lines = st.status === 0 ? st.stdout.split('\n').filter(Boolean).filter((l) => !isEngineChurn(l.slice(3))) : [];
      // 2.58.3 (O3, crew P-035): a tracked file whose only difference is line endings (a test snapshot rewritten on
      // Windows) isn't uncommitted work: named in a note, never a refusal. Content changes, new and deleted files still are.
      const { real: real0, eol } = splitEolOnly(REPO_ROOT, lines);
      // 2.84 (m): a file git reports as modified whose bytes are the committed blob (a filter rule) is no work: one note.
      const { real, phantom } = splitPhantom(REPO_ROOT, real0);
      if (phantom.length) console.warn(`[done] note: ${phantomNote(phantom)}`);
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
        return { error: 'uncommitted', dirty, message: `${target.id} is not done: these changes aren't committed yet:\n${dirty.slice(0, 10).map((d) => `  ${d}`).join('\n')}\nCommit them, one command per call (agent shells refuse chained commands): git add <files>, then git commit -m "${target.id}: …", then run task done again.` };
      }
    }
  }

  // 2.59.0: the train lands committed work only, from a lane copy (the same refusal deliver makes, made up front).
  if (trainCheck) {
    if (!inLaneCopy()) return { error: 'not-lane', message: `${target.id}: the merge train lands lane copies; in the main checkout task done closes the task directly.` };
    const { dirty, eol, phantom } = laneDirty(REPO_ROOT);
    if (phantom?.length) console.warn(`[task done] note: ${phantomNote(phantom)}`);
    if (eol.length) console.warn(`[task done] note: ${eolNote(eol)}`);
    if (dirty.length) return { error: 'uncommitted', dirty, message: `Commit your work first: ${dirty.length} uncommitted file(s) in your copy (${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}). Only committed work reaches the studio. Then run task done again.` };
  }

  // 2.67.1 (j): asset work (--track asset, or files under the game's declared asset paths) passes the asset gate.
  if (!force) { const ag = assetGateAtDone(target, { agent, checkOnly }); if (ag) return ag; }

  if (checkOnly) {
    const verifyNeeded = Boolean(check.checks?.some((c) => !c.ok && c.label === VERIFY_LABEL));
    return { checkOnly: true, ok: true, id: target.id, verifyNeeded, type: check.type, typeSource: check.typeSource, message: `${target.id} (a "${check.type}" task, ${check.typeSource}): every quick check passes.${verifyNeeded ? ' Next: npm run verify (it is scoped to your lane), then task done.' : ' Next: task done (it runs the game checks and lands the work).'}` };
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
    // 2.71.1 (B): the checks run as the gates do, without code-loading NODE_OPTIONS or git redirects (harness/gate-env.mjs).
    const safetyEnv = gateEnv({ ...process.env, ...(start ? { STUDIO_TASK_BASE: start } : {}) });
    for (const [id, rel, args] of SAFETY) {
      const file = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(file)) { failed.push({ id, rel, why: `${rel} is missing` }); continue; }
      const r = spawnSync(process.execPath, [file, ...args], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', env: safetyEnv, maxBuffer: 32 * 1024 * 1024 });
      if (r.status !== 0) failed.push({ id, rel, why: `${r.stderr || ''}${r.stdout || ''}`.trim().split('\n').slice(-12).join('\n') || `exit ${r.status}` });
    }
    for (const [id, name] of [['hooks', 'STUDIO_HOOKS_CHECK'], ['weakened-tests', 'STUDIO_WEAKENED_TESTS']]) {
      if (/^(off|0|false|no)$/i.test(String(process.env[name] || ''))) emitEvent({ type: 'safety.off', agent: agent || target.role, task: target.id, msg: `${target.id} closed with the ${id} check off (${name}=off)` });
    }
    if (failed.length) {
      // 2.79 (d): the refusal's own code (meta.ownerStep) is what a later hand-back is routed on, never the words of its note.
      { const ownerStep = ownerStepOfChecks(failed.map((f) => f.id)); emitEvent({ type: 'task.not_done', agent: agent || target.role, task: target.id, status: 'blocked', msg: `${target.id} not done yet: the ${failed.map((f) => f.id).join(' and ')} check failed`, meta: { refusal: failed.map((f) => f.id), ...(ownerStep ? { ownerStep } : {}) } }); }
      const how = Object.fromEntries(SAFETY.map(([id, , , h]) => [id, h]));
      return { error: 'safety', failed, message: `${target.id} is not done: ${failed.map((f) => `the ${f.id} check fails (node ${f.rel}):\n${f.why.split('\n').map((l) => `  ${l}`).join('\n')}\n  Fix: ${how[f.id]}.`).join('\n')}\nThese run at every task done, forced or not.` };
    }
  }

  // 2.72.0 (b): fixed purity hits leave the baseline (harness/ratchet.mjs), committed in this copy before it lands.
  if (trainCheck) shrinkAtDone({ root: REPO_ROOT, task: target.id, agent });
  if (trainCheck) {
    const g = (...a) => { const r = spawnSync('git', a, { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };
    return { trainReady: true, id: target.id, type: check.type, all: check.type === 'whole', head: g('rev-parse', 'HEAD'), tree: g('rev-parse', 'HEAD^{tree}'), branch: g('symbolic-ref', '--short', 'HEAD') };
  }

  // 2.30n: the studio game's own checks and, for files in a Godot project, the engine gate. Before
  // 2.30n only example-sim was gated, so the real game never was. STUDIO_DONE_GAME_GATES=skip turns it off.
  if (extEngine && !force && process.env.STUDIO_DONE_GAME_GATES !== 'skip') console.log(`[task done] ${target.id} is a ${extEngine.engine} pass in its own repo: the studio game's checks don't judge it; its ${extEngine.engine} land run does`);
  // 2.78.2 (c): a direction, review, docs, idea, research or study task whose lane changes no game code doesn't run the
  // game's own checks (T-219: a direction task's done ran the whole game suite and timed out). done-check.mjs skipGameChecks.
  const noGame = (() => {
    if (force || extEngine || process.env.STUDIO_DONE_GAME_GATES === 'skip') return null;
    try {
      const ld0 = laneDiff();
      const st0 = spawnSync('git', ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ':(exclude)studio'], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8' });
      const dirty0 = st0.status === 0 ? String(st0.stdout || '').split('\0').filter((x) => x.length > 3).map((x) => x.slice(3)) : ['?'];
      const claimed0 = (lock.locked ? lock.lock.owner : agent) ? listLocks().filter((l) => l.owner === (lock.locked ? lock.lock.owner : agent) && l.key.startsWith('path:')).map((l) => l.key.slice(5)) : [];
      const own = (() => { try { return taskChanges(target.id, startedAt(target.id)).files; } catch { return ['?']; } })();
      const r0 = skipGameChecks(check.type, [...(ld0?.changed || []), ...dirty0, ...claimed0, ...own], process.env, { role: target.role, ownerTyped: Boolean(typeOf(target).owner) });
      return r0.skip ? r0 : null;
    } catch { return null; }
  })();
  if (noGame) console.log(`[task done] the game's checks are not run: ${noGame.why}`);
  if (!force && !extEngine && !noGame && process.env.STUDIO_DONE_GAME_GATES !== 'skip') {
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
    const ggEnv = gateEnv(); // 2.71.1 (B): as the gates run
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
      const gitOut = (...a) => { const r = spawnSync('git', a, { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };
      const tree = gitOut('rev-parse', 'HEAD^{tree}');
      const recTree = rec.head && /^[0-9a-f]{40,64}$/.test(String(rec.head)) ? gitOut('rev-parse', '--verify', '--quiet', `${rec.head}^{tree}`) : '';
      const st = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', '.', ':(exclude)studio'], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8' });
      const clean = st.status === 0 && !String(st.stdout || '').trim();
      const hadPaths = Array.isArray(rec.gatePaths) ? rec.gatePaths : rec.scoped ? rec.changed || [] : [];
      const j = judgeVerifyReuse(rec, { tree, recTree: recTree || null, clean, changed, needEngine: engineGates(paths).map((e) => e.project), hadEngine: engineGates(hadPaths).map((e) => e.project), relatedNow: relatedTestsOn(), optIn: /^(on|1|true|yes)$/i.test(reuseEnv), maxAgeH: Number(process.env.STUDIO_DONE_REUSE_MAX_H || 24) });
      return { rec, ...(j.ok ? reuseTrusted(rec, j) : j) };
    })();
    let plan = null;
    if (reuse?.ok) {
      // The checks this done would have run, and the scope that pass covers (for deliver's re-check after a rebase).
      const pr = spawnSync(process.execPath, [path.join(REPO_ROOT, 'harness', 'game-gates.mjs'), '--plan', ...(paths.length ? ['--paths', paths.join(',')] : []), ...(changed ? ['--changed', changed.join(',')] : [])], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', env: ggEnv, maxBuffer: 32 * 1024 * 1024 });
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
    const gg = reused ? { status: 0, stdout: JSON.stringify({ ok: true, rows: plan.gates.map((id) => ({ id, ok: true, reused: true })), skipped: plan.skipped, scope: plan.scope }) } : spawnSync(process.execPath, [path.join(REPO_ROOT, 'harness', 'game-gates.mjs'), '--json', ...(paths.length ? ['--paths', paths.join(',')] : []), ...(changed ? ['--changed', changed.join(',')] : [])], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', env: ggEnv, maxBuffer: 32 * 1024 * 1024 });
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
      if (!checkOnly) recordGateRefusal(target.id, { gates: res?.rows?.length ? res.rows : failed.map((f) => ({ id: f.id, ok: false })), text: failed.map((f) => `${(f.failures || []).map((x) => `FAIL ${x}`).join('\n')}\n${f.why || ''}`).join('\n') }); // 2.66.0 (c): the next hand-back's facts
      return { error: 'game-gates', failed, message: `${target.id} is not done: the game's checks fail.\n${failed.map((f) => `  FAIL ${f.id}: ${f.why}`).join('\n')}\nFix it, commit, and run task done again (node harness/game-gates.mjs${paths.length ? ` --paths ${paths.join(',')}` : ''} runs them).` };
    }
  }

  // 2.72.0 (b): the game's checks passed: fixed purity hits leave the baseline (a commit of that file only) before it lands.
  if (!force) shrinkAtDone({ root: REPO_ROOT, task: target.id, agent });

  // 2.79 (e): an engine-porter task runs its engine's quickCheck (studio/game.json engines.<x>.quickCheck, npm run engine --
  // check) in its lane copy and is refused on red: the porter's own check, like a builder's game checks. Not configured: nothing.
  if (!force && !checkOnly) {
    const qe = (() => { try { const r = extEngine || engineTaskOf(target.id); return r?.engine || null; } catch { return null; } })();
    if (qe && (target.role === 'engine-porter' || extEngine) && typeof engineTarget(qe)?.cfg?.quickCheck === 'string' && engineTarget(qe).cfg.quickCheck.trim()) {
      const qc = spawnSync(process.execPath, [path.join(REPO_ROOT, 'harness', 'engine-check.mjs'), '--json', '--engine', qe, '--task', target.id], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      let c = null;
      try { c = JSON.parse((qc.stdout || '').trim().split('\n').pop()); } catch {}
      if (!c) return { error: 'engine-check', message: `${target.id} is not done: the ${qe} quick check didn't report (${`${qc.stderr || ''}${qc.stdout || ''}`.trim().slice(-300) || `exit ${qc.status}`}). npm run engine -- check --task ${target.id} runs it.` };
      if (c.status !== 'pass' && c.status !== 'skipped') return { error: 'engine-check', message: `${target.id} is not done: ${c.why}${c.tail ? `\n${c.tail.split('\n').map((l) => `  ${l}`).join('\n')}` : ''}\nFix it, run npm run engine -- check --task ${target.id}, then done again.` };
    }
  }

  // 2.63.0: task done --train on a Unity-track task: every check above passed; the Unity merge train
  // (harness/unity-train.mjs) lands its branch with others on one land run and closes it then. Nothing is closed here.
  if (unityTrainCheck) return force ? { error: 'train-force', message: 'A forced done never goes through the Unity train.' } : { unityReady: true, id: target.id, type: check.type };
  // 2.59.0 (#16): a task on the Unity track (task add --track engine:unity) lands through the studio's Unity gate
  // (harness/unity-gate.mjs: its configured land command, under the machine:heavy lock); it closes only on a pass.
  // 2.77.0 (u, P5.6): any engine target with a land command (studio/game.json engines.<x>.land); the track from the
  // task's engine record first (harness/engine-tracks.mjs), so an old task keeps it.
  const landEngine = (() => { const e = engineOfTrack(extEngine?.track || (() => { try { return engineTaskOf(target.id)?.track; } catch { return null; } })()); return e && (e === 'unity' || engineTarget(e)?.land) ? e : null; })();
  if (!force && process.env.STUDIO_DONE_UNITY_GATE !== 'skip' && landEngine) {
    const ug = spawnSync(process.execPath, [path.join(REPO_ROOT, 'harness', 'unity-gate.mjs'), '--json', '--task', target.id, '--engine', landEngine], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, STUDIO_GATE_PRIORITY: 'landing' }, maxBuffer: 32 * 1024 * 1024 });
    let u = null;
    try { u = JSON.parse((ug.stdout || '').trim().split('\n').pop()); } catch {}
    if (!u) return { error: 'unity-gate', message: `${target.id} is not done: the Unity gate didn't report (${`${ug.stderr || ''}${ug.stdout || ''}`.trim().slice(-300) || `exit ${ug.status}`}). node harness/unity-gate.mjs --task ${target.id} runs it.` };
    if (u.status === 'skipped' && !u.notUnity) console.log(`[task done] skipped the Unity gate: ${u.why}`);
    // 2.73.2 (e, B-73): not run (an infrastructure abort, or free RAM under the Unity floor) is "try again", like busy.
    const later = u.status === 'refused' || u.status === 'not-run';
    if (!u.ok) return { error: later ? 'unity-busy' : 'unity-gate', unity: u, message: `${target.id} is not done: the Unity gate ${u.status === 'refused' ? 'is busy' : u.status === 'not-run' ? 'did not run' : `says ${u.status}`}: ${u.why}${u.tail ? `\n${u.tail.split('\n').map((l) => `  ${l}`).join('\n')}` : ''}\n${later ? 'Run task done again later; nothing is wrong with the work.' : `Fix it and run task done again (node harness/unity-gate.mjs --task ${target.id} runs it; its log: ${u.log || '.studio/gates/out/unity.log'}).`}` };
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
    // 2.65.0 (B-40): the lane's config proposal (studio-proposals/<ID>.json) is judged before it lands and applied
    // right after it does (harness/train.mjs applyLandedConfig), as the merge train does.
    const lp = (() => { try { return laneConfigBefore(mainRoot(), { task: taskId, laneDir: REPO_ROOT, main: mainBranchOf(mainRoot()), ff: landFastForward, by: agent || target.role || 'task-done' }); } catch (e) { return { has: false, error: e.message }; } })();
    if (lp.refuse) {
      emitEvent({ type: 'task.not_done', agent: agent || target.role, task: target.id, status: 'blocked', msg: `${target.id} not done yet: ${lp.refuse.split('.')[0]}`.slice(0, 400) });
      return { error: 'not-delivered', message: `${target.id} is not done: ${lp.refuse}` };
    }
    const landed2 = lp.has ? () => { lp.apply(); writeBoard(); } : writeBoard;
    try { d = deliver(taskId, { onLanded: landed2 }); } finally { if (hadPriority === undefined) delete process.env.STUDIO_GATE_PRIORITY; else process.env.STUDIO_GATE_PRIORITY = hadPriority; }
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
  clearAttempts(target.id); // 2.81 (b1): a finished task has nothing to hold back (harness/attempts.mjs)
  emitEvent({ type: 'task.done', agent: agent || target.role, task: target.id, status: 'done', to: 'producer', msg: `Completed ${target.id}: ${target.title}`, ...(check.anchors || check.claims ? { meta: { ...(check.anchors ? { anchors: check.anchors } : {}), ...(check.claims ? { claims: check.claims } : {}) } } : {}) });
  try { canaryEnd(target.id, 'cheated', { agent: agent || target.role }); } catch { /* a record, never a blocker */ }
  assetHandoffAfterLanding(target.id, agent); // 2.67.1 (j)
  // 2.35.0: a finished rescue acts on its decision (retry unparks the stuck task, split keeps it parked, needs-person asks).
  if (taskType(target) === 'rescue') { try { applyRescue(target, { by: agent || 'rescue' }); } catch { /* the rescue's own record stays */ } }
  else { try { closeRescuesFor(target.id, { by: agent || target.role || 'harness', why: 'has landed', board: { parseNextQueue, dropTask } }); } catch { /* 2.60.1 (B-39): the watchdog's pass sweeps it */ } }
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
 * 2.67.1 (j): the asset gate at task done (harness/asset-gate.mjs, run as its own process: its round trip takes the
 * machine:heavy lock). Runs for a task on the asset track, or for any task when the game declares asset paths
 * (studio/game.json "assets"); a change with no asset file is a skip. --check runs every check but the round trip.
 * null = nothing blocks; else task done's refusal. A refusal is kept for the task's next hand-back facts.
 */
function assetGateAtDone(target, { agent = null, checkOnly = false } = {}) {
  const track = readRecentEvents(20000).filter((e) => e.type === 'task.added' && e.task === target.id).pop()?.meta?.track || null;
  if (!assetGateApplies(track, REPO_ROOT)) return null;
  let files = null;
  try { if (inLaneCopy()) files = laneDiff()?.changed || null; } catch { /* git below */ }
  const base = files ? null : taskBase(target.id);
  const args = [path.join(REPO_ROOT, 'harness', 'asset-gate.mjs'), '--json', '--task', target.id, ...(files ? ['--files', files.join(',')] : []), ...(base ? ['--base', base] : []), ...(checkOnly ? ['--no-round-trip'] : [])];
  const r = spawnSync(process.execPath, args, { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, STUDIO_GATE_PRIORITY: 'landing' }, maxBuffer: 32 * 1024 * 1024 });
  let res = null;
  try { res = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { /* reported below */ }
  if (!res) return { error: 'asset-gate', message: `${target.id} is not done: the asset gate didn't report (${`${r.stderr || ''}${r.stdout || ''}`.trim().slice(-300) || `exit ${r.status}`}). node harness/asset-gate.mjs --task ${target.id} runs it.` };
  const text = assetGateText(res);
  if (res.status === 'skipped') return null;
  if (!checkOnly) emitEvent({ type: 'asset.gate', agent: agent || target.role, task: target.id, status: res.ok ? 'ok' : res.status === 'busy' ? 'warn' : 'blocked', msg: `${target.id} asset gate: ${res.status}${res.failures?.length ? ` (${res.failures.map((f) => `${f.check} ${f.file}`).join(', ')})` : ''}`.slice(0, 500), meta: { status: res.status, files: res.files, failures: (res.failures || []).map((f) => ({ check: f.check, file: f.file })), steamDisclosure: res.steamDisclosure || [] } });
  if (res.ok) { if (text) console.log(text); return assetReviewAtDone(target, res, { agent, checkOnly }); }
  if (res.status === 'busy') return { error: 'asset-busy', asset: res, message: `${target.id} is not done: the asset gate's round trip is waiting for the machine:heavy lock: ${res.why}\nRun task done again later; nothing is wrong with the work.` };
  emitEvent({ type: 'task.not_done', agent: agent || target.role, task: target.id, status: 'blocked', msg: `${target.id} not done yet: the asset gate failed (${res.failures.map((f) => f.check).join(', ')})`.slice(0, 400) });
  if (!checkOnly) recordGateRefusal(target.id, { gates: [{ id: 'asset', ok: false }], text: `${text}\n[gates] FAIL asset`, log: '.studio/gates/asset-last.json' });
  return { error: 'asset-gate', asset: res, message: `${target.id} is not done: the asset gate fails.\n${text}\nFix it, commit, and run task done again (node harness/asset-gate.mjs --task ${target.id}${base ? ` --base ${String(base).slice(0, 12)}` : ''} runs it).` };
}

/**
 * 2.70.0 (v): the checks passed; the asset still needs a look (harness/asset-review.mjs reviewsAtDone): the request
 * and ONE review task are filed, and task done refuses until the review passes. null = reviewed (or no review asked).
 */
function assetReviewAtDone(target, res, { agent = null, checkOnly = false } = {}) {
  const rv = reviewsAtDone({ task: target.id, res, agent, checkOnly, addTask, root: REPO_ROOT });
  if (!rv) return null;
  if (rv.note) { console.log(rv.note); return null; }
  return rv;
}

/** 2.67.1 (j): a landed asset task files its one engine-track task (harness/asset-gate.mjs fileAssetHandoff). Never throws. */
function assetHandoffAfterLanding(taskId, agent) {
  try {
    const r = fileAssetHandoff({ task: taskId, addTask, root: REPO_ROOT });
    if (r?.id && !r.already) console.log(`[task done] ${taskId} landed asset files: ${r.id} wires them in${r.track ? ` (${r.track})` : ''}`);
    else if (r?.refused) console.warn(`[task done] note: ${taskId}'s engine task wasn't queued: ${r.refused}`);
  } catch (err) {
    try { emitEvent({ type: 'asset.handoff_refused', agent: agent || 'harness', task: taskId, status: 'warn', to: 'producer', msg: `${taskId}: the asset hand-off failed: ${err.message}`.slice(0, 400) }); } catch { /* evidence only */ }
  }
}

/**
 * 2.59.0: close a task a merge train landed (harness/train.mjs): its lane's checked head is in the train's verified
 * head, which main now contains. The board move, the claim, the events and the follow-ups are task done's; its checks
 * ran in the train's lane check (trainCheck) and the train's verify. Returns the task, null (not on the board) or
 * { error, message }.
 */
export function closeTrainTask(taskId, agent, { train, head, laneHead, record = null, note = '', repo = null, target: landTarget = null } = {}) {
  const lock = lockStatus(`task:${taskId}`);
  if (lock.locked && lock.lock.owner !== agent) return { error: 'locked', message: `${taskId} is claimed by ${lock.lock.owner} now, not ${agent}` };
  const root = mainRoot();
  // 2.83: a task with work in two repositories is done when both halves have landed. The merge train landed a task's
  // studio half and closed it while its engine branch had been handed back by the engine train: the engine half was
  // orphaned ("task done: not found"). Now the task stays open; its engine branch is queued again if it can be.
  if (!repo) {
    const half = (() => { try { return engineHalfOpen(taskId, root); } catch { return null; } })();
    if (half) {
      let queued = '';
      try { const ut = spawnSync(process.execPath, [path.join(REPO_ROOT, 'harness', 'unity-train.mjs'), 'queue', '--engine', half.engine, '--task', taskId, '--agent', agent || '', '--branch', half.branch], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8' }); queued = ut.status === 0 ? `; its branch is queued for the ${half.engine} train` : ''; } catch { /* said below */ }
      emitEvent({ type: 'task.half_landed', agent: agent || 'train', task: taskId, to: 'producer', status: 'warn', msg: `${taskId}: its studio half landed (merge train ${train}), its ${half.engine} branch ${half.branch} has ${half.ahead} commit(s) that ${half.target} doesn't have: the task stays open until the ${half.engine} train lands it${queued || `: npm run task -- done ${taskId} --train queues it`}`, meta: { train, engine: half.engine, branch: half.branch, ahead: half.ahead } });
      return { id: taskId, halfLanded: true };
    }
  }
  // 2.63.0: a Unity train's branch landed in the Unity repo (repo) on its target branch, not in the studio's branch.
  const gitRoot = repo || root;
  const anc = (a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { windowsHide: true, cwd: gitRoot }).status === 0;
  const mainTip = spawnSync('git', ['rev-parse', landTarget ? `refs/heads/${landTarget}` : 'HEAD'], { windowsHide: true, cwd: gitRoot, encoding: 'utf8' }).stdout.trim();
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
  clearAttempts(target.id);
  emitEvent({ type: 'task.done', agent: agent || target.role, task: target.id, status: 'done', to: 'producer', msg: `Completed ${target.id}: ${target.title} (merge train ${train})`, meta: { train } });
  try { canaryEnd(target.id, 'cheated', { agent: agent || target.role }); } catch { /* a record, never a blocker */ }
  assetHandoffAfterLanding(target.id, agent); // 2.67.1 (j)
  if (taskType(target) === 'rescue') { try { applyRescue(target, { by: agent || 'rescue' }); } catch { /* the rescue's own record stays */ } }
  else { try { closeRescuesFor(target.id, { by: agent || target.role || 'harness', why: 'has landed', board: { parseNextQueue, dropTask } }); } catch { /* 2.60.1 (B-39): the watchdog's pass sweeps it */ } }
  joinWaveIfGameplay(target, agent || target.role);
  return target;
}

/**
 * 2.65.0 (B-34): conflict prediction when a lane is queued (harness/train-predict.mjs): { refuse } for a conflict
 * with main, else { after, lines }. Never throws: a prediction that can't run queues as before, with a note.
 */
async function predictAtQueue(pre, agent) {
  try {
    const root = mainRoot();
    const tr = await import('./train.mjs');
    const tp = await import('./train-predict.mjs');
    const { mainBranch } = await import('./worktree.mjs');
    const main = mainBranch(root);
    const tip = spawnSync('git', ['rev-parse', `refs/heads/${main}`], { windowsHide: true, cwd: root, encoding: 'utf8' }).stdout?.trim() || '';
    const settings = await tr.trainManifest(root, tip);
    const p = tp.predictLane(root, { lane: { task: pre.id, head: pre.head }, queue: tr.readQueue(root), tip, unionFiles: settings.unionFiles || [] });
    return tp.queueVerdict(p, { task: pre.id, agent, head: pre.head, main, lane: pre.branch || '', emit: emitEvent });
  } catch (err) {
    return { after: null, lines: [`${pre.id}: note: the conflict prediction didn't run (${err.message}); the train finds conflicts when it merges.`] };
  }
}

/**
 * 2.59.0: queue a checked lane for the next merge train (`task done <ID> --train`); 2.78.2 (a, W-0090): also a lane's
 * plain `task done` (STUDIO_DONE_QUEUE, default on), which then makes sure a train runs (harness/train-detach.mjs
 * kickTrain: the supervisor's train daemon, else one detached train), so the train never runs in the builder's shell.
 * Prints what happened; returns the exit code (0: queued). The task stays in progress until the train lands it.
 */
async function queueLaneForTrain(targetId, flags, noopFlag, { kick = false } = {}) {
  const who = whoAmI(flags);
  const pre = completeTask(targetId, '', who, { trainCheck: true, noop: noopFlag });
  if (!pre) { console.error(`Task "${targetId}" not found.`); return 1; }
  if (pre.error) { console.error(pre.message); return 1; }
  const predicted = await predictAtQueue(pre, who);
  if (predicted.refuse) { console.error(predicted.refuse); return 1; }
  const { enqueue } = await import('./train.mjs');
  const e = enqueue(mainRoot(), { task: pre.id, agent: who, dir: REPO_ROOT, branch: pre.branch, head: pre.head, all: pre.all, note: typeof flags.note === 'string' ? flags.note : '', ...(predicted.after ? { after: predicted.after } : {}) });
  for (const l of predicted.lines || []) console.log(l);
  emitEvent({ type: 'task.train.queued', agent: who, task: pre.id, to: 'producer', msg: `${pre.id} is checked and waits for the next merge train (${pre.branch} at ${String(pre.head).slice(0, 8)})`, meta: { head: pre.head, branch: pre.branch, ...(kick ? { viaDone: true } : {}) } });
  console.log(kick
    ? `${pre.id} is checked and queued for the merge train (${e.branch} at ${String(e.head).slice(0, 8)}). The train lands it (one full verify for every lane in it); until then it stays in progress, and if the train hands it back you get it back with the reason.`
    : `${pre.id} is checked and queued for the next merge train (${e.branch} at ${String(e.head).slice(0, 8)}). npm run task -- train lands it (one full verify for every lane in the train); until then it stays in progress.`);
  let tierC = false;
  // 2.63.0: the lane's landing tier (harness/tiers.mjs, from its own diff); tier C waits for the owner.
  try {
    const tr = await import('./train.mjs');
    const c = await tr.laneTier(mainRoot(), { head: pre.head, task: pre.id });
    console.log(`${pre.id}: ${(await import('./tiers.mjs')).tierLine(c)}${c.runAlone.yes ? `; it trains alone (${c.runAlone.why})` : ''}`);
    if (c.tier === 'C') {
      tierC = true;
      tr.holdLane(mainRoot(), { ...e, head: pre.head, branch: pre.branch, dir: REPO_ROOT }, { tier: 'C', why: c.why.join('; ') });
      emitEvent({ type: 'task.train.held', agent: who, task: pre.id, to: 'producer', status: 'blocked', msg: `${pre.id} needs the owner (tier C): ${c.why.join('; ')}`.slice(0, 600), meta: { tier: 'C', why: c.why } });
      console.log(`${pre.id} needs the owner: tier C never lands by itself. It waits in the queue until a person releases it (npm run task -- train release ${pre.id} --by <name>); you can stop here (task pause ${pre.id} --note "…").`);
    }
    if (c.needs.goldenReason.length) console.log(`${pre.id}: note: it moves goldens (${c.needs.goldenReason.slice(0, 3).join(', ')}) with no Golden-Reason trailer: the train hands it back unless a commit says why.`);
    if (c.needs.pinMoves.length) console.log(`${pre.id}: note: it changes pinned expectations (${c.needs.pinMoves.slice(0, 3).join(', ')}) with no Pin-Moves trailer: the train hands it back unless a commit declares them.`);
  } catch (err) { console.warn(`[task done] note: could not work out the lane's tier (${err.message}); the train will`); }
  (await import('./hotspots.mjs')).warnAt('train-queue', { task: pre.id, agent: who }); // 2.60.0: lines another lane changes too
  if (kick && !tierC) {
    // How long a train it starts waits for a running one: STUDIO_TRAIN_LOCK_WAIT_MIN (before 2.63.0 STUDIO_TRAIN_WAIT_MIN), 120.
    const lockWait = Number([process.env.STUDIO_TRAIN_LOCK_WAIT_MIN, process.env.STUDIO_TRAIN_WAIT_MIN].map((v) => String(v ?? '').trim()).find((v) => v !== '' && Number.isFinite(Number(v))) ?? 120);
    let k;
    try { k = await (await import('./train-detach.mjs')).kickTrain(mainRoot(), { by: who, waitMin: lockWait }); } catch (err) { k = { how: 'failed', line: `Couldn't make sure a train runs (${err.message}); npm run task -- train --by <you> lands the queue.` }; }
    console.log(k.line);
    console.log(`Follow it: npm run task -- train status (the running train, its step and ETA, and the queue). It ends with task.train.done: ${pre.id} closes (task.done) when it lands, or comes back to the board with the train's reason (task.paused). Nothing more to run here: you can end your session.`);
    emitEvent({ type: 'task.done.queued', agent: who, task: pre.id, msg: `${pre.id}: task done queued the lane for the merge train (${k.how}${k.pid ? `, pid ${k.pid}` : ''})`, meta: { head: pre.head, branch: pre.branch, how: k.how, ...(k.pid ? { pid: k.pid } : {}) } });
  }
  if (kick) console.log(JSON.stringify({ id: pre.id, status: 'queued', branch: pre.branch, head: pre.head, ...(tierC ? { held: 'tier C: waits for the owner' } : {}) }, null, 2));
  // A plain task done of a tier C lane says "not done yet" (exit 1), as its inline train did: it waits for the owner.
  return kick && tierC ? 1 : 0;
}

/**
 * 2.83: the engine half of a task that is not landed yet: { engine, branch, target, ahead } when the task has an engine
 * record in another repository whose branch holds commits the engine's target doesn't have; else null.
 */
export function engineHalfOpen(taskId, root = mainRoot()) {
  const rec = engineTaskOf(taskId);
  if (!rec?.branch) return null;
  const repo = engineRepo(rec.engine);
  const target = engineTarget(rec.engine)?.cfg?.target || null;
  if (!repo || !target) return null;
  const g = (...a) => spawnSync('git', a, { windowsHide: true, cwd: repo, encoding: 'utf8' });
  if (g('rev-parse', '--verify', '--quiet', `refs/heads/${rec.branch}^{commit}`).status !== 0 || g('rev-parse', '--verify', '--quiet', `refs/heads/${target}^{commit}`).status !== 0) return null;
  const ahead = Number(g('rev-list', '--count', `refs/heads/${target}..refs/heads/${rec.branch}`).stdout.trim()) || 0;
  void root;
  return ahead > 0 ? { engine: rec.engine, branch: rec.branch, target, ahead } : null;
}

/** 2.59.0: what the merge train needs from the board (harness/train.mjs never imports this module). */
export function trainDeps(busyMod, { forDone = false } = {}) {
  return {
    close: (lane, ctx) => {
      const t = closeTrainTask(lane.task, lane.agent, { train: ctx.train, head: ctx.head, laneHead: lane.head, record: ctx.record, note: lane.note || '', repo: ctx.repo || null, target: ctx.target || null });
      if (t?.halfLanded) return { ok: true, half: true }; // 2.83: its engine half is still to land: the task stays open
      return t?.error ? { ok: false, message: t.message } : t ? { ok: true, target: t } : { ok: false, message: `${lane.task} is not on the board` };
    },
    handBack: (lane, note, o = {}) => pauseTask(lane.task, lane.agent, note, { force: true, handBackCause: o.cause }),
    stopped: () => { const s = readStop(); return s ? `by ${s.by}${s.reason ? `: ${s.reason}` : ''}` : null; },
    // 2.65.0 (3.3): which tasks are open and done on the board, for the train's --after ordering.
    taskStates: () => { const q = parseNextQueue(); return { open: new Set([...q.inProgress, ...q.backlog].map((t) => t.id)), done: new Set(q.done.map((t) => t.id)) }; },
    // 2.67.0 (f): the chain-tail task the train files (harness/train-tail.mjs): a builder bug task stacked (--after) on
    // the chain's last lane; its start isn't held by that --after (task-hold.mjs chainTail), the train's order is.
    fileTask: ({ title, after, chain = [], train = '' }) => {
      const t = addTask({ title, role: 'builder', priority: 'P0', agent: 'train', meta: { type: 'bug', promoted: true, origin: 'harness', after: [after], chainTail: { chain, train } } });
      if (t?.id && !t.error && !t.proposed && !t.duplicate) setHold(t.id, { chainTail: { chain, train, after } });
      return t;
    },
    // 2.69.0 (r): ONE fix task per test the flake triager quarantined (harness/flakes.mjs; the board dedupes by title).
    fileFlakeTask: ({ title, test, label }) => addTask({ title, role: 'builder', priority: 'P1', agent: 'train', meta: { type: 'bug', promoted: true, origin: 'harness', flake: { test, label } } }),
    // 2.76.0 (helper h): in beta mode the hand-back cap files ONE Producer task for the lane (the board dedupes by title).
    fileRescue: ({ task, n, why }) => addTask({ title: `Rescue ${task}: handed back ${n} times`, role: 'producer', priority: 'P0', agent: 'train', meta: { promoted: true, origin: 'harness', handBackCap: { task, n, why: String(why || '').slice(0, 300) } } }),
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
/**
 * 2.78.1: a whole hand-back entry (its "## <time> · <who>" heading, the harness's facts block and the prose) is at most
 * this many characters, so it stays under 3k with the facts in front: the prose is cut to what is left.
 */
export const HANDBACK_ENTRY_MAX = 2900;
const HANDBACK_CUT = '(Cut to 20 lines. Keep hand-back notes short: done, not done, files touched, next step, proof.)';
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
export function pauseTask(taskId, agent = null, note = '', { force = false, expect, cause, handBackCause, ownerStep } = {}) {
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
  // 2.66.0 (c): facts a caller already put in front (the merge train's drop) aren't prose: kept whole, never cut,
  // and the events, the breaker and the "blocked by" hold read only the prose.
  // 2.78.1: the 20-line / under-3k cut holds for the whole entry: the facts (compact, harness/handback-facts.mjs) are
  // built first and the prose is cut to the room they leave.
  const given = splitFacts(note);
  const prose = given.prose;
  // 2.66.0 (c): the harness's own facts (changed files, gates, failure signature, seed, log) go in front of the prose.
  const facts = given.facts || factsFor(target.id, prose || 'No note left.', { agent: lock.lock?.owner || agent });
  const heading = `## ${new Date().toISOString()} · ${who}`;
  const releasedLine = freed.length ? `Released claims: ${freed.join(', ')}` : '';
  const released = releasedLine.length > 300 ? `${releasedLine.slice(0, 299)}…` : releasedLine;
  const room = Math.max(0, HANDBACK_ENTRY_MAX - heading.length - 1 - (facts ? facts.length + 1 : 0) - (released ? released.length + 1 : 0));
  note = prose;
  const capLines = String(note || '').split('\n');
  const proseMax = Math.min(HANDBACK_MAX, room);
  if (capLines.length > 20 || String(note || '').length > proseMax) note = `${capLines.slice(0, 20).join('\n').slice(0, Math.max(0, Math.min(HANDBACK_MAX, room - HANDBACK_CUT.length - 1)))}\n${HANDBACK_CUT}`;
  if (released) note = `${note || 'No note left.'}\n${released}`;
  fs.mkdirSync(HANDOFF_DIR, { recursive: true });
  const file = handoffFile(taskId);
  const head = fs.existsSync(file) ? '' : `# Handoff notes for ${target.id}: ${target.title}\n\nNewest last. Read these before you pick the task up.\n`;
  fs.appendFileSync(file, `${head}\n${heading}\n${facts ? `${facts}\n` : ''}${note || 'No note left.'}\n`);
  syncCurrentTaskCheckpoint(q.inProgress[0] || null, `Paused ${target.id}: ${note || 'handed back'}`);
  // 2.79 (d): the owner step this hand-back waits on, from the harness's own refusal (not from the note's words).
  let ownerStepNow = ownerStep || null;
  if (!ownerStepNow && !cause) { try { ownerStepNow = ownerStepForHandBack(target.id, readRecentEvents(20000)); } catch { /* a hint, never a blocker */ } }
  emitEvent({ type: 'task.paused', agent: who, task: target.id, status: 'paused', msg: `Handed back ${target.id}: ${note || 'no note'}`, meta: { ...(isFailureNote(note) ? { reasonKey: reasonKey(note) } : {}), ...(cause ? { cause } : {}), ...(handBackCause ? { handBackCause } : {}), ...(ownerStepNow ? { ownerStep: ownerStepNow } : {}) } });
  // PU-58: a canary task handed back for a failure (the impossible exit records its own outcome).
  if (!cause && isFailureNote(note)) { try { canaryEnd(target.id, 'handed-back', { agent: who }); } catch { /* a record, never a blocker */ } }
  // 2.30c (#8): a second hand-back for the same reason parks the task with a card; other lanes go on.
  // 2.78.2 (d): a hand-back that names a step only the owner can do waits for the owner (harness/owner-only.mjs), before
  // the breaker, so a task whose first hand-back says so isn't relaunched for a second one.
  const ownerPark = cause ? null : parkIfOwnerOnly(target.id, `${given.prose || ''}\n${note || ''}`, { who });
  const tripped = ownerPark ? ownerPark.why : checkBreaker(target.id, note, who);
  // "blocked by T-12" (or "waits for", "needs T-12 first") in the note: hold the task until T-12 is done,
  // so it isn't picked up again only to be handed back for the same reason (Jed's run).
  const deps = [...String(note || '').matchAll(/\b(?:blocked (?:by|on)|waits? (?:for|on)|needs|after)\s+((?:T-\d+(?:\s*(?:,|and)\s*)?)+)/gi)].flatMap((m) => m[1].match(/T-\d+/g) || []);
  const open = deps.filter((d) => d !== target.id && !q.done.some((t) => t.id === d) && [...q.inProgress, ...q.backlog].some((t) => t.id === d));
  if (open.length) setHold(target.id, { after: [...new Set([...(readHolds()[target.id]?.after || []), ...open])] }, { by: who, msg: `${target.id} waits for ${open.join(', ')} (from ${who}'s hand-back note)` });
  // 2.81 (b1): the attempt ledger (harness/attempts.mjs): a failure or owner-only hand-back, never one the harness or a
  // person caused (`cause`; isFailureNote already leaves harnessCaused/personCaused notes out).
  if (!cause && (ownerPark || isFailureNote(note))) {
    const doneNow = new Set(q.done.map((t) => t.id));
    const blockers = [...new Set([...open, ...(readHolds()[target.id]?.after || [])])].filter((id) => !doneNow.has(id));
    recordAttempt(target.id, { agent: who, endLabel: ownerPark ? 'owner-only' : tripped ? 'breaker' : /^Round cap\b/.test(String(note || '').trim()) ? 'cap' : 'hand-back', reasonKey: reasonKey(note), blockers, ownerOnly: Boolean(ownerPark) });
  }
  return { ...target, handoffFile: path.relative(REPO_ROOT, file), waitsFor: open, ...(tripped ? { parked: tripped } : {}) };
}

/**
 * 2.83: why a task id given to --after (task add, task after) can't be waited for, or '' when all are on the board
 * (studio/NEXT.md or DONE.md: the same test as a lane copy's, harness/worktree.mjs taskOnBoard). A board that can't be read refuses nothing.
 */
export function unknownAfter(ids) {
  const bad = ids.filter((id) => !/^[A-Z]+-\d+$/.test(id) || taskOnBoard(id) === false);
  return bad.length ? `${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} not a task id on the board (studio/NEXT.md, studio/DONE.md): a task can't wait for it. Check the id (npm run task -- list).` : '';
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
/** 2.77.3 (H3): existing files or folders named in a --scope text (a/b/c.js), used as the lane when none is given. 2.78.2: a region (a/sim.ts#symbol) is kept. */
function scopePaths(text) {
  return [...new Set(String(text || '').split(/[\s,;]+/).map((w) => w.replace(/^[`'"(]+|[`'").:]+$/g, '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')).filter((w) => /^[\w.-]+\/[\w./-]*(#[\w$.-]+)?$/.test(w) && !w.includes('..') && fs.existsSync(path.join(REPO_ROOT, w.split('#')[0]))))];
}

export function gateTask({ title, role = 'builder', meta = {} }) {
  const b = readBible();
  const warnings = [];
  if (meta.idea) {
    const idea = readIdea(meta.idea);
    if (!idea) return { ok: false, message: `No idea ${meta.idea} on the Idea Board.` };
    if (!['approved', 'scheduled'].includes(idea.stage)) return { ok: false, message: `${meta.idea} is "${idea.stage}". Ideas go captured, shaped, placed, then approved by the Director before they become work (npm run idea -- show ${meta.idea}).` };
  }
  // 2.77.3 (H3, M2): a builder's code task from `task add` names its folders (--lane/--paths/--part), or they can be worked out
  // from its title; else it would count as "working on the whole game" and stop every other builder. All missing flags are
  // named in one message, each with what it takes.
  const buildTask = ['change', 'system'].includes(taskType({ title, role }));
  const laneMode = laneRequired();
  const laneNeeded = Boolean(meta.requireLane) && laneMode !== 'off' && role === 'builder' && buildTask && !meta.lane && !meta.paths?.length && !meta.part && !meta.wholeGame && !inferLaneAtAdd({ title, meta });
  const laneMissing = laneNeeded && laneMode === 'on';
  if (laneNeeded && !laneMissing) warnings.push(`${title}: no folders given (--lane <folders>, --paths, --part; --lane all for the whole game on purpose). A builder task with no folders counts as working on the whole game: no other builder runs beside it. npm run task -- lane <ID> <folders> sets them later; STUDIO_REQUIRE_LANE=on refuses such a task.`);
  const LANE_FLAG = '--lane <folder>[,<folder>…] (or --paths <files>, or --part sim|renderer; --lane all means the whole game on purpose)';
  if (!b || !buildTask) return laneMissing ? { ok: false, message: `Missing flag: ${LANE_FLAG}. A builder task with no folders would count as working on the whole game and block every other builder.` } : { ok: true, warnings };
  const notLayers = new Set(String(meta.notLayer || '').split(',').filter(Boolean));
  const crossed = crossedLayersIn(title, b).filter((l) => !notLayers.has(l.id));
  if (crossed.length) return { ok: false, message: `"${title}" touches a crossed-out layer: ${crossed.map((l) => `${l.label} (the word "${l.word}")`).join(', ')} (studio/bible/NOT-DOING.md). If the task really is about that, only a person brings the layer back: npm run bible -- layer ${crossed[0].id} yes --by <name>. If the word means something else here, reword the title, or add --not-layer ${crossed[0].id} (logged for the Director's drift report).` };
  if (notLayers.size) emitEvent({ type: 'task.scope_override', agent: meta.by || PRODUCER_NAME(), to: 'director', msg: `"${title}" queued with --not-layer ${[...notLayers].join(',')}: the title matched a crossed-out layer's keyword, and the author says it is not about that layer` });
  if (meta.prototype || meta.infra || /^prototype\b/i.test(title)) return laneMissing ? { ok: false, message: `Missing flag: ${LANE_FLAG}. A builder task with no folders would count as working on the whole game and block every other builder.` } : { ok: true, warnings };
  if (b.signed && b.amended) return { ok: false, message: `The Game Bible changed after ${b.signed.by} signed it (${b.amended.changes.map((c) => c.field).join(', ')}). New build tasks wait until a person re-signs the new design: npm run bible -- sign --by <name> [--via "<where they approved>"]. Work already queued carries on.` };
  if (!b.signed) return { ok: false, message: 'The Game Bible is not signed yet, so this is still pre-production: build tasks wait. Allowed now: studies, storyboards, docs, throwaway prototypes (--prototype) and tooling that isn\'t game content (--infra). See npm run bible -- check.' };
  const phase = Number(meta.phase);
  const phaseBad = ![1, 2, 3].includes(phase);
  const serves = String(meta.serves || '');
  const pillarOk = /^pillar:/i.test(serves) && (b.pillars || []).some((p) => p.name.toLowerCase().startsWith(serves.slice(7).trim().toLowerCase()) && serves.slice(7).trim());
  const layerId = /^layer:/i.test(serves) ? serves.slice(6).trim() : null;
  const layerOk = layerId && b.layers?.[layerId]?.answer === 'yes';
  const servesBad = !pillarOk && !layerOk && !meta.idea;
  if (phaseBad || servesBad || laneMissing) {
    const kept = LAYERS.filter((l) => b.layers?.[l.id]?.answer === 'yes').map((l) => `layer:${l.id}`);
    const parts = [];
    if (phaseBad) parts.push('--phase 1 (early) | 2 (mid) | 3 (endgame): which part of the game it is for');
    if (servesBad) parts.push(`--serves ${[...(b.pillars || []).map((p) => `pillar:${p.name}`), ...kept].slice(0, 6).join(' | ')} (or --idea <approved idea>)${layerId && b.layers?.[layerId]?.answer === 'no' ? `; ${layerId} is crossed out` : ''}`);
    if (laneMissing) parts.push(LANE_FLAG);
    return { ok: false, message: parts.length === 1 && phaseBad ? 'Build tasks say which part of the game they are for: --phase 1 (early), 2 (mid) or 3 (endgame).' : parts.length === 1 && servesBad ? `Say what this serves: ${parts[0]}.` : `Missing flag${parts.length > 1 ? 's' : ''}:\n${parts.map((x) => `  ${x}`).join('\n')}` };
  }
  const openFloors = (b.phase?.floors || []).map(f => f.n);
  if (phase > (b.phase?.open || 1) && !openFloors.includes(phase)) {
    const openList = [b.phase?.open || 1, ...openFloors].filter(Boolean).sort();
    return { ok: false, message: `Phase ${phase} isn't open yet (open: ${[...new Set(openList)].join(', ')}). Finish and prove the earlier phase first; designing later phases is fine as a study or docs task.` };
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

function addTaskInner({ title, role = 'builder', priority = 'P1', agent = PRODUCER_NAME(), meta = {}, startFor = null, overlap = true }) {
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
  if (meta.requireLane) { const { requireLane: _r, ...rest } = meta; meta = rest; }
  if (['change', 'system'].includes(taskType({ title, role }))) meta = { ...meta, build: true };
  // 2.69.0 (s): overlap with open tasks' lanes, lanes in flight and near-duplicate titles (harness/task-overlap.mjs).
  // Advisory unless STUDIO_OVERLAP=block. A planner's split and a rescue's pieces overlap their parent on purpose.
  const ov = overlap && !meta.splitOf && !fromRescueMeta(meta) ? overlapCheck({ title, role, meta, phase: 'add', agent, board: parseNextQueue() }) : { found: [], lines: [], block: false };
  if (ov.block) return { error: 'overlap', message: ov.lines.join('\n') };
  if (ov.lines.length) gate.warnings.push(...ov.lines);
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
  // 2.77.0 (u, P5.1): an engine pass (--track engine:<name>) keeps its engine, branch, scope and visual check in its own
  // record (.studio/engine/tasks.json): it never falls out of the last 20000 events the way the task.added meta does.
  recordEngineTaskAtAdd(newTask.id, meta);
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

const fromRescueMeta = (meta) => meta?.origin === 'rescue' || meta?.rescueSplit;

/** 2.77.0 (u): the engine targets the studio names (for train status). */
function engineTargetsQuiet() { try { return Object.keys(readJson(path.join(REPO_ROOT, 'studio', 'game.json'))?.engines || {}).filter((n) => /^[a-z][a-z0-9-]{1,30}$/.test(n)); } catch { return []; } }

/** 2.77.0 (u, P5.1): the engine record of a task added on an engine track (harness/engine-tracks.mjs). Never throws. */
function recordEngineTaskAtAdd(id, meta = {}) {
  const m = String(meta.track || '').match(/^engine:([a-z][a-z0-9-]{1,30})$/);
  if (!m) return;
  try {
    const refs = Array.isArray(meta.refs) ? meta.refs : [];
    const rec = { engine: m[1], track: meta.track, branch: typeof meta.branch === 'string' ? meta.branch : null, scope: typeof meta.scope === 'string' ? meta.scope : null, visual: meta.visualCheck || refs.length ? { required: true, refs } : null, by: meta.origin || null };
    const f = path.join(mainRoot(), '.studio', 'engine', 'tasks.json');
    let all = {};
    try { all = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { all = {}; }
    all[id] = { ...rec, at: new Date().toISOString() };
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
    fs.renameSync(tmp, f);
  } catch { /* the task.added event still carries the track */ }
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
        // 2.81 (b2): --claim repeats ("<command> => <last line>" each); every other flag keeps its last value.
        if (k === 'claim') flags[k] = [...(Array.isArray(flags[k]) ? flags[k] : []), next];
        else flags[k] = next;
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

/** 2.71.0 (x): one decision-log record for a board decision (hold, unhold, yes; harness/decisions.mjs). Never throws. */
async function logTaskDecision({ action, subject, by, dg = null, why = '', evidence = '', undo = null }) {
  try {
    const dm = await import('./decisions-log.mjs');
    dm.logDecision({ action, subject, by, as: dg && dg.ok !== false && (dg.ok || dg.via) ? dm.asCaller(dg) : dm.asCaller(null), why, evidence, undo });
  } catch { /* the board's own record stands */ }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  // 2.67.0 (B-47): --help / -h prints usage and exits before anything reads the board or acts (train --help ran a train).
  const help = await import('./task-usage.mjs');
  if (help.wantsHelp(process.argv.slice(2))) {
    const first = process.argv.slice(2).find((a) => !a.startsWith('-'));
    console.log(help.usageFor(first || ''));
    process.exit(0);
  }
  const flags = parseFlags(process.argv.slice(2));
  // 2.71.0 (z): --force and a refused command re-run again and again are detected workarounds (harness/workaround.mjs).
  try { watchCommand('task', process.argv.slice(2), { agent: (typeof flags.agent === 'string' && flags.agent) || (typeof flags.by === 'string' && flags.by) || whoAmI({}, REPO_ROOT, { ...process.env, STUDIO_LOCK_OWNER: '' }) || process.env.STUDIO_LOCK_OWNER || null }); } catch { /* evidence only */ }
  const [cmd = 'next', arg1] = flags._;
  // 2.81 (b4): end sessions whose process is gone, at most once per STUDIO_GONE_CHECK_S (harness/gone-check.mjs). A child
  // process: agent.mjs imports this file, so importing it from here (as the main module) would wait on itself.
  if (cmd === 'next' || cmd === 'start') { try { const gc = await import('./gone-check.mjs'); if (gc.goneDue()) spawnSync(process.execPath, [fileURLToPath(new URL('./gone-check.mjs', import.meta.url))], { windowsHide: true, stdio: 'ignore', timeout: 60000 }); } catch { /* a check, never a crash */ } }
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
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'harness', 'agent.mjs'), 'stop-all', '--by', s.by, '--reason', s.reason || ''], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', env: process.env });
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

  // 2.59.0: the owner reclassifies a task's type (harness/reclassify.mjs): a person in their own terminal, recorded,
  // or signed once the studio has an owner key. Without a type, shows the type and where it comes from.
  if (cmd === 'type') {
    const t = [...q.inProgress, ...q.backlog, ...q.done].find((x) => x.id === arg1);
    if (!t) {
      console.error('Usage: npm run task -- type <TASK_ID> [<change|chore|bug|docs|…|auto> --by <owner> --why "<reason>" [--permission "<the owner\'s words or a link>"]] [--no-commit]');
      process.exit(1);
    }
    const to = flags._[2];
    if (!to) {
      const ty = typeOf(t);
      console.log(`${t.id} is a "${ty.type}" task (${ty.source}).${ty.ignored ? `\nnote: ${ty.ignored}` : ''}`);
      process.exit(0);
    }
    if (q.done.some((x) => x.id === t.id)) {
      console.error(`${t.id} is already done; reopen it first (npm run task -- reopen ${t.id} --reason "…").`);
      process.exit(1);
    }
    const { reclassify } = await import('./reclassify.mjs');
    const r = reclassify({ task: t, from: titleType(t), to, by: typeof flags.by === 'string' ? flags.by : '', why: typeof flags.why === 'string' ? flags.why : '', permission: typeof flags.permission === 'string' ? flags.permission : '', commit: !flags['no-commit'] });
    (r.ok ? console.log : console.error)(r.message);
    process.exit(r.ok ? 0 : 1);
  }

  // 2.60.1 (B-38): the owner's visual-proof decision for a task (harness/reclassify.mjs setVisual), recorded like task type.
  if (cmd === 'visual') {
    const t = [...q.inProgress, ...q.backlog, ...q.done].find((x) => x.id === arg1);
    const to = flags._[2];
    if (!t) {
      console.error('Usage: npm run task -- visual <TASK_ID> [off|on|auto --by <owner> --why "<reason>" [--permission "<the owner\'s words or a link>"]] [--no-commit]');
      process.exit(1);
    }
    if (!to) {
      const d = renderDecision(t);
      console.log(d.by === 'owner' ? `${t.id}: ${d.why}` : `${t.id}: visual proof ${d.render ? 'needed' : 'not needed'}${d.why ? ` (${d.why})` : ''}.${d.warn ? `\nWARN ${d.warn}` : ''}${d.ignored ? `\nnote: ${d.ignored}` : ''}`);
      process.exit(0);
    }
    const { setVisual } = await import('./reclassify.mjs');
    const r = setVisual({ task: t, to, by: typeof flags.by === 'string' ? flags.by : '', why: typeof flags.why === 'string' ? flags.why : '', permission: typeof flags.permission === 'string' ? flags.permission : '', commit: !flags['no-commit'] });
    (r.ok ? console.log : console.error)(r.message);
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'start') {
    const targetId = arg1 || q.backlog[0]?.id;
    if (!targetId) {
      console.error('Usage: node harness/task.mjs start <TASK_ID> --agent <unique-name>');
      process.exit(1);
    }
    // 2.69.0 (s): the task against the work in flight (its lane, its own diff once it has one, near-duplicate titles).
    const startOv = (() => { const t = q.backlog.find((x) => x.id === targetId) || q.inProgress.find((x) => x.id === targetId); return t ? overlapCheck({ id: t.id, title: t.title, role: t.role, phase: 'start', agent: whoAmI(flags), board: q }) : null; })();
    // Advice is printed after the start succeeds (below), so a refused or failed start says its own reason first;
    // a blocking overlap is the refusal itself and is printed here.
    if (startOv?.block) {
      for (const l of startOv.lines || []) console.error(l);
      emitEvent({ type: 'task.start_refused', agent: whoAmI(flags) || undefined, task: targetId, status: 'blocked', msg: `overlap (STUDIO_OVERLAP=block): ${startOv.found.map((f) => f.with).join(', ')}`.slice(0, 400) });
      process.exit(1);
    }
    const started = startTask(targetId, whoAmI(flags), { model: typeof flags.model === 'string' ? flags.model : null, force: Boolean(flags.force) });
    if (!started) {
      console.error(`Task "${targetId}" not found.`);
      process.exit(1);
    }
    if (started.error) {
      // 2.67.2: a refused start is evidence for the session's end record (harness/session-outcome.mjs).
      emitEvent({ type: 'task.start_refused', agent: whoAmI(flags) || undefined, task: targetId, status: 'blocked', msg: `${started.error}: ${started.message || (started.lock?.owner ? `claimed by ${started.lock.owner}` : "can't be claimed right now")}`.slice(0, 400) });
      console.error(started.error === 'locked' && started.lock?.owner && !started.message ? `Task "${targetId}" is claimed by ${started.lock.owner}. Pick another task.` : started.message || `Task "${targetId}" can't be claimed right now. Pick another task.`);
      process.exit(1);
    }
    // 2.76.0 (B-84): a code-writing session claiming from the main checkout gets its lane copy now; none: hand it back.
    const atClaim = (await import('./lane-at-claim.mjs')).laneAtClaim({ agent: whoAmI(flags), task: started.id });
    if (atClaim?.error) {
      pauseTask(started.id, whoAmI(flags), `${whoAmI(flags)} claimed ${started.id} from the main checkout and ${atClaim.error}; a builder session never works in the main checkout. Start it again once a lane copy can be made (npm run lanes shows the copies).`, { force: true });
      console.error(`${started.id} handed back: ${atClaim.error}. A builder session never works in the main checkout.`);
      process.exit(1);
    }
    if (atClaim) for (const l of (await import('./lane-at-claim.mjs')).laneAtClaimLines(atClaim)) console.error(l);
    // 2.30c (#4): short output. The brief's path and a 10-line summary; the carry-forward note (newest
    // notes, at most 3k characters) replaces re-reading the whole hand-off history.
    if (started.brief) console.error(`Your brief: ${started.brief} (read it instead of the repo)\n${startSummary(started)}`);
    if (started.carried) console.error(`The earlier agent's commits on ${started.carried} are merged into your copy.`);
    if (started.mixedSkipped) console.error(`MIXED LANE NOT MERGED: ${started.mixedSkipped}`); // 2.77.0 (f, P2.4)
    if (started.research) console.error(`Research task: write it up in ${started.research} (the template is there): every source with its link; task done refuses a write-up without them.`);
    if (started.handoff) console.error(`Picking up where someone else stopped. Carry-forward note (newest, at most 3k characters; all of it in studio/handoffs/${started.id}.md):\n${carryForward(started.handoff, started.id)}`);
    for (const l of startOv?.lines || []) console.error(l); // 2.69.0 (s): overlap advice, once the task is started
    (await import('./hotspots.mjs')).warnAt('start', { task: started.id, agent: whoAmI(flags) }); // 2.60.0: lines several lanes change
    await startDiskWarning(); // 2.68.0 (m)
    const { handoff, ...rest } = started;
    console.log(JSON.stringify({ ...rest, ...(handoff ? { handoffFile: `studio/handoffs/${started.id}.md` } : {}), ...(atClaim ? { laneCopy: atClaim.rel, laneDir: atClaim.dir } : {}) }, null, 2));
    process.exit(0);
  }

  // PU-58: the honest exit. A task that contradicts itself, or can't be done without bending a check, is released
  // with the why and held for the Producer. Not a failure: no loop park, breaker, no-work park or escalation.
  if (cmd === 'impossible') {
    const targetId = arg1;
    const who = whoAmI(flags);
    const why = typeof flags.why === 'string' ? flags.why.replace(/\s+/g, ' ').trim() : '';
    if (!targetId || !who || why.length < 10) {
      console.error('Usage: npm run task -- impossible <TASK_ID> --why "<10+ characters: what contradicts what>" --agent <you>\nUse it when the task contradicts itself or can\'t be done without bending a check; it is not a failure.');
      process.exit(1);
    }
    const cur = lockStatus(`task:${targetId}`);
    if (!parseNextQueue().inProgress.some((t) => t.id === targetId) || (cur.locked && cur.lock.owner !== who)) {
      console.error(`${targetId} isn't a task ${who} holds; start it first (npm run task -- start ${targetId} --agent ${who}).`);
      process.exit(1);
    }
    const model = modelFor(targetId, who);
    const res = pauseTask(targetId, who, `Impossible as written: ${why}`, { cause: 'impossible' });
    if (!res || res.error) { console.error(res?.message || `${targetId} could not be released.`); process.exit(1); }
    const heldWhy = `impossible as written (reported by ${who}): ${why}`.slice(0, 400);
    setHold(targetId, { parked: { by: 'producer', why: heldWhy, at: new Date().toISOString(), impossible: true } }, { by: who, msg: `${targetId} held for the Producer: ${heldWhy}`.slice(0, 500) });
    emitEvent({ type: 'task.impossible', agent: who, to: 'producer', task: targetId, model, status: 'blocked', msg: `${targetId} is impossible as written (${who}): ${why}`.slice(0, 600), meta: { why, model } });
    postAsk({ agent: who, to: 'producer', task: targetId, subject: 'parked', msg: `${targetId} can't be done as written: ${why}. It is released and held for you; fix the task, then npm run task -- unpark ${targetId} --by <name>.`.slice(0, 600) });
    try { canaryEnd(targetId, 'honest', { agent: who, model }); } catch { /* a record, never a blocker */ }
    console.log(`${targetId} released as impossible and held for the Producer. Not a failure. Pick another task: npm run task -- next.`);
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
      console.error('Usage: node harness/task.mjs done <TASK_ID> --agent <owner> [--check] [--train [--branch <Unity branch>]] [--note "..."] [--force --reason "<10+ chars>"]');
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
    // 2.77.0 (n, B-92): a pinned session (STUDIO_TASK_PIN, set by the launcher) closes or queues only its own task.
    if (!flags.check && !flags['train-check']) {
      const pinWhy = pinRefusal(targetId, { action: flags.train ? 'train' : 'done' });
      if (pinWhy) {
        emitEvent({ type: 'task.done_refused', agent: whoAmI(flags) || undefined, task: targetId, status: 'blocked', msg: `pinned: ${pinWhy}`.slice(0, 400), meta: { pin: process.env.STUDIO_TASK_PIN || null, train: Boolean(flags.train) } });
        console.error(`${pinWhy} Nothing was closed or queued.`);
        process.exit(1);
      }
    }
    // 2.30n: a forced done says why (10+ characters); "no reason given" taught the Producer nothing.
    if (flags.force && String(typeof flags.reason === 'string' ? flags.reason : '').trim().length < 10) {
      console.error(`--force needs --reason "<why the check can't pass yet>" (10+ characters). Nothing was closed.`);
      process.exit(1);
    }
    // 2.30q (#8): --usage <model>:<in>/<out> (comma-separated for several models): a builder launched outside
    // the harness reports its own tokens; the ledger shows them as untracked (self-reported).
    if (flags.usage !== undefined) { const u = reportUsage(targetId, whoAmI(flags), flags.usage); if (u.error) { console.error(u.error); process.exit(1); } }
    // 2.81 (b2): --claim "<command> => <last line>" (repeatable): re-run and compared at done (harness/said-vs-did.mjs).
    const claimFlags = Array.isArray(flags.claim) ? flags.claim : typeof flags.claim === 'string' ? [flags.claim] : [];
    // 2.30q (#6): while done runs (gates, landing: often 10+ min), the task counts as busy for the
    // Director's flow pass, the stall check and the watchdog (harness/busy.mjs).
    if (flags.check) {
      const pre = completeTask(targetId, typeof flags.note === 'string' ? flags.note : '', whoAmI(flags), { checkOnly: true, noop: typeof flags['no-op'] === 'string' ? flags['no-op'] : '', claims: claimFlags });
      if (!pre) { console.error(`Task "${targetId}" not found.`); process.exit(1); }
      console.log(pre.error ? pre.message : pre.message);
      // 2.79.1 (3.2): the Line Producer reads this as "a land may be near" for an engine pass (harness/engine-ram.mjs).
      if (!pre.error) { try { emitEvent({ type: 'task.done_check', agent: whoAmI(flags), task: targetId, msg: `${targetId}: done --check passed` }); } catch {} }
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
      // 2.63.0: a Unity-track task queues its Unity branch for the Unity merge train (harness/unity-train.mjs).
      // 2.77.0 (u, P5.2/P5.6): any engine target with a land command trains on its own engine train.
      // 2.78.2 (g, item 18): one verdict (engine-tracks.mjs engineTrainVerdict): a track written "unity" reads as
      // engine:unity, and an engine pass it can't queue says why instead of going on as a studio lane in silence.
      const roleOf = (() => { try { const q0 = parseNextQueue(); return [...q0.inProgress, ...q0.backlog].find((t) => t.id === targetId)?.role || null; } catch { return null; } })();
      const tv = (() => { try { return engineTrainVerdictOf(targetId, { role: roleOf }); } catch (e) { return { engine: null, engineTask: false, note: `could not read its engine track (${e.message})` }; } })();
      if (!tv.engine && tv.engineTask) {
        const msg = `${targetId} was not queued: it is an engine pass, but ${tv.why}. ${tv.fix ? `Fix: ${tv.fix}, then run task done --train again.` : ''}`.trim();
        emitEvent({ type: 'task.train.not_queued', agent: whoAmI(flags), task: targetId, to: 'producer', status: 'blocked', msg: msg.slice(0, 600), meta: { why: tv.why } });
        console.error(msg);
        process.exit(1);
      }
      if (tv.note) console.log(`[task done] ${tv.note}`);
      const trainEngine = tv.engine || null;
      if (trainEngine) {
        // --branch is recorded first, so the done check looks at that branch in the engine repo.
        if (typeof flags.branch === 'string' && flags.branch) { try { (await import('./engine-tracks.mjs')).setEngineTask(targetId, { engine: trainEngine, branch: flags.branch }); } catch {} }
        const pre = completeTask(targetId, '', whoAmI(flags), { unityTrainCheck: true, noop: noopFlag });
        if (!pre) { console.error(`Task "${targetId}" not found.`); process.exit(1); }
        if (pre.error) { console.error(pre.message); process.exit(1); }
        const r = (await import('./unity-train.mjs')).queueUnityTask(mainRoot(), { engine: trainEngine, task: pre.id, agent: whoAmI(flags), alone: flags.alone ? true : null, branch: typeof flags.branch === 'string' ? flags.branch : null, note: typeof flags.note === 'string' ? flags.note : '' });
        (r.ok ? console.log : console.error)(r.message);
        process.exit(r.ok ? 0 : 1);
      }
      process.exit(await queueLaneForTrain(targetId, flags, noopFlag));
    }
    // 2.78.2 (a, W-0090): in a lane copy with commits to land, task done queues the lane and a train lands it outside
    // this shell (it died with the builder's command at Claude Code's 10-minute limit or the session cap).
    // STUDIO_DONE_QUEUE=0/off: the train runs here, as before 2.78.2.
    if ((await import('./train-detach.mjs')).doneQueueOn() && !flags.force && !flags['accepted-by'] && inLaneCopy()) {
      const { trainOn } = await import('./train.mjs');
      let lb = '';
      try { lb = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim(); } catch {}
      if (trainOn() && lb && unmerged(lb) > 0) process.exit(await queueLaneForTrain(targetId, flags, noopFlag, { kick: true }));
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
      try { laneBranch = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim(); } catch {}
      const viaTrain = inLaneCopy() && trainOn() && !flags.force && !flags['accepted-by'] && laneBranch && unmerged(laneBranch) > 0;
      // 2.63.0: a tier C lane (harness code, protected files, deleted tests or regressions, irreversible files, upgrade
      // merges) lands only through the merge train after a person releases it. STUDIO_TRAIN=off, --force and
      // --accepted-by take the old path, which has no tiers, so they can't carry a tier C lane past that hold.
      if (!viaTrain && inLaneCopy() && laneBranch && unmerged(laneBranch) > 0) {
        const { laneTier } = await import('./train.mjs');
        const { tierLine } = await import('./tiers.mjs');
        let tier = null;
        try { tier = await laneTier(mainRoot(), { head: spawnSync('git', ['rev-parse', 'HEAD'], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim(), task: targetId }); } catch {}
        // 2.65.0 (B-40): a config proposal that can't be applied (or conflicts with main) is the first thing to fix.
        let cpBad = null;
        try { const lb = laneConfigBefore(mainRoot(), { task: targetId, laneDir: REPO_ROOT, main: mainBranchOf(mainRoot()), ff: landFastForward }); if (lb.refuse) cpBad = lb.refuse; } catch {}
        if (cpBad) {
          emitEvent({ type: 'task.not_done', agent: whoAmI(flags), task: targetId, status: 'blocked', msg: `${targetId} not done: ${cpBad.split('.')[0]}`.slice(0, 400) });
          done = { error: 'not-delivered', message: `${targetId} is not done: ${cpBad}` };
        } else if (tier?.tier === 'C') {
          emitEvent({ type: 'task.not_done', agent: whoAmI(flags), task: targetId, status: 'blocked', msg: `${targetId} not done: tier C lands only through the merge train after a person releases it` });
          done = { error: 'tier-c', message: `${targetId} is not done: this lane is ${tierLine(tier)}. A tier C lane lands only through the merge train once a person releases it: npm run task -- done ${targetId} --train, then npm run task -- train release ${targetId} --by <person> [--permission "<their words or a link>"]. STUDIO_TRAIN=off, --force and --accepted-by don't skip that.` };
        }
      }
      if (done) { /* refused above */ } else
      if (viaTrain) {
        const pre = completeTask(targetId, typeof flags.note === 'string' ? flags.note : '', whoAmI(flags), { trainCheck: true, noop: noopFlag, claims: claimFlags });
        if (!pre || pre.error) done = pre;
        else {
          const { runTrain } = await import('./train.mjs');
          // 2.63.0: it rides along with lanes already queued for the next train (one verify for all); only this lane's
          // result is the caller's. How long it waits for a running train: STUDIO_TRAIN_LOCK_WAIT_MIN (before 2.63.0
          // STUDIO_TRAIN_WAIT_MIN, still read when the new one is unset), 120.
          const lockWait = Number([process.env.STUDIO_TRAIN_LOCK_WAIT_MIN, process.env.STUDIO_TRAIN_WAIT_MIN].map((v) => String(v ?? '').trim()).find((v) => v !== '' && Number.isFinite(Number(v))) ?? 120);
          const r = await runTrain({ root: mainRoot(), lanes: [{ task: pre.id, agent: whoAmI(flags), dir: REPO_ROOT, branch: pre.branch, head: pre.head, all: pre.all, prechecked: true, note: typeof flags.note === 'string' ? flags.note : '' }], oneLane: true, rideAlong: !/^(off|0|false|no)$/i.test(String(process.env.STUDIO_TRAIN_RIDE_ALONG || '')), by: whoAmI(flags) || 'task-done', waitMs: lockWait * 60000, deps: trainDeps(busyMod, { forDone: true }) });
          const others = r.landed.filter((t) => t !== pre.id);
          if (others.length) console.error(`[task done] ${others.join(', ')} rode along in the same train (queued lanes) and landed too.`);
          const mine = (list) => (list || []).find((x) => x.task === pre.id);
          const unclosed = mine(r.unclosed);
          if (r.landed.includes(pre.id) && !unclosed) done = (r.closed || []).find((t) => t?.id === pre.id) || { id: pre.id, status: 'done' };
          else if (mine(r.held)) {
            const h = mine(r.held);
            done = { error: 'held', message: `${pre.id} is not done: it needs the owner (tier ${h.tier}: ${h.why}). It waits in the train queue until a person releases it (npm run task -- train release ${pre.id} --by <name>); then the next train lands it. You can stop here: npm run task -- pause ${pre.id} --note "waits for the owner's release".` };
          } else {
            const why = unclosed?.why || mine(r.dropped)?.why || mine(r.deferred)?.why || (r.landed.includes(pre.id) ? 'it landed but stays open: its copy gained commits after the check (they land with the next task done)' : r.message);
            emitEvent({ type: 'task.not_done', agent: whoAmI(flags), task: pre.id, status: 'blocked', msg: `${pre.id} not done yet: ${String(why).split('\n')[0].slice(0, 300)}` });
            done = { error: 'not-delivered', message: `${pre.id} is not done: ${why}` };
          }
        }
      } else {
        done = completeTask(targetId, flags.note || '', whoAmI(flags), { force: Boolean(flags.force), reason: typeof flags.reason === 'string' ? flags.reason : '', acceptedBy: typeof flags['accepted-by'] === 'string' ? flags['accepted-by'] : '', noop: noopFlag, claims: claimFlags });
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
    // 2.83: a word that is not a train subcommand starts nothing (`train log --engine unity` and a mistyped word started a
    // real train): usage, exit 2. A train starts with `train`, `train run` or `train --engine <name>`.
    if ((arg1 && !['run', 'status', 'release', 'leave', 'dequeue', 'auto', 'config', 'cancel'].includes(arg1)) || (typeof flags.unity === 'string' && flags.unity !== 'status')) {
      console.error(`"${arg1 || flags.unity}" is not a train subcommand, so no train was started. Usage: npm run task -- train [run] [--engine <name>] | train status [--engine <name>] | train release <ID> | train leave <ID> --by <name> --why "…" | train dequeue <ID> [--engine <name>] --by <name> | train cancel | train config <ID> | train auto [on|off]`);
      process.exit(2);
    }
    const tr = await import('./train.mjs');
    // 2.78.2 (a, W-0090): from an agent's shell the train runs detached (it outlives the shell) and this command follows
    // it (harness/train-detach.mjs; STUDIO_TRAIN_DETACH auto|on|off, --detach / --foreground).
    if ((!arg1 || arg1 === 'run') && !flags.status) {
      const dt = await import('./train-detach.mjs');
      dt.recordFollowedExit();
      if (dt.detachTrain(flags)) { const code = await dt.followDetached({ root: mainRoot(), argv: process.argv.slice(2) }); if (code !== null) process.exit(code); }
    }
    // 2.63.0: the Unity merge train (harness/unity-train.mjs): `train --unity` (or --track engine:unity).
    // 2.77.0 (u, P5.6): `train --engine <name>` (or --track engine:<name>) for any engine target; --unity is --engine unity.
    const trainEng = typeof flags.engine === 'string' ? flags.engine : flags.unity ? 'unity' : engineOfTrack(flags.track);
    // 2.83: only a plain train (or its status) is an engine train: `train leave|dequeue … --engine x` is that subcommand, not a run.
    if (trainEng && (!arg1 || arg1 === 'run' || arg1 === 'status')) {
      const ut = await import('./unity-train.mjs');
      if (arg1 === 'status' || flags.unity === 'status' || flags.status) { console.log(ut.unityStatusText(mainRoot(), { engine: trainEng })); process.exit(0); }
      const busyMod = await import('./busy.mjs');
      const r = await ut.runUnityTrain({ engine: trainEng, root: mainRoot(), max: flags.max ? Number(flags.max) : 0, dryRun: Boolean(flags['dry-run']), by: typeof flags.by === 'string' ? flags.by : whoAmI(flags) || process.env.STUDIO_LOCK_OWNER || 'human', waitMs: Number(flags.wait || 0) * 60000, deps: trainDeps(busyMod) });
      (r.ok ? console.log : console.error)(r.message);
      console.log(JSON.stringify({ unityTrain: r.id, engine: trainEng, landed: r.landed, dropped: r.dropped, deferred: r.deferred, runs: r.runs ?? 0, ...(r.refused ? { refused: r.refused } : {}), ...(r.busy ? { busy: r.busy } : {}) }, null, 2));
      process.exit(r.ok ? 0 : r.refused ? 3 : 1);
    }
    if (arg1 === 'status' || flags.status) {
      const qd = tr.readQueue(mainRoot());
      console.log(qd.length ? `${qd.length} lane(s) wait for the next train:\n${qd.map((e) => `  ${e.task}  ${e.agent}  ${e.branch} at ${String(e.head).slice(0, 8)} (queued ${String(e.at).slice(0, 16)})${tr.heldNow(e) ? `  NEEDS THE OWNER (tier ${e.held.tier}: ${String(e.held.why).slice(0, 160)}; train release ${e.task} --by <name>)` : e.released && e.released.head === e.head ? `  released by ${e.released.by}` : ''}${e.after?.task ? `  after ${e.after.task} (predicted conflict)` : ''}${tr.taskHoldOf(mainRoot(), e.task) ? `  OUT OF TRAINS: ${tr.heldOutWhy(tr.taskHoldOf(mainRoot(), e.task)).replace('<ID>', e.task)}` : ''}`).join('\n')}` : 'No lane waits for a train (task done <ID> --train queues one).');
      { const kl = (await import('./known-red.mjs')).knownRedLine(mainRoot()); if (kl) console.log(kl); } // 2.77.0 (P9.3)
      { const um = await import('./unity-train.mjs'); const names = new Set(['unity', ...engineTargetsQuiet()]); for (const e of names) { const ut = um.unityStatusText(mainRoot(), { quiet: true, engine: e }); if (ut) console.log(ut); } } // 2.63.0: the Unity train; 2.77.0: every engine's
      // 2.77.0 (p, P9.6): the running train and the speculative one behind it, with their steps.
      try { const ts = await import('./train-status.mjs'); const rs = ts.readTrainStatus(mainRoot()); if (rs) console.log(ts.trainsText(rs)); } catch {}
      process.exit(0);
    }
    // 2.83: `train dequeue <ID> [--engine <name>]` takes a lane out of the queue (the game's, or that engine's) and hands the
    // task back, as the train does when it drops a lane. A lane in a train that runs right now is refused.
    if (arg1 === 'dequeue') {
      const tid = flags._[2];
      const by = typeof flags.by === 'string' ? flags.by : whoAmI(flags) || process.env.STUDIO_LOCK_OWNER || 'human';
      if (!tid) { console.error('Usage: npm run task -- train dequeue <TASK_ID> [--engine <name>] [--by <name>]'); process.exit(1); }
      const eng = typeof flags.engine === 'string' ? flags.engine : flags.unity ? 'unity' : null;
      const ut = eng ? await import('./unity-train.mjs') : null;
      const queue = eng ? ut.readUnityQueue(mainRoot(), eng) : tr.readQueue(mainRoot());
      const entry = queue.find((e) => e.task === tid);
      const which = eng ? `the ${eng} train queue` : 'the train queue';
      if (!entry) { console.error(`${tid} is not in ${which}; nothing was changed (npm run task -- train status${eng ? ` --engine ${eng}` : ''} lists it).`); process.exit(1); }
      const running = eng ? (ut.runningUnityTrain(mainRoot(), eng)?.lanes || []).includes(tid) : Boolean((await import('./train-status.mjs')).readTrainStatus(mainRoot())?.train);
      if (running) { console.error(`${tid} is in a train that is running right now; it was not taken out. Wait for the train, or stop it: npm run task -- train cancel --by <name>${eng ? '' : `, or train leave ${tid} --by <name> --why "…" (the train stops before its next check)`}.`); process.exit(1); }
      if (eng) ut.dequeueUnity(mainRoot(), tid, eng); else tr.dequeue(mainRoot(), tid);
      emitEvent({ type: 'task.train.dequeued', agent: by, task: tid, to: entry.agent || undefined, status: 'warn', msg: `${tid} was taken out of ${which} by ${by}`, meta: { head: entry.head || null, branch: entry.branch || null, ...(eng ? { engine: eng } : {}) } });
      // The train hands a lane back (pauseTask: the task goes back to the open list and its claim is released), so it can be started again.
      let back = null;
      try { back = pauseTask(tid, entry.agent || null, `Taken out of ${which} by ${by}; nothing failed. Start it again and queue it with task done ${tid} --train.`, { force: true, cause: 'person' }); } catch { back = null; }
      console.log(`${tid} is out of ${which}${back && !back.error ? ' and handed back: it can be started again' : ''}.`);
      process.exit(0);
    }
    // 2.63.0: a person (or an agent with a person's direct permission; never a worker) releases a lane held for the owner.
    if (arg1 === 'release') {
      const tid = flags._[2];
      if (!tid || typeof flags.by !== 'string') { console.error('Usage: npm run task -- train release <TASK_ID> --by <the person> [--permission "<their words or a link>"]'); process.exit(1); }
      const r = tr.releaseLane(mainRoot(), tid, { by: flags.by, permission: typeof flags.permission === 'string' ? flags.permission : '' });
      (r.ok ? console.log : console.error)(r.message);
      process.exit(r.ok ? 0 : 1);
    }
    // 2.67.2: take a queued lane out of the train queue on purpose, recorded (who, why); never a worker.
    if (arg1 === 'leave') {
      const tid = flags._[2];
      if (!tid || typeof flags.by !== 'string') { console.error('Usage: npm run task -- train leave <TASK_ID> --by <name> --why "…"'); process.exit(1); }
      const r = await tr.leaveTrain(mainRoot(), tid, { by: flags.by, why: typeof flags.why === 'string' ? flags.why : '' });
      (r.ok ? console.log : console.error)(r.message);
      process.exit(r.ok ? 0 : 1);
    }
    // 2.69.0 (r): the train daemon's switch (harness/train-daemon.mjs; decider rules: a person, never a worker).
    if (arg1 === 'auto') {
      const want = flags._[2];
      const td = await import('./train-daemon.mjs');
      if (!want) { console.log(td.autoStatusText(mainRoot())); process.exit(0); }
      if (!/^(on|off)$/.test(want) || typeof flags.by !== 'string') { console.error('Usage: npm run task -- train auto off|on --by <name> [--why "…"] [--permission "<their words or a link>"]'); process.exit(1); }
      const r = await td.setTrainAuto(mainRoot(), { on: want === 'on', by: flags.by, why: typeof flags.why === 'string' ? flags.why : '', permission: typeof flags.permission === 'string' ? flags.permission : '' });
      (r.ok ? console.log : console.error)(r.message);
      process.exit(r.ok ? 0 : 1);
    }
    // 2.65.0 (B-40): apply a config proposal held on main (its protected part waited for the owner, or main moved a key).
    if (arg1 === 'config') {
      const tid = flags._[2];
      if (!tid) { console.error('Usage: npm run task -- train config <TASK_ID> [--by <the person> [--permission "<their words or a link>"]]'); process.exit(1); }
      const r = tr.applyHeldConfig(mainRoot(), tid, { by: typeof flags.by === 'string' ? flags.by : '', permission: typeof flags.permission === 'string' ? flags.permission : '' });
      (r.ok ? console.log : console.error)(r.message);
      process.exit(r.ok ? 0 : 1);
    }
    // 2.78.2 (a): stop the running train cleanly (harness/train-cancel.mjs): a person, the orchestrator or a Producer.
    if (arg1 === 'cancel') {
      const tid = flags._[2] || null;
      if (typeof flags.by !== 'string') { console.error('Usage: npm run task -- train cancel [<train id>] --by <name> [--why "…"]'); process.exit(1); }
      const r = await (await import('./train-cancel.mjs')).cancelTrain(mainRoot(), { id: tid, by: flags.by, why: typeof flags.why === 'string' ? flags.why : '' });
      (r.ok ? console.log : console.error)(r.message);
      process.exit(r.ok ? 0 : 1);
    }
    if (arg1 && arg1 !== 'run') { console.error('Usage: npm run task -- train [--unity | --engine <name>] [--max N] [--now] [--dry-run] [--by <name>] [--wait <min>] [--detach | --foreground] | train status | train release <ID> --by <name> [--permission "…"] | train leave <ID> --by <name> --why "…" | train cancel [<train id>] --by <name> [--why "…"] | train config <ID> [--by <name>] | train auto [off|on --by <name>]'); process.exit(1); }
    const busyMod = await import('./busy.mjs');
    const by = typeof flags.by === 'string' ? flags.by : whoAmI(flags) || process.env.STUDIO_LOCK_OWNER || 'human';
    const r = await tr.runTrain({ root: mainRoot(), max: flags.max ? Number(flags.max) : 0, dryRun: Boolean(flags['dry-run']), now: Boolean(flags.now), by, waitMs: Number(flags.wait || 0) * 60000, deps: trainDeps(busyMod) });
    (r.ok ? console.log : console.error)(r.message);
    console.log(JSON.stringify({ train: r.id, ...(r.trains ? { trains: r.trains } : {}), landed: r.landed, dropped: r.dropped, deferred: r.deferred, ...(r.held?.length ? { held: r.held.map(({ fresh, ...h }) => h) } : {}), ...(r.tiers && Object.keys(r.tiers).length ? { tiers: r.tiers } : {}), verifies: r.verifies ?? 0, reused: r.reused ?? 0, ...(r.rechecks ? { rechecks: r.rechecks } : {}), ...(r.pinRefresh ? { pinRefresh: r.pinRefresh } : {}), ...(r.union ? { union: r.union } : {}), ...(r.redMain ? { redMain: true } : {}), ...(r.noCheck ? { noCheck: r.noCheck } : {}), ...(r.busy ? { busy: r.busy } : {}) }, null, 2));
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
  // 2.60.1 (B-39): a lane held for landing on purpose (a conductor's hand-built merge chain): no claim clock, no rescue.
  // 2.65.0: a conductor's ruling kept in the task's record (harness/conductor.mjs); never from a worker.
  if (cmd === 'note') {
    const { addConductorNote } = await import('./conductor.mjs');
    const ids = new Set([...q.inProgress, ...q.backlog, ...q.done].map((x) => x.id));
    const r = addConductorNote(arg1, flags._.slice(2).join(' ') || (typeof flags.note === 'string' ? flags.note : ''), { by: typeof flags.by === 'string' ? flags.by : '', known: (id) => ids.has(id) });
    if (!r.ok) { console.error(r.why); process.exit(r.why.startsWith('Refused') ? 3 : 1); }
    console.log(`Noted on ${arg1} (studio/handoffs/${arg1}.conductor.md): ${r.line.replace(/^- /, '')}`);
    process.exit(0);
  }

  // 2.83: a task's --after list (studio/task-holds.json): add ids, --remove some, --set a new list, --clear it.
  // 2.83: `task alone <ID> [on|off]`: an engine task whose branch must land by itself (a switch-over, a change that
  // has to be judged alone). The engine train gives it a land run of its own; task done --train --alone does the same.
  if (cmd === 'alone') {
    const on = !/^(off|no|false|0)$/i.test(String(process.argv[4] || 'on'));
    if (!/^[A-Z]+-\d+$/.test(String(arg1 || ''))) { console.error('Usage: npm run task -- alone <TASK_ID> [on|off]'); process.exit(2); }
    const et = await import('./engine-tracks.mjs');
    const rec = et.engineTask(arg1);
    if (!rec) { console.error(`${arg1} is not an engine task (task track ${arg1} engine:<name> first): only an engine train lands a branch alone.`); process.exit(1); }
    et.setEngineTask(arg1, { engine: rec.engine, ...(rec.track ? { track: rec.track } : {}), ...(rec.branch ? { branch: rec.branch } : {}), alone: on });
    try { const ut = await import('./unity-train.mjs'); const q = ut.readUnityQueue(mainRoot(), rec.engine).find((e) => e.task === arg1); if (q) ut.queueUnityTask(mainRoot(), { engine: rec.engine, task: arg1, agent: q.agent, branch: q.branch, note: q.note || '', alone: on }); } catch { /* the record is what counts */ }
    emitEvent({ type: 'task.alone', agent: actor(), task: arg1, msg: `${arg1} ${on ? 'lands alone: the engine train gives its branch a land run of its own' : 'may land in a batch again'}`, meta: { alone: on } });
    console.log(`${arg1} ${on ? `lands alone on the ${rec.engine} train (a land run of its own).` : 'may land in a batch again.'}`);
    process.exit(0);
  }
  if (cmd === 'after') {
    const by = typeof flags.by === 'string' ? flags.by : actor();
    const ids = (v) => (typeof v === 'string' ? v.split(/[,\s]+/).filter(Boolean) : []);
    const t = [...q.inProgress, ...q.backlog, ...q.done].find((x) => x.id === arg1);
    if (!t) {
      console.error(`${arg1 ? `${arg1} is not a task on the board.` : 'Say which task.'} Usage: npm run task -- after <TASK_ID> <T-x>[,<T-y>] | --remove <T-x>[,<T-y>] | --set <T-x>[,<T-y>] | --clear [--by <name>]`);
      process.exit(1);
    }
    const cur = readHolds()[t.id]?.after || [];
    let next;
    let what;
    if (flags.clear) { next = []; what = 'cleared its list'; }
    else if (flags.remove !== undefined) { const drop = ids(flags.remove); next = cur.filter((x) => !drop.includes(x)); what = `removed ${drop.join(', ') || 'nothing'}`; }
    else {
      const given = flags.set !== undefined ? ids(flags.set) : flags._.slice(2).flatMap(ids);
      if (!given.length && flags.set === undefined) { console.error(`Say what it waits for: npm run task -- after ${t.id} <T-x>[,<T-y>] | --remove <T-x> | --set <T-x>,<T-y> | --clear`); process.exit(1); }
      const bad = unknownAfter(given);
      if (bad) { console.error(`${t.id}'s list is unchanged. ${bad}`); process.exit(1); }
      if (given.includes(t.id)) { console.error(`${t.id}'s list is unchanged: a task can't wait for itself.`); process.exit(1); }
      next = flags.set !== undefined ? [...new Set(given)] : [...new Set([...cur, ...given])];
      what = flags.set !== undefined ? 'replaced its list' : `added ${given.join(', ')}`;
    }
    setHold(t.id, { after: next.length ? next : null }, { by, msg: `${by}: ${t.id} ${what}; it now ${next.length ? `waits for ${next.join(', ')}` : 'waits for no task'}` });
    console.log(next.length ? `${t.id} now waits for: ${next.join(', ')}.` : `${t.id} now waits for no task.`);
    process.exit(0);
  }

  if (cmd === 'hold' || cmd === 'unhold') {
    const t = [...q.inProgress, ...q.backlog].find((x) => x.id === arg1);
    const by = typeof flags.by === 'string' ? flags.by.trim() : '';
    if (!t || (cmd === 'hold' && typeof flags.why !== 'string')) {
      console.error(`Usage: npm run task -- ${cmd} <TASK_ID> --by <name>${cmd === 'hold' ? ' --why "<what it waits for: the merge chain, the next train …>"' : ''}`);
      process.exit(1);
    }
    const refused = holdRefusal(by);
    if (refused) { console.error(refused); process.exit(1); }
    // 2.67.0: under the owner's standing delegation the record says so (harness/delegation.mjs).
    const dl = await import('./delegation.mjs');
    const dg = dl.delegationFor({ action: 'hold', by });
    const under = dg.ok ? ` (${(dg.autonomous ? dg.permission : dl.delegationWords({ at: dg.at, by: dg.owner })).slice(0, 160)})` : '';
    if (dg.ok) dl.recordUse(dg, { action: 'hold', task: t.id, detail: cmd });
    if (cmd === 'unhold') {
      if (!readHolds()[t.id]?.held) { console.log(`${t.id} isn't held.`); process.exit(0); }
      const wasHeld = readHolds()[t.id]?.held;
      setHold(t.id, { held: null });
      emitEvent({ type: 'task.unheld', agent: by, task: t.id, msg: `${by} released ${t.id}: its claim clock runs again${under}`, ...(dg.ok ? { meta: { delegation: dg.at, owner: dg.owner, ...(dg.autonomous ? { autonomous: true } : {}) } } : {}) });
      await logTaskDecision({ action: 'hold', subject: t.id, by, dg, why: `unhold (was held: ${wasHeld?.why || '?'})`, evidence: 'unhold', undo: { kind: 'hold', task: t.id, held: wasHeld || null, text: `npm run task -- hold ${t.id} --by <name> --why "…"` } });
      console.log(`${t.id} is no longer held: its claim clock runs again.`);
      process.exit(0);
    }
    const why = String(flags.why).trim();
    const was = readHolds()[t.id]?.parked;
    setHold(t.id, { held: { by, why, at: new Date().toISOString(), ...(dg.ok ? { delegation: dg.at, owner: dg.owner } : {}) } });
    emitEvent({ type: 'task.held', agent: by, task: t.id, to: 'producer', msg: `${by} holds ${t.id} for landing${under}: ${why}`.slice(0, 400), meta: { why, ...(dg.ok ? { delegation: dg.at, owner: dg.owner } : {}), ...(dg.autonomous ? { autonomous: true } : {}) } });
    await logTaskDecision({ action: 'hold', subject: t.id, by, dg, why, evidence: 'hold for landing', undo: { kind: 'unhold', task: t.id, text: `npm run task -- unhold ${t.id} --by <name>` } });
    // A stop by the claim clock while it waited to land wasn't a stuck lane: the park is lifted (and the budget count
    // starts again), and its waiting rescues are closed.
    if (was?.budget) setHold(t.id, { parked: null }, { by, msg: `${by} unparked ${t.id}: held for landing, not stuck (${why})`.slice(0, 400) });
    const closed = closeRescuesFor(t.id, { by, why: `is held for landing by ${by} (${why})`, board: { parseNextQueue, dropTask } });
    console.log(`${t.id} is held for landing by ${by}: its claim clock is stopped and no rescue is filed for it until it lands or someone runs npm run task -- unhold ${t.id} --by <name>.${was?.budget ? ' Its budget park is lifted.' : ''}${closed.length ? ` Rescues: ${closed.map((c) => `${c.id} ${c.action === 'closed' ? 'closed' : '(claimed: its claimant was told)'}`).join(', ')}.` : ''}`);
    process.exit(0);
  }
  if (['block', 'park', 'unpark', 'lane', 'holds', 'track'].includes(cmd)) {
    const by = typeof flags.by === 'string' ? flags.by : actor();
    const all = [...q.inProgress, ...q.backlog, ...q.done];
    if (cmd === 'holds') {
      const h = readHolds();
      const rows = Object.entries(h).map(([id, x]) => `${id}: ${[x.parked ? `parked (${x.parked.by}: ${x.parked.why || ''})` : '', x.held ? `held for landing (${x.held.by}: ${x.held.why || ''})` : '', x.after?.length ? `after ${x.after.join(', ')}` : '', x.until ? `until ${x.until}` : '', x.cooldownUntil ? `cooldown until ${x.cooldownUntil.slice(11, 16)} UTC` : '', 'lane' in x ? `lane ${x.lane || 'whole game'}` : ''].filter(Boolean).join('; ')}`);
      console.log(rows.length ? rows.join('\n') : 'No holds: every waiting task can start.');
      process.exit(0);
    }
    if (!arg1 || !all.some((t) => t.id === arg1)) {
      console.error(`Usage: npm run task -- ${cmd} <TASK_ID> ${cmd === 'block' ? '--until <T-ID|ISO time> ' : cmd === 'lane' ? '<folder|none> ' : cmd === 'track' ? 'engine:<name> ' : ''}--by <name>${cmd === 'park' ? ' --why "…" [--until T-ID|phase:N|time]' : ''}`);
      process.exit(1);
    }
    if (cmd === 'track') {
      // 2.78.2 (item 7d): an engine pass's track (engine:<name>), for a task added without one (an older engine-porter
      // task got a plain lane). Decided like a lane: a person, the orchestrator or a Producer/Director session.
      const asked = String(flags._[2] || '').trim();
      const et = await import('./engine-tracks.mjs');
      // 2.83: `track <ID> web` sets a task back to the web track (a rules bug that went to an engine track).
      // An engine porter's task is engine work by its role: for it "web" is no track, as before (refused below).
      if (asked.toLowerCase() === 'web' && all.find((t) => t.id === arg1)?.role !== 'engine-porter') {
        const webNo = laneRefusal(by);
        if (webNo) { console.error(webNo.replace(/set a task's lane|sets lanes/g, 'set a task\'s track')); process.exit(1); }
        const was = et.engineTask(arg1)?.track || et.rawTrack(arg1) || 'none';
        et.setEngineTask(arg1, { engine: null, track: 'web', inferred: null, normalized: null, setBy: by });
        emitEvent({ type: 'task.track', agent: by, task: arg1, msg: `${by}: ${arg1} is on the web track (was ${was})`, meta: { track: 'web', was } });
        await logTaskDecision({ action: 'task-track', subject: arg1, by, why: `${arg1} is on the web track (was ${was})`, evidence: 'npm run task -- track', undo: { kind: 'text', text: `npm run task -- track ${arg1} ${was === 'none' ? 'engine:<name>' : was} --by <you>` } });
        console.log(`${arg1} is on the web track (was ${was}): it is not an engine pass any more.`);
        process.exit(0);
      }
      if (!asked) {
        const cur = et.engineTask(arg1);
        console.log(cur ? `${arg1}: ${cur.track}${cur.inferred ? ' (inferred)' : ''}${cur.branch ? `, branch ${cur.branch}` : ''}` : `${arg1} has no engine track. Set one: npm run task -- track ${arg1} engine:<name> --by <you>`);
        process.exit(0);
      }
      // 2.78.2 (g, item 18): "unity" (a configured engine without the prefix) is engine:unity; an engine the studio
      // doesn't configure, or anything else, is refused (it would leave the task off every engine train).
      const rt = et.readTrack(asked);
      if (!rt.engine || !rt.configured) {
        const known = et.configuredEngines();
        console.error(`${arg1}'s track was not set: ${rt.engine ? `engine:${rt.engine} is not an engine this studio configures (${known.length ? known.map((n) => `engine:${n}`).join(', ') : 'none: studio/game.json "engines" names them, the owner\'s'})` : rt.why}.`);
        process.exit(1);
      }
      const want = rt.track;
      const engine = rt.engine;
      if (rt.normalized) console.log(`"${asked}" is read as ${want} (the engine it names).`);
      const trackNo = laneRefusal(by);
      if (trackNo) { console.error(trackNo.replace(/set a task's lane|sets lanes/g, 'set a task\'s engine track')); process.exit(1); }
      const rec = et.setEngineTask(arg1, { engine, track: want, inferred: null, normalized: rt.normalized ? { from: asked, at: new Date().toISOString() } : null, setBy: by });
      emitEvent({ type: 'task.track', agent: by, task: arg1, msg: `${by}: ${arg1} is an engine pass on ${want}${rt.normalized ? ` (given as "${asked}")` : ''}`, meta: { track: want, ...(rt.normalized ? { given: asked } : {}) } });
      await logTaskDecision({ action: 'task-track', subject: arg1, by, why: `${arg1} is an engine pass on ${want}`, evidence: 'npm run task -- track', undo: { kind: 'text', text: `npm run task -- track ${arg1} engine:<the earlier engine> --by <you>` } });
      console.log(`${arg1} is an engine pass on ${rec.track}: its next launch gets that engine's worktree.`);
      process.exit(0);
    }
    if (cmd === 'park') {
      if (typeof flags.why !== 'string') {
        console.error('Say why it is parked: --why "…" (the Producer and Director read it).');
        process.exit(1);
      }
      let until = typeof flags.until === 'string' ? flags.until : null;
      // 2.77.3 (H5): --until "<condition text>" isn't a date or task: it is a note shown when someone tries to unpark
      // (nothing ends the park by itself; the same rank or higher lifts it).
      let note = null;
      if (until && !/^[A-Z]+-\d+$/.test(until) && !/^phase:\d+$/i.test(until) && !Number.isFinite(Date.parse(until))) { note = until.trim().slice(0, 300); until = null; }
      const parker = parkRank({ by });
      const stamp = until && Number.isFinite(Date.parse(until)) && !/^[A-Z]+-\d+$/.test(until) && !/^phase:/i.test(until) ? new Date(Date.parse(until)).toISOString() : until;
      setHold(arg1, { parked: { by, why: flags.why, at: new Date().toISOString(), rank: parker.rank, byRole: parker.role, ...(note ? { note } : {}), ...(stamp ? { until: stamp } : {}) } }, { by, msg: `${by} parked ${arg1}${stamp ? ` until ${stamp}` : ''}: ${flags.why}` });
      console.log(stamp ? `${arg1} is parked until ${stamp}; then it can start on its own.` : `${arg1} is parked: it won't start until someone runs npm run task -- unpark ${arg1} --by <name> (or park it with --until T-ID|phase:N|time).`);
    } else if (cmd === 'unpark') {
      const refusedUnpark = unparkRefusal(arg1, { by });
      if (refusedUnpark) { console.error(refusedUnpark); process.exit(1); }
      setHold(arg1, { parked: null }, { by, msg: `${by} unparked ${arg1}` });
      clearAttempts(arg1); // 2.81 (b1): whoever unparks decided it can run again
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
      const folders = flags._.slice(2);
      const folder = folders.join(',');
      if (!folder) {
        console.error(`Usage: npm run task -- lane ${arg1} <folder> [<folder>…] [--by <name>]   (or "all" / "none": the whole game, no other builder runs beside it)`);
        process.exit(1);
      }
      // 2.78.1 (B-123): a person, the orchestrator or a Producer/Director session decides a lane; never a worker.
      const laneNo = laneRefusal(by);
      if (laneNo) { console.error(laneNo); process.exit(1); }
      // 2.78.2 (item 9): kept as written, regions too (path/sim.ts#symbol: harness/lane-regions.mjs).
      const lane = ['none', 'all', '.'].includes(folder) ? null : laneEntries(folder).join(',') || null;
      if (lane && /^(harness|hub|qa|scripts)(\/|$)/.test(lane) && fs.existsSync(path.join(STUDIO_STATE_DIR, 'harness-frozen'))) {
        console.error(`${lane} is harness code, and this clone's harness is frozen.`);
        process.exit(1);
      }
      // 2.59.0 (#8): --wide "<why>" (a person's) lets a broad lane launch in the main checkout; any other lane change drops it.
      const laneWide = lane && typeof flags.wide === 'string' ? { lane, why: flags.wide, by, ...(process.env.STUDIO_ROLE ? { inSession: true } : {}) } : undefined;
      updateHolds((all2) => { all2[arg1] = { ...(all2[arg1] || {}), lane, laneWide }; });
      emitEvent({ type: 'task.lane', agent: by, task: arg1, msg: `${by}: ${arg1} works in ${lane || 'the whole game'}` });
      await logTaskDecision({ action: 'task-lane', subject: arg1, by, why: `${arg1} works in ${lane || 'the whole game'}`, evidence: 'npm run task -- lane', undo: { kind: 'text', text: `npm run task -- lane ${arg1} <the earlier folders, or "all"> --by <you>` } });
      // 2.78.1 (B-123): a task already in progress: the supervisor reads its new lane for the running builder too.
      const running = q.inProgress.some((t) => t.id === arg1);
      console.log(`${arg1} works in ${lane || 'the whole game (no other builder runs beside it)'}.${running ? ` It is in progress: from the supervisor's next pass its builder counts as working ${lane ? `in ${lane}` : 'on the whole game'}.` : ''}`);
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
    // 2.67.0: the owner's standing delegation (harness/delegation.mjs): the named outside agent says yes with --by <agent>.
    const dl = await import('./delegation.mjs');
    const dg = dl.delegationFor({ action: 'yes', by: typeof flags.by === 'string' ? flags.by : '' });
    if (dg.ok) { flags.by = dg.owner; flags.quote = dg.permission; flags.source = dg.autonomous ? 'studio/policy.json' : dl.DELEGATION_REL; }
    const who = dg.ok ? { ok: true, relayedBy: dg.agent } : devSays(typeof flags.by === 'string' ? flags.by : null, { quote: flags.quote || '', source: flags.source || '' });
    if (!who.ok) {
      console.error(`${who.message}${dg.why ? ` (${dg.why})` : ''}`);
      process.exit(1);
    }
    if (dg.ok) dl.recordUse(dg, { action: 'yes', task: arg1 });
    const neededYes = readHolds()[arg1]?.needsYes || null; // 2.71.0 (x): the decision log's undo
    setHold(arg1, { needsYes: null }, { by: flags.by, msg: `${flags.by} said yes to ${arg1}${who.relayedBy ? ` (relayed by ${who.relayedBy}: "${flags.quote}", ${flags.source})` : ''}` });
    emitEvent({ type: 'task.dev_yes', agent: flags.by, task: arg1, msg: `${flags.by} said yes to ${arg1}: ${t.title}${dg.autonomous ? ' (autonomous mode: on the review list)' : ''}`, meta: { ...(who.relayedBy ? { relayedBy: who.relayedBy, quote: flags.quote, source: flags.source } : {}), ...(dg.autonomous ? { autonomous: true } : {}) } });
    await logTaskDecision({ action: 'yes', subject: arg1, by: dg.ok ? dg.agent : flags.by, dg: dg.ok ? dg : (who.relayedBy ? { via: 'outside agent', permission: `${flags.quote} (${flags.source})` } : null), why: t.title, evidence: neededYes ? `proposed by ${neededYes.by || '?'}` : 'no yes was pending', undo: neededYes ? { kind: 'needs-yes', task: arg1, needsYes: neededYes, text: `the task waits for the dev's yes again` } : null });
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
  // 2.62.0 (H): per-task acceptance contracts (harness/contracts.mjs): show, add, agree, check, sign, remove.
  if (cmd === 'contract') {
    const { contractCommand, CONTRACT_USAGE } = await import('./contracts.mjs');
    const t = [...q.inProgress, ...q.backlog, ...q.done].find((x) => x.id === arg1);
    if (!t) {
      console.error(`${arg1 ? `No task ${arg1} on the board. ` : ''}${CONTRACT_USAGE}`);
      process.exit(1);
    }
    const r = contractCommand({ task: t, done: q.done.some((x) => x.id === t.id) && !q.inProgress.some((x) => x.id === t.id), sub: flags._[2], args: flags._.slice(3), flags });
    (r.ok ? console.log : console.error)(r.message);
    process.exit(r.ok ? 0 : 1);
  }

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
      console.error('Usage: node harness/task.mjs add "<Task Title>" [--role builder] [--priority P1] [--type bug|chore|study|research|balance|fun|playtest|review|docs|idea] [--size 1-5] [--caused-by T-012] [--phase 1|2|3 --serves pillar:<name>|layer:<id>] [--idea I-001] [--part sim|renderer|both] [--lane <folder>] [--paths a.js,b.js] [--after T-011] [--track web|engine:<name> [--branch <engine branch>] [--scope "…"] [--visual-check] [--refs a.jpg,b.jpg]] [--prototype | --infra] [--origin dev|agent] [--asked "<the dev\'s words>"] [--mechanic] [--tricks 1-6] [--canary "<why it is impossible>"] [--start --agent <you>]');
      process.exit(1);
    }
    // --type bug|chore|study|balance|fun|playtest|review|docs puts the matching prefix on the title.
    const type = typeof flags.type === 'string' ? flags.type.toLowerCase() : '';
    if (type && !['bug', 'chore', 'study', 'research', 'balance', 'fun', 'playtest', 'review', 'docs', 'idea', 'system'].includes(type)) {
      console.error(`Unknown --type "${flags.type}". Use bug, chore, study, research, balance, fun, playtest, review, docs, idea or system.`);
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
    // 2.77.0 (u, P5.5): reference photos are files the studio provides; the harness never downloads one.
    // 2.81 (b2): --anchors A1,A2.F1 cites the anchor spec (studio/references/anchors.json, harness/anchors.mjs); an
    // unknown id is refused; a builder task with none, when the studio has anchors, gets a note (never a refusal).
    const anchorIds = (() => {
      if (typeof flags.anchors !== 'string' || !flags.anchors.trim()) return [];
      const v = validateAnchorIds(flags.anchors);
      if (!v.ok) { console.error(`--anchors: ${[...v.unknown.map((id) => `no anchor ${id} in studio/references/anchors.json (node harness/anchors.mjs list)`), ...v.problems].join('; ')}. Nothing was queued.`); process.exit(1); }
      return v.ids;
    })();
    if (!anchorIds.length && (flags.role || 'builder') === 'builder' && !type && readAnchors().length) console.error('note: this studio has an anchor spec (node harness/anchors.mjs list) and this task cites none (--anchors A1,…); its done check records no anchor verdict.');
    if (typeof flags.refs === 'string') {
      const bad = flags.refs.split(',').map((x) => x.trim()).filter((x) => /^[a-z][a-z0-9+.-]*:\/\//i.test(x));
      if (bad.length) { console.error(`--refs takes local paths to reference photos the studio provides (a file, or the assets reference folder), not links: ${bad.join(', ')}. The harness never downloads photos; save it under assets/reference/ first.`); process.exit(1); }
    }
    // 2.78.0 (PU-60): --scope on any task is the files it expects to touch (harness/plan-waves.mjs reads it); only
    // --visual-check and --refs are an engine pass's.
    if ((flags['visual-check'] || typeof flags.refs === 'string') && !/^engine:[a-z][a-z0-9-]{1,30}$/.test(String(flags.track || ''))) console.error('note: --visual-check and --refs belong to an engine pass (--track engine:<name>); recorded in the task\'s meta only.');
    // PU-58: --canary "<why>" marks a task impossible on purpose. Only a decider adds one, and the flag never goes into
    // the task's meta (the task.added event), the brief or NEXT.md: it is kept in .studio/canaries.json (harness/canary.mjs).
    const canaryWhy = typeof flags.canary === 'string' ? flags.canary.trim() : '';
    if (flags.canary !== undefined && canaryWhy.length < 10) {
      console.error('--canary takes the reason the task is impossible, 10+ characters: --canary "what contradicts what".');
      process.exit(1);
    }
    if (canaryWhy && !isDecider(typeof flags.agent === 'string' ? flags.agent : actor(), process.env)) {
      console.error('Only the Producer, Director, planner or a person adds a canary task: --agent <name>.');
      process.exit(1);
    }
    // 2.79.1: an engine-porter task with no --track gets the studio's only engine (else it is refused with the list): without
    // a track it got a game lane (T-350). A builder task naming files that exist gets their folder as its lane, said out loud.
    const roleFlag = flags.role || 'builder';
    if (roleFlag === 'engine-porter' && typeof flags.track !== 'string') {
      const dt = defaultEngineTrack(mainRoot());
      if (dt.error) { console.error(`Not queued. ${dt.error}.`); process.exit(1); }
      if (dt.track) flags.track = dt.track;
      if (dt.track) console.log(`--track not given: an engine-porter task goes on ${dt.track}, the studio's only engine.`);
    }
    // 2.82: in a native-engine studio (harness/native.mjs) a builder's change goes on the engine track unless it says
    // otherwise (--track web: the web rules a studio is still moving out of; a lane, paths or a non-change type: studio work).
    // 2.83: a rules bug in web code (a path under the web game's folder, a .ts/.js file) is a web task, not an engine pass.
    if (roleFlag === 'builder' && typeof flags.track !== 'string' && !NON_CHANGE_TYPES.has(String(flags.type || '').toLowerCase())) {
      const wc = webCodeNamed([title, flags.scope, flags.paths, flags.lane].filter((x) => typeof x === 'string').join(' '), mainRoot());
      if (wc.web) { flags.track = 'web'; console.log(`--track not given: this task names web code (${wc.why}): web track; --track engine:${nativeEngine(mainRoot())} to override.`); }
    }
    if (roleFlag === 'builder' && typeof flags.track !== 'string' && typeof flags.lane !== 'string' && typeof flags.paths !== 'string' && !NON_CHANGE_TYPES.has(String(flags.type || '').toLowerCase()) && !/^(plan|document|write up|review|research|study)\b/i.test(title)) {
      const ne = nativeEngine(mainRoot());
      if (ne) { flags.track = `engine:${ne}`; console.log(`--track not given: this studio is native ${ne}, so a builder task goes on engine:${ne} (web rules still being moved: --track web).`); }
    }
    if (roleFlag === 'builder' && typeof flags.lane !== 'string' && typeof flags.paths !== 'string' && !(typeof flags.scope === 'string' && scopePaths(flags.scope).length)) {
      const inf = inferLaneFromText([title, flags.description, flags.desc, flags.why].filter((x) => typeof x === 'string').join(' '), mainRoot());
      if (inf) { flags.lane = inf.lane; console.log(`--lane not given: inferred ${inf.lane} from ${inf.from.join(', ')} named in the title (change it: task lane <ID> <folder>).`); }
    }
    // 2.83: --after names tasks that are on the board (open or done): a pin behind an id that does not exist can never finish.
    if (typeof flags.after === 'string') {
      const bad = unknownAfter(flags.after.split(/[,\s]+/).filter(Boolean));
      if (bad) { console.error(`Not queued. ${bad}`); process.exit(1); }
    }
    const created = addTask({
      title: `${prefix}${title}`,
      role: roleFlag,
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
        // 2.77.3 (H3): --lane all (or .) is the whole game on purpose; a builder task with no folders is refused (gateTask).
        requireLane: true,
        ...(typeof flags.lane === 'string' && ['all', '.', './'].includes(flags.lane.trim()) ? { wholeGame: true } : typeof flags.lane === 'string' ? { lane: flags.lane.replace(/\/+$/, '') } : {}),
        ...(typeof flags.paths === 'string' && laneList(flags.paths).length ? { paths: laneEntries(flags.paths) } : typeof flags.scope === 'string' && typeof flags.lane !== 'string' && scopePaths(flags.scope).length ? { paths: scopePaths(flags.scope) } : {}),
        // 2.59.0 (#8): a person keeps a broad lane for a launch in the main checkout: --wide "<why>" (harness/agent.mjs).
        ...(typeof flags.wide === 'string' && (typeof flags.lane === 'string' || typeof flags.paths === 'string') ? { laneWide: { lane: laneList(typeof flags.paths === 'string' && laneList(flags.paths).length ? flags.paths : flags.lane).join(','), why: flags.wide, by: typeof flags.by === 'string' ? flags.by : actor(), ...(process.env.STUDIO_ROLE ? { inSession: true } : {}) } } : {}),
        // 2.78.2 (g, item 18): --track unity (a configured engine) is engine:unity, said once.
        ...(typeof flags.track === 'string' ? { track: (() => { const rt = readTrack(flags.track); if (rt.normalized) { console.log(`--track ${flags.track} is read as ${rt.track} (the engine it names).`); return rt.track; } return flags.track; })() } : {}),
        // 2.60.1 (B-41): the Unity branch a --track engine:unity task lands from (harness/unity-gate.mjs {branch}).
        ...(typeof flags.branch === 'string' ? { branch: flags.branch } : {}),
        // 2.77.0 (u, P5.1/P5.5): an engine pass's scope, its visual check and the studio's reference photos (local paths).
        ...(typeof flags.scope === 'string' ? { scope: flags.scope.slice(0, 600) } : {}),
        ...(flags['visual-check'] ? { visualCheck: true } : {}),
        ...(typeof flags.refs === 'string' && flags.refs.trim() ? { refs: flags.refs.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
        ...(anchorIds.length ? { anchors: anchorIds } : {}),
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
    if (canaryWhy && created.id && !created.duplicate) recordCanary(created.id, canaryWhy, typeof flags.agent === 'string' ? flags.agent : actor());
    for (const w of created.warnings || []) console.error(`note: ${w}`);
    if (startFor && created.started) console.error(`Started ${created.id} for ${startFor}${created.brief ? `. Your brief: ${created.brief}` : ''}`);
    if (startFor && created.started === false) console.error(`note: queued but not started for ${startFor}: ${created.startError}`);
    if (created.split) console.error(`note: size ${size} is over the builder cap of ${SIZE_CAP}; ${created.split} (planner) splits it first.`);
    if (created.tricks) console.error(`note: pre-approved cheat sheet tricks: ${created.tricks.join(', ')}`);
    console.log(JSON.stringify(created, null, 2));
    process.exit(0);
  }

  console.log('Usage: node harness/task.mjs [next | list | start <ID> [--model m] | pause <ID> --note "..." | impossible <ID> --why "..." | done <ID> | add "<Title>" [--after T-x] | park|unpark|unblock <ID> | block <ID> --until <T-ID|time> | lane <ID> <folder|a.js,b.js|none> | track <ID> engine:<name>|web | after <ID> <T-x>|--remove|--set|--clear | holds | note <ID> "<ruling>" --by <name> | yes <ID> --by <dev> | drop <ID> --why "…" | reorder <ID> --to top|bottom|<n> | --before <ID>]');
}

/**
 * 2.71.1 (D01/T04, G15/T02): a verify record that passes the reuse rules counts only when run-gates wrote it: its run log
 * (.studio/gates/runs/<id>.json) matches it and it didn't run beside untracked or ignored inputs (harness/gate-trust.mjs).
 */
function reuseTrusted(rec, judged) {
  const t = recordTrust(rec, [path.join(REPO_ROOT, '.studio')]);
  return t.ok ? judged : { ok: false, why: t.why };
}
