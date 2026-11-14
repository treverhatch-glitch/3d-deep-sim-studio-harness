#!/usr/bin/env node
/**
 * harness/engine-tracks.mjs — one table for every engine target (Unity, Godot, Unreal, or any engine a studio names), so
 * its lane, land gate, merge train and rig cost come from data, not Unity-only code paths.
 *
 * An engine pass has its own record (this file), is judged in the engine's repo (harness/done-check.mjs
 * engineWorkChecks), has its train started by the Line Producer in a quiet window (harness/line-producer.mjs
 * enginePass), and gets an engine worktree per launched pass (engineLaunch below, used by harness/agent.mjs). The track
 * lives in .studio/engine/tasks.json, not only in the task.added event (which can scroll out of the last 20000 events).
 *
 * The table: ENGINE_TARGETS (defaults), merged with studio/game.json "engines": { "<name>": { ... } } (protected: the
 * owner's). A studio can name any engine there; an unknown name gets the generic defaults.
 *   heavyKind   the machine:heavy job kind its land run takes (unity: the "unity" kind and its cap; else "heavy")
 *   rig         { ramGb, cpuThreads, minutes }: the expected cost of ONE land run (minutes: until durations exist)
 *   floor       { env, gb }: the free-RAM floor a land run waits for (env wins; then the lane's tuned ram-floor)
 *   tune        the settings the engine lane may change itself (harness/engine-tune.mjs); engines.<x>.tune.allow narrows
 *   files       queue/lock/last files of its train and gate (unity-queue.json, …)
 *
 *   node harness/engine-tracks.mjs [list] [--json]       every engine target, its land command, queue and cost
 *   node harness/engine-tracks.mjs task <T-ID> [--json]   the engine record of one task
 *   node harness/engine-tracks.mjs backfill [--dry-run] [--by <name>]   open engine-porter tasks get their track
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, readRecentEvents, emitEvent } from './event.mjs';
import { mainRoot } from './worktree.mjs';
import { learnedNeed } from './engine-ram.mjs';
import { readJson, writeAtomic } from './fsafe.mjs';
import { splitPhantom, phantomNote } from './eol-only.mjs';
import { addEngineWorktree, sparsePathsFor, sparseState, sparseLine, outsideSparse, widenHint, widenEngineWorktree, reapplySparse } from './engine-worktree.mjs';

// 2.86: fsafe's writeAtomic retries a rename Windows refuses for a moment (EPERM/EBUSY); a bare rename killed a session's launch (setEngineTask).
const writeJson = (f, v) => { writeAtomic(f, `${JSON.stringify(v, null, 2)}\n`); };
const num = (v, d) => { const s = String(v ?? '').trim(); const n = Number(s); return s !== '' && Number.isFinite(n) ? n : d; };
const off = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());

/** The settings every engine lane may tune itself. Each: { what, check(value) -> { ok, value, why } }. */
export const TUNE_KEYS = {
  'quality-level': { what: 'the quality level its editor runs and builds use (a name or an index)', check: (v) => (/^[A-Za-z0-9 _.-]{1,40}$/.test(String(v)) ? { ok: true, value: /^\d+$/.test(String(v)) ? Number(v) : String(v) } : { ok: false, why: 'a quality level is a name or an index (letters, digits, space, _ . -)' }) },
  volume: { what: 'the render volume profile it uses (a name)', check: (v) => (/^[A-Za-z0-9 _./-]{1,80}$/.test(String(v)) ? { ok: true, value: String(v) } : { ok: false, why: 'a volume is a profile name (letters, digits, space, _ . / -)' }) },
  'lod-bias': { what: 'the LOD bias (0.1 to 8)', check: (v) => (Number(v) >= 0.1 && Number(v) <= 8 ? { ok: true, value: Number(v) } : { ok: false, why: 'the LOD bias is a number from 0.1 to 8' }) },
  'batch-flags': { what: 'extra editor batch flags for its land runs ({flags} in the land command, STUDIO_ENGINE_FLAGS)', check: (v) => { const list = (Array.isArray(v) ? v : String(v).split(/\s+/)).map(String).filter(Boolean); return list.length <= 12 && list.every((f) => /^-{1,2}[A-Za-z][A-Za-z0-9_-]*(=[A-Za-z0-9_.:,/-]+)?$/.test(f)) ? { ok: true, value: list } : { ok: false, why: 'batch flags are up to 12 plain -flag or -flag=value words (no spaces, quotes or shell characters)' }; } },
  'ram-floor': { what: 'the free RAM (GB) its land run waits for (0 to 64; the owner\'s environment setting wins)', check: (v) => (Number(v) >= 0 && Number(v) <= 64 ? { ok: true, value: Number(v) } : { ok: false, why: 'the RAM floor is a number of GB from 0 to 64' }) },
};

const BASE = { heavyKind: 'heavy', role: 'engine-porter', rig: { ramGb: 4, cpuThreads: 2, minutes: 15 }, floor: { env: null, gb: 0 }, tune: Object.keys(TUNE_KEYS) };
/** Defaults per engine; studio/game.json engines.<name> overrides any of them. */
export const ENGINE_TARGETS = {
  unity: { label: 'Unity', heavyKind: 'unity', rig: { ramGb: 8, cpuThreads: 4, minutes: 30 }, floor: { env: 'STUDIO_UNITY_MIN_FREE_GB', gb: 12 } },
  godot: { label: 'Godot', heavyKind: 'heavy', rig: { ramGb: 3, cpuThreads: 2, minutes: 10 }, floor: { env: 'STUDIO_GODOT_MIN_FREE_GB', gb: 0 } },
  unreal: { label: 'Unreal', heavyKind: 'heavy', rig: { ramGb: 12, cpuThreads: 6, minutes: 45 }, floor: { env: 'STUDIO_UNREAL_MIN_FREE_GB', gb: 16 } },
};
export const ENGINE_NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;

/** "engine:unity" -> "unity"; anything else -> null. */
export const engineOfTrack = (track) => { const m = String(track || '').match(/^engine:([a-z][a-z0-9-]{1,30})$/); return m ? m[1] : null; };

/** studio/game.json "engines" (the owner's), or {}. */
export function enginesConfig(root = REPO_ROOT) {
  const e = readJson(path.join(root, 'studio', 'game.json'))?.engines;
  return e && typeof e === 'object' ? e : {};
}

/** The files of an engine's train and gate. */
export function engineFiles(engine) {
  return { queue: `${engine}-queue.json`, last: `${engine}-last.json`, lock: `${engine}-train.lock`, gateLast: `${engine}-last.json`, gateLog: `${engine}.log`, refPrefix: `${engine}-train/` };
}

/** One engine target: the table's defaults, then studio/game.json engines.<name>. { name, label, heavyKind, rig, floor, tune, land, cfg, files }. */
export function engineTarget(name, { root = REPO_ROOT } = {}) {
  if (!ENGINE_NAME_RE.test(String(name || ''))) return null;
  const d = { ...BASE, ...(ENGINE_TARGETS[name] || {}) };
  const cfg = enginesConfig(root)[name] || {};
  const rig = { ...d.rig, ...(cfg.rig && typeof cfg.rig === 'object' ? Object.fromEntries(Object.entries(cfg.rig).filter(([, v]) => Number(v) >= 0)) : {}) };
  const allow = Array.isArray(cfg.tune?.allow) ? cfg.tune.allow.filter((k) => TUNE_KEYS[k]) : d.tune;
  return {
    name,
    label: cfg.label || d.label || `${name[0].toUpperCase()}${name.slice(1)}`,
    heavyKind: typeof cfg.heavyKind === 'string' && cfg.heavyKind ? cfg.heavyKind : d.heavyKind,
    role: cfg.role || d.role,
    rig,
    floor: { env: d.floor?.env || `STUDIO_${name.toUpperCase().replace(/-/g, '_')}_MIN_FREE_GB`, gb: Number.isFinite(Number(cfg.minFreeGb)) ? Number(cfg.minFreeGb) : d.floor?.gb ?? 0 },
    tune: allow,
    land: typeof cfg.land === 'string' && cfg.land.trim() ? cfg.land : null,
    trainAuto: cfg.trainAuto !== false,
    cfg,
    files: engineFiles(name),
  };
}

