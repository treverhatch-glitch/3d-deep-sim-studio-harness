/**
 * harness/task-overlap.mjs — 2.69.0 (s): overlap checks when work is added or started.
 *
 * The crew's orchestrator spotted two tasks editing the same sim line, and three sharing replays, only by eye. Now
 * `task add` and `task start` compare the task with the work already open:
 *   - its lane (declared with --paths/--lane, `task lane`, or guessed from the title: harness/task-hold.mjs laneOf)
 *     against what each lane in flight already changes (queued lanes and lane copies with unlanded commits, diffed
 *     against main: harness/hotspots.mjs laneChanges) and against the lanes of open tasks;
 *   - at start, its own lane's diff against main once it has one, line by line (hotspots.mjs overlaps);
 *   - its title against open tasks' titles (normalised word overlap of TITLE_MIN, 0.7, or more).
 * Each finding is printed ("T-132 already changes src/sim/sim.ts:120-140; consider stacking (--after T-132) or
 * splitting the scope") and recorded as one task.overlap event. Advisory: nothing is refused unless
 * STUDIO_OVERLAP=block (then add and start refuse while an overlap stands); STUDIO_OVERLAP=off skips the check.
 * Never throws: a failed check is a line, not a refused add.
 */
import { emitEvent, readRecentEvents } from './event.mjs';
import { laneOf, laneList, laneEntries, readHolds } from './task-hold.mjs';
import { entriesClash } from './lane-regions.mjs';
import { lanesInFlight, laneChanges, overlaps } from './hotspots.mjs';
import { mainRoot } from './worktree.mjs';

