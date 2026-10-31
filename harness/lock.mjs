#!/usr/bin/env node
/**
 * harness/lock.mjs — atomic claim/release locks so two agents never edit the same thing.
 *
 *   node harness/lock.mjs claim   task:T-001        --owner cursor-win2 [--ttl 3600]
 *   node harness/lock.mjs claim   path:src/sim/     --owner codex-a      (a folder lock covers everything under it)
 *   node harness/lock.mjs release <key>             --owner <same owner>
 *   node harness/lock.mjs status  <key>
 *   node harness/lock.mjs list
 *   node harness/lock.mjs check-staged [--owner me]  (pre-commit: refuse staged files locked by someone else)
 *
 * Owners must be unique per running agent: tool and role names that several agents share are refused.
 * `file:` is accepted as an alias of `path:`. Paths are compared without regard to case (2.58.0, PU-43): on Windows
 * `game/Branding` and `game/branding` are one folder, so two agents can't hold it under two spellings.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { createExclusive, moveAside, onFsafeWarning, sweepTemps, withFileLock, writeAtomic } from './fsafe.mjs';

// 2.58.0 (PU-43): fsafe's warnings (a state file written in place because another program held it open) are logged
// as events too, not only printed to a console nobody may read. Every command that changes studio state loads this.
onFsafeWarning((msg, info) => emitEvent({ type: 'fsafe.warning', agent: process.env.STUDIO_LOCK_OWNER || 'harness', status: 'warn', target: info?.file ? path.relative(REPO_ROOT, info.file).replace(/\\/g, '/') : null, msg: String(msg).replace(/^\[fsafe\]\s*/, '') }));

const LOCK_DIR = path.join(REPO_ROOT, '.studio', 'locks');
/** 2.57.0 (PU-16, P-037): unreadable lock files are moved here (renamed, never deleted) once they are this old. */
export const BROKEN_DIR = path.join(LOCK_DIR, 'broken');
export const brokenGraceMs = () => {
  const v = Number(process.env.STUDIO_BROKEN_LOCK_GRACE_SEC);
  return (process.env.STUDIO_BROKEN_LOCK_GRACE_SEC !== undefined && process.env.STUDIO_BROKEN_LOCK_GRACE_SEC !== '' && Number.isFinite(v) ? v : 10) * 1000;
};
export const SHARED_OWNERS = new Set([
  '', 'unknown', 'agent', 'default', 'ai', 'bot', 'me', 'user', 'human',
  'cursor', 'claude', 'codex', 'gemini', 'grok', 'copilot', 'aider', 'windsurf', 'cline',
  'producer', 'builder', 'qa', 'qa-playtester', 'playtester', 'reviewer', 'designer', 'designer-calibrator', 'balancer',
]);

/** task:T-001 stays as is; path:/file: keys become path:<repo-relative posix path> (case kept as typed). */
export function normalizeKey(key) {
  const raw = String(key || '').trim();
  const m = /^(path|file):(.*)$/.exec(raw);
  if (!m) return raw;
  let p = m[2].replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (path.isAbsolute(p)) p = path.relative(REPO_ROOT, p).replace(/\\/g, '/');
  return `path:${p}`;
}

/** A path as compared between claims: lower case (Windows and macOS folders ignore case). */
export const foldPath = (p) => String(p || '').toLowerCase();

function lockPath(key) {
  const k = normalizeKey(key);
  const slug = k.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
  const digest = crypto.createHash('sha1').update(k).digest('hex').slice(0, 10);
  return path.join(LOCK_DIR, `${slug}.${digest}.lock`);
}

function assertOwner(owner) {
  const value = String(owner || '').trim();
  if (SHARED_OWNERS.has(value.toLowerCase())) {
    return { ok: false, reason: 'owner-required', message: `Pass a unique --owner (e.g. cursor-win2, claude-a). "${value}" is shared by many agents.` };
  }
  return { ok: true, owner: value };
}

/**
 * What a lock file holds: { lock, raw } (a claim), { expired, raw }, { broken, raw, ageMs } (empty, torn, or not a
 * claim), or { missing }. Never throws.
 */
