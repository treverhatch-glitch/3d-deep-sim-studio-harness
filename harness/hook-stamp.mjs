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
 * Context (2.59.0, H-13): a patch-id hashes the diff's context lines too, so a clean rebase onto a main that changed
 * lines within 3 lines of a commit's hunks changed it and the gate called the commit "changed after the hooks ran". The
 * commit-msg hook now also records the patch-id of the change without context (`git diff -U0`) in a second trailer,
 *   Studio-Patch-U0: p<id>      (s<id> with an old git; none for an empty commit or a merge)
 * and a commit whose tree and context patch-id no longer match passes when its -U0 patch-id does: exactly the same
 * added and removed lines, in the same files, in the same order. A stamp without that trailer (made before 2.59.0)
 * keeps the old rule. What a -U0 match can't see: where in a file the same lines sit, and the unchanged lines around
 * them. Those come from the commit's base, which is judged on its own (every commit since the base branch is; the
 * base branch's own commits passed their hooks when they were made), and every hook check judges the staged lines and
 * file names, not their position; the gates and task done judge the final tree whatever the stamps say.
 * A separate trailer (not a field in the Studio-Hooks line) so an older harness still reads the stamp as before; not
 * named Studio-Hooks-<x>, because git interpret-trailers matches a key by its prefix and replaced one with the other.
 *
 * Re-stamp (2.59.0): `npm run hooks -- restamp`, in a lane copy only, re-commits the lane's commits since the studio's
 * branch through the real hooks (from the oldest one whose stamp no longer matches), keeping the same trees, messages and
 * authors, after saving the old head as backup/<lane>-pre-restamp-<time>. It never writes a stamp itself: a commit the
 * hooks refuse stops it and the lane goes back to where it was. task done runs it (--auto) after its own rebase when a
 * commit's stamp was valid before the rebase and isn't after it (STUDIO_HOOKS_RESTAMP=off: never).
 *
 * Lane harness (2.59.0, #6): a lane copy runs its own committed harness/ and scripts/. When the studio's branch changed
 * files there since the lane branched, `check` refuses (it would judge with the old code: T-061 failed the hooks gate
 * again after the fix had landed) and names the files and the fix: rebase on the studio's branch. STUDIO_LANE_HARNESS=own
 * runs the lane's own copy anyway. The hooks only print that note at commit; they never block on it.
 *
 * Harness ref (2.60.0, #4): a studio that took an unmerged harness branch on the owner's say-so (its commits aren't on
 * the base branch yet, and the harness's own release commit carries no stamp) sets STUDIO_HARNESS_REF=<remote>/<branch>
 * in .env. Commits reachable from that branch as the remote reports it (git ls-remote; never a local branch or a
 * remote-tracking ref moved by hand) are exempt, and the output names the ref and commit used, or why it wasn't used.
 *
 *   node harness/hook-stamp.mjs check [--json]
 *   node harness/hook-stamp.mjs stamp <message-file>      (the commit-msg hook)
 *   node harness/hook-stamp.mjs grandfather [--json]      (list the commits this checkout already has as exempt)
 *   node harness/hook-stamp.mjs restamp [--json]          (npm run hooks -- restamp; in a lane copy)
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
export const HARNESS_KINDS = { 'experiment-drop': /^Studio-Experiment-Drop:\s*\S/m, 'config-from': /^Config-From:\s*\S/m };
/**
 * 2.65.0 (B-40): what a harness commit of each kind may change. A config-from commit (harness/config-proposal.mjs, made
 * on main right after a lane landed) changes only top-level studio/*.json and studio-proposals/*.json, one parent: any
 * other file, and the trailer exempts nothing.
 */
const HARNESS_FILES = { 'config-from': /^(studio\/[^/]+\.json|studio-proposals\/[^/]+\.json)$/ };
function harnessExempt(kind, c, cwd) {
  if (!kind || !HARNESS_KINDS[kind]?.test(c.msg)) return false;
  const rx = HARNESS_FILES[kind];
  if (!rx) return true;
  if ((c.parents || []).length !== 1) return false;
  const r = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--no-renames', c.sha], cwd ? { cwd } : {});
  const files = r.status === 0 ? r.stdout.split('\n').map((x) => x.trim()).filter(Boolean) : [];
  return files.length > 0 && files.every((f) => rx.test(f));
}
const HOOK_FILES = ['pre-commit', 'commit-msg', 'prepare-commit-msg'];
const HOOK_REL = 'scripts/hooks/commit-msg';
const MARKER = 'hook-stamp.mjs'; // a commit-msg hook that calls this file stamps commits
export const PASS_FILE = 'studio-hooks-pass';
export const AMEND_FILE = 'studio-hooks-amend';
const STAMP_RE = /^Studio-Hooks:[ \t]*v([0-9a-f]{8})[ \t]+t([0-9a-f]{12})[ \t]+(?:([ps])([0-9a-f]{12})|(empty)|(merge))[ \t]*$/gim;
/** 2.59.0 (H-13): the patch-id of the change without context lines (git diff -U0), beside the stamp. */
export const Z_TRAILER = 'Studio-Patch-U0';
const Z_RE = /^Studio-Patch-U0:[ \t]*([ps])([0-9a-f]{12})[ \t]*$/gim;

// The same diff, byte for byte, in the hook (git diff --cached) and in the gate (git log -p), whatever the user's config.
const GIT_CFG = ['-c', 'core.quotePath=true', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.relative=false',
  '-c', 'diff.suppressBlankEmpty=false', '-c', 'log.showSignature=false', '-c', 'color.ui=false', '-c', 'patchid.verbatim=false', '-c', 'patchid.stable=false'];
export const DIFF_OPTS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--diff-algorithm=myers', '--indent-heuristic', '-U3',
  '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/', '--binary', '--ignore-submodules=none', '--submodule=short'];
/** 2.59.0 (H-13): the same diff without context lines, for the Studio-Patch-U0 patch-id. */
export const DIFF_OPTS_Z = DIFF_OPTS.map((o) => (o === '-U3' ? '-U0' : o));
/** A pid mode: p (verbatim), s (stable), zp / zs (the same, without context). */
const diffOptsFor = (mode) => (String(mode).startsWith('z') ? DIFF_OPTS_Z : DIFF_OPTS);
const idModeOf = (mode) => String(mode || 'p').replace(/^z/, '');
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
    const pid = spawn('git', [...GIT_CFG, 'patch-id', idModeOf(mode) === 'p' ? '--verbatim' : '--stable'], { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
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
  const r = await pipePatchId(['-c', 'log.showRoot=true', 'log', '--no-walk=unsorted', '--stdin', '--no-merges', '-p', '--format=commit %H', ...diffOptsFor(mode)], mode, { cwd, stdinText: `${list.join('\n')}\n` });
  if (r.status !== 0) return out;
  for (const l of r.lines) { const [pid, sha] = l.split(/\s+/); if (sha && /^[0-9a-f]{40}/.test(pid)) out.set(sha, pid.slice(0, 12)); }
  return out;
}

/** A cache of patch-ids that computes only the ones asked for, in one streamed batch per mode. */
function pidStore(cwd = ROOT) {
  const cache = { p: new Map(), s: new Map(), zp: new Map(), zs: new Map() };
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
    /**
     * stampValid for many commits, computing only the patch-ids it looks at, in rounds: each dry run stops a commit at
     * the first id not computed yet, the ids asked for are computed in one batch per mode, and again. So the context-free
     * id (2.59.0) is computed only for a commit whose context id didn't match, never for every rebased commit.
     */
    async validate(list) {
      const NEED = Symbol('need');
      for (let round = 0; round < 6; round += 1) {
        const want = new Map();
        for (const { c, parentTree } of list) {
          try {
            stampValid(c, (sha, mode) => {
              const m = mode || 'p';
              if (cache[m].has(sha)) return cache[m].get(sha);
              throw { [NEED]: true, sha, m };
            }, parentTree);
          } catch (e) {
            if (!e?.[NEED]) throw e;
            if (!want.has(e.m)) want.set(e.m, new Set());
            want.get(e.m).add(e.sha);
          }
        }
        if (!want.size) break;
        for (const [m, shas] of want) await this.need([...shas], m);
      }
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
export async function stagedPatchId(parent, cwd = ROOT, { zero = false, mode = null } = {}) {
  for (const m of mode ? [mode] : ['p', 's']) {
    const r = await pipePatchId(['diff', '--cached', ...(zero ? DIFF_OPTS_Z : DIFF_OPTS), parent], m, { cwd });
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
/** 2.59.0 (H-13): the Studio-Patch-U0 ids in a message: [{ mode: 'p'|'s', pid }]. */
export function parseZ(msg) {
  return [...String(msg || '').matchAll(Z_RE)].map((m) => ({ mode: m[1], pid: m[2] }));
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
  // 2.59.0 (H-13): the same added and removed lines after a clean rebase whose new base changed the lines around them
  // (the context patch-id above hashes those too). Only for a stamp that recorded its -U0 id (Studio-Patch-U0); a stamp
  // from before keeps the rule above. Never for a merge or an empty stamp.
  if (!merge && stamps.some((s) => !s.merge && s.pid)) {
    for (const z of parseZ(c.msg)) if (pidOf(c.sha, `z${z.mode}`) === z.pid) return { ok: true, by: 'z' };
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
  if (harnessExempt(kind, h, cwd)) return { ok: true };
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
  let stripped = original.split(/\r?\n/).filter((l) => !/^(Studio-Hooks|Studio-Patch-U0):/i.test(l)).join('\n');
  if (!stripped.endsWith('\n')) stripped += '\n';
  if (stripped !== original) fs.writeFileSync(file, stripped);
  const tree = git(['write-tree'], { cwd }).stdout.trim();
  const ver = hooksVersion(cwd);
  let stamp = null;
  let zStamp = null;
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
        // 2.59.0 (H-13): and the same change's patch-id without context lines, so a clean rebase keeps the stamp valid.
        const z = pid ? await stagedPatchId(parent, cwd, { zero: true, mode: pid.mode }) : null;
        if (z) zStamp = `${z.mode}${z.id.slice(0, 12)}`;
      }
    }
  }
  if (stamp) {
    const r = git(['interpret-trailers', '--in-place', '--if-exists', 'replace', '--trailer', `${TRAILER}: ${stamp}`, ...(zStamp ? ['--trailer', `${Z_TRAILER}: ${zStamp}`] : []), file], { cwd });
    if (r.status !== 0) return { stamp: null, why: `git interpret-trailers failed: ${(r.stderr || '').trim()}` };
  }
  return { stamp, z: zStamp, why };
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

/** Is the hooks gate enforced: STUDIO_HOOKS_CHECK=on, the hooks installed here, or the base's recent history stamped. */
function hooksEnforced(base, env = process.env) {
  if (falsy(env.STUDIO_HOOKS_CHECK)) return false;
  return truthy(env.STUDIO_HOOKS_CHECK) || hooksInstalled() || /^Studio-Hooks:/im.test(git(['log', '-50', '--format=%B', base]).stdout);
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
 * 2.60.0 (#4): STUDIO_HARNESS_REF=<remote>/<branch> (set in .env by a person; for example upstream/claude/2591) names
 * an unmerged harness ref the owner told the studio to take. Its commits are the harness's, not the studio's, so they
 * are exempt like the base branch's, but only as the remote itself has them: <remote> must be a configured remote,
 * refs/remotes/<remote>/<branch> must exist (a local branch of that name doesn't count), and `git ls-remote` must
 * confirm <branch> on <remote>; the exempt commits are the ones reachable from the commit the remote reports (a
 * remote-tracking ref moved by hand to a local commit doesn't count). Asked only when a commit is unstamped. Can't
 * reach the remote: not used, and the output says why (the gate fails closed). Returns { declared, ref, ok, why, sha, shas }.
 */
export function declaredHarnessRef(env = process.env, root = ROOT) {
  if (String(env.STUDIO_HARNESS_REF || '').trim()) return String(env.STUDIO_HARNESS_REF).trim();
  const main = String(env.STUDIO_MAIN_ROOT || '').trim() ? path.resolve(env.STUDIO_MAIN_ROOT) : root;
  let found = '';
  for (const dir of [...new Set([root, main])]) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, '.env'), 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?STUDIO_HARNESS_REF\s*=\s*(.*?)\s*$/);
      if (m && m[1].replace(/^['"]|['"]$/g, '')) found = m[1].replace(/^['"]|['"]$/g, '');
    }
    if (found) return found;
  }
  return '';
}
export function harnessRefCommits(base, env = process.env, root = ROOT) {
  const ref = declaredHarnessRef(env, root);
  if (!ref) return { declared: false, ok: false, shas: new Set() };
  const no = (why) => ({ declared: true, ref, ok: false, why: `STUDIO_HARNESS_REF=${ref} not used: ${why}`, shas: new Set() });
  const m = ref.match(/^([\w.-]+)\/([\w./-]+)$/);
  if (!m || ref.includes('..')) return no('give it as <remote>/<branch>, for example upstream/claude/2591');
  const [, remote, branch] = m;
  const remotes = git(['remote'], { cwd: root }).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!remotes.includes(remote)) return no(`"${remote}" is not a configured remote (git remote -v)`);
  const tracking = git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}^{commit}`], { cwd: root }).stdout.trim();
  if (!isSha(tracking)) return no(`there is no remote-tracking branch ${remote}/${branch} (git fetch ${remote} ${branch}); a local branch of that name doesn't count`);
  const ls = spawnSync('git', ['ls-remote', '--heads', remote, `refs/heads/${branch}`], { cwd: root, encoding: 'utf8', timeout: Number(env.STUDIO_HARNESS_REF_TIMEOUT_MS) > 0 ? Number(env.STUDIO_HARNESS_REF_TIMEOUT_MS) : 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (ls.status !== 0) return no(`couldn't reach ${remote} to confirm it has ${branch} (${String(ls.stderr || ls.error?.code || 'timed out').trim().split('\n')[0].slice(0, 120)})`);
  const line = ls.stdout.split('\n').find((l) => l.endsWith(`\trefs/heads/${branch}`));
  const sha = line ? line.split('\t')[0].trim() : '';
  if (!isSha(sha)) return no(`${remote} has no branch ${branch}`);
  if (git(['cat-file', '-e', `${sha}^{commit}`], { cwd: root }).status !== 0) return no(`${remote}/${branch} is at ${sha.slice(0, 10)} on the remote, which this checkout doesn't have yet (git fetch ${remote})`);
  const shas = new Set(gitAll(['rev-list', sha, '--not', base], { cwd: root }).stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  return { declared: true, ref, ok: true, remote, branch, sha, shas, why: `STUDIO_HARNESS_REF=${ref} (${sha.slice(0, 10)}, confirmed on ${remote})` };
}

/**
 * The commits since the base that skipped the hooks.
 * { ok, enforced, off, base, checked, open: [{ sha, subject, why, pid }], exempt, approved, patchIds (commits patch-id'd), why }
 * Throws when the commit list is too big to read (never judges a list cut short).
 */
export async function checkHookStamps({ env = process.env, ignoreApprovals = false, range: given = null } = {}) {
  if (falsy(env.STUDIO_HOOKS_CHECK)) return { ok: true, off: true, enforced: false, open: [], why: 'off (STUDIO_HOOKS_CHECK=off): commits are not checked for skipped hooks' };
  // 2.59.0: restamp judges an explicit range (the lane before and after task done's rebase): { base, head } shas.
  const b = given ? { ref: given.base.slice(0, 8), base: given.base } : await changeBase(env);
  if (!b) return { ok: true, enforced: false, open: [], why: 'no base branch to compare with, so no commits to check' };
  const head = given ? given.head : headToJudge(env);
  const range = `${b.base}..${head}`;
  // Messages only (small); a list cut short would pass commits unchecked, so too big to read is an error (gitAll).
  const log = gitAll(['log', '--format=%x1e%H%x1f%T%x1f%P%x1f%B', range]);
  const commits = log.stdout.split('\x1e').filter((s) => s.includes('\x1f')).map((s) => {
    const [sha, tree, parents, msg] = s.split('\x1f');
    return { sha: sha.trim(), tree, parents: parents.trim() ? parents.trim().split(' ') : [], msg: msg || '' };
  });
  const enforced = hooksEnforced(b.base, env);
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
    if (harnessExempt(kind, c)) { exempt++; continue; }
    judged.push({ c, kind, parentTree: parentTree(c) });
  }
  const verdicts = await pids.validate(judged);
  judged.forEach(({ c, kind }, i) => {
    const v = verdicts[i];
    if (v.ok) return;
    const subject = c.msg.split('\n')[0].slice(0, 80);
    open.push({ sha: c.sha, subject, why: kind ? `it says Studio-Harness: ${kind}, which isn't a commit the harness makes without hooks; ${v.why}` : v.why, merge: c.parents.length > 1 });
  });
  // 2.60.0 (#4): the declared harness ref's own commits, as its remote has them, are the harness's (asked only now).
  let harnessRef = null;
  if (open.length) {
    harnessRef = harnessRefCommits(b.base, env, ROOT);
    if (harnessRef.ok) {
      const before = open.length;
      for (let i = open.length - 1; i >= 0; i--) if (harnessRef.shas.has(open[i].sha)) open.splice(i, 1);
      harnessRef.exempt = before - open.length;
      exempt += harnessRef.exempt;
    }
  }
  const refNote = !harnessRef?.declared ? '' : harnessRef.ok ? `; ${harnessRef.why}: ${harnessRef.exempt} harness commit(s) exempt` : `; ${harnessRef.why}`;
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
    ? `${left.length} commit(s) since ${b.ref} skipped the git hooks (no valid ${TRAILER} stamp)${enforced ? '' : '; not enforced here: the hooks aren\'t installed in this checkout and the base has no stamped commits (npm run hooks:install; STUDIO_HOOKS_CHECK=on enforces)'}${refNote}`
    : `every one of ${commits.length} commit(s) since ${b.ref} passed the hooks${exempt ? ` (${exempt} exempt: made before the stamping hooks or already in this checkout when it took them, or by the harness)` : ''}${approved.length ? ` (${approved.length} approved by the owner)` : ''}${refNote}`;
  const hr = harnessRef?.declared ? { ref: harnessRef.ref, used: harnessRef.ok, sha: harnessRef.sha || null, exempt: harnessRef.exempt || 0, why: harnessRef.why } : null;
  return { ok: !left.length || !enforced, enforced, base: b.ref, baseSha: b.base, checked: commits.length, open: left, approved, exempt, patchIds: pids.computed, harnessRef: hr, why };
}

// ---- 2.59.0 (#6): a lane copy whose harness is older than the studio's branch ----

/** Folders that hold the harness a lane copy runs (its gates, hooks and task done). */
export const LANE_HARNESS_DIRS = ['harness', 'scripts'];
const realOrResolved = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const samePath = (a, b) => { const n = (p) => (process.platform === 'win32' ? realOrResolved(p).toLowerCase() : realOrResolved(p)); return n(a) === n(b); };

/**
 * Is this checkout a lane copy (a git worktree of the main checkout: <main>/.lanes/<agent>, or STUDIO_MAIN_ROOT set to
 * another worktree of the same repository)? { root, main, branch } or null.
 */
export function laneOf(root = ROOT, env = process.env) {
  // Inside a git hook, git exports GIT_DIR / GIT_INDEX_FILE for the checkout committing: never let them point a command
  // meant for another checkout (the main one) back at this one.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(k)));
  const git = (args, { cwd }) => spawnSync('git', [...GIT_CFG, ...args], { cwd, encoding: 'utf8', env: clean });
  const gd = git(['rev-parse', '--absolute-git-dir'], { cwd: root }).stdout.trim();
  const cd = git(['rev-parse', '--git-common-dir'], { cwd: root }).stdout.trim();
  if (!gd || !cd) return null;
  const common = path.resolve(root, cd);
  if (samePath(gd, common)) return null; // the main checkout itself
  const fromPath = String(root).replace(/\\/g, '/').match(/^(.*)\/\.lanes\/[^/]+\/?$/);
  const candidates = [env.STUDIO_MAIN_ROOT, fromPath?.[1]].filter(Boolean).map((p) => path.resolve(p)).filter((p) => !samePath(p, root));
  for (const main of candidates) {
    const mc = git(['rev-parse', '--git-common-dir'], { cwd: main }).stdout.trim();
    if (!mc || !samePath(path.resolve(main, mc), common)) continue;
    const branch = git(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: main }).stdout.trim();
    if (branch) return { root, main, branch };
  }
  return null;
}

/**
 * The harness files the studio's branch changed since this lane copy branched from it (files the lane doesn't have):
 * { lane, branch, base, files } or null outside a lane copy (or when it can't tell). Files the lane changed itself
 * (a harness task) don't count: that is the lane's own work, judged by its own copy and then on landing.
 */
export function laneHarnessDrift(root = ROOT, env = process.env) {
  const lane = laneOf(root, env);
  if (!lane) return null;
  const tip = git(['rev-parse', '-q', '--verify', `refs/heads/${lane.branch}^{commit}`], { cwd: root }).stdout.trim();
  const base = tip ? git(['merge-base', 'HEAD', tip], { cwd: root }).stdout.trim() : '';
  if (!isSha(tip) || !isSha(base)) return null;
  if (base === tip) return { lane, branch: lane.branch, base, tip, files: [] };
  const d = git(['diff', '--name-only', '--no-renames', base, tip, '--', ...LANE_HARNESS_DIRS], { cwd: root });
  if (d.status !== 0) return null;
  return { lane, branch: lane.branch, base, tip, files: d.stdout.split('\n').map((s) => s.trim()).filter(Boolean) };
}

export const laneHarnessOwn = (env = process.env) => /^own$/i.test(String(env.STUDIO_LANE_HARNESS || ''));

/** The refusal (or note) for a lane copy running an older harness than the studio's branch. */
export function laneDriftText(d) {
  const shown = d.files.slice(0, 6).join(', ') + (d.files.length > 6 ? ` and ${d.files.length - 6} more` : '');
  return `this lane copy runs its own harness, and ${d.branch} has changed ${d.files.length} harness file(s) since the lane branched from it (${shown}), so its checks would judge with the old code. Rebase on it: git rebase ${d.branch} (then npm run hooks -- restamp if the hooks gate lists commits). STUDIO_LANE_HARNESS=own runs this copy's harness anyway.`;
}

// ---- 2.59.0: re-stamp a lane's commits through the real hooks ----

/**
 * Re-commit a lane copy's commits since the studio's branch through the real git hooks, from the oldest one whose stamp
 * is no longer valid (all of them with all=true): each commit's own tree, message and author, committed with
 * `git -c core.hooksPath=<this checkout>/scripts/hooks commit -C <commit>`, so pre-commit checks it and commit-msg
 * stamps it. Nothing is stamped by hand: a commit the hooks refuse (or leave unstamped) stops it, and the lane goes
 * back to where it was. The old head is kept as backup/<lane>-pre-restamp-<time> (auto: removed again on success).
 *
 * Refuses in the main checkout, with uncommitted changes, during a rebase/merge/cherry-pick, and over a merge commit.
 * auto (task done, after its rebase): only when the hooks gate is enforced here and every commit in was (the lane
 * before the rebase: { base, head }) had a valid stamp, so nothing that skipped the hooks is re-committed unasked.
 * Returns { ok, replayed, backup, why, ... }.
 */
export async function restamp({ cwd = ROOT, auto = false, all = false, base: givenBase = null, was = null, env = process.env, now = new Date() } = {}) {
  const g = (args, opts = {}) => git(args, { cwd, ...opts });
  if (g(['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') return { ok: false, why: 'not a git checkout' };
  const lane = laneOf(cwd, env);
  const gd = g(['rev-parse', '--absolute-git-dir']).stdout.trim();
  const common = path.resolve(cwd, g(['rev-parse', '--git-common-dir']).stdout.trim());
  if (samePath(gd, common)) return { ok: false, why: 'this is the main checkout: restamp only runs in a lane copy (.lanes/<agent>), whose commits reach the studio by task done. On the main checkout the hooks gate says how to re-commit by hand.' };
  for (const f of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if (fs.existsSync(path.join(gd, f))) return { ok: false, why: `a ${f.replace(/_HEAD$|-\w+$/, '').toLowerCase()} is in progress here; finish or abort it first` };
  }
  const dirty = g(['status', '--porcelain', '--untracked-files=no']).stdout.split('\n').filter((l) => l.length > 3);
  if (dirty.length) return { ok: false, why: `uncommitted changes (${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}${dirty.length > 3 ? ` +${dirty.length - 3}` : ''}): commit or set them aside first` };
  // 2.60.1 (B-32): the same base as the hooks check (changeBase: approve.mjs resolveBase, which in a lane copy is the
  // main checkout's local branch). Restamp took the lane's local main while the check took a stale origin/main, so it
  // said "nothing to do" while the check failed on main's own commits.
  const cb = givenBase ? null : await changeBase(env);
  const mainBranch = cb?.ref || lane?.branch || null;
  const base = givenBase || cb?.base || '';
  if (!isSha(base)) return { ok: false, why: 'no studio branch to re-stamp from (set STUDIO_MAIN_ROOT to the main checkout)' };
  const baseInfo = { baseRef: givenBase ? givenBase.slice(0, 8) : mainBranch, baseSha: base };
  const head = g(['rev-parse', 'HEAD']).stdout.trim();
  const branch = g(['symbolic-ref', '-q', '--short', 'HEAD']).stdout.trim();
  if (!branch) return { ...baseInfo, ok: false, why: 'HEAD is detached: check out the lane\'s branch first' };
  const list = g(['rev-list', '--reverse', '--topo-order', '--parents', `${base}..HEAD`]).stdout.split('\n').map((l) => l.trim().split(' ')).filter((a) => isSha(a[0]));
  if (!list.length) return { ...baseInfo, ok: true, replayed: 0, why: `no commits since ${mainBranch || base.slice(0, 8)}` };
  const judgeEnv = { ...env, STUDIO_HOOKS_CHECK: 'on' };
  if (auto && !hooksEnforced(base, env)) return { ...baseInfo, ok: true, replayed: 0, skipped: true, why: 'the hooks gate is not enforced here' };
  const now0 = await checkHookStamps({ env: judgeEnv, range: { base, head } });
  if (auto) {
    if (!now0.open.length) return { ...baseInfo, ok: true, replayed: 0, why: 'every stamp still matches' };
    if (!was || !isSha(was.base) || !isSha(was.head)) return { ...baseInfo, ok: true, replayed: 0, skipped: true, why: 'no record of the lane before the rebase' };
    const before = await checkHookStamps({ env: judgeEnv, range: was });
    if (before.open.length) return { ...baseInfo, ok: true, replayed: 0, skipped: true, why: `${before.open.length} commit(s) had no valid stamp before the rebase either; not re-committed (the hooks gate lists them)` };
  }
  const openSet = new Set(now0.open.map((o) => o.sha));
  const first = all ? 0 : list.findIndex(([sha]) => openSet.has(sha));
  if (first < 0) return { ...baseInfo, ok: true, replayed: 0, why: 'every stamp matches its commit; nothing to re-stamp (--all re-commits them anyway)' };
  const todo = list.slice(first);
  const merges = todo.filter((a) => a.length > 2);
  if (merges.length) return { ...baseInfo, ok: false, why: `${merges[0][0].slice(0, 8)} is a merge commit: rebase on ${mainBranch || 'the studio\'s branch'} first (git rebase flattens merges), then restamp` };
  const hooksDir = path.join(cwd, 'scripts', 'hooks');
  let commitMsgHook = '';
  try { commitMsgHook = fs.readFileSync(path.join(hooksDir, 'commit-msg'), 'utf8'); } catch {}
  if (!commitMsgHook.includes(MARKER)) return { ...baseInfo, ok: false, why: `scripts/hooks/commit-msg in this checkout doesn't stamp commits; nothing to re-stamp with` };
  const laneName = (lane ? path.basename(cwd) : branch).replace(/[^\w.-]+/g, '-');
  const t = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  let backup = `backup/${laneName}-pre-restamp-${t}`;
  for (let i = 2; g(['rev-parse', '-q', '--verify', `refs/heads/${backup}`]).status === 0; i += 1) backup = `backup/${laneName}-pre-restamp-${t}-${i}`;
  const mk = g(['branch', backup, head]);
  if (mk.status !== 0) return { ...baseInfo, ok: false, why: `could not keep the old head as ${backup}: ${(mk.stderr || '').trim()}` };
  const kept = auto ? null : backup; // task done's own run drops its backup again (success or not)
  const ident = auto || !g(['config', 'user.email']).stdout.trim() ? ['-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local'] : [];
  // Back to where the lane was (nothing of it changed).
  const restore = () => { g(['reset', '-q', '--hard', head]); if (auto) g(['branch', '-D', backup]); };
  const startAt = todo[0][1] || null;
  if (!startAt) return { ...baseInfo, ok: false, why: 'the lane\'s first commit is a root commit; nothing to re-stamp onto' };
  const rs = g(['reset', '-q', '--hard', startAt]);
  if (rs.status !== 0) { restore(); return { ...baseInfo, ok: false, backup: kept, why: `git reset failed: ${(rs.stderr || '').trim()}` }; }
  const treeOf = (rev) => g(['rev-parse', `${rev}^{tree}`]).stdout.trim();
  let n = 0;
  for (const [sha, parent] of todo) {
    const want = treeOf(sha);
    const rt = g(['read-tree', '-m', '-u', 'HEAD', sha]);
    if (rt.status !== 0 || g(['write-tree']).stdout.trim() !== want) {
      restore();
      return { ...baseInfo, ok: false, backup: kept, why: `could not bring ${sha.slice(0, 8)}'s files back: ${(rt.stderr || '').trim().split('\n').pop() || 'its tree differs'}` };
    }
    const empty = parent && treeOf(parent) === want;
    const prevHead = g(['rev-parse', 'HEAD']).stdout.trim();
    // The real hooks, from this checkout: pre-commit checks the change, commit-msg stamps it. Its output is shown.
    const c = spawnSync('git', [...ident, '-c', `core.hooksPath=${hooksDir}`, 'commit', '-q', '-C', sha, ...(empty ? ['--allow-empty'] : [])], { cwd, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    const after = commitInfo('HEAD', cwd);
    const out = `${c.stdout || ''}${c.stderr || ''}`.trim();
    if (c.status !== 0 || !after || after.sha === prevHead || after.parents[0] !== prevHead) {
      restore();
      return { ...baseInfo, ok: false, backup: kept, why: `the hooks refused ${sha.slice(0, 8)} (${(commitInfo(sha, cwd)?.msg || '').split('\n')[0].slice(0, 60)}): ${out.split('\n').slice(-6).join(' | ') || `exit ${c.status}`}. The lane is back where it was; fix what they refuse and commit, or ask the owner.` };
    }
    if (after.tree !== want || !parseStamps(after.msg).length) {
      restore();
      return { ...baseInfo, ok: false, backup: kept, why: `${sha.slice(0, 8)} was re-committed but ${after.tree !== want ? 'its files differ' : `the hooks gave it no stamp (${out.split('\n').filter((l) => /commit-msg/.test(l)).pop() || 'see the commit-msg output'})`}; the lane is back where it was` };
    }
    n += 1;
  }
  if (treeOf('HEAD') !== treeOf(head)) { restore(); return { ...baseInfo, ok: false, backup: kept, why: 'the re-committed lane\'s files differ from before; the lane is back where it was' }; }
  const check = await checkHookStamps({ env: judgeEnv, range: { base, head: g(['rev-parse', 'HEAD']).stdout.trim() } });
  if (check.open.length) { restore(); return { ...baseInfo, ok: false, backup: kept, why: `after re-committing, ${check.open.length} commit(s) still have no valid stamp (${check.open[0].why}); the lane is back where it was` }; }
  if (auto) g(['branch', '-D', backup]);
  return { ...baseInfo, ok: true, replayed: n, backup: kept, head: g(['rev-parse', 'HEAD']).stdout.trim(), from: head, why: `${n} commit(s) re-committed through the hooks${auto ? '' : `; the old head is kept as ${backup}`}` };
}

/** How to fix it, in commands that work in cmd, PowerShell and bash. */
export function fixText(open) {
  const oldest = open[open.length - 1]; // git log lists newest first
  return [
    'Re-commit them with the hooks (the hooks then check every change in them; fix what they refuse):',
    `  git reset --soft ${oldest.sha.slice(0, 12)}~1`,
    '  git commit -C ORIG_HEAD',
    '  (one commit with everything since; just the last commit: the same with HEAD~1)',
    'In a lane copy (.lanes/<agent>): npm run hooks -- restamp re-commits every commit since the studio\'s branch through the hooks, the same files and messages, and keeps the old head as a backup/ branch.',
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
    // 2.59.0 (#6): a note, never a refusal: the commit is the agent's work and must not be lost to a stale copy.
    try { const d = laneHarnessOwn() ? null : laneHarnessDrift(process.cwd()); if (d?.files.length) console.error(`[commit-msg] note: ${laneDriftText(d)}`); } catch {}
    process.exit(0);
  }
  if (cmd === 'check') {
    // 2.59.0 (#6): an older harness in a lane copy doesn't judge the lane's commits; the studio's branch has the fix.
    if (!falsy(process.env.STUDIO_HOOKS_CHECK)) {
      let d = null;
      try { d = laneHarnessDrift(); } catch {}
      if (d?.files.length && laneHarnessOwn()) console.error(`[hooks] note: STUDIO_LANE_HARNESS=own: judging with this lane copy's own harness, ${d.files.length} file(s) behind ${d.branch}`);
      else if (d?.files.length) {
        const why = laneDriftText(d);
        if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, staleHarness: d.files, open: [], why }));
        else console.error(`[hooks] FAIL ${why}`);
        process.exit(1);
      }
    }
    let r;
    try { r = await checkHookStamps(); } catch (e) {
      if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: e.message, open: [], why: `could not check the commits: ${e.message}` }));
      else console.error(`[hooks] FAIL could not check the commits since the base: ${e.message}`);
      process.exit(1);
    }
    if (process.argv.includes('--json')) { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); }
    if (r.off) { console.log(`[hooks] ${r.why}`); process.exit(0); }
    const list = r.open.map((o) => `  ${o.sha.slice(0, 8)} ${o.subject} — ${o.why}`);
    // 2.60.1 (B-32): which base was judged from, the same line restamp prints.
    if (r.baseSha) (r.ok ? console.log : console.error)(`[hooks] base ${r.base} ${String(r.baseSha).slice(0, 8)}`);
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
  if (cmd === 'restamp') {
    const flag = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : null);
    const auto = process.argv.includes('--auto');
    const was = flag('--was') && flag('--was-base') ? { head: flag('--was'), base: flag('--was-base') } : null;
    let r;
    try { r = await restamp({ auto, all: process.argv.includes('--all'), base: flag('--base'), was }); } catch (e) { r = { ok: false, why: e.message }; }
    if (process.argv.includes('--json')) { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); }
    if (r.baseSha) (r.ok ? console.log : console.error)(`[restamp] base ${r.baseRef} ${String(r.baseSha).slice(0, 8)}`);
    if (!r.ok) { console.error(`[restamp] FAIL ${r.why}${r.backup ? ` (old head kept as ${r.backup})` : ''}`); process.exit(1); }
    console.log(`[restamp] ${r.replayed ? 'PASS' : 'nothing to do'}: ${r.why}`);
    process.exit(0);
  }
  console.log('Usage: node harness/hook-stamp.mjs check [--json] | stamp <message-file> | grandfather [--json] | restamp [--all] [--json]');
  process.exit(1);
}
