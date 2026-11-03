/**
 * harness/ram.mjs — free memory against STUDIO_RAM_FLOOR_GB, shared by the supervisor (no new agent below it) and
 * machine:heavy (no heavy start below it). Its only harness import is machine.mjs, which imports nothing of the
 * harness: supervisor.mjs and heavy.mjs both import this, and neither may import the other at load.
 */
import os from 'node:os';
import { readMachine, memHeadroomGb, sampleMs } from './machine.mjs';

/**
 * 2.59.0 (#11c): is free memory under STUDIO_RAM_FLOOR_GB (3; 0 turns it off)? { low, freeGb, floorGb, why }.
 * Free memory is os.freemem() (on Linux the kernel's "available" figure; on Windows free physical memory).
 * 2.68.0 (m): on Windows the machine scan's commit headroom (commit limit - committed, harness/machine.mjs) counts too:
 * freeGb is the smaller of the two (the crew's PC had 5.8 GB "available" at 55/60 GB committed, so the floor never
 * tripped while allocations failed). The scan is the last one (.studio/machine.json, at most 2 x STUDIO_MACHINE_SAMPLE_S
 * old; on Windows a stale one is redone); STUDIO_MACHINE_SCAN=off or no scan: os.freemem alone, as before.
 * Test hooks, inert unless set: opts.freemem (a function giving bytes) or STUDIO_TEST_FREEMEM_MB; opts.machine (a profile,
 * or null for none).
 */
export function ramCheck(opts = {}, env = process.env) {
  const floorGb = env.STUDIO_RAM_FLOOR_GB === undefined || env.STUDIO_RAM_FLOOR_GB === '' ? 3 : Number(env.STUDIO_RAM_FLOOR_GB);
  if (!(floorGb > 0)) return { low: false, floorGb: 0 };
  const test = env.STUDIO_TEST_FREEMEM_MB;
  const bytes = typeof opts.freemem === 'function' ? Number(opts.freemem()) : test !== undefined && test !== '' ? Number(test) * 1024 * 1024 : os.freemem();
  if (!Number.isFinite(bytes)) return { low: false, floorGb };
  const availGb = Math.round((bytes / 1024 ** 3) * 10) / 10;
  let profile = null;
  // A stale scan is redone only on Windows (where the commit charge matters), never under a test's memory hook.
  const faked = typeof opts.freemem === 'function' || (test !== undefined && test !== '');
  try { profile = opts.machine !== undefined ? opts.machine : readMachine({ env, maxAgeMs: 2 * sampleMs(env), scan: process.platform === 'win32' && !faked }); } catch { profile = null; }
  const r = profile?.os === 'win32' ? profile.ram || {} : {};
  const commitGb = Number.isFinite(r.commitLimitGb) && Number.isFinite(r.commitUsedGb) ? memHeadroomGb({ os: 'win32', ram: { commitLimitGb: r.commitLimitGb, commitUsedGb: r.commitUsedGb } }) : null;
  const byCommit = commitGb !== null && commitGb < availGb;
  const freeGb = byCommit ? commitGb : availGb;
  const why = byCommit
    ? `commit headroom ${freeGb} GB (${r.commitUsedGb}/${r.commitLimitGb} GB committed; ${availGb} GB available) is under the floor (STUDIO_RAM_FLOOR_GB=${floorGb}): no new agent starts until more is free`
    : `free memory ${freeGb} GB is under the floor (STUDIO_RAM_FLOOR_GB=${floorGb}): no new agent starts until more is free`;
  return { low: freeGb < floorGb, freeGb, floorGb, why, availableGb: availGb, ...(commitGb !== null ? { commitHeadroomGb: commitGb } : {}) };
}
