/**
 * harness/hotspots.mjs — 2.60.0: lines that several lanes change at once, and lines that keep conflicting.
 *
 * Crew report: every lane appended its module import to the same joined line of one big file, so every landing
 * conflicted with every other lane's (two lanes conflicted three times in a row on that one line). Nobody saw it coming.
 *
 *   Overlaps. The lanes in flight are the train queue (.studio/train/queue.json) and the lane copies with commits the
 *   studio's main branch doesn't have. Each is diffed against main (-U0, from its merge-base, its hunks mapped onto
 *   main's lines); two or more lanes whose hunks touch or meet on the same lines of the same file are an overlap: the
 *   one that lands second will conflict there. `task start`, `task done --train` and the merge train's start log warn,
 *   naming the file, the line and the lanes; each overlap is posted to the Producer once (a hotspot.overlap event and
 *   a line in studio/producer/INBOX.md, which the Producer's briefing shows under "Needs you first").
 *
 *   Conflicts. Each merge train that finds a lane conflicting (with the lanes before it, or with main) records the
 *   file and line (.studio/hotspots.json: one count per train, lines within 2 of each other count as one place). At
 *   STUDIO_HOTSPOT_ASK conflicts (default 3) on one place the Producer gets ONE ask: "hotspot: restructure
 *   <file>:<line> (registry/barrel pattern)" (a hotspot.ask event and an inbox line), never again for that place.
 *
 *   node harness/hotspots.mjs [--json]     the overlaps now, and the conflict counts
 *
 * Code only (git diffs), no model. Nothing here blocks a start, a queue or a train: it warns and asks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitEvent } from './event.mjs';
import { mainRoot, mainBranch, laneCopies } from './worktree.mjs';
import { listLocks } from './lock.mjs';
import { withLandLock } from './merge-lane.mjs';

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
const isSha = (s) => /^[0-9a-f]{40}$/.test(String(s || ''));
const NEAR = 2;
export const askAt = (env = process.env) => Math.max(1, Number(env.STUDIO_HOTSPOT_ASK) || 3);
const stateFile = (root) => path.join(root, '.studio', 'hotspots.json');
const SKIP = /^(studio|\.studio|\.lanes)\//;

// ---- diffs ------------------------------------------------------------------------------------------

/** `git diff -U0` text → Map(file → [{ os, on, ns, nn }]) (old start/length, new start/length). */
export function parseHunks(text) {
  const files = new Map();
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('diff --git ')) { cur = null; continue; }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      cur = p === '/dev/null' ? cur : p.replace(/^b\//, '');
      if (cur && !files.has(cur)) files.set(cur, []);
      continue;
    }
    if (line.startsWith('--- ')) { const p = line.slice(4).trim(); if (p !== '/dev/null') { cur = p.replace(/^a\//, ''); if (!files.has(cur)) files.set(cur, []); } continue; }
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m && cur) files.get(cur).push({ os: Number(m[1]), on: m[2] === undefined ? 1 : Number(m[2]), ns: Number(m[3]), nn: m[4] === undefined ? 1 : Number(m[4]) });
  }
  return files;
}
const diffHunks = (root, a, b, files = []) => parseHunks(out(git(root, 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', a, b, ...(files.length ? ['--', ...files] : []))));

/** A line of `from` (the merge-base) on the other side of these hunks (from → to). Inside a changed range: its start. */
export function mapLine(line, hunks = []) {
  let shift = 0;
  for (const h of hunks) {
    if (h.on === 0) { if (h.os < line) shift += h.nn; continue; }
    if (line >= h.os && line <= h.os + h.on - 1) return h.ns;
    if (h.os + h.on - 1 < line) shift += h.nn - h.on;
  }
  return line + shift;
}

/**
 * A hunk's place on a doubled line scale (line k is 2k, the gap after it 2k+1), widened to the gaps around a changed
 * range: git's merge conflicts on changes that touch, so two hunks conflict when their places meet. `start` is the line
 * to name (an insertion is named by the line it follows).
 */
const place = (start, len) => (len > 0 ? { lo: 2 * start - 1, hi: 2 * (start + len - 1) + 1, line: Math.max(1, start) } : { lo: 2 * start + 1, hi: 2 * start + 1, line: Math.max(1, start) });

/** Groups of places from several owners that meet: [{ line, owners: [..] }] with 2+ owners. */
export function clusters(places) {
  const sorted = [...places].sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const out1 = [];
  let cur = null;
  for (const p of sorted) {
    if (cur && p.lo <= cur.hi) { cur.hi = Math.max(cur.hi, p.hi); cur.line = Math.min(cur.line, p.line); cur.owners.add(p.owner); continue; }
    cur = { lo: p.lo, hi: p.hi, line: p.line, owners: new Set([p.owner]) };
    out1.push(cur);
  }
  return out1.filter((c) => c.owners.size > 1).map((c) => ({ line: c.line, owners: [...c.owners] }));
}

// ---- the lanes in flight ----------------------------------------------------------------------------

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

/** The queued and in-flight lanes: [{ label, task, agent, branch, head }], one per branch (or head). */
export function lanesInFlight(root = mainRoot()) {
  const main = mainBranch(root);
  const byBranch = new Map();
  const taskOfBranch = new Map(Object.entries(readJson(path.join(root, '.studio', 'lane-branches.json'), {})).filter(([k, v]) => /^T-\d+$/.test(k) && typeof v === 'string').map(([k, v]) => [v, k]));
  let taskOfAgent = new Map();
  try { taskOfAgent = new Map(listLocks().filter((l) => /^task:/.test(l.key)).map((l) => [l.owner, l.key.slice(5)])); } catch {}
  for (const e of readJson(path.join(root, '.studio', 'train', 'queue.json'), [])) {
    if (!e || !isSha(e.head)) continue;
    byBranch.set(e.branch || e.head, { task: e.task || null, agent: e.agent || null, branch: e.branch || null, head: e.head, queued: true });
  }
  let copies = [];
  try { copies = laneCopies(root); } catch {}
  for (const c of copies) {
    if (!c.branch || !c.unmerged) continue;
    const head = out(git(root, 'rev-parse', `refs/heads/${c.branch}`));
    if (!isSha(head)) continue;
    const had = byBranch.get(c.branch);
    byBranch.set(c.branch, { task: had?.task || taskOfBranch.get(c.branch) || taskOfAgent.get(c.agent) || null, agent: had?.agent || c.agent, branch: c.branch, head, queued: Boolean(had) });
  }
  const tip = out(git(root, 'rev-parse', `refs/heads/${main}`));
  return [...byBranch.values()].filter((l) => l.head !== tip).map((l) => ({ ...l, label: l.task ? `${l.task}${l.agent ? ` (${l.agent})` : ''}` : l.agent || l.branch || l.head.slice(0, 8) }));
}

/** Overlaps among these lanes, on main's lines: [{ file, line, lanes: [label] }]. */
export function overlaps(root = mainRoot(), lanes = lanesInFlight(root)) {
  const main = mainBranch(root);
  const tip = out(git(root, 'rev-parse', `refs/heads/${main}`));
  if (!isSha(tip) || lanes.length < 2) return [];
  const perFile = new Map();
  const mainSince = new Map();
  for (const l of lanes) {
    const mb = out(git(root, 'merge-base', tip, l.head));
    if (!isSha(mb)) continue;
    const mine = diffHunks(root, mb, l.head);
    const files = [...mine.keys()].filter((f) => !SKIP.test(f));
    if (!files.length) continue;
    if (!mainSince.has(mb)) mainSince.set(mb, mb === tip ? new Map() : diffHunks(root, mb, tip));
    const moved = mainSince.get(mb);
    for (const f of files) {
      if (!perFile.has(f)) perFile.set(f, []);
      for (const h of mine.get(f)) perFile.get(f).push({ ...place(h.on > 0 ? mapLine(h.os, moved.get(f)) : (h.os === 0 ? 0 : mapLine(h.os, moved.get(f))), h.on), owner: l.label });
    }
  }
  const found = [];
  for (const [file, places] of perFile) for (const c of clusters(places)) found.push({ file, line: c.line, lanes: c.owners.sort() });
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// ---- telling the Producer ---------------------------------------------------------------------------

function readState(root) {
  const s = readJson(stateFile(root), {});
  return { posted: s.posted && typeof s.posted === 'object' ? s.posted : {}, conflicts: Array.isArray(s.conflicts) ? s.conflicts : [] };
}
/** Read, change and write the state under its own short lock (a train and a task start may write at once). */
const withState = (root, fn) => withLandLock(root, () => { const s = readState(root); const r = fn(s); writeState(root, s); return r; }, { name: 'hotspots', waitMs: 15000 });
function writeState(root, s) {
  const f = stateFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  fs.renameSync(tmp, f);
}
/** A line in the Producer's inbox (studio/producer/INBOX.md), the way the War Room writes one. */
function inbox(root, text) {
  const f = path.join(root, 'studio', 'producer', 'INBOX.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, '# Producer inbox\n\n> Messages from people in the War Room. The Producer reads new ones in its briefing (`npm run handoff`).\n\n');
  fs.appendFileSync(f, `- [${new Date().toISOString().slice(0, 16).replace('T', ' ')}] **harness**: ${text.replace(/\n+/g, ' ')}\n`);
}

export const overlapText = (o) => `hotspot: ${o.file}:${o.line} is changed by ${o.lanes.length} lanes in flight: ${o.lanes.join(', ')}. The one that lands second will conflict there: land one first, or move those lines into a registry (one module per entry, studio/rules/lanes.md)`;

/** Post each overlap to the Producer once (by file, line and lanes). Returns the ones posted now. */
export function postOverlaps(root, found, { by = 'harness', where = '' } = {}) {
  if (!found.length) return [];
  const fresh = withState(root, (s) => {
    const now = found.filter((o) => !s.posted[`${o.file}:${o.line}:${o.lanes.join(',')}`]);
    for (const o of now) s.posted[`${o.file}:${o.line}:${o.lanes.join(',')}`] = new Date().toISOString();
    return now;
  });
  for (const o of fresh) {
    inbox(root, overlapText(o));
    emitEvent({ type: 'hotspot.overlap', agent: by, to: 'producer', status: 'warn', msg: `${overlapText(o)}${where ? ` (seen at ${where})` : ''}`.slice(0, 600), meta: { file: o.file, line: o.line, lanes: o.lanes } });
  }
  return fresh;
}

/**
 * The warning `task start` and `task done --train` print (where: 'start' | 'train-queue'). At start every overlap in
 * flight (so the new task stays off those lines) and the places that already reached the ask; when queueing, the
 * overlaps this task's lane is part of. Never throws: a warning must not stop a start or a queue.
 */
export function warnAt(where, { task = null, agent = null } = {}, print = (m) => console.error(m)) {
  try {
    const root = mainRoot();
    let found = overlaps(root);
    if (where === 'train-queue' && task) found = found.filter((o) => o.lanes.some((l) => l === task || l.startsWith(`${task} `)));
    postOverlaps(root, found, { by: agent || 'harness', where: `${where === 'start' ? 'task start' : 'task done --train'} ${task || ''}`.trim() });
    for (const o of found.slice(0, 6)) print(`[hotspot] ${overlapText(o)}.`);
    if (found.length > 6) print(`[hotspot] and ${found.length - 6} more: node harness/hotspots.mjs`);
    if (where === 'start') for (const c of readState(root).conflicts.filter((x) => x.asked).slice(0, 3)) print(`[hotspot] ${c.file}:${c.line} conflicted in ${c.count} merges: stay off that line (the Producer was asked to restructure it).`);
    return found;
  } catch (e) {
    print(`[hotspot] the overlap check didn't run: ${e.message}`);
    return [];
  }
}

/** The merge train's start log: overlaps among this train's lanes and the other lanes in flight. Never throws. */
export function trainStart(root, lanes, log = () => {}, id = '') {
  try {
    const mine = (lanes || []).filter((l) => isSha(l.head)).map((l) => ({ ...l, label: `${l.task}${l.agent ? ` (${l.agent})` : ''}` }));
    const seen = new Set(mine.map((l) => l.branch || l.head));
    const all = [...mine, ...lanesInFlight(root).filter((l) => !seen.has(l.branch || l.head) && !mine.some((m) => m.task && m.task === l.task))];
    const found = overlaps(root, all).filter((o) => o.lanes.some((x) => mine.some((m) => m.label === x)));
    postOverlaps(root, found, { by: 'train', where: `train ${id}` });
    for (const o of found) log(`[train] ${id}: ${overlapText(o)}`);
    return found;
  } catch (e) {
    log(`[train] ${id}: the hotspot check didn't run: ${e.message}`);
    return [];
  }
}

// ---- conflicts --------------------------------------------------------------------------------------

/** Where two commits conflict: [{ file, line }] on `ours`'s lines (merge-tree touches no index and no files). */
export function conflictPlaces(root, ours, theirs) {
  const mt = git(root, 'merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs);
  if (mt.status === 0) return [];
  const files = String(mt.stdout || '').split('\n').slice(1).map((s) => s.trim()).filter(Boolean);
  const mb = out(git(root, 'merge-base', ours, theirs));
  if (!files.length || !isSha(mb)) return [];
  const a = diffHunks(root, mb, ours, files);
  const b = diffHunks(root, mb, theirs, files);
  const found = [];
  for (const f of files) {
    const places = [...(a.get(f) || []).map((h) => ({ ...place(h.os, h.on), owner: 'ours' })), ...(b.get(f) || []).map((h) => ({ ...place(h.os, h.on), owner: 'theirs' }))];
    const cs = clusters(places);
    if (!cs.length) { found.push({ file: f, line: 1 }); continue; }
    for (const c of cs) found.push({ file: f, line: Math.max(1, mapLine(c.line, a.get(f) || [])) });
  }
  return found;
}

/**
 * Count one conflict per place for this train (id) and raise the ask at the threshold, once per place.
 * places: [{ file, line, lanes: [task] }]. Returns the asks raised now.
 */
export function recordConflicts(root, places, { id, by = 'train', log = () => {} } = {}) {
  if (!places.length) return [];
  const asks = [];
  const logs = [];
  withState(root, (s) => { for (const p of places) {
    let e = s.conflicts.find((c) => c.file === p.file && Math.abs(c.line - p.line) <= NEAR);
    if (!e) { e = { file: p.file, line: p.line, count: 0, trains: [], lanes: [], asked: false }; s.conflicts.push(e); }
    if (e.trains.includes(id)) continue;
    e.trains = [...e.trains, id].slice(-20);
    e.count += 1;
    e.line = p.line;
    e.lanes = [...new Set([...e.lanes, ...(p.lanes || [])])].slice(-12);
    e.at = new Date().toISOString();
    logs.push(`[train] ${id}: ${p.file}:${p.line} conflicted (${e.count} time(s) so far${(p.lanes || []).length ? `: ${p.lanes.join(', ')}` : ''})`);
    if (e.count >= askAt() && !e.asked) {
      e.asked = true;
      asks.push({ file: e.file, line: e.line, count: e.count, lanes: [...e.lanes] });
    }
  } });
  for (const m of logs) log(m);
  for (const a of asks) {
    const text = `hotspot: restructure ${a.file}:${a.line} (registry/barrel pattern): ${a.count} merge conflicts on this line (lanes ${a.lanes.join(', ') || '?'}). Give each entry its own module and a generated or one-line-per-entry index (studio/rules/lanes.md), as a task before more lanes touch it`;
    inbox(root, text);
    emitEvent({ type: 'hotspot.ask', agent: by, to: 'producer', status: 'warn', msg: text.slice(0, 600), meta: { file: a.file, line: a.line, count: a.count, lanes: a.lanes } });
  }
  return asks;
}

/** The train's hook: the lanes this build deferred (conflict with the lanes before them) or dropped (conflict with main). Never throws. */
export function noteTrainConflicts(root, tip, built, { id, log = () => {} } = {}) {
  try {
    const places = [];
    for (const l of built?.deferred || []) for (const p of conflictPlaces(root, built.head, l.head)) places.push({ ...p, lanes: [...(built.included || []).map((x) => x.task), l.task] });
    for (const l of built?.conflictMain || []) for (const p of conflictPlaces(root, tip, l.head)) places.push({ ...p, lanes: [l.task] });
    return recordConflicts(root, places, { id, log });
  } catch (e) {
    log(`[train] ${id}: the conflict count didn't update: ${e.message}`);
    return [];
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const root = mainRoot();
  const found = overlaps(root);
  const { conflicts } = readState(root);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ overlaps: found, conflicts }, null, 2));
  else {
    console.log(found.length ? found.map((o) => `- ${overlapText(o)}`).join('\n') : 'No two lanes in flight change the same lines.');
    if (conflicts.length) console.log(`Merge conflicts by place (an ask at ${askAt()}):\n${conflicts.map((c) => `- ${c.file}:${c.line}: ${c.count}${c.asked ? ' (asked)' : ''}`).join('\n')}`);
  }
}