/** Every engine the studio names (studio/game.json engines.*) or that a task is on: [target]. */
export function engineTargets({ root = REPO_ROOT } = {}) {
  const names = new Set(Object.keys(enginesConfig(root)).filter((n) => ENGINE_NAME_RE.test(n)));
  for (const r of Object.values(readEngineTasks(root))) if (r?.engine) names.add(r.engine);
  return [...names].sort().map((n) => engineTarget(n, { root })).filter(Boolean);
}

// ---- engine task records ------------------------------------------------------------------------------------

const tasksFile = (root) => path.join(root, '.studio', 'engine', 'tasks.json');
export function readEngineTasks(root = mainRoot()) { const j = readJson(tasksFile(root), {}); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; }

/**
 * The engines this studio configures: the names in studio/game.json "engines" (the owner's) and the engine of each
 * engine/<game>/engine.json track. Sorted.
 */
export function configuredEngines({ root = REPO_ROOT } = {}) {
  const names = new Set(Object.keys(enginesConfig(root)).filter((n) => ENGINE_NAME_RE.test(n)));
  try { for (const g of fs.readdirSync(path.join(root, 'engine'))) { const e = readJson(path.join(root, 'engine', g, 'engine.json'))?.engine; if (ENGINE_NAME_RE.test(String(e || ''))) names.add(e); } } catch {}
  return [...names].sort();
}

/**
 * Read a track value. "engine:<name>" is that engine (configured: whether the studio names it); a bare name the studio
 * configures ("unity") reads as "engine:<name>" (normalized: true); anything else is unknown.
 * { track, engine, configured, normalized } | { track: null, engine: null, unknown: <value>, why } | { track: null } (empty).
 * STUDIO_ENGINE_TRACK_NORMALIZE=off: a bare name is unknown.
 */
export function readTrack(value, { root = REPO_ROOT, env = process.env } = {}) {
  const v = String(value ?? '').trim();
  if (!v) return { track: null, engine: null };
  const known = configuredEngines({ root });
  const e = engineOfTrack(v);
  if (e) return { track: v, engine: e, configured: known.includes(e), normalized: false };
  const bare = v.toLowerCase();
  if (!off(env.STUDIO_ENGINE_TRACK_NORMALIZE) && ENGINE_NAME_RE.test(bare) && known.includes(bare)) return { track: `engine:${bare}`, engine: bare, configured: true, normalized: true, from: v };
  return { track: null, engine: null, unknown: v, why: `"${v}" is not a track: an engine pass's track is engine:<name>, and ${known.length ? `this studio configures ${known.map((n) => `engine:${n}`).join(', ')}` : 'this studio configures no engine (studio/game.json "engines")'}` };
}

/** A track written without "engine:" was read as the engine: the record is fixed once, and said so. */
function normalizeOnce(taskId, t, { root, from }) {
  let rec = null;
  try { rec = setEngineTask(taskId, { engine: t.engine, track: t.track, normalized: { from: t.from, at: new Date().toISOString() } }, { root }); } catch { return null; }
  try { emitEvent({ type: 'engine.track_normalized', agent: 'launcher', task: taskId, to: 'producer', msg: `${taskId}'s track "${t.from}" (${from}) is read as ${t.track}: the engine it names (npm run task -- track ${taskId} engine:<name> --by <you> changes it)`.slice(0, 400), meta: { from: t.from, track: t.track, source: from } }); } catch {}
  return rec;
}

/**
 * The engine record of a task: { task, engine, track, branch, scope, visual: { required, refs }, by, at } or null. The
 * record (.studio/engine/tasks.json, written by task add --track engine:<x>) wins; an older task falls back to its
 * task.added event (and its task.unity_branch record). A bare engine name ("unity") reads as engine:<name> (readTrack).
 */
export function engineTask(taskId, { root = mainRoot(), events = null, env = process.env } = {}) {
  if (!taskId) return null;
  const rec = readEngineTasks(root)[taskId];
  // `task track <ID> web` writes { track: 'web', engine: null }: a web task again, whatever its task.added event said.
  if (rec?.track === 'web' && !rec.engine) return null;
  if (rec?.engine && engineOfTrack(rec.track) === rec.engine) return { task: taskId, ...rec };
  if (rec?.engine || rec?.track) {
    const t = readTrack(rec.track || rec.engine, { root, env });
    if (t.normalized && (!rec.engine || rec.engine === t.engine)) { const n = normalizeOnce(taskId, t, { root, from: '.studio/engine/tasks.json' }); if (n) return n; }
    if (rec.engine) return { task: taskId, ...rec };
    if (t.engine) return { task: taskId, ...rec, engine: t.engine, track: t.track };
  }
  const evs = events || readRecentEvents(20000);
  const added = evs.filter((e) => e.type === 'task.added' && e.task === taskId).pop();
  let track = added?.meta?.track;
  let engine = engineOfTrack(track);
  if (!engine && track) {
    const t = readTrack(track, { root, env });
    if (t.normalized) {
      const branch0 = evs.filter((e) => e.type === 'task.unity_branch' && e.task === taskId).pop()?.meta?.branch || added.meta.branch || null;
      try { setEngineTask(taskId, { branch: branch0, scope: added.meta.scope || null, visual: added.meta.visualCheck ? { required: true, refs: added.meta.refs || [] } : null }, { root }); } catch {}
      const n = normalizeOnce(taskId, t, { root, from: 'its task.added event' });
      if (n) return n;
      engine = t.engine; track = t.track;
    }
  }
  if (!engine) return null;
  // A record that holds only a branch (written at launch; the track is in the task.added event) is still the branch.
  const branch = evs.filter((e) => e.type === 'task.unity_branch' && e.task === taskId).pop()?.meta?.branch || (typeof rec?.branch === 'string' && rec.branch ? rec.branch : null) || added.meta.branch || null;
  return { task: taskId, engine, track, branch, scope: added.meta.scope || null, visual: added.meta.visualCheck ? { required: true, refs: added.meta.refs || [] } : null, from: 'event' };
}

/**
 * The raw track a task was given (record, else its task.added event), for saying why it isn't an engine task. '' when none.
 */
export function rawTrack(taskId, { root = mainRoot(), events = null } = {}) {
  const rec = readEngineTasks(root)[taskId];
  if (rec?.track || rec?.engine) return String(rec.track || rec.engine);
  const evs = events || readRecentEvents(20000);
  return String(evs.filter((e) => e.type === 'task.added' && e.task === taskId).pop()?.meta?.track || '');
}

/**
 * Which engine train `task done --train` queues this task on, or why none. The one place the decision is made (task.mjs asks it). { engine } | { engine: null, engineTask: true, why, fix } (an engine pass that
 * can't be queued: done says so and queues nothing) | { engine: null, engineTask: false, note? } (a studio lane).
 */
