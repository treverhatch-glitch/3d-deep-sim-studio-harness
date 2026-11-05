#!/usr/bin/env node
/**
 * harness/plan-waves.mjs — 2.78.0 (PU-60): plan-time scope and waves, in SHADOW mode. A script: no model, no tokens.
 *
 *   node harness/plan-waves.mjs [--json]     the ready queue as waves, which running lanes overlap which ready tasks, and the serialized share
 *   node harness/plan-waves.mjs replay --events <events.jsonl> --days 14 [--json]
 *                                       how many recorded overlaps waves would have avoided, and roughly how much extra wall time
 *
 * A task may carry a scope: the globs of the files it expects to touch (`task add --scope "src/sim/**,docs/A.md"`; stored
 * as `scope` in the task.added event's meta, see parseScope). A task with no scope borrows the files its hotspot.overlap
 * and task.overlap history names. Tasks whose files overlap are joined in a graph and coloured greedily, in queue order,
 * into waves: tasks in one wave never overlap. A task in wave 2 or later is "serialized"; the serialized share is those
 * over all ready tasks. Over STUDIO_WAVES_MAX_SHARE (0.6) waves would over-serialize the crew (the stop rule).
 *
 * Shadow mode only: `shadowPass` (called from the watcher, harness/watch.mjs) logs one waves.shadow event at most every
 * STUDIO_WAVES_MIN minutes (30; STUDIO_WAVES=off skips it). Nothing here changes which task starts, blocks or holds.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { matchAny } from './merge-lane.mjs';

const num = (v, d) => (String(v ?? '').trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
export const wavesMinutes = (env = process.env) => Math.max(0, num(env.STUDIO_WAVES_MIN, 30));
export const maxShare = (env = process.env) => num(env.STUDIO_WAVES_MAX_SHARE, 0.6);
export const wavesOff = (env = process.env) => /^(off|0|false|no)$/i.test(String(env.STUDIO_WAVES || '').trim());
const STATE = () => path.join(STUDIO_STATE_DIR, 'waves-shadow.json');

const GLOB_CHARS = /[*?[\]{}]/;
const norm = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * `--scope "<glob>,<glob>"` as a list of globs. Free text (an engine pass's prose scope, words with spaces) is not a
 * glob list: those entries are dropped, so such a task counts as unscoped. A comma inside {a,b} stays inside.
 */
export function parseScope(v) {
  if (Array.isArray(v)) v = v.join(',');
  const out = [];
  let depth = 0; let cur = '';
  for (const ch of String(v ?? '')) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && !depth) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return [...new Set(out.map(norm).filter((g) => g && !/\s/.test(g)))];
}

/** The folder part of a glob before its first wildcard segment: "src/sim/**" -> "src/sim", "src/*.ts" -> "src". */
const staticPrefix = (g) => {
  const segs = g.split('/');
  const i = segs.findIndex((s) => GLOB_CHARS.test(s));
  return (i < 0 ? segs : segs.slice(0, i)).join('/');
};
const related = (a, b) => a === b || !a || !b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** Can these two globs (or paths) name the same file? Conservative: when unsure, yes. */
export function globsOverlap(a, b) {
  // 2.78.2 (item 9): a region entry (path/sim.ts#symbol) is its whole file here: predictions stay file-level; only the
  // supervisor's lane check and the shared-sim stacking read regions (harness/lane-regions.mjs).
  a = norm(String(a ?? '').split('#')[0]); b = norm(String(b ?? '').split('#')[0]);
  const ga = GLOB_CHARS.test(a); const gb = GLOB_CHARS.test(b);
  if (!ga && !gb) return related(a, b) && a !== '' && b !== '';
  if (ga !== gb) {
    const [file, glob] = ga ? [b, a] : [a, b];
    if (matchAny(file, [glob])) return true;
    // a plain folder name covers the files below it
    return staticPrefix(glob) === file || staticPrefix(glob).startsWith(`${file}/`) || (file.startsWith(`${staticPrefix(glob)}/`) && /(^|\/)\*\*$/.test(glob));
  }
  return related(staticPrefix(a), staticPrefix(b));
}
/** The first pair of entries that overlap, or null: { a, b }. */
export function firstOverlap(A, B) {
  for (const a of A) for (const b of B) if (globsOverlap(a, b)) return { a, b };
  return null;
}

/** What a task is known to touch: its scope, else the files its overlap history named. */
const footprint = (t) => (t.scope?.length ? t.scope : t.files || []);

/**
 * The plan. ready: [{ id, title?, scope?: [glob], files?: [path] }] in queue order. running: the same, for lanes in flight
 * (files may hold what the lane already changed). Pure and deterministic.
 */
