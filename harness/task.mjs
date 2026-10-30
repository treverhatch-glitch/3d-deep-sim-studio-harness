#!/usr/bin/env node
/**
 * harness/task.mjs — Markdown Task Queue Manager (`studio/NEXT.md`)
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actor, emitEvent, REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents } from './event.mjs';
import { claim, release, status as lockStatus, listLocks } from './lock.mjs';
import { checkDone, taskType, joinWaveIfGameplay } from './done-check.mjs';
import { summarize as summarizeVerdict } from './verdict-split.mjs';
import { readBible, crossedLayersIn, readIdea, writeIdea, latestReview, LAYERS } from './bible.mjs';
import { writeFocus } from './focus.mjs';
import { causeOf, isAccepted } from './cause-store.mjs';
import { holdReason, setHold, readHolds, laneList, gameFolders } from './task-hold.mjs';
import { stopIfOverBudget } from './task-budget.mjs';
import { savePatch } from './wip.mjs';
import { inLaneCopy, catchUp, carryTaskBranch, deliver, laneDiff, mainRoot } from './worktree.mjs';
import { recordPass, clearPass, withLandLock } from './merge-lane.mjs';
import { isEngineChurn } from './game-gates.mjs';
import { isMechanic, originOf, devSays } from './intent.mjs';
import { checkBreaker, isFailureNote, reasonKey, unblockTask } from './breaker.mjs';
import { startSummary, carryForward } from './carry.mjs';
import { openPending, readPending } from './pending-review.mjs';
import { isDecider, propose, SIZE_CAP } from './proposed.mjs';
import { attachTricks } from './cheatsheet.mjs';

export const NEXT_FILE = path.join(REPO_ROOT, 'studio', 'NEXT.md');
// 2.30c (#13): finished tasks live in studio/DONE.md, so NEXT.md (read by every agent) holds only open work.
export const DONE_FILE = path.join(REPO_ROOT, 'studio', 'DONE.md');
export const CURRENT_TASK_FILE = path.join(REPO_ROOT, 'studio', 'CURRENT_TASK.md');

const TASK_LINE_RE = /^-\s+\[([ x>~])\]\s+\*\*([A-Z]+-\d+)\*\*\s+\[(P[0-3])\]\s+\(`([^`]+)`\)\s+—\s+(.+)$/;

export function parseNextQueue() {
  const tasks = parseQueueFile(NEXT_FILE);
  // Older studios kept DONE in NEXT.md: those still count, and move to DONE.md on the next write.
  const seen = new Set(tasks.done.map((t) => t.id));
  for (const t of parseQueueFile(DONE_FILE, 'done').done) if (!seen.has(t.id)) tasks.done.push(t), seen.add(t.id);
  // 2.30p: remember which tasks this snapshot saw, so a later write can keep tasks added since.
  Object.defineProperty(tasks, 'readIds', { value: new Set([...tasks.inProgress, ...tasks.backlog, ...tasks.done].map((t) => t.id)), enumerable: false });
  return tasks;
}

function parseQueueFile(file, start = 'backlog') {
  if (!fs.existsSync(file)) {
    return { inProgress: [], backlog: [], done: [] };
  }
  const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  let section = start;
  const tasks = { inProgress: [], backlog: [], done: [] };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+IN_PROGRESS/i.test(trimmed)) {
      section = 'inProgress';
      continue;
    }
    if (/^##\s+BACKLOG/i.test(trimmed)) {
      section = 'backlog';
      continue;
    }
    if (/^##\s+DONE/i.test(trimmed)) {
      section = 'done';
      continue;
    }

    const m = trimmed.match(TASK_LINE_RE);
    if (m) {
      const [, mark, id, priority, role, title] = m;
      tasks[section].push({
        id,
        priority,
        role,
        title: title.trim(),
        status: section === 'done' || mark === 'x' ? 'done' : section === 'inProgress' || mark === '>' ? 'in_progress' : 'backlog',
      });
    }
  }
  return tasks;
}

function formatTaskLine(t, mark) {
  return `- [${mark}] **${t.id}** [${t.priority}] (\`${t.role}\`) — ${t.title}`;
}

/**
 * 2.30p: every board write takes the short land lock and re-reads the board first. A task on disk that
 * the caller's snapshot never saw (another agent added it meanwhile) is kept, never overwritten.
 */
