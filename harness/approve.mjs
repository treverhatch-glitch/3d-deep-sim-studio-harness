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
import { REPO_ROOT, emitEvent } from './event.mjs';
import { canonicalBytes } from './hash.mjs';
import { matchAny } from './merge-lane.mjs';

export const OWNER_PUB_REL = 'studio/keys/owner-ed25519.pub.pem';
export const APPROVALS_REL = 'studio/approvals';
const PROTECTED_REL = 'studio/protected.json';
export const DEFAULT_PROTECTED = [
  'studio/protected.json', 'studio/keys/**', 'studio/gates.json', 'studio/bible/controls.json',
  'cartridges/*/qa.mjs', 'web/*/sim/qa.mjs', 'game/*/sim/qa.mjs', 'qa/regressions/**',
  'qa/controls-check.mjs', 'qa/protected-check.mjs', 'harness/approve.mjs',
  '**/tools/controls.gd', '**/tools/gate.gd', '.github/workflows/**',
  'scripts/hooks/**', 'harness/hook-stamp.mjs', 'harness/test-weakening.mjs',
];

// The repo to inspect. CI runs the base branch's copy of this checker against the PR's checkout
// (STUDIO_PROTECT_ROOT), so a branch can't weaken the check that judges it.
const ROOT = process.env.STUDIO_PROTECT_ROOT ? path.resolve(process.env.STUDIO_PROTECT_ROOT) : REPO_ROOT;
const git = (args, cwd = ROOT) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
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
  if (env.STUDIO_MAIN_ROOT) { const b = git(['symbolic-ref', '--short', 'HEAD'], env.STUDIO_MAIN_ROOT).stdout.trim(); if (b) return b; }
  try {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(k)));
    const g = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', env: clean }).stdout.trim();
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
export function resolveBase(env = process.env) {
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

const blobSha = (rel) => {
  const f = path.join(ROOT, rel);
  return fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'deleted';
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
  const committed = git(['diff', '--name-only', `${base}...HEAD`]).stdout.split('\n');
  const dirty = git(['status', '--porcelain', '--untracked-files=all']).stdout.split('\n').filter((l) => l.length > 3).map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''));
  const addOnly = addOnlyGlobs(base);
  const files = [...new Set([...committed, ...dirty].map((f) => f.trim()).filter(Boolean))]
    .filter((f) => matchAny(f, globs))
    .filter((f) => !(matchAny(f, addOnly) && !inBase(base, f) && fs.existsSync(path.join(ROOT, f))))
    .sort();
  return files.map((f) => ({ path: f, sha256: blobSha(f) }));
}

export const changeId = (changes) => crypto.createHash('sha256').update(canonicalBytes(changes.map((c) => [c.path, c.sha256]))).digest('hex');

export function readApprovals() {
  const dir = path.join(ROOT, APPROVALS_REL);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { return { file: `${APPROVALS_REL}/${f}`, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }; } catch { return null; } }).filter(Boolean);
}

export function verifyApproval(doc, publicPem) {
  try {
    return crypto.verify(null, Buffer.from(canonicalBytes(doc.approval)), crypto.createPublicKey(publicPem), Buffer.from(String(doc.signature), 'base64'));
  } catch {
    return false;
  }
}

/** Is this exact set of protected changes approved? { enforced, ok, changes, why } */
export function checkProtected({ env = process.env } = {}) {
  const b = resolveBase(env);
  if (!b) return { enforced: false, ok: true, changes: [], why: `no base branch to compare with and no owner key (${OWNER_PUB_REL}) committed, so protected files aren't enforced yet; ${OWNER_KEY_HOWTO}` };
  const pub = ownerPublicKey(b.base);
  const changes = protectedChanges(b.base);
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
  return { enforced: true, ok: false, changes, base: b.ref, change: id, why: `${changes.length} protected file(s) changed since ${b.ref} with no owner approval for exactly these contents${stale ? ' (an approval exists, but for different contents: the files changed after it was signed)' : ''}` };
}

