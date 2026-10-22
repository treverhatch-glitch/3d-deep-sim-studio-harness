#!/usr/bin/env node
/**
 * harness/proposed.mjs — who may add to the live queue, and the proposed list (2.30d, plan #6 and #5).
 *
 * Only the Director, the Producer and the planner (and people) add to studio/NEXT.md. Any other role's
 * `task add` lands in studio/proposed.json with a one-line reason (--why "…"); nothing is lost and the
 * agent carries on. The Producer promotes proposals in batches:
 *   npm run task -- proposed                      what is waiting
 *   npm run task -- promote P-3,P-4 --by producer one batch onto the live queue
 *   npm run task -- promote --all --by producer [--drop P-5]
 * A task the dev asked for (--origin dev --asked "…") always goes straight on the queue.
 * Builder tasks are size 3 at most (SIZE_CAP); a bigger one gets a planner task that splits it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, emitEvent } from './event.mjs';

export const DECIDERS = ['director', 'producer', 'planner', 'human'];
export const SIZE_CAP = 3;
export const PROPOSED_FILE = path.join(REPO_ROOT, 'studio', 'proposed.json');
// Launcher agent names start with their role (builder-3, qa-playtester-1); people's names don't. The watcher
// (a script) and the liaison (it relays the dev's own words) queue directly.
const ROLE_NAME = /^(builder|qa|qa-playtester|art|art-lead|reviewer|rnd|engine-porter|sound|ui|narrative|localization|release)(-|\d|$)/i;
const DECIDER_NAME = /(^|-)(director|producer|planner)(-|\d|$)/i;

/** May this agent add straight to the live queue? */
export function isDecider(agent, env = process.env) {
  const role = String(env.STUDIO_ROLE || '').toLowerCase();
  if (role) return DECIDERS.includes(role) || DECIDER_NAME.test(role);
  const name = String(agent || '');
  if (DECIDER_NAME.test(name) || name === (env.STUDIO_PRODUCER_NAME || 'producer')) return true;
  return !ROLE_NAME.test(name);
}

export function readProposed() {
  try {
    return { items: [], next: 1, ...JSON.parse(fs.readFileSync(PROPOSED_FILE, 'utf8')) };
  } catch {
    return { items: [], next: 1 };
  }
}
function writeProposed(p) {
  fs.mkdirSync(path.dirname(PROPOSED_FILE), { recursive: true });
  fs.writeFileSync(PROPOSED_FILE, `${JSON.stringify(p, null, 2)}\n`);
}
export const listProposed = () => readProposed().items.filter((i) => !i.promoted && !i.dropped);

/** A non-decider's add: kept with its reason. The dev's own asks skip this (handled by the caller's meta). */
export function propose({ title, role = 'builder', priority = 'P1', agent, meta = {}, why }) {
  if (meta.origin === 'dev' && meta.asked) return null;
  const reason = String(why || '').split('\n')[0].trim().slice(0, 160);
  if (!reason) return { error: 'why-needed', message: `Only the Director, Producer or planner add to the live queue. Say why in one line and it goes on the proposed list for the Producer: --why "…"` };
  const p = readProposed();
  const item = { id: `P-${p.next}`, title: String(title).slice(0, 200), role, priority: String(priority).toUpperCase(), agent, why: reason, meta: { ...meta, why: undefined }, at: new Date().toISOString() };
  p.items.push(item);
  p.next += 1;
  writeProposed(p);
  emitEvent({ type: 'task.proposed', agent, to: 'producer', msg: `${agent} proposed ${item.id}: ${item.title} (${reason})`, meta: { id: item.id, role } });
  return { proposed: true, id: item.id, message: `${item.id} waits on the proposed list; the Producer promotes proposals in batches (npm run task -- promote ${item.id} --by producer).` };
}

/** The Producer (or Director, planner, a person) moves a batch onto the live queue. addTask is passed in (no import cycle). */
export function promote(ids, { by, drop = [], addTask, env = process.env }) {
  if (!by || !isDecider(by, env)) return { ok: false, message: 'Only the Producer, Director, planner or a person promotes proposals: --by <name>.' };
  const p = readProposed();
  const open = p.items.filter((i) => !i.promoted && !i.dropped);
  const pick = ids === 'all' ? open : open.filter((i) => ids.includes(i.id));
  if (!pick.length && !drop.length) return { ok: false, message: 'Nothing to promote. npm run task -- proposed lists what is waiting.' };
  const queued = [];
  const refused = [];
  for (const i of pick) {
    if (drop.includes(i.id)) continue;
    const t = addTask({ title: i.title, role: i.role, priority: i.priority, agent: by, meta: { ...i.meta, promoted: true, proposedBy: i.agent, proposal: i.id, origin: i.meta?.origin || 'agent' } });
    if (t?.error) { refused.push(`${i.id}: ${t.message.split('.')[0]}`); continue; }
    Object.assign(i, { promoted: t.id, by, at2: new Date().toISOString() });
    queued.push(`${i.id}→${t.id}`);
  }
  for (const i of open.filter((x) => drop.includes(x.id))) Object.assign(i, { dropped: true, by });
  writeProposed(p);
  emitEvent({ type: 'proposed.promoted', agent: by, msg: `${by} promoted ${queued.length} proposal${queued.length === 1 ? '' : 's'}${queued.length ? `: ${queued.join(', ')}` : ''}${drop.length ? `; dropped ${drop.join(', ')}` : ''}`, meta: { queued, dropped: drop, refused } });
  return { ok: true, queued, refused, message: `${queued.length ? `Queued ${queued.join(', ')}` : 'Nothing queued'}${refused.length ? `. Refused: ${refused.join('; ')}` : ''}${drop.length ? `. Dropped ${drop.join(', ')}` : ''}.` };
}
