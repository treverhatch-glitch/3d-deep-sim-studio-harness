#!/usr/bin/env node
/**
 * harness/causes.mjs — forced-done tasks grouped by why they were forced, and accepted once.
 *
 *   npm run causes                          open groups: the cause, the tasks, the Producer's check task
 *   npm run causes -- accept "<cause>" --by <person> --why "…"   accept that cause for this run
 *
 * When most tasks are forced past the same failing check (run #1: 32 of 57 past one red gate), a
 * "Needs you" list with one card per task teaches everyone to ignore it. Instead a forced task
 * joins the open check task for its cause, the War Room shows one card per cause, and a person can
 * accept a cause once: its check tasks close, and later tasks forced for the same cause are logged
 * without asking again. A different cause still raises a new card.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';

import { ACCEPTED_FILE, causeOf, readAccepted, forcedGroups } from './cause-store.mjs';
import { parseNextQueue, completeTask } from './task.mjs';
import { isAgent } from './ask.mjs';

export { causeOf, readAccepted, forcedGroups };
export async function acceptCause(cause, { by, why = '' }) {
  if (!by || isAgent(by)) return { ok: false, message: 'A person accepts a cause: --by <your name>.' };
  const c = causeOf(cause);
  const group = forcedGroups(parseNextQueue()).find((g) => g.cause === c);
  const list = readAccepted();
  if (!list.some((a) => a.cause === c)) list.push({ cause: c, by, why: String(why).slice(0, 300), at: new Date().toISOString(), tasks: group?.tasks || [] });
  fs.mkdirSync(path.dirname(ACCEPTED_FILE), { recursive: true });
  fs.writeFileSync(ACCEPTED_FILE, `${JSON.stringify({ accepted: list }, null, 2)}\n`);
  const closed = [];
  for (const id of group?.checks || []) {
    const r = completeTask(id, `accepted by ${by}: ${c}`, by);
    if (r && !r.error) closed.push(id);
  }
  emitEvent({ type: 'cause.accepted', agent: by, to: 'producer', msg: `${by} accepted "${c}" for this run${why ? ` (${why})` : ''}; ${group?.tasks.length || 0} forced task(s), ${closed.length} check task(s) closed. Later tasks forced for the same cause are logged without a new card.` });
  return { ok: true, cause: c, closed, tasks: group?.tasks || [] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  if (argv[0] === 'accept') {
    const r = await acceptCause(argv[1], { by: flag('by'), why: flag('why') || '' });
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(`Accepted "${r.cause}". Closed ${r.closed.join(', ') || 'no check tasks'}.`);
    process.exit(0);
  }
  const groups = forcedGroups(parseNextQueue());
  console.log(groups.length ? groups.map((g) => `${g.tasks.length} task(s) forced past: ${g.cause}\n  tasks ${g.tasks.join(', ')}; check task ${g.checks.join(', ')}\n  accept: npm run causes -- accept "${g.cause}" --by <name> --why "…"`).join('\n') : 'No forced tasks waiting for a check.');
  const acc = readAccepted();
  if (acc.length) console.log(`\nAccepted for this run:\n${acc.map((a) => `  ${a.cause} (by ${a.by}${a.why ? `: ${a.why}` : ''})`).join('\n')}`);
}
