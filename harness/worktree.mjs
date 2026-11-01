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
import { changedSince, readPass, recordPass, canReuse, withLandLock, landingRecheckEnv } from './merge-lane.mjs';
import { PLANNING_ROLES } from './stall.mjs';
import { splitEolOnly, eolNote } from './eol-only.mjs';

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

/**
 * M2 (2.58.3, crew P-039): roles that work on the board, not the game's code, and so stay in the main checkout when
 * their task has no lane (the planning roles of harness/stall.mjs, plus the liaison and a person).
 */
export const MAIN_CHECKOUT_ROLES = new Set([...PLANNING_ROLES, 'liaison', 'human']);
/**
 * A session on a task with no lane gets its own copy too when its role writes code (builder, rnd, art, qa-playtester,
 * reviewer, …): builders on laneless tasks left staged test files in the main checkout and blocked six other tasks'
 * `task done` for 3 hours. STUDIO_LANELESS=shared keeps the old shared checkout; STUDIO_WORKTREES=off turns copies off.
 */
export function lanelessWantsCopy({ role, lane = null, task = null, env = process.env } = {}) {
  if (lane || !task || !role) return false;
  if (/^shared$/i.test(env.STUDIO_LANELESS || '') || /^(off|0|false|no)$/i.test(env.STUDIO_WORKTREES || '')) return false;
  return !MAIN_CHECKOUT_ROLES.has(String(role).toLowerCase());
}

/**
 * M1 (2.58.3): the main checkout's real studio/ and .studio/ folders, which a lane copy links to. A tool started in the
 * copy (cwd .lanes/<agent>) is told it may use them (Claude Code: --add-dir), since it resolves the links and would
 * otherwise refuse their targets as "outside the allowed working directories".
 */
export function laneShareDirs(root = mainRoot()) {
  return ['studio', '.studio'].map((d) => {
    const p = path.join(root, d);
    try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
  });
}

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
export function linkDir(target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

/** node_modules folders worth linking: the root's, hub/'s, and one level into game/, web/, engine/. */
export function nodeModuleDirs(root) {
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

/** 2.30p: what this lane copy changed against the studio's branch: { base, head, changed }. */
export function laneDiff() {
  if (!inLaneCopy()) return null;
  const main = mainBranch(mainRoot());
  const base = git(REPO_ROOT, 'merge-base', 'HEAD', main).stdout.trim();
  const head = git(REPO_ROOT, 'rev-parse', 'HEAD').stdout.trim();
  return { base, head, changed: changedSince(REPO_ROOT, base, head) };
}

/**
 * Task done in a lane copy: the work must be committed; it is rebased on the studio's branch and then
 * the studio's branch fast-forwards to it. Returns null when not in a lane copy, { ok: true, merged }
 * or { ok: false, message }.
 *
 * 2.30p: after a clean rebase the checks re-run only when the incoming changes touch this lane's gate
 * scope (recorded by task done in .studio/gate-pass/<task>.json); otherwise the earlier pass is reused.
 * Re-runs are path-scoped too (STUDIO_GATE_CHANGED). Only the final "did the branch move?" check, the
 * fast-forward and onLanded (the board write) hold the short land lock, so tracks land in parallel.
 */
export function deliver(taskId, { runChecks = true, onLanded = null } = {}) {
  if (!inLaneCopy()) return null;
  const root = mainRoot();
  const main = mainBranch(root);
  // 2.31.0: no trim() before slice(3) (it ate the first letter of the first path: "odot/..."), and engine
  // cache files (.godot/, *.import, *.uid) that every headless Godot run rewrites don't block a landing.
  const dirtyAll = (git(REPO_ROOT, 'status', '--porcelain').stdout || '').split('\n').filter((l) => l.length > 3)
    .filter((l) => !/(^|\/)\.godot\/|\.import$|\.(uid|tmp)$|(^|\/)\.import\//.test(l.slice(3).replace(/^"|"$/g, '')));
  // 2.58.3 (O3, crew P-035): a tracked file that differs only in line endings isn't uncommitted work; it is set aside
  // with the engine cache below (a named stash) so the rebase can run.
  const { real: dirty, eol } = splitEolOnly(REPO_ROOT, dirtyAll);
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
      // 2.59.0 (H-13): a commit whose hook stamp was valid before this rebase and isn't after it is re-committed through
      // the real hooks (harness/hook-stamp.mjs restamp --auto), never stamped by hand; if the hooks refuse it, it doesn't land.
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
          // 2.58.5 (H-3): with the lane's pass recorded for its pre-rebase commit, only the game checks whose inputs main changed run again.
          const env = { ...process.env, ...(changed.length ? { STUDIO_GATE_CHANGED: changed.join(','), STUDIO_GATE_PATHS: process.env.STUDIO_GATE_PATHS || changed.join(',') } : {}), ...landingRecheckEnv(root, taskId, rec, { preHead, incoming }) };
          const g = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'run-gates.mjs')], { cwd: REPO_ROOT, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
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
        // 2.30q (#5): the merge runs in a dedicated merge worktree and the branch ref moves by compare-and-swap;
        // the main checkout's index is only touched to bring its files up to date afterwards.
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
    // The task's branch and any earlier agents' branches it carried are in the studio's branch now.
    const b = readBranches();
    for (const old of b[`${taskId}:carried`] || []) git(root, 'branch', '-D', old);
    delete b[`${taskId}:carried`];
    if (b[taskId] === branch) delete b[taskId];
    writeBranches(b);
    if (res.merged) emitEvent({ type: 'lane.merged', agent: process.env.STUDIO_LOCK_OWNER || null, task: taskId, msg: `${taskId}: ${branch} added to ${main}` });
    return res;
  }
  return { ok: false, message: `${main} kept moving while ${taskId} was landing (${tries} tries). Run task done again.` };
}

/**
 * 2.59.0 (H-13): after deliver's rebase, re-commit through the hooks the lane commits whose stamps the rebase made stale
 * (only when every stamp was valid before it). STUDIO_HOOKS_RESTAMP=off skips it (the hooks gate then lists them).
 * Returns { ok, message, replayed }.
 */
export function restampAfterRebase(taskId, { tip, before, preHead }) {
  if (/^(off|0|false|no)$/i.test(process.env.STUDIO_HOOKS_RESTAMP || '')) return { ok: true, replayed: 0 };
  const script = path.join(REPO_ROOT, 'harness', 'hook-stamp.mjs');
  if (!fs.existsSync(script)) return { ok: true, replayed: 0 };
  const r = spawnSync(process.execPath, [script, 'restamp', '--auto', '--json', '--base', tip, '--was', preHead, '--was-base', before], { cwd: REPO_ROOT, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
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

/** 2.30q (#5): the dedicated merge worktree (detached, no checkout: its own HEAD and index, no files). */
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
 * 2.30q (#5): land a lane branch on the studio's branch without the main checkout's index.
 * In the Marina run 12 landings failed in `git merge --ff-only` run inside the main checkout ("Please commit
 * your changes or stash them", untracked files in the way, index.lock). Now:
 *   1. in the merge worktree, `git merge-tree --write-tree` proves the result is exactly the lane's tree (a
 *      fast-forward), touching no one's index;
 *   2. the main checkout's own uncommitted edits to files the lane changed are kept in a named stash (never
 *      lost; STUDIO_LAND_STASH=off refuses instead, as before);
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
