/**
 * harness/yes-wait.mjs — 2.76.0 (j, B-87): agent-proposed tasks waiting on a dev's `task yes`, said out loud.
 *
 * A task an agent proposes as a new mechanic waits for the dev's yes (studio/task-holds.json needsYes; harness/task.mjs
 * `task yes`). The supervisor's pass started nothing for hours while ten such tasks waited, and no status said why. The
 * list is now in `npm run studio:status` (the last-pass line), `npm run status -- --brief` (Blockers) and the War Room's
 * Needs a person:
 *
 *   yesWaiting({ holds, queue })   -> { count, ids, items: [{ id, title, by, at }] }   (pure; open tasks only)
 *   readYesWaiting({ root?, env? }) the same from the board and holds, plus { beta, line }
 *   yesLine(w)                     "waiting on yes: 3 (T-166, T-167, T-168)" or ''
 *
 * In beta mode (harness/beta-mode.mjs readBeta().on) the line also says who beta mode lets give the yes (the named
 * agents and the planning roles): who may is decided by harness/delegation.mjs, not here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './event.mjs';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const cut = (ids, k = 6) => (ids.length <= k ? ids.join(', ') : `${ids.slice(0, k).join(', ')} +${ids.length - k} more`);

/** Open tasks (in progress or waiting) whose hold says they wait for the dev's yes, in board order. */
export function yesWaiting({ holds = {}, queue = { inProgress: [], backlog: [] } } = {}) {
  const open = [...(queue?.inProgress || []), ...(queue?.backlog || [])];
  const items = open.filter((t) => t?.id && holds?.[t.id]?.needsYes).map((t) => ({ id: t.id, title: String(t.title || '').slice(0, 120), by: holds[t.id].needsYes?.by || null, at: holds[t.id].needsYes?.at || null }));
  return { count: items.length, ids: items.map((i) => i.id), items };
}

/** "waiting on yes: N (ids)" for a status line, or '' when nothing waits. */
export function yesLine(w, { k = 6 } = {}) {
  return w?.count ? `waiting on yes: ${w.count} (${cut(w.ids, k)})` : '';
}

/** Who beta mode lets say yes, in words ('' when beta mode is off). */
export function betaYesWords(beta) {
  if (!beta?.on) return '';
  const agents = (Array.isArray(beta.doc?.agents) ? beta.doc.agents : []).filter(Boolean);
  const roles = (Array.isArray(beta.doc?.roles) ? beta.doc.roles : ['producer', 'director']).filter(Boolean);
  return `beta mode is on: ${[...agents, ...roles.map((r) => `a ${r} session`)].join(', ') || 'the named agents'} may say yes (npm run task -- yes <id> --by <name>)`;
}

/** From the studio's board and holds (and beta mode from the main checkout): { count, ids, items, beta, line }. Never throws. */
export async function readYesWaiting({ root = REPO_ROOT } = {}) {
  let queue = { inProgress: [], backlog: [] };
  let holds = {};
  try {
    if (path.resolve(root) === path.resolve(REPO_ROOT)) {
      queue = (await import('./task.mjs')).parseNextQueue();
      holds = (await import('./task-hold.mjs')).readHolds();
    } else {
      holds = readJson(path.join(root, 'studio', 'task-holds.json'))?.tasks || {};
      const text = fs.readFileSync(path.join(root, 'studio', 'NEXT.md'), 'utf8');
      for (const m of text.matchAll(/^\s*[-*]\s+\[([ >~])\]\s+\*\*([A-Z]+-\d+)\*\*\s*(?:\([^)]*\)\s*)?(.*)$/gm)) (m[1] === ' ' ? queue.backlog : queue.inProgress).push({ id: m[2], title: m[3].replace(/^[\s:—-]+/, '').trim() });
    }
  } catch { /* no board: nothing waits */ }
  const w = yesWaiting({ holds, queue });
  let beta = { on: false };
  if (w.count) { try { beta = (await import('./beta-mode.mjs')).readBeta(); } catch { beta = { on: false }; } }
  return { ...w, beta: { on: Boolean(beta.on), words: betaYesWords(beta) }, line: yesLine(w) };
}
