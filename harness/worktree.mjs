/**
 * harness/worktree.mjs — one working copy per lane.
 *
 * Builders sharing one checkout leaked half-done edits into each other's tests and commits. An agent the launcher
 * starts with a code lane works in its own git worktree, `.lanes/<agent>/`, on its own branch; its finished work
 * reaches the studio's branch only through `task done`, after its checks pass.
 *
 * Shared: `studio/` (the board, handoffs, the Bible) and `.studio/` (locks, events, sessions) are links to the main
 * checkout's, so every agent sees one board and one set of claims; both are left out of the worktree's own checkout
 * (sparse checkout) so the link never shows as a change. `.env` is copied and `node_modules` folders are linked.
 *
 *   task start (in a lane copy)  fast-forwards it to the studio's branch when it has no work of its own
 *   task done  (in a lane copy)  refuses uncommitted work, rebases on the studio's branch, re-runs the
 *                                everyday checks if the branch moved, then fast-forwards the studio's branch
 *   the session ends             a merged copy is removed; unmerged commits stay on their branch, which the
 *                                next agent on that task gets merged into its own copy
 *
 * Needs git 2.42 or newer (sparse.expectFilesOutsideOfPatterns). Older git, not a git checkout, or
 * STUDIO_WORKTREES=off: agents share the main checkout as before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';
import { PROXY_HELD } from './agent-env.mjs';
import { listLocks } from './lock.mjs';
import { changedSince, readPass, recordPass, canReuse, withLandLock, landingRecheckEnv } from './merge-lane.mjs';
import { PLANNING_ROLES } from './planning-roles.mjs';
import { splitEolOnly, eolNote, splitPhantom, phantomNote } from './eol-only.mjs';
import { mixedLane, mayCarry } from './train-lanes.mjs';
import { boardStates, readDeps } from './train-deps.mjs';
import { lanePlan, writeRecord as writeSparseRecord, removeRecord as removeSparseRecord, widenStrays } from './lane-sparse.mjs';
import { approvedBranchFor } from './lane-approvals.mjs';
import { writeLaneBaseline } from './drift-baseline.mjs';

export const LANES_DIR = '.lanes';
const BRANCHES = () => path.join(STUDIO_STATE_DIR, 'lane-branches.json');
const git = (cwd, ...args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** The main checkout: this one, or the one a lane copy was made from. */
// A lane copy lives at <main>/.lanes/<agent>; that path names the main checkout even when the shell lost
// STUDIO_MAIN_ROOT, so done never skips the merge.
const fromPath = () => {
  const m = REPO_ROOT.replace(/\\/g, '/').match(/^(.*)\/\.lanes\/[^/]+$/);
  return m && fs.existsSync(path.join(m[1], '.git')) ? path.resolve(m[1]) : null;
};
export const mainRoot = () => (process.env.STUDIO_MAIN_ROOT ? path.resolve(process.env.STUDIO_MAIN_ROOT) : fromPath() || REPO_ROOT);
/** True inside a lane copy. */
export const inLaneCopy = () => mainRoot() !== REPO_ROOT;

