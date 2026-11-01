#!/usr/bin/env node
/**
 * harness/hook-stamp.mjs — 2.58.2 (PU-29): find commits that skipped the git hooks.
 *
 * A hook can't stop `git commit --no-verify` (or `git -c core.hooksPath=… commit`): it simply doesn't run. So the hooks
 * leave a stamp on every commit they passed, and a gate looks for commits without a valid one afterwards.
 *
 *   pre-commit          when every check passed, writes the tree it checked to .git/studio-hooks-pass
 *   prepare-commit-msg  (runs even with --no-verify) notes whether this commit amends HEAD
 *   commit-msg          adds the trailer   Studio-Hooks: v<hooks version> t<tree> p<patch-id>
 *                       (`s<id>` with an old git that has no `patch-id --verbatim`; `empty` for an empty commit;
 *                       `merge` for a merge commit, which only commit-msg runs for). Only when pre-commit passed on
 *                       exactly this tree, and never when the commit replaces (amends) a HEAD that wasn't checked.
 *
 * The gate (`node harness/hook-stamp.mjs check`, the `hooks` gate and every `task done`) lists the commits since the
 * base branch (approve.mjs resolveBase) whose stamp is missing or doesn't match the commit: its tree (the same commit)
 * or its patch-id (the same change after a clean rebase or cherry-pick) must match. Exempt: commits made before the
 * stamping hooks existed (their parent's scripts/hooks/commit-msg doesn't stamp), commits the harness makes without
 * hooks marked `Studio-Harness: <kind>` (a known kind only), and commits the owner approved
 * (`npm run approve -- hooks --note "why"`). CI's own merge commit of a pull request is not judged, its PR head is.
 *
 * Enforced when the hooks are installed in this checkout (core.hooksPath=scripts/hooks), or the base branch's recent
 * history carries stamps (the studio uses them), or STUDIO_HOOKS_CHECK=on. STUDIO_HOOKS_CHECK=off turns it off.
 *
 * Upgrading: commits a checkout already had when it took the stamping hooks (lane branches, local work not yet
 * pushed) are listed once, by patch-id, in <git common dir>/studio-hooks-grandfather.json. The first stamping hook run
 * writes it (the upgrade's own merge commit), and `node harness/hook-stamp.mjs grandfather` adds to it by hand. Those
 * commits stay exempt after a clean rebase onto the upgrade (P-068); a commit made after the list was written is not in it.
 *
 * Limits: a stamp is plain text, so a deliberate forger who computes one by hand passes (the weakened-test and
 * protected-file gates still judge the content); `git revert`, `git rebase` with conflicts or squashes, and an amend
 * with `-m` that is later rebased onto a moved base are flagged until re-committed with the hooks.
 *
 * Size (2.58.5, H-7): only the commits that need a patch-id get one (a stamp whose tree doesn't match, the grandfather
 * list, the commits listed), and every diff streams from git into git patch-id; none is held in memory, so a range
 * holding a game's binary art costs time, not memory. A commit list too big to read fails the gate, never passes it.
 *
 *   node harness/hook-stamp.mjs check [--json]
 *   node harness/hook-stamp.mjs stamp <message-file>      (the commit-msg hook)
 *   node harness/hook-stamp.mjs grandfather [--json]      (list the commits this checkout already has as exempt)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.STUDIO_PROTECT_ROOT ? path.resolve(process.env.STUDIO_PROTECT_ROOT) : path.resolve(HERE, '..');
export const TRAILER = 'Studio-Hooks';
export const HARNESS_TRAILER = 'Studio-Harness';
/** Commits the harness itself makes without the hooks: the kind, and a trailer such a commit always carries too. */
export const HARNESS_KINDS = { 'experiment-drop': /^Studio-Experiment-Drop:\s*\S/m };
const HOOK_FILES = ['pre-commit', 'commit-msg', 'prepare-commit-msg'];
const HOOK_REL = 'scripts/hooks/commit-msg';
const MARKER = 'hook-stamp.mjs'; // a commit-msg hook that calls this file stamps commits
export const PASS_FILE = 'studio-hooks-pass';
export const AMEND_FILE = 'studio-hooks-amend';
const STAMP_RE = /^Studio-Hooks:[ \t]*v([0-9a-f]{8})[ \t]+t([0-9a-f]{12})[ \t]+(?:([ps])([0-9a-f]{12})|(empty)|(merge))[ \t]*$/gim;

