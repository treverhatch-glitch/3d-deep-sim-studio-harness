/**
 * harness/engine-worktree.mjs — makes an engine task's worktree, sparse when its role only needs a few folders.
 * studio/game.json engines.<x>.sparse = { "roles": ["engine-porter"], "paths": ["Assets/Rules", "tools/tests"] } (the
 * owner's file): a task whose role is listed gets a cone-mode sparse checkout of those folders plus every top-level
 * file; other roles get a full worktree, at <studio>/.lanes/engine/<task>. Uses `git worktree add --no-checkout`, `git
 * sparse-checkout set --cone` (per-worktree config.worktree, so the main checkout stays full), `git read-tree -mu
 * HEAD`, `git sparse-checkout disable` and `reapply`. A merge in a sparse worktree (ort) merges paths outside the cone
 * in the index only; a conflict writes that file. Git older than SPARSE_MIN_GIT: a full worktree. Creation is all or
 * nothing: on any failure what this call made (registration, folder, branch) is removed again. No harness imports at
 * load (engine-tracks.mjs and engine-clean.mjs import this).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SPARSE_MIN_GIT = [2, 38];
const fwd = (p) => String(p).split(path.sep).join('/');

/** The default git runner: no shell, hidden window, long paths allowed on Windows (core.longpaths). */
export function runGit(cwd, args) {
  const pre = process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
  return spawnSync('git', [...pre, ...args], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60000 });
}
const lastLine = (r) => String(r?.stderr || r?.stdout || r?.error?.message || '').trim().split(/\r?\n/).pop().slice(0, 240);

