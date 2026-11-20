#!/usr/bin/env node
/**
 * harness/unity-train.mjs — the Unity merge train: several Unity branches land on ONE run of the studio's Unity land
 * command, one train at a time.
 *    node harness/unity-train.mjs status [--json] [--engine <name>]
 *    node harness/unity-train.mjs queue --task <ID> [--engine x] [--agent a] [--branch b] [--alone]
 * `npm run task -- train --unity` runs a train, `train status` shows it. `task done <ID> --train` queues a branch in
 * .studio/train/unity-queue.json; the train runs ONE land command and bisects by prefix on red. Refused, error or
 * "not run" retries (STUDIO_UNITY_TRAIN_RETRIES, _RETRY_MIN).
 * Runs under machine:heavy; lock .studio/locks/unity-train.lock; STUDIO_GATE_PRIORITY=landing;
 * STUDIO_UNITY_MIN_FREE_GB. Never imports harness/task.mjs. Engine <x>: own queue, lock, events (task.train.<x>.*),
 * land command (engines.<x>).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runLimitedSync } from './run-limited.mjs';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { mainRoot } from './worktree.mjs';
import { withLandLock, matchAny } from './merge-lane.mjs';
import { selfIdentity, pidAlive } from './proc-identity.mjs';
import { runUnityGate, unityConfig, unityTrack, landManyCommand, safeRefName, taskBranch } from './unity-gate.mjs';
import { engineTarget, engineFiles, engineTask, setEngineTask, targetMergeCommand, engineFloor } from './engine-tracks.mjs';
import { selectBatch, batchLimits, laneClass, laneAloneWhy, onlyList, tagCounts, autoLine } from './engine-train-control.mjs';
import { recordEngineShots } from './engine-shots.mjs';
import { writeAtomic, readJson } from './fsafe.mjs';
import { rulesConfig, rulesGate, inputsPrint, shareInputs, changedPaths, playSelection, PLAY_FILTER_SAFE, blameList, blameSuspect, rulesCheckout, removeCheckout, rulesNoJudge, fullRulesOwed, fullRulesRun, rulesFullRed, rulesKey, rulesLanded } from './engine-rules.mjs';
import { noteUnmatched, proposeGaps } from './play-gaps.mjs';
import { compileSearchOf, compileSearch, compileAt, compilerLines } from './engine-compile.mjs';
import { parallelState, parallelUse, parallelLine, runGateChild } from './engine-gates.mjs';
import { engineSlotsAt, heavySlotsAt, floorFree } from './heavy.mjs';
import { maxConcurrent, capGroup } from './heavy-budget.mjs';
import { removeLandedLane, pruneBuilds, buildsConfig } from './engine-clean.mjs';
import { flagOf, foldRealOf, gitMax64 as git, numBlankDefault as num, realOrResolved as real, short8 as short, sleepSyncClamped as sleep, stdoutOf as out } from './helpers.mjs';
import { targetRedTask, targetRedClear, targetRedLine } from './engine-target-red.mjs';
import { aheadStart, aheadVerdict, aheadFor, aheadLine } from './rules-ahead.mjs';
import { unionGlobs, unionMerge } from './merge-union.mjs';
import { runningLines } from './run-cost.mjs';

const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); writeAtomic(f, `${JSON.stringify(v, null, 2)}\n`); };
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
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
    const r = runLimitedSync(cmd, { cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeoutMs: Math.max(1, num(s.cfg.preLandTimeoutMin, 10)) * 60000, env: { ...env, STUDIO_LANE_COMMIT: lane.head, STUDIO_LANE_DIR: dir, STUDIO_ENGINE_REPO: s.repo } });
    if (r.error) return { error: `the pre-land command could not run: ${r.error.code || r.error.message}` };
    if (r.status === 0) return { ok: true };
    const lines = `${r.stdout || ''}${r.stderr || ''}`.replace(/\r\n?/g, '\n').trimEnd().split('\n').slice(-8).join('\n');
    return { ok: false, why: `the pre-land check (engines.${s.engine || 'unity'}.preLand) exited ${r.status ?? r.signal ?? '?'}${lines ? `:\n${lines.split('\n').map((x) => `  ${x}`).join('\n')}` : ''}` };
  } finally { cleanup(); }
}

/** 2.90: engines.<x>.preQueue, checked: [{ touches: [glob], titles: [regex], run, say, timeoutMin, env }]; an entry needs a run and touches or titles (2.93); a bad regex leaves it out and is added to `bad`. */
const envVars = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string')) : {});
export function preQueueOf(cfg = {}, bad = []) {
  const v = Array.isArray(cfg?.preQueue) ? cfg.preQueue : [];
  const res = (x) => { try { return new RegExp(x, 'i'); } catch { bad.push(x); return null; } };
  const strs = (a) => (Array.isArray(a) ? a : [a]).filter((x) => typeof x === 'string' && x.trim());
  return v.map((e) => ({ titles: strs(e?.titles).map(res), touches: (Array.isArray(e?.touches) ? e.touches : [e?.touches]).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().replace(/\\/g, '/')), run: typeof e?.run === 'string' ? e.run.trim() : '', say: typeof e?.say === 'string' ? e.say.trim().slice(0, 300) : '', timeoutMin: Math.max(1, num(e?.timeoutMin, 10)), env: envVars(e?.env) })).filter((e) => (e.touches.length || e.titles.length) && !e.titles.includes(null) && e.run);
}

const badWords = (bad, engine) => (bad.length ? `\nLeft out of engines.${engine}.preQueue: an entry whose "titles" has ${bad.map((x) => `"${x}"`).join(', ')}, not a valid regular expression.` : '');

/** 2.92: the lane's head merged with the target tip, a commit object only (no ref): { tip, head } | { tip, conflict } | { tip, error }. */
function mergedOnTarget(s, lane) {
  const tip = headOf(s.repo, s.target);
  const c = chainOnTarget(s.repo, tip, [lane], 'queue', s.engine || 'unity', { union: unionOf(s.cfg) });
  if (c.error) return { tip, error: c.error };
  return c.conflictTarget[0] ? { tip, conflict: `${lane.branch}: ${c.conflictTarget[0].why}` } : { tip, head: c.head };
}

/**
 * 2.90: run the preQueue entries whose "touches" match a file the lane's branch changes (against its merge base with the
 * target), in one throwaway checkout of its head merged with the target tip (2.92; a conflict refuses, nothing runs). Env:
 * the entry's own "env", then STUDIO_LANE_COMMIT (the head), STUDIO_TARGET_COMMIT, STUDIO_LANE_DIR, STUDIO_ENGINE_REPO,
 * STUDIO_ENGINE_LANE_DIR when the porter's lane folder exists. { ran: [run], files, target, refused?: text, skipped?: why }.
 */
export function runPreQueue(s, lane, { root, env = process.env } = {}) {
  const bad = [];
  const list = preQueueOf(s.cfg, bad);
  const res = { ran: [], files: [], bad };
  if (!list.length) return res;
  const base = out(git(s.repo, 'merge-base', `refs/heads/${s.target}`, lane.head));
  const changed = base ? changedPaths(s.repo, base, lane.head) || [] : [];
  const due = list.map((e) => ({ e, files: e.touches.length ? changed.filter((f) => matchAny(f, e.touches)) : [] })).filter((x) => (!x.e.touches.length || x.files.length) && (!x.e.titles.length || x.e.titles.some((t) => t.test(lane.title || ''))));
  if (!due.length) return res;
  res.files = [...new Set(due.flatMap((x) => x.files))];
  const m = mergedOnTarget(s, lane);
  res.target = m.tip;
  if (m.conflict) return { ...res, refused: m.conflict, conflict: true };
  if (m.error) return { ...res, skipped: m.error };
  const dir = path.join(root, '.studio', 'tmp', `prequeue-${String(lane.task).replace(/[^A-Za-z0-9._-]/g, '_')}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  removeCheckout(s.repo, dir);
  const co = rulesCheckout({ repo: s.repo, sha: m.head, dir, cfg: {}, env });
  if (!co.ok) return { ...res, skipped: `could not check ${short(lane.head)} out: ${co.why}` };
  const laneDir = path.join(root, '.lanes', 'engine', String(lane.task));
  try {
    for (const { e, files } of due) {
      const r = runLimitedSync(e.run, { cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeoutMs: e.timeoutMin * 60000, env: { ...env, ...e.env, STUDIO_TASK_ID: String(lane.task), STUDIO_TASK_TITLE: lane.title || '', STUDIO_LANE_COMMIT: lane.head, STUDIO_TARGET_COMMIT: m.tip, STUDIO_LANE_DIR: dir, STUDIO_ENGINE_REPO: s.repo, ...(fs.existsSync(laneDir) ? { STUDIO_ENGINE_LANE_DIR: laneDir } : {}) } });
      if (r.error && r.error.code !== 'ETIMEDOUT') return { ...res, skipped: `${e.run}: ${r.error.code || r.error.message}` };
      if (r.status === 0 && !r.error) { res.ran.push(e.run); continue; }
      const lines = `${r.stdout || ''}${r.stderr || ''}`.replace(/\r\n?/g, '\n').trimEnd().split('\n').slice(-8);
      return { ...res, refused: `${lane.branch}${files.length ? ` changes ${files.slice(0, 3).join(', ')}` : ` is for ${lane.task}`}, and the check for it (engines.${s.engine || 'unity'}.preQueue: ${e.run}) ${r.error ? `timed out after ${e.timeoutMin} min` : `exited ${r.status ?? r.signal ?? '?'}`}:\n${lines.map((x) => `  ${x}`).join('\n')}\n${e.say ? e.say.replace(/[.\s]+$/, '') : `Fix it on ${lane.branch}`}, then task done ${lane.task} --train again.` };
    }
    return res;
  } finally { removeCheckout(s.repo, dir); }
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
export function queueUnityTask(root, { engine = 'unity', task, agent = null, branch = null, note = '', alone = null, tag = null, again = false, meta = null, title = '', waits = [] } = {}) {
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
    if (rec && !again) return { ok: false, error: 'unchanged', handback: rec, message: `${task} was not queued: nothing changed since ${L} train ${rec.train} handed ${br} back for ${rec.reason}: the same red would repeat (since then ${br} has only merges of ${s.target}${(rec.files || []).length ? `, and ${s.target} changed none of ${rec.files.slice(0, 4).join(', ')}` : `, and ${s.target} has not moved`}). Fix it, or \`npm run task -- impossible ${task} --why "<what contradicts what>"\`. (add --again if a person wants it run again as it is).` };
    if (rec && again) evTop('requeued_unchanged', 'queue', `${task}: ${br} at ${short(head)} queued again with --again though nothing changed since train ${rec.train} handed it back (${rec.reason})`, { engine, agent: agent || `${engine}-train`, task, to: 'producer', status: 'warn', meta: { branch: br, head, handback: rec.train, reason: String(rec.reason).slice(0, 200) } });
  }
  // 2.95 (d): the same branch at the same head, already queued, and the task waits for another task: nothing to do again.
  const queued = readUnityQueue(root, engine).find((e) => e.task === task);
  if (queued && queued.head === head && queued.branch === br && alone == null && tag == null) {
    if (waits.length) return { ok: true, entry: queued, message: `${task} is already queued; it waits for ${waits.join(', ')} (task after); nothing changed.` };
  }
  // 2.90: engines.<x>.preQueue: the checks keyed to the files this branch changes, before it is queued (not again for the same head).
  const q0 = readUnityQueue(root, engine);
  const inQueue = q0.find((e) => e.task === task);
  // 2.92: what the door found is kept on the entry (preQueue: the target tip it judged; clash: the queued lanes it does not compile with).
  let kept = inQueue && inQueue.head === head ? { ...(inQueue.preQueue ? { preQueue: inQueue.preQueue } : {}), ...(inQueue.clash ? { clash: inQueue.clash } : {}) } : {};
  let say = '';
  if (!inQueue || inQueue.head !== head) {
    const pq = runPreQueue(s, { task, branch: br, head, title }, { root });
    say += badWords(pq.bad, engine);
    if (pq.refused) {
      evTop('pre_queue', 'queue', `${task}: not queued: ${pq.refused.split('\n')[0]}`, { engine, agent: agent || `${engine}-train`, task, to: agent || 'producer', status: 'blocked', meta: { branch: br, head, files: pq.files.slice(0, 10) } });
      return { ok: false, error: 'pre-queue', message: `${task} was not queued: ${pq.refused}${say}` };
    }
    if (pq.ran.length || pq.skipped) evTop('pre_queue', 'queue', `${task}: ${pq.skipped ? `the pre-queue check could not run (${pq.skipped}); queued without it` : `pre-queue check(s) passed: ${pq.ran.join('; ')}`}`, { engine, agent: agent || `${engine}-train`, task, status: pq.skipped ? 'warn' : 'ok', meta: { branch: br, head, ran: pq.ran.length } });
    kept = pq.ran.length && !pq.skipped ? { preQueue: { target: pq.target, head } } : {};
    // 2.92: the compile search at the door: lanes queued ahead are the untagged ones that do not land alone or wait for the target.
    const rec0 = (() => { try { return engineTask(task, { root }); } catch { return null; } })();
    const apart = (alone == null ? Boolean(rec0?.alone || inQueue?.alone) : Boolean(alone)) || Boolean(tag == null ? rec0?.tag || inQueue?.tag : tag);
    const waits = waitingOnTarget(root, engine, q0);
    const ahead = apart ? [] : q0.slice(0, inQueue ? q0.indexOf(inQueue) : q0.length).filter((e) => !e.tag && !e.alone && !waits.has(e.task));
    const qc = queueCompile(s, { task, branch: br, head }, { root, engine, ahead });
    if (qc) {
      evTop('queue_compile', 'queue', `${task}: ${qc.verdict}: ${qc.say.split('\n')[0]}`, { engine, agent: agent || `${engine}-train`, task, to: qc.refused || qc.clash ? agent || 'producer' : undefined, status: qc.refused ? 'blocked' : qc.verdict === 'pass' ? 'ok' : 'warn', meta: { branch: br, head, verdict: qc.verdict, runs: qc.runs, ahead: ahead.length, ...(qc.clash ? { with: qc.clash.with } : {}) } });
      if (qc.refused) return { ok: false, error: 'compile', message: `${task} was not queued: ${qc.say}` };
      if (qc.clash) kept.clash = qc.clash;
      if (qc.verdict !== 'pass') say = `\n${qc.say}`;
    }
  }
  const entry = withQueue(root, (q) => {
    const i = q.findIndex((e) => e.task === task);
    // A branch that must land alone (task done --train --alone, or the task's record: task alone <ID> on).
    const solo = alone === null || alone === undefined ? Boolean((() => { try { return engineTask(task, { root })?.alone; } catch { return false; } })() || (i >= 0 && q[i].alone)) : Boolean(alone);
    // A lane tag (task done --train --tag <word>, task tag <ID> <word>): only a train for that tag takes it.
    // tag null: the task's record, else the entry's own; '' clears it.
    const tg = tag === null || tag === undefined ? (() => { try { return engineTask(task, { root })?.tag || null; } catch { return null; } })() || (i >= 0 ? q[i].tag || null : null) : tag || null;
    const rec = { task, agent, branch: br, head, note: note || '', at: new Date().toISOString(), ...(solo ? { alone: true } : {}), ...(tg ? { tag: tg } : {}), ...kept };
    if (i >= 0) q.splice(i, 1, { ...rec, at: q[i].at });
    else q.push(rec);
    return rec;
  }, engine);
  if (tag !== null && tag !== undefined) { try { const r0 = engineTask(task, { root }); if (r0?.engine === engine || !r0) setEngineTask(task, { engine, ...(r0?.track ? { track: r0.track } : {}), tag: tag || null }, { root }); } catch { /* the queue entry carries it */ } }
  evTop('queued', 'queue', `${task}: ${br} at ${short(head)} waits for the next ${L} train${entry.alone ? ' (it lands alone)' : ''}${entry.tag ? ` (tag ${entry.tag}: only train --engine ${engine} --tag ${entry.tag} takes it)` : ''}`, { engine, agent: agent || `${engine}-train`, task, to: 'producer', meta: { branch: br, head, ...(entry.alone ? { alone: true } : {}), ...(entry.tag ? { tag: entry.tag } : {}), ...(meta && typeof meta === 'object' ? meta : {}) } }); // 2.85: meta.auto when the harness queued it
  // The lane's new shared input files (engines.<x>.rules.share: content-addressed files a lane adds, git-ignored) go to the
  // engine's input folder now, so the rules check and the land run find them. Never overwrites.
  try { shareLaneInputs(root, engine, s, task, (m) => console.error(m)); } catch { /* the train tries again */ }
  return { ok: true, entry, message: `${task} is checked and its ${L} branch ${br} (at ${short(head)}, ${ahead} commit(s) ahead of ${s.target}) is queued for the next ${L} train${entry.tag ? `, tagged ${entry.tag}: only npm run task -- train --engine ${engine} --tag ${entry.tag} takes it (the automatic start never does)` : ''}. npm run task -- train --engine ${engine} lands every queued branch on ONE land run (the Line Producer starts it in a quiet window); until then the task stays in progress.${say}` };
}

/** The 2.90 compile hand-back words: x { lane, with: [lane], lines, tail }, where: what the lanes in `with` are doing. */
function noCompileText(x, { target, engine, cc, where }) {
  const w = x.with.map((l) => `${l.task} (${l.branch})`).join(', ');
  const said = x.lines.length ? x.lines : (x.tail || '').split('\n').filter(Boolean).slice(-6);
  return `it does not compile ${w ? `together with ${w}, ${where}` : `on ${target} by itself`} (engines.${engine}.${cc.source}: ${cc.command}). ${w ? `Once ${x.with.length === 1 ? 'it has' : 'they have'} landed, bring ${target} in (${targetMergeCommand(x.lane.task)}) and fix the lines below${x.lines.some((l) => /\bCS01(01|02|11)\b/.test(l)) ? ' (both branches declare the same member or type: keep one)' : ''}` : `Bring ${target} in (${targetMergeCommand(x.lane.task)}) and fix the lines below`}, then task done ${x.lane.task} --train again.\nThe compiler:\n${said.map((l) => `  ${l}`).join('\n')}`;
}

