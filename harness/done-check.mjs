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
import { failsBefore } from '../qa/fails-before.mjs';
import { modelFamily } from './families.mjs';
import { proofStatus } from './proof.mjs';
import { listLocks, coveringLock } from './lock.mjs';
import { overLimits, isGameCode, LIMITS } from '../scripts/check-function-size.mjs';

/** Which part of the game a task touches (task add --part sim|renderer|both); null when not said. */
export const partOf = (id) => readRecentEvents(20000).find((e) => e.type === 'task.added' && e.task === id)?.meta?.part || null;

/** The oldest commit tagged with this task (Studio-Task trailer), or null. */
function firstTaggedCommit(taskId) {
  const out = git('log', '--reverse', '--format=%H%x09%(trailers:key=Studio-Task,valueonly,separator=%x2C)');
  if (out === null) return undefined; // not a git checkout
  const line = out.split('\n').find((l) => (l.split('\t')[1] || '').split(',').map((x) => x.trim()).includes(taskId));
  return line ? line.split('\t')[0] : null;
}

const PREFIX = [
  // A bug in the docs (the docs gate, a .md file) closes like a docs task, not with a sim replay
  // (Jed's run: docs-gate bugs could only close with --force).
  [/^(bug|fix)\b.*\b(docs?[- ]gate|check-docs|[\w/-]+\.md)\b/i, 'docs'],
  [/^(bug|fix)\b/i, 'bug'],
  [/^system\b/i, 'system'],
  [/^study\b/i, 'study'],
  [/^balance\b/i, 'balance'],
  [/^fun\b/i, 'fun'],
  [/^playtest\b/i, 'playtest'],
  [/^review\b/i, 'review'],
  [/^docs?\b/i, 'docs'],
  [/^check forced done\b/i, 'none'],
  [/^director review\b/i, 'direction'],
  [/^idea\b/i, 'idea'],
  [/^art\b/i, 'art'],
  [/^trick hunt\b/i, 'trick'],
  [/^tricks:/i, 'none'],
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
  art: 'art',
  'dev-hacker': 'trick',
  artist: 'art',
  'art-director': 'art',
};

export const TYPES = {
  change: { skill: 'studio/skills/builder.md', means: 'changes exist for the task, and a full `npm run verify` passed after the last of them' },
  bug: { skill: 'studio/skills/bug.md', means: 'a regression with seed, tick and pinned SHA-256 that fails on the code before the fix, a lesson naming the bug, the fix committed with the task\'s tag, and a green verify after the last change' },
  balance: { skill: 'studio/skills/balance.md', means: 'a sweep of the current tuning, newer than the last game change; a person picks the number' },
  fun: { skill: 'studio/skills/playtest.md', means: 'a fun report newer than the task start and the last game change' },
  playtest: { skill: 'studio/skills/playtest.md', means: 'a playtest report on the current build with seed, ticks, hash, and the failing tick if it failed' },
  study: { skill: 'studio/skills/study.md', means: 'a study.md of 120+ words under studio/research/, written after the task started' },
  review: { skill: 'studio/skills/review.md', means: 'a review note naming the task or commit it reviewed, with a verdict' },
  docs: { skill: 'studio/skills/docs.md', means: 'a changed .md file, and a full `npm run verify` after the last change' },
  direction: { skill: 'studio/skills/direction.md', means: 'a dated review in studio/bible/reviews/ since the task started, naming the phase, what it checked, a verdict, and next tasks' },
  system: { skill: 'studio/skills/system.md', means: 'a spec with a hand-off in studio/bible/systems/, the sim change with a scenario in qa.mjs and updated goldens, a playtest of the current build, a green verify after the last change, and an approving review from another model family' },
  idea: { skill: 'studio/skills/ideas.md', means: 'the idea named in the title moved to its next stage (shaped, placed, or decided) since the task started' },
  art: { skill: 'studio/skills/art.md', means: 'designs proposed for the game dev since the task started (npm run art -- propose); approving them is the dev\'s call, not part of done' },
  trick: { skill: 'studio/skills/dev-hacker.md', means: 'a trick card proposed since the task started (npm run trick -- propose), or a note that nothing is worth doing now (npm run trick -- none "why")' },
  none: { skill: null, means: 'nothing to check (coordination work)' },
};

export function taskType(task) {
  const title = String(task?.title || '');
  for (const [re, type] of PREFIX) if (re.test(title)) return type;
  return BY_ROLE[task?.role] || 'change';
}

