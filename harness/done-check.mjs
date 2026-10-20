#!/usr/bin/env node
/**
 * harness/done-check.mjs — a task is done when the check for its kind of work passes.
 *
 * `node harness/task.mjs done <ID>` runs this first and refuses while something is missing.
 * `--force` finishes anyway: it writes a task.forced event and queues a P1 check for the Producer.
 *
 *   node harness/done-check.mjs <TASK_ID>    show the type, what is checked and what is missing
 *
 * The type comes from a title prefix (Bug:, Fix, Study:, Balance:, Fun:, Playtest:, Review:, Docs:)
 * and otherwise from the role. Each type is described in studio/skills/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, readRecentEvents } from './event.mjs';
import { isHash64 } from './hash.mjs';
import { parseNextQueue } from './task.mjs';

const PREFIX = [
  [/^(bug|fix)\b/i, 'bug'],
  [/^study\b/i, 'study'],
  [/^balance\b/i, 'balance'],
  [/^fun\b/i, 'fun'],
  [/^playtest\b/i, 'playtest'],
  [/^review\b/i, 'review'],
  [/^docs?\b/i, 'docs'],
  [/^check forced done\b/i, 'none'],
];
const BY_ROLE = {
  producer: 'none',
  human: 'none',
  builder: 'change',
  'asset-3d': 'change',
  'qa-playtester': 'playtest',
  playtester: 'playtest',
  'designer-calibrator': 'balance',
  balancer: 'balance',
  'fun-tester': 'fun',
  reviewer: 'review',
  'reference-scout': 'study',
};

export const TYPES = {
  change: { skill: 'studio/skills/builder.md', means: 'a full `npm run verify` passed after the task started' },
  bug: { skill: 'studio/skills/bug.md', means: 'a pinned regression in qa/regressions/, a lesson in studio/memory/failures.md, and a green verify, all after the task started' },
  balance: { skill: 'studio/skills/balance.md', means: 'a sweep report (studio/balance/latest.md) written after the task started; a person picks the number' },
  fun: { skill: 'studio/skills/playtest.md', means: 'a fun report (studio/fun/latest.md) written after the task started' },
  playtest: { skill: 'studio/skills/playtest.md', means: 'a playtest report in qa/reports/ written after the task started' },
  study: { skill: 'studio/skills/study.md', means: 'a study.md under studio/research/ written after the task started' },
  review: { skill: 'studio/skills/review.md', means: 'a review note in studio/reviews/ written after the task started' },
  docs: { skill: 'studio/skills/docs.md', means: 'a full `npm run verify` passed after the task started' },
  none: { skill: null, means: 'nothing to check (coordination work)' },
};

export function taskType(task) {
  const title = String(task?.title || '');
  for (const [re, type] of PREFIX) if (re.test(title)) return type;
  return BY_ROLE[task?.role] || 'change';
}

/** When the work started: the last task.start event, else when it was queued, else the beginning of time. */
export function startedAt(taskId) {
  const events = readRecentEvents(20000);
  let added = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.task !== taskId) continue;
    if (e.type === 'task.start') return Date.parse(e.ts) || 0;
    if (e.type === 'task.added' && !added) added = Date.parse(e.ts) || 0;
  }
  return added;
}

const abs = (rel) => path.join(REPO_ROOT, rel);
const mtime = (rel) => {
  try {
    return fs.statSync(abs(rel)).mtimeMs;
  } catch {
    return -1;
  }
};
function filesUnder(rel, test, deep = false) {
  const dir = abs(rel);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.posix.join(rel, entry.name);
    if (entry.isDirectory() && deep) out.push(...filesUnder(child, test, deep));
    else if (entry.isFile() && test(entry.name, child)) out.push(child);
  }
  return out;
}
const newestSince = (files, since) => files.filter((f) => mtime(f) >= since);

function gatesSince(since) {
  let run = null;
  try {
    run = JSON.parse(fs.readFileSync(abs('.studio/gates-last.json'), 'utf8'));
  } catch {
    return 'no full `npm run verify` has been recorded';
  }
  if (run.partial) return 'the last verify was a partial run (--only); run the full `npm run verify`';
  if ((Date.parse(run.at) || 0) < since) return 'no full `npm run verify` since this task started';
  const red = (run.rows || []).filter((r) => r.required && !r.ok).map((r) => r.id);
  return red.length ? `the last verify failed: ${red.join(', ')}` : null;
}

/** Returns { ok, type, means, skill, missing: [..] }. */
export function checkDone(task, since = startedAt(task.id)) {
  const type = taskType(task);
  const missing = [];
  const need = (cond, msg) => {
    if (!cond) missing.push(msg);
  };
  const gates = () => {
    const why = gatesSince(since);
    if (why) missing.push(why);
  };

  if (type === 'change' || type === 'docs') gates();
  if (type === 'bug') {
    const pinned = newestSince(filesUnder('qa/regressions', (n) => n.endsWith('.json')), since).filter((f) => {
      try {
        return isHash64(JSON.parse(fs.readFileSync(abs(f), 'utf8')).hash);
      } catch {
        return false;
      }
    });
    need(pinned.length, 'no regression in qa/regressions/ with a pinned hash since this task started (add one, then `node qa/check-regressions.mjs --update`)');
    need(mtime('studio/memory/failures.md') >= since, 'no lesson added to studio/memory/failures.md since this task started (`bash scripts/distill-bug.sh`)');
    gates();
  }
  if (type === 'balance') need(mtime('studio/balance/latest.md') >= since, 'no sweep since this task started (`npm run balance`)');
  if (type === 'fun') need(mtime('studio/fun/latest.md') >= since, 'no fun report since this task started (`npm run fun`)');
  if (type === 'playtest') need(newestSince(filesUnder('qa/reports', (n) => /^qa_.*\.json$/.test(n)), since).length, 'no playtest report in qa/reports/ since this task started (`npm run playtest:stage1`)');
  if (type === 'study') {
    const studies = newestSince(filesUnder('studio/research', (n) => n === 'study.md', true), since).filter((f) => fs.readFileSync(abs(f), 'utf8').trim().length > 0);
    need(studies.length, 'no study.md under studio/research/ since this task started (layout ideas: docs/GAME-STUDY.md)');
  }
  if (type === 'review') need(newestSince(filesUnder('studio/reviews', (n) => n.endsWith('.md') && n !== 'README.md'), since).length, 'no review note in studio/reviews/ since this task started');

  return { ok: missing.length === 0, type, since, missing, ...TYPES[type] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const id = process.argv[2];
  const q = parseNextQueue();
  const task = [...q.inProgress, ...q.backlog, ...q.done].find((t) => t.id === id);
  if (!task) {
    console.error('Usage: node harness/done-check.mjs <TASK_ID>');
    process.exit(1);
  }
  const res = checkDone(task);
  console.log(`${task.id} is a "${res.type}" task. Done means: ${res.means}.${res.skill ? ` Skill: ${res.skill}` : ''}`);
  if (res.ok) console.log('Ready to finish.');
  else for (const m of res.missing) console.log(`  missing: ${m}`);
  process.exit(res.ok ? 0 : 1);
}
