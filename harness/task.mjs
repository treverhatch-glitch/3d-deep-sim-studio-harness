#!/usr/bin/env node
/**
 * harness/task.mjs — Markdown Task Queue Manager (`studio/NEXT.md`)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitEvent, REPO_ROOT } from './event.mjs';
import { claim, release, status as lockStatus, listLocks } from './lock.mjs';
import { checkDone } from './done-check.mjs';

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

export function startTask(taskId, agent = null, { model = null } = {}) {
  if (!agent) return { error: 'owner-required', message: 'Pass --agent <unique-name> so the task lock has an owner.' };
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
  syncCurrentTaskCheckpoint(target, `Started ${target.id} (${target.role}) — owner ${agent}`);
  const handoff = readTaskHandoff(target.id);
  emitEvent({ type: 'task.start', agent, model, task: target.id, status: 'editing', msg: `${handoff ? 'Picked up' : 'Started'} ${target.id}: ${target.title}` });
  return { ...target, owner: agent, ...(handoff ? { handoff } : {}) };
}

/**
 * Only the lock owner can finish a claimed task, and only once the done-check for its type passes
 * (harness/done-check.mjs). force skips both; a skipped check is logged and the Producer gets a
 * P1 task to run it.
 */
export function completeTask(taskId, note = '', agent = null, { force = false } = {}) {
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
        ...check.missing.map((m) => `  missing: ${m}`),
        check.skill ? `How: ${check.skill}` : '',
        'To finish anyway: --force (logged, and the Producer gets a task to run the check).',
      ].filter(Boolean).join('\n'),
    };
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
      msg: `Forced ${target.id} done without: ${check.missing[0]}`,
      meta: { type: check.type, missing: check.missing },
    });
    const followUp = addTask({ title: `Check forced done ${target.id} (${check.type}): ${check.missing[0]}`, role: 'producer', priority: 'P1' });
    return { ...target, forced: true, check, followUp: followUp.id };
  }
  return target;
}

/**
 * Hand a task back: the agent is out of usage, being swapped, or stuck. The task goes to the top of
 * the queue, the claim is released, and the note tells the next agent where things stand.
 * The watcher (harness/watch.mjs) does the same for claims that expired with no word.
 */
