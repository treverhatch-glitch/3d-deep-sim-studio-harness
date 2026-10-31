/**
 * harness/fsafe.mjs — crash-safe studio state (2.57.0, PU-16). Pure Node, no other studio modules.
 *
 *   writeAtomic(file, text)        readers see the old file or the new one, never half of one: the text goes to a
 *                                  temp file in the same folder, then is renamed over the target.
 *   createExclusive(file, text)    make a file only if none exists, already holding all of its text (a hard link
 *                                  from a temp file; where links aren't supported: exclusive create, one write).
 *   withFileLock(name, fn)         a short cross-process lock (<dir>/<name>.mutex: pid, host, time) around a
 *                                  synchronous read-modify-write. Re-entrant in one process. A dead holder's lock is
 *                                  broken at once; a live holder on this machine is waited for, never broken on age
 *                                  (2.58.0, P-056); after timeoutMs it throws (code ELOCKBUSY), never loops.
 *   appendLine(file, line)         append one line; a torn last line (a writer killed mid-line) is closed first, so
 *                                  it can't swallow this one.
 *   moveAside(file, dest, raw)     rename a file away only if it still holds `raw` (put back if another agent
 *                                  replaced it meanwhile).
 *   sweepTempsDeep(roots)          remove temp files killed writers left (2.58.0, P-060; the watcher runs it).
 *   onFsafeWarning(fn)             also send fsafe's warnings to `fn` (harness/lock.mjs logs them as events).
 *
 * Why: P-037 (an empty lock file made every claim recurse forever), P-038 (ten agents starting at once lost each
 * other's board moves), P-041 (ten parks kept one hold; a half-written STOP read as "not stopped"; a torn events
 * line glued to the next event). Agents are killed at any moment, so no state file may ever be seen half-written.
 *
 * Windows: renaming over a file another program holds open (an antivirus scan, an editor) can fail with
 * EPERM/EBUSY/EACCES. writeAtomic retries briefly with backoff (about 1 s, STUDIO_ATOMIC_RETRIES), then writes the
 * file in place with a warning (and, 2.58.0, a warning event) rather than lose the update. createExclusive retries
 * the same errors (a lock file that was just deleted stays "delete pending" while another program has it open).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LOCK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.studio', 'locks');
const HOST = os.hostname();
let seq = 0;

export const sleepMs = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

/** A temp name beside the target (same folder, so the rename never crosses a disk). Starts with a dot, ends .tmp. */
export const tempPath = (file) => path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${Date.now().toString(36)}-${(seq++).toString(36)}.tmp`);
export const isTempName = (name) => /^\..+\.\d+-[0-9a-z]+-[0-9a-z]+\.tmp$/.test(name);

// fsync is cheap on Linux and macOS; on Windows FlushFileBuffers costs tens of ms, and the danger here is a killed
// process (which fsync doesn't help with), not a power cut. STUDIO_FSYNC=on|off overrides.
const fsyncOn = () => (process.env.STUDIO_FSYNC ? !/^(off|0|false|no)$/i.test(process.env.STUDIO_FSYNC) : process.platform !== 'win32');

function writeAll(fd, text) {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

function writeTemp(tmp, text, { fsync = fsyncOn() } = {}) {
  const fd = fs.openSync(tmp, 'wx');
  try {
    writeAll(fd, text);
    if (fsync) try { fs.fsyncSync(fd); } catch { /* not every filesystem supports it */ }
  } finally {
    fs.closeSync(fd);
  }
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** The waits between rename attempts: 10, 20, 40 ... ms, at most 250 each (8 tries, about 1 s). */
export const retryDelays = (n = num(process.env.STUDIO_ATOMIC_RETRIES, 8)) => Array.from({ length: Math.max(0, n) }, (_, i) => Math.min(250, 10 * 2 ** i));

/**
 * Rename `from` over `to`, retrying the errors Windows gives while another program has `to` open. Returns true when
 * renamed, false when it still failed after the retries (the caller falls back). Other errors throw.
 * `rename` and `retryable` are for tests.
 */
export function renameWithRetry(from, to, { rename = fs.renameSync, retryable = (code) => (process.platform === 'win32' ? RETRY_CODES.has(code) : code === 'EBUSY'), delays = retryDelays() } = {}) {
  for (let i = 0; ; i++) {
    try {
      rename(from, to);
      return true;
    } catch (err) {
      if (!retryable(err.code)) throw err;
      if (i >= delays.length) return false;
      sleepMs(delays[i]);
    }
  }
}

// 2.58.0 (PU-43): a warning only on the console reaches nobody when the agent's output isn't read. Whoever imports
// the event log registers a sink (harness/lock.mjs: a `fsafe.warning` event); fsafe itself stays free of it.
let warnSink = null;
let warning = false;
export function onFsafeWarning(fn) { warnSink = typeof fn === 'function' ? fn : null; }
export function fsafeWarn(msg, info = {}) {
  try { console.warn(msg); } catch { /* no console */ }
  if (!warnSink || warning) return;
  warning = true; // a sink that itself warns doesn't loop
  try { warnSink(msg, info); } catch { /* the console line is there */ } finally { warning = false; }
}

/**
 * 2.58.0 (P-056): a writer holding a withFileLock checks, right before it replaces a file, that every lock it holds
 * is still its own. A lock broken from under it (its process looked gone, or it was paused past the limit) throws
 * ELOCKLOST here instead of overwriting what the new holder wrote. Unreadable for another reason: assumed still ours.
 */
export function assertLocksHeld() {
  for (const [file, token] of held) {
    let now;
    try { now = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') continue; now = null; }
    if (now !== token) throw lostError(file, token);
  }
}
function lostError(file, token) {
  let at = null;
  try { at = JSON.parse(token).at; } catch { /* ours is always JSON */ }
  const s = Number.isFinite(at) ? ` after ${Math.round((Date.now() - at) / 1000)} s` : '';
  return Object.assign(new Error(`This process lost the lock ${path.basename(file)}${s} (another agent took it over, judging this one gone or stuck), so it stopped before writing over that agent's change. Check the result, then run the command again.`), { code: 'ELOCKLOST', file });
}