function inspectLock(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true };
    return { broken: true, raw: null, ageMs: ageOf(file) };
  }
  let lock = null;
  try { lock = JSON.parse(raw); } catch { /* empty or half-written */ }
  if (!lock || typeof lock !== 'object' || typeof lock.key !== 'string') return { broken: true, raw, ageMs: ageOf(file), parsed: lock };
  if (lock.expiresAt && Date.parse(lock.expiresAt) < Date.now()) return { expired: true, raw, lock };
  return { lock, raw };
}
// Never negative: a file's mtime can be a fraction of a millisecond ahead of Date.now() (finer timestamp
// resolution), which made a grace of 0 skip a file written just before (seen in the 2.57.0 combined selftest).
function ageOf(file) {
  try { return Math.max(0, Date.now() - fs.statSync(file).mtimeMs); } catch { return 0; }
}

function readLock(file) {
  const seen = inspectLock(file);
  // An expired claim is removed, but only if it is still the one we read (another agent may have just re-claimed it).
  if (seen.expired) moveAside(file, null, seen.raw);
  return seen.lock && !seen.expired ? seen.lock : null;
}

/**
 * 2.57.0 (PU-16, P-037): move an unreadable lock file to .studio/locks/broken/<name>.<time> (kept for a look, never
 * deleted), only if it still holds what was read. Returns the new path, or null when it changed or couldn't move.
 */
function setAside(file, raw, why) {
  const dest = path.join(BROKEN_DIR, `${path.basename(file)}.${new Date().toISOString().replace(/[-:]/g, '').replace('.', '')}`);
  if (!moveAside(file, dest, raw === null ? undefined : raw)) return null;
  try {
    emitEvent({ type: 'lock.broken', agent: 'locks', status: 'warn', msg: `Set aside an unreadable lock file (${why}): .studio/locks/${path.basename(file)} → .studio/locks/broken/${path.basename(dest)}` });
  } catch { /* the move is what matters */ }
  return dest;
}

/**
 * 2.57.0 (PU-16): the watcher's sweep. Lock files that can't be read as JSON and are older than the grace
 * (STUDIO_BROKEN_LOCK_GRACE_SEC, 10) go to .studio/locks/broken/; temp files a killed writer left are removed.
 * Lock files that parse but aren't claims (the land lock's) are left alone. Returns the names set aside.
 */
export function sweepBrokenLocks({ graceMs = brokenGraceMs(), dryRun = false } = {}) {
  const out = [];
  if (!fs.existsSync(LOCK_DIR)) return out;
  for (const f of fs.readdirSync(LOCK_DIR).filter((x) => x.endsWith('.lock'))) {
    const file = path.join(LOCK_DIR, f);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let ok = true;
    try { ok = Boolean(JSON.parse(raw)) && typeof JSON.parse(raw) === 'object'; } catch { ok = false; }
    if (ok || (graceMs > 0 && ageOf(file) < graceMs)) continue;
    if (dryRun || setAside(file, raw, raw.trim() ? 'half-written' : 'empty')) out.push(f);
  }
  if (!dryRun) sweepTemps(LOCK_DIR);
  return out;
}

/**
 * A short studio-wide mutex around "check for overlapping folder locks, then write". Each lock file
 * is created atomically, but two agents claiming a folder and a file inside it at the same moment
 * could both pass the overlap check before either writes. 2.57.0 (PU-16): harness/fsafe.mjs's lock (a dead
 * holder's is broken at once, a stale one after 10 s).
 */
function withMutex(fn) {
  try {
    return withFileLock('claims', fn, { dir: LOCK_DIR, timeoutMs: 5000, what: 'Another agent claiming a folder' });
  } catch (err) {
    if (err.code !== 'ELOCKBUSY') throw err;
    return { ok: false, reason: 'busy', message: 'Another agent is claiming right now; try again.' };
  }
}

/** Top-level folders: claiming one blocks every other agent, so it needs a stated reason. */
export const WIDE_PATHS = new Set(['', 'studio', 'qa', 'cartridges', 'src', 'game', 'harness', 'hub', 'scripts', 'docs', 'tools', 'assets', 'public']);

export function claim(key, owner, ttlSec = 3600, { wide = null } = {}) {
  const check = assertOwner(owner);
  if (!check.ok) return check;
  const k = normalizeKey(key);
  if (k.startsWith('path:') && WIDE_PATHS.has(k.slice(5).replace(/\/+$/, '')) && !wide) {
    const at = k.slice(5).replace(/\/+$/, '');
    return { ok: false, reason: 'too-wide', message: `path:${at} is a whole top-level folder and would block every other agent. Claim the narrowest folder or file you will edit (for example path:${at || '<folder>'}/<subfolder or file>), or pass --wide "<why you need all of it>".` };
  }
  return k.startsWith('path:') ? withMutex(() => claimUnlocked(k, check.owner, ttlSec)) : claimUnlocked(k, check.owner, ttlSec);
}

