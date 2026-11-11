#!/usr/bin/env node
/**
 * harness/unity-train.mjs — 2.63.0: the Unity merge train. Several Unity branches land on ONE run of the studio's
 * Unity land command, one train at a time, always under machine:heavy, so Unity builds never pile up.
 *
 * Before 2.63.0 the Unity gate (harness/unity-gate.mjs) landed one branch per `task done`: N porters finishing
 * together meant N Unity builds of 20-60+ min each, one after another. The train works like the web train
 * (harness/train.mjs) but never runs Unity itself and never touches the Unity repo's files:
 *
 *   1. `task done <ID> --train` on a task added with --track engine:unity runs every check task done runs before the
 *      Unity gate, then queues the task's Unity branch (--branch, else the Unity folder's current branch) in
 *      .studio/train/unity-queue.json. The branch must exist in the Unity repo and have commits its target lacks.
 *   2. `npm run task -- train --unity` takes the queue, oldest first (at most --max), reads each branch's head, and
 *      checks the branches against the target with `git merge-tree --write-tree` (objects only: no worktree, no
 *      index, no ref moved). One that conflicts with the target is handed back; one that conflicts only with a
 *      branch before it waits for the next train (it stays queued).
 *   3. ONE land run for the rest: a land command that takes a list ("landMany", or {branches} in "land") gets the
 *      branches in order. A land command that takes one {branch} gets one integration branch, unity-train/<id>, that
 *      the harness builds from refs only (merge-tree + commit-tree + a new branch ref: target + each branch in order,
 *      a fast-forward where it can be); the gate worktree is never touched: only the land script works there.
 *   4. Pass (exit 0): the target must now contain every branch's head (else nothing closes: an error, nobody blamed);
 *      each task closes (board, claim, events) as the web train closes its lanes.
 *   5. Red (1) or conflict (2): prefix bisection, as the web train's. The land command runs again on target + the
 *      first half, and so on (binary search: about log2 N more runs). A green prefix run LANDS that prefix (it is the
 *      land command: green on exactly that tree), so those tasks close; the first red prefix names the branch that
 *      breaks it, alone or only together with the branches before it (which landed). It is handed back with the run's
 *      last lines, and the branches after it train again (one more run).
 *   6. Refused (3: an editor open, too little memory, another landing, machine:heavy busy) or error (4, other, a
 *      timeout): nobody is blamed. A refusal is tried again (STUDIO_UNITY_TRAIN_RETRIES, 2, every
 *      STUDIO_UNITY_TRAIN_RETRY_MIN, 10 min); still refused, or an error: the train stops, its branches stay queued,
 *      and `npm run task -- train --unity` later runs it again. What landed before it stays landed and closed.
 *      2.73.2 (e, B-73): "not run" (the gate's status not-run: an infrastructure abort such as out of memory, the
 *      editor ended from outside, no licence, or free RAM under STUDIO_UNITY_MIN_FREE_GB) is handled as a refusal:
 *      tried again after STUDIO_UNITY_TRAIN_RETRY_MIN, then the branches stay queued; nobody is handed back as red.
 *
 * One Unity train at a time (.studio/locks/unity-train.lock; a dead holder's lock is taken over); every land run takes
 * machine:heavy (harness/unity-gate.mjs), as a landing (STUDIO_GATE_PRIORITY=landing). `npm run task -- train status`
 * shows the queue and the running train. This module never imports harness/task.mjs: the board comes in as `deps`.
 *
 *   node harness/unity-train.mjs status [--json] [--engine <name>]
 *
 * 2.77.0 (u, P5.2/P5.6): the train of ANY engine target (harness/engine-tracks.mjs): every function takes `engine`
 * (default unity, whose file names stay as they were). Engine <x>'s train has its own queue (.studio/train/<x>-queue.json),
 * lock (.studio/locks/<x>-train.lock), last result, integration refs (<x>-train/<id>), events (task.train.<x>.*) and land
 * command (studio/game.json engines.<x>), and runs beside the web train and every other engine's: they compete only for
 * machine:heavy (and its RAM floor), which the Line Producer schedules (harness/line-producer.mjs enginePass).
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
import { engineTarget, engineFiles, engineTask } from './engine-tracks.mjs';
import { recordEngineShots } from './engine-shots.mjs';
import { writeAtomic, readJson } from './fsafe.mjs';
import { rulesConfig, rulesGate, inputsPrint, shareInputs } from './engine-rules.mjs';
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

// ---- settings ---------------------------------------------------------------------------------------

const isRepo = (dir) => Boolean(dir) && fs.existsSync(dir) && git(dir, 'rev-parse', '--git-dir').status === 0;

/**
 * The Unity repo the harness reads refs in: engines.unity.gateWorktree, else the Unity track's folder, else
 * engines.unity.cwd (each relative to the studio). Only ref and object commands run there (rev-parse, merge-base,
 * merge-tree --write-tree, commit-tree, update-ref): never checkout, merge, reset or clean.
 */
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
 * 2.79 (e): the engine config's "preLand" command for one lane, before the long land run: run in a throwaway checkout of
 * the engine repo at the lane's commit (never the land script's own worktree), with STUDIO_LANE_COMMIT, STUDIO_LANE_DIR
 * and STUDIO_ENGINE_REPO set. { ok: true } | { ok: false, why } (the command exited non-zero: its last lines) |
 * { error } (could not be run: nobody is blamed).
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

