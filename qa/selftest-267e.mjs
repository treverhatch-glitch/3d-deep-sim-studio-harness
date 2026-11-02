/**
 * qa/selftest-267e.mjs — 2.67.0 (e): the supervisor's --help never starts a supervisor (B-47's last command: a helper's
 * smoke load of `node harness/supervisor.mjs --help` started a real one, twice).
 */
import fs from 'node:fs';
import path from 'node:path';

export async function selftest267E({ dir, run, report }) {
  const status = path.join(dir, '.studio', 'supervisor.json');
  try { fs.rmSync(status, { force: true }); } catch {}
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_WATCHDOG: 'off' };
  const h = run(dir, 'node harness/supervisor.mjs --help', env);
  const h2 = run(dir, 'node harness/supervisor.mjs -h --foreground', env);
  const text = `${h.stdout || ''}${h.stderr || ''}`;
  report('2.67.0 (e, B-47): `node harness/supervisor.mjs --help` (and -h --foreground) prints usage and exits 0 at once; no supervisor starts (no .studio/supervisor.json written) (fails on 2.66.0: --help started a real supervisor)',
    h.status === 0 && h2.status === 0 && /Usage:/.test(text) && /studio:start/.test(text) && !fs.existsSync(status),
    `${text.slice(-800)}\nstatus file: ${fs.existsSync(status)}`);
}
