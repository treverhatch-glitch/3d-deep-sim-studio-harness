/**
 * harness/code-stamp.mjs — 2.86 (a, B-139): which harness code a long-running process runs, and whether that is still
 * the code installed in the checkout.
 *
 * A long-running Node process (the supervisor, a watcher loop) keeps the code it loaded at its start. After
 * `npm run upgrade -- --merge <ref>` a crew's supervisor ran the old code for 20 hours and nothing said so. So:
 *
 *   codeStamp({ root })    the installed harness: { version (package.json), head (the checkout's HEAD commit, read from
 *                          the .git files, no git process), harness (the tree id of harness/ at HEAD), at }. Cached for
 *                          STAMP_CACHE_MS (a minute); git runs only when HEAD moved since the last look.
 *   sameCode(a, b)         false when the code differs (the version, or the harness/ tree); true when it is the same;
 *                          null when it can't tell. HEAD alone moving (a board commit, a landed lane) is not new code.
 *   noticeNewCode(rec, …)  one harness.code_changed event per new installed stamp, said loudly once on the console.
 *   restartHow(…)          how the supervisor can restart itself where it runs: 'spawn' (it runs on its own: a fresh
 *                          detached supervisor waits for this one to end), 'exit' (a launchd job, or a systemd unit with
 *                          KillMode=process: exit 75 and the service manager starts it again), or null with the reason
 *                          (a terminal a person watches, an old systemd unit whose stop would end every agent session,
 *                          or STUDIO_SUPERVISOR_SELF_RESTART=off).
 *   writeHandoff / takeHandoff   what the supervisor keeps in memory that a restart must not lose (a halt, an extended
 *                          end time, the agents it started, back-offs, the timed passes' clocks), in
 *                          .studio/supervisor-handoff.json for the next supervisor.
 *   noteRunning / runningRecords  other long-running processes (the watcher loop) record their stamp in .studio/running/.
 *   oldCodeReport(…)       every long-running process that still runs old code, with what will happen to it: for
 *                          `upgrade --merge`, `npm run harness-health`, `npm run studio:status` and the daily digest.
 *
 * Only node's own modules at the top: `upgrade --merge` loads this file from a studio that may be older.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const STAMP_CACHE_MS = 60000;
/** The exit code that asks a service manager (systemd Restart=on-failure, launchd KeepAlive) to start the supervisor again. */
export const RESTART_EXIT_CODE = 75;
export const HANDOFF_FILE = 'supervisor-handoff.json';
/** Handed-off state older than this is not taken (a restart that never happened; a later start is a fresh one). */
export const HANDOFF_MAX_AGE_MS = 15 * 60000;
/** The supervisor's in-memory state that a restart carries over (as a person's restart would want it kept). */
export const HANDOFF_KEYS = ['halted', 'haltCheckFrom', 'extended', 'names', 'roleBackoff', 'roleBackoffSeen', 'startBackoffSeen', 'timed', 'probed'];

const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const readJsonFile = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The checkout's git folder and the common one (a worktree's .git is a file naming its folder). */
function gitDirs(root) {
  const dotgit = path.join(root, '.git');
  let gitDir = null;
  try {
    if (fs.statSync(dotgit).isDirectory()) gitDir = dotgit;
    else { const m = /^gitdir:\s*(.+)$/m.exec(readText(dotgit) || ''); if (m) gitDir = path.resolve(root, m[1].trim()); }
  } catch { return null; }
  if (!gitDir) return null;
  const common = (readText(path.join(gitDir, 'commondir')) || '').trim();
  return { gitDir, commonDir: common ? path.resolve(gitDir, common) : gitDir };
}

/** HEAD's commit read from the .git files (no git process), or null when it can't be read that way. */
export function readHead(root) {
  const d = gitDirs(root);
  if (!d) return null;
  const head = (readText(path.join(d.gitDir, 'HEAD')) || '').trim();
  if (SHA.test(head)) return head;
  const m = /^ref:\s*(\S+)$/.exec(head);
  if (!m) return null;
  for (const dir of [d.gitDir, d.commonDir]) {
    const v = (readText(path.join(dir, ...m[1].split('/'))) || '').trim();
    if (SHA.test(v)) return v;
  }
  for (const line of (readText(path.join(d.commonDir, 'packed-refs')) || '').split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref === m[1] && SHA.test(sha || '')) return sha;
  }
  return null;
}

