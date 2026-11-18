/**
 * harness/landings.mjs — which tasks landed, read one way from the event log. A leaf: node built-ins and helpers only.
 * Kinds of record: 'web' (lane.merged, or a lane named in task.train.landed meta.lanes: the studio's main branch);
 * 'engine' (a lane named in task.train.<engine>.landed meta.lanes: the engine target, in its own repo); 'closed'
 * (task.done, landed or not: planning, watch and director tasks close with no branch); 'forced' (task.forced).
 * A measure is one kind, 'landed' (web or engine), or a list of them; a caller names the one it means.
 * A lane entry is a task id or an object with .task. Every landing also closes its task (task.done) unless the close
 * fails, so a reader that counts 'closed' already sees landings, and also tasks that landed nothing.
 */
import { tsMs } from './helpers.mjs';

const ENGINE_LANDED = /^task\.train\.([a-z][a-z0-9-]{1,30})\.landed$/;
const KINDS = new Set(['web', 'engine', 'closed', 'forced']);

const laneIds = (e) => (Array.isArray(e.meta?.lanes) ? e.meta.lanes.map((x) => (x && typeof x === 'object' ? x.task : x)) : [e.task]).filter((x) => x !== undefined && x !== null && x !== '').map(String);

/** { kind, engine, ids } for a record that counts toward some kind, else null. */
function readRecord(e) {
  const t = e?.type;
  if (t === 'lane.merged') return { kind: 'web', engine: null, ids: e.task ? [String(e.task)] : [] };
  if (t === 'task.train.landed') return { kind: 'web', engine: null, ids: laneIds(e) };
  if (t === 'task.done') return { kind: 'closed', engine: null, ids: e.task ? [String(e.task)] : [] };
  if (t === 'task.forced') return { kind: 'forced', engine: null, ids: e.task ? [String(e.task)] : [] };
  const m = ENGINE_LANDED.exec(String(t || ''));
  return m ? { kind: 'engine', engine: m[1], ids: laneIds(e) } : null;
}

const kindsOf = (measure) => {
  const ks = new Set((Array.isArray(measure) ? measure : [measure]).flatMap((k) => (k === 'landed' ? ['web', 'engine'] : [k])));
  for (const k of ks) if (!KINDS.has(k)) throw new Error(`landings: unknown measure "${k}" (web, engine, landed, closed, forced)`);
  return ks;
};

/** The task ids one event counts toward `measure` ([] when it counts toward none). */
export function tasksOf(e, measure) {
  const r = readRecord(e);
  return r && kindsOf(measure).has(r.kind) ? r.ids : [];
}

/**
 * Every (task, record) pair of `measure` in events, in the events' order: [{ task, at (ms), ts, kind, engine, e }].
 * since: at >= since; after: at > after; before: at < before.
 */
export function landings(events, measure, { since = -Infinity, after = -Infinity, before = Infinity } = {}) {
  const ks = kindsOf(measure);
  const out = [];
  for (const e of events || []) {
    const r = readRecord(e);
    if (!r || !ks.has(r.kind)) continue;
    const at = tsMs(e);
    if (at < since || at <= after || at >= before) continue;
    for (const task of r.ids) out.push({ task, at, ts: e.ts, kind: r.kind, engine: r.engine, e });
  }
  return out;
}

/**
 * 'landed' when the log has any landing record, else 'closed': a studio with no lanes or trains closes tasks in the main
 * checkout, where task.done is the landing. Decide on the whole log the caller read, not on a quiet window of it.
 */
export const landedMeasure = (events) => ((events || []).some((e) => ['web', 'engine'].includes(readRecord(e)?.kind)) ? 'landed' : 'closed');

/** The distinct task ids of landings(events, measure, window), first seen first. */
export const landedTasks = (events, measure, window = {}) => [...new Set(landings(events, measure, window).map((l) => l.task))];

/** { measure, count, closedWithoutLanding }: the window's count by landedMeasure(all), and the closes that landed nothing in it. */
export function landedCounts(events, all = events) {
  const measure = landedMeasure(all);
  const count = landedTasks(events, measure);
  if (measure === 'closed') return { measure, count: count.length, closedWithoutLanding: 0 };
  const landed = new Set(count);
  return { measure, count: count.length, closedWithoutLanding: landedTasks(events, 'closed').filter((t) => !landed.has(t)).length };
}

/** "landed: 3; closed without a landing: 2" (second part only above 0); "closed: 7" in a log with no landing. */
export const landedText = (events, all = events) => { const c = landedCounts(events, all); return `${c.measure}: ${c.count}${c.closedWithoutLanding > 0 ? `; closed without a landing: ${c.closedWithoutLanding}` : ''}`; };
