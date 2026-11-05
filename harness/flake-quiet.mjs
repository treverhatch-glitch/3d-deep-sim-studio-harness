/**
 * harness/flake-quiet.mjs — 2.78.0 (PU-56): wait for a quiet machine before the flake triager's confirming re-run.
 *
 * A test that fails "alone" while other verifies still run may only need a quiet machine (the crew's 2 ms timing test:
 * 2.2-2.5 ms under load, 0.7-1.1 ms alone). The re-run at low load waits until no other heavy job runs: no live
 * machine:heavy holder (a verify, a Unity run, ...), no other game check holding a gate slot, no heavy program (Unity)
 * outside the lock. The holder this process runs inside (STUDIO_HEAVY_HELD) and this process are not "other".
 * Bounded by STUDIO_FLAKE_QUIET_WAIT_MIN (harness/flakes.mjs quietWaitMin, default 10). Never throws: when the
 * machine can't be read it counts as quiet (there is no evidence of load to wait for).
 * 2.78.2 (b): a live agent session in a role that drives a game engine (STUDIO_QUIET_BUSY_ROLES, default
 * engine-porter,engine-worker: a Unity porter starts and stops the editor between steps, so "no Unity process right
 * now" didn't mean quiet) counts as other work too, whether or not its engine is running at that moment; the session
 * this process runs in (STUDIO_LOCK_OWNER) doesn't. off: roles don't count (a Unity process still does, as before).
 * The game:perf step (harness/game-gates.mjs) waits on the same test.
 */
import fs from 'node:fs';
import path from 'node:path';
import { heavyHolders, laneCheckSlots, implicitHolders, describeHolder, describeImplicit } from './heavy.mjs';
import { recordAlive } from './proc-identity.mjs';

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 2.78.2 (b): STUDIO_QUIET_BUSY_ROLES as a list (default engine-porter,engine-worker, also when empty; off: none). */
export function quietBusyRoles(env = process.env) {
  const v = String(env.STUDIO_QUIET_BUSY_ROLES ?? '').trim() === '' ? 'engine-porter,engine-worker' : String(env.STUDIO_QUIET_BUSY_ROLES);
  return /^(off|0|false|no)$/i.test(v.trim()) ? [] : v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
}

/**
 * 2.78.2 (b): live agent sessions (<root>/.studio/agents/*.json, harness/agent.mjs sessions) in a busy role, not the one
 * this process runs in: [{ agent, role, pid }]. Never throws. Injectable: alive (record -> boolean) for tests.
 */
export function busySessions(root, { env = process.env, alive = recordAlive } = {}) {
  const roles = quietBusyRoles(env);
  if (!roles.length || !root) return [];
  const own = String(env.STUDIO_LOCK_OWNER || '').trim();
  const dir = path.join(root, '.studio', 'agents');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    if (!s || s.status !== 'running' || !roles.includes(String(s.role || '').toLowerCase()) || (own && s.agent === own)) continue;
    let live = false;
    try { live = Boolean(alive(s)); } catch { live = false; }
    if (live) out.push({ agent: String(s.agent || n.replace(/\.json$/, '')), role: String(s.role), pid: Number(s.supervisor || s.pid) || null });
  }
  return out;
}

/** Who else is busy now: [text]. Injectable: busy (a function returning that list) for tests. */
export function otherWork(root, { env = process.env, self = process.pid } = {}) {
  const out = [];
  const held = String(env.STUDIO_HEAVY_HELD || '').match(/^(machine-heavy-\d+\.lock):(\d+)$/);
  try { for (const h of heavyHolders(root, { env })) if (Number(h.pid) !== self && !(held && h.file === held[1] && Number(h.pid) === Number(held[2]))) out.push(describeHolder(h)); } catch {}
  try { for (const g of laneCheckSlots(root, env)) out.push(`${g.label || 'a game check'} (pid ${g.pid})`); } catch {}
  try { for (const p of implicitHolders(root, { env })) out.push(describeImplicit(p)); } catch {}
  try { for (const x of busySessions(root, { env })) out.push(`${x.agent} (an ${x.role} session${x.pid ? `, pid ${x.pid}` : ''}: it drives a game engine; STUDIO_QUIET_BUSY_ROLES)`); } catch {}
  return out;
}

/** Wait up to waitMin minutes for otherWork() to be empty: { quiet, waitedMs, busy }. Injectable: busy, sleep, now, pollMs. */
export function waitQuiet(root, { waitMin = 10, env = process.env, log = () => {}, busy = null, sleep = sleepSync, now = Date.now, pollMs = 2000, what = 'the confirming re-run' } = {}) {
  const t0 = now();
  const limit = Math.max(0, Number(waitMin) || 0) * 60000;
  let told = '';
  for (;;) {
    let b = [];
    try { b = busy ? busy() : otherWork(root, { env }); } catch { b = []; }
    if (!b.length) return { quiet: true, waitedMs: now() - t0, busy: [] };
    if (now() - t0 >= limit) return { quiet: false, waitedMs: now() - t0, busy: b };
    const line = `waiting for a quiet machine before ${what}: ${b.slice(0, 3).join('; ')}${b.length > 3 ? ` (+${b.length - 3} more)` : ''}`;
    if (line !== told) { told = line; log(line); }
    sleep(Math.min(pollMs, Math.max(1, limit - (now() - t0))));
  }
}
