/**
 * harness/ram.mjs — free memory against STUDIO_RAM_FLOOR_GB, shared by the supervisor (no new agent below it) and
 * machine:heavy (no heavy start below it). No harness imports: both import it, and neither may import the other at load.
 */
import os from 'node:os';

/**
 * 2.59.0 (#11c): is free memory under STUDIO_RAM_FLOOR_GB (3; 0 turns it off)? { low, freeGb, floorGb, why }.
 * Free memory is os.freemem() (on Linux the kernel's "available" figure; on Windows free physical memory).
 * Test hooks, inert unless set: opts.freemem (a function giving bytes) or STUDIO_TEST_FREEMEM_MB.
 */
export function ramCheck(opts = {}, env = process.env) {
  const floorGb = env.STUDIO_RAM_FLOOR_GB === undefined || env.STUDIO_RAM_FLOOR_GB === '' ? 3 : Number(env.STUDIO_RAM_FLOOR_GB);
  if (!(floorGb > 0)) return { low: false, floorGb: 0 };
  const test = env.STUDIO_TEST_FREEMEM_MB;
  const bytes = typeof opts.freemem === 'function' ? Number(opts.freemem()) : test !== undefined && test !== '' ? Number(test) * 1024 * 1024 : os.freemem();
  if (!Number.isFinite(bytes)) return { low: false, floorGb };
  const freeGb = Math.round((bytes / 1024 ** 3) * 10) / 10;
  return { low: freeGb < floorGb, freeGb, floorGb, why: `free memory ${freeGb} GB is under the floor (STUDIO_RAM_FLOOR_GB=${floorGb}): no new agent starts until more is free` };
}