export function gitVersion() {
  const m = (git(REPO_ROOT, '--version').stdout || '').match(/(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Whether lane copies are on, and if not, why. */
export function worktreeSupport(root = mainRoot()) {
  if (/^(off|0|false|no)$/i.test(process.env.STUDIO_WORKTREES || '')) return { ok: false, why: 'STUDIO_WORKTREES=off' };
  if (git(root, 'rev-parse', '--is-inside-work-tree').stdout?.trim() !== 'true') return { ok: false, why: 'not a git checkout' };
  const v = gitVersion();
  if (!v || v[0] < 2 || (v[0] === 2 && v[1] < 42)) return { ok: false, why: `git ${v ? v.join('.') : '?'} is older than 2.42 (macOS: brew install git; Windows: update Git for Windows)` };
  if (!git(root, 'symbolic-ref', '--short', 'HEAD').stdout?.trim()) return { ok: false, why: 'the main checkout is not on a branch' };
  return { ok: true };
}

/** A lane in the code (not the board, not the whole game) gets its own copy. */
export const laneWantsCopy = (lane) => Boolean(lane) && !/^(studio|\.studio)(\/|$)/.test(lane);

/**
 * Roles that work on the board, not the game's code, and so stay in the main checkout when their task has no lane (the
 * planning roles of harness/stall.mjs, plus a person).
 */
export const MAIN_CHECKOUT_ROLES = new Set([...PLANNING_ROLES, 'human']);
/**
 * A session on a task with no lane gets its own copy too when its role writes code (builder, rnd, art, qa-playtester,
 * reviewer, …), as does one started with no task at all: laneless builders stage files in the main checkout and block
 * other tasks' `task done`. STUDIO_LANELESS=shared keeps the shared checkout; STUDIO_WORKTREES=off turns copies off.
 */
export function lanelessWantsCopy({ role, lane = null, task = null, env = process.env } = {}) {
  void task;
  if (lane || !role) return false;
  if (/^shared$/i.test(env.STUDIO_LANELESS || '') || /^(off|0|false|no)$/i.test(env.STUDIO_WORKTREES || '')) return false;
  return !MAIN_CHECKOUT_ROLES.has(String(role).toLowerCase());
}

/**
 * The main checkout's real studio/ and .studio/ folders, which a lane copy links to. A tool started in the copy is told
 * it may use them (Claude Code: --add-dir), since it resolves the links and would otherwise refuse their targets.
 */
export function laneShareDirs(root = mainRoot()) {
  return ['studio', '.studio'].map((d) => {
    const p = path.join(root, d);
    try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
  });
}

export const mainBranch = (root = mainRoot()) => git(root, 'symbolic-ref', '--short', 'HEAD').stdout.trim();

function readBranches() {
  try {
    return JSON.parse(fs.readFileSync(BRANCHES(), 'utf8'));
  } catch {
    return {};
  }
}
function writeBranches(b) {
  pruneUnknownTasks(b);
  fs.mkdirSync(path.dirname(BRANCHES()), { recursive: true });
  fs.writeFileSync(BRANCHES(), `${JSON.stringify(b, null, 2)}\n`);
}

/**
 * Keep .lanes/ out of the main checkout's git status even where an older studio's .gitignore lacks it
 * (git add -A would otherwise add every lane copy as an embedded repository).
 */
export function ignoreLanes(root = mainRoot()) {
  const common = git(root, 'rev-parse', '--git-common-dir').stdout.trim();
  if (!common) return;
  const file = path.join(path.resolve(root, common), 'info', 'exclude');
  try {
    const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!/^\/?\.lanes\/?$/m.test(now)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${now && !now.endsWith('\n') ? '\n' : ''}/.lanes/\n`);
    }
  } catch {}
}

/** Link a folder (a junction on Windows, which needs no admin rights). */
export function linkDir(target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

/** node_modules folders worth linking: the root's, and one level into game/, web/, engine/. */
export function nodeModuleDirs(root) {
  const out = [];
  const add = (rel) => fs.existsSync(path.join(root, rel, 'node_modules')) && out.push(path.join(rel, 'node_modules'));
  add('');
  for (const top of ['game', 'web', 'engine']) {
    const d = path.join(root, top);
    if (!fs.existsSync(d)) continue;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) add(path.join(top, e.name));
  }
  return out;
}

/**
 * Make the lane copy for an agent. Returns { dir, branch } or { error }. Any work an earlier agent left
 * on this task's branch is merged in (carry: false leaves it out: harness/lane-create.mjs merges chosen branches).
 */
export function createLaneCopy(agent, { task = null, lane = null, carry = true } = {}) {
  // A task id that isn't on the board (studio/NEXT.md or DONE.md) is refused before anything is made or written.
  if (task) {
    const known = taskOnBoard(task);
    if (known === false) return { error: `${task} is not on the board (studio/NEXT.md, studio/DONE.md): no lane copy made for it. Check the id (node harness/task.mjs next), or add the task first` };
  }
  const root = mainRoot();
  const sup = worktreeSupport(root);
  if (!sup.ok) return { error: sup.why };
  const dir = path.join(root, LANES_DIR, agent);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  const branch = `lane/${agent}-${stamp}`;
  if (fs.existsSync(dir) && removeLaneCopy(agent, { keepBranch: true, ifIdle: true }).kept) return { error: `${LANES_DIR}/${agent} is still in use; not replacing it` };
  fs.mkdirSync(path.join(root, LANES_DIR), { recursive: true });
  ignoreLanes(root);
  // A builder relaunched on a task (under any name) starts from the task's remembered lane branch when it holds work the
  // studio's branch lacks (merging it in afterwards could lose the commits on a conflict). STUDIO_LANE_START_FROM_PREV=off: start from the studio's branch.
  const startFrom = task && carry ? previousLaneStart(root, task) : null;
  const add = git(root, 'worktree', 'add', '--no-checkout', '-b', branch, dir, startFrom || 'HEAD');
  if (add.status !== 0) return { error: `git worktree add failed: ${(add.stderr || '').trim().split('\n').pop()}` };
  // The game's laneExclude (and STUDIO_LANE_EXCLUDE) are left out too, minus the task's declared scope
  // (harness/lane-sparse.mjs); off unless declared.
  const plan = sparsePlanSafe(root, task, lane);
  const steps = [
    ['config', 'extensions.worktreeConfig', 'true'],
    ['config', '--worktree', 'sparse.expectFilesOutsideOfPatterns', 'true'],
    ['sparse-checkout', 'set', '--no-cone', ...plan.patterns],
    ['checkout', '-q', branch],
  ];
  for (const s of steps) {
    const r = git(dir, ...s);
    if (r.status !== 0) {
      removeLaneCopy(agent);
      return { error: `git ${s.slice(0, 2).join(' ')} failed: ${(r.stderr || '').trim().split('\n').pop()}` };
    }
  }
  // The shared board and state, the settings, the installed packages.
  const linked = [linkDir(path.join(root, 'studio'), path.join(dir, 'studio')), linkDir(path.join(root, '.studio'), path.join(dir, '.studio'))];
  if (linked.includes(false)) {
    removeLaneCopy(agent);
    return { error: 'could not link studio/ and .studio/ into the lane copy' };
  }
  for (const rel of nodeModuleDirs(root)) if (!fs.existsSync(path.join(dir, rel))) linkDir(path.join(root, rel), path.join(dir, rel));
  try {
    // Without the keys only a harness proxy holds (agent-env.mjs PROXY_HELD: the Vertex key): a session, or a program it
    // runs that loads this .env, never reads them here.
    if (fs.existsSync(path.join(root, '.env'))) fs.writeFileSync(path.join(dir, '.env'), fs.readFileSync(path.join(root, '.env'), 'utf8').split(/(?<=\n)/).filter((l) => !PROXY_HELD.some((k) => new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=`, 'i').test(l))).join(''));
  } catch {}
  // The links are not changes: keep them out of this copy's git status.
  // What the main checkout has uncommitted now is not this session's work (harness/drift-baseline.mjs).
  writeLaneBaseline(agent, root);
  const exclude = path.join(root, '.studio', 'lanes', `${agent}.exclude`);
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.writeFileSync(exclude, ['/studio', '/.studio', '/.env', 'node_modules', ''].join('\n'));
  git(dir, 'config', '--worktree', 'core.excludesFile', exclude);
  // `npm run lane -- create <T-ID> --from <branch>...` merges the branches it was given instead (carry: false). A
  // previous lane that carries another open task's commits isn't merged (carryTaskBranchEx).
  const cx = task && carry ? carryTaskBranchEx(task, dir) : { carried: null, mixed: null };
  let carried = cx.carried;
  if (startFrom) {
    // The previous work is the start; bring the studio's branch in when it applies cleanly (a conflict is left for the
    // builder or the train: nothing is lost either way).
    const main = mainBranch(root);
    let note = '';
    if (git(dir, 'merge-base', '--is-ancestor', main, 'HEAD').status !== 0) {
      const m = git(dir, '-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local', 'merge', '--no-edit', main);
      if (m.status !== 0) { git(dir, 'merge', '--abort'); note = ` ${main} was not merged into it (conflict): merge it before task done`; }
    }
    carried = carried || startFrom;
    try { emitEvent({ type: 'lane.started_from_previous', agent, task, msg: `${agent}'s copy for ${task} starts from ${startFrom}, the task's earlier lane branch, not from ${main}.${note}`.slice(0, 400), meta: { from: startFrom, mainMerged: !note } }); } catch {}
  }
  if (plan.on) writeSparseRecord(root, agent, { agent, task, at: new Date().toISOString(), exclude: plan.exclude, keep: plan.keep, from: plan.from, patterns: plan.patterns, widened: [] });
  else removeSparseRecord(root, agent);
  emitEvent({ type: 'lane.copy', agent, task, msg: `${agent} works in its own copy (${LANES_DIR}/${agent}, branch ${branch})${carried ? `, with ${carried} merged in` : ''}${plan.on ? `; ${plan.why}` : ''}`.slice(0, 500), ...(plan.on ? { meta: { exclude: plan.exclude, keep: plan.keep } } : {}) });
  return { dir, branch, carried, mixed: cx.mixed, sparse: plan.on ? { exclude: plan.exclude, keep: plan.keep } : null };
}

