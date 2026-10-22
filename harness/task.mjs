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
import { checkDone, taskType } from './done-check.mjs';
import { readBible, crossedLayersIn, readIdea, writeIdea, latestReview, LAYERS } from './bible.mjs';
import { writeFocus } from './focus.mjs';
import { causeOf, isAccepted } from './cause-store.mjs';
import { holdReason, setHold, readHolds } from './task-hold.mjs';
import { savePatch } from './wip.mjs';
import { inLaneCopy, catchUp, carryTaskBranch, deliver } from './worktree.mjs';

export const NEXT_FILE = path.join(REPO_ROOT, 'studio', 'NEXT.md');
export const CURRENT_TASK_FILE = path.join(REPO_ROOT, 'studio', 'CURRENT_TASK.md');

const TASK_LINE_RE = /^-\s+\[([ x>~])\]\s+\*\*([A-Z]+-\d+)\*\*\s+\[(P[0-3])\]\s+\(`([^`]+)`\)\s+—\s+(.+)$/;

export function parseNextQueue() {
  if (!fs.existsSync(NEXT_FILE)) {
    return { inProgress: [], backlog: [], done: [] };
  }
  const lines = fs.readFileSync(NEXT_FILE, 'utf8').replace(/\r\n/g, '\n').split('\n');
  let section = 'backlog';
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

export function writeNextQueue(tasks) {
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
    ...(tasks.done.length
      ? tasks.done.map((t) => formatTaskLine(t, 'x'))
      : ['_No completed tasks yet._']),
    '',
  ];
  fs.mkdirSync(path.dirname(NEXT_FILE), { recursive: true });
  fs.writeFileSync(NEXT_FILE, out.join('\n'), 'utf8');
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
 * Only the lock owner can finish a claimed task, and only once the done-check for its type passes
 * (harness/done-check.mjs). force skips both; a skipped check is logged and the Producer gets a
 * P1 task to run it.
 */
export function completeTask(taskId, note = '', agent = null, { force = false, reason = '', acceptedBy = '' } = {}) {
  const lock = lockStatus(`task:${taskId}`);
  if (lock.locked && lock.lock.owner !== agent && !force) {
    return { error: 'locked', lock: lock.lock, message: `Task ${taskId} is claimed by ${lock.lock.owner}. Finish it as that owner or pass --force.` };
  }
  const q = parseNextQueue();
  let idx = q.inProgress.findIndex((t) => t.id === taskId);
  let target = null;
  if (idx !== -1) {
    [target] = q.inProgress.splice(idx, 1);
  } else {
    idx = q.backlog.findIndex((t) => t.id === taskId);
    if (idx !== -1) [target] = q.backlog.splice(idx, 1);
  }
  if (!target) return null;

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

  // In a lane copy (2.29), done is when the work reaches the studio's branch: committed, rebased on the
  // latest, checked again if that moved, then added. Forced or not, uncommitted work is refused here.
  if (inLaneCopy()) {
    const d = deliver(taskId);
    if (d && !d.ok) {
      emitEvent({ type: 'task.not_done', agent: agent || target.role, task: target.id, status: 'blocked', msg: `${target.id} not done yet: ${d.message.split('.')[0]}` });
      return { error: 'not-delivered', message: d.message };
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

  target.status = 'done';
  if (note) target.title = `${target.title} _(✓ ${note})_`;
  q.done.unshift(target);
  writeNextQueue(q);
  if (lock.locked) release(`task:${taskId}`, lock.lock.owner);

  const nextActive = q.inProgress[0] || null;
  syncCurrentTaskCheckpoint(nextActive, `Completed ${target.id}${note ? `: ${note}` : ''}`);
  emitEvent({ type: 'task.done', agent: agent || target.role, task: target.id, status: 'done', to: 'producer', msg: `Completed ${target.id}: ${target.title}` });

  if (!check.ok) {
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
  if (capLines.length > 20 || String(note || '').length > 2400) note = `${capLines.slice(0, 20).join('\n').slice(0, 2400)}\n(Cut to 20 lines. Keep hand-back notes short: done, not done, files touched, next step, proof.)`;
  if (freed.length) note = `${note || 'No note left.'}\nReleased claims: ${freed.join(', ')}`;
  fs.mkdirSync(HANDOFF_DIR, { recursive: true });
  const file = handoffFile(taskId);
  const head = fs.existsSync(file) ? '' : `# Handoff notes for ${target.id}: ${target.title}\n\nNewest last. Read these before you pick the task up.\n`;
  fs.appendFileSync(file, `${head}\n## ${new Date().toISOString()} · ${who}\n${note || 'No note left.'}\n`);
  syncCurrentTaskCheckpoint(q.inProgress[0] || null, `Paused ${target.id}: ${note || 'handed back'}`);
  emitEvent({ type: 'task.paused', agent: who, task: target.id, status: 'paused', msg: `Handed back ${target.id}: ${note || 'no note'}` });
  // "blocked by T-12" (or "waits for", "needs T-12 first") in the note: hold the task until T-12 is done,
  // so it isn't picked up again only to be handed back for the same reason (Jed's run).
  const deps = [...String(note || '').matchAll(/\b(?:blocked (?:by|on)|waits? (?:for|on)|needs|after)\s+((?:T-\d+(?:\s*(?:,|and)\s*)?)+)/gi)].flatMap((m) => m[1].match(/T-\d+/g) || []);
  const open = deps.filter((d) => d !== target.id && !q.done.some((t) => t.id === d) && [...q.inProgress, ...q.backlog].some((t) => t.id === d));
  if (open.length) setHold(target.id, { after: [...new Set([...(readHolds()[target.id]?.after || []), ...open])] }, { by: who, msg: `${target.id} waits for ${open.join(', ')} (from ${who}'s hand-back note)` });
  return { ...target, handoffFile: path.relative(REPO_ROOT, file), waitsFor: open };
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
  if (phase > (b.phase?.open || 1)) return { ok: false, message: `Phase ${phase} isn't open yet (Phase ${b.phase?.open || 1} is). Finish and prove the earlier phase first; designing later phases is fine as a study or docs task.` };
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
  q.backlog.push(newTask);
  writeNextQueue(q);
  if (meta.after?.length) setHold(newTask.id, { after: meta.after });
  emitEvent({
    type: 'task.added',
    agent,
    task: newTask.id,
    msg: `Queued ${newTask.id} [${newTask.priority}] (${newTask.role}): ${newTask.title}`,
    meta,
  });
  if (meta.idea) {
    const idea = readIdea(meta.idea);
    writeIdea({ ...idea, stage: 'scheduled', tasks: [...new Set([...(idea.tasks || []), newTask.id])], history: [...(idea.history || []), { stage: 'scheduled', at: new Date().toISOString(), by: agent, note: newTask.id }] });
  }
  return gate.warnings.length ? { ...newTask, warnings: gate.warnings } : newTask;
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

  if (cmd === 'list') {
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
    const started = startTask(targetId, flags.agent || process.env.STUDIO_LOCK_OWNER || null, { model: typeof flags.model === 'string' ? flags.model : null, force: Boolean(flags.force) });
    if (!started) {
      console.error(`Task "${targetId}" not found.`);
      process.exit(1);
    }
    if (started.error) {
      console.error(started.error === 'locked' ? `Task "${targetId}" is claimed by ${started.lock?.owner}. Pick another task.` : started.message);
      process.exit(1);
    }
    if (started.brief) console.error(`Your brief: ${started.brief} (read it instead of the repo)`);
    if (started.handoff) console.error(`Picking up where someone else stopped. Notes (studio/handoffs/${started.id}.md):\n${started.handoff}`);
    if (started.carried) console.error(`The earlier agent's commits on ${started.carried} are merged into your copy.`);
    console.log(JSON.stringify(started, null, 2));
    process.exit(0);
  }

  if (cmd === 'pause') {
    const targetId = arg1;
    const res = targetId && pauseTask(targetId, flags.agent || process.env.STUDIO_LOCK_OWNER || null, typeof flags.note === 'string' ? flags.note : '', { force: Boolean(flags.force) });
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
      console.error('Usage: node harness/task.mjs done <TASK_ID> --agent <owner> [--note "..."] [--force]');
      process.exit(1);
    }
    const done = completeTask(targetId, flags.note || '', flags.agent || process.env.STUDIO_LOCK_OWNER || null, { force: Boolean(flags.force), reason: typeof flags.reason === 'string' ? flags.reason : '', acceptedBy: typeof flags['accepted-by'] === 'string' ? flags['accepted-by'] : '' });
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
      const lane = folder === 'none' ? null : folder.replace(/\\/g, '/').replace(/\/+$/, '');
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

  if (cmd === 'add') {
    const title = flags._.slice(1).join(' ');
    if (!title) {
      console.error('Usage: node harness/task.mjs add "<Task Title>" [--role builder] [--priority P1] [--type bug|study|balance|fun|playtest|review|docs|idea] [--size 1-5] [--caused-by T-012] [--phase 1|2|3 --serves pillar:<name>|layer:<id>] [--idea I-001] [--part sim|renderer|both] [--lane <folder>] [--after T-011] [--track web|engine:<name>] [--prototype | --infra]');
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
        ...(causedBy ? { causedBy } : {}),
        ...(flags.phase !== undefined ? { phase: Number(flags.phase) } : {}),
        ...(typeof flags.serves === 'string' ? { serves: flags.serves } : {}),
        ...(typeof flags.idea === 'string' ? { idea: flags.idea } : {}),
        ...(typeof flags.part === 'string' ? { part: flags.part } : {}),
        ...(typeof flags.lane === 'string' ? { lane: flags.lane.replace(/\/+$/, '') } : {}),
        ...(typeof flags.track === 'string' ? { track: flags.track } : {}),
        ...(typeof flags.after === 'string' ? { after: flags.after.split(/[,\s]+/).filter((x) => /^[A-Z]+-\d+$/.test(x)) } : {}),
        ...(flags.prototype ? { prototype: true } : {}),
        ...(flags.infra ? { infra: true } : {}),
        ...(typeof flags['not-layer'] === 'string' ? { notLayer: flags['not-layer'] } : {}),
      },
    });
    if (created.error) {
      console.error(`Not queued. ${created.message}`);
      process.exit(1);
    }
    for (const w of created.warnings || []) console.error(`note: ${w}`);
    console.log(JSON.stringify(created, null, 2));
    process.exit(0);
  }

  console.log('Usage: node harness/task.mjs [next | list | start <ID> [--model m] | pause <ID> --note "..." | done <ID> | add "<Title>" [--after T-x] | park|unpark <ID> | block <ID> --until <T-ID|time> | lane <ID> <folder|none> | holds]');
}
