/**
 * harness/lane-plan.mjs — 2.78.1 (B-123): lanes for unscoped builder tasks, unscoped builders side by side, and shared
 * sim code stacked (phase awareness).
 *
 * The crew's run: every ready builder task had no lane in studio/task-holds.json, so a builder on any one of them
 * counted as "working on the whole game (no lane)" and the supervisor started no other builder (1-2 builders with 5
 * ready and a target of 6). Three parts here, each with a setting to turn it off:
 *
 *   1. lanePass (the Line Producer's pass, harness/line-producer.mjs, on the Producer's behalf): each READY builder task
 *      with no lane (and not the whole game on purpose: task add --lane all, or task lane <ID> all) gets one worked out
 *      from what it says it touches: its --scope globs (their folders), the code paths its title, asked text or its own
 *      hand-off note names (paths that exist, outside studio/, docs/ and the harness), the files its title points at
 *      (harness/task-hold.mjs inferLaneAtAdd) and plan-waves' predicted files (harness/plan-waves.mjs: its overlap
 *      history). The lane is written where the supervisor reads it (studio/task-holds.json "lane", as `task lane` does),
 *      logged as the Producer's decision (.studio/decisions.jsonl, a task.lane event). A task it can't scope is reported
 *      "unscoped" (the Line Producer's status and blockers). A running task is never re-scoped by the pass: only a
 *      person, the orchestrator or the Producer does that (npm run task -- lane <ID> <folders> --by <you>).
 *      STUDIO_LINE_LANES=on (default) | report (say what it would set, set nothing) | off.
 *   2. predictedApart (the supervisor's lane check, harness/supervisor.mjs): two builders where one or both have no lane
 *      run side by side when both have a prediction (a lane, else plan-waves' scope or overlap history) and the two
 *      don't overlap. No prediction on either side: the old rule (no lane = the whole game). STUDIO_UNSCOPED_PARALLEL=off
 *      turns it off.
 *   3. stackShared (phase awareness, in lanePass): a ready builder task whose lane or predicted files touch shared sim
 *      code waits (--after) for the open task before it (in progress first, then the Line Producer's order) that touches
 *      the same shared files, instead of running beside it. Shared sim code: STUDIO_SHARED_SIM (globs, comma separated;
 *      "off" turns stacking off), else the game manifest's "sharedSim" (<game>/studio.gates.json), else DEFAULT_SHARED_SIM.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { laneList, laneOf, inferLaneAtAdd, gameFolders, setHold } from './task-hold.mjs';
import { parseScope, overlapHistory, firstOverlap } from './plan-waves.mjs';
import { matchAny } from './merge-lane.mjs';

const OFF = /^(off|0|false|no)$/i;
const norm = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
const GLOB = /[*?[\]{}]/;

/** STUDIO_LINE_LANES: on (default) | report | off. */
export function lineLanesMode(env = process.env) {
  const v = String(env.STUDIO_LINE_LANES ?? '').trim().toLowerCase();
  if (OFF.test(v)) return 'off';
  if (/^(report|shadow|dry)$/.test(v)) return 'report';
  return 'on';
}
/** STUDIO_UNSCOPED_PARALLEL: on (default) | off. */
export const unscopedParallelOn = (env = process.env) => !OFF.test(String(env.STUDIO_UNSCOPED_PARALLEL ?? '').trim());

/**
 * Shared sim code when nothing else says: a cartridge's entry and core files, and a sim folder's core, shared systems
 * and types. Generic on purpose: a game names its own in its manifest ("sharedSim") or STUDIO_SHARED_SIM.
 */
export const DEFAULT_SHARED_SIM = [
  'cartridges/*/index.*', 'cartridges/*/sim.*', 'cartridges/*/core/**', 'cartridges/*/systems/**',
  '**/sim/sim.*', '**/sim/index.*', '**/sim/core/**', '**/sim/systems/**', '**/sim/shared/**', '**/sim/types.*', '**/src/sim.*',
];

/** The shared sim globs in force: { globs, from }. globs [] when STUDIO_SHARED_SIM=off. */
export function sharedSimGlobs({ env = process.env, root = REPO_ROOT } = {}) {
  const v = String(env.STUDIO_SHARED_SIM ?? '').trim();
  if (OFF.test(v)) return { globs: [], from: 'STUDIO_SHARED_SIM=off' };
  if (v) return { globs: v.split(',').map(norm).filter(Boolean), from: 'STUDIO_SHARED_SIM' };
  try {
    const f = gameFolders();
    for (const dir of [f.renderer, f.sim].filter(Boolean)) {
      const j = JSON.parse(fs.readFileSync(path.join(root, dir, 'studio.gates.json'), 'utf8'));
      if (Array.isArray(j.sharedSim) && j.sharedSim.length) return { globs: j.sharedSim.map(norm).filter(Boolean), from: `${dir}/studio.gates.json "sharedSim"` };
    }
  } catch { /* no manifest or no key: the default */ }
  return { globs: DEFAULT_SHARED_SIM, from: 'the default (DEFAULT_SHARED_SIM)' };
}

