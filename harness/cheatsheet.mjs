#!/usr/bin/env node
/**
 * harness/cheatsheet.mjs — the cheat sheet check (2.29.2).
 *
 *   npm run cheatsheet -- match "<task title or tags>"      up to 3 matching lines from studio/CHEATSHEET.md
 *   npm run cheatsheet -- attach T-123 [--tags godot,test] [--by <name>]   attach them to the task's brief
 *   npm run cheatsheet -- show T-123
 *   npm run cheatsheet -- cap [N]        the Director's per-task trick cap (default 3, 1 to 6); --max N on match/attach overrides it once
 *
 * Before a task is handed out, its title and tags are matched against the [tags] of each line in
 * studio/CHEATSHEET.md, and up to 3 tricks are attached as PRE-APPROVED by whoever assigns it (the
 * Director or Producer): the agent may use them for that task without asking. The approval is recorded
 * (event cheatsheet.preapproved: task, trick ids, approved by). Anything not attached follows the normal
 * approval rules. The brief (.studio/briefs/<ID>.md) and the War Room show them on the task.
 * Lines tagged `director` are for planning and assigning: `match --for director` shows only those, and
 * they are never attached to a builder's task. One small file read, no model, no wait.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';

export const CHEATSHEET_FILE = path.join(REPO_ROOT, 'studio', 'CHEATSHEET.md');
export const ATTACH_DIR = path.join(STUDIO_STATE_DIR, 'cheatsheet');
export const MAX_TRICKS = 3;
/** 2.30h: the Director can raise (or lower) how many tricks a task gets: 1 to 6, default 3. */
export const TRICKS_CEILING = 6;
export const CAP_FILE = path.join(STUDIO_STATE_DIR, 'cheatsheet-cap.json');
export function clampTricks(n, fallback = MAX_TRICKS) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 1 ? Math.min(v, TRICKS_CEILING) : fallback;
}
/** The studio default the Director set (`cheatsheet -- cap N`), else 3. */
export function trickCap() {
  try {
    return clampTricks(JSON.parse(fs.readFileSync(CAP_FILE, 'utf8')).cap);
  } catch {
    return MAX_TRICKS;
  }
}
export function setTrickCap(n, by = 'director') {
  const cap = clampTricks(n);
  fs.mkdirSync(path.dirname(CAP_FILE), { recursive: true });
  fs.writeFileSync(CAP_FILE, `${JSON.stringify({ cap, by, at: new Date().toISOString() })}\n`);
  emitEvent({ type: 'cheatsheet.cap', agent: by, msg: `${by} set the cheat sheet trick cap to ${cap} per task`, meta: { cap } });
  return cap;
}

/** Every entry: its tags and the line. */
export function readCheatsheet(file = CHEATSHEET_FILE) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.match(/^- (?:(C-\d+) )?\[([^\]]+)\]\s*(.+)$/)).filter(Boolean).map((m) => ({ id: m[1] || null, tags: m[2].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean), text: m[3].trim() }));
}

const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w.length > 1);

/** The best matching entries (most tags hit; ties keep the sheet's order), at most the cap (3 unless the Director changed it, never over 6). */
// 2.30j (M9): a trick matches with 2+ tag hits, or one hit on a narrow entry (at least a fifth of its tags),
// or a tag passed explicitly; one word hitting a broad 9-tag rule (C-65 on a boat-wake task) no longer does.
export function matchTricks(text, { tags = [], entries = readCheatsheet(), max = trickCap(), forRole = 'agent' } = {}) {
  // Director lines are for planning; the rest are for the work itself.
  entries = entries.filter((e) => (forRole === 'director') === e.tags.includes('director'));
  const explicitTags = new Set(tags.map((t) => String(t).toLowerCase()));
  const ws = new Set([...words(text), ...explicitTags]);
  // Simple stems, so "tests" finds [test] and "replays" finds [replay].
  for (const w of [...ws]) if (w.endsWith('s')) ws.add(w.slice(0, -1));
  return entries.map((e, i) => ({ ...e, i, hits: e.tags.filter((t) => ws.has(t)) })).filter((e) => e.hits.length && (e.hits.length >= 2 || e.hits.length / Math.max(1, e.tags.filter((t) => t !== 'director').length) >= 0.2 || e.hits.some((t) => explicitTags.has(t)))).sort((a, b) => b.hits.length - a.hits.length || a.i - b.i).slice(0, max).map(({ id, tags: t, text: x, hits }) => ({ id, tags: t, text: x, hits }));
}

