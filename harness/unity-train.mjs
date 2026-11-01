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
 *
 * One Unity train at a time (.studio/locks/unity-train.lock; a dead holder's lock is taken over); every land run takes
 * machine:heavy (harness/unity-gate.mjs), as a landing (STUDIO_GATE_PRIORITY=landing). `npm run task -- train status`
 * shows the queue and the running train. This module never imports harness/task.mjs: the board comes in as `deps`.
 *
 *   node harness/unity-train.mjs status [--json]
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

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`); fs.renameSync(tmp, f); };
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const short = (s) => String(s || '').slice(0, 8);
const ev = (type, id, msg, extra = {}) => { try { emitEvent({ type: `task.train.unity.${type}`, agent: extra.agent || 'unity-train', task: extra.task, to: extra.to, status: extra.status, track: 'engine:unity', msg: `Unity train ${id}: ${msg}`.slice(0, 600), meta: { train: id, ...(extra.meta || {}) } }); } catch {} };

export const UNITY_REF_PREFIX = 'unity-train/';
const queueFile = (root) => path.join(root, '.studio', 'train', 'unity-queue.json');
const lastFile = (root) => path.join(root, '.studio', 'train', 'unity-last.json');
const lockFile = (root) => path.join(root, '.studio', 'locks', 'unity-train.lock');

// ---- settings ---------------------------------------------------------------------------------------

const isRepo = (dir) => Boolean(dir) && fs.existsSync(dir) && git(dir, 'rev-parse', '--git-dir').status === 0;

/**
 * The Unity repo the harness reads refs in: engines.unity.gateWorktree, else the Unity track's folder, else
 * engines.unity.cwd (each relative to the studio). Only ref and object commands run there (rev-parse, merge-base,
 * merge-tree --write-tree, commit-tree, update-ref): never checkout, merge, reset or clean.
 */
export function unityRepo(cfg, root = REPO_ROOT) {
  const track = unityTrack();
  for (const d of [cfg?.gateWorktree, track?.folder, cfg?.cwd]) {
    if (typeof d !== 'string' || !d.trim()) continue;
    const abs = path.resolve(root, d);
    if (isRepo(abs)) return abs;
  }
  return null;
}

/** What the train needs from studio/game.json engines.unity: { cfg, many, target, repo, folder } or { error, message }. */
export function unityTrainSettings(root = REPO_ROOT) {
  const cfg = unityConfig(root);
  if (!cfg) return { error: 'no-land', message: 'No Unity land command is configured (studio/game.json "engines": { "unity": { "land": "<command>" } }): there is nothing to land Unity branches with.' };
  const many = Boolean(landManyCommand(cfg));
  if (!many && !String(cfg.land).includes('{branch}')) return { error: 'no-branch', message: 'The Unity land command takes no {branch} (nor {branches}, nor a "landMany" command): the train could not tell it what to land. The owner adds {branch} or a "landMany" command with {branches} to studio/game.json engines.unity.' };
  if (!safeRefName(cfg.target)) return { error: 'no-target', message: 'The Unity train needs "target" in studio/game.json engines.unity: the branch the land script lands on (the train checks each branch against it and that the target contains them after a pass).' };
  const repo = unityRepo(cfg, root);
  if (!repo) return { error: 'no-repo', message: 'The Unity repo was not found: engines.unity.gateWorktree, the Unity track\'s folder (engine/<game>/engine.json) or engines.unity.cwd must be a git checkout of it.' };
  if (git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${cfg.target}`).status !== 0) return { error: 'no-target', message: `The Unity repo (${repo}) has no branch ${cfg.target} (engines.unity.target).` };
  const track = unityTrack();
  const folder = track?.folder && isRepo(path.resolve(root, track.folder)) ? path.resolve(root, track.folder) : cfg.cwd && isRepo(path.resolve(root, cfg.cwd)) ? path.resolve(root, cfg.cwd) : repo;
  return { cfg, many, target: cfg.target, repo, folder };
}

