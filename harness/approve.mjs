#!/usr/bin/env node
/**
 * harness/approve.mjs — 2.32.0: changes only the owner can approve, proved with the owner's signature.
 *
 * Agents can edit any file they can write, including the tests that judge them: in the Marina run a
 * protected-test list was re-initialised by agent commits, and changing a scenario's expected outcome
 * turned a broken game green. So some files are protected (studio/protected.json "globs"), and a change
 * to them lands only with an approval signed by the owner's key:
 *
 *   npm run approve -- keygen                       make the owner key pair, once, on the owner's own machine.
 *                                                   The private key goes to ~/.studio-owner/ (STUDIO_OWNER_KEY
 *                                                   to put it elsewhere), never into the repo and never on a
 *                                                   machine agents run on. Commit studio/keys/owner-ed25519.pub.pem.
 *   npm run approve -- show [--base <ref>]          the protected files this branch changes, and whether approved
 *   npm run approve -- protected --note "why" [--base <ref>]   sign exactly those changes (by content)
 *   npm run approve -- force <T-ID> --reason "why"  let task done --force / --accepted-by close that task
 *   npm run approve -- tests --note "why"           2.58.2 (PU-29): accept exactly the weakened tests listed now
 *                                                   (harness/test-weakening.mjs: a removed assert, a .skip, a wider tolerance…)
 *   npm run approve -- proposal <T-ID> --note "why" 2.65.0 (B-40): sign exactly the protected part of the lane's config
 *                                                   proposal (studio-proposals/<T-ID>.json in this checkout), so the
 *                                                   merge train applies it when the lane lands (harness/config-proposal.mjs)
 *   npm run approve -- hooks --note "why"           2.58.2 (PU-29): accept exactly the commits listed now that skipped
 *                                                   the git hooks (harness/hook-stamp.mjs), by commit and patch-id
 *
 * An approval is a file in studio/approvals/ (commit it with the change). It holds what was approved
 * (each protected file's path and content hash, or the task) and an Ed25519 signature. The check
 * (qa/protected-check.mjs) verifies it against the owner's public key read from the BASE branch, never
 * from the branch under review, so an agent can't swap in its own key; and the signed hashes must match
 * the files exactly, so an approval can't be reused for a different edit. Until the base branch has an
 * owner key, nothing is enforced (the check says so).
 *
 * PU-20: the check judges the working tree (committed, staged, unstaged and untracked protected files), also
 * when the base is at HEAD (nothing committed yet, or just pushed). With no base branch at all (no remote, on
 * the studio's own branch) it judges every change since the commit that set the owner key, file by file,
 * against the hashes the owner's approvals recorded, instead of passing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent, boardRoot } from './event.mjs';
import { canonicalBytes } from './hash.mjs';
import { proxyApprovalOk, proxyShell } from './owner-proxy.mjs';
import { betaActor, betaRecordVerdict } from './beta-mode.mjs';
import { ownerOnlyAction, ownerOnlyWhy } from './owner-acts.mjs';
import { matchAny, matchAnyFold } from './merge-lane.mjs';
import { protectRoot, trustedEnv, mainRootTrust } from './gate-trust.mjs';
import { TOOLCHAIN_GLOBS, toolchainProtected } from './test-toolchain.mjs';
import { gitEnv, gitRedirects, gitRedirectsWhy } from './gate-env.mjs';

export const OWNER_PUB_REL = 'studio/keys/owner-ed25519.pub.pem';
export const APPROVALS_REL = 'studio/approvals';
const PROTECTED_REL = 'studio/protected.json';
export const DEFAULT_PROTECTED = [
  'studio/protected.json', 'studio/keys/**', 'studio/beta.json', 'studio/gates.json', 'studio/bible/controls.json',
  'cartridges/*/qa.mjs', 'web/*/sim/qa.mjs', 'game/*/sim/qa.mjs', 'qa/regressions/**',
  'qa/controls-check.mjs', 'qa/protected-check.mjs', 'harness/approve.mjs',
  '**/tools/controls.gd', '**/tools/gate.gd', '.github/workflows/**',
  'scripts/hooks/**', 'harness/hook-stamp.mjs', 'harness/test-weakening.mjs',
  // 2.62.0: the replay bench's cases and graders (harness/bench.mjs).
  'studio/bench/**',
  // 2.64.0: the trigger table (harness/threads.mjs). studio/autonomy.json is not protected (the owner's rule).
  'studio/triggers.json',
  // 2.67.0: the owner's standing delegation to an outside agent (harness/delegation.mjs): an agent can't grant itself one.
  'studio/delegation.json',
  // 2.71.0: the studio policy (harness/policy.mjs): autonomous mode and the owner's rules; an agent can't turn it on.
  'studio/policy.json',
  // 2.73.0 (f): the outside overseer's stage (harness/overseer.mjs): an agent can't raise its own stage.
  'studio/overseer.json',
  // 2.79.1 (a): the owner's tools (harness/tool-registry.mjs): what the harness launches, with which keys; owner-only.
  'studio/tools.json',
  // 2.71.1 (A01b/A01d/A03): the gate runners and what they load, so a lane can't neuter the check that judges it
  // (harness/gate-trust.mjs and harness/test-toolchain.mjs decide what the gates trust, so they are here too).
  'scripts/run-gates.mjs', 'harness/gate-spawn.mjs', 'harness/game-gates.mjs', 'harness/silent-green.mjs', 'harness/cartridge.mjs',
  'harness/hash.mjs', 'harness/merge-lane.mjs', 'harness/gate-trust.mjs', 'harness/test-toolchain.mjs',
  'harness/ratchet.mjs', // 2.72.0 (b): the purity ratchet decides which hits stand
  'harness/verify-key.mjs', 'harness/golden-report.mjs', // 2.73.0 (g): which verify records and golden reports are the harness's
  'scripts/check-sim-*.mjs', 'qa/check-*.mjs', 'qa/fails-before.mjs', 'qa/vertical-slice.mjs', 'qa/run-python.mjs', 'qa/test-golden.py', 'qa/selftest*.mjs',
  // 2.71.1 (H03/H04/S02): each game's test toolchain (configs, .npmrc); the setup files they name and package.json's
  // test scripts are added from the base (harness/test-toolchain.mjs).
  ...TOOLCHAIN_GLOBS,
];

// The repo to inspect. CI runs the base branch's copy of this checker against the PR's checkout
// (STUDIO_PROTECT_ROOT), so a branch can't weaken the check that judges it.
// 2.71.1 (A16): never in a lane copy (harness/gate-trust.mjs): there the checker judges the lane itself.
const ROOT = protectRoot(REPO_ROOT) || REPO_ROOT;
// 2.71.1 (B, G10/G16): every git call here sees only this checkout, with replace refs ignored (harness/gate-env.mjs).
const git = (args, cwd = ROOT) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: gitEnv() });
/**
 * 2.58.5 (H-11): how the owner key gets made, said the same way wherever a check finds none. An agent asked to make it
 * on the agents' PC rightly refused (every agent there could then sign its own approvals); this says what to do instead.
 */