export function engineTrainVerdict(taskId, { role = null, root = mainRoot(), env = process.env, events = null } = {}) {
  const fixTrack = `npm run task -- track ${taskId} engine:<name> --by <you> (a person, the orchestrator or a Producer)`;
  let rec = null;
  try { rec = engineTask(taskId, { root, env, events }); } catch { rec = null; }
  const raw = rec ? '' : rawTrack(taskId, { root, events });
  // A track that names no engine: other tracks ("asset", "web") are not engine passes, but an engine-porter's is one.
  if (!rec && raw && isEngineRole(role, { root })) {
    const t = readTrack(raw, { root, env });
    return { engine: null, engineTask: true, why: `it is an engine-porter task and ${t.why || `its track "${raw}" is not one this studio can train`}`, fix: fixTrack };
  }
  if (!rec && raw) return { engine: null, engineTask: false };
  if (!rec && isEngineRole(role, { root })) {
    const inf = inferEngineTrack(taskId, { root, env, by: 'task-done' });
    if (inf.error) return { engine: null, engineTask: true, why: `it is an engine-porter task with no engine track, and the studio names several engines`, fix: fixTrack };
    rec = inf.rec || null;
    if (!rec) return { engine: null, engineTask: false, note: `${taskId} is an engine-porter task with no engine track (${inf.why}): it trains as a studio lane` };
  }
  const e = rec ? engineOfTrack(rec.track) || rec.engine : null;
  if (!e) return { engine: null, engineTask: false };
  if (String(env.STUDIO_DONE_UNITY_GATE || '') === 'skip') return { engine: null, engineTask: true, why: `STUDIO_DONE_UNITY_GATE=skip turns the engine land gate and its train off`, fix: 'unset STUDIO_DONE_UNITY_GATE, then run task done --train again' };
  const t = engineTarget(e, { root });
  if (e === 'unity' || t?.land) return { engine: e };
  const outside = (() => { try { return Boolean(engineRepo(e, { root })); } catch { return false; } })();
  const why = `its engine ${e} has no land command (studio/game.json "engines": { "${e}": { "land": "<command>" } }), so there is no ${t?.label || e} train`;
  if (!outside) return { engine: null, engineTask: false, note: `${taskId} is on engine:${e}, but ${why.slice(4)}; its work is in the studio, so it trains as a studio lane` };
  return { engine: null, engineTask: true, why, fix: `the owner sets engines.${e}.land in studio/game.json (protected)` };
}

/**
 * On upgrade, open engine-porter tasks with no engine track get one when the studio configures exactly one engine
 * (inferred: { from: 'upgrade backfill' } plus an engine.track_backfilled event); with several they are listed for a
 * person (npm run task -- track <ID> engine:<name>), as is a track that names no engine. Bare names are normalized.
 * `open`: [{ id, role }] (default: the board's open tasks). Returns { changed: [{ task, track, how }], ambiguous: [task],
 * unknown: [{ task, track }], engines, lines }. dryRun: nothing written.
 */
export async function backfillEngineTracks({ root = mainRoot(), by = 'upgrade', dryRun = false, env = process.env, open = null } = {}) {
  let tasks = open;
  if (!tasks) {
    const { parseNextQueue } = await import('./task.mjs');
    const q = parseNextQueue();
    tasks = [...q.inProgress, ...q.backlog].map((t) => ({ id: t.id, role: t.role }));
  }
  const names = configuredEngines({ root });
  const events = readRecentEvents(20000);
  const changed = [];
  const ambiguous = [];
  const unknown = [];
  for (const t of tasks) {
    const raw = rawTrack(t.id, { root, events });
    const tr = raw ? readTrack(raw, { root, env }) : null;
    if (tr?.normalized) {
      if (!dryRun) engineTask(t.id, { root, events, env });
      changed.push({ task: t.id, track: tr.track, how: `"${raw}" read as ${tr.track}` });
      continue;
    }
    if (!isEngineRole(t.role, { root })) continue;
    if (raw) { if (!engineOfTrack(raw)) unknown.push({ task: t.id, track: raw }); continue; }
    if (names.length === 1) {
      const track = `engine:${names[0]}`;
      if (!dryRun) {
        setEngineTask(t.id, { engine: names[0], track, inferred: { from: 'upgrade backfill (the only engine in studio/game.json)', by } }, { root });
        try { emitEvent({ type: 'engine.track_backfilled', agent: by, task: t.id, to: 'producer', msg: `${t.id} (engine-porter, no engine track) set to ${track}, the studio's only engine (npm run task -- track ${t.id} engine:<name> --by <you> changes it)`.slice(0, 400), meta: { track } }); } catch {}
      }
      changed.push({ task: t.id, track, how: 'no track: the only engine' });
    } else if (names.length > 1) ambiguous.push(t.id);
  }
  const verb = dryRun ? 'would set' : 'set';
  const lines = [
    ...changed.map((c) => `[upgrade] engine track ${verb}: ${c.task} -> ${c.track} (${c.how})`),
    ...unknown.map((u) => `[upgrade] ${u.task} is an engine-porter task whose track "${u.track}" names no engine this studio configures (${names.join(', ') || 'none'}): a person sets it: npm run task -- track ${u.task} engine:<name> --by <you>`),
    ...(ambiguous.length ? [`[upgrade] ${ambiguous.length} open engine-porter task(s) have no engine track and this studio configures ${names.length} engines (${names.join(', ')}): a person says which: ${ambiguous.map((x) => `npm run task -- track ${x} engine:<${names.join('|')}> --by <you>`).join('; ')}`] : []),
  ];
  return { changed, ambiguous, unknown, engines: names, lines };
}

/** Write (merge) a task's engine record. Returns the record. */
export function setEngineTask(taskId, patch, { root = mainRoot() } = {}) {
  const all = readEngineTasks(root);
  const cur = all[taskId] || {};
  const next = { ...cur, ...patch, task: undefined, at: cur.at || new Date().toISOString(), updatedAt: new Date().toISOString() };
  delete next.task;
  if (patch.engine && !patch.track) next.track = `engine:${patch.engine}`;
  all[taskId] = next;
  writeJson(tasksFile(root), all);
  return { task: taskId, ...next };
}

/** Is this a launch role that works on an engine pass (engine-porter, or an engine's own "role")? */
export function isEngineRole(role, { root = REPO_ROOT } = {}) {
  const r = String(role || '').trim().toLowerCase();
  if (!r) return false;
  if (r === BASE.role) return true;
  return Object.values(enginesConfig(root)).some((c) => c && typeof c.role === 'string' && c.role.toLowerCase() === r);
}

/** The engines this studio configures (studio/game.json "engines"), sorted. */
export const engineNames = (root = REPO_ROOT) => Object.keys(enginesConfig(root)).filter((n) => ENGINE_NAME_RE.test(n)).sort();

/**
 * For task add --role engine-porter with no --track: { track: "engine:<name>" } when the studio configures exactly one
 * engine, else { error } listing the engines or saying there is none. STUDIO_ENGINE_TRACK_INFER=off: { track: null }.
 */
export function defaultEngineTrack(root = REPO_ROOT, env = process.env) {
  if (off(env.STUDIO_ENGINE_TRACK_INFER)) return { track: null }; // the same switch as inferEngineTrack
  const names = engineNames(root);
  if (names.length === 1) return { track: `engine:${names[0]}` };
  if (!names.length) return { error: 'an engine-porter task needs an engine track, and studio/game.json "engines" names no engine' };
  return { error: `an engine-porter task needs an engine track, and this studio names ${names.length} engines: add --track ${names.map((n) => `engine:${n}`).join(' | ')}` };
}

/**
 * The track of an engine-porter task that has no engine record. With exactly one engine in studio/game.json "engines",
 * that engine: the record is written (.studio/engine/tasks.json, inferred: true) with an engine.track_inferred event.
 * With several: { error } naming them and how to set it (npm run task -- track <ID> engine:<name>). With none:
 * { rec: null } (the work lives in the studio). STUDIO_ENGINE_TRACK_INFER=off: { rec: null } always.
 */
export function inferEngineTrack(taskId, { root = mainRoot(), env = process.env, dryRun = false, by = null } = {}) {
  if (off(env.STUDIO_ENGINE_TRACK_INFER)) return { rec: null, why: 'STUDIO_ENGINE_TRACK_INFER=off' };
  const names = Object.keys(enginesConfig(root)).filter((n) => ENGINE_NAME_RE.test(n)).sort();
  if (!names.length) return { rec: null, why: 'no engine in studio/game.json "engines"' };
  if (names.length > 1) return { error: `${taskId} is an engine-porter task with no engine track, and this studio names ${names.length} engines (${names.join(', ')}): say which, then launch again: npm run task -- track ${taskId} engine:<${names.join('|')}> --by <you> (a person, the orchestrator or a Producer)` };
  const engine = names[0];
  if (dryRun) return { rec: { task: taskId, engine, track: `engine:${engine}`, inferred: true, dry: true } };
  const rec = setEngineTask(taskId, { engine, track: `engine:${engine}`, inferred: { from: 'studio/game.json engines (the only one)', by: by || null } }, { root });
  try { emitEvent({ type: 'engine.track_inferred', agent: by || 'launcher', task: taskId, to: 'producer', msg: `${taskId} had no engine track: set to engine:${engine}, the only engine in studio/game.json (npm run task -- track ${taskId} engine:<name> --by <you> changes it)`.slice(0, 400), meta: { engine } }); } catch {}
  return { rec };
}