function claimUnlocked(k, owner, ttlSec, again = false) {
  const check = { ok: true, owner };
  if (k.startsWith('path:')) {
    // A folder lock covers its files, and a file lock blocks locking its folder: refuse overlaps. 2.58.0 (PU-43):
    // compared without regard to case (game/Branding and game/branding were both granted; on Windows that is one
    // folder held by two agents).
    const at = foldPath(k.slice(5));
    const overlap = listLocks().find((l) => {
      if (!l.key.startsWith('path:') || l.owner === check.owner) return false;
      const other = foldPath(l.key.slice(5));
      return other === '' || at === '' || at === other || at.startsWith(`${other}/`) || other.startsWith(`${at}/`);
    });
    if (overlap) return { ok: false, reason: 'claimed', lock: overlap };
  }
  const file = lockPath(k);
  const now = Date.now();
  const payload = { key: k, owner: check.owner, claimedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlSec * 1000).toISOString() };
  // 2.57.0 (PU-16): the lock file appears already holding its payload (never empty, even if this process is killed).
  if (createExclusive(file, JSON.stringify(payload, null, 2))) return { ok: true, lock: payload };
  const seen = inspectLock(file);
  if (seen.lock && !seen.expired) {
    if (seen.lock.owner === check.owner) return { ok: true, lock: seen.lock, reused: true };
    return { ok: false, reason: 'claimed', lock: seen.lock };
  }
  // P-037: an unreadable lock file (an agent killed between creating and writing it, under an older harness) used
  // to make this recurse until the stack overflowed. Young: someone is writing it right now. Old: set it aside and
  // claim once more. Never more than one retry.
  if (seen.broken) {
    if (brokenGraceMs() > 0 && seen.ageMs < brokenGraceMs()) return { ok: false, reason: 'claimed', writing: true, lock: null, message: `${k} is claimed (lock being written): its lock file is still being written. Pick another task, or try again in a few seconds.` };
    setAside(file, seen.raw, seen.raw === null ? 'unreadable' : seen.raw.trim() ? 'half-written' : 'empty');
  } else if (seen.expired) moveAside(file, null, seen.raw);
  if (again) return { ok: false, reason: 'busy', lock: null, message: `${k} is changing hands right now; try again in a moment.` };
  return claimUnlocked(k, owner, ttlSec, true);
}

export function release(key, owner) {
  const check = assertOwner(owner);
  if (!check.ok) return check;
  let file = lockPath(key);
  let existing = fs.existsSync(file) ? readLock(file) : null;
  // 2.58.0 (PU-43): a folder claimed as game/Branding can be released as game/branding (the owner's own claim).
  if (!existing && normalizeKey(key).startsWith('path:')) {
    const want = foldPath(normalizeKey(key).slice(5));
    const mine = listLocks().find((l) => l.owner === check.owner && l.key.startsWith('path:') && foldPath(l.key.slice(5)) === want);
    if (mine) { file = lockPath(mine.key); existing = readLock(file); }
  }
  if (!existing) return { ok: true, released: false };
  if (existing.owner !== check.owner) return { ok: false, reason: 'not-owner', lock: existing };
  fs.rmSync(file, { force: true });
  return { ok: true, released: true };
}

/**
 * 2.30h: drop every lock an agent holds whose process is gone. `isDead(owner)` decides (the launcher's
 * session records); owners it doesn't know (a person, a CLI user) are never touched. Returns the keys freed.
 */
export function releaseDeadOwners(isDead) {
  const freed = [];
  for (const l of listLocks()) {
    if (!isDead(l.owner, l)) continue;
    fs.rmSync(lockPath(l.key), { force: true });
    freed.push(`${l.key} (${l.owner})`);
  }
  return freed;
}

/**
 * Extend every claim an owner holds to at least `ttlSec` from now. The launcher calls it on each
 * heartbeat, so a long task never loses its claim mid-work while the agent is alive (Jed's run: claims
 * ran out under a working agent and the watcher requeued its task).
 */
