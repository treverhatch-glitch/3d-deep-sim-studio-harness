/**
 * harness/pending-review.mjs — forced work is "done (pending)" (2.30d, plan #9).
 *
 * `task done <ID> --force --reason "…"` still moves the task to DONE, so its lane carries on, but it opens
 * an approval card (studio/pending-review.json, event task.pending_review). It is closed or reopened by
 * a person, or by a reviewer whose model family differs from the model that forced it:
 *   npm run task -- pending
 *   npm run task -- review T-12 --close|--reopen --by <name> [--model <reviewer model>] [--note "…"]
 * The forcing agent can't close its own card; neither can another model of the same family.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { modelFamily } from './families.mjs';

export const PENDING_FILE = path.join(REPO_ROOT, 'studio', 'pending-review.json');
const ROLE_NAME = /^(builder|qa|qa-playtester|art|reviewer|rnd|liaison|engine-porter|producer|director|planner|watchdog)(-|\d|$)/i;

export function readPending() {
  try {
    return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  } catch {
    return { items: [] };
  }
}
const save = (p) => { fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true }); fs.writeFileSync(PENDING_FILE, `${JSON.stringify(p, null, 2)}\n`); };
export const listPending = () => readPending().items.filter((i) => !i.closed);
export const isPending = (id) => listPending().some((i) => i.task === id);

export function openPending({ task, title, by, model, reason, missing, type, patch }) {
  const p = readPending();
  p.items = p.items.filter((i) => !(i.task === task && !i.closed));
  const item = { task, title: String(title || '').slice(0, 160), by, model: model || null, family: model ? modelFamily(model) : 'unknown', reason, missing, type, patch: patch || null, at: new Date().toISOString(), closed: null };
  p.items.push(item);
  save(p);
  emitEvent({ type: 'task.pending_review', agent: by, task, to: 'producer', status: 'pending', msg: `${task} is done (pending): forced past "${missing}" because: ${reason}. A person or a reviewer from another model family closes or reopens it (npm run task -- review ${task} --close|--reopen --by <name>).`, meta: { reason, missing, model: model || null, family: item.family } });
  return item;
}

/**
 * Close or reopen. A reviewer with --model must be another family than the forcing model; a name with
 * no model counts as a person unless it is the forcing agent or looks like a launcher agent's name.
 */
export function closePending(task, { by, model = null, verdict, note = '' }) {
  if (!by) return { ok: false, message: 'Say who reviews it: --by <name> (a person, or a reviewer with --model <its model>).' };
  if (!['close', 'reopen'].includes(verdict)) return { ok: false, message: `Usage: npm run task -- review ${task} --close|--reopen --by <name> [--model m] [--note "…"]` };
  const p = readPending();
  const item = p.items.find((i) => i.task === task && !i.closed);
  if (!item) return { ok: false, message: `${task} has no forced done waiting for review.` };
  if (by === item.by) return { ok: false, message: `${by} forced ${task}; someone else reviews it.` };
  if (model) {
    const fam = modelFamily(model);
    if (item.family !== 'unknown' && fam === item.family) return { ok: false, message: `${task} was forced on ${item.model} (${fam}); the reviewer must be from another model family, or a person.` };
  } else if (ROLE_NAME.test(by)) return { ok: false, message: `${by} looks like an agent: pass --model <its model> (another family than ${item.model || 'the forcing model'}), or a person reviews it.` };
  item.closed = { verdict, by, model, note: String(note).slice(0, 300), at: new Date().toISOString() };
  save(p);
  emitEvent({ type: verdict === 'close' ? 'task.pending_closed' : 'task.pending_reopened', agent: by, task, to: 'producer', msg: `${by}${model ? ` (${model})` : ''} ${verdict === 'close' ? 'accepted' : 'reopened'} forced ${task}${note ? `: ${note}` : ''}`, meta: { verdict, model, forcedBy: item.by } });
  return { ok: true, verdict, by, note, reason: item.reason, message: verdict === 'close' ? `${task} is done (reviewed by ${by}).` : `${task} is back on the queue (reopened by ${by}).` };
}
