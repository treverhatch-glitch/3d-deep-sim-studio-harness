/**
 * harness/train-deps.mjs — 2.65.0 (crew feedback 3.3): the merge train honours task dependencies.
 *
 * `task add … --after T-067,T-094` and `task block <ID> --until T-x` (studio/task-holds.json, "after") used to gate
 * only a task's start (harness/task-hold.mjs). A lane queued for the train now also waits for them:
 *   - a dependency that is done (landed) is met;
 *   - one queued in the same train is met by order: within a train lanes merge in dependency order, and a lane whose
 *     dependency drops out of the train (conflict, hand-back) leaves with it;
 *   - one still open and not in this train: the lane waits for a later train (deferred, says which);
 *   - one that was dropped from the board, or isn't on it at all: the lane is handed back with a note (it would
 *     otherwise wait forever). `npm run task -- unblock <ID>` clears the dependency if the Producer decides so.
 * Code only. Imports nothing from task.mjs (its CLI imports train.mjs, which imports this).
 */
import fs from 'node:fs';
import path from 'node:path';
import { readRecentEvents } from './event.mjs';

const TASK = /^[A-Z]+-\d+$/;

/** The board's open and done ids, read from studio/NEXT.md and DONE.md under root; null when neither can be read. */
export function boardStates(root) {
  const open = new Set();
  const done = new Set();
  let read = 0;
  for (const f of ['NEXT.md', 'DONE.md']) {
    let text;
    try { text = fs.readFileSync(path.join(root, 'studio', f), 'utf8'); read += 1; } catch { continue; }
    let inDone = f === 'DONE.md';
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
      if (/^##\s+DONE/i.test(line.trim())) inDone = true;
      else if (/^##\s+(IN_PROGRESS|BACKLOG)/i.test(line.trim())) inDone = f === 'DONE.md';
      const m = line.match(/^\s*[-*]\s+\[([ xX>~])\]\s+\*\*([A-Z]+-\d+)\*\*/);
      if (m) (inDone || m[1].toLowerCase() === 'x' ? done : open).add(m[2]);
    }
  }
  for (const id of done) open.delete(id);
  return read ? { open, done } : null;
}

/** Tasks dropped from the board (task.dropped events). */
export function droppedTasks(events = null) {
  const evs = events || readRecentEvents(20000);
  return new Set(evs.filter((e) => e?.type === 'task.dropped' && TASK.test(String(e.task || ''))).map((e) => e.task));
}

/** Each task's dependencies (studio/task-holds.json "after"): Map(task -> [ids]). */
export function readDeps(root) {
  let tasks = {};
  try { tasks = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'task-holds.json'), 'utf8')).tasks || {}; } catch {}
  const m = new Map();
  for (const [id, h] of Object.entries(tasks)) {
    const after = (Array.isArray(h?.after) ? h.after : []).filter((x) => TASK.test(String(x)) && x !== id);
    if (after.length) m.set(id, [...new Set(after)]);
  }
  return m;
}

/**
 * Judge one lane's dependencies. states: { open, done } (board), dropped: Set, inTrain: Set of tasks in this train.
 * Returns { ok: true, inTrain: [deps met by order] } | { wait: why, deps } | { stuck: why, deps } (dropped/unknown).
 */
export function judgeDeps(task, deps, { states, dropped = new Set(), inTrain = new Set() } = {}) {
  const list = deps.get(task) || [];
  if (!list.length) return { ok: true, inTrain: [] };
  const missing = list.filter((d) => !states?.done?.has(d));
  if (!missing.length) return { ok: true, inTrain: [] };
  const gone = missing.filter((d) => dropped.has(d) && !states?.open?.has(d));
  const unknown = missing.filter((d) => !gone.includes(d) && states && !states.open.has(d));
  if (gone.length || unknown.length) {
    const why = [gone.length ? `${gone.join(', ')} ${gone.length > 1 ? 'were' : 'was'} dropped` : '', unknown.length ? `${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not on the board` : ''].filter(Boolean).join('; ');
    return { stuck: `it depends on ${[...gone, ...unknown].join(', ')} (--after), but ${why}, so it would wait forever. The Producer decides: clear the dependency (npm run task -- unblock ${task}) and queue it again, or re-plan it`, deps: [...gone, ...unknown] };
  }
  const notHere = missing.filter((d) => !inTrain.has(d));
  if (notHere.length) return { wait: `it waits for ${notHere.join(', ')} (--after): not landed yet${notHere.length === 1 ? '' : ' (any of them)'}; it goes in a train after ${notHere.length === 1 ? 'that lands' : 'they land'}`, deps: notHere };
  return { ok: true, inTrain: missing };
}

/**
 * Lanes in dependency order (stable: queue order otherwise), and the lanes that must leave because a dependency in
 * this train isn't (any more) in it. lanes: [{ task }]. Returns { ordered, out: [{ lane, why }] }.
 */
export function orderByDeps(lanes, deps, { done = new Set() } = {}) {
  let set = [...lanes];
  const out = [];
  for (let changed = true; changed;) {
    changed = false;
    const here = new Set(set.map((l) => l.task));
    for (const l of set) {
      const lost = (deps.get(l.task) || []).filter((d) => !done.has(d) && !here.has(d));
      if (lost.length) { out.push({ lane: l, why: `it waits for ${lost.join(', ')} (--after), which is not in this train any more; it goes in a later train` }); set = set.filter((x) => x !== l); changed = true; break; }
    }
  }
  const ordered = [];
  const placed = new Set();
  const visiting = new Set();
  const byTask = new Map(set.map((l) => [l.task, l]));
  const visit = (l) => {
    if (placed.has(l.task)) return;
    if (visiting.has(l.task)) return; // a cycle: queue order breaks it
    visiting.add(l.task);
    for (const d of deps.get(l.task) || []) if (byTask.has(d)) visit(byTask.get(d));
    visiting.delete(l.task);
    placed.add(l.task);
    ordered.push(l);
  };
  for (const l of set) visit(l);
  return { ordered, out };
}