export const TITLE_MIN = 0.7;
export const overlapMode = (env = process.env) => {
  const v = String(env.STUDIO_OVERLAP || '').trim().toLowerCase();
  return /^(off|0|false|no)$/.test(v) ? 'off' : v === 'block' ? 'block' : 'warn';
};

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'from', 'by', 'at', 'is', 'it', 'its', 'be', 'so', 'as', 'into', 'when', 'that', 'this']);
const TYPE_PREFIX = /^\s*(bug|chore|study|balance|fun|playtest|review|docs|idea|system)\s*:\s*/i;
/** A title's words for comparing: lower case, no [ref:…], no type prefix, no stop words, no one-letter words. */
export function titleWords(title) {
  const t = String(title || '').replace(/\[ref:[^\]]*\]/g, ' ').replace(TYPE_PREFIX, '').toLowerCase();
  return new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)));
}
/** Shared words over the longer title's words (0..1): "Fix fee panel overflow" vs "Fix the fee panel overflow on resize" = 0.8. */
export function titleOverlap(a, b) {
  const A = titleWords(a); const B = titleWords(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n += 1;
  return n / Math.max(A.size, B.size);
}

const meet = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
/** Ranges as text, joined when they touch: "120-140, 180". */
export function rangesText(ranges) {
  const s = [...ranges].sort((x, y) => x.start - y.start);
  const merged = [];
  for (const r of s) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged.slice(0, 4).map((r) => (r.end > r.start ? `${r.start}-${r.end}` : `${r.start}`)).join(', ') + (merged.length > 4 ? ', …' : '');
}

const advice = (other, id, phase) => (phase === 'start' && id
  ? `consider stacking (--after ${other}: npm run task -- block ${id} --until ${other} --by <you>) or splitting the scope`
  : `consider stacking (--after ${other}) or splitting the scope`);

/**
 * The overlaps for one task: [{ kind: 'diff' | 'lines' | 'lane' | 'title', with, text, file?, lines? }].
 * id: the task (null at add, before it has one); title, meta (at add: the task.added meta it will get); phase 'add' | 'start'.
 * Everything else is read from the studio unless given (tests pass board, events, holds, root, inFlight).
 */
export function findOverlaps({ id = null, title = '', role = 'builder', meta = {}, phase = 'add', board, events = null, holds = null, root = null, inFlight = null } = {}) {
  const evs = events || readRecentEvents(20000);
  const hl = holds || readHolds();
  const declared = id
    ? laneOf(id, evs, hl)
    : laneOf('T-0', [{ type: 'task.added', task: 'T-0', msg: `Queued T-0 [P1] (${role}): ${title}`, meta: { ...meta, role } }], {});
  const mine = laneList(declared || '');
  const open = [...(board?.inProgress || []).map((t) => ({ ...t, where: 'in progress' })), ...(board?.backlog || []).map((t) => ({ ...t, where: 'waiting' }))].filter((t) => t.id !== id);
  const found = [];
  const seen = new Set();
  // 1. Lanes in flight: what they already change, against this task's lane (and, at start, its own diff).
  let r = root;
  let flight = inFlight;
  try { r ||= mainRoot(); flight ||= lanesInFlight(r); } catch { flight ||= []; }
  const own = id ? flight.find((l) => l.task === id) : null;
  const others = flight.filter((l) => l !== own && (!id || l.task !== id));
  if (mine.length) {
    for (const l of others) {
      const name = l.task || l.label;
      let ch = new Map();
      try { ch = laneChanges(r, l); } catch {}
      const hits = [...ch.entries()].filter(([f]) => mine.some((p) => meet(f, p)));
      if (!hits.length) continue;
      seen.add(name);
      const where = hits.slice(0, 3).map(([f, rs]) => `${f}:${rangesText(rs)}`).join(', ') + (hits.length > 3 ? ` and ${hits.length - 3} more file(s)` : '');
      found.push({ kind: 'diff', with: name, file: hits[0][0], lines: rangesText(hits[0][1]), text: `${name} already changes ${where}; ${advice(name, id, phase)}` });
    }
  }
  if (own) {
    let ov = [];
    try { ov = overlaps(r, [own, ...others]); } catch {}
    for (const o of ov.filter((x) => x.lanes.includes(own.label))) {
      for (const lab of o.lanes.filter((x) => x !== own.label)) {
        const name = (others.find((l) => l.label === lab) || {}).task || lab;
        found.push({ kind: 'lines', with: name, file: o.file, lines: String(o.line), text: `${name} already changes ${o.file}:${o.line}, and so does this task's lane; ${advice(name, id, phase)}` });
        seen.add(name);
      }
    }
  }
  // 2. Open tasks' lanes (no diff yet): the same files or folders.
  if (mine.length) {
    for (const t of open) {
      if (seen.has(t.id)) continue;
      let theirs = [];
      try { theirs = laneEntries(laneOf(t.id, evs, hl) || ''); } catch {}
      // 2.78.2 (item 9): regions of an opted-in file that don't overlap don't meet (harness/lane-regions.mjs).
      const mineE = laneEntries(declared || '');
      const hit = theirs.filter((p) => mineE.some((m) => (p.includes('#') || m.includes('#') ? entriesClash(p, m) : meet(p, m))));
      if (!hit.length) continue;
      seen.add(t.id);
      found.push({ kind: 'lane', with: t.id, file: hit[0], text: `${t.id} (${t.where}) works in ${hit.slice(0, 3).join(', ')} too; ${advice(t.id, id, phase)}` });
    }
  }
  // 3. Near-duplicate titles.
  for (const t of open) {
    const s = titleOverlap(title, t.title);
    if (s < TITLE_MIN) continue;
    found.push({ kind: 'title', with: t.id, text: `${t.id} "${String(t.title).slice(0, 100)}" (${t.where}) looks like the same work (${Math.round(s * 100)}% of the title's words); ${advice(t.id, id, phase)}` });
  }
  return { lane: declared || null, found };
}

/**
 * The check `task add` and `task start` run: { mode, found, block, lines }. Records one task.overlap event when
 * something overlaps (with block: true when STUDIO_OVERLAP=block refuses). Never throws.
 */
export function overlapCheck({ id = null, title = '', role = 'builder', meta = {}, phase = 'add', agent = null, board, env = process.env, ...rest } = {}) {
  const mode = overlapMode(env);
  if (mode === 'off') return { mode, found: [], block: false, lines: [] };
  let res;
  try { res = findOverlaps({ id, title, role, meta, phase, board, ...rest }); } catch (e) { return { mode, found: [], block: false, lines: [`[overlap] the overlap check didn't run: ${e.message}`] }; }
  const block = mode === 'block' && res.found.length > 0;
  const lines = res.found.slice(0, 8).map((f) => `[overlap] ${f.text}`);
  if (res.found.length > 8) lines.push(`[overlap] and ${res.found.length - 8} more`);
  if (res.found.length) {
    if (block) lines.push(`[overlap] STUDIO_OVERLAP=block: ${phase === 'add' ? 'not queued' : 'not started'}. Stack it (--after), split the scope, or ask a person to change STUDIO_OVERLAP.`);
    try {
      emitEvent({
        type: 'task.overlap', agent: agent || undefined, task: id || undefined, to: 'producer', status: block ? 'blocked' : 'warn',
        msg: `${phase === 'add' ? `adding "${String(title).slice(0, 80)}"` : `starting ${id}`}: ${res.found.map((f) => f.text).join(' | ')}`.slice(0, 600),
        meta: { phase, mode, block, lane: res.lane, title: String(title).slice(0, 200), with: [...new Set(res.found.map((f) => f.with))], items: res.found.slice(0, 12).map(({ kind, with: w, file, lines: l }) => ({ kind, with: w, file: file || null, lines: l || null })) },
      });
    } catch { /* the record is a help, never a blocker */ }
  }
  return { mode, found: res.found, block, lines, lane: res.lane };
}