export function pauseTask(taskId, agent = null, note = '', { force = false } = {}) {
  const lock = lockStatus(`task:${taskId}`);
  if (lock.locked && lock.lock.owner !== agent && !force) {
    return { error: 'locked', message: `Task ${taskId} is claimed by ${lock.lock.owner}. Only that owner can hand it back.` };
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
  if (freed.length) note = `${note || 'No note left.'}\nReleased claims: ${freed.join(', ')}`;
  fs.mkdirSync(HANDOFF_DIR, { recursive: true });
  const file = handoffFile(taskId);
  const head = fs.existsSync(file) ? '' : `# Handoff notes for ${target.id}: ${target.title}\n\nNewest last. Read these before you pick the task up.\n`;
  fs.appendFileSync(file, `${head}\n## ${new Date().toISOString()} · ${who}\n${note || 'No note left.'}\n`);
  syncCurrentTaskCheckpoint(q.inProgress[0] || null, `Paused ${target.id}: ${note || 'handed back'}`);
  emitEvent({ type: 'task.paused', agent: who, task: target.id, status: 'paused', msg: `Handed back ${target.id}: ${note || 'no note'}` });
  return { ...target, handoffFile: path.relative(REPO_ROOT, file) };
}

export function addTask({ title, role = 'builder', priority = 'P1', agent = 'producer' }) {
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
  emitEvent({
    type: 'task.added',
    agent,
    task: newTask.id,
    msg: `Queued ${newTask.id} [${newTask.priority}] (${newTask.role}): ${newTask.title}`,
  });
  return newTask;
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
    const active = q.inProgress[0] || q.backlog[0] || null;
    if (!active) {
      console.log('No tasks in IN_PROGRESS or BACKLOG.');
      process.exit(0);
    }
    console.log(JSON.stringify(active, null, 2));
    process.exit(0);
  }

  if (cmd === 'list') {
    console.log(JSON.stringify(q, null, 2));
    process.exit(0);
  }

  if (cmd === 'start') {
    const targetId = arg1 || q.backlog[0]?.id;
    if (!targetId) {
      console.error('Usage: node harness/task.mjs start <TASK_ID> --agent <unique-name>');
      process.exit(1);
    }
    const started = startTask(targetId, flags.agent || process.env.STUDIO_LOCK_OWNER || null, { model: typeof flags.model === 'string' ? flags.model : null });
    if (!started) {
      console.error(`Task "${targetId}" not found.`);
      process.exit(1);
    }
    if (started.error) {
      console.error(started.error === 'locked' ? `Task "${targetId}" is claimed by ${started.lock?.owner}. Pick another task.` : started.message);
      process.exit(1);
    }
    if (started.handoff) console.error(`Picking up where someone else stopped. Notes (studio/handoffs/${started.id}.md):\n${started.handoff}`);
    console.log(JSON.stringify(started, null, 2));
    process.exit(0);
  }

  if (cmd === 'pause') {
    const targetId = arg1;
    const res = targetId && pauseTask(targetId, flags.agent || process.env.STUDIO_LOCK_OWNER || null, typeof flags.note === 'string' ? flags.note : '', { force: Boolean(flags.force) });
    if (!res) {
      console.error('Usage: node harness/task.mjs pause <TASK_ID> --agent <owner> --note "where you stopped and what is left"');
      process.exit(1);
    }
    if (res.error) {
      console.error(res.message);
      process.exit(1);
    }
    console.log(`${res.id} is back at the top of the queue. Notes: ${res.handoffFile}`);
    process.exit(0);
  }

  if (cmd === 'done') {
    const targetId = arg1 || q.inProgress[0]?.id;
    if (!targetId) {
      console.error('Usage: node harness/task.mjs done <TASK_ID> --agent <owner> [--note "..."] [--force]');
      process.exit(1);
    }
    const done = completeTask(targetId, flags.note || '', flags.agent || process.env.STUDIO_LOCK_OWNER || null, { force: Boolean(flags.force) });
    if (!done) {
      console.error(`Task "${targetId}" not found.`);
      process.exit(1);
    }
    if (done.error) {
      console.error(done.message);
      process.exit(1);
    }
    if (done.forced) console.error(`Forced past the ${done.check.type} check. The Producer has ${done.followUp} to run it.`);
    console.log(JSON.stringify(done, null, 2));
    process.exit(0);
  }

  if (cmd === 'add') {
    const title = flags._.slice(1).join(' ');
    if (!title) {
      console.error('Usage: node harness/task.mjs add "<Task Title>" [--role builder] [--priority P1] [--type bug|study|balance|fun|playtest|review|docs]');
      process.exit(1);
    }
    // --type bug|study|balance|fun|playtest|review|docs puts the matching prefix on the title.
    const type = typeof flags.type === 'string' ? flags.type.toLowerCase() : '';
    if (type && !['bug', 'study', 'balance', 'fun', 'playtest', 'review', 'docs'].includes(type)) {
      console.error(`Unknown --type "${flags.type}". Use bug, study, balance, fun, playtest, review or docs.`);
      process.exit(1);
    }
    const prefix = type && !title.toLowerCase().startsWith(type) ? `${type[0].toUpperCase()}${type.slice(1)}: ` : '';
    const created = addTask({
      title: `${prefix}${title}`,
      role: flags.role || 'builder',
      priority: flags.priority || 'P1',
    });
    console.log(JSON.stringify(created, null, 2));
    process.exit(0);
  }

  console.log('Usage: node harness/task.mjs [next | list | start <ID> [--model m] | pause <ID> --note "..." | done <ID> | add "<Title>"]');
}