/**
 * Replace `file` with `text` so no reader ever sees it half-written, and a writer killed mid-way leaves the old
 * file whole. Returns 'renamed', or 'direct' when Windows kept refusing the rename and the file was written in place.
 */
export function writeAtomic(file, text, { fsync, rename, retryable, delays, warn = fsafeWarn } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tempPath(file);
  try {
    writeTemp(tmp, text, fsync === undefined ? {} : { fsync });
    assertLocksHeld();
    if (renameWithRetry(tmp, file, { ...(rename ? { rename } : {}), ...(retryable ? { retryable } : {}), ...(delays ? { delays } : {}) })) return 'renamed';
    // Still locked by another program after about a second: write in place rather than lose the update.
    warn(`[fsafe] couldn't replace ${path.basename(file)} atomically (another program has it open); wrote it in place`, { file, kind: 'in-place' });
    fs.writeFileSync(file, text);
    return 'direct';
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* removed on the next sweep */ }
  }
}

// Hard links: NTFS, ext4, APFS have them; FAT/exFAT and some network or synced folders don't. These codes mean "no
// hard links in this folder"; EPERM/EACCES don't (2.58.0, P-055: on Windows they are what a file another program
// holds open, or one deleted a moment ago and still "delete pending", gives).
const NO_LINK = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL', 'EMLINK']);
const noLinkDirs = new Set();
// EPERM/EACCES on Windows that outlast the retries, though an exclusive create then works: a folder without hard
// links (FAT). After this many, the folder skips links (one failure used to turn links off for the whole process).
const NO_LINK_AFTER = 3;
const permFallbacks = new Map();
/** The errors that mean "busy right now, try again": Windows' sharing errors; elsewhere only EBUSY. */
export const busyCode = (code) => (process.platform === 'win32' ? RETRY_CODES.has(code) : code === 'EBUSY');

/**
 * Create `file` holding `text`, only if it doesn't exist yet. Returns true when created, false when it exists (or,
 * 2.58.0, is still held busy after the retries: the caller treats that as taken and tries again later). The file
 * never appears empty: the text is written to a temp file first and hard-linked into place (link fails with EEXIST,
 * like exclusive create). Without hard links: exclusive create and the whole text in one write.
 * `link`, `open`, `busy`, `delays` and `platform` are for tests.
 */