// ---- the engine repo ------------------------------------------------------------------------------------------------

const isRepo = (dir) => Boolean(dir) && fs.existsSync(dir) && spawnSync('git', ['rev-parse', '--git-dir'], { cwd: dir, encoding: 'utf8', windowsHide: true }).status === 0;
const gitTop = (dir) => { const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', windowsHide: true }); return r.status === 0 ? path.resolve(r.stdout.trim()) : null; };
const gitCommon = (dir) => { const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, encoding: 'utf8', windowsHide: true }); return r.status === 0 ? path.resolve(r.stdout.trim()) : null; };

/**
 * The engine's own repo, when it is not the studio's: engines.<x>.gateWorktree, folder or cwd (relative to the studio),
 * else the track's folder (engine/<game>/engine.json) for that engine. null when the engine's work lives in the studio.
 */
export function engineRepo(engine, { root = REPO_ROOT } = {}) {
  const t = engineTarget(engine, { root });
  if (!t) return null;
  const studioCommon = gitCommon(root);
  const cands = [t.cfg.gateWorktree, t.cfg.folder, t.cfg.cwd];
  try {
    const tracks = fs.readdirSync(path.join(root, 'engine')).map((g) => readJson(path.join(root, 'engine', g, 'engine.json'))).filter((x) => x?.engine === engine && x.folder);
    for (const x of tracks) cands.push(x.folder);
  } catch {}
  for (const c of cands) {
    if (typeof c !== 'string' || !c.trim()) continue;
    const abs = path.resolve(root, c);
    if (!isRepo(abs)) continue;
    if (studioCommon && gitCommon(abs) === studioCommon) return null;
    return gitTop(abs) || abs;
  }
  return null;
}

// ---- recorded durations --------------------------------------------------------------------------------------

const durFile = (root) => path.join(root, '.studio', 'engine', 'durations.json');
/** Keep one land run's length: .studio/engine/durations.json { <engine>: [{ kind, ms, status, at }] } (the last 20). */
export function recordDuration(engine, { kind = 'land', ms, status, root = mainRoot() } = {}) {
  if (!ENGINE_NAME_RE.test(String(engine || '')) || !(Number(ms) > 0)) return null;
  try {
    const all = readJson(durFile(root), {}) || {};
    const list = Array.isArray(all[engine]) ? all[engine] : [];
    list.push({ kind, ms: Math.round(Number(ms)), status: status || null, at: new Date().toISOString() });
    all[engine] = list.slice(-20);
    writeJson(durFile(root), all);
    return all[engine];
  } catch { return null; }
}
/**
 * The expected minutes of one land run: the median of the recorded runs that ran to the end (pass, red, conflict; a
 * refusal or not-run is not a length), else the table's rig.minutes. { minutes, from, n }.
 */
export function expectedMinutes(engine, { root = mainRoot(), kind = 'land' } = {}) {
  const t = engineTarget(engine, { root: REPO_ROOT }) || engineTarget(engine, { root });
  const list = ((readJson(durFile(root), {}) || {})[engine] || []).filter((d) => d.kind === kind && ['pass', 'red', 'conflict'].includes(d.status) && d.ms > 0).slice(-12);
  if (!list.length) return { minutes: t?.rig?.minutes ?? null, from: 'the engine table (no land run recorded yet)', n: 0 };
  const s = list.map((d) => d.ms).sort((a, b) => a - b);
  return { minutes: Math.max(0.1, Math.round(s[Math.floor(s.length / 2)] / 6000) / 10), from: `the median of the last ${list.length} land run(s)`, n: list.length };
}

// ---- the RAM floor and the tuned settings ---------------------------------------------------------------------------

const tuneFile = (root, engine) => path.join(root, 'studio', 'engine', `${engine}-tune.json`);
/** The engine lane's tuned settings (studio/engine/<engine>-tune.json): { values: { key: value }, log: [] }. */
export function readTune(engine, root = mainRoot()) { const j = readJson(tuneFile(root, engine), null); return j && typeof j === 'object' ? { values: j.values && typeof j.values === 'object' ? j.values : {}, log: Array.isArray(j.log) ? j.log : [] } : { values: {}, log: [] }; }
export const tunePath = tuneFile;

/** The free-RAM floor of an engine's land run: { gb, from }. The owner's environment wins, then the lane's tuned ram-floor, then the table. */
export function engineFloor(engine, { env = process.env, root = mainRoot() } = {}) {
  const t = engineTarget(engine, { root: REPO_ROOT }) || engineTarget(engine, { root });
  if (!t) return { gb: 0, from: 'no such engine' };
  const raw = t.floor.env ? env[t.floor.env] : undefined;
  if (raw !== undefined && String(raw).trim() !== '') return off(raw) ? { gb: 0, from: `${t.floor.env}=${raw} (the owner's setting)` } : { gb: num(raw, t.floor.gb), from: `${t.floor.env} (the owner's setting)` };
  const tuned = readTune(engine, root).values['ram-floor'];
  if (Number.isFinite(Number(tuned)) && t.tune.includes('ram-floor')) return { gb: Number(tuned), from: `the ${t.label} lane's tuned ram-floor (studio/engine/${engine}-tune.json)` };
  // The RAM the last green land runs really took (engine-ram.mjs), plus a margin, once there are enough of them.
  try { const l = learnedNeed(engine, { root, env }); if (l) return { gb: l.gb, from: l.from }; } catch { /* the table's */ }
  return { gb: t.floor.gb, from: `the engine table (${t.label}: ${t.floor.gb} GB)` };
}

// ---- launching an engine pass --------------------------------------------------------------------------------

const safeName = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s) && !s.includes('..') && !s.endsWith('.lock') && !s.endsWith('/');

/**
 * One path in one spelling for comparing (Windows trap): git prints a worktree as its real path (long names, forward
 * slashes) while the studio's paths may be short names (C:\Users\RUNNER~1\...) or another case; path.resolve() equates
 * neither. The native real path does; on Windows case doesn't count.
 */