const attachFile = (id) => path.join(ATTACH_DIR, `${id}.json`);
export function readAttached(id) {
  try {
    return JSON.parse(fs.readFileSync(attachFile(id), 'utf8'));
  } catch {
    return null;
  }
}
/** Every task's attached tricks, for the War Room. */
export function allAttached() {
  if (!fs.existsSync(ATTACH_DIR)) return {};
  return Object.fromEntries(fs.readdirSync(ATTACH_DIR).filter((f) => f.endsWith('.json')).map((f) => [f.slice(0, -5), readAttached(f.slice(0, -5))]).filter(([, v]) => v));
}

/**
 * Attach the matches to a task, pre-approved by whoever assigns it. The brief shows them from the next
 * `task start` (or `npm run focus`). The approval covers only these tricks, only for this task.
 */
export function attachTricks(id, { title = '', tags = [], by = 'producer', max = null } = {}) {
  if (!/^T-\d+$/.test(String(id || ''))) return { ok: false, message: 'cheatsheet -- attach <T-ID> [--tags a,b] --by <director or producer>' };
  const cap = max == null ? trickCap() : clampTricks(max, trickCap());
  const tricks = matchTricks(`${title} ${tags.join(' ')}`, { tags, max: cap });
  const ids = tricks.map((t) => t.id).filter(Boolean);
  const rec = { task: id, by, at: new Date().toISOString(), cap, tricks, preapproved: { ids, approvedBy: by, scope: 'this task only; anything else follows the normal approval rules' } };
  fs.mkdirSync(ATTACH_DIR, { recursive: true });
  fs.writeFileSync(attachFile(id), `${JSON.stringify(rec, null, 2)}\n`);
  if (tricks.length) emitEvent({ type: 'cheatsheet.preapproved', agent: by, task: id, msg: `${by} pre-approved ${ids.join(', ')} for ${id}: ${tricks.map((t) => t.text.split('→')[0].trim()).join('; ').slice(0, 200)}`, meta: { task: id, tricks: ids, approved_by: by } });
  else emitEvent({ type: 'cheatsheet.attached', agent: by, task: id, msg: `No cheat sheet entry matches ${id}` });
  return { ok: true, ...rec };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const tags = String(flag('tags') || '').split(',').map((t) => t.trim()).filter(Boolean);
  const print = (list) => console.log(list.length ? list.map((t) => `- ${t.id ? `${t.id} ` : ''}${t.text}`).join('\n') : 'No cheat sheet entry matches.');
  if (argv[0] === 'cap') {
    if (argv[1] === undefined) console.log(`Trick cap: ${trickCap()} per task (1 to ${TRICKS_CEILING})`);
    else console.log(`Trick cap set to ${setTrickCap(argv[1], flag('by') || process.env.STUDIO_LOCK_OWNER || 'director')} per task`);
    process.exit(0);
  }
  if (argv[0] === 'match') {
    print(matchTricks(argv.slice(1).filter((x, i, a) => !x.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--'))).join(' '), { tags, max: flag('max') ? clampTricks(flag('max'), trickCap()) : trickCap(), forRole: flag('for') === 'director' ? 'director' : 'agent' }));
    process.exit(0);
  }
  if (argv[0] === 'attach' || argv[0] === 'show') {
    const id = argv[1];
    if (argv[0] === 'show') {
      const r = readAttached(id);
      print(r?.tricks || []);
      process.exit(0);
    }
    // The task's line on the board (read directly: task.mjs loads this module through the brief).
    let line = '';
    try {
      line = fs.readFileSync(path.join(REPO_ROOT, 'studio', 'NEXT.md'), 'utf8').split('\n').find((l) => l.includes(`**${id}**`)) || '';
    } catch {}
    const r = attachTricks(id, { title: line.replace(/^.*?\*\*T-\d+\*\*/, ''), tags, max: flag('max'), by: flag('by') || process.env.STUDIO_LOCK_OWNER || 'producer' });
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    print(r.tricks);
    if (r.tricks.length) console.log(`Pre-approved for ${id} by ${r.preapproved.approvedBy}: the agent may use these without asking.`);
    process.exit(0);
  }
  console.log(`${readCheatsheet().length} entries in studio/CHEATSHEET.md. npm run cheatsheet -- match "<title>" | attach <ID> | show <ID>`);
}
