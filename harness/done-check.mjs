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
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, readRecentEvents } from './event.mjs';
import { isSha256 } from './hash.mjs';
import { parseNextQueue } from './task.mjs';
import { parseReview, readIdea } from './bible.mjs';

const PREFIX = [
  [/^(bug|fix)\b/i, 'bug'],
  [/^study\b/i, 'study'],
  [/^balance\b/i, 'balance'],
  [/^fun\b/i, 'fun'],
  [/^playtest\b/i, 'playtest'],
  [/^review\b/i, 'review'],
  [/^docs?\b/i, 'docs'],
  [/^check forced done\b/i, 'none'],
  [/^director review\b/i, 'direction'],
  [/^idea\b/i, 'idea'],
  [/^(plan|sign the game bible|ideas:)\b/i, 'none'],
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
  director: 'direction',
  liaison: 'none',
  rnd: 'idea',
  planner: 'idea',
};

export const TYPES = {
  change: { skill: 'studio/skills/builder.md', means: 'changes exist for the task, and a full `npm run verify` passed after the last of them' },
  bug: { skill: 'studio/skills/bug.md', means: 'a regression with seed, tick and pinned hash, a lesson naming the bug, changes for the fix, and a green verify after the last change' },
  balance: { skill: 'studio/skills/balance.md', means: 'a sweep of the current tuning, newer than the last game change; a person picks the number' },
  fun: { skill: 'studio/skills/playtest.md', means: 'a fun report newer than the task start and the last game change' },
  playtest: { skill: 'studio/skills/playtest.md', means: 'a playtest report on the current build with seed, ticks, hash, and the failing tick if it failed' },
  study: { skill: 'studio/skills/study.md', means: 'a study.md of 120+ words under studio/research/, written after the task started' },
  review: { skill: 'studio/skills/review.md', means: 'a review note naming the task or commit it reviewed, with a verdict' },
  docs: { skill: 'studio/skills/docs.md', means: 'a changed .md file, and a full `npm run verify` after the last change' },
  direction: { skill: 'studio/skills/direction.md', means: 'a dated review in studio/bible/reviews/ since the task started, naming the phase, what it checked, a verdict, and next tasks' },
  idea: { skill: 'studio/skills/ideas.md', means: 'the idea named in the title moved to its next stage (shaped, placed, or decided) since the task started' },
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

// ---- what changed, and when ----
const BOOKKEEPING = /^(\.studio\/|studio\/(NEXT\.md|CURRENT_TASK\.md|handoffs\/|meetings\/|producer\/|game\/|memory\/retros\/|harness-notes\/)|qa\/reports\/)/;
const WORK_DIRS = ['cartridges', 'src', 'harness', 'hub', 'qa', 'scripts', 'tools', 'docs', 'studio'];
const git = (...args) => {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
};
function walkSince(rel, since, out, depth = 0) {
  const dir = abs(rel);
  if (depth > 6 || !fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const child = path.posix.join(rel, e.name);
    if (e.isDirectory()) walkSince(child, since, out, depth + 1);
    else if (!BOOKKEEPING.test(child) && mtime(child) >= since) out.push(child);
  }
}
/** Evidence that work happened for this task: tagged commits, untagged commits since the start, or edits on disk. */
export function taskChanges(taskId, since) {
  const files = new Set();
  let lastAt = 0;
  const log = git('log', `--since=${Math.floor(since / 1000)}`, '--format=%x1e%H%x09%ct%x09%(trailers:key=Studio-Task,valueonly,separator=%x2C)', '--name-only');
  const commits = [];
  if (log !== null) {
    for (const block of log.split('\x1e').slice(1)) {
      const [head, ...names] = block.trim().split('\n');
      const [hash, ct, tasks] = head.split('\t');
      const tagged = (tasks || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (tagged.length && !tagged.includes(taskId)) continue; // someone else's task
      if (!tagged.length && Number(ct) * 1000 < since) continue; // same second as the start, but before it
      const touched = names.filter((n) => n && !BOOKKEEPING.test(n));
      if (!touched.length) continue;
      commits.push({ hash, at: Number(ct) * 1000, tagged: tagged.includes(taskId) });
      touched.forEach((n) => files.add(n));
      lastAt = Math.max(lastAt, Number(ct) * 1000);
    }
    const status = git('status', '--porcelain') || '';
    for (const line of status.split('\n').filter(Boolean)) {
      const f = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop();
      if (BOOKKEEPING.test(f)) continue;
      const m = mtime(f);
      if (m >= since) {
        files.add(f);
        lastAt = Math.max(lastAt, m);
      }
    }
  } else {
    // Not a git checkout: fall back to files modified since the task started.
    const out = [];
    for (const d of WORK_DIRS) walkSince(d, since, out);
    out.forEach((f) => {
      files.add(f);
      lastAt = Math.max(lastAt, mtime(f));
    });
  }
  return { files: [...files], commits, lastAt };
}
/** The last time game code changed (cartridges/, src/): reports older than this describe an old build. */
function lastGameChange() {
  const out = [];
  for (const d of ['cartridges', 'src']) walkSince(d, 0, out);
  return out.reduce((m, f) => Math.max(m, mtime(f)), 0);
}
function gatesAfter(at) {
  let run = null;
  try {
    run = JSON.parse(fs.readFileSync(abs('.studio/gates-last.json'), 'utf8'));
  } catch {
    return 'no full `npm run verify` has been recorded';
  }
  if (run.partial) return 'the last verify was a partial run (--only); run the full `npm run verify`';
  if ((Date.parse(run.at) || 0) < at) return 'no full `npm run verify` after your last change; run it again';
  const red = (run.rows || []).filter((r) => r.required && !r.ok).map((r) => r.id);
  return red.length ? `the last verify failed: ${red.join(', ')}` : null;
}
const readJson = (rel) => {
  try {
    return JSON.parse(fs.readFileSync(abs(rel), 'utf8'));
  } catch {
    return null;
  }
};
const words = (rel) => (fs.readFileSync(abs(rel), 'utf8').match(/[A-Za-z0-9]{2,}/g) || []).length;

/**
 * Returns { ok, type, means, skill, checks: [{ label, ok, why }], missing: [why…] }.
 * Each check reads what the work contains, not only when a file was touched.
 */
export function checkDone(task, since = startedAt(task.id)) {
  const type = taskType(task);
  const checks = [];
  const check = (label, ok, why) => checks.push({ label, ok: Boolean(ok), why: ok ? null : why });

  const workAndVerify = (docsOnly = false) => {
    const ch = taskChanges(task.id, since);
    const relevant = docsOnly ? ch.files.filter((f) => f.endsWith('.md')) : ch.files;
    check(docsOnly ? 'Docs changed for this task' : 'Changes exist for this task', relevant.length, docsOnly ? 'no changed .md file since this task started' : `no changes found for ${task.id}: no commit tagged Studio-Task: ${task.id} and no edits since it started`);
    const why = gatesAfter(Math.max(since, ch.lastAt));
    check('Full verify green after the last change', !why, why);
  };

  if (type === 'change') workAndVerify();
  if (type === 'docs') workAndVerify(true);
  if (type === 'bug') {
    const regs = newestSince(filesUnder('qa/regressions', (n) => n.endsWith('.json')), since)
      .map((f) => ({ f, j: readJson(f) }))
      .filter(({ j }) => j && Number.isInteger(j.seed) && Number.isInteger(j.tick) && isSha256(j.sha256));
    check('Regression saved with seed, tick and a pinned hash', regs.length, 'no regression in qa/regressions/ with a seed, a tick and a pinned hash since this task started (save the replay, then `node qa/check-regressions.mjs --update`)');
    const lessons = fs.existsSync(abs('studio/memory/failures.md')) ? fs.readFileSync(abs('studio/memory/failures.md'), 'utf8').match(/^### .+$/gm) || [] : [];
    const ids = [task.id, ...(task.title.match(/\b(BUG|REG)-[\w-]+/g) || []), ...regs.map(({ j }) => j.id).filter(Boolean)];
    const day = new Date(since).toISOString().slice(0, 10);
    const named = lessons.some((h) => ids.some((id) => h.includes(id)));
    const dated = lessons.some((h) => (h.match(/\[(\d{4}-\d{2}-\d{2})\]/) || [])[1] >= day) && mtime('studio/memory/failures.md') >= since;
    check('Lesson written in studio/memory/failures.md', named || dated, `no lesson in studio/memory/failures.md naming ${ids.join(' or ')} or dated since the task started (\`bash scripts/distill-bug.sh\`)`);
    workAndVerify();
  }
  const fresh = lastGameChange();
  if (type === 'balance') {
    const rel = 'studio/balance/latest.md';
    check('Sweep written since the task started', mtime(rel) >= since, 'no sweep since this task started (`npm run balance`)');
    check('Sweep covers the current tuning value', fs.existsSync(abs(rel)) && /\(current\)/.test(fs.readFileSync(abs(rel), 'utf8')), 'the sweep has no "(current)" row; it was not run against the game\'s current tuning');
    check('Sweep is newer than the last game change', mtime(rel) >= fresh, 'the game changed after the sweep; run `npm run balance` again');
  }
  if (type === 'fun') {
    check('Fun report since the task started', mtime('studio/fun/latest.md') >= since, 'no fun report since this task started (`npm run fun`)');
    check('Fun report is newer than the last game change', mtime('studio/fun/latest.md') >= fresh, 'the game changed after the fun report; run `npm run fun` again');
  }
  if (type === 'playtest') {
    const reps = newestSince(filesUnder('qa/reports', (n) => /^qa_.*\.json$/.test(n)), since).map((f) => ({ f, j: readJson(f) })).filter(({ j }) => j?.stage1);
    check('Playtest report since the task started', reps.length, 'no playtest report in qa/reports/ since this task started (`npm run playtest:stage1`)');
    const good = reps.filter(({ f, j }) => mtime(f) >= fresh && j.stage1.seed != null && j.stage1.ticksRun != null && j.stage1.finalHash && (j.passed || j.stage1.failingTick != null));
    check('Report covers the current build with seed, ticks and hash (and the failing tick if it failed)', good.length, 'no report on the current build with a seed, ticks, a hash and (if it failed) the failing tick; run the playtest again');
  }
  if (type === 'study') {
    const studies = newestSince(filesUnder('studio/research', (n) => n === 'study.md', true), since);
    check('study.md written since the task started', studies.length, 'no study.md under studio/research/ since this task started (layout ideas: docs/GAME-STUDY.md)');
    check('Study has substance (120+ words)', studies.some((f) => words(f) >= 120), 'the study is under 120 words; write the findings and the tasks they lead to');
  }
  if (type === 'review') {
    const notes = newestSince(filesUnder('studio/reviews', (n) => n.endsWith('.md') && n !== 'README.md'), since).map((f) => fs.readFileSync(abs(f), 'utf8'));
    check('Review note since the task started', notes.length, 'no review note in studio/reviews/ since this task started');
    check('Note names what it reviewed (a task ID or commit)', notes.some((t) => /\bT-\d+\b|\b[0-9a-f]{7,40}\b/.test(t)), 'the review note doesn\'t name the task or commit it reviewed');
    check('Note gives a verdict', notes.some((t) => /\b(approve[sd]?|lgtm|request(ed)? changes|changes requested|reject(ed)?|blocking)\b/i.test(t)), 'the review note has no verdict (approve, request changes, or reject)');
  }
  if (type === 'direction') {
    const reviews = newestSince(filesUnder('studio/bible/reviews', (n) => n.endsWith('.md') && n !== 'README.md'), since).map((f) => parseReview(abs(f))).filter(Boolean);
    check('Review written in studio/bible/reviews/ since the task started', reviews.length, 'no review in studio/bible/reviews/ since this task started (`npm run director -- review` starts one)');
    check('Review names the phase (Phase: 1|2|3)', reviews.some((r) => r.phase), 'the review has no "Phase: 1|2|3" line');
    check('Review gives a verdict (on course, drifting, off course, phase-ready)', reviews.some((r) => r.verdict), 'the review has no "Verdict: on course|drifting|off course|phase-ready" line');
    check('Review says what it checked (pillars or layers)', reviews.some((r) => /pillar:|layer:/i.test(r.checked)), 'the review has no "Checked: pillar:… layer:…" line');
    check('Review lists next tasks', reviews.some((r) => r.next), 'the review has no "## Next" list');
  }
  if (type === 'idea') {
    const id = (task.title.match(/\bI-\d+\b/) || [])[0];
    const idea = id ? readIdea(id) : null;
    check('Title names an idea (I-001)', idea, id ? `no idea ${id} on the Idea Board` : 'the title names no idea (I-001)');
    const moved = idea && (idea.history || []).some((h) => Date.parse(h.at) >= since && ['shaped', 'placed', 'approved', 'parked', 'rejected'].includes(h.stage));
    check('The idea moved to its next stage since the task started', moved, `${id || 'the idea'} hasn't moved since this task started (npm run idea -- shape|place|decide ${id || 'I-…'})`);
  }
  const missing = checks.filter((c) => !c.ok).map((c) => c.why);
  return { ok: missing.length === 0, type, since, checks, missing, ...TYPES[type] };
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
  for (const c of res.checks) console.log(`  [${c.ok ? 'x' : ' '}] ${c.label}${c.ok ? '' : `: ${c.why}`}`);
  console.log(res.ok ? 'Ready to finish.' : 'Not done yet.');
  process.exit(res.ok ? 0 : 1);
}
