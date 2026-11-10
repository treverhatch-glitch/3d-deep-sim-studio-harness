/**
 * 2.81 (b4), from the R2 trial (P4): a dead session was ended only by the watch pass, so one with no watcher running
 * stayed "running" for hours. goneCheck() runs the same markGone pass (harness/agent.mjs: recordAlive, a PID and its
 * start-time identity from harness/proc-identity.mjs, which works on Windows too; nothing else decides a session is
 * gone) from the supervisor pass and from `task start` / `task next`, at most once per
 * STUDIO_GONE_CHECK_S (60) seconds, stamped in .studio/gone-check.json. STUDIO_GONE_CHECK_S=off turns it off.
 * It touches no lock or claim beyond what markGone already does. Never throws.
 * `node harness/gone-check.mjs` runs one guarded pass (task.mjs uses it: agent.mjs imports task.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUDIO_STATE_DIR } from './event.mjs';

export const GONE_STAMP = path.join(STUDIO_STATE_DIR, 'gone-check.json');

/** The interval in ms, or 0 when the check is off. */
function gapMs(env) {
  const raw = String(env.STUDIO_GONE_CHECK_S ?? '60').trim();
  if (/^(off|0|false|no)$/i.test(raw)) return 0;
  const n = Number(raw);
  return (Number.isFinite(n) && n > 0 ? n : 60) * 1000;
}

/** Cheap, no agent.mjs: is a pass due (there are session records, the stamp is older than the interval)? */
export function goneDue({ now = Date.now(), env = process.env } = {}) {
  try {
    const gap = gapMs(env);
    if (!gap || !fs.existsSync(path.join(STUDIO_STATE_DIR, 'agents'))) return false;
    let last = 0;
    try { last = Number(JSON.parse(fs.readFileSync(GONE_STAMP, 'utf8')).at) || 0; } catch { /* no stamp yet */ }
    return !(now >= last && now - last < gap);
  } catch { return false; }
}

/** { ran, gone }: ran false when inside the interval, off, or nothing to check. */
export async function goneCheck({ now = Date.now(), env = process.env } = {}) {
  try {
    if (!goneDue({ now, env })) return { ran: false, gone: [] };
    fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
    fs.writeFileSync(GONE_STAMP, `${JSON.stringify({ at: now, pid: process.pid })}\n`);
    const { markGone } = await import('./agent.mjs');
    return { ran: true, gone: markGone() };
  } catch { return { ran: false, gone: [] }; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await goneCheck();
  process.exit(0);
}