const headOf = (repo, branch) => out(git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`));
const isAncestor = (repo, a, b) => git(repo, 'merge-base', '--is-ancestor', a, b).status === 0;

// ---- the queue ----------------------------------------------------------------------------------------

export function readUnityQueue(root = mainRoot()) {
  const q = readJson(queueFile(root));
  return Array.isArray(q) ? q : [];
}
const withQueue = (root, fn) => withLandLock(root, () => { const q = readUnityQueue(root); const r = fn(q); writeJson(queueFile(root), q); return r; }, { name: 'unity-train-queue', waitMs: 30000 });
export const dequeueUnity = (root, task) => withQueue(root, (q) => { const i = q.findIndex((e) => e.task === task); if (i >= 0) q.splice(i, 1); return i >= 0; });

/**
 * Queue a Unity-track task's branch (task done <ID> --train, after its checks). { ok, entry, message } or
 * { ok: false, error, message }. The branch: `branch`, else the task's recorded Unity branch, else the Unity folder's
 * current branch (never the target).
 */
export function queueUnityTask(root, { task, agent = null, branch = null, note = '' } = {}) {
  const s = unityTrainSettings(root);
  if (s.error) return { ok: false, error: s.error, message: `${task} was not queued. ${s.message}` };
  // 2.60.1 (B-41) with the train: --branch, else the task's recorded Unity branch (task add --branch, unity-gate branch),
  // else the Unity folder's current branch (refused below when it is the target itself).
  let br = typeof branch === 'string' && branch ? branch : (taskBranch(task) || '');
  if (!br) {
    const cur = out(git(s.folder, 'symbolic-ref', '--short', 'HEAD'));
    if (!cur) return { ok: false, error: 'no-branch', message: `${task} was not queued: which Unity branch? Pass --branch <name> (the Unity folder is not on a branch).` };
    br = cur;
  }
  if (!safeRefName(br) || br.startsWith(UNITY_REF_PREFIX)) return { ok: false, error: 'bad-branch', message: `${task} was not queued: "${br.slice(0, 80)}" is not a plain branch name (letters, digits, . _ / - only, not ${UNITY_REF_PREFIX}...).` };
  if (br === s.target) return { ok: false, error: 'bad-branch', message: `${task} was not queued: ${br} is the target itself; queue the branch the work is on (--branch <name>).` };
  const head = headOf(s.repo, br);
  if (!head) return { ok: false, error: 'no-branch', message: `${task} was not queued: the Unity repo has no branch ${br}.` };
  const ahead = Number(out(git(s.repo, 'rev-list', '--count', `refs/heads/${s.target}..${head}`))) || 0;
  if (!ahead) return { ok: false, error: 'nothing', message: `${task} was not queued: ${br} has no commits that ${s.target} doesn't have.` };
  const entry = withQueue(root, (q) => {
    const i = q.findIndex((e) => e.task === task);
    const rec = { task, agent, branch: br, head, note: note || '', at: new Date().toISOString() };
    if (i >= 0) q.splice(i, 1, { ...rec, at: q[i].at });
    else q.push(rec);
    return rec;
  });
  ev('queued', 'queue', `${task}: ${br} at ${short(head)} waits for the next Unity train`, { agent: agent || 'unity-train', task, to: 'producer', meta: { branch: br, head } });
  return { ok: true, entry, message: `${task} is checked and its Unity branch ${br} (at ${short(head)}, ${ahead} commit(s) ahead of ${s.target}) is queued for the next Unity train. npm run task -- train --unity lands every queued branch on ONE land run; until then the task stays in progress.` };
}

// ---- one Unity train at a time ----------------------------------------------------------------------------

/** The running Unity train's record (a live holder of .studio/locks/unity-train.lock), or null. */
export function runningUnityTrain(root = mainRoot()) {
  const h = readJson(lockFile(root));
  return h && h.pid && pidAlive(h.pid, h.identity) ? h : null;
}