const canonPath = (p) => {
  let r;
  try { r = fs.realpathSync.native(p); } catch { r = path.resolve(p); }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
export const samePath = (a, b) => Boolean(a) && Boolean(b) && canonPath(a) === canonPath(b);
/**
 * A path git printed, in the studio's own spelling: under the nearest folder of `anchors` (and their parents) that holds
 * it, so it compares and prints the way the studio's paths do (the engine repo's folder, the studio). Unchanged when none does.
 */
export function ownSpelling(p, anchors = []) {
  if (!p) return p;
  let real;
  try { real = fs.realpathSync.native(p); } catch { return p; }
  const fold = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  for (const anchor of anchors.filter(Boolean)) {
    for (let a = path.resolve(anchor); ; a = path.dirname(a)) {
      let ra = null;
      try { ra = fs.realpathSync.native(a); } catch { ra = null; }
      if (ra) {
        if (fold(real) === fold(ra)) return a;
        const pre = ra.endsWith(path.sep) ? ra : `${ra}${path.sep}`;
        if (fold(real).startsWith(fold(pre))) return path.join(a, real.slice(pre.length));
      }
      if (path.dirname(a) === a) break;
    }
  }
  return p;
}

/** The worktree of `repo` that has `branch` checked out (git worktree list), or null. */
export function worktreeOn(repo, branch) {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  let dir = null;
  for (const l of String(r.stdout || '').split(/\r?\n/)) {
    if (l.startsWith('worktree ')) dir = l.slice(9).trim();
    else if (l.trim() === `branch refs/heads/${branch}` && dir) return path.resolve(dir);
  }
  return null;
}

/**
 * A launched pass on an engine whose work lives in its own repo gets its own worktree of that repo on the task's
 * branch (made from the target when the branch doesn't exist yet), at <studio>/.lanes/engine/<task>. Only `git worktree
 * add` runs in the engine repo; its checked-out folders and the land script's gate worktree are never touched.
 * { dir, branch, repo, created, note } | { error } | null (not an engine task, or the engine's work is in the studio).
 */
export function engineLaunch({ task, agent = null, role = null, root = mainRoot(), dryRun = false, env = process.env } = {}) {
  let rec = engineTask(task, { root });
  // An engine-porter task with no engine record (older, or added without --track) has its track worked out
  // (inferEngineTrack) or the launch is refused with how to set it.
  if (!rec && isEngineRole(role, { root })) {
    const inf = inferEngineTrack(task, { root, env, dryRun, by: agent });
    if (inf.error) return { error: inf.error };
    rec = inf.rec || null;
  }
  if (!rec) return null;
  const repo = engineRepo(rec.engine, { root });
  if (!repo) return null;
  const t = engineTarget(rec.engine, { root });
  const target = t.cfg.target;
  const branch = rec.branch || `${rec.engine}/${String(task).toLowerCase()}`;
  if (!safeName(branch)) return { error: `the task's ${t.label} branch "${String(branch).slice(0, 60)}" is not a plain branch name` };
  const dir = path.join(root, '.lanes', 'engine', String(task));
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true });
  const has = g('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).status === 0;
  // 2.86 (f): a sparse worktree says so in the brief, in one line, with the folders it has.
  const note = (created, sp = null) => `Your ${t.label} work is in its own repo: your worktree is ${dir.split(path.sep).join('/')} on branch ${branch}${created ? ` (new, from ${target || 'its HEAD'})` : ''}. Edit and commit there (no editor run needed; the land run does it). Then: npm run task -- done ${task} --agent ${agent || '<you>'} --train${rec.visual?.required ? ` (first the visual check: npm run visual -- status ${task})` : ''}.${sp?.length ? ` ${sparseLine(task, sp)}` : ''}`;
  if (fs.existsSync(path.join(dir, '.git'))) {
    const cur = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8', windowsHide: true }).stdout.trim();
    if (cur === branch) { if (!rec.branch && !dryRun) { try { setEngineTask(task, { engine: rec.engine, ...(rec.track ? { track: rec.track } : {}), branch }, { root }); } catch { /* the record is a help */ } } const ss = sparseState(dir); return { dir, branch, repo, created: false, sparse: ss.sparse ? ss.paths : null, note: note(false, ss.sparse ? ss.paths : null) }; }
    return { error: `${dir} is a worktree on ${cur || 'a detached HEAD'}, not ${branch}: remove it (git -C "${repo}" worktree remove "${dir}") and start again` };
  }
  // A branch checked out in another worktree can't be checked out twice. Clean there: the pass works in that worktree.
  // Uncommitted work there: refused, with what to do.
  if (has) {
    g('worktree', 'prune');
    // Compared by real path in the studio's spelling (see samePath); the configured folders come first because
    // engineRepo's repo is git's own spelling.
    const spelled = [t.cfg.gateWorktree, t.cfg.folder, t.cfg.cwd].filter((c) => typeof c === 'string' && c.trim()).map((c) => path.resolve(root, c));
    const other = ownSpelling(worktreeOn(repo, branch), [...spelled, root, repo]);
    if (other && !samePath(other, dir)) {
      const st = spawnSync('git', ['status', '--porcelain'], { cwd: other, encoding: 'utf8', windowsHide: true });
      const dirty = st.status === 0 ? st.stdout.split('\n').filter((l) => l.trim()) : null;
      const shown = other.split(path.sep).join('/');
      // The land script's own worktree (engines.<x>.gateWorktree) is never an agent's.
      const gw = t.cfg.gateWorktree ? path.resolve(root, t.cfg.gateWorktree) : null;
      if (gw && samePath(other, gw)) return { error: `the task's ${t.label} branch ${branch} is checked out in ${shown}, the land script's own worktree (engines.${rec.engine}.gateWorktree), which no agent edits: switch that folder back to its own branch (git -C "${shown}" switch <its branch>), then start the pass again`, busy: shown };
      if (dirty && !dirty.length) {
        const n = `Your ${t.label} work is in its own repo: your worktree is ${shown} on branch ${branch} (already checked out there and clean, so you work there). Edit and commit there (no editor run needed; the land run does it). Then: npm run task -- done ${task} --agent ${agent || '<you>'} --train${rec.visual?.required ? ` (first the visual check: npm run visual -- status ${task})` : ''}.`;
        return { dir: other, branch, repo, created: false, reused: true, note: n };
      }
      return { error: `the task's ${t.label} branch ${branch} is checked out in ${shown}${dirty ? ` with uncommitted work (${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}${dirty.length > 3 ? ` +${dirty.length - 3}` : ''})` : ' (its state could not be read)'}, and a branch can't be checked out twice: commit or stash that work there (or switch that folder to another branch: git -C "${shown}" switch <other>), then start the pass again`, busy: shown };
    }
  }
  // 2.86 (f): a role listed in engines.<x>.sparse.roles gets a sparse worktree (harness/engine-worktree.mjs), unless the
  // task was widened before (`npm run engine -- lane <ID> --full` records full: true).
  const sparse = rec.full ? null : sparsePathsFor(t.cfg, role);
  if (dryRun) return { dir, branch, repo, created: !has, dry: true, sparse, note: note(!has, sparse) };
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  g('worktree', 'prune');
  const base = target && g('rev-parse', '--verify', '--quiet', `refs/heads/${target}`).status === 0 ? target : 'HEAD';
  const add = addEngineWorktree({ repo, dir, branch, base, create: !has, sparse });
  if (add.error) return { error: `git worktree add in ${repo} failed: ${add.error} (a branch checked out in another folder can't be checked out twice: work there, or move it)` };
  if (add.fallback) { try { emitEvent({ type: 'engine.lane', agent: agent || 'launcher', task, status: 'warn', msg: `${task}: ${add.fallback}`.slice(0, 400) }); } catch { /* a note */ } }
  // The whole record (engine, track, branch), so task done finds the branch without --branch.
  if (!rec.branch) setEngineTask(task, { engine: rec.engine, ...(rec.track ? { track: rec.track } : {}), branch }, { root });
  return { dir, branch, repo, created: !has, sparse: add.sparse, note: note(!has, add.sparse) };
}

/**
 * The engine target merge a session can run itself. At launch the harness merges the engine's target into the task's
 * engine worktree and, on a conflict, aborts. A launched session may not run `git merge` (harness/allowlist.mjs: only
 * add, commit, status, diff, log, show; a session must not merge lanes into the target), so this command merges the
 * TARGET into the task's OWN engine worktree, found from its engine record, and nothing else:
 *   npm run engine -- merge <ID>             merge (no fast-forward, no commit); clean: committed at once with the launch
 *                                            merge's message; a conflict is LEFT in the worktree with each file named
 *   npm run engine -- merge <ID> --continue  refused while a conflicted file still holds <<<<<<< or >>>>>>> lines or git
 *                                            still lists unmerged paths; else git commit --no-edit
 *   npm run engine -- merge <ID> --abort     git merge --abort
 * A caller that works as an agent (STUDIO_AGENT, or STUDIO_LOCK_OWNER as a launched session has) must hold the task's
 * claim; a launched session pinned to another task is refused. A shell with neither is a person's and may run it.
 * So may the owner's stand-ins outside the harness (targetMergeStandIn), for any task; meta.via says how.
 * Events: engine.target_merge with meta.step started | conflict (meta.files) | done | aborted.
 */