// The same diff, byte for byte, in the hook (git diff --cached) and in the gate (git log -p), whatever the user's config.
const GIT_CFG = ['-c', 'core.quotePath=true', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.relative=false',
  '-c', 'diff.suppressBlankEmpty=false', '-c', 'log.showSignature=false', '-c', 'color.ui=false', '-c', 'patchid.verbatim=false', '-c', 'patchid.stable=false'];
export const DIFF_OPTS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--diff-algorithm=myers', '--indent-heuristic', '-U3',
  '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/', '--binary', '--ignore-submodules=none', '--submodule=short'];
// 2.58.5 (H-7): no diff is read into memory any more (patch-ids stream, below); what is still read whole is small
// (commit messages, names). STUDIO_HOOKS_MAX_BUFFER (bytes) lowers the limit, for tests that prove that.
export const MAX_BUFFER = Number(process.env.STUDIO_HOOKS_MAX_BUFFER) > 0 ? Number(process.env.STUDIO_HOOKS_MAX_BUFFER) : 512 * 1024 * 1024;
const git = (args, { cwd = ROOT, input } = {}) => spawnSync('git', [...GIT_CFG, ...args], { cwd, encoding: 'utf8', input, maxBuffer: MAX_BUFFER });
/** git(), but an output too big to read is an error, never a silently cut list (spawnSync stops at maxBuffer). */
function gitAll(args, opts) {
  let r;
  try { r = git(args, opts); } catch (e) { throw new Error(`git ${args[0]}: output too big to read (${e.code || e.message})`); }
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.code === 'ENOBUFS' ? `output over ${MAX_BUFFER} bytes, not read` : r.error.message}`);
  return r;
}
const isSha = (s) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(String(s || ''));

/**
 * 2.58.5 (H-7): `git <diffArgs>` piped straight into `git patch-id`, so the diff never passes through this process (a
 * whole-range `git log -p --binary` over a game's art passed Node's string limit: ERR_STRING_TOO_LONG). stdinText feeds
 * the first command (commit ids for `log --stdin`). Resolves { status, lines } with patch-id's output lines.
 */
function pipePatchId(diffArgs, mode, { cwd = ROOT, stdinText = null } = {}) {
  return new Promise((resolve) => {
    const src = spawn('git', [...GIT_CFG, ...diffArgs], { cwd, stdio: [stdinText === null ? 'ignore' : 'pipe', 'pipe', 'ignore'], windowsHide: true });
    const pid = spawn('git', [...GIT_CFG, 'patch-id', mode === 'p' ? '--verbatim' : '--stable'], { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    let codes = 0;
    let bad = false;
    const finish = (code) => { if (code !== 0) bad = true; if (++codes === 2) resolve({ status: bad ? 1 : 0, lines: out.split('\n').map((l) => l.trim()).filter(Boolean) }); };
    for (const s of [src.stdout, pid.stdin, pid.stdout, src.stdin].filter(Boolean)) s.on('error', () => { bad = true; });
    src.on('error', () => { bad = true; pid.stdin.end(); });
    pid.on('error', () => { bad = true; src.kill(); });
    src.on('close', finish);
    pid.on('close', finish);
    src.stdout.pipe(pid.stdin);
    pid.stdout.setEncoding('utf8');
    pid.stdout.on('data', (d) => { out += d; });
    if (src.stdin) src.stdin.end(stdinText);
  });
}

/**
 * Patch-ids (12 hex) of exactly these non-merge commits, for one mode: Map sha -> id (a commit with an empty diff has
 * none). Each commit's diff against its first parent (the empty tree for a root), the same diff the commit-msg hook
 * patch-ids (`git diff --cached` against the parent), streamed (pipePatchId). The ids go in on stdin: no command-line limit.
 */
export async function patchIdsOf(shas, mode = 'p', cwd = ROOT) {
  const out = new Map();
  const list = [...new Set(shas)].filter(isSha);
  if (!list.length) return out;
  const r = await pipePatchId(['-c', 'log.showRoot=true', 'log', '--no-walk=unsorted', '--stdin', '--no-merges', '-p', '--format=commit %H', ...DIFF_OPTS], mode, { cwd, stdinText: `${list.join('\n')}\n` });
  if (r.status !== 0) return out;
  for (const l of r.lines) { const [pid, sha] = l.split(/\s+/); if (sha && /^[0-9a-f]{40}/.test(pid)) out.set(sha, pid.slice(0, 12)); }
  return out;
}

/** A cache of patch-ids that computes only the ones asked for, in one streamed batch per mode. */
function pidStore(cwd = ROOT) {
  const cache = { p: new Map(), s: new Map() };
  let computed = 0;
  return {
    get: (sha, mode) => cache[mode || 'p'].get(sha) ?? null,
    get computed() { return computed; },
    async need(shas, mode = 'p') {
      const m = mode || 'p';
      const missing = [...new Set(shas)].filter((s) => !cache[m].has(s));
      if (!missing.length) return;
      computed += missing.length;
      const got = await patchIdsOf(missing, m, cwd);
      for (const s of missing) cache[m].set(s, got.get(s) || null);
    },
    /** stampValid for many commits: a dry run says which patch-ids it would look at (only where the tree doesn't match). */
    async validate(list) {
      const want = { p: new Set(), s: new Set() };
      for (const { c, parentTree } of list) stampValid(c, (sha, m) => { want[m || 'p'].add(sha); return null; }, parentTree);
      for (const m of ['p', 's']) await this.need([...want[m]], m);
      return list.map(({ c, parentTree }) => stampValid(c, this.get, parentTree));
    },
  };
}

/** The hooks' version: a short hash of their text (line endings ignored). */
export function hooksVersion(root = ROOT) {
  const h = crypto.createHash('sha256');
  for (const f of HOOK_FILES) {
    let t = '';
    try { t = fs.readFileSync(path.join(root, 'scripts', 'hooks', f), 'utf8').replace(/\r\n/g, '\n'); } catch {}
    h.update(`${f}\n${t}\n`);
  }
  return h.digest('hex').slice(0, 8);
}

/** Patch-id of a diff: { mode: 'p' (verbatim) | 's' (stable, whitespace ignored), id } or null for an empty diff. */
export function patchIdOf(diff, cwd = ROOT, mode = null) {
  if (!String(diff || '').trim()) return null;
  for (const m of mode ? [mode] : ['p', 's']) {
    const r = git(['patch-id', m === 'p' ? '--verbatim' : '--stable'], { cwd, input: diff });
    const id = (r.stdout || '').trim().split(/\s+/)[0];
    if (r.status === 0 && /^[0-9a-f]{40}/.test(id || '')) return { mode: m, id };
  }
  return null;
}

/**
 * The patch-id of the staged change against a parent, as patchIdOf gives it ({ mode, id } or null when empty), the diff
 * streamed into git patch-id (2.58.5, H-7: a large binary file staged no longer has to fit in this process).
 */
export async function stagedPatchId(parent, cwd = ROOT) {
  for (const m of ['p', 's']) {
    const r = await pipePatchId(['diff', '--cached', ...DIFF_OPTS, parent], m, { cwd });
    const id = (r.lines[0] || '').split(/\s+/)[0];
    if (r.status === 0 && /^[0-9a-f]{40}/.test(id)) return { mode: m, id };
    if (r.status === 0 && !r.lines.length) return null; // an empty diff
  }
  return null;
}

/** Every Studio-Hooks stamp in a message (a squash can carry several; any matching one counts). */
export function parseStamps(msg) {
  return [...String(msg || '').matchAll(STAMP_RE)].map((m) => ({ ver: m[1], tree: m[2], mode: m[3] || null, pid: m[4] || null, empty: Boolean(m[5]), merge: Boolean(m[6]) }));
}

/**
 * Is this commit's stamp valid? c = { sha, tree, parents: [], msg }; pidOf(sha, mode) gives its patch-id (12 hex) or null.
 * Returns { ok, why }.
 */
export function stampValid(c, pidOf, parentTree = null) {
  const stamps = parseStamps(c.msg);
  if (!stamps.length) return { ok: false, why: 'no Studio-Hooks stamp: made with --no-verify, without the hooks installed, or by revert/rebase' };
  const merge = c.parents.length > 1;
  for (const s of stamps) {
    if (s.merge !== merge) continue;
    if (c.tree.startsWith(s.tree)) return { ok: true };
    if (merge) continue;
    if (s.empty && parentTree && parentTree === c.tree) return { ok: true };
    if (s.pid && pidOf(c.sha, s.mode) === s.pid) return { ok: true };
  }
  return { ok: false, why: merge ? 'its stamp is not a merge stamp for this merge\'s content' : 'its stamp doesn\'t match its content: changed after the hooks ran (an amend or rebase without them, a squash, or a copied message)' };
}

function commitInfo(rev, cwd) {
  const r = git(['log', '-1', '--format=%H%x1f%T%x1f%P%x1f%B', rev], { cwd });
  if (r.status !== 0) return null;
  const [sha, tree, parents, msg] = r.stdout.split('\x1f');
  return { sha, tree, parents: parents.trim() ? parents.trim().split(' ') : [], msg: msg || '' };
}
const emptyTree = (cwd) => git(['hash-object', '-t', 'tree', '--stdin'], { cwd, input: '' }).stdout.trim();
const hookStamps = (blob, cwd) => isSha(blob) && git(['cat-file', 'blob', blob], { cwd }).stdout.includes(MARKER);

// 2.58.2 (P-068): the commits a checkout already had when it took the stamping hooks. They were never stamped, and once a
// lane rebases them onto the upgrade their parent's hook stamps, so without this list every in-flight lane task would
// fail the hooks gate at task done. Kept by patch-id (a clean rebase keeps it) in the git common dir, shared by every
// worktree (lanes) of the checkout and never committed.
export const GRANDFATHER_FILE = 'studio-hooks-grandfather.json';
export function grandfatherPath(cwd = ROOT) {
  const r = git(['rev-parse', '--git-common-dir'], { cwd });
  return r.status === 0 && r.stdout.trim() ? path.join(path.resolve(cwd, r.stdout.trim()), GRANDFATHER_FILE) : null;
}
export function readGrandfather(cwd = ROOT) {
  const f = grandfatherPath(cwd);
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return { file: f, exists: true, shas: new Set(j.shas || []), pids: new Set(j.pids || []), at: j.at || null }; } catch {}
  return { file: f, exists: false, shas: new Set(), pids: new Set(), at: null };
}
/**
 * List every commit on a local branch that no remote branch has (lane work, unpushed local commits) and that carries no
 * stamp, by sha and verbatim patch-id. Adds to an existing list. With no remote, the last 5000 commits of local branches.
 */
export async function writeGrandfather(cwd = ROOT) {
  const f = grandfatherPath(cwd);
  if (!f) return { ok: false, why: 'not a git checkout' };
  const remotes = git(['for-each-ref', '--format=%(refname)', 'refs/remotes'], { cwd }).stdout.trim();
  const range = ['--branches', ...(remotes ? ['--not', '--remotes'] : ['-n', '5000'])];
  const list = gitAll(['log', '--no-merges', '--format=%x1e%H%x1f%B', ...range], { cwd });
  const unstamped = new Set(list.stdout.split('\x1e').filter((x) => x.includes('\x1f')).map((x) => x.split('\x1f')).filter(([, msg]) => !parseStamps(msg).length).map(([sha]) => sha.trim()));
  const old = readGrandfather(cwd);
  const pids = new Set(old.pids);
  // 2.58.5 (H-7): patch-ids of the unstamped commits only, streamed; never a whole-history `git log -p --binary`.
  for (const pid of (await patchIdsOf([...unstamped], 'p', cwd)).values()) pids.add(pid);
  const shas = new Set([...old.shas, ...unstamped]);
  fs.writeFileSync(f, `${JSON.stringify({ at: old.at || new Date().toISOString(), updated: new Date().toISOString(), shas: [...shas], pids: [...pids] }, null, 1)}\n`);
  return { ok: true, file: f, added: unstamped.size - [...unstamped].filter((x) => old.shas.has(x)).length, total: shas.size };
}
const grandfathered = (g, sha, pid) => g.shas.has(sha) || Boolean(pid && g.pids.has(pid));
/** Was HEAD checked? A valid stamp, a commit other branches hold (already shared), or one exempt from stamping. */
async function headChecked(cwd) {
  const h = commitInfo('HEAD', cwd);
  if (!h) return { ok: true }; // the first commit
  const parentTree = h.parents[0] ? git(['rev-parse', `${h.parents[0]}^{tree}`], { cwd }).stdout.trim() : null;
  const pids = pidStore(cwd);
  if ((await pids.validate([{ c: h, parentTree }]))[0].ok) return { ok: true };
  const kind = (h.msg.match(/^Studio-Harness:[ \t]*([\w-]+)/m) || [])[1];
  if (kind && HARNESS_KINDS[kind]?.test(h.msg)) return { ok: true };
  if (!h.parents[0] || !hookStamps(git(['rev-parse', '-q', '--verify', `${h.parents[0]}:${HOOK_REL}`], { cwd }).stdout.trim(), cwd)) return { ok: true };
  const g = readGrandfather(cwd);
  if (g.pids.size) await pids.need([h.sha], 'p');
  if ((g.shas.size || g.pids.size) && grandfathered(g, h.sha, pids.get(h.sha, 'p'))) return { ok: true };
  const own = git(['symbolic-ref', '-q', 'HEAD'], { cwd }).stdout.trim();
  const holders = git(['for-each-ref', '--contains', h.sha, '--format=%(refname)', 'refs/heads', 'refs/remotes'], { cwd }).stdout.split('\n').map((s) => s.trim()).filter((s) => s && s !== own);
  if (holders.length) return { ok: true };
  // The owner accepted it as it is (npm run approve -- hooks): the gate verifies the signature against the base's key;
  // here the working tree's key is enough to keep the next commits stamped.
  try {
    const { ownerPublicKey, readApprovals, verifyApproval } = await import('./approve.mjs');
    const pub = ownerPublicKey(null);
    await pids.need([h.sha], 'p');
    const pid = pids.get(h.sha, 'p');
    if (pub && readApprovals().some((a) => a.approval?.kind === 'hooks' && (a.approval.commits || []).some((x) => x.sha === h.sha || (pid && x.pid === pid)) && verifyApproval(a, pub))) return { ok: true };
  } catch {}
  return { ok: false, sha: h.sha };
}

/** The commit-msg hook: add (or replace) the stamp when pre-commit passed on exactly this content. Returns { stamp, why }. */
export async function stampMessage(msgFile, { cwd = process.cwd() } = {}) {
  const gitPath = (p) => path.resolve(cwd, git(['rev-parse', '--git-path', p], { cwd }).stdout.trim());
  const take = (p) => { const f = gitPath(p); let t = ''; try { t = fs.readFileSync(f, 'utf8').trim(); fs.rmSync(f, { force: true }); } catch {} return t; };
  const passed = take(PASS_FILE);
  const amend = take(AMEND_FILE);
  // The first stamping hook run in this checkout (normally the upgrade's own merge commit): list what it already has.
  try { if (!readGrandfather(cwd).exists) await writeGrandfather(cwd); } catch {}
  const file = path.resolve(cwd, msgFile);
  const original = fs.readFileSync(file, 'utf8');
  // A message with no final newline (git merge's) makes interpret-trailers glue the trailer to the subject line.
  let stripped = original.split(/\r?\n/).filter((l) => !/^Studio-Hooks:/i.test(l)).join('\n');
  if (!stripped.endsWith('\n')) stripped += '\n';
  if (stripped !== original) fs.writeFileSync(file, stripped);
  const tree = git(['write-tree'], { cwd }).stdout.trim();
  const ver = hooksVersion(cwd);
  let stamp = null;
  let why = '';
  const merging = git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd }).status === 0;
  if (!isSha(tree)) why = 'could not read the staged tree';
  else if (merging) stamp = `v${ver} t${tree.slice(0, 12)} merge`;
  else if (passed !== tree) why = 'the pre-commit hook did not pass on this exact content (it did not run, or the staged files changed after it)';
  else {
    // Amending replaces HEAD: pre-commit only saw the change since HEAD, so HEAD itself must have been checked before.
    const hc = await headChecked(cwd);
    const head = git(['rev-parse', '-q', '--verify', 'HEAD'], { cwd }).stdout.trim();
    if (!hc.ok) why = `HEAD (${hc.sha.slice(0, 8)}) was committed without the hooks, and this commit could be an amend carrying its unchecked changes, so commits stay unstamped until it is re-committed with the hooks (the hooks gate says how)`;
    else {
      let parent = head || emptyTree(cwd);
      let mergeAmend = false;
      if (amend && head) {
        const ps = commitInfo('HEAD', cwd).parents;
        if (ps.length > 1) mergeAmend = true;
        parent = ps[0] || emptyTree(cwd);
      }
      if (mergeAmend) stamp = `v${ver} t${tree.slice(0, 12)} merge`;
      else {
        const pid = await stagedPatchId(parent, cwd);
        stamp = `v${ver} t${tree.slice(0, 12)} ${pid ? `${pid.mode}${pid.id.slice(0, 12)}` : 'empty'}`;
      }
    }
  }
  if (stamp) {
    const r = git(['interpret-trailers', '--in-place', '--if-exists', 'replace', '--trailer', `${TRAILER}: ${stamp}`, file], { cwd });
    if (r.status !== 0) return { stamp: null, why: `git interpret-trailers failed: ${(r.stderr || '').trim()}` };
  }
  return { stamp, why };
}

const truthy = (v) => /^(on|1|true|yes)$/i.test(String(v || ''));
const falsy = (v) => /^(off|0|false|no)$/i.test(String(v || ''));

/** Are the hooks installed in this checkout? */
function hooksInstalled() {
  const v = git(['config', '--get', 'core.hooksPath']).stdout.trim();
  if (!v) return false;
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(path.resolve(ROOT, v)) === norm(path.join(ROOT, 'scripts', 'hooks'));
}

/** The base to judge from: approve.mjs's resolveBase, else STUDIO_TASK_BASE (task done passes the task's start commit). */
export async function changeBase(env = process.env) {
  const { resolveBase } = await import('./approve.mjs');
  const b = resolveBase(env);
  if (b) return b;
  if (isSha(env.STUDIO_TASK_BASE)) return { ref: `${env.STUDIO_TASK_BASE.slice(0, 8)} (the task's start)`, base: env.STUDIO_TASK_BASE };
  return null;
}