export function planWaves({ ready = [], running = [], max = maxShare() } = {}) {
  const fp = new Map(ready.map((t) => [t.id, footprint(t)]));
  const edges = [];
  for (let i = 0; i < ready.length; i += 1) {
    for (let j = i + 1; j < ready.length; j += 1) {
      const hit = firstOverlap(fp.get(ready[i].id), fp.get(ready[j].id));
      if (hit) edges.push({ a: ready[i].id, b: ready[j].id, via: hit.a === hit.b ? hit.a : `${hit.a} ~ ${hit.b}` });
    }
  }
  const adj = new Map(ready.map((t) => [t.id, new Set()]));
  for (const e of edges) { adj.get(e.a).add(e.b); adj.get(e.b).add(e.a); }
  const waveOf = new Map();
  const waves = [];
  for (const t of ready) {
    let w = 0;
    while ([...adj.get(t.id)].some((o) => waveOf.get(o) === w)) w += 1;
    waveOf.set(t.id, w);
    (waves[w] ||= []).push(t.id);
  }
  const runningOverlaps = [];
  for (const r of running) {
    const rf = [...(r.scope || []), ...(r.files || [])];
    if (!rf.length) continue;
    for (const t of ready) {
      const hit = firstOverlap(rf, fp.get(t.id));
      if (hit) runningOverlaps.push({ running: r.id, agent: r.agent || null, ready: t.id, via: hit.a === hit.b ? hit.a : `${hit.a} ~ ${hit.b}`, wave: waveOf.get(t.id) });
    }
  }
  const serialized = ready.filter((t) => waveOf.get(t.id) > 0).length;
  const share = ready.length ? Math.round((serialized / ready.length) * 1000) / 1000 : 0;
  return {
    ready: ready.map((t) => t.id), waves, edges, runningOverlaps,
    unscoped: ready.filter((t) => !fp.get(t.id).length).map((t) => t.id),
    serialized, serializedShare: share, maxShare: max, overSerialize: share > max,
  };
}

export function wavesText(p) {
  const L = [`Waves for ${p.ready.length} ready task(s) (shadow mode: nothing is scheduled by this):`];
  p.waves.forEach((w, i) => L.push(`  wave ${i + 1}: ${w.join(', ')}`));
  if (!p.waves.length) L.push('  (no ready tasks)');
  for (const e of p.edges.slice(0, 12)) L.push(`  ${e.a} overlaps ${e.b} (${e.via})`);
  if (p.edges.length > 12) L.push(`  and ${p.edges.length - 12} more overlap(s)`);
  for (const o of p.runningOverlaps.slice(0, 12)) L.push(`  running ${o.running}${o.agent ? ` (${o.agent})` : ''} overlaps ready ${o.ready} (${o.via})`);
  if (p.runningOverlaps.length > 12) L.push(`  and ${p.runningOverlaps.length - 12} more running/ready overlap(s)`);
  if (p.unscoped.length) L.push(`  no scope and no history (treated as overlapping nothing): ${p.unscoped.slice(0, 12).join(', ')}${p.unscoped.length > 12 ? ', …' : ''}`);
  L.push(`serialized: ${p.serialized} of ${p.ready.length} ready task(s) = ${Math.round(p.serializedShare * 100)}%${p.overSerialize ? `; over ${Math.round(p.maxShare * 100)}%: waves would over-serialize the crew` : ''}`);
  return L.join('\n');
}

// ---- reading the studio ----
const taskIds = (s) => [...new Set(String(s || '').match(/\b[A-Z]+-\d+\b/g) || [])];

/** Files each task's overlap history names: Map<taskId, Set<file>>, from hotspot.overlap and task.overlap events (before `until`, a ms time). */
export function overlapHistory(events, until = Infinity) {
  const by = new Map();
  const add = (id, f) => { if (id && f) { if (!by.has(id)) by.set(id, new Set()); by.get(id).add(norm(f)); } };
  for (const e of events) {
    if (!(Date.parse(e.ts) < until || !e.ts)) continue;
    if (e.type === 'hotspot.overlap') for (const l of e.meta?.lanes || []) for (const id of taskIds(l)) add(id, e.meta?.file);
    else if (e.type === 'task.overlap') for (const it of e.meta?.items || []) { add(e.task, it.file); add(it.with, it.file); }
  }
  return by;
}
const scopeOf = (events, id) => { const a = events.filter((e) => e.type === 'task.added' && e.task === id).pop(); return parseScope(a?.meta?.scope); };