/**
 * The branch a new copy for `task` starts from: the task's remembered lane branch, when it exists, holds commits the
 * studio's branch lacks, and isn't a mixed lane (those cherry-pick the task's own commits). null: the studio's branch.
 */
function previousLaneStart(root, task) {
  try {
    if (/^(off|0|false|no)$/i.test(String(process.env.STUDIO_LANE_START_FROM_PREV || '').trim())) return null;
    const prev = readBranches()[task];
    if (!prev || git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${prev}`).status !== 0 || unmerged(prev, root) <= 0) return null;
    if (launcherMixed(root, task, prev)) return null;
    return prev;
  } catch { return null; }
}

/** The sparse plan for a new lane copy; the plain patterns (all but studio/ and .studio/) if it can't be worked out. */
function sparsePlanSafe(root, task, lane) {
  try { return lanePlan({ root, task, lane }); } catch { return { on: false, patterns: ['/*', '!/studio/', '!/.studio/'] }; }
}

/**
 * Every write of .studio/lane-branches.json drops the keys of task ids the board doesn't have; their branches are kept.
 * Nothing is dropped when the board can't be read or lists no task. Returns the keys dropped.
 */
export function pruneUnknownTasks(b) {
  const ids = boardIds();
  if (!ids?.size) return [];
  const gone = Object.keys(b).filter((k) => { const id = k.split(':')[0]; return /^[A-Z]+-\d+$/.test(id) && !ids.has(id); });
  for (const k of gone) delete b[k];
  if (gone.length) emitEvent({ type: 'lane.branches_pruned', agent: process.env.STUDIO_LOCK_OWNER || null, msg: `.studio/lane-branches.json: dropped ${gone.length} key(s) for task ids not on the board (${gone.join(', ')}); their branches are kept`.slice(0, 400) });
  return gone;
}

/**
 * The task ids on the board: every task line ("- [ ] **T-123** ...") in studio/NEXT.md and studio/DONE.md, open or done;
 * null when neither can be read. Not read through task.mjs's parseNextQueue: task.mjs imports modules that import this
 * one, and a static import back would deadlock the CLIs that wait on a top-level await (heavy.mjs, game-gates.mjs).
 */
export function boardIds(root = mainRoot()) {
  const ids = new Set();
  let read = 0;
  for (const f of ['NEXT.md', 'DONE.md']) {
    let text;
    try { text = fs.readFileSync(path.join(root, 'studio', f), 'utf8'); read += 1; } catch { continue; }
    for (const m of text.matchAll(/^\s*[-*]\s+\[[ xX>~]\]\s+\*\*([A-Z]+-\d+)\*\*/gm)) ids.add(m[1]);
  }
  return read ? ids : null;
}

/** Is this task id on the board (open or done)? true / false, or null when the board can't be read. */
export function taskOnBoard(task) {
  const ids = boardIds();
  return ids ? ids.has(String(task)) : null;
}

/**
 * An earlier agent's unmerged work on this task comes with it: its branch is merged into this copy, and
 * this copy's branch becomes the task's branch. Returns the branch merged in, or null.
 */
export function carryTaskBranch(task, dir = REPO_ROOT) {
  return carryTaskBranchEx(task, dir).carried;
}

/**
 * carryTaskBranch with the launcher-side mixed-lane check. A branch whose own commits carry another OPEN task's
 * Studio-Task trailer (not this task, a declared --after dependency, or the task this one rescues: train-lanes.mjs
 * mixedLane / mayCarry, the train's rules) is NOT merged: the copy stays on the studio's branch plus this task's own
 * commits from it (cherry-picked, in order), and a lane.mixed_skipped event says so. STUDIO_TRAIN_MIXED=off turns the
 * check off (as for the train). Returns { carried, mixed: null | { branch, why, foreign,
 * picked, left, line } }.
 */
export function carryTaskBranchEx(task, dir = REPO_ROOT) {
  const root = mainRoot();
  const mine = git(dir, 'symbolic-ref', '--short', 'HEAD').stdout?.trim();
  const b = readBranches();
  const prev = b[task];
  let carried = null;
  let mixed = null;
  if (prev && prev !== mine && git(root, 'rev-parse', '--verify', '--quiet', prev).status === 0 && unmerged(prev, root) > 0) {
    mixed = launcherMixed(root, task, prev);
    if (mixed) {
      const lines = pickOwn(dir, root, task, prev);
      mixed = { ...mixed, ...lines };
      mixed.line = `${mixed.line}${lines.picked ? ` Started from ${mainBranch(root)} plus ${lines.picked} of ${task}'s own commit(s) from it.` : ` Started from ${mainBranch(root)}.`}${lines.left ? ` ${lines.left} commit(s) of it carry no Studio-Task: ${task} and were left (still on ${prev}).` : ''}`;
      try { emitEvent({ type: 'lane.mixed_skipped', agent: process.env.STUDIO_LOCK_OWNER || null, task, status: 'warn', msg: mixed.line.slice(0, 600), meta: { branch: prev, foreign: mixed.foreign.map((f) => ({ task: f.task, commits: f.commits.map((c) => c.sha) })), picked: lines.picked, left: lines.left } }); } catch {}
    } else {
      const m = git(dir, '-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local', 'merge', '--no-edit', prev);
      if (m.status === 0) {
        carried = prev;
        b[`${task}:carried`] = [...new Set([...(b[`${task}:carried`] || []), prev])];
      } else git(dir, 'merge', '--abort');
    }
  }
  // Also the lane branch holding the contents the task's owner approval was signed for, when it isn't the previous lane
  // (harness/lane-approvals.mjs). A conflict leaves the copy as it was, with an event saying so.
  const ap = approvedBranchFor(root, task, { dir, main: mainBranch(root) });
  if (ap) {
    const m = git(dir, '-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local', 'merge', '--no-edit', ap.branch);
    if (m.status === 0) {
      carried = carried ? `${carried}, ${ap.branch}` : ap.branch;
      b[`${task}:carried`] = [...new Set([...(b[`${task}:carried`] || []), ap.branch])];
      emitEvent({ type: 'lane.approval_carried', task, msg: `${task}: merged ${ap.branch} into the new copy: it holds the contents ${ap.approval} was signed for`, meta: { branch: ap.branch, head: ap.head, approval: ap.approval } });
    } else {
      git(dir, 'merge', '--abort');
      emitEvent({ type: 'lane.approval_carried', task, status: 'warn', msg: `${task}: ${ap.branch} holds the contents ${ap.approval} was signed for, but it doesn't merge into the new copy cleanly; merge it by hand`, meta: { branch: ap.branch, head: ap.head, approval: ap.approval, conflict: true } });
    }
  }
  if (mine) {
    b[task] = mine;
    writeBranches(b);
  }
  return { carried, mixed };
}

