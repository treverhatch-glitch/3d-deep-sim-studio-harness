/**
 * harness/proc-identity.mjs — PU-17 (P-039, P-045): is this process number still the program the launcher started?
 *
 * The OS reuses process numbers. A session record left "running" after a crash or a reboot can name a number that
 * another program has now, and killing by number (agent stop, pause, stop all, the stall and refresh checks,
 * studio:stop) would kill that program (on Windows with its whole tree). So the launcher writes down when each
 * process started, and a kill first checks the number still belongs to it.
 *
 * Each moment has its own cost, and only the kill pays for an OS query (P-045: a PowerShell call at every launch and
 * in every listing slowed the launcher on Windows and made five selftests fail there):
 *   launch   in-process, no child process: the launcher's own start (Date.now() - process.uptime(), or the spawn time
 *            its parent wrote) and each agent's spawn time (Date.now() right after spawn) with its program's name;
 *            on Linux also the /proc start ticks (a file read).
 *   listing  sessions(), task.mjs's holder check, the supervisor, the watcher and the HUD: no child process. A number
 *            in use counts as alive, as before; on Linux a /proc start that differs from the record means dead.
 *   kill     readStarts() asks the OS once (Linux /proc; macOS one ps; Windows one PowerShell Get-CimInstance, with a
 *            timeout) and sameProcess() compares. The recorded time is the spawn time, not the OS's creation time,
 *            so they may differ by STUDIO_PROC_START_TOLERANCE_SEC (default 3). Same: kill. Clearly different: don't.
 *            Unreadable: the caller's old rule (a fresh heartbeat).
 *
 * Test hooks (the Windows logic, tested on any OS):
 *   STUDIO_PROC_IDENTITY_STUB=<file.json>  readStarts answers from this map, { "<pid>": <start ms> | "error" | "gone" };
 *                                          other pids go to the real reader. Launches record no /proc ticks and
 *                                          listings use the Windows rule, as on Windows.
 *   STUDIO_PROC_IDENTITY_DELAY_MS=<ms>     every readStarts call waits this long first (a slow PowerShell).
 *   STUDIO_PROC_IDENTITY_LOG=<file>        every readStarts call appends one JSON line: when, which pids, who asked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const STUB = process.env.STUDIO_PROC_IDENTITY_STUB || '';
// The cheap /proc checks at launch and in listings. Off under the stub, so a Linux run takes the Windows path.
const LINUX = process.platform === 'linux' && !STUB;
const tolSec = Number(process.env.STUDIO_PROC_START_TOLERANCE_SEC);
export const START_TOLERANCE_MS = (Number.isFinite(tolSec) && tolSec >= 0 ? tolSec : 3) * 1000;
// A start a process measured itself (Date.now() - process.uptime()) is late by the time Node took to get going, so
// the OS's creation time may be this much earlier and still be the same process. A later process can't be: a
// number is reused only by a program created after the recorded one.
const SELF_SLACK_MS = 10000;
const READ_TIMEOUT_MS = Number(process.env.STUDIO_PROC_IDENTITY_TIMEOUT_MS) || 8000;
const USER_HZ = 100; // /proc's clock ticks per second (sysconf(_SC_CLK_TCK); 100 on every mainstream Linux)

const progName = (s) => String(s || '').trim().split(/[\\/]/).pop().slice(0, 80) || null;

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

/** Linux: the start of a pid in clock ticks since boot (/proc/<pid>/stat field 22), or null. */
function linuxTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 2 (the program's name) is in parentheses and may hold spaces: count from the last ')'.
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return /^\d+$/.test(ticks || '') ? Number(ticks) : null;
  } catch {
    return null;
  }
}
const procTag = (ticks) => `linux:${ticks}@${bootId()}`;

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

// ---- launch: in-process only ----

/** This process: when it started (ms since 1970, from Node's own clock), plus the /proc start on Linux. */
export function selfIdentity() {
  const id = { start: Math.round(Date.now() - process.uptime() * 1000), self: true };
  if (LINUX) {
    const t = linuxTicks(process.pid);
    if (t !== null) id.proc = procTag(t);
  }
  return id;
}

