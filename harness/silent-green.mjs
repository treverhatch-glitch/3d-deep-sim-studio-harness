/**
 * harness/silent-green.mjs — 2.36.0: a check that exits 0 but ran no tests is not a pass.
 *
 * The research pack measured it: GUT 9.5.0 with a test file that doesn't parse prints "Nothing was run" and
 * exits 0; gdUnit4 leaves an older report behind; vitest and jest can find no test files and still pass with
 * the wrong flags. A gate built on such a runner goes green when the tests are broken.
 *
 * STUDIO_SILENT_GREEN: "warn" (the default: the gate still passes, the output says so and a
 * gate.silent_green event is logged), "fail" (the gate fails: opt in for a studio whose checks are set up),
 * or "off".
 */
import { emitEvent } from './event.mjs';

// Phrases test runners print when nothing ran. Each is specific enough not to match a normal pass.
const NOTHING_RAN = [
  [/\bNothing was run\b/i, 'GUT: nothing was run'],
  [/\bNo test files found\b/i, 'no test files found'],
  [/\bNo tests found\b/i, 'no tests found'],
  [/\bno tests ran\b/i, 'no tests ran'],
  [/\bcollected 0 items\b/i, 'pytest collected 0 items'],
  [/^# tests 0\s*$/m, 'node:test ran 0 tests'],
  [/\bTests:\s+0 total\b/i, 'jest ran 0 tests'],
  [/\bTest Files\s+0\b|\bTests\s+0 \(0\)/i, 'vitest ran 0 tests'],
  [/\b0 tests?,\s*0 (passed|failures?)\b/i, '0 tests'],
  [/\b(Total|Executed)\s*(tests?)?\s*[:=]\s*0\b(?!\.\d)/i, '0 tests in the summary'],
];

export function silentGreenMode(env = process.env) {
  const v = String(env.STUDIO_SILENT_GREEN || 'warn').toLowerCase();
  return ['fail', 'off'].includes(v) ? v : 'warn';
}

/** Why a passing run's output says nothing ran, or null. */
export function nothingRan(output = '') {
  const text = String(output || '');
  for (const [re, why] of NOTHING_RAN) if (re.test(text)) return why;
  return null;
}

/**
 * Judge a check that exited 0. Returns { ok, why, note }: with "fail" a silent green is not ok; with "warn" it
 * stays ok and carries a note; with "off" nothing is checked. `count` (when the caller knows it) wins over
 * the output: 0 tests counted is a silent green whatever the output says.
 */
export function judgePass(id, { output = '', count = null, env = process.env } = {}) {
  const mode = silentGreenMode(env);
  if (mode === 'off') return { ok: true, why: '', note: '' };
  const why = count === 0 ? 'it counted 0 tests' : nothingRan(output);
  if (!why) return { ok: true, why: '', note: '' };
  const msg = `${id} passed but ran no tests (${why})`;
  try { emitEvent({ type: 'gate.silent_green', agent: 'gates', to: 'producer', status: 'warn', msg, meta: { gate: id, why, mode } }); } catch { /* a log line, never a crash */ }
  return mode === 'fail'
    ? { ok: false, why: `${msg}: a check that ran nothing is not a pass (STUDIO_SILENT_GREEN=fail)`, note: '' }
    : { ok: true, why: '', note: `${msg}; set STUDIO_SILENT_GREEN=fail to make this fail the gate` };
}