const runGit = (root, args) => { const r = spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20000 }); return r.status === 0 ? String(r.stdout || '').trim() : ''; };
const cache = new Map(); // root -> { at, stamp }
const trees = new Map(); // `${root}\n${head}` -> harness/ tree id

/** The installed harness's identity. deps.git(root, args) stands in for git in tests. */
export function codeStamp({ root, now = Date.now(), fresh = false, git = runGit } = {}) {
  const key = path.resolve(String(root || '.'));
  const c = cache.get(key);
  if (!fresh && c && now - c.at >= 0 && now - c.at < STAMP_CACHE_MS) return c.stamp;
  const version = readJsonFile(path.join(key, 'package.json'))?.version || null;
  let head = readHead(key);
  if (!head) { const h = git(key, ['rev-parse', '--verify', '-q', 'HEAD']); head = SHA.test(h) ? h : null; }
  let harness = null;
  if (head) {
    const tk = `${key}\n${head}`;
    if (trees.has(tk)) harness = trees.get(tk);
    else { const t = git(key, ['rev-parse', '--verify', '-q', `${head}:harness`]); harness = SHA.test(t) ? t : null; if (harness) trees.set(tk, harness); }
  }
  const stamp = { version, head, harness, at: new Date(now).toISOString() };
  cache.set(key, { at: now, stamp });
  return stamp;
}

/** false: different code; true: the same; null: can't tell (a side unknown). A HEAD that moved with harness/ unchanged is the same code. */
export function sameCode(a, b) {
  if (!a || !b) return null;
  if (a.version && b.version && a.version !== b.version) return false;
  if (a.harness && b.harness) return a.harness === b.harness;
  if (!a.harness && !b.harness && a.head && b.head && a.head === b.head) return true;
  return null;
}

/** "2.85.0 (1155180a)". */
export const stampWords = (s) => (s ? `${s.version || '?'} (${String(s.head || '').slice(0, 8) || 'no commit'})` : 'unknown code');

export const selfRestartOn = (env = process.env) => !/^(off|0|false|no)$/i.test(String(env.STUDIO_SUPERVISOR_SELF_RESTART ?? '').trim());
/** The systemd user unit `npm run studio:start -- --install` writes for this checkout. */
export const systemdUnitFile = (root, home = os.homedir()) => path.join(home, '.config', 'systemd', 'user', `studio-${path.basename(root).replace(/[^a-z0-9-]/gi, '-').toLowerCase()}.service`);
/** What a person runs to restart the supervisor by hand. */
export const RESTART_BY_HAND = 'npm run studio:stop, then npm run studio:start';

/**
 * How this supervisor can restart itself: { how: 'spawn'|'exit'|null, why, byHand }. tty: it runs in a terminal (a person
 * watches its output there). unitText: the systemd unit's text (read from systemdUnitFile when not given).
 */
export function restartHow({ env = process.env, tty = false, root = process.cwd(), unitText = undefined } = {}) {
  if (!selfRestartOn(env)) return { how: null, why: 'STUDIO_SUPERVISOR_SELF_RESTART is off', byHand: RESTART_BY_HAND };
  if (String(env.INVOCATION_ID || '').trim()) {
    const text = unitText === undefined ? readText(systemdUnitFile(root)) : unitText;
    if (/^\s*KillMode\s*=\s*process\s*$/m.test(String(text || ''))) return { how: 'exit', why: 'a systemd service: it exits and systemd starts it again (Restart=on-failure); KillMode=process keeps the agents running', byHand: RESTART_BY_HAND };
    return { how: null, why: 'it runs as a systemd service installed before 2.86, whose stop would end every agent session too: reinstall it once (npm run studio:start -- --install) and it restarts itself after the next update', byHand: 'npm run studio:start -- --install (it restarts the service once; agents running then end)' };
  }
  if (/^com\.studio\./.test(String(env.XPC_SERVICE_NAME || ''))) return { how: 'exit', why: 'a launchd job: it exits and launchd starts it again (KeepAlive); agent sessions run in their own process groups', byHand: RESTART_BY_HAND };
  if (tty) return { how: null, why: 'it runs in the foreground of a terminal, where a person watches it', byHand: 'stop it there (Ctrl+C) and run the same command again' };
  return { how: 'spawn', why: 'it runs on its own: a fresh supervisor with the same options takes over when this one ends', byHand: RESTART_BY_HAND };
}

