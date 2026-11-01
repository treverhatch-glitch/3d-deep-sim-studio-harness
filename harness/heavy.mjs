#!/usr/bin/env node
/**
 * harness/heavy.mjs — 2.59.0 (#11, #2): the machine:heavy lock, and the load a gate's timeout is scaled for.
 *
 * Full verifies, a Unity editor run (6-7 GB) and 3D browser playtests (about 5 GB each) overlapping on one PC gave
 * e2e timeouts ("Test timed out in 120000ms", "timed out after 600 s") and a dip to 2.6 GB free. Gate slots
 * (merge-lane.mjs withGateSlot, STUDIO_GATE_SLOTS) only spread single game checks; nothing kept whole heavy runs
 * apart. Heavy work now takes one of STUDIO_HEAVY_SLOTS (1) slots in <main checkout>/.studio/locks/
 * machine-heavy-<n>.lock (every lane copy shares the main checkout's, like the gate slots) while it runs:
 *   - a full verify (scripts/run-gates.mjs: the full set, or any run that includes a heavy gate: game, browser-play);
 *   - the Unity landing gate (harness/unity-gate.mjs);
 *   - anything wrapped in `node harness/heavy.mjs run --label <what> -- <command>` (a game's own browser playtest).
 * It is one slot class beside the gate slots: a full verify holds machine:heavy for its whole run and its game
 * checks still take gate slots, so a landing's game checks (task done) are not held up by it.
 *
 * A holder records its pid and start identity (harness/proc-identity.mjs): a dead holder, or a pid now used by
 * another program (Linux /proc start), is stale and taken over, as is one older than STUDIO_HEAVY_STALE_MIN (240).
 * A waiter waits, naming the holder (again every 5 min), up to STUDIO_HEAVY_WAIT_MIN (60), then fails clearly
 * (code HEAVY_BUSY): heavy work never runs on top of other heavy work just because it waited. A landing
 * (STUDIO_GATE_PRIORITY=landing) leaves a machine-heavy-landing-<pid>.wait marker and goes ahead of other waiters;
 * a running holder is never stopped. The children of a holder (the gates a verify runs) see STUDIO_HEAVY_HELD and
 * don't wait for their own parent. STUDIO_HEAVY_SLOTS=0 turns it off.
 *
 *   node harness/heavy.mjs status                       who holds machine:heavy now (JSON with --json)
 *   node harness/heavy.mjs run --label <what> -- <cmd>  run a command under the lock; exits with its code
 *
 * Test hook: STUDIO_TEST_LOADAVG=<1-min load> stands in for os.loadavg()[0] in loadFactor (unset: the real one).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selfIdentity, pidAlive } from './proc-identity.mjs';
import { landingWaiters } from './merge-lane.mjs';

const PREFIX = 'machine-heavy';
const SLOT_RE = /^machine-heavy-(\d+)\.lock$/;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const mins = (ms) => Math.max(0, Math.round(ms / 60000));
const span = (ms) => (ms < 120000 ? `${Math.round(ms / 1000)} s` : `${mins(ms)} min`);

/** The main checkout (lane copies share its .studio/locks), else this checkout. */
export async function heavyRoot() {
  try { return (await import('./worktree.mjs')).mainRoot(); } catch { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); }
}
export const heavyDir = (root) => path.join(root, '.studio', 'locks');
export const heavySlots = (env = process.env) => num(env.STUDIO_HEAVY_SLOTS, 1);
const staleOf = (env) => num(env.STUDIO_HEAVY_STALE_MIN, 240) * 60000;

/** Linux: a process that has ended but whose parent hasn't collected it yet (a zombie) still answers kill(pid, 0). */
function zombie(pid) {
  if (process.platform !== 'linux') return false;
  try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3) === 'Z'; } catch { return false; }
}
/** A holder record is live: its process runs (same start identity where the OS tells) and it isn't too old. */
export function holderLive(h, { staleMs = 240 * 60000 } = {}) {
  return Boolean(h?.pid) && pidAlive(h.pid, h.identity) && !zombie(h.pid) && !(Date.now() - Number(h.at || 0) > staleMs);
}
export const describeHolder = (h) => `${h.label || 'heavy work'}${h.owner ? ` by ${h.owner}` : ''} (pid ${h.pid}, for ${span(Date.now() - Number(h.at || 0))})`;

/** Live machine:heavy holders: [{ pid, label, owner, at, file }]. Read-only (stale files are left to a waiter). */
export function heavyHolders(root, { env = process.env } = {}) {
  const dir = heavyDir(root);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!SLOT_RE.test(n)) continue;
    const h = readJson(path.join(dir, n));
    if (holderLive(h, { staleMs: staleOf(env) })) out.push({ ...h, file: n });
  }
  return out;
}