/** The launcher's mixed-lane judgement of `branch` for `task` (null: fine, or the check is off). Never throws. */
function launcherMixed(root, task, branch) {
  try {
    if (/^(off|0|false|no)$/i.test(process.env.STUDIO_TRAIN_MIXED || '')) return null;
    const st = boardStates(root) || { open: new Set(), done: new Set() };
    const allowed = mayCarry(root, task, readDeps(root));
    const tip = git(root, 'rev-parse', `refs/heads/${mainBranch(root)}`).stdout?.trim();
    const head = git(root, 'rev-parse', `${branch}^{commit}`).stdout?.trim();
    const m = mixedLane(root, { task, tip, head, open: (t) => st.open.has(t) && !allowed.has(t) });
    if (!m.mixed) return null;
    const shown = m.foreign.map((f) => `${f.task} (${f.commits.length} commit(s))`).join(', ');
    return { branch, why: m.why, foreign: m.foreign, tip, head, line: `Did not merge ${branch} into your copy: it carries commits of another open task (${shown}), and a lane trains only its own task's commits.` };
  } catch { return null; }
}

/** Cherry-pick the branch's commits tagged Studio-Task: <task> (oldest first) into dir. { picked, left }. */
function pickOwn(dir, root, task, branch) {
  const r = git(root, 'log', '--no-merges', '--reverse', '--right-only', '--cherry-pick', '--format=%x1e%H%x09%(trailers:key=Studio-Task,valueonly,separator=%x2C)', `${mainBranch(root)}...${branch}`);
  let picked = 0; let left = 0;
  if (r.status !== 0) return { picked, left };
  let stop = false;
  for (const blk of String(r.stdout).split('\x1e').filter((x) => x.trim())) {
    const [sha, tags = ''] = blk.trim().split('\t');
    if (!tags.split(/[,\s]+/).includes(task)) { if (!tags.split(/[,\s]+/).some((x) => /^[A-Z]+-\d+$/.test(x))) left += 1; continue; }
    if (stop) continue;
    const c = git(dir, '-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local', 'cherry-pick', '--allow-empty', sha);
    if (c.status === 0) picked += 1;
    else { git(dir, 'cherry-pick', '--abort'); stop = true; left += 1; }
  }
  return { picked, left };
}

/** Remember which branch holds a task's unmerged work (the launcher, when a session ends). */
export function rememberTaskBranch(task, branch) {
  const b = readBranches();
  b[task] = branch;
  writeBranches(b);
}

