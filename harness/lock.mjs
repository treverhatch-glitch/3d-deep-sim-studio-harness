#!/usr/bin/env node
/**
 * harness/lock.mjs — Atomic claim/release locks
 * Owner is required and cannot be a shared default.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './event.mjs';

const LOCK_DIR = path.join(REPO_ROOT, '.studio', 'locks');
const SHARED_OWNERS = new Set(['', 'unknown', 'agent', 'cursor', 'default']);

function lockPath(key) {
  const safe = String(key).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(LOCK_DIR, `${safe}.lock`);
}

function assertOwner(owner) {
  const value = String(owner || '').trim();
  if (SHARED_OWNERS.has(value.toLowerCase())) {
    return { ok: false, reason: 'owner-required', message: 'Pass a unique --owner. Shared names are rejected.' };
  }
  return { ok: true, owner: value };
}

export function claim(key, owner, ttlSec = 3600) {
  const check = assertOwner(owner);
  if (!check.ok) return check;
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const file = lockPath(key);
  const now = Date.now();
  const payload = {
    key,
    owner: check.owner,
    claimedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSec * 1000).toISOString(),
  };
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
    fs.closeSync(fd);
    return { ok: true, lock: payload };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    try {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (existing.expiresAt && Date.parse(existing.expiresAt) < now) {
        fs.unlinkSync(file);
        return claim(key, check.owner, ttlSec);
      }
      if (existing.owner === check.owner) return { ok: true, lock: existing, reused: true };
      return { ok: false, reason: 'claimed', lock: existing };
    } catch {
      return { ok: false, reason: 'claimed' };
    }
  }
}

export function release(key, owner) {
  const check = assertOwner(owner);
  if (!check.ok) return check;
  const file = lockPath(key);
  if (!fs.existsSync(file)) return { ok: true, released: false };
  try {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (existing.owner && existing.owner !== check.owner) {
      return { ok: false, reason: 'not-owner', lock: existing };
    }
  } catch {}
  fs.unlinkSync(file);
  return { ok: true, released: true };
}

export function status(key) {
  const file = lockPath(key);
  if (!fs.existsSync(file)) return { locked: false };
  try {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (existing.expiresAt && Date.parse(existing.expiresAt) < Date.now()) {
      fs.unlinkSync(file);
      return { locked: false, expired: true };
    }
    return { locked: true, lock: existing };
  } catch {
    return { locked: true };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [cmd, key, ...rest] = process.argv.slice(2);
  const ownerFlag = rest.indexOf('--owner');
  const owner = ownerFlag >= 0 ? rest[ownerFlag + 1] : '';
  const ttlFlag = rest.indexOf('--ttl');
  const ttl = ttlFlag >= 0 ? Number(rest[ttlFlag + 1]) : 3600;
  if (!cmd || !key) {
    console.log('Usage: node harness/lock.mjs claim|release|status <key> --owner <unique-name>');
    process.exit(1);
  }
  if (cmd === 'claim') {
    const res = claim(key, owner, ttl);
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }
  if (cmd === 'release') {
    const res = release(key, owner);
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }
  if (cmd === 'status') {
    console.log(JSON.stringify(status(key), null, 2));
    process.exit(0);
  }
  process.exit(1);
}
