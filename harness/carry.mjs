/**
 * harness/carry.mjs — short command output for agents (2.30c, #4).
 *
 * Every token an agent reads at the start of a session is paid again on every later turn, so what
 * `task start` prints is kept small: the brief's path, a 10-line summary of it, and one carry-forward
 * note (the newest hand-off notes, at most 3k characters) instead of the whole hand-off history.
 * The full history stays in studio/handoffs/<ID>.md for whoever really needs it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './event.mjs';

export const CARRY_MAX = 3000;
export const SUMMARY_LINES = 10;

/** The newest hand-off notes, at most CARRY_MAX characters, whole sections where they fit. */
export function carryForward(handoff, id = '', max = CARRY_MAX) {
  const body = String(handoff || '').replace(/^# .*\n+/, '').replace(/^Newest last.*\n/m, '').trim();
  if (body.length <= max) return body;
  const parts = body.split(/\n(?=## )/);
  const kept = [];
  let n = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (n + parts[i].length + 1 > max - 80) break;
    kept.unshift(parts[i]);
    n += parts[i].length + 1;
  }
  const older = `(Older notes in studio/handoffs/${id || '<ID>'}.md.)`;
  if (!kept.length) return `${older}\n…${body.slice(-(max - older.length - 2))}`;
  return `${older}\n${kept.join('\n')}`;
}

/** Ten lines: the task, what done means, the newest note, and where the rest is. */
export function startSummary(started, root = REPO_ROOT) {
  let brief = '';
  try {
    brief = fs.readFileSync(path.isAbsolute(started.brief) ? started.brief : path.join(root, started.brief), 'utf8');
  } catch {}
  const lines = brief.split('\n').map((l) => l.trim()).filter((l) => l && !/^```/.test(l));
  const head = lines.filter((l) => !/^#/.test(l)).slice(0, SUMMARY_LINES - 3);
  const out = [`${started.id} [${started.priority}] (${started.role}): ${started.title}`.slice(0, 200), ...head.map((l) => l.slice(0, 200))];
  if (started.handoff) out.push(`Hand-off: the newest notes are printed below (≤${CARRY_MAX / 1000}k chars); full history in studio/handoffs/${started.id}.md`);
  out.push(`Full brief: ${started.brief}`);
  return out.slice(0, SUMMARY_LINES).join('\n');
}