/** Commits on the lane branch that the studio's branch doesn't have yet. */
export function unmerged(branch, root = mainRoot()) {
  const r = git(root, 'rev-list', '--count', `${mainBranch(root)}..${branch}`);
  return r.status === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

/**
 * Is someone still working in this lane copy? A builder launched outside the harness has no session record, so "no
 * running session" is not proof it is gone (preflight --fix must not delete a live copy). Live when a process has its
 * working folder inside the copy, the agent holds a claim renewed in the last STUDIO_LANE_LIVE_MIN minutes (20), or the
 * copy's git index or folder changed that recently.
 */
export function laneLive(agent, root = mainRoot()) {
  const dir = path.join(root, LANES_DIR, agent);
  if (!fs.existsSync(dir)) return { live: false };
  const win = Number(process.env.STUDIO_LANE_LIVE_MIN || 20) * 60000;
  const now = Date.now();
  try {
    if (process.platform === 'linux') {
      const real = fs.realpathSync(dir);
      for (const pid of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
        let cwd = '';
        try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { continue; }
        if (cwd === real || cwd.startsWith(`${real}/`)) return { live: true, why: `process ${pid} is working in it` };
      }
    }
  } catch {}
  try {
    const held = listLocks().filter((l) => l.owner === agent && Date.parse(l.expiresAt) > now && now - Date.parse(l.renewedAt || l.claimedAt) < win);
    if (held.length) return { live: true, why: `${agent} holds ${held[0].key}, renewed ${Math.round((now - Date.parse(held[0].renewedAt || held[0].claimedAt)) / 60000)} min ago` };
  } catch {}
  try {
    // Only a lane's own index (a leftover folder's git would read the main checkout's).
    const idx = fs.existsSync(path.join(dir, '.git')) ? git(dir, 'rev-parse', '--git-path', 'index').stdout?.trim() : '';
    const times = [fs.statSync(dir).mtimeMs, idx ? fs.statSync(path.resolve(dir, idx)).mtimeMs : 0];
    const t = Math.max(...times);
    if (now - t < win) return { live: true, why: `changed ${Math.round((now - t) / 60000)} min ago` };
  } catch {}
  return { live: false };
}

/** Remove an agent's copy; its branch goes too once merged, unless keepBranch. ifIdle: keep a live copy. */
export function removeLaneCopy(agent, { keepBranch = false, ifIdle = false } = {}) {
  const root = mainRoot();
  const dir = path.join(root, LANES_DIR, agent);
  if (ifIdle) {
    const l = laneLive(agent, root);
    if (l.live) {
      emitEvent({ type: 'lane.kept', agent, msg: `Kept ${agent}'s lane copy: ${l.why}` });
      return { kept: true, why: l.why };
    }
  }
  // A leftover folder (no worktree) has no branch of its own: git there would name main's.
  const branch = fs.existsSync(dir) && isLaneWorktree(dir, root) ? git(dir, 'symbolic-ref', '--short', 'HEAD').stdout?.trim() : null;
  // Unlink the shared folders first so nothing can follow them while the copy is removed.
  for (const rel of ['studio', '.studio', ...nodeModuleDirs(root)]) {
    const p = path.join(dir, rel);
    try {
      if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
    } catch {}
  }
  git(root, 'worktree', 'remove', '--force', dir);
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  git(root, 'worktree', 'prune');
  if (branch && !keepBranch && unmerged(branch, root) === 0) git(root, 'branch', '-D', branch);
  try {
    fs.rmSync(path.join(root, '.studio', 'lanes', `${agent}.exclude`), { force: true });
  } catch {}
  removeSparseRecord(root, agent);
  return { branch };
}

/** Task start in a lane copy: catch up with the studio's branch when this copy has nothing of its own. */
export function catchUp() {
  if (!inLaneCopy()) return null;
  const main = mainBranch();
  const dirty = (git(REPO_ROOT, 'status', '--porcelain').stdout || '').trim();
  if (dirty) return { ok: false, why: 'uncommitted work in this copy' };
  const r = git(REPO_ROOT, 'merge', '--ff-only', main);
  return r.status === 0 ? { ok: true } : { ok: false, why: 'this copy has its own commits; they reach the studio at task done' };
}

/** What this lane copy changed against the studio's branch: { base, head, changed }. */
export function laneDiff() {
  if (!inLaneCopy()) return null;
  const main = mainBranch(mainRoot());
  const base = git(REPO_ROOT, 'merge-base', 'HEAD', main).stdout.trim();
  const head = git(REPO_ROOT, 'rev-parse', 'HEAD').stdout.trim();
  return { base, head, changed: changedSince(REPO_ROOT, base, head) };
}

/**
 * Uncommitted work in a lane copy, as task done judges it: { dirty: porcelain lines, eol: line-ending-only files }.
 * Engine cache files (.godot/, *.import, *.uid) that every headless Godot run rewrites don't count, nor does a tracked
 * file that differs only in line endings (deliver sets it aside with the engine cache); phantom files (eol-only.mjs
 * splitPhantom) are left out too and returned as `phantom` (paths), for the caller's one note. Shared with the merge
 * train's lane check (harness/train.mjs). Never trim() before slice(3): it eats the first letter of the first path.
 */
export function laneDirty(dir = REPO_ROOT) {
  const dirtyAll = (git(dir, 'status', '--porcelain').stdout || '').split('\n').filter((l) => l.length > 3)
    .filter((l) => !/(^|\/)\.godot\/|\.import$|\.(uid|tmp)$|(^|\/)\.import\//.test(l.slice(3).replace(/^"|"$/g, '')));
  const { real, eol } = splitEolOnly(dir, dirtyAll);
  // A file git reports as modified whose bytes are the committed blob (a filter rule, Git LFS) is no work.
  const ph = splitPhantom(dir, real);
  return { dirty: ph.real, eol, phantom: ph.phantom };
}

/** A task's lane branch (and the earlier agents' branches it carried) are in the studio's branch now: forget them. */
export function forgetLanded(taskId, branch, root = mainRoot()) {
  const b = readBranches();
  for (const old of b[`${taskId}:carried`] || []) git(root, 'branch', '-D', old);
  delete b[`${taskId}:carried`];
  if (b[taskId] === branch) delete b[taskId];
  writeBranches(b);
}

/**
 * Task done in a lane copy: the work must be committed; it is rebased on the studio's branch and then the studio's
 * branch fast-forwards to it. Returns null when not in a lane copy, { ok: true, merged } or { ok: false, message }.
 *
 * After a clean rebase the checks re-run only when the incoming changes touch this lane's gate scope (recorded by task
 * done in .studio/gate-pass/<task>.json); otherwise the earlier pass is reused. Re-runs are path-scoped too
 * (STUDIO_GATE_CHANGED). Only the final "did the branch move?" check, the fast-forward and onLanded (the board write)
 * hold the short land lock, so tracks land in parallel. STUDIO_LAND_TRIES (6) bounds the rebase attempts.
 */
export function deliver(taskId, { runChecks = true, onLanded = null } = {}) {
  if (!inLaneCopy()) return null;
  const root = mainRoot();
  const main = mainBranch(root);
  // Files written into paths a sparse lane left out are hidden from git; widen over them first.
  try { widenStrays({ dir: REPO_ROOT, root, log: (m) => console.warn(m) }); } catch {}
  const { dirty, eol, phantom } = laneDirty(REPO_ROOT);
  if (phantom.length) console.warn(`[task done] note: ${phantomNote(phantom)}`);
  if (eol.length) {
    console.warn(`[task done] note: ${eolNote(eol)}`);
    emitEvent({ type: 'task.eol_ignored', agent: process.env.STUDIO_LOCK_OWNER || null, task: taskId, status: 'warn', msg: `${taskId}: ${eolNote(eol)}`.slice(0, 400) });
  }
  if (dirty.length) return { ok: false, message: `Commit your work first: ${dirty.length} uncommitted file(s) in your copy (${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}). Only committed work reaches the studio. Then run task done again.` };
  // Tracked engine cache files the gates just rewrote would stop the rebase ("unstaged changes"): set them
  // aside in a named stash (recoverable with git stash list / pop; nothing is deleted).
  const churn = (git(REPO_ROOT, 'status', '--porcelain', '--untracked-files=no').stdout || '').split('\n').filter((l) => l.length > 3).map((l) => l.slice(3).replace(/^"|"$/g, ''));
  if (churn.length) {
    git(REPO_ROOT, '-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local', 'stash', 'push', '-m', `studio land ${taskId}: engine cache set aside`, '--', ...churn);
    emitEvent({ type: 'land.stashed', agent: process.env.STUDIO_LOCK_OWNER || null, task: taskId, msg: `${taskId}: ${churn.length} engine cache or line-ending-only file(s) set aside before landing (git stash list)` });
  }
  const branch = git(REPO_ROOT, 'symbolic-ref', '--short', 'HEAD').stdout.trim();
  const tries = Number(process.env.STUDIO_LAND_TRIES || 6);
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const before = git(REPO_ROOT, 'merge-base', 'HEAD', main).stdout.trim();
    const tip = git(root, 'rev-parse', main).stdout.trim();
    if (before !== tip) {
      const preHead = git(REPO_ROOT, 'rev-parse', 'HEAD').stdout.trim();
      const rb = git(REPO_ROOT, '-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local', 'rebase', main);
      if (rb.status !== 0) {
        git(REPO_ROOT, 'rebase', '--abort');
        return { ok: false, message: `The studio's branch (${main}) changed files you changed too. Merge it into your copy (git merge ${main}), resolve the conflicts, commit, run npm run verify, then task done again.` };
      }
      // A commit whose hook stamp was valid before this rebase and isn't after it is re-committed through the real hooks
      // (harness/hook-stamp.mjs restamp --auto), never stamped by hand; if the hooks refuse it, it doesn't land.
      const rs = restampAfterRebase(taskId, { tip, before, preHead });
      if (!rs.ok) return { ok: false, message: rs.message };
      const head = git(REPO_ROOT, 'rev-parse', 'HEAD').stdout.trim();
      if (runChecks) {
        const incoming = changedSince(REPO_ROOT, before, tip);
        const rec = readPass(root, taskId);
        const reuse = canReuse(rec, { head: preHead, incoming });
        if (reuse.ok) {
          recordPass(root, taskId, { ...rec, head, base: tip, reusedFrom: preHead });
          emitEvent({ type: 'gates.reused', agent: process.env.STUDIO_LOCK_OWNER || null, task: taskId, msg: `${taskId}: rebased on ${main}; checks not re-run: ${reuse.why}` });
          console.log(`[deliver] ${taskId}: checks reused after rebase: ${reuse.why}`);
        } else {
          const changed = changedSince(REPO_ROOT, tip, head);
          console.log(`[deliver] ${taskId}: checks re-run after rebase: ${reuse.why}`);
          // With the lane's pass recorded for its pre-rebase commit, only the game checks whose inputs main changed run again.
          const env = { ...process.env, ...(changed.length ? { STUDIO_GATE_CHANGED: changed.join(','), STUDIO_GATE_PATHS: process.env.STUDIO_GATE_PATHS || changed.join(',') } : {}), ...landingRecheckEnv(root, taskId, rec, { preHead, incoming }) };
          const g = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'run-gates.mjs')], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
          if (g.status !== 0) {
            const red = [...new Set((g.stdout.match(/FAIL\s+(\S+)/g) || []).map((x) => x.split(/\s+/)[1]))].slice(0, 4).join(', ');
            return { ok: false, message: `Your work was rebased on the latest ${main}, and the checks now fail${red ? ` (${red})` : ''}. Fix it in your copy, commit, run npm run verify, then task done again.` };
          }
          if (rec) recordPass(root, taskId, { ...rec, head, base: tip });
        }
      }
    }
    let res;
    try {
      res = withLandLock(root, () => {
        // Under the lock: if the branch moved while the checks ran, go round again (rebase, scope check).
        const nowTip = git(root, 'rev-parse', main).stdout.trim();
        const base = git(REPO_ROOT, 'merge-base', 'HEAD', main).stdout.trim();
        if (base !== nowTip) return { retry: true };
        if (unmerged(branch, root) === 0) {
          onLanded?.();
          return { ok: true, merged: 0 };
        }
        // The merge runs in a dedicated merge worktree and the branch ref moves by compare-and-swap; the main checkout's
        // index is only touched to bring its files up to date afterwards.
        const ff = landFastForward(root, main, branch, { taskId });
        if (!ff.ok) return { ok: false, message: ff.message };
        const n = Number(git(root, 'rev-list', '--count', `${base}..${branch}`).stdout.trim()) || 0;
        onLanded?.();
        return { ok: true, merged: n };
      });
    } catch (err) {
      if (err.code === 'LAND_BUSY') return { ok: false, message: `Another landing held the land lock too long (${err.message}). Run task done again.` };
      throw err;
    }
    if (res.retry) continue;
    if (!res.ok || !res.merged) return res;
    forgetLanded(taskId, branch, root);
    if (res.merged) emitEvent({ type: 'lane.merged', agent: process.env.STUDIO_LOCK_OWNER || null, task: taskId, msg: `${taskId}: ${branch} added to ${main}` });
    return res;
  }
  return { ok: false, message: `${main} kept moving while ${taskId} was landing (${tries} tries). Run task done again.` };
}