export const OWNER_KEY_HOWTO = `the owner makes the key once, on a device no agent runs on (not the PC the crew works on): `
  + `clone the studio there and run npm run approve -- keygen; commit only the public key ${OWNER_PUB_REL} and merge it to the studio's main branch. `
  + 'The private key stays on that device (~/.studio-owner/owner-ed25519.pem): never copy it to the agents\' PC, never commit it. '
  + 'Approvals (npm run approve -- protected | tests | hooks | force) are signed on that device too, and the approval file is committed. '
  + 'An agent never runs keygen';
export const ownerKeyPath = (env = process.env) => env.STUDIO_OWNER_KEY || path.join(os.homedir(), '.studio-owner', 'owner-ed25519.pem');

/** The protected globs: studio/protected.json at the base (so a branch can't shrink its own list), else the defaults. */
export function protectedGlobs(base = null) {
  const text = base ? git(['show', `${base}:${PROTECTED_REL}`]).stdout : (fs.existsSync(path.join(ROOT, PROTECTED_REL)) ? fs.readFileSync(path.join(ROOT, PROTECTED_REL), 'utf8') : '');
  try { const g = JSON.parse(text).globs; if (Array.isArray(g) && g.length) return g.map(String); } catch {}
  return DEFAULT_PROTECTED;
}

/** The owner's public key as the base branch has it (null: no key yet, nothing enforced). */
export function ownerPublicKey(base = null) {
  const pem = base ? git(['show', `${base}:${OWNER_PUB_REL}`]).stdout : (fs.existsSync(path.join(ROOT, OWNER_PUB_REL)) ? fs.readFileSync(path.join(ROOT, OWNER_PUB_REL), 'utf8') : '');
  return /BEGIN PUBLIC KEY/.test(pem || '') ? pem : null;
}

/**
 * 2.60.1 (B-30): the studio's branch when this checkout is a lane copy: STUDIO_MAIN_ROOT's branch (as before), else the
 * main checkout's branch found from the copy itself (a git worktree at <main>/.lanes/<x> of the same repository, as
 * hook-stamp.mjs laneOf finds it; not imported from there: hook-stamp.mjs imports this file while its own top level
 * still runs), so a sub-agent started without STUDIO_MAIN_ROOT judges against the same local branch. Null elsewhere.
 */
function studioBranchOfLane(env = process.env) {
  // 2.71.1 (G12): STUDIO_MAIN_ROOT counts only when it is this repository's main worktree, never this checkout itself.
  if (env.STUDIO_MAIN_ROOT && mainRootTrust(ROOT, env.STUDIO_MAIN_ROOT).ok) { const b = git(['symbolic-ref', '--short', 'HEAD'], env.STUDIO_MAIN_ROOT).stdout.trim(); if (b) return b; }
  try {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(k)));
    const g = (args, cwd) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', env: clean }).stdout.trim();
    const real = (p) => { try { const r = fs.realpathSync.native(p); return process.platform === 'win32' ? r.toLowerCase() : r; } catch { return path.resolve(p); } };
    const gd = g(['rev-parse', '--absolute-git-dir'], ROOT);
    const cd = g(['rev-parse', '--git-common-dir'], ROOT);
    if (!gd || !cd || real(gd) === real(path.resolve(ROOT, cd))) return null; // the main checkout itself
    const m = String(ROOT).replace(/\\/g, '/').match(/^(.*)\/\.lanes\/[^/]+\/?$/);
    if (!m) return null;
    const main = path.resolve(m[1]);
    const mc = g(['rev-parse', '--git-common-dir'], main);
    if (!mc || real(path.resolve(main, mc)) !== real(path.resolve(ROOT, cd))) return null;
    return g(['symbolic-ref', '-q', '--short', 'HEAD'], main) || null;
  } catch { return null; }
}

/**
 * Which branch to compare with: STUDIO_PROTECT_BASE, the PR's base in CI, the lane's studio branch, else origin/main.
 * PU-20: a base at HEAD itself (nothing committed since, or just pushed) is still used, so uncommitted edits are
 * judged; with no other branch at all (no remote, on the studio's own branch) the base is the last commit that
 * set the owner key, and changes since then are judged by the approvals' recorded hashes ({ byHash: true }).
 *
 * 2.60.1 (B-30, B-32): this is THE base for every check that judges "since the base": the protected and weakened-tests
 * gates, the hooks gate and `npm run hooks -- restamp` (hook-stamp.mjs changeBase), and task done (which runs those).
 * Restamp used the lane's local main while the hooks check took a stale origin/main, so restamp said "nothing to do"
 * while the check flagged main's own commits. Now:
 *   - in a lane copy (STUDIO_MAIN_ROOT, or a worktree at <main>/.lanes/<x>: hook-stamp.mjs laneOf), the main
 *     checkout's own branch, local, even when the lane is at its tip (a stale origin/main never wins there);
 *   - elsewhere, local main before origin/main when origin/main is an ancestor of it (main is ahead: origin is only
 *     stale), unless HEAD is on main itself (there origin/main still names what isn't pushed yet).
 * Which commits count as stamped is unchanged; only the base is.
 */