// ---- the queue ----------------------------------------------------------------------------------------

export function readUnityQueue(root = mainRoot(), engine = 'unity') {
  const q = readJson(queueFile(root, engine));
  return Array.isArray(q) ? q : [];
}
const withQueue = (root, fn, engine = 'unity') => withLandLock(root, () => { const q = readUnityQueue(root, engine); const r = fn(q); writeJson(queueFile(root, engine), q); return r; }, { name: `${engine}-train-queue`, waitMs: 30000 });
export const dequeueUnity = (root, task, engine = 'unity') => withQueue(root, (q) => { const i = q.findIndex((e) => e.task === task); if (i >= 0) q.splice(i, 1); return i >= 0; }, engine);

/**
 * Queue a Unity-track task's branch (task done <ID> --train, after its checks). { ok, entry, message } or
 * { ok: false, error, message }. The branch: `branch`, else the task's recorded Unity branch, else the Unity folder's
 * current branch (never the target).
 */
export function queueUnityTask(root, { engine = 'unity', task, agent = null, branch = null, note = '', alone = null } = {}) {
  const s = unityTrainSettings(root, engine);
  const L = labelOf(engine);
  const UNITY_REF_PREFIX = refPrefix(engine);
  if (s.error) return { ok: false, error: s.error, message: `${task} was not queued. ${s.message}` };
  // 2.60.1 (B-41) with the train: --branch, else the task's recorded Unity branch (task add --branch, unity-gate branch),
  // else the Unity folder's current branch (refused below when it is the target itself).
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
  const entry = withQueue(root, (q) => {
    const i = q.findIndex((e) => e.task === task);
    // 2.83: a branch that must land alone (task done --train --alone, or the task's record: task alone <ID> on).
    const solo = alone === null || alone === undefined ? Boolean((() => { try { return engineTask(task, { root })?.alone; } catch { return false; } })() || (i >= 0 && q[i].alone)) : Boolean(alone);
    const rec = { task, agent, branch: br, head, note: note || '', at: new Date().toISOString(), ...(solo ? { alone: true } : {}) };
    if (i >= 0) q.splice(i, 1, { ...rec, at: q[i].at });
    else q.push(rec);
    return rec;
  }, engine);
  evTop('queued', 'queue', `${task}: ${br} at ${short(head)} waits for the next ${L} train${entry.alone ? ' (it lands alone)' : ''}`, { engine, agent: agent || `${engine}-train`, task, to: 'producer', meta: { branch: br, head, ...(entry.alone ? { alone: true } : {}) } });
  // 2.83: the lane's new shared input files (engines.<x>.rules.share: content-addressed files a lane adds, git-ignored)
  // go to the engine's input folder now, so the rules check and the land run find them. Never overwrites.
  try { shareLaneInputs(root, engine, s, task, (m) => console.error(m)); } catch { /* the train tries again */ }
  return { ok: true, entry, message: `${task} is checked and its ${L} branch ${br} (at ${short(head)}, ${ahead} commit(s) ahead of ${s.target}) is queued for the next ${L} train. npm run task -- train --engine ${engine} lands every queued branch on ONE land run (the Line Producer starts it in a quiet window); until then the task stays in progress.` };
}

/** 2.83: copy a lane's new shared input files (rules.share) into the engine's input folder. { copied, skipped } | null. */
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

/** 2.83: the stage a red land run failed in first (from its stage report), or null when it reported none. */
export const firstRedStage = (r) => (Array.isArray(r?.stages) ? (r.stages.find((x) => x && x.name && !/^(pass|passed|ok|skip|skipped)$/i.test(String(x.status || ''))) || {}).name || null : null);

/**
 * 2.83: the stages a red land run is tried once more for before anyone is blamed: engines.<x>.retryStages (a list), or
 * STUDIO_ENGINE_RETRY_STAGES (comma-separated; off: none); for Unity, "play" when neither is set (its Play Mode tests
 * wait on frames and time, and failed under load on lanes that passed alone).
 */
export function retryStagesOf(cfg = {}, env = process.env, engine = 'unity') {
  const raw = String(env.STUDIO_ENGINE_RETRY_STAGES ?? '').trim();
  if (raw) return /^(off|0|false|no|none)$/i.test(raw) ? [] : raw.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (Array.isArray(cfg.retryStages)) return cfg.retryStages.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  return engine === 'unity' ? ['play'] : [];
}

/**
 * 2.83: blame by evidence. For a red batch whose failing tests are named: which lanes change a file that names a
 * failing test's class (the test itself, or the code it is named after)? [{ lane, tests: [names], files: [paths] }].
 * Reads refs only (git diff, git grep on the lane's head). A lane with too many changed files, or a test name with no
 * usable class, yields no evidence: the caller then searches as before.
 */
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