/**
 * After deliver's rebase, re-commit through the hooks the lane commits whose stamps the rebase made stale
 * (only when every stamp was valid before it). STUDIO_HOOKS_RESTAMP=off skips it (the hooks gate then lists them).
 * Returns { ok, message, replayed }.
 */
export function restampAfterRebase(taskId, { tip, before, preHead }) {
  if (/^(off|0|false|no)$/i.test(process.env.STUDIO_HOOKS_RESTAMP || '')) return { ok: true, replayed: 0 };
  const script = path.join(REPO_ROOT, 'harness', 'hook-stamp.mjs');
  if (!fs.existsSync(script)) return { ok: true, replayed: 0 };
  const r = spawnSync(process.execPath, [script, 'restamp', '--auto', '--json', '--base', tip, '--was', preHead, '--was-base', before], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
  let j = null;
  try { j = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch {}
  if (j?.ok) {
    if (j.replayed) {
      console.log(`[deliver] ${taskId}: ${j.why} after the rebase (their stamps no longer matched)`);
      emitEvent({ type: 'hooks.restamped', agent: process.env.STUDIO_LOCK_OWNER || null, task: taskId, msg: `${taskId}: ${j.why} after task done's rebase` });
    }
    return { ok: true, replayed: j.replayed || 0 };
  }
  const why = j?.why || `${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ') || `exit ${r.status}`}`;
  return { ok: false, message: `Your work was rebased on the latest studio branch, and its commits' hook stamps no longer match, so they were re-committed through the hooks, which failed: ${why}. Fix it in your copy and commit (or npm run hooks -- restamp), then task done again.` };
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const MERGE_WT = '.studio/merge-wt';

/** The dedicated merge worktree (detached, no checkout: its own HEAD and index, no files). */
export function mergeWorktree(root = mainRoot()) {
  const dir = path.join(root, MERGE_WT);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    git(root, 'worktree', 'prune');
    const r = git(root, 'worktree', 'add', '--detach', '--no-checkout', dir, 'HEAD');
    if (r.status !== 0) return { ok: false, why: (r.stderr || r.stdout || '').trim().split('\n').pop() };
  }
  return { ok: true, dir };
}

/**
 * Land a lane branch on the studio's branch without the main checkout's index (a `git merge --ff-only` run inside the
 * main checkout fails on its uncommitted files, untracked files and index.lock).
 *   1. in the merge worktree, `git merge-tree --write-tree` proves the result is exactly the lane's tree (a
 *      fast-forward), touching no one's index;
 *   2. the main checkout's own uncommitted edits to files the lane changed are kept in a named stash (never
 *      lost; STUDIO_LAND_STASH=off refuses instead);
 *   3. `git update-ref` moves the branch from old to new only if it still points at old (compare-and-swap);
 *   4. the main checkout's index and files follow (`read-tree -m -u old new`, index.lock retries); if they
 *      can't, the ref is swapped back and the landing reports why.
 * Returns { ok, merged, stashed } or { ok: false, message }.
 */
export function landFastForward(root, main, branch, { taskId = '' } = {}) {
  const rev = (r) => git(root, 'rev-parse', '--verify', `${r}^{commit}`).stdout.trim();
  const oldTip = rev(`refs/heads/${main}`);
  const neu = rev(branch);
  if (!oldTip || !neu) return { ok: false, message: `Couldn't read ${main} or ${branch}. Run task done again.` };
  if (oldTip === neu) return { ok: true, merged: 0 };
  if (git(root, 'merge-base', '--is-ancestor', oldTip, neu).status !== 0) return { ok: false, message: `${branch} is not ahead of ${main} (the studio's branch moved). Run task done again (it rebases).` };
  const mw = mergeWorktree(root);
  if (mw.ok) {
    const t = git(mw.dir, 'merge-tree', '--write-tree', oldTip, neu);
    const want = git(root, 'rev-parse', `${neu}^{tree}`).stdout.trim();
    if (t.status === 0 && t.stdout.trim().split('\n')[0] !== want) return { ok: false, message: `The merge worktree's result for ${branch} differs from its own tree; run task done again.` };
  }
  const headRef = git(root, 'symbolic-ref', '-q', 'HEAD').stdout.trim();
  const checkedOut = headRef === `refs/heads/${main}`;
  let stashed = null;
  if (checkedOut) {
    const incoming = new Set(changedSince(root, oldTip, neu));
    const dirty = (git(root, 'status', '--porcelain', '--untracked-files=all').stdout || '').split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''));
    const overlap = dirty.filter((f) => incoming.has(f));
    if (overlap.length) {
      if (/^(off|0|false|no)$/i.test(process.env.STUDIO_LAND_STASH || '')) return { ok: false, message: `The main checkout has uncommitted edits to ${overlap.length} file(s) this landing changes (${overlap.slice(0, 3).join(', ')}). Commit or stash them there, then run task done again.` };
      const msg = `studio land ${taskId || branch}: main checkout's own edits to ${overlap.slice(0, 3).join(', ')}${overlap.length > 3 ? ` +${overlap.length - 3}` : ''}`;
      let st = null;
      for (let i = 0; i < 20; i += 1) {
        st = git(root, '-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local', 'stash', 'push', '--include-untracked', '-m', msg, '--', ...overlap);
        if (st.status === 0 || !/index\.lock/.test(st.stderr || '')) break;
        sleepMs(500);
      }
      if (st.status !== 0) return { ok: false, message: `The main checkout has uncommitted edits to ${overlap.slice(0, 3).join(', ')} and they couldn't be set aside (${(st.stderr || '').trim().split('\n').pop()}). Run task done again.` };
      stashed = { files: overlap, message: msg };
      emitEvent({ type: 'land.stashed', agent: process.env.STUDIO_LOCK_OWNER || 'launcher', to: 'human', task: taskId || undefined, status: 'warn', msg: `${taskId || branch} landed over uncommitted edits in the main checkout; they are kept in git stash "${msg}" (git stash list)`, meta: { files: overlap } });
    }
  }
  const up = git(root, 'update-ref', '-m', `studio land ${taskId || branch}`, `refs/heads/${main}`, neu, oldTip);
  if (up.status !== 0) return { ok: false, message: `${main} moved while ${taskId || branch} was landing. Run task done again (it rebases).` };
  if (checkedOut) {
    let rt = null;
    for (let i = 0; i < Number(process.env.STUDIO_LAND_SYNC_TRIES || 20); i += 1) {
      rt = git(root, 'read-tree', '-m', '-u', oldTip, neu);
      if (rt.status === 0 || !/index\.lock/.test(`${rt.stderr}`)) break;
      sleepMs(500);
    }
    if (rt.status !== 0) {
      git(root, 'update-ref', '-m', `studio land ${taskId || branch}: undone`, `refs/heads/${main}`, oldTip, neu);
      const why = (rt.stderr || rt.stdout || '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
      return { ok: false, message: `${taskId || branch} reached ${main}, but the main checkout couldn't follow (${why}), so it was undone. Run task done again; if it repeats, ask the Producer.${stashed ? ` Edits set aside: git stash "${stashed.message}".` : ''}` };
    }
  }
  return { ok: true, stashed };
}

/**
 * The registered worktrees of this repo (git worktree list --porcelain), resolved. `has(dir)`: dir is one of them AND
 * has its own .git file. A folder in .lanes/ that isn't (an emptied lane folder, a pruned copy) is no lane: git run
 * inside it walks up to the main checkout and answers for main, so nothing runs git there.
 */
export function laneWorktrees(root = mainRoot()) {
  const norm = (p) => { let r = path.resolve(p); try { r = fs.realpathSync.native(r); } catch {} return process.platform === 'win32' ? r.toLowerCase() : r; };
  const list = (git(root, 'worktree', 'list', '--porcelain').stdout || '').split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => norm(l.slice(9).trim()));
  return { list, has: (dir) => fs.existsSync(path.join(dir, '.git')) && list.includes(norm(dir)) };
}
export const isLaneWorktree = (dir, root = mainRoot()) => laneWorktrees(root).has(dir);

