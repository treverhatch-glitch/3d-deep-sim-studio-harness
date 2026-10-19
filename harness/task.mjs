#!/usr/bin/env node
/**
 * harness/task.mjs — Markdown Task Queue Manager (`studio/NEXT.md`)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitEvent, REPO_ROOT } from './event.mjs';
import { claim, release } from './lock.mjs';

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

export function startTask(taskId, agentOverride = null) {
  const owner = agentOverride || 'agent';
  const lockRes = claim(`task:${taskId}`, owner);
  if (!lockRes.ok) {
    emitEvent({
      type: 'task.lock_denied',
      agent: owner,
      task: taskId,
      status: 'blocked',
      msg: `Task ${taskId} already claimed`,
    });
    return { error: 'locked', lock: lockRes.lock || null };
  }

  const q = parseNextQueue();
  let target = q.inProgress.find((t) => t.id === taskId);
  if (!target) {
    const idx = q.backlog.findIndex((t) => t.id === taskId);
    if (idx === -1) {
      release(`task:${taskId}`, owner);
      return null;
    }
    [target] = q.backlog.splice(idx, 1);
    if (agentOverride) target.role = agentOverride;
    target.status = 'in_progress';
    q.inProgress.unshift(target);
  }
  writeNextQueue(q);
  syncCurrentTaskCheckpoint(target, `Started ${target.id} (${target.role})`);
  emitEvent({
    type: 'task.start',
    agent: target.role,
    task: target.id,
    status: 'editing',
    msg: `Started ${target.id}: ${target.title}`,
  });
  return target;
}

export function completeTask(taskId, note = '') {
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

  target.status = 'done';
  if (note) target.title = `${target.title} _(✓ ${note})_`;
  q.done.unshift(target);
  writeNextQueue(q);
  release(`task:${taskId}`, target.role);

  const nextActive = q.inProgress[0] || null;
  syncCurrentTaskCheckpoint(nextActive, `Completed ${target.id}${note ? `: ${note}` : ''}`);
  emitEvent({
    type: 'task.done',
    agent: target.role,
    task: target.id,
    status: 'done',
    msg: `Completed ${target.id}: ${target.title}`,
  });
  return target;
}

export function addTask({ title, role = 'builder', priority = 'P1' }) {
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
    agent: 'producer',
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
      console.error('Usage: node harness/task.mjs start <TASK_ID>');
      process.exit(1);
    }
    const started = startTask(targetId, flags.agent || null);
    if (!started) {
      console.error(`Task "${targetId}" not found.`);
      process.exit(1);
    }
    if (started.error === 'locked') {
      console.error(`Task "${targetId}" is locked.`);
      console.log(JSON.stringify(started, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify(started, null, 2));
    process.exit(0);
  }

  if (cmd === 'done') {
    const targetId = arg1 || q.inProgress[0]?.id;
    if (!targetId) {
      console.error('Usage: node harness/task.mjs done <TASK_ID> [--note "..."]');
      process.exit(1);
    }
    const done = completeTask(targetId, flags.note || '');
    if (!done) {
      console.error(`Task "${targetId}" not found.`);
      process.exit(1);
    }
    console.log(JSON.stringify(done, null, 2));
    process.exit(0);
  }

  if (cmd === 'add') {
    const title = flags._.slice(1).join(' ');
    if (!title) {
      console.error('Usage: node harness/task.mjs add "<Task Title>" [--role builder] [--priority P1]');
      process.exit(1);
    }
    const created = addTask({
      title,
      role: flags.role || 'builder',
      priority: flags.priority || 'P1',
    });
    console.log(JSON.stringify(created, null, 2));
    process.exit(0);
  }

  console.log('Usage: node harness/task.mjs [next | list | start <ID> | done <ID> | add "<Title>"]');
}
