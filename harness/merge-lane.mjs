/**
 * harness/merge-lane.mjs — 2.30p: path-scoped gates, reused lane verify results, and a short land lock.
 *
 * Found in a live run with two tracks (a browser build under web/ and an engine build under godot/):
 *  - every `task done` ran every game gate, so an engine-only change spent ~11.6 min in browser checks;
 *  - with no merge lock, `deliver` re-ran every gate whenever the studio's branch had moved, so each
 *    landing restarted every other in-flight done (one chain ran 23 min and then failed);
 *  - the board (studio/NEXT.md) was read at the start of done and written ~11 min later, so a done
 *    could overwrite tasks other agents queued in between.
 *
 * Gate scope: a gate in <game>/studio.gates.json may declare "paths" (globs, repo-relative) and a
 * "track" name. The manifest may declare "shared" globs: a change there runs every gate. A gate with no
 * "paths" always runs (old manifests behave exactly as before). Harness, scripts, studio/gates.json,
 * package files and the manifest itself are always shared.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { busyCode } from './fsafe.mjs';

export const ALWAYS_SHARED = ['harness/**', 'scripts/**', 'studio/gates.json', 'package.json', 'package-lock.json'];

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/** Glob → RegExp: ** any depth, * one segment, ? one char; a bare folder ("web/") covers what's under it. */
export function globRe(glob) {
  let g = norm(glob);
  if (!/[*?]/.test(g)) g = `${g}{,/**}`;
  let re = '';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += g[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += g[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (g.startsWith('{,/**}', i)) { re += '(?:/.*)?'; i += 5; }
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
export const matchAny = (file, globs = []) => globs.some((g) => globRe(g).test(norm(file)));

/**
 * Which gates a change runs. changed: repo-relative files (null/empty = unknown → everything runs).
 * Returns { run, skipped: [{ id, why }], all: bool }.
 */
export function selectGates(gates, changed, { shared = [] } = {}) {
  const files = (changed || []).map(norm).filter(Boolean);
  if (!files.length) return { run: gates, skipped: [], all: true, why: 'no diff known: every gate runs' };
  const sharedAll = [...ALWAYS_SHARED, ...shared];
  const hitShared = files.find((f) => matchAny(f, sharedAll));
  if (hitShared) return { run: gates, skipped: [], all: true, why: `${hitShared} is shared: every gate runs` };
  const run = [];
  const skipped = [];
  for (const g of gates) {
    if (!g.paths?.length) { run.push(g); continue; }
    const hit = files.find((f) => matchAny(f, g.paths));
    if (hit) run.push(g);
    else skipped.push({ id: g.id, why: `none of the ${files.length} changed file(s) are in its paths (${g.paths.join(', ')})${g.track ? `; track ${g.track}` : ''}` });
  }
  return { run, skipped, all: skipped.length === 0 };
}

/** The scope a passing run covers: the union of the gates' paths, or null (= everything) if any gate was unscoped. */
export function scopeOf(ranGates, shared = []) {
  if (ranGates.some((g) => !g.paths?.length)) return null;
  return [...new Set([...ranGates.flatMap((g) => g.paths), ...shared, ...ALWAYS_SHARED])];
}

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
export const changedSince = (cwd, base, head = 'HEAD') => {
  if (!base) return [];
  const r = git(cwd, 'diff', '--name-only', `${base}..${head}`);
  return r.status === 0 ? r.stdout.split('\n').map(norm).filter(Boolean) : [];
};

// ---- lane verify results -------------------------------------------------------------------------

const passFile = (root, taskId) => path.join(root, '.studio', 'gate-pass', `${String(taskId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
export function recordPass(root, taskId, rec) {
  const f = passFile(root, taskId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ task: taskId, at: new Date().toISOString(), ...rec }, null, 2));
}
export function readPass(root, taskId) {
  try { return JSON.parse(fs.readFileSync(passFile(root, taskId), 'utf8')); } catch { return null; }
}
export function clearPass(root, taskId) {
  try { fs.rmSync(passFile(root, taskId), { force: true }); } catch {}
}

/**
 * After a clean rebase: may the earlier pass stand? Only when it was recorded for the lane's pre-rebase
 * commit, it had a scope, and none of the incoming main-branch files touch that scope.
 */
export function canReuse(rec, { head, incoming }) {
  if (process.env.STUDIO_GATE_REUSE === 'off') return { ok: false, why: 'STUDIO_GATE_REUSE=off' };
  if (!rec) return { ok: false, why: 'no recorded pass' };
  if (rec.head !== head) return { ok: false, why: `the pass was for ${String(rec.head).slice(0, 8)}, the lane is at ${String(head).slice(0, 8)}` };
  if (!rec.scope) return { ok: false, why: 'the pass ran an unscoped gate (it covers everything)' };
  const hit = (incoming || []).find((f) => matchAny(f, rec.scope));
  if (hit) return { ok: false, why: `the studio's branch changed ${hit}, inside this lane's gate scope` };
  return { ok: true, why: `${(incoming || []).length} incoming file(s), all outside this lane's gate scope` };
}

// ---- the short land lock -------------------------------------------------------------------------

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * Run fn while holding <root>/.studio/locks/land.lock: only the final rebase check, the fast-forward and
 * the board write go in here (seconds), never the gates. A lock older than STUDIO_LAND_LOCK_STALE_MS
 * (120 s) or held by a dead process is broken. 2.58.0 (P-043): on Windows, creating or removing the lock file
 * while another process removes or creates it can fail with EPERM/EACCES/EBUSY ("delete pending"); that counts
 * as busy and is retried with a short backoff (it crashed about 2 Windows CI runs in 5). `busy` is for tests.
 */
const held = new Map();

/**
 * 2.31.0 (Gap 3): gate slots. Heavy game checks (the game's own gates, the Godot engine gate) take one of
 * STUDIO_GATE_SLOTS (2) box-wide slots in <root>/.studio/locks/gate-slot-<n>.lock while they run, so two
 * tracks (web and Godot) check in parallel but five lanes don't pile onto one machine and time out (the
 * Marina run: 600 s gate timeouts at load ~25 on 8 cores). The wait for a slot is logged and never counts
 * toward a gate's own timeout. A slot held by a dead process, or older than STUDIO_GATE_SLOT_STALE_MIN
 * (120), is taken over. After STUDIO_GATE_SLOT_WAIT_MIN (60) of waiting the gate runs anyway, with a note.
 * STUDIO_GATE_SLOTS=0 turns slots off.
 */
export function withGateSlot(root, label, fn, { log = () => {}, env = process.env } = {}) {
  const n = Number(env.STUDIO_GATE_SLOTS ?? 2);
  if (!(n > 0)) return fn();
  const dir = path.join(root, '.studio', 'locks');
  fs.mkdirSync(dir, { recursive: true });
  const staleMs = Number(env.STUDIO_GATE_SLOT_STALE_MIN ?? 120) * 60000;
  const deadline = Date.now() + Number(env.STUDIO_GATE_SLOT_WAIT_MIN ?? 60) * 60000;
  const poll = Number(env.STUDIO_GATE_SLOT_POLL_MS ?? 1000);
  const t0 = Date.now();
  let mine = null;
  let told = false;
  while (!mine) {
    for (let i = 1; i <= n && !mine; i += 1) {
      const f = path.join(dir, `gate-slot-${i}.lock`);
      try {
        fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now(), label }), { flag: 'wx' });
        mine = f;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try {
          const h = JSON.parse(fs.readFileSync(f, 'utf8'));
          if ((h.pid && !alive(h.pid)) || Date.now() - h.at > staleMs) fs.rmSync(f, { force: true });
        } catch { try { if (Date.now() - fs.statSync(f).mtimeMs > 5000) fs.rmSync(f, { force: true }); } catch {} }
      }
    }
    if (mine) break;
    if (Date.now() > deadline) {
      log(`[gate-slots] waited ${Math.round((Date.now() - t0) / 60000)} min for a free slot; running ${label} anyway`);
      return fn();
    }
    if (!told) {
      const holders = [];
      for (let i = 1; i <= n; i += 1) { try { holders.push(JSON.parse(fs.readFileSync(path.join(dir, `gate-slot-${i}.lock`), 'utf8')).label); } catch {} }
      log(`[gate-slots] waiting for one of ${n} gate slot(s) (busy: ${holders.join(', ') || 'unknown'}); waiting doesn't count toward ${label}'s timeout`);
      told = true;
    }
    sleep(poll);
  }
  if (told) log(`[gate-slots] got a slot after ${Math.round((Date.now() - t0) / 1000)} s`);
  try { return fn(); } finally { try { fs.rmSync(mine, { force: true }); } catch {} }
}
export function withLandLock(root, fn, { waitMs = Number(process.env.STUDIO_LAND_LOCK_WAIT_MS || 180000), name = 'land', busy = busyCode } = {}) {
  // Re-entrant within one process (deliver → board write → writeNextQueue).
  const key = `${path.resolve(root)}|${name}`;
  if (held.get(key)) return fn();
  const dir = path.join(root, '.studio', 'locks');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${name}.lock`);
  const stale = Number(process.env.STUDIO_LAND_LOCK_STALE_MS || 120000);
  const deadline = Date.now() + waitMs;
  let backoff = 10;
  for (;;) {
    try {
      fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' && !busy(err.code)) throw err;
      if (err.code === 'EEXIST') {
        try {
          const h = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (Date.now() - h.at > stale || (h.pid && !alive(h.pid))) { fs.rmSync(f, { force: true }); continue; }
        } catch { try { if (Date.now() - fs.statSync(f).mtimeMs > 2000) fs.rmSync(f, { force: true }); } catch {} }
      }
      if (Date.now() > deadline) throw Object.assign(new Error(`land lock busy for ${Math.round(waitMs / 1000)} s`), { code: 'LAND_BUSY' });
      if (err.code === 'EEXIST') sleep(25);
      else { sleep(backoff); backoff = Math.min(250, backoff * 2); }
    }
  }
  held.set(key, true);
  try {
    return fn();
  } finally {
    held.delete(key);
    // Removed with the same short retry: a lock left behind by a live process blocks landings for 120 s.
    for (let i = 0, wait = 10; i < 6; i++, wait *= 2) {
      try { fs.rmSync(f, { force: true }); break; } catch (err) { if (!busy(err.code)) break; sleep(wait); }
    }
  }
}
