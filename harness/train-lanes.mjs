/**
 * harness/train-lanes.mjs — 2.76.0 (helper h): the merge train's lane mechanics that were costing the crew hand-backs.
 *
 *   W-0081  recreateLaneCopy: a queued lane whose copy (.lanes/<name>) is gone is made again from its branch (the copy's
 *           links, sparse checkout and exclude file as harness/worktree.mjs makes them) instead of being handed back.
 *           Only a folder under <main>/.lanes/, only when the branch still holds the queued head (or moved forward from
 *           it), and never while another worktree has that branch checked out.
 *   infra   infraHandBack: the hand-backs the harness or the machine caused (a missing lane copy, a CRLF/hash mismatch, a
 *           re-queue, a dead train, a timeout-only red already re-run alone, a mixed lane) never count toward
 *           STUDIO_TRAIN_MAX_HANDBACKS. Releases are also kept by task and head (.studio/train/releases.json), so a
 *           release survives the lane leaving and re-entering the queue for the same commit.
 *   B-91/92 mixedLane: the lane's own commits (main..head, patch-equal commits main already has left out) that carry
 *           another OPEN task's Studio-Task trailer and not this one's: such a lane is refused before its verify, naming
 *           the commits and how to split them off.
 * No import of train.mjs (it imports this).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { emitEvent } from './event.mjs';
import { linkDir, nodeModuleDirs, ignoreLanes, LANES_DIR } from './worktree.mjs';
import { writeAtomic } from './fsafe.mjs';

const git = (cwd, ...args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const norm = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));

// ---- W-0081: a missing lane copy, made again from its branch ----

/**
 * 2.79 (b): true when `dir` is its own git worktree (git's top level there is the folder itself). A folder with no .git
 * (a leftover: something wrote .studio/ into a removed copy) gets main's top level from git, so it never counts.
 */
export function ownWorktree(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return false;
    const top = out(git(dir, 'rev-parse', '--show-toplevel'));
    return Boolean(top) && norm(real(top)) === norm(real(dir));
  } catch { return false; }
}

/**
 * Make `lane`'s copy again at lane.dir from lane.branch. { ok, dir, branch, head, why }. Never throws.
 */