/**
 * When the work started: the first task.start since the task was last finished or reopened, else when it
 * was queued, else the beginning of time. The first, not the last: a task handed back and picked up again
 * keeps the work done before the hand-back (Jed's run: the second agent's done-check missed the first
 * agent's commits and asked for changes that were already there).
 */
export function startedAt(taskId) {
  const events = readRecentEvents(20000);
  let added = 0;
  let first = 0;
  let boundary = 0;
  for (const e of events) {
    if (e.task !== taskId) continue;
    const at = Date.parse(e.ts) || 0;
    if (e.type === 'task.added' && !added) added = at;
    if (e.type === 'task.done' || e.type === 'task.forced' || e.type === 'task.reopened') {
      first = 0;
      boundary = at;
    }
    else if (e.type === 'task.start' && !first) first = at;
  }
  return first || boundary || added;
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
const BOOKKEEPING = /^(package-lock\.json$|\.studio\/|studio\/(NEXT\.md|CURRENT_TASK\.md|handoffs\/|meetings\/|producer\/|game\/|memory\/retros\/|harness-notes\/|proof\/)|qa\/reports\/)/;
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
/** Evidence that work happened for this task: commits tagged with it (any time), untagged commits since the start, or edits on disk. */
export function taskChanges(taskId, since) {
  const files = new Set();
  let lastAt = 0;
  const base = taskBase(taskId);
  const afterBase = base ? new Set((git('rev-list', `${base}..HEAD`) || '').split('\n').filter(Boolean)) : null;
  const log = git('log', `--since=${Math.floor(since / 1000) - 1}`, '--format=%x1e%H%x09%ct%x09%(trailers:key=Studio-Task,valueonly,separator=%x2C)', '--name-only');
  const commits = [];
  if (log !== null) {
    for (const block of log.split('\x1e').slice(1)) {
      const [head, ...names] = block.trim().split('\n');
      const [hash, ct, tasks] = head.split('\t');
      const tagged = (tasks || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (tagged.length && !tagged.includes(taskId)) continue; // someone else's task
      // Untagged commits count when made after the task started: after the commit it started from when
      // that's recorded (2.29; git keeps whole seconds, so a quick agent's commit can share the start's
      // second), else by time.
      if (!tagged.length && (afterBase ? !afterBase.has(hash) : Number(ct) * 1000 < since)) continue;
      const touched = names.filter((n) => n && !BOOKKEEPING.test(n));
      if (!touched.length) continue;
      commits.push({ hash, at: Number(ct) * 1000, tagged: tagged.includes(taskId) });
      touched.forEach((n) => files.add(n));
      lastAt = Math.max(lastAt, Number(ct) * 1000);
    }
    // Work committed for this task before its latest start (handed back, then picked up) still counts.
    const seen = new Set(commits.map((c) => c.hash));
    const tagged = git('log', '-n2000', '--format=%x1e%H%x09%ct%x09%(trailers:key=Studio-Task,valueonly,separator=%x2C)', '--name-only') || '';
    for (const block of tagged.split('\x1e').slice(1)) {
      const [head, ...names] = block.trim().split('\n');
      const [hash, ct, tasks] = head.split('\t');
      if (seen.has(hash) || !(tasks || '').split(',').map((x) => x.trim()).includes(taskId)) continue;
      const touched = names.filter((n) => n && !BOOKKEEPING.test(n));
      if (!touched.length) continue;
      commits.push({ hash, at: Number(ct) * 1000, tagged: true, earlier: true });
      touched.forEach((n) => files.add(n));
      lastAt = Math.max(lastAt, Number(ct) * 1000);
    }
    const status = git('status', '--porcelain') || '';
    // Another agent's uncommitted work in its own claimed folder isn't this task's change (Jed's run: a
    // Producer's Check forced done could never clear while builders had edits in progress).
    const locks = listLocks();
    const mine = locks.find((l) => l.key === `task:${taskId}`)?.owner || null;
    for (const line of status.split('\n').filter(Boolean)) {
      const f = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop();
      if (BOOKKEEPING.test(f)) continue;
      const held = coveringLock(f, locks);
      if (held && held.owner !== mine) continue;
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
/** The commit a task started from (recorded on its first task.start since it was last finished or reopened). */
export function taskBase(taskId) {
  let base = null;
  for (const e of readRecentEvents(20000)) {
    if (e.task !== taskId) continue;
    if (e.type === 'task.done' || e.type === 'task.forced' || e.type === 'task.reopened') base = null;
    else if (e.type === 'task.start' && !base && e.meta?.head) base = e.meta.head;
  }
  return base;
}

/**
 * The size ratchet (2.29): game functions and files over the limit (scripts/check-function-size.mjs) that
 * this task made bigger, or created. Ones that were already that big and didn't grow are left to a split
 * task. Null when the start commit isn't known (a task started before 2.29).
 */
export function sizeGrowth(taskId, files) {
  const base = taskBase(taskId);
  if (!base) return null;
  const limits = LIMITS();
  const out = [];
  for (const f of files.filter((x) => isGameCode(x) && /\.(m?js|cjs|jsx|tsx?|gd)$/i.test(x) && fs.existsSync(abs(x)))) {
    let before = null;
    const r = spawnSync('git', ['show', `${base}:${f}`], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) before = r.stdout;
    let now, was;
    try {
      now = overLimits(f, fs.readFileSync(abs(f), 'utf8'), limits);
      was = before === null ? [] : overLimits(f, before, limits);
    } catch (err) {
      if (err.code !== 'STUDIO_NO_PARSER') throw err;
      out.push(`${f}: the size check ${err.message}`);
      continue;
    }
    for (const x of now) {
      const old = was.find((y) => y.kind === x.kind && y.name === x.name && y.unit === x.unit);
      if (!old || x.size > old.size) out.push(`${f}${x.kind === 'function' ? ` ${x.name}()` : ''} is ${x.size} ${x.unit}${old ? ` (was ${old.size})` : ''}, over the limit of ${x.limit}`);
    }
  }
  return out;
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
    // The agent's own full run first (2.29: in its own copy, the studio-wide record is someone else's code).
    const owner = process.env.STUDIO_LOCK_OWNER;
    const own = owner && /^[\w.-]+$/.test(owner) ? `.studio/gates/${owner}-full.json` : null;
    const file = own && fs.existsSync(abs(own)) ? own : fs.existsSync(abs('.studio/gates-last-full.json')) ? '.studio/gates-last-full.json' : '.studio/gates-last.json';
    run = JSON.parse(fs.readFileSync(abs(file), 'utf8'));
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
  const part = task.part || partOf(task.id);
  const seen = part === 'renderer' || part === 'both';
  const checks = [];
  const check = (label, ok, why) => checks.push({ label, ok: Boolean(ok), why: ok ? null : why });

  const workAndVerify = (docsOnly = false) => {
    const ch = taskChanges(task.id, since);
    const relevant = docsOnly ? ch.files.filter((f) => f.endsWith('.md')) : ch.files;
    check(docsOnly ? 'Docs changed for this task' : 'Changes exist for this task', relevant.length, docsOnly ? 'no changed .md file since this task started' : `no changes found for ${task.id}: no commit tagged Studio-Task: ${task.id} and no edits since it started`);
    const why = gatesAfter(Math.max(since, ch.lastAt));
    check('Full verify green after the last change', !why, why);
    if (!docsOnly) {
      const grew = sizeGrowth(task.id, ch.files);
      if (grew !== null) check('No function or file grown past the size limit', !grew.length, `${grew.slice(0, 3).join('; ')}. Split it first (move a part into its own function or file), or ask the Producer for a split task (npm run task -- add "Split …")`);
    }
  };

  if (type === 'change') workAndVerify();
  if (type === 'docs') workAndVerify(true);
  if (type === 'bug') {
    const regs = newestSince(filesUnder('qa/regressions', (n) => n.endsWith('.json')), since)
      .map((f) => ({ f, j: readJson(f) }))
      .filter(({ j }) => j && Number.isInteger(j.seed) && Number.isInteger(j.tick) && isSha256(j.sha256));
    if (part !== 'renderer') check('Regression saved with seed, tick and a pinned hash', regs.length, 'no regression in qa/regressions/ with a seed, a tick and a pinned hash since this task started (save the replay, then `node qa/check-regressions.mjs --update`)');
    const lessons = fs.existsSync(abs('studio/memory/failures.md')) ? fs.readFileSync(abs('studio/memory/failures.md'), 'utf8').match(/^### .+$/gm) || [] : [];
    const ids = [task.id, ...(task.title.match(/\b(BUG|REG)-[\w-]+/g) || []), ...regs.map(({ j }) => j.id).filter(Boolean)];
    const day = new Date(since).toISOString().slice(0, 10);
    const named = lessons.some((h) => ids.some((id) => h.includes(id)));
    const dated = lessons.some((h) => (h.match(/\[(\d{4}-\d{2}-\d{2})\]/) || [])[1] >= day) && mtime('studio/memory/failures.md') >= since;
    // The regression has to catch the bug: replayed on the code before the fix, it must fail.
    const fix = firstTaggedCommit(task.id);
    if (part !== 'renderer' && fix !== undefined && regs.length) {
      if (!fix) check('Regression fails on the code before the fix', false, `no commit tagged Studio-Task: ${task.id} yet; commit the fix (with STUDIO_LOCK_OWNER set, the hook adds the tag), then this check replays the regression on the commit before it`);
      else {
        const results = regs.map(({ f }) => failsBefore(abs(f), `${fix}^`));
        const good = results.find((r) => r.ok);
        check('Regression fails on the code before the fix', good, results.map((r) => r.why).join('; '));
      }
    }
    if (seen) {
      // A renderer bug can't be pinned by a sim hash: it closes with a check on the running page.
      const bregs = newestSince(filesUnder('qa/regressions/browser', (n) => n.endsWith('.mjs')), since);
      check('Browser regression in qa/regressions/browser/ since the task started', bregs.length, `no browser regression since this task started: add qa/regressions/browser/${task.id}.mjs exporting check({ page, sim, view }) that returns { ok, why } and fails on the bug (studio/skills/bug.md)`);
      const lastChange = taskChanges(task.id, since).lastAt;
      const plays = newestSince(filesUnder('qa/reports', (n) => /^browser_\d+\.json$/.test(n)), since).map((f) => readJson(f)).filter(Boolean);
      const good = plays.filter((r) => r.passed && (Date.parse(r.at) || 0) >= lastChange && bregs.every((f) => (r.regressions || []).some((x) => x.file === f && x.ok)));
      check('Browser play passed with the regression, after the last change', good.length, 'no passing browser play (npm run play:browser) that ran the new regression after your last change');
    }
    check('Lesson written in studio/memory/failures.md', named || dated, `no lesson in studio/memory/failures.md naming ${ids.join(' or ')} or dated since the task started (\`node scripts/distill-bug.mjs\`)`);
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
    const good = reps.filter(({ f, j }) => mtime(f) >= fresh && j.stage1.seed != null && j.stage1.ticksRun != null && isSha256(j.stage1.finalSha256) && (j.passed || j.stage1.failingTick != null));
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
  if (type === 'system') {
    const specs = newestSince(filesUnder('studio/bible/systems', (n) => n.endsWith('.md') && n !== 'README.md'), since);
    check('Spec written in studio/bible/systems/ since the task started', specs.length, 'no spec in studio/bible/systems/ since this task started (what it does, its phase and layer, its rules and invariants)');
    check('Spec ends with a hand-off for the next agent', specs.some((f) => /^##\s*For the next agent/im.test(fs.readFileSync(abs(f), 'utf8')) && words(f) >= 80), 'the spec has no "## For the next agent" section, or is under 80 words');
    const ch = taskChanges(task.id, since);
    check('A scenario for it in the cartridge\'s qa.mjs', ch.files.some((f) => /^cartridges\/[^/]+\/qa\.mjs$/.test(f)), 'qa.mjs wasn\'t changed: add a scenario that exercises the system');
    check('Goldens updated with it', ch.files.some((f) => f.startsWith('qa/golden/')), 'no golden changed: the system changes the game, so regenerate (npm run golden -- --update) and commit the goldens with it');
    const fresh2 = lastGameChange();
    const reps = newestSince(filesUnder('qa/reports', (n) => /^qa_.*\.json$/.test(n)), since).filter((f) => mtime(f) >= fresh2);
    check('Playtest of the current build', reps.length, 'no playtest report newer than the last game change (npm run playtest:stage1)');
    workAndVerify();
    const implementer = (readRecentEvents(20000).filter((e) => e.type === 'task.start' && e.task === task.id).pop() || {}).model;
    const notes = filesUnder('studio/reviews', (n) => n.endsWith('.md') && n !== 'README.md').map((f) => fs.readFileSync(abs(f), 'utf8')).filter((t) => new RegExp(`\\b${task.id}\\b`).test(t));
    const approving = notes.filter((t) => /\b(approve[sd]?|lgtm)\b/i.test(t) && !/\b(request(ed)? changes|changes requested|reject(ed)?|blocking)\b/i.test(t));
    const cross = approving.filter((t) => {
      const rev = (t.match(/model-family\s*:\s*(\S+)/i) || [])[1];
      const impl = (t.match(/implementer-family\s*:\s*(\S+)/i) || [])[1] || (implementer ? modelFamily(implementer) : null);
      return rev && impl && modelFamily(rev) !== modelFamily(impl) && modelFamily(rev) !== 'unknown';
    });
    check('Approved by a reviewer from another model family', cross.length, approving.length ? 'the approving review is from the same model family as the builder (or has no model-family line)' : `no review in studio/reviews/ names ${task.id} and approves it (with "model-family:" and "implementer-family:" lines)`);
  }
  if (type === 'direction') {
    const reviews = newestSince(filesUnder('studio/bible/reviews', (n) => n.endsWith('.md') && n !== 'README.md'), since).map((f) => parseReview(abs(f))).filter(Boolean);
    check('Review written in studio/bible/reviews/ since the task started', reviews.length, 'no review in studio/bible/reviews/ since this task started (`npm run director -- review` starts one)');
    check('Review names the phase (Phase: 1|2|3)', reviews.some((r) => r.phase), 'the review has no "Phase: 1|2|3" line');
    check('Review gives a verdict (on course, drifting, off course, phase-ready)', reviews.some((r) => r.verdict), 'the review has no "Verdict: on course|drifting|off course|phase-ready" line');
    check('Review says what it checked (pillars or layers)', reviews.some((r) => /pillar:|layer:/i.test(r.checked)), 'the review has no "Checked: pillar:… layer:…" line');
    check('Review lists next tasks', reviews.some((r) => r.next), 'the review has no "## Next" list');
  }
  if (type === 'art') {
    let designs = [];
    try {
      designs = JSON.parse(fs.readFileSync(abs('studio/art/designs.json'), 'utf8')).designs || [];
    } catch {
      // none yet
    }
    const mine = designs.filter((d) => d.task === task.id || Date.parse(d.at) >= since);
    check('Designs proposed for the game dev since the task started', mine.length, 'no design proposed since this task started (npm run art -- propose <file> --title "…" --kind style|asset --task ' + task.id + ')');
    if (/style sheet/i.test(task.title)) check('A style sheet among them', mine.some((d) => d.kind === 'style'), 'the task asks for a style sheet; propose one with --kind style');
    const m = task.title.match(/\b(\w+) placeholder assets?\b/i);
    const want = m ? { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }[m[1].toLowerCase()] || Number(m[1]) || 0 : 0;
    if (want) check(`${want} placeholder assets among them`, mine.filter((d) => d.kind === 'asset').length >= want, `${mine.filter((d) => d.kind === 'asset').length} of ${want} placeholder assets proposed`);
  }
  if (type === 'trick') {
    const dir = abs('studio/tricks');
    const cards = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^K-\d+\.json$/.test(f)).map((f) => readJson(`studio/tricks/${f}`)).filter((t) => t && Date.parse(t.at) >= since) : [];
    const none = mtime('studio/tricks/HUNTS.md') >= since;
    check('A trick card, or a note that nothing is worth doing now', cards.length || none, 'no trick card since this task started: npm run trick -- propose "…" --problem … --trick … --fits … --avoid-if … --proof …, or npm run trick -- none "<why>"');
  }
  if (type === 'idea') {
    const id = (task.title.match(/\bI-\d+\b/) || [])[0];
    const idea = id ? readIdea(id) : null;
    check(`Title names an idea (${id || 'I-…'})`, idea, id ? `no idea ${id} on the Idea Board` : 'the title names no idea (like I-001)');
    const moved = idea && (idea.history || []).some((h) => Date.parse(h.at) >= since && ['shaped', 'placed', 'approved', 'parked', 'rejected'].includes(h.stage));
    check('The idea moved to its next stage since the task started', moved, `${id || 'the idea'} hasn't moved since this task started (npm run idea -- shape|place|decide ${id || 'I-…'})`);
  }
  if (seen && ['change', 'bug', 'system'].includes(type)) {
    const pr = proofStatus(task.id, since);
    check('Screenshots, each with a line saying what it shows', pr.shots && pr.fresh, `no screenshots for ${task.id} since it started: npm run play:browser, then npm run proof -- add ${task.id} <png> "<what it shows>"`);
    check('Checked by someone other than the builder', pr.checked, pr.wrong ? `the last check said they don't match: ${pr.wrong}` : `nobody else has checked them yet: npm run proof -- check ${task.id} --by <name> --verdict matches|wrong`);
  }
  const missing = checks.filter((c) => !c.ok).map((c) => c.why);
  return { ok: missing.length === 0, type, part, since, checks, missing, ...TYPES[type] };
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