const scopeOfMeta = (meta) => parseScope(meta?.scope);
const addedMeta = (events, id) => events.filter((e) => e.type === 'task.added' && e.task === id).pop()?.meta || {};

/**
 * plan-waves' prediction for each task: (id) -> [glob or path], its --scope globs, else the files its overlap history
 * names (hotspot.overlap, task.overlap). [] when there is none.
 */
export function predictor(events = []) {
  const hist = overlapHistory(events);
  const cache = new Map();
  return (id) => {
    if (!id) return [];
    if (!cache.has(id)) {
      const s = scopeOfMeta(addedMeta(events, id));
      cache.set(id, s.length ? s : [...(hist.get(id) || [])]);
    }
    return cache.get(id);
  };
}

/** Two footprints that are both known and name no file in common (plan-waves globsOverlap; conservative). */
export function predictedApart(a = [], b = []) {
  return a.length > 0 && b.length > 0 && !firstOverlap(a, b);
}

/**
 * The supervisor's lane check with predictions: does a running session (lane sLane, task sTask) clash with a waiting
 * task (lane gLane, task gTask)? clashes(a, b) is the lane rule (harness/task-hold.mjs lanesClash). Two lanes that clash
 * always clash; where one or both have no lane, both footprints (the lane, else the prediction) must be known and apart.
 */
export function clashWithPredictions({ sLane = null, gLane = null, sTask = null, gTask = null, clashes, predict, env = process.env }) {
  if (!clashes(sLane, gLane)) return false;
  if ((sLane && gLane) || !unscopedParallelOn(env) || typeof predict !== 'function') return true;
  const fs1 = sLane ? laneList(sLane) : predict(sTask);
  const fs2 = gLane ? laneList(gLane) : predict(gTask);
  return !predictedApart(fs1, fs2);
}

// ---- working out a lane --------------------------------------------------------------------------------------------

/** A --scope glob's folder (its part before the first wildcard): src/sim/** -> src/sim; '' (the whole repo) is dropped. */
export function scopeFolders(scope) {
  const out = new Set();
  for (const g of parseScope(scope)) {
    const segs = norm(g).split('/');
    const i = segs.findIndex((s) => GLOB.test(s));
    const p = (i < 0 ? segs : segs.slice(0, i)).join('/');
    if (p && !p.split('/').includes('..')) out.add(p);
  }
  return [...out];
}

/** Paths a builder's lane never holds: the board, docs, the harness and its checks (a brief names them all the time). */
const NOT_A_LANE = /^(studio|docs|\.studio|\.lanes|\.git|node_modules|harness|hub|scripts|tools|qa)(\/|$)/;