export function resolveBase(envIn = process.env) {
  // 2.71.1 (A09, S01): in a lane copy a named base (STUDIO_PROTECT_BASE, GITHUB_BASE_REF) is ignored (gate-trust.mjs).
  const env = trustedEnv(ROOT, envIn).env;
  const tries = [];
  const decisive = new Set([env.STUDIO_PROTECT_BASE].filter(Boolean));
  if (env.STUDIO_PROTECT_BASE) tries.push(env.STUDIO_PROTECT_BASE);
  if (env.GITHUB_BASE_REF) tries.push(`origin/${env.GITHUB_BASE_REF}`);
  const laneBranch = studioBranchOfLane(env);
  if (laneBranch) { tries.push(laneBranch); decisive.add(laneBranch); }
  const own = git(['symbolic-ref', '-q', '--short', 'HEAD']).stdout.trim();
  const sha = (ref) => git(['rev-parse', '-q', '--verify', `${ref}^{commit}`]).stdout.trim();
  const localFirst = own !== 'main' && /^[0-9a-f]{40}$/.test(sha('main')) && /^[0-9a-f]{40}$/.test(sha('origin/main'))
    && git(['merge-base', '--is-ancestor', 'origin/main', 'main']).status === 0;
  tries.push(...(localFirst ? ['main', 'origin/main'] : ['origin/main', 'main']));
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(head)) return null;
  let atHead = null;
  for (const t of tries) {
    const mb = git(['merge-base', 'HEAD', t]).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(mb)) continue;
    if (mb !== head || decisive.has(t)) return { ref: t, base: mb };
    if (!atHead && t !== own) atHead = { ref: t, base: mb };
  }
  if (atHead) return atHead;
  const keyCommit = git(['log', '-1', '--format=%H', '--diff-filter=AM', 'HEAD', '--', OWNER_PUB_REL]).stdout.trim();
  if (/^[0-9a-f]{40}$/.test(keyCommit)) return { ref: `${keyCommit.slice(0, 8)} (the commit that set the owner key; no base branch)`, base: keyCommit, byHash: true };
  return null;
}

/**
 * 2.78.1 (B-120): the owner key that approvals are verified with for base `b` (resolveBase's answer): { pub, ref, from }.
 * The base's own key, as before. On the main checkout of a studio that doesn't push, the base is origin/main, which
 * never got the owner key (it was committed on main and never pushed), so `npm run approve -- hooks` wrote an approval
 * the hooks check could never verify ("2 commit(s) since origin/main skipped the git hooks"), while the train, whose
 * base is the local main, passed. Now, when the base has no key, the key-carrying base is used: the local main's
 * committed key, but only when the studio doesn't push there, which the harness reads from git itself (there is no
 * origin/main, or origin/main is an ancestor of main: main is ahead, origin is only stale) and only when the base is in
 * main's history (so main's key is the key of the history being judged). Which commits are judged is unchanged; only
 * which key verifies the owner's approvals of them. This is the key a train copy (base: the local main) reads, so
 * verify, the train and approve agree. A lane copy's base is the studio's branch (decisive), whose own key wins.
 * STUDIO_KEY_BASE=off: the base's key only (the 2.78.0 way).
 *
 * 2.78.2 (A-030): origin/main can hold commits local main doesn't (pull requests merged on GitHub, never pulled), so
 * "origin/main is an ancestor of main" missed, and so did "the base is in main's history" when the base came from
 * origin/main's side. The relation now: the key is always read from refs/heads/main (main's own history); the base
 * shares history with main; none of the base's commits that main lacks (main..base) touches the owner key file, so the
 * base's side never set or removed a key; and origin/main carries no other owner key (none, or main's). A base whose
 * own side changed the key, or an origin/main with a different key, gets none. STUDIO_KEY_BASE=ancestor: 2.78.1's rule.
 */
const pemKey = (p) => String(p || '').replace(/\r\n/g, '\n').trim();
export function keyFor(b, env = process.env) {
  if (!b?.base) return { pub: null, ref: null, from: 'none' };
  const own = ownerPublicKey(b.base);
  if (own) return { pub: own, ref: b.ref, from: 'base' };
  const mode = String(env.STUDIO_KEY_BASE || '').trim().toLowerCase();
  const none = { pub: null, ref: b.ref, from: 'none' };
  if (/^(off|0|false|no)$/.test(mode)) return none;
  const sha = (ref) => git(['rev-parse', '-q', '--verify', `${ref}^{commit}`]).stdout.trim();
  const main = sha('refs/heads/main');
  if (!/^[0-9a-f]{40}$/.test(main)) return none;
  const origin = sha('refs/remotes/origin/main');
  const pub = ownerPublicKey(main);
  if (!pub) return none;
  if (mode === 'ancestor') {
    const noPush = !origin || git(['merge-base', '--is-ancestor', origin, main]).status === 0;
    if (!noPush || git(['merge-base', '--is-ancestor', b.base, main]).status !== 0) return none;
    return { pub, ref: `main ${main.slice(0, 8)}`, from: 'main' };
  }
  if (!/^[0-9a-f]{40}$/.test(git(['merge-base', b.base, main]).stdout.trim())) return none;
  const keyTouched = git(['log', '-1', '--format=%H', `${main}..${b.base}`, '--', OWNER_PUB_REL]);
  if (keyTouched.status !== 0 || keyTouched.stdout.trim()) return none;
  if (origin) { const op = ownerPublicKey(origin); if (op && pemKey(op) !== pemKey(pub)) return none; }
  return { pub, ref: `main ${main.slice(0, 8)}`, from: 'main' };
}

/**
 * 2.78.2 (B-120 again, A-030): THE base and key every approval kind is made and judged with: resolveBase's base and
 * keyFor's key ({ ...base, key }). `exact`: a kind whose enforcement starts with the key (protected files, weakened
 * tests). When the key came from local main (the base has none: a studio that doesn't push, or an origin/main with
 * merges main lacks), those are judged since the key-carrying base, local main (git merge-base HEAD main), the base a
 * lane copy and a train copy use. Without it `approve -- protected` on the main checkout (or in a checkout outside
 * .lanes/) signed the change set since origin/main, which also held main's own protected commits since then, so its
 * change id never matched the set the train judges since local main. The range only shrinks (merge-base HEAD main
 * descends from the old base): commits main already has are not judged again. The hooks gate keeps its base (it is
 * enforced without a key) and only takes the key. STUDIO_KEY_BASE=off: the 2.78.0 reading for every kind.
 */