/** The queue as the planner reads it. q: the board (parseNextQueue); readyIds: the builder tasks that could start now. */
export function gather({ q, readyIds, events, running = null }) {
  const hist = overlapHistory(events);
  const mk = (t) => ({ id: t.id, title: t.title, scope: scopeOf(events, t.id), files: [...(hist.get(t.id) || [])] });
  const byId = new Map((q.backlog || []).map((t) => [t.id, t]));
  const ready = readyIds.map((id) => byId.get(id)).filter(Boolean).map(mk);
  const run = running || (q.inProgress || []).map((t) => ({ ...mk(t), agent: t.agent || t.owner || null }));
  return { ready, running: run };
}

async function liveRunning(q, events) {
  const out = (q.inProgress || []).map((t) => ({ id: t.id, title: t.title, agent: t.agent || t.owner || null, scope: scopeOf(events, t.id), files: [] }));
  // What a running lane has already changed (its diff against main), when the lane is a copy with unlanded commits.
  try {
    const hs = await import('./hotspots.mjs');
    const { mainRoot } = await import('./worktree.mjs');
    const root = mainRoot();
    const hist = overlapHistory(events);
    for (const l of hs.lanesInFlight(root)) {
      const r = out.find((x) => x.id === l.task);
      if (r) r.files = [...new Set([...r.files, ...hs.laneChanges(root, l).keys()])];
    }
    for (const r of out) r.files = [...new Set([...r.files, ...(hist.get(r.id) || [])])];
  } catch { /* the diff is a help; scope and history still count */ }
  return out;
}

/** The current queue, planned. deps (tests): { q, readyIds, events, running }. */
export async function currentWaves(deps = {}) {
  const events = deps.events || readRecentEvents(20000);
  const q = deps.q || (await import('./task.mjs')).parseNextQueue();
  let readyIds = deps.readyIds;
  if (!readyIds) {
    const { readiness } = await import('./queue-depth.mjs');
    readyIds = readiness(q, { events }).ready;
  }
  const g = gather({ q, readyIds, events, running: deps.running || (deps.q ? null : await liveRunning(q, events)) });
  return planWaves(g);
}

/**
 * Shadow mode: at most every STUDIO_WAVES_MIN minutes, plan the queue and log one waves.shadow event. Never changes
 * which task starts; never throws. { ran, why, plan? }.
 */
export async function shadowPass({ now = Date.now(), env = process.env, deps = {}, dryRun = false } = {}) {
  try {
    if (wavesOff(env)) return { ran: false, why: 'STUDIO_WAVES=off' };
    let st = {};
    try { st = JSON.parse(fs.readFileSync(STATE(), 'utf8')); } catch {}
    const every = wavesMinutes(env) * 60000;
    if (st.at && now - Date.parse(st.at) < every) return { ran: false, why: `logged ${st.at}` };
    const plan = await currentWaves(deps);
    if (dryRun) return { ran: false, why: 'dry run', plan };
    try { fs.mkdirSync(path.dirname(STATE()), { recursive: true }); fs.writeFileSync(STATE(), `${JSON.stringify({ at: new Date(now).toISOString() })}\n`); } catch {}
    if (!plan.ready.length) return { ran: false, why: 'no ready tasks', plan };
    const msg = `Waves (shadow, nothing scheduled): ${plan.ready.length} ready in ${plan.waves.length} wave(s), ${plan.serialized} serialized (${Math.round(plan.serializedShare * 100)}%)${plan.overSerialize ? `; over ${Math.round(plan.maxShare * 100)}%: waves would over-serialize` : ''}; ${plan.runningOverlaps.length} running/ready overlap(s); ${plan.unscoped.length} unscoped`;
    emitEvent({ type: 'waves.shadow', agent: 'watch', status: plan.overSerialize ? 'warn' : 'info', msg, meta: { waves: plan.waves.slice(0, 12), serialized: plan.serialized, ready: plan.ready.length, share: plan.serializedShare, overSerialize: plan.overSerialize, runningOverlaps: plan.runningOverlaps.slice(0, 12), unscoped: plan.unscoped.length } });
    return { ran: true, why: msg, plan };
  } catch (e) {
    return { ran: false, why: `waves shadow failed: ${e.message}` };
  }
}

// ---- replay ----
const tsOf = (e) => Date.parse(e.ts);
const fmtH = (ms) => (ms >= 3600000 ? `${Math.round(ms / 360000) / 10} h` : `${Math.round(ms / 6000) / 10} min`);

/**
 * Replay past events: how many recorded hotspot.overlap events (and distinct task pairs) would waves have avoided, i.e.
 * the two tasks' scopes (or the overlap history known BEFORE that event) overlapped, so they would have been in different
 * waves. Extra wall time, roughly: for the task that started second, how long it overlapped the other (task.start to
 * task.done; a task with no done event counts as long as the median); each task counts its largest such wait once.
 */