/**
 * Note new code once. rec keeps rec.codeChanged = { at, from, to, restart, why, byHand }. Returns { changed, first,
 * restart }: changed while the installed code differs from `running`; first on the pass that noticed it (then one
 * harness.code_changed event and one loud console block); restart is the method, or null (warn only).
 */
export function noticeNewCode(rec, { name = 'supervisor', pid = process.pid, running, installed, how = { how: null, why: '' }, emit = () => {}, log = console.error, now = Date.now() } = {}) {
  const same = sameCode(running, installed);
  if (same !== false) return { changed: false, first: false, restart: null };
  const prev = rec.codeChanged;
  if (prev && sameCode(prev.to, installed) === true && prev.to?.version === installed.version) return { changed: true, first: false, restart: prev.failed ? null : prev.restart };
  rec.codeChanged = { at: new Date(now).toISOString(), from: running, to: installed, restart: how.how || null, why: how.why || '', byHand: how.byHand || RESTART_BY_HAND };
  const then = how.how ? `it restarts itself at a quiet point between passes (${how.why})` : `it keeps running the old code (${how.why}): restart it: ${how.byHand || RESTART_BY_HAND}`;
  const msg = `The ${name} (pid ${pid}) runs harness ${stampWords(running)}, but ${stampWords(installed)} is installed: ${then}`;
  try { emit({ type: 'harness.code_changed', agent: name, to: 'producer', status: how.how ? 'info' : 'warn', msg: msg.slice(0, 600), meta: { process: name, pid, from: running, to: installed, restart: how.how || null, why: how.why || null } }); } catch { /* the console says it */ }
  try { log(how.how ? `[${name}] ${msg}` : ['', `[${name}] ==== OLD HARNESS CODE ====`, `[${name}] ${msg}`, `[${name}] ==========================`, ''].join('\n')); } catch {}
  return { changed: true, first: true, restart: how.how || null };
}

/** Write the state a successor takes (HANDOFF_KEYS, the options as they are now) to <stateDir>/supervisor-handoff.json. */
export function writeHandoff(stateDir, state, { pid = process.pid, now = Date.now() } = {}) {
  const keep = {};
  for (const k of HANDOFF_KEYS) if (state[k] !== undefined) keep[k] = state[k];
  // The clocks that default to the start time carry the old start, so the successor reads the log from where this one was.
  keep.haltCheckFrom ??= state.startedAt;
  keep.startBackoffSeen ??= state.startedAt;
  const rec = { from: pid, at: new Date(now).toISOString(), opts: state.opts || {}, state: keep, startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, HANDOFF_FILE), `${JSON.stringify(rec, null, 2)}\n`);
  return rec;
}

/** The handed-off state, taken once (the file is removed): null when there is none, it is stale, or its writer still runs. */
export function takeHandoff(stateDir, { alive = () => false, now = Date.now(), maxAgeMs = HANDOFF_MAX_AGE_MS } = {}) {
  const f = path.join(stateDir, HANDOFF_FILE);
  const rec = readJsonFile(f);
  if (!rec) return null;
  if (rec.from && alive(Number(rec.from))) return null;
  try { fs.rmSync(f, { force: true }); } catch { /* read once anyway */ }
  const age = now - Date.parse(rec.at || '');
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
  return rec;
}