/**
 * 2.92: the compile search at the queue door (engines.<x>.quickCheck): the branch merged with the target (red: refused), then
 * the target + the lanes queued ahead + the branch (a clash: queued, marked). At most STUDIO_QUEUE_COMPILE_RUNS (6) runs for
 * the second, STUDIO_QUEUE_COMPILE_MIN (10) in all. Anything that stops the check queues as before. null when off, else
 * { verdict: pass|red|conflict|clash|unfinished|not-run, say, runs, refused?, clash? }.
 */
function queueCompile(s, lane, { root, engine, ahead = [], env = process.env }) {
  const cc = compileSearchOf(s.cfg);
  if (!cc) return null;
  const maxRuns = Math.max(1, Math.floor(num(env.STUDIO_QUEUE_COMPILE_RUNS, 6)));
  const end = Date.now() + Math.max(0.1, num(env.STUDIO_QUEUE_COMPILE_MIN, 10)) * 60000;
  let runs = 0; let cap = Infinity; let stop = '';
  const memo = new Map();
  const notRun = (why) => ({ verdict: 'not-run', runs, say: `The compile check at the queue door judged nothing (${why}): queued without it.` });
  try {
    const m = mergedOnTarget(s, lane);
    if (m.conflict) return { verdict: 'conflict', runs, refused: true, say: m.conflict };
    if (m.error) return notRun(m.error);
    const rules = (() => { try { return rulesConfig(engine, { root, env, repo: s.repo, ref: s.target }); } catch { return null; } })();
    const at = (sha) => {
      const tree = out(git(s.repo, 'rev-parse', `${sha}^{tree}`)) || sha;
      if (memo.has(tree)) return memo.get(tree);
      if (runs >= cap || Date.now() >= end) { stop = stop || (runs >= cap ? `${maxRuns} compile runs (STUDIO_QUEUE_COMPILE_RUNS)` : 'its time limit (STUDIO_QUEUE_COMPILE_MIN)'); return { status: 'error', why: stop }; }
      runs += 1;
      const r = compileAt({ repo: s.repo, sha, cmd: { ...cc, timeoutMin: Math.min(cc.timeoutMin, Math.max(0.1, (end - Date.now()) / 60000)) }, root, id: `queue-${lane.task}`, engine, rules, env });
      if (r.status !== 'pass' && r.status !== 'red') stop = stop || r.why;
      memo.set(tree, r);
      return r;
    };
    const chain = (t, ls) => chainOnTarget(s.repo, t, ls, 'queue', engine, { union: unionOf(s.cfg) });
    const one = compileSearch({ repo: s.repo, tip: m.tip, lanes: [lane], chain, at, maxRuns: 99 });
    const ctx = { target: s.target, engine, cc };
    if (one.left.length) return { verdict: 'red', runs, refused: true, say: `${lane.branch}: ${noCompileText(one.left[0], { ...ctx, where: '' })}` };
    if (!one.green) return notRun(one.why);
    const lanes = ahead.map((e) => ({ task: e.task, branch: e.branch, head: headOf(s.repo, e.branch) || e.head })).filter((l) => l.head);
    if (!lanes.length) return { verdict: 'pass', runs, say: '' };
    runs = 0; cap = maxRuns; stop = '';
    const two = compileSearch({ repo: s.repo, tip: m.tip, lanes: [...lanes, lane], chain, at, maxRuns: 99 });
    const x = two.left.find((y) => y.lane.task === lane.task);
    if (x && x.with.length) {
      const said = noCompileText(x, { ...ctx, where: 'queued ahead of it' });
      return { verdict: 'clash', runs, clash: { with: x.with.map((l) => l.task), lines: x.lines.slice(0, 8), target: m.tip, at: new Date().toISOString() }, say: `Queued, but ${said}\nUntil then a train leaves ${lane.task} out of a batch with ${x.with.map((l) => l.task).join(', ')}; it is checked again once ${x.with.length === 1 ? 'that lane has' : 'they have'} landed or left the queue.` };
    }
    if (stop || two.targetRed || !two.ran) return { verdict: 'unfinished', runs, say: `The compile check with the ${lanes.length} lane(s) queued ahead did not finish (${stop || two.why}): queued as before.` };
    return { verdict: 'pass', runs, say: '' };
  } catch (e) { return notRun(e.message); }
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
    const same = (n, c) => n === c || n.endsWith(`/${c}`) || c.endsWith(`/${n}`);
    const hit = changed.filter((c) => named.some((n) => same(n, c)));
    // cover: the named files this lane changes (2.92: every one covered by some lane hands those lanes back at once).
    if (hit.length) found.push({ lane, tests: [], files: hit.slice(0, 6), cover: named.filter((n) => hit.some((c) => same(n, c))) });
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
 * Which lanes are tied to which failing tests, by every evidence rule: the class rule, the namespace rule, the class
 * file less "Tests" (ShopTests: Shop.cs), and the assembly folder (.asmdef that holds the test's file). { byTest: {
 * name: [task] }, byLane: Map task -> { lane, tests, files, rules }, unjudged: [task] } (unjudged: too many files).
 */
export function tiesOf({ repo, tip, lanes = [], failures = [] } = {}) {
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
  // 2.86: a hand-back for a merge conflict with the target is fixed by merging the target: a new head that holds the target's current
  // tip counts as changed, even when the target touched none of the conflicting files.
  if (head !== rec.head && /(^|: )it conflicts with the target/.test(String(rec.reason))) { const tip = headOf(s.repo, s.target); if (tip && isAncestor(s.repo, tip, head)) return null; }
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

// ---- 2.86: what the train keeps about tests and trees ----
// A crew's one flaky Play Mode test (red about half the time) cost two one-branch trains their branch and a 6-branch
// train 6.5 h: a red on a listed flaky test was a branch's fault after one retry, with no look at the target alone.

/** engines.<x>.flakyRetries: how often a red on listed flaky tests only is run again by name (default 2, 0 to 5). */
export function flakyRetriesOf(cfg = {}) {
  const n = Number(cfg?.flakyRetries);
  return Number.isFinite(n) ? Math.max(0, Math.min(5, Math.floor(n))) : 2;
}

const flakesFile = (root, engine) => path.join(root, '.studio', 'train', `${engine}-flakes.json`);
/** The flake record: { tests: { <name>: { runs, reds, lastRed, probeRed?, probeGreen? } }, told: { <key>: at } }. */
export function readFlakes(root, engine = 'unity') {
  const j = readJson(flakesFile(root, engine));
  return { tests: j?.tests && typeof j.tests === 'object' && !Array.isArray(j.tests) ? j.tests : {}, told: j?.told && typeof j.told === 'object' ? j.told : {} };
}
const editFlakes = (root, engine, fn) => { try { withLandLock(root, () => { const f = readFlakes(root, engine); fn(f); const keep = Object.entries(f.tests).sort((a, b) => String(b[1]?.at || '').localeCompare(String(a[1]?.at || ''))).slice(0, 200); writeJson(flakesFile(root, engine), { tests: Object.fromEntries(keep), told: Object.fromEntries(Object.entries(f.told).slice(-50)) }); }, { name: `${engine}-train-flakes`, waitMs: 30000 }); } catch { /* a record only */ } };

/**
 * 2.86: count one run in the flake record, for the tests on engines.<x>.flakyTests (exact names) and every listed test that
 * failed. A run counts for a test when its result is known: it failed, or the run passed with the test in it (a full Play Mode
 * stage, a full run, or a retry or probe that named it). A red run that failed elsewhere says nothing about the test.
 */
export function noteFlakes(root, engine, { cfg = {}, r, named = null, train = null, target = null, probe = false } = {}) {
  if (!r || !['pass', 'red'].includes(r.status) || r.compileOnly) return;
  const isFlaky = flakyMatcher(cfg.flakyTests);
  const failed = new Set(r.status === 'red' && Array.isArray(r.failures) ? r.failures : []);
  const listed = (Array.isArray(cfg.flakyTests) ? cfg.flakyTests : []).filter((x) => typeof x === 'string' && x.trim() && !x.trim().endsWith('*')).map((x) => x.trim());
  const names = [...new Set([...listed, ...[...failed].filter(isFlaky)])];
  const ran = (n) => failed.has(n) || (r.status === 'pass' && ((named && named.includes(n)) || (!named && (r.full || r.play?.mode === 'full'))));
  const counted = names.filter(ran);
  if (!counted.length) return;
  const at = new Date().toISOString();
  editFlakes(root, engine, (f) => {
    for (const n of counted) {
      const t = f.tests[n] || { runs: 0, reds: 0 };
      t.runs = (Number(t.runs) || 0) + 1;
      if (failed.has(n)) { t.reds = (Number(t.reds) || 0) + 1; t.lastRed = at; }
      if (probe) t[failed.has(n) ? 'probeRed' : 'probeGreen'] = { at, train, target };
      t.at = at;
      f.tests[n] = t;
    }
  });
}

/** 2.86: lines for train status: a listed test red in 2 or more land runs. */
export function flakeLines(root, engine = 'unity') {
  return Object.entries(readFlakes(root, engine).tests).filter(([, t]) => Number(t?.reds) >= 2).sort((a, b) => b[1].reds - a[1].reds).slice(0, 5)
    .map(([n, t]) => `${n} red in ${t.reds} of ${t.runs} land runs: fix it or it will keep costing runs${t.probeRed ? ` (red on the target alone in a probe at ${String(t.probeRed.at).slice(0, 16)})` : ''}`);
}

/**
 * 2.86: the listed flaky tests a probe found red on the target alone within engines.<x>.knownRedHours (default 0: off).
 * { names, probes: [{ test, train, at, target }] }. Never a test that is not on flakyTests.
 */
export function knownRedOf(root, engine, cfg = {}, now = Date.now()) {
  const h = Number(cfg?.knownRedHours);
  if (!Number.isFinite(h) || h <= 0) return { names: [], probes: [] };
  const isFlaky = flakyMatcher(cfg.flakyTests);
  const probes = Object.entries(readFlakes(root, engine).tests).filter(([n, t]) => isFlaky(n) && t?.probeRed && now - Date.parse(t.probeRed.at) <= h * 3600000 && !(t.probeGreen && Date.parse(t.probeGreen.at) > Date.parse(t.probeRed.at))).map(([n, t]) => ({ test: n, ...t.probeRed }));
  return { names: probes.map((p) => p.test), probes };
}

/** 2.86: tests a probe found red on the target alone at exactly this tip (a later green probe on it clears one). */
export const targetRedAt = (root, engine, tip) => Object.entries(readFlakes(root, engine).tests).filter(([, t]) => t?.probeRed?.target && t.probeRed.target === tip && !(t.probeGreen?.target === tip && Date.parse(t.probeGreen.at) > Date.parse(t.probeRed.at))).map(([n]) => n);

const probeFile = (root, engine) => path.join(root, '.studio', 'train', `${engine}-probe.json`);
/**
 * 2.86: does the engine's land script honour STUDIO_LAND_PROBE=1 (land nothing)? A run of the target alone is safe either way (its
 * branch is the target itself); a by-name step on lanes is not, so it is used only when the script said so in a run told
 * STUDIO_LAND_PROBE=1 (an output line "[land-probe] honoured", or "probe": true in its stage report), or the owner set
 * engines.<x>.landProbe true. A run that moved the target anyway withdraws it until a person removes .studio/train/<x>-probe.json.
 */
export function probeHonoured(root, engine = 'unity', cfg = {}) {
  const j = readJson(probeFile(root, engine));
  if (j?.revoked) return false;
  return cfg?.landProbe === true || j?.honoured === true;
}
const noteProbe = (root, engine, rec) => { try { const j = readJson(probeFile(root, engine)); if (j?.revoked && !rec.revoked) return; if (j?.honoured === rec.honoured && !rec.revoked) return; writeJson(probeFile(root, engine), { ...rec, at: new Date().toISOString() }); } catch { /* a record only */ } };

const greenFile = (root, engine) => path.join(root, '.studio', 'train', `${engine}-green.json`);
/** 2.86: the green record: [{ tree, target, kind, train, at }], newest last, 200 at most. */
export function readGreen(root, engine = 'unity') { const j = readJson(greenFile(root, engine)); return Array.isArray(j) ? j.filter((x) => x && x.tree && x.target && x.kind) : []; }
export const greenHas = (root, engine, { tree, target, kind }) => readGreen(root, engine).find((x) => x.tree === tree && x.target === target && x.kind === kind) || null;
const noteGreen = (root, engine, rec) => { try { withLandLock(root, () => { const g = readGreen(root, engine).filter((x) => !(x.tree === rec.tree && x.target === rec.target && x.kind === rec.kind)); g.push({ ...rec, at: new Date().toISOString() }); writeJson(greenFile(root, engine), g.slice(-200)); }, { name: `${engine}-train-green`, waitMs: 30000 }); } catch { /* a record only */ } };

/**
 * 2.86: the queued lanes that wait for the target: a train ended "waiting for the target" on them (red on the target alone)
 * and the target has not moved since. A Set of task ids.
 */
export function waitingOnTarget(root, engine = 'unity', queue = null) {
  const q = Array.isArray(queue) ? queue : readUnityQueue(root, engine);
  if (!q.some((e) => e?.waitTarget?.target)) return new Set();
  const s = unityTrainSettings(root, engine);
  const tip = s.error ? null : headOf(s.repo, s.target);
  return new Set(q.filter((e) => e?.waitTarget?.target && e.waitTarget.target === tip).map((e) => e.task));
}

/** 2.90: one line when the rules check judged no lane on 2 or more trains in a row (engine-rules.mjs rulesNoJudge), else ''. */
export function rulesIdleLine(root, engine = 'unity') {
  const L = [];
  try { const nj = rulesNoJudge(root, engine); if (nj && nj.n >= 2) L.push(`The ${labelOf(engine)} rules check judged no lane on the last ${nj.n} trains (${Math.round(nj.minutes)} min spent on it since ${String(nj.since).slice(0, 16)}): ${nj.why}. Change: ${nj.fix}.`); } catch { /* none */ }
  // 2.91: the owed full rules run red (or timed out) on the target alone: no lane is blamed; it waits for the target to change.
  try { const fr = rulesFullRed(root, engine); if (fr) L.push(`The ${labelOf(engine)} full rules run on the target alone is ${fr.status === 'red' ? 'red' : 'not green'} at ${short(fr.tip)} (${String(fr.at).slice(0, 16)}): ${fr.why}${fr.failures?.length ? ` (${fr.failures.slice(0, 3).join(', ')})` : ''}. No lane is blamed; it runs again when the target changes under what the rules tests read. A fix task is wanted.`); } catch { /* none */ }
  return L.join('\n');
}

/**
 * 2.90: may this train use the second gate now (harness/engine-gates.mjs parallelUse)? The switch, a second gate, the probe
 * record, and the machine budget: the engine line's, the heavy slots and the job kind's cap (the smallest), and free RAM against
 * two runs' floor.
 */
export function parallelNow(root, engine, cfg = {}, env = process.env) {
  const state = parallelState(root, engine);
  let admit = null;
  try {
    const es = engineSlotsAt(root, env);
    const kind = engineTarget(engine, { root })?.heavyKind || 'heavy';
    const caps = [maxConcurrent(kind, { root, env }), maxConcurrent(capGroup(kind), { root, env })].filter((x) => Number.isFinite(x));
    const slots = Math.min(es > 0 ? es : Infinity, heavySlotsAt(root, env), ...caps);
    const needGb = 2 * (Number(engineFloor(engine, { env, root }).gb) || 0);
    admit = { slots, needGb, freeGb: floorFree(needGb, { env }).freeGb };
  } catch { admit = { slots: 1 }; }
  return { ...parallelUse({ state, cfg, probeOk: probeHonoured(root, engine, cfg), admit, env }), state, admit };
}

// ---- 2.86: the order of steps after a red, as one pure plan ----

/** Kinds of step whose pass lands its group, when it is a complete run (a by-name step lands nothing). */
const LANDS = new Set(['land', 'retry', 'known-red', 'without', 'apart', 'bisect', 'confirm']);

/**
 * The next step of a round of a train, from the results so far. Pure: no git, no file. in: lanes, results, ties and
 * the retry and bisect settings. out: { step, group?, run: 'complete' | 'name', lands, ... }.
 * The order: retries by name, the target alone (a probe), the suspect, the prefix search, a culprit alone (confirm).
 * When the red names its tests and byNameOk, narrowing steps run only those tests.
 */
export function nextStep({ lanes = [], results = [], ties = undefined, flaky = () => false, flakyRetries = 2, stageRetry = false, targetRed = [], knownRed = false, bisectMax = 3, namesOk = (n) => Boolean(retryNames(n)), byNameOk = false, pair = false } = {}) {
  const C = { run: 'complete', lands: true };
  if (!results.length) return { step: 'land', group: lanes.slice(), ...C };
  const landed = new Set(results.filter((x) => x.status === 'pass' && LANDS.has(x.kind) && !x.byName).flatMap((x) => x.group || []));
  const left = lanes.filter((t) => !landed.has(t));
  if (!left.length) return { step: 'done' };
  const last = results[results.length - 1];
  // A lane the merge itself names is handed back for its conflict; the rest go on as a new round.
  if (last.kind !== 'probe' && last.status === 'conflict' && last.lane) return { step: 'handback', lanes: [last.lane], cause: 'conflict', red: last, rounds: [left.filter((t) => t !== last.lane)] };
  const of = (k) => results.filter((x) => x.kind === k);
  const opening = results.filter((x) => ['land', 'retry', 'known-red'].includes(x.kind));
  const main = [...opening].reverse().find((x) => x.status === 'red' || x.status === 'conflict') || results[0];
  const F = [...new Set(Array.isArray(main.failures) ? main.failures : [])];
  const flakyOnly = F.length > 0 && F.every((n) => flaky(n)) && !main.compileOnly;
  const asNamed = F.length > 0 && namesOk(F) ? { run: 'name', lands: true } : C;
  const inOpening = results.every((x) => ['land', 'retry', 'known-red', 'probe'].includes(x.kind));
  if (inOpening) {
    const retries = of('retry').length;
    const probe = of('probe')[0] || null;
    const kr = of('known-red')[0] || null;
    const proven = flakyOnly && F.every((n) => targetRed.includes(n));
    if (flakyOnly && !probe && !proven && retries < flakyRetries) return { step: 'retry', group: left, tests: F, known: true, n: retries + 1, ...asNamed };
    if (!flakyOnly && !main.compileOnly && stageRetry && retries < 1) return { step: 'retry', group: left, tests: F, known: false, n: 1, ...asNamed };
    if (flakyOnly && !probe && !proven && namesOk(F)) return { step: 'probe', group: [], tests: F, run: 'name', lands: false };
    const onTarget = proven ? F : probe?.status === 'red' ? ((probe.failures || []).filter((n) => F.includes(n)).length ? (probe.failures || []).filter((n) => F.includes(n)) : F) : [];
    if (flakyOnly && onTarget.length) {
      const otherRed = kr && kr.status === 'red' && (kr.failures || []).some((n) => !onTarget.includes(n));
      if (!otherRed) {
        if (knownRed && !kr) return { step: 'known-red', group: left, tests: F, known: onTarget, ...asNamed };
        return { step: 'wait-target', group: left, tests: onTarget, proof: probe ? 'probe' : 'earlier' };
      }
    }
  }
  // The narrowing steps: by name (land nothing) when the red names its tests and the land script honours STUDIO_LAND_PROBE.
  const byName = byNameOk && main.status === 'red' && !main.compileOnly && F.length > 0 && namesOk(F);
  const N = byName ? { run: 'name', lands: false, tests: F, byName: true } : C;
  const w = of('without')[0];
  const a = of('apart')[0];
  if (w?.status === 'pass') return { step: 'handback', lanes: [w.suspect], cause: 'evidence', red: main, rounds: byName ? [left.filter((t) => t !== w.suspect)] : [] };
  if (a?.status === 'pass' && !byName) return { step: 'next-round', rounds: [a.tied || []] };
  const bis = of('bisect');
  if (left.length === 1 && !bis.length && !of('confirm').length) return { step: 'handback', lanes: left, cause: 'red', red: main, rounds: [], proof: 'alone' };
  const apartGreen = byName && a?.status === 'pass';
  if (!bis.length && !apartGreen) {
    if (ties === undefined) return { step: 'ties', red: main };
    if (!w && !a && ties?.compile?.length) return { step: 'handback', lanes: ties.compile, cause: 'compile', red: main, rounds: [left.filter((t) => !ties.compile.includes(t))] };
    if (!w && !a && ties?.suspect && left.includes(ties.suspect)) return { step: 'without', group: left.filter((t) => t !== ties.suspect), suspect: ties.suspect, ...N };
    if (!w && !a && (ties?.tied || []).length >= 2 && (ties?.untied || []).length) return { step: 'apart', group: ties.untied.slice(), tied: ties.tied.slice(), ...N };
  }
  // The prefix search. Complete runs: a green prefix lands and the search goes on past it. By name: nothing lands, so each step
  // runs the whole prefix; an untied group found green by name is a green prefix to start from.
  const order = apartGreen ? [...a.group, ...a.tied.filter((t) => !a.group.includes(t))] : lanes.slice();
  const sig = F.length ? new Set(F) : null;
  let lo = apartGreen ? a.group.length : 0;
  let hi = order.length;
  let bad = main;
  // 2.90: a step's prefix length (n) when every step has one (two steps of one round, on two gates); else the halving order.
  if (bis.length && bis.every((b) => Number.isFinite(b.n))) {
    for (const b of bis) if (b.status !== 'pass' && b.n > lo && b.n < hi) { hi = b.n; bad = b; }
    for (const b of bis) if (b.status === 'pass' && b.n > lo && b.n < hi) lo = b.n;
  } else for (const b of bis) { const mid = Math.floor((lo + hi) / 2); if (b.status === 'pass') lo = mid; else { hi = mid; bad = b; } }
  const after = (t) => (byName ? order.filter((x) => x !== t) : order.slice(order.indexOf(t) + 1));
  if (!byName && hi - lo > 1 && sig && bis.length >= bisectMax) return { step: 'handback', lanes: order.slice(lo, hi), cause: 'capped', red: bad, rounds: [order.slice(hi)], green: order.slice(0, lo), runs: bis.length };
  // 2.90 (pair: a second gate): by name, two prefixes at a third and two thirds, run at once; neither lands.
  if (pair && byName && hi - lo >= 3) { const a = lo + Math.round((hi - lo) / 3); const b = lo + Math.round((2 * (hi - lo)) / 3); return { step: 'bisect', group: order.slice(0, a), prefix: order.slice(0, a), ...N, also: { group: order.slice(0, b), prefix: order.slice(0, b) } }; }
  if (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); return { step: 'bisect', group: byName ? order.slice(0, mid) : order.slice(lo, mid), prefix: order.slice(0, mid), ...N }; }
  const culprit = order[hi - 1];
  const conf = of('confirm')[0];
  if (conf) {
    if (conf.status === 'pass') return { step: 'next-round', passedAlone: culprit, rounds: byName ? [order.slice(0, hi - 1), [culprit], order.slice(hi)].filter((x) => x.length) : [order.slice(hi)] };
    return { step: 'handback', lanes: [culprit], cause: 'red', red: conf, rounds: [after(culprit)], proof: 'alone', green: order.slice(0, hi - 1) };
  }
  // No blame by elimination (2.83): a culprit that was not red by itself is run alone first (by name when the names are known).
  if (!((bad.group || []).length === 1 && bad.group[0] === culprit)) return { step: 'confirm', group: [culprit], ...N };
  return { step: 'handback', lanes: [culprit], cause: 'red', red: bad, rounds: [after(culprit)], proof: 'alone', green: order.slice(0, hi - 1) };
}