/**
 * 2.78.2: the owner's switch, STUDIO_MAIN_CHECKOUT_ENFORCE (default off). Where the base has no owner key and the key
 * comes from local main (keyFor from 'main': in practice the main checkout of a studio that doesn't push), 2.78.1 did
 * not enforce protected files, weakened tests or `task done --force` there ("not enforced"), and the owner kept that
 * call for himself. judgeBase still gives every approve kind one base and key (so an approval signed there is the one
 * the train accepts); this only decides whether those three checks enforce on such a checkout. on: they do, with main's
 * key. The hooks gate is unchanged (enforced without a key since 2.58.2; 2.78.1 verifies its approvals with main's key).
 * Returns the key to enforce with, or null (not enforced).
 */
export const mainCheckoutEnforce = (env = process.env) => /^(on|1|true|yes)$/i.test(String(env.STUDIO_MAIN_CHECKOUT_ENFORCE || '').trim());
export function enforcingKey(b, env = process.env) {
  if (!b?.key) return null;
  if (b.key.from === 'main' && !mainCheckoutEnforce(env)) return null;
  return b.key.pub || null;
}

export function judgeBase(env = process.env, { exact = false } = {}) {
  const b = resolveBase(env);
  if (!b) return null;
  const key = keyFor(b, env);
  if (exact && key.from === 'main') {
    const mb = git(['merge-base', 'HEAD', 'refs/heads/main']).stdout.trim();
    if (/^[0-9a-f]{40}$/.test(mb)) return { ref: 'main', base: mb, key, movedFrom: b.ref };
  }
  return { ...b, key };
}

// 2.76.0 (B-93): a text file is hashed with LF line endings, as git stores it: a Windows checkout (core.autocrlf) has CRLF
// in the working tree, and an approval signed there never matched the check run in a checkout with LF. Binary files
// (a NUL byte) are hashed as they are.
const blobSha = (rel) => {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) return 'deleted';
  const b = fs.readFileSync(f);
  const norm = b.includes(0) ? b : Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return crypto.createHash('sha256').update(norm).digest('hex');
};

/** Globs where a NEW file needs no approval (a new regression only makes the judge stricter); edits and deletes still do. */
export function addOnlyGlobs(base = null) {
  const text = base ? git(['show', `${base}:${PROTECTED_REL}`]).stdout : (fs.existsSync(path.join(ROOT, PROTECTED_REL)) ? fs.readFileSync(path.join(ROOT, PROTECTED_REL), 'utf8') : '');
  try { const g = JSON.parse(text).addOnly; if (Array.isArray(g)) return g.map(String); } catch {}
  return ['qa/regressions/**'];
}
const inBase = (base, f) => git(['cat-file', '-e', `${base}:${f}`]).status === 0;

/** Protected files changed since base (committed or not), each with its content hash now. */
export function protectedChanges(base, globs = protectedGlobs(base)) {
  // 2.71.1 (B, G14/W01): names as git stores them (-z, never quoted), both sides of a rename, and globs matched in any
  // case and spelling (merge-lane.mjs matchAnyFold): a non-ASCII or case-variant path no longer slips past the list.
  const committed = git(['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', `${base}...HEAD`]).stdout.split('\0');
  const st = git(['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']).stdout.split('\0');
  const dirty = st.filter((e) => e.length > 3).map((e) => e.slice(3));
  const addOnly = addOnlyGlobs(base);
  const all = [...new Set([...committed, ...dirty].map((f) => f.trim()).filter(Boolean))];
  // 2.71.1 (H03/H04/S02): the setup files the base's test configs name, and package.json's test entries (by key).
  const tc = toolchainChanges(base, all);
  const files = all
    .filter((f) => matchAnyFold(f, [...globs, ...tc.globs]))
    .filter((f) => !(matchAny(f, addOnly) && !inBase(base, f) && fs.existsSync(path.join(ROOT, f))))
    .sort();
  return [...files.map((f) => ({ path: f, sha256: blobSha(f) })), ...tc.keyed].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 2.71.1: harness/test-toolchain.mjs against this checkout (the base by git, the rest from the working tree). */
function toolchainChanges(base, changed) {
  try {
    return toolchainProtected({
      base, changed,
      show: (rev, f) => { const r = git(['show', `${rev}:${f}`]); return r.status === 0 ? r.stdout : null; },
      names: (rev) => git(['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', rev, '--', 'game', 'web']).stdout.split('\n').filter(Boolean),
      now: (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return null; } },
    });
  } catch { return { globs: [], keyed: [] }; }
}

export const changeId = (changes) => crypto.createHash('sha256').update(canonicalBytes(changes.map((c) => [c.path, c.sha256]))).digest('hex');

export function readApprovals() {
  const dir = path.join(ROOT, APPROVALS_REL);
  if (!fs.existsSync(dir)) return [];
  // 2.78.2 (h; the 2.79 audit D1.1): the real file name wins over a "file" key in the JSON, which could name another file.
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { return { ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), file: `${APPROVALS_REL}/${f}` }; } catch { return null; } }).filter(Boolean);
}

/** The Studio-Agent trailer of the last commit that touched rel ('' = a person's commit), or null when uncommitted. */
function committedByAgent(rel) {
  const r = git(['log', '-1', '--format=%H%x09%(trailers:key=Studio-Agent,valueonly,separator=%x2C)', '--', rel]);
  const line = String(r.stdout || '').trim();
  if (r.status !== 0 || !line) return null;
  return String(line.split('\t')[1] || '').trim();
}
/**
 * 2.79.1 (a): an approval whose files include an owner-only file (studio/tools.json: defining a tool is the owner's own
 * act, harness/owner-acts.mjs "tools") counts only with the owner key's signature: never beta mode's or the owner proxy's
 * record, whoever made it. The act it names, or null.
 */