export function replayWaves(events, { days = 14, now = null } = {}) {
  const evs = events.filter((e) => e && e.ts && Number.isFinite(tsOf(e))).sort((a, b) => tsOf(a) - tsOf(b));
  const end = now ?? (evs.length ? tsOf(evs[evs.length - 1]) : Date.now());
  const from = end - days * 86400000;
  const inWin = evs.filter((e) => tsOf(e) >= from && tsOf(e) <= end);
  const starts = inWin.filter((e) => e.type === 'task.start' && e.task);
  const spans = new Map(); // task -> [{ start, end }]
  for (const s of starts) {
    const done = evs.find((e) => e.task === s.task && tsOf(e) > tsOf(s) && /^task\.(done|handback|pause|paused)$/.test(e.type));
    (spans.get(s.task) || spans.set(s.task, []).get(s.task)).push({ start: tsOf(s), end: done ? tsOf(done) : null });
  }
  const known = [...spans.values()].flat().filter((x) => x.end).map((x) => x.end - x.start).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 0;
  const spanAt = (id, t) => { const l = (spans.get(id) || []).filter((x) => x.start <= t).pop() || (spans.get(id) || [])[0]; return l ? { start: l.start, end: l.end ?? l.start + median } : null; };
  const overlapsRec = inWin.filter((e) => e.type === 'hotspot.overlap');
  const scopes = new Map();
  const scopeFor = (id) => { if (!scopes.has(id)) scopes.set(id, scopeOf(evs, id)); return scopes.get(id); };
  let avoided = 0; let unavoidable = 0;
  const pairs = new Map(); // "A|B" -> { avoided }
  const wait = new Map(); // later task -> ms
  for (const o of overlapsRec) {
    const ids = [...new Set((o.meta?.lanes || []).flatMap(taskIds))];
    if (ids.length < 2) { unavoidable += 1; continue; }
    const hist = overlapHistory(evs, tsOf(o)); // only what was known before this event
    let hit = false;
    let pair = null;
    for (let i = 0; i < ids.length && !hit; i += 1) {
      for (let j = i + 1; j < ids.length && !hit; j += 1) {
        const fa = footprint({ scope: scopeFor(ids[i]), files: [...(hist.get(ids[i]) || [])] });
        const fb = footprint({ scope: scopeFor(ids[j]), files: [...(hist.get(ids[j]) || [])] });
        if (fa.length && fb.length && firstOverlap(fa, fb)) { hit = true; pair = [ids[i], ids[j]]; }
      }
    }
    if (!hit) { unavoidable += 1; continue; }
    avoided += 1;
    const key = pair.slice().sort().join('|');
    if (!pairs.has(key)) {
      pairs.set(key, true);
      const sa = spanAt(pair[0], tsOf(o)); const sb = spanAt(pair[1], tsOf(o));
      if (sa && sb) {
        const [first, second, later] = sa.start <= sb.start ? [sa, sb, pair[1]] : [sb, sa, pair[0]];
        const ms = Math.max(0, Math.min(first.end, second.end) - second.start);
        wait.set(later, Math.max(wait.get(later) || 0, ms));
      }
    }
  }
  const extraMs = [...wait.values()].reduce((n, x) => n + x, 0);
  return {
    days, from: new Date(from).toISOString(), to: new Date(end).toISOString(),
    taskStarts: starts.length, overlapEvents: overlapsRec.length, avoidedEvents: avoided, notAvoided: unavoidable,
    avoidedPairs: pairs.size, extraWallMs: extraMs,
  };
}
export const replayText = (r) => `Replay ${r.from.slice(0, 10)} to ${r.to.slice(0, 10)} (${r.days} days): ${r.taskStarts} task start(s), ${r.overlapEvents} hotspot.overlap event(s).\nWaves would have avoided ${r.avoidedEvents} of them (${r.avoidedPairs} distinct task pair(s)); ${r.notAvoided} could not be (no scope or history known before the event).\nExtra wall time, roughly (the later task of each avoided pair waits out the overlap): ${fmtH(r.extraWallMs)}.`;

// ---- CLI ----
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true; };
  const json = argv.includes('--json');
  if (argv[0] === 'replay') {
    const f = flag('events');
    if (typeof f !== 'string' || !fs.existsSync(f)) { console.error('Usage: node harness/plan-waves.mjs replay --events <events.jsonl> --days 14 [--json]'); process.exit(1); }
    const events = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const r = replayWaves(events, { days: num(flag('days'), 14) });
    console.log(json ? JSON.stringify(r, null, 2) : replayText(r));
  } else {
    const p = await currentWaves();
    console.log(json ? JSON.stringify(p, null, 2) : wavesText(p));
  }
}
