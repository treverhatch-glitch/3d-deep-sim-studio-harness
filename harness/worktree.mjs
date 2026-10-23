/**
 * harness/worktree.mjs — one working copy per lane (2.29).
 *
 * Test #3's top problem: builders shared one checkout, so one builder's half-done edits leaked into
 * another's tests and commits. Now an agent the launcher starts with a code lane works in its own git
 * worktree, `.lanes/<agent>/`, on its own branch, and its finished work reaches the studio's branch only
 * through `task done`, after its checks pass.
 *
 * What stays shared: `studio/` (the board, handoffs, the Bible) and `.studio/` (locks, events, sessions)
 * are links to the main checkout's, so every agent sees one board and one set of claims. `studio/` is left
 * and `.studio/` are left out of the worktree's own checkout (sparse checkout), so the link never shows as a change. `.env` is
 * copied and `node_modules` folders are linked.
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
import { listLocks } from './lock.mjs';

export const LANES_DIR = '.lanes';
const BRANCHES = () => path.join(STUDIO_STATE_DIR, 'lane-branches.json');
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** The main checkout: this one, or the one a lane copy was made from. */
// 2.30n: a lane copy lives at <main>/.lanes/<agent>; that path names the main checkout even when the
// shell lost STUDIO_MAIN_ROOT (a shared tool gateway in the Marina run), so done never skips the merge.
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

const mainBranch = (root = mainRoot()) => git(root, 'symbolic-ref', '--short', 'HEAD').stdout.trim();