export const OWNER_ONLY_FILES = Object.freeze({ 'studio/tools.json': 'tools' });
export const ownerOnlyFileIn = (approval) => (approval?.files || []).map((f) => String(f?.path || '').replace(/\\/g, '/')).find((f) => OWNER_ONLY_FILES[f]) || null;
export function verifyApproval(doc, publicPem) {
  if (!doc?.signature && ownerOnlyFileIn(doc?.approval)) return false;
  // 2.73.1 (B-67): an approval the owner's proxy made (no signature; the owner-signed proxy grant embedded) counts while
  // that grant is still the one on file and the owner's yes is recorded (harness/owner-proxy.mjs).
  // A committed proxy approval also has to be the proxy's own commit (the commit-msg hook's Studio-Agent trailer: the
  // proxy's name, or none for a person): a builder's lane can't carry one in.
  // 2.78.2 (h; the 2.79 audit D1.1): a beta approval of any kind (protected files, weakened tests, hooks, a forced done)
  // is judged by the one beta predicate (beta-mode.mjs betaRecordVerdict): committed exactly as written, under the beta
  // session on now, not by a worker, and made by someone who may make that decision (permission.mjs mayDecide). Before,
  // an uncommitted one (committedByAgent null) passed: a builder could drop one in studio/approvals/, which lanes share.
  if (!doc?.signature && doc?.beta) return betaVerdict(doc).ok;
  if (!doc?.signature && doc?.proxy) {
    if (!proxyApprovalOk(doc, publicPem)) return false;
    const who = doc.file ? committedByAgent(doc.file) : null;
    return who === null || who === '' || who.toLowerCase() === String(doc.proxy.grant.agent).toLowerCase();
  }
  try {
    return crypto.verify(null, Buffer.from(canonicalBytes(doc.approval)), crypto.createPublicKey(publicPem), Buffer.from(String(doc.signature), 'base64'));
  } catch {
    return false;
  }
}

/** 2.78.2 (h): betaRecordVerdict for an approval read here (readApprovals: { file, ...doc }). */
export function betaVerdict(doc) {
  if (!doc?.file) return { ok: false, why: 'no file to find its commit', grandfathered: false };
  return betaRecordVerdict(ROOT, doc.file, doc);
}

/** Is this exact set of protected changes approved? { enforced, ok, changes, why } */
export function checkProtected({ env = process.env } = {}) {
  const note = trustedEnv(ROOT, env).note; // 2.71.1: an override a lane copy can't use is ignored, and said so
  const r = checkProtectedWith(env);
  return note ? { ...r, note } : r;
}
function checkProtectedWith(env) {
  // 2.71.1 (B, G10/G16/T01): replace refs or grafts make git show other commits or files than the committed ones (the
  // base branch's protected list, its owner key, main itself), in every lane copy of this git folder: never a pass.
  const redirects = gitRedirectsWhy(gitRedirects(ROOT));
  if (redirects) return { enforced: true, ok: false, changes: [], redirect: true, why: `${redirects}. Remove them (git replace -d <sha> for each, delete the grafts file) or hand the task back if you didn't add them` };
  // 2.78.2 (B-120 again): the base and key every approve kind uses (judgeBase): the key-carrying base's key, and the
  // change set since that base, so an approval made on the main checkout names the set a train copy judges.
  const b = judgeBase(env, { exact: true });
  if (!b) return { enforced: false, ok: true, changes: [], why: `no base branch to compare with and no owner key (${OWNER_PUB_REL}) committed, so protected files aren't enforced yet; ${OWNER_KEY_HOWTO}` };
  const pub = enforcingKey(b, env);
  const changes = protectedChanges(b.base);
  if (!pub && b.key.from === 'main') return { enforced: false, ok: true, changes, base: b.ref, why: `${b.movedFrom || b.ref} has no owner key (${OWNER_PUB_REL}), so protected files aren't enforced on this checkout, as before 2.78.2 (local main has the key and the train enforces it; STUDIO_MAIN_CHECKOUT_ENFORCE=on, the owner's switch, enforces it here too)` };
  if (!pub) return { enforced: false, ok: true, changes, base: b.ref, why: `${b.ref} has no owner key (${OWNER_PUB_REL}), so protected files aren't enforced yet: ${OWNER_KEY_HOWTO}` };
  if (!changes.length) return { enforced: true, ok: true, changes, base: b.ref, why: `no protected file changed since ${b.ref}, committed or not` };
  if (b.byHash) {
    // PU-20, no base branch: each changed file's content must be one an owner approval recorded (path + hash).
    const signed = readApprovals().filter((a) => a.approval?.kind === 'protected' && verifyApproval(a, pub));
    const ok = new Set(signed.flatMap((a) => (a.approval.files || []).map((f) => `${f.path}\n${f.sha256}`)));
    const open = changes.filter((c) => !ok.has(`${c.path}\n${c.sha256}`));
    if (!open.length) return { enforced: true, ok: true, changes, base: b.ref, why: `every protected file changed since ${b.ref} has contents an owner approval recorded` };
    const stale = open.some((c) => signed.some((a) => (a.approval.files || []).some((f) => f.path === c.path)));
    return { enforced: true, ok: false, changes: open, base: b.ref, change: changeId(changes), why: `${open.length} protected file(s) changed since ${b.ref} with no owner approval for exactly these contents${stale ? ' (an approval exists, but for different contents: the files changed after it was signed)' : ''}` };
  }
  const id = changeId(changes);
  const approved = readApprovals().filter((a) => a.approval?.kind === 'protected' && a.approval.change === id && verifyApproval(a, pub));
  if (approved.length) return { enforced: true, ok: true, changes, base: b.ref, why: `approved by ${approved[0].approval.by} (${approved[0].file})`, change: id };
  const stale = readApprovals().filter((a) => a.approval?.kind === 'protected' && verifyApproval(a, pub)).length;
  // 2.78.2 (h): a beta approval of exactly this set that doesn't count says why (not committed, a Producer's, …).
  const beta = readApprovals().find((a) => a.approval?.kind === 'protected' && a.approval.change === id && !a.signature && a.beta);
  const betaWhy = beta ? ` (${beta.file} doesn't count: ${betaVerdict(beta).why})` : '';
  return { enforced: true, ok: false, changes, base: b.ref, change: id, why: `${changes.length} protected file(s) changed since ${b.ref} with no owner approval for exactly these contents${stale ? ' (an approval exists, but for different contents: the files changed after it was signed)' : ''}${betaWhy}` };
}