/**
 * A child this process has just spawned: the spawn time stands in for its start (spawn returns once the OS has
 * created it), plus its program's name (never its arguments) and the /proc start on Linux.
 */
export function spawnedIdentity(pid, program = null, at = Date.now()) {
  if (!pid) return null;
  const id = { start: at };
  const name = progName(program);
  if (name) id.cmd = name;
  if (LINUX) {
    const t = linuxTicks(pid);
    if (t !== null) id.proc = procTag(t);
  }
  return id;
}

// ---- listing: no child process ----

/**
 * Listing check: is `pid` alive as far as a cheap look can tell? A number in use counts as alive (the rule before
 * PU-17, kept on Windows and macOS); on Linux a /proc start that differs from the recorded one means it is another
 * program now. eperm: whether a process we may not signal counts (it does for sessions, not for the supervisor).
 */
export function pidAlive(pid, recorded, { eperm = true } = {}) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (!(eperm && err.code === 'EPERM')) return false;
  }
  if (LINUX && recorded?.proc) {
    const t = linuxTicks(pid);
    if (t !== null && procTag(t) !== recorded.proc) return false;
  }
  return true;
}

/** Is a launcher session record's process alive (listing check)? Its launcher when it has one, else the agent. */
export function recordAlive(s) {
  if (!s) return false;
  const pid = s.supervisor || s.pid;
  return pidAlive(pid, s.supervisor ? s.identity?.supervisor : s.identity?.pid);
}

// ---- kill: one OS query ----

const sleep = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function linuxStarts(pids) {
  const out = new Map();
  let up = null;
  try {
    up = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
  } catch {}
  for (const p of pids) {
    const t = linuxTicks(p);
    if (t === null) continue;
    let cmd = null;
    try {
      cmd = progName(fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0')[0]);
    } catch {}
    out.set(p, { start: Number.isFinite(up) ? Math.round(Date.now() - (up - t / USER_HZ) * 1000) : null, proc: procTag(t), cmd });
  }
  return out;
}

function macStarts(pids) {
  const r = spawnSync('ps', ['-o', 'pid=', '-o', 'lstart=', '-o', 'comm=', '-p', pids.join(',')], { encoding: 'utf8', timeout: READ_TIMEOUT_MS, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
  // ps exits 1 when one of the pids is gone, and still prints the others.
  if (r.error || (r.status !== 0 && r.status !== 1)) throw new Error(r.error?.code || `ps exit ${r.status}`);
  const out = new Map();
  for (const line of String(r.stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}:\d{2}:\d{2})\s+(\d{4})\s?(.*)$/);
    if (m) out.set(Number(m[1]), { start: Date.parse(`${m[2]} ${m[3]}, ${m[5]} ${m[4]} UTC`), cmd: progName(m[6]) });
  }
  return out;
}

/**
 * One PowerShell call for every pid, plus PowerShell's own process as a reference: it was created just after `t0`,
 * so if the creation times come out shifted by a whole time-zone offset (a DateTime read as the wrong kind), the
 * shift is seen and taken back out (in 15-minute steps) instead of making every agent look like another program.
 */
export function winStartsFrom(stdout, t0) {
  const out = new Map();
  let self = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const me = line.match(/^self\|(\d+)$/);
    if (me) self = Number(me[1]);
    const m = line.match(/^(\d+)\|(\d*)\|(.*)$/);
    if (m) out.set(Number(m[1]), m[2] ? { start: Number(m[2]), cmd: progName(m[3]) } : { error: 'no creation time', cmd: progName(m[3]) });
  }
  const ref = self ? out.get(self) : null;
  const skew = ref?.start ? t0 - ref.start : 0;
  if (Math.abs(skew) > 10 * 60000) {
    const fix = Math.round(skew / 900000) * 900000;
    for (const v of out.values()) if (v.start) v.start += fix;
  }
  return out;
}

