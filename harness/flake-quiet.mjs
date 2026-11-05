/**
 * harness/flake-quiet.mjs — 2.78.0 (PU-56): wait for a quiet machine before the flake triager's confirming re-run.
 *
 * A test that fails "alone" while other verifies still run may only need a quiet machine (the crew's 2 ms timing test:
 * 2.2-2.5 ms under load, 0.7-1.1 ms alone). The re-run at low load waits until no other heavy job runs: no live
 * machine:heavy holder (a verify, a Unity run, ...), no other game check holding a gate slot, no heavy program (Unity)
 * outside the lock. The holder this process runs inside (STUDIO_HEAVY_HELD) and this process are not "other".
 * Bounded by STUDIO_FLAKE_QUIET_WAIT_MIN (harness/flakes.mjs quietWaitMin, default 10). Never throws: when the
 * machine can't be read it counts as quiet (there is no evidence of load to wait for).
 */
import { heavyHolders, laneCheckSlots, implicitHolders, describeHolder, describeImplicit } from './heavy.mjs';

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Who else is busy now: [text]. Injectable: busy (a function returning that list) for tests. */
export function otherWork(root, { env = process.env, self = process.pid } = {}) {
  const out = [];
  const held = String(env.STUDIO_HEAVY_HELD || '').match(/^(machine-heavy-\d+\.lock):(\d+)$/);
  try { for (const h of heavyHolders(root, { env })) if (Number(h.pid) !== self && !(held && h.file === held[1] && Number(h.pid) === Number(held[2]))) out.push(describeHolder(h)); } catch {}
  try { for (const g of laneCheckSlots(root, env)) out.push(`${g.label || 'a game check'} (pid ${g.pid})`); } catch {}
  try { for (const p of implicitHolders(root, { env })) out.push(describeImplicit(p)); } catch {}
  return out;
}

/** Wait up to waitMin minutes for otherWork() to be empty: { quiet, waitedMs, busy }. Injectable: busy, sleep, now, pollMs. */
export function waitQuiet(root, { waitMin = 10, env = process.env, log = () => {}, busy = null, sleep = sleepSync, now = Date.now, pollMs = 2000 } = {}) {
  const t0 = now();
  const limit = Math.max(0, Number(waitMin) || 0) * 60000;
  let told = '';
  for (;;) {
    let b = [];
    try { b = busy ? busy() : otherWork(root, { env }); } catch { b = []; }
    if (!b.length) return { quiet: true, waitedMs: now() - t0, busy: [] };
    if (now() - t0 >= limit) return { quiet: false, waitedMs: now() - t0, busy: b };
    const line = `waiting for a quiet machine before the confirming re-run: ${b.slice(0, 3).join('; ')}${b.length > 3 ? ` (+${b.length - 3} more)` : ''}`;
    if (line !== told) { told = line; log(line); }
    sleep(Math.min(pollMs, Math.max(1, limit - (now() - t0))));
  }
}
