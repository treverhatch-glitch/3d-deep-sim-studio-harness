/**
 * harness/proc-identity.mjs — 2.57.0 (PU-17, P-039): is this process number still the program we started?
 *
 * The OS reuses process numbers. A session record left "running" after a crash or a reboot can point at a
 * number that now belongs to another program, and killing by number (agent stop, stop all, the stall
 * check, studio:stop) would kill that program (on Windows with its whole tree). So the launcher records an
 * identity next to each pid it writes down, and every kill and every "is it alive" check compares it first.
 *
 *   Linux:   /proc/<pid>/stat field 22 (start, in clock ticks since boot) + /proc/sys/kernel/random/boot_id
 *   macOS:   ps -o lstart= -o command= (TZ=UTC and LC_ALL=C, so the text is the same on every read)
 *   Windows: PowerShell Get-CimInstance Win32_Process (CreationDate, CommandLine)
 *
 * Only the start time is compared. It stays the same when a shell execs the agent's program; the command
 * line doesn't, so it is kept for messages only. Best effort and fast: anything unreadable is null, a null
 * never blocks a launch, and on macOS and Windows one call reads every pid asked for and is reused for a
 * few seconds.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const CACHE_MS = 3000;
const cache = new Map(); // pid -> { at, id }

let BOOT;
function bootId() {
  if (BOOT === undefined) {
    try {
      BOOT = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      BOOT = '';
    }
  }
  return BOOT;
}

function linuxIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 2 (the program name) is in parentheses and may hold spaces: count from the last ')'.
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; // field 22
    if (!/^\d+$/.test(ticks || '')) return null;
    let cmd = null;
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 200) || null;
    } catch {}
    const boot = bootId();
    return { start: `linux:${ticks}${boot ? `@${boot}` : ''}`, cmd };
  } catch {
    return null;
  }
}

function macIdentities(pids) {
  const out = new Map();
  const r = spawnSync('ps', ['-o', 'pid=', '-o', 'lstart=', '-o', 'command=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 3000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
  // ps exits 1 when one of the pids is gone, and still prints the others.
  for (const line of String(r.stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s?(.*)$/);
    if (m) out.set(Number(m[1]), { start: `ps:${m[2].replace(/\s+/g, ' ')}`, cmd: m[3].trim().slice(0, 200) || null });
  }
  return out;
}

function winIdentities(pids) {
  const out = new Map();
  const filter = pids.map((p) => `ProcessId=${Number(p)}`).join(' OR ');
  const script = `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { if ($_.CreationDate) { '{0}|{1}|{2}' -f $_.ProcessId, $_.CreationDate.ToUniversalTime().ToString('o'), $_.CommandLine } }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const m = line.match(/^(\d+)\|([^|]+)\|(.*)$/);
    if (m) out.set(Number(m[1]), { start: `win:${m[2].trim()}`, cmd: m[3].trim().slice(0, 200) || null });
  }
  return out;
}

/** Identities of several pids at once: Map pid -> { start, cmd } (missing when gone or unreadable). */
export function readIdentities(pids, now = Date.now()) {
  const want = [...new Set((pids || []).map(Number).filter((p) => Number.isInteger(p) && p > 0))];
  const out = new Map();
  if (IS_LINUX) {
    for (const p of want) {
      const id = linuxIdentity(p);
      if (id) out.set(p, id);
    }
    return out;
  }
  const ask = [];
  for (const p of want) {
    const c = cache.get(p);
    if (c && now - c.at < CACHE_MS) {
      if (c.id) out.set(p, c.id);
    } else ask.push(p);
  }
  if (ask.length) {
    let got = new Map();
    try {
      got = IS_WIN ? winIdentities(ask) : macIdentities(ask);
    } catch {
      // unreadable: unknown, never a crash
    }
    for (const p of ask) {
      cache.set(p, { at: now, id: got.get(p) || null });
      if (got.get(p)) out.set(p, got.get(p));
    }
  }
  return out;
}

/** One pid's identity { start, cmd }, or null when it is gone or can't be read. */
export function readIdentity(pid) {
  return readIdentities([pid]).get(Number(pid)) || null;
}

/** Is a process with this number running at all (whoever it is)? */
export function pidExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * What the number `pid` is now, against the identity recorded when it was started:
 *   gone    - no process has that number
 *   same    - the recorded program (same start time)
 *   other   - another program has the number now
 *   unknown - no identity on record (an older record), or the current one can't be read
 */
export function pidState(pid, recorded) {
  if (!pidExists(pid)) return { state: 'gone', now: null };
  if (!recorded?.start) return { state: 'unknown', now: null };
  const now = readIdentity(pid);
  if (!now) return { state: 'unknown', now: null };
  return { state: now.start === recorded.start ? 'same' : 'other', now };
}

/** Alive as far as anyone can tell: the same program, or a live number with nothing to compare against. */
export function pidAlive(pid, recorded) {
  const st = pidState(pid, recorded).state;
  return st === 'same' || st === 'unknown';
}

/**
 * Is a launcher session record's process alive? Its launcher (supervisor) when it has one, else the agent.
 * An identity that no longer matches means dead: the number belongs to another program now. A record
 * without one (written before 2.57.0) keeps the plain pid check; agent stop judges those by the heartbeat.
 */
export function recordAlive(s) {
  if (!s) return false;
  const pid = s.supervisor || s.pid;
  return pidAlive(pid, s.supervisor ? s.identity?.supervisor : s.identity?.pid);
}

/** Read the identities of every live, identified pid in these records at once (one ps / PowerShell call). */
export function warmIdentities(records) {
  if (IS_LINUX) return;
  const pids = [];
  for (const s of records || []) {
    if (s?.status !== 'running') continue;
    if (s.supervisor && s.identity?.supervisor && pidExists(s.supervisor)) pids.push(s.supervisor);
    if (s.pid && s.identity?.pid && pidExists(s.pid)) pids.push(s.pid);
  }
  if (pids.length) readIdentities(pids);
}
