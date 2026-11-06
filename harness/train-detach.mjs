/**
 * harness/train-detach.mjs — 2.78.2 (a, W-0090): a merge train outlives whoever started it.
 *
 * A lane's plain `task done` ran its train inline (harness/task.mjs viaTrain -> runTrain), in the builder's shell. Claude
 * Code ends a shell command after 10 minutes and the watchdog ends a session at its cap, so every train over ~10 minutes
 * died with its builder (6 deaths in one morning). Now:
 *   - `task done` in a lane (the train path) runs the quick checks, queues the lane and exits 0 with "queued"
 *     (STUDIO_DONE_QUEUE, default on; =0/off: the old inline train). The train itself is the train daemon's
 *     (harness/train-daemon.mjs, each supervisor pass) when a supervisor runs and train auto is on; otherwise
 *     kickTrain starts one train, detached, that waits for a running train first (STUDIO_TRAIN_LOCK_WAIT_MIN).
 *   - spawnDetached: a train process is started through a launcher process that starts it detached and exits at once,
 *     so the train's parent is gone before its starter can be killed: a kill of the starter's process tree (taskkill /T
 *     on Windows walks parent ids; a process-group kill elsewhere) doesn't reach it. Its output goes to a log file
 *     (stdio never tied to the starter's console), windowsHide on Windows.
 *   - `npm run task -- train` run from an agent's shell (a launched session, or a shell Claude Code, Codex, Gemini or
 *     another agent runs: STUDIO_ROLE, an agent's STUDIO_LOCK_OWNER, CLAUDECODE, AI_AGENT, …) runs its train that way
 *     too and follows it (its output and exit code, as before); if the shell is ended, the train goes on
 *     (`npm run task -- train status` shows it). STUDIO_TRAIN_DETACH: auto (default: only from an agent's shell), on,
 *     off; `--foreground` / `--detach` for one run. A person's terminal keeps the inline train (Ctrl+C stops it).
 * The train's own life record (harness/train-life.mjs) holds the train process's pid, its heartbeat and its lock, so a
 * train whose starter died is alive by every check (reapDeadTrains, the communicator, the daemon's lock test).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchedSession } from './agent-env.mjs';
import { AGENT_SHELL } from './permission.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const off = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());
const onV = (v) => /^(on|1|true|yes)$/i.test(String(v ?? '').trim());
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** STUDIO_DONE_QUEUE (default on): a lane's task done queues the lane for the train instead of running it inline. */
export const doneQueueOn = (env = process.env) => !off(env.STUDIO_DONE_QUEUE);
/** STUDIO_TRAIN_DETACH: 'auto' (default), 'on' or 'off'. */
export const detachMode = (env = process.env) => (off(env.STUDIO_TRAIN_DETACH) ? 'off' : onV(env.STUDIO_TRAIN_DETACH) ? 'on' : 'auto');
/** Does this process run in an agent's shell (one an agent tool may end at its command time limit)? */
export const agentShell = (env = process.env) => Boolean(launchedSession(env) || AGENT_SHELL.some((k) => String(env[k] || '').trim()));
/** Should `task train` (the run form) run its train detached and follow it? flags: --detach / --foreground. */
export function detachTrain(flags = {}, env = process.env) {
  if (env.STUDIO_TRAIN_FOLLOWED) return false; // already the detached train
  if (flags['dry-run']) return false;
  if (flags.foreground) return false;
  if (flags.detach) return true;
  const m = detachMode(env);
  return m === 'on' || (m === 'auto' && agentShell(env));
}

export const pidAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  // A zombie (ended, not yet reaped by a parent that never waits) is gone for us.
  try { if (/\)\s+Z\s/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false; } catch {}
  return true;
};

/**
 * Start `node <args>` so it survives its starter: a launcher (this file, `launch`) starts it detached with its output
 * in `out` (and `err`, default the same file) and exits; returns { ok, pid, why? }. The child's environment: env, with
 * the session identity keys left as given (callers pass what the train should run as).
 */
export function spawnDetached({ args, out, err = out, env = process.env, cwd = process.cwd(), timeoutMs = 30000 } = {}) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (err !== out) fs.mkdirSync(path.dirname(err), { recursive: true });
  const pidFile = `${out}.${process.pid}-${Date.now()}.pid`;
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'launch', '--out', out, '--err', err, '--pid-file', pidFile, '--cwd', cwd, '--', ...args], { cwd, env, windowsHide: true, stdio: 'ignore', timeout: timeoutMs });
  let pid = null;
  try { pid = Number(fs.readFileSync(pidFile, 'utf8')) || null; } catch {}
  try { fs.rmSync(pidFile, { force: true }); } catch {}
  if (!pid) return { ok: false, pid: null, why: r.error ? r.error.message : `the launcher exited ${r.status ?? r.signal ?? '?'} without starting it` };
  return { ok: true, pid };
}

/**
 * `task train` from an agent's shell: the same command runs detached (STUDIO_TRAIN_FOLLOWED marks it, its exit code goes
 * to a file) and this process copies its output and returns its exit code. If this process is ended, the train goes on.
 */
