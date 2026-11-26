/**
 * harness/task-checklist.mjs — 2.98 (c): a task's checklist, and the one answer to "does this landing close the task?".
 *   npm run task -- checklist <ID> add "<item>" ... | done "<item>" | skip "<item>" --why "…" | list
 *   npm run task -- add "<title>" --checklist-file <file>        (one item a line)
 *   npm run task -- split <ID> --every <n> --by <name>            child tasks from the open items, n a child
 * The list lives in the task's holds (studio/task-holds.json "checklist"; a lane's studio/ is main's). While an item is
 * open, or a part of a split is not done, every landing of the task is a slice: it goes back to ready.
 * 2.99 (f): a session's brief shows the first 8 open items; a task over studio/game.json task.checklistSplitAt (8, 0 = off)
 * open items is told to the producer once (adviseSplit); a hand-back with no commit and no item done says so (idleLine).
 */
import fs from 'node:fs';
import path from 'node:path';
import { boardRoot, emitEvent } from './event.mjs';
import { readJson } from './fsafe.mjs';
import { readHolds, setHold, updateHolds } from './task-hold.mjs';

const MARK = { done: '[x]', skipped: '[-]', split: '[>]' };
export const itemsOf = (id, holds = readHolds()) => (Array.isArray(holds[id]?.checklist) ? holds[id].checklist : []);
export const openItems = (items) => items.filter((i) => i.state === 'open');

/** "7 of 12 done" (a skipped or split item is not open), or '' when the task has no list. */
export function progress(items) {
  if (!items.length) return '';
  const skipped = items.filter((i) => i.state === 'skipped').length;
  return `${items.length - openItems(items).length} of ${items.length} done${skipped ? ` (${skipped} skipped)` : ''}`;
}
export const itemLines = (items) => items.map((i) => `${MARK[i.state] || '[ ]'} ${i.text}${i.state === 'skipped' ? ` (skipped: ${i.why})` : i.state === 'split' ? ` (in ${i.to})` : ''}`);

/** The items of a checklist file: one a line; blank lines and a leading "-" or "- [ ]" are dropped. */
export const readItemsFile = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*[-*]\s*(\[[ xX]\]\s*)?/, '').trim()).filter(Boolean);

/**
 * add | done | skip one or more items of a task's list. { ok, items, message }. An item is named by its words (case and
 * spaces ignored) or its number in `list`. skip needs a reason (5+ characters).
 */
export function changeChecklist(id, verb, texts, { why = '', by = 'agent', now = new Date().toISOString() } = {}) {
  const words = texts.map((t) => String(t).trim().slice(0, 200)).filter(Boolean);
  if (!words.length) return { ok: false, message: `Name the item: npm run task -- checklist ${id} ${verb} "<item>".` };
  if (verb === 'skip' && String(why).trim().length < 5) return { ok: false, message: `A skipped item needs a reason: npm run task -- checklist ${id} skip "<item>" --why "<why it is not needed>". Nothing was changed.` };
  const key = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  return updateHolds((all) => {
    const items = [...itemsOf(id, all)];
    const said = [];
    for (const w of words) {
      if (verb === 'add') { if (!items.some((i) => key(i.text) === key(w))) { items.push({ text: w, state: 'open', by, at: now }); said.push(w); } continue; }
      const i = /^\d+$/.test(w) ? Number(w) - 1 : items.findIndex((x) => key(x.text) === key(w));
      if (!items[i]) return { ok: false, message: `${id} has no checklist item "${w}". Its open items: ${openItems(items).map((x) => `"${x.text}"`).join(', ') || 'none'}. Nothing was changed.` };
      if (items[i].state !== 'open') return { ok: false, message: `"${items[i].text}" is not open (${items[i].state}${items[i].to ? ` in ${items[i].to}` : ''}). Nothing was changed.` };
      items[i] = { ...items[i], state: verb === 'skip' ? 'skipped' : 'done', by, at: now, ...(verb === 'skip' ? { why: String(why).trim().slice(0, 300) } : {}) };
      said.push(items[i].text);
    }
    all[id] = { ...(all[id] || {}), checklist: items };
    return { ok: true, items, message: `${id}: ${verb === 'add' ? `added ${said.length} item(s)` : `${verb === 'skip' ? 'skipped' : 'done'}: ${said.join('; ')}`}. Checklist ${progress(items)}.` };
  });
}

/**
 * Why a landing of this task does not close it (it is a slice), or null when it closes: a --final mark closes it; open
 * checklist items, parts of a split that are not done (`done`: the board's done ids) or the slice mark keep it open.
 */
export function landingKeepsOpen(id, { holds = readHolds(), done = new Set() } = {}) {
  const h = holds[id] || {};
  if (h.final) return null;
  const open = openItems(itemsOf(id, holds)).length;
  if (open) return `${open} checklist item(s) are still open`;
  const parts = (h.split?.children || []).filter((c) => !done.has(c));
  if (parts.length) return `its parts ${parts.join(', ')} are not done yet`;
  return h.slice ? 'it was queued as a slice' : null;
}

/** The note a --final close carries: the items still open, or ''. */
export function finalNote(id, holds = readHolds()) {
  const open = openItems(itemsOf(id, holds));
  return holds[id]?.final && open.length ? `closed with ${open.length} checklist item(s) open: ${open.map((i) => i.text).join('; ')}`.slice(0, 400) : '';
}

/** The open items in groups of `every` (task split). */
export const splitGroups = (items, every) => { const o = openItems(items); const g = []; for (let i = 0; i < o.length; i += every) g.push(o.slice(i, i + every)); return g; };

/** The open items a brief shows: the first `n`, then the count of the rest. */
export function briefItems(id, items, n = 8) {
  const o = openItems(items);
  return [...o.slice(0, n).map((i) => `[ ] ${i.text}`), ...(o.length > n ? [`... and ${o.length - n} more open (npm run task -- checklist ${id} list)`] : [])];
}

/** studio/game.json task.checklistSplitAt: 8 when unset; 0 turns the advice off. */
export function checklistSplitAt(root = boardRoot()) {
  const n = Number(readJson(path.join(root, 'studio', 'game.json'), null)?.task?.checklistSplitAt);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 8;
}

/** "T-x has 23 open items: split it (...)" when the task has more open items than checklistSplitAt, else ''. */
export function splitLine(id, holds = readHolds(), at = checklistSplitAt()) {
  const n = openItems(itemsOf(id, holds)).length;
  return at > 0 && n > at ? `${id} has ${n} open items: split it (\`npm run task -- split ${id} --every ${at}\`)` : '';
}

/** Tell the producer once for each open count (an event); never splits by itself. Returns the line or ''. */
export function adviseSplit(id, { emit = emitEvent } = {}) {
  const holds = readHolds();
  const line = splitLine(id, holds);
  const n = openItems(itemsOf(id, holds)).length;
  if (!line || holds[id]?.splitAdvised === n) return '';
  setHold(id, { splitAdvised: n });
  emit({ type: 'task.split_advised', agent: 'harness', task: id, to: 'producer', status: 'warn', msg: line, meta: { open: n } });
  return line;
}

/** The hand-back line for a session that left no commit and marked no item (since `sinceMs`), or ''. */
export function idleLine(id, { commits, sinceMs, holds = readHolds() } = {}) {
  const items = itemsOf(id, holds);
  const first = openItems(items)[0];
  if (!first || Number(commits) !== 0 || items.some((i) => i.state === 'done' && Date.parse(i.at) >= sinceMs)) return '';
  return `This session left no commit and marked no checklist item. The next one starts with the first open item ("${first.text.slice(0, 80)}"), not with the whole list.`;
}
