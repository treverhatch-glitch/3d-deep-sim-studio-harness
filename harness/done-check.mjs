#!/usr/bin/env node
/**
 * harness/done-check.mjs — a task is done when the check for its kind of work passes.
 *
 * `node harness/task.mjs done <ID>` runs this first and refuses while something is missing.
 * `--force` finishes anyway: it writes a task.forced event and queues a P1 check for the Producer.
 *
 *   node harness/done-check.mjs <TASK_ID>    show the type, what is checked and what is missing
 *
 * The type comes from a title prefix (Bug:, Fix, Chore:, Study:, Balance:, Fun:, Playtest:, Review:, Docs:)
 * and otherwise from the role. Each type is described in studio/skills/ (the table in studio/skills/README.md).
 * 2.59.0: the owner can reclassify a task (npm run task -- type <ID> <type> --by <owner> --why "…",
 * harness/reclassify.mjs); that type wins over the title's, and the output says which one is used and why.
 * A bug's regression is a cartridge replay or a seeded game unit test ("kind": "test", qa/regressions/README.md).
 * 2.62.0 (H): a task with an agreed acceptance contract (studio/contracts/<ID>.json) also needs every criterion in
 * force passing (harness/contracts.mjs contractChecks); one without a contract is checked as before.
 * 2.65.0 (hands-off by default): a "bug" type from the title or role whose committed changes are only tests, docs or
 * config (no game logic: harness/type-evidence.mjs, the sim paths of harness/tiers.mjs and the game's manifest) is
 * judged a "change" task (no regression replay), said as "type: change (evidence: …)" and logged once as a
 * task.type.evidence event (evidenceType). An owner or permission record always outranks the evidence; a change in
 * a sim path keeps "bug" and its replay.
 * 2.77.0 (u, P5.1/P5.5): an engine pass whose work lives in the engine's own repo (harness/engine-tracks.mjs engineRepo)
 * is judged there (engineWorkChecks): commits on its branch that the engine's target lacks; the engine's land run (the
 * gate or its train) stands for the studio's verify, so the studio-repo rows (changes, verify, size, reach) don't apply.
 * A task added with --visual-check or --refs also needs the visual check (harness/visual-check.mjs visualCheckRows).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, readRecentEvents, emitEvent } from './event.mjs';
import { isSha256 } from './hash.mjs';
import { parseNextQueue } from './task.mjs';
import { parseReview, readIdea } from './bible.mjs';
import { failsBefore, regressionKind } from '../qa/fails-before.mjs';
import { ownerType, ownerTypeWords } from './reclassify.mjs';
import { renderDecision, readVerdict } from './verdict-split.mjs';
import { modelFamily } from './families.mjs';
import { proofStatus } from './proof.mjs';
import { listLocks, coveringLock } from './lock.mjs';
import { overLimits, isGameCode, LIMITS } from '../scripts/check-function-size.mjs';
import { wavesOn, waveFor, nextWaveId, joinWave } from './waves.mjs';
import { reachMode, unreached } from './reachability.mjs';
import { judgeRed, readBaseline } from './baseline.mjs';
import { inLaneCopy, mainRoot } from './worktree.mjs';
import { isEolOnlyLine } from './eol-only.mjs';
import { sizeRuleFor, freeImportLines } from './size-rule.mjs';
import { contractChecks } from './contracts.mjs';
import { judgeFiles, manifestSettings, evidenceWords } from './type-evidence.mjs';
import { activeGame } from './cartridge.mjs';
import { stage1Replaced, studioGameSync } from './tester-config.mjs';
import { regressionHowTo, regressionMissing } from './regression-howto.mjs';
import { checkResearch, ensureResearchTemplate } from './research.mjs';
import { engineTask, engineRepo, engineTarget } from './engine-tracks.mjs';
import { visualCheckRows } from './visual-check.mjs';

/** Which part of the game a task touches (task add --part sim|renderer|both); null when not said. */
export const partOf = (id) => readRecentEvents(20000).find((e) => e.type === 'task.added' && e.task === id)?.meta?.part || null;

/**
 * 2.78.2 (c): does a review file approve? Judged by its LAST "Verdict:" line (its own line, case-insensitive; markdown
 * markers before it are fine): "approve"/"LGTM" approves; "changes requested", "reject" or "blocking" doesn't; anything
 * else doesn't. So a re-review appended to the first one decides, and a "non-blocking note" doesn't count against it.
 * A file with no Verdict line keeps the old rule: it names approve/LGTM and none of changes requested/reject/blocking.
 */