/** A task done --force / --accepted-by for this task: is it signed by the owner? null = no owner key (not enforced). */
export function forceApproved(taskId, { env = process.env } = {}) {
  const b = resolveBase(env);
  const pub = ownerPublicKey(b?.base || null);
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
function writeApproval(name, approval) {
  const doc = { approval, signature: sign(approval) };
  const dir = path.join(ROOT, APPROVALS_REL);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${name}.json`);
  fs.writeFileSync(f, `${JSON.stringify(doc, null, 2)}\n`);
  return path.relative(ROOT, f).split(path.sep).join('/');
}

/** 2.58.2 (PU-29): sign the weakened tests (`tests`) or the commits that skipped the hooks (`hooks`) the gate lists now. */
async function approveListed(cmd, note, by) {
  const { changeBase, checkHookStamps } = await import('./hook-stamp.mjs');
  const b = await changeBase();
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
  emitEvent({ type: `approval.${cmd}`, agent: by, msg: `${by} approved ${items.length} ${cmd === 'tests' ? 'weakened test(s)' : 'commit(s) made without the hooks'}: ${note.slice(0, 200)}` });
  console.log(`Approved ${items.length} ${cmd === 'tests' ? 'weakened test(s)' : 'commit(s)'}. Commit ${file}. Anything else changed later needs a new approval.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  const flag = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : null);
  if (flag('--base')) process.env.STUDIO_PROTECT_BASE = flag('--base');
  const by = flag('--by') || process.env.USER || process.env.USERNAME || 'owner';
  const cmd = a[0] || 'show';
  try {
    if (cmd === 'keygen') {
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
      const b = resolveBase();
      if (!b) throw new Error('no base branch to compare with (--base <ref>)');
      const changes = protectedChanges(b.base);
      if (!changes.length) throw new Error(`no protected file changed since ${b.ref}`);
      const id = changeId(changes);
      for (const c of changes) console.log(`  ${c.path}  ${c.sha256 === 'deleted' ? 'deleted' : c.sha256.slice(0, 12)}`);
      const file = writeApproval(`protected-${id.slice(0, 16)}`, { kind: 'protected', change: id, files: changes, base: b.ref, by, note, at: new Date().toISOString() });
      emitEvent({ type: 'approval.protected', agent: by, msg: `${by} approved ${changes.length} protected change(s): ${note.slice(0, 200)}` });
      console.log(`Approved ${changes.length} protected change(s). Commit ${file} with them. Any later edit to these files needs a new approval.`);
    } else if (cmd === 'force') {
      const task = a[1];
      const reason = flag('--reason') || '';
      if (!/^[A-Z]+-\d+$/.test(task || '')) throw new Error('Usage: npm run approve -- force <T-ID> --reason "why it can close without its check"');
      if (reason.trim().length < 10) throw new Error('say why, in 10+ characters: --reason "…"');
      const file = writeApproval(`force-${task}`, { kind: 'force', task, reason, by, at: new Date().toISOString() });
      emitEvent({ type: 'approval.force', agent: by, task, msg: `${by} approved closing ${task} without its check: ${reason.slice(0, 200)}` });
      console.log(`Approved: ${task} may close with task done --force. Commit ${file}.`);
    } else if (cmd === 'tests' || cmd === 'hooks') {
      // 2.58.2 (PU-29): sign exactly what the gate lists now, by content, so the approval can't cover a later change.
      // Not awaited here: the checks import this module, which must finish loading first.
      const note = flag('--note') || '';
      if (note.trim().length < 10) throw new Error('say why, in 10+ characters: --note "…"');
      approveListed(cmd, note, by).catch((e) => { console.error(e.message); process.exit(1); });
    } else {
      console.log('Usage: npm run approve -- keygen | show | protected --note "…" | force <T-ID> --reason "…" | tests --note "…" | hooks --note "…"   [--base <ref>] [--by <name>]');
      console.log(`Owner only, on the owner's own device: ${OWNER_KEY_HOWTO}.`);
      process.exit(1);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
