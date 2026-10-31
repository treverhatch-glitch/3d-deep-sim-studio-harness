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
 * `file:` is accepted as an alias of `path:`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './event.mjs';

const LOCK_DIR = path.join(REPO_ROOT, '.studio', 'locks');
export const SHARED_OWNERS = new Set([
  '', 'unknown', 'agent', 'default', 'ai', 'bot', 'me', 'user', 'human',
  'cursor', 'claude', 'codex', 'gemini', 'grok', 'copilot', 'aider', 'windsurf', 'cline',
  'producer', 'builder', 'qa', 'qa-playtester', 'playtester', 'reviewer', 'designer', 'designer-calibrator', 'balancer',
]);

/** task:T-001 stays as is; path:/file: keys become path:<repo-relative posix path>. */
export function normalizeKey(key) {
  const raw = String(key || '').trim();
  const m = /^(path|file):(.*)$/.exec(raw);
  if (!m) return raw;
  let p = m[2].replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (path.isAbsolute(p)) p = path.relative(REPO_ROOT, p).replace(/\\/g, '/');
  return `path:${p}`;
}

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

function readLock(file) {
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (lock.expiresAt && Date.parse(lock.expiresAt) < Date.now()) {
      fs.rmSync(file, { force: true });
      return null;
    }
    return lock;
  } catch {
    return null;
  }
}

/**
 * A short studio-wide mutex around "check for overlapping folder locks, then write". Each lock file
 * is created atomically, but two agents claiming a folder and a file inside it at the same moment
 * could both pass the overlap check before either writes. Stale after 10 s (a crashed claimer).
 */
function withMutex(fn) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const mutex = path.join(LOCK_DIR, '.mutex');
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(mutex, 'wx'));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(mutex).mtimeMs > 10000) fs.rmSync(mutex, { force: true });
      } catch {
        /* gone already */
      }
      if (Date.now() > deadline) return { ok: false, reason: 'busy', message: 'Another agent is claiming right now; try again.' };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(mutex, { force: true });
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

function claimUnlocked(k, owner, ttlSec) {
  const check = { ok: true, owner };
  if (k.startsWith('path:')) {
    // A folder lock covers its files, and a file lock blocks locking its folder: refuse overlaps.
    const at = k.slice(5);
    const overlap = listLocks().find((l) => {
      if (!l.key.startsWith('path:') || l.owner === check.owner) return false;
      const other = l.key.slice(5);
      return other === '' || at === '' || at === other || at.startsWith(`${other}/`) || other.startsWith(`${at}/`);
    });
    if (overlap) return { ok: false, reason: 'claimed', lock: overlap };
  }
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const file = lockPath(k);
  const now = Date.now();
  const payload = { key: k, owner: check.owner, claimedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlSec * 1000).toISOString() };
  try {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { flag: 'wx' });
    return { ok: true, lock: payload };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const existing = readLock(file);
    if (!existing) return claimUnlocked(k, check.owner, ttlSec);
    if (existing.owner === check.owner) return { ok: true, lock: existing, reused: true };
    return { ok: false, reason: 'claimed', lock: existing };
  }
}

export function release(key, owner) {
  const check = assertOwner(owner);
  if (!check.ok) return check;
  const file = lockPath(key);
  const existing = fs.existsSync(file) ? readLock(file) : null;
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
    const lock = readLock(file);
    if (!lock || lock.owner !== owner || Date.parse(lock.expiresAt) >= until - 60000) continue;
    try {
      fs.writeFileSync(file, JSON.stringify({ ...lock, expiresAt: new Date(until).toISOString(), renewedAt: new Date().toISOString() }, null, 2));
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
    .filter(Boolean);
}

/** The path lock that covers a repo-relative file (the file itself or any parent folder), if any. */
export function coveringLock(relFile, locks = listLocks()) {
  const p = normalizeKey(`path:${relFile}`).slice(5);
  return locks
    .filter((l) => l.key.startsWith('path:'))
    .map((l) => ({ lock: l, at: l.key.slice(5) }))
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