function winStarts(pids) {
  // No double quotes anywhere in the script: Node escapes them on the command line in a way powershell.exe 5.1 reads
  // differently. The creation time goes out as milliseconds since 1970, so no date text is parsed.
  const filter = pids.map((p) => `ProcessId=${Number(p)}`).join(' OR ');
  const script = `'self|' + $PID; Get-CimInstance Win32_Process -Filter ('${filter} OR ProcessId=' + $PID) | ForEach-Object { if ($_.CreationDate) { '{0}|{1}|{2}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), $_.Name } else { '{0}||{1}' -f $_.ProcessId, $_.Name } }`;
  const t0 = Date.now();
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: READ_TIMEOUT_MS, windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(r.error?.code || `powershell exit ${r.status}`);
  const out = winStartsFrom(r.stdout, t0);
  const self = Number((String(r.stdout).match(/^self\|(\d+)/m) || [])[1]);
  if (self && !pids.includes(self)) out.delete(self);
  return out;
}

function osStarts(pids) {
  if (process.platform === 'linux') return linuxStarts(pids);
  if (process.platform === 'win32') return winStarts(pids);
  return macStarts(pids);
}

/**
 * Kill time only: what the OS says about each pid now, in one query. Map pid -> { start, proc?, cmd? } for a running
 * process, or { error } when its start couldn't be read (timeout, no PowerShell, access); a pid missing from the
 * map has no process. Never throws.
 */
export function readStarts(pids) {
  const want = [...new Set((pids || []).map(Number).filter((p) => Number.isInteger(p) && p > 0))];
  const out = new Map();
  if (!want.length) return out;
  if (process.env.STUDIO_PROC_IDENTITY_LOG) {
    try {
      fs.appendFileSync(process.env.STUDIO_PROC_IDENTITY_LOG, `${JSON.stringify({ at: new Date().toISOString(), pids: want, by: [path.basename(process.argv[1] || ''), process.argv[2] || ''].join(' ').trim() })}\n`);
    } catch {}
  }
  sleep(Number(process.env.STUDIO_PROC_IDENTITY_DELAY_MS) || 0);
  let rest = want;
  if (STUB) {
    let map = null;
    try {
      map = JSON.parse(fs.readFileSync(STUB, 'utf8'));
    } catch {}
    if (!map || typeof map !== 'object') {
      for (const p of want) out.set(p, { error: 'stub unreadable' });
      return out;
    }
    rest = [];
    for (const p of want) {
      const v = map[String(p)];
      if (v === undefined) rest.push(p);
      else if (typeof v === 'number') out.set(p, { start: v, cmd: 'stub' });
      else if (v !== 'gone' && v !== null) out.set(p, { error: String(v) });
    }
  }
  if (rest.length) {
    let got;
    try {
      got = osStarts(rest);
    } catch (err) {
      for (const p of rest) out.set(p, { error: String(err.message || err).slice(0, 80) });
      return out;
    }
    for (const p of rest) {
      if (got.has(p)) out.set(p, got.get(p));
      // Not listed but still there (a query that skipped it): unreadable, never "gone".
      else if (pidExists(p)) out.set(p, { error: 'not listed' });
    }
  }
  return out;
}

/**
 * Is the process read now (`cur`, from readStarts) the one on record? true, false, or null when there is nothing to
 * compare (no start on record, or none could be read). On Linux, when both sides have the /proc start, they must be
 * equal. Otherwise the recorded start may be off by START_TOLERANCE_MS either way (more on the early side for a start
 * the process measured itself).
 */
export function sameProcess(recorded, cur, tolMs = START_TOLERANCE_MS) {
  if (!recorded || !cur || cur.error) return null;
  if (recorded.proc && cur.proc) return recorded.proc === cur.proc;
  const a = Number(recorded.start);
  const b = Number(cur.start);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !recorded.start || !cur.start) return null;
  return b >= a - (recorded.self ? Math.max(tolMs, SELF_SLACK_MS) : tolMs) && b <= a + tolMs;
}

// ---- 2.60.0 (#5): the whole process table, for killing a machine:heavy holder's tree ----