/** A task done --force / --accepted-by for this task: is it signed by the owner? null = no owner key (not enforced). */
export function forceApproved(taskId, { env = process.env } = {}) {
  // 2.78.2: the key every approve kind is judged with (judgeBase); with the key from local main, enforced only with
  // STUDIO_MAIN_CHECKOUT_ENFORCE=on (enforcingKey), as 2.78.1 left it.
  const b = judgeBase(env);
  const pub = b ? enforcingKey(b, env) : ownerPublicKey(null);
  if (!pub) return null;
  const a = readApprovals().find((x) => x.approval?.kind === 'force' && x.approval.task === taskId && verifyApproval(x, pub));
  return a ? { ok: true, by: a.approval.by, reason: a.approval.reason, file: a.file } : { ok: false };
}

function sign(approval) {
  const keyFile = ownerKeyPath();
  if (!fs.existsSync(keyFile)) throw new Error(`no owner key at ${keyFile} on this machine. Approvals are signed only where the owner's private key is: ${OWNER_KEY_HOWTO}.`);
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'));
  return crypto.sign(null, Buffer.from(canonicalBytes(approval)), privateKey).toString('base64');
}
// 2.73.1 (B-67): the owner's yes the proxy records (--permission "<the owner's words, or a link to the message>").
let proxyPermission = '';
/**
 * Signed with the owner key where it is; otherwise, in the owner proxy's own shell (harness/owner-proxy.mjs), an
 * approval that carries the signed proxy grant and the owner's recorded yes instead of a signature.
 */
function signOrProxy(approval) {
  if (fs.existsSync(ownerKeyPath())) return { approval, signature: sign(approval) };
  // 2.79.1 (a): a change to an owner-only file (studio/tools.json) is approved with the owner key only: beta mode's agents,
  // an outside signer and the owner proxy are refused, with the reason, and nothing is written.
  { const own = ownerOnlyFileIn(approval); if (own) throw new Error(`${ownerOnlyWhy(ownerOnlyAction(OWNER_ONLY_FILES[own]))}: ${own} changes only with an approval signed by the owner key, on the owner's own device. Nothing was written.`); }
  // 2.76.0: in beta mode (harness/beta-mode.mjs) the owner's stand-ins approve without the key or per-step words; the
  // approval carries studio/beta.json and counts while beta mode is still on with it. Logged like every owner act.
  // 2.79 (c): --by names an outside signer in a shell the harness didn't launch and that names nobody (--by grokbot).
  const b = betaActor({ allowLane: true, kind: approval.kind, by: approval.by });
  // 2.78.2 (h): a protected decision a Producer/Director session may not make (or a worker) is refused, saying who may.
  if (b.refused) throw new Error(`${b.why} Nothing was written.`);
  if (b.ok) {
    const yes = String(proxyPermission || '').trim();
    // decides: the class it was made as (2.78.2); a record without it was made before 2.78.2 (see betaRecordVerdict).
    const a = { ...approval, recordedBy: String(b.who), via: b.via, decides: b.decides, ...(yes ? { permission: yes.slice(0, 500) } : {}) };
    emitEvent({ type: 'delegation.used', agent: String(b.who).slice(0, 60), msg: `${b.who} approved ${approval.kind} in beta mode${approval.note ? `: ${String(approval.note).slice(0, 160)}` : ''}`.slice(0, 400), meta: { beta: true, action: `approve-${approval.kind}`, by: approval.by } });
    import('./decisions-log.mjs').then((dm) => dm.logDecision({ action: `approve-${approval.kind}`, subject: approval.change || approval.task || approval.kind, by: String(b.doc.by).slice(0, 60), as: 'beta', why: String(approval.note || approval.reason || '').slice(0, 300), evidence: `${b.via} ${b.who}${yes ? `: ${yes.slice(0, 160)}` : ''}`, undo: null })).catch(() => {});
    return { approval: a, signature: null, beta: { by: b.doc.by, at: b.doc.at } };
  }
  const p = proxyShell({ allowLane: true });
  if (!p.ok) return { approval, signature: sign(approval) }; // throws the usual "no owner key on this machine"
  const yes = String(proxyPermission || '').trim();
  if (yes.length < 10) throw new Error(`the owner proxy (${p.doc.agent}) signs approvals only with the owner's yes recorded: --permission "<the owner's words, or a link to the message>" (10+ characters)`);
  const a = { ...approval, recordedBy: String(p.doc.agent), permission: yes.slice(0, 500), via: 'owner proxy' };
  emitEvent({ type: 'delegation.used', agent: String(p.doc.agent), msg: `${p.doc.agent} approved ${approval.kind} as the owner's proxy on ${p.doc.by}'s yes: "${yes.slice(0, 160)}"`.slice(0, 400), meta: { proxy: true, action: `approve-${approval.kind}`, permission: yes.slice(0, 300), by: approval.by } });
  import('./decisions-log.mjs').then((dm) => dm.logDecision({ action: `approve-${approval.kind}`, subject: approval.change || approval.task || approval.kind, by: String(approval.by || p.doc.by).slice(0, 60), as: dm.asOf ? dm.asOf({ via: 'outside agent', permission: yes }) : 'outside agent', why: String(approval.note || approval.reason || '').slice(0, 300), evidence: `owner proxy ${p.doc.agent}: ${yes.slice(0, 200)}`, undo: null })).catch(() => {});
  return { approval: a, signature: null, proxy: { grant: p.doc } };
}
/**
 * 2.78.2 (item 7c): the task an approval is for, so its event names it (the Line Producer releases a task held for its
 * protected step on an approval event for that task): in a lane copy the copy's own task (its branch in the main
 * checkout's .studio/lane-branches.json, or its session record), else the one task id the note names. null otherwise.
 */