export const targetMergeCommand = (task) => `npm run engine -- merge ${task}`;
export const targetMergeMessage = (target, rec, task) => `Merge ${target} into ${rec?.branch || task} (engine pass ${task})`;
const BOTH_SIDES = 'Small conflicts in project files (a project file, an asmdef, a package list) usually want both sides kept.';
const mergeStateFile = (root, task) => path.join(root, '.studio', 'engine', `merge-${String(task).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
const MARKER = /^(<{7}|>{7})(\s|$)/m;

/** The task's own engine worktree (the launch's, else the worktree holding its branch), or { error }. */
export function engineTaskDir(task, { root = mainRoot(), engine = null } = {}) {
  const rec = engineTask(task, { root });
  if (!rec) return { error: `${task} is not an engine task (no engine record): there is no engine worktree to merge into` };
  if (engine && engine !== rec.engine) return { error: `${task} is a ${rec.engine} task, not ${engine}` };
  const repo = engineRepo(rec.engine, { root });
  if (!repo) return { error: `the ${rec.engine} work of ${task} is not in a repo of its own (engines.${rec.engine}.cwd): nothing to merge here` };
  const t = engineTarget(rec.engine, { root });
  const target = t?.cfg?.target;
  if (!target) return { error: `engines.${rec.engine}.target is not set in studio/game.json: there is no target branch to merge` };
  const own = path.join(root, '.lanes', 'engine', String(task));
  const dir = fs.existsSync(path.join(own, '.git')) ? own : (rec.branch ? worktreeOn(repo, rec.branch) : null);
  if (!dir || !fs.existsSync(dir)) return { error: `${task} has no engine worktree yet (it is made when a session is launched on the task): nothing to merge into` };
  // The land script's own worktree is never an agent's, and nothing but the task's branch is merged into.
  const gw = t.cfg.gateWorktree ? path.resolve(root, t.cfg.gateWorktree) : null;
  if (gw && samePath(dir, gw)) return { error: `${dir.split(path.sep).join('/')} is the land script's own worktree (engines.${rec.engine}.gateWorktree): refused` };
  const cur = spawnSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: dir, encoding: 'utf8', windowsHide: true }).stdout.trim();
  if (rec.branch && cur !== rec.branch) return { error: `${dir.split(path.sep).join('/')} is on ${cur || 'a detached HEAD'}, not ${task}'s branch ${rec.branch}: refused` };
  return { rec, repo, dir, target, label: t.label, branch: rec.branch || cur };
}

/**
 * Who may merge for any task without its claim: the owner's stand-in in a shell the harness did not launch (no
 * STUDIO_ROLE, no STUDIO_TASK_PIN): the owner's proxy, a beta-mode named agent or an outside signer (ask.mjs
 * ownerStandIn), or an outside coding agent's shell that the board-decision verdict lets decide (permission.mjs
 * mayDecide 'board'). { name, via } or null. A launched session, worker or planner keeps the claim rule.
 */
export async function targetMergeStandIn({ env = process.env, root = mainRoot() } = {}) {
  const me = String(env.STUDIO_AGENT || env.STUDIO_LOCK_OWNER || '').trim();
  if (!me || String(env.STUDIO_ROLE || '').trim() || String(env.STUDIO_TASK_PIN || '').trim()) return null;
  try {
    const pm = await import('./permission.mjs');
    if (pm.WORKER_NAME.test(me)) return null;
    const actEnv = { ...env, STUDIO_LOCK_OWNER: me };
    const s = (await import('./ask.mjs')).ownerStandIn(actEnv, { kind: 'board' });
    if (s?.agent && s.agent.toLowerCase() === me.toLowerCase()) return { name: me, via: s.via };
    const marker = pm.AGENT_SHELL.find((k) => String(env[k] || '').trim());
    if (marker && pm.mayDecide('board', pm.actorOf({ env: actEnv, root }), { root }).ok) return { name: me, via: 'outside agent' };
  } catch { /* not a stand-in: the claim rule */ }
  return null;
}

/** Why this caller may not merge for `task` ('' when it may). A person's shell (no agent identity) may. */
export async function targetMergeRefusal(task, { env = process.env, root = mainRoot() } = {}) {
  const me = String(env.STUDIO_AGENT || env.STUDIO_LOCK_OWNER || '').trim();
  const pin = String(env.STUDIO_TASK_PIN || '').trim();
  if (pin && pin !== String(task)) return `this session was launched for ${pin}, not ${task}: a session merges only into its own task's worktree`;
  if (!me) return '';
  if (await targetMergeStandIn({ env, root })) return '';
  let holder = null;
  try { const { listLocks } = await import('./lock.mjs'); holder = listLocks().find((l) => l.key === `task:${task}`)?.owner || null; } catch { holder = null; }
  if (holder === me) return '';
  return holder ? `${task} is claimed by ${holder}, not ${me}: only the agent holding a task's claim (or a person, or the overseer) merges into its worktree` : `${me} does not hold ${task}'s claim (npm run task -- start ${task} --agent ${me} first), and only the agent holding it (or a person, or the overseer) merges into its worktree`;
}

/**
 * The command. mode: 'merge' | 'continue' | 'abort'. { ok, code (0 done or nothing to do, 1 refused, 2 conflict left),
 * lines, files?, step }. Never throws.
 */