/** 2.83: the last full land run that passed ({ at, id } or null), and whether one is due (STUDIO_ENGINE_FULL_LAND_HOURS, 24; 0 or off: never). */
const fullLandFile = (root, engine) => path.join(root, '.studio', 'engine', `${engine}-full-land.json`);
export function fullLandDue(root, engine, cfg = {}, env = process.env, now = Date.now()) {
  const raw = String(env.STUDIO_ENGINE_FULL_LAND_HOURS ?? cfg.fullLandHours ?? '').trim();
  if (/^(off|false|no)$/i.test(raw)) return '';
  const h = raw === '' ? 24 : Number(raw);
  if (!Number.isFinite(h) || h <= 0) return '';
  const at = Date.parse(readJson(fullLandFile(root, engine))?.at || '');
  if (!Number.isFinite(at)) return 'no full land run is recorded yet';
  return now - at >= h * 3600000 ? `the last full land run that passed is older than ${h} h` : '';
}

/**
 * 2.83: does the land command run a script that differs from the target branch's copy of it? A crew landed a change to
 * its land script and nothing changed: the command ran the script from another worktree, on another branch.
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
      const common = (d) => { const c = out(git(d, 'rev-parse', '--git-common-dir')); return c ? fs.realpathSync(path.resolve(d, c)) : ''; };
      if (!common(dir) || common(dir) !== common(s.repo)) continue;
      const rel = path.relative(fs.realpathSync(top), fs.realpathSync(file)).split(path.sep).join('/');
      const want = out(git(s.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${s.target}:${rel}`));
      const have = out(git(dir, 'hash-object', '--', file));
      if (!want) return { file, rel, branch: out(git(dir, 'symbolic-ref', '--short', '-q', 'HEAD')) || 'a detached HEAD', missing: true };
      if (have && have !== want) return { file, rel, branch: out(git(dir, 'symbolic-ref', '--short', '-q', 'HEAD')) || 'a detached HEAD' };
      return null;
    }
  } catch { /* a warning only */ }
  return null;
}

// ---- one Unity train at a time ----------------------------------------------------------------------------

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

// ---- integration from refs only ------------------------------------------------------------------------

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
    else res.conflictTarget.push({ ...lane, files: conflictFiles(alone.stdout), why: `it conflicts with the target${conflictFiles(alone.stdout).length ? ` in ${conflictFiles(alone.stdout).slice(0, 5).join(', ')}` : ''}: merge the target into it, resolve the conflicts, commit, then task done --train again` });
  }
  return { ...res, head: tip };
}

// ---- the train ---------------------------------------------------------------------------------------------

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
  if (!opts.dryRun && deps.waitForDrain) {
    const w = await deps.waitForDrain();
    if (!w.ok) return { ...empty, ok: false, message: w.message };
  }
  // 2.78.1 (f): the lock names its engine and the RAM a land run takes, so room for builders counts it between runs
  // (heavy-budget.mjs engineTrainReserve).
  const rigRam = Number(engineTarget(engine)?.rig?.ramGb) || null;
  const locked = await withUnityTrainLock(root, { id, by, lanes: [], engine, ...(rigRam ? { ramGb: rigRam } : {}) }, (update) => unityTrainBody({ ...opts, engine, root, log, deps, id, by, s, update }), { waitMs: opts.waitMs ?? 0, log, engine });
  if (locked?.busy) return { ...empty, ok: false, busy: locked.busy, message: `Another ${L} train is running (${locked.busy.id || '?'}, by ${locked.busy.by || '?'}, pid ${locked.busy.pid || '?'}); one ${L} train at a time: run this again when it ends (npm run task -- train status shows it).` };
  return locked;
}