/** Existing code paths a text names (a/b/c.ts, src/sim/, `game/x/y.js`), outside NOT_A_LANE. */
export function namedCodePaths(text, root = REPO_ROOT) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/(?:^|[\s`'"(\[,;:])((?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]*)/g)) {
    const p = norm(m[1].replace(/[.,;:)]+$/, ''));
    if (!p || p.split('/').includes('..') || NOT_A_LANE.test(p)) continue;
    try { if (fs.existsSync(path.join(root, p))) out.add(p); } catch { /* not a path */ }
  }
  return [...out];
}

/** A task's own hand-off note (studio/handoffs/<ID>.md), or ''. */
const handoffText = (root, id) => { try { return fs.readFileSync(path.join(root, 'studio', 'handoffs', `${id}.md`), 'utf8').slice(0, 20000); } catch { return ''; } };

/** Drop entries another entry already holds (a/b under a). */
const collapse = (list) => {
  const l = [...new Set(list.map(norm).filter(Boolean))].sort((a, b) => a.length - b.length || a.localeCompare(b));
  return l.filter((p, i) => !l.slice(0, i).some((q) => p === q || p.startsWith(`${q}/`))).sort();
};

/**
 * The lane a task's own words and history give: { lane: 'a,b', from: ['scope', 'paths', 'title', 'history'] } or null.
 * history: plan-waves' overlap history (Map id -> Set of files).
 */
export function inferTaskLane({ id, title = '', meta = {}, root = REPO_ROOT, hist = new Map() } = {}) {
  const from = [];
  const found = [];
  const sc = scopeFolders(meta.scope);
  if (sc.length) { found.push(...sc); from.push('scope'); }
  const text = `${title} ${meta.asked || ''} ${meta.spec || ''} ${handoffText(root, id)}`;
  const named = namedCodePaths(text, root);
  if (named.length) { found.push(...named); from.push('paths'); }
  let guess = '';
  try { guess = inferLaneAtAdd({ title, meta }); } catch { guess = ''; }
  if (guess) { found.push(...laneList(guess)); from.push('title'); }
  const h = [...(hist.get(id) || [])].filter((p) => !NOT_A_LANE.test(p));
  if (h.length) { found.push(...h); from.push('history'); }
  const lane = collapse(found);
  return lane.length ? { lane: lane.join(','), from } : null;
}

// ---- shared sim code ----------------------------------------------------------------------------------------------

/** The repo's files (git ls-files, else a walk), for matching folders and globs against the shared sim globs. */
export function repoFiles(root = REPO_ROOT, cap = 50000) {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0 && r.stdout) return r.stdout.split('\0').filter(Boolean).map(norm).slice(0, cap);
  const out = [];
  const walk = (d) => {
    if (out.length >= cap) return;
    let ents = [];
    try { ents = fs.readdirSync(path.join(root, d), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const rel = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!/^(\.git|node_modules|\.lanes|\.studio|studio)$/.test(e.name)) walk(rel); } else out.push(rel);
      if (out.length >= cap) return;
    }
  };
  walk('');
  return out;
}

/** The shared sim files a footprint touches: [path or glob], sorted. files: the repo's files. */
export function sharedTouches(footprint = [], shared = [], files = []) {
  if (!footprint.length || !shared.length) return [];
  const sharedFiles = files.filter((f) => matchAny(f, shared));
  const out = new Set();
  for (const e0 of footprint) {
    const e = norm(e0);
    if (!e) continue;
    if (!GLOB.test(e) && matchAny(e, shared)) out.add(e);
    for (const f of sharedFiles) if (GLOB.test(e) ? matchAny(f, [e]) : f === e || f.startsWith(`${e}/`)) out.add(f);
  }
  return [...out].sort();
}

/** Does `from` wait on `to` (studio/task-holds.json "after", followed through)? */
function waitsOn(holds, from, to, seen = new Set()) {
  if (seen.has(from)) return false;
  seen.add(from);
  for (const a of holds[from]?.after || []) if (a === to || waitsOn(holds, a, to, seen)) return true;
  return false;
}

/**
 * Phase awareness, pure: rows [{ id, state: 'running'|'ready', touches: [files] }] in order (running first). Each ready
 * row that shares a file with an earlier row waits for the LAST such row (a chain: B after A, C after B), unless it
 * already waits for one of them or that row waits for it. Returns [{ task, after, via }].
 */
export function stackShared(rows = [], holds = {}) {
  const out = [];
  const h = JSON.parse(JSON.stringify(holds || {}));
  for (let i = 0; i < rows.length; i += 1) {
    const t = rows[i];
    if (t.state !== 'ready' || !t.touches?.length) continue;
    const before = rows.slice(0, i).filter((o) => o.touches?.length && o.touches.some((f) => t.touches.includes(f)));
    if (!before.length) continue;
    if (before.some((o) => waitsOn(h, t.id, o.id))) continue;
    const o = before[before.length - 1];
    if (waitsOn(h, o.id, t.id)) continue;
    const via = o.touches.filter((f) => t.touches.includes(f));
    out.push({ task: t.id, after: o.id, via });
    h[t.id] = { ...(h[t.id] || {}), after: [...(h[t.id]?.after || []), o.id] };
  }
  return out;
}

// ---- the pass ------------------------------------------------------------------------------------------------------

async function logLaneDecision({ action, subject, by, why, evidence, undo }) {
  try {
    const dm = await import('./decisions-log.mjs');
    dm.logDecision({ action, subject, by, as: 'agent', why, evidence, undo });
  } catch { /* the hold file and the event say it */ }
}

/**
 * One look at the open builder tasks (the Line Producer's gatherFacts rows: { id, title, role, meta, state }), in order.
 * act: write the lanes and the --after holds (the Line Producer's mode on, not a dry pass). Returns
 * { mode, set: [{ task, lane, from, dry? }], unscoped: [{ task, why, fix }], stacked: [{ task, after, via, dry? }],
 *   running: [{ task, why }] (running builders that hold the whole game), shared: { from, n }, changed }.
 */
export async function lanePass({ tasks = [], order = null, holds = {}, events = [], root = REPO_ROOT, env = process.env, act = false, by = 'line-producer', files = null } = {}) {
  const mode = lineLanesMode(env);
  const writing = act && mode === 'on';
  const hist = overlapHistory(events);
  const predict = predictor(events);
  const set = [];
  const unscoped = [];
  const running = [];
  const laneNow = new Map();
  const builders = tasks.filter((t) => t.role === 'builder' && (t.state === 'ready' || t.state === 'running' || t.state === 'blocked'));
  for (const t of builders) {
    const h = holds[t.id] || {};
    const meta = t.meta || {};
    const onPurpose = meta.wholeGame || ('lane' in h && !h.lane);
    let lane = null;
    try { lane = laneOf(t.id, events, holds); } catch { lane = null; }
    laneNow.set(t.id, lane);
    if (lane || onPurpose) continue;
    if (t.state === 'running') { running.push({ task: t.id, why: `${t.id} runs with no lane: its builder holds the whole game until it ends`, fix: `npm run task -- lane ${t.id} <folders> --by <you> (a person, the orchestrator or the Producer)` }); continue; }
    if (t.state !== 'ready' || mode === 'off') {
      if (t.state === 'ready') unscoped.push({ task: t.id, why: `${t.id} has no lane (STUDIO_LINE_LANES=off): a builder on it holds the whole game`, fix: `npm run task -- lane ${t.id} <folders> --by <you>` });
      continue;
    }
    const inf = inferTaskLane({ id: t.id, title: t.title, meta, root, hist });
    if (!inf) {
      unscoped.push({ task: t.id, why: `${t.id} names no folder, file or --scope and has no overlap history: unscoped, a builder on it holds the whole game`, fix: `npm run task -- lane ${t.id} <folders> --by <you> (or --lane all on purpose)` });
      continue;
    }
    laneNow.set(t.id, inf.lane);
    const row = { task: t.id, lane: inf.lane, from: inf.from };
    if (writing) {
      try {
        setHold(t.id, { lane: inf.lane });
        emitEvent({ type: 'task.lane', agent: by, task: t.id, to: 'producer', msg: `${by} (for the Producer): ${t.id} works in ${inf.lane} (worked out from its ${inf.from.join(', ')})`.slice(0, 500), meta: { lane: inf.lane, inferred: true, from: inf.from } });
        await logLaneDecision({ action: 'task-lane', subject: t.id, by, why: `the Producer's lane for ${t.id}, set by the Line Producer's pass: ${inf.lane}`, evidence: `worked out from its ${inf.from.join(', ')} (harness/lane-plan.mjs inferTaskLane)`, undo: { kind: 'text', text: `npm run task -- lane ${t.id} <the right folders> --by <you> (or "all": the whole game)` } });
      } catch (e) { row.error = e.message; }
    } else row.dry = true;
    set.push(row);
  }
  // Phase awareness: shared sim code is stacked.
  const sh = sharedSimGlobs({ env, root });
  let stacked = [];
  if (sh.globs.length) {
    const list = files || repoFiles(root);
    const idx = new Map((order || []).map((id, i) => [id, i]));
    const pos = new Map(tasks.map((t, i) => [t.id, i]));
    const rows = builders.filter((t) => t.state === 'running' || t.state === 'ready')
      .map((t) => {
        const lane = laneNow.get(t.id);
        const fp = [...(lane ? laneList(lane) : []), ...predict(t.id)];
        return { id: t.id, state: t.state, touches: sharedTouches(fp, sh.globs, list) };
      })
      .sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || (idx.has(a.id) ? idx.get(a.id) : 1e6 + pos.get(a.id)) - (idx.has(b.id) ? idx.get(b.id) : 1e6 + pos.get(b.id)));
    stacked = stackShared(rows, holds);
    for (const s of stacked) {
      if (!writing) { s.dry = true; continue; }
      try {
        setHold(s.task, { after: [...new Set([...(holds[s.task]?.after || []), s.after])] }, { by, msg: `${by} (for the Producer): ${s.task} waits for ${s.after}: both touch shared sim code (${s.via.slice(0, 3).join(', ')}), so they run one after the other`, meta: { after: s.after, via: s.via, stack: 'shared-sim' } });
        await logLaneDecision({ action: 'task-stack', subject: s.task, by, why: `the Producer's stack: ${s.task} after ${s.after}, both touch shared sim code`, evidence: `${s.via.join(', ')} (shared sim code: ${sh.from})`, undo: { kind: 'text', text: `npm run task -- holds; edit the "after" of ${s.task} out with the Producer's call` } });
      } catch (e) { s.error = e.message; }
    }
  }
  return { mode, set, unscoped, running, stacked, shared: { from: sh.from, n: sh.globs.length }, changed: writing && (set.some((s) => !s.error) || stacked.some((s) => !s.error)) };
}