/** STUDIO_HEAVY_HELD="<lock file>:<pid>": a parent of this process holds machine:heavy (and still does). */
function heldByParent(dir, env) {
  const m = String(env.STUDIO_HEAVY_HELD || '').match(/^(machine-heavy-\d+\.lock):(\d+)$/);
  if (!m) return null;
  const h = readJson(path.join(dir, m[1]));
  return h && Number(h.pid) === Number(m[2]) && holderLive(h, { staleMs: staleOf(env) }) ? h : null;
}

/**
 * Take a machine:heavy slot (sync; waits). Returns { release(), held, waitedMs, skipped?, inside? }. Throws an
 * Error with code HEAVY_BUSY when the wait limit passes. While held, process.env.STUDIO_HEAVY_HELD names the slot
 * so the processes this one starts don't wait for it.
 */
export function acquireHeavy(root, label, { log = () => {}, env = process.env, owner = null } = {}) {
  const n = heavySlots(env);
  const none = { release: () => {}, held: null, waitedMs: 0 };
  if (!(n > 0)) return { ...none, skipped: true };
  const dir = heavyDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const parent = heldByParent(dir, env);
  if (parent) return { ...none, inside: parent };
  const staleMs = staleOf(env);
  const waitMs = num(env.STUDIO_HEAVY_WAIT_MIN, 60) * 60000;
  const poll = num(env.STUDIO_HEAVY_POLL_MS, 2000);
  const remind = num(env.STUDIO_HEAVY_REMIND_MS, 5 * 60000);
  const landing = String(env.STUDIO_GATE_PRIORITY || '').toLowerCase() === 'landing';
  const marker = landing ? path.join(dir, `${PREFIX}-landing-${process.pid}.wait`) : null;
  const t0 = Date.now();
  let mine = null;
  let toldAt = 0;
  let holders = [];
  try {
    while (!mine) {
      const ahead = landing ? [] : landingWaiters(dir, { staleMs, prefix: PREFIX });
      holders = [];
      for (let i = 1; i <= n && !mine; i += 1) {
        const f = path.join(dir, `${PREFIX}-${i}.lock`);
        const h = readJson(f);
        if (h && holderLive(h, { staleMs })) { holders.push(h); continue; }
        if (fs.existsSync(f)) {
          // Stale (dead holder, reused pid, too old) or unreadable for more than a moment: take it over.
          if (h || Date.now() - (fs.statSync(f, { throwIfNoEntry: false })?.mtimeMs || 0) > 5000) {
            if (h) log(`[heavy] ${describeHolder(h)} is gone: its machine:heavy slot is free again`);
            try { fs.rmSync(f, { force: true }); } catch {}
          } else continue;
        }
        if (ahead.length) continue;
        try {
          fs.writeFileSync(f, JSON.stringify({ pid: process.pid, identity: selfIdentity(), at: Date.now(), label, owner: owner || env.STUDIO_LOCK_OWNER || null, ...(landing ? { landing: true } : {}) }), { flag: 'wx' });
          mine = f;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
      }
      if (mine) break;
      const busyWith = holders.length ? holders.map(describeHolder).join('; ') : ahead.length ? `a landing waiting first (${ahead.map((w) => w.label).join(', ')})` : 'unknown';
      if (Date.now() - t0 >= waitMs) {
        throw Object.assign(new Error(`[heavy] waited ${span(Date.now() - t0)} for the machine:heavy lock and it is still held: ${busyWith}. ${label} did not run (it never runs on top of other heavy work). Run it again when that ends (node harness/heavy.mjs status shows the holder); STUDIO_HEAVY_WAIT_MIN sets the wait.`), { code: 'HEAVY_BUSY', holders });
      }
      if (marker && !fs.existsSync(marker)) { try { fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, at: Date.now(), label })); } catch {} }
      if (!toldAt || Date.now() - toldAt >= remind) {
        log(`[heavy] ${label} waits for the machine:heavy lock (${n} slot${n === 1 ? '' : 's'}, STUDIO_HEAVY_SLOTS), held by ${busyWith}${landing ? '; a landing: it takes the next free slot ahead of other waiters' : ''}; waiting up to ${span(waitMs)}, which doesn't count toward its own timeouts`);
        toldAt = Date.now();
      }
      sleep(poll);
    }
  } finally {
    if (marker) try { fs.rmSync(marker, { force: true }); } catch {}
  }
  const waitedMs = Date.now() - t0;
  if (toldAt) log(`[heavy] ${label} got the machine:heavy lock after ${Math.round(waitedMs / 1000)} s`);
  const token = `${path.basename(mine)}:${process.pid}`;
  const prevEnv = process.env.STUDIO_HEAVY_HELD;
  process.env.STUDIO_HEAVY_HELD = token;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { if (readJson(mine)?.pid === process.pid) fs.rmSync(mine, { force: true }); } catch {}
    if (process.env.STUDIO_HEAVY_HELD === token) { if (prevEnv === undefined) delete process.env.STUDIO_HEAVY_HELD; else process.env.STUDIO_HEAVY_HELD = prevEnv; }
  };
  return { release, held: path.basename(mine), waitedMs };
}