function readBranches() {
  try {
    return JSON.parse(fs.readFileSync(BRANCHES(), 'utf8'));
  } catch {
    return {};
  }
}
function writeBranches(b) {
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
function linkDir(target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

/** node_modules folders worth linking: the root's, hub/'s, and one level into game/, web/, engine/. */
function nodeModuleDirs(root) {
  const out = [];
  const add = (rel) => fs.existsSync(path.join(root, rel, 'node_modules')) && out.push(path.join(rel, 'node_modules'));
  add('');
  add('hub');
  for (const top of ['game', 'web', 'engine']) {
    const d = path.join(root, top);
    if (!fs.existsSync(d)) continue;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) add(path.join(top, e.name));
  }
  return out;
}

/**
 * Make the lane copy for an agent. Returns { dir, branch } or { error }. Any work an earlier agent left
 * on this task's branch is merged in.
 */
export function createLaneCopy(agent, { task = null } = {}) {
  const root = mainRoot();
  const sup = worktreeSupport(root);
  if (!sup.ok) return { error: sup.why };
  const dir = path.join(root, LANES_DIR, agent);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  const branch = `lane/${agent}-${stamp}`;
  if (fs.existsSync(dir) && removeLaneCopy(agent, { keepBranch: true, ifIdle: true }).kept) return { error: `${LANES_DIR}/${agent} is still in use; not replacing it` };
  fs.mkdirSync(path.join(root, LANES_DIR), { recursive: true });
  ignoreLanes(root);
  const add = git(root, 'worktree', 'add', '--no-checkout', '-b', branch, dir, 'HEAD');
  if (add.status !== 0) return { error: `git worktree add failed: ${(add.stderr || '').trim().split('\n').pop()}` };
  const steps = [
    ['config', 'extensions.worktreeConfig', 'true'],
    ['config', '--worktree', 'sparse.expectFilesOutsideOfPatterns', 'true'],
    ['sparse-checkout', 'set', '--no-cone', '/*', '!/studio/', '!/.studio/'],
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
    if (fs.existsSync(path.join(root, '.env'))) fs.copyFileSync(path.join(root, '.env'), path.join(dir, '.env'));
  } catch {}
  // The links are not changes: keep them out of this copy's git status.
  const exclude = path.join(root, '.studio', 'lanes', `${agent}.exclude`);
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.writeFileSync(exclude, ['/studio', '/.studio', '/.env', 'node_modules', ''].join('\n'));
  git(dir, 'config', '--worktree', 'core.excludesFile', exclude);
  const carried = task ? carryTaskBranch(task, dir) : null;
  emitEvent({ type: 'lane.copy', agent, task, msg: `${agent} works in its own copy (${LANES_DIR}/${agent}, branch ${branch})${carried ? `, with ${carried} merged in` : ''}` });
  return { dir, branch, carried };
}

/**
 * An earlier agent's unmerged work on this task comes with it: its branch is merged into this copy, and
 * this copy's branch becomes the task's branch. Returns the branch merged in, or null.
 */
export function carryTaskBranch(task, dir = REPO_ROOT) {
  const root = mainRoot();
  const mine = git(dir, 'symbolic-ref', '--short', 'HEAD').stdout?.trim();
  const b = readBranches();
  const prev = b[task];
  let carried = null;
  if (prev && prev !== mine && git(root, 'rev-parse', '--verify', '--quiet', prev).status === 0 && unmerged(prev, root) > 0) {
    const m = git(dir, '-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local', 'merge', '--no-edit', prev);
    if (m.status === 0) {
      carried = prev;
      b[`${task}:carried`] = [...new Set([...(b[`${task}:carried`] || []), prev])];
    } else git(dir, 'merge', '--abort');
  }
  if (mine) {
    b[task] = mine;
    writeBranches(b);
  }
  return carried;
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
 * 2.30n: is someone still working in this lane copy? A builder launched outside the harness has no
 * session record, so "no running session" is not proof it is gone (T-024 in the Marina run: preflight
 * --fix deleted a live builder's copy mid-task). Live when a process has its working folder inside the
 * copy, the agent holds a claim renewed in the last STUDIO_LANE_LIVE_MIN minutes (20), or the copy's git
 * index or folder changed that recently.
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
    const idx = git(dir, 'rev-parse', '--git-path', 'index').stdout?.trim();
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
  const branch = fs.existsSync(dir) ? git(dir, 'symbolic-ref', '--short', 'HEAD').stdout?.trim() : null;
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

/**
 * Task done in a lane copy: the work must be committed; it is rebased on the studio's branch (the
 * everyday checks run again if that branch moved) and then the studio's branch fast-forwards to it.
 * Returns null when not in a lane copy, { ok: true, merged } or { ok: false, message }.
 */
export function deliver(taskId, { runChecks = true } = {}) {
  if (!inLaneCopy()) return null;
  const root = mainRoot();
  const main = mainBranch(root);
  const dirty = (git(REPO_ROOT, 'status', '--porcelain').stdout || '').trim().split('\n').filter(Boolean);
  if (dirty.length) return { ok: false, message: `Commit your work first: ${dirty.length} uncommitted file(s) in your copy (${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}). Only committed work reaches the studio. Then run task done again.` };
  const branch = git(REPO_ROOT, 'symbolic-ref', '--short', 'HEAD').stdout.trim();
  const before = git(REPO_ROOT, 'merge-base', 'HEAD', main).stdout.trim();
  const tip = git(root, 'rev-parse', main).stdout.trim();
  if (before !== tip) {
    const rb = git(REPO_ROOT, '-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local', 'rebase', main);
    if (rb.status !== 0) {
      git(REPO_ROOT, 'rebase', '--abort');
      return { ok: false, message: `The studio's branch (${main}) changed files you changed too. Merge it into your copy (git merge ${main}), resolve the conflicts, commit, run npm run verify, then task done again.` };
    }
    if (runChecks) {
      const g = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'run-gates.mjs')], { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } });
      if (g.status !== 0) {
        const red = (g.stdout.match(/FAIL\s+(\S+)/g) || []).map((x) => x.split(/\s+/)[1]).slice(0, 4).join(', ');
        return { ok: false, message: `Your work was rebased on the latest ${main}, and the checks now fail${red ? ` (${red})` : ''}. Fix it in your copy, commit, run npm run verify, then task done again.` };
      }
    }
  }
  if (unmerged(branch, root) === 0) return { ok: true, merged: 0 };
  // The studio's branch moves only forward; another agent's index lock gets a few retries.
  let ff = null;
  for (let i = 0; i < 5; i += 1) {
    ff = git(root, 'merge', '--ff-only', branch);
    if (ff.status === 0) break;
    if (!/index\.lock/.test(ff.stderr || '')) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  }
  if (ff.status !== 0) {
    const why = (ff.stderr || ff.stdout || '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
    return { ok: false, message: `Your work couldn't be added to ${main} in the main checkout: ${why}. If ${main} moved, run task done again (it rebases); if files there are edited but not committed, ask the Producer.` };
  }
  const n = Number(git(root, 'rev-list', '--count', `${before}..${branch}`).stdout.trim()) || 0;
  // The task's branch and any earlier agents' branches it carried are in the studio's branch now.
  const b = readBranches();
  for (const old of b[`${taskId}:carried`] || []) git(root, 'branch', '-D', old);
  delete b[`${taskId}:carried`];
  if (b[taskId] === branch) delete b[taskId];
  writeBranches(b);
  emitEvent({ type: 'lane.merged', agent: process.env.STUDIO_LOCK_OWNER || null, task: taskId, msg: `${taskId}: ${branch} added to ${main}` });
  return { ok: true, merged: n };
}

/** Lane copies on disk, for the War Room and preflight. */
export function laneCopies(root = mainRoot()) {
  const d = path.join(root, LANES_DIR);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
    const dir = path.join(d, e.name);
    const branch = git(dir, 'symbolic-ref', '--short', 'HEAD').stdout?.trim() || null;
    return { agent: e.name, dir, branch, unmerged: branch ? unmerged(branch, root) : 0, dirty: Boolean((git(dir, 'status', '--porcelain').stdout || '').trim()) };
  });
}