/**
 * `bisect-plan`: the steps nextStep would take for made-up outcomes (read-only, nothing runs). lanes: task ids in
 * order; red: lanes that break any group; flakyRed; targetRed; passOnRetry; tied; byName: the land script honours
 * STUDIO_LAND_PROBE; noNames: the red names no test. landMin / nameMin: minutes of a complete run and of a run by
 * name. [{ step, group, status, run, lands, minutes }].
 */
export function bisectPlan({ lanes = [], red = [], flakyRed = false, targetRed = false, passOnRetry = 0, tied = [], flakyRetries = 2, bisectMax = 3, knownRed = false, byName = true, noNames = false, landMin = 60, nameMin = 5 } = {}) {
  const TF = 'Made.Up.Flaky.Test';
  const TR = 'Made.Up.Red.Test';
  const steps = [];
  const pending = [lanes.slice()];
  for (let guard = 0; guard < 80 && pending.length;) {
    const round = pending.shift();
    if (!round.length) continue;
    const results = [];
    let retry = 0;
    for (; guard < 80; guard += 1) {
      const t = results.length ? (tied.length === 1 && round.includes(tied[0]) ? { suspect: tied[0], tied, untied: round.filter((x) => !tied.includes(x)) } : tied.filter((x) => round.includes(x)).length >= 2 ? { suspect: null, tied: tied.filter((x) => round.includes(x)), untied: round.filter((x) => !tied.includes(x)) } : null) : undefined;
      const st = nextStep({ lanes: round, results, ties: t, flaky: (n) => n === TF, flakyRetries, stageRetry: false, knownRed, bisectMax, byNameOk: byName, namesOk: () => !noNames });
      if (st.step === 'done') break;
      if (['handback', 'next-round', 'wait-target'].includes(st.step)) {
        steps.push({ step: st.step, group: st.lanes || st.group || [], ...(st.cause ? { cause: st.cause } : {}) });
        if (st.step !== 'wait-target') pending.unshift(...(st.rounds || []).filter((x) => x.length));
        else pending.length = 0;
        break;
      }
      const g = st.group || [];
      if (st.step === 'retry') retry += 1;
      const lanesRed = g.some((x) => red.includes(x));
      // Made-up outcomes: a red lane breaks every group it is in; a test red on the target breaks every run but one that leaves it
      // out (known-red); a flaky test that passes on retry N breaks the first land run and the retries before N.
      let bad = false;
      if (st.step === 'known-red') bad = lanesRed;
      else if (st.step === 'probe') bad = flakyRed && targetRed;
      else if (lanesRed || (flakyRed && targetRed)) bad = true;
      else if (flakyRed && passOnRetry > 0) bad = (st.step === 'land' && !results.length && steps.filter((x) => x.status).length === 0) || (st.step === 'retry' && retry < passOnRetry);
      const status = bad ? 'red' : 'pass';
      steps.push({ step: st.step, group: g, status, run: st.run, lands: st.lands, minutes: st.run === 'name' ? nameMin : landMin });
      results.push({ kind: st.step, group: g, status, failures: bad ? [flakyRed ? TF : TR] : [], byName: Boolean(st.byName), ...(st.suspect ? { suspect: st.suspect } : {}), ...(st.tied ? { tied: st.tied } : {}) });
      guard += 1;
    }
  }
  return steps;
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
 * Is a full land run due? Every STUDIO_ENGINE_FULL_LAND_HOURS (engines.<x>.fullLandHours, 24; 0 or off: never),
 * counted from the last full run that passed ({ at, id } in .studio/engine/<engine>-full-land.json). No record: the
 * clock starts now. Returns { why, overdue, hours, maxHours }. Past engines.<x>.fullLandMaxHours (default 2 x the
 * hours) it is overdue: 2.91, it runs at the end of the next train, after the batch's rounds. It runs on the target alone.
 */
const fullLandFile = (root, engine) => path.join(root, '.studio', 'engine', `${engine}-full-land.json`);
export function fullLandDue(root, engine, cfg = {}, env = process.env, now = Date.now(), { start = true } = {}) {
  const raw = String(env.STUDIO_ENGINE_FULL_LAND_HOURS ?? cfg.fullLandHours ?? '').trim();
  const no = { why: '', overdue: false, hours: null, maxHours: null };
  if (/^(off|false|no)$/i.test(raw)) return no;
  const h = raw === '' ? 24 : Number(raw);
  if (!Number.isFinite(h) || h <= 0) return no;
  const mx = Number(cfg.fullLandMaxHours);
  const maxHours = Number.isFinite(mx) && mx >= h ? mx : 2 * h;
  const at = Date.parse(readJson(fullLandFile(root, engine))?.at || '');
  if (!Number.isFinite(at)) {
    if (start) { try { fs.mkdirSync(path.dirname(fullLandFile(root, engine)), { recursive: true }); writeJson(fullLandFile(root, engine), { at: new Date(now).toISOString(), id: null, clock: 'started' }); } catch { /* asked again next time */ } }
    return { ...no, hours: h, maxHours };
  }
  const age = now - at;
  if (age < h * 3600000) return { ...no, hours: h, maxHours };
  const overdue = age >= maxHours * 3600000;
  return { why: overdue ? `the last full land run that passed is older than ${maxHours} h (engines.${engine}.fullLandMaxHours): overdue` : `the last full land run that passed is older than ${h} h`, overdue, hours: h, maxHours };
}

/** 2.91: is the full rules run owed now on the target as it is (engine-rules.mjs fullRulesOwed)? { why, overdue, blocked }. */
export function fullRulesOwedNow(root, engine = 'unity', env = process.env, now = Date.now()) {
  const s = unityTrainSettings(root, engine);
  if (s.error) return { why: '' };
  const rc = rulesConfig(engine, { root, env, repo: s.repo, ref: s.target });
  return rc ? fullRulesOwed(root, engine, rc, { repo: s.repo, tip: headOf(s.repo, s.target), now }) : { why: '' };
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
      const fold = foldRealOf(real);
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

/** 2.96 (c4): the merge.union globs a train uses: none when a landMany command merges the branches itself. */
export const unionOf = (cfg) => (cfg && !landManyCommand(cfg) ? unionGlobs(cfg) : []);

/**
 * target + each lane, in order, as commit objects only (no worktree, no index, no ref moved). A lane already in the
 * chain is `already`; one whose merge conflicts is `conflictTarget` (it conflicts with the target alone) or `deferred`
 * (only with lanes before it). 2.96 (c4): a conflict only in merge.union files that both sides only grow is merged as a
 * union (merge-union.mjs; `union`: [{ task, files }]). { head, included, deferred, conflictTarget, already, union } or { error }.
 */
export function chainOnTarget(repo, base, lanes, id, engine = 'unity', { union = unionOf(unityConfig(REPO_ROOT, engine)) } = {}) {
  let tip = base;
  const res = { included: [], deferred: [], conflictTarget: [], already: [], union: [] };
  for (const lane of lanes) {
    if (isAncestor(repo, lane.head, tip)) { (tip === base ? res.already : res.included).push({ ...lane }); continue; }
    if (isAncestor(repo, tip, lane.head)) { tip = lane.head; res.included.push({ ...lane }); continue; }
    const mt = git(repo, 'merge-tree', '--write-tree', tip, lane.head);
    const un = mt.status === 1 ? unionMerge(repo, tip, lane.head, union) : null;
    if (mt.status === 0 || un) {
      const tree = un ? un.tree : String(mt.stdout).split('\n')[0].trim();
      const msg = `${engine} train ${id}: land ${lane.task} (${lane.branch})\n\n${un ? `Union-Merge: ${un.files.join(', ')} (engines.${engine}.merge.union: both sides only added lines)\n` : ''}Studio-Train: ${id} ${lane.task}`;
      const c = spawnSync('git', ['commit-tree', tree, '-p', tip, '-p', lane.head, '-m', msg], { windowsHide: true, cwd: repo, encoding: 'utf8', env: { ...process.env, ...BOT } });
      if (c.status !== 0) return { error: `git commit-tree failed: ${String(c.stderr || '').trim().split('\n').pop()}` };
      if (un) res.union.push({ task: lane.task, files: un.files, with: tip === base ? 'the target' : res.included.map((l) => l.task).join(', ') || 'the target' });
      tip = c.stdout.trim();
      res.included.push({ ...lane, ...(un ? { union: un.files } : {}) });
      continue;
    }
    if (mt.status !== 1) return { error: `git merge-tree --write-tree failed (git 2.38 or newer is needed): ${String(mt.stderr || '').trim().split('\n').pop()}` };
    const files = conflictFiles(mt.stdout);
    const alone = tip === base ? mt : git(repo, 'merge-tree', '--write-tree', base, lane.head);
    if (alone.status === 0 || (tip !== base && unionMerge(repo, base, lane.head, union))) res.deferred.push({ ...lane, files, why: `it conflicts with ${res.included.map((l) => `${l.task} (${l.branch})`).join(', ') || 'the branches before it'} in this train${files.length ? ` in ${files.slice(0, 5).join(', ')}` : ''}; it goes in the next ${labelOf(engine)} train` });
    else res.conflictTarget.push({ ...lane, files: conflictFiles(alone.stdout), why: `it conflicts with the target${conflictFiles(alone.stdout).length ? ` in ${conflictFiles(alone.stdout).slice(0, 5).join(', ')}` : ''}: bring the target into it with ${targetMergeCommand(lane.task)} (it leaves the conflicts in the task's worktree to resolve; small conflicts in project files usually want both sides kept), then task done --train again` });
  }
  return { ...res, head: tip };
}

// ---- the train ----

/** The batch a train takes from `queued` (harness/engine-train-control.mjs selectBatch with this engine's settings). */
function pickBatch(root, engine, s, queued, { only = [], tag = null, max = 0, env = process.env, held = null } = {}) {
  const { repo, target } = s;
  // 2.86: lanes a train left waiting for the target (red on it alone) sit out until it moves; engines.<x>.batchAlone paths land alone.
  return selectBatch(queued, { only, tag, max, ...batchLimits(s.cfg, env), classOf: (l) => laneClass({ repo, target, cfg: s.cfg, lane: l }), waits: waitingOnTarget(root, engine, queued), aloneOf: (l) => laneAloneWhy({ repo, target, cfg: s.cfg, lane: l }), held });
}

/** 2.96 (c1): queued lanes whose task waits for another task (task after), as the train reads the board now: Map task -> why. */
function heldLanes(queued, board, holdMod) {
  const m = new Map();
  if (!board || !holdMod) return m;
  for (const e of queued) { let w = []; try { w = holdMod.afterWaits(e.task, board); } catch { w = []; } if (w.length) m.set(e.task, `waits for ${w.join(', ')} (task after)`); }
  return m;
}
/** 2.96 (c1): the same for `train status` (task.mjs passes the board); null without one (status then shows the last train's record). */
export async function heldNow(root, engine, board) {
  if (!board) return null;
  try { return heldLanes(readUnityQueue(root, engine), board, await import('./task-hold.mjs')); } catch { return null; }
}
const heldFile = (root, engine) => path.join(root, '.studio', 'engine', `${engine}-held.json`);
/**
 * 2.96 (c1): record the lanes left out as held; one event per lane the first time (again only after its hold cleared or
 * its reason changed). add: keep the others (a lane left out before a land run), else the record is this pick's set.
 */
function noteHeld(root, engine, held, { id, by, queued, add = false, when = 'when the batch was picked' }) {
  const prev = readJson(heldFile(root, engine)) || {};
  const next = add ? { ...prev } : {};
  for (const [task, why] of held) {
    if (prev[task]?.why === why) { next[task] = prev[task]; continue; }
    next[task] = { why, since: new Date().toISOString(), train: id };
    evTop('held', id, `${task} held: ${why}; left out ${when}: it stays queued, takes no seat and is not handed back; the first train after the hold clears takes it`, { engine, task, agent: by, to: queued.find((e) => e.task === task)?.agent, status: 'warn', meta: { why, when: add ? 'land' : 'pick' } });
  }
  try { writeJson(heldFile(root, engine), next); } catch { /* the event stands */ }
}

/** Each lane of a batch as it is now: { lane, defer } or { lane, drop } (nobody blamed), else { lane (its head now), moved }. */
function laneStates(lanes, { repo, target, board, holdMod, L }) {
  return lanes.map((lane) => {
    const held = holdMod ? holdMod.afterWaits(lane.task, board) : [];
    if (held.length) return { lane, defer: `it waits for ${held.join(', ')} (task after)` };
    // 2.92: the queue door found it does not compile with a lane of this batch: it waits, as a lane that conflicts with one.
    const clash = (lane.clash?.with || []).filter((t) => lanes.some((l) => l.task === t));
    if (clash.length) return { lane, defer: `it does not compile with ${clash.join(', ')} in this train (found when it was queued); it is checked again once ${clash.length === 1 ? 'that lane has' : 'they have'} landed or left the queue` };
    const head = headOf(repo, lane.branch);
    if (!head) return { lane, drop: `its branch ${lane.branch} is gone from the ${L} repo; queue it again` };
    const moved = head !== lane.head ? head : null;
    if (isAncestor(repo, head, `refs/heads/${target}`)) return { lane, moved, drop: `${lane.branch} has no commits that ${target} doesn't have; task done ${lane.task} closes it` };
    return { lane: { ...lane, head }, moved };
  });
}

/**
 * 2.96 (c2): the lanes as they are now (laneStates) and their merge on the target (chainOnTarget). A lane that cannot go
 * (deferred, dropped, a conflict) is an `out` and, with `repick`, the batch is picked again without it (at most 3 times),
 * so it decides no class and takes no seat. { sel, lanes, outs: [{ lane, kind, why, files? }], moved, pre, repicked } | { error }.
 */
function formBatch(sel0, { repick, repo, target, tip, board, holdMod, L, id, engine, union }) {
  let sel = sel0;
  const outs = [];
  const moved = new Map();
  const skip = new Set();
  for (let pass = 0; ; pass += 1) {
    const now = [];
    const ready = [];
    for (const x of laneStates(sel.lanes, { repo, target, board, holdMod, L })) {
      if (x.moved) moved.set(x.lane.task, { lane: x.lane, from: sel.lanes.find((l) => l.task === x.lane.task).head, to: x.moved });
      if (x.defer) now.push({ lane: x.lane, kind: 'defer', why: x.defer });
      else if (x.drop) now.push({ lane: x.lane, kind: 'gone', why: x.drop });
      else ready.push(x.lane);
    }
    const pre = chainOnTarget(repo, tip, ready, id, engine, { union });
    if (pre.error) return { error: pre.error };
    for (const l of pre.conflictTarget) now.push({ lane: l, kind: 'conflictTarget', why: l.why, files: l.files });
    for (const l of pre.deferred) now.push({ lane: l, kind: 'defer', why: l.why });
    for (const l of pre.already) now.push({ lane: l, kind: 'already' });
    outs.push(...now);
    if (!now.length || !repick || pass >= 3) return { sel, lanes: sel.lanes, outs, moved, pre, repicked: pass };
    for (const o of now) skip.add(o.lane.task);
    const nx = repick(skip);
    const keep = new Set(pre.included.map((l) => l.task));
    if (nx.error || nx.lanes.every((l) => keep.has(l.task))) return { sel, lanes: sel.lanes, outs, moved, pre, repicked: pass };
    sel = { ...nx, why: `${nx.why}; picked again without ${[...skip].join(', ')} (${skip.size === 1 ? 'it' : 'they'} could not go)` };
  }
}

/** 2.94: a kept check ahead's lanes, all queued and unchanged, when the target is the tree it was built on: { train, lanes } or null. */
function aheadSet(root, engine, queued, { repo, tip, cfg }) {
  const m = readJson(path.join(root, '.studio', 'engine', `${engine}-rules-ahead.json`));
  if (m?.verdict !== 'kept' || !Array.isArray(m.tasks) || readJson(path.join(root, '.studio', 'engine', `${engine}-rules-ahead-out.json`))?.state === 'not-started') return null;
  const ls = m.tasks.map((t, i) => queued.find((e) => e.task === t && e.head === m.heads[i]));
  try { return ls.every(Boolean) && rulesKey({ repo, sha: tip, cfg }) === m.baseKey ? { train: m.train, lanes: ls } : null; } catch { return null; }
}

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
  // 2.93: where the train's time went, in ms: compile, rules, wait (for the machine before a land run), land (the runs themselves).
  const t0 = Date.now();
  const spent = { compile: 0, rules: 0, wait: 0, land: 0 };
  let landRuns = 0;
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
  // 2.93: the board gives a lane's task title (preQueue "titles") and the "task after" holds; 2.96 (c1): a held lane is left out before the pick.
  const board = (() => { try { return deps.board?.() || null; } catch { return null; } })();
  const holdMod = board ? await import('./task-hold.mjs') : null;
  const heldPick = heldLanes(queued, board, holdMod);
  if (!dryRun) noteHeld(root, engine, heldPick, { id, by, queued });
  if (heldPick.size) log(`[unity-train] ${id}: left out, held: ${[...heldPick].map(([t, w]) => `${t} (${w})`).join('; ')}; they stay queued`);
  let sel = pickBatch(root, engine, s, queued, { only, tag, max, env, held: heldPick });
  if (sel.error) { res.ok = false; res.message = `No ${L} branch landed: ${sel.why} (--only takes queued tasks).`; return finish(); }
  let lanes = sel.lanes;
  res.batch = sel.why;
  if (heldPick.size) res.held = [...heldPick].map(([task, why]) => ({ task, why }));
  // 2.91: the periodic full runs (the full rules run rules.focus.fullEveryHours owes, the daily full land run) are runs of the target
  // alone and never go ahead of a waiting batch: due, they run when this train has no lane; overdue, after the batch's rounds.
  const fullDue = dryRun ? { why: '' } : fullLandDue(root, engine, s.cfg, env, Date.now());
  const rc0 = dryRun ? null : (() => { try { return rulesConfig(engine, { root, env, repo, ref: target }); } catch { return null; } })();
  // 2.94: the set a check ahead ran for, when every one of its lanes is unchanged (rules.ahead; harness/rules-ahead.mjs).
  const pref0 = rc0?.ahead && !only.length && !tag ? aheadSet(root, engine, queued, { repo, tip: headOf(repo, target), cfg: rc0 }) : null;
  const pref = pref0 && !pref0.lanes.some((l) => heldPick.has(l.task)) ? pref0 : null;
  if (pref && pref.lanes.map((l) => l.task).join() !== lanes.map((l) => l.task).join()) {
    log(`[unity-train] ${id}: takes the set the check ahead of train ${pref.train} ran for: ${pref.lanes.map((l) => l.task).join(', ')}${queued.length > pref.lanes.length ? `; the ${queued.length - pref.lanes.length} other queued lane(s) ride the train after` : ''}`);
    lanes = pref.lanes;
    res.batch = `${sel.why}; the set checked ahead`;
  }
  const owed0 = rc0 ? fullRulesOwed(root, engine, rc0, { repo, tip: headOf(repo, target) }) : { why: '' };
  const fullFirst = Boolean(fullDue.why && !lanes.length);
  const fullLast = Boolean(fullDue.why && fullDue.overdue && lanes.length);
  const rulesFirst = Boolean(owed0.why && !lanes.length);
  if (owed0.blocked) log(`[unity-train] ${id}: the full rules run is owed (${owed0.blocked.owed}) but was ${owed0.blocked.status} on ${target} at ${short(owed0.blocked.tip)} (${String(owed0.blocked.at).slice(0, 16)}) and the rules tests see no change since: not run again yet`);
  if (!lanes.length && !fullFirst && !rulesFirst) { res.message = queued.length ? `No ${L} branch for this train (${sel.why}).` : `No ${L} branch is waiting to land (task done <ID> --train on a ${L}-track task queues one).`; return finish(); }
  // 2.96 (c2): a lane that cannot go (deferred, dropped, a conflict) is taken out and the batch picked again without it.
  const union = unionOf(s.cfg);
  const tip0 = headOf(repo, target);
  const formed = formBatch(pref ? { ...sel, lanes } : sel, { repick: pref || only.length ? null : (skip) => pickBatch(root, engine, s, queued.filter((e) => !skip.has(e.task)), { only, tag, max, env, held: heldPick }), repo, target, tip: tip0, board, holdMod, L, id, engine, union });
  if (formed.error) { res.ok = false; res.message = `The ${L} train could not check the branches: ${formed.error}. Nothing ran; the queue is kept.`; return finish(); }
  if (formed.repicked) { sel = formed.sel; lanes = formed.lanes; res.batch = sel.why; }
  if (sel.alone) res.alone = sel.alone;
  if (sel.waiting || formed.repicked) log(`[unity-train] ${id}: batch ${sel.why}`);
  if (lanes.length && fullDue.why) {
    const m = `the daily full land run is due (${fullDue.why}) and ${lanes.length} lane(s) wait: it does not go ahead of them; ${fullLast ? `it runs at the end of this train, after the batch's rounds, on ${target} as it is then` : `it waits for an empty queue (past engines.${engine}.fullLandMaxHours it runs at the end of a train)`}`;
    log(`[unity-train] ${id}: ${m}`);
    ev('full_land', id, m, { agent: by, to: 'producer', meta: { why: fullDue.why, tasks: lanes.map((l) => l.task), waits: fullLast ? 'end' : 'empty-queue', overdue: Boolean(fullDue.overdue) } });
  }
  if (lanes.length && owed0.why) {
    const m = `the full rules run is owed (${owed0.why}) and ${lanes.length} lane(s) wait: this train's rules check runs as if it were not, and the full run ${owed0.overdue ? `runs on ${target} alone at the end of this train, after the batch's rounds` : `waits for an empty queue (past rules.focus.fullEveryMaxHours it runs at the end of a train)`}`;
    log(`[unity-train] ${id}: ${m}`);
    ev('rules_full', id, m, { agent: by, to: 'producer', meta: { why: owed0.why, tasks: lanes.map((l) => l.task), waits: owed0.overdue ? 'end' : 'empty-queue', overdue: Boolean(owed0.overdue) } });
  }
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
  // 2.96 (c3): lanes whose hold was set after the pick: out of this train, still queued, nobody blamed.
  const leaveOutHeld = (now) => {
    for (const [task, why] of now) {
      live.delete(task);
      res.held = [...(res.held || []), { task, why, at: 'land' }];
      log(`[unity-train] ${id}: ${task} held: ${why}; set after this train started, so it is left out before the land run: it stays queued and is not handed back`);
      try { deps.clearRunning?.(task); } catch { /* the finally clears it too */ }
    }
    liveNow();
    noteHeld(root, engine, now, { id, by, queued, add: true, when: 'before the land run (the hold was set after the train started)' });
  };
  const defer = (lane, why) => { res.deferred.push({ task: lane.task, why }); if (!dryRun) ev('deferred', id, `${lane.task} waits for the next ${L} train: ${why.split('\n')[0]}`, { task: lane.task, agent: by, to: lane.agent, status: 'warn' }); };

  const titleOf = (t) => [...(board?.inProgress || []), ...(board?.backlog || []), ...(board?.done || [])].find((x) => x.id === t)?.title || '';
  // (a) Each branch as it is now and (b) its conflicts against the target and between branches, from refs only (formBatch).
  for (const m of formed.moved.values()) log(`[unity-train] ${id}: ${m.lane.task}'s branch ${m.lane.branch} moved since it was queued (${short(m.from)} -> ${short(m.to)}); the branch as it is now goes in`);
  for (const o of formed.outs) {
    if (o.kind === 'defer') defer(o.lane, o.why);
    else if (o.kind === 'gone') drop(o.lane, o.why, { handBack: false });
    else if (o.kind === 'conflictTarget') drop(o.lane, o.why, { evidence: { files: o.files || [] } });
    else drop(o.lane, `${o.lane.branch} is already in ${target}; task done ${o.lane.task} closes it`, { handBack: false });
  }
  const pre = formed.pre;
  // 2.96 (c4): files merged as a union, in the log, one event and the summary.
  if (pre.union.length) {
    res.union = pre.union;
    const m = `merged as a union (engines.${engine}.merge.union; both sides only added lines): ${pre.union.map((u) => `${u.files.join(', ')} (${u.task} with ${u.with})`).join('; ')}; the compile check and the tests decide`;
    log(`[unity-train] ${id}: ${m}`);
    if (!dryRun) ev('union', id, m, { agent: by, meta: { union: pre.union } });
    update({ union: [...new Set(pre.union.flatMap((u) => u.files))] });
  }
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
  // 2.92: a lane's preQueue check that judged another target tip (or head) runs again on the lane merged with this tip.
  if (preQueueOf(s.cfg).length) {
    const kept = [];
    let told = false;
    for (const l of set) {
      if (l.preQueue && l.preQueue.target === tip0 && l.preQueue.head === l.head) { kept.push(l); continue; }
      const q0 = Date.now();
      const pq = runPreQueue(s, { ...l, title: titleOf(l.task) }, { root, env });
      spent.rules += Date.now() - q0;
      if (pq.bad.length && !told) { told = true; log(`[unity-train] ${id}:${badWords(pq.bad, engine).replace(/\n/g, ' ')}`); }
      if (pq.refused) { drop(l, `refused before the land run: ${pq.refused}`, { cause: 'pre-queue', evidence: { files: pq.files } }); continue; }
      if (pq.ran.length || pq.skipped) log(`[unity-train] ${id}: pre-queue check of ${l.task} on ${target} at ${short(tip0)}: ${pq.skipped ? `could not run (${pq.skipped}); it goes on` : 'passed'}`);
      kept.push(l);
    }
    set = kept;
  }
  // 2.90: the compile search (harness/engine-compile.mjs): the batch compiled with the cheap compile command before anything long.
  // Lanes that do not compile with the ones before them are handed back with the compiler's lines (cause 'compile').
  // 2.92: also a batch of one the queue door marked, once its clash partner has landed or left the queue.
  const cc = compileSearchOf(s.cfg);
  if (cc && (set.length > 1 || set.some((l) => l.clash))) {
    update({ now: `compile search: ${set.map((l) => l.task).join(', ')}` });
    const rc = (() => { try { return rulesConfig(engine, { root, env, repo, ref: target }); } catch { return null; } })();
    const cs0 = Date.now();
    const cs = compileSearch({ repo, tip: tip0, lanes: set, chain: (t, ls) => chainOnTarget(repo, t, ls, id, engine, { union }), at: (sha) => compileAt({ repo, sha, cmd: cc, root, id, engine, rules: rc, env, log }) });
    spent.compile += Date.now() - cs0;
    log(`[unity-train] ${id}: compile search (engines.${engine}.${cc.source}): ${cs.why} (${cs.runs} compile run(s))`);
    res.compile = { runs: cs.runs, left: cs.left.map((x) => x.lane.task), ...(cs.targetRed ? { targetRed: true } : {}) };
    if (cs.left.length || cs.targetRed) ev('compile_search', id, `${cs.why}; ${cs.runs} compile run(s) of engines.${engine}.${cc.source}, no land run`, { agent: by, status: cs.left.length ? 'warn' : 'ok', meta: { runs: cs.runs, left: cs.left.map((x) => x.lane.task), kept: cs.kept.map((l) => l.task), ...(cs.targetRed ? { targetRed: true } : {}) } });
    for (const x of cs.left) drop(x.lane, `refused before the land run: ${noCompileText(x, { target, engine, cc, where: 'which go on in this train' })}`, { cause: 'compile', evidence: { files: x.files } });
    set = set.filter((l) => !cs.left.some((x) => x.lane.task === l.task));
  }
  // The rules check on the batch as it would land (harness/engine-rules.mjs), before the long land run. A lane that turns the batch red is
  // handed back with cause 'rules'; a check that is red on the target itself judges nobody. The land run then gets STUDIO_RULES_GREEN=1 while it
  // lands exactly the checked batch on the checked target with the checked inputs (re-looked at right before the land run).
  let rulesGreen = null;
  const fromAll = [...new Set([s.folder, s.cfg.gateWorktree ? path.resolve(root, s.cfg.gateWorktree) : null, s.cfg.cwd ? path.resolve(root, s.cfg.cwd) : null, repo].filter(Boolean))];
  {
    const rc = rc0;
    if (rc && set.length) {
      update({ now: `rules check: ${set.map((l) => l.task).join(', ')}` });
      const from = fromAll;
      // Each lane's new shared input files first (rules.share), and the lanes' own folders as further input sources.
      for (const l of set) { try { shareLaneInputs(root, engine, s, l.task, log); } catch { /* the check says what is missing */ } }
      const extraFrom = set.map((l) => path.join(root, '.lanes', 'engine', String(l.task))).filter((d) => fs.existsSync(d));
      // 2.94: a check ahead for exactly this batch's tree is waited for (never run twice); one for another tree is ended.
      const aw0 = Date.now();
      const aw = await aheadFor(root, engine, { train: id, log: (m) => log(`[unity-train] ${id}: the check ahead ${m}`), key: () => { try { const c = chainOnTarget(repo, tip0, set, id, engine, { union }); return c.head ? rulesKey({ repo, sha: c.head, cfg: rc }) : null; } catch { return null; } } });
      spent.rules += Date.now() - aw0;
      const rg0 = Date.now();
      const rg = (deps.rulesGate || rulesGate)({ engine, repo, tip: tip0, lanes: set, cfg: rc, from, extraFrom, owe: true, root, id, env, log, chain: (t, ls) => chainOnTarget(repo, t, ls, id, engine, { union }) });
      spent.rules += Date.now() - rg0;
      log(`[unity-train] ${id}: rules check: ${rg.why}${rg.runs ? ` (${rg.runs} run(s), ${Math.round(rg.ms / 1000)} s)` : ''}${aw && ['pass', 'red'].includes(aw.status) ? `; the batch's result came from the check ahead of train ${aw.train}${aw.waitedMs >= 1000 ? ` (waited ${Math.round(aw.waitedMs / 6000) / 10} min for it)` : ''}` : ''}${aw?.status === 'partial' ? `; the check ahead of train ${aw.train} finished some shards, this train ran the rest` : ''}`);
      // 2.90: a check that judged no lane because of the target is said where people look (event; train status after 2 in a row).
      if (rg.noJudge) ev('rules_no_judge', id, `the rules check judged no lane${rg.noJudge.n > 1 ? ` (${rg.noJudge.n} trains in a row, ${Math.round(rg.noJudge.minutes)} min spent)` : ''}: ${rg.why}`, { agent: by, to: 'producer', status: 'warn', meta: { n: rg.noJudge.n, minutes: rg.noJudge.minutes, timeout: Boolean(rg.timedOut), fix: rg.noJudge.fix } });
      if (rg.noJudge && rg.calibration === 'red' && !rg.timedOut) targetRedTask(root, { engine, target, source: 'rules', tests: rg.redTests, why: rg.noJudge.why, train: id }); else if (rg.ran) targetRedClear(root, engine, 'rules');
      for (const d of rg.dropped) drop(d.lane, `refused before the land run: ${d.why}\nFix it on ${d.lane.branch} (bring ${target} in first: ${targetMergeCommand(d.lane.task)}), then task done ${d.lane.task} --train again.`, { cause: 'rules' });
      set = rg.kept;
      res.rules = { ran: rg.ran, runs: rg.runs, ms: rg.ms, dropped: rg.dropped.map((d) => d.lane.task), ...(rg.skipped ? { skipped: rg.why } : {}), ...(rg.mode ? { mode: rg.mode } : {}), ...(rg.selWhy ? { why: rg.selWhy } : {}), ...(rg.parts ? { parts: rg.parts } : {}), ...(rg.splitAtOnce ? { splitAtOnce: rg.splitAtOnce } : {}), ...(rg.filter ? { filter: rg.filter } : {}), ...(rg.groups ? { groups: rg.groups } : {}), ...(rg.reused ? { reused: rg.reused } : {}), ...(rg.sliced ? { sliced: rg.sliced, slices: rg.slices } : {}), ...(rg.shards ? { shards: rg.shards } : {}) };
      // 2.91: keeps(tip): with rules.paths or rules.ignore, a target that moved only where the rules tests do not read keeps the green.
      const scope = rc.paths?.length ? 'outside rules.paths' : rc.ignore?.length ? 'under rules.ignore' : '';
      // 2.95: shards without rules.shards.rest did not run every test: the land run is told focus, never full.
      if (rg.green) rulesGreen = { head: rg.green, tip: tip0, tasks: set.map((l) => l.task).join(','), mode: rg.mode === 'shards' ? 'focus' : rg.mode || 'full', scope, same: () => { try { return inputsPrint(rc, [...from, ...extraFrom]) === (rg.inputs ?? inputsPrint(rc, [...from, ...extraFrom])); } catch { return false; } }, keeps: (t) => { if (!scope) return false; try { const k = rulesKey({ repo, sha: tip0, cfg: rc }); return Boolean(k) && k === rulesKey({ repo, sha: t, cfg: rc }); } catch { return false; } } };
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
  // 2.94: the check ahead (harness/rules-ahead.mjs): started once per train, settled when the land run answers.
  let ahead = null;
  let aheadTried = false;
  const aheadSay = (m) => log(`[unity-train] ${id}: the check ahead ${m}`);
  const aheadBegin = (group, landLabel) => {
    if (par.ok) { aheadSay(`is not started: a second gate (engines.${engine}.gates) is in use`); return null; }
    const inIt = new Set(group.map((l) => l.task));
    const nx = pickBatch(root, engine, s, readUnityQueue(root, engine).filter((e) => !inIt.has(e.task)), { env, held: heldPick });
    const ok = nx.error ? [] : laneStates(nx.lanes, { repo, target, board, holdMod, L }).filter((x) => !x.defer && !x.drop).map((x) => x.lane);
    const c = ok.length ? chainOnTarget(repo, rulesGreen.head, ok, `${id}-ahead`, engine, { union }) : { included: [] };
    if (c.error || !c.included.length) { aheadSay(`is not started: no lane waits for the next train${c.error ? ` (${c.error})` : ''}`); return null; }
    const extraFrom = c.included.map((l) => path.join(root, '.lanes', 'engine', String(l.task))).filter((d) => fs.existsSync(d));
    try { return aheadStart({ root, engine, repo, target, head: rulesGreen.head, next: c.head, lanes: c.included, cfg: rc0, from: fromAll, extraFrom, train: id, landLabel, env, log: aheadSay }); } catch (e) { aheadSay(`is not started: ${e.message}`); return null; }
  };
  // Kept only when this land run landed the batch unchanged (the landed target has the checked head's rules key).
  const aheadSettle = async (r, why = '') => {
    if (!ahead) return;
    const h = ahead;
    ahead = null;
    let keep = false;
    if (!why) { try { keep = r?.status === 'pass' && Boolean(r.newTip) && rulesKey({ repo, sha: r.newTip, cfg: rc0 }) === h.baseKey; } catch { keep = false; } }
    const w = why || (r?.status === 'pass' ? `${target} did not land as the checked batch` : `the land run ended ${r?.status || 'without an answer'}`);
    for (const l of await aheadVerdict(root, engine, { keep, why: w })) aheadSay(l);
  };
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
    // 2.86: the target alone (a probe, the daily full run): a ref at the target's tip, so a land script that takes {branch} or
    // {branches} lands nothing new; it is told STUDIO_LAND_PROBE=1 (land nothing). opts.noLand: a by-name step of a red's search on
    // a group of lanes, also STUDIO_LAND_PROBE=1 (only once the land script showed it honours that: probeHonoured). A recorded green
    // of the same tree, target and kind of run is not run again.
    const alone = !group.length;
    const noLand = alone || Boolean(opts.noLand);
    const named = [...(opts.retry?.tests || [])].sort().join(';');
    const kind = alone ? (opts.full ? 'full' : `probe:${named}`) : noLand ? `name:${named}` : null;
    if (noLand) {
      let head0 = tip;
      let u1 = false;
      if (!alone) { const c = chainOnTarget(repo, tip, group, id, engine, { union }); if (c.error) return { status: 'error', why: c.error }; const bad = [...c.conflictTarget, ...c.deferred][0]; if (bad) return { status: 'conflict', why: bad.why, lane: bad }; head0 = c.head; u1 = c.union.length > 0; }
      const tree = out(git(repo, 'rev-parse', `${head0}^{tree}`));
      const g0 = kind !== 'full' && tree ? greenHas(root, engine, { tree, target: tip, kind }) : null;
      if (g0) {
        log(`[unity-train] ${id}: ${what}: not run again: the same tree on ${target} at ${short(tip)} is recorded green for this run (train ${g0.train || '?'}, ${String(g0.at).slice(0, 16)})`);
        ev('green_reused', id, `${what}: not run: the same tree on ${target} at ${short(tip)} is recorded green for the same run by train ${g0.train || '?'}`, { agent: by, meta: { tree, target: tip, kind, from: g0.train || null, lanes: group.map((l) => l.task) } });
        return { status: 'pass', ok: true, reused: g0, why: 'recorded green', failures: [], play: opts.play || null };
      }
      if (alone) {
        ref = `${UNITY_REF_PREFIX}${id}-target`;
        merged = tip;
        if (git(repo, 'update-ref', `refs/heads/${ref}`, tip, '').status !== 0) return { status: 'error', why: `could not make the ref ${ref} at the target` };
        arg = s.many ? { branches: [ref] } : { branch: ref };
      } else if (s.many) { merged = head0; arg = { branches: group.map((l) => l.branch) }; }
      else if (group.length === 1 && !u1) { merged = head0; arg = { branch: group[0].branch }; }
      else {
        ref = `${UNITY_REF_PREFIX}${id}`;
        merged = head0;
        if (git(repo, 'update-ref', `refs/heads/${ref}`, head0, '').status !== 0) return { status: 'error', why: `could not make the integration branch ${ref}` };
        arg = { branch: ref };
      }
    } else if (s.many) arg = { branches: group.map((l) => l.branch) };
    // 2.96 (c4): one lane merged with the target as a union lands through the integration branch (its own merge would conflict).
    else if (group.length === 1 && (!union.length || !(chainOnTarget(repo, tip, group, id, engine, { union }).union || []).length)) arg = { branch: group[0].branch };
    else {
      const c = chainOnTarget(repo, tip, group, id, engine, { union });
      if (c.error) return { status: 'error', why: c.error };
      if (c.union.length) log(`[unity-train] ${id}: ${what}: merged as a union: ${c.union.map((u) => `${u.files.join(', ')} (${u.task})`).join('; ')}`);
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
        if (!head) { const c = chainOnTarget(repo, tip, group, id, engine, { union }); head = c.error ? null : c.head; }
        return head ? changedPaths(repo, tip, head) : null;
      } catch { return null; }
    };
    let r = null;
    let knownRedUsed = null;
    try {
      for (let a = 0; ; a += 1) {
        const checked = !noLand && rulesGreen && rulesGreen.tasks === group.map((l) => l.task).join(',') && (rulesGreen.tip === tip || rulesGreen.keeps(tip)) && rulesGreen.same();
        if (checked && a === 0 && rulesGreen.tip !== tip) log(`[unity-train] ${id}: the rules green stands: ${target} moved (${short(rulesGreen.tip)} -> ${short(tip)}) only ${rulesGreen.scope}, where the rules tests do not read`);
        // Once a day (STUDIO_ENGINE_FULL_LAND_HOURS) a land run is told nothing that lets it skip its own tests (no STUDIO_RULES_GREEN, no Edit Mode
        // plan, STUDIO_LAND_FULL=1): the shortcuts rest on tests run outside the editor, and this run would see a difference between the runtimes.
        // 2.86: only ever a run of the target alone (opts.full: its why), never a batch's run or a step of a red.
        const fullWhy = alone && opts.full ? String(opts.full) : '';
        // 2.85 (B-137): the daily full run is said wherever a person looks: the train's "now" line, train status, an event at its start.
        const fullMin = fullWhy ? Number(readJson(fullLandFile(root, engine))?.minutes) || null : null;
        const runText = fullWhy ? `${what}, the daily full run: every test runs, expect about ${fullMin ? `${fullMin} min` : 'the longest land run of the day'}` : what;
        update({ now: `${runText}: ${group.map((l) => l.task).join(', ') || `${target} alone`}${a ? ` (try ${a + 1})` : ''}`, runs: res.runs + 1, full: fullWhy ? { why: fullWhy, minutes: fullMin } : null });
        log(`[unity-train] ${id}: ${what}: ${alone ? `the target alone, no branch (${ref} at ${short(tip)}; STUDIO_LAND_PROBE=1)` : `${noLand ? 'run' : 'land'} ${group.map((l) => `${l.task} (${l.branch})`).join(', ')}`} on ${target} at ${short(tip)}${ref && !alone ? ` through ${ref}` : ''}${noLand && opts.retry?.tests?.length ? `; by name: ${opts.retry.tests.length} test(s), does not land` : noLand ? '; does not land' : ''}`);
        if (fullWhy) log(`[unity-train] ${id}: a full land run (${fullWhy}): the land command is not told the rules are green and gets no Edit Mode plan`);
        if (fullWhy && a === 0 && !dryRun) ev('full_land', id, `the daily full run, on ${target} alone with no branch (${fullWhy}), runs now: ${opts.when === 'end' ? 'the end of the train, after the batch\'s rounds' : 'no lane waits'}; every test runs${fullMin ? `, expect about ${fullMin} min` : ''}; its red goes to the target's own full-run failures`, { agent: by, to: 'producer', meta: { why: fullWhy, tasks: [], alone: true, when: opts.when || 'idle', ...(fullMin ? { minutes: fullMin } : {}) } });
        // The Play Mode focus (engines.<x>.play.focus): a hint the land script may use. Never on a full land run; a retry of a red play stage
        // gets the selection of the run it repeats.
        const play = fullWhy ? { mode: 'full', filter: '', why: fullWhy } : opts.play || (alone ? { mode: 'full', filter: '', why: 'the target alone' } : playSelection({ changed: batchPaths(), cfg: s.cfg, full: false }));
        for (const b of play.ignoreBad || []) log(`[unity-train] ${id}: play.focus.ignore pattern ${JSON.stringify(b).slice(0, 120)} is not a valid regex; skipped`);
        if (play.refused) log(`[unity-train] ${id}: play focus: ${play.why}; the play stage runs in full`);
        else if (play.mode === 'focus') log(`[unity-train] ${id}: play focus: ${play.why} (${play.filter})`);
        else if (play.mode === 'skip') log(`[unity-train] ${id}: play stage skipped: ${play.why}`);
        // 2.85: a full play stage says why, naming the paths no play.focus.map entry takes.
        else if (play.unmatched?.length) { log(`[unity-train] ${id}: play stage in full: ${play.why}`); res.playUnmatched = play.unmatched; if (!dryRun) noteUnmatched(root, engine, { train: id, paths: play.unmatchedAll }); }
        const playEnv = { STUDIO_PLAY_MODE: play.mode, ...(play.mode === 'focus' ? { STUDIO_PLAY_FILTER: play.filter, ...(engine === 'unity' ? { STUDIO_UNITY_PLAYMODE_ARGS: `-testFilter "${play.filter}"` } : {}) } : {}) };
        const landEnv = { ...env, STUDIO_GATE_PRIORITY: 'landing', ...(fullWhy ? { STUDIO_LAND_FULL: '1' } : checked ? { STUDIO_RULES_GREEN: '1', STUDIO_RULES_MODE: rulesGreen.mode } : {}), ...playEnv };
        if (play.mode !== 'focus') { delete landEnv.STUDIO_PLAY_FILTER; delete landEnv.STUDIO_UNITY_PLAYMODE_ARGS; }
        // What the harness tells a land script is its own: nothing of these comes from the train's environment.
        for (const k of ['STUDIO_LAND_ONLY', 'STUDIO_LAND_RETRY', 'STUDIO_LAND_RETRY_STAGE', 'STUDIO_LAND_RETRY_TESTS', 'STUDIO_LAND_PROBE', 'STUDIO_LAND_KNOWN_RED', 'STUDIO_EDITOR_SERVICE', 'STUDIO_EDITOR_SERVICE_CLI']) delete landEnv[k];
        // 2.86: the target alone lands nothing (a probe or the full run).
        if (noLand) landEnv.STUDIO_LAND_PROBE = '1';
        // 2.86 (engines.<x>.knownRedHours, off by default): listed flaky tests a probe found red on the target alone are named to the
        // land script, which may leave them out of its verdict. Never on the target alone; each use is an event naming the probe.
        if (!noLand && a === 0) {
          const kr = knownRedOf(root, engine, s.cfg);
          const isF = flakyMatcher(s.cfg.flakyTests);
          const names = (opts.knownRed || kr.names).filter((n) => isF(n) && kr.names.includes(n));
          if (names.length) {
            knownRedUsed = names;
            const pr = kr.probes.filter((p) => names.includes(p.test));
            ev('known_red', id, `${what}: the land script is told ${names.length} test(s) are red on ${target} alone (STUDIO_LAND_KNOWN_RED, engines.${engine}.knownRedHours): ${names.slice(0, 3).join(', ')}; proved by the probe of train ${pr[0]?.train || '?'} at ${String(pr[0]?.at || '').slice(0, 16)}`, { agent: by, to: 'producer', status: 'warn', meta: { tests: names.slice(0, 10), probes: pr.slice(0, 10), lanes: group.map((l) => l.task) } });
          }
        }
        if (!noLand && knownRedUsed) landEnv.STUDIO_LAND_KNOWN_RED = knownRedUsed.join(';');
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
        if (compileOn && !compileOff && !rt && !alone && !compiledGroups.has(gkey) && !(group.length === 1 && compiledLanes.has(group[0].task))) {
          update({ now: `compile check: ${group.map((l) => l.task).join(', ')}${fullWhy ? ' (the daily full land run comes after it)' : ''}` });
          log(`[unity-train] ${id}: compile check (STUDIO_LAND_ONLY=compile) of ${group.map((l) => l.task).join(', ')}, up to ${compileMin} min`);
          const c0 = Date.now();
          // 2.85 (B-137): the compile check carries only what a compile needs: no full-run, rules, retry or Play Mode filter variables.
          // STUDIO_PLAY_MODE stays (2.84's qa/selftest-284t.mjs pins it on the compile run).
          const compileEnv = { ...landEnv, STUDIO_LAND_ONLY: 'compile' };
          for (const k of Object.keys(compileEnv)) if (/^STUDIO_(LAND_(FULL|RETRY.*)|RULES_(GREEN|MODE)|PLAY_FILTER|UNITY_(PLAYMODE|EDITMODE)_ARGS)$/.test(k)) delete compileEnv[k];
          const rc = await land({ engine, ...arg, task: gkey, label: `${label} compile`, env: compileEnv, log, only: 'compile', timeoutMin: compileMin });
          const secs = Math.round((Date.now() - c0) / 1000);
          spent.compile += Date.now() - c0;
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
          // 2.94: the next batch's rules check beside this land run (rules.ahead), once per train, only for the checked batch.
          if (rc0?.ahead && checked && !aheadTried && !dryRun) { aheadTried = true; ahead = aheadBegin(group, label); }
          const l0 = Date.now();
          r = await land({ engine, ...arg, task: gkey, label, env: landEnv, log, ...(stagesBefore.length ? { stagesBefore } : {}), ...(ahead ? { onOom: () => aheadSettle(null, 'the land run died out of memory; it is ended before the land run is tried once more, and not started again in this train') } : {}) });
          res.runs += 1;
          landRuns += 1;
          // The run says how long it waited (waitMs); else the wall time not in its own ms.
          const wall = Date.now() - l0;
          spent.wait += Math.max(0, Number(r.waitMs ?? (wall - (r.ms ?? wall))));
          spent.land += Math.max(0, Number(r.ms ?? wall) - Number(r.waitMs ?? 0));
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
    // 2.86: a run that lands nothing (the target alone, a by-name step) must leave the target where it was. If it moved, the land
    // script did not honour STUDIO_LAND_PROBE: the run is an error (nobody is blamed, the train holds its lanes), and by-name steps
    // stop for this engine until a person clears .studio/train/<x>-probe.json.
    if (noLand && !dryRun) {
      const now = headOf(repo, target);
      // 2.86.1: a run of the target alone merges no branch, so a target that moved during it cannot be a landing: a land script
      // that commits its own record of every run moves it. The result stands for the tip that was run; one note says so.
      if (now !== tip && !group.length) {
        r = { ...r, movedAlone: now };
        log(`[unity-train] ${id}: ${target} moved (${short(tip)} -> ${short(now)}) during ${what}; no branch was in that run, so nothing was landed by it and its result stands for ${short(tip)}`);
        ev('target_moved_alone', id, `${target} moved (${short(tip)} -> ${short(now)}) during ${what}: no branch was in that run, so its result stands for ${short(tip)}. A land script that honours STUDIO_LAND_PROBE=1 writes nothing to the target (docs/NATIVE-ENGINE.md)`, { agent: by, to: 'producer', status: 'warn', meta: { from: tip, to: now } });
      } else if (now !== tip) {
        r = { ...r, status: 'error', ok: false, moved: now, why: `${target} moved (${short(tip)} -> ${short(now)}) during ${what}, a run that must land nothing (STUDIO_LAND_PROBE=1): the land script does not honour it` };
        noteProbe(root, engine, { honoured: false, revoked: true, why: r.why, train: id });
        log(`[unity-train] ${id}: STOP: ${r.why}; nobody is blamed, the lanes stay queued; by-name steps are off for ${engine} until .studio/train/${engine}-probe.json is cleared`);
        ev('probe_moved_target', id, `${r.why}. Nobody is blamed; the lanes stay queued; by-name steps are off until a person clears .studio/train/${engine}-probe.json (docs/NATIVE-ENGINE.md)`, { agent: by, to: 'producer', status: 'blocked', meta: { from: tip, to: now, lanes: group.map((l) => l.task) } });
      } else if (r.probeAck) noteProbe(root, engine, { honoured: true, train: id });
    }
    if (knownRedUsed) r = { ...r, knownRed: knownRedUsed };
    // 2.86: the flake record (named: the tests a retry or a probe ran by name) and the green record of runs that land nothing.
    if (!dryRun) {
      // A by-name step of a search judges branches, not the test: it is not counted.
      if (alone || !noLand) noteFlakes(root, engine, { cfg: s.cfg, r, named: opts.retry?.tests || null, train: id, target: tip, probe: alone && !r.full });
      if (noLand && r.status === 'pass' && !r.moved && merged) { const tree = out(git(repo, 'rev-parse', `${merged}^{tree}`)); if (tree) noteGreen(root, engine, { tree, target: tip, kind, train: id }); }
    }
    // 2.85: a daily full run is judged against the target's own full-run failures (fullRunVerdict).
    if (r.full && !dryRun) fullRunVerdict(r);
    if (r.status === 'pass' && noLand) return { ...r, noLand: true };
    if (r.status === 'pass') {
      const now = headOf(repo, target);
      const missing = group.filter((l) => !isAncestor(repo, l.head, now));
      if (missing.length) return { ...r, status: 'error', ok: false, why: `the land command said pass, but ${target} (now ${short(now)}) doesn't contain ${missing.map((l) => `${l.branch} at ${short(l.head)}`).join(', ')}: nothing was closed` };
      return { ...r, newTip: now };
    }
    return r;
  };
  /**
   * The daily full run against the target's own full-run failures (.studio/train/<engine>-full-baseline.json). Green:
   * the baseline is cleared. Red with named tests: the names go to the baseline, a name the run no longer shows is
   * cleared, the director is told once per set of names (engine.full_red_on_target) and the full-run clock counts as
   * served.
   */
  const fullRunVerdict = (r) => {
    const base = readFullBaseline(root, engine);
    const emitB = (type, status, msg, meta) => { try { emitEvent({ type, agent: by, to: 'director', status, track: `engine:${engine}`, msg: `${L} train ${id}: ${msg}`.slice(0, 600), meta: { train: id, engine, ...meta } }); } catch {} };
    const save = (failing, extra = {}) => { try { writeJson(baselineFile(root, engine), { at: new Date().toISOString(), target: headOf(repo, target), failing, source: `the full land run of ${L} train ${id}`, ...(base.told ? { told: base.told } : {}), ...extra }); } catch { /* asked again next time */ } };
    const clear = (gone) => { if (!gone.length) return; emitB('engine.full_baseline_cleared', 'ok', `the daily full run no longer fails ${gone.length} test(s) the target was red on: ${gone.slice(0, 5).join(', ')}${gone.length > 5 ? ', ...' : ''}; removed from the known-red list`, { tests: gone.slice(0, 20) }); log(`[unity-train] ${id}: full-run baseline: ${gone.length} name(s) pass again: ${gone.slice(0, 5).join(', ')}`); };
    if (r.status === 'pass') targetRedClear(root, engine, 'full-land');
    if (r.status === 'pass') { if (base.failing.length) { save([], { told: '' }); clear(base.failing); } return; }
    const names = r.status === 'red' && !r.compileOnly && Array.isArray(r.failures) ? [...new Set(r.failures)] : [];
    if (!names.length) return;
    const st = Array.isArray(r.stages) ? r.stages.map((x) => x?.name) : [];
    const red0 = firstRedStage(r);
    const ranOn = red0 && st.indexOf(red0) >= 0 && st.indexOf(red0) < st.length - 1;
    const gone = ranOn ? base.failing.filter((n) => !names.includes(n)) : [];
    const kept = base.failing.filter((n) => !gone.includes(n));
    const failing = [...new Set([...kept, ...names])].sort();
    const key = failing.join('\n');
    const told = base.told === key;
    save(failing, { told: key });
    clear(gone);
    if (!told) emitB('engine.full_red_on_target', 'warn', `the daily full land run, on ${target} alone with no branch, is red on ${names.length} test(s): ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', ...' : ''}. They fail on the target itself; no branch is counted against them. A fix task for them is wanted.`, { tests: names.slice(0, 20), failing: failing.slice(0, 50), lanes: [] });
    targetRedTask(root, { engine, target, source: 'full-land', tests: failing, why: `the full land run is red on ${names[0]}`, train: id });
    // The full-run clock counts as served: the next full run is due after the usual hours.
    try { const prev = readJson(fullLandFile(root, engine)) || {}; writeJson(fullLandFile(root, engine), { ...prev, at: new Date().toISOString(), id, served: 'red only on the target\'s own tests' }); } catch { /* due again next time */ }
    log(`[unity-train] ${id}: the full run of ${target} alone is red on ${names.slice(0, 5).join(', ')}: known red on the target; nobody is blamed`);
    res.fullRedOnTarget = names.slice(0, 20);
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
    // 2.93: the landed tree's rules answer (rules.landGate's pass, or the checked full green landed unchanged) for the next train.
    if (!dryRun && rc0) {
      const gk = group.map((l) => l.task).join(',');
      try { const how = rulesLanded({ root, engine, repo, cfg: rc0, tip: r.newTip, head: rulesGreen?.tasks === gk ? rulesGreen.head : null, mode: rulesGreen?.mode, stages: r.stages, from: fromAll }); if (how) log(`[unity-train] ${id}: ${how === 'gate' ? `the land run's ${rc0.landGate} gate passed: kept as a full rules pass of ${short(r.newTip)}` : `the checked full rules pass landed unchanged: it is the full pass of ${short(r.newTip)}`}`); } catch { /* the next train asks again */ }
    }
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
  let held = null;
  const hold = (group, r) => {
    held = r.status;
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

  /**
   * 2.86: the evidence for a red round (what 2.85 did inline): the failing tests less the target's own full-run failures, tied to
   * lanes by the compiler's files or the evidence rules. null when there is none to go by; else { suspect, tied, untied, sp }.
   * The plan is said in the log and in task.train.<x>.blame.
   */
  const tiesFor = (left, r) => {
    const baseNames = new Set(readFullBaseline(root, engine).failing);
    const namedAll = Array.isArray(r.failures) ? r.failures : [];
    const namedTests = namedAll.filter((n) => !baseNames.has(n));
    if (namedTests.length < namedAll.length) log(`[unity-train] ${id}: ${namedAll.length - namedTests.length} failing test(s) are known red on the target in the full run and are not counted against anyone: ${namedAll.filter((n) => baseNames.has(n)).slice(0, 5).join(', ')}`);
    const namedFiles = Array.isArray(r.errorFiles) ? r.errorFiles : [];
    if (!(r.status === 'red' && left.length > 1 && (namedTests.length || namedFiles.length) && !/^(off|0|false|no)$/i.test(String(env.STUDIO_ENGINE_BLAME_EVIDENCE || '')))) return null;
    let sp = null; let what = ''; let rule = '';
    let apart = null;
    const redStage = firstRedStage(r);
    try {
      const tipNow = headOf(repo, target);
      // 2.92: each file the compiler names is changed by exactly one lane (two that clash in a file: the search), not all: they go back now.
      const cf = namedFiles.length ? suspectsByFiles({ repo, tip: tipNow, lanes: left, files: namedFiles }) : [];
      const all = namedFiles.slice(0, 20).map((f) => String(f).replace(/\\/g, '/').replace(/^\.\//, '')).filter((f) => f.includes('.'));
      if (cf.length && cf.length < left.length && all.every((f) => cf.filter((h) => h.cover.includes(f)).length === 1)) {
        const lanesC = cf.map((h) => h.lane.task);
        const planText = `every file the compiler names (${all.slice(0, 3).join(', ')}) is changed by ${lanesC.join(', ')} and no other branch: ${lanesC.length === 1 ? 'it goes' : 'they go'} back now and ${left.filter((l) => !lanesC.includes(l.task)).map((l) => l.task).join(', ')} run again, no halving search`;
        log(`[unity-train] ${id}: blame plan: ${planText}`);
        ev('blame', id, `red on a compile error${redStage ? ` in ${redStage}` : ''}: ${planText}`, { agent: by, meta: { plan: 'compile', lanes: lanesC, next: left.filter((l) => !lanesC.includes(l.task)).map((l) => l.task), files: all.slice(0, 10), stage: redStage } });
        return { suspect: null, tied: lanesC, untied: [], compile: lanesC, byLane: Object.fromEntries(cf.map((h) => [h.lane.task, h.files])) };
      }
      // 2.90: engines.<x>.blame first: the studio's own tie from a failing test to the files that explain it.
      const bl = namedTests.length ? blameList(s.cfg.blame).blame : [];
      const bs = bl.length ? blameSuspect({ repo, tip: tipNow, lanes: left, failures: namedTests, blame: bl }) : null;
      if (bs?.lane) { sp = { lane: bs.lane, tests: bs.tests, files: bs.files, say: bs.entry.say }; rule = 'blame'; what = `${bs.entry.touches.join(', ')}, which engines.${engine}.blame ties to ${bs.tests.slice(0, 3).join(', ')}`; }
      else if (bs?.tied && left.some((l) => !bs.tied.includes(l))) apart = { tied: bs.tied, untied: left.filter((l) => !bs.tied.includes(l)), byTest: Object.fromEntries(bs.tests.map((t) => [t, bs.tied.map((l) => l.task)])) };
      const byFile = sp || apart ? [] : namedFiles.length ? suspectsByFiles({ repo, tip: tipNow, lanes: left, files: namedFiles }) : [];
      if (sp || apart) { /* engines.<x>.blame decided */ }
      else if (byFile.length === 1) { sp = byFile[0]; rule = 'compile-files'; what = `the file(s) the compiler names (${sp.files.slice(0, 3).join(', ')})`; }
      else if (!byFile.length && namedTests.length) {
        const sus = suspectsOf({ repo, tip: tipNow, lanes: left, failures: namedTests });
        if (sus.length === 1 && sus[0].tests.length === Math.min(namedTests.length, 20)) { sp = sus[0]; rule = 'class'; what = `files naming the failing test(s) (${sp.tests.slice(0, 3).join(', ')}: ${sp.files.slice(0, 3).join(', ')})`; }
        else {
          const ns = suspectsByNamespace({ repo, tip: tipNow, lanes: left, failures: namedTests });
          if (ns.length === 1 && ns[0].tests.length === Math.min(namedTests.length, 20)) { sp = ns[0]; rule = 'namespace'; what = `test files of the failing test's namespace or class (${sp.tests.slice(0, 3).join(', ')}: ${sp.files.slice(0, 3).join(', ')})`; }
        }
        if (!sp) {
          const t = tiesOf({ repo, tip: tipNow, lanes: left, failures: namedTests });
          const tiedSet = new Set([...t.byLane.keys(), ...t.unjudged]);
          if (tiedSet.size === 1 && t.byLane.size === 1) { sp = [...t.byLane.values()][0]; rule = sp.rules.join('+'); what = `files tied to the failing test(s) by ${sp.rules.join(', ')} (${sp.tests.slice(0, 3).join(', ')}: ${sp.files.slice(0, 3).join(', ')})`; }
          else if (tiedSet.size >= 2 && left.some((l) => !tiedSet.has(l.task))) apart = { tied: left.filter((l) => tiedSet.has(l.task)), untied: left.filter((l) => !tiedSet.has(l.task)), byTest: t.byTest };
        }
      }
    } catch { sp = null; apart = null; }
    const plan = sp ? { plan: 'without', suspect: sp.lane.task, next: left.filter((l) => l.task !== sp.lane.task).map((l) => l.task), rule } : apart ? { plan: 'apart', tied: apart.tied.map((l) => l.task), next: apart.untied.map((l) => l.task) } : { plan: 'bisect', next: left.map((l) => l.task) };
    const planText = plan.plan === 'without' ? `exactly one branch is tied to the failing test(s), ${plan.suspect}: the next land run is the batch without it (${plan.next.join(', ')}), not a halving search` : plan.plan === 'apart' ? `${plan.tied.length} branches are tied to the failing test(s) (${plan.tied.join(', ')}): the untied ones (${plan.next.join(', ')}) land first, apart from them` : `no single branch is tied to the failing test(s)${namedTests.length ? '' : ' (only a compile error)'}: the search by land runs`;
    log(`[unity-train] ${id}: blame plan: ${planText}`);
    ev('blame', id, `red${redStage ? ` in ${redStage}` : ''} on ${namedTests.slice(0, 3).join(', ') || namedFiles.slice(0, 3).join(', ')}: ${planText}`, { agent: by, meta: { ...plan, tests: namedTests.slice(0, 10), files: namedFiles.slice(0, 10), stage: redStage, ...(apart ? { byTest: Object.fromEntries(Object.entries(apart.byTest).slice(0, 10)) } : {}) } });
    if (sp) return { suspect: sp.lane.task, tied: [sp.lane.task], untied: plan.next, sp: { ...sp, what, rule, stage: redStage } };
    if (apart) return { suspect: null, tied: plan.tied, untied: plan.next };
    return null;
  };
  const redEvidenceOf = (x) => { const baseNames = new Set(readFullBaseline(root, engine).failing); return { tests: (Array.isArray(x?.failures) ? x.failures : []).filter((n) => !baseNames.has(n)).slice(0, 10), files: (Array.isArray(x?.errorFiles) ? x.errorFiles : []).slice(0, 10) }; };
  /** 2.86: a round ended "waiting for the target": its lanes stay queued (marked, in place), nobody is handed back or counted. */
  const waitForTarget = (st, lanesNow, proof) => {
    const tip = headOf(repo, target);
    const at = new Date().toISOString();
    try { withQueue(root, (q) => { for (const e of q) if (st.group.includes(e.task)) e.waitTarget = { target: tip, tests: st.tests.slice(0, 10), train: id, at }; }, engine); } catch { /* they are tried again at the next train */ }
    res.waitTarget = { target: tip, tests: st.tests.slice(0, 20), lanes: st.group.slice() };
    for (const l of lanesNow) { live.delete(l.task); try { deps.clearRunning?.(l.task); } catch {} }
    liveNow();
    const msg = `red on ${st.tests.slice(0, 3).join(', ')}${st.tests.length > 3 ? ', ...' : ''}, and ${proof === 'probe' ? 'a run of those tests on' : 'an earlier probe found them red on'} ${target} alone (no branch) is red too: the target is red. Nobody is handed back; ${st.group.join(', ')} stay queued and wait until ${target} moves (a fix lands)`;
    log(`[unity-train] ${id}: ${msg}`);
    ev('waiting_target', id, msg, { agent: by, to: 'producer', status: 'warn', meta: { tests: st.tests.slice(0, 10), target: tip, lanes: st.group, proof } });
    // The planner is paged once per set of tests and target tip.
    const key = `${tip}:${[...st.tests].sort().join(';')}`;
    let told = false;
    editFlakes(root, engine, (f) => { told = Boolean(f.told[key]); if (!told) f.told[key] = at; });
    if (!told) { try { emitEvent({ type: 'engine.red_on_target', agent: by, to: 'planner', status: 'warn', track: `engine:${engine}`, msg: `${L} train ${id}: ${target} alone (no branch) is red on ${st.tests.slice(0, 5).join(', ')}${st.tests.length > 5 ? ', ...' : ''} (engines.${engine}.flakyTests lists ${st.tests.length === 1 ? 'it' : 'them'}). No branch is blamed; ${st.group.length} lane(s) wait for the target to move. A fix task for ${st.tests.length === 1 ? 'this test' : 'these tests'} is wanted.`.slice(0, 600), meta: { train: id, engine, tests: st.tests.slice(0, 20), target: tip, lanes: st.group, proof } }); } catch {} }
  };

  /**
   * 2.90: two narrowing steps by name at once, one per gate, each its own process (harness/unity-gate.mjs --gate k) with its own
   * machine:heavy admission; neither lands (STUDIO_LAND_PROBE=1). { results: [r | null] } (null: no answer, that step runs again on
   * one gate), or { moved } when the target moved under them (the land script ignored the probe: as landGroup, nobody is blamed).
   */
  const pairRun = async (steps, firstRun) => {
    const tip = headOf(repo, target);
    const refs = [];
    const stage = firstRedStage(firstRun);
    try {
      const jobs = steps.map((st, k) => {
        const c = chainOnTarget(repo, tip, st.lanes, id, engine, { union });
        if (c.error || c.conflictTarget.length || c.deferred.length) return Promise.resolve(null);
        const tests = retryNames(st.tests) || [];
        const kind = `name:${[...tests].sort().join(';')}`;
        const tree = out(git(repo, 'rev-parse', `${c.head}^{tree}`));
        const g0 = tree ? greenHas(root, engine, { tree, target: tip, kind }) : null;
        if (g0) return Promise.resolve({ status: 'pass', ok: true, reused: g0, failures: [] });
        const ref = `${UNITY_REF_PREFIX}${id}-g${k + 1}`;
        if (git(repo, 'update-ref', `refs/heads/${ref}`, c.head, '').status !== 0) return Promise.resolve(null);
        refs.push(ref);
        const e = { ...env, STUDIO_MAIN_ROOT: root, STUDIO_GATE_PRIORITY: 'landing', STUDIO_LAND_PROBE: '1', STUDIO_LAND_RETRY: '1', STUDIO_HEAVY_WAIT_MIN: String(Math.min(num(env.STUDIO_HEAVY_WAIT_MIN, 2), 2)), ...(stage ? { STUDIO_LAND_RETRY_STAGE: stage } : {}), ...(tests.length ? { STUDIO_LAND_RETRY_TESTS: tests.join(';') } : {}), ...(firstRun?.play?.mode ? { STUDIO_PLAY_MODE: firstRun.play.mode } : {}) };
        for (const x of ['STUDIO_LAND_ONLY', 'STUDIO_LAND_KNOWN_RED', 'STUDIO_LAND_FULL', 'STUDIO_RULES_GREEN', 'STUDIO_RULES_MODE', 'STUDIO_HEAVY_HELD', 'STUDIO_EDITOR_SERVICE', 'STUDIO_EDITOR_SERVICE_CLI', 'STUDIO_PLAY_FILTER', 'STUDIO_UNITY_PLAYMODE_ARGS']) delete e[x];
        if (engine === 'unity' && String(stage || '').toLowerCase() === 'play' && tests.length) e.STUDIO_UNITY_PLAYMODE_ARGS = `-testFilter "${tests.join(';')}"`;
        log(`[unity-train] ${id}: gate ${k + 1}: run ${st.group.join(', ')} on ${target} at ${short(tip)} through ${ref}; by name, does not land`);
        return runGateChild({ root, engine, gate: k + 1, args: s.many ? ['--branches', ref] : ['--branch', ref], env: e }).then((r) => ({ ...r, tree, kind }));
      });
      const rs = await Promise.all(jobs);
      const now = headOf(repo, target);
      if (now !== tip) {
        const why = `${target} moved (${short(tip)} -> ${short(now)}) during two runs that must land nothing (STUDIO_LAND_PROBE=1): a land script does not honour it`;
        noteProbe(root, engine, { honoured: false, revoked: true, why, train: id });
        ev('probe_moved_target', id, `${why}. Nobody is blamed; the lanes stay queued; by-name steps and the second gate are off until a person clears .studio/train/${engine}-probe.json (docs/NATIVE-ENGINE.md)`, { agent: by, to: 'producer', status: 'blocked', meta: { from: tip, to: now } });
        return { moved: now, why };
      }
      return { results: rs.map((r) => {
        if (!r || !['pass', 'red'].includes(r.status)) { if (r) log(`[unity-train] ${id}: gate ${r.gate || '?'} gave no answer (${r.status}: ${String(r.why || '').split('\n')[0]}); that step runs again on one gate`); return null; }
        if (r.status === 'pass' && !r.reused && r.tree) noteGreen(root, engine, { tree: r.tree, target: tip, kind: r.kind, train: id });
        if (r.probeAck) noteProbe(root, engine, { honoured: true, train: id });
        return r;
      }) };
    } finally { for (const ref of refs) git(repo, 'update-ref', '-d', `refs/heads/${ref}`); }
  };
  // 2.90: whether this train may use the second gate (said once in the log when it is on and not used).
  const par = parallelNow(root, engine, s.cfg, env);
  if (par.state.on && !par.ok) log(`[unity-train] ${id}: two land runs at once are on, not used: ${par.why}`);
  res.rounds = 0;
  // 2.91: the periodic full runs on the target alone, the full rules run first (it is shorter), then the full land run. when:
  // 'idle' (no lane: the due ones) or 'end' (after the batch's rounds: the overdue ones). true when the train was cancelled.
  const fullsOnTarget = async (when) => {
    const tipN = headOf(repo, target);
    const ow = when === 'idle' ? (rulesFirst ? owed0 : { why: '' }) : rc0 ? fullRulesOwed(root, engine, rc0, { repo, tip: tipN }) : { why: '' };
    if (ow.why && (when === 'idle' || ow.overdue)) {
      const say = when === 'idle' ? 'runs now: no lane waits' : 'runs now: the end of the train, after the batch\'s rounds';
      update({ now: `the full rules run on ${target} alone (${ow.why})` });
      log(`[unity-train] ${id}: the full rules run on ${target} alone at ${short(tipN)} (${ow.why}); it ${say}`);
      const fr = (deps.fullRulesRun || fullRulesRun)({ engine, repo, tip: tipN, cfg: rc0, from: fromAll, root, id, env, log });
      res.fullRules = { status: fr.status, ...(fr.notFull ? { notFull: true } : {}), why: ow.why, overdue: Boolean(ow.overdue), when, tip: tipN, ...(fr.cached ? { cached: true } : {}) };
      const ok = fr.status === 'pass';
      const m = ok && fr.notFull ? `the rules shards on ${target} alone at ${short(tipN)} passed (${ow.why}; it ${say}), but rules.shards has no rest, so a test no shard filter matches did not run: this is not the full run and it stays owed. Set rules.shards.rest`
        : ok ? `the full rules run on ${target} alone at ${short(tipN)} passed${fr.cached ? ' (a kept result of this tree)' : ''} (${ow.why}; it ${say}): the next one is owed in ${ow.hours} h`
        : `the full rules run on ${target} alone at ${short(tipN)} ${fr.timedOut ? 'timed out' : `is ${fr.status}`} (${String(fr.why || '').split('\n')[0]}${fr.failures?.length ? `: ${fr.failures.slice(0, 3).join(', ')}` : ''}): no lane is blamed; it is not run again until ${target} changes under what the rules tests read${fr.timedOut && !fr.timeoutSet ? ' or the doubled timeout applies' : ''}. A fix task is wanted`;
      log(`[unity-train] ${id}: ${m}`);
      ev('rules_full', id, m, { agent: by, to: 'producer', status: ok && !fr.notFull ? 'ok' : 'warn', meta: { status: fr.status, ...(fr.notFull ? { notFull: true } : {}), why: ow.why, overdue: Boolean(ow.overdue), when, tip: tipN, ...(fr.failures?.length ? { failures: fr.failures.slice(0, 10) } : {}), ...(fr.timedOut ? { timeout: true } : {}) } });
      if (cancelledTrain(root, engine, id)) return true;
    }
    if (when === 'idle' ? !fullFirst : !fullLast) return false;
    update({ now: 'the daily full run on the target alone' });
    const fr = await landGroup([], `${target} alone`, { full: fullDue.why, when });
    res.full = { status: fr.status, why: fullDue.why, overdue: fullDue.overdue, when };
    if (!['pass', 'red'].includes(fr.status)) { log(`[unity-train] ${id}: the full run on the target alone ended ${fr.status} (${fr.why}); it is tried again at the next train`); ev('full_land', id, `the daily full run on ${target} alone could not run to its end (${fr.status}: ${String(fr.why || '').split('\n')[0]}); the land script must take a branch that is the target itself and land nothing (STUDIO_LAND_PROBE=1, docs/NATIVE-ENGINE.md); tried again at the next train`, { agent: by, to: 'producer', status: 'warn', meta: { status: fr.status, why: fullDue.why, alone: true, when } }); }
    return fr.status === 'cancelled' || Boolean(cancelledTrain(root, engine, id));
  };

  try {
    // 2.86: one round per set of lanes; each step comes from nextStep (pure), the train runs it.
    let fullCancelled = false;
    if ((fullFirst || rulesFirst) && await fullsOnTarget('idle')) { hold(set, { status: 'cancelled', why: 'the train was cancelled during the full run' }); fullCancelled = true; }
    // The rounds still to run, in order (a round starts with a complete land run of its lanes).
    const pending = fullCancelled || !set.length ? [] : [set];
    let rounds = 0;
    const again = retryStagesOf(s.cfg, env, engine);
    const isFlaky = flakyMatcher(s.cfg.flakyTests);
    const fRetries = flakyRetriesOf(s.cfg);
    const krOn = Number(s.cfg.knownRedHours) > 0;
    const bisectMax = bisectCap();
    let stageRetried = false;
    let stop = false;
    const byTask = new Map(set.map((l) => [l.task, l]));
    const lanesOf = (ids) => (ids || []).map((t) => byTask.get(t)).filter(Boolean);
    const baseNames = new Set(readFullBaseline(root, engine).failing);
    while (pending.length && !stop && rounds++ <= 2 * set.length + 4) {
      const round = pending.shift().filter((l) => live.has(l.task) && !res.landed.includes(l.task));
      if (!round.length) continue;
      const results = [];
      let ties;
      const nextRounds = (lists) => { pending.unshift(...(lists || []).map((x) => lanesOf(x)).filter((x) => x.length)); };
      for (let n = 0; n < 4 * set.length + 12; n += 1) {
        const first = results[0];
        const stage0 = first?.status === 'red' ? firstRedStage(first.r) : null;
        const st = nextStep({ lanes: round.map((l) => l.task), results, ties, flaky: isFlaky, flakyRetries: fRetries, stageRetry: !stageRetried && Boolean(stage0 && again.includes(String(stage0).toLowerCase())), targetRed: targetRedAt(root, engine, headOf(repo, target)), knownRed: krOn, bisectMax, byNameOk: probeHonoured(root, engine, s.cfg), pair: par.ok && probeHonoured(root, engine, s.cfg) });
        if (st.step === 'done') break;
        if (st.step === 'ties') { ties = tiesFor(lanesOf(round.map((l) => l.task).filter((t) => live.has(t))), st.red.r); continue; }
        if (st.step === 'next-round') {
          if (st.passedAlone) ev('bisect', id, `${bisectText(results)}; ${st.passedAlone} was the one left, and it passed by itself: ${results.some((x) => x.byName) ? 'by name; it lands on a complete run of its own' : 'landed'}, nobody is handed back`, { agent: by, meta: { steps: bisectSteps(results), confirmed: st.passedAlone, passedAlone: true } });
          nextRounds(st.rounds); break;
        }
        if (st.step === 'wait-target') { waitForTarget(st, lanesOf(st.group), st.proof); stop = true; break; }
        if (st.step === 'handback') { handBackStep(st, lanesOf(st.lanes), results, ties); nextRounds(st.rounds); break; }
        // A run.
        const group = lanesOf(st.group);
        const firstRun = results[0]?.r || null;
        const tests = st.tests ? retryNames(st.tests) : null;
        let what = 'land run';
        let o = {};
        if (st.step === 'retry') {
          if (!st.known) stageRetried = true;
          const red = results[results.length - 1].r;
          const fails0 = Array.isArray(red.failures) ? red.failures : [];
          const sname = firstRedStage(firstRun) || 'unknown';
          what = `land run again (red in ${sname}${tests ? `, ${tests.length} test(s)` : ''}${st.known ? `, retry ${st.n} of ${fRetries}` : ''})`;
          ev('retry', id, `red in ${sname} (${fails0.slice(0, 3).join(', ') || 'no test named'})${st.known ? ` on test(s) engines.${engine}.flakyTests names` : ''}: one more run of ${group.map((l) => l.task).join(', ')} before anyone is blamed${tests ? `, re-running only ${tests.length} failed test(s)` : ''}${st.known ? ` (retry ${st.n} of ${fRetries}, engines.${engine}.flakyRetries)` : ''}`, { agent: by, meta: { stage: firstRedStage(firstRun), failures: fails0.slice(0, 10), ...(tests ? { only: tests.slice(0, 10) } : {}), ...(st.known ? { known: true, n: st.n, of: fRetries } : {}) } });
          if (!tests && fails0.length) log(`[unity-train] ${id}: the failed test names are not safe on a command line (or more than 50): the whole land runs again`);
          o = { play: firstRun?.play || null, ...(tests ? { retry: { stage: firstRedStage(firstRun), tests } } : {}) };
        } else if (st.step === 'probe') {
          what = `the target alone: a run of ${tests.length} failed test(s) with no branch`;
          ev('probe', id, `red on listed flaky test(s) only (${tests.slice(0, 3).join(', ')}) after ${fRetries} retr${fRetries === 1 ? 'y' : 'ies'}: the same test(s) run on ${target} alone, with no branch, before anyone is blamed`, { agent: by, meta: { tests: tests.slice(0, 10), lanes: round.map((l) => l.task) } });
          o = { play: firstRun?.play || null, retry: { stage: firstRedStage(firstRun), tests } };
        } else if (st.step === 'known-red') {
          what = `land run again with the target's known-red test(s) named (${st.known.slice(0, 3).join(', ')})`;
          o = { play: firstRun?.play || null, knownRed: st.known, ...(tests ? { retry: { stage: firstRedStage(firstRun), tests } } : {}) };
        } else if (st.step === 'without') {
          const sp = ties?.sp;
          if (sp) ev('evidence', id, `${sp.lane.task} is the only branch that changes ${sp.what}${sp.stage ? ` (red in ${sp.stage})` : ''}: running ${st.group.join(', ')} without it`, { agent: by, meta: { suspect: sp.lane.task, tests: sp.tests.slice(0, 5), files: sp.files, stage: sp.stage, rule: sp.rule } });
          what = `without ${st.suspect}`;
        } else if (st.step === 'apart') what = `apart from ${st.tied.join(', ')}`;
        else if (st.step === 'bisect') what = `bisect ${st.prefix.join('+')}`;
        else if (st.step === 'confirm') what = `confirm ${st.group[0]}`;
        // 2.86: a narrowing step by name runs only the red's tests on its merged tree and lands nothing (STUDIO_LAND_PROBE=1).
        if (st.byName) { const nt = retryNames(st.tests); what = `${what}, by name`; o = { play: firstRun?.play || null, noLand: true, retry: { stage: firstRedStage(firstRun), tests: nt } }; }
        // 2.90: two steps by name at once, one per gate (nextStep's pair); a step with no answer runs again below on one gate.
        if (st.also && st.byName) {
          res.rounds += 1;
          const pr = await pairRun([{ ...st, lanes: lanesOf(st.group) }, { ...st, group: st.also.group, prefix: st.also.prefix, lanes: lanesOf(st.also.group) }], firstRun);
          if (pr.moved) { hold(lanesOf(round.map((l) => l.task).filter((t) => live.has(t) && !res.landed.includes(t))), { status: 'error', why: pr.why }); stop = true; break; }
          let got = 0;
          pr.results.forEach((x, k) => {
            if (!x) return;
            got += 1; if (!x.reused) res.runs += 1;
            const pre = k ? st.also.prefix : st.prefix;
            results.push({ kind: 'bisect', group: pre.slice(), status: x.status, failures: (Array.isArray(x.failures) ? x.failures : []).filter((n) => !baseNames.has(n)), byName: true, compileOnly: false, n: pre.length, r: { ...x, play: firstRun?.play || null, noLand: true } });
          });
          if (got) { res.parallel = (res.parallel || 0) + 1; ev('parallel', id, `two steps by name at once on two gates: ${target} + ${st.prefix.join(' + ')}: ${pr.results[0]?.status || 'no answer'}; ${target} + ${st.also.prefix.join(' + ')}: ${pr.results[1]?.status || 'no answer'}; nothing landed`, { agent: by, meta: { groups: [st.prefix, st.also.prefix], status: pr.results.map((x) => x?.status || null) } }); continue; }
          log(`[unity-train] ${id}: neither gate gave an answer: ${what} runs on one gate`);
        }
        // 2.96 (c3): a hold set since the pick counts until the land run starts: the lane is left out (not handed back, not blamed)
        // and the round starts again with the lanes left, as any changed set (its rules green no longer stands).
        if (!st.byName && st.step !== 'probe' && holdMod) {
          const now = heldLanes(group, (() => { try { return deps.board?.() || null; } catch { return null; } })(), holdMod);
          if (now.size) { leaveOutHeld(now); const rest = round.filter((l) => live.has(l.task) && !res.landed.includes(l.task)); if (rest.length) pending.unshift(rest); break; }
        }
        res.rounds += 1;
        const r = await landGroup(group, what, o);
        await aheadSettle(r);
        // A run that should have landed nothing moved the target: stop, nobody is blamed (landGroup said why).
        if (r.moved) { hold(lanesOf(round.map((l) => l.task).filter((t) => live.has(t) && !res.landed.includes(t))), r); stop = true; break; }
        // The target's own full-run failures are never counted against a lane (2.85), nor narrowed on.
        results.push({ kind: st.step, group: st.group.slice(), status: r.status, failures: (Array.isArray(r.failures) ? r.failures : []).filter((x) => !baseNames.has(x)), byName: Boolean(st.byName), compileOnly: Boolean(r.compileOnly), ...(r.lane ? { lane: r.lane.task, laneObj: r.lane } : {}), ...(st.suspect ? { suspect: st.suspect } : {}), ...(st.tied ? { tied: st.tied } : {}), ...(st.prefix ? { n: st.prefix.length } : {}), r });
        if (st.step === 'probe') {
          if (!['pass', 'red'].includes(r.status)) log(`[unity-train] ${id}: the run of the target alone could not tell (${r.status}: ${String(r.why || '').split('\n')[0]}); blame goes on as before`);
          else log(`[unity-train] ${id}: the target alone is ${r.status === 'pass' ? 'green' : 'red'} on ${tests.join(', ')}${r.status === 'pass' ? ': a branch makes it red; blame goes on' : ''}`);
          continue;
        }
        if (r.status === 'pass') {
          if (st.step === 'retry') {
            const red = results[results.length - 2].r;
            const fails0 = Array.isArray(red.failures) ? red.failures : [];
            const sname = firstRedStage(firstRun);
            res.flaky = [...(res.flaky || []), { stage: sname, failures: fails0.slice(0, 10), ...(tests ? { tests: tests.slice(0, 10) } : {}), ...(st.known ? { known: true, retry: st.n } : {}) }];
            ev('flaky', id, `the same batch passed on retry ${st.n}: ${sname || 'unknown'} failed before (${fails0.slice(0, 3).join(', ') || 'no test named'}); nobody is handed back. A test that fails under load is the game's to fix`, { agent: by, to: 'producer', status: 'warn', meta: { stage: sname, failures: fails0.slice(0, 10), tests: fails0.slice(0, 10), retriedOnly: Boolean(tests), ...(st.known ? { known: true, retry: st.n } : {}), lanes: group.map((l) => l.task) } });
          }
          if (!st.byName && st.lands !== false) close(group, r);
          continue;
        }
        if (r.status !== 'red' && r.status !== 'conflict') { hold(lanesOf(round.map((l) => l.task).filter((t) => live.has(t) && !res.landed.includes(t))), r); stop = true; break; }
        if (st.step === 'without' || st.step === 'apart') log(`[unity-train] ${id}: the ${st.step === 'without' ? `batch without ${st.suspect}` : 'untied branches by themselves'} ${st.step === 'without' ? 'is' : 'are'} ${r.status} too: the evidence did not hold; searching by land runs`);
      }
    }
    // 2.91: the batch's rounds are over (landed or handed back): an overdue full run goes now, on the target as it is now.
    if (!fullCancelled && lanes.length && (fullLast || owed0.overdue)) {
      if (held) log(`[unity-train] ${id}: the overdue full run(s) wait for the next train: this train stopped (${held})`);
      else if (await fullsOnTarget('end')) res.cancelled = res.cancelled || { at: new Date().toISOString(), why: 'the train was cancelled during the full run at its end' };
    }
  } finally {
    await aheadSettle(null, 'the train ended before its land run answered');
    for (const l of set) deps.clearRunning?.(l.task);
    await Promise.all(shotJobs);
  }
  if (res.ok) res.ok = res.landed.length > 0 || (!res.dropped.length && !res.deferred.length && !res.waitTarget);
  return finish();

  function bisectSteps(results) { return results.filter((x) => ['land', 'bisect', 'confirm'].includes(x.kind)).map((x) => ({ n: x.kind === 'bisect' ? x.n : x.group.length, kind: x.kind, status: x.status, ...(x.byName ? { byName: true } : {}), ...(x.failures?.length ? { failures: x.failures.length } : {}) })); }
  // The round's runs as 2.85's bisect event said them: "<target> + A + B: red, <target> + A: pass" (a bisect step by its prefix).
  function bisectText(results) { const all = results[0]?.group || []; return results.filter((x) => ['land', 'bisect', 'confirm'].includes(x.kind)).map((x) => `${target} + ${(x.kind === 'bisect' ? (x.byName ? x.group : all.slice(0, x.n)) : x.group).join(' + ')}: ${x.status}`).join(', '); }
  function bisectCap() { return Math.max(1, Math.floor(num(env.STUDIO_ENGINE_BISECT_MAX, 3))); }
  /** 2.86: a hand-back the plan decided, with 2.85's texts and events. */
  function handBackStep(st, ls, results, ties) {
    const red = st.red?.r || st.red || {};
    const redTests = Array.isArray(red.failures) ? red.failures.slice(0, 5) : [];
    const redSaid = redTests.length ? ` (red: ${redTests.join(', ')}${red.failures.length > 5 ? ', ...' : ''})` : '';
    if (st.cause === 'conflict') { for (const l of ls) drop(l, st.red?.laneObj?.why || blame(red)); return; }
    if (st.cause === 'compile') {
      const lines = red.errorLines?.length ? red.errorLines : compilerLines(red.tail || '');
      for (const l of ls) drop(l, `${blame(red)}\nThe batch was red on a compile error in ${(ties?.byLane?.[l.task] || []).join(', ')}, which ${ls.length === 1 ? `${l.branch} changes and no other branch in the batch` : `only ${ls.map((x) => x.task).join(', ')} change in the batch`}; the others run again without ${ls.length === 1 ? 'it' : 'them'}. Bring ${target} in (${targetMergeCommand(l.task)}) and fix the lines below, then task done ${l.task} --train again.\nThe compiler:\n${lines.map((x) => `  ${x}`).join('\n')}`, { cause: 'compile', evidence: { files: ties?.byLane?.[l.task] || [] } });
      return;
    }
    if (st.cause === 'evidence') {
      const sp = ties?.sp || { tests: [], files: [], what: 'the evidence' };
      const wr = results.find((x) => x.kind === 'without');
      const rest = wr?.group || [];
      for (const l of ls) drop(l, `${blame(red)}\nBlame by evidence: the batch was red${sp.stage ? ` in its ${sp.stage} stage` : ''} on ${sp.tests.length ? sp.tests.slice(0, 5).join(', ') : 'a compile error'}, ${l.branch} (${l.task}) is the only branch that changes ${sp.what}, and the batch without it ${wr?.byName ? 'was green on those tests by name (it lands on one complete run next)' : 'landed green'} (${rest.join(', ')}). The files that tie them: ${sp.files.slice(0, 6).join(', ')}.${sp.say ? ` ${sp.say}` : ''} Fix it on ${l.branch} (bring ${target} in first: ${targetMergeCommand(l.task)}), then task done ${l.task} --train again.`, { cause: 'evidence', evidence: { tests: sp.tests, files: sp.files } });
      return;
    }
    if (st.cause === 'capped') {
      const sig = new Set(Array.isArray(results[0]?.failures) ? results[0].failures : []);
      const before = st.green || [];
      ev('bisect', id, `${bisectText(results)}; stopped after ${st.runs} bisect run(s) (STUDIO_ENGINE_BISECT_MAX): ${ls.map((l) => l.task).join(', ')} still fail${before.length ? `, ${before.join(' + ')} landed green` : ''}${redSaid}`, { agent: by, meta: { steps: bisectSteps(results), culprits: ls.map((l) => l.task), capped: true, tests: redTests } });
      for (const g of ls) drop(g, `${blame(red)}\nThe ${L} train's bisect stopped after ${st.runs} run(s) (STUDIO_ENGINE_BISECT_MAX ${bisectCap()}): ${target} + ${[...before, ...ls.map((l) => l.task)].join(' + ')} still shows the batch's failures (${[...sig].slice(0, 5).join(', ')}${sig.size > 5 ? ', ...' : ''}), so one of ${ls.map((l) => l.branch).join(', ')} breaks it${before.length ? `; ${target} + ${before.join(' + ')} landed green` : ''}. Fix it on its branch (bring ${target} in first: ${targetMergeCommand(g.task)}), then task done ${g.task} --train again.`, { evidence: redEvidenceOf(red) });
      return;
    }
    const culprit = ls[0];
    if (!culprit) return;
    if (results.some((x) => ['bisect', 'confirm'].includes(x.kind))) {
      const before = st.green || [];
      const nm = results.some((x) => x.byName);
      ev('bisect', id, `${bisectText(results)}; first not green with ${culprit.task}${nm ? ' (steps by name: none landed; the others land on one complete run next)' : ''}${redSaid}`, { agent: by, meta: { steps: bisectSteps(results), culprit: culprit.task, tests: redTests, byName: nm } });
      drop(culprit, `${blame(red)}\nThe ${L} train's prefix bisection${nm ? ' (by name: only the failing tests, nothing landed)' : ''}: ${target} + ${[...before, culprit.task].join(' + ')} is ${red.status}${before.length ? `, ${target} + ${before.join(' + ')} ${nm ? 'was green' : 'landed green'}` : ''}, and ${culprit.task} was red by itself; so ${culprit.branch} breaks it. Fix it on ${culprit.branch} (bring ${target} in first: ${targetMergeCommand(culprit.task)}), then task done ${culprit.task} --train again.`, { evidence: redEvidenceOf(red) });
      return;
    }
    drop(culprit, `${blame(red)}\nFix it on ${culprit.branch}, then task done ${culprit.task} --train again.`, { evidence: redEvidenceOf(red) });
  }

  function finish() {
    res.message = res.message || summary(res);
    const one = (x) => Math.round(x / 6000) / 10;
    const minutes = { total: one(Date.now() - t0), compile: one(spent.compile), rules: one(spent.rules), wait: one(spent.wait), land: one(spent.land) };
    try { writeJson(lastFile(root, engine), { ...res, minutes, landRuns, by, at: new Date().toISOString() }); } catch {}
    ev('done', id, res.message, { agent: by, status: res.landed.length ? 'ok' : 'warn', meta: { landed: res.landed, dropped: res.dropped.map((d) => d.task), deferred: res.deferred.map((d) => d.task), runs: res.runs, minutes, landRuns, refused: Boolean(res.refused), notRun: Boolean(res.notRun), ...(res.killed ? { killed: true } : {}), ...(res.cancelled ? { cancelled: true } : {}), ...(res.compileRuns ? { compileRuns: res.compileRuns } : {}), ...(res.fullLand ? { fullLand: res.fullLand } : {}), ...(res.fullRedOnTarget ? { fullRedOnTarget: res.fullRedOnTarget } : {}), ...(res.playUnmatched ? { playUnmatched: res.playUnmatched } : {}), ...(res.waitTarget ? { waitTarget: res.waitTarget.tests } : {}) } });
    return res;
  }
}

function summary(res) {
  const parts = [];
  if (res.landed.length) parts.push(`landed ${res.landed.join(', ')} with ${res.runs} ${labelOf(res.engine || 'unity')} land run(s)`);
  if (res.dropped.length) parts.push(`handed back ${res.dropped.map((d) => `${d.task} (${d.why.split('\n')[0]})`).join('; ')}`);
  if (res.deferred.length) parts.push(`waiting for the next ${labelOf(res.engine || 'unity')} train: ${res.deferred.map((d) => `${d.task} (${d.why.split('\n')[0]})`).join('; ')}`);
  // 2.96 (c1, c3, c4): lanes left out as held, and files merged as a union.
  if (res.held?.length) parts.push(`left out, held (still queued): ${res.held.map((h) => `${h.task} (${h.why})`).join('; ')}`);
  if (res.union?.length) parts.push(`merged as a union: ${[...new Set(res.union.flatMap((u) => u.files))].join(', ')}`);
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
export function unityStatusText(root = mainRoot(), { quiet = false, engine = 'unity', held = null } = {}) {
  const st = unityTrainStatus(root, engine);
  const L = labelOf(engine);
  if (quiet && !st.queue.length && !st.running) return '';
  const lines = [];
  // The running train's batch and the waiting queue are two lists: a queue entry whose task rides the running train is on the first only.
  // 2.96 (c1): a held lane is a third, listed once (held: from the board now, else the last train's record).
  const inTrain = new Set(st.running?.lanes || []);
  const hd = held || new Map(Object.entries(readJson(heldFile(root, engine)) || {}).map(([t, h]) => [t, h?.why || 'held']));
  const heldQ = st.queue.filter((e) => hd.has(e.task) && !inTrain.has(e.task));
  const waiting = st.queue.filter((e) => !inTrain.has(e.task) && !hd.has(e.task));
  const row = (e) => `  ${e.task}  ${e.agent || '?'}  ${e.branch} at ${short(e.head)} (queued ${String(e.at).slice(0, 16)})${e.tag ? `  tag ${e.tag}` : ''}${e.alone ? '  alone' : ''}`;
  if (st.running?.lanes?.length) lines.push(`Running ${L} train batch (${st.running.lanes.length}): ${st.running.lanes.join(', ')}`);
  lines.push(waiting.length ? `${waiting.length} ${L} branch(es) wait in the queue for the next ${L} train (npm run task -- train --engine ${engine}):\n${waiting.map(row).join('\n')}` : `No ${L} branch waits for a ${L} train (task done <ID> --train on a ${L}-track task queues one).`);
  for (const e of heldQ) lines.push(`${e.task} held: ${hd.get(e.task)}; its branch stays queued and takes no seat in a batch`);
  if (st.running?.union?.length) lines.push(`Running ${L} train: merged as a union: ${st.running.union.join(', ')}`);
  if (st.running) lines.push(`${L} train running: ${st.running.id} by ${st.running.by || '?'} (pid ${st.running.pid}, since ${new Date(st.running.at).toISOString().slice(11, 16)} UTC)${st.running.lanes?.length ? `, ${st.running.lanes.join(', ')}` : ''}${st.running.now ? `; now: ${st.running.now}` : ''}`);
  // 2.85 (B-137): the daily full run is said plainly while it runs.
  if (st.running?.full) lines.push(`This ${L} land run is the daily full run (${st.running.full.why}): every test runs, expect about ${st.running.full.minutes ? `${st.running.full.minutes} min` : 'the longest land run of the day'}.`);
  // 2.85: the tests the target itself fails in the full run (not counted against any branch).
  { const b = readFullBaseline(root, engine); if (b.failing.length) lines.push(`Known red on the target in the full run: ${b.failing.length} test(s): ${b.failing.slice(0, 3).join(', ')}${b.failing.length > 3 ? ', ...' : ''} (not counted against any branch; a fix task is wanted)`); }
  // 2.86: listed flaky tests that keep costing runs, and lanes that wait for the target (red on it alone).
  try { for (const l of flakeLines(root, engine)) lines.push(l); } catch { /* the queue lines stand */ }
  try { const w = waitingOnTarget(root, engine, st.queue); if (w.size) { const e0 = st.queue.find((e) => w.has(e.task)); lines.push(`${w.size} ${L} lane(s) wait for the target to move: it is red on ${(e0?.waitTarget?.tests || []).slice(0, 3).join(', ') || 'a test'} by itself (train ${e0?.waitTarget?.train || '?'}); nobody was handed back: ${[...w].join(', ')}`); } } catch { /* the queue lines stand */ }
  // Tags (how many wait per tag), why the running train's batch is what it is, and the automatic start.
  const tc = tagCounts(waiting);
  if (Object.keys(tc).length) lines.push(`Tagged ${L} lanes (only train --engine ${engine} --tag <tag> takes them; the automatic start never does): ${Object.entries(tc).map(([k, v]) => `${k} ${v} waiting`).join(', ')}; untagged ${waiting.filter((e) => !e.tag).length} waiting`);
  if (st.running?.batch) lines.push(`Running ${L} train's batch: ${st.running.batch}`);
  // 2.85: the last rules check: its mode and why (a full run names the unmapped paths), what it cost and how many parts ran at once.
  if (st.last?.rules?.ran && !st.running) lines.push(`Last ${L} rules check: ${st.last.rules.mode || 'full'}${st.last.rules.why ? `: ${st.last.rules.why}` : ''}; ${st.last.rules.runs ?? 0} run(s), ${Math.round((st.last.rules.ms || 0) / 1000)} s${st.last.rules.parts > 1 ? `, ${st.last.rules.parts} parts, ${st.last.rules.splitAtOnce || 1} at once` : ''}`);
  // 2.93: where the last train's time went (parts of 0 are left out; "the rest" is what the named parts do not cover).
  if (st.last?.minutes && !st.running) {
    const m = st.last.minutes;
    const named = [['compile', m.compile], ['rules check', m.rules], ['waiting for the machine', m.wait], [`land runs`, m.land, st.last.landRuns]].filter((p) => Math.round(p[1] || 0) > 0);
    const rest = Math.round(m.total - named.reduce((n, p) => n + p[1], 0));
    lines.push(`Last train took ${Math.round(m.total)} min: ${named.map((p) => `${p[0]} ${Math.round(p[1])}${p[2] ? ` (${p[2]})` : ''}`).join(', ') || 'no named part'}${rest >= 1 ? `; the rest ${rest}` : ''}.`);
  }
  if (st.last && !st.running) lines.push(`Last ${L} train ${st.last.id} (${String(st.last.at || '').slice(0, 16)}): ${st.last.message}${st.last.batch ? ` [batch ${st.last.batch}]` : ''}`);
  if (!quiet) { try { lines.push(autoLine(root, engine)); } catch { /* the queue lines stand */ } }
  { const nj = rulesIdleLine(root, engine); if (nj) lines.push(nj); }
  { const ah = aheadLine(root, engine); if (ah) lines.push(ah); }
  // 2.96 (a): each sampled run going on now, with its numbers and its reservation.
  try { lines.push(...runningLines(root)); } catch { /* the queue lines stand */ }
  { const tr = targetRedLine(root, engine); if (tr) lines.push(tr); }
  if (!quiet) { try { const s = unityTrainSettings(root, engine); if (!s.error) lines.push(parallelLine(root, engine, parallelNow(root, engine, s.cfg))); } catch { /* the queue lines stand */ } }
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
    const fl = flagOf(argv);
    const r = queueUnityTask(mainRoot(), { engine: fl('engine') || 'unity', task: fl('task'), agent: fl('agent') || null, branch: fl('branch') || null, alone: argv.includes('--alone') ? true : null, again: argv.includes('--again') });
    console.log(JSON.stringify({ ok: r.ok, message: r.message, error: r.error || null }));
    process.exit(r.ok ? 0 : 1);
  }
  // 2.85: `play-plan [--engine x] [--branch b | --paths a,b] [--json]`: what a batch's Play Mode stage would run, and why (read-only).
  if (argv[0] === 'play-plan') {
    const fl = flagOf(argv);
    // 2.96 (d): --propose names the paths no play.focus.map entry takes and proposes an entry for each (harness/play-gaps.mjs).
    if (argv.includes('--propose')) {
      const eng = fl('engine') || 'unity';
      const pl = fl('branch') || fl('paths') ? playPlan(mainRoot(), { engine: eng, branch: fl('branch'), paths: fl('paths') }) : null;
      const pr = proposeGaps(mainRoot(), { engine: eng, plan: pl, cfg: unityConfig(mainRoot(), eng) || {}, json: argv.includes('--json') });
      console.log(pr.text);
      process.exit(pr.code);
    }
    const r = playPlan(mainRoot(), { engine: fl('engine') || 'unity', branch: fl('branch'), paths: fl('paths') });
    if (argv.includes('--json')) console.log(JSON.stringify(r));
    else console.log(r.error ? r.message : playPlanText(r));
    process.exit(r.error ? 1 : 0);
  }
  // 2.86: `bisect-plan --lanes A,B,C [--red B] [--flaky] [--target-red] [--pass-on-retry N] [--tied A,B] [--complete] [--no-names]
  // [--land-min 60] [--name-min 5] [--json]`: the steps a red train would take for made-up outcomes, with each step's kind of run and
  // its minutes (nextStep, read-only: nothing runs; only the engine's flakyRetries and knownRedHours are read).
  if (argv[0] === 'bisect-plan') {
    const fl = flagOf(argv);
    const list = (k) => String(fl(k) || '').split(',').map((x) => x.trim()).filter(Boolean);
    const cfg = unityConfig(mainRoot(), fl('engine') || 'unity') || {};
    const landMin = Number(fl('land-min')) > 0 ? Number(fl('land-min')) : 60;
    const nameMin = Number(fl('name-min')) > 0 ? Number(fl('name-min')) : 5;
    const steps = bisectPlan({ lanes: list('lanes'), red: list('red'), tied: list('tied'), flakyRed: argv.includes('--flaky'), targetRed: argv.includes('--target-red'), passOnRetry: Number(fl('pass-on-retry')) || 0, byName: !argv.includes('--complete'), noNames: argv.includes('--no-names'), flakyRetries: flakyRetriesOf(cfg), knownRed: Number(cfg.knownRedHours) > 0, landMin, nameMin });
    const ran = steps.filter((x) => x.status);
    if (argv.includes('--json')) console.log(JSON.stringify(steps));
    else console.log(steps.length ? `${steps.map((x, i) => `${i + 1}. ${x.step}${x.group.length ? ` ${x.group.join(', ')}` : x.step === 'probe' ? ' (the target alone)' : ''}${x.status ? `: ${x.status} [${x.run === 'name' ? 'by name' : 'complete run'}, ~${x.minutes} min${x.lands ? '' : ', does not land'}]` : ''}${x.cause ? ` (${x.cause})` : ''}`).join('\n')}\n${ran.length} land run(s): ${ran.filter((x) => x.run !== 'name').length} complete, ${ran.filter((x) => x.run === 'name').length} by name; about ${ran.reduce((k, x) => k + x.minutes, 0)} min` : 'Pass --lanes A,B,C (and --red B for the lanes that break a run).');
    process.exit(list('lanes').length ? 0 : 1);
  }
  console.error('Usage: node harness/unity-train.mjs status [--json] | queue --task <ID> [--again] | play-plan [--branch b | --paths a,b] | bisect-plan --lanes A,B,C [--red B] [--flaky] [--target-red] [--pass-on-retry N] [--tied A] [--complete] [--no-names]   (npm run task -- train --unity runs a Unity train)');
  process.exit(1);
}