export async function engineTargetMerge(task, { mode = 'merge', engine = null, root = mainRoot(), env = process.env } = {}) {
  const fail = (line, extra = {}) => ({ ok: false, code: 1, lines: [line], ...extra });
  try {
    if (!task || !/^[A-Za-z]+-\d+$/.test(String(task))) return fail(`Usage: ${targetMergeCommand('<TASK_ID>')} [--engine <x>] [--continue | --abort]`);
    const who = await targetMergeRefusal(task, { env, root });
    if (who) return fail(`Not merged: ${who}.`);
    const standIn = await targetMergeStandIn({ env, root });
    const w = engineTaskDir(task, { root, engine });
    if (w.error) return fail(`Not merged: ${w.error}.`);
    const { dir, target, rec, branch } = w;
    const shown = dir.split(path.sep).join('/');
    const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    const ident = g('config', 'user.name').stdout.trim() ? [] : ['-c', 'user.name=studio-launcher', '-c', 'user.email=studio-launcher@example.invalid'];
    const agent = String(env.STUDIO_AGENT || env.STUDIO_LOCK_OWNER || '').trim() || 'person';
    const ev = (step, msg, meta = {}) => { try { emitEvent({ type: 'engine.target_merge', agent, task, ...(step === 'conflict' ? { to: 'producer', status: 'warn' } : {}), msg: `${task}: ${msg}`.slice(0, 500), meta: { step, dir: shown, target, ...(standIn ? { via: standIn.via } : {}), ...meta } }); } catch { /* the merge stands without its event */ } };
    const merging = () => g('rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0;
    const unmerged = () => g('-c', 'core.quotepath=off', 'diff', '--name-only', '--diff-filter=U').stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const state = mergeStateFile(root, task);
    const readState = () => { const j = readJson(state, null); return j && Array.isArray(j.files) ? j : { files: [] }; };
    const dropState = () => { try { fs.rmSync(state, { force: true }); } catch { /* a record */ } };
    const withMarkers = (files) => files.filter((f) => { try { return MARKER.test(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return false; } });
    const fileLines = (files) => files.slice(0, 40).map((f) => `  ${f}: edit it to keep both sides where both are needed (and remove the <<<<<<< ======= >>>>>>> lines), then git -C ${shown} add ${f}, then ${targetMergeCommand(task)} --continue`);

    if (mode === 'abort') {
      if (!merging()) { dropState(); return { ok: true, code: 0, step: 'none', lines: [`No merge is in progress in ${shown}: nothing to abort.`] }; }
      const a = g('merge', '--abort');
      if (a.status !== 0) return fail(`git merge --abort failed in ${shown}: ${String(a.stderr || a.stdout).trim().split('\n').pop()}`);
      reapplySparse(dir); // 2.86 (f): files outside a sparse worktree's folders that the merge wrote go again
      dropState();
      ev('aborted', `the merge of ${target} into ${branch} was aborted; the worktree is as it was before it`);
      return { ok: true, code: 0, step: 'aborted', lines: [`Aborted: ${shown} is back where it was before the merge of ${target}.`] };
    }
    if (mode === 'continue') {
      if (!merging()) { dropState(); return fail(`No merge is in progress in ${shown}: start one with ${targetMergeCommand(task)}.`); }
      const open = unmerged();
      const marked = withMarkers([...new Set([...readState().files, ...open])]);
      if (open.length || marked.length) {
        const lines = [`Not committed: the merge of ${target} still has ${open.length ? `${open.length} unmerged path(s) (${open.slice(0, 8).join(', ')})` : ''}${open.length && marked.length ? ' and ' : ''}${marked.length ? `conflict markers in ${marked.slice(0, 8).join(', ')}` : ''}.`, ...fileLines([...new Set([...marked, ...open])]), BOTH_SIDES];
        return { ok: false, code: 2, step: 'conflict', files: [...new Set([...marked, ...open])], lines };
      }
      const c = g(...ident, 'commit', '--no-edit');
      if (c.status !== 0) return fail(`git commit --no-edit failed in ${shown}: ${String(c.stderr || c.stdout).trim().split('\n').pop()}`);
      dropState();
      const sha = g('rev-parse', '--short', 'HEAD').stdout.trim();
      ev('done', `${target} was merged into ${branch} (${sha}) after the conflicts were resolved`);
      return { ok: true, code: 0, step: 'done', lines: [`Merged: ${target} is in ${branch} (merge commit ${sha}). Go on with the task.`] };
    }

    // A plain merge.
    if (merging()) {
      const open = unmerged();
      return { ok: false, code: 2, step: 'conflict', files: open, lines: [`A merge is already in progress in ${shown}${open.length ? ` with ${open.length} unmerged path(s)` : ''}.`, ...fileLines(open), `Or put it back: ${targetMergeCommand(task)} --abort.`] };
    }
    const ref = ['', 'refs/heads/', 'refs/remotes/'].map((p) => `${p}${target}`).find((r) => g('rev-parse', '--verify', '--quiet', `${r}^{commit}`).status === 0);
    if (!ref) return fail(`Not merged: ${target} is not a branch the ${rec.engine} repo has.`);
    if (g('merge-base', '--is-ancestor', ref, 'HEAD').status === 0) return { ok: true, code: 0, step: 'up-to-date', lines: [`${branch} already has everything on ${target}: nothing to merge.`] };
    // Staged or modified tracked files would be mixed into the merge commit: they are committed (or set aside) first.
    const tracked = g('status', '--porcelain', '--untracked-files=no').stdout.split('\n').filter((l) => l.trim());
    const dirty = splitPhantom(dir, tracked).real;
    if (dirty.length) return fail(`Not merged: ${dirty.length} uncommitted file(s) in ${shown} (${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}): commit them first (git -C ${shown} add <file>, then git -C ${shown} commit -m "..."), then run this again.`);
    ev('started', `merging ${target} into ${branch} in ${shown}`);
    const m = g(...ident, 'merge', '--no-ff', '--no-commit', '-m', targetMergeMessage(target, rec, task), ref);
    if (m.status === 0 && merging()) {
      const c = g(...ident, 'commit', '--no-edit');
      if (c.status !== 0) return fail(`The merge of ${target} was clean but git commit failed in ${shown}: ${String(c.stderr || c.stdout).trim().split('\n').pop()} (finish it with ${targetMergeCommand(task)} --continue)`);
      const sha = g('rev-parse', '--short', 'HEAD').stdout.trim();
      ev('done', `${target} was merged into ${branch} (${sha}), no conflict`);
      return { ok: true, code: 0, step: 'done', lines: [`Merged: ${target} is in ${branch} (merge commit ${sha}), no conflict. Go on with the task.`] };
    }
    const files = unmerged();
    if (!files.length) {
      const why = String(m.stderr || m.stdout || '').trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);
      if (merging()) g('merge', '--abort');
      return fail(`Not merged: git merge of ${target} failed in ${shown} without a conflict to resolve (${why || `exit ${m.status}`}); the worktree is as it was.`);
    }
    try { fs.mkdirSync(path.dirname(state), { recursive: true }); fs.writeFileSync(state, `${JSON.stringify({ task, target, dir: shown, files, at: new Date().toISOString() }, null, 2)}\n`); } catch { /* --continue still reads git's unmerged list */ }
    ev('conflict', `merging ${target} into ${branch} left ${files.length} conflicted file(s): ${files.slice(0, 8).join(', ')}`, { files: files.slice(0, 40) });
    // 2.86 (f): a sparse worktree: git wrote the conflicted files outside its folders into it; say so, and how to widen it.
    const ss = sparseState(dir);
    const out = ss.sparse ? outsideSparse(files, ss.paths) : [];
    const wide = out.length ? [`${out.length} of these are outside this sparse worktree's folders (${ss.paths.join(', ')}): ${out.slice(0, 8).join(', ')}. Git wrote them into the worktree to resolve here; if you need the rest of the project around them, widen it: ${widenHint(task)}.`] : [];
    return { ok: false, code: 2, step: 'conflict', files, ...(out.length ? { outside: out } : {}), lines: [`Merging ${target} into ${branch} left ${files.length} conflicted file(s) in ${shown}; the merge stays open there for you to resolve:`, ...fileLines(files), ...wide, BOTH_SIDES, `To put the worktree back instead: ${targetMergeCommand(task)} --abort.`] };
  } catch (e) { return fail(`Not merged: ${e.message}`); }
}

/**
 * 2.86 (f): `npm run engine -- lane <ID> --full`: the task's sparse engine worktree becomes full (git sparse-checkout
 * disable), and the task's record keeps full: true so a worktree made again for it is full too. Who may: as for merge.
 * { ok, code, lines }. Never throws.
 */
export async function widenEngineLane(task, { engine = null, root = mainRoot(), env = process.env } = {}) {
  const fail = (line) => ({ ok: false, code: 1, lines: [line] });
  try {
    if (!task || !/^[A-Za-z]+-\d+$/.test(String(task))) return fail('Usage: npm run engine -- lane <TASK_ID> --full');
    const who = await targetMergeRefusal(task, { env, root });
    if (who) return fail(`Not widened: ${who}.`);
    const w = engineTaskDir(task, { root, engine });
    if (w.error) return fail(`Not widened: ${w.error}.`);
    const shown = w.dir.split(path.sep).join('/');
    const r = widenEngineWorktree(w.dir);
    if (r.error) return fail(`Not widened: ${shown}: ${r.error}.`);
    setEngineTask(task, { engine: w.rec.engine, ...(w.rec.track ? { track: w.rec.track } : {}), ...(w.rec.branch ? {} : { branch: w.branch }), full: true }, { root });
    if (!r.already) { try { emitEvent({ type: 'engine.lane', agent: String(env.STUDIO_AGENT || env.STUDIO_LOCK_OWNER || '').trim() || 'person', task, msg: `${task}: its engine worktree ${shown} was widened to full (npm run engine -- lane ${task} --full)`.slice(0, 400), meta: { dir: shown, full: true } }); } catch { /* a record */ } }
    return { ok: true, code: 0, lines: [r.already ? `${shown} is already a full worktree.` : `${shown} is now a full worktree (every file of ${w.branch} is checked out).`] };
  } catch (e) { return fail(`Not widened: ${e.message}`); }
}

/**
 * Before an engine pass's session starts, the engine's target branch (engines.<x>.target, e.g. unity/main) is merged
 * into its pass worktree, no fast-forward (a merge commit, as the train merges lanes). On a conflict the merge is
 * aborted and the conflicting files are returned for the porter's brief and an event; the session starts unmerged. { merged, upToDate, conflicts, note } | null (nothing to merge: no target, or the ref isn't there).
 */
export function syncEngineTarget({ task, dir, repo = null, root = mainRoot() } = {}) {
  const rec = engineTask(task, { root });
  const t = rec ? engineTarget(rec.engine, { root }) : null;
  const target = t?.cfg?.target;
  if (!target || !dir || !fs.existsSync(path.join(dir, '.git'))) return null;
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true });
  const ref = ['', 'refs/heads/', 'refs/remotes/'].map((p) => `${p}${target}`).find((r) => g('rev-parse', '--verify', '--quiet', `${r}^{commit}`).status === 0);
  if (!ref) return null;
  if (g('merge-base', '--is-ancestor', ref, 'HEAD').status === 0) return { merged: false, upToDate: true, conflicts: [], note: '' };
  const who = g('config', 'user.name').stdout.trim() ? [] : ['-c', 'user.name=studio-launcher', '-c', 'user.email=studio-launcher@example.invalid'];
  const m = g(...who, 'merge', '--no-ff', '--no-edit', '-m', targetMergeMessage(target, rec, task), ref);
  if (m.status === 0) return { merged: true, upToDate: false, conflicts: [], note: `${target} was merged into your worktree before this session (a merge commit), so you start with its newer changes.` };
  const conflicts = g('diff', '--name-only', '--diff-filter=U').stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  g('merge', '--abort');
  reapplySparse(dir);
  const files = conflicts.slice(0, 12).join(', ') || 'none named';
  return { merged: false, upToDate: false, conflicts, note: `Merging ${target} into your worktree failed${conflicts.length ? ` with conflicts in ${files}${conflicts.length > 12 ? ` +${conflicts.length - 12}` : ''}` : `: ${String(m.stderr || m.stdout || '').trim().split('\n').pop().slice(0, 160)}`}; the merge was aborted and your worktree is as it was. Start by running ${targetMergeCommand(task)}: it merges ${target} into your worktree and leaves ${conflicts.length ? 'those files' : 'what it reports'} for you to resolve (then git add each, then ${targetMergeCommand(task)} --continue). ${BOTH_SIDES}${(() => { const ss = sparseState(dir); const o = ss.sparse ? outsideSparse(conflicts, ss.paths) : []; return o.length ? ` ${o.length} of them are outside this sparse worktree's folders; to widen it: npm run engine -- lane ${task} --full.` : ''; })()}` };
}