/** Linux: /proc/<pid>/stat as { ppid, pgid, ticks, zombie } (fields 4, 5, 22 and the state), or null. */
function linuxStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: f[0], ppid: Number(f[1]), pgid: Number(f[2]), ticks: Number(f[19]) };
  } catch {
    return null;
  }
}

/**
 * The process group a pid leads or belongs to (POSIX), or null (Windows has none; unreadable). Linux reads /proc;
 * macOS asks ps once.
 */
export function processGroup(pid = process.pid) {
  if (process.platform === 'win32') return null;
  if (process.platform === 'linux') return linuxStat(pid)?.pgid ?? null;
  const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: READ_TIMEOUT_MS });
  const g = Number(String(r.stdout || '').trim());
  return Number.isInteger(g) && g > 0 ? g : null;
}

/**
 * Windows: the lines of one Get-CimInstance Win32_Process listing ("pid|ppid|creation ms|name", plus "self|<pid>"),
 * as [{ pid, ppid, start, cmd }], with the same time-zone shift correction as winStartsFrom.
 */
export function winProcsFrom(stdout, t0 = Date.now()) {
  const out = [];
  let self = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const me = line.match(/^self\|(\d+)$/);
    if (me) self = Number(me[1]);
    const m = line.match(/^(\d+)\|(\d+)\|(\d*)\|(.*)$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: null, start: m[3] ? Number(m[3]) : null, cmd: progName(m[4]) });
  }
  const ref = self ? out.find((p) => p.pid === self) : null;
  const skew = ref?.start ? t0 - ref.start : 0;
  if (Math.abs(skew) > 10 * 60000) {
    const fix = Math.round(skew / 900000) * 900000;
    for (const p of out) if (p.start) p.start += fix;
  }
  return out.filter((p) => p.pid !== self);
}

/**
 * Every process now, in one OS query: [{ pid, ppid, pgid, start, proc?, cmd, zombie? }]. Linux reads /proc; macOS
 * runs one ps; Windows one PowerShell Get-CimInstance (Windows keeps a child's ParentProcessId after its parent ends,
 * so orphans still name their dead parent; there is no process group). Throws when the OS can't be asked.
 * STUDIO_PROC_LIST_STUB=<file.json> answers with that array instead (tests).
 */
export function listProcesses() {
  const stub = process.env.STUDIO_PROC_LIST_STUB;
  if (stub) return JSON.parse(fs.readFileSync(stub, 'utf8'));
  if (process.platform === 'linux') {
    let up = null;
    try { up = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]); } catch {}
    const out = [];
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const s = linuxStat(name);
      if (!s) continue;
      let cmd = null;
      try { cmd = progName(fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0')[0]); } catch {}
      out.push({ pid: Number(name), ppid: s.ppid, pgid: s.pgid, start: Number.isFinite(up) ? Math.round(Date.now() - (up - s.ticks / USER_HZ) * 1000) : null, proc: procTag(s.ticks), cmd, ...(s.state === 'Z' ? { zombie: true } : {}) });
    }
    return out;
  }
  if (process.platform === 'win32') {
    const script = `'self|' + $PID; Get-CimInstance Win32_Process | ForEach-Object { $ms = ''; if ($_.CreationDate) { $ms = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }; '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $ms, $_.Name }`;
    const t0 = Date.now();
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: READ_TIMEOUT_MS * 2, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error(r.error?.code || `powershell exit ${r.status}`);
    return winProcsFrom(r.stdout, t0);
  }
  const r = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'comm='], { encoding: 'utf8', timeout: READ_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
  if (r.error || r.status !== 0) throw new Error(r.error?.code || `ps exit ${r.status}`);
  const out = [];
  for (const line of String(r.stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}:\d{2}:\d{2})\s+(\d{4})\s?(.*)$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), start: Date.parse(`${m[5]} ${m[6]}, ${m[8]} ${m[7]} UTC`), cmd: progName(m[9]), ...(m[4].startsWith('Z') ? { zombie: true } : {}) });
  }
  return out;
}