function approvalTask(note = '') {
  try {
    const board = boardRoot();
    if (board !== REPO_ROOT) {
      const branch = git(['symbolic-ref', '-q', '--short', 'HEAD']).stdout.trim();
      const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
      const found = new Set();
      if (branch) {
        for (const [k, v] of Object.entries(read(path.join(board, '.studio', 'lane-branches.json')) || {})) if (/^[A-Z]+-\d+$/.test(k) && v === branch) found.add(k);
        const s = read(path.join(board, '.studio', 'agents', `${path.basename(ROOT)}.json`));
        if (s?.task && s.copy?.branch === branch) found.add(String(s.task));
      }
      if (found.size === 1) return [...found][0];
    }
  } catch {}
  const ids = [...new Set(String(note).match(/\b[A-Z]+-\d+\b/g) || [])];
  return ids.length === 1 ? ids[0] : null;
}
/** 2.78.2 (B-120 again): say so when the approval just written won't verify with the key the checks use. */
function checkSigned(rel, key) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    // 2.78.2 (h): a beta approval counts once committed (betaRecordVerdict); say so instead of "doesn't verify".
    if (!doc.signature && doc.beta) {
      const v = betaVerdict({ ...doc, file: rel });
      if (!v.ok && /isn't committed/.test(v.why)) { console.log(`Note: a beta-mode approval counts only once committed, exactly as written: commit ${rel} now (git add ${rel}, then git commit).`); return; }
      if (!v.ok) { console.log(`Note: ${rel} doesn't count: ${v.why}.`); return; }
      return;
    }
    if (!key?.pub) return;
    if (!verifyApproval({ file: rel, ...doc }, key.pub)) console.log(`Note: ${rel} does not verify with the owner key the checks read (${key.ref || 'the base'}${key.from === 'main' ? ', the key-carrying base' : ''}): it was signed with another key, or the stand-in's record doesn't count here. The checks will not accept it.`);
  } catch {}
}
function writeApproval(name, approval) {
  const doc = signOrProxy(approval);
  const dir = path.join(ROOT, APPROVALS_REL);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${name}.json`);
  fs.writeFileSync(f, `${JSON.stringify(doc, null, 2)}\n`);
  return path.relative(ROOT, f).split(path.sep).join('/');
}

/** 2.58.2 (PU-29): sign the weakened tests (`tests`) or the commits that skipped the hooks (`hooks`) the gate lists now. */
async function approveListed(cmd, note, by) {
  const { changeBase, checkHookStamps } = await import('./hook-stamp.mjs');
  // 2.78.2: tests are judged since judgeBase's base (as test-weakening.mjs findWeakenings); hooks keep their base.
  const b = (cmd === 'tests' ? judgeBase(process.env, { exact: true }) : null) || await changeBase();
  if (!b) throw new Error('no base branch to compare with (--base <ref>)');
  let items;
  if (cmd === 'tests') {
    const { findWeakenings, formatFinding } = await import('./test-weakening.mjs');
    items = (await findWeakenings()).findings.map(({ id, kind, file, text }) => ({ id, kind, file, text }));
    if (!items.length) throw new Error(`no weakened test since ${b.ref}`);
    for (const x of items) console.log(formatFinding({ ...x, line: '-' }));
  } else {
    items = (await checkHookStamps({ ignoreApprovals: true, env: { ...process.env, STUDIO_HOOKS_CHECK: 'on' } })).open.map(({ sha, pid, subject }) => ({ sha, pid: pid || null, subject }));
    if (!items.length) throw new Error(`no commit since ${b.ref} skipped the hooks`);
    for (const x of items) console.log(`  ${x.sha.slice(0, 8)} ${x.subject}`);
  }
  const id = crypto.createHash('sha256').update(canonicalBytes(items)).digest('hex');
  const file = writeApproval(`${cmd}-${id.slice(0, 16)}`, { kind: cmd, [cmd === 'tests' ? 'findings' : 'commits']: items, base: b.ref, by, note, at: new Date().toISOString() });
  const task = approvalTask(note);
  emitEvent({ type: `approval.${cmd}`, agent: by, ...(task ? { task } : {}), msg: `${by} approved ${items.length} ${cmd === 'tests' ? 'weakened test(s)' : 'commit(s) made without the hooks'}: ${note.slice(0, 200)}` });
  checkSigned(file, b.key || keyFor(b));
  console.log(`Approved ${items.length} ${cmd === 'tests' ? 'weakened test(s)' : 'commit(s)'}. Commit ${file}. Anything else changed later needs a new approval.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  const flag = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : null);
  if (flag('--base')) process.env.STUDIO_PROTECT_BASE = flag('--base');
  const by = flag('--by') || process.env.USER || process.env.USERNAME || 'owner';
  proxyPermission = flag('--permission') || '';
  const cmd = a[0] || 'show';
  try {
    if (cmd === 'keygen') {
      // 2.79 (c): keys and credentials stay the owner's own (harness/owner-acts.mjs): beta mode's agents, an outside signer
      // and the owner proxy are refused, with the reason.
      {
        const standIn = (() => { try { const p = proxyShell({ allowLane: true }); if (p.ok) return `${p.doc.agent} (the owner's proxy)`; } catch {} try { const x = betaActor({ allowLane: true, kind: 'board', by }); if (x.ok) return `${x.who} (${x.via})`; } catch {} return ''; })();
        if (standIn) throw new Error(`${ownerOnlyWhy(ownerOnlyAction('keygen'), standIn)}. Nothing was made`);
      }
      const keyFile = ownerKeyPath();
      if (fs.existsSync(keyFile) && !a.includes('--force')) throw new Error(`an owner key already exists at ${keyFile} (--force replaces it; old approvals stop verifying)`);
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      const pub = path.join(ROOT, OWNER_PUB_REL);
      fs.mkdirSync(path.dirname(pub), { recursive: true });
      fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
      console.log(`Owner key made. Private: ${keyFile} (keep it on this device only; never copy it to the PC agents run on, never commit it).\nPublic: ${OWNER_PUB_REL}. Commit only that file (git add ${OWNER_PUB_REL}) and merge it to the studio's main branch: from then on, protected files, weakened tests and commits that skipped the hooks change only with your approval, signed on this device.\nIf agents run on this device, this was the wrong place: delete ${keyFile} and ${OWNER_PUB_REL} and make the key on a device with no agents.`);
    } else if (cmd === 'show') {
      const r = checkProtected();
      console.log(`${r.ok ? 'OK' : 'NEEDS APPROVAL'}: ${r.why}`);
      for (const c of r.changes) console.log(`  ${c.path}  ${c.sha256 === 'deleted' ? 'deleted' : c.sha256.slice(0, 12)}`);
      process.exit(r.ok ? 0 : 3);
    } else if (cmd === 'protected') {
      const note = flag('--note') || '';
      if (note.trim().length < 10) throw new Error('say why, in 10+ characters: --note "…"');
      // 2.78.2 (B-120 again): the base and key the protected check uses (judgeBase), wherever this runs.
      const b = judgeBase(process.env, { exact: true });
      if (!b) throw new Error('no base branch to compare with (--base <ref>)');
      if (b.movedFrom) console.log(`  (judged since ${b.ref} ${b.base.slice(0, 8)}, the key-carrying base: ${b.movedFrom} has no owner key)`);
      const changes = protectedChanges(b.base);
      if (!changes.length) throw new Error(`no protected file changed since ${b.ref}`);
      const id = changeId(changes);
      for (const c of changes) console.log(`  ${c.path}  ${c.sha256 === 'deleted' ? 'deleted' : c.sha256.slice(0, 12)}`);
      const file = writeApproval(`protected-${id.slice(0, 16)}`, { kind: 'protected', change: id, files: changes, base: b.ref, by, note, at: new Date().toISOString() });
      const task = approvalTask(note);
      emitEvent({ type: 'approval.protected', agent: by, ...(task ? { task } : {}), msg: `${by} approved ${changes.length} protected change(s)${task && !note.includes(task) ? ` for ${task}` : ''}: ${note.slice(0, 200)}` });
      checkSigned(file, b.key);
      console.log(`Approved ${changes.length} protected change(s). Commit ${file} with them. Any later edit to these files needs a new approval.`);
      // 2.77.1 (H7): the train and the gates read approvals from the studio's main branch (a lane copy's studio/ is main's).
      console.log('Approvals are read from the studio\'s main branch (studio/approvals/): commit it on main, not only on a lane branch, or the merge train won\'t see it.');
    } else if (cmd === 'force') {
      const task = a[1];
      const reason = flag('--reason') || '';
      if (!/^[A-Z]+-\d+$/.test(task || '')) throw new Error('Usage: npm run approve -- force <T-ID> --reason "why it can close without its check"');
      if (reason.trim().length < 10) throw new Error('say why, in 10+ characters: --reason "…"');
      const file = writeApproval(`force-${task}`, { kind: 'force', task, reason, by, at: new Date().toISOString() });
      checkSigned(file, judgeBase()?.key);
      emitEvent({ type: 'approval.force', agent: by, task, msg: `${by} approved closing ${task} without its check: ${reason.slice(0, 200)}` });
      console.log(`Approved: ${task} may close with task done --force. Commit ${file}.`);
    } else if (cmd === 'proposal') {
      // 2.65.0 (B-40): the protected part of a lane's config proposal, by content (file, keys, values). Not awaited:
      // config-proposal.mjs imports modules that import this one, which must finish loading first.
      const task = a[1];
      const note = flag('--note') || '';
      if (!/^[A-Z]+-\d+$/.test(task || '')) throw new Error('Usage: npm run approve -- proposal <T-ID> --note "why" (in a checkout of the lane, or of main while the proposal is held there)');
      if (note.trim().length < 10) throw new Error('say why, in 10+ characters: --note "…"');
      import('./config-proposal.mjs').then((cp) => {
        const rel = cp.proposalRel(task);
        const f = path.join(ROOT, rel);
        if (!fs.existsSync(f)) throw new Error(`no ${rel} in this checkout`);
        const p = cp.parseProposal(fs.readFileSync(f, 'utf8'));
        if (!p.ok) throw new Error(`${rel} can't be applied: ${p.errors.join('; ')}`);
        const part = cp.protectedPart(p.changes, [...new Set([...cp.protectedGlobsAt(ROOT, 'HEAD'), ...protectedGlobs()])]);
        if (!part.changes.length) throw new Error(`${rel} changes no protected file: it needs no approval`);
        for (const c of part.changes) for (const [k, v] of Object.entries(c.set)) console.log(`  ${c.file}  ${k} = ${JSON.stringify(v).slice(0, 100)}`);
        const file = writeApproval(`proposal-${task}-${part.hash.slice(0, 12)}`, { kind: 'proposal', task, change: part.hash, changes: part.changes, by, note, at: new Date().toISOString() });
        checkSigned(file, judgeBase()?.key);
        emitEvent({ type: 'approval.proposal', agent: by, task, msg: `${by} approved ${task}'s protected config change(s) (${part.changes.map((c) => c.file).join(', ')}): ${note.slice(0, 200)}` });
        console.log(`Approved ${task}'s protected config change(s). Commit ${file} to the studio's main branch: the merge train applies the proposal when the lane lands (or npm run task -- train config ${task} if it is held on main). A different value needs a new approval.`);
      }).catch((e) => { console.error(e.message); process.exit(1); });
    } else if (cmd === 'tests' || cmd === 'hooks') {
      // 2.58.2 (PU-29): sign exactly what the gate lists now, by content, so the approval can't cover a later change.
      // Not awaited here: the checks import this module, which must finish loading first.
      const note = flag('--note') || '';
      if (note.trim().length < 10) throw new Error('say why, in 10+ characters: --note "…"');
      approveListed(cmd, note, by).catch((e) => { console.error(e.message); process.exit(1); });
    } else {
      console.log('Usage: npm run approve -- keygen | show | protected --note "…" | force <T-ID> --reason "…" | proposal <T-ID> --note "…" | tests --note "…" | hooks --note "…"   [--base <ref>] [--by <name>]');
      console.log(`Owner only, on the owner's own device: ${OWNER_KEY_HOWTO}.`);
      process.exit(1);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