export function renewOwner(owner, ttlSec = 3600) {
  if (!owner || !fs.existsSync(LOCK_DIR)) return 0;
  const until = Date.now() + ttlSec * 1000;
  let n = 0;
  for (const f of fs.readdirSync(LOCK_DIR).filter((x) => x.endsWith('.lock'))) {
    const file = path.join(LOCK_DIR, f);
    const seen = inspectLock(file);
    const lock = seen.lock && !seen.expired ? seen.lock : null;
    if (!lock || lock.owner !== owner || Date.parse(lock.expiresAt) >= until - 60000) continue;
    try {
      // 2.57.0 (PU-16): renewed by replacing the file whole (a reader polling during a renew saw "unlocked" in
      // about 29% of reads when it was truncated and rewritten in place). Skipped if it was released meanwhile.
      if (fs.readFileSync(file, 'utf8') !== seen.raw) continue;
      writeAtomic(file, JSON.stringify({ ...lock, expiresAt: new Date(until).toISOString(), renewedAt: new Date().toISOString() }, null, 2), { fsync: false });
      n += 1;
    } catch {}
  }
  return n;
}

export function status(key) {
  const file = lockPath(key);
  const lock = fs.existsSync(file) ? readLock(file) : null;
  return lock ? { locked: true, lock } : { locked: false };
}

export function listLocks() {
  if (!fs.existsSync(LOCK_DIR)) return [];
  return fs
    .readdirSync(LOCK_DIR)
    .filter((f) => f.endsWith('.lock'))
    .map((f) => readLock(path.join(LOCK_DIR, f)))
    // Only claims: the land lock's files share the folder and the .lock ending, but have no key.
    .filter((l) => l && typeof l.key === 'string' && typeof l.owner === 'string');
}

/** The path lock that covers a repo-relative file (the file itself or any parent folder), if any. Case-blind (PU-43). */
export function coveringLock(relFile, locks = listLocks()) {
  const p = foldPath(normalizeKey(`path:${relFile}`).slice(5));
  return locks
    .filter((l) => l.key.startsWith('path:'))
    .map((l) => ({ lock: l, at: foldPath(l.key.slice(5)) }))
    .filter(({ at }) => at === '' || p === at || p.startsWith(`${at}/`))
    .sort((a, b) => b.at.length - a.at.length)[0]?.lock || null;
}

/** For pre-commit: staged files locked by another owner fail; STUDIO_LOCK_STRICT=1 also requires your own lock. */
export function checkStaged(owner, { strict = process.env.STUDIO_LOCK_STRICT === '1', files } = {}) {
  const staged = files || execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMRD'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const locks = listLocks();
  const problems = [];
  for (const file of staged) {
    const lock = coveringLock(file, locks);
    if (lock && lock.owner !== owner) problems.push(`${file} is locked by ${lock.owner} (${lock.key}, until ${lock.expiresAt})`);
    else if (!lock && strict) problems.push(`${file} has no lock. Run: node harness/lock.mjs claim path:${file} --owner ${owner || '<you>'}`);
  }
  return { ok: problems.length === 0, checked: staged.length, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [cmd, maybeKey, ...rest] = process.argv.slice(2);
  const all = process.argv.slice(2);
  const flag = (name) => (all.includes(name) ? all[all.indexOf(name) + 1] : undefined);
  const owner = flag('--owner') || process.env.STUDIO_LOCK_OWNER || '';
  const out = (res, ok = res.ok) => {
    console.log(JSON.stringify(res, null, 2));
    process.exit(ok ? 0 : 1);
  };
  if (cmd === 'list') out({ ok: true, locks: listLocks() });
  if (cmd === 'check-staged') {
    const res = checkStaged(owner);
    if (!res.ok) {
      console.error('[locks] FAIL');
      for (const p of res.problems) console.error(`  x ${p}`);
      process.exit(1);
    }
    console.log(`[locks] PASS ${res.checked} staged file(s)`);
    process.exit(0);
  }
  if (!cmd || !maybeKey || maybeKey.startsWith('--')) {
    console.log('Usage: node harness/lock.mjs claim|release|status <key> --owner <unique-name> | list | check-staged');
    process.exit(1);
  }
  if (cmd === 'claim') out(claim(maybeKey, owner, Number(flag('--ttl') || 3600), { wide: flag('--wide') || null }));
  if (cmd === 'release') out(release(maybeKey, owner));
  if (cmd === 'status') out(status(maybeKey), true);
  void rest;
  process.exit(1);
}