export const reviewApproves = (text) => {
  const t = String(text || '').replace(/\r\n/g, '\n');
  const old = () => /\b(approve[sd]?|lgtm)\b/i.test(t) && !/\b(request(ed)? changes|changes requested|reject(ed)?|blocking)\b/i.test(t);
  const lines = [...t.matchAll(/^[ \t>*_#-]*verdict[ \t*_]*:[ \t*_]*(.*)$/gim)];
  if (!lines.length) return old();
  const v = lines[lines.length - 1][1];
  if (/\b(request(ed)? changes|changes requested|reject(ed)?|blocking)\b/i.test(v)) return false;
  return /\b(approve[sd]?|lgtm)\b/i.test(v);
};

/** 2.78.2 (c): task types that produce notes, reviews and docs, never game code. */
export const NO_GAME_CODE_TYPES = ['direction', 'review', 'docs', 'idea', 'research', 'study'];
/** 2.79 (d): roles whose tasks write notes, reviews and plans, never game code (a title like "Fix …" doesn't change that). */
export const NO_GAME_CODE_ROLES = ['director', 'reviewer'];
/**
 * 2.78.2 (c): may `task done` skip the game's own checks (the whole game test suite)? Yes when the task's type is one of
 * NO_GAME_CODE_TYPES and every file its lane changes (or claims, or has dirty) is a Markdown file or under studio/,
 * docs/ or .studio/. Any other file, or a type that can write code, runs them as before: a docs task that also touched
 * code still runs them. The docs and board checks are separate rows and always run. { skip, why }.
 * 2.79 (d): a Director's or reviewer's task (NO_GAME_CODE_ROLES) is judged the same way when its title typed it "bug" or
 * "change" and no owner reclassified it: its files decide.
 */
export function skipGameChecks(type, files, env = process.env, { role = null, ownerTyped = false } = {}) {
  // 2.79 (d): a Director's or reviewer's task whose title typed it "bug" or "change" (no type set) is still that role's: the
  // rule is its files, as for a typed one. An owner's reclassification (ownerTyped) is taken as said.
  const byRole = !ownerTyped && NO_GAME_CODE_ROLES.includes(String(role || '').toLowerCase());
  if (!byRole && !NO_GAME_CODE_TYPES.includes(type)) return { skip: false, why: `a ${type} task can change game code` };
  const list = [...new Set((files || []).map((f) => String(f).replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean))];
  const code = list.find((f) => !(/\.md$/i.test(f) || /^(studio|docs|\.studio)\//.test(f)));
  if (code) return { skip: false, why: `it changes ${code}, which isn't a note or doc` };
  return { skip: true, why: `a ${NO_GAME_CODE_TYPES.includes(type) ? type : `${role}`} task whose ${list.length} changed file(s) are notes, docs or studio records: no game code to test` };
}

/** The oldest commit tagged with this task (Studio-Task trailer), or null. */
function firstTaggedCommit(taskId) {
  const out = git('log', '--reverse', '--format=%H%x09%(trailers:key=Studio-Task,valueonly,separator=%x2C)');
  if (out === null) return undefined; // not a git checkout
  const line = out.split('\n').find((l) => (l.split('\t')[1] || '').split(',').map((x) => x.trim()).includes(taskId));
  return line ? line.split('\t')[0] : null;
}

// 2.58.0: build, toolchain, CI and dependency work. "build" alone is the usual start of a game task ("Build the
// stairwell", "Fix build menu …", a game's build tool or build times), so it counts only as a label (Build: /
// build(deps)), at the end ("Fix the build"), or with a toolchain word; anything else stays a change or a bug.
const TOOL_WORD = String.raw`(scripts?|pipeline|config\w*|toolchain|tooling|cache|deps|dependencies|break(s|age)?|broke|broken|errors?|failures?|fail(s|ed|ing)?|warnings?|red|again|(is|was)\s+(broken|red|failing|slow)|on\s+(windows|linux|mac\w*|node|ci|ubuntu|github))\b`;
const CHORE_START = new RegExp(String.raw`^(chore|toolchain|tooling|infra|ci|deps|dependencies)\b|^build\s*[:([]|^build\s+${TOOL_WORD}`, 'i');
const CHORE_FIX = new RegExp(String.raw`^fix(es|ed|ing)?\b[\s:]*((the|a)\s+)?((ci|toolchain|tooling|deps|dependencies)\b|build(?=\s*$|\s*[:;,.!()[\]—–-]|\s+${TOOL_WORD}))`, 'i');
/** A [chore] tag in the title, or "type: chore" in the task's detail (the board keeps none; callers may pass one). */
const choreTagged = (task) => /\[chore(:[^\]]*)?\]/i.test(String(task?.title || '')) || /(^|\n)\s*type\s*:\s*chore\b/im.test(String(task?.detail || ''));

/**
 * 2.58.3 (crew P-041): the subject of a "Fix …"/"Bug …" title, the part that says what is being fixed: the title up
 * to the first separator (" — ", " – ", " - ", ";", "(", "[") or reference word (see, per, ref, refs, cf, via). The
 * crew's "Fix: bug batch 3 … see qa/reports/kept/known-bugs-….md" was typed docs because of the file it pointed at;
 * its subject is "Fix: bug batch 3 …". "Fix: typo in docs/X.md" keeps the .md in its subject and stays docs.
 */
export const docsFixSubject = (title) => String(title || '').split(/\s+[—–-]\s+|\s*[;([]|\b(?:see|per|refs?|cf|via)\b/i)[0];
const isDocsFix = (title) => /^(bug|fix)\b/i.test(title) && /\b(docs?[- ]gate|check-docs|[\w/-]+\.md)\b/i.test(docsFixSubject(title));

const PREFIX = [
  // 2.35.0: a rescue of a task stopped by its budget (harness/rescue.mjs).
  [/^rescue:/i, 'rescue'],
  // 2.37.0: the whole-game check went red after a landing (harness/whole-game.mjs).
  [/^whole-game check red\b/i, 'whole'],
  [/^check forced done\b/i, 'none'],
  // A bug in the docs (the docs gate, a .md file) closes like a docs task, not with a sim replay
  // (Jed's run: docs-gate bugs could only close with --force). 2.58.3 (crew P-041): only when the docs are what
  // is being fixed, named in the title's subject (docsFixSubject), not a "see <file>.md" reference.
  [{ test: (title) => isDocsFix(title) }, 'docs'],
  // 2.58.0: "Fix the build", "Fix CI", "Fix toolchain", "Fix deps" are chores, not bugs: no regression to replay
  // (a crew report: toolchain tasks titled "Fix …" had to be retitled to close). Other "Fix …" stays a bug.
  [CHORE_FIX, 'chore'],
  [CHORE_START, 'chore'],
  [/^(bug|fix)\b/i, 'bug'],
  [/^system\b/i, 'system'],
  [/^study\b/i, 'study'],
  // 2.71.0 (y): a research write-up with its sources (harness/research.mjs).
  [/^research\b/i, 'research'],
  [/^balance\b/i, 'balance'],
  [/^fun\b/i, 'fun'],
  [/^playtest\b/i, 'playtest'],
  [/^review\b/i, 'review'],
  [/^docs?\b/i, 'docs'],
  [/^director review\b/i, 'direction'],
  [/^idea\b/i, 'idea'],
  [/^art\b/i, 'art'],
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
  rnd: 'idea',
  planner: 'idea',
  art: 'art',
  artist: 'art',
  'art-director': 'art',
};

export const TYPES = {
  change: { skill: 'studio/skills/builder.md', means: 'changes exist for the task, and a full `npm run verify` passed after the last of them' },
  chore: { skill: 'studio/skills/builder.md', means: 'build, toolchain, CI or dependency work: changes exist for the task, and a full `npm run verify` passed after the last of them (no regression, no gameplay checks, no reach check)' },
  bug: { skill: 'studio/skills/bug.md', means: 'a regression that fails on the code before the fix (a cartridge replay with seed, tick and pinned SHA-256, or a seeded game unit test, "kind": "test", that passes with the fix), a lesson naming the bug, the fix committed with the task\'s tag, and a green verify after the last change' },
  balance: { skill: 'studio/skills/balance.md', means: 'a sweep of the current tuning, newer than the last game change; a person picks the number' },
  fun: { skill: 'studio/skills/playtest.md', means: 'a fun report newer than the task start and the last game change' },
  playtest: { skill: 'studio/skills/playtest.md', means: 'a playtest report on the current build with seed, ticks, hash, and the failing tick if it failed' },
  study: { skill: 'studio/skills/study.md', means: 'a study.md of 120+ words under studio/research/, written after the task started' },
  research: { skill: 'studio/skills/research.md', means: 'a write-up at docs/research/<ID>.md (or the game\'s docs/research/) with a Sources section holding at least one link; the template (question, sources, findings, unverified, recommendation) is written at task start' },
  review: { skill: 'studio/skills/review.md', means: 'a review note naming the task or commit it reviewed, with a verdict' },
  docs: { skill: 'studio/skills/docs.md', means: 'a changed .md file, and a full `npm run verify` after the last change' },
  direction: { skill: 'studio/skills/direction.md', means: 'a dated review in studio/bible/reviews/ since the task started, naming the phase, what it checked, a verdict, and next tasks' },
  system: { skill: 'studio/skills/system.md', means: 'a spec with a hand-off in studio/bible/systems/, the sim change with a scenario in qa.mjs and updated goldens, a playtest of the current build, a green verify after the last change, and an approving review from another model family' },
  idea: { skill: 'studio/skills/ideas.md', means: 'the idea named in the title moved to its next stage (shaped, placed, or decided) since the task started' },
  art: { skill: 'studio/skills/art.md', means: 'designs proposed for the game dev since the task started (npm run art -- propose); approving them is the dev\'s call, not part of done' },
  whole: { skill: null, means: 'a fix committed for this task, then a full verify of the whole game (npm run verify -- --all), not one scoped to the files you changed, green after your last change' },
  rescue: { skill: 'studio/skills/rescue.md', means: 'studio/rescues/<the stuck task>.md written since the rescue started, with a Diagnosis of 40+ words and one Decision: retry, split (smaller tasks naming the stuck task are queued) or needs-person' },
  none: { skill: null, means: 'nothing to check (coordination work)' },
};

/** The type the title (or, failing that, the role) gives: { type, by: 'title' | 'role' }. */
function titleRule(task) {
  const title = String(task?.title || '');
  // 2.58.0: a [chore] tag retypes a "Fix …" or a plain build task, never a review, study, rescue...
  const tagged = choreTagged(task);
  for (const [re, type] of PREFIX) if (re.test(title)) return { type: type === 'bug' && tagged ? 'chore' : type, by: 'title' };
  const byRole = BY_ROLE[task?.role] || 'change';
  return { type: byRole === 'change' && tagged ? 'chore' : byRole, by: 'role' };
}
/** The type the title (or the role) gives, ignoring any owner reclassification. */
export const titleType = (task) => titleRule(task).type;

/**
 * 2.59.0: the task's type and where it comes from: { type, source, owner, ignored }. An owner reclassification
 * (harness/reclassify.mjs) wins; one on file that doesn't count (unsigned with an owner key, set by an agent's commit,
 * not committed yet) is named in `ignored` and the title decides.
 */
export function typeOf(task) {
  const rule = titleRule(task);
  let o = null;
  try { o = task?.id ? ownerType(task.id) : null; } catch { o = null; }
  if (o?.type) return { type: o.type, source: ownerTypeWords(o), owner: o, ignored: null, titleType: rule.type };
  return { type: rule.type, source: rule.by === 'title' ? 'from its title' : `from its role (${task?.role || 'none'})`, owner: null, ignored: o?.ignored || null, titleType: rule.type };
}

/**
 * 2.65.0: the type the task's own diff gives, when it overrides a title/role "bug": { type: 'change', source, files,
 * kinds } or null (no override: an owner record, not a bug, no commits yet, or any game-logic file changed). Writes
 * one task.type.evidence event per task and file set (emit: false skips it). ch: taskChanges() when the caller has it.
 */
export function evidenceType(task, typed = typeOf(task), { since = null, ch = null, emit = true, env = process.env } = {}) {
  if (!task?.id || typed.owner || typed.type !== 'bug') return null;
  let changes = ch;
  try { changes ||= taskChanges(task.id, since ?? startedAt(task.id)); } catch { return null; }
  if (!changes?.commits?.length || !changes.files?.length) return null;
  let game = null;
  try { game = activeGame().name || null; } catch { game = null; }
  const j = judgeFiles(changes.files, { settings: manifestSettings(REPO_ROOT, game), exists: (f) => fs.existsSync(abs(f)) });
  if (!j.onlyNonLogic) return null;
  const words = evidenceWords(j.kinds);
  const files = [...j.kinds.test, ...j.kinds.docs, ...j.kinds.config].sort();
  if (emit) {
    try {
      const key = files.join('\n');
      const seen = readRecentEvents(20000).some((e) => e.type === 'task.type.evidence' && e.task === task.id && (e.meta?.files || []).join('\n') === key);
      if (!seen) emitEvent({ type: 'task.type.evidence', agent: 'done-check', task: task.id, msg: `${task.id}: judged a "change" task, not a "bug" (${typed.source}): ${words}; no regression replay needed (an owner's npm run task -- type ${task.id} bug outranks this)`.slice(0, 600), meta: { from: 'bug', to: 'change', titleType: typed.titleType, evidence: words, files: files.slice(0, 50) } });
    } catch { /* the decision stands without its event */ }
  }
  return { type: 'change', source: `evidence: ${words}`, files, kinds: j.kinds };
}

export function taskType(task) {
  return typeOf(task).type;
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
// 2.73.0: the harness's own records (the harness-task queue a forced done adds to, 2.71.0 z; pending reviews and holds)
// are no task's change: another task's forced done wrote HARNESS-TASKS.md and it counted as this task's edit.
const BOOKKEEPING = /^(package-lock\.json$|\.studio\/|studio\/(task-types\.json$|HARNESS-TASKS\.md$|pending-review\.json$|task-holds\.json$|NEXT\.md|CURRENT_TASK\.md|handoffs\/|meetings\/|producer\/|game\/|memory\/retros\/|harness-notes\/|proof\/)|qa\/reports\/)/;
const WORK_DIRS = ['cartridges', 'src', 'harness', 'hub', 'qa', 'scripts', 'tools', 'docs', 'studio'];
const git = (...args) => {
  const r = spawnSync('git', args, { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8' });
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
  const committed = new Set();
  let lastAt = 0;
  // 2.58.3 (O5): what the newest change was, so a stale verify can say what made it stale.
  let last = null;
  const bump = (at, what) => { if (at >= lastAt) { lastAt = at; last = { at, ...what }; } };
  const eolSkipped = [];
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
      touched.forEach((n) => { files.add(n); committed.add(n); });
      bump(Number(ct) * 1000, { kind: 'commit', hash, file: touched[0], tagged: tagged.includes(taskId) });
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
      touched.forEach((n) => { files.add(n); committed.add(n); });
      bump(Number(ct) * 1000, { kind: 'commit', hash, file: touched[0], tagged: true });
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
        // 2.58.3 (O3, crew P-035): a tracked file whose only difference is line endings isn't a change.
        if (isEolOnlyLine(REPO_ROOT, line)) { eolSkipped.push(f); continue; }
        files.add(f);
        bump(m, { kind: 'file', file: f });
      }
    }
  } else {
    // Not a git checkout: fall back to files modified since the task started.
    const out = [];
    for (const d of WORK_DIRS) walkSince(d, since, out);
    out.forEach((f) => {
      files.add(f);
      bump(mtime(f), { kind: 'file', file: f });
    });
  }
  return { files: [...files], committed: [...committed], commits, lastAt, last, eolSkipped };
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

const isSha = (s) => /^[0-9a-f]{40}$/.test(String(s || ''));
const isAncestor = (a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { windowsHide: true, cwd: REPO_ROOT }).status === 0;
/** The studio's main branch as this checkout can name it (a lane copy: the main checkout's branch), never HEAD's own. */
function studioMainBranches() {
  const own = (git('symbolic-ref', '-q', '--short', 'HEAD') || '').trim();
  const names = [];
  try {
    if (inLaneCopy()) names.push(spawnSync('git', ['symbolic-ref', '-q', '--short', 'HEAD'], { windowsHide: true, cwd: mainRoot(), encoding: 'utf8' }).stdout.trim());
  } catch {
    // no main checkout to ask
  }
  names.push('main', 'origin/main');
  return [...new Set(names.filter((n) => n && n !== own && n !== `origin/${own}`))];
}
/**
 * 2.58.0: the commit a task's growth is measured from. Its start commit, unless its branch has since taken in the
 * studio's main branch (a merge or a rebase): then the merge-base of HEAD and main, so what came from main isn't
 * counted as the task's own growth (a crew report: a merged-in main forced a --force close twice). Only a
 * merge-base at or after the start counts; on main itself, or with no main, the start commit.
 */
export function sizeBase(taskId) {
  const base = taskBase(taskId);
  if (!base) return null;
  let best = base;
  for (const ref of studioMainBranches()) {
    const mb = (git('merge-base', 'HEAD', ref) || '').trim();
    if (isSha(mb) && mb !== best && isAncestor(best, mb)) best = mb;
  }
  return best;
}

/**
 * 2.58.3 (crew P-034): an anonymous function is named by its line ("(anonymous, line 120)"), so lines inserted above
 * an unchanged one made it look new. It is matched with the old version by its stable key (codeindex: the describe/it
 * titles and calls around it, nth occurrence), else by the most lines in common (half of the old body at least).
 */
function matchAnonymous(x, was, used, nowText, beforeText) {
  const olds = was.filter((y) => y.kind === 'function' && y.key && !used.has(y));
  let old = olds.find((y) => y.key === x.key);
  if (!old && beforeText !== null) {
    const body = (text, a, b) => text.split('\n').slice(a - 1, b).map((l) => l.trim()).filter(Boolean);
    const mine = new Set(body(nowText, x.start, x.end));
    let best = 0;
    for (const y of olds) {
      const theirs = body(beforeText, y.start, y.end);
      const share = theirs.length ? theirs.filter((l) => mine.has(l)).length / theirs.length : 0;
      if (share >= 0.5 && share > best) { best = share; old = y; }
    }
  }
  if (old) used.add(old);
  return old || null;
}

/**
 * The size ratchet (2.29): game functions and files over the limit (scripts/check-function-size.mjs) that
 * this task made bigger, or created. Ones that were already that big and didn't grow are left to a split
 * task. Null when the start commit isn't known (a task started before 2.29). 2.58.0: compared with sizeBase
 * (the merge-base with the studio's main branch once the task took main in), not always the start commit.
 */
export function sizeGrowth(taskId, files, info = null) {
  const base = sizeBase(taskId);
  if (!base) return null;
  const limits = LIMITS();
  const out = [];
  // 2.60.0: the game's "sizeRule" (harness/size-rule.mjs), as committed on the studio's main branch, else at the base.
  const ruleRef = studioMainBranches().find((b) => git('rev-parse', '--verify', '--quiet', `${b}^{commit}`)) || base;
  const cache = new Map();
  const ignored = new Set();
  for (const f of files.filter((x) => isGameCode(x) && /\.(m?js|cjs|jsx|tsx?|gd)$/i.test(x) && fs.existsSync(abs(x)))) {
    const rule = sizeRuleFor(f, ruleRef, limits, cache);
    for (const w of rule.ignored) ignored.add(w);
    let before = null;
    const r = spawnSync('git', ['show', `${base}:${f}`], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
    const used = new Set();
    let free = null;
    for (const x of now) {
      const old = x.key ? matchAnonymous(x, was, used, fs.readFileSync(abs(f), 'utf8'), before) : was.find((y) => y.kind === x.kind && y.name === x.name && y.unit === x.unit);
      if (x.kind === 'file' && (rule.exempt || rule.importLinesFree)) {
        // 2.60.0: an exempt file has a hard cap instead of the no-growth rule; import-only lines added don't count.
        const text = fs.readFileSync(abs(f), 'utf8');
        const lines = text.split('\n').length;
        const kb = Buffer.byteLength(text) / 1024;
        if (rule.exempt) {
          const over = lines > rule.cap.lines ? `${lines} lines, over the hard cap of ${rule.cap.lines}` : kb > rule.cap.kb ? `${Math.round(kb)} KB, over the hard cap of ${rule.cap.kb} KB` : null;
          const wasLines = before === null ? 0 : before.split('\n').length;
          if (over && (lines > wasLines || before === null)) out.push(`${f} is ${over} for a file exempt from the no-growth rule (${rule.source} "sizeRule"): split it (one module per entry, studio/rules/lanes.md)`);
          else if (info) info.push(`${f} is exempt from the no-growth rule (${rule.source}): ${lines} of at most ${rule.cap.lines} lines`);
          continue;
        }
        if (free === null) free = freeImportLines(base, f);
        if (free.lines || free.bytes) {
          const size = x.unit === 'lines' ? x.size - free.lines : Math.round((Buffer.byteLength(text) - free.bytes) / 1024);
          if (size <= x.limit || (old && size <= old.size)) {
            if (info) info.push(`${f}: ${free.lines} added import line(s) not counted (${rule.source} "sizeRule": importLinesFree)`);
            continue;
          }
          if (!old || size > old.size) out.push(`${f} is ${x.size} ${x.unit}${old ? ` (was ${old.size})` : ''}, over the limit of ${x.limit}, ${size} without the ${free.lines} added import line(s) ${rule.source} lets through`);
          continue;
        }
      }
      if (!old || x.size > old.size) out.push(`${f}${x.kind === 'function' ? ` ${x.key ? `${x.name.replace(/\)$/, '')}: ${x.key})` : `${x.name}()`}` : ''} is ${x.size} ${x.unit}${old ? ` (was ${old.size})` : ''}, over the limit of ${x.limit}`);
    }
  }
  if (out.length && ignored.size) out.push(...[...ignored].map((w) => `note: ${w}`));
  return out;
}

/** The size-growth items for a message: all of them up to 10; past that, 10, "and N more", and where the full list is. */
export function sizeList(taskId, grew, max = 10) {
  if (grew.length <= max) return `${grew.length > 1 ? `${grew.length} items: ` : ''}${grew.join('; ')}`;
  const rel = `.studio/size-growth/${String(taskId).replace(/[^\w.-]/g, '_')}.txt`;
  let written = true;
  try {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), `${grew.join('\n')}\n`);
  } catch {
    written = false;
  }
  return `${grew.length} items: ${grew.slice(0, max).join('; ')}; and ${grew.length - max} more${written ? ` (the full list: ${rel})` : ''}`;
}

/** The last time game code changed (cartridges/, src/): reports older than this describe an old build. */
function lastGameChange() {
  const out = [];
  for (const d of ['cartridges', 'src']) walkSince(d, 0, out);
  return out.reduce((m, f) => Math.max(m, mtime(f)), 0);
}
/**
 * 2.79.1 (d): a game tester run (qa/reports/tester/<id>/summary.json, harness/tester.mjs) newer than `min` and newer than the
 * last change to the game (the cartridge, or the studio's own game folder). It satisfies a "playtest of the current build"
 * row where the template's stage-1 playtest would have: it played the real build, which stage 1 does not. [] when none.
 */
function testerRunsSince(min) {
  const out = [];
  try { const g = studioGameSync(); if (g?.root) walkSince(g.root, 0, out); } catch { /* no game folder */ }
  // build output (dist/, build/ ...) is written by the build the tester itself runs: not a change to the game
  const fresh = Math.max(min, lastGameChange(), out.filter((f) => !/(^|\/)(dist|build|out|coverage|test-results|playwright-report)\//.test(f)).reduce((m, f) => Math.max(m, mtime(f)), 0));
  return newestSince(filesUnder('qa/reports/tester', (n) => n === 'summary.json', true), fresh).filter((f) => { const j = readJson(f); return j && typeof j === 'object' && !Array.isArray(j); });
}
/** The record gatesAfter reads (the agent's own full run, else the studio's). */
export function lastFullRecord() {
  try {
    const owner = process.env.STUDIO_LOCK_OWNER;
    const own = owner && /^[\w.-]+$/.test(owner) ? `.studio/gates/${owner}-full.json` : null;
    const file = own && fs.existsSync(abs(own)) ? own : fs.existsSync(abs('.studio/gates-last-full.json')) ? '.studio/gates-last-full.json' : '.studio/gates-last.json';
    return JSON.parse(fs.readFileSync(abs(file), 'utf8'));
  } catch {
    return null;
  }
}

const hhmm = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
/** 2.58.3 (O5): who ran the studio-wide full verify: the owner whose own record (.studio/gates/<owner>-full.json) is the same run. */
function studioRecordOwner(rec) {
  try {
    for (const f of fs.readdirSync(abs('.studio/gates')).filter((n) => n.endsWith('-full.json'))) {
      const r = readJson(`.studio/gates/${f}`);
      if (r && r.at === rec.at && (r.head || null) === (rec.head || null)) return f.slice(0, -'-full.json'.length);
    }
  } catch {
    // no owner records
  }
  return null;
}
/** Other tasks finished (landed) after `ms`: [{ task, at }], oldest first. */
function landedSince(ms, taskId) {
  return readRecentEvents(20000).filter((e) => (e.type === 'task.done' || e.type === 'task.forced') && e.task && e.task !== taskId && (Date.parse(e.ts) || 0) > ms).map((e) => ({ task: e.task, at: Date.parse(e.ts) }));
}
const landedText = (l) => `${l.slice(-2).map((x) => `${x.task} landed at ${hhmm(x.at)}`).join(', ')}${l.length > 2 ? ` and ${l.length - 2} more` : ''}`;
/**
 * 2.58.3 (O5): why the verify record doesn't cover this task, in words that say what is stale (a crew report: "no full
 * verify after your last change" came back unchanged after a full verify had run, because main had moved and the
 * verify was under another name of the same bot). The rule is unchanged: only the reason is named.
 */
function staleVerifyWhy(run, at, taskId, ch, usedOwn) {
  const me = process.env.STUDIO_LOCK_OWNER;
  const runAt = Date.parse(run.at) || 0;
  if (usedOwn) {
    const studio = readJson('.studio/gates-last-full.json');
    const sAt = Date.parse(studio?.at) || 0;
    const by = studio ? studioRecordOwner(studio) : null;
    if (studio && !studio.partial && sAt > runAt && sAt >= at && by !== me) return `no full \`npm run verify\` of yours after your last change: the last full verify (${hhmm(sAt)}) was by ${by || 'another name'}, not you (STUDIO_LOCK_OWNER=${me}); yours was at ${hhmm(runAt)}. A verify counts for the name that ran it: run \`npm run verify\` as ${me}`;
  }
  const last = ch?.last;
  const landed = taskId ? landedSince(runAt, taskId) : [];
  if (last && last.kind === 'commit' && !last.tagged && landed.length) return `no full \`npm run verify\` after main moved: main moved since your last verify (${landedText(landed)}), and this task's own files haven't changed since it (${hhmm(runAt)}); run \`npm run verify\` again`;
  if (last) return `no full \`npm run verify\` after your last change: your files changed after it (${last.file}${last.kind === 'commit' ? ` in commit ${String(last.hash).slice(0, 8)}` : ''} at ${hhmm(last.at)}; the last full verify was at ${hhmm(runAt)}); run it again`;
  return `no full \`npm run verify\` after your last change (the last full verify was at ${hhmm(runAt)}); run it again`;
}
/** 2.58.3 (O5): the studio's full verify of this very commit, when it was run under another name. */
function otherOwnerOnHead(head) {
  const me = process.env.STUDIO_LOCK_OWNER;
  const studio = readJson('.studio/gates-last-full.json');
  if (!studio || studio.partial || studio.head !== head) return '';
  const by = studioRecordOwner(studio);
  return by === me ? '' : `: the full verify of this commit (${hhmm(Date.parse(studio.at) || 0)}) was by ${by || 'another name'}, not you (STUDIO_LOCK_OWNER=${me}); a verify counts for the name that ran it, so run it as ${me}`;
}
/** 2.58.3 (O5): what moved HEAD since the commit the verify ran on. */
function movedHeadWhy(run, head, taskId) {
  if (!isSha(run.head) || !isAncestor(run.head, head)) return '';
  const tags = (git('log', '--format=%(trailers:key=Studio-Task,valueonly,separator=%x2C)', `${run.head}..${head}`) || '').split('\n');
  const mine = tags.filter((t) => t.split(',').map((x) => x.trim()).includes(taskId)).length;
  if (mine) return `: your ${mine} commit${mine === 1 ? '' : 's'} came after it`;
  const landed = taskId ? landedSince(Date.parse(run.at) || 0, taskId) : [];
  return landed.length ? `: main moved since your last verify (${landedText(landed)})` : ': commits from elsewhere came in since it';
}

export function gatesAfter(at, files = null, taskId = null, ch = null) {
  let run = null;
  let usedOwn = false;
  try {
    // The agent's own full run first (2.29: in its own copy, the studio-wide record is someone else's code).
    const owner = process.env.STUDIO_LOCK_OWNER;
    const own = owner && /^[\w.-]+$/.test(owner) ? `.studio/gates/${owner}-full.json` : null;
    usedOwn = Boolean(own && fs.existsSync(abs(own)));
    const file = usedOwn ? own : fs.existsSync(abs('.studio/gates-last-full.json')) ? '.studio/gates-last-full.json' : '.studio/gates-last.json';
    run = JSON.parse(fs.readFileSync(abs(file), 'utf8'));
  } catch {
    return 'no full `npm run verify` has been recorded';
  }
  if (run.partial) return 'the last verify was a partial run (--only); run the full `npm run verify`';
  if ((Date.parse(run.at) || 0) < at) return staleVerifyWhy(run, at, taskId, ch, usedOwn);
  // 2.58.0 (PU-34, P-047): only a verify of this very commit on a clean tree counts. The time and the rows alone
  // could be an older commit's run, or a record written by hand. (Not a git checkout: no commit to compare.)
  const head = (git('rev-parse', 'HEAD') || '').trim();
  if (isSha(head)) {
    if (!run.head) return 'the last verify record names no commit (it is older than 2.43.0, or was written by hand); run `npm run verify` again';
    if (run.head !== head) return `the last verify ran on commit ${String(run.head).slice(0, 8)}, not on this one (${head.slice(0, 8)})${(usedOwn && otherOwnerOnHead(head)) || movedHeadWhy(run, head, taskId)}; run \`npm run verify\` again`;
    if (run.dirty) return 'the last verify ran with uncommitted changes, so it tested something other than this commit; commit your work, then run `npm run verify` again';
  }
  // 2.31.0: a verify scoped to a lane's changes (scripts/run-gates.mjs) counts as full when its scope holds
  // every file this task changed.
  if (run.scoped && Array.isArray(run.changed) && files?.length) {
    const inScope = new Set(run.changed);
    const outside = files.filter((f) => !inScope.has(f));
    if (outside.length) return `the last verify was scoped to ${run.changed.length} file(s) and missed ${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ` and ${outside.length - 3} more` : ''}; run \`npm run verify\` again (or \`npm run verify -- --all\`)`;
  }
  const red = (run.rows || []).filter((r) => r.required && !r.ok).map((r) => r.id);
  if (!red.length) return null;
  // 2.54.0 (PU-06): checks already red when the task was claimed don't count against it; new failures do.
  const base = taskId ? readBaseline(taskId) : null;
  if (!base) return `the last verify failed: ${red.join(', ')}`;
  const { fresh } = judgeRed(run.rows, base);
  if (!fresh.length) return null;
  return `the last verify failed: ${fresh.map((f) => (f.failures?.length ? `${f.id} (new since claim: ${f.failures.slice(0, 3).join('; ')}${f.failures.length > 3 ? ` and ${f.failures.length - 3} more` : ''})` : f.id)).join(', ')}`;
}

const readJson = (rel) => {
  try {
    return JSON.parse(fs.readFileSync(abs(rel), 'utf8'));
  } catch {
    return null;
  }
};
const words = (rel) => (fs.readFileSync(abs(rel), 'utf8').match(/[A-Za-z0-9]{2,}/g) || []).length;

// 2.30b (J1, J4): a gameplay task closes only on a real-input browser play whose fun probes all pass after the last
// change, plus a clip of the build; a sim task on a game with a browser build closes only when every sim feature shows.
/** After a task closes: gameplay work in wave mode joins the open wave (2.30d). */
export function joinWaveIfGameplay(task, by) {
  if (!wavesOn() || !['change', 'bug'].includes(taskType(task)) || !GAMEPLAY.test(`${task.title} ${task.detail || ''}`)) return null;
  try { return joinWave(task.id, { by })?.id || null; } catch { return null; }
}
export const GAMEPLAY = /\b(movement|move|moving|wasd|sprint\w*|jump\w*|aim\w*|shoot\w*|shot|crosshair|camera|controls?|combat|gun|weapon)\b/i;
export function gameplayChecks(task, part, since, check) {
  const all = filesUnder('qa/reports', (n) => /^browser_\d+\.json$/.test(n)).map((f) => readJson(f)).filter(Boolean);
  const declared = all.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))[0]?.declared || null;
  const gameplay = GAMEPLAY.test(`${task.title} ${task.detail || ''}`) && part !== 'docs' && (part !== 'sim' || declared?.probes?.length);
  const simShown = part === 'sim' && declared?.simFeatures?.length;
  if (!gameplay && !simShown) return;
  const lastChange = taskChanges(task.id, since).lastAt;
  const after = all.filter((r) => (Date.parse(r.at) || 0) >= Math.max(since, lastChange));
  // 2.30d (plan #6): in wave mode the probes run on the batch (harness/waves.mjs), not per task: the task
  // closes, joins the open wave, and the lane moves on.
  if (gameplay && wavesOn()) {
    const w = (() => { try { return waveFor(task.id)?.id || nextWaveId(); } catch { return null; } })();
    check(`Fun check runs on the batch: this joins wave ${w || 'W-?'} when done (npm run wave -- status)`, true, null);
  } else if (gameplay) {
    const good = after.filter((r) => r.probes?.length && r.probes.every((p) => p.ok));
    const bad = after.flatMap((r) => (r.probes || []).filter((p) => !p.ok)).map((p) => `${p.name}: ${p.why}`);
    check('Real-input fun probes pass in the browser build after the last change', good.length, !declared?.probes?.length ? 'this is a gameplay task but the cartridge declares no probes: add browser.probes (move, sprint, jump, aim, camera) to its qa.mjs, then npm run play:browser' : bad.length ? `a probe fails: ${[...new Set(bad)].slice(0, 3).join('; ')}` : 'no browser play (npm run play:browser) with every probe passing after your last change');
    const clips = newestSince(filesUnder('qa/reports/clips', (n) => /\.(webm|mp4)$/.test(n)), since);
    check('A clip of the real build since the task started', clips.length, 'no clip in qa/reports/clips/ since this task started (npm run clip): every gameplay merge carries one');
  }
  if (simShown) {
    const good = after.filter((r) => (r.simFeatures || []).length && r.simFeatures.every((f) => f.ok));
    const off = after.flatMap((r) => (r.simFeatures || []).filter((f) => !f.ok)).map((f) => f.name);
    check('The build shows every sim feature (input bound, on screen)', good.length, off.length ? `sim-only, not in the build: ${[...new Set(off)].join(', ')}` : 'no browser play after your last change that checked the sim features (npm run play:browser)');
  }
}

/**
 * Returns { ok, type, means, skill, checks: [{ label, ok, why }], missing: [why…] }.
 * Each check reads what the work contains, not only when a file was touched.
 */
/**
 * 2.77.0 (u): the engine pass's work in its own repo: { engine, label, repo, branch, target, ahead, rows } or null (not
 * an engine task, or its engine's work lives in the studio repo).
 */
export function engineWorkChecks(task) {
  let rec = null;
  try { rec = engineTask(task.id); } catch { rec = null; }
  if (!rec) return null;
  const repo = engineRepo(rec.engine);
  if (!repo) return null;
  const t = engineTarget(rec.engine);
  const target = t?.cfg?.target || null;
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true });
  const rows = [];
  const br = rec.branch;
  let ahead = 0;
  if (!br) rows.push({ label: `A ${t.label} branch for this pass`, ok: false, why: `no ${t.label} branch recorded for ${task.id}: task done ${task.id} --train --branch <its branch> (or node harness/unity-gate.mjs branch ${task.id} <branch>)` });
  else {
    const head = g('rev-parse', '--verify', '--quiet', `refs/heads/${br}^{commit}`).stdout.trim();
    const base = target ? g('rev-parse', '--verify', '--quiet', `refs/heads/${target}^{commit}`).stdout.trim() : '';
    ahead = head && base ? Number(g('rev-list', '--count', `${base}..${head}`).stdout.trim()) || 0 : head ? 1 : 0;
    const dirtyIn = (() => { const wt = g('worktree', 'list', '--porcelain').stdout.split('\n\n').map((b) => ({ dir: (b.match(/^worktree (.+)$/m) || [])[1], br: (b.match(/^branch refs\/heads\/(.+)$/m) || [])[1] })).find((w) => w.br === br && w.dir); if (!wt) return []; return g('-C', wt.dir, 'status', '--porcelain').stdout.split('\n').filter(Boolean).filter((l) => !/(^|\/)(Library|Temp|Logs|obj|UserSettings|\.godot)\//.test(l.slice(3))); })();
    rows.push({ label: `Commits on ${br} in the ${t.label} repo that ${target || 'its target'} doesn't have`, ok: Boolean(head) && ahead > 0, why: !head ? `the ${t.label} repo (${repo}) has no branch ${br}` : `${br} has no commits that ${target} lacks: commit the pass's work on ${br}` });
    rows.push({ label: `Everything on ${br} is committed`, ok: !dirtyIn.length, why: `${dirtyIn.length} uncommitted file(s) in ${br}'s worktree (${dirtyIn.slice(0, 3).map((l) => l.slice(3)).join(', ')}): commit them first (only committed work lands)` });
  }
  return { engine: rec.engine, label: t.label, repo, branch: br, target, ahead, rows };
}
const ENGINE_WORK_TYPES = new Set(['change', 'chore', 'bug', 'system', 'whole', 'docs']);

export function checkDone(task, since = startedAt(task.id), { noop = false } = {}) {
  // 2.77.0 (u): an engine pass in its own repo is judged there; the engine's land run is its verify.
  const ew = (() => { try { return engineWorkChecks(task); } catch { return null; } })();
  if (ew && ENGINE_WORK_TYPES.has(typeOf(task).type)) {
    const checks = [...ew.rows];
    try { for (const r of visualCheckRows(task.id)) checks.push(r); } catch (e) { checks.push({ label: 'The visual check', ok: false, why: `could not be read: ${e.message}` }); }
    try { const k = contractChecks(task, 'change', { defer: false }); for (const c of k.checks) checks.push({ label: c.label, ok: Boolean(c.ok), why: c.ok ? null : c.why }); } catch {}
    const missing = checks.filter((c) => !c.ok).map((c) => c.why);
    const typed = typeOf(task);
    return { ok: !missing.length, type: typed.type, typeSource: typed.source, titleType: typed.titleType, part: null, since, checks, missing, notes: [], engineWork: { engine: ew.engine, repo: ew.repo, branch: ew.branch, target: ew.target, ahead: ew.ahead }, skill: 'studio/roles/engine-porter.md', means: `an engine pass in the ${ew.label} repo: commits on its branch that ${ew.target || 'the target'} lacks, all committed${checks.some((c) => /visual|screenshots|reference photo|looked|Reviewed/i.test(c.label)) ? ', the visual check' : ''}; the ${ew.label} land run (task done --train, then the ${ew.label} train; or the gate at done) is its verify` };
  }
  const typed = typeOf(task);
  // 2.65.0: a bug whose diff is only tests, docs or config is a change (evidence; an owner record outranks it).
  const ev = evidenceType(task, typed, { since });
  if (ev) Object.assign(typed, { type: ev.type, source: ev.source, evidence: ev });
  const type = typed.type;
  const part = task.part || partOf(task.id);
  const seen = part === 'renderer' || part === 'both';
  const checks = [];
  const check = (label, ok, why) => checks.push({ label, ok: Boolean(ok), why: ok ? null : why });
  // 2.78.1 (f, M7): warnings that don't block, shown as "WARN ..." (a playtest stage 1 that played the template cartridge
  // while the studio's game has its own checks, STUDIO_PLAYTEST_GAME_CHECK=warn, the default).
  const warnings = [];
  const stage1Warnings = (reps) => {
    const newest = (reps || []).filter(({ j }) => j?.stage1).sort((a, b) => mtime(b.f) - mtime(a.f))[0];
    for (const w of newest?.j?.stage1?.warnings || []) if (w?.id) warnings.push(`${w.id}: ${w.summary || ''}`.slice(0, 500));
  };

  const workAndVerify = (docsOnly = false) => {
    const ch = taskChanges(task.id, since);
    const relevant = docsOnly ? ch.files.filter((f) => f.endsWith('.md')) : ch.files;
    check(docsOnly ? 'Docs changed for this task' : 'Changes exist for this task', relevant.length, docsOnly ? 'no changed .md file since this task started' : `no changes found for ${task.id}: no commit tagged Studio-Task: ${task.id} and no edits since it started`);
    const why = gatesAfter(Math.max(since, ch.lastAt), relevant, task.id, ch);
    check('Full verify green after the last change', !why, why);
    if (!docsOnly) {
      const sizeInfo = [];
      const grew = sizeGrowth(task.id, ch.files, sizeInfo);
      // 2.58.3 (crew P-034): every item, not the first 3 (fixing them one by one kept turning up the next ones); past
      // 10, the first 10 and the full list in .studio/size-growth/<task>.txt. 2.60.0: what the game's "sizeRule" let through, in the label.
      if (grew !== null) check(`No function or file grown past the size limit${sizeInfo.length && !grew.length ? ` (${sizeInfo.slice(0, 3).join('; ')})` : ''}`, !grew.length, `${sizeList(task.id, grew)}. Split it first (move a part into its own function or file), or ask the Producer for a split task (npm run task -- add "Split …")`);
    }
  };

  // 2.58.0: a chore closes like a change, without the gameplay, reach and screenshot checks below.
  // 2.80 (f, N6): a chore closed --no-op (with its reason) has no change to verify: it skips exactly those two items.
  if (type === 'change' || (type === 'chore' && !noop)) workAndVerify();
  if (type === 'change' || type === 'bug') gameplayChecks(task, part, since, check);
  // 2.38.0: built but not wired. Game code this task changed that nothing in the game reaches from its entry
  // points (harness/reachability.mjs). A note by default; STUDIO_REACHABILITY=fail makes it a failing check.
  const notes = [];
  if (['change', 'bug', 'system'].includes(type) && reachMode() !== 'off') {
    try {
      const u = unreached(taskChanges(task.id, since).files);
      if (u.length) {
        const why = `${u.slice(0, 4).join(', ')}${u.length > 4 ? ` and ${u.length - 4} more` : ''} ${u.length === 1 ? 'is' : 'are'} not reached from the game (nothing imports ${u.length === 1 ? 'it' : 'them'} from an entry point; tests and demos don't count): wire ${u.length === 1 ? 'it' : 'them'} in, or say in the hand-back why ${u.length === 1 ? 'it waits' : 'they wait'}`;
        if (reachMode() === 'fail') check('New game code is wired into the game', false, why);
        else notes.push(why);
      }
    } catch {
      // the reachability walk is a help, never a crash
    }
  }
  if (type === 'docs') workAndVerify(true);
  if (type === 'bug') {
    // 2.59.0: a cartridge replay (seed, tick, pinned hash) or a seeded game unit test ("kind": "test": the test file,
    // its name and the seed; the command is the studio's own, qa/regressions/README.md).
    const replayReg = (j) => regressionKind(j) === 'replay' && Number.isInteger(j.seed) && Number.isInteger(j.tick) && isSha256(j.sha256);
    const testReg = (j) => regressionKind(j) === 'test' && Number.isInteger(j.seed) && typeof j.test?.file === 'string' && j.test.file && typeof j.test?.name === 'string' && j.test.name;
    const cands = newestSince(filesUnder('qa/regressions', (n) => n.endsWith('.json')), since).map((f) => ({ f, j: readJson(f) }));
    const regs = cands.filter(({ j }) => j && (replayReg(j) || testReg(j)));
    // 2.67.2: the refusal says exactly what to add: the file path, the fields a file written since the claim still
    // lacks, the pin command and the fails-before command (harness/regression-howto.mjs; the bug brief says the same).
    const fix0 = regs.length ? null : firstTaggedCommit(task.id);
    const lacking = cands.filter(({ j }) => !(j && (replayReg(j) || testReg(j)))).slice(0, 3).map(({ f, j }) => `${String(f).replace(/\\/g, '/')} (missing ${regressionMissing(j).join(', ')})`);
    if (part !== 'renderer') check('Regression saved (a cartridge replay with seed, tick and a pinned hash, or a seeded game test)', regs.length, `no regression in qa/regressions/ since this task started${lacking.length ? `; written since the claim but not counted: ${lacking.join('; ')}` : ''}. ${regressionHowTo(task.id, { fix: fix0 || null }).join(' ')} (studio/skills/bug.md)`);
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
        console.error(`[done-check] replaying ${regs.length} regression(s) on the commit before the fix (${fix.slice(0, 8)}^): this can take minutes`);
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
      // 2.41.0: STUDIO_TWO_GREENS=on (opt-in): a new browser regression joins the protected set only after two
      // separate passing plays since the last change and no failing one. The research pack: "one flaky input
      // test turned the main branch red even though the game code was fine".
      if (/^(on|1|true|yes)$/i.test(process.env.STUDIO_TWO_GREENS || '') && good.length) {
        const after = plays.filter((r) => (Date.parse(r.at) || 0) >= lastChange);
        const red = after.filter((r) => bregs.some((f) => (r.regressions || []).some((x) => x.file === f && !x.ok)));
        check('The new regression passed twice in a row, never failing (it is not flaky)', good.length >= 2 && !red.length, red.length ? `the new regression failed in ${red.length} of ${after.length} browser plays since your last change (${red.map((r) => (r.regressions || []).find((x) => bregs.includes(x.file) && !x.ok)?.why).filter(Boolean)[0] || 'see the report'}): a flaky test must not be protected; make it deterministic` : `it has passed once since your last change; run npm run play:browser again (a new regression must pass twice before it is protected)`);
      }
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
  // 2.79 (t): a studio whose game has its own build or checks doesn't play the template cartridge per task any more: the
  // game tester (harness/tester.mjs) plays the real build on its own schedule. A template studio keeps the stage-1 rows.
  const s1 = stage1Replaced();
  if (type === 'playtest' && s1.replaced) check(`Stage-1 playtest: ${s1.words}`, true, '');
  else if (type === 'playtest' && testerRunsSince(since).length) {
    check(`Playtest of the current build: a game tester run (${testerRunsSince(since)[0]}) is newer than the task start and the last game change`, true, '');
  } else if (type === 'playtest') {
    const reps = newestSince(filesUnder('qa/reports', (n) => /^qa_.*\.json$/.test(n)), since).map((f) => ({ f, j: readJson(f) })).filter(({ j }) => j?.stage1);
    check('Playtest report since the task started', reps.length, 'no playtest report in qa/reports/ since this task started (`npm run playtest:stage1`, or a game tester run: `npm run tester`)');
    const good = reps.filter(({ f, j }) => mtime(f) >= fresh && j.stage1.seed != null && j.stage1.ticksRun != null && isSha256(j.stage1.finalSha256) && (j.passed || j.stage1.failingTick != null));
    check('Report covers the current build with seed, ticks and hash (and the failing tick if it failed)', good.length, 'no report on the current build with a seed, ticks, a hash and (if it failed) the failing tick; run the playtest again');
    stage1Warnings(good.length ? good : reps);
  }
  // 2.71.0 (y): research is paperwork: its write-up, with a Sources section and at least one link (harness/research.mjs).
  if (type === 'research') {
    const r = checkResearch(task);
    let wrote = null;
    if (!r.exists) { try { wrote = ensureResearchTemplate(task); } catch { wrote = null; } }
    check(`Research write-up at ${r.file}`, r.exists, wrote ? `no write-up yet: the template is now at ${wrote}; fill it in (the question, sources with links, findings, what is UNVERIFIED, a recommendation) and commit it` : `no write-up at ${r.file}`);
    if (r.exists) check('The write-up has a Sources section with at least one link', r.ok, `${r.why}: list each source with its link (https://…); research without sources is not done`);
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
    // 2.30n: the spec must be this task's (its ID in the file name or text), not any spec written meanwhile.
    const idRe = new RegExp(`\\b${task.id}\\b`);
    const specs = newestSince(filesUnder('studio/bible/systems', (n) => n.endsWith('.md') && n !== 'README.md'), since).filter((f) => idRe.test(path.basename(f)) || idRe.test(fs.readFileSync(abs(f), 'utf8')));
    check('Spec for this task written in studio/bible/systems/ since it started', specs.length, `no spec in studio/bible/systems/ naming ${task.id} since this task started (what it does, its phase and layer, its rules and invariants; put ${task.id} in its name or text)`);
    check('Spec ends with a hand-off for the next agent', specs.some((f) => /^##\s*For the next agent/im.test(fs.readFileSync(abs(f), 'utf8')) && words(f) >= 80), 'the spec has no "## For the next agent" section, or is under 80 words');
    const ch = taskChanges(task.id, since);
    check('A scenario for it in the game\'s qa.mjs', ch.files.some((f) => /^cartridges\/[^/]+\/qa\.mjs$/.test(f) || /^(web|game)\/[^/]+\/sim\/qa\.mjs$/.test(f)), 'qa.mjs wasn\'t changed: add a scenario that exercises the system (cartridges/<game>/qa.mjs, or web/<game>/sim/qa.mjs)');
    check('Goldens updated with it', ch.files.some((f) => f.startsWith('qa/golden/')), 'no golden changed: the system changes the game, so regenerate (npm run golden -- --update) and commit the goldens with it');
    const fresh2 = lastGameChange();
    const reps = s1.replaced ? [] : newestSince(filesUnder('qa/reports', (n) => /^qa_.*\.json$/.test(n)), since).filter((f) => mtime(f) >= fresh2);
    const tr = s1.replaced ? [] : testerRunsSince(since);
    if (s1.replaced) check(`Stage-1 playtest of the current build: ${s1.words}`, true, '');
    else if (tr.length) check(`Playtest of the current build: a game tester run (${tr[0]}) is newer than the task start and the last game change`, true, '');
    else check('Playtest of the current build', reps.length, 'no playtest report newer than the last game change (npm run playtest:stage1, or a game tester run: npm run tester)');
    if (!s1.replaced) stage1Warnings(reps.map((f) => ({ f, j: readJson(f) })).filter(({ j }) => j?.stage1));
    workAndVerify();
    const implementer = (readRecentEvents(20000).filter((e) => e.type === 'task.start' && e.task === task.id).pop() || {}).model;
    const notes = filesUnder('studio/reviews', (n) => n.endsWith('.md') && n !== 'README.md').map((f) => fs.readFileSync(abs(f), 'utf8')).filter((t) => new RegExp(`\\b${task.id}\\b`).test(t));
    const approving = notes.filter(reviewApproves);
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
  if (type === 'idea') {
    const id = (task.title.match(/\bI-\d+\b/) || [])[0];
    const idea = id ? readIdea(id) : null;
    check(`Title names an idea (${id || 'I-…'})`, idea, id ? `no idea ${id} on the Idea Board` : 'the title names no idea (like I-001)');
    const moved = idea && (idea.history || []).some((h) => Date.parse(h.at) >= since && ['shaped', 'placed', 'approved', 'parked', 'rejected'].includes(h.stage));
    check('The idea moved to its next stage since the task started', moved, `${id || 'the idea'} hasn't moved since this task started (npm run idea -- shape|place|decide ${id || 'I-…'})`);
  }
  if (type === 'whole') {
    workAndVerify();
    // The fix must be checked the way the break was found: every check on the whole game.
    const rec = lastFullRecord();
    check('The verify ran on the whole game (--all), not scoped to your files', rec && !rec.scoped, rec ? 'the last verify was scoped to the files you changed; this task needs npm run verify -- --all' : 'no full verify recorded');
  }
  if (type === 'rescue') {
    const stuck = (String(task.title).match(/^Rescue:\s*(T-\d+)/i) || [])[1];
    const rel = stuck ? `studio/rescues/${stuck}.md` : null;
    const text = rel && fs.existsSync(abs(rel)) && mtime(rel) >= since ? fs.readFileSync(abs(rel), 'utf8') : '';
    const decision = ((text.match(/^\s*Decision:\s*([\w-]+)/im) || [])[1] || '').toLowerCase();
    const diag = (text.split(/^\s*Diagnosis:\s*/im)[1] || '').split(/^\s*Decision:/im)[0];
    check('Rescue report written since the rescue started', Boolean(text), `no ${rel || 'studio/rescues/<T-ID>.md'} since this rescue started (see studio/skills/rescue.md)`);
    check('A diagnosis of 40+ words (what kept failing, and why)', (diag.match(/[A-Za-z0-9]{2,}/g) || []).length >= 40, 'the report has no "Diagnosis:" section of 40+ words');
    check('One decision: retry, split or needs-person', ['retry', 'split', 'needs-person'].includes(decision), `the report has no "Decision: retry|split|needs-person" line${decision ? ` ("${decision}" isn't one)` : ''}`);
    // Step 2 of the ladder (the title says "split it"): a retry already failed once, so only split or needs-person.
    if (/split it into small pieces/i.test(task.title)) check('Step 2 decides split or needs-person (a retry already failed)', decision !== 'retry', 'this is rescue step 2: the decision must be split or needs-person, not retry');
    if (decision === 'split') {
      const added = readRecentEvents(20000).filter((e) => e.type === 'task.added' && Date.parse(e.ts) >= since && e.task !== task.id && new RegExp(`\\b${stuck}\\b`).test(e.msg || ''));
      check('The smaller tasks are queued, each naming the stuck task', added.length > 0, `split: no task added since the rescue started whose title names ${stuck}`);
    }
  }
  if (seen && ['change', 'bug', 'system'].includes(type)) {
    const pr = proofStatus(task.id, since);
    check('Screenshots, each with a line saying what it shows', pr.shots && pr.fresh, `no screenshots for ${task.id} since it started: npm run play:browser, then npm run proof -- add ${task.id} <png> "<what it shows>"`);
    check('Checked by someone other than the builder', pr.checked, pr.wrong ? `the last check said they don't match: ${pr.wrong}` : `nobody else has checked them yet: npm run proof -- check ${task.id} --by <name> --verdict matches|wrong`);
  }
  // 2.77.0 (u, P5.5): a task added with --visual-check or --refs needs the visual check (harness/visual-check.mjs).
  try { for (const r of visualCheckRows(task.id)) check(r.label, r.ok, r.why); } catch { /* not readable: no rows */ }
  // 2.62.0 (H): an agreed acceptance contract (studio/contracts/<ID>.json, harness/contracts.mjs) needs every
  // criterion in force passing; no contract, no change (unless studio/game.json "contracts.required" names the type).
  {
    // 2.72.0 (c): in a lane that lands through the merge train, an unverified must-item waits for the reviewer there
    // (tier C, harness/train.mjs laneTier) instead of blocking done here; elsewhere it blocks as before.
    const k = contractChecks(task, type, { defer: inLaneCopy() && !/^(off|0|false|no)$/i.test(String(process.env.STUDIO_TRAIN || '')) });
    for (const c of k.checks) check(c.label, c.ok, c.why);
    notes.push(...k.notes);
  }
  const missing = checks.filter((c) => !c.ok).map((c) => c.why);
  return { ok: missing.length === 0, type, typeSource: typed.source, typeIgnored: typed.ignored, titleType: typed.titleType, ...(typed.evidence ? { typeEvidence: typed.evidence } : {}), part, since, checks, missing, notes, ...(warnings.length ? { warnings } : {}), ...TYPES[type] };
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
  console.log(`${task.id} is a "${res.type}" task (${res.typeSource}). Done means: ${res.means}.${res.skill ? ` Skill: ${res.skill}` : ''}`);
  if (res.typeIgnored) console.log(`  note: ${res.typeIgnored}`);
  if (res.typeEvidence) console.log(`  type: ${res.type} (${res.typeSource}; the title says ${res.titleType}, so no regression replay is needed)`);
  // 2.60.1 (B-38): whether it needs a visual result, and why (the owner's decision, the evidence or the title).
  try {
    const d = renderDecision(task);
    if (d.by === 'owner') console.log(`  ${d.why}`);
    else if (d.why) console.log(`  visual proof: ${d.render ? 'needed' : 'not needed'} (${d.why})`);
    if (d.warn) console.log(`  WARN ${d.warn}`);
    if (d.ignored) console.log(`  note: ${d.ignored}`);
    // 2.65.0: the visual result on file, with each camera's noise baseline (harness/visual-proof.mjs).
    const vp = readVerdict(task.id)?.parts?.visual;
    if (vp) console.log(`  visual result: ${vp.ok ? 'PASS' : 'FAIL'}${vp.why ? ` (${vp.why.slice(0, 300)})` : ''}${(vp.evidence || []).length ? ` [${vp.evidence.join('; ').slice(0, 300)}]` : ''}`);
  } catch { /* no verdict module */ }
  for (const c of res.checks) console.log(`  [${c.ok ? 'x' : ' '}] ${c.label}${c.ok ? '' : `: ${c.why}`}`);
  for (const w of res.warnings || []) console.log(`  WARN ${w}`);
  for (const n of res.notes || []) console.log(`  note: ${n}${/^studio\/contracts\//.test(n) ? '' : ' (STUDIO_REACHABILITY=fail makes this a failing check)'}`);
  console.log(res.ok ? 'Ready to finish.' : 'Not done yet.');
  process.exit(res.ok ? 0 : 1);
}