export function createExclusive(file, text, { link = fs.linkSync, open = fs.openSync, busy = busyCode, delays = retryDelays(), platform = process.platform } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const dir = path.resolve(path.dirname(file));
  let permDenied = false;
  if (!noLinkDirs.has(dir)) {
    const tmp = tempPath(file);
    writeTemp(tmp, text, { fsync: false });
    try {
      for (let i = 0; ; i++) {
        try {
          link(tmp, file);
          permFallbacks.delete(dir);
          return true;
        } catch (err) {
          if (err.code === 'EEXIST') return false;
          if (busy(err.code) && i < delays.length) { sleepMs(delays[i]); continue; }
          if (NO_LINK.has(err.code)) { noLinkDirs.add(dir); break; }
          // EPERM/EACCES: this one call falls back to an exclusive create; links stay on.
          if (err.code === 'EPERM' || err.code === 'EACCES') { permDenied = true; break; }
          if (busy(err.code)) return false;
          throw err;
        }
      }
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* removed on the next sweep */ }
    }
  }
  let fd;
  for (let i = 0; ; i++) {
    try {
      fd = open(file, 'wx');
      break;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      if (busy(err.code)) {
        if (i < delays.length) { sleepMs(delays[i]); continue; }
        return false; // still held (delete pending, a scanner): taken for now
      }
      throw err;
    }
  }
  try {
    writeAll(fd, text);
  } finally {
    fs.closeSync(fd);
  }
  if (permDenied && platform === 'win32') {
    const n = (permFallbacks.get(dir) || 0) + 1;
    permFallbacks.set(dir, n);
    if (n >= NO_LINK_AFTER) noLinkDirs.add(dir);
  }
  return true;
}

/**
 * Move `file` to `dest` (rename, never delete), only if it still holds `raw` when moved. If another agent replaced
 * it meanwhile, the newer file is put back (exclusively, so nothing newer still is overwritten). Returns true when
 * moved. `dest` null: the moved file is removed (for our own stale lock files).
 */
export function moveAside(file, dest, raw) {
  const to = dest || `${file}.${process.pid}-${(seq++).toString(36)}.gone`;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(file, to);
  } catch {
    return false; // gone already, or (Windows) held open: the caller tries again later
  }
  let now = null;
  try { now = fs.readFileSync(to, 'utf8'); } catch { /* unreadable: treat as changed */ }
  if (raw !== undefined && now !== raw) {
    try { fs.linkSync(to, file); fs.rmSync(to, { force: true }); } catch (err) {
      if (err.code !== 'EEXIST') { try { if (!fs.existsSync(file)) fs.renameSync(to, file); } catch { /* left where it is */ } }
    }
    return false;
  }
  if (!dest) try { fs.rmSync(to, { force: true }); } catch { /* removed on the next sweep */ }
  return true;
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const held = new Map();

/**
 * Run `fn` (synchronous) holding the lock `<dir>/<name>.mutex`. Other processes wait (polling, 2 → 50 ms) up to
 * timeoutMs (STUDIO_STATE_LOCK_WAIT_MS, 15 s), then get an error with code ELOCKBUSY. The sections it guards are a
 * read and a write of one small file: milliseconds. When a lock is broken:
 *   - its holder is on this machine and its process is gone: at once;
 *   - its holder is on this machine and alive: never on age (2.58.0, P-056: a holder paused 12 s, by a click in its
 *     Windows console, a sleeping laptop or a clock jump, lost the lock at 10 s and its update was lost). Only past
 *     liveMaxMs (STUDIO_STATE_LOCK_LIVE_MAX_MS, 10 min), when the pid most likely belongs to another program now;
 *   - its holder is on another machine (a shared folder): when older than staleMs (STUDIO_STATE_LOCK_STALE_MS, 10 s);
 *   - it can't be read as a lock: after 2 s.
 * A holder whose lock was broken anyway finds out before it writes (assertLocksHeld in writeAtomic) and when it lets
 * go: it throws ELOCKLOST rather than pass silently.
 */
export function withFileLock(name, fn, { dir = DEFAULT_LOCK_DIR, timeoutMs = num(process.env.STUDIO_STATE_LOCK_WAIT_MS, 15000), staleMs = num(process.env.STUDIO_STATE_LOCK_STALE_MS, 10000), liveMaxMs = num(process.env.STUDIO_STATE_LOCK_LIVE_MAX_MS, 600000), what = name } = {}) {
  const file = path.join(dir, `${name}.mutex`);
  const key = path.resolve(file);
  if (held.has(key)) return fn();
  const token = acquire(key, { timeoutMs, staleMs, liveMaxMs, what });
  held.set(key, token);
  let out;
  let lost = false;
  try {
    out = fn();
  } finally {
    held.delete(key);
    // Remove it only while it is still ours (a holder judged gone may have lost it to another agent).
    let now;
    for (let i = 0; i < 3; i++) {
      try { now = fs.readFileSync(key, 'utf8'); break; } catch (err) { if (err.code === 'ENOENT') { now = null; break; } sleepMs(20); }
    }
    if (now === token) { try { fs.rmSync(key, { force: true }); } catch { /* the next taker breaks it: our pid is gone by then */ } }
    else if (now !== undefined) lost = true; // undefined: still unreadable, so unknown; leave it
  }
  if (lost) throw lostError(key, token);
  return out;
}