/**
 * Hold .studio/locks/unity-train.lock while fn runs. A lock whose holder is gone (or older than
 * STUDIO_UNITY_TRAIN_STALE_MIN, 1440) is taken over. Busy past waitMs: { busy: holder } and fn doesn't run.
 * fn gets update(patch): what the train is doing now, for `train status`.
 */
export async function withUnityTrainLock(root, info, fn, { waitMs = 0, poll = 2000, log = () => {} } = {}) {
  const f = lockFile(root);
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
export function chainOnTarget(repo, base, lanes, id) {
  let tip = base;
  const res = { included: [], deferred: [], conflictTarget: [], already: [] };
  for (const lane of lanes) {
    if (isAncestor(repo, lane.head, tip)) { (tip === base ? res.already : res.included).push({ ...lane }); continue; }
    if (isAncestor(repo, tip, lane.head)) { tip = lane.head; res.included.push({ ...lane }); continue; }
    const mt = git(repo, 'merge-tree', '--write-tree', tip, lane.head);
    if (mt.status === 0) {
      const tree = String(mt.stdout).split('\n')[0].trim();
      const msg = `unity train ${id}: land ${lane.task} (${lane.branch})\n\nStudio-Train: ${id} ${lane.task}`;
      const c = spawnSync('git', ['commit-tree', tree, '-p', tip, '-p', lane.head, '-m', msg], { cwd: repo, encoding: 'utf8', env: { ...process.env, ...BOT } });
      if (c.status !== 0) return { error: `git commit-tree failed: ${String(c.stderr || '').trim().split('\n').pop()}` };
      tip = c.stdout.trim();
      res.included.push({ ...lane });
      continue;
    }
    if (mt.status !== 1) return { error: `git merge-tree --write-tree failed (git 2.38 or newer is needed): ${String(mt.stderr || '').trim().split('\n').pop()}` };
    const files = conflictFiles(mt.stdout);
    const alone = tip === base ? mt : git(repo, 'merge-tree', '--write-tree', base, lane.head);
    if (alone.status === 0) res.deferred.push({ ...lane, files, why: `it conflicts with ${res.included.map((l) => `${l.task} (${l.branch})`).join(', ') || 'the branches before it'} in this train${files.length ? ` in ${files.slice(0, 5).join(', ')}` : ''}; it goes in the next Unity train` });
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
  const empty = { id, landed: [], dropped: [], deferred: [], runs: 0 };
  const stopped = deps.stopped?.();
  if (stopped) return { ...empty, ok: false, message: `The studio is stopped (${stopped}); no Unity train runs until npm run task -- resume.` };
  const s = unityTrainSettings(root);
  if (s.error) return { ...empty, ok: false, message: s.message };
  if (!opts.dryRun && deps.waitForDrain) {
    const w = await deps.waitForDrain();
    if (!w.ok) return { ...empty, ok: false, message: w.message };
  }
  const locked = await withUnityTrainLock(root, { id, by, lanes: [] }, (update) => unityTrainBody({ ...opts, root, log, deps, id, by, s, update }), { waitMs: opts.waitMs ?? 0, log });
  if (locked?.busy) return { ...empty, ok: false, busy: locked.busy, message: `Another Unity train is running (${locked.busy.id || '?'}, by ${locked.busy.by || '?'}, pid ${locked.busy.pid || '?'}); one Unity train at a time: run this again when it ends (npm run task -- train status shows it).` };
  return locked;
}

async function unityTrainBody({ root, log, deps, id, by, s, update, max = 0, dryRun = false, env = process.env }) {
  const res = { ok: true, id, landed: [], dropped: [], deferred: [], runs: 0, message: '' };
  const { repo, target } = s;
  // Integration refs a killed train left (only while holding the train lock).
  for (const r of out(git(repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${UNITY_REF_PREFIX}`)).split('\n').filter(Boolean)) git(repo, 'update-ref', '-d', r);
  let lanes = readUnityQueue(root);
  if (Number(max) > 0) lanes = lanes.slice(0, Number(max));
  if (!lanes.length) { res.message = 'No Unity branch is waiting to land (task done <ID> --train on a Unity-track task queues one).'; return finish(); }
  update({ lanes: lanes.map((l) => l.task), now: 'checking the branches' });
  ev('start', id, `${lanes.length} branch(es): ${lanes.map((l) => `${l.task} (${l.branch})`).join(', ')}${dryRun ? ' (dry run)' : ''}`, { agent: by, meta: { lanes: lanes.map((l) => l.task), dryRun } });

  const drop = (lane, why, { handBack = true } = {}) => {
    res.dropped.push({ task: lane.task, why });
    if (dryRun) return;
    try { dequeueUnity(root, lane.task); } catch {}
    ev('dropped', id, `${lane.task} handed back: ${why.split('\n')[0]}`, { task: lane.task, agent: by, to: lane.agent, status: 'blocked' });
    if (handBack) { try { deps.handBack?.(lane, `Not landed by Unity train ${id}: ${why}`); } catch (e) { log(`[unity-train] ${id}: could not hand ${lane.task} back: ${e.message}`); } }
  };
  const defer = (lane, why) => { res.deferred.push({ task: lane.task, why }); if (!dryRun) ev('deferred', id, `${lane.task} waits for the next Unity train: ${why.split('\n')[0]}`, { task: lane.task, agent: by, to: lane.agent, status: 'warn' }); };

  // (a) Each branch as it is now.
  const ready = [];
  for (const lane of lanes) {
    const head = headOf(repo, lane.branch);
    if (!head) { drop(lane, `its branch ${lane.branch} is gone from the Unity repo; queue it again`, { handBack: false }); continue; }
    if (head !== lane.head) log(`[unity-train] ${id}: ${lane.task}'s branch ${lane.branch} moved since it was queued (${short(lane.head)} -> ${short(head)}); the branch as it is now goes in`);
    if (isAncestor(repo, head, `refs/heads/${target}`)) { drop(lane, `${lane.branch} has no commits that ${target} doesn't have; task done ${lane.task} closes it`, { handBack: false }); continue; }
    ready.push({ ...lane, head });
  }
  // (b) Conflicts against the target and between branches, from refs only.
  const tip0 = headOf(repo, target);
  const pre = chainOnTarget(repo, tip0, ready, id);
  if (pre.error) { res.ok = false; res.message = `The Unity train could not check the branches: ${pre.error}. Nothing ran; the queue is kept.`; return finish(); }
  for (const l of pre.conflictTarget) drop(l, l.why);
  for (const l of pre.deferred) defer(l, l.why);
  for (const l of pre.already) drop(l, `${l.branch} is already in ${target}; task done ${l.task} closes it`, { handBack: false });
  let set = pre.included;
  if (dryRun) { res.message = `Dry run: ${set.length} branch(es) would land on ONE Unity land run (${set.map((l) => l.task).join(', ') || 'none'}) on ${target} at ${short(tip0)}${s.many ? ' (the land command takes the list)' : set.length > 1 ? ` (through one integration branch, ${UNITY_REF_PREFIX}${id})` : ''}; ${summary(res)}`; return finish(); }
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
      const c = chainOnTarget(repo, tip, group, id);
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
        r = await runUnityGate({ ...arg, task: group.map((l) => l.task).join(','), label: `unity train ${id} (${group.map((l) => l.task).join(', ')})`, env: { ...env, STUDIO_GATE_PRIORITY: 'landing' }, log });
        res.runs += 1;
        if (r.status !== 'refused' || a >= retries) break;
        log(`[unity-train] ${id}: the land command refused (${r.why}); nobody is blamed; trying again in ${Math.round(retryMs / 1000)} s (${a + 1} of ${retries} retries)`);
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
  const close = (group, r) => {
    for (const lane of group) {
      const c = deps.close ? deps.close(lane, { train: id, head: r.newTip, repo, target }) : { ok: true };
      if (c?.ok === false) { ev('close_failed', id, `${lane.task} landed but couldn't be closed: ${c.message}`, { task: lane.task, agent: by, to: 'producer', status: 'warn' }); res.unclosed = [...(res.unclosed || []), { task: lane.task, why: c.message }]; }
      try { dequeueUnity(root, lane.task); } catch {}
      res.landed.push(lane.task);
    }
    ev('landed', id, `${target} moved to ${short(r.newTip)} on one land run: ${group.map((l) => l.task).join(', ')}`, { agent: by, status: 'ok', meta: { head: r.newTip, lanes: group.map((l) => l.task) } });
  };
  /** Refused or error: nobody is blamed, every branch left waits (stays queued). */
  const hold = (group, r) => {
    if (r.status === 'refused') res.refused = { at: new Date().toISOString(), why: r.why };
    res.ok = false;
    for (const l of group) defer(l, r.status === 'refused' ? `the land command refused (${r.why}); not a failure of the work: the next Unity train tries again` : `the land command failed to run (${r.why}); nobody is blamed: fix it, then run npm run task -- train --unity`);
    ev(r.status === 'refused' ? 'refused' : 'error', id, `${r.status}: ${r.why}; ${group.map((l) => l.task).join(', ')} stay queued, nobody is handed back`, { agent: by, to: 'producer', status: r.status === 'refused' ? 'warn' : 'blocked', meta: { status: r.status, log: r.log } });
  };
  const blame = (r) => `${r.status === 'conflict' ? 'the land command found a merge conflict' : 'the land command is red'}: ${r.why}${r.tail ? `\n${r.tail.split('\n').map((x) => `  ${x}`).join('\n')}` : ''}\nIts log: ${r.log || '.studio/gates/out/unity.log'}.`;

  try {
    let remaining = set;
    let rounds = 0;
    while (remaining.length && rounds++ <= set.length) {
      const r = await landGroup(remaining, 'land run');
      if (r.status === 'pass') { close(remaining, r); break; }
      if (r.status !== 'red' && r.status !== 'conflict') { hold(remaining, r); break; }
      if (r.lane) { drop(r.lane, r.lane.why); remaining = remaining.filter((l) => l.task !== r.lane.task); continue; }
      if (remaining.length === 1) { drop(remaining[0], `${blame(r)}\nFix it on ${remaining[0].branch}, then task done ${remaining[0].task} --train again.`); break; }
      // Prefix bisection: the smallest k with target + the first k branches not green. Green prefixes land.
      let lo = 0;
      let hi = remaining.length;
      let bad = r;
      const steps = [{ n: hi, status: r.status }];
      let held = false;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        const part = remaining.slice(lo, mid);
        const rm = await landGroup(part, `bisect ${remaining.slice(0, mid).map((l) => l.task).join('+')}`);
        steps.push({ n: mid, status: rm.status });
        if (rm.status === 'pass') { close(part, rm); lo = mid; continue; }
        if (rm.status !== 'red' && rm.status !== 'conflict') { hold(remaining.slice(lo), rm); held = true; break; }
        if (rm.lane) { bad = rm; hi = remaining.findIndex((l) => l.task === rm.lane.task) + 1 || mid; break; }
        hi = mid;
        bad = rm;
      }
      if (held) break;
      const culprit = remaining[hi - 1];
      const before = remaining.slice(0, hi - 1).map((l) => l.task);
      ev('bisect', id, `${steps.map((st) => `${target} + ${remaining.slice(0, st.n).map((l) => l.task).join(' + ')}: ${st.status}`).join(', ')}; first not green with ${culprit.task}`, { agent: by, meta: { steps, culprit: culprit.task } });
      drop(culprit, `${blame(bad)}\nThe Unity train's prefix bisection: ${target} + ${[...before, culprit.task].join(' + ')} is ${bad.status}${before.length ? `, ${target} + ${before.join(' + ')} landed green` : ''}; so ${culprit.branch} breaks it${before.length ? ' (alone, or together with the branches before it)' : ''}. Fix it on ${culprit.branch} (merge ${target} in first), then task done ${culprit.task} --train again.`);
      remaining = remaining.slice(hi);
    }
  } finally {
    for (const l of set) deps.clearRunning?.(l.task);
  }
  if (res.ok) res.ok = res.landed.length > 0 || (!res.dropped.length && !res.deferred.length);
  return finish();

  function finish() {
    res.message = res.message || summary(res);
    try { writeJson(lastFile(root), { ...res, by, at: new Date().toISOString() }); } catch {}
    ev('done', id, res.message, { agent: by, status: res.landed.length ? 'ok' : 'warn', meta: { landed: res.landed, dropped: res.dropped.map((d) => d.task), deferred: res.deferred.map((d) => d.task), runs: res.runs, refused: Boolean(res.refused) } });
    return res;
  }
}

function summary(res) {
  const parts = [];
  if (res.landed.length) parts.push(`landed ${res.landed.join(', ')} with ${res.runs} Unity land run(s)`);
  if (res.dropped.length) parts.push(`handed back ${res.dropped.map((d) => `${d.task} (${d.why.split('\n')[0]})`).join('; ')}`);
  if (res.deferred.length) parts.push(`waiting for the next Unity train: ${res.deferred.map((d) => `${d.task} (${d.why.split('\n')[0]})`).join('; ')}`);
  return parts.join('. ') || 'nothing to land';
}

// ---- status ------------------------------------------------------------------------------------------------

/** { queue, running, last } for `npm run task -- train status`. */
export function unityTrainStatus(root = mainRoot()) {
  return { queue: readUnityQueue(root), running: runningUnityTrain(root), last: readJson(lastFile(root)) };
}

/** Lines for people; '' when there is nothing to say and quiet is set. */
export function unityStatusText(root = mainRoot(), { quiet = false } = {}) {
  const st = unityTrainStatus(root);
  if (quiet && !st.queue.length && !st.running) return '';
  const lines = [];
  const inTrain = new Set(st.running?.lanes || []);
  const waiting = st.queue.filter((e) => !inTrain.has(e.task));
  const row = (e) => `  ${e.task}  ${e.agent || '?'}  ${e.branch} at ${short(e.head)} (queued ${String(e.at).slice(0, 16)})`;
  lines.push(waiting.length ? `${waiting.length} Unity branch(es) wait for the next Unity train (npm run task -- train --unity):\n${waiting.map(row).join('\n')}` : 'No Unity branch waits for a Unity train (task done <ID> --train on a Unity-track task queues one).');
  if (st.running) lines.push(`Unity train running: ${st.running.id} by ${st.running.by || '?'} (pid ${st.running.pid}, since ${new Date(st.running.at).toISOString().slice(11, 16)} UTC)${st.running.lanes?.length ? `, ${st.running.lanes.join(', ')}` : ''}${st.running.now ? `; now: ${st.running.now}` : ''}`);
  if (st.last && !st.running) lines.push(`Last Unity train ${st.last.id} (${String(st.last.at || '').slice(0, 16)}): ${st.last.message}`);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'status' || !argv.length) {
    const root = mainRoot();
    if (argv.includes('--json')) console.log(JSON.stringify(unityTrainStatus(root), null, 2));
    else console.log(unityStatusText(root));
    process.exit(0);
  }
  console.error('Usage: node harness/unity-train.mjs status [--json]   (npm run task -- train --unity runs a Unity train)');
  process.exit(1);
}
