#!/usr/bin/env node
/**
 * harness/unity-train.mjs — the Unity merge train: several Unity branches land on ONE run of the studio's Unity land
 * command, one train at a time, always under machine:heavy, so Unity builds never pile up. It works like the web train
 * (harness/train.mjs) but never runs Unity itself and never touches the Unity repo's files.
 * 
 *   node harness/unity-train.mjs status [--json] [--engine <name>]
 *   node harness/unity-train.mjs queue --task <ID> [--engine x] [--agent a] [--branch b] [--alone]
 *   (npm run task -- train --unity runs a train; npm run task -- train status shows the queue and the running train)
 * 
 * Flow: `task done <ID> --train` (after the usual checks) queues the task's Unity branch (--branch, else the Unity folder's current
 * branch; it needs commits its target lacks) in .studio/train/unity-queue.json. `npm run task -- train --unity` takes the queue oldest
 * first (at most --max) and checks the branches against the target with `git merge-tree --write-tree` (objects only: no worktree,
 * index or ref moved): a conflict with the target is handed back; a conflict only with an earlier branch waits for the next train.
 * ONE land run for the rest: a land command that takes a list ("landMany", or {branches} in "land") gets the branches in order; one that
 * takes a single {branch} gets one integration branch, unity-train/<id>, built from refs only. Pass (0): the target must contain every
 * branch's head (else nothing closes: an error) and each task closes as in the web train. Red (1) or conflict (2): prefix bisection as the
 * web train's (about log2 N more runs): a green prefix LANDS, the first red prefix names the branch that breaks it (alone or with the
 * branches before it), handed back with the run's last lines; the rest train again. Refused (3: editor open, little memory, another
 * landing, machine:heavy busy), error (4, other, a timeout) or "not run" (infrastructure abort: out of memory, editor ended from
 * outside, no licence, free RAM under STUDIO_UNITY_MIN_FREE_GB): nobody is blamed; retried (STUDIO_UNITY_TRAIN_RETRIES, 2, every
 * STUDIO_UNITY_TRAIN_RETRY_MIN, 10 min), then the train stops, its branches stay queued and what landed stays landed.
 * 
 * One Unity train at a time (.studio/locks/unity-train.lock; a dead holder's lock is taken over); every land run takes
 * machine:heavy (harness/unity-gate.mjs), as a landing (STUDIO_GATE_PRIORITY=landing). This module never imports
 * harness/task.mjs: the board comes in as `deps`.
 * 
 * It serves ANY engine target (harness/engine-tracks.mjs): every function takes `engine` (default unity, whose file names
 * stay as they were). Engine <x>'s train has its own queue (.studio/train/<x>-queue.json), lock (.studio/locks/<x>-train.lock),
 * last result, integration refs (<x>-train/<id>), events (task.train.<x>.*) and land command (studio/game.json engines.<x>),
 * and runs beside the web train and every other engine's: they compete only for machine:heavy (and its RAM floor), which
 * the Line Producer schedules (harness/line-producer.mjs enginePass).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { mainRoot } from './worktree.mjs';
import { withLandLock } from './merge-lane.mjs';
import { selfIdentity, pidAlive } from './proc-identity.mjs';
import { runUnityGate, unityConfig, unityTrack, landManyCommand, safeRefName, taskBranch } from './unity-gate.mjs';
import { engineTarget, engineFiles, engineTask, setEngineTask, targetMergeCommand } from './engine-tracks.mjs';
import { selectBatch, batchLimits, laneClass, onlyList, tagCounts, autoLine } from './engine-train-control.mjs';
import { recordEngineShots } from './engine-shots.mjs';
import { writeAtomic, readJson } from './fsafe.mjs';
import { rulesConfig, rulesGate, inputsPrint, shareInputs, changedPaths, playSelection, PLAY_FILTER_SAFE } from './engine-rules.mjs';
import { removeLandedLane, pruneBuilds, buildsConfig } from './engine-clean.mjs';

const git = (cwd, ...args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); writeAtomic(f, `${JSON.stringify(v, null, 2)}\n`); };
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const short = (s) => String(s || '').slice(0, 8);
const labelOf = (engine) => engineTarget(engine)?.label || engine;
const evTop = (type, id, msg, extra = {}) => { const e = extra.engine || 'unity'; try { emitEvent({ type: `task.train.${e}.${type}`, agent: extra.agent || `${e}-train`, task: extra.task, to: extra.to, status: extra.status, track: `engine:${e}`, msg: `${labelOf(e)} train ${id}: ${msg}`.slice(0, 600), meta: { train: id, engine: e, ...(extra.meta || {}) } }); } catch {} };

export const UNITY_REF_PREFIX = 'unity-train/';
const queueFile = (root, engine = 'unity') => path.join(root, '.studio', 'train', engineFiles(engine).queue);
const lastFile = (root, engine = 'unity') => path.join(root, '.studio', 'train', engineFiles(engine).last);
const lockFile = (root, engine = 'unity') => path.join(root, '.studio', 'locks', engineFiles(engine).lock);
const refPrefix = (engine = 'unity') => engineFiles(engine).refPrefix;

// ---- settings ----

const isRepo = (dir) => Boolean(dir) && fs.existsSync(dir) && git(dir, 'rev-parse', '--git-dir').status === 0;

/** The Unity repo the harness reads refs in: engines.unity.gateWorktree, else the Unity track's folder, else engines.unity.cwd. Only ref and object commands run there (rev-parse, merge-base, merge-tree --write-tree, commit-tree, update-ref): never checkout, merge, reset or clean. */
export function unityRepo(cfg, root = REPO_ROOT, engine = 'unity') {
  const track = unityTrack(engine);
  for (const d of [cfg?.gateWorktree, track?.folder, cfg?.cwd]) {
    if (typeof d !== 'string' || !d.trim()) continue;
    const abs = path.resolve(root, d);
    if (isRepo(abs)) return abs;
  }
  return null;
}

/** What the train needs from studio/game.json engines.unity: { cfg, many, target, repo, folder } or { error, message }. */
export function unityTrainSettings(root = REPO_ROOT, engine = 'unity') {
  const cfg = unityConfig(root, engine);
  const L = labelOf(engine);
  if (!cfg) return { error: 'no-land', message: `No ${L} land command is configured (studio/game.json "engines": { "${engine}": { "land": "<command>" } }): there is nothing to land ${L} branches with.` };
  const many = Boolean(landManyCommand(cfg));
  if (!many && !String(cfg.land).includes('{branch}')) return { error: 'no-branch', message: `The ${L} land command takes no {branch} (nor {branches}, nor a "landMany" command): the train could not tell it what to land. The owner adds {branch} or a "landMany" command with {branches} to studio/game.json engines.${engine}.` };
  if (!safeRefName(cfg.target)) return { error: 'no-target', message: `The ${L} train needs "target" in studio/game.json engines.${engine}: the branch the land script lands on (the train checks each branch against it and that the target contains them after a pass).` };
  const repo = unityRepo(cfg, root, engine);
  if (!repo) return { error: 'no-repo', message: `The ${L} repo was not found: engines.${engine}.gateWorktree, the ${L} track's folder (engine/<game>/engine.json) or engines.${engine}.cwd must be a git checkout of it.` };
  if (git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${cfg.target}`).status !== 0) return { error: 'no-target', message: `The ${L} repo (${repo}) has no branch ${cfg.target} (engines.${engine}.target).` };
  const track = unityTrack(engine);
  const folder = track?.folder && isRepo(path.resolve(root, track.folder)) ? path.resolve(root, track.folder) : cfg.cwd && isRepo(path.resolve(root, cfg.cwd)) ? path.resolve(root, cfg.cwd) : repo;
  return { cfg, many, target: cfg.target, repo, folder, engine };
}

const headOf = (repo, branch) => out(git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`));
const isAncestor = (repo, a, b) => git(repo, 'merge-base', '--is-ancestor', a, b).status === 0;

/**
 * The engine config's "preLand" command for one lane, before the long land run: run in a throwaway checkout of the engine repo at the
 * lane's commit (never the land script's own worktree), with STUDIO_LANE_COMMIT, STUDIO_LANE_DIR and STUDIO_ENGINE_REPO set.
 * { ok: true } | { ok: false, why } (exited non-zero: its last lines) | { error } (could not be run: nobody is blamed).
 */