/** [major, minor] of the installed git, or null. */
export function gitVersionOf(run = runGit) {
  const m = String(run(process.cwd(), ['--version']).stdout || '').match(/(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
export const sparseGitOk = (v) => Boolean(v) && (v[0] > SPARSE_MIN_GIT[0] || (v[0] === SPARSE_MIN_GIT[0] && v[1] >= SPARSE_MIN_GIT[1]));

/**
 * engines.<x>.sparse from the engine's config object -> { roles, paths } | { error } | null (not set). Paths are folders
 * relative to the repo's top, forward slashes, no wildcard, no "..", no leading slash.
 */
export function sparseConfig(cfg) {
  const s = cfg?.sparse;
  if (s === undefined || s === null) return null;
  if (typeof s !== 'object' || !Array.isArray(s.roles) || !Array.isArray(s.paths)) return { error: 'engines.<x>.sparse must be { "roles": [...], "paths": [...] }' };
  const roles = s.roles.map((r) => String(r || '').trim().toLowerCase()).filter(Boolean);
  const paths = [];
  for (const raw of s.paths) {
    const p = String(raw || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..') || /[*?[\]!\n\r]/.test(p)) return { error: `engines.<x>.sparse.paths: "${String(raw).slice(0, 80)}" is not a plain folder path inside the repo` };
    if (!paths.includes(p)) paths.push(p);
  }
  if (!roles.length || !paths.length) return { error: 'engines.<x>.sparse needs at least one role and one path' };
  return { roles, paths };
}

/** The sparse paths for a worktree made for `role`, or null (full). */
export function sparsePathsFor(cfg, role) {
  const s = sparseConfig(cfg);
  if (!s || s.error) return null;
  return s.roles.includes(String(role || '').trim().toLowerCase()) ? s.paths : null;
}

/** The worktree's own git folder (the `gitdir:` its .git file names), or null. */
function gitDirOf(dir) {
  try {
    const t = fs.readFileSync(path.join(dir, '.git'), 'utf8');
    const m = t.match(/^gitdir:\s*(.+)$/m);
    return m ? path.resolve(dir, m[1].trim()) : null;
  } catch { return null; }
}

/** Is this worktree sparse, and with which folders? Read from its own config.worktree and info/sparse-checkout (no git run). */
export function sparseState(dir) {
  const gd = gitDirOf(dir);
  if (!gd) return { sparse: false, paths: [] };
  let cfg = '';
  try { cfg = fs.readFileSync(path.join(gd, 'config.worktree'), 'utf8'); } catch { return { sparse: false, paths: [] }; }
  if (!/^\s*sparsecheckout\s*=\s*true\s*$/im.test(cfg)) return { sparse: false, paths: [] };
  let pats = [];
  try { pats = fs.readFileSync(path.join(gd, 'info', 'sparse-checkout'), 'utf8').split(/\r?\n/); } catch { pats = []; }
  // Cone-mode patterns: "/Assets/" (a parent), "!/Assets/*/" and "/Assets/Rules/" (a kept folder). The kept folders are the
  // deepest ones listed without a "!".
  const dirs = pats.map((l) => l.trim()).filter((l) => /^\/.+\/$/.test(l)).map((l) => l.slice(1, -1));
  const kept = dirs.filter((d) => !dirs.some((o) => o !== d && o.startsWith(`${d}/`)));
  return { sparse: true, paths: kept };
}

/** Files (repo paths) that are outside a sparse worktree's folders and not at the repo's top level. */
export function outsideSparse(files, paths) {
  return (files || []).filter((f) => f.includes('/') && !paths.some((p) => f === p || f.startsWith(`${p}/`)));
}

/** The one line a brief or a message uses for a sparse worktree. */
export const sparseLine = (task, paths) => `This worktree is sparse: it holds only ${paths.join(', ')} and the repo's top-level files. If the task needs more, say so in your hand-back, or widen it first: npm run engine -- lane ${task} --full.`;
export const widenHint = (task) => `npm run engine -- merge ${task} --abort, then npm run engine -- lane ${task} --full (the worktree becomes full), then npm run engine -- merge ${task} again`;

/** Remove what a failed creation made: the registration, the folder (retried: Windows may hold a file a moment), a new branch. */
function undo({ repo, dir, branch, createdBranch, baseSha, run }) {
  run(repo, ['worktree', 'remove', '--force', '--force', dir]);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* checked below */ }
  run(repo, ['worktree', 'prune']);
  // Only a branch this call made, still where it was made: nothing anyone committed is ever lost.
  if (createdBranch && baseSha) {
    const tip = String(run(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).stdout || '').trim();
    if (tip === baseSha) run(repo, ['branch', '-D', branch]);
  }
  return !fs.existsSync(dir);
}

/**
 * Make `dir` a worktree of `repo` on `branch` (created from `base` when `create`), sparse with `sparse` folders when given.
 * { ok: true, sparse: [paths] | null, fallback?: why } | { error, cleaned }. All or nothing (see the header). `run` is the
 * git runner (cwd, args) -> spawnSync result, replaceable for tests.
 */
export function addEngineWorktree({ repo, dir, branch, base = null, create = false, sparse = null, run = runGit } = {}) {
  let paths = Array.isArray(sparse) && sparse.length ? sparse : null;
  let fallback = null;
  if (paths) {
    const v = gitVersionOf(run);
    if (!sparseGitOk(v)) { fallback = `git ${v ? v.join('.') : '?'} is older than ${SPARSE_MIN_GIT.join('.')}, so this engine worktree is full, not sparse (update git to get sparse engine worktrees)`; paths = null; }
  }
  if (fs.existsSync(dir)) return { error: `${fwd(dir)} already exists and is not a worktree on ${branch}: remove it first`, cleaned: false };
  const baseSha = create ? String(run(repo, ['rev-parse', '--verify', '--quiet', `${base || 'HEAD'}^{commit}`]).stdout || '').trim() : null;
  if (create && !baseSha) return { error: `${base || 'HEAD'} is not a commit in ${fwd(repo)}`, cleaned: true };
  try { fs.mkdirSync(path.dirname(dir), { recursive: true }); } catch (e) { return { error: `could not make ${fwd(path.dirname(dir))}: ${e.message}`, cleaned: true }; }
  const fail = (what, r) => {
    const cleaned = undo({ repo, dir, branch, createdBranch: create, baseSha, run });
    return { error: `${what} failed: ${lastLine(r)}${cleaned ? ' (nothing was left behind)' : `; the half-made folder ${fwd(dir)} could not be removed (a process may hold a file in it): remove it by hand, then git -C "${fwd(repo)}" worktree prune`}`, cleaned };
  };
  const add = run(repo, create ? ['worktree', 'add', '--no-checkout', '-b', branch, dir, baseSha] : ['worktree', 'add', '--no-checkout', dir, branch]);
  if (add.status !== 0) return fail('git worktree add', add);
  if (paths) {
    const s = run(dir, ['sparse-checkout', 'set', '--cone', ...paths]);
    if (s.status !== 0) return fail('git sparse-checkout set', s);
  }
  const fill = run(dir, ['read-tree', '-mu', 'HEAD']);
  if (fill.status !== 0) return fail('git read-tree (checking the files out)', fill);
  return { ok: true, sparse: paths, ...(fallback ? { fallback } : {}) };
}

/** Make a sparse worktree full (git sparse-checkout disable). { ok, already } | { error }. Refused mid-merge. */
export function widenEngineWorktree(dir, { run = runGit } = {}) {
  if (!sparseState(dir).sparse) return { ok: true, already: true };
  if (run(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0) return { error: 'a merge is in progress there: finish it or abort it first (npm run engine -- merge <ID> --abort)' };
  const r = run(dir, ['sparse-checkout', 'disable']);
  if (r.status !== 0) return { error: `git sparse-checkout disable failed: ${lastLine(r)}` };
  return { ok: true, already: false };
}

/** After an aborted merge in a sparse worktree: drop files outside the folders that the merge wrote (git sparse-checkout reapply). */
export function reapplySparse(dir, { run = runGit } = {}) {
  if (sparseState(dir).sparse) run(dir, ['sparse-checkout', 'reapply']);
}