/** CI's own merge of a pull request (refs/pull/N/merge) is nobody's commit: judge the PR head (HEAD^2) instead. */
function headToJudge(env) {
  if (!/^pull_request/.test(env.GITHUB_EVENT_NAME || '') || !env.GITHUB_SHA) return 'HEAD';
  const h = commitInfo('HEAD', ROOT);
  return h && h.sha === env.GITHUB_SHA && h.parents.length === 2 ? h.parents[1] : 'HEAD';
}

/**
 * The commits since the base that skipped the hooks.
 * { ok, enforced, off, base, checked, open: [{ sha, subject, why, pid }], exempt, approved, patchIds (commits patch-id'd), why }
 * Throws when the commit list is too big to read (never judges a list cut short).
 */
export async function checkHookStamps({ env = process.env, ignoreApprovals = false } = {}) {
  if (falsy(env.STUDIO_HOOKS_CHECK)) return { ok: true, off: true, enforced: false, open: [], why: 'off (STUDIO_HOOKS_CHECK=off): commits are not checked for skipped hooks' };
  const b = await changeBase(env);
  if (!b) return { ok: true, enforced: false, open: [], why: 'no base branch to compare with, so no commits to check' };
  const head = headToJudge(env);
  const range = `${b.base}..${head}`;
  // Messages only (small); a list cut short would pass commits unchecked, so too big to read is an error (gitAll).
  const log = gitAll(['log', '--format=%x1e%H%x1f%T%x1f%P%x1f%B', range]);
  const commits = log.stdout.split('\x1e').filter((s) => s.includes('\x1f')).map((s) => {
    const [sha, tree, parents, msg] = s.split('\x1f');
    return { sha: sha.trim(), tree, parents: parents.trim() ? parents.trim().split(' ') : [], msg: msg || '' };
  });
  const enforced = truthy(env.STUDIO_HOOKS_CHECK) || hooksInstalled() || /^Studio-Hooks:/im.test(git(['log', '-50', '--format=%B', b.base]).stdout);
  if (!commits.length) return { ok: true, enforced, open: [], checked: 0, base: b.ref, why: `no commits since ${b.ref}` };

  // Commits made before the stamping hooks existed are exempt: their first parent's commit-msg hook doesn't stamp.
  const firstParents = [...new Set(commits.map((c) => c.parents[0]).filter(Boolean))];
  const check = git(['cat-file', '--batch-check=%(objectname)'], { input: firstParents.map((p) => `${p}:${HOOK_REL}`).join('\n') + '\n' });
  const blobOf = new Map(firstParents.map((p, i) => [p, (check.stdout.split('\n')[i] || '').trim()]));
  const stamping = new Map();
  for (const blob of new Set(blobOf.values())) stamping.set(blob, hookStamps(blob, ROOT));
  const treeOf = new Map(commits.map((c) => [c.sha, c.tree]));
  const parentTree = (c) => (c.parents[0] ? treeOf.get(c.parents[0]) || git(['rev-parse', `${c.parents[0]}^{tree}`]).stdout.trim() : null);

  // 2.58.5 (H-7): patch-ids only for the commits that need one (a stamp whose tree doesn't match: rebased, cherry-picked;
  // the grandfather list; the commits listed), streamed in one batch per mode. Never a whole-range `git log -p --binary`:
  // with a base far behind, the range holds a game's whole art import and that passed Node's string limit.
  const pids = pidStore(ROOT);
  const open = [];
  let exempt = 0;
  const g = readGrandfather(ROOT);
  const stamped = (c) => c.parents[0] && stamping.get(blobOf.get(c.parents[0]));
  const maybeOld = (c) => (g.shas.size || g.pids.size) && !parseStamps(c.msg).length && c.parents.length < 2;
  if (g.pids.size) await pids.need(commits.filter((c) => stamped(c) && maybeOld(c) && !g.shas.has(c.sha)).map((c) => c.sha), 'p');
  const judged = [];
  for (const c of commits) {
    if (!stamped(c)) { exempt++; continue; }
    if (maybeOld(c) && grandfathered(g, c.sha, pids.get(c.sha, 'p'))) { exempt++; continue; }
    const kind = (c.msg.match(/^Studio-Harness:[ \t]*([\w-]+)/m) || [])[1];
    if (kind && HARNESS_KINDS[kind]?.test(c.msg)) { exempt++; continue; }
    judged.push({ c, kind, parentTree: parentTree(c) });
  }
  const verdicts = await pids.validate(judged);
  judged.forEach(({ c, kind }, i) => {
    const v = verdicts[i];
    if (v.ok) return;
    const subject = c.msg.split('\n')[0].slice(0, 80);
    open.push({ sha: c.sha, subject, why: kind ? `it says Studio-Harness: ${kind}, which isn't a commit the harness makes without hooks; ${v.why}` : v.why, merge: c.parents.length > 1 });
  });
  const single = open.filter((o) => !o.merge).map((o) => o.sha);
  await pids.need(single, 'p');
  await pids.need(single.filter((s) => !pids.get(s, 'p')), 's');
  for (const o of open) o.pid = o.merge ? null : pids.get(o.sha, 'p') || pids.get(o.sha, 's');

  let approved = [];
  let left = open;
  if (open.length && !ignoreApprovals) {
    const { ownerPublicKey, readApprovals, verifyApproval } = await import('./approve.mjs');
    const pub = ownerPublicKey(b.base);
    if (pub) {
      const signed = readApprovals().filter((a) => a.approval?.kind === 'hooks' && verifyApproval(a, pub));
      const ok = new Set(signed.flatMap((a) => (a.approval.commits || []).flatMap((x) => [x.sha, x.pid && `pid:${x.pid}`]).filter(Boolean)));
      approved = open.filter((o) => ok.has(o.sha) || (o.pid && ok.has(`pid:${o.pid}`)));
      left = open.filter((o) => !approved.includes(o));
    }
  }
  const why = left.length
    ? `${left.length} commit(s) since ${b.ref} skipped the git hooks (no valid ${TRAILER} stamp)${enforced ? '' : '; not enforced here: the hooks aren\'t installed in this checkout and the base has no stamped commits (npm run hooks:install; STUDIO_HOOKS_CHECK=on enforces)'}`
    : `every one of ${commits.length} commit(s) since ${b.ref} passed the hooks${exempt ? ` (${exempt} exempt: made before the stamping hooks or already in this checkout when it took them, or by the harness)` : ''}${approved.length ? ` (${approved.length} approved by the owner)` : ''}`;
  return { ok: !left.length || !enforced, enforced, base: b.ref, baseSha: b.base, checked: commits.length, open: left, approved, exempt, patchIds: pids.computed, why };
}