export function runPreLand(s, lane, { root, id, env = process.env, log = () => {} } = {}) {
  const cmd = typeof s.cfg?.preLand === 'string' ? s.cfg.preLand.trim() : '';
  if (!cmd) return { ok: true, skipped: true };
  const dir = path.join(root, '.studio', 'tmp', `preland-${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}-${String(lane.task).replace(/[^A-Za-z0-9._-]/g, '_')}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const cleanup = () => { git(s.repo, 'worktree', 'remove', '--force', dir); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} git(s.repo, 'worktree', 'prune'); };
  cleanup();
  const add = git(s.repo, 'worktree', 'add', '--detach', dir, lane.head);
  if (add.status !== 0) return { error: `could not check ${short(lane.head)} out for the pre-land check: ${String(add.stderr || '').trim().split('\n').pop()}` };
  try {
    log(`[unity-train] ${id}: pre-land check for ${lane.task} (${lane.branch} at ${short(lane.head)}): ${cmd}`);
    const r = spawnSync(cmd, { shell: true, cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: Math.max(1, num(s.cfg.preLandTimeoutMin, 10)) * 60000, env: { ...env, STUDIO_LANE_COMMIT: lane.head, STUDIO_LANE_DIR: dir, STUDIO_ENGINE_REPO: s.repo } });
    if (r.error) return { error: `the pre-land command could not run: ${r.error.code || r.error.message}` };
    if (r.status === 0) return { ok: true };
    const lines = `${r.stdout || ''}${r.stderr || ''}`.replace(/\r\n?/g, '\n').trimEnd().split('\n').slice(-8).join('\n');
    return { ok: false, why: `the pre-land check (engines.${s.engine || 'unity'}.preLand) exited ${r.status ?? r.signal ?? '?'}${lines ? `:\n${lines.split('\n').map((x) => `  ${x}`).join('\n')}` : ''}` };
  } finally { cleanup(); }
}

// ---- the queue ----

export function readUnityQueue(root = mainRoot(), engine = 'unity') {
  const q = readJson(queueFile(root, engine));
  return Array.isArray(q) ? q : [];
}
const withQueue = (root, fn, engine = 'unity') => withLandLock(root, () => { const q = readUnityQueue(root, engine); const r = fn(q); writeJson(queueFile(root, engine), q); return r; }, { name: `${engine}-train-queue`, waitMs: 30000 });
export const dequeueUnity = (root, task, engine = 'unity') => withQueue(root, (q) => { const i = q.findIndex((e) => e.task === task); if (i >= 0) q.splice(i, 1); return i >= 0; }, engine);
/** Set (a word) or clear (null) a queued lane's tag in place. The entry, or null when the task is not queued. */
export const setQueueTag = (root, task, tag, engine = 'unity') => withQueue(root, (q) => { const e = q.find((x) => x.task === task); if (!e) return null; if (tag) e.tag = tag; else delete e.tag; return { ...e }; }, engine);

/**
 * Queue a Unity-track task's branch (task done <ID> --train, after its checks). { ok, entry, message } or { ok: false, error,
 * message }. The branch: `branch`, else the task's recorded Unity branch, else the Unity folder's current branch (never the target).
 */
export function queueUnityTask(root, { engine = 'unity', task, agent = null, branch = null, note = '', alone = null, tag = null, again = false, meta = null } = {}) {
  const s = unityTrainSettings(root, engine);
  const L = labelOf(engine);
  const UNITY_REF_PREFIX = refPrefix(engine);
  if (s.error) return { ok: false, error: s.error, message: `${task} was not queued. ${s.message}` };
  // --branch, else the task's recorded Unity branch (task add --branch, unity-gate branch), else the Unity folder's current branch (refused below when it is the target itself).
  let br = typeof branch === 'string' && branch ? branch : (taskBranch(task) || '');
  if (!br) {
    const cur = out(git(s.folder, 'symbolic-ref', '--short', 'HEAD'));
    if (!cur) return { ok: false, error: 'no-branch', message: `${task} was not queued: which ${L} branch? Pass --branch <name> (the ${L} folder is not on a branch).` };
    br = cur;
  }
  if (!safeRefName(br) || br.startsWith(UNITY_REF_PREFIX)) return { ok: false, error: 'bad-branch', message: `${task} was not queued: "${br.slice(0, 80)}" is not a plain branch name (letters, digits, . _ / - only, not ${UNITY_REF_PREFIX}...).` };
  if (br === s.target) return { ok: false, error: 'bad-branch', message: `${task} was not queued: ${br} is the target itself; queue the branch the work is on (--branch <name>).` };
  const head = headOf(s.repo, br);
  if (!head) return { ok: false, error: 'no-branch', message: `${task} was not queued: the ${L} repo has no branch ${br}.` };
  const ahead = Number(out(git(s.repo, 'rev-list', '--count', `refs/heads/${s.target}..${head}`))) || 0;
  if (!ahead) return { ok: false, error: 'nothing', message: `${task} was not queued: ${br} has no commits that ${s.target} doesn't have.` };
  // 2.85: a branch the train handed back is not queued again unchanged (only merges of the target since that red, and the target
  // changed nothing the red's evidence names): the same red would repeat. --again (the overseer or a planner) queues it anyway, logged.
  // An entry already in the queue (task alone, a re-tag) is not asked.
  if (!readUnityQueue(root, engine).some((e) => e.task === task)) {
    const rec = (() => { try { return unchangedSinceRed(s, readHandbacks(root, engine)[task], br, head); } catch { return null; } })();
    if (rec && !again) return { ok: false, error: 'unchanged', handback: rec, message: `${task} was not queued: nothing changed since ${L} train ${rec.train} handed ${br} back for ${rec.reason}: the same red would repeat (since then ${br} has only merges of ${s.target}${(rec.files || []).length ? `, and ${s.target} changed none of ${rec.files.slice(0, 4).join(', ')}` : `, and ${s.target} has not moved`}). Fix it, or \`npm run task -- impossible ${task} --why "<what contradicts what>"\`. The overseer or a planner may queue it anyway with --again.` };
    if (rec && again) evTop('requeued_unchanged', 'queue', `${task}: ${br} at ${short(head)} queued again with --again though nothing changed since train ${rec.train} handed it back (${rec.reason})`, { engine, agent: agent || `${engine}-train`, task, to: 'producer', status: 'warn', meta: { branch: br, head, handback: rec.train, reason: String(rec.reason).slice(0, 200) } });
  }
  const entry = withQueue(root, (q) => {
    const i = q.findIndex((e) => e.task === task);
    // A branch that must land alone (task done --train --alone, or the task's record: task alone <ID> on).
    const solo = alone === null || alone === undefined ? Boolean((() => { try { return engineTask(task, { root })?.alone; } catch { return false; } })() || (i >= 0 && q[i].alone)) : Boolean(alone);
    // A lane tag (task done --train --tag <word>, task tag <ID> <word>): only a train for that tag takes it.
    // tag null: the task's record, else the entry's own; '' clears it.
    const tg = tag === null || tag === undefined ? (() => { try { return engineTask(task, { root })?.tag || null; } catch { return null; } })() || (i >= 0 ? q[i].tag || null : null) : tag || null;
    const rec = { task, agent, branch: br, head, note: note || '', at: new Date().toISOString(), ...(solo ? { alone: true } : {}), ...(tg ? { tag: tg } : {}) };
    if (i >= 0) q.splice(i, 1, { ...rec, at: q[i].at });
    else q.push(rec);
    return rec;
  }, engine);
  if (tag !== null && tag !== undefined) { try { const r0 = engineTask(task, { root }); if (r0?.engine === engine || !r0) setEngineTask(task, { engine, ...(r0?.track ? { track: r0.track } : {}), tag: tag || null }, { root }); } catch { /* the queue entry carries it */ } }
  evTop('queued', 'queue', `${task}: ${br} at ${short(head)} waits for the next ${L} train${entry.alone ? ' (it lands alone)' : ''}${entry.tag ? ` (tag ${entry.tag}: only train --engine ${engine} --tag ${entry.tag} takes it)` : ''}`, { engine, agent: agent || `${engine}-train`, task, to: 'producer', meta: { branch: br, head, ...(entry.alone ? { alone: true } : {}), ...(entry.tag ? { tag: entry.tag } : {}), ...(meta && typeof meta === 'object' ? meta : {}) } }); // 2.85: meta.auto when the harness queued it
  // The lane's new shared input files (engines.<x>.rules.share: content-addressed files a lane adds, git-ignored) go to the
  // engine's input folder now, so the rules check and the land run find them. Never overwrites.
  try { shareLaneInputs(root, engine, s, task, (m) => console.error(m)); } catch { /* the train tries again */ }
  return { ok: true, entry, message: `${task} is checked and its ${L} branch ${br} (at ${short(head)}, ${ahead} commit(s) ahead of ${s.target}) is queued for the next ${L} train${entry.tag ? `, tagged ${entry.tag}: only npm run task -- train --engine ${engine} --tag ${entry.tag} takes it (the automatic start never does)` : ''}. npm run task -- train --engine ${engine} lands every queued branch on ONE land run (the Line Producer starts it in a quiet window); until then the task stays in progress.` };
}

/** Copy a lane's new shared input files (rules.share) into the engine's input folder. { copied, skipped } | null. */
export function shareLaneInputs(root, engine, s, task, log = () => {}) {
  const cfg = (() => { try { return rulesConfig(engine, { root, repo: s.repo, ref: s.target }); } catch { return null; } })();
  if (!cfg || !Array.isArray(cfg.share) || !cfg.share.length) return null;
  const laneDir = path.join(root, '.lanes', 'engine', String(task));
  if (!fs.existsSync(laneDir)) return null;
  const to = s.cfg.cwd ? path.resolve(root, s.cfg.cwd) : s.folder;
  if (!to || !fs.existsSync(to)) return null;
  const r = shareInputs({ cfg, laneDir, to, log });
  if (r?.copied?.length) { log(`[unity-train] ${task}: ${r.copied.length} new shared input file(s) copied to ${to.split(path.sep).join('/')}: ${r.copied.slice(0, 4).join(', ')}${r.copied.length > 4 ? ', ...' : ''}`); evTop('inputs_shared', 'queue', `${task}: ${r.copied.length} new shared input file(s) copied to the ${engine} input folder`, { engine, task, meta: { files: r.copied.slice(0, 20) } }); }
  return r;
}

/** The stage a red land run failed in first (from its stage report), or null when it reported none. */
export const firstRedStage = (r) => (Array.isArray(r?.stages) ? (r.stages.find((x) => x && x.name && !/^(pass|passed|ok|skip|skipped)$/i.test(String(x.status || ''))) || {}).name || null : null);

/**
 * The stages a red land run is tried once more for before anyone is blamed: engines.<x>.retryStages (a list), or
 * STUDIO_ENGINE_RETRY_STAGES (comma-separated; off: none); for Unity, "play" when neither is set (Play Mode tests wait on frames
 * and time, and fail under load).
 */
export function retryStagesOf(cfg = {}, env = process.env, engine = 'unity') {
  const raw = String(env.STUDIO_ENGINE_RETRY_STAGES ?? '').trim();
  if (raw) return /^(off|0|false|no|none)$/i.test(raw) ? [] : raw.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (Array.isArray(cfg.retryStages)) return cfg.retryStages.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  return engine === 'unity' ? ['play'] : [];
}

/**
 * Blame by evidence, rule 1: for a red batch with named failing tests, the lanes that change a file naming a failing test's class (the
 * test itself, or the code named after it). [{ lane, tests, files }]. Reads refs only; a lane with too many changed files, or a test name
 * with no usable class, yields no evidence.
 */
export function suspectsByFiles({ repo, tip, lanes = [], files = [] } = {}) {
  const named = files.slice(0, 20).map((f) => String(f).replace(/\\/g, '/').replace(/^\.\//, '')).filter((f) => f.includes('.'));
  if (!named.length) return [];
  const found = [];
  for (const lane of lanes) {
    const changed = out(git(repo, 'diff', '--name-only', '--no-renames', `${tip}...${lane.head}`)).split('\n').filter(Boolean);
    if (!changed.length || changed.length > 300) continue;
    const hit = changed.filter((c) => named.some((n) => n === c || n.endsWith(`/${c}`) || c.endsWith(`/${n}`)));
    if (hit.length) found.push({ lane, tests: [], files: hit.slice(0, 6) });
  }
  return found;
}
export function suspectsOf({ repo, tip, lanes = [], failures = [] } = {}) {
  const tokens = new Map();
  for (const f of failures.slice(0, 20)) {
    const parts = String(f).replace(/\(.*$/, '').split('.').map((x) => x.trim()).filter(Boolean);
    const cls = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    if (cls && /^[A-Za-z_][A-Za-z0-9_]{3,}$/.test(cls)) tokens.set(String(f), cls);
  }
  if (!tokens.size) return [];
  const found = [];
  for (const lane of lanes) {
    const files = out(git(repo, 'diff', '--name-only', '--no-renames', `${tip}...${lane.head}`)).split('\n').filter(Boolean);
    if (!files.length || files.length > 300) continue;
    const tests = []; const hit = new Set();
    for (const [name, cls] of tokens) {
      const r = git(repo, 'grep', '-l', '-F', '-w', '-e', cls, lane.head, '--', ...files);
      const fs2 = r.status === 0 ? String(r.stdout || '').split('\n').filter(Boolean).map((l) => l.slice(l.indexOf(':') + 1)) : [];
      if (fs2.length) { tests.push(name); for (const x of fs2) hit.add(x); }
    }
    if (tests.length) found.push({ lane, tests, files: [...hit].slice(0, 6) });
  }
  return found;
}

/**
 * Blame by evidence, rule 2, when the class name finds no single lane (a helper or fixture beside the test changed): a lane matches a test
 * when it changes a test file (Tests.cs, or under /Tests/) whose text at the lane's head declares the test's namespace (its full name less
 * class and method), or a file named after its class. [{ lane, tests, files }], as suspectsOf.
 */
export function suspectsByNamespace({ repo, tip, lanes = [], failures = [] } = {}) {
  const want = [];
  for (const f of failures.slice(0, 20)) {
    const parts = String(f).replace(/\(.*$/, '').split('.').map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const cls = parts[parts.length - 2];
    const ns = parts.slice(0, -2).join('.');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cls) || (ns && !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(ns))) continue;
    want.push({ name: String(f), cls, ns });
  }
  if (!want.length) return [];
  const found = [];
  for (const lane of lanes) {
    const files = out(git(repo, 'diff', '--name-only', '--no-renames', '--diff-filter=ACMR', `${tip}...${lane.head}`)).split('\n').filter(Boolean);
    if (!files.length || files.length > 300) continue;
    const testFiles = files.filter((x) => /Tests\.cs$/i.test(x) || /(^|\/)Tests\//.test(x)).slice(0, 60);
    const texts = new Map();
    const textOf = (x) => { if (!texts.has(x)) texts.set(x, String(git(repo, 'show', `${lane.head}:${x}`).stdout || '')); return texts.get(x); };
    const tests = []; const hit = new Set();
    for (const w of want) {
      const byName = files.filter((x) => path.posix.basename(x).replace(/\.[^.]*$/, '') === w.cls);
      const nsRe = w.ns ? new RegExp(`\\bnamespace\\s+${w.ns.replace(/\./g, '\\s*\\.\\s*')}\\s*[;{\\r\\n]`) : null;
      const byNs = nsRe ? testFiles.filter((x) => nsRe.test(textOf(x))) : [];
      if (byName.length || byNs.length) { tests.push(w.name); for (const x of [...byName, ...byNs]) hit.add(x); }
    }
    if (tests.length) found.push({ lane, tests, files: [...hit].slice(0, 6) });
  }
  return found;
}

/** A test's full name in parts: { name, cls, ns } (cls null when it has no usable class). */
const testParts = (f) => {
  const parts = String(f).replace(/\(.*$/, '').split('.').map((x) => x.trim()).filter(Boolean);
  const cls = parts.length >= 2 ? parts[parts.length - 2] : null;
  return { name: String(f), cls: cls && /^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(cls) ? cls : null, ns: parts.slice(0, -2).join('.') };
};

/** 2.85: the files at `ref` that declare a class (C#, GDScript, Python), 5 at most. */
export function testFilesAt(repo, ref, cls) {
  if (!ref || !cls || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(cls)) return [];
  const r = git(repo, 'grep', '-l', '-E', '-e', `(class|struct|record|class_name)[[:space:]]+${cls}([^A-Za-z0-9_]|$)`, ref, '--');
  return r.status === 0 ? String(r.stdout || '').split('\n').filter(Boolean).map((l) => l.slice(l.indexOf(':') + 1)).slice(0, 5) : [];
}

/** 2.85: a test file's assembly folder: the nearest folder above it holding an .asmdef at `ref`, else its own folder. */
function asmFolderOf(repo, ref, file, cache) {
  const key = `${ref}`;
  if (!cache.has(key)) cache.set(key, out(git(repo, 'ls-tree', '-r', '--name-only', ref)).split('\n').filter((x) => /\.asmdef$/i.test(x)).map((x) => path.posix.dirname(x)));
  const dirs = cache.get(key).filter((d) => d !== '.' && file.startsWith(`${d}/`)).sort((a, b) => b.length - a.length);
  return dirs[0] || path.posix.dirname(file);
}

/**
 * 2.85: which lanes are tied to which failing tests, by every evidence rule: the class rule (a changed file names the test's class,
 * which covers the lane that added the test), the namespace rule (a changed test file declares its namespace, or a file is named
 * after its class), the class file less "Tests" (FeesTests: Fees.cs), and the assembly folder (a changed file under the folder of the
 * .asmdef that holds the test's file, at the target or at the lane's head). With `weak`, also a lane that changes a path with a folder
 * named like a namespace part (Game.Economy.Tests: .../Economy/...): too loose to blame anyone by, used only to decide whether a red
 * full run is the target's own.
 * { byTest: { name: [task] }, byLane: Map task -> { lane, tests, files, rules }, unjudged: [task] } (unjudged: too many files to judge).
 */
export function tiesOf({ repo, tip, lanes = [], failures = [], weak = false } = {}) {
  const want = [...new Set(failures)].slice(0, 20).map(testParts);
  const byTest = Object.fromEntries(want.map((w) => [w.name, []]));
  const byLane = new Map();
  const unjudged = [];
  const asmCache = new Map();
  const tie = (lane, test, files, rule) => {
    if (!byLane.has(lane.task)) byLane.set(lane.task, { lane, tests: [], files: [], rules: [] });
    const t = byLane.get(lane.task);
    if (!t.tests.includes(test)) t.tests.push(test);
    for (const f of files) if (!t.files.includes(f) && t.files.length < 6) t.files.push(f);
    if (!t.rules.includes(rule)) t.rules.push(rule);
    if (!byTest[test].includes(lane.task)) byTest[test].push(lane.task);
  };
  if (!want.length) return { byTest, byLane, unjudged };
  for (const [rule, found] of [['class', suspectsOf({ repo, tip, lanes, failures: want.map((w) => w.name) })], ['namespace', suspectsByNamespace({ repo, tip, lanes, failures: want.map((w) => w.name) })]]) {
    for (const f of found) for (const t of f.tests) tie(f.lane, t, f.files, rule);
  }
  const atTip = new Map(want.map((w) => [w.name, w.cls ? testFilesAt(repo, tip, w.cls) : []]));
  for (const lane of lanes) {
    const changed = out(git(repo, 'diff', '--name-only', '--no-renames', `${tip}...${lane.head}`)).split('\n').filter(Boolean);
    if (changed.length > 300) { unjudged.push(lane.task); continue; }
    if (!changed.length) continue;
    for (const w of want) {
      if (!w.cls) continue;
      const stem = w.cls.replace(/Tests?$/, '');
      const byStem = stem.length >= 3 && stem !== w.cls ? changed.filter((x) => path.posix.basename(x).replace(/\.[^.]*$/, '') === stem) : [];
      if (byStem.length) tie(lane, w.name, byStem, 'class-file');
      const homes = [...atTip.get(w.name).map((f) => asmFolderOf(repo, tip, f, asmCache)), ...testFilesAt(repo, lane.head, w.cls).map((f) => asmFolderOf(repo, lane.head, f, asmCache))];
      const inAsm = changed.filter((x) => homes.some((d) => d && d !== '.' && x.startsWith(`${d}/`)));
      if (inAsm.length) tie(lane, w.name, inAsm, 'assembly');
      if (weak) {
        const segs = w.ns.split('.').slice(1).filter((x) => x.length >= 3 && !/^(Tests?|EditMode|PlayMode|PlayModeTests|EditModeTests)$/i.test(x)).map((x) => x.toLowerCase());
        const near = segs.length ? changed.filter((x) => x.toLowerCase().split('/').slice(0, -1).some((d) => segs.includes(d))) : [];
        if (near.length) tie(lane, w.name, near, 'folder');
      }
    }
  }
  return { byTest, byLane, unjudged };
}

// 2.85: the target's own red tests in the daily full land run, and the train's hand-back records.
const baselineFile = (root, engine) => path.join(root, '.studio', 'train', `${engine}-full-baseline.json`);
/** The engine's full-run baseline: { at, target, failing: [names], source, told } ({ failing: [] } when none). */
export function readFullBaseline(root, engine = 'unity') {
  const j = readJson(baselineFile(root, engine));
  return j && typeof j === 'object' && Array.isArray(j.failing) ? { ...j, failing: j.failing.filter((x) => typeof x === 'string') } : { failing: [] };
}
const handbacksFile = (root, engine) => path.join(root, '.studio', 'train', `${engine}-handbacks.json`);
/** What the train handed each task back for: { [task]: { train, branch, head, reason, cause, files, tests, targetAt, at } }. */
export function readHandbacks(root, engine = 'unity') {
  const j = readJson(handbacksFile(root, engine));
  return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
}
const editHandbacks = (root, engine, fn) => { try { withLandLock(root, () => { const h = readHandbacks(root, engine); fn(h); writeJson(handbacksFile(root, engine), h); }, { name: `${engine}-train-handbacks`, waitMs: 30000 }); } catch { /* a record only */ } };

/**
 * 2.85: would queueing `br` at `head` repeat the red the train handed it back for? The record when every commit on the branch since
 * that red is a merge of the target (no commit of its own) and the target changed none of the files the red's evidence names (with
 * no file named: the target has not moved); else null.
 */
export function unchangedSinceRed(s, rec, br, head) {
  if (!rec || rec.branch !== br || !rec.head || !rec.reason) return null;
  if (head !== rec.head) {
    if (!isAncestor(s.repo, rec.head, head)) return null;
    // Commits on the branch since the red that the target does not hold: none may be a commit of its own.
    if (out(git(s.repo, 'rev-list', '--no-merges', `${rec.head}..${head}`, '--not', `refs/heads/${s.target}`))) return null;
    for (const line of out(git(s.repo, 'rev-list', '--merges', '--parents', `${rec.head}..${head}`, '--not', `refs/heads/${s.target}`)).split('\n').filter(Boolean)) {
      const others = line.split(' ').slice(2);
      if (!others.length || !others.every((p) => isAncestor(s.repo, p, `refs/heads/${s.target}`))) return null;
    }
  }
  const tipNow = headOf(s.repo, s.target);
  const files = Array.isArray(rec.files) ? rec.files.filter(Boolean) : [];
  if (!rec.targetAt || !tipNow) return null;
  if (files.length) { const d = git(s.repo, 'diff', '--name-only', `${rec.targetAt}..${tipNow}`, '--', ...files); if (d.status !== 0 || out(d)) return null; }
  else if (tipNow !== rec.targetAt) return null;
  return rec;
}

/** Does a test's full name match engines.<x>.flakyTests (a full name, or a prefix ending in *)? */
export function flakyMatcher(list) {
  const pats = (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  return (name) => pats.some((p) => (p.endsWith('*') ? String(name).startsWith(p.slice(0, -1)) : String(name) === p));
}

/** The failing tests a retry can be told to re-run: the names when every one is safe on a command line (PLAY_FILTER_SAFE, no ";", 50 at most), else null (the whole land runs again). */
export function retryNames(failures = []) {
  const names = [...new Set((Array.isArray(failures) ? failures : []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!names.length || names.length > 50) return null;
  return names.every((n) => !n.includes(';') && PLAY_FILTER_SAFE.test(n)) ? names : null;
}

/** The cancel file a person's `train cancel` writes before it stops a train (read only, never written here). */
export const cancelFile = (root, engine = 'unity') => path.join(root, '.studio', 'train', `${engine}-cancel.json`);
export function cancelledTrain(root, engine, id) {
  try {
    const j = JSON.parse(fs.readFileSync(cancelFile(root, engine), 'utf8').replace(/^\uFEFF/, ''));
    if (!j || typeof j !== 'object') return null;
    const named = [j.train, j.id, j.trainId].map((x) => (x == null ? '' : String(x)));
    return named.includes(String(id)) ? { by: typeof j.by === 'string' ? j.by.slice(0, 60) : null, why: typeof j.why === 'string' ? j.why.slice(0, 200) : null } : null;
  } catch { return null; }
}

/**
 * Is a full land run due? Every STUDIO_ENGINE_FULL_LAND_HOURS (24; 0 or off: never), counted from the last full run that passed
 * ({ at, id } in .studio/engine/<engine>-full-land.json). With no record the clock starts now (unless `start` is false) and nothing is due.
 */
const fullLandFile = (root, engine) => path.join(root, '.studio', 'engine', `${engine}-full-land.json`);
export function fullLandDue(root, engine, cfg = {}, env = process.env, now = Date.now(), { start = true } = {}) {
  const raw = String(env.STUDIO_ENGINE_FULL_LAND_HOURS ?? cfg.fullLandHours ?? '').trim();
  if (/^(off|false|no)$/i.test(raw)) return '';
  const h = raw === '' ? 24 : Number(raw);
  if (!Number.isFinite(h) || h <= 0) return '';
  const at = Date.parse(readJson(fullLandFile(root, engine))?.at || '');
  if (!Number.isFinite(at)) {
    if (start) { try { fs.mkdirSync(path.dirname(fullLandFile(root, engine)), { recursive: true }); writeJson(fullLandFile(root, engine), { at: new Date(now).toISOString(), id: null, clock: 'started' }); } catch { /* asked again next time */ } }
    return '';
  }
  return now - at >= h * 3600000 ? `the last full land run that passed is older than ${h} h` : '';
}

/**
 * Does the land command run a script that differs from the target branch's copy (so a landed change to it would have no effect)?
 * { file, rel, branch } | null (no script named, not in the engine repo, or the same).
 */
export function landScriptDrift(s, root = mainRoot()) {
  try {
    const base = s.cfg.cwd ? path.resolve(root, s.cfg.cwd) : s.folder;
    const words = String(s.cfg.land || '').match(/"[^"]+"|'[^']+'|\S+/g) || [];
    for (const w0 of words) {
      const w = w0.replace(/^["']|["']$/g, '');
      if (!/\.(ps1|sh|mjs|cjs|js|py|cmd|bat)$/i.test(w)) continue;
      const file = path.isAbsolute(w) ? w : path.resolve(base || root, w);
      if (!fs.existsSync(file)) continue;
      const dir = path.dirname(file);
      const top = out(git(dir, 'rev-parse', '--show-toplevel'));
      if (!top) continue;
      // Native real paths: on Windows git prints long names while a temp folder is often spelled with its 8.3 short name.
      const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
      const fold = (p) => (process.platform === 'win32' ? real(p).toLowerCase() : real(p));
      const common = (d) => { const c = out(git(d, 'rev-parse', '--git-common-dir')); return c ? fold(path.resolve(d, c)) : ''; };
      if (!common(dir) || common(dir) !== common(s.repo)) continue;
      const rel = path.relative(real(top), real(file)).split(path.sep).join('/');
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const want = out(git(s.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${s.target}:${rel}`));
      const have = out(git(dir, 'hash-object', '--', file));
      if (!want) return { file, rel, branch: out(git(dir, 'symbolic-ref', '--short', '-q', 'HEAD')) || 'a detached HEAD', missing: true };
      if (have && have !== want) return { file, rel, branch: out(git(dir, 'symbolic-ref', '--short', '-q', 'HEAD')) || 'a detached HEAD' };
      return null;
    }
  } catch { /* a warning only */ }
  return null;
}

// ---- one Unity train at a time ----

/** The running Unity train's record (a live holder of .studio/locks/unity-train.lock), or null. */
export function runningUnityTrain(root = mainRoot(), engine = 'unity') {
  const h = readJson(lockFile(root, engine));
  return h && h.pid && pidAlive(h.pid, h.identity) ? h : null;
}

/**
 * Hold .studio/locks/unity-train.lock while fn runs. A lock whose holder is gone (or older than
 * STUDIO_UNITY_TRAIN_STALE_MIN, 1440) is taken over. Busy past waitMs: { busy: holder } and fn doesn't run.
 * fn gets update(patch): what the train is doing now, for `train status`.
 */
export async function withUnityTrainLock(root, info, fn, { waitMs = 0, poll = 2000, log = () => {}, engine = 'unity' } = {}) {
  const f = lockFile(root, engine);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const stale = num(process.env.STUDIO_UNITY_TRAIN_STALE_MIN, 1440) * 60000;
  const deadline = Date.now() + waitMs;
  let told = false;
  const rec = { pid: process.pid, identity: selfIdentity(), at: Date.now(), ...info };
  for (;;) {
    try { fs.writeFileSync(f, JSON.stringify(rec), { flag: 'wx' }); break; } catch (err) {
      if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      const h = readJson(f);
      if (!h) { try { if (Date.now() - fs.statSync(f).mtimeMs > 5000) fs.rmSync(f, { force: true }); } catch {} }
      else if (!h.pid || !pidAlive(h.pid, h.identity) || Date.now() - Number(h.at || 0) > stale) { try { fs.rmSync(f, { force: true }); } catch {} log(`[unity-train] the Unity train lock of ${h.id || '?'} (pid ${h.pid}) was left by a train that is gone: taken over`); continue; }
      if (Date.now() >= deadline) return { busy: h || { why: 'unreadable lock' } };
      if (!told && h) { log(`[unity-train] another Unity train is running (${h.id || '?'}, by ${h.by || '?'}); waiting for it`); told = true; }
      sleep(poll);
    }
  }
  const update = (patch) => { try { const cur = readJson(f); if (cur?.pid === process.pid) fs.writeFileSync(f, JSON.stringify({ ...cur, ...patch })); } catch {} };
  try { return await fn(update); } finally { try { if (readJson(f)?.pid === process.pid) fs.rmSync(f, { force: true }); } catch {} }
}

// ---- integration from refs only ----

const BOT = { GIT_AUTHOR_NAME: 'launcher', GIT_AUTHOR_EMAIL: 'launcher@studio.local', GIT_COMMITTER_NAME: 'launcher', GIT_COMMITTER_EMAIL: 'launcher@studio.local' };

/** The files a `git merge-tree --write-tree` conflict names (its "<mode> <oid> <stage>\t<path>" lines). */
const conflictFiles = (text) => [...new Set(String(text || '').split('\n').filter((l) => /^\d{6} [0-9a-f]+ [123]\t/.test(l)).map((l) => l.split('\t')[1]))];

/**
 * target + each lane, in order, as commit objects only (no worktree, no index, no ref moved). A lane already in the
 * chain is `already`; one whose merge conflicts is `conflictTarget` (it conflicts with the target alone) or `deferred`
 * (only with lanes before it). { head, included, deferred, conflictTarget, already } or { error }.
 */
export function chainOnTarget(repo, base, lanes, id, engine = 'unity') {
  let tip = base;
  const res = { included: [], deferred: [], conflictTarget: [], already: [] };
  for (const lane of lanes) {
    if (isAncestor(repo, lane.head, tip)) { (tip === base ? res.already : res.included).push({ ...lane }); continue; }
    if (isAncestor(repo, tip, lane.head)) { tip = lane.head; res.included.push({ ...lane }); continue; }
    const mt = git(repo, 'merge-tree', '--write-tree', tip, lane.head);
    if (mt.status === 0) {
      const tree = String(mt.stdout).split('\n')[0].trim();
      const msg = `${engine} train ${id}: land ${lane.task} (${lane.branch})\n\nStudio-Train: ${id} ${lane.task}`;
      const c = spawnSync('git', ['commit-tree', tree, '-p', tip, '-p', lane.head, '-m', msg], { windowsHide: true, cwd: repo, encoding: 'utf8', env: { ...process.env, ...BOT } });
      if (c.status !== 0) return { error: `git commit-tree failed: ${String(c.stderr || '').trim().split('\n').pop()}` };
      tip = c.stdout.trim();
      res.included.push({ ...lane });
      continue;
    }
    if (mt.status !== 1) return { error: `git merge-tree --write-tree failed (git 2.38 or newer is needed): ${String(mt.stderr || '').trim().split('\n').pop()}` };
    const files = conflictFiles(mt.stdout);
    const alone = tip === base ? mt : git(repo, 'merge-tree', '--write-tree', base, lane.head);
    if (alone.status === 0) res.deferred.push({ ...lane, files, why: `it conflicts with ${res.included.map((l) => `${l.task} (${l.branch})`).join(', ') || 'the branches before it'} in this train${files.length ? ` in ${files.slice(0, 5).join(', ')}` : ''}; it goes in the next ${labelOf(engine)} train` });
    else res.conflictTarget.push({ ...lane, files: conflictFiles(alone.stdout), why: `it conflicts with the target${conflictFiles(alone.stdout).length ? ` in ${conflictFiles(alone.stdout).slice(0, 5).join(', ')}` : ''}: bring the target into it with ${targetMergeCommand(lane.task)} (it leaves the conflicts in the task's worktree to resolve; small conflicts in project files usually want both sides kept), then task done --train again` });
  }
  return { ...res, head: tip };
}

// ---- the train ----

/**
 * Run one Unity train. opts: root, by, max, dryRun, waitMs (for a running Unity train; default 0: busy at once),
 * log, env, deps { close(lane, ctx{ train, head, repo, target }) -> { ok, message?, target? }, handBack(lane, note),
 * stopped() -> reason|null, waitForDrain(), markRunning(task, agent), clearRunning(task) }.
 * Returns { ok, id, landed, dropped: [{ task, why }], deferred: [{ task, why }], runs, refused?, busy?, message }.
 */
export async function runUnityTrain(opts = {}) {
  const root = opts.root || mainRoot();
  const log = opts.log || ((m) => console.error(m));
  const deps = opts.deps || {};
  const id = `${stamp()}-${process.pid}`;
  const by = opts.by || process.env.STUDIO_LOCK_OWNER || 'human';
  const engine = opts.engine || 'unity';
  const L = labelOf(engine);
  const empty = { id, engine, landed: [], dropped: [], deferred: [], runs: 0 };
  const stopped = deps.stopped?.();
  if (stopped) return { ...empty, ok: false, message: `The studio is stopped (${stopped}); no ${L} train runs until npm run task -- resume.` };
  const s = unityTrainSettings(root, engine);
  if (s.error) return { ...empty, ok: false, message: s.message };
  // --only ids (STUDIO_UNITY_TRAIN_ONLY, deprecated, is its alias) must all be queued: refused before anything starts.
  const only = onlyList(opts.only ?? (opts.env || process.env).STUDIO_UNITY_TRAIN_ONLY ?? '');
  { const miss = only.filter((t) => !readUnityQueue(root, engine).some((e) => e.task === t)); if (miss.length) return { ...empty, ok: false, unknown: miss, message: `No ${L} train was started: ${miss.join(', ')} ${miss.length === 1 ? 'is' : 'are'} not in the ${L} queue (--only takes queued tasks; npm run task -- train status --engine ${engine} lists them).` }; }
  if (!opts.dryRun && deps.waitForDrain) {
    const w = await deps.waitForDrain();
    if (!w.ok) return { ...empty, ok: false, message: w.message };
  }
  // The lock names its engine and the RAM a land run takes, so room for builders counts it between runs (heavy-budget.mjs engineTrainReserve).
  const rigRam = Number(engineTarget(engine)?.rig?.ramGb) || null;
  const locked = await withUnityTrainLock(root, { id, by, lanes: [], engine, ...(rigRam ? { ramGb: rigRam } : {}) }, (update) => unityTrainBody({ ...opts, only, engine, root, log, deps, id, by, s, update }), { waitMs: opts.waitMs ?? 0, log, engine });
  if (locked?.busy) return { ...empty, ok: false, busy: locked.busy, message: `Another ${L} train is running (${locked.busy.id || '?'}, by ${locked.busy.by || '?'}, pid ${locked.busy.pid || '?'}); one ${L} train at a time: run this again when it ends (npm run task -- train status shows it).` };
  return locked;
}

async function unityTrainBody({ engine = 'unity', root, log, deps, id, by, s, update, max = 0, dryRun = false, env = process.env, only = [], tag = null }) {
  const res = { ok: true, id, engine, landed: [], dropped: [], deferred: [], runs: 0, message: '' };
  const L = labelOf(engine);
  const UNITY_REF_PREFIX = refPrefix(engine);
  const ev = (type, idd, msg, extra = {}) => evTop(type, idd, msg, { engine, ...extra });
  const { repo, target } = s;
  // Integration refs a killed train left (only while holding the train lock).
  for (const r of out(git(repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${UNITY_REF_PREFIX}`)).split('\n').filter(Boolean)) git(repo, 'update-ref', '-d', r);
  // The batch (harness/engine-train-control.mjs selectBatch): --only / --tag first (a train with neither takes untagged lanes only), then an alone
  // lane, then engines.<x>.batchGroup "play", then the cap (--max, engines.<x>.batchMax). Everything else stays queued.
  const queued = readUnityQueue(root, engine);
  const sel = selectBatch(queued, { only, tag, max, ...batchLimits(s.cfg, env), classOf: (l) => laneClass({ repo, target, cfg: s.cfg, lane: l }) });
  if (sel.error) { res.ok = false; res.message = `No ${L} branch landed: ${sel.why} (--only takes queued tasks).`; return finish(); }
  let lanes = sel.lanes;
  res.batch = sel.why;
  if (!lanes.length) { res.message = queued.length ? `No ${L} branch for this train (${sel.why}).` : `No ${L} branch is waiting to land (task done <ID> --train on a ${L}-track task queues one).`; return finish(); }
  if (sel.alone) res.alone = sel.alone;
  if (sel.waiting) log(`[unity-train] ${id}: batch ${sel.why}`);
  const live = new Set(lanes.map((l) => l.task));
  const liveNow = () => { try { update({ lanes: [...live] }); } catch { /* the status line only */ } };
  if (!dryRun) {
    const sd = landScriptDrift(s, root);
    if (sd) { res.landScript = sd; const m = `the land command runs ${sd.file.split(path.sep).join('/')} (on ${sd.branch}), ${sd.missing ? `which ${target} does not have` : `which differs from ${target}'s copy of ${sd.rel}`}: a change landed to that script is not in use until that folder is updated`; log(`[unity-train] ${id}: WARNING: ${m}`); ev('land_script', id, m, { agent: by, to: 'producer', status: 'warn', meta: { file: sd.rel, branch: sd.branch } }); }
  }
  update({ lanes: lanes.map((l) => l.task), now: 'checking the branches', batch: sel.why, targetAt: headOf(repo, target) || null, ...(tag ? { tag } : {}) });
  ev('start', id, `${lanes.length} branch(es): ${lanes.map((l) => `${l.task} (${l.branch})`).join(', ')}${dryRun ? ' (dry run)' : ''}; batch ${sel.why}`, { agent: by, meta: { lanes: lanes.map((l) => l.task), dryRun, batch: sel.why, ...(tag ? { tag } : {}), ...(only.length ? { only } : {}), ...(sel.cls ? { cls: sel.cls } : {}) } });

  const drop = (lane, why, { handBack = true, cause = null, evidence = null } = {}) => {
    res.dropped.push({ task: lane.task, why, ...(cause ? { cause } : {}) });
    if (dryRun) return;
    // 2.85: what this lane was handed back for, so an unchanged branch is not queued again (queueUnityTask): its head, the reason and
    // the files the red's evidence names (the failing tests' files, the conflict or compile files).
    if (handBack) {
      try {
        const tests = (evidence?.tests || []).slice(0, 10);
        const files = [...new Set([...(evidence?.files || []), ...tests.flatMap((t) => testFilesAt(repo, lane.head, testParts(t).cls))])].slice(0, 20);
        editHandbacks(root, engine, (h) => { h[lane.task] = { train: id, branch: lane.branch, head: lane.head, reason: `${cause ? `${cause}: ` : ''}${why.split('\n')[0]}`.slice(0, 240), cause: cause || 'red', files, tests, targetAt: headOf(repo, target) || null, at: new Date().toISOString() }; });
      } catch { /* a record only */ }
    }
    try { dequeueUnity(root, lane.task, engine); } catch {}
    // Handed back means out of this train now: its fix can start at once, not after the train's remaining runs.
    live.delete(lane.task); liveNow();
    try { deps.clearRunning?.(lane.task); } catch { /* the finally below clears it too */ }
    ev('dropped', id, `${lane.task} handed back: ${why.split('\n')[0]}`, { task: lane.task, agent: by, to: lane.agent, status: 'blocked', ...(cause ? { meta: { cause } } : {}) });
    if (handBack) { try { deps.handBack?.(lane, `Not landed by ${L} train ${id}: ${why}`, cause ? { cause } : undefined); } catch (e) { log(`[unity-train] ${id}: could not hand ${lane.task} back: ${e.message}`); } }
  };
  const defer = (lane, why) => { res.deferred.push({ task: lane.task, why }); if (!dryRun) ev('deferred', id, `${lane.task} waits for the next ${L} train: ${why.split('\n')[0]}`, { task: lane.task, agent: by, to: lane.agent, status: 'warn' }); };

  // (a) Each branch as it is now.
  const ready = [];
  for (const lane of lanes) {
    const head = headOf(repo, lane.branch);
    if (!head) { drop(lane, `its branch ${lane.branch} is gone from the ${L} repo; queue it again`, { handBack: false }); continue; }
    if (head !== lane.head) log(`[unity-train] ${id}: ${lane.task}'s branch ${lane.branch} moved since it was queued (${short(lane.head)} -> ${short(head)}); the branch as it is now goes in`);
    if (isAncestor(repo, head, `refs/heads/${target}`)) { drop(lane, `${lane.branch} has no commits that ${target} doesn't have; task done ${lane.task} closes it`, { handBack: false }); continue; }
    ready.push({ ...lane, head });
  }
  // (b) Conflicts against the target and between branches, from refs only.
  const tip0 = headOf(repo, target);
  const pre = chainOnTarget(repo, tip0, ready, id, engine);
  if (pre.error) { res.ok = false; res.message = `The ${L} train could not check the branches: ${pre.error}. Nothing ran; the queue is kept.`; return finish(); }
  for (const l of pre.conflictTarget) drop(l, l.why, { evidence: { files: l.files || [] } });
  for (const l of pre.deferred) defer(l, l.why);
  for (const l of pre.already) drop(l, `${l.branch} is already in ${target}; task done ${l.task} closes it`, { handBack: false });
  let set = pre.included;
  if (dryRun) { res.message = `Dry run: ${set.length} branch(es) would land on ONE ${L} land run (${set.map((l) => l.task).join(', ') || 'none'}) on ${target} at ${short(tip0)}${s.many ? ' (the land command takes the list)' : set.length > 1 ? ` (through one integration branch, ${UNITY_REF_PREFIX}${id})` : ''}; ${summary(res)}`; return finish(); }
  // The engine's per-lane pre-land check (engines.<x>.preLand), before the long land run: a lane that fails it is handed back with cause
  // 'precheck' (not a red land run); a check that can't run defers the lane (nobody is blamed).
  if (typeof s.cfg.preLand === 'string' && s.cfg.preLand.trim()) {
    const kept = [];
    for (const l of set) {
      const pl = runPreLand(s, l, { root, id, env, log });
      if (pl.ok) kept.push(l);
      else if (pl.error) defer(l, `${pl.error}; the next ${L} train tries again`);
      else drop(l, `refused before the land run: ${pl.why}\nFix it on ${l.branch}, then task done ${l.task} --train again.`, { cause: 'precheck' });
    }
    set = kept;
  }
  // The rules check on the batch as it would land (harness/engine-rules.mjs), before the long land run. A lane that turns the batch red is
  // handed back with cause 'rules'; a check that is red on the target itself judges nobody. The land run then gets STUDIO_RULES_GREEN=1 while it
  // lands exactly the checked batch on the checked target with the checked inputs (re-looked at right before the land run).
  let rulesGreen = null;
  {
    const rc = (() => { try { return rulesConfig(engine, { root, env, repo, ref: target }); } catch { return null; } })();
    if (rc && set.length) {
      update({ now: `rules check: ${set.map((l) => l.task).join(', ')}` });
      const from = [...new Set([s.folder, s.cfg.gateWorktree ? path.resolve(root, s.cfg.gateWorktree) : null, s.cfg.cwd ? path.resolve(root, s.cfg.cwd) : null, repo].filter(Boolean))];
      // Each lane's new shared input files first (rules.share), and the lanes' own folders as further input sources.
      for (const l of set) { try { shareLaneInputs(root, engine, s, l.task, log); } catch { /* the check says what is missing */ } }
      const extraFrom = set.map((l) => path.join(root, '.lanes', 'engine', String(l.task))).filter((d) => fs.existsSync(d));
      const rg = (deps.rulesGate || rulesGate)({ engine, repo, tip: tip0, lanes: set, cfg: rc, from, extraFrom, root, id, env, log, chain: (t, ls) => chainOnTarget(repo, t, ls, id, engine) });
      log(`[unity-train] ${id}: rules check: ${rg.why}${rg.runs ? ` (${rg.runs} run(s), ${Math.round(rg.ms / 1000)} s)` : ''}`);
      for (const d of rg.dropped) drop(d.lane, `refused before the land run: ${d.why}\nFix it on ${d.lane.branch} (bring ${target} in first: ${targetMergeCommand(d.lane.task)}), then task done ${d.lane.task} --train again.`, { cause: 'rules' });
      set = rg.kept;
      res.rules = { ran: rg.ran, runs: rg.runs, ms: rg.ms, dropped: rg.dropped.map((d) => d.lane.task), ...(rg.skipped ? { skipped: rg.why } : {}), ...(rg.mode ? { mode: rg.mode } : {}), ...(rg.selWhy ? { why: rg.selWhy } : {}), ...(rg.parts ? { parts: rg.parts } : {}), ...(rg.splitAtOnce ? { splitAtOnce: rg.splitAtOnce } : {}), ...(rg.filter ? { filter: rg.filter } : {}), ...(rg.groups ? { groups: rg.groups } : {}), ...(rg.sliced ? { sliced: rg.sliced, slices: rg.slices } : {}) };
      if (rg.green) rulesGreen = { tip: tip0, tasks: set.map((l) => l.task).join(','), mode: rg.mode || 'full', same: () => { try { return inputsPrint(rc, [...from, ...extraFrom]) === (rg.inputs ?? inputsPrint(rc, [...from, ...extraFrom])); } catch { return false; } } };
    }
  }
  for (const l of set) deps.markRunning?.(l.task, l.agent);
  const retries = Math.max(0, num(env.STUDIO_UNITY_TRAIN_RETRIES ?? s.cfg.trainRetries, 2));
  const retryMs = Math.max(0, num(env.STUDIO_UNITY_TRAIN_RETRY_MIN ?? s.cfg.trainRetryMin, 10) * 60000);
  // Compile first (engines.<x>.compileFirst): the land command once with STUDIO_LAND_ONLY=compile before a group's land run.
  // compileOff: the land script showed it does not honour that, so this train stops asking.
  const compileOn = s.cfg.compileFirst === true;
  let compileOff = false;
  const compileMin = Math.max(1, num(s.cfg.compileTimeoutMin, 10));
  const compiledGroups = new Set();
  const compiledLanes = new Set();
  res.compileRuns = 0;
  // A land killed from outside is tried once more after STUDIO_ENGINE_KILLED_RETRY_SEC (60 s).
  let killedRetried = false;
  const killedWaitMs = Math.max(0, num(env.STUDIO_ENGINE_KILLED_RETRY_SEC, 60)) * 1000;

  /**
   * One land run of `group` on the target as it is now (refused runs tried again). The gate's result, checked. opts.play: the Play Mode
   * selection to reuse (a retry of a red play stage runs with the same filter). opts.retry: { stage, tests } for the retry of a red stage:
   * the land command is told to re-run only those tests (STUDIO_LAND_RETRY*; for a Unity play stage also STUDIO_UNITY_PLAYMODE_ARGS).
   * A retry is not compiled first.
   */
  const landGroup = async (group, what, opts = {}) => {
    const tip = headOf(repo, target);
    let arg;
    let ref = null;
    let merged = null;
    if (s.many) arg = { branches: group.map((l) => l.branch) };
    else if (group.length === 1) arg = { branch: group[0].branch };
    else {
      const c = chainOnTarget(repo, tip, group, id, engine);
      if (c.error) return { status: 'error', why: c.error };
      const bad = [...c.conflictTarget, ...c.deferred][0];
      if (bad) return { status: 'conflict', why: bad.why, lane: bad };
      ref = `${UNITY_REF_PREFIX}${id}`;
      merged = c.head;
      if (git(repo, 'update-ref', `refs/heads/${ref}`, c.head, '').status !== 0) return { status: 'error', why: `could not make the integration branch ${ref}` };
      arg = { branch: ref };
    }
    // The batch's changed paths against the target (as it would land), for the Play Mode focus. Null when git can't tell: then the play stage runs in full.
    const batchPaths = () => {
      try {
        let head = merged;
        if (!head) { const c = chainOnTarget(repo, tip, group, id, engine); head = c.error ? null : c.head; }
        return head ? changedPaths(repo, tip, head) : null;
      } catch { return null; }
    };
    let r = null;
    try {
      for (let a = 0; ; a += 1) {
        const checked = rulesGreen && rulesGreen.tip === tip && rulesGreen.tasks === group.map((l) => l.task).join(',') && rulesGreen.same();
        // Once a day (STUDIO_ENGINE_FULL_LAND_HOURS) a land run is told nothing that lets it skip its own tests (no STUDIO_RULES_GREEN, no Edit Mode
        // plan, STUDIO_LAND_FULL=1): the shortcuts rest on tests run outside the editor, and this run would see a difference between the runtimes.
        // opts.notFull: the ordinary run after a full run that was red only on the target's own tests (2.85).
        const fullWhy = opts.notFull ? '' : fullLandDue(root, engine, s.cfg, env, Date.now(), { start: !dryRun });
        // 2.85 (B-137): the daily full run is said wherever a person looks: the train's "now" line, train status, an event at its start.
        const fullMin = fullWhy ? Number(readJson(fullLandFile(root, engine))?.minutes) || null : null;
        const runText = fullWhy ? `${what}, the daily full run: every test runs, expect about ${fullMin ? `${fullMin} min` : 'the longest land run of the day'}` : what;
        update({ now: `${runText}: ${group.map((l) => l.task).join(', ')}${a ? ` (try ${a + 1})` : ''}`, runs: res.runs + 1, full: fullWhy ? { why: fullWhy, minutes: fullMin } : null });
        log(`[unity-train] ${id}: ${what}: land ${group.map((l) => `${l.task} (${l.branch})`).join(', ')} on ${target} at ${short(tip)}${ref ? ` through ${ref}` : ''}`);
        if (fullWhy) log(`[unity-train] ${id}: a full land run (${fullWhy}): the land command is not told the rules are green and gets no Edit Mode plan`);
        if (fullWhy && a === 0 && !opts.retry && !dryRun) ev('full_land', id, `${what} of ${group.map((l) => l.task).join(', ')} is the daily full run (${fullWhy}): every test runs${fullMin ? `, expect about ${fullMin} min` : ''}; a red here is checked against the target's own full-run failures`, { agent: by, to: 'producer', meta: { why: fullWhy, tasks: group.map((l) => l.task), ...(fullMin ? { minutes: fullMin } : {}) } });
        // The Play Mode focus (engines.<x>.play.focus): a hint the land script may use. Never on a full land run; a retry of a red play stage
        // gets the selection of the run it repeats.
        const play = fullWhy ? { mode: 'full', filter: '', why: fullWhy } : opts.play || playSelection({ changed: batchPaths(), cfg: s.cfg, full: false });
        for (const b of play.ignoreBad || []) log(`[unity-train] ${id}: play.focus.ignore pattern ${JSON.stringify(b).slice(0, 120)} is not a valid regex; skipped`);
        if (play.refused) log(`[unity-train] ${id}: play focus: ${play.why}; the play stage runs in full`);
        else if (play.mode === 'focus') log(`[unity-train] ${id}: play focus: ${play.why} (${play.filter})`);
        else if (play.mode === 'skip') log(`[unity-train] ${id}: play stage skipped: ${play.why}`);
        // 2.85: a full play stage says why, naming the paths no play.focus.map entry takes.
        else if (play.unmatched?.length) { log(`[unity-train] ${id}: play stage in full: ${play.why}`); res.playUnmatched = play.unmatched; }
        const playEnv = { STUDIO_PLAY_MODE: play.mode, ...(play.mode === 'focus' ? { STUDIO_PLAY_FILTER: play.filter, ...(engine === 'unity' ? { STUDIO_UNITY_PLAYMODE_ARGS: `-testFilter "${play.filter}"` } : {}) } : {}) };
        const landEnv = { ...env, STUDIO_GATE_PRIORITY: 'landing', ...(fullWhy ? { STUDIO_LAND_FULL: '1' } : checked ? { STUDIO_RULES_GREEN: '1', STUDIO_RULES_MODE: rulesGreen.mode } : {}), ...playEnv };
        if (play.mode !== 'focus') { delete landEnv.STUDIO_PLAY_FILTER; delete landEnv.STUDIO_UNITY_PLAYMODE_ARGS; }
        // What the harness tells a land script is its own: nothing of these comes from the train's environment.
        for (const k of ['STUDIO_LAND_ONLY', 'STUDIO_LAND_RETRY', 'STUDIO_LAND_RETRY_STAGE', 'STUDIO_LAND_RETRY_TESTS', 'STUDIO_EDITOR_SERVICE', 'STUDIO_EDITOR_SERVICE_CLI']) delete landEnv[k];
        // The warm editor (engines.<x>.warm, harness/editor-service.mjs): offered to the land script, never required. Not healthy after one restart:
        // the variables stay unset (the cold path) and engine.warm.fallback says why.
        if (s.cfg.warm && !dryRun) { try { Object.assign(landEnv, await (await import('./editor-service.mjs')).warmLandEnv({ root, engine, cfg: s.cfg, env, log })); } catch { /* the cold path */ } }
        const rt = opts.retry || null;
        if (rt) {
          landEnv.STUDIO_LAND_RETRY = '1';
          if (rt.stage) landEnv.STUDIO_LAND_RETRY_STAGE = rt.stage;
          if (rt.tests?.length) {
            landEnv.STUDIO_LAND_RETRY_TESTS = rt.tests.join(';');
            // Only for a red play stage: a filter of other tests would make the Play Mode stage run none of its own.
            if (engine === 'unity' && String(rt.stage || '').toLowerCase() === 'play') landEnv.STUDIO_UNITY_PLAYMODE_ARGS = `-testFilter "${rt.tests.join(';')}"`;
          }
        }
        const land = deps.land || runUnityGate;
        const label = `${engine} train ${id} (${group.map((l) => l.task).join(', ')})`;
        const gkey = group.map((l) => l.task).join(',');
        // Compile first. A red compile is handled as a red land run (its compile errors name the lane); a land script that lands anyway, or
        // answers with an error or not-run code, does not honour STUDIO_LAND_ONLY.
        let decided = null;
        let stagesBefore = [];
        if (compileOn && !compileOff && !rt && !compiledGroups.has(gkey) && !(group.length === 1 && compiledLanes.has(group[0].task))) {
          update({ now: `compile check: ${group.map((l) => l.task).join(', ')}${fullWhy ? ' (the daily full land run comes after it)' : ''}` });
          log(`[unity-train] ${id}: compile check (STUDIO_LAND_ONLY=compile) of ${group.map((l) => l.task).join(', ')}, up to ${compileMin} min`);
          const c0 = Date.now();
          // 2.85 (B-137): the compile check carries only what a compile needs: no full-run, rules, retry or Play Mode filter variables.
          // STUDIO_PLAY_MODE stays (2.84's qa/selftest-284t.mjs pins it on the compile run).
          const compileEnv = { ...landEnv, STUDIO_LAND_ONLY: 'compile' };
          for (const k of Object.keys(compileEnv)) if (/^STUDIO_(LAND_(FULL|RETRY.*)|RULES_(GREEN|MODE)|PLAY_FILTER|UNITY_(PLAYMODE|EDITMODE)_ARGS)$/.test(k)) delete compileEnv[k];
          const rc = await land({ engine, ...arg, task: gkey, label: `${label} compile`, env: compileEnv, log, only: 'compile', timeoutMin: compileMin });
          const secs = Math.round((Date.now() - c0) / 1000);
          res.compileRuns += 1;
          const notHonoured = (why) => {
            compileOff = true;
            const m = `the land command does not honour STUDIO_LAND_ONLY=compile (${why}): this train no longer asks it to compile first`;
            log(`[unity-train] ${id}: ${m}`);
            ev('compile', id, m, { agent: by, to: 'producer', status: 'warn', meta: { status: 'ignored', seconds: secs, why: String(why).slice(0, 300) } });
          };
          const nowTip = headOf(repo, target);
          if (rc.status === 'pass' && nowTip !== tip && group.every((l) => isAncestor(repo, l.head, nowTip))) {
            notHonoured('it landed the branches');
            decided = { ...rc, stages: [{ name: 'compile', status: 'pass', seconds: secs }, ...(rc.stages || [])].slice(0, 12) };
            res.runs += 1;
          } else if (rc.status === 'pass') {
            compiledGroups.add(gkey); for (const l of group) compiledLanes.add(l.task);
            stagesBefore = [{ name: 'compile', status: 'pass', seconds: secs }];
            ev('compile', id, `compile check of ${gkey}: passed in ${secs} s; the land run starts now${fullWhy ? ' (the daily full run)' : ''}`, { agent: by, status: 'ok', meta: { status: 'pass', seconds: secs, lanes: group.map((l) => l.task), ...(fullWhy ? { full: true } : {}) } });
            update({ now: `compile check passed in ${secs} s; ${runText} starts now: ${group.map((l) => l.task).join(', ')}` });
          } else if (rc.status === 'red' || rc.status === 'conflict') {
            decided = { ...rc, compileOnly: true, stages: [{ name: 'compile', status: 'fail', seconds: secs }] };
            ev('compile', id, `compile check of ${gkey}: ${rc.status} (${secs} s)${rc.errorFiles?.length ? `: ${rc.errorFiles.slice(0, 3).join(', ')}` : ''}`, { agent: by, status: 'blocked', meta: { status: rc.status, seconds: secs, lanes: group.map((l) => l.task), files: (rc.errorFiles || []).slice(0, 10), failures: (rc.failures || []).slice(0, 10) } });
          } else if (rc.status === 'killed') decided = rc;
          else if (rc.status === 'refused' || (rc.status === 'not-run' && rc.infra)) log(`[unity-train] ${id}: the compile check ${rc.status === 'refused' ? 'was refused' : 'did not run'} (${rc.why}); the land run goes on without it`);
          else notHonoured(`${rc.status}: ${String(rc.why || '').split('\n')[0]}`);
        }
        if (decided) r = decided;
        else {
          const l0 = Date.now();
          r = await land({ engine, ...arg, task: gkey, label, env: landEnv, log, ...(stagesBefore.length ? { stagesBefore } : {}) });
          res.runs += 1;
          if (fullWhy) {
            res.fullLand = (res.fullLand || 0) + 1;
            // 2.85: the full run's minutes are kept for the next one's "expect about N min" (a run that ran to the end only).
            const minutes = ['pass', 'red'].includes(r.status) ? Math.max(1, Math.round((Date.now() - l0) / 60000)) : null;
            try {
              const prev = readJson(fullLandFile(root, engine)) || {};
              if (r.status === 'pass') writeJson(fullLandFile(root, engine), { at: new Date().toISOString(), id, ...(minutes ? { minutes } : prev.minutes ? { minutes: prev.minutes } : {}) });
              else if (minutes && prev.at) writeJson(fullLandFile(root, engine), { ...prev, minutes });
            } catch { /* it is due again next time */ }
          }
        }
        // 2.85: never the previous stage while the next runs: the run ended, the train decides what comes next.
        update({ now: `${runText} of ${group.map((l) => l.task).join(', ')} ended ${r.status}; deciding what runs next`, full: null });
        r = { ...r, play, ...(fullWhy ? { full: true } : {}) };
        res.playMode = play.mode;
        res.playFilter = play.filter;
        if (play.mode === 'skip') res.playSkipped = (res.playSkipped || 0) + 1;
        // A person cancelled this train (the cancel file names it): nobody is blamed, nothing is retried.
        if (r.status !== 'pass') {
          const cx = cancelledTrain(root, engine, id);
          if (cx) { r = { ...r, status: 'cancelled', why: `the train was cancelled${cx.by ? ` by ${cx.by}` : ''}${cx.why ? ` (${cx.why})` : ''}; the land command ended ${r.status}: ${r.why}` }; break; }
        }
        // Killed from outside (a reboot): tried once more in this train; a second kill ends it.
        if (r.status === 'killed') {
          if (killedRetried) break;
          killedRetried = true;
          log(`[unity-train] ${id}: the land command was killed from outside (${r.why}); nobody is blamed; trying it once more in ${Math.round(killedWaitMs / 1000)} s`);
          ev('killed_retry', id, `the land of ${gkey} was killed from outside (${String(r.why || '').slice(0, 160)}): one more run in ${Math.round(killedWaitMs / 1000)} s; nobody is blamed`, { agent: by, to: 'producer', status: 'warn', meta: { lanes: group.map((l) => l.task), code: r.code ?? null, waitSec: Math.round(killedWaitMs / 1000) } });
          update({ now: `waiting after a kill from outside (${String(r.why || '').slice(0, 120)})` });
          sleep(killedWaitMs);
          const cx = cancelledTrain(root, engine, id);
          if (cx) { r = { ...r, status: 'cancelled', why: `the train was cancelled${cx.by ? ` by ${cx.by}` : ''} while it waited to retry a killed land run` }; break; }
          a -= 1;
          continue;
        }
        if (r.compileOnly) break;
        if ((r.status !== 'refused' && r.status !== 'not-run') || a >= retries) break;
        log(`[unity-train] ${id}: the land command ${r.status === 'not-run' ? 'did not run' : 'refused'} (${r.why}); nobody is blamed; trying again in ${Math.round(retryMs / 1000)} s (${a + 1} of ${retries} retries)`);
        update({ now: `waiting after a refusal (${r.why.slice(0, 120)})` });
        sleep(retryMs);
      }
    } finally {
      if (ref) git(repo, 'update-ref', '-d', `refs/heads/${ref}`);
    }
    // 2.85: a daily full run is judged against the target's own full-run failures (fullRunVerdict).
    if (r.full && !dryRun) { const fr = await fullRunVerdict(group, r, tip, what); if (fr) return fr; }
    if (r.status === 'pass') {
      const now = headOf(repo, target);
      const missing = group.filter((l) => !isAncestor(repo, l.head, now));
      if (missing.length) return { ...r, status: 'error', ok: false, why: `the land command said pass, but ${target} (now ${short(now)}) doesn't contain ${missing.map((l) => `${l.branch} at ${short(l.head)}`).join(', ')}: nothing was closed` };
      return { ...r, newTip: now };
    }
    return r;
  };
  /**
   * 2.85: the daily full run against the target's own full-run failures (.studio/train/<engine>-full-baseline.json). Green: the
   * baseline is cleared. Red with named tests: a baseline name the run no longer shows is cleared (only when the run went on past its
   * first red stage, so the test did run); when no failure is tied to a branch of the batch by the evidence rules (tiesOf, with the
   * loose folder rule too) or every failure is already in the baseline, the batch is neither blamed nor bisected: the names go to the
   * baseline, the director is told once per set of names (engine.full_red_on_target), the full-run clock counts as served, and the
   * same batch lands again as an ordinary land run, once. Otherwise null: the usual blame, with the baseline's names left out.
   */
  const fullRunVerdict = async (group, r, tip, what) => {
    const base = readFullBaseline(root, engine);
    const emitB = (type, status, msg, meta) => { try { emitEvent({ type, agent: by, to: 'director', status, track: `engine:${engine}`, msg: `${L} train ${id}: ${msg}`.slice(0, 600), meta: { train: id, engine, ...meta } }); } catch {} };
    const save = (failing, extra = {}) => { try { writeJson(baselineFile(root, engine), { at: new Date().toISOString(), target: headOf(repo, target) || tip, failing, source: `the full land run of ${L} train ${id}`, ...(base.told ? { told: base.told } : {}), ...extra }); } catch { /* asked again next time */ } };
    const clear = (gone) => { if (!gone.length) return; emitB('engine.full_baseline_cleared', 'ok', `the daily full run no longer fails ${gone.length} test(s) the target was red on: ${gone.slice(0, 5).join(', ')}${gone.length > 5 ? ', ...' : ''}; removed from the known-red list`, { tests: gone.slice(0, 20) }); log(`[unity-train] ${id}: full-run baseline: ${gone.length} name(s) pass again: ${gone.slice(0, 5).join(', ')}`); };
    if (r.status === 'pass') { if (base.failing.length) { save([], { told: '' }); clear(base.failing); } return null; }
    const names = r.status === 'red' && !r.compileOnly && Array.isArray(r.failures) ? [...new Set(r.failures)] : [];
    if (!names.length) return null;
    const st = Array.isArray(r.stages) ? r.stages.map((x) => x?.name) : [];
    const red0 = firstRedStage(r);
    const ranOn = red0 && st.indexOf(red0) >= 0 && st.indexOf(red0) < st.length - 1;
    const gone = ranOn ? base.failing.filter((n) => !names.includes(n)) : [];
    const kept = base.failing.filter((n) => !gone.includes(n));
    const fresh = names.filter((n) => !kept.includes(n));
    let tied = [];
    let unjudged = [];
    try { const t = tiesOf({ repo, tip, lanes: group, failures: fresh, weak: true }); tied = fresh.filter((n) => t.byTest[n]?.length); unjudged = t.unjudged; } catch { unjudged = ['?']; }
    if (tied.length || unjudged.length || fresh.length > 20) {
      if (gone.length) { save(kept); clear(gone); }
      log(`[unity-train] ${id}: the full run is red on ${names.length} test(s); ${tied.length ? `tied to a branch of the batch: ${tied.slice(0, 5).join(', ')}` : 'a branch could not be judged (too many files)'}${kept.length ? `; the target's own (not counted against anyone): ${kept.filter((n) => names.includes(n)).slice(0, 5).join(', ') || 'none in this run'}` : ''}`);
      return null;
    }
    const failing = [...new Set([...kept, ...names])].sort();
    const key = failing.join('\n');
    const told = base.told === key;
    save(failing, { told: key });
    clear(gone);
    if (!told) emitB('engine.full_red_on_target', 'warn', `the daily full land run is red on ${names.length} test(s) no branch of the batch is tied to: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', ...' : ''}. They fail on the target itself, or in the full run only; nobody was handed back and the batch lands on an ordinary run. A fix task for them is wanted.`, { tests: names.slice(0, 20), failing: failing.slice(0, 50), lanes: group.map((l) => l.task) });
    // The full-run clock counts as served: the next full run is due after the usual hours.
    try { const prev = readJson(fullLandFile(root, engine)) || {}; writeJson(fullLandFile(root, engine), { ...prev, at: new Date().toISOString(), id, served: 'red only on the target\'s own tests' }); } catch { /* due again next time */ }
    log(`[unity-train] ${id}: the full run is red only on test(s) no branch is tied to (${names.slice(0, 5).join(', ')}): known red on the target; nobody is blamed; the same batch lands again as an ordinary land run`);
    res.fullRedOnTarget = names.slice(0, 20);
    const again = await landGroup(group, `${what} again, as an ordinary land run (the full run was red only on the target's own tests)`, { notFull: true });
    return { ...again, fullRedOnTarget: names };
  };
  const shotJobs = [];
  const close = (group, r) => {
    for (const lane of group) {
      const c = deps.close ? deps.close(lane, { train: id, head: r.newTip, repo, target }) : { ok: true };
      if (c?.ok === false) { ev('close_failed', id, `${lane.task} landed but couldn't be closed: ${c.message}`, { task: lane.task, agent: by, to: 'producer', status: 'warn' }); res.unclosed = [...(res.unclosed || []), { task: lane.task, why: c.message }]; }
      try { dequeueUnity(root, lane.task, engine); } catch {}
      if (!dryRun) editHandbacks(root, engine, (h) => { delete h[lane.task]; });
      res.landed.push(lane.task);
      live.delete(lane.task);
      // A landed lane's engine worktree is removed (kept, with the reason, when anything unlanded is in it).
      if (!dryRun && !/^(off|0|false|no)$/i.test(String(env.STUDIO_ENGINE_LANE_CLEAN || ''))) { try { const rm = removeLandedLane({ root, engine, task: lane.task, log }); if (rm && !rm.removed && rm.why && rm.dir && rm.why !== 'no such folder') log(`[unity-train] ${id}: kept ${lane.task}'s engine worktree: ${rm.why}`); } catch (e) { log(`[unity-train] ${id}: could not clean ${lane.task}'s engine worktree: ${e.message}`); } }
    }
    liveNow();
    // Old gate builds are pruned (engines.<x>.builds; absent: nothing is touched).
    if (!dryRun) { try { const bc = buildsConfig(engine, { root, env }); if (bc) { const pb = pruneBuilds({ ...bc, root, log }); if (pb?.removed?.length) log(`[unity-train] ${id}: pruned ${pb.removed.length} old build(s) in ${String(bc.dir).split(path.sep).join('/')}; kept ${pb.kept.length}`); } } catch (e) { log(`[unity-train] ${id}: could not prune old builds: ${e.message}`); } }
    // Before/after pictures of a green land (engines.<x>.shots); no shots: nothing happens.
    if (typeof s.cfg.shots === 'string' && s.cfg.shots.trim() && !dryRun) {
      const base = s.cfg.cwd ? path.resolve(root, s.cfg.cwd) : s.folder;
      try { shotJobs.push(recordEngineShots({ root, engine, tasks: group.map((l) => l.task), shotsDir: path.resolve(base, s.cfg.shots), deps: deps.shots || {} }).then((x) => { if (x) log(`[unity-train] ${id}: before/after shots: ${x.pages.join(', ')}`); }).catch((e) => log(`[unity-train] ${id}: before/after shots failed: ${e.message}`))); } catch (e) { log(`[unity-train] ${id}: before/after shots failed: ${e.message}`); }
    }
    ev('landed', id, `${target} moved to ${short(r.newTip)} on one land run: ${group.map((l) => l.task).join(', ')}`, { agent: by, status: 'ok', meta: { head: r.newTip, lanes: group.map((l) => l.task) } });
  };
  /** Refused or error: nobody is blamed, every branch left waits (stays queued). */
  const hold = (group, r) => {
    if (r.status === 'refused') res.refused = { at: new Date().toISOString(), why: r.why };
    // An infrastructure abort: not run, not red; the branches wait for the next train.
    if (r.status === 'not-run') res.notRun = { at: new Date().toISOString(), why: r.why, kind: r.infra?.kind || null };
    res.ok = false;
    // Killed twice from outside, or cancelled by a person: nobody is blamed, the branches stay queued.
    if (r.status === 'killed') res.killed = { at: new Date().toISOString(), why: r.why };
    if (r.status === 'cancelled') res.cancelled = { at: new Date().toISOString(), why: r.why };
    for (const l of group) defer(l, r.status === 'refused' ? `the land command refused (${r.why}); not a failure of the work: the next ${L} train tries again` : r.status === 'not-run' ? `${r.why.startsWith('not run') ? r.why : `not run: ${r.why}`}; the next ${L} train tries again` : r.status === 'killed' ? `the land command was killed from outside twice (${r.why}); nobody is blamed: the next ${L} train tries again` : r.status === 'cancelled' ? `${r.why}; it stays queued` : `the land command failed to run (${r.why}); nobody is blamed: fix it, then run npm run task -- train --engine ${engine}`);
    if (r.status === 'cancelled') { ev('cancelled', id, `${r.why.split('\n')[0]}; ${group.map((l) => l.task).join(', ')} stay queued, nobody is handed back`, { agent: by, to: 'producer', status: 'warn', meta: { status: r.status } }); return; }
    ev(r.status === 'refused' ? 'refused' : r.status === 'not-run' ? 'not_run' : r.status === 'killed' ? 'killed' : 'error', id, `${r.status}: ${r.why}; ${group.map((l) => l.task).join(', ')} stay queued, nobody is handed back`, { agent: by, to: 'producer', status: r.status === 'refused' || r.status === 'not-run' || r.status === 'killed' ? 'warn' : 'blocked', meta: { status: r.status, log: r.log, ...(r.infra ? { infra: r.infra.kind } : {}) } });
  };
  const blame = (r) => `${r.compileOnly ? `the compile check (the land command with STUDIO_LAND_ONLY=compile) is ${r.status}` : r.status === 'conflict' ? 'the land command found a merge conflict' : 'the land command is red'}: ${r.why}${r.tail ? `\n${r.tail.split('\n').map((x) => `  ${x}`).join('\n')}` : ''}\nIts log: ${r.log || '.studio/gates/out/unity.log'}.`;

  try {
    let remaining = set;
    let rounds = 0;
    const again = retryStagesOf(s.cfg, env, engine);
    const isFlaky = flakyMatcher(s.cfg.flakyTests);
    let retried = false;
    while (remaining.length && rounds++ <= set.length + 2) {
      let r = await landGroup(remaining, 'land run');
      if (r.status === 'pass') { close(remaining, r); break; }
      // One more run before anyone is blamed when the red is in a stage known to fail under load (retryStagesOf).
      const stage0 = r.status === 'red' ? firstRedStage(r) : null;
      // engines.<x>.flakyTests: a red run whose ONLY failures are tests the owner knows to be flaky is retried even when its stage is not
      // a retry stage. A compile check's red is never retried.
      const fails0 = r.status === 'red' && Array.isArray(r.failures) ? r.failures : [];
      const knownFlaky = fails0.length > 0 && fails0.every(isFlaky);
      if (!retried && !r.compileOnly && ((stage0 && again.includes(String(stage0).toLowerCase())) || knownFlaky)) {
        retried = true;
        // Retry only what failed, when the names are known and safe on a command line; else the whole land.
        const only = retryNames(fails0);
        const st = stage0 || 'unknown';
        ev('retry', id, `red in ${st} (${fails0.slice(0, 3).join(', ') || 'no test named'})${knownFlaky ? ' on test(s) engines.' + engine + '.flakyTests names' : ''}: one more run of ${remaining.map((l) => l.task).join(', ')} before anyone is blamed${only ? `, re-running only ${only.length} failed test(s)` : ''}`, { agent: by, meta: { stage: stage0, failures: fails0.slice(0, 10), ...(only ? { only: only.slice(0, 10) } : {}), ...(knownFlaky ? { known: true } : {}) } });
        if (!only && fails0.length) log(`[unity-train] ${id}: the failed test names are not safe on a command line (or more than 50): the whole land runs again`);
        // The same Play Mode filter as the red run (a different filter would be a different check).
        const r2 = await landGroup(remaining, `land run again (red in ${st}${only ? `, ${only.length} test(s)` : ''})`, { play: r.play || null, ...(only ? { retry: { stage: stage0, tests: only } } : {}) });
        if (r2.status === 'pass') {
          res.flaky = [...(res.flaky || []), { stage: stage0, failures: fails0.slice(0, 10), ...(only ? { tests: only.slice(0, 10) } : {}), ...(knownFlaky ? { known: true } : {}) }];
          ev('flaky', id, `the same batch passed on the second run: ${st} failed the first time (${fails0.slice(0, 3).join(', ') || 'no test named'}); nobody is handed back. A test that fails under load is the game's to fix`, { agent: by, to: 'producer', status: 'warn', meta: { stage: stage0, failures: fails0.slice(0, 10), tests: fails0.slice(0, 10), retriedOnly: Boolean(only), ...(knownFlaky ? { known: true } : {}), lanes: remaining.map((l) => l.task) } });
          close(remaining, r2); break;
        }
        r = r2;
      }
      if (r.status !== 'red' && r.status !== 'conflict') { hold(remaining, r); break; }
      if (r.lane) { drop(r.lane, r.lane.why); remaining = remaining.filter((l) => l.task !== r.lane.task); continue; }
      // Blame by evidence, before any search by land runs: when the failing tests are named and exactly one lane changes a file naming their classes,
      // the batch runs without that lane: green lands the rest and hands that lane back with the evidence; red means the evidence was wrong and the
      // search goes on. A compile error names no test: then the file the compiler names is the evidence.
      // 2.85: the target's own full-run failures (the baseline) are never counted against a branch.
      const baseNames = new Set(readFullBaseline(root, engine).failing);
      const namedAll = Array.isArray(r.failures) ? r.failures : [];
      const namedTests = namedAll.filter((n) => !baseNames.has(n));
      if (namedTests.length < namedAll.length) log(`[unity-train] ${id}: ${namedAll.length - namedTests.length} failing test(s) are known red on the target in the full run and are not counted against anyone: ${namedAll.filter((n) => baseNames.has(n)).slice(0, 5).join(', ')}`);
      const namedFiles = Array.isArray(r.errorFiles) ? r.errorFiles : [];
      const redEvidence = (x) => ({ tests: (Array.isArray(x?.failures) ? x.failures : []).filter((n) => !baseNames.has(n)).slice(0, 10), files: (Array.isArray(x?.errorFiles) ? x.errorFiles : []).slice(0, 10) });
      if (r.status === 'red' && remaining.length > 1 && (namedTests.length || namedFiles.length) && !/^(off|0|false|no)$/i.test(String(env.STUDIO_ENGINE_BLAME_EVIDENCE || ''))) {
        let sp = null; let what = ''; let rule = '';
        let apart = null;
        const redStage = firstRedStage(r);
        try {
          const tipNow = headOf(repo, target);
          const byFile = namedFiles.length ? suspectsByFiles({ repo, tip: tipNow, lanes: remaining, files: namedFiles }) : [];
          if (byFile.length === 1) { sp = byFile[0]; rule = 'compile-files'; what = `the file(s) the compiler names (${sp.files.slice(0, 3).join(', ')})`; }
          else if (!byFile.length && namedTests.length) {
            const sus = suspectsOf({ repo, tip: tipNow, lanes: remaining, failures: namedTests });
            if (sus.length === 1 && sus[0].tests.length === Math.min(namedTests.length, 20)) { sp = sus[0]; rule = 'class'; what = `files naming the failing test(s) (${sp.tests.slice(0, 3).join(', ')}: ${sp.files.slice(0, 3).join(', ')})`; }
            else {
              // The second rule: the failing test's namespace (its folder's test files) or a file named after its class.
              const ns = suspectsByNamespace({ repo, tip: tipNow, lanes: remaining, failures: namedTests });
              if (ns.length === 1 && ns[0].tests.length === Math.min(namedTests.length, 20)) { sp = ns[0]; rule = 'namespace'; what = `test files of the failing test's namespace or class (${sp.tests.slice(0, 3).join(', ')}: ${sp.files.slice(0, 3).join(', ')})`; }
            }
            // 2.85: every rule at once (tiesOf: also the class file less "Tests" and the test's assembly folder), and a lane tied to only
            // some of the tests counts. Exactly one lane tied: the batch without it. Two or more: those apart from the untied ones first.
            if (!sp) {
              const t = tiesOf({ repo, tip: tipNow, lanes: remaining, failures: namedTests });
              const tiedSet = new Set([...t.byLane.keys(), ...t.unjudged]);
              if (tiedSet.size === 1 && t.byLane.size === 1) { sp = [...t.byLane.values()][0]; rule = sp.rules.join('+'); what = `files tied to the failing test(s) by ${sp.rules.join(', ')} (${sp.tests.slice(0, 3).join(', ')}: ${sp.files.slice(0, 3).join(', ')})`; }
              else if (tiedSet.size >= 2 && remaining.some((l) => !tiedSet.has(l.task))) apart = { tied: remaining.filter((l) => tiedSet.has(l.task)), untied: remaining.filter((l) => !tiedSet.has(l.task)), byTest: t.byTest };
            }
          }
        } catch { sp = null; apart = null; }
        // 2.85: the plan, said in the log and in task.train.<x>.blame: without the one suspect, the tied apart from the rest, or the search.
        const plan = sp ? { plan: 'without', suspect: sp.lane.task, next: remaining.filter((l) => l.task !== sp.lane.task).map((l) => l.task), rule } : apart ? { plan: 'apart', tied: apart.tied.map((l) => l.task), next: apart.untied.map((l) => l.task) } : { plan: 'bisect', next: remaining.map((l) => l.task) };
        const planText = plan.plan === 'without' ? `exactly one branch is tied to the failing test(s), ${plan.suspect}: the next land run is the batch without it (${plan.next.join(', ')}), not a halving search` : plan.plan === 'apart' ? `${plan.tied.length} branches are tied to the failing test(s) (${plan.tied.join(', ')}): the untied ones (${plan.next.join(', ')}) land first, apart from them` : `no single branch is tied to the failing test(s)${namedTests.length ? '' : ' (only a compile error)'}: the search by land runs`;
        log(`[unity-train] ${id}: blame plan: ${planText}`);
        ev('blame', id, `red${redStage ? ` in ${redStage}` : ''} on ${namedTests.slice(0, 3).join(', ') || namedFiles.slice(0, 3).join(', ')}: ${planText}`, { agent: by, meta: { ...plan, tests: namedTests.slice(0, 10), files: namedFiles.slice(0, 10), stage: redStage, ...(apart ? { byTest: Object.fromEntries(Object.entries(apart.byTest).slice(0, 10)) } : {}) } });
        if (apart) {
          const ru = await landGroup(apart.untied, `apart from ${apart.tied.map((l) => l.task).join(', ')}`);
          if (ru.status === 'pass') { close(apart.untied, ru); remaining = apart.tied; continue; }
          if (ru.status !== 'red' && ru.status !== 'conflict') { hold(remaining, ru); break; }
          log(`[unity-train] ${id}: the untied branches are ${ru.status} by themselves too: the evidence did not hold; searching by land runs`);
        }
        if (sp) {
          const rest = remaining.filter((l) => l.task !== sp.lane.task);
          ev('evidence', id, `${sp.lane.task} is the only branch that changes ${what}${redStage ? ` (red in ${redStage})` : ''}: running ${rest.map((l) => l.task).join(', ')} without it`, { agent: by, meta: { suspect: sp.lane.task, tests: sp.tests.slice(0, 5), files: sp.files, stage: redStage, rule } });
          const rr = await landGroup(rest, `without ${sp.lane.task}`);
          if (rr.status === 'pass') {
            close(rest, rr);
            drop(sp.lane, `${blame(r)}\nBlame by evidence: the batch was red${redStage ? ` in its ${redStage} stage` : ''} on ${sp.tests.length ? sp.tests.slice(0, 5).join(', ') : 'a compile error'}, ${sp.lane.branch} (${sp.lane.task}) is the only branch that changes ${what}, and the batch without it landed green (${rest.map((l) => l.task).join(', ')}). The files that tie them: ${sp.files.slice(0, 6).join(', ')}. Fix it on ${sp.lane.branch} (bring ${target} in first: ${targetMergeCommand(sp.lane.task)}), then task done ${sp.lane.task} --train again.`, { cause: 'evidence', evidence: { tests: sp.tests, files: sp.files } });
            remaining = []; break;
          }
          if (rr.status !== 'red' && rr.status !== 'conflict') { hold(remaining, rr); break; }
          log(`[unity-train] ${id}: the batch without ${sp.lane.task} is ${rr.status} too: the evidence did not hold; searching by land runs`);
        }
      }
      if (remaining.length === 1) { drop(remaining[0], `${blame(r)}\nFix it on ${remaining[0].branch}, then task done ${remaining[0].task} --train again.`, { evidence: redEvidence(r) }); break; }
      // Prefix bisection: the smallest k with target + the first k branches not green; green prefixes land. A red subset whose failures are the batch's
      // failure signature (the failing test names) or a subset of it holds the culprit: the search narrows there and stops after
      // STUDIO_ENGINE_BISECT_MAX runs (3), handing back the lanes still in the red range. No readable names: the full search.
      const sig = Array.isArray(r.failures) && r.failures.length ? new Set(r.failures) : null;
      // The bisect events say which tests were red (the batch's run), up to five.
      const redTests = Array.isArray(r.failures) ? r.failures.slice(0, 5) : [];
      const redSaid = redTests.length ? ` (red: ${redTests.join(', ')}${r.failures.length > 5 ? ', ...' : ''})` : '';
      const bisectMax = Math.max(1, Math.floor(num(env.STUDIO_ENGINE_BISECT_MAX, 3)));
      let bisectRuns = 0;
      let capped = false;
      let lo = 0;
      let hi = remaining.length;
      let bad = r;
      let badGroup = remaining;
      const steps = [{ n: hi, status: r.status }];
      let held = false;
      while (hi - lo > 1) {
        if (sig && bisectRuns >= bisectMax) { capped = true; break; }
        const mid = Math.floor((lo + hi) / 2);
        const part = remaining.slice(lo, mid);
        const rm = await landGroup(part, `bisect ${remaining.slice(0, mid).map((l) => l.task).join('+')}`);
        bisectRuns += 1;
        steps.push({ n: mid, status: rm.status, ...(rm.failures?.length ? { failures: rm.failures.length } : {}), ...(sig && rm.failures?.length && rm.failures.every((n) => sig.has(n)) ? { signature: true } : {}) });
        if (rm.status === 'pass') { close(part, rm); lo = mid; continue; }
        if (rm.status !== 'red' && rm.status !== 'conflict') { hold(remaining.slice(lo), rm); held = true; break; }
        if (rm.lane) { bad = rm; badGroup = [rm.lane]; hi = remaining.findIndex((l) => l.task === rm.lane.task) + 1 || mid; break; }
        hi = mid;
        bad = rm;
        badGroup = part;
      }
      if (held) break;
      if (capped) {
        const group = remaining.slice(lo, hi);
        const before = remaining.slice(0, lo).map((l) => l.task);
        ev('bisect', id, `${steps.map((st) => `${target} + ${remaining.slice(0, st.n).map((l) => l.task).join(' + ')}: ${st.status}${st.signature ? ' (the batch\'s failures)' : ''}`).join(', ')}; stopped after ${bisectRuns} bisect run(s) (STUDIO_ENGINE_BISECT_MAX): ${group.map((l) => l.task).join(', ')} still fail${before.length ? `, ${before.join(' + ')} landed green` : ''}${redSaid}`, { agent: by, meta: { steps, culprits: group.map((l) => l.task), capped: true, tests: redTests } });
        for (const g of group) drop(g, `${blame(bad)}\nThe ${L} train's bisect stopped after ${bisectRuns} run(s) (STUDIO_ENGINE_BISECT_MAX ${bisectMax}): ${target} + ${[...before, ...group.map((l) => l.task)].join(' + ')} still shows the batch's failures (${[...sig].slice(0, 5).join(', ')}${sig.size > 5 ? ', ...' : ''}), so one of ${group.map((l) => l.branch).join(', ')} breaks it${before.length ? `; ${target} + ${before.join(' + ')} landed green` : ''}. Fix it on its branch (bring ${target} in first: ${targetMergeCommand(g.task)}), then task done ${g.task} --train again.`, { evidence: redEvidence(bad) });
        remaining = remaining.slice(hi);
        continue;
      }
      const culprit = remaining[hi - 1];
      // No blame by elimination: if the last red run was not this lane by itself on the current target, run it once alone: green lands it, red is its own evidence.
      if (!(badGroup.length === 1 && badGroup[0].task === culprit.task)) {
        const rc = await landGroup([culprit], `confirm ${culprit.task}`);
        if (rc.status === 'pass') {
          ev('bisect', id, `${steps.map((st) => `${target} + ${remaining.slice(0, st.n).map((l) => l.task).join(' + ')}: ${st.status}`).join(', ')}; ${culprit.task} was the one left, and it passed by itself: landed, nobody is handed back${redSaid}`, { agent: by, meta: { steps, confirmed: culprit.task, passedAlone: true, tests: redTests } });
          close([culprit], rc);
          remaining = remaining.slice(hi);
          continue;
        }
        if (rc.status !== 'red' && rc.status !== 'conflict') { hold(remaining.slice(hi - 1), rc); break; }
        bad = rc;
      }
      const before = remaining.slice(0, hi - 1).map((l) => l.task);
      ev('bisect', id, `${steps.map((st) => `${target} + ${remaining.slice(0, st.n).map((l) => l.task).join(' + ')}: ${st.status}`).join(', ')}; first not green with ${culprit.task}${redSaid}`, { agent: by, meta: { steps, culprit: culprit.task, tests: redTests } });
      drop(culprit, `${blame(bad)}\nThe ${L} train's prefix bisection: ${target} + ${[...before, culprit.task].join(' + ')} is ${bad.status}${before.length ? `, ${target} + ${before.join(' + ')} landed green` : ''}; so ${culprit.branch} breaks it${before.length ? ' (alone, or together with the branches before it)' : ''}. Fix it on ${culprit.branch} (bring ${target} in first: ${targetMergeCommand(culprit.task)}), then task done ${culprit.task} --train again.`, { evidence: redEvidence(bad) });
      remaining = remaining.slice(hi);
    }
  } finally {
    for (const l of set) deps.clearRunning?.(l.task);
    await Promise.all(shotJobs);
  }
  if (res.ok) res.ok = res.landed.length > 0 || (!res.dropped.length && !res.deferred.length);
  return finish();

  function finish() {
    res.message = res.message || summary(res);
    try { writeJson(lastFile(root, engine), { ...res, by, at: new Date().toISOString() }); } catch {}
    ev('done', id, res.message, { agent: by, status: res.landed.length ? 'ok' : 'warn', meta: { landed: res.landed, dropped: res.dropped.map((d) => d.task), deferred: res.deferred.map((d) => d.task), runs: res.runs, refused: Boolean(res.refused), notRun: Boolean(res.notRun), ...(res.killed ? { killed: true } : {}), ...(res.cancelled ? { cancelled: true } : {}), ...(res.compileRuns ? { compileRuns: res.compileRuns } : {}), ...(res.fullLand ? { fullLand: res.fullLand } : {}), ...(res.fullRedOnTarget ? { fullRedOnTarget: res.fullRedOnTarget } : {}), ...(res.playUnmatched ? { playUnmatched: res.playUnmatched } : {}) } });
    return res;
  }
}

function summary(res) {
  const parts = [];
  if (res.landed.length) parts.push(`landed ${res.landed.join(', ')} with ${res.runs} ${labelOf(res.engine || 'unity')} land run(s)`);
  if (res.dropped.length) parts.push(`handed back ${res.dropped.map((d) => `${d.task} (${d.why.split('\n')[0]})`).join('; ')}`);
  if (res.deferred.length) parts.push(`waiting for the next ${labelOf(res.engine || 'unity')} train: ${res.deferred.map((d) => `${d.task} (${d.why.split('\n')[0]})`).join('; ')}`);
  return parts.join('. ') || 'nothing to land';
}

// ---- the Play Mode plan of a batch (2.85) ----

/**
 * What a batch's Play Mode stage would run (playSelection on the engine's play.focus), read-only: `paths` (a list, or a comma-separated
 * string) or `branch` (its changes since it left the target). { engine, source, changed, selection } or { error, message }.
 */
export function playPlan(root, { engine = 'unity', branch = null, paths = null } = {}) {
  const cfg = unityConfig(root, engine);
  if (!cfg) return { error: 'no-land', message: `No ${labelOf(engine)} land command is configured (studio/game.json engines.${engine}).` };
  let changed = null;
  let source = '';
  if (paths) { changed = (Array.isArray(paths) ? paths : String(paths).split(',')).map((x) => x.trim().replace(/\\/g, '/')).filter(Boolean); source = `${changed.length} path(s) given`; }
  else if (branch) {
    const s = unityTrainSettings(root, engine);
    if (s.error) return { error: s.error, message: s.message };
    const head = headOf(s.repo, branch);
    if (!head) return { error: 'no-branch', message: `The ${labelOf(engine)} repo has no branch ${branch}.` };
    const mb = out(git(s.repo, 'merge-base', `refs/heads/${s.target}`, head));
    changed = mb ? changedPaths(s.repo, mb, head) : null;
    source = `${branch} at ${short(head)} against ${s.target}`;
  } else return { error: 'usage', message: 'Which batch? Pass --branch <name> or --paths a,b.' };
  return { engine, source, changed, selection: playSelection({ changed, cfg, full: false }) };
}
export function playPlanText(r) {
  const sel = r.selection;
  const lines = [`Play Mode plan for ${r.source}: ${sel.mode}${sel.mode === 'focus' ? ` with the filter ${sel.filter}` : ''}`, `  why: ${sel.why}`];
  if (sel.unmatched?.length) lines.push(`  paths no play.focus.map entry takes (${sel.unmatchedCount || sel.unmatched.length}): ${sel.unmatched.join(', ')}; add an entry for them (studio/game.json engines.${r.engine}.play.focus.map), or list them in play.focus.ignore`);
  if (sel.ignored?.length) lines.push(`  left out by play.focus.ignore: ${sel.ignored.slice(0, 5).join(', ')}${sel.ignored.length > 5 ? ', ...' : ''}`);
  if (sel.ignoreBad?.length) lines.push(`  not a valid regex (skipped): ${sel.ignoreBad.join(', ')}`);
  lines.push('  (a daily full land run always runs the whole Play Mode stage)');
  return lines.join('\n');
}

// ---- status ----

/** { queue, running, last } for `npm run task -- train status`. */
export function unityTrainStatus(root = mainRoot(), engine = 'unity') {
  return { engine, queue: readUnityQueue(root, engine), running: runningUnityTrain(root, engine), last: readJson(lastFile(root, engine)) };
}

/** Lines for people; '' when there is nothing to say and quiet is set. */
export function unityStatusText(root = mainRoot(), { quiet = false, engine = 'unity' } = {}) {
  const st = unityTrainStatus(root, engine);
  const L = labelOf(engine);
  if (quiet && !st.queue.length && !st.running) return '';
  const lines = [];
  // The running train's batch and the waiting queue are two lists: a queue entry whose task rides the running train is on the first only.
  const inTrain = new Set(st.running?.lanes || []);
  const waiting = st.queue.filter((e) => !inTrain.has(e.task));
  const row = (e) => `  ${e.task}  ${e.agent || '?'}  ${e.branch} at ${short(e.head)} (queued ${String(e.at).slice(0, 16)})${e.tag ? `  tag ${e.tag}` : ''}${e.alone ? '  alone' : ''}`;
  if (st.running?.lanes?.length) lines.push(`Running ${L} train batch (${st.running.lanes.length}): ${st.running.lanes.join(', ')}`);
  lines.push(waiting.length ? `${waiting.length} ${L} branch(es) wait in the queue for the next ${L} train (npm run task -- train --engine ${engine}):\n${waiting.map(row).join('\n')}` : `No ${L} branch waits for a ${L} train (task done <ID> --train on a ${L}-track task queues one).`);
  if (st.running) lines.push(`${L} train running: ${st.running.id} by ${st.running.by || '?'} (pid ${st.running.pid}, since ${new Date(st.running.at).toISOString().slice(11, 16)} UTC)${st.running.lanes?.length ? `, ${st.running.lanes.join(', ')}` : ''}${st.running.now ? `; now: ${st.running.now}` : ''}`);
  // 2.85 (B-137): the daily full run is said plainly while it runs.
  if (st.running?.full) lines.push(`This ${L} land run is the daily full run (${st.running.full.why}): every test runs, expect about ${st.running.full.minutes ? `${st.running.full.minutes} min` : 'the longest land run of the day'}.`);
  // 2.85: the tests the target itself fails in the full run (not counted against any branch).
  { const b = readFullBaseline(root, engine); if (b.failing.length) lines.push(`Known red on the target in the full run: ${b.failing.length} test(s): ${b.failing.slice(0, 3).join(', ')}${b.failing.length > 3 ? ', ...' : ''} (not counted against any branch; a fix task is wanted)`); }
  // Tags (how many wait per tag), why the running train's batch is what it is, and the automatic start.
  const tc = tagCounts(waiting);
  if (Object.keys(tc).length) lines.push(`Tagged ${L} lanes (only train --engine ${engine} --tag <tag> takes them; the automatic start never does): ${Object.entries(tc).map(([k, v]) => `${k} ${v} waiting`).join(', ')}; untagged ${waiting.filter((e) => !e.tag).length} waiting`);
  if (st.running?.batch) lines.push(`Running ${L} train's batch: ${st.running.batch}`);
  // 2.85: the last rules check: its mode and why (a full run names the unmapped paths), what it cost and how many parts ran at once.
  if (st.last?.rules?.ran && !st.running) lines.push(`Last ${L} rules check: ${st.last.rules.mode || 'full'}${st.last.rules.why ? `: ${st.last.rules.why}` : ''}; ${st.last.rules.runs ?? 0} run(s), ${Math.round((st.last.rules.ms || 0) / 1000)} s${st.last.rules.parts > 1 ? `, ${st.last.rules.parts} parts, ${st.last.rules.splitAtOnce || 1} at once` : ''}`);
  if (st.last && !st.running) lines.push(`Last ${L} train ${st.last.id} (${String(st.last.at || '').slice(0, 16)}): ${st.last.message}${st.last.batch ? ` [batch ${st.last.batch}]` : ''}`);
  if (!quiet) { try { lines.push(autoLine(root, engine)); } catch { /* the queue lines stand */ } }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'status' || !argv.length) {
    const root = mainRoot();
    const engine = argv.includes('--engine') ? argv[argv.indexOf('--engine') + 1] : 'unity';
    if (argv.includes('--json')) console.log(JSON.stringify(unityTrainStatus(root, engine), null, 2));
    else console.log(unityStatusText(root, { engine }));
    process.exit(0);
  }
  // `queue --task <ID> [--engine x] [--agent a] [--branch b] [--alone]`: queue a task's branch (what task done --train does after its checks).
  if (argv[0] === 'queue') {
    const fl = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
    const r = queueUnityTask(mainRoot(), { engine: fl('engine') || 'unity', task: fl('task'), agent: fl('agent') || null, branch: fl('branch') || null, alone: argv.includes('--alone') ? true : null, again: argv.includes('--again') });
    console.log(JSON.stringify({ ok: r.ok, message: r.message, error: r.error || null }));
    process.exit(r.ok ? 0 : 1);
  }
  // 2.85: `play-plan [--engine x] [--branch b | --paths a,b] [--json]`: what a batch's Play Mode stage would run, and why (read-only).
  if (argv[0] === 'play-plan') {
    const fl = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
    const r = playPlan(mainRoot(), { engine: fl('engine') || 'unity', branch: fl('branch'), paths: fl('paths') });
    if (argv.includes('--json')) console.log(JSON.stringify(r));
    else console.log(r.error ? r.message : playPlanText(r));
    process.exit(r.error ? 1 : 0);
  }
  console.error('Usage: node harness/unity-train.mjs status [--json] | queue --task <ID> [--again] | play-plan [--branch b | --paths a,b]   (npm run task -- train --unity runs a Unity train)');
  process.exit(1);
}