async function unityTrainBody({ engine = 'unity', root, log, deps, id, by, s, update, max = 0, dryRun = false, env = process.env }) {
  const res = { ok: true, id, engine, landed: [], dropped: [], deferred: [], runs: 0, message: '' };
  const L = labelOf(engine);
  const UNITY_REF_PREFIX = refPrefix(engine);
  const ev = (type, idd, msg, extra = {}) => evTop(type, idd, msg, { engine, ...extra });
  const { repo, target } = s;
  // Integration refs a killed train left (only while holding the train lock).
  for (const r of out(git(repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${UNITY_REF_PREFIX}`)).split('\n').filter(Boolean)) git(repo, 'update-ref', '-d', r);
  let lanes = readUnityQueue(root, engine);
  if (Number(max) > 0) lanes = lanes.slice(0, Number(max));
  if (!lanes.length) { res.message = `No ${L} branch is waiting to land (task done <ID> --train on a ${L}-track task queues one).`; return finish(); }
  // 2.83: a branch marked "alone" (a change that must be judged by itself, like switching a system over) rides by
  // itself: first in the queue, it is this train's whole batch; further back, this train stops before it.
  const soloAt = lanes.findIndex((l) => l.alone);
  if (soloAt === 0 && lanes.length > 1) { log(`[unity-train] ${id}: ${lanes[0].task} lands alone; ${lanes.length - 1} other branch(es) wait for the next ${L} train`); res.alone = lanes[0].task; lanes = [lanes[0]]; }
  else if (soloAt > 0) { log(`[unity-train] ${id}: ${lanes[soloAt].task} lands alone, on the next ${L} train; this one takes the ${soloAt} branch(es) before it`); lanes = lanes.slice(0, soloAt); }
  else if (soloAt === 0) res.alone = lanes[0].task;
  const live = new Set(lanes.map((l) => l.task));
  const liveNow = () => { try { update({ lanes: [...live] }); } catch { /* the status line only */ } };
  if (!dryRun) {
    const sd = landScriptDrift(s, root);
    if (sd) { res.landScript = sd; const m = `the land command runs ${sd.file.split(path.sep).join('/')} (on ${sd.branch}), ${sd.missing ? `which ${target} does not have` : `which differs from ${target}'s copy of ${sd.rel}`}: a change landed to that script is not in use until that folder is updated`; log(`[unity-train] ${id}: WARNING: ${m}`); ev('land_script', id, m, { agent: by, to: 'producer', status: 'warn', meta: { file: sd.rel, branch: sd.branch } }); }
  }
  update({ lanes: lanes.map((l) => l.task), now: 'checking the branches' });
  ev('start', id, `${lanes.length} branch(es): ${lanes.map((l) => `${l.task} (${l.branch})`).join(', ')}${dryRun ? ' (dry run)' : ''}`, { agent: by, meta: { lanes: lanes.map((l) => l.task), dryRun } });

  const drop = (lane, why, { handBack = true, cause = null } = {}) => {
    res.dropped.push({ task: lane.task, why, ...(cause ? { cause } : {}) });
    if (dryRun) return;
    try { dequeueUnity(root, lane.task, engine); } catch {}
    // 2.83: handed back means out of this train now: its fix can start at once, not after the train's remaining runs.
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
  for (const l of pre.conflictTarget) drop(l, l.why);
  for (const l of pre.deferred) defer(l, l.why);
  for (const l of pre.already) drop(l, `${l.branch} is already in ${target}; task done ${l.task} closes it`, { handBack: false });
  let set = pre.included;
  if (dryRun) { res.message = `Dry run: ${set.length} branch(es) would land on ONE ${L} land run (${set.map((l) => l.task).join(', ') || 'none'}) on ${target} at ${short(tip0)}${s.many ? ' (the land command takes the list)' : set.length > 1 ? ` (through one integration branch, ${UNITY_REF_PREFIX}${id})` : ''}; ${summary(res)}`; return finish(); }
  // 2.79 (e): the engine's per-lane pre-land check (engines.<x>.preLand), before the long land run: a lane that fails it is
  // handed back with cause 'precheck' (not a red land run); a check that can't run defers the lane (nobody is blamed).
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
  // 2.82: the rules check on the batch as it would land (harness/engine-rules.mjs), before the long land run. A lane that
  // turns the batch red is handed back with cause 'rules' and its failing tests; a check that is red on the target itself
  // judges nobody. The land run then gets STUDIO_RULES_GREEN=1 while it lands exactly the checked batch on the checked target
  // with the checked inputs (the git-ignored files the tests read are looked at again right before the land run).
  let rulesGreen = null;
  {
    const rc = (() => { try { return rulesConfig(engine, { root, env, repo, ref: target }); } catch { return null; } })();
    if (rc && set.length) {
      update({ now: `rules check: ${set.map((l) => l.task).join(', ')}` });
      const from = [...new Set([s.folder, s.cfg.gateWorktree ? path.resolve(root, s.cfg.gateWorktree) : null, s.cfg.cwd ? path.resolve(root, s.cfg.cwd) : null, repo].filter(Boolean))];
      // 2.83: each lane's new shared input files first (rules.share), and the lanes' own folders as further input sources.
      for (const l of set) { try { shareLaneInputs(root, engine, s, l.task, log); } catch { /* the check says what is missing */ } }
      const extraFrom = set.map((l) => path.join(root, '.lanes', 'engine', String(l.task))).filter((d) => fs.existsSync(d));
      const rg = (deps.rulesGate || rulesGate)({ engine, repo, tip: tip0, lanes: set, cfg: rc, from, extraFrom, root, id, env, log, chain: (t, ls) => chainOnTarget(repo, t, ls, id, engine) });
      log(`[unity-train] ${id}: rules check: ${rg.why}${rg.runs ? ` (${rg.runs} run(s), ${Math.round(rg.ms / 1000)} s)` : ''}`);
      for (const d of rg.dropped) drop(d.lane, `refused before the land run: ${d.why}\nFix it on ${d.lane.branch} (merge ${target} in first), then task done ${d.lane.task} --train again.`, { cause: 'rules' });
      set = rg.kept;
      res.rules = { ran: rg.ran, runs: rg.runs, ms: rg.ms, dropped: rg.dropped.map((d) => d.lane.task), ...(rg.skipped ? { skipped: rg.why } : {}), ...(rg.mode ? { mode: rg.mode } : {}), ...(rg.filter ? { filter: rg.filter } : {}) };
      if (rg.green) rulesGreen = { tip: tip0, tasks: set.map((l) => l.task).join(','), mode: rg.mode || 'full', same: () => { try { return inputsPrint(rc, [...from, ...extraFrom]) === (rg.inputs ?? inputsPrint(rc, [...from, ...extraFrom])); } catch { return false; } } };
    }
  }
  for (const l of set) deps.markRunning?.(l.task, l.agent);
  const retries = Math.max(0, num(env.STUDIO_UNITY_TRAIN_RETRIES ?? s.cfg.trainRetries, 2));
  const retryMs = Math.max(0, num(env.STUDIO_UNITY_TRAIN_RETRY_MIN ?? s.cfg.trainRetryMin, 10) * 60000);

  /** One land run of `group` on the target as it is now (refused runs tried again). The gate's result, checked. */
  const landGroup = async (group, what) => {
    const tip = headOf(repo, target);
    let arg;
    let ref = null;
    if (s.many) arg = { branches: group.map((l) => l.branch) };
    else if (group.length === 1) arg = { branch: group[0].branch };
    else {
      const c = chainOnTarget(repo, tip, group, id, engine);
      if (c.error) return { status: 'error', why: c.error };
      const bad = [...c.conflictTarget, ...c.deferred][0];
      if (bad) return { status: 'conflict', why: bad.why, lane: bad };
      ref = `${UNITY_REF_PREFIX}${id}`;
      if (git(repo, 'update-ref', `refs/heads/${ref}`, c.head, '').status !== 0) return { status: 'error', why: `could not make the integration branch ${ref}` };
      arg = { branch: ref };
    }
    let r = null;
    try {
      for (let a = 0; ; a += 1) {
        update({ now: `${what}: ${group.map((l) => l.task).join(', ')}${a ? ` (try ${a + 1})` : ''}`, runs: res.runs + 1 });
        log(`[unity-train] ${id}: ${what}: land ${group.map((l) => `${l.task} (${l.branch})`).join(', ')} on ${target} at ${short(tip)}${ref ? ` through ${ref}` : ''}`);
        const checked = rulesGreen && rulesGreen.tip === tip && rulesGreen.tasks === group.map((l) => l.task).join(',') && rulesGreen.same();
        // 2.83: once a day (STUDIO_ENGINE_FULL_LAND_HOURS) a land run is told nothing that lets it skip its own tests:
        // no STUDIO_RULES_GREEN, no Edit Mode plan, and STUDIO_LAND_FULL=1. The shortcuts rest on tests run outside the
        // editor; this run is the one that would see a difference between the two runtimes.
        const fullWhy = fullLandDue(root, engine, s.cfg, env);
        if (fullWhy) log(`[unity-train] ${id}: a full land run (${fullWhy}): the land command is not told the rules are green and gets no Edit Mode plan`);
        r = await (deps.land || runUnityGate)({ engine, ...arg, task: group.map((l) => l.task).join(','), label: `${engine} train ${id} (${group.map((l) => l.task).join(', ')})`, env: { ...env, STUDIO_GATE_PRIORITY: 'landing', ...(fullWhy ? { STUDIO_LAND_FULL: '1' } : checked ? { STUDIO_RULES_GREEN: '1', STUDIO_RULES_MODE: rulesGreen.mode } : {}) }, log });
        res.runs += 1;
        if (fullWhy) { res.fullLand = (res.fullLand || 0) + 1; if (r.status === 'pass') { try { fs.mkdirSync(path.dirname(fullLandFile(root, engine)), { recursive: true }); writeJson(fullLandFile(root, engine), { at: new Date().toISOString(), id }); } catch { /* it is due again next time */ } } }
        if ((r.status !== 'refused' && r.status !== 'not-run') || a >= retries) break;
        log(`[unity-train] ${id}: the land command ${r.status === 'not-run' ? 'did not run' : 'refused'} (${r.why}); nobody is blamed; trying again in ${Math.round(retryMs / 1000)} s (${a + 1} of ${retries} retries)`);
        update({ now: `waiting after a refusal (${r.why.slice(0, 120)})` });
        sleep(retryMs);
      }
    } finally {
      if (ref) git(repo, 'update-ref', '-d', `refs/heads/${ref}`);
    }
    if (r.status === 'pass') {
      const now = headOf(repo, target);
      const missing = group.filter((l) => !isAncestor(repo, l.head, now));
      if (missing.length) return { ...r, status: 'error', ok: false, why: `the land command said pass, but ${target} (now ${short(now)}) doesn't contain ${missing.map((l) => `${l.branch} at ${short(l.head)}`).join(', ')}: nothing was closed` };
      return { ...r, newTip: now };
    }
    return r;
  };
  const shotJobs = [];
  const close = (group, r) => {
    for (const lane of group) {
      const c = deps.close ? deps.close(lane, { train: id, head: r.newTip, repo, target }) : { ok: true };
      if (c?.ok === false) { ev('close_failed', id, `${lane.task} landed but couldn't be closed: ${c.message}`, { task: lane.task, agent: by, to: 'producer', status: 'warn' }); res.unclosed = [...(res.unclosed || []), { task: lane.task, why: c.message }]; }
      try { dequeueUnity(root, lane.task, engine); } catch {}
      res.landed.push(lane.task);
      live.delete(lane.task);
      // 2.83: a landed lane's engine worktree is removed (kept, with the reason, when anything unlanded is in it).
      if (!dryRun && !/^(off|0|false|no)$/i.test(String(env.STUDIO_ENGINE_LANE_CLEAN || ''))) { try { const rm = removeLandedLane({ root, engine, task: lane.task, log }); if (rm && !rm.removed && rm.why && rm.dir) log(`[unity-train] ${id}: kept ${lane.task}'s engine worktree: ${rm.why}`); } catch (e) { log(`[unity-train] ${id}: could not clean ${lane.task}'s engine worktree: ${e.message}`); } }
    }
    liveNow();
    // 2.83: old gate builds are pruned (engines.<x>.builds; absent: nothing is touched).
    if (!dryRun) { try { const bc = buildsConfig(engine, { root, env }); if (bc) { const pb = pruneBuilds({ ...bc, root, log }); if (pb?.removed?.length) log(`[unity-train] ${id}: pruned ${pb.removed.length} old build(s) in ${String(bc.dir).split(path.sep).join('/')}; kept ${pb.kept.length}`); } } catch (e) { log(`[unity-train] ${id}: could not prune old builds: ${e.message}`); } }
    // 2.79 (e): before/after pictures of a green land (engines.<x>.shots); no shots: nothing happens.
    if (typeof s.cfg.shots === 'string' && s.cfg.shots.trim() && !dryRun) {
      const base = s.cfg.cwd ? path.resolve(root, s.cfg.cwd) : s.folder;
      try { shotJobs.push(recordEngineShots({ root, engine, tasks: group.map((l) => l.task), shotsDir: path.resolve(base, s.cfg.shots), deps: deps.shots || {} }).then((x) => { if (x) log(`[unity-train] ${id}: before/after shots: ${x.pages.join(', ')}`); }).catch((e) => log(`[unity-train] ${id}: before/after shots failed: ${e.message}`))); } catch (e) { log(`[unity-train] ${id}: before/after shots failed: ${e.message}`); }
    }
    ev('landed', id, `${target} moved to ${short(r.newTip)} on one land run: ${group.map((l) => l.task).join(', ')}`, { agent: by, status: 'ok', meta: { head: r.newTip, lanes: group.map((l) => l.task) } });
  };
  /** Refused or error: nobody is blamed, every branch left waits (stays queued). */
  const hold = (group, r) => {
    if (r.status === 'refused') res.refused = { at: new Date().toISOString(), why: r.why };
    // 2.73.2 (e, B-73): an infrastructure abort: not run, not red; the branches wait for the next train.
    if (r.status === 'not-run') res.notRun = { at: new Date().toISOString(), why: r.why, kind: r.infra?.kind || null };
    res.ok = false;
    for (const l of group) defer(l, r.status === 'refused' ? `the land command refused (${r.why}); not a failure of the work: the next ${L} train tries again` : r.status === 'not-run' ? `${r.why.startsWith('not run') ? r.why : `not run: ${r.why}`}; the next ${L} train tries again` : `the land command failed to run (${r.why}); nobody is blamed: fix it, then run npm run task -- train --engine ${engine}`);
    ev(r.status === 'refused' ? 'refused' : r.status === 'not-run' ? 'not_run' : 'error', id, `${r.status}: ${r.why}; ${group.map((l) => l.task).join(', ')} stay queued, nobody is handed back`, { agent: by, to: 'producer', status: r.status === 'refused' || r.status === 'not-run' ? 'warn' : 'blocked', meta: { status: r.status, log: r.log, ...(r.infra ? { infra: r.infra.kind } : {}) } });
  };
  const blame = (r) => `${r.status === 'conflict' ? 'the land command found a merge conflict' : 'the land command is red'}: ${r.why}${r.tail ? `\n${r.tail.split('\n').map((x) => `  ${x}`).join('\n')}` : ''}\nIts log: ${r.log || '.studio/gates/out/unity.log'}.`;

  try {
    let remaining = set;
    let rounds = 0;
    const again = retryStagesOf(s.cfg, env, engine);
    let retried = false;
    while (remaining.length && rounds++ <= set.length + 2) {
      let r = await landGroup(remaining, 'land run');
      if (r.status === 'pass') { close(remaining, r); break; }
      // 2.83: one more run before anyone is blamed, when the red is in a stage known to fail under load (retryStagesOf).
      // A crew's Play Mode failed on batches that only added files, passed alone and passed on the next run; the search
      // that followed handed back a lane that was never run by itself.
      const stage0 = r.status === 'red' ? firstRedStage(r) : null;
      if (stage0 && !retried && again.includes(String(stage0).toLowerCase())) {
        retried = true;
        ev('retry', id, `red in ${stage0} (${(r.failures || []).slice(0, 3).join(', ') || 'no test named'}): one more run of ${remaining.map((l) => l.task).join(', ')} before anyone is blamed`, { agent: by, meta: { stage: stage0, failures: (r.failures || []).slice(0, 10) } });
        const r2 = await landGroup(remaining, `land run again (red in ${stage0})`);
        if (r2.status === 'pass') {
          res.flaky = [...(res.flaky || []), { stage: stage0, failures: (r.failures || []).slice(0, 10) }];
          ev('flaky', id, `the same batch passed on the second run: ${stage0} failed the first time (${(r.failures || []).slice(0, 3).join(', ') || 'no test named'}); nobody is handed back. A test that fails under load is the game's to fix`, { agent: by, to: 'producer', status: 'warn', meta: { stage: stage0, failures: (r.failures || []).slice(0, 10), lanes: remaining.map((l) => l.task) } });
          close(remaining, r2); break;
        }
        r = r2;
      }
      if (r.status !== 'red' && r.status !== 'conflict') { hold(remaining, r); break; }
      if (r.lane) { drop(r.lane, r.lane.why); remaining = remaining.filter((l) => l.task !== r.lane.task); continue; }
      // 2.83: blame by evidence, before any search by land runs. When the failing tests are named and exactly one lane
      // of the batch changes a file naming their classes, the batch is run without that lane: green lands the rest on
      // one run and hands that lane back with the evidence; red means the evidence was wrong and the search goes on.
      if (r.status === 'red' && remaining.length > 1 && Array.isArray(r.failures) && r.failures.length && !/^(off|0|false|no)$/i.test(String(env.STUDIO_ENGINE_BLAME_EVIDENCE || ''))) {
        let sus = [];
        try { sus = suspectsOf({ repo, tip: headOf(repo, target), lanes: remaining, failures: r.failures }); } catch { sus = []; }
        if (sus.length === 1 && sus[0].tests.length === Math.min(r.failures.length, 20)) {
          const sp = sus[0];
          const rest = remaining.filter((l) => l.task !== sp.lane.task);
          ev('evidence', id, `${sp.lane.task} is the only branch that changes files naming the failing test(s) (${sp.tests.slice(0, 3).join(', ')}: ${sp.files.slice(0, 3).join(', ')}): running ${rest.map((l) => l.task).join(', ')} without it`, { agent: by, meta: { suspect: sp.lane.task, tests: sp.tests.slice(0, 10), files: sp.files } });
          const rr = await landGroup(rest, `without ${sp.lane.task}`);
          if (rr.status === 'pass') {
            close(rest, rr);
            drop(sp.lane, `${blame(r)}\nBlame by evidence: the batch was red on ${sp.tests.slice(0, 5).join(', ')}, which ${sp.lane.branch} changes (${sp.files.slice(0, 4).join(', ')}), and the batch without it landed green (${rest.map((l) => l.task).join(', ')}). Fix it on ${sp.lane.branch} (merge ${target} in first), then task done ${sp.lane.task} --train again.`, { cause: 'evidence' });
            remaining = []; break;
          }
          if (rr.status !== 'red' && rr.status !== 'conflict') { hold(remaining, rr); break; }
          log(`[unity-train] ${id}: the batch without ${sp.lane.task} is ${rr.status} too: the evidence did not hold; searching by land runs`);
        }
      }
      if (remaining.length === 1) { drop(remaining[0], `${blame(r)}\nFix it on ${remaining[0].branch}, then task done ${remaining[0].task} --train again.`); break; }
      // Prefix bisection: the smallest k with target + the first k branches not green. Green prefixes land.
      // 2.79 (e): the batch's failure signature (the failing test names the red run printed). A red subset whose failures
      // are the same names or a subset of them reproduces the batch's failure, so the culprit is in it: the search narrows
      // there and stops after STUDIO_ENGINE_BISECT_MAX runs (3), handing back the lanes still in the red range, instead of
      // re-running every subset (25-30 min each). No readable names: today's full search.
      const sig = Array.isArray(r.failures) && r.failures.length ? new Set(r.failures) : null;
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
        ev('bisect', id, `${steps.map((st) => `${target} + ${remaining.slice(0, st.n).map((l) => l.task).join(' + ')}: ${st.status}${st.signature ? ' (the batch\'s failures)' : ''}`).join(', ')}; stopped after ${bisectRuns} bisect run(s) (STUDIO_ENGINE_BISECT_MAX): ${group.map((l) => l.task).join(', ')} still fail${before.length ? `, ${before.join(' + ')} landed green` : ''}`, { agent: by, meta: { steps, culprits: group.map((l) => l.task), capped: true } });
        for (const g of group) drop(g, `${blame(bad)}\nThe ${L} train's bisect stopped after ${bisectRuns} run(s) (STUDIO_ENGINE_BISECT_MAX ${bisectMax}): ${target} + ${[...before, ...group.map((l) => l.task)].join(' + ')} still shows the batch's failures (${[...sig].slice(0, 5).join(', ')}${sig.size > 5 ? ', ...' : ''}), so one of ${group.map((l) => l.branch).join(', ')} breaks it${before.length ? `; ${target} + ${before.join(' + ')} landed green` : ''}. Fix it on its branch (merge ${target} in first), then task done <ID> --train again.`);
        remaining = remaining.slice(hi);
        continue;
      }
      const culprit = remaining[hi - 1];
      // 2.83: no blame by elimination. When the last red run was not a run of this lane by itself on the target as it
      // is now, it is run once by itself: green lands it (the red was the batch's, or a flake), red is its own evidence.
      if (!(badGroup.length === 1 && badGroup[0].task === culprit.task)) {
        const rc = await landGroup([culprit], `confirm ${culprit.task}`);
        if (rc.status === 'pass') {
          ev('bisect', id, `${steps.map((st) => `${target} + ${remaining.slice(0, st.n).map((l) => l.task).join(' + ')}: ${st.status}`).join(', ')}; ${culprit.task} was the one left, and it passed by itself: landed, nobody is handed back`, { agent: by, meta: { steps, confirmed: culprit.task, passedAlone: true } });
          close([culprit], rc);
          remaining = remaining.slice(hi);
          continue;
        }
        if (rc.status !== 'red' && rc.status !== 'conflict') { hold(remaining.slice(hi - 1), rc); break; }
        bad = rc;
      }
      const before = remaining.slice(0, hi - 1).map((l) => l.task);
      ev('bisect', id, `${steps.map((st) => `${target} + ${remaining.slice(0, st.n).map((l) => l.task).join(' + ')}: ${st.status}`).join(', ')}; first not green with ${culprit.task}`, { agent: by, meta: { steps, culprit: culprit.task } });
      drop(culprit, `${blame(bad)}\nThe ${L} train's prefix bisection: ${target} + ${[...before, culprit.task].join(' + ')} is ${bad.status}${before.length ? `, ${target} + ${before.join(' + ')} landed green` : ''}; so ${culprit.branch} breaks it${before.length ? ' (alone, or together with the branches before it)' : ''}. Fix it on ${culprit.branch} (merge ${target} in first), then task done ${culprit.task} --train again.`);
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
    ev('done', id, res.message, { agent: by, status: res.landed.length ? 'ok' : 'warn', meta: { landed: res.landed, dropped: res.dropped.map((d) => d.task), deferred: res.deferred.map((d) => d.task), runs: res.runs, refused: Boolean(res.refused), notRun: Boolean(res.notRun) } });
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

// ---- status ------------------------------------------------------------------------------------------------

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
  // 2.83: the running train's batch and the waiting queue are two lists: a branch queued again while its train runs showed
  // as "No Unity branch waits". A queue entry whose task rides the running train is marked, not hidden.
  const inTrain = new Set(st.running?.lanes || []);
  const row = (e) => `  ${e.task}  ${e.agent || '?'}  ${e.branch} at ${short(e.head)} (queued ${String(e.at).slice(0, 16)})${inTrain.has(e.task) ? '  (also in the running train)' : ''}`;
  if (st.running?.lanes?.length) lines.push(`Running ${L} train batch (${st.running.lanes.length}): ${st.running.lanes.join(', ')}`);
  lines.push(st.queue.length ? `${st.queue.length} ${L} branch(es) wait in the queue for the next ${L} train (npm run task -- train --engine ${engine}):\n${st.queue.map(row).join('\n')}` : `No ${L} branch waits for a ${L} train (task done <ID> --train on a ${L}-track task queues one).`);
  if (st.running) lines.push(`${L} train running: ${st.running.id} by ${st.running.by || '?'} (pid ${st.running.pid}, since ${new Date(st.running.at).toISOString().slice(11, 16)} UTC)${st.running.lanes?.length ? `, ${st.running.lanes.join(', ')}` : ''}${st.running.now ? `; now: ${st.running.now}` : ''}`);
  if (st.last && !st.running) lines.push(`Last ${L} train ${st.last.id} (${String(st.last.at || '').slice(0, 16)}): ${st.last.message}`);
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
  // 2.83: `queue --task <ID> [--engine x] [--agent a] [--branch b] [--alone]`: queue a task's branch (what task done --train does after its checks).
  if (argv[0] === 'queue') {
    const fl = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
    const r = queueUnityTask(mainRoot(), { engine: fl('engine') || 'unity', task: fl('task'), agent: fl('agent') || null, branch: fl('branch') || null, alone: argv.includes('--alone') ? true : null });
    console.log(JSON.stringify({ ok: r.ok, message: r.message, error: r.error || null }));
    process.exit(r.ok ? 0 : 1);
  }
  console.error('Usage: node harness/unity-train.mjs status [--json]   (npm run task -- train --unity runs a Unity train)');
  process.exit(1);
}