/** Run fn under machine:heavy (a returned promise is waited for before the slot is freed). */
export function withHeavy(root, label, fn, opts = {}) {
  const lk = acquireHeavy(root, label, opts);
  let out;
  try {
    out = fn(lk);
  } catch (err) {
    lk.release();
    throw err;
  }
  if (out && typeof out.then === 'function') return out.finally(() => lk.release());
  lk.release();
  return out;
}

/** Other gate-slot holders (merge-lane.mjs withGateSlot) than this process: [{ pid, label }]. */
function otherGateSlots(root, env) {
  const dir = heavyDir(root);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const staleMs = num(env.STUDIO_GATE_SLOT_STALE_MIN, 120) * 60000;
  return names.filter((n) => /^gate-slot-\d+\.lock$/.test(n)).map((n) => readJson(path.join(dir, n))).filter((h) => h?.pid && h.pid !== process.pid && pidAlive(h.pid, h.identity) && Date.now() - Number(h.at || 0) <= staleMs);
}

/**
 * 2.59.0 (#2): how loaded the machine is, as a factor for a gate's timeout: 1 + 1 per other live machine:heavy holder
 * (not the one this process runs inside) + 0.5 per other running gate check + the 1-minute load above 1.5 per core
 * (os.loadavg is all zeros on Windows, so there only the holder counts decide). Capped at
 * STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR (3), never below 1. { factor, why }.
 */
export function loadFactor(root, { env = process.env, loadavg = null, cpus = null } = {}) {
  const dir = heavyDir(root);
  const parent = heldByParent(dir, env);
  const heavy = heavyHolders(root, { env }).filter((h) => h.pid !== process.pid && !(parent && h.pid === parent.pid));
  const slots = otherGateSlots(root, env);
  const load = loadavg ?? (env.STUDIO_TEST_LOADAVG !== undefined && env.STUDIO_TEST_LOADAVG !== '' ? Number(env.STUDIO_TEST_LOADAVG) : os.loadavg()[0]);
  const cores = cpus ?? Math.max(1, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1);
  const why = [];
  let f = 1;
  if (heavy.length) { f += heavy.length; why.push(`${heavy.length} other heavy job${heavy.length === 1 ? '' : 's'} running: ${heavy.map(describeHolder).join('; ')}`); }
  if (slots.length) { f += 0.5 * slots.length; why.push(`${slots.length} other game check${slots.length === 1 ? '' : 's'} running (${slots.map((s) => s.label).join(', ')})`); }
  const per = Number.isFinite(load) ? load / cores : 0;
  if (per > 1.5) { f += Math.min(2, per - 1); why.push(`load ${load.toFixed(1)} on ${cores} core${cores === 1 ? '' : 's'}`); }
  const cap = Math.max(1, num(env.STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR, 3));
  return { factor: Math.round(Math.min(cap, Math.max(1, f)) * 10) / 10, why: why.join('; ') };
}

/**
 * A timeout scaled for load: { ms, base, factor, why }. Never shorter than the configured base;
 * STUDIO_GAME_GATE_TIMEOUT_SCALE=off keeps the base.
 */
export function scaledTimeout(base, root, { env = process.env, ...rest } = {}) {
  if (/^(off|0|false|no)$/i.test(String(env.STUDIO_GAME_GATE_TIMEOUT_SCALE || ''))) return { ms: base, base, factor: 1, why: '' };
  const { factor, why } = loadFactor(root, { env, ...rest });
  return { ms: Math.max(base, Math.round(base * factor)), base, factor, why };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const root = await heavyRoot();
  if (argv[0] === 'run') {
    const sep = argv.indexOf('--');
    const label = argv.includes('--label') ? argv[argv.indexOf('--label') + 1] : 'heavy command';
    const cmd = sep >= 0 ? argv.slice(sep + 1) : [];
    if (!cmd.length) { console.error('Usage: node harness/heavy.mjs run --label <what> -- <command> [args]'); process.exit(2); }
    let code = 1;
    try {
      withHeavy(root, label, () => {
        // One command line, run by the shell as written (no glob of ours; quoting is the caller's).
        const r = spawnSync(cmd.join(' '), { cwd: process.cwd(), shell: true, stdio: 'inherit' });
        code = r.status ?? 1;
      }, { log: (m) => console.error(m) });
    } catch (err) {
      if (err.code !== 'HEAVY_BUSY') throw err;
      console.error(err.message);
      code = 3;
    }
    process.exit(code);
  }
  const holders = heavyHolders(root);
  if (argv.includes('--json')) console.log(JSON.stringify({ slots: heavySlots(), holders }));
  else console.log(holders.length ? `machine:heavy (${heavySlots()} slot${heavySlots() === 1 ? '' : 's'}): ${holders.map(describeHolder).join('; ')}` : `machine:heavy is free (${heavySlots()} slot${heavySlots() === 1 ? '' : 's'}, STUDIO_HEAVY_SLOTS)`);
}