function acquire(file, { timeoutMs, staleMs, liveMaxMs, what }) {
  const deadline = Date.now() + timeoutMs;
  let wait = 2;
  let last = null;
  let age = 0;
  for (;;) {
    const token = JSON.stringify({ pid: process.pid, host: HOST, at: Date.now(), n: seq++ });
    if (createExclusive(file, token)) return token;
    let raw = null;
    let mtime = Date.now();
    let gone = false;
    try {
      raw = fs.readFileSync(file, 'utf8');
      mtime = fs.statSync(file).mtimeMs;
    } catch (err) {
      gone = err.code === 'ENOENT'; // released between our create and read: try again at once (within the deadline)
    }
    if (!gone) {
      let h = null;
      try { h = JSON.parse(raw); } catch { /* being written, or torn */ }
      if (!h || typeof h !== 'object') h = null;
      last = h;
      age = Math.max(0, Date.now() - (Number.isFinite(h?.at) ? h.at : mtime));
      const here = h && Number.isInteger(h.pid) && (!h.host || h.host === HOST);
      let breakIt;
      if (!h) breakIt = age > 2000;
      // Our own pid: a leftover of this process (its removal failed), as it holds nothing re-entrant here.
      else if (here) breakIt = h.pid === process.pid || !pidAlive(h.pid) || age > liveMaxMs;
      else breakIt = age > staleMs;
      if (breakIt && raw !== null && moveAside(file, null, raw)) continue;
    }
    if (Date.now() > deadline) {
      const by = last?.pid ? ` (held by process ${last.pid}${last.host && last.host !== HOST ? ` on ${last.host}` : ''} for ${Math.round(age / 1000)} s)` : '';
      throw Object.assign(new Error(`${what} is being changed by another agent${by}; waited ${Math.round(timeoutMs / 1000)} s. Nothing was changed: run the command again.`), { code: 'ELOCKBUSY', holder: last });
    }
    if (gone) continue;
    sleepMs(wait);
    wait = Math.min(50, wait * 2);
  }
}

/**
 * Append one line (a newline is added). If the file's last line was torn (a writer killed mid-line, so no newline
 * at the end), a newline goes first: the torn line stays unreadable on its own, and this one stays whole.
 */
export function appendLine(file, line) {
  const text = String(line).endsWith('\n') ? String(line) : `${line}\n`;
  const fd = fs.openSync(file, 'a+');
  try {
    const size = fs.fstatSync(fd).size;
    let lead = '';
    if (size > 0) {
      const b = Buffer.alloc(1);
      if (fs.readSync(fd, b, 0, 1, size - 1) === 1 && b[0] !== 0x0a) lead = '\n';
    }
    writeAll(fd, lead + text); // one write in append mode lands at the end, whole
  } finally {
    fs.closeSync(fd);
  }
}

/** Remove our own temp files older than maxAgeMs left in `dir` by a process killed mid-write. Returns the names. */
export function sweepTemps(dir, maxAgeMs = 60000) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!isTempName(n) && !/\.\d+-[0-9a-z]+\.gone$/.test(n)) continue;
    const f = path.join(dir, n);
    try {
      if (Date.now() - fs.statSync(f).mtimeMs < maxAgeMs) continue;
      fs.rmSync(f, { force: true });
      out.push(n);
    } catch { /* gone already */ }
  }
  return out;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.lanes']);
/**
 * 2.58.0 (P-060): the same sweep through whole folders (studio/ and .studio/ for the watcher): writeAtomic leaves a
 * full-size `.<name>.<pid>-<time>-<n>.tmp` beside its target when killed between writing and renaming (17 of 20
 * kills in round 2), and they piled up outside .studio/locks. Only files with fsafe's own temp names, older than
 * maxAgeMs (a live write takes milliseconds), at most `depth` folders down. Returns what it removed (or would, with
 * dryRun) as posix paths from each root's parent folder (studio/.NEXT.md.<…>.tmp).
 */
export function sweepTempsDeep(roots, { maxAgeMs = 5 * 60000, depth = 4, dryRun = false } = {}) {
  const out = [];
  const now = Date.now();
  const walk = (root, dir, left) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (left > 0 && !SKIP_DIRS.has(e.name)) walk(root, f, left - 1);
        continue;
      }
      if (!e.isFile() || (!isTempName(e.name) && !/\.\d+-[0-9a-z]+\.gone$/.test(e.name))) continue;
      try {
        if (now - fs.statSync(f).mtimeMs < maxAgeMs) continue;
        if (!dryRun) fs.rmSync(f, { force: true });
        out.push(path.relative(path.dirname(root), f).split(path.sep).join('/'));
      } catch { /* gone already */ }
    }
  };
  for (const root of roots) walk(root, root, depth);
  return out;
}
