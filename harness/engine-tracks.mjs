#!/usr/bin/env node
/**
 * harness/engine-tracks.mjs — 2.77.0 (u, P5.1-P5.6): one table for every engine target (Unity, Godot, Unreal, or any
 * engine a studio names), so its lane, land gate, merge train and rig cost come from data, not Unity-only code paths.
 *
 * Why (the crew, 2026-11-04): the Unity work ran OUTSIDE the harness (a hand-run agent in the Unity repo with its own
 * land script and a 12 GB RAM floor) because the harness's Unity track wasn't fed end to end:
 *   1. a Unity pass titled like real work ("Pass 11: …") is a "change" task, and its done check looked for commits and
 *      a full verify in the STUDIO repo, where an engine pass in its own repo has neither: `task done --train` refused
 *      it ("no changes found"). The 2.63 train test dodged it with a "Plan …" title (type none).
 *   2. the track lived only in the task.added event, read from the last 20000 events: on a busy board an older engine
 *      task lost its track and was closed as a web task.
 *   3. nobody ran `task train --unity`: the web train has its daemon, the Unity queue waited for a person.
 *   4. a launched porter got a lane copy of the studio, not a checkout of the engine repo on its branch.
 * The fixes: engine task records (this file), engine-aware done checks (harness/done-check.mjs engineWorkChecks), the
 * Line Producer starting an engine's train in a quiet window (harness/line-producer.mjs enginePass), and an engine
 * worktree per launched pass (engineLaunch below, used by harness/agent.mjs).
 *
 * The table: ENGINE_TARGETS (defaults), merged with studio/game.json "engines": { "<name>": { ... } } (protected: the
 * owner's). A studio can name any engine there; an unknown name gets the generic defaults.
 *   heavyKind   the machine:heavy job kind its land run takes (unity: the "unity" kind and its cap; else "heavy")
 *   rig         { ramGb, cpuThreads, minutes }: the expected cost of ONE land run (minutes: until durations exist)
 *   floor       { env, gb }: the free-RAM floor a land run waits for (env wins; then the lane's tuned ram-floor)
 *   tune        the settings the engine lane may change itself (harness/engine-tune.mjs); engines.<x>.tune.allow narrows
 *   files       queue/lock/last files of its train and gate: unity keeps its 2.63 names (unity-queue.json, …)
 *
 *   node harness/engine-tracks.mjs [list] [--json]       every engine target, its land command, queue and cost
 *   node harness/engine-tracks.mjs task <T-ID> [--json]   the engine record of one task
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, readRecentEvents } from './event.mjs';
import { mainRoot } from './worktree.mjs';

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`); fs.renameSync(tmp, f); };
const num = (v, d) => { const s = String(v ?? '').trim(); const n = Number(s); return s !== '' && Number.isFinite(n) ? n : d; };
const off = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());

/** The settings every engine lane may tune itself (P5.4). Each: { what, check(value) -> { ok, value, why } }. */
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

/** The files of an engine's train and gate. Unity keeps the 2.63 names. */
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

// ---- engine task records (P5.1) ------------------------------------------------------------------------------------

const tasksFile = (root) => path.join(root, '.studio', 'engine', 'tasks.json');
export function readEngineTasks(root = mainRoot()) { const j = readJson(tasksFile(root), {}); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; }

/**
 * The engine record of a task: { task, engine, track, branch, scope, visual: { required, refs }, by, at } or null. The
 * record (.studio/engine/tasks.json, written by task add --track engine:<x>) wins; a task added before 2.77 falls back
 * to its task.added event (and its task.unity_branch record) as before.
 */
export function engineTask(taskId, { root = mainRoot(), events = null } = {}) {
  if (!taskId) return null;
  const rec = readEngineTasks(root)[taskId];
  if (rec?.engine) return { task: taskId, ...rec };
  const evs = events || readRecentEvents(20000);
  const added = evs.filter((e) => e.type === 'task.added' && e.task === taskId).pop();
  const engine = engineOfTrack(added?.meta?.track);
  if (!engine) return null;
  const branch = evs.filter((e) => e.type === 'task.unity_branch' && e.task === taskId).pop()?.meta?.branch || added.meta.branch || null;
  return { task: taskId, engine, track: added.meta.track, branch, scope: added.meta.scope || null, visual: added.meta.visualCheck ? { required: true, refs: added.meta.refs || [] } : null, from: 'event' };
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

// ---- recorded durations (P5.3) --------------------------------------------------------------------------------------

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
  return { gb: t.floor.gb, from: `the engine table (${t.label}: ${t.floor.gb} GB)` };
}

// ---- launching an engine pass (P5.1) --------------------------------------------------------------------------------

const safeName = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s) && !s.includes('..') && !s.endsWith('.lock') && !s.endsWith('/');