/** Wait until `pid` has ended (never two supervisors at once): true when it did within timeoutMs. sleep(ms) is injected in tests. */
export async function waitGone(pid, { alive, timeoutMs = 60000, stepMs = 250, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  const until = now() + timeoutMs;
  for (;;) {
    if (!alive(Number(pid))) return true;
    if (now() >= until) return false;
    await sleep(stepMs);
  }
}

/** Another long-running process's record: .studio/running/<name>-<pid>.json { name, pid, code, startedAt, restart, byHand }. */
export function noteRunning(stateDir, { name, pid = process.pid, code, restart = null, byHand = '', now = Date.now() }) {
  const dir = path.join(stateDir, 'running');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}-${pid}.json`), `${JSON.stringify({ name, pid, code, startedAt: new Date(now).toISOString(), restart, byHand }, null, 2)}\n`);
  } catch { /* a report, never a crash */ }
}
/** The records in .studio/running/ whose process is still there (the others are removed). */
export function runningRecords(stateDir, { alive = () => false } = {}) {
  const dir = path.join(stateDir, 'running');
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return out; }
  for (const n of names) {
    const r = readJsonFile(path.join(dir, n));
    if (r?.pid && alive(Number(r.pid))) out.push(r);
    else { try { fs.rmSync(path.join(dir, n), { force: true }); } catch {} }
  }
  return out;
}

/**
 * The long-running processes still on code other than `installed`: [{ name, pid, runs, line, restarts }]. A supervisor
 * record without a stamp (a supervisor older than 2.86) counts when it started before `since` (the update's time).
 * deps.alive(pid, identity) tells whether a recorded process still runs.
 */
export function oldCodeReport({ stateDir, installed, since = null, alive = () => false, env = process.env } = {}) {
  const out = [];
  const s = readJsonFile(path.join(stateDir, 'supervisor.json'));
  if (s && s.status === 'running' && s.pid && alive(Number(s.pid), s.identity)) {
    const same = sameCode(s.code, installed);
    const before = since !== null && Date.parse(s.startedAt || '') < since;
    if (same === false || (!s.code && before)) {
      // The supervisor decided its restart method at its start; the setting can be turned off later (it is re-read from .env).
      const self = s.code && s.restart?.how && selfRestartOn(env) && !s.codeChanged?.failed;
      const runs = s.code ? stampWords(s.code) : `the code it started with at ${String(s.startedAt || '?').slice(0, 16).replace('T', ' ')} UTC`;
      const then = !s.code ? `it is older than 2.86 and can't tell: restart it: ${RESTART_BY_HAND}`
        : self ? 'it restarts itself at its next pass (within about a minute)'
          : `${s.restart?.why || s.codeChanged?.why || 'it does not restart itself'}: restart it: ${s.restart?.byHand || RESTART_BY_HAND}`;
      out.push({ name: 'supervisor', pid: s.pid, runs: s.code || null, restarts: Boolean(self), line: `supervisor runs ${runs}, installed ${stampWords(installed)}: ${then}` });
    }
  }
  for (const r of runningRecords(stateDir, { alive: (p) => alive(p) })) {
    if (sameCode(r.code, installed) !== false) continue;
    out.push({ name: r.name, pid: r.pid, runs: r.code, restarts: Boolean(r.restart), line: `${r.name} (pid ${r.pid}) runs ${stampWords(r.code)}, installed ${stampWords(installed)}: ${r.restart ? 'it restarts itself' : `restart it: ${r.byHand || 'stop it and start it again'}`}` });
  }
  return out;
}

/**
 * What keeps running on the code it started with until it ends, which is fine: agent sessions (each its own launcher
 * process, .studio/agents/<agent>.json) and running trains (their lock files). { sessions: [agent], trains: [label] }.
 */
export function workStillRunning(stateDir, { alive = () => false } = {}) {
  const sessions = [];
  const trains = [];
  let names = [];
  try { names = fs.readdirSync(path.join(stateDir, 'agents')).filter((n) => n.endsWith('.json')); } catch { names = []; }
  for (const n of names) {
    const r = readJsonFile(path.join(stateDir, 'agents', n));
    if (r?.status === 'running' && r.supervisor && alive(Number(r.supervisor))) sessions.push(r.agent || n.replace(/\.json$/, ''));
  }
  let locks = [];
  try { locks = fs.readdirSync(path.join(stateDir, 'locks')).filter((n) => /^([a-z][a-z0-9-]{1,30}-)?train\.lock$/.test(n)); } catch { locks = []; }
  for (const n of locks.sort()) {
    const r = readJsonFile(path.join(stateDir, 'locks', n));
    if (r?.pid && alive(Number(r.pid))) trains.push(`${n === 'train.lock' ? 'the merge train' : `the ${n.replace(/-train\.lock$/, '')} train`}${r.id ? ` ${r.id}` : ''} (pid ${r.pid})`);
  }
  return { sessions, trains };
}