export async function followDetached({ root, argv, env = process.env, outStream = process.stdout, errStream = process.stderr, pollMs = 300 } = {}) {
  const dir = path.join(root, '.studio', 'train', 'runs');
  const base = path.join(dir, `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')}-${process.pid}`);
  const out = `${base}.out.log`;
  const err = `${base}.err.log`;
  const codeFile = `${base}.exit`;
  const s = spawnDetached({ args: [path.join(HERE, 'task.mjs'), ...argv], out, err, env: { ...env, STUDIO_TRAIN_FOLLOWED: codeFile }, cwd: process.cwd() });
  if (!s.ok) { errStream.write(`[train] couldn't start the train detached (${s.why}); running it here instead\n`); return null; }
  const rel = (f) => path.relative(root, f).split(path.sep).join('/');
  errStream.write(`[train] the train runs detached (pid ${s.pid}; output ${rel(out)}): it goes on if this shell is ended (npm run task -- train status shows it; STUDIO_TRAIN_DETACH=off or --foreground runs it here)\n`);
  const pos = { out: 0, err: 0 };
  const copy = (f, k, stream) => {
    try {
      const st = fs.statSync(f);
      if (st.size <= pos[k]) return;
      const fd = fs.openSync(f, 'r');
      try { const b = Buffer.alloc(st.size - pos[k]); fs.readSync(fd, b, 0, b.length, pos[k]); pos[k] = st.size; stream.write(b); } finally { fs.closeSync(fd); }
    } catch {}
  };
  for (;;) {
    copy(out, 'out', outStream);
    copy(err, 'err', errStream);
    const ended = fs.existsSync(codeFile) || !pidAlive(s.pid);
    if (ended) {
      await new Promise((r) => setTimeout(r, pollMs));
      copy(out, 'out', outStream);
      copy(err, 'err', errStream);
      let code = null;
      try { code = Number(fs.readFileSync(codeFile, 'utf8')); } catch {}
      try { fs.rmSync(codeFile, { force: true }); } catch {}
      if (!Number.isInteger(code)) { errStream.write(`[train] the detached train (pid ${s.pid}) ended without an exit code (killed?); npm run task -- train status\n`); return 1; }
      return code;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** In the detached `task train`: record the exit code for the follower. */
export function recordFollowedExit(env = process.env) {
  const f = String(env.STUDIO_TRAIN_FOLLOWED || '').trim();
  if (!f || !path.isAbsolute(f)) return;
  process.on('exit', (code) => { try { fs.writeFileSync(f, String(code ?? 0)); } catch {} });
}

/**
 * After a queued task done: make sure a train will run. A supervisor running with the train daemon on: its next pass
 * starts it (by the batch and machine-room rules). Otherwise one train starts now, detached (train-daemon.mjs run
 * --wait <min>), and waits for a running train first. Returns { how: 'daemon'|'spawned'|'off'|'failed', pid?, line }.
 * deps (tests): { supervisor(root) -> record|null, auto(root, env) -> { on, why }, trainOn(env), spawn(opts) }.
 */
export async function kickTrain(root, { by = '', env = process.env, waitMin = 120, deps = {} } = {}) {
  const td = await import('./train-daemon.mjs');
  const tr = await import('./train.mjs');
  let sup = null;
  try { sup = deps.supervisor ? deps.supervisor(root) : (await import('./boot.mjs')).runningSupervisor(root); } catch { sup = null; }
  const auto = (deps.auto || td.trainAuto)(root, env);
  const trOn = (deps.trainOn || tr.trainOn)(env);
  if (sup && auto.on && trOn) {
    const sec = Number(env.STUDIO_SUPERVISOR_SEC || 60);
    return { how: 'daemon', line: `The train daemon starts the train at the supervisor's next pass (every ${sec} s), when lanes are ready and the machine has room for a verify.` };
  }
  // 2.79 (b): `train auto off` (or STUDIO_TRAIN_AUTO=off) is honoured here too: a queued task done doesn't start a train
  // behind the person's back (2.78.2 started one at 23:46 after the switch was set at 22:49). The lane waits in the queue.
  if (!auto.on) return { how: 'off', line: `No train was started: ${auto.why}. The lane waits in the queue until a person runs one (npm run task -- train --by <you>) or turns the daemon on.` };
  const why = !sup ? 'no supervisor is running' : !auto.on ? auto.why : 'STUDIO_TRAIN is off';
  const log = path.join(root, '.studio', 'train', 'daemon.log');
  const { daemonEnv } = await import('./boot.mjs');
  const childEnv = { ...daemonEnv(env), STUDIO_LOCK_OWNER: td.DAEMON_BY, STUDIO_MAIN_ROOT: root, STUDIO_TASK_PIN: '' };
  const s = (deps.spawn || spawnDetached)({ args: [path.join(HERE, 'train-daemon.mjs'), 'run', '--wait', String(Math.max(0, Number(waitMin) || 0)), '--kicked-by', String(by || '?').slice(0, 60)], out: log, env: childEnv, cwd: root });
  if (!s.ok) return { how: 'failed', line: `Couldn't start a train (${s.why}); npm run task -- train --by <you> lands the queue (or a supervisor's train daemon does).` };
  try { fs.writeFileSync(td.DAEMON_FILE(root), `${JSON.stringify({ pid: s.pid, at: new Date().toISOString(), kickedBy: by || null })}\n`); } catch {}
  return { how: 'spawned', pid: s.pid, line: `A train started for it, detached (pid ${s.pid}; ${why}; log .studio/train/daemon.log): it waits for a running train first, and goes on when this session ends.` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) && process.argv[2] === 'launch') {
  const a = process.argv.slice(3);
  const sep = a.indexOf('--');
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 && i < sep ? a[i + 1] : null; };
  const args = a.slice(sep + 1);
  const outFd = fs.openSync(opt('--out'), 'a');
  const errFd = opt('--err') && opt('--err') !== opt('--out') ? fs.openSync(opt('--err'), 'a') : outFd;
  const child = spawn(process.execPath, args, { cwd: opt('--cwd') || process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', outFd, errFd], env: process.env });
  child.on('error', () => {});
  child.unref();
  if (child.pid) { try { fs.writeFileSync(opt('--pid-file'), String(child.pid)); } catch {} }
  // Its parent ends now: the train is nobody's child (a tree kill of the starter can't reach it).
  sleep(50);
  process.exit(child.pid ? 0 : 1);
}