/** Folders in .lanes/ that are not lanes (no registered worktree): [{ name, dir }]. Never touched here. */
export function leftoverLaneFolders(root = mainRoot()) {
  const d = path.join(root, LANES_DIR);
  if (!fs.existsSync(d)) return [];
  const wt = laneWorktrees(root);
  return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !wt.has(path.join(d, e.name))).map((e) => ({ name: e.name, dir: path.join(d, e.name) }));
}

/** Lane copies on disk, for the War Room and preflight: registered worktrees only (leftoverLaneFolders). */
export function laneCopies(root = mainRoot(), { progress = null } = {}) {
  const d = path.join(root, LANES_DIR);
  if (!fs.existsSync(d)) return [];
  const wt = laneWorktrees(root);
  // A merge train's scratch copy (.lanes/_train-<id>, harness/train.mjs) is no agent's: the train removes it.
  const names = fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_train-') && wt.has(path.join(d, e.name)));
  let n = 0;
  return names.map((e) => {
    // Three git processes per copy: say so while a hundred of them take minutes.
    if (progress && (n++ % 10 === 0)) progress(`reading lane copies ${n}/${names.length}…`);
    const dir = path.join(d, e.name);
    const branch = git(dir, 'symbolic-ref', '--short', 'HEAD').stdout?.trim() || null;
    return { agent: e.name, dir, branch, unmerged: branch ? unmerged(branch, root) : 0, dirty: Boolean((git(dir, 'status', '--porcelain').stdout || '').trim()) };
  });
}