export function writeNextQueue(tasks) {
  const doWrite = () => {
    if (tasks.readIds) {
      const disk = parseNextQueue();
      const mine = new Set([...tasks.inProgress, ...tasks.backlog, ...tasks.done].map((t) => t.id));
      for (const sec of ['inProgress', 'backlog', 'done']) {
        for (const t of disk[sec]) if (!mine.has(t.id) && !tasks.readIds.has(t.id)) { tasks[sec].push(t); mine.add(t.id); }
      }
    }
    writeNextQueueRaw(tasks);
  };
  try {
    withLandLock(mainRoot(), doWrite, { waitMs: Number(process.env.STUDIO_BOARD_LOCK_WAIT_MS || 30000) });
  } catch (err) {
    if (err.code !== 'LAND_BUSY') throw err;
    doWrite();
  }
}

function writeNextQueueRaw(tasks) {
  const out = [
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
  ];
  fs.mkdirSync(path.dirname(NEXT_FILE), { recursive: true });
  fs.writeFileSync(NEXT_FILE, out.join('\n'), 'utf8');
  const done = [
    '# Finished tasks (`studio/DONE.md`)',
    '',
    '> Managed by `node harness/task.mjs`. Newest first. Open work is in `studio/NEXT.md`; agents don\'t need to read this file.',
    '',
    '## DONE',
    ...(tasks.done.length ? tasks.done.map((t) => formatTaskLine(t, 'x')) : ['_No completed tasks yet._']),
    '',
  ];
  fs.writeFileSync(DONE_FILE, done.join('\n'), 'utf8');
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
  fs.mkdirSync(path.dirname(CURRENT_TASK_FILE), { recursive: true });
  fs.writeFileSync(CURRENT_TASK_FILE, content, 'utf8');
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
export function readStop() {
  try {
    return JSON.parse(fs.readFileSync(STOP_FILE, 'utf8'));
  } catch {
    return null;
  }
}
export function setStop(by = 'war-room-human', reason = '') {
  const s = { by, reason: String(reason || '').slice(0, 300), at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(STOP_FILE), { recursive: true });
  fs.writeFileSync(STOP_FILE, `${JSON.stringify(s, null, 2)}\n`);
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
  const open = q.backlog
    .map((t, i) => [t, i])
    .filter(([t]) => !lockStatus(`task:${t.id}`).locked && (!role || t.role === role || !t.role) && !holdReason(t.id, q))
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
  const lockRes = claim(`task:${taskId}`, agent);
  if (!lockRes.ok) {
    if (lockRes.reason === 'owner-required') return { error: 'owner-required', message: lockRes.message };
    emitEvent({ type: 'task.lock_denied', agent, task: taskId, status: 'blocked', msg: `Task ${taskId} already claimed by ${lockRes.lock?.owner}` });
    return { error: 'locked', lock: lockRes.lock || null };
  }

  const q = parseNextQueue();
  let target = q.inProgress.find((t) => t.id === taskId);
  if (!target) {
    const idx = q.backlog.findIndex((t) => t.id === taskId);
    if (idx === -1) {
      release(`task:${taskId}`, agent);
      return null;
    }
    [target] = q.backlog.splice(idx, 1);
    target.status = 'in_progress';
    q.inProgress.unshift(target);
  }
  writeNextQueue(q);
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

/**
 * Only the lock owner can finish a claimed task, and only once the done-check for its type passes
 * (harness/done-check.mjs). force skips both; a skipped check is logged and the Producer gets a
 * P1 task to run it.
 */
export function completeTask(taskId, note = '', agent = null, { force = false, reason = '', acceptedBy = '', noop = '' } = {}) {
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
  if (!force && target.role === 'builder' && ['change', 'system', 'bug', 'fun', 'balance'].includes(taskType(target)) && process.env.STUDIO_DONE_NOOP !== 'allow') {
    if (noop && String(noop).trim().length >= 10) {
      emitEvent({ type: 'task.noop', agent: agent || target.role, task: target.id, msg: `${target.id} closed as no-op: ${String(noop).trim().slice(0, 300)}` });
      note = `${note ? `${note}; ` : ''}no-op: ${String(noop).trim().slice(0, 200)}`;
    } else {
      const start = readRecentEvents(20000).filter((e) => e.task === target.id && e.type === 'task.start' && e.meta?.head).pop()?.meta?.head;
      if (start) {
        const isCode = (f) => f && !/^(studio|\.studio|\.lanes|qa\/reports)\//.test(f) && !isEngineChurn(f);
        const committed = spawnSync('git', ['diff', '--name-only', `${start}..HEAD`], { cwd: REPO_ROOT, encoding: 'utf8' });
        const working = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
        if (committed.status === 0) {
          const files = [...committed.stdout.split('\n'), ...(working.stdout || '').split('\n').map((l) => l.slice(3))].filter(isCode);
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
  if (!check.ok && !force) {
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

  // 2.30n: the studio game's own checks and, for files in a Godot project, the engine gate. Before
  // 2.30n only example-sim was gated, so the real game never was. STUDIO_DONE_GAME_GATES=skip turns it off.
  if (!force && process.env.STUDIO_DONE_GAME_GATES !== 'skip') {
    const owner = lock.locked ? lock.lock.owner : agent;
    const claimed = owner ? listLocks().filter((l) => l.owner === owner && l.key.startsWith('path:')).map((l) => l.key.slice(5)).filter(Boolean) : [];
    const lanePaths = laneList(readHolds()[target.id]?.lane);
    // 2.30p: in a lane copy the diff against the studio's branch picks the gates (path-scoped gates);
    // its files also feed the engine gate. Outside a lane copy the diff is unknown and every gate runs.
    const ld = laneDiff();
    const changed = ld?.changed?.length ? ld.changed : null;
    const paths = [...new Set([...claimed, ...lanePaths, ...(changed || [])])];
    const ggEnv = { ...process.env };
    delete ggEnv.STUDIO_GATE_CHANGED;
    const gg = spawnSync(process.execPath, [path.join(REPO_ROOT, 'harness', 'game-gates.mjs'), '--json', ...(paths.length ? ['--paths', paths.join(',')] : []), ...(changed ? ['--changed', changed.join(',')] : [])], { cwd: REPO_ROOT, encoding: 'utf8', env: ggEnv, maxBuffer: 32 * 1024 * 1024 });
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

  // 2.30k: done means committed. Uncommitted changes in the task's claimed files (or the game's
  // folders when it claimed none) are refused, so they aren't later committed under another task
  // (T-013 in the Marina run was accepted with its diff left uncommitted).
  if (!force && !inLaneCopy() && process.env.STUDIO_DONE_UNCOMMITTED !== 'allow') {
    const owner = lock.locked ? lock.lock.owner : agent;
    let scope = owner ? listLocks().filter((l) => l.owner === owner && l.key.startsWith('path:')).map((l) => l.key.slice(5)).filter(Boolean) : [];
    if (!scope.length) {
      const f = gameFolders();
      scope = [f.renderer, f.sim].filter(Boolean);
    }
    if (scope.length) {
      const st = spawnSync('git', ['status', '--porcelain', '--', ...scope], { cwd: REPO_ROOT, encoding: 'utf8' });
      const dirty = st.status === 0 ? st.stdout.split('\n').filter(Boolean).map((l) => l.slice(3)).filter((f) => !isEngineChurn(f)) : [];
      if (dirty.length) {
        emitEvent({ type: 'task.not_done', agent: agent || target.role, task: target.id, status: 'blocked', msg: `${target.id} not done yet: ${dirty.length} uncommitted change${dirty.length === 1 ? '' : 's'} (${dirty.slice(0, 3).join(', ')})` });
        return { error: 'uncommitted', dirty, message: `${target.id} is not done: these changes aren't committed yet:\n${dirty.slice(0, 10).map((d) => `  ${d}`).join('\n')}\nCommit them (git add <files> && git commit -m "${target.id}: …"), then run task done again.` };
      }
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
  const writeBoard = () => {
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
  };

  // In a lane copy (2.29), done is when the work reaches the studio's branch: committed, rebased on the
  // latest, checked again if that moved, then added. Forced or not, uncommitted work is refused here.
  if (inLaneCopy()) {
    const d = deliver(taskId, { onLanded: writeBoard });
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
      const q2 = parseNextQueue();
      const same = [...q2.inProgress, ...q2.backlog].find((t) => t.id === open.id);
      const m = same.title.match(/^Check forced done (.+?) \(([^)]+)\): (.+)$/);
      const ids = m[1].split(/,\s*/);
      if (!ids.includes(target.id)) same.title = `Check forced done ${[...ids, target.id].join(', ')} (${m[2]}): ${m[3]}`;
      writeNextQueue(q2);
      return { ...target, forced: true, check, followUp: open.id, joined: true };
    }
    const followUp = addTask({ title: `Check forced done ${target.id} (${check.type}): ${check.missing[0]}`, role: 'producer', priority: 'P1' });
    return { ...target, forced: true, check, followUp: followUp.id, patch: forcedPatch };
  }
  return target;
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
  try {
    process.kill(s.supervisor || s.pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
/** 2.30c (#4): a hand-back note is at most this many characters (20 lines). */
export const HANDBACK_MAX = 2400;
export function pauseTask(taskId, agent = null, note = '', { force = false } = {}) {
  const lock = lockStatus(`task:${taskId}`);
  // Anyone may hand back a task whose holder's session has ended (test #2: dead agents' tasks sat
  // claimed for up to an hour, and the Producer had to wait for the claim to expire).
  if (lock.locked && lock.lock.owner !== agent && !force && holderRunning(lock.lock.owner)) {
    return { error: 'locked', message: `Task ${taskId} is claimed by ${lock.lock.owner}, which is still running. Only that owner can hand it back (or stop it: npm run agent -- stop ${lock.lock.owner}).` };
  }
  const q = parseNextQueue();
  const idx = q.inProgress.findIndex((t) => t.id === taskId);
  if (idx === -1) return null;
  const [target] = q.inProgress.splice(idx, 1);
  target.status = 'backlog';
  q.backlog.unshift(target);
  writeNextQueue(q);
  if (lock.locked) release(`task:${taskId}`, lock.lock.owner);
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

/** meta: { size: 1-5 (how hard), causedBy: 'T-012' (the task whose work caused this bug) } */
/**
 * Reopen finished work that turned out wrong. Counts as a bug against the model that closed it
 * (harness/scorecard.mjs). The reason goes into the task's handoff notes.
 */
export function reopenTask(taskId, reason = '', agent = PRODUCER_NAME()) {
  const q = parseNextQueue();
  const idx = q.done.findIndex((t) => t.id === taskId);
  if (idx === -1) return null;
  const [target] = q.done.splice(idx, 1);
  target.title = target.title.replace(/\s*_\(✓ .*\)_$/, '');
  target.status = 'backlog';
  q.backlog.unshift(target);
  writeNextQueue(q);
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

export function addTask({ title, role = 'builder', priority = 'P1', agent = PRODUCER_NAME(), meta = {} }) {
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
  const q = parseNextQueue();
  const all = [...q.inProgress, ...q.backlog, ...q.done];
  const maxNum = all.reduce((max, t) => {
    const num = Number((t.id.split('-')[1]) || 0);
    return num > max ? num : max;
  }, 0);
  const newTask = {
    id: `T-${String(maxNum + 1).padStart(3, '0')}`,
    priority: priority.toUpperCase(),
    role,
    title,
    status: 'backlog',
  };
  // 2.30 (J2): every task says whose idea it is; an agent's own mechanic waits for the dev's yes.
  meta = { ...meta, origin: originOf({ origin: meta.origin, agent, asked: meta.asked }) };
  q.backlog.push(newTask);
  writeNextQueue(q);
  if (meta.after?.length) setHold(newTask.id, { after: meta.after });
  if (meta.origin === 'agent-proposed' && isMechanic(title, meta)) {
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
  const q = parseNextQueue();
  if (q.inProgress.some((t) => t.id === id)) return { ok: false, message: `${id} is in progress. Pause it first (npm run task -- pause ${id} --note "…"), then drop it.` };
  const i = q.backlog.findIndex((t) => t.id === id);
  if (i === -1) return { ok: false, message: `${id} isn't waiting in the queue.` };
  const [t] = q.backlog.splice(i, 1);
  writeNextQueue(q);
  setHold(id, { needsYes: null, parked: null, after: null });
  fs.mkdirSync(HANDOFF_DIR, { recursive: true });
  fs.appendFileSync(handoffFile(id), `\n## ${new Date().toISOString()} · ${by} (dropped)\n${why}\nTitle was: ${t.title}\n`);
  emitEvent({ type: 'task.dropped', agent: by, task: id, msg: `${by} dropped ${id} (${t.title}): ${why}`, meta: { task: t } });
  return { ok: true, message: `${id} is off the queue. Its title and why are in the event log; re-add it with task add if needed.` };
}

/** Move a waiting task: --to top|bottom|<position from 1>, or --before <T-ID> (2.30, J11). */
export function reorderTask(id, { to, before, by = actor() } = {}) {
  const q = parseNextQueue();
  const i = q.backlog.findIndex((t) => t.id === id);
  if (i === -1) return { ok: false, message: `${id} isn't waiting in the queue (only waiting tasks move).` };
  const [t] = q.backlog.splice(i, 1);
  let at;
  if (typeof before === 'string') at = q.backlog.findIndex((x) => x.id === before);
  else if (to === 'top') at = 0;
  else if (to === 'bottom') at = q.backlog.length;
  else if (Number(to) >= 1) at = Math.min(q.backlog.length, Number(to) - 1);
  if (at === undefined || at < 0) return { ok: false, message: 'Usage: npm run task -- reorder <TASK_ID> --to top|bottom|<position> | --before <TASK_ID> --by <name>' };
  q.backlog.splice(at, 0, t);
  writeNextQueue(q);
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
      console.error(started.error === 'locked' ? `Task "${targetId}" is claimed by ${started.lock?.owner}. Pick another task.` : started.message);
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
      console.error('Usage: node harness/task.mjs done <TASK_ID> --agent <owner> [--note "..."] [--force --reason "<10+ chars>"]');
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
    const busyMod = await import('./busy.mjs');
    // 2.30q: drain on: a new done waits here (before its marker, so drain wait doesn't wait for it).
    { const w = await busyMod.waitForDrain(); if (!w.ok) { console.error(w.message); process.exit(1); } }
    await busyMod.markDoneRunning(targetId, whoAmI(flags)).catch(() => {});
    let done;
    try {
      done = completeTask(targetId, flags.note || '', whoAmI(flags), { force: Boolean(flags.force), reason: typeof flags.reason === 'string' ? flags.reason : '', acceptedBy: typeof flags['accepted-by'] === 'string' ? flags['accepted-by'] : '', noop: typeof flags['no-op'] === 'string' ? flags['no-op'] : '' });
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
      const all2 = readHolds();
      all2[arg1] = { ...(all2[arg1] || {}), lane };
      fs.writeFileSync(path.join(REPO_ROOT, 'studio', 'task-holds.json'), `${JSON.stringify({ tasks: all2 }, null, 2)}\n`);
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
    const title = flags._.slice(1).join(' ');
    if (!title) {
      console.error('Usage: node harness/task.mjs add "<Task Title>" [--role builder] [--priority P1] [--type bug|study|balance|fun|playtest|review|docs|idea] [--size 1-5] [--caused-by T-012] [--phase 1|2|3 --serves pillar:<name>|layer:<id>] [--idea I-001] [--part sim|renderer|both] [--lane <folder>] [--paths a.js,b.js] [--after T-011] [--track web|engine:<name>] [--prototype | --infra] [--origin dev|agent] [--asked "<the dev\'s words>"] [--mechanic] [--tricks 1-6]');
      process.exit(1);
    }
    // --type bug|study|balance|fun|playtest|review|docs puts the matching prefix on the title.
    const type = typeof flags.type === 'string' ? flags.type.toLowerCase() : '';
    if (type && !['bug', 'study', 'balance', 'fun', 'playtest', 'review', 'docs', 'idea', 'system'].includes(type)) {
      console.error(`Unknown --type "${flags.type}". Use bug, study, balance, fun, playtest, review, docs, idea or system.`);
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
    const created = addTask({
      title: `${prefix}${title}`,
      role: flags.role || 'builder',
      priority: flags.priority || 'P1',
      agent: typeof flags.agent === 'string' ? flags.agent : actor(),
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
    if (created.split) console.error(`note: size ${size} is over the builder cap of ${SIZE_CAP}; ${created.split} (planner) splits it first.`);
    if (created.tricks) console.error(`note: pre-approved cheat sheet tricks: ${created.tricks.join(', ')}`);
    console.log(JSON.stringify(created, null, 2));
    process.exit(0);
  }

  console.log('Usage: node harness/task.mjs [next | list | start <ID> [--model m] | pause <ID> --note "..." | done <ID> | add "<Title>" [--after T-x] | park|unpark|unblock <ID> | block <ID> --until <T-ID|time> | lane <ID> <folder|a.js,b.js|none> | holds | yes <ID> --by <dev> | drop <ID> --why "…" | reorder <ID> --to top|bottom|<n> | --before <ID>]');
}
