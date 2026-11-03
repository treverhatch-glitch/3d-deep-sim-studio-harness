/**
 * harness/hub-keeper.mjs — 2.74.0 (B-70, "the hub keeps dropping"): the supervisor keeps the War Room hub up, with backoff,
 * and says why it restarted it.
 *
 * Each supervisor pass calls keepHub(). The hub counts as up when GET /health answers within 5 s (it was 2 s: a busy hub
 * building a big HUD page was logged as "down"). When it is down:
 *   - its process is still there (our child): it is busy or hung. Left alone for STUDIO_HUB_HANG_MIN (5) minutes, then
 *     ended and restarted ("didn't answer /health for N min").
 *   - another hub process (the pid in .studio/hub.json, alive) holds the port: never touched, only reported.
 *   - no hub: started again (hidden on Windows), at most once per backoff step: 30 s, 1, 2, 4, 8, then every 10 minutes
 *     while it keeps failing; the steps start over once it has stayed up 10 minutes.
 * The cause is the hub's own last line in .studio/logs/hub-exit.log (hub/server.mjs writes it on every exit: a signal, an
 * uncaught error, the port in use), else its exit code. It is kept in supervisor.json (hubKeep.lastRestart) for
 * `npm run studio:status`, and each restart is a supervisor.hub_restart event.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { pidAlive } from './proc-identity.mjs';

export const HUB_EXIT_LOG_REL = '.studio/logs/hub-exit.log';
const MIN = 60000;
export const hangMs = (env = process.env) => (Number(env.STUDIO_HUB_HANG_MIN) > 0 ? Number(env.STUDIO_HUB_HANG_MIN) : 5) * MIN;
/** The wait before restart number n (1-based) in a row: 30 s, 1, 2, 4, 8, 10, 10 … minutes. */
export const backoffMs = (n) => Math.min(10 * MIN, 30000 * 2 ** Math.max(0, n - 1));

export function hubHealthy(port, { timeoutMs = 5000 } = {}) {
  return fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) }).then((r) => r.ok, () => false);
}

/** The hub's last recorded exit since `since` (ms), as one line, or ''. */
export function lastExitCause(root = REPO_ROOT, since = 0) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(root, HUB_EXIT_LOG_REL), 'utf8').split('\n').filter(Boolean).slice(-50); } catch { return ''; }
  for (const l of lines.reverse()) {
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    if (j.kind !== 'exit') continue;
    if ((Date.parse(j.at) || 0) < since - 2 * MIN) return '';
    return String(j.cause || '').split('\n')[0].slice(0, 300);
  }
  return '';
}

function defaultSpawn(root, env) {
  fs.mkdirSync(path.join(root, '.studio'), { recursive: true });
  const log = fs.openSync(path.join(root, '.studio', 'hub.log'), 'a');
  return spawn(process.execPath, [path.join(root, 'hub', 'server.mjs')], { cwd: root, stdio: ['ignore', log, log], env, windowsHide: true });
}
const childAlive = (c) => Boolean(c) && c.exitCode === null && c.signalCode === null;
const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);

/**
 * One pass. state is the supervisor's (state.hubKeep and state.hubDown are kept there). Returns { child, action, why }:
 * action is ok | waiting | ended | other-hub | backoff | restarted.
 */
export async function keepHub({ state, port, child = null, now = Date.now(), env = process.env, root = REPO_ROOT, loopMs = MIN, healthy = null, spawnHub = null, emit = emitEvent, kill = (c) => c.kill() } = {}) {
  const k = (state.hubKeep ||= { restarts: 0, fails: 0 });
  state.hubDown ||= [];
  const up = healthy ? await healthy() : await hubHealthy(port);
  if (up) {
    if (k.downSince) {
      if (now - k.downSince > loopMs) {
        state.hubDown.push({ from: new Date(k.downSince).toISOString(), to: new Date(now).toISOString() });
        state.hubDown = state.hubDown.slice(-20);
        emit({ type: 'supervisor.hub_restarted', agent: 'supervisor', to: 'producer', msg: `The War Room hub was down from ${hhmm(k.downSince)} to ${hhmm(now)}; restarted${k.lastRestart?.why ? ` (${k.lastRestart.why})` : ''}`.slice(0, 400), meta: { why: k.lastRestart?.why || null } });
      }
      k.downSince = null;
      k.upSince = now;
    }
    k.upSince ||= now;
    if (now - k.upSince >= 10 * MIN) { k.fails = 0; k.nextAt = 0; }
    return { child, action: 'ok', why: '' };
  }
  k.downSince ||= now;
  k.upSince = null;
  const downS = Math.round((now - k.downSince) / 1000);
  if (childAlive(child)) {
    if (now - k.downSince < hangMs(env)) return { child, action: 'waiting', why: `the hub (pid ${child.pid}) is running but hasn't answered /health for ${downS} s (busy?)` };
    k.pendingWhy = `the hub (pid ${child.pid}) didn't answer /health for ${Math.round((now - k.downSince) / MIN)} min: ended it`;
    try { kill(child); } catch {}
    return { child, action: 'ended', why: k.pendingWhy };
  }
  let other = null;
  try { other = JSON.parse(fs.readFileSync(path.join(root, '.studio', 'hub.json'), 'utf8')); } catch {}
  if (other?.pid && other.pid !== child?.pid && other.pid !== process.pid && pidAlive(Number(other.pid))) {
    return { child, action: 'other-hub', why: `another hub process (pid ${other.pid}, .studio/hub.json) holds port ${other.port || port} but doesn't answer /health; not touched` };
  }
  if (now < (k.nextAt || 0)) return { child, action: 'backoff', why: `restarting the hub in ${Math.round((k.nextAt - now) / 1000)} s (restart ${k.fails + 1} in a row)` };
  const why = k.pendingWhy || lastExitCause(root, k.downSince) || (child ? `it exited (${child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`}; nothing in ${HUB_EXIT_LOG_REL})` : 'it was not running');
  let next = null;
  try { next = spawnHub ? spawnHub() : defaultSpawn(root, env); } catch (err) { return { child, action: 'backoff', why: `couldn't start the hub: ${err.message}` }; }
  k.restarts += 1;
  k.fails += 1;
  k.nextAt = now + backoffMs(k.fails);
  k.pendingWhy = null;
  k.lastRestart = { at: new Date(now).toISOString(), why, n: k.restarts };
  emit({ type: 'supervisor.hub_restart', agent: 'supervisor', to: 'producer', status: k.fails > 2 ? 'warn' : undefined, msg: `Restarting the War Room hub (${why})${k.fails > 1 ? `; ${k.fails} restarts in a row, next try no sooner than ${Math.round(backoffMs(k.fails) / 1000)} s` : ''}`.slice(0, 400), meta: { why, fails: k.fails, restarts: k.restarts } });
  return { child: next, action: 'restarted', why };
}

/** For studio:status: " Hub last restarted 12:05 (why); 3 restarts this run." or ''. */
export function hubKeepLine(s) {
  const r = s?.hubKeep?.lastRestart;
  if (!r) return '';
  return ` Hub last restarted ${String(r.at).slice(11, 16)} UTC (${r.why}); ${s.hubKeep.restarts} restart${s.hubKeep.restarts === 1 ? '' : 's'} this run.`;
}