export function recreateLaneCopy(root, lane, { log = () => {} } = {}) {
  const no = (why) => ({ ok: false, why });
  try {
    if (!lane?.dir || !lane.branch) return no('the queue entry names no copy folder or branch');
    const lanes = path.join(real(root), LANES_DIR);
    const dir = path.resolve(lane.dir);
    const parent = real(path.dirname(dir));
    if (norm(parent) !== norm(lanes) || path.basename(dir).startsWith('_train-')) return no(`${lane.dir} is not a lane copy folder (${LANES_DIR}/<name>)`);
    // 2.79 (b): a folder that is not its own worktree (no .git) counts as missing: moved aside, not deleted, then made again.
    if (fs.existsSync(dir)) {
      if (ownWorktree(dir)) return no(`${lane.dir} exists`);
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
      const left = path.join(root, '.studio', 'lane-leftovers', `${path.basename(dir)}-${stamp}`);
      try { fs.mkdirSync(path.dirname(left), { recursive: true }); fs.renameSync(dir, left); }
      catch (e) { return no(`${lane.dir} is a leftover folder (no git worktree) and could not be moved aside (${e.code || e.message})`); }
      log(`[train] ${lane.task}: ${LANES_DIR}/${path.basename(dir)} had no .git (not a worktree); moved to ${path.relative(root, left).split(path.sep).join('/')}`);
    }
    const ref = `refs/heads/${lane.branch}`;
    const tip = out(git(root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`));
    if (!tip) return no(`its branch ${lane.branch} is gone too`);
    if (lane.head && tip !== lane.head && git(root, 'merge-base', '--is-ancestor', lane.head, tip).status !== 0) return no(`its branch ${lane.branch} no longer holds the queued commit ${String(lane.head).slice(0, 8)}`);
    git(root, 'worktree', 'prune');
    const wt = out(git(root, 'worktree', 'list', '--porcelain')).split('\n\n');
    const other = wt.find((b) => b.split('\n').includes(`branch ${ref}`));
    if (other) return no(`its branch ${lane.branch} is checked out in ${other.split('\n')[0].replace(/^worktree /, '')}`);
    ignoreLanes(root);
    const add = git(root, 'worktree', 'add', '--no-checkout', dir, lane.branch);
    if (add.status !== 0) return no(`git worktree add failed: ${String(add.stderr || '').trim().split('\n').pop()}`);
    const steps = [
      ['config', 'extensions.worktreeConfig', 'true'],
      ['config', '--worktree', 'sparse.expectFilesOutsideOfPatterns', 'true'],
      ['sparse-checkout', 'set', '--no-cone', '/*', '!/studio/', '!/.studio/'],
      ['checkout', '-q', lane.branch],
    ];
    for (const s of steps) {
      const r = git(dir, ...s);
      if (r.status !== 0) { git(root, 'worktree', 'remove', '--force', dir); return no(`git ${s.slice(0, 2).join(' ')} failed: ${String(r.stderr || '').trim().split('\n').pop()}`); }
    }
    if (!linkDir(path.join(root, 'studio'), path.join(dir, 'studio')) || !linkDir(path.join(root, '.studio'), path.join(dir, '.studio'))) {
      git(root, 'worktree', 'remove', '--force', dir);
      return no('could not link studio/ and .studio/ into the copy');
    }
    for (const rel of nodeModuleDirs(root)) if (!fs.existsSync(path.join(dir, rel))) linkDir(path.join(root, rel), path.join(dir, rel));
    try { if (fs.existsSync(path.join(root, '.env'))) fs.copyFileSync(path.join(root, '.env'), path.join(dir, '.env')); } catch {}
    const name = path.basename(dir);
    const exclude = path.join(root, '.studio', 'lanes', `${name}.exclude`);
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(exclude, ['/studio', '/.studio', '/.env', 'node_modules', ''].join('\n'));
    git(dir, 'config', '--worktree', 'core.excludesFile', exclude);
    const head = out(git(dir, 'rev-parse', 'HEAD'));
    log(`[train] ${lane.task}: its lane copy ${LANES_DIR}/${name} was gone; made it again from ${lane.branch} at ${head.slice(0, 8)} (W-0081)`);
    return { ok: true, dir, branch: lane.branch, head, why: '' };
  } catch (e) { return no(`could not make it again (${e.message})`); }
}

// ---- infrastructure hand-backs and kept releases ----

/** A hand-back the harness or the machine caused, not the lane's work (never counted toward the hand-back cap). */
export const INFRA_HANDBACK = /lane copy [^\n]{0,200}\b(is gone|was gone|missing|is not a git checkout)|\bCRLF\b|line[- ]endings? (differ|mismatch)|hash(es)? (don't|do not|doesn't|does not|didn't) match|hashed on CRLF|\bre-?queue(d|ing)?\b|queued (it )?again|\btrain \S+ died\b|\bdied: \w+|timeout-flake|timed out and passed alone|timeout-only red|mixed lane|carries commits of another task/i;
export const infraHandBack = (e) => Boolean(e?.meta?.infra) || INFRA_HANDBACK.test(String(e?.msg || ''));

const relFile = (root) => path.join(root, '.studio', 'train', 'releases.json');
const readRels = (root) => { try { const j = JSON.parse(fs.readFileSync(relFile(root), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
const writeRels = (root, j) => { try { const f = relFile(root); fs.mkdirSync(path.dirname(f), { recursive: true }); writeAtomic(f, `${JSON.stringify(j, null, 2)}\n`); } catch {} };
/** Keep a release by task and head (the newest 5 per task). */
export function keepRelease(root, task, rel) {
  if (!task || !rel?.head) return;
  const j = readRels(root);
  j[task] = [...(j[task] || []).filter((r) => r.head !== rel.head), rel].slice(-5);
  writeRels(root, j);
}
/**
 * The kept release of `task` for `head`, or null. 2.79 (c): with `tip` (main's tip), also one made at another head whose
 * lane content is the same now (releaseCovers), carried to this head.
 */
export function keptRelease(root, task, head, { tip = null } = {}) {
  if (!head) return null;
  const list = readRels(root)[task] || [];
  const exact = list.find((r) => r.head === head);
  if (exact || !tip) return exact || null;
  for (const r of [...list].reverse()) { const c = carriedRelease(root, r, { head, tip }); if (c) return c; }
  return null;
}

// ---- 2.79 (c): a release keyed on the lane's own content, not its raw head ----
//
// The crew's run (18:50): the train's precheck merged main into a released lane (a new head), and the owner's release
// was void: a release loop whenever main moved. A release now also records the lane's content: each file the lane changes
// against its merge-base with main, with that file's blob at the merge-base and at the lane's head. A new head with the
// same content (a re-queue, a catch-up merge of main that touches none of those files) is still covered; a lane commit
// that changes one of them, adds another file, or a main change merged into one of them is not (the key differs).

/** The lane's content against main's tip: { key, files, base } or null (unreadable). Never throws. */
export function laneContent(root, { head, tip }) {
  try {
    if (!head || !tip) return null;
    const base = out(git(root, 'merge-base', tip, head));
    if (!base) return null;
    const d = git(root, '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z', base, head);
    if (d.status !== 0) return null;
    const files = String(d.stdout || '').split('\0').filter(Boolean).sort();
    const blobs = (rev) => {
      const m = new Map();
      if (!files.length) return m;
      const r = git(root, '-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', rev, '--', ...files);
      for (const line of String(r.stdout || '').split('\0').filter(Boolean)) { const tab = line.indexOf('\t'); if (tab > 0) m.set(line.slice(tab + 1), line.slice(0, tab).split(' ')[2]); }
      return m;
    };
    const b = blobs(base); const h = blobs(head);
    const rows = files.map((f) => [f, b.get(f) || '-', h.get(f) || '-']);
    return { key: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'), files, base };
  } catch { return null; }
}
/** Does release `rel` (made at rel.head, with rel.content) still cover the lane at `head`? */
export function releaseCovers(root, rel, { head, tip }) {
  if (!rel || !head) return false;
  if (rel.head === head) return true;
  if (!rel.content?.key || !tip) return false;
  const c = laneContent(root, { head, tip });
  return Boolean(c && c.key === rel.content.key);
}
/** The release carried to `head` (same content), or null: { ...rel, head, carriedFrom: [older heads] }. */
export function carriedRelease(root, rel, { head, tip }) {
  if (!rel) return null;
  if (rel.head === head) return rel;
  if (!releaseCovers(root, rel, { head, tip })) return null;
  return { ...rel, head, carriedFrom: [...new Set([...(rel.carriedFrom || []), rel.head])].slice(-5) };
}
/** Forget a kept release (a reverted decision); all of the task's when head is null. */
export function forgetRelease(root, task, head = null) {
  const j = readRels(root);
  if (!j[task]) return;
  j[task] = head ? j[task].filter((r) => r.head !== head) : [];
  if (!j[task].length) delete j[task];
  writeRels(root, j);
}

// ---- B-91/B-92: a lane carrying another task's commits ----

/**
 * The lane's own commits (tip..head, merges and commits whose patch main already has left out) tagged Studio-Task with
 * another task that is open on the board and not with this one. { mixed, foreign: [{ task, commits: [{ sha, subject }] }],
 * own: n, why }. open(task) -> bool says what is open. Never throws (an unreadable lane is not judged mixed).
 */
export function mixedLane(root, { task, tip, head, open = () => true } = {}) {
  const none = { mixed: false, foreign: [], own: 0, why: '' };
  try {
    if (!tip || !head) return none;
    const r = git(root, 'log', '--no-merges', '--right-only', '--cherry-pick', '--format=%x1e%H%x09%s%x09%(trailers:key=Studio-Task,valueonly,separator=%x2C)', `${tip}...${head}`);
    if (r.status !== 0) return none;
    const foreign = new Map();
    let own = 0;
    for (const block of String(r.stdout).split('\x1e').filter((b) => b.trim())) {
      const [sha, subject = '', tags = ''] = block.replace(/\n+$/, '').split('\t');
      const ids = tags.split(/[,\s]+/).filter((x) => /^[A-Z]+-\d+$/.test(x));
      if (ids.includes(task)) { own += 1; continue; }
      for (const t of ids.filter((x) => open(x))) {
        const f = foreign.get(t) || { task: t, commits: [] };
        f.commits.push({ sha: sha.trim(), subject: subject.slice(0, 80) });
        foreign.set(t, f);
      }
    }
    if (!foreign.size) return { ...none, own };
    const list = [...foreign.values()];
    const shown = list.map((f) => `${f.task} (${f.commits.length} commit(s): ${f.commits.slice(0, 2).map((c) => `${c.sha.slice(0, 8)} "${c.subject}"`).join(', ')}${f.commits.length > 2 ? ', …' : ''})`).join('; ');
    const why = `a mixed lane: it carries commits of another task that hasn't landed: ${shown}${own ? '' : `, and none tagged Studio-Task: ${task}`}. A lane trains only its own task's commits (another lane was merged into this copy, or the session worked on another task). Make a clean lane: a branch off main with only ${task}'s commits (git switch -c <new> main, then git cherry-pick <${task}'s commits>), and task done ${task} there; or, if the work is ${list[0].task}'s, finish it as ${list[0].task}`;
    return { mixed: true, foreign: list, own, why };
  } catch { return none; }
}

/**
 * The tasks a lane may carry commits of: its --after dependencies (studio/task-holds.json, followed through) and, for a
 * rescue ("Rescue: T-x …" on the board), the task it rescues. A Set of ids.
 */
export function mayCarry(root, task, depMap = new Map()) {
  const ok = new Set();
  const walk = (t) => { for (const d of depMap.get(t) || []) if (!ok.has(d)) { ok.add(d); walk(d); } };
  walk(task);
  try {
    const line = fs.readFileSync(path.join(root, 'studio', 'NEXT.md'), 'utf8').split(/\r?\n/).find((l) => l.includes(`**${task}**`)) || '';
    const m = line.match(/Rescue:?\s*(T-\d+)\b/i);
    if (m && m[1] !== task) { ok.add(m[1]); walk(m[1]); }
  } catch {}
  return ok;
}

/** One event per mixed-lane refusal (task.train.mixed). */
export function noteMixed(id, lane, m, by) {
  try { emitEvent({ type: 'task.train.mixed', agent: by || 'train', task: lane.task, to: lane.agent, status: 'blocked', msg: `train ${id}: ${lane.task} refused before its verify: ${m.why}`.slice(0, 600), meta: { train: id, infra: true, foreign: m.foreign.map((f) => ({ task: f.task, commits: f.commits.map((c) => c.sha) })), own: m.own } }); } catch {}
}