/** How to fix it, in commands that work in cmd, PowerShell and bash. */
export function fixText(open) {
  const oldest = open[open.length - 1]; // git log lists newest first
  return [
    'Re-commit them with the hooks (the hooks then check every change in them; fix what they refuse):',
    `  git reset --soft ${oldest.sha.slice(0, 12)}~1`,
    '  git commit -C ORIG_HEAD',
    '  (one commit with everything since; just the last commit: the same with HEAD~1)',
    'Hooks not installed? npm run hooks:install first. A commit the owner accepts as it is: on the owner\'s own device (one no agent runs on), npm run approve -- hooks --note "why". No owner key yet? npm run approve -- show says how the owner makes one; an agent never runs keygen.',
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'stamp') {
    try {
      const r = await stampMessage(arg);
      if (!r.stamp) console.error(`[commit-msg] note: no ${TRAILER} stamp on this commit: ${r.why}. The hooks gate will list it.`);
    } catch (e) {
      console.error(`[commit-msg] note: could not stamp this commit (${e.message}); the hooks gate will list it.`);
    }
    process.exit(0);
  }
  if (cmd === 'check') {
    let r;
    try { r = await checkHookStamps(); } catch (e) {
      if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: e.message, open: [], why: `could not check the commits: ${e.message}` }));
      else console.error(`[hooks] FAIL could not check the commits since the base: ${e.message}`);
      process.exit(1);
    }
    if (process.argv.includes('--json')) { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); }
    if (r.off) { console.log(`[hooks] ${r.why}`); process.exit(0); }
    const list = r.open.map((o) => `  ${o.sha.slice(0, 8)} ${o.subject} — ${o.why}`);
    if (!r.ok) {
      console.error(`[hooks] FAIL ${r.why}:`);
      console.error(list.join('\n'));
      console.error(fixText(r.open).map((l) => `[hooks] ${l}`).join('\n'));
      process.exit(1);
    }
    console.log(`[hooks] ${r.open.length ? 'note' : 'PASS'}: ${r.why}`);
    if (r.open.length) console.log(list.join('\n'));
    process.exit(0);
  }
  if (cmd === 'grandfather') {
    const r = await writeGrandfather();
    if (process.argv.includes('--json')) { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); }
    if (!r.ok) { console.error(`[hooks] FAIL ${r.why}`); process.exit(1); }
    console.log(`[hooks] PASS ${r.added} unstamped commit(s) on local branches added to the exempt list (${r.total} in all): ${r.file}`);
    process.exit(0);
  }
  console.log('Usage: node harness/hook-stamp.mjs check [--json] | stamp <message-file> | grandfather [--json]');
  process.exit(1);
}