/**
 * 2.78.1 (B-119 on Windows): one path in one spelling for comparing. git prints a worktree as its real path (long names,
 * forward slashes: C:/Users/runneradmin/...), while the studio's own paths may be short names (C:\Users\RUNNER~1\..., as
 * Windows' TEMP is) or another letter case; path.resolve() equates neither. The native real path does; on Windows case
 * doesn't count.
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

/** 2.78.1 (e, B-119): the worktree of `repo` that has `branch` checked out (git worktree list), or null. */
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
export function engineLaunch({ task, agent = null, root = mainRoot(), dryRun = false } = {}) {
  const rec = engineTask(task, { root });
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
  const note = (created) => `Your ${t.label} work is in its own repo: your worktree is ${dir.split(path.sep).join('/')} on branch ${branch}${created ? ` (new, from ${target || 'its HEAD'})` : ''}. Edit and commit there (no editor run needed; the land run does it). Then: npm run task -- done ${task} --agent ${agent || '<you>'} --train${rec.visual?.required ? ` (first the visual check: npm run visual -- status ${task})` : ''}.`;
  if (fs.existsSync(path.join(dir, '.git'))) {
    const cur = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8', windowsHide: true }).stdout.trim();
    if (cur === branch) return { dir, branch, repo, created: false, note: note(false) };
    return { error: `${dir} is a worktree on ${cur || 'a detached HEAD'}, not ${branch}: remove it (git -C "${repo}" worktree remove "${dir}") and start again` };
  }
  // 2.78.1 (e, B-119): a branch checked out in another worktree can't be checked out twice. An engine pass launched then
  // ran with no code access. Clean there: the pass works in that worktree. Uncommitted work there: refused, with what to do.
  if (has) {
    g('worktree', 'prune');
    // In the studio's spelling, compared by real path (Windows: short names, letter case; see samePath).
    // The configured folders first: engineRepo's repo is git's own top-level path, in git's spelling too.
    const spelled = [t.cfg.gateWorktree, t.cfg.folder, t.cfg.cwd].filter((c) => typeof c === 'string' && c.trim()).map((c) => path.resolve(root, c));
    const other = ownSpelling(worktreeOn(repo, branch), [...spelled, root, repo]);
    if (other && !samePath(other, dir)) {
      const st = spawnSync('git', ['status', '--porcelain'], { cwd: other, encoding: 'utf8', windowsHide: true });
      const dirty = st.status === 0 ? st.stdout.split('\n').filter((l) => l.trim()) : null;
      const shown = other.split(path.sep).join('/');
      // The land script's own worktree (engines.<x>.gateWorktree) is never an agent's: the harness never touches its files.
      const gw = t.cfg.gateWorktree ? path.resolve(root, t.cfg.gateWorktree) : null;
      if (gw && samePath(other, gw)) return { error: `the task's ${t.label} branch ${branch} is checked out in ${shown}, the land script's own worktree (engines.${rec.engine}.gateWorktree), which no agent edits: switch that folder back to its own branch (git -C "${shown}" switch <its branch>), then start the pass again`, busy: shown };
      if (dirty && !dirty.length) {
        const n = `Your ${t.label} work is in its own repo: your worktree is ${shown} on branch ${branch} (already checked out there and clean, so you work there). Edit and commit there (no editor run needed; the land run does it). Then: npm run task -- done ${task} --agent ${agent || '<you>'} --train${rec.visual?.required ? ` (first the visual check: npm run visual -- status ${task})` : ''}.`;
        return { dir: other, branch, repo, created: false, reused: true, note: n };
      }
      return { error: `the task's ${t.label} branch ${branch} is checked out in ${shown}${dirty ? ` with uncommitted work (${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}${dirty.length > 3 ? ` +${dirty.length - 3}` : ''})` : ' (its state could not be read)'}, and a branch can't be checked out twice: commit or stash that work there (or switch that folder to another branch: git -C "${shown}" switch <other>), then start the pass again`, busy: shown };
    }
  }
  if (dryRun) return { dir, branch, repo, created: !has, dry: true, note: note(!has) };
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  g('worktree', 'prune');
  const base = target && g('rev-parse', '--verify', '--quiet', `refs/heads/${target}`).status === 0 ? target : 'HEAD';
  const add = has ? g('worktree', 'add', dir, branch) : g('worktree', 'add', '-b', branch, dir, base);
  if (add.status !== 0) return { error: `git worktree add in ${repo} failed: ${String(add.stderr || '').trim().split('\n').pop()} (a branch checked out in another folder can't be checked out twice: work there, or move it)` };
  if (!rec.branch) setEngineTask(task, { branch }, { root });
  return { dir, branch, repo, created: !has, note: note(!has) };
}

// ---- the CLI --------------------------------------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const root = mainRoot();
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
}