// ---- the CLI --------------------------------------------------------------------------------------------------------

// The CLI is an async function, not a top-level await: an import cycle through a top-level await ends the process with exit 13.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)))(async () => {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const root = mainRoot();
  // The upgrade's backfill, by hand: node harness/engine-tracks.mjs backfill [--dry-run] [--by <name>]
  if (argv[0] === 'backfill') {
    const i = argv.indexOf('--by');
    const r = await backfillEngineTracks({ root, by: i >= 0 && argv[i + 1] ? argv[i + 1] : 'engine-tracks', dryRun: argv.includes('--dry-run') });
    if (json) console.log(JSON.stringify({ changed: r.changed, ambiguous: r.ambiguous, unknown: r.unknown, engines: r.engines }));
    else console.log(r.lines.length ? r.lines.join('\n') : '[upgrade] engine tracks: nothing to backfill (every open engine-porter task has its track)');
    process.exit(0);
  }
  // npm run engine -- merge <ID> [--engine x] [--continue | --abort] (engineTargetMerge above).
  if (argv[0] === 'merge') {
    const i = argv.indexOf('--engine');
    const r = await engineTargetMerge(argv[1], { mode: argv.includes('--abort') ? 'abort' : argv.includes('--continue') ? 'continue' : 'merge', engine: i >= 0 ? argv[i + 1] || null : null, root });
    if (json) console.log(JSON.stringify({ ok: r.ok, step: r.step || null, files: r.files || [], lines: r.lines }));
    else (r.ok ? console.log : console.error)(r.lines.join('\n'));
    process.exit(r.code);
  }
  // 2.86 (f): npm run engine -- lane <ID> --full (widenEngineLane above).
  if (argv[0] === 'lane') {
    const i = argv.indexOf('--engine');
    if (!argv.includes('--full')) { console.error('Usage: npm run engine -- lane <TASK_ID> --full   (makes the task\'s sparse engine worktree full)'); process.exit(1); }
    const r = await widenEngineLane(argv[1], { engine: i >= 0 ? argv[i + 1] || null : null, root });
    (r.ok ? console.log : console.error)(r.lines.join('\n'));
    process.exit(r.code);
  }
  if (argv[0] === 'task') {
    const r = engineTask(argv[1], { root });
    console.log(json ? JSON.stringify(r) : r ? `${argv[1]}: ${r.track}${r.branch ? `, branch ${r.branch}` : ''}${r.scope ? `, scope: ${r.scope}` : ''}${r.visual?.required ? `, visual check required${r.visual.refs?.length ? ` (refs: ${r.visual.refs.join(', ')})` : ''}` : ''}` : `${argv[1]} is not an engine task.`);
    process.exit(r ? 0 : 1);
  }
  const list = engineTargets({ root: REPO_ROOT }).map((t) => {
    let queued = 0;
    try { queued = (readJson(path.join(root, '.studio', 'train', t.files.queue), []) || []).length; } catch {}
    const e = expectedMinutes(t.name, { root });
    return { name: t.name, label: t.label, land: Boolean(t.land), heavyKind: t.heavyKind, rig: t.rig, expected: e, floor: engineFloor(t.name, { root }), tune: t.tune, queued, repo: engineRepo(t.name) };
  });
  if (json) console.log(JSON.stringify(list, null, 2));
  else if (!list.length) console.log('No engine target: studio/game.json "engines": { "<name>": { "land": "<command>", "target": "<branch>" } } names one (docs/ENGINE-TRACKS.md).');
  else for (const t of list) console.log(`${t.name} (${t.label}): ${t.land ? 'land command set' : 'no land command'}; ${t.queued} queued; one land run ~${t.expected.minutes ?? '?'} min (${t.expected.from}), ${t.rig.ramGb} GB, ${t.rig.cpuThreads} threads as machine:heavy "${t.heavyKind}"; RAM floor ${t.floor.gb} GB (${t.floor.from}); self-tune: ${t.tune.join(', ') || 'nothing'}${t.repo ? `; its repo: ${t.repo}` : ''}`);
  process.exit(0);
})().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });

/**
 * What a session left in its task's engine worktree: { dir, branch, repo, commits, dirty: [paths], queued } or null (not
 * an engine task, or its work is in the studio). commits: the worktree's own commits since `since` (ISO), not in the
 * engine's target, merges aside; dirty: modified, staged and untracked files (git-ignored aside). Never throws.
 */
export function engineWork(taskId, { since = null, root = mainRoot() } = {}) {
  try {
    const rec = engineTask(taskId, { root });
    if (!rec) return null;
    const repo = engineRepo(rec.engine, { root });
    if (!repo) return null;
    const own = path.join(root, '.lanes', 'engine', String(taskId));
    const dir = fs.existsSync(path.join(own, '.git')) ? own : (rec.branch ? worktreeOn(repo, rec.branch) : null);
    if (!dir || !fs.existsSync(dir)) return { dir: null, branch: rec.branch || null, repo, commits: 0, dirty: [], engine: rec.engine };
    const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true });
    // The session's own commits: not the target's (merged in at launch), not that merge itself.
    const target = (() => { try { return engineTarget(rec.engine, { root })?.cfg?.target || null; } catch { return null; } })();
    const range = target && g('rev-parse', '--verify', '--quiet', `refs/heads/${target}^{commit}`).status === 0 ? `refs/heads/${target}..HEAD` : 'HEAD';
    const log = g('log', ...(since ? [`--since=${since}`] : ['-n', '50']), '--no-merges', '--format=%h', range);
    const commits = log.status === 0 ? log.stdout.split('\n').filter(Boolean).length : 0;
    const st = g('status', '--porcelain');
    // A file git reports as modified whose bytes are the committed blob (a filter rule) is not a leftover.
    const ph = splitPhantom(dir, st.status === 0 ? st.stdout.split('\n').filter((l) => l.trim()) : []);
    const dirty = ph.real.map((l) => l.slice(3).trim());
    const branch = g('symbolic-ref', '--short', '-q', 'HEAD').stdout.trim() || rec.branch || null;
    return { dir, branch, repo, commits, dirty, phantom: ph.phantom, ...(ph.phantom.length ? { phantomNote: phantomNote(ph.phantom) } : {}), engine: rec.engine };
  } catch { return null; }
}