// ---- the cheap lane listing: git's own metadata files, no git process per copy ------------------------

/** The repository's common git dir (<root>/.git, or what a `.git` file in a linked checkout points at), or null. */
function commonGitDir(root) {
  const g = path.join(root, '.git');
  let st; try { st = fs.statSync(g); } catch { return null; }
  if (st.isDirectory()) return g;
  try {
    const m = fs.readFileSync(g, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) return null;
    const gd = path.resolve(root, m[1]);
    let cd = '';
    try { cd = fs.readFileSync(path.join(gd, 'commondir'), 'utf8').trim(); } catch {}
    return cd ? path.resolve(gd, cd) : gd;
  } catch { return null; }
}

/** A ref's commit, read from the loose ref file or packed-refs (no git process), or ''. */
export function refSha(root, ref) {
  const cg = commonGitDir(root);
  if (!cg) return '';
  try { const s = fs.readFileSync(path.join(cg, ...ref.split('/')), 'utf8').trim(); if (/^[0-9a-f]{40,64}$/.test(s)) return s; } catch {}
  try {
    for (const l of fs.readFileSync(path.join(cg, 'packed-refs'), 'utf8').split(/\r?\n/)) {
      const m = l.match(/^([0-9a-f]{40,64}) (.+)$/);
      if (m && m[2] === ref) return m[1];
    }
  } catch {}
  return '';
}

/** The studio branch's name from the main checkout's HEAD file, or ''. */
export function mainBranchCheap(root = mainRoot()) {
  try { const m = fs.readFileSync(path.join(root, '.git'), 'utf8').match(/^gitdir:\s*(.+?)\s*$/m); const head = m ? path.join(path.resolve(root, m[1]), 'HEAD') : path.join(root, '.git', 'HEAD'); return (fs.readFileSync(head, 'utf8').match(/^ref:\s*refs\/heads\/(.+?)\s*$/m) || [])[1] || ''; } catch { return ''; }
}

/**
 * Lane copies from <git dir>/worktrees/<id>/{gitdir,HEAD} and the folders under .lanes (no git process per copy):
 * [{ agent, dir, branch, head }]. Train scratch copies and folders that are not registered worktrees are left out,
 * as laneCopies does. Ahead and dirty are not known here (that is what costs a process each).
 */
export function cheapLaneCopies(root = mainRoot()) {
  const d = path.join(root, LANES_DIR);
  const cg = commonGitDir(root);
  if (!cg || !fs.existsSync(d)) return [];
  const norm = (p) => { let r = path.resolve(p); try { r = fs.realpathSync.native(r); } catch {} return process.platform === 'win32' ? r.toLowerCase() : r; };
  const byDir = new Map();
  let ids = []; try { ids = fs.readdirSync(path.join(cg, 'worktrees')); } catch {}
  for (const id of ids) {
    try {
      const gd = fs.readFileSync(path.join(cg, 'worktrees', id, 'gitdir'), 'utf8').trim();
      const ref = (fs.readFileSync(path.join(cg, 'worktrees', id, 'HEAD'), 'utf8').match(/^ref:\s*refs\/heads\/(.+?)\s*$/m) || [])[1] || null;
      byDir.set(norm(path.dirname(gd)), { branch: ref, headFile: fs.readFileSync(path.join(cg, 'worktrees', id, 'HEAD'), 'utf8').trim() });
    } catch {}
  }
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('_train-')) continue;
    const dir = path.join(d, e.name);
    const w = byDir.get(norm(dir));
    if (!w || !fs.existsSync(path.join(dir, '.git'))) continue;
    out.push({ agent: e.name, dir, branch: w.branch, head: w.branch ? refSha(root, `refs/heads/${w.branch}`) : (/^[0-9a-f]{40,64}$/.test(w.headFile) ? w.headFile : '') });
  }
  return out;
}
