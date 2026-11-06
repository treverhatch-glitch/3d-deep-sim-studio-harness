/**
 * harness/train.mjs — 2.59.0: the merge train, the standard way lanes land.
 *
 * Before 2.59.0 landing was strictly serial: each lane ran a full verify, `task done` delivered it, main moved, and
 * every other lane had to rebase (which often invalidated its hook stamps) and verify again: about 10 rebases and 1-2 h
 * of serial verifies in one crew day. A train lands several lanes on ONE full verify:
 *
 *   1. pick the ready lanes: the train queue (.studio/train/queue.json; `task done <ID> --train` puts a lane there once
 *      every check of task done but the game's checks passes), oldest first, at most --max;
 *   2. check each lane again (the same checks task done runs before the game's checks, in the lane's own copy: board,
 *      done-check, protected files, secrets, hooks, weakened tests; uncommitted work refuses);
 *   3. build an integration branch train/<id> = main + each lane, in order, in a scratch copy (.lanes/_train-<id>,
 *      made like a lane copy: never the main checkout's files, never a lane's copy). A lane is merged as it is (a
 *      fast-forward, or a merge commit the hooks stamp): its own commits are never rewritten, so their stamps hold.
 *      A lane that conflicts with the lanes before it waits for the next train; one that conflicts with main itself
 *      is handed back;
 *   4. ONE full verify (scripts/run-gates.mjs, the gates a landing runs, scoped as a lane's verify is to the files the
 *      lanes change; --all for a "whole" task) of the final tree. A green full verify already recorded for exactly
 *      that tree stands for it (the one-lane case after the lane's own verify, as task done does since 2.58.5);
 *   5. green: under the land lock, main moves (compare-and-swap, harness/worktree.mjs landFastForward) to the train's
 *      tip, whose tree is the one verified, and each task closes (board, claim, events) as task done closes it;
 *   6. red (2.60.0, prefix bisection): only the failing checks run again (run-gates --only), first on main (red there:
 *      main itself is red, nobody is handed back), then on cumulative prefixes main+A, main+A+B, ... by binary search
 *      (about log2 N targeted runs). The first red prefix names the lane that breaks them, alone or only together
 *      with the lanes before it (an interaction culprit); it is handed back and the rest train again (one more full
 *      verify of the tree main would move to). STUDIO_TRAIN_BISECT=alone keeps the 2.59 way: each lane verified alone
 *      on main, one that fails alone handed back, lanes that pass alone but fail together: the last one waits;
 *   7. pins (2.60.0): when the red is only the game's declared pin tests (studio.gates.json "pins"), the pins' report
 *      runs on every prefix and each moved pin value is attributed to the lane(s) whose step changed it. Every move
 *      declared by its lane (a Pin-Moves: trailer on the lane's own commits) and no invariant pin moved: the pins'
 *      refresh runs on the combined tree, ONE extra train commit ("pin refresh", Pin-Refresh: <lanes>) is verified
 *      in full and lands with the lanes; the before/after report is kept in .studio/train/<id>/pins.json. An
 *      undeclared move or a moved invariant hands back the lane it is attributed to; pins red on main itself is a
 *      regression on main (nobody handed back). All of it is code: nothing here is decided by a model;
 *   8. unionFiles (2.60.0): two lanes (or a lane and main) that conflict ONLY inside files the manifest lists as
 *      "unionFiles" (one-import-per-line barrels) are merged with git's union driver for those files (both sides'
 *      added lines kept, ours first) and the merge commit says so (Union-Merge:); any other conflict is as before;
 *   9. tiers (2.63.0, harness/tiers.mjs): before its check each lane gets a blast-radius tier from its own diff, by
 *      code. C (protected files, harness code, deleted tests, irreversible files, upgrade merges) is held in the queue
 *      as "needs the owner" until a person releases it (releaseLane; never a worker); B (sim, goldens, pins, shared
 *      code) makes the verify --all, is handed back for a golden without Golden-Reason or a pin file without
 *      Pin-Moves, and is held after more than 3 hand-backs; A lands with the normal verify;
 *  10. batching (2.63.0): a queued train waits up to STUDIO_TRAIN_WAIT_MIN for STUDIO_TRAIN_MIN lanes, takes at most
 *      STUDIO_TRAIN_MAX; a "runAlone" lane (manifest) gets a train of its own (the next trains run right after); a lone
 *      task done takes the queued lanes along (ride along), its own lane's result its answer.
 *  11. B-43 (2.65.3): re-checks run only the failing test files (harness/train-focus.mjs, STUDIO_GATE_FOCUS); the red
 *      event names the failing tests; each re-check says its question and an ETA (harness/train-status.mjs), a new
 *      round says what it is, the step is in .studio/train/<id>/status.json; once a culprit at position k > 1 is named
 *      the green prefix is verified in full and lands at once, the lanes after it go in the next train, run right away
 *      (landPrefixEarly; STUDIO_TRAIN_LAND_PREFIX=off keeps 2.65.2).
 *  12. chain tails (2.67.0, harness/train-tail.mjs, STUDIO_TRAIN_CHAIN_TAIL): before the verify, a stacked chain (or a
 *      lane declaring pin moves) is built alone in a second scratch copy and its touched tests and pins run there; red:
 *      ONE "chain tail" builder task stacked on its last lane. A verify red on exactly those tests defers the whole
 *      chain "waiting for its tail" (no bisection, nobody handed back); chain + tail land together once it is queued.
 *  13. parallel prefixes (2.69.0, harness/train-parallel.mjs): the prefix search re-checks K boundary prefixes at once,
 *      each in its own scratch copy (K from the machine budget, STUDIO_TRAIN_BISECT_PARALLEL; no scan: 1, as before);
 *      STUDIO_VERIFY_REMOTE=github (harness/remote-verify.mjs): the safety gates always run locally; only the game's
 *      checks may come from the named CI check run on train/<id> (STUDIO_VERIFY_REMOTE_CHECK); both must pass.
 *
 * Safety: main moves only after a green full verify of exactly the tree it ends at, and only from the tip the train
 * was built on (if main moved meanwhile, the train is rebuilt and verified again); one train at a time
 * (.studio/locks/train.lock); drain and stop are respected; the verify takes gate slots as a landing
 * (STUDIO_GATE_PRIORITY=landing). A lane that gained commits after its check lands as checked and stays queued
 * (2.78.1 (d): unless they are only merges of main that bring nothing beyond it: the task closes as landed).
 * 2.78.1 (d): a tier-A lane whose tip changes no file against main lands without a verify (empty_diff): main's tree
 * doesn't change, so nothing is verified that main hasn't been (STUDIO_TRAIN_EMPTY_DIFF=off: it rides the verify).
 *
 * `task done <ID>` in a lane copy is a one-lane train (STUDIO_TRAIN=off: the old deliver path). This module never
 * imports harness/task.mjs (its CLI imports this one): the board operations come in as `deps`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitEvent, readRecentEvents } from './event.mjs';
import { mainRoot, mainBranch, linkDir, nodeModuleDirs, ignoreLanes, landFastForward, forgetLanded, rememberTaskBranch, LANES_DIR } from './worktree.mjs';
import { withLandLock, judgeVerifyReuse, matchAny, withGateSlot, selectGates, ALWAYS_SHARED } from './merge-lane.mjs';
import { studioCheckReaders } from './check-reads.mjs';
import { recordTrust } from './gate-trust.mjs';
import { beginTrainLife, reapDeadTrains } from './train-life.mjs';
import { processHarness, chainGuard, copyHarnessDrift } from './harness-version.mjs';
import { cancelPath } from './train-watch.mjs';
import { recreateLaneCopy, ownWorktree, infraHandBack, INFRA_HANDBACK, keepRelease, keptRelease, forgetRelease, mixedLane, mayCarry, noteMixed, laneContent, carriedRelease } from './train-lanes.mjs';
import { readBeta, betaActor, recordBetaUse } from './beta-mode.mjs';
import { addKnownRed, clearKnownRed, knownRedCandidate, readKnownRed, fileSub } from './known-red.mjs';
import { toolchainProtected } from './test-toolchain.mjs';
import { fixFirstOrder, noteTrainRed, noteTrainLanded, noteFixTried } from './train-fix-first.mjs';
import { engineGates, relatedTestsOn, studioGame, perfTestsOf } from './game-gates.mjs';
import { readBaseline, judgeRed } from './baseline.mjs';
import { classifyLane, tierLine } from './tiers.mjs';
import { recordRound, redSignature } from './round-cap.mjs';
import { unverifiedMust, contractHoldWhy, contractOnlyHold, CONTRACT_HOLD } from './contracts.mjs';
import { laneProposal, configLine, isProposalPath, proposalTargets, proposalRel, parseProposal, protectedGlobsAt, applyLandedConfig as applyLandedConfigWith } from './config-proposal.mjs';
import { agentOnPermission, permissionText, WORKER_NAME, AGENT_SHELL, mayDecide, actorOf } from './permission.mjs';
import { agentLikeName, launchedSession } from './agent-env.mjs';
import { delegationFor, recordUse } from './delegation.mjs';
import { autonomousReleaseRefusal } from './policy-rules.mjs';
import { logDecision, asOf } from './decisions-log.mjs';
import { rerecordTier, rerecordRefusal, rerecordEvidence } from './golden-report.mjs';
import { jobDone } from './jobs.mjs';
import { boardStates, readDeps, droppedTasks, judgeDeps, orderByDeps } from './train-deps.mjs';
import { trainFocus, failingTestsLine } from './train-focus.mjs';
import { trainEta, stepsLeft, writeTrainStatus, writeTrainsSummary, quietVerifyMs, capNote, readTrainStatus } from './train-status.mjs';
import { batchCap, batchSize, pipelineMode, pipelineRoom, pipelineKick, nextBusy, waitForNext, takeNextLock, trainState, judgeTrainA, pickNextLanes, speculativeBaseVerdict, NEXT_BY } from './train-pipeline.mjs';
import { withFacts } from './handback-facts.mjs';
import { triageRed, triageOn, fileQuarantineTasks, loadSensitiveExcuse, collisionWaitExcuse, flakeRules, flakeHoldMin } from './flakes.mjs';
import { waitQuiet } from './flake-quiet.mjs';
import { onlyMainMerges } from './landed-content.mjs';
import { markQuietHold, clearQuietHold } from './heavy.mjs';
import { subIdsFromLog } from './gate-subids.mjs';
import { timeoutFlakesFromLog } from './timeout-rerun.mjs';
import { runGatesWaiting, busyWhy, ranNoCheck } from './train-busy.mjs';
import { remoteMode, remoteVerify, remoteCheckPattern, localGateIds } from './remote-verify.mjs';
import { bisectWidth, karySearch, karyCost, focusWorkers, spawnCollect, runGatesWaitingAsync } from './train-parallel.mjs';
import { chainTailOn, readTails, updateTails, trainChains, touchedTests, chainFocus, failingTests, tailSignature, tailsExplaining, tailTitle, tailNote, tailWaitWhy, pinDiffLines } from './train-tail.mjs';
import { checkStamped, stampWrite } from './workaround.mjs';
import { gateEnv } from './gate-env.mjs';
import { refreshStaleLane } from './train-refresh.mjs';
import { writeAtomic } from './fsafe.mjs';

const git = (cwd, ...args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export const TRAIN_DIR = path.join('.studio', 'train');
export const trainOn = (env = process.env) => !/^(off|0|false|no)$/i.test(String(env.STUDIO_TRAIN || ''));

// ---- the queue ----------------------------------------------------------------------------------

const queueFile = (root) => path.join(root, TRAIN_DIR, 'queue.json');
export function readQueue(root = mainRoot()) {
  try { const q = JSON.parse(fs.readFileSync(queueFile(root), 'utf8')); return Array.isArray(q) ? q : []; } catch { return []; }
}
function writeQueue(root, q) {
  const f = queueFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const text = `${JSON.stringify(q, null, 2)}\n`;
  try { stampWrite(f, text, { root }); } catch { /* 2.71.0 (z): the write goes ahead unstamped */ }
  // 2.79 (b): with the retries Windows needs when another process has the file open (fsafe.mjs writeAtomic): a bare rename
  // died with EPERM while a reader had queue.json open.
  writeAtomic(f, text);
}
// 2.71.0 (z): the queue changed by hand since the harness last wrote it is a detected workaround (harness/workaround.mjs).
const withQueue = (root, fn) => withLandLock(root, () => { try { checkStamped(queueFile(root), { root }); } catch { /* evidence only */ } const q = readQueue(root); const r = fn(q); writeQueue(root, q); return r; }, { name: 'train-queue', waitMs: 30000 });

/** Put a checked lane in the queue (replacing the task's older entry). entry: { task, agent, dir, branch, head, all }. */
export function enqueue(root, entry) {
  return withQueue(root, (q) => {
    const i = q.findIndex((e) => e.task === entry.task);
    const rec = { ...entry, at: new Date().toISOString() };
    // 2.63.0: a hold for the owner, and a person's release of it, stay with the entry while its head is the same.
    // 2.79 (c): or while the lane's content is the same (a catch-up merge of main that touches none of the released
    // files, train-lanes.mjs carriedRelease): the release is carried to the new head, with its hold.
    if (i >= 0) {
      const was = q[i];
      const carried = was.released && was.head !== rec.head ? carriedRelease(root, was.released, { head: rec.head, tip: mainTip(root) }) : null;
      const keep = was.head === rec.head || Boolean(carried);
      q.splice(i, 1, { ...rec, ...(keep ? { ...(was.held ? { held: was.held } : {}), ...(was.released ? { released: carried || was.released } : {}) } : {}), at: was.at });
    }
    else q.push(rec);
    return rec;
  });
}
export function dequeue(root, task) {
  return withQueue(root, (q) => { const i = q.findIndex((e) => e.task === task); if (i >= 0) q.splice(i, 1); return i >= 0; });
}
const requeue = (root, lane, patch) => withQueue(root, (q) => { const e = q.find((x) => x.task === lane.task); if (e) Object.assign(e, patch); });

// ---- 2.67.2: a held task stays out of trains; train leave -----------------------------------------

/** The `task hold` record for a task (studio/task-holds.json, main's), or null. */
export function taskHoldOf(root, task) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'studio', 'task-holds.json'), 'utf8')).tasks?.[task]?.held || null; } catch { return null; }
}
/** Words for a held task left out of a train. */
export const heldOutWhy = (h) => `held for landing by ${h.by || 'someone'}${h.why ? `: ${h.why}` : ''}; it stays out of trains until npm run task -- unhold <ID> --by <name>`;

/** Who left the train queue on purpose, newest last: .studio/train/left.json [{ task, by, why, at, head, branch }]. */
export function readLeft(root) {
  try { const j = JSON.parse(fs.readFileSync(path.join(root, TRAIN_DIR, 'left.json'), 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; }
}

/**
 * `npm run task -- train leave <ID> --by <name> --why "…"`: take a queued lane out of the train queue on purpose (its
 * copy and commits stay; task done <ID> --train queues it again). Who: as for task hold (a person, a Producer or
 * Director session, an agent outside the harness; never a worker). Recorded (.studio/train/left.json) with who and why,
 * and a task.train.left event. Before 2.67.2 the crew called dequeue() from this file by hand.
 */
export async function leaveTrain(root, task, { by = '', why = '', env = process.env } = {}) {
  const { holdRefusal } = await import('./task-hold.mjs');
  const refused = holdRefusal(by, env);
  if (refused) return { ok: false, message: refused.replace('hold a lane', 'take a lane out of the train').replace('holds lanes', 'takes lanes out of the train') };
  if (!String(why).trim()) return { ok: false, message: 'Say why: --why "…" (it is recorded and shown in npm run lanes).' };
  const e = readQueue(root).find((x) => x.task === task);
  if (!e) return { ok: false, message: `${task} isn't in the train queue (npm run task -- train status lists it).` };
  dequeue(root, task);
  // 2.77.1 (B-98): a train already running with this lane stops before its next check (it can only look between steps).
  const running = [];
  try { const st = readTrainStatus(root); for (const t of [st?.train, st?.next?.train]) if (t && !running.includes(String(t))) running.push(String(t)); } catch {}
  const rec = { task, by: String(by).trim().slice(0, 60), why: String(why).trim().slice(0, 300), at: new Date().toISOString(), head: e.head || null, branch: e.branch || null };
  const f = path.join(root, TRAIN_DIR, 'left.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify([...readLeft(root), rec].slice(-200), null, 2));
  for (const tid of running) writeCancel(root, tid, rec);
  emitEvent({ type: 'task.train.left', agent: rec.by, task, to: e.agent || undefined, status: 'warn', msg: `${task} left the train queue (by ${rec.by}): ${rec.why}`.slice(0, 600), meta: { head: rec.head, branch: rec.branch, ...(running.length ? { runningTrains: running } : {}) } });
  return { ok: true, entry: rec, cancelled: running, message: `${task} is out of the train queue (by ${rec.by}: ${rec.why}). Its copy and commits are unchanged; npm run task -- done ${task} --train queues it again.${running.length ? ` Train ${running.join(', ')} is running: if it has ${task}, it stops before its next check and the other lanes stay queued.` : ''}` };
}

// ---- 2.77.1 (B-98): a lane that leaves a running train stops that train ------------------------------------------------

/** .studio/train/<train id>.cancel.json = { tasks, by, why, at }: written by leaveTrain, read by the running train. */
const cancelFile = cancelPath; // .studio/train/<id>.cancel.json (2.77.3: the stall watch writes one too, { stall: true })
export function readCancel(root, id) {
  try { const j = JSON.parse(fs.readFileSync(cancelFile(root, id), 'utf8')); return j && Array.isArray(j.tasks) ? j : null; } catch { return null; }
}
function writeCancel(root, id, rec) {
  try {
    const old = readCancel(root, id);
    const f = cancelFile(root, id);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify({ tasks: [...new Set([...(old?.tasks || []), rec.task])], by: rec.by, why: rec.why, at: rec.at }, null, 2)}\n`);
  } catch {}
}
/** Running trains in this process: id -> () => the tasks still riding it (not handed back, not landed). */
const activeLanes = new Map();
class TrainCancelled extends Error {
  constructor(marker) { super(marker.stall ? `the train stalled (${marker.why})` : marker.cancel ? `the train was cancelled (by ${marker.by}${marker.why ? `: ${marker.why}` : ''})` : `${marker.tasks.join(', ')} left the train (by ${marker.by}: ${marker.why})`); this.marker = marker; this.name = 'TrainCancelled'; this.stopsTriage = true; }
}
// ---- 2.78.2 (b): the red chain's time cap -------------------------------------------------------------------------

/**
 * STUDIO_TRAIN_RED_BUDGET_MIN (default 30; 0 or off: no cap): minutes a train may spend on a red, from its first red
 * verify (the flake triage, the bisection, the re-check of main, later rounds' verifies). One red cost the crew 1-2 h
 * (train 111009: 106 min, nothing landed). Past it the train stops looking: it hands back the NEWEST lane (the most likely
 * cause), lands the longest prefix of the others that a full verify of its exact tree has already passed (never one that
 * no full verify passed), and re-queues the rest (task.train.red_budget).
 */
export function redBudgetMin(env = process.env) {
  const v = String(env.STUDIO_TRAIN_RED_BUDGET_MIN ?? '').trim();
  if (v === '') return 30;
  if (/^(off|no|false)$/i.test(v)) return 0;
  return Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 30;
}
/** Running trains in this process: id -> { t0, ms, red } (red: the first red verify's summary, for the hand-back). */
const redClock = new Map();
class TrainRedBudget extends TrainCancelled {
  constructor(marker) { super({ tasks: [], ...marker }); this.message = `the red chain ran past its budget (${marker.why})`; this.name = 'TrainRedBudget'; }
}
/** The first red verify of a running train starts its clock (once per train; only for a train this process runs). */
function startRedClock(id, red, env = process.env) {
  const ms = redBudgetMin(env) * 60000;
  if (!ms || redClock.has(String(id)) || !activeLanes.has(String(id))) return;
  redClock.set(String(id), { t0: Date.now(), ms, min: redBudgetMin(env), red });
}
/** Minutes of the red budget left (Infinity when no clock runs). */
function redLeftMin(id) {
  const c = redClock.get(String(id));
  return c ? Math.max(0, (c.ms - (Date.now() - c.t0)) / 60000) : Infinity;
}
/** Throws TrainRedBudget once the red chain has run past its budget (before each triage run, re-check, round and verify). */
function checkRedBudget(id) {
  const c = redClock.get(String(id));
  if (!c || Date.now() - c.t0 <= c.ms) return;
  const took = (Date.now() - c.t0) / 60000;
  throw new TrainRedBudget({ redBudget: true, why: `${took >= 10 ? Math.round(took) : Math.round(took * 10) / 10} min since the first red verify, more than STUDIO_TRAIN_RED_BUDGET_MIN (${c.min})`, red: c.red, minutes: c.min });
}

/**
 * Throws TrainCancelled when a lane of train `id` has left it (called before each verify, re-check and round, and
 * 2.77.3 right after each check's run). 2.77.3 (H2): a stall marker (harness/train-watch.mjs) stops the whole train.
 */
function checkCancel(root, id) {
  const lanes = activeLanes.get(String(id));
  if (!lanes) return;
  const m = readCancel(root, id);
  if (!m) return;
  if (m.stall || m.cancel) throw new TrainCancelled({ ...m, tasks: lanes() }); // 2.78.2 (a): `train cancel` stops it all
  const left = m.tasks.filter((t) => lanes().includes(t));
  if (left.length) throw new TrainCancelled({ ...m, tasks: left });
}

// ---- one train at a time ------------------------------------------------------------------------

/**
 * Hold .studio/locks/train.lock while fn runs. A lock held by a dead process, or older than STUDIO_TRAIN_STALE_MIN
 * (360), is taken over. Busy past waitMs: { busy: holder } and fn doesn't run.
 */
export async function withTrainLock(root, info, fn, { waitMs = 0, poll = 2000, log = () => {} } = {}) {
  const dir = path.join(root, '.studio', 'locks');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'train.lock');
  const stale = Number(process.env.STUDIO_TRAIN_STALE_MIN || 360) * 60000;
  const deadline = Date.now() + waitMs;
  let told = false;
  for (;;) {
    try {
      fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now(), ...info }), { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' && err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') throw err;
      let h = null;
      try { h = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { try { if (Date.now() - fs.statSync(f).mtimeMs > 5000) fs.rmSync(f, { force: true }); } catch {} }
      if (h && ((h.pid && !alive(h.pid)) || Date.now() - h.at > stale)) { try { fs.rmSync(f, { force: true }); } catch {} continue; }
      if (Date.now() >= deadline) return { busy: h || { why: 'unreadable lock' } };
      if (!told && h) { log(`[train] another train is running (${h.id || '?'}, by ${h.by || '?'}, since ${new Date(h.at).toISOString().slice(11, 19)} UTC); waiting for it`); told = true; }
      sleep(poll);
    }
  }
  try { return await fn(); } finally { try { fs.rmSync(f, { force: true }); } catch {} }
}

// ---- the scratch copy -----------------------------------------------------------------------------

/**
 * A scratch copy for train <id>: .lanes/_train-<id> on branch train/<id> at `tip`, made like a lane copy (studio/ and
 * .studio/ linked to the main checkout's, node_modules linked, .env copied), so its verify is a lane verify of the
 * integration: scoped to what it changes against main, its record in the shared .studio/.
 */
export function makeScratch(root, id, tip) {
  const name = `_train-${id}`;
  const dir = path.join(root, LANES_DIR, name);
  const branch = `train/${id}`;
  fs.mkdirSync(path.join(root, LANES_DIR), { recursive: true });
  ignoreLanes(root);
  const add = git(root, 'worktree', 'add', '--no-checkout', '-b', branch, dir, tip);
  if (add.status !== 0) return { error: `git worktree add failed: ${(add.stderr || '').trim().split('\n').pop()}` };
  const steps = [
    ['config', 'extensions.worktreeConfig', 'true'],
    ['config', '--worktree', 'sparse.expectFilesOutsideOfPatterns', 'true'],
    ['sparse-checkout', 'set', '--no-cone', '/*', '!/studio/', '!/.studio/'],
    ['checkout', '-q', branch],
  ];
  const sc = { dir, branch, name, root };
  for (const s of steps) {
    const r = git(dir, ...s);
    if (r.status !== 0) { removeScratch(sc); return { error: `git ${s.slice(0, 2).join(' ')} failed: ${(r.stderr || '').trim().split('\n').pop()}` }; }
  }
  if (!linkDir(path.join(root, 'studio'), path.join(dir, 'studio')) || !linkDir(path.join(root, '.studio'), path.join(dir, '.studio'))) {
    removeScratch(sc);
    return { error: 'could not link studio/ and .studio/ into the train copy' };
  }
  for (const rel of nodeModuleDirs(root)) if (!fs.existsSync(path.join(dir, rel))) linkDir(path.join(root, rel), path.join(dir, rel));
  try { if (fs.existsSync(path.join(root, '.env'))) fs.copyFileSync(path.join(root, '.env'), path.join(dir, '.env')); } catch {}
  const exclude = path.join(root, '.studio', 'lanes', `${name}.exclude`);
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.writeFileSync(exclude, ['/studio', '/.studio', '/.env', 'node_modules', ''].join('\n'));
  git(dir, 'config', '--worktree', 'core.excludesFile', exclude);
  return sc;
}

export function removeScratch(sc) {
  if (!sc?.dir) return;
  for (const rel of ['studio', '.studio', ...nodeModuleDirs(sc.root)]) {
    const p = path.join(sc.dir, rel);
    try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch {}
    // A Windows junction is not always reported as a symbolic link: remove it as an empty directory link.
    try { if (process.platform === 'win32' && fs.existsSync(p) && fs.lstatSync(p).isDirectory() && fs.realpathSync(p) !== path.join(fs.realpathSync(sc.dir), rel)) fs.rmdirSync(p); } catch {}
  }
  git(sc.root, 'worktree', 'remove', '--force', sc.dir);
  if (fs.existsSync(sc.dir)) { try { fs.rmSync(sc.dir, { recursive: true, force: true }); } catch {} }
  git(sc.root, 'worktree', 'prune');
  git(sc.root, 'branch', '-D', sc.branch);
  try { fs.rmSync(path.join(sc.root, '.studio', 'lanes', `${sc.name}.exclude`), { force: true }); } catch {}
}

/** The Golden-Reason trailers of a lane's own commits: a merge that brings their golden changes carries them. */
function goldenReasons(root, base, head) {
  const r = git(root, 'log', '--format=%(trailers:key=Golden-Reason,valueonly,separator=%x3B )', `${base}..${head}`);
  return [...new Set(out(r).split('\n').map((s) => s.trim()).filter(Boolean))];
}

// ---- 2.60.0: the game's train settings (pins, unionFiles) -----------------------------------------------

/**
 * The train's part of a game manifest (pure; see docs/ONBOARDING-A-GAME.md "Pins and union files"):
 *   "pins": { "tests": [<test names or globs>], "report": "<cmd with {out}>", "refresh": "<cmd with {in}>",
 *             "invariants": [<pin names or globs never auto-refreshed>] }
 *   "unionFiles": [<repo-relative paths or globs of one-import-per-line files>]
 * 2.63.0 (landing tiers and batching): pins.files, "simPaths", "shared", "registry", "ui", "irreversible" (globs),
 * "tiers" ({ rules, set, default }: harness/tiers.mjs), "runAlone" ({ maxFiles, paths }).
 * Returns { pins: {...} | null, unionFiles: [], notes: [problems], ...those keys }. A pins block with a problem is off (noted).
 */
export function readTrainSettings(j = {}) {
  const notes = [];
  const strs = (a) => (Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean) : []);
  let pins = null;
  if (j && j.pins !== undefined) {
    const p = j.pins && typeof j.pins === 'object' ? j.pins : {};
    const bad = [];
    if (!strs(p.tests).length) bad.push('pins.tests lists no test');
    if (typeof p.report !== 'string' || !p.report.includes('{out}')) bad.push('pins.report must be a command with {out}');
    if (typeof p.refresh !== 'string' || !p.refresh.includes('{in}')) bad.push('pins.refresh must be a command with {in}');
    if (bad.length) notes.push(...bad);
    else pins = { tests: strs(p.tests), report: p.report, refresh: p.refresh, invariants: strs(p.invariants) };
  }
  const unionFiles = [];
  for (const f of strs(j?.unionFiles)) {
    const rel = f.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (/[\s"']/.test(rel) || rel.startsWith('../') || !rel) notes.push(`unionFiles: "${f}" is not a plain repo-relative path`);
    else unionFiles.push(rel);
  }
  if (pins && j.pins.files !== undefined) pins.files = strs(j.pins.files);
  // 2.63.0: what the landing tiers (harness/tiers.mjs) and the batching rules read from the manifest.
  const extra = {};
  for (const k of ['simPaths', 'shared', 'registry', 'ui', 'irreversible']) if (j && j[k] !== undefined) extra[k] = strs(j[k]);
  if (j && j.tiers !== undefined) {
    if (j.tiers && typeof j.tiers === 'object' && !Array.isArray(j.tiers)) extra.tiers = j.tiers;
    else notes.push('tiers must be an object ({ "rules": [...], "set": {...}, "default": "B" })');
  }
  if (j && j.runAlone !== undefined) {
    const ra = j.runAlone && typeof j.runAlone === 'object' ? j.runAlone : {};
    const maxFiles = Number(ra.maxFiles);
    if (ra.maxFiles !== undefined && !(maxFiles > 0)) notes.push('runAlone.maxFiles must be a number above 0');
    extra.runAlone = { ...(maxFiles > 0 ? { maxFiles } : {}), paths: strs(ra.paths) };
  }
  return { pins, unionFiles, notes, ...extra };
}

/**
 * The game's train settings, read from main's tip (the manifest is protected: a lane can't change it without the
 * owner), else from the checkout. { gameRoot, manifest, pins, unionFiles, notes }; never throws.
 */
export async function trainManifest(root, tip) {
  const none = { gameRoot: null, manifest: null, pins: null, unionFiles: [], notes: [] };
  let game = null;
  try { game = await studioGame(); } catch {}
  if (!game?.root) return none;
  const rel = `${game.root}/studio.gates.json`;
  let text = tip ? out(git(root, 'show', `${tip}:${rel}`)) : '';
  if (!text) { try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch {} }
  if (!text) return { ...none, gameRoot: game.root, manifest: rel };
  try { return { gameRoot: game.root, manifest: rel, ...readTrainSettings(JSON.parse(text)) }; } catch { return { ...none, gameRoot: game.root, manifest: rel, notes: [`${rel} is not valid JSON`] }; }
}

const esc = (s) => String(s).replace(/[.+^${}()|[\]\\?]/g, '\\$&');
/** A pin name matches a Pin-Moves or invariants entry: the whole name, `*` matching anything. */
export const pinNameMatches = (name, globs = []) => globs.some((g) => new RegExp(`^${esc(g).replace(/\*/g, '.*')}$`).test(String(name)));
/**
 * A failing test is a pin test when a pins.tests entry matches its name whole or as a token bounded by non-word
 * characters (`*` matching within the token): "throughput" matches "pins > throughput" and
 * "throughput: expected 10, got 11"; "replays/start-*" matches "replays/start-2 drifted".
 */
export const isPinTest = (name, tests = []) => tests.some((t) => new RegExp(`(^|[^\\w])${esc(t).replace(/\*/g, '\\S*')}($|[^\\w])`).test(String(name)));

/** The Pin-Moves trailers of a lane's own commits (base..head): the pins it says it moves. */
export function pinMoves(root, base, head) {
  const r = git(root, 'log', '--format=%(trailers:key=Pin-Moves,valueonly,separator=%x2C)', `${base}..${head}`);
  return [...new Set(out(r).split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];
}

/**
 * Is a red verify only the game's declared pins? Every failing required gate is a game gate (its command runs
 * harness/game-gates.mjs), every failing game check named its failing tests (game-gates prints them since 2.60.0),
 * and every one of those tests is a pin test. Returns { ok, why, checks, tests }.
 */
export function pinsOnlyRed(text, { failGates = [], gameGates = ['game'], tests = [] } = {}) {
  if (!failGates.length) return { ok: false, why: 'no failing check is named' };
  const other = failGates.filter((g) => !gameGates.includes(g));
  if (other.length) return { ok: false, why: `${other.join(', ')} failed too` };
  const failed = new Set();
  const names = new Map();
  for (const l of String(text || '').split(/\r?\n/)) {
    let m = l.match(/^\[game-gates\] FAIL (\S+?)(?:: |$)/);
    if (m) failed.add(m[1]);
    m = l.match(/^\[game-gates\] failing tests in (\S+?): (\[.*\])\s*$/);
    if (m) { try { names.set(m[1], JSON.parse(m[2]).map(String)); } catch {} }
  }
  if (!failed.size) return { ok: false, why: 'the log names no failing game check' };
  const all = [];
  for (const id of failed) {
    const n = names.get(id);
    if (!n?.length) return { ok: false, why: `${id} failed without naming a failing test` };
    const notPin = n.filter((t) => !isPinTest(t, tests));
    if (notPin.length) return { ok: false, why: `${id} has failing tests that are not pins: ${notPin.slice(0, 3).join('; ').slice(0, 200)}` };
    all.push(...n);
  }
  return { ok: true, why: '', checks: [...failed], tests: all };
}

/** The studio gates that run the game's checks (their command runs harness/game-gates.mjs). */
function gameGateIds(root) {
  try {
    const ids = (JSON.parse(fs.readFileSync(path.join(root, 'studio', 'gates.json'), 'utf8')).gates || []).filter((g) => /game-gates\.mjs/.test(String(g.command || ''))).map((g) => g.id);
    if (ids.length) return ids;
  } catch {}
  return ['game'];
}

/** A git attributes file that gives the union files git's union merge driver (core.attributesFile for one merge). */
function unionAttributes(root, id, files) {
  const f = path.join(root, TRAIN_DIR, String(id), 'union.gitattributes');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${files.map((p) => `/${p} merge=union`).join('\n')}\n`);
  return f.split(path.sep).join('/');
}

/**
 * Reset the scratch copy to `tip` and merge the lanes in order. Returns { included, deferred, conflictMain, head, tree }.
 * A lane is merged at its checked head (never its branch name, which may move). A merge that stops (a conflict, or a
 * commit hook refusing) is aborted: the lane waits for the next train if it merges cleanly onto main alone, else it
 * conflicts with main (conflictMain) and is handed back.
 */
export function buildIntegration(sc, tip, lanes, { id, unionFiles = [] }) {
  const { dir, root } = sc;
  git(dir, 'reset', '-q', '--hard', tip);
  git(dir, 'clean', '-fdq');
  const included = [];
  const deferred = [];
  const conflictMain = [];
  const env = { ...process.env };
  for (const k of ['STUDIO_LOCK_OWNER', 'STUDIO_EXPERIMENT', 'STUDIO_AGENT_MODEL']) delete env[k];
  for (const lane of lanes) {
    const before = out(git(dir, 'rev-parse', 'HEAD'));
    const base = out(git(root, 'merge-base', tip, lane.head));
    const reasons = goldenReasons(root, base || tip, lane.head);
    const msg = [`train ${id}: land ${lane.task} (${lane.branch || String(lane.head).slice(0, 8)})`, '', ...(reasons.length ? [`Golden-Reason: carried from ${lane.task}'s own commits: ${reasons.join('; ').slice(0, 500)}`] : []), `Studio-Train: ${id} ${lane.task}`].join('\n');
    const merge = (extra, message) => spawnSync('git', [...extra, '-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local', 'merge', '--ff', '--no-edit', '-m', message, lane.head], { windowsHide: true, cwd: dir, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
    let m = merge([], msg);
    if (m.status === 0) { included.push({ ...lane, before, after: out(git(dir, 'rev-parse', 'HEAD')) }); continue; }
    const conflicted = out(git(dir, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean);
    git(dir, 'merge', '--abort');
    git(dir, 'reset', '-q', '--hard', before);
    // 2.60.0 (#2c): conflicts ONLY inside the manifest's unionFiles (one-import-per-line barrels): merge again with
    // git's union driver for those files (core.attributesFile for this one merge: both sides' added lines are kept,
    // this train's side first), and say so in the merge commit. Any other conflict is handled as before.
    if (unionFiles.length && conflicted.length && conflicted.every((f) => matchAny(f, unionFiles))) {
      const attrs = unionAttributes(root, id, unionFiles);
      m = merge(['-c', `core.attributesFile=${attrs}`], `${msg}\nUnion-Merge: ${conflicted.join(', ')} (unionFiles: both sides' added lines kept)`);
      if (m.status === 0) { included.push({ ...lane, before, after: out(git(dir, 'rev-parse', 'HEAD')), union: conflicted }); continue; }
      git(dir, 'merge', '--abort');
      git(dir, 'reset', '-q', '--hard', before);
    }
    const why = `${m.stdout || ''}${m.stderr || ''}`.trim().split('\n').filter(Boolean).slice(-4).join(' ');
    // Onto main alone? merge-tree touches no index and no files.
    const alone = git(root, 'merge-tree', '--write-tree', tip, lane.head);
    if (before !== tip && alone.status === 0) deferred.push({ ...lane, why: `it conflicts with ${included.map((l) => l.task).join(', ') || 'the lanes before it'} in this train (${why.slice(0, 200)}); it goes in the next train` });
    else conflictMain.push({ ...lane, why: alone.status === 0 ? `its merge onto main stopped: ${why.slice(0, 300)}` : `main changed files this lane changed too (${why.slice(0, 200)})` });
  }
  const head = out(git(dir, 'rev-parse', 'HEAD'));
  return { included, deferred, conflictMain, head, tree: out(git(dir, 'rev-parse', 'HEAD^{tree}')) };
}

// ---- the verify -------------------------------------------------------------------------------------

/** Every required row green, nothing partial, fast, dirty or a landing re-check. */
const recordGreen = (rec) => Boolean(rec) && !rec.partial && rec.tier !== 'fast' && rec.dirty === false && !rec.incomingOnly && Array.isArray(rec.rows) && rec.rows.length > 0 && rec.rows.every((r) => r.ok || r.required === false);

/**
 * 2.76.0 (B-85): a full record whose required rows all passed and whose "dirty" comes only from ignored, non-config files
 * the checks may read (run-gates' dirtyFrom: tracked tree clean, nothing untracked, no config-like name): the trust
 * note's words, else ''. Only the train's own just-run verify in its fresh scratch copy is judged so (never a reuse).
 */
export function ignoredOnlyDirty(rec) {
  const d = rec?.dirtyFrom;
  if (!rec || rec.dirty !== true || !d || d.tracked !== false || d.untracked !== 0 || d.config !== 0 || !(d.ignored > 0)) return '';
  if (rec.partial || rec.tier === 'fast' || rec.incomingOnly || !Array.isArray(rec.rows) || !rec.rows.length || !rec.rows.every((r) => r.ok || r.required === false)) return '';
  const shown = (rec.hidden || []).slice(0, 3).join(', ');
  return `the record counts as dirty only because of ${d.ignored} ignored file(s) the checks wrote in the train's own copy (${shown}${d.ignored > 3 ? ', …' : ''}), no tracked change, no untracked file, no config file`;
}

/**
 * May this verify record stand for the train's verify of `tree`? The same rules as task done's (merge-lane.mjs
 * judgeVerifyReuse: same tree, clean, at least as wide, engine gate, not related-only, at most 24 h old), and every
 * required row green (task done reruns the safety checks itself; a train has only this verify).
 */
export function recordCovers(rec, { root, tree, changed, all = false, whole = null }) {
  if (!recordGreen(rec)) return { ok: false, why: 'not a green full verify' };
  // 2.69.0 (p): a lane's verify is scoped to its files; a tier-B train verifies with --all. The scoped record is as wide
  // when every game check ran for those files anyway (wholeEquiv: no check skipped by its paths).
  if (all && rec.scoped) {
    const w = whole ? whole(rec.changed || []) : { ok: false };
    if (!w.ok) return { ok: false, why: `scoped, and this train needs the whole game (--all)${w.why ? `: ${w.why}` : ''}` };
    const c = recordCovers(rec, { root, tree, changed, all: false }); // still: the train's files all in its scope
    return c.ok ? { ok: true, why: `${c.why}; scoped to ${(rec.changed || []).length} file(s), but ${w.why}` } : c;
  }
  const recTree = rec.head && /^[0-9a-f]{40,64}$/.test(String(rec.head)) ? out(git(root, 'rev-parse', '--verify', '--quiet', `${rec.head}^{tree}`)) : '';
  const hadPaths = Array.isArray(rec.gatePaths) ? rec.gatePaths : rec.scoped ? rec.changed || [] : [];
  return judgeVerifyReuse(rec, { tree, recTree: recTree || null, clean: true, changed: changed?.length ? changed : null, needEngine: engineGates(changed || []).map((e) => e.project), hadEngine: engineGates(hadPaths).map((e) => e.project), relatedNow: relatedTestsOn(), maxAgeH: Number(process.env.STUDIO_DONE_REUSE_MAX_H || 24) });
}

/**
 * 2.69.0 (p): may a verify scoped to `changed` stand for an --all verify? A function (changed) -> { ok, why }, for the
 * game's manifest as main's tip has it: yes when the manifest declares checks, every one of them runs for those files
 * (none has "paths" that skip it: merge-lane.mjs selectGates). The engine gate is judged as before (judgeVerifyReuse:
 * the record must have run every engine gate the train's files need). Anything unreadable: no.
 */
export function wholeEquiv(root, tip, settings) {
  let gates = [];
  let shared = [];
  try {
    const text = settings?.manifest ? out(git(root, 'show', `${tip}:${settings.manifest}`)) : '';
    const j = text ? JSON.parse(text) : null;
    gates = (j?.gates || []).filter((x) => x && x.id && x.command).map((x) => ({ id: x.id, ...(Array.isArray(x.paths) && x.paths.length ? { paths: x.paths.map(String) } : {}) }));
    shared = Array.isArray(j?.shared) ? j.shared.map(String) : [];
  } catch { gates = []; }
  return (changed) => {
    if (!gates.length) return { ok: false, why: 'the game declares no checks to compare' };
    const sel = selectGates(gates, changed, { shared });
    if (sel.skipped.length) return { ok: false, why: `it skipped ${sel.skipped.map((x) => x.id).join(', ')} by paths` };
    return { ok: true, why: `every game check (${gates.map((x) => x.id).join(', ')}) ran for them, as --all runs them` };
  };
}

/**
 * A full, clean record whose only red required rows were already red when each of these tasks was claimed (PU-06
 * baselines, harness/baseline.mjs judgeRed). task done accepts that ("the last verify failed" names only new
 * failures), so the train does too: otherwise a red trunk would block every landing, the fix included. Every task
 * needs its own baseline; a task without one excuses nothing.
 */
export function excusedRed(rec, tasks = []) {
  if (!rec || rec.partial || rec.tier === 'fast' || rec.dirty !== false || rec.incomingOnly || !Array.isArray(rec.rows) || !rec.rows.length) return { ok: false };
  const red = rec.rows.filter((r) => r.required !== false && !r.ok);
  if (!red.length) return { ok: true, excused: [] };
  if (!tasks.length) return { ok: false };
  for (const t of tasks) {
    const { fresh } = judgeRed(rec.rows.map((r) => ({ ...r, required: r.required !== false })), readBaseline(t) || { red: [] });
    if (fresh.length) return { ok: false, task: t, fresh: fresh.map((f) => f.id) };
  }
  return { ok: true, excused: red.map((r) => r.id) };
}

/**
 * 2.71.1 (D01/T04, G15/T02): may this record be reused at all? Its run log (harness/gate-trust.mjs recordTrust) must be in
 * the .studio/ it was read from or the studio's own; a hand-written or edited record, or one from a run beside untracked
 * or ignored inputs, is not. { ok, why }.
 */
export function recordTrusted(rec, root) {
  return recordTrust(rec, [rec?._studio, path.join(root, '.studio')]);
}

/**
 * Recorded full verifies in the shared .studio/ (each agent's own, the studio's, earlier trains'). 2.69.0 (p): also the
 * verifies kept by tree (.studio/gates/trees/<tree>.json, run-gates keeps the newest 64: an agent's next verify no longer
 * hides its lane's green one) and, for a lane copy whose .studio/ is its own (not the link), the records in it.
 */
function recordedVerifies(root, { tree = null, lanes = [] } = {}) {
  const files = [];
  const seen = new Set();
  // 2.71.1: each record keeps the .studio/ it was read from (_studio), where its run log must be (recordTrusted).
  const add = (f, from = null, studio = null) => { if (seen.has(f)) return; seen.add(f); try { files.push({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...(from ? { _lane: from } : {}), _studio: studio }); } catch {} };
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const scan = (studio, from) => {
    if (tree && /^[0-9a-f]{40,64}$/.test(tree)) add(path.join(studio, 'gates', 'trees', `${tree}.json`), from, studio);
    add(path.join(studio, 'gates-last-full.json'), from, studio);
    try { for (const n of fs.readdirSync(path.join(studio, 'gates'))) if (n.endsWith('-full.json')) add(path.join(studio, 'gates', n), from, studio); } catch {}
  };
  scan(path.join(root, '.studio'), null);
  try { for (const n of fs.readdirSync(path.join(root, TRAIN_DIR, 'records'))) add(path.join(root, TRAIN_DIR, 'records', n), null, path.join(root, '.studio')); } catch {}
  const mine = real(path.join(root, '.studio'));
  for (const l of lanes) {
    const own = l?.dir ? real(path.join(l.dir, '.studio')) : null;
    if (own && own !== mine) scan(own, l.task || null);
  }
  return files;
}

/**
 * 2.69.0 (p): which of these lanes already has a green full verify of its OWN tree on main's tip (merge-tree of tip and
 * the lane's head, judged by recordCovers)? Those are "prechecked" and go first in a multi-lane train (stable: the
 * others keep their order), so the verify's prefix bisection starts from lanes known to be green. Returns the lanes,
 * each with greenTree set when it has one.
 */
export function greenFirst(root, tip, lanes, { id = '', log = () => {}, whole = null } = {}) {
  if (lanes.length < 2) return lanes;
  const marked = lanes.map((l) => {
    const m = git(root, 'merge-tree', '--write-tree', tip, l.head);
    const tree = m.status === 0 ? out(m).split('\n')[0].trim() : '';
    if (!/^[0-9a-f]{40,64}$/.test(tree)) return l;
    const changed = out(git(root, 'diff', '--name-only', tip, tree)).split('\n').filter(Boolean);
    const hit = recordedVerifies(root, { tree, lanes: [l] }).find((rec) => rec.tree === tree && recordCovers(rec, { root, tree, changed, all: Boolean(l.all), whole }).ok && recordTrusted(rec, root).ok);
    return hit ? { ...l, greenTree: tree } : l;
  });
  const first = marked.filter((l) => l.greenTree);
  if (!first.length || first.length === marked.length) return marked;
  const ordered = [...first, ...marked.filter((l) => !l.greenTree)];
  log(`[train] ${id}: prechecked first: ${first.map((l) => `${l.task} (its tree ${l.greenTree.slice(0, 8)} on main's tip has a green verify)`).join(', ')}; then ${ordered.filter((l) => !l.greenTree).map((l) => l.task).join(', ')}`);
  return ordered;
}

/** 2.78.0 (PU-54): the ids of the gates studio/gates.json marks trainOnly (they run at the train, never in a lane). */
export function trainOnlyGates(dir) {
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, 'studio', 'gates.json'), 'utf8')); return (j.gates || []).filter((g) => g && g.trainOnly === true && g.id).map((g) => String(g.id)); } catch { return []; }
}

/**
 * 2.78.2 (f): a reused verify record whose game:perf step said "not run (busy)" (run-gates marks the game gate's row
 * "perfNotRun") stood for a tree whose perf tests never ran, and the landing went without them. The train re-runs only
 * that step on the same tree: run-gates --only <the game gates> with STUDIO_GATE_FOCUS { "game:perf": <the perf globs> }
 * (game-gates skips every other check; a landing run waits STUDIO_PERF_WAIT_MIN for a quiet machine, holding new
 * verifies back). Still busy: 2.78.2 (b)'s rule for a busy focused re-check of game:perf, a busy refusal, read by
 * runGatesWaiting (it waits STUDIO_TRAIN_BUSY_WAIT_MIN, then the train defers its lanes, judging nobody). Returns null
 * (nothing to re-run), { ok: true }, { ok: false, ... } (red) or { ok: false, noCheck: true, busy }.
 */
export function perfRerun(sc, { id, tree, rec, log = () => {} }) {
  const row = (rec?.rows || []).find((r) => r && r.perfNotRun);
  if (!row) return null;
  const globs = perfTestsOf(process.env, sc.dir);
  if (!globs.length) return null;
  const root = sc.root;
  const env = { ...process.env, STUDIO_MAIN_ROOT: root, STUDIO_LOCK_OWNER: `train-${id}-perf`, STUDIO_GATE_PRIORITY: 'landing', STUDIO_VERIFY_DETACH: 'off', STUDIO_GATE_FOCUS: JSON.stringify({ 'game:perf': globs }) };
  for (const k of ['STUDIO_GATE_CHANGED', 'STUDIO_GATE_PATHS', 'STUDIO_GATE_INCOMING_FILE', 'STUDIO_VERIFY_RUN', 'npm_lifecycle_event', 'STUDIO_TASK_BASE']) delete env[k];
  const ids = gameGateIds(sc.dir);
  log(`[train] ${id}: the reused verify of tree ${tree.slice(0, 8)} did not run its perf tests (${String(row.perfNotRun).slice(0, 160)}): running game:perf (${globs.join(', ')}) alone on that tree before it counts`);
  const { r, text, busy, noCheck } = runGatesWaiting(() => spawnSync(process.execPath, [path.join(sc.dir, 'scripts', 'run-gates.mjs'), '--no-detach', '--only', ids.join(',')], { windowsHide: true, cwd: sc.dir, env: gateEnv(env), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }), { log: (m) => log(`[train] ${id}: ${m}`), label: 'the game:perf re-run' });
  for (const f of [`train-${id}-perf.json`, `train-${id}-perf-full.json`]) { try { fs.rmSync(path.join(root, '.studio', 'gates', f), { force: true }); } catch {} }
  let logRel = null;
  try { const f = path.join(root, TRAIN_DIR, `${id}-perf-${tree.slice(0, 8)}.log`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); logRel = path.relative(root, f).split(path.sep).join('/'); } catch {}
  if (r.status === 0) { log(`[train] ${id}: game:perf on tree ${tree.slice(0, 8)}: green`); return { ok: true }; }
  if (noCheck) {
    log(`[train] ${id}: game:perf on tree ${tree.slice(0, 8)} did not run (${busy || 'busy'}): the reused verify can't stand without it; busy, not red`);
    return { ok: false, noCheck: true, busy: busy || null, rec: null, gates: [], detail: [], why: `ran no check (the game:perf re-run: ${busy || 'busy'})`, log: logRel };
  }
  const fl = failLines(text);
  log(`[train] ${id}: game:perf on tree ${tree.slice(0, 8)}: red`);
  return { ok: false, rec: null, gates: fl.gates.length ? fl.gates : ids, detail: fl.detail, why: `game:perf failed on the reused verify's tree (its perf tests had not run: busy)`, log: logRel };
}

/** The FAIL lines of a verify's output, for a hand-back note: the gates, and the game checks' own lines. */
export function failLines(text) {
  const lines = String(text || '').split('\n');
  const gates = [...new Set(lines.map((l) => (l.match(/^\[gates\] FAIL (\S+)/) || [])[1]).filter(Boolean))];
  const detail = lines.filter((l) => /\bFAIL\b|Error:|failed/i.test(l) && !/^\[gates\] (FAIL|in plain words|Fix:)/.test(l)).slice(-8).map((l) => l.trim().slice(0, 240));
  return { gates, detail };
}

/**
 * Verify the scratch copy's tree once (or take a record that already covers it). Returns
 * { ok, reused?, cached?, rec, gates, detail, log }. `seen` caches the runs by tree for this train; `tasks` are the
 * lanes in it, whose claim baselines may excuse checks that were already red (excusedRed).
 */
export function verifyTree(sc, { id, n, tree, changed, all, seen, tasks = [], lanes = [], whole = null, log = () => {}, noRun = false }) {
  checkCancel(sc.root, id); // 2.77.1 (B-98)
  const judged = (raw) => {
    if (raw.ok || raw.reused || !raw.rec || raw.rec.tree !== tree || (all && raw.rec.scoped)) return raw;
    const ex = excusedRed(raw.rec, tasks);
    return ex.ok ? { ...raw, ok: true, excused: ex.excused } : raw;
  };
  if (seen.has(tree)) return { ...judged(seen.get(tree)), cached: true };
  const root = sc.root;
  let notReused = '';
  for (const rec of recordedVerifies(root, { tree, lanes })) {
    if (rec.tree !== tree) continue;
    const c0 = recordCovers(rec, { root, tree, changed, all, whole });
    const c = c0.ok ? recordTrusted(rec, root) : c0; // 2.71.1 (D01/T04): only a record run-gates wrote (its run log matches)
    if (!c.ok) notReused ||= c.why;
    if (c.ok) c.why = c0.why;
    if (c.ok) {
      // 2.78.2 (f): a noRun ask (the red budget's green prefix) runs nothing, so a record whose game:perf step did not run
      // (busy) doesn't count there.
      if (noRun && (rec.rows || []).some((r) => r && r.perfNotRun) && perfTestsOf(process.env, sc.dir).length) { notReused ||= 'its game:perf step did not run (busy), and this ask runs nothing'; continue; }
      // 2.69.0 (p): a train of ONE lane whose integration tree is the lane's verified tree reuses the lane's verify.
      const laneOf = lanes.length === 1 ? lanes[0].task : rec._lane || null;
      if (laneOf) log(`[train] ${id}: reused ${laneOf}'s green verify of tree ${tree.slice(0, 8)} (${c.why}); not run again`);
      else log(`[train] ${id}: the tree ${tree.slice(0, 8)} already has a green full verify (${c.why}); not run again`);
      // 2.78.0 (PU-54): a lane's own verify skips the train-only gates (the held-out cases), so a reused record never ran
      // them: the train runs just those here, on the same tree, before it counts the record as green.
      const tro = trainOnlyGates(sc.dir);
      if (tro.length) {
        const env = { ...process.env, STUDIO_MAIN_ROOT: root, STUDIO_GATE_PRIORITY: 'landing', STUDIO_VERIFY_DETACH: 'off' };
        for (const k of ['STUDIO_GATE_CHANGED', 'STUDIO_GATE_PATHS', 'STUDIO_GATE_FOCUS', 'STUDIO_VERIFY_RUN', 'npm_lifecycle_event']) delete env[k];
        const r = spawnSync(process.execPath, [path.join(sc.dir, 'scripts', 'run-gates.mjs'), '--no-detach', '--only', tro.join(',')], { windowsHide: true, cwd: sc.dir, env: gateEnv(env), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        const text = `${r.stdout || ''}${r.stderr || ''}`;
        log(`[train] ${id}: the train-only gate(s) ${tro.join(', ')} on tree ${tree.slice(0, 8)}: ${r.status === 0 ? 'green' : 'red'}`);
        if (r.status !== 0) {
          const fl = failLines(text);
          const red = { ok: false, rec: null, gates: fl.gates.length ? fl.gates : tro, detail: fl.detail, why: `train-only gate(s) failed: ${(fl.gates.length ? fl.gates : tro).join(', ')}`, log: null };
          seen.set(tree, red);
          return red;
        }
      }
      // 2.78.2 (f): a record whose game:perf step said "not run (busy)" never ran the perf tests on this tree: the train
      // runs that step here (alone, on a quiet machine, bounded by STUDIO_PERF_WAIT_MIN) before it counts the record.
      const perf = perfRerun(sc, { id, tree, rec, log });
      if (perf) {
        if (perf.noCheck) return perf; // still busy: the train's rule for a run that judged nothing (it defers), never cached
        if (!perf.ok) { seen.set(tree, perf); return perf; }
      }
      const res = { ok: true, reused: true, rec, gates: [], detail: [], ...(perf ? { perfRerun: true } : {}) };
      seen.set(tree, res);
      return res;
    }
  }
  if (notReused) log(`[train] ${id}: a verify of tree ${tree.slice(0, 8)} is recorded but can't stand for this one (${notReused})`);
  // 2.78.2 (b): only asking whether a green full verify of this tree exists (the red budget's green prefix): none.
  if (noRun) return { ok: false, notVerified: true, rec: null, gates: [], detail: [], why: 'no full verify of this tree has passed', log: null };
  const owner = `train-${id}`;
  const env = { ...process.env, STUDIO_MAIN_ROOT: root, STUDIO_LOCK_OWNER: owner, STUDIO_GATE_PRIORITY: 'landing', STUDIO_VERIFY_DETACH: 'off' };
  for (const k of ['STUDIO_GATE_CHANGED', 'STUDIO_GATE_PATHS', 'STUDIO_GATE_INCOMING_FILE', 'STUDIO_VERIFY_RUN', 'npm_lifecycle_event', 'STUDIO_TASK_BASE']) delete env[k];
  const t0 = Date.now();
  log(`[train] ${id}: verify ${n} of tree ${tree.slice(0, 8)} (${changed.length} changed file(s)${all ? ', --all' : ''})`);
  // 2.67.2 (B-50): a run refused before any gate ran (busy) waits and runs again, bounded; it is never read as red.
  const { r, text, busy, noCheck } = runGatesWaiting(() => spawnSync(process.execPath, [path.join(sc.dir, 'scripts', 'run-gates.mjs'), '--no-detach', ...(all ? ['--all'] : [])], { windowsHide: true, cwd: sc.dir, env: gateEnv(env), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }), { log: (m) => log(`[train] ${id}: ${m}`), label: `verify ${n}` });
  checkCancel(root, id); // 2.77.3 (H2): a run the stall watch stopped judges nothing
  const recDir = path.join(root, TRAIN_DIR, 'records');
  fs.mkdirSync(recDir, { recursive: true });
  const logFile = path.join(root, TRAIN_DIR, `${id}-verify-${n}.log`);
  try { fs.writeFileSync(logFile, text); } catch {}
  let rec = null;
  const gatesDir = path.join(root, '.studio', 'gates');
  try { rec = JSON.parse(fs.readFileSync(path.join(gatesDir, `${owner}-full.json`), 'utf8')); } catch {}
  for (const f of [`${owner}-full.json`, `${owner}.json`]) { try { fs.rmSync(path.join(gatesDir, f), { force: true }); } catch {} }
  if (rec) { rec.train = id; try { fs.writeFileSync(path.join(recDir, `${id}-${n}.json`), JSON.stringify(rec, null, 2)); } catch {} }
  // Green only when the gates passed AND the record says they tested exactly this tree, clean, in full.
  // 2.76.0 (B-85): or every gate passed on exactly this tree and the only thing that made the record "dirty" is ignored,
  // non-config files in the train's own scratch copy (made fresh from git: only this train's checks wrote them, e.g. art
  // a pretest step unpacks): a trust note, never a hand-back. A tracked change, an untracked file or a config-like name
  // still makes it not clean (2.71.1).
  const trustNote = r.status === 0 && !recordGreen(rec) && rec?.tree === tree && (!all || !rec.scoped) ? ignoredOnlyDirty(rec) : '';
  const ok = r.status === 0 && (recordGreen(rec) || Boolean(trustNote)) && rec.tree === tree && (!all || !rec.scoped);
  if (trustNote) {
    log(`[train] ${id}: verify ${n}: trust note: ${trustNote}; every gate passed on tree ${tree.slice(0, 8)}, so it counts as green (not a hand-back)`);
    emitEvent({ type: 'task.train.trust_note', agent: owner, status: 'warn', msg: `train ${id}: verify ${n} of ${tree.slice(0, 8)} green with a trust note: ${trustNote}`.slice(0, 600), meta: { train: id, tree, n, dirtyFrom: rec.dirtyFrom, hidden: (rec.hidden || []).slice(0, 10) } });
  }
  const { gates, detail } = failLines(text);
  const why = ok ? '' : noCheck ? `ran no check (${busy || `exit ${r.status} before any gate ran`})` : r.status !== 0 ? `failed: ${gates.join(', ') || `exit ${r.status}`}` : !rec ? 'wrote no verify record' : rec.tree !== tree ? `tested tree ${String(rec.tree).slice(0, 8)}, not ${tree.slice(0, 8)}` : 'its record is not a clean full verify';
  const vparts = trainVerifyParts(text, ok, [sc.dir, root]); // 2.72.0 (a)
  emitEvent({ type: 'task.train.verify', agent: owner, status: ok ? 'ok' : 'blocked', msg: `train ${id}: verify ${n} of ${tree.slice(0, 8)} ${ok ? 'green' : why} in ${Math.round((Date.now() - t0) / 1000)} s${vparts.flakes.length ? ` (timeout-flake, green for those files only: ${vparts.flakes.slice(0, 3).join(', ')})` : ''}`, meta: { train: id, tree, ok, gates, ms: Date.now() - t0, ...(vparts.subIds.length ? { subIds: vparts.subIds } : {}), ...(vparts.flakes.length ? { timeoutFlakes: vparts.flakes } : {}) } });
  if (vparts.flakes.length) log(`[train] ${id}: verify ${n}: ${vparts.flakes.length} test file(s) timed out and passed alone at low load (timeout-flake; the lane is not blamed for them): ${vparts.flakes.slice(0, 5).join(', ')}`);
  const res = { ok, rec, gates, detail, why, log: path.relative(root, logFile).split(path.sep).join('/'), ms: Date.now() - t0, ...(ok ? {} : noCheck ? { noCheck: true, busy: busy || null } : {}), ...(trustNote ? { trustNote, closeRec: { ...rec, dirty: false, trustNote } } : {}) };
  if (!res.noCheck) seen.set(tree, res); // a run that judged nothing is not cached: the next ask runs it again
  if (!ok && !res.noCheck) startRedClock(id, { why, gates, log: res.log, tests: failingTestsLine(text).list.slice(0, 5) }); // 2.78.2 (b)
  if (!ok && !res.noCheck) { res.triage = flakeTriage(sc, { id, tree, text, log }); if (!res.triage) delete res.triage; } // 2.69.0 (r); 2.77.3: its result; 2.78.0: the labels decide a load-sensitive excuse
  const j = judged(res);
  if (j.excused?.length) log(`[train] ${id}: red only in ${j.excused.join(', ')}, already red when ${tasks.join(', ')} ${tasks.length === 1 ? 'was' : 'were'} claimed: counts as green, as at task done`);
  return j;
}

/**
 * 2.69.0 (q): STUDIO_VERIFY_REMOTE=github (harness/remote-verify.mjs). The remote never stands for a safety gate: the
 * train first runs every non-game, non-engine gate locally on the tree (localGateIds: protected, secrets, hooks,
 * weakened-tests, golden, regressions, ...; run-gates --only, ~10 s). Red (and not excused by the tasks' baselines):
 * the verify is red, the remote is not asked, and the prefix search re-checks those gates. Green: the repo's CI runs
 * the named check (STUDIO_VERIFY_REMOTE_CHECK) on exactly this commit, and a green result stands for the game's checks
 * only; both parts are written to .studio/train/split/<id>-<n>.json (which gate came from where). Anything else (off,
 * busy, error, timeout, red CI) runs the full local verify, as before. A tree already verified here (or with a
 * recorded green verify) is not sent out again. deps.remoteClient: a test's fake client.
 */
async function verifyRemoteFirst(sc, o, { head, by, deps = {}, res }) {
  if (remoteMode() === 'off' || o.seen.has(o.tree) || recordedVerifies(sc.root).some((rec) => rec.tree === o.tree && recordCovers(rec, { root: sc.root, tree: o.tree, changed: o.changed, all: o.all }).ok && recordTrusted(rec, sc.root).ok)) return verifyTree(sc, o);
  const root = sc.root;
  const games = gameGateIds(root);
  let gates = [];
  try { gates = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'gates.json'), 'utf8')).gates || []; } catch {}
  const ids = localGateIds(gates, games);
  const lp = ids.length ? localSafetyGates(sc, o, ids, games) : { ok: true, rows: [], gates: [], log: null };
  if (lp.noCheck) { o.log(`[train] ${o.id}: the local safety gates ran no check (${lp.busy || 'busy'}): the full local verify runs`); return verifyTree(sc, o); }
  if (!lp.ok) {
    o.log(`[train] ${o.id}: remote verify not asked: the local safety gates are red on tree ${o.tree.slice(0, 8)} (${lp.why}); a remote result never stands for them`);
    ev('remote_verify', o.id, `not asked: the local safety gates are red (${lp.why})`, { agent: by, status: 'blocked', meta: { used: false, local: { ok: false, gates: lp.gates, log: lp.log }, tree: o.tree } });
    return { ok: false, rec: lp.rec, gates: lp.gates, detail: lp.detail, why: `local safety gates failed: ${lp.gates.join(', ') || lp.why}`, log: lp.log, ms: lp.ms, split: true };
  }
  const rv = await remoteVerify({ root, id: o.id, sha: head, client: deps.remoteClient || null, log: (m) => o.log(`[train] ${o.id}: ${m}`) });
  ev('remote_verify', o.id, `${rv.used ? (rv.ok ? 'green' : 'red') : 'not used'}: ${rv.why}`, { agent: by, status: rv.used && rv.ok ? 'ok' : 'warn', meta: { used: rv.used, ok: rv.used ? rv.ok : null, tree: o.tree, runs: rv.runs || null, local: { ok: true, gates: ids, log: lp.log } } });
  if (rv.used && rv.ok) {
    const from = { ...Object.fromEntries(lp.rows.map((r) => [r.id, `local (${r.ok ? 'pass' : 'excused by a baseline'})`])), ...Object.fromEntries(games.map((g) => [g, `remote CI: ${rv.runs.map((r) => r.name).join(', ')}`])) };
    const record = { train: o.id, n: o.n, at: new Date().toISOString(), tree: o.tree, head, from, local: { gates: ids, rows: lp.rows, log: lp.log, excused: lp.excused || [] }, remote: { check: String(remoteCheckPattern()), runs: rv.runs, why: rv.why } };
    const rel = path.join(TRAIN_DIR, 'split', `${o.id}-${o.n}.json`);
    try { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), `${JSON.stringify(record, null, 2)}\n`); } catch {}
    o.log(`[train] ${o.id}: verify of tree ${o.tree.slice(0, 8)} (commit ${String(head).slice(0, 8)}): local safety gates green (${lp.rows.map((r) => r.id).join(', ') || 'none'}), the game's checks from the repo's CI (${rv.why}); both parts in ${rel.split(path.sep).join('/')}`);
    const v = { ok: true, remote: { why: rv.why, runs: rv.runs, record: rel.split(path.sep).join('/') }, rec: null, gates: [], detail: [], why: '', ms: rv.ms };
    o.seen.set(o.tree, v);
    res.remoteVerifies = (res.remoteVerifies || 0) + 1;
    return v;
  }
  o.log(`[train] ${o.id}: remote verify ${rv.used ? `red (${rv.why}): the local verify runs to name the failing checks` : `not used (${rv.why}): the local verify runs`}`);
  return verifyTree(sc, o);
}

/** 2.69.0 (q): run-gates --only <the safety gates> on the train's tree: { ok, rec, rows, gates, detail, why, log, excused }. */
function localSafetyGates(sc, { id, n, tree, all, tasks = [], log }, ids, games) {
  const root = sc.root;
  checkCancel(root, id); // 2.77.1 (B-98)
  const owner = `train-${id}-local`;
  const env = { ...process.env, STUDIO_MAIN_ROOT: root, STUDIO_LOCK_OWNER: owner, STUDIO_GATE_PRIORITY: 'landing', STUDIO_VERIFY_DETACH: 'off' };
  for (const k of ['STUDIO_GATE_CHANGED', 'STUDIO_GATE_PATHS', 'STUDIO_GATE_INCOMING_FILE', 'STUDIO_VERIFY_RUN', 'npm_lifecycle_event', 'STUDIO_TASK_BASE', 'STUDIO_GATE_FOCUS']) delete env[k];
  const t0 = Date.now();
  log(`[train] ${id}: local safety gates of tree ${tree.slice(0, 8)} (${ids.join(', ')}); the game's checks may come from the repo's CI`);
  const { r, text, busy, noCheck } = runGatesWaiting(() => spawnSync(process.execPath, [path.join(sc.dir, 'scripts', 'run-gates.mjs'), '--no-detach', '--only', ids.join(','), ...(all ? ['--all'] : [])], { windowsHide: true, cwd: sc.dir, env: gateEnv(env), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }), { log: (m) => log(`[train] ${id}: ${m}`), label: `local safety gates ${n}` });
  const logFile = path.join(root, TRAIN_DIR, `${id}-verify-${n}-local.log`);
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, text); } catch {}
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(path.join(root, '.studio', 'gates', `${owner}.json`), 'utf8')); } catch {}
  for (const f of [`${owner}.json`, `${owner}-full.json`]) { try { fs.rmSync(path.join(root, '.studio', 'gates', f), { force: true }); } catch {} }
  const rel = path.relative(root, logFile).split(path.sep).join('/');
  if (r.status !== 0 && noCheck) return { ok: false, noCheck: true, busy: busy || null, log: rel };
  const { gates: failedLines, detail } = failLines(text);
  const rows = Array.isArray(rec?.rows) ? rec.rows : [];
  const red = rows.filter((x) => !x.ok && x.required !== false);
  let fresh = red.map((x) => x.id);
  if (red.length && tasks.length) {
    const f = new Set();
    for (const t of tasks) for (const x of judgeRed(rows.map((y) => ({ ...y, required: y.required !== false })), readBaseline(t) || { red: [] }).fresh) f.add(x.id);
    fresh = fresh.filter((g) => f.has(g));
  }
  const why = !rec ? 'wrote no record' : rec.tree !== tree ? `tested tree ${String(rec.tree).slice(0, 8)}, not ${tree.slice(0, 8)}` : rec.dirty !== false ? 'the tree was not clean' : !rows.length ? 'ran no gate' : rows.some((x) => games.includes(x.id)) ? 'a game check ran in the safety part' : fresh.length ? `failed: ${fresh.join(', ')}` : r.status !== 0 && !red.length ? `exit ${r.status}` : '';
  return { ok: !why, rec, rows, gates: fresh.length ? fresh : failedLines, detail, why, log: rel, ms: Date.now() - t0, excused: red.filter((x) => !fresh.includes(x.id)).map((x) => x.id) };
}

// ---- 2.60.0: a red train: prefix bisection and pin refresh ------------------------------------------------

/** STUDIO_TRAIN_BISECT: prefix (default) or alone (the 2.59 way). */
export const bisectMode = (env = process.env) => (/^alone$/i.test(String(env.STUDIO_TRAIN_BISECT || '')) ? 'alone' : 'prefix');
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x)) ?? 'undefined';
const short = (v) => { const t = stable(v); return t.length > 60 ? `${t.slice(0, 57)}...` : t; };
const mergeEnv = () => { const env = { ...process.env }; for (const k of ['STUDIO_LOCK_OWNER', 'STUDIO_EXPERIMENT', 'STUDIO_AGENT_MODEL']) delete env[k]; return env; };

/**
 * Re-run ONLY these studio gates on the scratch copy's tree (run-gates --only, a partial run that stands for no
 * verify), scoped as the train's verify was (the train's changed files), so the same game checks run on every
 * prefix. Cached by tree and gates. Returns { ok, gates, detail, log }.
 */
function recheckStart(sc, { id, tree, gates, changed, all, cache, log, res, label, focus = null, question = '', about = 0, eta = null, owner: ownerGiven = null, workers = null }) {
  checkCancel(sc.root, id); // 2.77.1 (B-98): a lane left this train: no further re-check
  const key = `${tree}:${gates.join(',')}${focus ? `:${JSON.stringify(focus)}` : ''}`;
  if (cache.has(key)) return { cached: cache.get(key) };
  const root = sc.root;
  const owner = ownerGiven || `train-${id}-re`;
  const env = { ...process.env, STUDIO_MAIN_ROOT: root, STUDIO_LOCK_OWNER: owner, STUDIO_GATE_PRIORITY: 'landing', STUDIO_VERIFY_DETACH: 'off' };
  for (const k of ['STUDIO_GATE_CHANGED', 'STUDIO_GATE_PATHS', 'STUDIO_GATE_INCOMING_FILE', 'STUDIO_VERIFY_RUN', 'npm_lifecycle_event', 'STUDIO_TASK_BASE']) delete env[k];
  if (!all && changed.length) { env.STUDIO_GATE_CHANGED = changed.join(','); env.STUDIO_GATE_PATHS = changed.join(','); }
  // 2.65.3 (B-43): only the failing test files of the failing game checks (harness/train-focus.mjs); run-gates passes
  // STUDIO_GATE_FOCUS on only in this --only run, which stands for no verify.
  delete env.STUDIO_GATE_FOCUS;
  if (focus) env.STUDIO_GATE_FOCUS = JSON.stringify(focus);
  // 2.69.0 (q): a parallel focused re-check claims (and runs) only the test workers its few files need.
  if (workers && !(Number(env.STUDIO_TEST_WORKERS) > 0)) env.STUDIO_TEST_WORKERS = String(workers);
  res.rechecks = (res.rechecks || 0) + 1;
  const n = res.rechecks;
  const nFiles = focus ? Object.values(focus).reduce((a, f) => a + f.length, 0) : 0;
  const what = `${gates.join(', ')}${focus ? ` (${nFiles} failing test file(s) only)` : ''} on ${label}, tree ${tree.slice(0, 8)}`;
  const line = `re-check ${n}${about ? ` of about ${Math.max(about, n)}` : ''}: ${question ? `${question} (running ${what})` : what}${eta ? `; ${eta.text}` : ''}`;
  log(`[train] ${id}: ${line}`);
  writeTrainStatus(sc.root, id, { step: 'recheck', text: line, lanes: res.trainLanes || null, round: res.round || 1, recheck: n, eta });
  ev('recheck', id, line, { meta: { n, about: about || null, question, gates, tree, focus: focus || null, eta: eta ? { ms: eta.ms, text: eta.text } : null } });
  const args = [path.join(sc.dir, 'scripts', 'run-gates.mjs'), '--no-detach', '--only', gates.join(','), ...(all ? ['--all'] : [])];
  return { job: { key, owner, env, n, args, t0: Date.now(), opts: { cwd: sc.dir, env: gateEnv(env), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 } } };
}

function recheckEnd(sc, { cache, res, tree, log = () => {} }, job, { r, text, busy, noCheck }, { triage = true } = {}) {
  const root = sc.root;
  const logFile = path.join(root, TRAIN_DIR, `${job.id}-recheck-${job.n}.log`);
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, text); } catch {}
  for (const f of [`${job.owner}.json`, `${job.owner}-full.json`]) { try { fs.rmSync(path.join(root, '.studio', 'gates', f), { force: true }); } catch {} }
  const { gates: failed, detail } = failLines(text);
  res.recheckMs = [...(res.recheckMs || []), Date.now() - job.t0];
  const c = { ok: r.status === 0, gates: failed, detail, text, log: path.relative(root, logFile).split(path.sep).join('/'), ...(r.status !== 0 && noCheck ? { noCheck: true, busy: busy || null } : {}) };
  if (!c.noCheck) cache.set(job.key, c);
  // 2.69.0 (r): the parallel search triages after all its prefixes finish (one at a time, so a low-load run is low load).
  if (triage && !c.ok && !c.noCheck) flakeTriage(sc, { id: job.id, tree, text, log }); // 2.69.0 (r)
  return c;
}

function recheck(sc, o) {
  checkRedBudget(o.id); // 2.78.2 (b)
  const s = recheckStart(sc, o);
  if (s.cached) return s.cached;
  const job = { ...s.job, id: o.id };
  const w = runGatesWaiting(() => spawnSync(process.execPath, job.args, { windowsHide: true, ...job.opts }), { log: (m) => o.log(`[train] ${o.id}: ${m}`), label: `re-check ${job.n}` });
  checkCancel(sc.root, o.id); // 2.77.3 (H2)
  return recheckEnd(sc, o, job, w);
}

/** 2.69.0 (q): recheck, run asynchronously (several prefixes at once, each in its own scratch copy). */
async function recheckAsync(sc, o) {
  const s = recheckStart(sc, o);
  if (s.cached) return s.cached;
  const job = { ...s.job, id: o.id };
  const w = await runGatesWaitingAsync(() => spawnCollect(process.execPath, job.args, { cwd: job.opts.cwd, env: job.opts.env }), { log: (m) => o.log(`[train] ${o.id}: ${m}`), label: `re-check ${job.n}` });
  checkCancel(sc.root, o.id); // 2.77.3 (H2)
  return recheckEnd(sc, o, job, w, { triage: false });
}

// ---- 2.72.0 (a): sub-ids and timeout-flakes from a verify's log -----------------------------------------------------

/** { subIds (when red), flakes (files a timeout-only red re-ran green alone) } from a run-gates log. Never throws. */
export function trainVerifyParts(text, ok, roots = []) {
  let subIds = [];
  let flakes = [];
  try { if (!ok) subIds = subIdsFromLog(text, { roots }); } catch {}
  try { flakes = [...new Set(Object.values(timeoutFlakesFromLog(text)).flat())]; } catch {}
  return { subIds, flakes };
}

// ---- 2.69.0 (r): the flake triager (harness/flakes.mjs) ------------------------------------------------------------

const flakeSeen = new Map();
/**
 * After a red verify or re-check: each failing test file runs ALONE on this same tree (run-gates --only the game's
 * gates, STUDIO_GATE_FOCUS, as a 2.65.3 re-check; the second, low-load run with STUDIO_TEST_WORKERS=1), at most once
 * per train, and is labelled real / seed-flake / load-flake / intermittent in .studio/flakes.jsonl. Labels only: what
 * the train does next is decided as before. Never throws (but a stall or a lane leaving still stops the train).
 * 2.77.3 (H2, B-112): each run says so in the train's status ("flake check k of n: <file> alone"), waits at most
 * STUDIO_FLAKE_WAIT_MIN (10) for a machine:heavy slot (its STUDIO_HEAVY_WAIT_MIN), and a run refused as busy or stopped
 * before any gate is "not run" (no label), never "real"; the triage ends at the first real label (harness/flakes.mjs).
 * 2.77.3 (C2): a red whose every failing file is a port collision is not the lanes' (trainBody defers them).
 */
export function flakeTriage(sc, { id, tree, text, log }) {
  if (!triageOn()) return null;
  try {
    const root = sc.root;
    const gates = gameGateIds(root);
    if (!gates.length) return null;
    const base = String(id).replace(/-\d+$/, '');
    if (!flakeSeen.has(base)) flakeSeen.set(base, new Set());
    let n = 0;
    const waitMin = flakeRules().waitMin;
    const runOne = ({ check, file, files = null, lowLoad, quiet = false, quietWaitMin = 10, k = 1, of = 1, trusted = false }) => {
      checkCancel(root, id); // 2.77.1 (B-98); 2.77.3: rethrown below, so the train stops here
      checkRedBudget(id); // 2.78.2 (b): the red chain's time cap (STUDIO_TRAIN_RED_BUDGET_MIN)
      // 2.78.2 (b): several failing files of one check in one run (harness/flakes.mjs labelGroup).
      const list = Array.isArray(files) && files.length ? files : [file];
      const what = list.length > 1 ? `${list.length} failing files of ${check} together (${list.slice(0, 3).join(', ')}${list.length > 3 ? ', …' : ''})` : list[0];
      // 2.78.0 (PU-56): the confirming re-run of a red alone waits for a quiet machine (no other heavy job), bounded.
      // It is an alone-run like the others: it shows in the status ("flake check k of n") while it waits and runs.
      if (quiet) {
        // 2.78.2 (b): never past the red budget: the wait is cut to what is left of it.
        const leftMin = redLeftMin(id);
        const waitFor = Math.max(0, Math.min(quietWaitMin, leftMin));
        const shown = waitFor < quietWaitMin ? Math.round(waitFor * 10) / 10 : quietWaitMin;
        const wl = `flake check ${k} of ${of}: ${what} failed alone; waiting up to ${shown} min for a quiet machine (STUDIO_FLAKE_QUIET_WAIT_MIN${waitFor < quietWaitMin ? ', cut to the red budget left, STUDIO_TRAIN_RED_BUDGET_MIN' : ''}) to run ${list.length > 1 ? 'them' : 'it'} again at low load, on tree ${String(tree).slice(0, 8)}`;
        writeTrainStatus(root, id, { step: 'flake-check', text: wl, eta: null });
        log(`[train] ${id}: ${wl}`);
        const q = waitQuiet(root, { waitMin: waitFor, log: (m) => log(`[train] ${id}: ${m}`) });
        checkCancel(root, id);
        if (!q.quiet) { checkRedBudget(id); log(`[train] ${id}: no quiet machine within ${shown} min (${q.busy.slice(0, 2).join('; ')}): ${what} stay${list.length > 1 ? '' : 's'} real, unconfirmed under load`); return { ok: false, quietUnreached: true }; }
      }
      n += 1;
      const owner = `train-${id}-flake`;
      const env = { ...process.env, STUDIO_MAIN_ROOT: root, STUDIO_LOCK_OWNER: owner, STUDIO_GATE_PRIORITY: 'landing', STUDIO_VERIFY_DETACH: 'off', STUDIO_GATE_FOCUS: JSON.stringify({ [check]: list }) };
      for (const x of ['STUDIO_GATE_CHANGED', 'STUDIO_GATE_PATHS', 'STUDIO_GATE_INCOMING_FILE', 'STUDIO_VERIFY_RUN', 'npm_lifecycle_event', 'STUDIO_TASK_BASE']) delete env[x];
      if (lowLoad) env.STUDIO_TEST_WORKERS = '1';
      env.STUDIO_TIMEOUT_RERUN = 'off'; // 2.72.0 (a): the triager wants the raw answer, not the gate's own timeout re-run
      // 2.77.3 (H2): a focused run waits at most STUDIO_FLAKE_WAIT_MIN for a machine:heavy slot, then is "not run".
      const hw = Number(process.env.STUDIO_HEAVY_WAIT_MIN);
      env.STUDIO_HEAVY_WAIT_MIN = String(Math.min(Number.isFinite(hw) && String(process.env.STUDIO_HEAVY_WAIT_MIN ?? '').trim() !== '' ? hw : 60, waitMin));
      const line = `flake check ${k} of ${of}: ${quiet ? `${what} again, on a quiet machine at low load (one test worker; it failed alone)` : trusted ? `${what} again, alone at low load (one test worker; it failed alone; a trusted load-sensitive file: no quiet wait, STUDIO_LOAD_SENSITIVE_TRUST)` : `${what} alone${lowLoad ? ' at low load (one test worker)' : ''}`}, on tree ${String(tree).slice(0, 8)} (the verify was red; up to ${waitMin} min for a slot, STUDIO_FLAKE_WAIT_MIN)`;
      writeTrainStatus(root, id, { step: 'flake-check', text: line, eta: null });
      log(`[train] ${id}: ${line}`);
      const r = spawnSync(process.execPath, [path.join(sc.dir, 'scripts', 'run-gates.mjs'), '--no-detach', '--only', gates.join(',')], { windowsHide: true, cwd: sc.dir, env: gateEnv(env), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      const out2 = `${r.stdout || ''}${r.stderr || ''}`;
      try { fs.mkdirSync(path.join(root, TRAIN_DIR), { recursive: true }); fs.writeFileSync(path.join(root, TRAIN_DIR, `${id}-flake-${n}.log`), out2); } catch {}
      for (const f of [`${owner}.json`, `${owner}-full.json`]) { try { fs.rmSync(path.join(root, '.studio', 'gates', f), { force: true }); } catch {} }
      checkCancel(root, id); // 2.77.3 (H2): stopped by the stall watch: judge nothing
      const busy = r.status !== 0 ? busyWhy(out2) : '';
      if (r.status !== 0 && (busy || ranNoCheck(out2))) return { ok: false, notRun: busy || `it stopped before any gate ran (${r.status === null ? `signal ${r.signal || '?'}` : `exit ${r.status}`})`, text: out2 };
      return { ok: r.status === 0, text: out2 };
    };
    // 2.78.0 (C2c): the quiet re-run holds new non-landing heavy work (builder and lane verifies) back from the start of
    // its quiet wait to the end of its run (harness/heavy.mjs markQuietHold), bounded by STUDIO_FLAKE_HOLD_MIN; released
    // however the run ends (a cancel included); a train that dies leaves a marker heavy.mjs ignores (its process is gone).
    const runAlone = (a) => {
      if (!a.quiet) return runOne(a);
      const holdMin = flakeHoldMin();
      const names = Array.isArray(a.files) && a.files.length ? a.files.join(', ') : a.file;
      const held = markQuietHold(root, { ms: holdMin * 60000, owner: `train-${id}-flake`, train: id, file: names, why: `the quiet re-run of ${names}` });
      if (held) log(`[train] ${id}: holding new builder and lane verifies back while ${names} ${Array.isArray(a.files) && a.files.length > 1 ? 'are' : 'is'} re-run on a quiet machine (at most ${Math.round(holdMin * 10) / 10} min, STUDIO_FLAKE_HOLD_MIN; running ones are not stopped)`);
      try { return runOne(a); } finally { if (held) clearQuietHold(root); }
    };
    return triageRed({ root, dir: sc.dir, text, train: id, tree, runAlone, seen: flakeSeen.get(base), log: (m) => log(`[train] ${id}: ${m}`), together: true });
  } catch (e) { if (e instanceof TrainCancelled) throw e; log(`[train] ${id}: flake triage skipped (${e.message})`); return null; }
}

/** Run the pins' report on the scratch copy's tree: { report } ({ pin: value }) or { error }. Cached by tree. */
function pinReport(sc, pins, { id, k, tree, cache, log }) {
  if (cache.has(tree)) return cache.get(tree);
  const f = path.join(sc.root, TRAIN_DIR, String(id), `pins-report-${k}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  try { fs.rmSync(f, { force: true }); } catch {}
  const cmd = pins.report.split('{out}').join(`"${f}"`);
  const env = /^(off|0|false|no)$/i.test(process.env.STUDIO_GAME_GATE_CI || '') ? process.env : { ...process.env, CI: 'true' };
  const r = withGateSlot(sc.root, `train-${id}-pins`, () => spawnSync(cmd, { windowsHide: true, cwd: sc.dir, shell: true, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, timeout: Number(process.env.STUDIO_GAME_GATE_TIMEOUT_MS || 600000) }), { log });
  let rep = null;
  try { rep = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const res = r.status === 0 && rep && typeof rep === 'object' && !Array.isArray(rep) ? { report: rep, file: f } : { error: `the pins' report ${r.status !== 0 ? `exited ${r.status}` : 'wrote no JSON object'} on tree ${tree.slice(0, 8)}: ${`${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-2).join(' ').slice(0, 200)}` };
  cache.set(tree, res);
  return res;
}

/**
 * What a red train does next (all code, no judgement): { kind } is
 *   redMain      the failing checks fail on main itself: nobody is handed back
 *   refreshed    pins only, every move declared: the scratch copy holds main + lanes + one pin-refresh commit
 *                ({ built, info }), to be verified in full before main moves
 *   pinBlocked   pins only, but a move is undeclared or an invariant: { blocked: [{ lane, why }] }
 *   culprit      the first red prefix: { lane, why }
 *   flaky        the failing checks pass when run again on the train's own tree: nobody is handed back
 *   alone        no failing check is named (or a prefix doesn't build): the 2.59 way decides
 */
async function redPlan(ctx, { pins: tryPins = true, bisect = true } = {}) {
  const { sc, tip, set, built, v, id, log, res, settings, all, cache, main } = ctx;
  const unionFiles = settings.unionFiles || [];
  const changed = changedVs(sc.dir, tip, built.head);
  const rows = v.rec && v.rec.tree === built.tree && Array.isArray(v.rec.rows) ? v.rec.rows : null;
  let failGates = rows ? rows.filter((r) => !r.ok && r.required !== false).map((r) => r.id) : [...(v.gates || [])];
  // A check already red when a task was claimed (its baseline) is not this train's: only the fresh ones are re-run.
  if (rows) {
    const fresh = new Set();
    for (const l of set) for (const f of judgeRed(rows.map((r) => ({ ...r, required: r.required !== false })), readBaseline(l.task) || { red: [] }).fresh) fresh.add(f.id);
    failGates = failGates.filter((g) => fresh.has(g));
  }
  if (!failGates.length) return { kind: 'alone', why: 'the red verify names no failing check' };
  const label = (k) => (k ? `${main} + ${set.slice(0, k).map((l) => l.task).join(' + ')}` : main);
  const prefix = (k) => { const b = buildIntegration(sc, tip, set.slice(0, k), { id, unionFiles }); return b.included.length === k ? b : null; };
  // 2.65.3 (B-43): focused re-checks (only the failing test files) and each re-check's question and ETA, in words.
  let fx = focusPlan(ctx, failGates);
  const n = set.length;
  // 2.69.0 (q): K prefixes per round (harness/train-parallel.mjs): as many focused re-checks as fit the machine now.
  const nFx = fx ? Object.values(fx).reduce((a, f) => a + f.length, 0) : 0;
  const width = bisect && n > 2 ? await bisectWidth({ root: sc.root, nFiles: nFx }) : { k: 1, why: '' };
  const K = Math.min(width.k, Math.max(1, n - 1));
  // Re-checks (serial) or rounds (parallel: one round takes about one re-check's time) left, for the ETA.
  const left = (lo, hi, sawRed = true) => (K > 1 ? karyCost(hi - lo, K).rounds + (sawRed ? 0 : 1) : stepsLeft(lo, hi, sawRed));
  const about = (res.rechecks || 0) + 1 + (K > 1 ? karyCost(n, K).probes : stepsLeft(0, n));
  const ask = recheckWords(ctx, n);
  const check = (k, q = {}) => { const b = prefix(k); if (!b) return null; return { ...recheck(sc, { id, tree: b.tree, gates: failGates, changed, all, cache: cache.checks, log, res, label: label(k), focus: fx, question: q.question || '', about, eta: ctx.eta ? ctx.eta(q.left ?? 0) : null }), b }; };
  const steps = [];
  const c0 = check(0, { question: ask.main(), left: 1 + left(0, n) });
  if (!c0) return { kind: 'alone', why: `${main} alone doesn't build` };
  if (c0.noCheck) return noCheckPlan(c0, main);
  steps.push({ prefix: [], ok: c0.ok });
  const pinsOnly = settings.pins && tryPins ? pinsOnlyRed(v.rec?.tree === built.tree ? ctx.text : '', { failGates, gameGates: gameGateIds(sc.root), tests: settings.pins.tests }) : { ok: false, why: settings.pins ? 'pins already tried' : 'the game declares no pins' };
  if (!c0.ok) return { kind: 'redMain', gates: failGates, log: c0.log, why: pinsOnly.ok ? `the pinned checks (${pinsOnly.tests.slice(0, 5).join('; ')}) fail on ${main} itself: no lane in this train moved them, a regression on ${main}` : `${failGates.join(', ')} fail on ${main} itself` };
  if (settings.pins && tryPins) {
    if (!pinsOnly.ok) log(`[train] ${id}: not a pins-only red (${pinsOnly.why})`);
    else {
      const p = pinPlan(ctx, { prefix, label, pinsOnly });
      if (p.kind !== 'none') return p;
      log(`[train] ${id}: no pin refresh (${p.why}); bisecting`);
    }
  }
  if (!bisect) return { kind: 'alone', why: 'one lane' };
  // Binary search for the first red prefix: lo is green (main), hi is red (the whole train).
  let lo = 0;
  let hi = set.length;
  let red = null;
  // 2.69.0 (q): K > 1: a scratch copy per extra prefix of a round (removed when the plan is made).
  const copies = [sc];
  for (let j = 1; j < K; j += 1) {
    const c = makeScratch(sc.root, `${id}-p${j + 1}`, tip);
    if (c.error) { log(`[train] ${id}: a scratch copy for a parallel re-check could not be made (${c.error}): ${copies.length} at once`); break; }
    copies.push(c);
  }
  const k = copies.length;
  if (k > 1) {
    res.bisectWidth = k;
    log(`[train] ${id}: the prefix search checks up to ${k} prefixes at once: ${width.why}`);
  }
  const probe = async (pts, round, { lo: a, hi: z, sawRed }) => {
    checkRedBudget(id); // 2.78.2 (b): before the round, never inside it (its re-checks start together)
    const line = `bisect round ${round}: checking prefix${pts.length === 1 ? '' : 'es'} ${pts.join(', ')} at once (lanes 1-${n}; ${a ? `green through lane ${a}` : `${main} green`}, red at ${z}${sawRed ? '' : ' (the verify)'})${ctx.eta ? `; ${ctx.eta(left(a, z, sawRed)).text}` : ''}`;
    log(`[train] ${id}: ${line}`);
    writeTrainStatus(sc.root, id, { step: 'recheck', text: line, lanes: res.trainLanes || null, round: res.round || 1, eta: ctx.eta ? ctx.eta(left(a, z, sawRed)) : null });
    ev('bisect_round', id, line, { meta: { round, prefixes: pts, lo: a, hi: z, width: k } });
    const built = pts.map((p, j) => { const b = buildIntegration(copies[j], tip, set.slice(0, p), { id, unionFiles }); return b.included.length === p ? b : null; });
    const bad = built.findIndex((b) => !b);
    if (bad >= 0) return pts.map(() => ({ stop: { kind: 'alone', why: `${label(pts[bad])} doesn't build` } }));
    const rs = await Promise.all(pts.map((p, j) => recheckAsync(copies[j], { id, tree: built[j].tree, gates: failGates, changed, all, cache: cache.checks, log, res, label: label(p), focus: fx, question: ask.mid(a, z, p, sawRed), about, eta: ctx.eta ? ctx.eta(left(a, z, sawRed)) : null, owner: j ? `train-${id}-re${j + 1}` : null, workers: fx ? focusWorkers(nFx) : null })));
    for (let j = 0; j < rs.length; j += 1) if (!rs[j].ok && !rs[j].noCheck && !rs[j].triaged) { rs[j].triaged = true; flakeTriage(copies[j], { id, tree: built[j].tree, text: rs[j].text, log }); } // 2.69.0 (r), one at a time
    return rs.map((c, j) => (c.noCheck ? { stop: noCheckPlan(c, label(pts[j])) } : { ...c, b: built[j] }));
  };
  try {
  for (;;) {
    lo = 0; hi = set.length; red = null;
    if (k > 1) {
      const r = await karySearch({ lo, hi, k, probe });
      for (const st of r.steps) steps.push({ prefix: set.slice(0, st.k).map((l) => l.task), ok: st.ok, parallel: true });
      if (r.stop) return r.stop;
      ({ lo, hi, red } = r);
      res.bisectRounds = (res.bisectRounds || 0) + r.rounds;
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const c = check(mid, { question: ask.mid(lo, hi, mid, Boolean(red)), left: stepsLeft(lo, hi, Boolean(red)) });
      if (!c) return { kind: 'alone', why: `${label(mid)} doesn't build` };
      if (c.noCheck) return noCheckPlan(c, label(mid));
      steps.push({ prefix: set.slice(0, mid).map((l) => l.task), ok: c.ok });
      res.bisectRounds = (res.bisectRounds || 0) + 1;
      if (c.ok) lo = mid; else { hi = mid; red = c; }
    }
    if (red) break;
    // Only the full verify said the whole train is red: confirm it before anyone is handed back.
    const c = check(hi, { question: ask.confirm(lo, hi), left: 1 });
    if (!c) return { kind: 'alone', why: `${label(hi)} doesn't build` };
    if (c.noCheck) return noCheckPlan(c, label(hi));
    steps.push({ prefix: set.slice(0, hi).map((l) => l.task), ok: c.ok });
    if (!c.ok) { red = c; break; }
    // 2.65.3 (B-43): the failing test files pass when run on their own on the very tree the verify failed: they fail
    // only together with other tests, so a focused re-check can't see the break (and would call it flaky). Search
    // again with the whole failing gate(s), as in 2.65.2; main's re-check is redone the same way first.
    if (fx) {
      log(`[train] ${id}: the failing test files pass when run on their own on the train's tree (they fail only together with other tests): searching again with the whole failing gate(s) (${failGates.join(', ')})`);
      fx = null;
      const w0 = check(0, { question: `${ask.main()} (the whole failing gate(s) this time)`, left: 1 + left(0, n) });
      if (!w0) return { kind: 'alone', why: `${main} alone doesn't build` };
      if (w0.noCheck) return noCheckPlan(w0, main);
      steps.push({ prefix: [], ok: w0.ok, whole: true });
      if (!w0.ok) return { kind: 'redMain', gates: failGates, log: w0.log, why: `${failGates.join(', ')} fail on ${main} itself` };
      continue;
    }
    return { kind: 'flaky', steps, why: `${failGates.join(', ')} failed in the train's verify but passed when run again on the same tree` };
  }
  } finally {
    for (const c of copies.slice(1)) removeScratch(c);
  }
  const lane = set[hi - 1];
  const before = set.slice(0, hi - 1).map((l) => l.task);
  const what = `${failGates.join(', ')}${red.gates.length && red.gates.join(',') !== failGates.join(',') ? ` (${red.gates.join(', ')})` : ''}`;
  const why = before.length
    ? `the checks ${what} pass on ${main} + ${before.join(' + ')} (the lanes before it in this train) and fail once this lane is added (${label(hi)}): it breaks them, alone or only together with those lanes`
    : `the checks ${what} pass on ${main} and fail on ${main} + this lane`;
  return { kind: 'culprit', lane, steps, why: `${why}${red.detail.length ? `:\n${red.detail.join('\n')}` : ''}\nLog: ${red.log}. ${before.length ? `Once ${before.join(', ')} land${before.length === 1 ? 's' : ''}, merge ${main} into your copy (git merge ${main}), fix it there` : 'Fix it in your copy'}, commit, run npm run verify, then task done again` };
}

/** 2.67.2 (B-50): a re-check that ran no check (refused as busy, or stopped before any gate) judges nothing. */
const noCheckPlan = (c, label) => ({ kind: 'noCheck', busy: c.busy || null, log: c.log, why: `the re-check on ${label} ran no check (${c.busy || 'it stopped before any gate ran'}; log ${c.log || '-'})` });

/**
 * 2.67.2 (B-50): a verify or re-check that ran no check: the lanes wait in the queue for the next train; nothing is
 * judged (no hand-back, never "main itself is red").
 */
function deferNoCheck(res, set, defer, { id, log, by, what }) {
  const why = `${what}: busy, not red. nothing landed, nobody was handed back and main was not judged; the lanes wait for the next train`;
  res.ok = false;
  res.noCheck = { why: what };
  log(`[train] ${id}: ${why}`);
  ev('no_check', id, `${set.map((l) => l.task).join(', ')}: ${why}`.slice(0, 600), { agent: by, to: 'producer', status: 'warn', meta: { lanes: set.map((l) => l.task) } });
  for (const l of set) defer(l, `${what} (busy, not red)`);
}

/**
 * 2.78.1 (B-116): a red re-check of main whose copy ran another harness than the studio has now (an update merged
 * while the train ran), or whose own process did: the check didn't judge main, so it is "not run (harness changed
 * underneath)" and main is not blamed (no red-main verdict, no known-red listing, nobody handed back): the lanes wait
 * for the next train, a fresh process. True when that was the case (the lanes are deferred here).
 * STUDIO_TRAIN_HARNESS_GUARD=off: never (harness/harness-version.mjs copyHarnessDrift).
 */
function harnessUnderneath(ctx, logRel) {
  const { sc, tip, set, id, log, res, by, defer, root } = ctx;
  let text = '';
  for (const base of [sc?.dir, root].filter(Boolean)) { try { text = fs.readFileSync(path.resolve(base, String(logRel || '')), 'utf8'); break; } catch {} }
  const d = copyHarnessDrift({ mainDir: root, copyRev: tip, logText: text.slice(-200000) });
  if (!d.changed) return false;
  const what = `not run (harness changed underneath): ${d.why}`;
  res.ok = false;
  res.noCheck = { why: what, harness: true };
  const line = `${id}: the re-check on ${mainBranch(root)} is ${what}. ${mainBranch(root)} is not judged, nothing landed and nobody was handed back; ${set.map((l) => l.task).join(', ')} wait for the next train (a fresh process)`;
  log(`[train] ${line}`);
  ev('no_check', id, line.replace(/^[^:]+: /, '').slice(0, 600), { agent: by, to: 'producer', status: 'warn', meta: { lanes: set.map((l) => l.task), harness: true, log: logRel || null } });
  for (const l of set) defer(l, what);
  return true;
}

/**
 * 2.65.3 (B-43): the STUDIO_GATE_FOCUS map for this red train's re-checks (harness/train-focus.mjs trainFocus): the
 * failing game checks and their failing test files, read from the verify log; null (the whole gate, as before) when
 * no failing game gate is among the failing checks or no failing test file is named. The log says which, and why.
 */
function focusPlan(ctx, failGates) {
  const { sc, text, id, log } = ctx;
  const games = gameGateIds(sc.root);
  if (!failGates.some((g) => games.includes(g))) return null;
  const f = trainFocus(text);
  if (!f.focus) { log(`[train] ${id}: re-checks run the whole failing gate(s) (${failGates.join(', ')}): ${f.why}`); return null; }
  const said = Object.entries(f.focus).map(([k, v]) => `${k}: ${v.length ? `${v.slice(0, 4).join(', ')}${v.length > 4 ? ` +${v.length - 4} more` : ''}` : 'the whole check (no failing file named)'}`);
  log(`[train] ${id}: re-checks run only the failing test files (${said.join('; ')}); checks that passed in the verify are skipped. A re-check stands for no verify: landing still needs a full verify of the exact tree`);
  return f.focus;
}

/** 2.65.3 (B-43): what each re-check of a bisection over this round's n lanes decides, in plain words. */
function recheckWords(ctx, n) {
  const { set, main, res } = ctx;
  const lanes = `lanes 1-${n}${res.roundWithout?.length ? ` (round ${res.round}: without ${res.roundWithout.join(', ')})` : ''}`;
  const at = (k) => `lane ${k} (${set[k - 1].task})`;
  const range = (a, b) => (a === b ? at(a) : `lanes ${a}-${b}`);
  const green = (lo) => (lo ? `green through ${at(lo)}` : `${main} green`);
  return {
    main: () => `${lanes} red in the verify; is ${main} itself red?`,
    mid: (lo, hi, mid, sawRed) => `${lanes}; ${green(lo)}, red at ${hi}${sawRed ? '' : ' (the verify)'}; is the break in ${range(lo + 1, mid)}?`,
    confirm: (lo, hi) => `${lanes}; ${green(lo)}, and only the verify said ${range(1, hi)} is red; is it still red when run again?`,
  };
}

/** STUDIO_TRAIN_LAND_PREFIX (2.65.3, default on): once a culprit is named, verify and land the green prefix before it. */
export const landPrefixOn = (env = process.env) => !/^(off|0|false|no)$/i.test(String(env.STUDIO_TRAIN_LAND_PREFIX || '').trim());
/** 2.78.1 (d): a lane that gained only merges of main after its check closes as landed (STUDIO_TRAIN_CLOSE_MAIN_MERGES, default on). */
export const closeMainMergesOn = (env = process.env) => !/^(off|0|false|no)$/i.test(String(env.STUDIO_TRAIN_CLOSE_MAIN_MERGES || '').trim());
/** 2.78.1 (d): a tier-A lane whose tip changes no file against main lands without a verify (STUDIO_TRAIN_EMPTY_DIFF, default on). */
export const emptyDiffOn = (env = process.env) => !/^(off|0|false|no)$/i.test(String(env.STUDIO_TRAIN_EMPTY_DIFF || '').trim());

/**
 * 2.65.3 (B-43, c): the culprit at 0-based index k > 0 was handed back. Verify main + the lanes before it in full; green:
 * land them now (landTrain, the same compare-and-swap) and defer the lanes after the culprit to the next train, on top
 * of them. Returns { landed: true } | { landed: false, stop?: true } (stop: landing failed for another reason than a
 * moved main; res says why). Only when every lane after the culprit is in the queue (it is picked up again from there).
 */
function landPrefixEarly(ctx, k) {
  const { sc, tip, set, id, log, res, seen, by, deps, main, root, unionFiles, defer } = ctx;
  const culprit = set[k];
  const pre = set.slice(0, k);
  const after = set.slice(k + 1);
  const names = pre.map((l) => l.task).join(', ');
  checkRedBudget(id); // 2.78.2 (b)
  const notQueued = after.filter((l) => !l.fromQueue);
  if (notQueued.length) { log(`[train] ${id}: the green prefix (${names}) is not landed early: ${notQueued.map((l) => l.task).join(', ')} after ${culprit.task} is not in the train queue to be picked up again`); return { landed: false }; }
  const b = buildIntegration(sc, tip, pre, { id, unionFiles });
  if (b.included.length !== pre.length) { log(`[train] ${id}: the green prefix (${names}) no longer builds alone; carrying on as before`); return { landed: false }; }
  const line = `${k === 1 ? 'lane 1' : `lanes 1-${k}`} (${names}) passed the re-checks before ${culprit.task}: verifying ${main} + them in full to land them now${after.length ? `; ${after.map((l) => l.task).join(', ')} after it go${after.length === 1 ? 'es' : ''} in the next train` : ''}`;
  log(`[train] ${id}: ${line}`);
  writeTrainStatus(root, id, { step: 'prefix', text: line, lanes: res.trainLanes || null, round: res.round || 1, eta: ctx.eta ? ctx.eta(0) : null });
  const v = verifyTree(sc, { id, n: res.verifies + 1, tree: b.tree, changed: changedVs(sc.dir, tip, b.head), all: pre.some((l) => l.all), seen, tasks: pre.map((l) => l.task), log });
  if (!v.cached && !v.reused) { res.verifies += 1; if (v.ms) res.lastVerifyMs = v.ms; }
  if (v.reused) res.reused += 1;
  if (!v.ok) {
    log(`[train] ${id}: the full verify of the prefix ${names} is red (${v.why || v.gates.join(', ')}); carrying on as before`);
    ev('prefix_red', id, `the green prefix ${names} before ${culprit.task} is red in a full verify (${v.why || v.gates.join(', ')}); not landed early`, { agent: by, status: 'warn', meta: { lanes: pre.map((l) => l.task), culprit: culprit.task, gates: v.gates } });
    return { landed: false };
  }
  const before = res.landed.length;
  const r = landTrain(root, sc, main, tip, { built: b, v }, { id, by, deps, log, res, unionFiles });
  if (r === 'moved') return { landed: false };
  if (res.landed.length === before) return { landed: false, stop: true };
  ev('prefix_landed', id, `the green prefix ${names} (before the culprit ${culprit.task}) landed early on a full verify${after.length ? `; ${after.map((l) => l.task).join(', ')} wait for the next train, on top of it` : ''}`, { agent: by, status: 'ok', meta: { lanes: pre.map((l) => l.task), culprit: culprit.task, after: after.map((l) => l.task) } });
  for (const l of after) defer(l, `${culprit.task} before it was handed back and the lanes before that (${names}) landed early as a green prefix; it goes in the next train, on top of them`);
  if (after.length) { res.more = true; res.prefixMore = true; }
  return { landed: true };
}

/**
 * The pins: the report on every prefix, each moved value attributed to the lane whose step moved it, checked
 * against the lanes' Pin-Moves and the invariants; all good: the refresh on the combined tree and one commit.
 */
function pinPlan(ctx, { prefix, label, pinsOnly }) {
  const { sc, tip, set, id, log, settings, cache, root, main } = ctx;
  const pins = settings.pins;
  const reports = [];
  for (let k = 0; k <= set.length; k += 1) {
    const b = prefix(k);
    if (!b) return { kind: 'none', why: `${label(k)} doesn't build` };
    const r = pinReport(sc, pins, { id, k, tree: b.tree, cache: cache.reports, log });
    if (r.error) return { kind: 'none', why: r.error };
    reports.push(r);
  }
  const R = reports.map((r) => r.report);
  const keys = [...new Set(R.flatMap((r) => Object.keys(r)))].sort();
  const moved = keys.filter((p) => stable(R[0][p]) !== stable(R[set.length][p]));
  const declared = new Map(set.map((l) => [l.task, pinMoves(root, out(git(root, 'merge-base', tip, l.head)) || tip, l.head)]));
  const movedBy = {};
  for (const p of moved) {
    movedBy[p] = { from: R[0][p] ?? null, to: R[set.length][p] ?? null, by: [] };
    for (let k = 1; k <= set.length; k += 1) if (stable(R[k][p]) !== stable(R[k - 1][p]) && !movedBy[p].by.includes(set[k - 1].task)) movedBy[p].by.push(set[k - 1].task);
  }
  const blocked = new Map();
  const block = (task, why) => blocked.set(task, [...(blocked.get(task) || []), why]);
  for (const p of moved) {
    for (const t of movedBy[p].by) {
      if (pinNameMatches(p, pins.invariants)) block(t, `it moves ${p} (${short(R[0][p])} -> ${short(R[set.length][p])} in this train), an invariant pin (pins.invariants): never refreshed by the train`);
      else if (!pinNameMatches(p, declared.get(t) || [])) block(t, `it moves ${p} (${short(R[0][p])} -> ${short(R[set.length][p])} in this train) without declaring it (no "Pin-Moves: ${p}" trailer on its commits)`);
    }
  }
  const dir = path.join(root, TRAIN_DIR, String(id));
  const repRel = path.relative(root, path.join(dir, 'pins.json')).split(path.sep).join('/');
  const lanesMoving = set.filter((l) => moved.some((p) => movedBy[p].by.includes(l.task))).map((l) => l.task);
  const record = { train: id, at: new Date().toISOString(), main: tip, failingTests: pinsOnly.tests, lanes: set.map((l) => ({ task: l.task, head: l.head, pinMoves: declared.get(l.task) || [] })), before: R[0], after: R[set.length], prefixes: R.map((r, k) => ({ prefix: set.slice(0, k).map((l) => l.task), report: r })), moved: movedBy, invariants: pins.invariants, blocked: Object.fromEntries(blocked), refreshed: false };
  const save = () => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'pins.json'), `${JSON.stringify(record, null, 2)}\n`); } catch {} };
  ev('pins', id, `pins report on ${set.length + 1} prefix(es): ${moved.length ? moved.map((p) => `${p} ${short(movedBy[p].from)} -> ${short(movedBy[p].to)} by ${movedBy[p].by.join(', ') || 'no lane'}`).join('; ') : 'no pin moved'}`, { meta: { moved: movedBy, report: repRel } });
  if (!moved.length) { save(); return { kind: 'none', why: 'the pins\' report shows no moved value, so the failing pins are not explained by a lane' }; }
  if (blocked.size) {
    save();
    return { kind: 'pinBlocked', blocked: set.filter((l) => blocked.has(l.task)).map((l) => ({ lane: l, why: `the train is red only on pinned values, and ${blocked.get(l.task).join('; ')}. Report: ${repRel}. Declare an intended move with a "Pin-Moves: <pin>" trailer on a commit (an invariant needs the owner), or fix the change, then task done again` })) };
  }
  // Every move declared, no invariant: refresh on the combined tree and commit once.
  const b = prefix(set.length);
  if (!b) return { kind: 'none', why: 'the train no longer builds' };
  const cmd = pins.refresh.split('{in}').join(`"${reports[set.length].file}"`);
  const env = mergeEnv();
  const rr = spawnSync(cmd, { windowsHide: true, cwd: sc.dir, shell: true, encoding: 'utf8', env: /^(off|0|false|no)$/i.test(process.env.STUDIO_GAME_GATE_CI || '') ? env : { ...env, CI: 'true' }, maxBuffer: 64 * 1024 * 1024, timeout: Number(process.env.STUDIO_GAME_GATE_TIMEOUT_MS || 600000) });
  if (rr.status !== 0) { save(); return { kind: 'none', why: `the pins' refresh exited ${rr.status}: ${`${rr.stdout || ''}${rr.stderr || ''}`.trim().split('\n').slice(-2).join(' ').slice(0, 200)}` }; }
  git(sc.dir, 'add', '-A');
  if (!out(git(sc.dir, 'diff', '--cached', '--name-only'))) { save(); return { kind: 'none', why: 'the pins\' refresh changed no file' }; }
  const lines = moved.map((p) => `  ${p}: ${short(movedBy[p].from)} -> ${short(movedBy[p].to)} (${movedBy[p].by.join(', ')})`);
  const msg = [`train ${id}: pin refresh`, '', `Pinned values moved by lanes of this train, each declared by the lane that moved it (Pin-Moves):`, ...lines, `Report (before/after per pin and per prefix): ${repRel}`, '', `Golden-Reason: pin refresh by merge train ${id}: values moved by ${lanesMoving.join(', ')} (declared Pin-Moves)`, `Pin-Refresh: ${lanesMoving.join(', ')}`, `Studio-Train: ${id} pin-refresh`].join('\n');
  const c = spawnSync('git', ['-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local', 'commit', '-q', '-m', msg], { windowsHide: true, cwd: sc.dir, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
  if (c.status !== 0) { git(sc.dir, 'reset', '-q', '--hard', b.head); save(); return { kind: 'none', why: `the pin-refresh commit was refused: ${`${c.stdout || ''}${c.stderr || ''}`.trim().split('\n').slice(-2).join(' ').slice(0, 200)}` }; }
  const head = out(git(sc.dir, 'rev-parse', 'HEAD'));
  record.refreshed = true;
  record.commit = head;
  record.files = out(git(sc.dir, 'diff', '--name-only', `${b.head}..${head}`)).split('\n').filter(Boolean);
  save();
  log(`[train] ${id}: red only on declared pins; refreshed ${moved.join(', ')} in one commit (${head.slice(0, 8)}); verifying it in full`);
  return { kind: 'refreshed', built: { ...b, head, tree: out(git(sc.dir, 'rev-parse', 'HEAD^{tree}')) }, info: { lanes: lanesMoving, pins: movedBy, report: repRel, commit: head } };
}

// ---- 2.63.0: landing tiers (harness/tiers.mjs), holds for the owner, batching ---------------------------------

/** The trailers of a lane's own commits (base..head): { key: [values] }. */
export function laneTrailers(root, base, head) {
  const r = git(root, 'log', '--format=%(trailers:only,unfold)%x00', `${base}..${head}`);
  const t = {};
  for (const l of out(r).split(/[\n\0]/)) {
    const m = l.match(/^([A-Za-z][\w-]*):\s*(.*\S)\s*$/);
    if (m) (t[m[1]] = t[m[1]] || []).push(m[2]);
  }
  return t;
}

/** The lane's own diff (merge-base with main's tip .. its head) as [{ status, path }]; a rename gives both paths. */
export function laneFiles(root, base, head) {
  const r = git(root, '-c', 'core.quotePath=false', 'diff', '--name-status', '-M', `${base}..${head}`);
  const files = [];
  for (const l of out(r).split('\n').filter(Boolean)) {
    const [st, a, b] = l.split('\t');
    if (b) { files.push({ status: st, path: a }, { status: st, path: b }); } else if (a) files.push({ status: st, path: a });
  }
  return files;
}

/**
 * 2.71.1 (H03/H04/S02): the game's test toolchain in a lane's diff (harness/test-toolchain.mjs): the setup files the
 * test configs name where the lane branched (more protected globs) and a change to a game package.json's test scripts (a "<pkg>#test-scripts"
 * file, protected). Never throws.
 */
function laneToolchain(root, { base, head, files }) {
  try {
    const show = (rev, f) => { const r = git(root, 'show', `${rev}:${f}`); return r.status === 0 ? r.stdout : null; };
    // The configs and manifests as main had them where the lane branched (base), the lane's own change base..head.
    const tc = toolchainProtected({ base, changed: files.map((f) => f.path), show, names: (rev) => out(git(root, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', rev, '--', 'game', 'web')).split('\n').filter(Boolean), now: (f) => show(head, f) });
    return { globs: [...tc.globs, ...tc.keyed.map((k) => k.path)], files: tc.keyed.map((k) => ({ status: 'M', path: k.path })) };
  } catch { return { globs: [], files: [] }; }
}

/** The protected list (globs, addOnly) as main's tip has it: a lane can't shrink the list that judges it. */
function protectedAt(root, tip) {
  try { const j = JSON.parse(out(git(root, 'show', `${tip}:studio/protected.json`))); return { globs: Array.isArray(j.globs) ? j.globs.map(String) : [], addOnly: Array.isArray(j.addOnly) ? j.addOnly.map(String) : ['qa/regressions/**'] }; } catch { return { globs: [], addOnly: ['qa/regressions/**'] }; }
}

/**
 * The landing tier of a lane at `head` against main's `tip` (harness/tiers.mjs classifyLane on its own diff and its
 * own commits' trailers, with the game's manifest as main has it). Code only. Never throws.
 */
export async function laneTier(root, { head, task = null, agent = null, dir = null }, { tip = null, settings = null } = {}) {
  const t = tip || out(git(root, 'rev-parse', `refs/heads/${mainBranch(root)}`));
  const s = settings || await trainManifest(root, t);
  const base = out(git(root, 'merge-base', t, head)) || t;
  const prot = protectedAt(root, t);
  let files = laneFiles(root, base, head);
  // 2.72.0 (b): a purity ratchet baseline that grew in the lane is tier C (harness/ratchet.mjs markGrowth, tiers "ratchet-grow").
  try { files = (await import('./ratchet.mjs')).markGrowth(root, base, head, files); } catch { /* the rule just doesn't fire */ }
  // 2.65.0 (B-40): the files each config proposal of the lane names (a protected one makes the lane tier C).
  const proposals = Object.fromEntries(files.filter((f) => isProposalPath(f.path) && !String(f.status).startsWith('D')).map((f) => {
    const r = git(root, 'show', `${head}:${f.path}`);
    return [f.path, r.status === 0 ? proposalTargets(r.stdout) : null];
  }));
  const tc = laneToolchain(root, { base, head, files }); // 2.71.1 (H03/H04/S02)
  const c = classifyLane({ files: [...files, ...tc.files], trailers: laneTrailers(root, base, head), settings: s, protectedGlobs: [...prot.globs, ...tc.globs], addOnly: prot.addOnly, proposals });
  // 2.65.0 (B-40): a held lane's reason names the protected config it would change, so a release is an informed answer.
  if (c.rules.includes('config-proposal-protected')) {
    const globs = protectedGlobsAt(root, t);
    const said = [];
    for (const rel of Object.keys(proposals)) {
      const r = git(root, 'show', `${head}:${rel}`);
      const p = parseProposal(r.status === 0 ? r.stdout : '');
      for (const x of p.changes.filter((y) => matchAny(y.file, globs))) said.push(`${x.file}: ${Object.entries(x.set).map(([k, v]) => `${k} = ${JSON.stringify(v)}`.slice(0, 80)).join(', ')}`);
      if (!p.ok) said.push(`${rel} can't be read (${p.errors.slice(0, 2).join('; ')})`);
    }
    if (said.length && c.tier === 'C') c.why = [...c.why, `it proposes ${said.join('; ').slice(0, 400)}`];
  }
  contractTier(root, task, c);
  // 2.73.0 (g, A13): a re-recorded golden (rule golden-rerecord) carries the harness's first-divergence report, shown in
  // the hold; its release needs a second signer (harness/golden-report.mjs).
  rerecordTier(root, c, { base, head, agent, dirs: dir ? [dir] : [], tip: t });
  return c;
}

/**
 * 2.72.0 (c), the completeness rubric: a task whose acceptance contract (harness/contracts.mjs) has must-items the
 * harness can't verify (manual, not signed by a reviewer or a person) is tier C: it lands only after a reviewer's yes
 * (contract sign) or a person's release. Changes c in place. Never throws.
 */
function contractTier(root, task, c) {
  if (!task) return;
  try {
    const items = unverifiedMust(task, root);
    if (!items.length) return;
    // The reasons of a lower tier don't say why it waits; a lane already tier C keeps its own.
    const own = c.tier === 'C' ? c.why.filter((w) => !String(w).startsWith(CONTRACT_HOLD)) : [];
    c.tier = 'C';
    c.why = [...own, contractHoldWhy(task, items)];
    c.rules = [...(c.rules || []), 'contract-unverified'];
  } catch { /* no contract: no change */ }
}

/**
 * 2.72.0 (c): a lane held only for its contract's unverified must-items is let go once a reviewer (or a person) has
 * signed them all: the reviewer's yes is the release. The train classifies it again before it lands.
 */
export function clearContractHolds(root, lanes, log = () => {}) {
  for (const l of lanes) {
    if (!l.fromQueue || !heldNow(l) || !contractOnlyHold(l.held.why)) continue;
    let left = null;
    try { left = unverifiedMust(l.task, root); } catch { continue; }
    if (left.length) continue;
    withQueue(root, (q) => { const e = q.find((x) => x.task === l.task); if (e && e.held && contractOnlyHold(e.held.why)) delete e.held; });
    delete l.held;
    log(`[train] ${l.task}: its contract's must-items are signed now, so the hold for them is cleared (the train checks its tier again)`);
    emitEvent({ type: 'task.train.unheld', agent: 'train', task: l.task, status: 'ok', msg: `${l.task}: every must-item of its acceptance contract is signed; the tier-C hold for them is cleared` });
  }
}

// ---- 2.65.0 (B-40 full): a lane's studio config proposal (harness/config-proposal.mjs) ----------------------------

/** Apply the config proposals of lanes that just landed (harness/config-proposal.mjs applyLandedConfig, main moved by landFastForward). */
export const applyLandedConfig = (root, main, lanes, opts = {}) => applyLandedConfigWith(root, main, lanes, { ...opts, ff: landFastForward });

/**
 * `npm run task -- train config <ID> [--by <person>] [--permission "…"]`: apply a proposal held on main (its protected
 * part waited for the owner's signature, or a person; or main changed a key). With an owner key the signature decides;
 * without one, --by names the person who decides, under the release rules (releaseRefusal: never a worker).
 */
export function applyHeldConfig(root, task, { by = '', permission = '', env = process.env } = {}) {
  const main = mainBranch(root);
  const tip = out(git(root, 'rev-parse', `refs/heads/${main}`));
  if (git(root, 'cat-file', '-e', `${tip}:${proposalRel(task)}`).status !== 0) return { ok: false, message: `${main} holds no config proposal for ${task} (${proposalRel(task)}).` };
  const ownerKey = /BEGIN PUBLIC KEY/.test(out(git(root, 'show', `${tip}:studio/keys/owner-ed25519.pub.pem`)));
  let released = null;
  // 2.77.3 (B-111): in beta mode the owner's stand-in decides a held protected part as the owner would, key or not
  // (config-proposal.mjs betaReleaseOk); logged as a beta use.
  const dgb = String(by || '').trim() ? delegationFor({ action: 'train-config', by, env, root }) : { ok: false };
  if (dgb.ok && dgb.beta) {
    // 2.78.2 (h): a protected config part is a protected decision (permission.mjs mayDecide): the owner's and the outside
    // agents', not a Producer/Director session's unless STUDIO_PRODUCER_APPROVES=protected; never a worker's.
    const d = mayDecide('train-config', actorOf({ env, root }), { root, agents: dgb.doc?.agents || [] });
    if (!d.ok) return { ok: false, message: `Refused: ${d.why}. Nothing was applied.` };
    released = { by: String(dgb.owner || by).trim().slice(0, 60), recordedBy: String(dgb.agent || '').slice(0, 60), beta: true, betaAt: dgb.at, decides: d.cls };
  }
  else if (String(by || '').trim() && !ownerKey) {
    const refusal = releaseRefusal({ by, permission, env, ownerKey, stateDir: path.join(root, '.studio') });
    if (refusal) return { ok: false, message: `${refusal.replace(/Landing a tier-C lane/, 'Applying a protected config change')} Nothing was applied.` };
    const perm = permissionText(permission);
    const rec = perm ? agentOnPermission({ permission: perm, env }) : null;
    released = { by: String(by).trim().slice(0, 60), ...(rec && rec.via !== 'person' ? { recordedBy: rec.recordedBy } : {}) };
  }
  let r;
  try { r = withLandLock(root, () => applyLandedConfig(root, main, [{ task, released }], { by: released?.recordedBy || released?.by || 'train-config' })[0]); } catch (e) { return { ok: false, message: `could not apply it: ${e.message}` }; }
  if (!r) return { ok: false, message: `${task}'s proposal could not be read.` };
  if (!r.held.length && released) logDecision({ action: 'config-apply', subject: task, by: released.beta ? released.recordedBy : released.by, as: released.beta ? 'beta' : asOf({ via: released.recordedBy ? 'outside agent' : 'person', permission }), why: `applied ${task}'s held config proposal`, evidence: released.beta ? `beta mode ${released.recordedBy}: ${proposalRel(task)}` : proposalRel(task), undo: null, root });
  return { ok: !r.held.length, message: configLine(task, { ...r, decision: '' }) };
}

/** How many times a task was handed back for a failure (task.paused with a reason key, as harness/breaker.mjs counts). */
// 2.76.0: infrastructure hand-backs (a missing lane copy, a CRLF/hash mismatch, a re-queue, a dead train, a timeout-only
// red already re-run, a mixed lane: harness/train-lanes.mjs infraHandBack) never count.
// 2.79 (b): a hand-back the train tagged (meta.handBackCause) counts only when the lane's own check failed or it
// conflicted ('red', 'conflict'); an untagged one (an agent's own, or from 2.78.2) keeps the rule above.
const countsAsHandBack = (e) => (e.meta?.handBackCause ? /^(red|conflict)$/.test(e.meta.handBackCause) : !infraHandBack(e));
export function handBackCount(task) {
  return readRecentEvents(20000).filter((e) => e.type === 'task.paused' && e.task === task && (e.meta?.reasonKey || /Not landed by merge train/.test(String(e.msg || ''))) && countsAsHandBack(e)).length;
}
export const maxHandBacks = (env = process.env) => (Number(env.STUDIO_TRAIN_MAX_HANDBACKS) >= 0 && String(env.STUDIO_TRAIN_MAX_HANDBACKS || '').trim() !== '' ? Number(env.STUDIO_TRAIN_MAX_HANDBACKS) : 3);

const mainTip = (root) => out(git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${mainBranch(root)}`)) || null;
/** A queue entry waiting for the owner: held, and not released for the head it is at. */
export const heldNow = (e) => Boolean(e?.held) && !(e.released && e.released.head === e.head);
/** A release that covers this head. */
const releasedFor = (e, head) => Boolean(e?.released) && e.released.head === head;

/** Put a lane in the queue as "needs the owner" (or mark its entry so), with its tier and why. */
export function holdLane(root, lane, { tier, why, rerecord = null, beta = false }) {
  return withQueue(root, (q) => {
    let e = q.find((x) => x.task === lane.task);
    if (!e) { e = { task: lane.task, agent: lane.agent, dir: lane.dir, branch: lane.branch, head: lane.head, all: Boolean(lane.all), note: lane.note || '', at: new Date().toISOString() }; q.push(e); }
    const fresh = !e.held || e.held.head !== lane.head || e.held.why !== why;
    Object.assign(e, { head: lane.head, branch: lane.branch || e.branch, dir: lane.dir || e.dir, held: { tier, why, head: lane.head, at: fresh ? new Date().toISOString() : e.held.at, ...(rerecord ? { rerecord } : {}), ...(beta ? { beta: true } : {}) } });
    // 2.79 (c): a release made at another head still covers a lane whose content is the same (carried to this head).
    if (e.released && e.released.head !== lane.head) { const c = carriedRelease(root, e.released, { head: lane.head, tip: mainTip(root) }); if (c) e.released = c; else delete e.released; }
    return { entry: { ...e }, fresh };
  });
}

/**
 * Why this caller may not release a held lane, or '' (a person, or an agent recording a person's permission).
 * The rule of harness/permission.mjs: a person in their own terminal; with --permission a Producer or Director session
 * or an agent outside the harness, for the person named in --by; a worker never. With an owner key a permission line
 * isn't a signature: only the owner's own terminal releases.
 */
export function releaseRefusal({ by, permission, env = process.env, ownerKey = false, stateDir } = {}) {
  const who = String(by || '').trim();
  const tail = 'Landing a tier-C lane is the owner\'s decision: the owner runs npm run task -- train release <ID> --by <name> in their own terminal, or a Producer or Director session (or an agent outside the harness) records the owner\'s direct permission with --permission "<their words or a link>". A worker hands the task back and asks.';
  if (!who) return `Say who decides: --by <the person's name>. ${tail}`;
  if (agentLikeName(who, stateDir ? { stateDir } : undefined)) return `"${who}" is an agent's name; --by names the person who decides. ${tail}`;
  const perm = permissionText(permission);
  if (perm) {
    const p = agentOnPermission({ permission: perm, env });
    if (!p.ok) return `Refused: ${p.why}. ${tail}`;
    if (ownerKey && p.via !== 'person') return `This studio has an owner key: a permission line isn't a signature, so only the owner's own terminal releases a held lane. ${tail}`;
    return '';
  }
  const inSession = launchedSession(env);
  if (inSession) return `Refused: ${inSession}. ${tail}`;
  const marker = AGENT_SHELL.find((k) => String(env[k] || '').trim());
  if (marker) return `Refused: this shell is run by a coding agent (${marker} is set). ${tail}`;
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  if (owner && WORKER_NAME.test(owner)) return `Refused: ${owner} is a worker agent. ${tail}`;
  return '';
}

/** Release a held lane for the head it is at (recorded in the queue entry and as a task.train.released event). */
export function releaseLane(root, task, { by, permission = '', env = process.env } = {}) {
  const ownerKey = /BEGIN PUBLIC KEY/.test(out(git(root, 'show', `refs/heads/${mainBranch(root)}:studio/keys/owner-ed25519.pub.pem`)));
  // 2.67.0: the owner's standing delegation (harness/delegation.mjs) lets the named outside agent release with --by <agent>.
  const dg = delegationFor({ action: 'train-release', by, env, root });
  if (dg.ok && ownerKey && !dg.signed && !dg.beta) return { ok: false, message: `This studio has an owner key: the delegation isn't signed with it. Nothing was released.` };
  // 2.76.0: a lane the hand-back cap held in beta mode is released by the beta actors (the orchestrator, a Producer or
  // Director session: harness/beta-mode.mjs betaActor), no owner needed. Recorded as a beta use.
  const betaHeld = !dg.ok && Boolean(readQueue(root).find((x) => x.task === task)?.held?.beta);
  const ba = betaHeld ? betaActor({ env, from: root }) : { ok: false };
  if (ba.ok) by = String(by || ba.who || '').trim() || ba.who;
  const refusal = dg.ok || ba.ok ? '' : releaseRefusal({ by, permission, env, ownerKey, stateDir: path.join(root, '.studio') });
  if (refusal) return { ok: false, message: `${refusal}${dg.why ? ` (${dg.why})` : ''} Nothing was released.` };
  if (dg.ok) { by = dg.owner; permission = dg.permission; }
  const perm = permissionText(permission);
  const rec = dg.ok ? { ok: true, via: 'delegation', recordedBy: dg.agent } : perm ? agentOnPermission({ permission: perm, env }) : null;
  const r = withQueue(root, (q) => {
    const e = q.find((x) => x.task === task);
    if (!e) return { ok: false, message: `${task} is not in the train queue (task done ${task} --train queues it; a tier-C lane is held there).` };
    if (!e.held) return { ok: false, message: `${task} is queued but not held: it needs no release.` };
    // 2.71.0 (x): autonomous mode never releases a lane held for protected files, gates, deletes … (harness/policy.mjs).
    const never = dg.autonomous ? autonomousReleaseRefusal(e.held.why) : '';
    if (never) return { ok: false, message: `Refused: ${never}. Nothing was released.` };
    // 2.73.0 (g, A13): a re-recorded golden needs a releaser who isn't the lane's author, and, without the harness's
    // first-divergence report, a person (harness/golden-report.mjs).
    const second = rerecordRefusal(e.held, { by, agent: dg.ok ? dg.agent : '', recordedBy: rec?.recordedBy || '', delegated: dg.ok, beta: Boolean(dg.beta) });
    if (second) return { ok: false, message: `Refused: ${second}. Nothing was released.` };
    // 2.79 (c): the lane's content at release (train-lanes.mjs laneContent), so a new head with the same content keeps it.
    const content = laneContent(root, { head: e.head, tip: mainTip(root) });
    e.released = { by: String(by).trim().slice(0, 60), at: new Date().toISOString(), head: e.head, ...(content ? { content: { key: content.key, files: content.files.slice(0, 200) } } : {}), tier: e.held.tier, why: e.held.why, ...(rec && rec.via !== 'person' ? { permission: perm.slice(0, 500), recordedBy: rec.recordedBy } : {}), ...(dg.ok ? { delegation: dg.at } : {}), ...(dg.autonomous ? { autonomous: true } : {}), ...(dg.beta ? { beta: true, betaAt: dg.at, decides: 'board' } : {}), ...(ba.ok ? { beta: ba.via, betaAt: ba.doc.at, decides: 'board' } : {}) };
    return { ok: true, entry: { ...e } };
  });
  if (!r.ok) return r;
  const e = r.entry;
  keepRelease(root, task, e.released); // 2.76.0: survives the lane leaving and re-entering the queue at this head
  if (dg.ok) recordUse(dg, { action: 'train-release', task, detail: `tier ${e.held.tier} at ${String(e.head).slice(0, 8)}` });
  if (ba.ok) recordBetaUse(ba, { action: 'train-release', subject: task, why: e.held.why });
  emitEvent({ type: 'task.train.released', agent: e.released.recordedBy || e.released.by, task, to: e.agent, status: 'ok', msg: `${task} (tier ${e.held.tier}: ${String(e.held.why).slice(0, 200)}) released for the merge train by ${dg.autonomous ? `${dg.agent} in autonomous mode (allowed by ${e.released.by}; on the review list)` : e.released.by}${dg.autonomous ? '' : e.released.recordedBy ? ` (recorded by ${e.released.recordedBy} on ${e.released.by}'s permission: "${e.released.permission.slice(0, 120)}")` : ''}, at ${String(e.head).slice(0, 8)}`.slice(0, 600), meta: { by: e.released.by, head: e.head, tier: e.held.tier, ...(e.released.permission ? { permission: e.released.permission, recordedBy: e.released.recordedBy } : {}), ...(dg.autonomous ? { autonomous: true } : {}) } });
  // 2.71.0 (x): one record in the decision log (harness/decisions.mjs).
  logDecision({ action: 'train-release', subject: task, by: dg.ok ? dg.agent : e.released.by, as: asOf(dg.ok ? dg : { via: rec?.via, permission: e.released.permission }), why: `tier ${e.held.tier}: ${e.held.why}`, evidence: `${e.held.rerecord ? `${rerecordEvidence(e.held)}; ` : ''}${e.held.tier} at ${String(e.head).slice(0, 8)}`, undo: { kind: 'rehold-lane', task, head: e.head, text: `npm run decisions -- revert <id> (holds ${task} again if it hasn't landed; else files a revert task)` }, root });
  return { ok: true, entry: e, message: `${task} is released (tier ${e.held.tier}: ${e.held.why}) by ${e.released.by}${e.released.recordedBy ? `, recorded by ${e.released.recordedBy}` : ''}, for ${String(e.head).slice(0, 8)}. It lands with the next train (npm run task -- train); new commits on the lane need a new release.` };
}

/**
 * 2.71.0 (x): undo a release (a reverted decision, harness/decisions.mjs): the lane waits for a person again. Only for
 * the head that was released and only while it hasn't landed. { ok, landed, message }.
 */
export function unreleaseLane(root, task, { head = null, why = '' } = {}) {
  const r = withQueue(root, (q) => {
    const e = q.find((x) => x.task === task);
    if (!e) return { ok: false, landed: true, message: `${task} isn't in the train queue any more (it landed or left)` };
    if (!e.released) return { ok: true, message: `${task} is in the queue and not released; nothing to undo` };
    if (head && e.released.head !== head) return { ok: false, message: `${task} was released again for another head (${String(e.released.head).slice(0, 8)}); undo that one by hand` };
    forgetRelease(root, task, e.released.head);
    delete e.released;
    return { ok: true, message: `${task} is held again (tier ${e.held?.tier || '?'}): it waits for a person's release`, entry: { ...e } };
  });
  if (r.ok && r.entry) emitEvent({ type: 'task.train.held', agent: 'decisions', task, to: 'producer', status: 'blocked', msg: `${task} is held again${why ? ` (${why})` : ''}: npm run task -- train release ${task} --by <name>`.slice(0, 400), meta: { tier: r.entry.held?.tier || null, why: r.entry.held?.why || null, revert: true } });
  return r;
}

/** STUDIO_TRAIN_MIN (1), STUDIO_TRAIN_MAX (0: no cap), STUDIO_TRAIN_WAIT_MIN (10) and the poll (STUDIO_TRAIN_POLL_S, 15). */
export function batchRules(env = process.env) {
  const num = (k, d) => { const v = String(env[k] ?? '').trim(); return v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d; };
  return { min: Math.max(1, Math.floor(num('STUDIO_TRAIN_MIN', 1))), max: Math.floor(num('STUDIO_TRAIN_MAX', 0)), waitMin: num('STUDIO_TRAIN_WAIT_MIN', 10), pollMs: Math.max(200, num('STUDIO_TRAIN_POLL_S', 15) * 1000) };
}

/**
 * A queued train waits up to WAIT minutes (from the oldest lane's queueing) for MIN lanes that aren't held. Returns
 * { waited: ms, lanes: n }. Never holds the train lock while it waits.
 */
export function waitForBatch(root, { log = () => {}, rules = batchRules(), id = '' } = {}) {
  const t0 = Date.now();
  let told = false;
  for (;;) {
    const runnable = readQueue(root).filter((e) => !heldNow(e));
    if (runnable.length >= rules.min || !runnable.length) return { waited: Date.now() - t0, lanes: runnable.length };
    const oldest = Math.min(...runnable.map((e) => Date.parse(e.at) || Date.now()));
    const left = oldest + rules.waitMin * 60000 - Date.now();
    if (left <= 0) {
      if (told) log(`[train] waited ${Math.round((Date.now() - t0) / 1000)} s; ${runnable.length} of ${rules.min} lane(s): running with what is queued`);
      return { waited: Date.now() - t0, lanes: runnable.length, timedOut: true };
    }
    if (!told) {
      log(`[train] ${runnable.length} of ${rules.min} lane(s) queued (STUDIO_TRAIN_MIN); waiting up to ${Math.ceil(left / 1000)} s more (STUDIO_TRAIN_WAIT_MIN ${rules.waitMin}) for more`);
      emitEvent({ type: 'task.train.waiting', agent: 'train', status: 'warn', msg: `train${id ? ` ${id}` : ''}: ${runnable.length} of ${rules.min} lane(s) queued; waiting up to ${Math.ceil(left / 1000)} s for more`, meta: { lanes: runnable.map((e) => e.task), min: rules.min, waitMin: rules.waitMin } });
      told = true;
    }
    sleep(Math.min(rules.pollMs, left));
  }
}

// ---- the train ---------------------------------------------------------------------------------------

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const ev = (type, id, msg, extra = {}) => emitEvent({ type: `task.train.${type}`, agent: extra.agent || 'train', task: extra.task, to: extra.to, status: extra.status, msg: `train ${id}: ${msg}`.slice(0, 600), meta: { train: id, ...(extra.meta || {}) } });

/** Read a queue entry's lane copy as it is now: { dir, branch, head } or { error }. */
export function laneNow(lane) {
  if (!lane.dir || !fs.existsSync(lane.dir)) return { error: `its lane copy ${lane.dir || '(none)'} is gone` };
  // 2.79 (b): a folder with no .git of its own is not a copy: git there names the main checkout's branch ("its copy is on
  // main now"). It counts as missing (the train moves it aside and makes the copy again from the lane's branch).
  if (!ownWorktree(lane.dir)) return { error: `its lane copy ${lane.dir} is not a git checkout (a leftover folder with no .git)`, leftover: true };
  const head = out(git(lane.dir, 'rev-parse', 'HEAD'));
  const branch = out(git(lane.dir, 'symbolic-ref', '--short', 'HEAD'));
  if (!head) return { error: `its lane copy ${lane.dir} is not a git checkout` };
  return { head, branch };
}

/**
 * Check a queued lane in its own copy: its harness's `task done <ID> --train-check` (every check of task done but
 * the game's, nothing closed). A copy whose harness predates the train is refused, never run (an older task.mjs
 * would ignore the flag and run a whole task done).
 */
export function precheckChild(root, lane) {
  const script = path.join(lane.dir, 'harness', 'task.mjs');
  let src = '';
  try { src = fs.readFileSync(script, 'utf8'); } catch {}
  if (!src.includes("flags['train-check']")) return { ok: false, error: 'old-harness', message: `${lane.task}'s lane copy runs a harness from before the merge train (2.59.0): merge the studio's branch into the copy (git merge ${mainBranch(root)}), commit, and queue it again, or land it with STUDIO_TRAIN=off npm run task -- done ${lane.task}` };
  // 2.76.0 (B-90): run in the lane owner's name, but its events are the train's (meta.onBehalf), never the owner's activity.
  const env = { ...process.env, STUDIO_MAIN_ROOT: root, STUDIO_LOCK_OWNER: lane.agent, STUDIO_ON_BEHALF: 'train' };
  const r = spawnSync(process.execPath, [script, 'done', lane.task, '--agent', lane.agent, '--train-check'], { windowsHide: true, cwd: lane.dir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{"train')).pop();
  try { const j = JSON.parse(line); return { ...j, ok: Boolean(j.ok) }; } catch {}
  return { ok: false, error: 'check-failed', message: `${`${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-12).join('\n') || `exit ${r.status}`}` };
}

/** The files the integration changes against main (what scopes its verify, as a lane verify is scoped). */
const changedVs = (dir, tip, head) => out(git(dir, 'diff', '--name-only', `${tip}..${head}`)).split('\n').filter(Boolean);

/**
 * Run one train. opts:
 *   lanes       explicit lanes ([{ task, agent, dir, branch, head, all, prechecked }]); default: the queue
 *   max         at most this many lanes from the queue
 *   dryRun      check and plan only: nothing verified, nothing lands, nothing handed back
 *   by          who runs it (events)
 *   oneLane     task done's own one-lane train: a failure is returned to the caller, not handed back
 *   waitMs      how long to wait for a running train (task done waits; `task train` doesn't)
 *   deps        { close(lane, ctx) -> { ok, message? }, handBack(lane, note), stopped() -> reason|null,
 *                 waitForDrain() -> { ok, message }, markRunning(task, agent), clearRunning(task), precheck(lane) }
 *   log         progress lines
 * Returns { ok, id, landed: [task], dropped: [{ task, why }], deferred: [{ task, why }], verifies, reused, message }.
 */
/** 2.68.0 (m): the disk-low warning in the train's output (harness/machine.mjs diskWarning). */
async function trainDiskWarning(root, log) {
  try { const w = await (await import('./machine.mjs')).diskWarning({ root }); if (w) log(`[train] warning: ${w}.`); } catch {}
}

/**
 * 2.76.0 (B-88): run one train body with its life recorded (harness/train-life.mjs): its lanes, a normal end, or a death
 * with its cause on any exit path this process sees (a throw in a step is recorded, then thrown on). A dry run records
 * nothing.
 */
async function livedTrain(root, { id, by, dryRun }, fn) {
  if (dryRun) return fn(null);
  const life = beginTrainLife(root, { id, by, harness: processHarness() });
  try {
    const r = await fn(life);
    life.end(r?.message || '');
    return r;
  } catch (e) {
    life.died(`crashed: ${String(e?.message || e).slice(0, 200)}`);
    throw e;
  }
}

/**
 * 2.76.0 (B-88): record every train that died without recording its end (harness/train-life.mjs reapDeadTrains) and keep
 * its lanes moving: a queued lane keeps its place, a task done's own lane is queued, a lane two trains died with at the
 * same head is held for the Producer (not a hand-back: never counted toward STUDIO_TRAIN_MAX_HANDBACKS). Never throws.
 */
export function reapTrains(root, { log = () => {}, now = Date.now(), env = process.env } = {}) {
  try {
    return reapDeadTrains(root, {
      now, env, log,
      entryOf: (task) => readQueue(root).find((e) => e.task === task) || null,
      mark: (task, patch) => requeue(root, { task }, patch),
      enqueue: (lane) => enqueue(root, { task: lane.task, agent: lane.agent, dir: lane.dir, branch: lane.branch, head: lane.head, all: Boolean(lane.all), note: 'queued again after its train died', diedIn: lane.diedIn }),
      onMain: (head) => git(root, 'merge-base', '--is-ancestor', head, `refs/heads/${mainBranch(root)}`).status === 0,
      toProducer: (lane, note) => { const h = holdLane(root, lane, { tier: 'B', why: note }); if (h.fresh) emitEvent({ type: 'task.train.held', agent: 'train', task: lane.task, to: 'producer', status: 'blocked', msg: `${lane.task}: ${note}. npm run task -- train release ${lane.task} --by <name> lets it train again`.slice(0, 600), meta: { tier: 'B', why: note, died: true } }); },
    });
  } catch { return []; }
}

export async function runTrain(opts = {}) {
  const root = opts.root || mainRoot();
  const log = opts.log || ((m) => console.error(m));
  const deps = opts.deps || {};
  const id = `${stamp()}-${process.pid}`;
  const by = opts.by || process.env.STUDIO_LOCK_OWNER || 'human';
  const t0 = Date.now();
  processHarness(); // 2.78.1 (B-122): the harness this process runs, taken as its first train starts
  const stopped = deps.stopped?.();
  if (stopped) return { ok: false, id, message: `The studio is stopped (${stopped}); no train runs until npm run task -- resume.`, landed: [], dropped: [], deferred: [] };
  if (!opts.dryRun) await trainDiskWarning(root, log); // 2.68.0 (m)
  if (!opts.dryRun && deps.waitForDrain) {
    const w = await deps.waitForDrain();
    if (!w.ok) return { ok: false, id, message: w.message, landed: [], dropped: [], deferred: [] };
  }
  // 2.63.0 (batching): a queued train waits up to STUDIO_TRAIN_WAIT_MIN for STUDIO_TRAIN_MIN lanes (--now: it doesn't).
  if (!opts.lanes && !opts.dryRun && !opts.now) waitForBatch(root, { log, id });
  // 2.76.0 (B-88): a train that died without recording its end (its process gone) is recorded now, before this one.
  if (!opts.dryRun) reapTrains(root, { log });
  // 2.77.0 (p, P9.6): a speculative train that can land on main now (its train A ended and main is the tree it built on)
  // goes first: a train that gets the train lock before it gives the lock back and waits for it (within waitMs).
  const tipNow = () => out(git(root, 'rev-parse', `refs/heads/${mainBranch(root)}`));
  const one = async (tid, extra = {}, waitMs = opts.waitMs ?? 0) => {
    const until = Date.now() + waitMs;
    for (;;) {
      const r = await withTrainLock(root, { id: tid, by }, () => {
        const nb = opts.dryRun ? null : nextBusy(root, { tip: tipNow(), self: tid });
        return nb ? { yieldTo: nb } : livedTrain(root, { id: tid, by, dryRun: opts.dryRun }, (life) => trainBody({ ...opts, ...extra, root, log, deps, id: tid, by, life }));
      }, { waitMs: Math.max(0, until - Date.now()), log });
      if (!r?.yieldTo) return r;
      log(`[train] ${tid}: the speculative train ${r.yieldTo.id} (after ${r.yieldTo.after || '?'}) lands on ${mainBranch(root)} first`);
      const w = await waitForNext(root, { maxMs: Math.max(0, until - Date.now()), tipOf: tipNow, self: tid, log });
      if (!w.gone) return { busy: { id: r.yieldTo.id, by: r.yieldTo.by || NEXT_BY, why: `the speculative train ${r.yieldTo.id} lands first` } };
    }
  };
  let locked = await one(id);
  if (locked?.busy) return { ok: false, id, busy: locked.busy, message: `Another train is running (${locked.busy.id || '?'}, by ${locked.busy.by || '?'}); run this again when it ends.`, landed: [], dropped: [], deferred: [] };
  // 2.63.0 (run alone): lanes that waited because a lane ran alone get the next train(s) now, one after another.
  const trains = [locked.id];
  // 2.65.3 (B-43, c): after an early landing of a green prefix, the lanes deferred behind its culprit (queued) get the
  // next train now, also after a task done's own train (then as a queued train: its riders are in the queue).
  for (let k = 1; locked.more && !opts.dryRun && (!opts.lanes || locked.prefixMore) && k <= 50; k += 1) {
    // 2.78.1 (B-122): never chain-start a train when the harness changed since this process started (an update merged
    // meanwhile): its modules would mix the old code with the new. The lanes stay queued for the train daemon, a fresh
    // process on the new harness.
    const cg = deps.chainGuard ? deps.chainGuard() : chainGuard();
    if (!cg.ok) {
      const line = `${id}: the next train is not started from this process: ${cg.why}; the queued lanes wait for the train daemon (a fresh process; npm run task -- train --by <you> starts one by hand)`;
      log(`[train] ${line}`);
      ev('chain_stopped', locked.id || id, line.replace(/^[^:]+: /, ''), { agent: by, to: 'producer', status: 'warn', meta: { was: cg.was || null, now: cg.now || null } });
      locked.chainStopped = cg.why;
      break;
    }
    const next = await one(`${id}-${k}`, opts.lanes ? { lanes: undefined, oneLane: false, rideAlong: false } : {}, Number(process.env.STUDIO_TRAIN_STALE_MIN || 360) * 60000); // 2.77.0 (p): after a speculative train behind it
    if (next?.busy) break;
    trains.push(next.id);
    const later = new Set([...next.landed, ...next.dropped.map((d) => d.task), ...next.held.map((h) => h.task)]);
    locked = {
      ...next,
      ok: (locked.ok && next.ok) || locked.landed.length + next.landed.length > 0,
      landed: [...locked.landed, ...next.landed],
      dropped: [...locked.dropped, ...next.dropped],
      deferred: [...locked.deferred.filter((d) => !later.has(d.task) && !next.deferred.some((x) => x.task === d.task)), ...next.deferred],
      held: [...locked.held.filter((h) => !later.has(h.task)), ...next.held],
      tiers: { ...locked.tiers, ...next.tiers },
      verifies: locked.verifies + next.verifies,
      reused: locked.reused + next.reused,
      ...(locked.rechecks || next.rechecks ? { rechecks: (locked.rechecks || 0) + (next.rechecks || 0) } : {}),
      closed: [...(locked.closed || []), ...(next.closed || [])],
    };
    locked.message = summary(locked);
  }
  if (trains.length > 1) locked.trains = trains;
  // 2.69.0 (r): ONE fix task per test the triager quarantined (deduped; harness/flakes.mjs).
  if (!opts.dryRun && deps.fileFlakeTask) { try { locked.flakeTasks = await fileQuarantineTasks(root, deps.fileFlakeTask); } catch {} }
  // 2.70.0 (t): a playable build + clip of the landed main, queued (never waited for).
  if (!opts.dryRun) { const lb = await landingBuildAfterTrain(root, locked, { log, queue: deps.landingBuild }); if (lb) locked.landingBuild = lb; }
  // 2.69.0 (r): the train daemon posts its own job.done (with what it re-queued), so the train's own is left out.
  if (!opts.dryRun && !opts.quietJob) trainJobDone(locked, t0);
  return locked;
}

/**
 * 2.70.0 (t): after a train lands, queue ONE low-priority playable build + clip (harness/landing-build.mjs): a file and
 * a detached worker, so the train never waits for it; STUDIO_LANDING_BUILD=off turns it off. Never throws. Returns
 * the queue result (or null when nothing landed). queue: deps.landingBuild (tests).
 */
export async function landingBuildAfterTrain(root, res, { env = process.env, log = () => {}, queue = null } = {}) {
  if (!res?.landed?.length) return null;
  try {
    const q = queue || (await import('./landing-build.mjs')).queueLandingBuild;
    return await q({ root, train: res.id || null, tasks: res.landed, env, log: (m) => log(`[train] ${res.id || ''}: ${m}`) });
  } catch (e) {
    try { log(`[train] ${res.id || ''}: playable build + clip not queued: ${String(e.message || e).slice(0, 160)}`); } catch {}
    return null;
  }
}

/** 2.65.0: the uniform job.done (harness/jobs.mjs) for a train that ran (not a dry run, not one that found another running). */
export function trainJobDone(res, t0, more = {}) {
  try {
    const result = res.landed?.length ? 'landed' : res.held?.length && !res.dropped?.length ? 'held' : res.dropped?.length ? 'fail' : res.ok ? 'nothing' : 'fail';
    const tail = [res.landed?.length ? `landed ${res.landed.join(', ')}` : '', res.dropped?.length ? `handed back ${res.dropped.map((d) => d.task).join(', ')}` : '', res.deferred?.length ? `deferred ${res.deferred.map((d) => d.task).join(', ')}` : '', res.held?.length ? `held ${res.held.map((h) => h.task).join(', ')}` : ''].filter(Boolean).join('; ') || String(res.message || '').slice(0, 300);
    jobDone({ kind: 'train', id: res.id, code: res.ok ? 0 : 1, result, ms: Date.now() - t0, tail: `${tail}${more.tail ? `; ${more.tail}` : ''}`.slice(0, 600), log: path.join(TRAIN_DIR, String(res.id || '')).split(path.sep).join('/'), extra: { landed: res.landed || [], dropped: (res.dropped || []).map((d) => d.task), deferred: (res.deferred || []).map((d) => d.task), held: (res.held || []).map((h) => h.task), ...(more.extra || {}) } });
  } catch {}
}

// ---- 2.65.0: lanes that wait (a predicted conflict, B-34; --after dependencies, crew feedback 3.3) -------------

/** The board's states and the dependency map: deps.taskStates() (task.mjs) or the board files under root. */
function depContext(root, deps = {}) {
  let states = null;
  try { states = deps.taskStates?.() || null; } catch {}
  states = states || boardStates(root) || { open: new Set(), done: new Set() };
  return { map: readDeps(root), done: states.done, states };
}

/**
 * Which of these lanes wait, before anything is spent on them: [{ lane, why, key, kind: 'after'|'deps'|'stuck' }].
 *   after  queued after a predicted conflict with another queued lane (train-predict.mjs) still in the queue and
 *          not done: it goes in a train after that one;
 *   deps   an --after dependency that isn't done and isn't among this train's lanes;
 *   stuck  a dependency dropped from the board or not on it: handed back with a note (never waits forever).
 */
export function laneWaits(root, lanes, deps = {}) {
  const ctx = depContext(root, deps);
  const queue = readQueue(root);
  const here = new Set(lanes.map((l) => l.task));
  let dropped = null;
  const out = [];
  for (const l of lanes) {
    const a = l.after?.task;
    if (a && a !== l.task && !ctx.done.has(a) && queue.some((e) => e.task === a)) {
      out.push({ lane: l, kind: 'after', key: `after:${a}:${l.head}`, why: `it was queued after ${a} (predicted conflict: ${(l.after.places?.length ? l.after.places.map((p) => `${p.file}:${p.line}`) : l.after.files || []).slice(0, 4).join(', ') || 'see the queue'}); it goes in a train after ${a} lands or leaves the queue` });
      continue;
    }
    if (!ctx.map.has(l.task)) continue;
    dropped = dropped || droppedTasks();
    const j = judgeDeps(l.task, ctx.map, { states: ctx.states, dropped, inTrain: here });
    if (j.stuck) out.push({ lane: l, kind: 'stuck', key: `stuck:${j.deps.join(',')}`, why: j.stuck });
    else if (j.wait) out.push({ lane: l, kind: 'deps', key: `deps:${j.deps.join(',')}`, why: j.wait });
  }
  return out;
}

/** Defer the waiting lanes (the event once per lane and reason: the queue entry keeps waitTold) and hand back the stuck. */
function waitActions(root, waits, { id, by, dryRun, res, log, deps = {} }) {
  for (const w of waits) {
    const { lane, why } = w;
    log(`[train] ${id}: ${lane.task} ${w.kind === 'stuck' ? 'is handed back' : 'waits'}: ${why}`);
    if (w.kind === 'stuck') {
      res.dropped.push({ task: lane.task, why });
      if (dryRun) continue;
      if (lane.fromQueue) dequeue(root, lane.task);
      ev('dropped', id, `${lane.task} handed back: ${why}`, { task: lane.task, agent: by, to: lane.agent, status: 'blocked', meta: { deps: true } });
      if (!lane.own) {
        try { if (lane.branch) rememberTaskBranch(lane.task, lane.branch); } catch {}
        try { deps.handBack?.(lane, `Not landed by merge train ${id}: ${why}`, { cause: /\b(EPERM|EBUSY)\b/.test(String(why)) ? 'infra' : 'red' }); } catch (e) { log(`[train] ${id}: could not hand ${lane.task} back: ${e.message}`); }
      }
      continue;
    }
    res.deferred.push({ task: lane.task, why });
    if (dryRun) continue;
    const told = lane.fromQueue && readQueue(root).find((e) => e.task === lane.task)?.waitTold === w.key;
    if (told) continue;
    ev('deferred', id, `${lane.task} waits for a later train: ${why}`, { task: lane.task, agent: by, to: lane.agent, status: 'warn', meta: { wait: w.kind, ...(w.kind === 'after' ? { after: lane.after.task } : {}) } });
    if (lane.fromQueue) requeue(root, lane, { waitTold: w.key });
  }
}

/**
 * buildIntegration in dependency order. A lane whose dependency in this train didn't merge (it conflicted or was
 * deferred) is taken out and the rest built again: depWait [{ ...lane, why }].
 */
function buildInOrder(sc, tip, set, opts, dep) {
  const depWait = [];
  let lanes = set;
  for (let k = 0; ; k += 1) {
    const o = orderByDeps(lanes, dep.map, { done: dep.done });
    depWait.push(...o.out.map((x) => ({ ...x.lane, why: x.why })));
    const built = buildIntegration(sc, tip, o.ordered, opts);
    const lost = dep.map.size ? orderByDeps(built.included, dep.map, { done: dep.done }).out : [];
    if (!lost.length || k >= 20) return { ...built, depWait };
    depWait.push(...lost.map((x) => ({ ...x.lane, why: x.why })));
    lanes = o.ordered.filter((l) => !lost.some((x) => x.lane.task === l.task));
  }
}

/**
 * 2.69.0 (p): STUDIO_TRAIN_RELATED_FIRST: on, off, or (unset) on when the game declares a related-tests command (a
 * "related" gate in its manifest, as main has it).
 */
export function relatedFirstOn(gates = [], env = process.env) {
  const v = String(env.STUDIO_TRAIN_RELATED_FIRST || '');
  if (/^(off|0|false|no)$/i.test(v)) return false;
  if (/^(on|1|true|yes)$/i.test(v)) return true;
  return gates.some((g) => typeof g.related === 'string' && g.related.includes('{files}'));
}

/** The related tests of these files, on the scratch copy as it is now (game-gates, related-only): { ok, failures, text }. */
function relatedRun(sc, { owner, files }) {
  const env = { ...process.env, STUDIO_MAIN_ROOT: sc.root, STUDIO_LOCK_OWNER: owner, STUDIO_GATE_PRIORITY: 'landing', STUDIO_GATE_RELATED: 'on', STUDIO_GATE_RELATED_ONLY: 'on' };
  for (const k of ['STUDIO_GATE_CHANGED', 'STUDIO_GATE_PATHS', 'STUDIO_GATE_INCOMING_FILE', 'STUDIO_GATE_FOCUS', 'STUDIO_VERIFY_RUN', 'npm_lifecycle_event', 'STUDIO_TASK_BASE']) delete env[k];
  const r = spawnSync(process.execPath, [path.join(sc.dir, 'harness', 'game-gates.mjs'), '--json', '--paths', files.join(','), '--changed', files.join(',')], { cwd: sc.dir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  let j = null;
  try { j = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch {}
  const failed = (j?.failed || []);
  const failures = failed.flatMap((f) => (f.failures?.length ? f.failures.map((t) => `${f.id}: ${t}`) : [`${f.id}: ${String(f.why || 'failed').slice(0, 160)}`]));
  return { ok: r.status === 0 && Boolean(j?.ok), ran: (j?.rows || []).filter((x) => x.related).map((x) => x.id), failures, judged: Boolean(j), text: `${r.stdout || ''}${r.stderr || ''}` };
}

/**
 * 2.69.0 (p): related tests first. Before the full verify of a multi-lane train, each lane's related tests (the game's
 * "related" command on the lane's own changed files, as a lane verify runs them with STUDIO_GATE_RELATED) run on the
 * COMBINED tree in the scratch copy. A lane whose related tests fail there, and pass on main's tip alone (so main isn't
 * the red), is handed back at once with the failing tests (and the 2.66 facts block), without a full verify or a
 * bisection. A run that judges nothing (no related command, no code files) drops nobody. Returns the lanes dropped.
 */
function relatedFirst({ sc, root, id, tip, set, built, settings, log, res, drop }) {
  if (set.length < 2) return [];
  const gates = manifestGates(root, tip, settings.manifest);
  if (!relatedFirstOn(gates)) return [];
  const gameRoot = settings.gameRoot ? `${String(settings.gameRoot).replace(/\\/g, '/').replace(/\/$/, '')}/` : null;
  const t0 = Date.now();
  const dropped = [];
  let moved = false;
  res.relatedFirst = { ran: 0, dropped: [] };
  for (const l of set) {
    const base = out(git(root, 'merge-base', tip, l.head)) || tip;
    const files = [...new Set(laneFiles(root, base, l.head).filter((f) => f.status !== 'D').map((f) => f.path))].filter((f) => (!gameRoot || f.startsWith(gameRoot)) && fs.existsSync(path.join(sc.dir, f)));
    if (!files.length) continue;
    const run = relatedRun(sc, { owner: `train-${id}-rel`, files });
    res.relatedFirst.ran += 1;
    if (run.ok || !run.judged || !run.failures.length) { if (run.ran.length) log(`[train] ${id}: related-first: ${l.task}'s related tests pass on the combined tree (${run.ran.join(', ')})`); continue; }
    // Red: the same tests on main's tip alone. Red there too: main is red, not this lane; the full verify decides.
    git(sc.dir, 'reset', '-q', '--hard', tip);
    moved = true;
    const tipFiles = files.filter((f) => fs.existsSync(path.join(sc.dir, f)));
    const onTip = tipFiles.length ? relatedRun(sc, { owner: `train-${id}-rel`, files: tipFiles }) : { failures: [] }; // new files only: nothing on tip to fail
    const fresh = run.failures.filter((f) => !onTip.failures.includes(f));
    git(sc.dir, 'reset', '-q', '--hard', built.head);
    const logFile = path.join(root, TRAIN_DIR, `${id}-related-${l.task}.log`);
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, run.text); } catch {}
    const rel = path.relative(root, logFile).split(path.sep).join('/');
    if (!fresh.length) { log(`[train] ${id}: related-first: ${l.task}'s related tests fail on main's tip too (${run.failures.slice(0, 3).join('; ')}): not handed back; the full verify decides`); continue; }
    const why = `its related tests fail on the combined train tree (related-first, before the full verify; they pass on ${mainBranch(root)}'s tip): ${fresh.slice(0, 5).join('; ')}${fresh.length > 5 ? ` (+${fresh.length - 5} more)` : ''}; log ${rel}`;
    log(`[train] ${id}: related-first: ${l.task} handed back without a full verify: ${fresh.slice(0, 3).join('; ')}`);
    drop(l, why);
    dropped.push(l);
    res.relatedFirst.dropped.push({ task: l.task, failures: fresh.slice(0, 20), log: rel });
  }
  if (moved) git(sc.dir, 'reset', '-q', '--hard', built.head);
  if (res.relatedFirst.ran) ev('related_first', id, `related tests first on the combined tree: ${res.relatedFirst.ran} lane(s) checked in ${Math.round((Date.now() - t0) / 1000)} s${dropped.length ? `; handed back ${dropped.map((l) => l.task).join(', ')}` : ', all green'}`, { meta: res.relatedFirst });
  return dropped;
}

/** Scratch copies and train/* branches a killed train left (only called while holding the train lock). */
function sweepScratch(root, log) {
  const d = path.join(root, LANES_DIR);
  let names = [];
  try { names = fs.readdirSync(d).filter((n) => n.startsWith('_train-')); } catch {}
  for (const n of names) { removeScratch({ dir: path.join(d, n), root, name: n, branch: `train/${n.slice('_train-'.length)}` }); log(`[train] removed ${LANES_DIR}/${n}, left by a train that didn't finish`); }
  for (const b of out(git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/train/')).split('\n').filter(Boolean)) git(root, 'branch', '-D', b);
}

// ---- 2.67.0 (f): the proactive chain-tail fixer (harness/train-tail.mjs) -----------------------------------------

/**
 * Chain lanes whose tail (filed by an earlier train, the chain deferred for it) is open on the board and not in this
 * train: they wait, before anything is spent on them ([{ lane, kind: 'tail', key, why }], as laneWaits).
 */
function chainTailWaits(root, lanes, deps = {}) {
  if (!chainTailOn()) return [];
  const recs = readTails(root).filter((r) => r.waiting && r.tail);
  if (!recs.length) return [];
  const ctx = depContext(root, deps);
  const here = new Set(lanes.map((l) => l.task));
  const out = [];
  for (const r of recs) {
    if (ctx.done.has(r.tail) || !ctx.states.open.has(r.tail) || here.has(r.tail)) continue;
    for (const l of lanes) if ((r.chain || []).includes(l.task) && !out.some((w) => w.lane === l)) out.push({ lane: l, kind: 'tail', key: `tail:${r.tail}`, why: tailWaitWhy(r) });
  }
  return out;
}

/** The game's checks as its manifest lists them on main's tip ([{ id, command, focus? }]). */
function manifestGates(root, tip, rel) {
  if (!rel) return [];
  let text = tip ? out(git(root, 'show', `${tip}:${rel}`)) : '';
  if (!text) { try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch {} }
  try { return (JSON.parse(text).gates || []).filter((g) => g && g.id && g.command); } catch { return []; }
}

/** Run only the game checks on these test files (run-gates --only, STUDIO_GATE_FOCUS: a partial run, no verify). */
function tailRun(sc, { id, n, focus, changed, log }) {
  const root = sc.root;
  const owner = `train-${id}-tail`;
  const env = { ...process.env, STUDIO_MAIN_ROOT: root, STUDIO_LOCK_OWNER: owner, STUDIO_GATE_PRIORITY: 'landing', STUDIO_VERIFY_DETACH: 'off', STUDIO_GATE_FOCUS: JSON.stringify(focus) };
  for (const k of ['STUDIO_GATE_CHANGED', 'STUDIO_GATE_PATHS', 'STUDIO_GATE_INCOMING_FILE', 'STUDIO_VERIFY_RUN', 'npm_lifecycle_event', 'STUDIO_TASK_BASE']) delete env[k];
  if (changed.length) { env.STUDIO_GATE_CHANGED = changed.join(','); env.STUDIO_GATE_PATHS = changed.join(','); }
  const gates = gameGateIds(root);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(sc.dir, 'scripts', 'run-gates.mjs'), '--no-detach', '--only', gates.join(',')], { windowsHide: true, cwd: sc.dir, env: gateEnv(env), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const logFile = path.join(root, TRAIN_DIR, `${id}-chain-tail-${n}.log`);
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, text); } catch {}
  for (const f of [`${owner}.json`, `${owner}-full.json`]) { try { fs.rmSync(path.join(root, '.studio', 'gates', f), { force: true }); } catch {} }
  log(`[train] ${id}: chain-tail check ${n}: ${r.status === 0 ? 'green' : 'red'} in ${Math.round((Date.now() - t0) / 1000)} s`);
  return { ok: r.status === 0, text, log: path.relative(root, logFile).split(path.sep).join('/') };
}

/**
 * Before the verify: each chain of this train (train-tail.mjs trainChains) built alone on main in a second scratch
 * copy, its touched test files run (focused) and the pins' report taken on main and on it; red (and not fixed by the
 * pin refresh the train would make): ONE tail task stacked on its last lane (deduped by chain + failure signature).
 * res.chainTails: the chains red here, with their tail. Never throws; a check that can't run says why and is skipped.
 */
async function chainTailCheck({ root, id, tip, set, settings, depInfo, log, res, by, deps, main }) {
  res.chainTails = [];
  if (!chainTailOn() || !set.length) return;
  const records = readTails(root);
  const pinsOf = (l) => pinMoves(root, out(git(root, 'merge-base', tip, l.head)) || tip, l.head);
  const chains = trainChains(set, depInfo.map, { pinsOf, tails: records });
  if (!chains.length) return;
  const gameRoot = settings.gameRoot || null;
  const gates = manifestGates(root, tip, settings.manifest);
  const sid = `${id}-tail`;
  writeTrainStatus(root, id, { step: 'chain-tail', text: `chain-tail check before the verify: ${chains.map((c) => c.tasks.join(' + ')).join('; ')}`, lanes: res.trainLanes || null, round: 1, eta: null });
  const sc2 = makeScratch(root, sid, tip);
  if (sc2.error) { log(`[train] ${id}: no chain-tail check (the second scratch copy: ${sc2.error})`); return; }
  try {
    const cache = new Map();
    let base = null;
    if (settings.pins) {
      const b0 = buildIntegration(sc2, tip, [], { id: sid });
      base = pinReport(sc2, settings.pins, { id: sid, k: 'main', tree: b0.tree, cache, log });
      if (base.error) log(`[train] ${id}: chain-tail check: no pin diff (${base.error})`);
    }
    let n = 0;
    for (const ch of chains) {
      const names = ch.tasks.join(', ');
      const b = buildIntegration(sc2, tip, ch.lanes, { id: sid, unionFiles: settings.unionFiles || [] });
      if (b.included.length !== ch.lanes.length) { log(`[train] ${id}: chain-tail check: ${names} doesn't merge alone onto ${main}; not checked (the train's build says why)`); continue; }
      const changed = changedVs(sc2.dir, tip, b.head);
      const tests = touchedTests(changed.filter((f) => fs.existsSync(path.join(sc2.dir, f))), gameRoot);
      const fx = chainFocus(gates, tests, gameRoot);
      for (const s of fx.skipped) log(`[train] ${id}: chain-tail check: ${s.id} not run on single files (${s.why})`);
      // The pin diff: the pins' report on main and on main + the chain, each move checked against the chain's Pin-Moves.
      let moved = [];
      let rep = null;
      if (settings.pins && base && !base.error) {
        rep = pinReport(sc2, settings.pins, { id: sid, k: `chain-${n + 1}`, tree: b.tree, cache, log });
        if (rep.error) log(`[train] ${id}: chain-tail check: no pin diff for ${names} (${rep.error})`);
        else {
          const keys = [...new Set([...Object.keys(base.report), ...Object.keys(rep.report)])].sort();
          moved = keys.filter((p) => stable(base.report[p]) !== stable(rep.report[p])).map((p) => ({ pin: p, from: short(base.report[p] ?? null), to: short(rep.report[p] ?? null), declaredBy: Object.entries(ch.pins).filter(([, g]) => pinNameMatches(p, g)).map(([t]) => t), invariant: pinNameMatches(p, settings.pins.invariants) }));
        }
      }
      if (!fx.focus) { log(`[train] ${id}: chain-tail check: ${names}: ${tests.length ? 'no game check can run single test files' : 'touches no test file'}; ${moved.length ? `pin diff only: ${pinDiffLines(moved).join('; ')}` : 'nothing to run'}`); continue; }
      n += 1;
      log(`[train] ${id}: chain-tail check ${n}: ${main} + ${ch.tasks.join(' + ')} in a second copy, before the verify: ${tests.length} touched test file(s) (${tests.slice(0, 4).join(', ')}${tests.length > 4 ? ' ...' : ''})${settings.pins ? `, pin diff: ${moved.length ? pinDiffLines(moved).join('; ') : 'none'}` : ''}`);
      let run = tailRun(sc2, { id, n, focus: fx.focus, changed, log });
      if (run.ok) { log(`[train] ${id}: chain ${names} is green on its touched tests: no tail needed`); continue; }
      const failing = failingTests(run.text);
      // Pins only, every move declared, no invariant: the train's own pin refresh may fix it; try it in this copy.
      if (settings.pins && rep && !rep.error && moved.length && failing.tests.length && failing.tests.every((t) => isPinTest(t, settings.pins.tests)) && moved.every((m) => m.declaredBy.length && !m.invariant)) {
        const cmd = settings.pins.refresh.split('{in}').join(`"${rep.file}"`);
        const env = mergeEnv();
        const rr = spawnSync(cmd, { windowsHide: true, cwd: sc2.dir, shell: true, encoding: 'utf8', env: /^(off|0|false|no)$/i.test(process.env.STUDIO_GAME_GATE_CI || '') ? env : { ...env, CI: 'true' }, maxBuffer: 64 * 1024 * 1024, timeout: Number(process.env.STUDIO_GAME_GATE_TIMEOUT_MS || 600000) });
        if (rr.status === 0) {
          const again = tailRun(sc2, { id, n: `${n}-refreshed`, focus: fx.focus, changed, log });
          if (again.ok) {
            log(`[train] ${id}: chain ${names}: red only on declared pins, and the pin refresh makes it green: the train's pin refresh covers it, no tail`);
            ev('chain_tail', id, `chain ${names}: red only on declared pins (${pinDiffLines(moved).join('; ')}); the pin refresh makes its tests green, so no tail is filed`, { agent: by, status: 'ok', meta: { action: 'pin_refresh', chain: ch.core, tests: failing.tests, pins: moved } });
            continue;
          }
          run = { ...run, refreshTried: true };
        }
      }
      const sig = tailSignature(failing.tests, failing.checks);
      const known = records.find((r) => r.key === ch.key && r.sig === sig);
      const tests1 = failing.tests.length ? failing.tests : failing.checks;
      if (known) {
        res.chainTails.push({ key: ch.key, sig, tail: known.tail, chain: ch.core, lanes: ch.tasks, tests: known.tests?.length ? known.tests : tests1, known: true });
        log(`[train] ${id}: chain ${names} is red on ${tests1.slice(0, 3).join('; ')}; its tail ${known.tail} (train ${known.train}) is already filed for this failure: not filed again`);
        ev('chain_tail', id, `chain ${names}: red again on the same tests; its tail ${known.tail} is already filed (not filed again)`, { task: known.tail, agent: by, status: 'warn', meta: { action: 'known', chain: ch.core, tail: known.tail, sig, tests: tests1 } });
        continue;
      }
      const lanesInfo = ch.lanes.filter((l) => ch.core.includes(l.task)).map((l) => ({ task: l.task, head: l.head }));
      const title = tailTitle(ch.core, failing.tests, failing.checks);
      let t = null;
      try { t = deps.fileTask ? deps.fileTask({ title, after: ch.last.task, chain: ch.core, train: id }) : null; } catch (e) { log(`[train] ${id}: chain-tail task not filed: ${e.message}`); }
      if (!t?.id || t.error || t.proposed) { log(`[train] ${id}: chain ${names} is red on ${tests1.slice(0, 3).join('; ')}, but no tail task was filed (${t?.message || 'no board here'})`); continue; }
      try {
        const f = path.join(root, 'studio', 'handoffs', `${t.id}.md`);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.appendFileSync(f, tailNote({ tail: t.id, train: id, chain: lanesInfo, tests: failing.tests, checks: failing.checks, pins: moved, log: run.log, main, pinsRun: Boolean(settings.pins) }));
      } catch {}
      const rec = { key: ch.key, sig, tail: t.id, chain: ch.core, last: ch.last.task, tests: tests1, pins: moved, train: id, at: new Date().toISOString(), log: run.log };
      updateTails(root, (list) => { list.push(rec); });
      records.push(rec);
      res.chainTails.push({ key: ch.key, sig, tail: t.id, chain: ch.core, lanes: ch.tasks, tests: tests1 });
      log(`[train] ${id}: chain ${names} fails ${tests1.slice(0, 3).join('; ')}${tests1.length > 3 ? ` (+${tests1.length - 3} more)` : ''} on the combined tree: opened ${t.id} (chain tail, builder, stacked on ${ch.last.task}${t.duplicate ? ', already on the board' : ''}); its note: studio/handoffs/${t.id}.md. If the verify fails on exactly these tests, the chain waits for ${t.id} instead of being bisected`);
      ev('chain_tail', id, `chain ${names} is red on its touched tests before the verify (${tests1.slice(0, 3).join('; ')}${moved.length ? `; pin diff: ${pinDiffLines(moved).join('; ')}` : ''}): opened ${t.id}, a builder task stacked on ${ch.last.task}`, { task: t.id, agent: by, to: 'builder', status: 'warn', meta: { action: 'opened', chain: ch.core, tail: t.id, last: ch.last.task, sig, tests: tests1, pins: moved, log: run.log } });
    }
  } finally {
    removeScratch(sc2);
  }
}

/**
 * After a red verify: are its failing tests exactly those of chain(s) found red before it (res.chainTails)? Then
 * { tails, lanes } (the lanes of those chains in this set, tails included); else null (handled as before).
 */
function chainTailDefer(ctx, { set, v, text }) {
  const { root, res } = ctx;
  if (!chainTailOn() || !res.chainTails?.length) return null;
  const games = gameGateIds(root);
  if (!v.gates?.length || v.gates.some((g) => !games.includes(g))) return null;
  const vt = failingTests(text).tests;
  const tails = tailsExplaining(vt, res.chainTails);
  if (!tails.length) return null;
  const names = new Set(tails.flatMap((t) => t.lanes));
  const lanes = set.filter((l) => names.has(l.task));
  return lanes.length ? { tails, lanes, tests: vt } : null;
}

/**
 * 2.73.2 (d, B-75): with main stuck red on a game check (harness/train-fix-first.mjs), the first lane that changes that
 * check's configuration goes first and alone (its runAlone), with a task.train.fix_first event naming why.
 */
function fixFirst(root, lanes, { id, by, dryRun, log }) {
  let r;
  try {
    const tip = out(git(root, 'rev-parse', `refs/heads/${mainBranch(root)}`));
    r = fixFirstOrder(root, lanes, { tip, gameIds: gameGateIds(root), headOf: (l) => laneNow(l).head || null });
  } catch (err) { log(`[train] ${id}: WARN fix-first: ${err.message}`); return lanes; }
  if (r.note) log(`[train] ${id}: fix-first: ${r.note}`);
  if (!r.fix) return lanes;
  log(`[train] ${id}: ${r.fix.task} first: ${r.fix.why}`);
  if (!dryRun) {
    ev('fix_first', id, `${r.fix.task} trains alone and first: ${r.fix.why}`, { task: r.fix.task, agent: by, status: 'warn', meta: { gates: r.fix.gates, files: r.fix.files, head: r.fix.head } });
  }
  return r.lanes;
}

/**
 * 2.78.2 (b): the red chain ran past its budget (STUDIO_TRAIN_RED_BUDGET_MIN). The newest lane of the train (the one
 * queued last: the most likely cause) is handed back with the red's summary; of the others, the longest prefix (in the
 * train's order) whose exact tree a full verify has already passed (this train's own, or a trusted record that covers
 * it: verifyTree noRun, which runs no verify) is returned as the verdict to land; the rest keep their place in the queue
 * (keepOrHold: a second time at the same head they are held for the Producer). No full verify passed: nothing lands.
 * Logs task.train.red_budget. Returns the verdict ({ built, v }) or null.
 */
function redBudgetEnd({ marker, sc, tip, set, id, log, res, seen, by, unionFiles, drop, keepOrHold }) {
  redClock.delete(String(id));
  const red = marker.red || {};
  const redLine = `${red.why || 'the verify was red'}${red.tests?.length ? `; failing: ${red.tests.join('; ')}` : ''}${red.log ? `; log ${red.log}` : ''}`;
  res.redBudget = { why: marker.why, minutes: marker.minutes ?? null };
  if (!set.length) {
    log(`[train] ${id}: the red chain ran past its budget (${marker.why}), with no lane left riding`);
    ev('red_budget', id, `the red chain ran past its budget (${marker.why}); no lane left riding`, { agent: by, to: 'producer', status: 'warn', meta: { why: marker.why, red: redLine } });
    return null;
  }
  const at = (l) => Date.parse(l.at || '') || 0;
  let newest = set[set.length - 1];
  for (const l of set) if (at(l) > at(newest)) newest = l;
  const rest = set.filter((l) => l !== newest);
  drop(newest, `the red chain of this train ran past its time budget (${marker.why}) before it found who breaks the checks. ${newest.task} is the newest lane in the train, the most likely cause, so it is handed back${rest.length ? ` (the others: ${rest.map((l) => l.task).join(', ')})` : ''}. The red: ${redLine}. Run npm run verify in your copy: if it is green there, the red may be another lane's or the machine's load; say so in your note and task done again`);
  let verdict = null;
  let k = 0;
  for (let j = rest.length; j >= 1 && !verdict; j -= 1) {
    const pre = rest.slice(0, j);
    const b = buildIntegration(sc, tip, pre, { id, unionFiles });
    if (b.included.length !== j) continue;
    const v = verifyTree(sc, { id, n: res.verifies + 1, tree: b.tree, changed: changedVs(sc.dir, tip, b.head), all: pre.some((l) => l.all), seen, tasks: pre.map((l) => l.task), lanes: pre, log, noRun: true });
    if (v.ok) { verdict = { built: b, v }; k = j; if (v.reused) res.reused += 1; }
  }
  const landing = rest.slice(0, k).map((l) => l.task);
  const after = rest.slice(k);
  const why = `train ${id}'s red chain ran past its budget (${marker.why}); ${newest.task} was handed back${landing.length ? ` and ${landing.join(', ')} land on a green full verify` : ''}; it goes in the next train`;
  for (const l of after) keepOrHold(l, 'redBudgetIn', why, 'a train ran out of its red budget');
  const msg = `the red chain ran past its budget (${marker.why}): ${newest.task} (the newest lane, the most likely cause) handed back; ${landing.length ? `${landing.join(', ')} land on a green full verify of their tree` : 'no prefix of the others has a green full verify, so nothing lands'}${after.length ? `; ${after.map((l) => l.task).join(', ')} re-queued` : ''}. The red: ${redLine}`;
  log(`[train] ${id}: ${msg}`);
  ev('red_budget', id, msg, { agent: by, to: 'producer', status: 'warn', meta: { why: marker.why, minutes: marker.minutes ?? null, handedBack: newest.task, landing, requeued: after.map((l) => l.task), red: redLine } });
  return verdict;
}

async function trainBody({ root, log, deps, id, by, lanes: given, max, dryRun = false, oneLane = false, rideAlong = false, life = null }) {
  const res = { ok: true, id, landed: [], dropped: [], deferred: [], held: [], tiers: {}, verifies: 0, reused: 0, message: '' };
  sweepScratch(root, log);
  const queued = !given;
  const rules = batchRules();
  // 2.77.0 (p, P9.6): a train takes at most STUDIO_TRAIN_BATCH lanes (default 4), beside --max and STUDIO_TRAIN_MAX.
  let maxLanes = batchCap({ max, rulesMax: rules.max });
  // 2.77.0 (maintainer): the DEFAULT batch of 4 only splits the queue when a speculative train can follow (pipeline on,
  // or auto with room for a second verify); otherwise one train takes them all, the 2.76 way, so 6 green lanes still
  // land on one verify. A STUDIO_TRAIN_BATCH that is set always applies.
  if (!given && String(process.env.STUDIO_TRAIN_BATCH ?? '').trim() === '' && maxLanes === batchSize()) {
    const mode = pipelineMode();
    let room = mode === 'on';
    if (mode === 'auto') { try { room = Boolean((await (deps.pipelineRoom || pipelineRoom)({ root }))?.ok); } catch { room = false; } }
    if (!room) maxLanes = batchCap({ max, rulesMax: rules.max, env: { ...process.env, STUDIO_TRAIN_BATCH: 'off' } });
  }
  let lanes = given ? given.map((l) => ({ ...l, own: oneLane })) : readQueue(root).map((l) => ({ ...l, fromQueue: true }));
  // 2.63.0: a lane held for the owner (tier C, or handed back too often) stays in the queue until a person releases it.
  clearContractHolds(root, lanes, log); // 2.72.0 (c): a reviewer's signature clears a contract-only hold
  const stillHeld = lanes.filter((l) => l.fromQueue && heldNow(l));
  for (const l of stillHeld) { res.held.push({ task: l.task, tier: l.held.tier, why: l.held.why, fresh: false }); log(`[train] ${id}: ${l.task} needs the owner (tier ${l.held.tier}: ${l.held.why}); npm run task -- train release ${l.task} --by <name> lands it`); }
  lanes = lanes.filter((l) => !stillHeld.includes(l));
  // 2.67.2: a task held for landing (npm run task -- hold) stays out of trains: queued, ridden along or its own task done.
  for (const l of lanes.filter((x) => taskHoldOf(root, x.task))) {
    const why = heldOutWhy(taskHoldOf(root, l.task)).replace('<ID>', l.task);
    res.deferred.push({ task: l.task, why });
    log(`[train] ${id}: ${l.task} left out: ${why}`);
    if (!dryRun) ev('deferred', id, `${l.task} left out of this train: ${why}`, { task: l.task, agent: by, to: l.agent, status: 'warn', meta: { held: true } });
  }
  lanes = lanes.filter((l) => !taskHoldOf(root, l.task));
  // 2.63.0 (ride along): a lone task done takes the lanes already queued for the next train with it.
  if (given && rideAlong) {
    const riders = readQueue(root).filter((e) => !given.some((g0) => g0.task === e.task) && !heldNow(e) && !taskHoldOf(root, e.task)).map((e) => ({ ...e, fromQueue: true, rider: true }));
    lanes.push(...riders);
  }
  // 2.65.0 (B-34, 3.3): lanes queued after a predicted conflict, or whose --after dependencies haven't landed, wait
  // here: before any check, tier or verify is spent on them (laneWaits; deferral logged once per reason).
  const waits = laneWaits(root, lanes, deps);
  // 2.67.0 (f): a chain deferred for its tail waits until the tail is queued (harness/train-tail.mjs).
  waits.push(...chainTailWaits(root, lanes.filter((l) => !waits.some((w) => w.lane === l)), deps));
  lanes = lanes.filter((l) => !waits.some((w) => w.lane === l));
  lanes = fixFirst(root, lanes, { id, by, dryRun, log }); // 2.73.2 (d, B-75), before the cap so the fix is never cut
  // 2.77.0 (p, P9.6): the lanes past the cap wait for the next train (behind this one's speculative train, if any).
  if (maxLanes > 0 && lanes.length > maxLanes) { res.batchCut = lanes.slice(maxLanes).map((l) => l.task); lanes = lanes.slice(0, maxLanes); log(`[train] ${id}: ${res.batchCut.length} more lane(s) wait for the next train (at most ${maxLanes} per train: STUDIO_TRAIN_BATCH ${batchSize() || 'off'}, STUDIO_TRAIN_MAX ${rules.max || 0}${Number(max) > 0 ? `, --max ${max}` : ''}): ${res.batchCut.join(', ')}`); }
  if (!lanes.length && waits.length) { waitActions(root, waits, { id, by, dryRun, res, log, deps }); res.ok = !res.dropped.length; res.message = summary(res); ev('done', id, res.message, { agent: by, meta: brief(res) }); return res; }
  if (!lanes.length) { res.message = res.held.length ? `No lane can land now: ${res.held.map((h) => `${h.task} needs the owner (tier ${h.tier})`).join('; ')}.` : 'No lane is waiting to land (the train queue is empty: task done <ID> --train adds one).'; return res; }
  ev('start', id, `${lanes.length} lane(s): ${lanes.map((l) => l.task).join(', ')}${dryRun ? ' (dry run)' : ''}`, { agent: by, meta: { lanes: lanes.map((l) => l.task), dryRun, ...(lanes.some((l) => l.rider) ? { riders: lanes.filter((l) => l.rider).map((l) => l.task) } : {}) } });
  (await import('./hotspots.mjs')).trainStart(root, lanes, log, id); // 2.60.0 (helper b): lines two lanes change, in the start log
  const drop = (lane, why, { handBack = true, infra = false, cause = null } = {}) => {
    // 2.79 (b): why the lane left, as a field the hand-back cap counts by (handBackCount): 'red' (its own check failed),
    // 'conflict', or 'infra' (the harness or the machine: a copy made again, a dead train, EPERM). Never read from prose.
    const why0 = cause || (infra || /\b(EPERM|EBUSY)\b/.test(String(why)) || INFRA_HANDBACK.test(String(why)) ? 'infra' : 'red');
    res.dropped.push({ task: lane.task, why });
    if (dryRun) return;
    if (queued || lane.fromQueue) dequeue(root, lane.task);
    ev('dropped', id, `${lane.task} handed back: ${why}`, { task: lane.task, agent: by, to: lane.agent, status: 'blocked', ...(why0 === 'infra' ? { meta: { infra: true } } : {}) });
    if (handBack && !lane.own) {
      try { if (lane.branch) rememberTaskBranch(lane.task, lane.branch); } catch {}
      // 2.72.0 (b): a train red is a round of the lane's task (harness/round-cap.mjs); red twice in a row on one failure adds
      // the cap's summary and its restart-from-the-spec note to the hand-back.
      let capNoteText = '';
      try { const rc = trainRound(lane, why); if (rc?.capped) capNoteText = `\n${rc.note}`; } catch {}
      try { deps.handBack?.(lane, withFacts(lane.task, `Not landed by merge train ${id}: ${why}${capNoteText}`, { agent: lane.agent, dir: lane.dir, root, withNext: false }), { cause: why0 }); } catch (e) { log(`[train] ${id}: could not hand ${lane.task} back: ${e.message}`); }
    }
  };
  const defer = (lane, why) => { res.deferred.push({ task: lane.task, why }); if (!dryRun) ev('deferred', id, `${lane.task} waits for the next train: ${why}`, { task: lane.task, agent: by, to: lane.agent, status: 'warn' }); };
  const hold = (lane, tier, why, extra = {}) => {
    res.held.push({ task: lane.task, tier, why, fresh: true, ...(extra.beta ? { beta: true } : {}) });
    // 2.76.0: a beta hold (the hand-back cap in beta mode) waits for the orchestrator or the Producer, not a person.
    const who = extra.beta ? 'the orchestrator or the Producer' : 'a person';
    log(`[train] ${id}: ${lane.task} ${extra.beta ? 'goes to the orchestrator and the Producer' : 'needs the owner'} (tier ${tier}: ${why}); it waits in the train queue until ${who} releases it: npm run task -- train release ${lane.task} --by <name>`);
    if (dryRun) return;
    const h = holdLane(root, lane, { tier, why, ...extra });
    if (h.fresh) ev('held', id, `${lane.task} ${extra.beta ? 'is held for the orchestrator and the Producer (beta mode)' : 'needs the owner'} (tier ${tier}): ${why}. It waits in the queue; ${who} releases it with npm run task -- train release ${lane.task} --by <name>${extra.beta ? '' : ' [--permission "…"]'}`, { task: lane.task, agent: by, to: 'producer', status: 'blocked', meta: { tier, why, ...(extra.beta ? { beta: true } : {}) } });
  };
  // 2.77.3 (H2, C2): an attempt that ended for no fault of the lane (the train stalled; a port collision): the lane keeps
  // its place in the queue (queued if it wasn't: a task done's own lane), marked with `key`; a second time at the same
  // head (another train) it is held for the Producer instead, so it can't loop. Never a hand-back.
  const keepOrHold = (lane, key, why, what) => {
    if (dryRun) { defer(lane, why); return 'kept'; }
    let e = null;
    try { e = readQueue(root).find((x) => x.task === lane.task) || null; } catch {}
    const head = lane.head || e?.head || null;
    if (e?.[key]?.head && head && e[key].head === head && e[key].train !== id) {
      hold(lane, 'B', `${what} twice with ${lane.task} at ${String(head).slice(0, 8)} (train ${e[key].train}, then ${id}): ${why}; the Producer looks before it trains again`);
      return 'held';
    }
    const mark = { [key]: { train: id, head, at: new Date().toISOString() } };
    try {
      if (e) requeue(root, lane, mark);
      else enqueue(root, { task: lane.task, agent: lane.agent, dir: lane.dir, branch: lane.branch, head, all: Boolean(lane.all), note: `queued again: ${what}`, ...mark });
    } catch {}
    defer(lane, why);
    return 'kept';
  };

  waitActions(root, waits, { id, by, dryRun, res, log, deps });

  // (a) The lanes, as they are now: tier (2.63.0), then each checked again in its own copy.
  const tip0 = out(git(root, 'rev-parse', `refs/heads/${mainBranch(root)}`));
  const settings0 = await trainManifest(root, tip0);
  const queueNow = readQueue(root);
  const ready = [];
  for (const lane of lanes) {
    // A rider goes only with the caller's own lane: if that one can't go, the riders wait for the next train.
    if (lane.rider && !ready.some((l) => l.own)) continue;
    let now = laneNow(lane);
    // 2.76.0 (W-0081): a copy that is gone is made again from its branch, not handed back.
    if (now.error && lane.dir && (!fs.existsSync(lane.dir) || now.leftover)) {
      if (dryRun) log(`[train] ${id}: ${lane.task}: ${now.error}; a train would make it again from ${lane.branch || 'its branch'}`);
      else {
        const rc = recreateLaneCopy(root, lane, { log: (m) => log(m.replace('[train] ', `[train] ${id}: `)) });
        if (rc.ok) { ev('lane_recreated', id, `${lane.task}: its lane copy was gone; made again from ${rc.branch} at ${rc.head.slice(0, 8)}`, { task: lane.task, agent: by, to: lane.agent, status: 'warn', meta: { dir: rc.dir, branch: rc.branch, head: rc.head, infra: true } }); now = laneNow(lane); }
        else now = { error: `${now.error}, and it couldn't be made again from its branch: ${rc.why}` };
      }
    }
    if (now.error) { drop(lane, now.error, { handBack: false, infra: true }); continue; }
    if (lane.branch && now.branch && now.branch !== lane.branch) { drop(lane, `its copy is on ${now.branch} now, not ${lane.branch}; queue it again`, { handBack: false }); continue; }
    // 2.76.0 (B-91/B-92): a lane carrying another open task's commits (Studio-Task trailers) is refused before anything
    // is spent on it, naming them (harness/train-lanes.mjs mixedLane). Not counted toward the hand-back cap.
    if (!/^(off|0|false|no)$/i.test(process.env.STUDIO_TRAIN_MIXED || '')) {
      const dc = depContext(root, deps);
      const openNow = dc.states?.open;
      const allowed = mayCarry(root, lane.task, dc.map);
      const m = mixedLane(root, { task: lane.task, tip: out(git(root, 'rev-parse', `refs/heads/${mainBranch(root)}`)), head: now.head, open: (t) => (openNow ? openNow.has(t) : true) && !allowed.has(t) });
      if (m.mixed) { if (!dryRun) noteMixed(id, lane, m, by); drop(lane, m.why, { infra: true }); continue; }
    }
    // 2.76.0 (B-81): a lane whose harness is behind main (an upgrade's refresh that didn't finish) is refreshed here
    // (harness/train-refresh.mjs), not handed back by its hooks check; only a real conflict hands it back.
    if (!dryRun) {
      const rf = await (deps.refreshStale || refreshStaleLane)(root, { ...lane, head: now.head }, { log });
      if (rf.handBack) { drop(lane, rf.why, { cause: 'conflict' }); continue; }
      if (rf.refreshed) { now = laneNow(lane); if (now.error) { drop(lane, now.error, { handBack: false }); continue; } }
    }
    // 2.63.0: the lane's blast-radius tier, from its own diff (code, never a model's confidence).
    const c = await laneTier(root, { head: now.head, task: lane.task, agent: lane.agent, dir: lane.dir }, { tip: tip0, settings: settings0 });
    const entry = queueNow.find((e) => e.task === lane.task);
    // 2.76.0: a release kept for this task and head (.studio/train/releases.json) counts too: an infrastructure hand-back
    // (lane copy missing, a re-queue, a dead train) that took the entry out of the queue never voids it.
    // 2.79 (c): a release made at an older head whose lane content is the same now (a catch-up merge of main, a re-queue)
    // is carried to this head, in the queue entry and in the kept releases, instead of voided.
    const carriedNow = entry?.released && !releasedFor(entry, now.head) ? carriedRelease(root, entry.released, { head: now.head, tip: tip0 }) : null;
    if (carriedNow && entry) { entry.released = carriedNow; if (!dryRun) { try { requeue(root, { task: lane.task }, { released: carriedNow }); keepRelease(root, lane.task, carriedNow); } catch {} log(`[train] ${id}: ${lane.task}: ${carriedNow.by}'s release at ${String(carriedNow.carriedFrom.at(-1)).slice(0, 8)} still covers ${String(now.head).slice(0, 8)} (the lane's own changes are the same)`); } }
    const kept = releasedFor(entry, now.head) ? null : keptRelease(root, lane.task, now.head, { tip: tip0 });
    if (kept && entry) { entry.released = kept; if (kept.carriedFrom && !dryRun) { try { requeue(root, { task: lane.task }, { released: kept }); keepRelease(root, lane.task, kept); } catch {} } }
    const released = releasedFor(entry, now.head) || Boolean(kept);
    const relBy = (entry?.released || kept)?.by;
    res.tiers[lane.task] = c.tier;
    log(`[train] ${id}: ${lane.task} ${tierLine(c)}${released ? ` (released by ${relBy})` : ''}${c.runAlone.yes ? `; runs alone: ${c.runAlone.why}` : ''}`);
    for (const n of c.notes) log(`[train] ${id}: ${settings0.manifest || 'manifest'}: ${n} (ignored)`);
    if (!dryRun) ev('tier', id, `${lane.task} ${tierLine(c)}${released ? ` (released by ${relBy})` : ''}`, { task: lane.task, agent: by, meta: { tier: c.tier, why: c.why, rules: c.rules, runAlone: c.runAlone.yes ? c.runAlone.why : null, released: released ? relBy : null } });
    // 2.65.0 (B-40): a config proposal that can't be applied, or conflicts with main's value now, is handed back first.
    const cp = laneProposal(root, { task: lane.task, head: now.head, tip: tip0 });
    if (cp && !cp.ok) { drop(lane, cp.why, { cause: 'conflict' }); continue; }
    if (c.tier === 'C' && !released) { hold({ ...lane, head: now.head, branch: now.branch || lane.branch }, 'C', c.why.join('; '), c.rerecord ? { rerecord: c.rerecord } : {}); continue; }
    if (c.needs.goldenReason.length) { drop(lane, `it is tier B and moves goldens (${c.needs.goldenReason.slice(0, 3).join(', ')}) with no Golden-Reason trailer on its commits: say why the recorded answers changed (git commit --amend, or a new commit, with -m "Golden-Reason: <why>"), then task done again`); continue; }
    if (c.needs.pinMoves.length) { drop(lane, `it is tier B and changes pinned expectations (${c.needs.pinMoves.slice(0, 3).join(', ')}) with no Pin-Moves trailer on its commits: declare the pins it moves ("Pin-Moves: <pin>"), then task done again`); continue; }
    if (c.tier === 'B' && !released) {
      const n = (deps.handBacks || handBackCount)(lane.task);
      if (n > maxHandBacks()) {
        // 2.76.0 (the owner's Priority 1): in beta mode the cap sends the lane to the orchestrator and the Producer (they
        // release it, no owner key) with ONE Producer rescue task, instead of waiting for a person.
        let beta = false;
        try { beta = readBeta({ root }).on; } catch {}
        if (beta) {
          const why = `handed back ${n} times (more than ${maxHandBacks()}, STUDIO_TRAIN_MAX_HANDBACKS): in beta mode the orchestrator or the Producer looks (no owner needed): fix the plan, then npm run task -- train release ${lane.task} --by <you>`;
          const fresh = !(entry?.held?.beta && entry.held.head === now.head);
          hold({ ...lane, head: now.head, branch: now.branch || lane.branch }, 'B', why, { beta: true });
          if (fresh && !dryRun) { try { const t = deps.fileRescue?.({ task: lane.task, n, why }); if (t?.id) log(`[train] ${id}: ${lane.task}: Producer task ${t.id}${t.duplicate ? ' (already open)' : ''}: ${t.title || `Rescue ${lane.task}`}`); } catch (e) { log(`[train] ${id}: ${lane.task}: couldn't file the Producer's rescue task: ${e.message}`); } }
          continue;
        }
        hold({ ...lane, head: now.head, branch: now.branch || lane.branch }, 'B', `handed back ${n} times (more than ${maxHandBacks()}, STUDIO_TRAIN_MAX_HANDBACKS): after that many tries the problem is in the plan, so a person looks before it lands`);
        continue;
      }
    }
    if (!dryRun) writeTrainStatus(root, id, { step: 'precheck', text: `checking ${lane.task} in its own copy`, lanes: lanes.length, eta: null }); // 2.76.0 (B-88)
    const pre = lane.prechecked && now.head === lane.head ? { ok: true, head: now.head, all: lane.all } : (deps.precheck || ((l) => precheckChild(root, l)))({ ...lane, head: now.head });
    // Uncommitted work: its agent is still at it, so it waits (queued). Not this agent's claim any more, or a copy whose
    // harness predates the train: out of the queue, nobody's claim touched. Any other refusal (hooks, protected files,
    // secrets, done-check) is handed back with its message.
    if (!pre.ok && pre.error === 'uncommitted') { defer(lane, pre.message || 'uncommitted work in its copy'); continue; }
    if (!pre.ok) { drop(lane, pre.message || 'its checks failed', { handBack: !['locked', 'not-found', 'old-harness'].includes(pre.error) }); continue; }
    if (pre.head && pre.head !== now.head) { drop(lane, 'its copy changed while it was checked; queue it again', { handBack: false }); continue; }
    const main = mainBranch(root);
    const ahead = Number(out(git(root, 'rev-list', '--count', `refs/heads/${main}..${now.head}`))) || 0;
    if (!ahead) { drop(lane, `it has no commits that ${main} doesn't have; task done ${lane.task} closes it`, { handBack: false }); continue; }
    // Tier B and C (released) lanes verify the whole game (--all).
    ready.push({ ...lane, head: now.head, branch: now.branch || lane.branch, all: Boolean(pre.all || lane.all || c.needs.all), tier: c.tier, runAlone: lane.fixFirst ? { yes: true, why: lane.fixFirst.why } : c.runAlone, released: released ? entry?.released || kept : null });
  }
  // 2.63.0 (run alone): a large or sim-wide lane (manifest "runAlone") trains by itself. The caller's own lane goes
  // first; in a queued train the oldest decides: a run-alone lane first goes alone, else the others go without them.
  const own = ready.find((l) => l.own);
  let group = ready;
  if (own) {
    group = own.runAlone?.yes ? [own] : ready.filter((l) => l === own || !l.runAlone?.yes);
    for (const l of ready.filter((x) => !group.includes(x))) log(`[train] ${id}: ${l.task} stays queued for the next train (${own.runAlone?.yes ? `${own.task} runs alone: ${own.runAlone.why}` : `it runs alone: ${l.runAlone.why}`})`);
  } else if (ready.length > 1) {
    group = ready[0].runAlone?.yes ? [ready[0]] : ready.filter((l) => !l.runAlone?.yes);
    for (const l of ready.filter((x) => !group.includes(x))) { defer(l, l.runAlone?.yes ? `it runs alone (${l.runAlone.why}): it gets a train of its own` : `${ready[0].task} runs alone (${ready[0].runAlone.why}); this lane goes in the next train`); res.more = true; }
  }
  // 2.65.0 (3.3): within one train, lanes merge in dependency order (--after).
  const depInfo = depContext(root, deps);
  group = greenFirst(root, tip0, group, { id, log, whole: wholeEquiv(root, tip0, settings0) }); // 2.69.0 (p): lanes with a green verify of their own tree go first
  { const o = orderByDeps(group, depInfo.map, { done: depInfo.done }); for (const x of o.out) defer(x.lane, x.why); group = o.ordered; }
  if (group.length > 1 || group.some((l) => l.runAlone?.yes)) log(`[train] ${id}: this train: ${group.map((l) => `${l.task} (tier ${l.tier}${l.runAlone?.yes ? ', alone' : ''})`).join(', ')}`);
  ready.splice(0, ready.length, ...group);
  if (!dryRun) for (const l of ready.filter((x) => x.fixFirst)) noteFixTried(root, l.task, l.head); // once per head (B-75)
  if (!ready.length) { res.ok = !res.dropped.length; res.message = summary(res); ev('done', id, res.message, { agent: by, meta: brief(res) }); return res; }

  const main = mainBranch(root);
  life?.lanes(ready); // 2.76.0 (B-88): a death from here on keeps these lanes moving
  writeTrainStatus(root, id, { step: 'build', text: `building main + ${ready.map((l) => l.task).join(', ')}`, lanes: ready.length, eta: null });
  for (const l of ready) deps.markRunning?.(l.task, l.agent);
  // 2.65.3 (B-43): the running train's step, for npm run lanes and status --brief; a long train is told about the cap.
  res.trainLanes = ready.length;
  { const cn = capNote(ready.length); if (cn) log(`[train] ${id}: note: ${cn}`); }
  let sc = null;
  activeLanes.set(String(id), () => ready.map((l) => l.task).filter((t) => !res.dropped.some((d) => d.task === t) && !res.landed.includes(t)));
  try {
    for (let attempt = 0; attempt < Number(process.env.STUDIO_TRAIN_TRIES || 3); attempt += 1) {
      const tip = out(git(root, 'rev-parse', `refs/heads/${main}`));
      if (!sc) {
        sc = makeScratch(root, id, tip);
        if (sc.error) { res.ok = false; res.message = `The train couldn't make its scratch copy: ${sc.error}`; sc = null; return res; }
      }
      checkCancel(root, id); // 2.77.1 (B-98)
      redClock.delete(String(id)); // 2.78.2 (b): each attempt's red chain has its own budget
      const seen = new Map();
      // 2.60.0: the game's pins and union files (its manifest, as main has it).
      const settings = await trainManifest(root, tip);
      for (const n of settings.notes) log(`[train] ${id}: ${settings.manifest}: ${n} (ignored)`);
      const unionFiles = settings.unionFiles;
      const cache = { checks: new Map(), reports: new Map() };
      let set = ready.filter((l) => !res.dropped.some((d) => d.task === l.task) && !res.deferred.some((d) => d.task === l.task) && !res.landed.includes(l.task));
      // (b) Build: main + each lane, in order.
      let built = buildInOrder(sc, tip, set, { id, unionFiles }, depInfo);
      for (const l of built.depWait) defer(l, l.why);
      if (!dryRun) (await import('./hotspots.mjs')).noteTrainConflicts(root, tip, built, { id, log }); // 2.60.0 (helper b): conflict count per line
      for (const l of built.conflictMain) drop(l, `${l.why}. Merge it into your copy (git merge ${main}), resolve the conflicts, commit, run npm run verify, then task done again`);
      for (const l of built.deferred) defer(l, l.why);
      set = built.included;
      if (dryRun) {
        res.message = `Dry run: ${set.length} lane(s) would go in one train (${set.map((l) => l.task).join(', ') || 'none'}) on ${main} at ${tip.slice(0, 8)}; ${summary(res)}`;
        ev('done', id, res.message, { agent: by, meta: { ...brief(res), plan: set.map((l) => l.task), dryRun: true } });
        return res;
      }
      if (!set.length) break;
      // 2.78.1 (d): tier-A lanes whose tip changes no file against main (a close-out: git diff <main> <tip> is empty) land
      // without a verify (there is nothing to verify that main hasn't); with other lanes in the train they land first and
      // the rest are built again on the new main. STUDIO_TRAIN_EMPTY_DIFF=off: they ride the verify (2.78.0).
      if (emptyDiffOn() && !res.emptyDiffDone) {
        const inSet = new Set(set.map((l) => l.task));
        // (one that waits on another lane of this train (--after) keeps the train's order: it rides the verify)
        const empty = set.filter((l) => l.tier === 'A' && !(depInfo.map.get(l.task) || []).some((d) => inSet.has(d)) && git(root, 'diff', '--quiet', tip, l.head).status === 0);
        if (empty.length) {
          const eb = empty.length === set.length ? built : buildIntegration(sc, tip, empty, { id, unionFiles });
          const tipTree = out(git(root, 'rev-parse', `${tip}^{tree}`));
          if (eb.included.length === empty.length && eb.tree && eb.tree === tipTree) {
            const names = empty.map((l) => l.task);
            res.emptyDiffDone = true;
            log(`[train] ${id}: ${names.join(', ')} change no file against ${main} (tier A, git diff ${tip.slice(0, 8)} <tip> is empty): landed without a verify${empty.length < set.length ? `; ${set.filter((l) => !empty.includes(l)).map((l) => l.task).join(', ')} are built again on the new ${main} and verified` : ''}`);
            ev('empty_diff', id, `${names.join(', ')} change no file against ${main} (tier A): landed and closed without a verify`, { agent: by, status: 'ok', meta: { lanes: names, tip } });
            writeTrainStatus(root, id, { step: 'landing', text: `landing ${names.join(', ')} (no file changes: no verify)`, lanes: ready.length, eta: null });
            const le = landTrain(root, sc, main, tip, { built: eb, v: { ok: true, emptyDiff: true, rec: null, closeRec: null, gates: [] } }, { id, by, deps, log, res, unionFiles });
            if (le === 'moved') { res.emptyDiffDone = false; continue; }
            if (empty.length === set.length || !res.landed.length) break;
            attempt -= 1; // the others, on the new main: not a retry
            continue;
          }
          log(`[train] ${id}: ${empty.map((l) => l.task).join(', ')}: no file changes alone, but not once merged together (${eb.included.length}/${empty.length} merged); verified as usual`);
        }
      }
      // 2.67.0 (f): before the verify, each stacked chain's touched tests and pins on its own combined tree; red: a tail.
      if (!res.chainTailChecked) { res.chainTailChecked = true; await chainTailCheck({ root, id, tip, set, settings, depInfo, log, res, by, deps, main }); }
      // 2.69.0 (p): each lane's related tests on the combined tree; a lane red there is handed back before the full verify.
      if (!res.relatedFirstDone) {
        res.relatedFirstDone = true;
        const gone = relatedFirst({ sc, root, id, tip, set, built, settings, log, res, drop });
        if (gone.length) {
          set = set.filter((l) => !gone.includes(l));
          if (!set.length) break;
          built = buildInOrder(sc, tip, set, { id, unionFiles }, depInfo);
          for (const l of built.depWait) defer(l, l.why);
          for (const l of built.conflictMain) drop(l, l.why);
          for (const l of built.deferred) defer(l, l.why);
          set = built.included;
          if (!set.length) break;
        }
      }
      const all = set.some((l) => l.all);
      // (c) ONE full verify of the final tree; (e) red: find who fails alone.
      let verdict = null;
      // 2.65.3 (B-43): the ETA from this train's own timings (harness/train-status.mjs trainEta).
      const quiet = res.lastVerifyMs ? null : quietVerifyMs(root, settings.gameRoot ? path.basename(settings.gameRoot) : null);
      const etaFor = (rechecks, verifies = 1) => trainEta({ rechecks, verifies, recheckMs: res.recheckMs, verifyMs: res.lastVerifyMs || quiet, quiet: !res.lastVerifyMs && Boolean(quiet) });
      res.roundWithout = [];
      try {
      for (let round = 0; set.length && round <= ready.length + 1; round += 1) {
        checkCancel(root, id); // 2.77.1 (B-98)
        checkRedBudget(id); // 2.78.2 (b): a later round's verify is part of the red chain too
        res.round = round + 1;
        if (round > 0) { built = buildInOrder(sc, tip, set, { id, unionFiles }, depInfo); for (const l of built.depWait) defer(l, l.why); }
        // (Round 0's build was handled above; 2.59.0 handled it twice: a deferral logged twice, a hand-back made twice.)
        if (round > 0 && (built.conflictMain.length || built.deferred.length || built.depWait.length)) {
          for (const l of built.conflictMain) drop(l, l.why);
          for (const l of built.deferred) defer(l, l.why);
          set = built.included;
          if (!set.length) break;
        }
        // 2.77.0 (p, P9.6): the tree under verify (head, tree, base, tasks) is what a speculative train builds on.
        writeTrainStatus(root, id, { step: 'verify', text: `verify ${res.verifies + 1}: lanes 1-${set.length}${res.roundWithout.length ? ` (round ${res.round}: without ${res.roundWithout.join(', ')})` : ''}, ${set.map((l) => l.task).join(', ')}`, lanes: ready.length, round: res.round, eta: etaFor(0), head: built.head, tree: built.tree, base: tip, tasks: set.map((l) => l.task) });
        // 2.78.1 (B-122): no speculative train from a process whose harness changed underneath it.
        { const cg = deps.chainGuard ? deps.chainGuard() : chainGuard(); if (cg.ok) await pipelineKick(root, { after: id, log, ...(deps.startNext ? { spawn: deps.startNext } : {}) }); else if (!res.kickStopped) { res.kickStopped = true; log(`[train] ${id}: no speculative train behind it: ${cg.why}`); } }
        const v = await verifyRemoteFirst(sc, { id, n: res.verifies + 1, tree: built.tree, changed: changedVs(sc.dir, tip, built.head), all, seen, tasks: set.map((l) => l.task), lanes: set, whole: wholeEquiv(root, tip, settings), log }, { head: built.head, by, deps, res });
        if (!v.cached && !v.reused && !v.remote) { res.verifies += 1; if (v.ms) res.lastVerifyMs = v.ms; }
        if (v.reused) res.reused += 1;
        if (v.ok) { verdict = { built, v }; break; }
        if (v.noCheck) { deferNoCheck(res, set, defer, { id, log, by, what: `verify ${res.verifies} ${v.why}` }); set = []; break; }
        // 2.65.3 (B-43): the red event and the log name the failing tests (parsed from the verify log, capped).
        let redText = '';
        try { redText = v.log ? fs.readFileSync(path.join(root, v.log), 'utf8') : ''; } catch {}
        const ft = failingTestsLine(redText);
        const redEta = bisectMode() === 'prefix' && set.length > 1 ? etaFor(1 + stepsLeft(0, set.length)) : null;
        if (ft.list.length) log(`[train] ${id}: verify ${res.verifies} red; failing tests: ${ft.list.join('; ')}${ft.more ? ` (+${ft.more} more)` : ''}`);
        const redSub = trainVerifyParts(redText, false, [sc.dir, root]).subIds; // 2.72.0 (a): which parts failed
        // 2.77.0 (P9.3/P9.6): red only on tests known red on main (no lane changes them) that still fail on main alone:
        // the full verify ran on the exact tree; those reds are reported, not blocking (harness/known-red.mjs).
        {
          const kr = knownRedTry({ sc, tip, set, built, v, redSub, id, log, res, cache, all, main, root, unionFiles, depInfo, by, text: redText });
          if (kr) { verdict = { built: kr.built, v: { ...v, ok: true, knownRed: kr.subs, closeRec: v.rec ? { ...v.rec, rows: (v.rec.rows || []).map((r) => (!r.ok && v.gates.includes(r.id) ? { ...r, ok: true, knownRed: kr.subs.filter((x) => x.split(':')[0] === r.id) } : r)) } : null } }; break; }
        }
        // 2.78.0 (PU-56): red only on tests that failed alone under load and passed alone at quiet low load (load-sensitive):
        // like a timeout-flake that passed alone at low load, the lane isn't handed back for them; the reds are reported.
        // A red that also has a port collision (2.77.3) never lands on this excuse: it waits below (harness/flakes.mjs header).
        const pcMix = !v.triage?.allPortCollision && v.triage?.portCollisionWait ? collisionWaitExcuse({ subs: redSub, gates: v.gates, labels: v.triage.labels }) : null;
        {
          const ls = loadSensitiveExcuse({ subs: redSub, gates: v.gates, labels: v.triage?.labels || [] });
          if (ls.ok) {
            // 2.78.1 (d): files trusted as load-sensitive (their record; no quiet wait) are named "trusted" in the log and event.
            const trusted = (v.triage?.labels || []).filter((l) => l.label === 'load-sensitive' && l.trusted).map((l) => l.test);
            const how = trusted.length ? `passed alone at low load; trusted load-sensitive without a quiet machine: ${trusted.slice(0, 3).join(', ')}${trusted.length > 3 ? ', …' : ''}` : 'passed alone at quiet low load';
            log(`[train] ${id}: red only in load-sensitive tests that ${how} (${ls.tests.slice(0, 3).join('; ')}${ls.tests.length > 3 ? '; …' : ''}): treated like a timeout-flake that passed alone at low load; ${set.map((l) => l.task).join(', ')} not handed back for them`);
            ev('load_sensitive', id, `red only in load-sensitive tests (${how}): ${set.map((l) => l.task).join(', ')} not handed back; the reds are reported`, { agent: by, status: 'warn', meta: { action: 'excused', tests: ls.tests, lanes: set.map((l) => l.task), verifyLog: v.log || null, ...(trusted.length ? { trusted } : {}) } });
            verdict = { built, v: { ...v, ok: true, loadSensitive: ls.tests, closeRec: v.rec ? { ...v.rec, rows: (v.rec.rows || []).map((r) => (!r.ok && v.gates.includes(r.id) ? { ...r, ok: true, loadSensitive: ls.tests.filter((x) => x.split(':')[0] === r.id) } : r)) } : null } };
            break;
          } else if (v.triage?.labels?.some((l) => l.label === 'load-sensitive') && !pcMix?.ok) log(`[train] ${id}: some failing tests are load-sensitive but the red is not only that (${ls.why}); handled as a real red`);
        }
        // 2.77.3 (C2, B-108): every failing test file failed on a port collision (the flake triage): another verify ran the
        // same test on the same fixed port. Not the lanes' failure: nobody is handed back, they wait for the next train.
        // 2.78.0 merge: so does a red mixing port collisions and load-sensitive files (pcMix; every failed gate has a file part).
        if (v.triage?.allPortCollision || pcMix?.ok) {
          const ports = [...new Set(v.triage.labels.map((r) => r.port).filter(Boolean))];
          const sens = v.triage.labels.filter((r) => r.label === 'load-sensitive').map((r) => r.test);
          const why = `the verify failed only on port collisions${sens.length ? ` and load-sensitive tests (${sens.slice(0, 3).join(', ')})` : ''} (${v.triage.labels.filter((r) => r.label === 'port-collision').map((r) => r.test).slice(0, 3).join(', ')}${ports.length ? `; port ${ports.join(', ')}` : ''}): another verify ran the same test on the same fixed port at the same time. Not this lane's failure; it waits for the next train. Give those tests a free port (studio/rules/test-ports.md)`;
          log(`[train] ${id}: ${why}`);
          ev('port_collision', id, `${set.map((l) => l.task).join(', ')}: ${why}`.slice(0, 600), { agent: by, to: 'producer', status: 'warn', meta: { lanes: set.map((l) => l.task), ports, tests: v.triage.labels.map((r) => r.test), ...(sens.length ? { loadSensitive: sens } : {}), log: v.log || null } });
          for (const l of set) keepOrHold(l, 'portCollisionIn', why, 'a train failed only on port collisions');
          set = [];
          break;
        }
        noteTrainRed(root, { id, gates: v.gates }); // 2.73.2 (d, B-75): the streak a fix lane is put first for
        ev('red', id, `the train of ${set.map((l) => l.task).join(', ')} is red (${v.why})${ft.list.length ? `; failing: ${ft.list.slice(0, 3).join('; ')}${ft.list.length + ft.more > 3 ? ` (+${ft.list.length + ft.more - 3} more)` : ''}` : ''}; log ${v.log || '-'}`, { agent: by, status: 'blocked', meta: { lanes: set.map((l) => l.task), gates: v.gates, ...(redSub.length ? { subIds: redSub } : {}), ...(ft.list.length ? { failingTests: ft.list, moreTests: ft.more } : {}), ...(redEta ? { eta: { ms: redEta.ms, text: redEta.text } } : {}) } });
        // 2.67.0 (f): red on exactly the tests a chain failed before the verify (its tail is filed): the whole chain
        // waits for its tail, nobody handed back, no bisection; the other lanes go on without it.
        const th = chainTailDefer({ root, res }, { set, v, text: redText });
        if (th) {
          const tailIds = [...new Set(th.tails.map((t) => t.tail))];
          for (const l of th.lanes) defer(l, tailWaitWhy({ chain: th.tails.flatMap((t) => t.chain), tail: tailIds.join(', '), tests: th.tests }));
          updateTails(root, (list) => { for (const r of list) if (th.tails.some((t) => t.key === r.key && t.sig === r.sig)) r.waiting = { train: id, at: new Date().toISOString() }; });
          log(`[train] ${id}: the verify is red on exactly the tests the chain-tail check found (${th.tests.slice(0, 3).join('; ')}${th.tests.length > 3 ? ` (+${th.tests.length - 3} more)` : ''}): ${th.lanes.map((l) => l.task).join(', ')} wait for ${tailIds.join(', ')} (not bisected, nobody handed back)${set.length > th.lanes.length ? `; the other lanes go on without them` : ''}`);
          ev('chain_tail', id, `the verify is red on exactly the chain's tests: ${th.lanes.map((l) => l.task).join(', ')} deferred, waiting for ${tailIds.join(', ')}; not bisected, nobody handed back`, { agent: by, status: 'warn', meta: { action: 'deferred', lanes: th.lanes.map((l) => l.task), tails: tailIds, tests: th.tests } });
          set = set.filter((l) => !th.lanes.includes(l));
          res.roundWithout.push(...th.lanes.map((l) => l.task));
          if (set.length) log(`[train] ${id}: round ${res.round + 1}: ${set.length} lane(s) left without ${res.roundWithout.join(', ')} (${set.map((l) => l.task).join(', ')}); verify, then bisect again if red`);
          continue;
        }
        // 2.60.0: prefix bisection on the failing checks only, and pin refresh (redPlan). STUDIO_TRAIN_BISECT=alone, or
        // a plan that can't name the failing checks: the 2.59 way below.
        if (bisectMode() === 'prefix' && !(oneLane && set.length === 1 && !settings.pins)) {
          const text = redText;
          const ctx = { sc, tip, set, built, v, id, log, res, settings, all, cache, main, root, text, eta: (left) => etaFor(left), seen, by, deps, unionFiles, defer };
          let plan = await redPlan(ctx, { bisect: !(oneLane && set.length === 1) });
          if (plan.kind === 'refreshed') {
            const v2 = verifyTree(sc, { id, n: res.verifies + 1, tree: plan.built.tree, changed: changedVs(sc.dir, tip, plan.built.head), all, seen, tasks: set.map((l) => l.task), log });
            if (!v2.cached && !v2.reused) res.verifies += 1;
            if (v2.ok) {
              res.pinRefresh = plan.info;
              ev('pin_refresh', id, `red only on declared pins: one pin-refresh commit (${plan.info.commit.slice(0, 8)}) for ${plan.info.lanes.join(', ')}, verified green; report ${plan.info.report}`, { agent: by, status: 'ok', meta: plan.info });
              verdict = { built: plan.built, v: v2 };
              break;
            }
            ev('pin_refresh_red', id, `the pin refresh didn't make the train green (${v2.why}); bisecting instead`, { agent: by, status: 'warn', meta: { report: plan.info.report, gates: v2.gates } });
            plan = await redPlan(ctx, { pins: false, bisect: !(oneLane && set.length === 1) });
          }
          if (plan.kind === 'noCheck') { deferNoCheck(res, set, defer, { id, log, by, what: plan.why }); set = []; break; }
          if (plan.kind === 'redMain' && harnessUnderneath(ctx, plan.log)) { set = []; break; }
          if (plan.kind === 'redMain') {
            listRedMain(root, { id, logRel: plan.log, roots: [sc.dir, root], tree: out(git(root, 'rev-parse', `${tip}^{tree}`)), gates: plan.gates || v.gates }); // 2.77.0 (P9.3)
            res.ok = false;
            res.redMain = true;
            res.message = `${main} itself fails its checks (${plan.why}; log ${plan.log || '-'}): nothing landed and no lane was handed back. Fix ${main} first.`;
            noteTrainRed(root, { id, gates: plan.gates || v.gates, redMain: true });
            ev('red_main', id, res.message, { agent: by, to: 'producer', status: 'blocked' });
            for (const l of set) defer(l, `${main} itself is red`);
            return res;
          }
          if (plan.kind === 'flaky') {
            ev('flaky', id, `${plan.why}: nobody is handed back; ${set.map((l) => l.task).join(', ')} wait for the next train`, { agent: by, to: 'producer', status: 'warn', meta: { steps: plan.steps } });
            for (const l of set) defer(l, plan.why);
            set = [];
            break;
          }
          if (plan.kind === 'pinBlocked') {
            for (const { lane, why } of plan.blocked) drop(lane, why);
            set = set.filter((l) => !plan.blocked.some((x) => x.lane.task === l.task));
            continue;
          }
          if (plan.kind === 'culprit') {
            ev('bisect', id, `${plan.steps.map((st) => `${st.prefix.length ? `${main} + ${st.prefix.join(' + ')}` : main}: ${st.ok ? 'green' : 'red'}`).join(', ')}; first red with ${plan.lane.task}`, { agent: by, meta: { mode: 'prefix', steps: plan.steps, culprit: plan.lane.task, eta: (({ ms, text: t }) => ({ ms, text: t }))(etaFor(0)) } });
            drop(plan.lane, plan.why);
            // 2.65.3 (B-43, c): land the green prefix before the culprit now (STUDIO_TRAIN_LAND_PREFIX, default on).
            const k = set.findIndex((l) => l.task === plan.lane.task);
            if (k > 0 && landPrefixOn()) {
              const early = landPrefixEarly(ctx, k);
              if (early.landed || early.stop) { set = []; break; }
            }
            set = set.filter((l) => l.task !== plan.lane.task);
            res.roundWithout.push(plan.lane.task);
            // 2.65.3 (B-43, b): the new round says what it is (its lanes are prefixes of the reduced set).
            if (set.length) log(`[train] ${id}: round ${res.round + 1}: ${set.length} lane(s) left without ${res.roundWithout.join(', ')} (${set.map((l) => l.task).join(', ')}); verify, then bisect again if red${(({ text: t }) => `; ${t}`)(etaFor(0))}`);
            continue;
          }
          log(`[train] ${id}: ${plan.why}; each lane is verified alone`);
        }
        if (set.length === 1) {
          drop(set[0], `the checks fail on main + this lane (${v.gates.join(', ') || v.why})${v.detail.length ? `:\n${v.detail.join('\n')}` : ''}\nFull log: ${v.log || '(none)'}. Fix it in your copy, commit, run npm run verify, then task done again`);
          set = [];
          break;
        }
        // Each lane alone on main.
        const alone = [];
        for (const l of set) {
          const b1 = buildIntegration(sc, tip, [l], { id, unionFiles });
          if (!b1.included.length) { drop(l, (b1.conflictMain[0] || b1.deferred[0])?.why || 'it no longer merges onto main'); continue; }
          const v1 = verifyTree(sc, { id, n: res.verifies + 1, tree: b1.tree, changed: changedVs(sc.dir, tip, b1.head), all: Boolean(l.all), seen, tasks: [l.task], log });
          if (!v1.cached && !v1.reused) res.verifies += 1;
          if (v1.reused) res.reused += 1;
          alone.push({ l, v1 });
          if (v1.noCheck) break;
        }
        const idle = alone.find(({ v1 }) => v1.noCheck);
        if (idle) { deferNoCheck(res, set, defer, { id, log, by, what: `the verify of ${idle.l.task} alone ${idle.v1.why}` }); set = []; break; }
        ev('bisect', id, alone.map(({ l, v1 }) => `${l.task} alone: ${v1.ok ? 'green' : 'red'}`).join(', '), { agent: by, meta: { alone: alone.map(({ l, v1 }) => ({ task: l.task, ok: v1.ok })) } });
        const bad = alone.filter((x) => !x.v1.ok);
        if (bad.length && bad.length === alone.length) {
          // Every lane fails alone: is main itself red? Then nobody is handed back.
          const b0 = buildIntegration(sc, tip, [], { id, unionFiles });
          const v0 = verifyTree(sc, { id, n: res.verifies + 1, tree: b0.tree, changed: [], all: false, seen, tasks: alone.map(({ l }) => l.task), log });
          if (!v0.cached && !v0.reused) res.verifies += 1;
          if (v0.noCheck) { deferNoCheck(res, set, defer, { id, log, by, what: `the verify of main alone ${v0.why}` }); set = []; break; }
          if (!v0.ok && harnessUnderneath({ sc, tip, set, id, log, res, by, defer, root }, v0.log)) { set = []; break; }
          if (!v0.ok) {
            listRedMain(root, { id, logRel: v0.log, roots: [sc.dir, root], tree: b0.tree, gates: v0.gates }); // 2.77.0 (P9.3)
            res.ok = false;
            res.redMain = true;
            res.message = `${main} itself fails its checks (${v0.gates.join(', ') || v0.why}; log ${v0.log || '-'}): nothing landed and no lane was handed back. Fix ${main} first.`;
            noteTrainRed(root, { id, gates: v0.gates, redMain: true });
            ev('red_main', id, res.message, { agent: by, to: 'producer', status: 'blocked' });
            for (const { l } of alone) defer(l, `${main} itself is red`);
            return res;
          }
        }
        for (const { l, v1 } of bad) drop(l, `the checks fail on main + this lane alone (${v1.gates.join(', ') || v1.why})${v1.detail.length ? `:\n${v1.detail.join('\n')}` : ''}\nFull log: ${v1.log || '(none)'}. Fix it in your copy, commit, run npm run verify, then task done again`);
        const good = alone.filter((x) => x.v1.ok).map((x) => x.l);
        if (!bad.length && good.length > 1) {
          // Each passes alone, together they fail: the last one waits for the next train (on top of the others).
          const last = good.pop();
          defer(last, `it passes alone but not together with ${good.map((l) => l.task).join(', ')}; it goes in the next train, on top of them`);
        }
        set = good;
      }
      } catch (e) {
        // 2.78.2 (b): the red chain ran past STUDIO_TRAIN_RED_BUDGET_MIN: stop looking (see redBudgetEnd).
        if (!(e instanceof TrainRedBudget)) throw e;
        verdict = redBudgetEnd({ marker: e.marker, sc, tip, set, id, log, res, seen, by, unionFiles, drop, keepOrHold });
        set = [];
      }
      if (!verdict) break;
      // (d) Green: main moves to exactly the verified tree, then each task closes.
      const landed = landTrain(root, sc, main, tip, verdict, { id, by, deps, log, res, unionFiles });
      // 2.77.0 (P9.3): a green landing that changed a known-red test's file is main going green on it.
      if (landed !== 'moved' && res.landed.length && !verdict.v.knownRed && !verdict.v.loadSensitive && !verdict.v.excused?.length) {
        try { const ch = changedVs(sc.dir, tip, verdict.built.head); const fixed = readKnownRed(root).filter((x) => ch.some((c) => c === fileSub(x.test) || c.endsWith(`/${fileSub(x.test)}`))).map((x) => x.test); if (fixed.length) clearKnownRed(root, fixed, `train ${id} landed a change to them on a green verify`); } catch {}
      }
      if (landed === 'moved') {
        ev('moved', id, `${main} moved while the train was verified; building it again on the new ${main}`, { agent: by, status: 'warn' });
        continue;
      }
      break;
    }
  } catch (e) {
    if (!(e instanceof TrainCancelled)) throw e;
    if (e.marker.stall) {
      // 2.77.3 (H2, B-112): the stall watch (harness/train-watch.mjs) stopped this attempt: nothing more lands from it,
      // nobody is handed back; each lane still riding keeps its place (held for the Producer if it stalled a train before).
      const riding = ready.filter((l) => !res.dropped.some((d) => d.task === l.task) && !res.landed.includes(l.task));
      const why = `train ${id} stalled: ${e.marker.why}`;
      const kept = [];
      const held = [];
      for (const l of riding) (keepOrHold(l, 'stalledIn', why, 'a train stalled') === 'held' ? held : kept).push(l.task);
      res.ok = res.landed.length > 0;
      res.stalled = { why: e.marker.why, step: e.marker.step || null, at: e.marker.at || null };
      res.message = `Train ${id} stalled and ended this attempt: ${e.marker.why}. Its running checks were stopped; nobody was handed back.${kept.length ? ` ${kept.join(', ')} keep their place in the train queue.` : ''}${held.length ? ` ${held.join(', ')} stalled a train before at the same head: held for the Producer (npm run task -- train release <ID> --by <name>).` : ''}${res.landed.length ? ` ${summary(res)}` : ''}`;
      log(`[train] ${id}: ${res.message}`);
      ev('stall_ended', id, res.message, { agent: by, to: 'producer', status: 'blocked', meta: { why: e.marker.why, step: e.marker.step || null, kept, held } });
    } else if (e.marker.cancel) {
      // 2.78.2 (a): `npm run task -- train cancel` (harness/train-cancel.mjs): nothing more lands from this attempt, nobody
      // is handed back, and every lane still riding keeps (or gets) its place in the queue; no hold, no count.
      const riding = ready.filter((l) => !res.dropped.some((d) => d.task === l.task) && !res.landed.includes(l.task));
      const kept = [];
      for (const l of riding) {
        try {
          const q = readQueue(root).find((x) => x.task === l.task);
          if (!q && !dryRun) enqueue(root, { task: l.task, agent: l.agent, dir: l.dir, branch: l.branch, head: l.head, all: Boolean(l.all), note: `queued again: train ${id} was cancelled` });
        } catch {}
        defer(l, `train ${id} was cancelled by ${e.marker.by || '?'}${e.marker.why ? ` (${e.marker.why})` : ''}`);
        kept.push(l.task);
      }
      res.ok = res.landed.length > 0;
      res.cancelled = e.marker;
      res.more = false;
      res.prefixMore = false;
      res.message = `Train ${id} was cancelled by ${e.marker.by || '?'}${e.marker.why ? ` (${e.marker.why})` : ''}: its running checks were stopped and nothing more lands from it; nobody was handed back.${kept.length ? ` ${kept.join(', ')} keep their place in the train queue.` : ''}${res.landed.length ? ` ${summary(res)}` : ''}`;
      log(`[train] ${id}: ${res.message}`);
      ev('cancel_ended', id, res.message, { agent: by, to: 'producer', status: 'warn', meta: { by: e.marker.by || null, why: e.marker.why || null, kept } });
    } else {
      // 2.77.1 (B-98): ended like a train that lands nothing: lanes kept (queued for the next train), nobody handed back.
      const stay = ready.map((l) => l.task).filter((t) => !e.marker.tasks.includes(t) && !res.dropped.some((d) => d.task === t) && !res.landed.includes(t));
      res.cancelled = e.marker;
      res.message = `Train ${id} stopped: ${e.marker.tasks.join(', ')} left the train (by ${e.marker.by || '?'}: ${e.marker.why || '-'}); no further checks.${stay.length ? ` ${stay.join(', ')} stay queued for the next train (nobody handed back).` : ''}${res.landed.length ? ` ${summary(res)}` : ''}`;
      log(`[train] ${id}: ${res.message}`);
      ev('cancelled', id, res.message, { agent: by, status: 'warn', meta: { left: e.marker.tasks, leftBy: e.marker.by || null, why: e.marker.why || null, stay } });
    }
  } finally {
    activeLanes.delete(String(id));
    redClock.delete(String(id)); // 2.78.2 (b)
    for (const l of ready) deps.clearRunning?.(l.task);
    if (sc) removeScratch(sc);
  }
  if (res.landed.length && !dryRun) noteTrainLanded(root); // 2.73.2 (d, B-75): main is green again
  if (res.batchCut?.length && res.landed.length && queued && !res.cancelled?.cancel) res.more = true; // 2.77.0 (p): the next batch runs right after (2.78.2: not after a cancel)
  if (res.ok) res.ok = res.landed.length > 0 || (!res.dropped.length && !res.deferred.length);
  res.message = res.message || summary(res);
  writeTrainStatus(root, id, { step: 'done', text: `done: ${res.message.slice(0, 300)}`, lanes: res.trainLanes || null, round: res.round || 1, eta: null });
  ev('done', id, res.message, { agent: by, status: res.landed.length ? 'ok' : 'warn', meta: brief(res) });
  return res;
}

// ---- 2.77.0 (P9.3/P9.6): tests known red on main -----------------------------------------------------------------

/** A verify of main alone was red: list its failing test files as known red on main (harness/known-red.mjs). */
function listRedMain(root, { id, logRel, roots, tree, gates }) {
  try {
    const text = logRel ? fs.readFileSync(path.join(root, logRel), 'utf8') : '';
    const subs = trainVerifyParts(text, false, roots).subIds;
    if (subs.length) addKnownRed(root, subs, { train: id, tree, log: logRel || null, gates });
  } catch {}
}

/**
 * The verify is red: if its only red parts are known-red tests no lane changes, re-run just those test files on main's
 * tip alone. Still red there: { built, subs } (the train lands; the reds are reported). Green there: the entries clear,
 * null (the red is the lanes'). Anything else: null. The scratch copy is back at the train's tree when it returns.
 */
function knownRedTry({ sc, tip, set, built, v, redSub, id, log, res, cache, all, main, root, unionFiles, depInfo, by, text }) {
  if (!readKnownRed(root).length) return null;
  const changed = changedVs(sc.dir, tip, built.head);
  const cand = knownRedCandidate(root, { redGates: v.gates, subs: redSub, changed });
  if (!cand.ok) { log(`[train] ${id}: known red on ${main}: not excused (${cand.why})`); return null; }
  const f = trainFocus(text);
  const b0 = buildIntegration(sc, tip, [], { id, unionFiles });
  const c = recheck(sc, { id, tree: b0.tree, gates: v.gates, changed: [], all, cache: cache.checks, log, res, label: `${main} alone`, focus: f.focus || null, question: `do the known-red tests (${cand.subs.slice(0, 3).join(', ')}) still fail on ${main} alone?` });
  const back = buildInOrder(sc, tip, set, { id, unionFiles }, depInfo);
  if (back.tree !== built.tree) { log(`[train] ${id}: known red: the train's tree couldn't be rebuilt exactly (${String(back.tree).slice(0, 8)} vs ${built.tree.slice(0, 8)}); not excused`); return null; }
  if (c.noCheck) return null;
  if (c.ok) {
    clearKnownRed(root, cand.subs, `green on ${main} alone in train ${id}`);
    log(`[train] ${id}: ${cand.subs.join(', ')} pass on ${main} alone now (cleared from the known-red list): the red is this train's`);
    return null;
  }
  addKnownRed(root, cand.subs, { train: id, tree: b0.tree, log: c.log, gates: v.gates });
  log(`[train] ${id}: red only on tests known red on ${main} (${cand.subs.join(', ')}), and they still fail on ${main} alone (${c.log}): the full verify of tree ${built.tree.slice(0, 8)} ran; those reds are reported, not blocking`);
  ev('known_red', id, `red only on known-red tests that also fail on ${main} alone (${cand.subs.slice(0, 4).join(', ')}${cand.subs.length > 4 ? ', …' : ''}): ${set.map((l) => l.task).join(', ')} land; the reds are reported, not blocking`, { agent: by, status: 'warn', meta: { action: 'excused', tests: cand.subs, lanes: set.map((l) => l.task), mainLog: c.log, verifyLog: v.log || null } });
  return { built: back, subs: cand.subs };
}

// ---- 2.60.1 (B-29): main moved only by board/record files -----------------------------------------------

/** The board/record paths a move of main may touch without a new verify (harness/train-board.json "boardPaths"). */
export function boardPaths(file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'train-board.json')) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j.boardPaths) ? j.boardPaths.map((x) => String(x).trim()).filter(Boolean) : []; } catch { return []; }
}

/**
 * Did main move from `tip` to `now` by board/record files only? { ok, files } or { ok: false, why }. `now` must be a
 * descendant of `tip`, and every path changed in tip..now must be on the list, added or modified (a delete or a
 * rename never counts: --no-renames shows a rename as a delete).
 */
/** 2.77.0 (P9.1): files a board move may add, never change (train-board.json "addOnlyPaths"). */
export function addOnlyPaths(file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'train-board.json')) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j.addOnlyPaths) ? j.addOnlyPaths.map(String) : []; } catch { return []; }
}
/** 2.77.0 (P9.1): files only some required checks read: glob -> [check id] (train-board.json "recheckPaths"). */
export function recheckPaths(file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'train-board.json')) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j.recheckPaths && typeof j.recheckPaths === 'object' ? j.recheckPaths : {}; } catch { return {}; }
}

/**
 * 2.78.2 (c): did studio/quarantine.json change only by skipping MORE tests (every test the runner skipped at `tip` is
 * still skipped at `now`)? A verify that ran a test and was green stays true when later runs skip it, so a quarantine
 * that only grows can't make the verified tree wrong; a release (or a status turned back to "proposed") means a test
 * the verify never ran will run, so that still verifies again. STUDIO_TRAIN_QUARANTINE_MOVE=off: every change verifies again.
 */
export function quarantineOnlyGrows(root, tip, now, rel = 'studio/quarantine.json', env = process.env) {
  if (/^(off|0|false|no)$/i.test(String(env.STUDIO_TRAIN_QUARANTINE_MOVE ?? '').trim())) return false;
  const active = (rev) => {
    const r = git(root, 'show', `${rev}:${rel}`);
    if (r.status !== 0) return new Set();
    let j; try { j = JSON.parse(r.stdout); } catch { return null; }
    const list = Array.isArray(j) ? j : Array.isArray(j?.tests) ? j.tests : null;
    if (!list) return null;
    return new Set(list.filter((e) => e && typeof e.test === 'string' && e.test.trim() && (!e.status || e.status === 'active')).map((e) => e.test.trim().replace(/\\/g, '/')));
  };
  const a = active(tip); const b = active(now);
  return Boolean(a && b && [...a].every((t) => b.has(t)));
}

export function boardOnlyMove(root, tip, now, list = boardPaths(), { lanes = null, records = taskRecordPaths(), addOnly = addOnlyPaths(), rechecks = recheckPaths() } = {}) {
  if (!list.length) return { ok: false, why: 'no board paths are listed (harness/train-board.json)' };
  if (git(root, 'merge-base', '--is-ancestor', tip, now).status !== 0) return { ok: false, why: `the new ${now.slice(0, 8)} doesn't descend from ${tip.slice(0, 8)}` };
  const r = git(root, 'diff', '--name-status', '--no-renames', '-z', tip, now);
  if (r.status !== 0) return { ok: false, why: 'git diff failed' };
  const parts = String(r.stdout || '').split('\0').filter(Boolean);
  const files = [];
  const recheck = new Set();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [st, f] = [parts[i], parts[i + 1]];
    if (!/^[AM]$/.test(st)) return { ok: false, why: `it ${st === 'D' ? 'deletes' : `changes (${st})`} ${f}` };
    // 2.77.0 (P9.1): an added approval is a record (it only lets more pass); a file some checks read re-runs those.
    if (!matchAny(f, list) && st === 'A' && matchAny(f, addOnly)) { files.push(f); continue; }
    const rc = Object.entries(rechecks).filter(([g]) => matchAny(f, [g])).flatMap(([, ids]) => (Array.isArray(ids) ? ids.map(String) : []));
    if (!matchAny(f, list) && rc.length) { for (const x of rc) recheck.add(x); files.push(f); continue; }
    if (!matchAny(f, list) && f === 'studio/quarantine.json' && quarantineOnlyGrows(root, tip, now, f)) { files.push(f); continue; }
    if (!matchAny(f, list)) {
      // 2.67.0 (B-29): a task record (holds, approval cards) counts when no entry it changes is a lane of this train.
      const rec = Array.isArray(lanes) && records[f] ? recordEntriesChanged(root, tip, now, f, records[f]) : null;
      if (!rec?.ok) return { ok: false, why: `it changes ${f}, which is not a board or record file${rec?.why ? ` (${rec.why})` : ''}` };
      const mine = rec.tasks.filter((t) => lanes.includes(t));
      if (mine.length) return { ok: false, why: `it changes ${f} for ${mine.join(', ')}, a lane of this train` };
    }
    files.push(f);
  }
  return files.length ? { ok: true, files, recheck: [...recheck].sort() } : { ok: false, why: 'no file changed' };
}

/** 2.67.0 (B-29): task records a board move may change for tasks outside the train (train-board.json "taskRecords": path -> key). */
export function taskRecordPaths(file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'train-board.json')) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j.taskRecords && typeof j.taskRecords === 'object' ? j.taskRecords : {}; } catch { return {}; }
}

/**
 * The task ids whose entries a task record changed between two commits: { ok, tasks } or { ok: false, why }. The record
 * is JSON whose `key` holds a map by task id or a list of entries with a "task" field; anything else changed (another
 * key, an entry without a task, unreadable JSON) refuses.
 */
export function recordEntriesChanged(root, from, to, file, key) {
  const read = (rev) => {
    const r = git(root, 'show', `${rev}:${file}`);
    if (r.status !== 0) return {};
    try { return JSON.parse(r.stdout); } catch { return null; }
  };
  const a = read(from);
  const b = read(to);
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return { ok: false, why: 'not readable JSON' };
  const others = (o) => JSON.stringify(Object.keys(o).filter((k) => k !== key).sort().map((k) => [k, o[k]]));
  if (others(a) !== others(b)) return { ok: false, why: `it changes more than "${key}"` };
  const byTask = (v) => {
    const m = new Map();
    if (Array.isArray(v)) {
      for (const it of v) {
        if (!it || typeof it !== 'object' || !it.task) return null;
        m.set(String(it.task), [...(m.get(String(it.task)) || []), it]);
      }
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) m.set(k, x);
    else if (v !== undefined) return null;
    return m;
  };
  const ma = byTask(a[key]);
  const mb = byTask(b[key]);
  if (!ma || !mb) return { ok: false, why: `an entry of "${key}" names no task` };
  const tasks = [...new Set([...ma.keys(), ...mb.keys()])].filter((t) => JSON.stringify(ma.get(t) ?? null) !== JSON.stringify(mb.get(t) ?? null)).sort();
  return { ok: true, tasks };
}

/**
 * Main moved by board files only while the train was verified (called under the land lock): merge the train's lanes
 * again onto the new tip and keep the verify when, checked with git, the new tree is the verified tree with exactly
 * those board files as main has them now. Returns { ok, built, files } or { ok: false, why } (the caller then does as
 * before: build again on the new main and verify again).
 */
function rebuildOverBoardMove(root, sc, { tip, now, built, id, unionFiles }) {
  const move = boardOnlyMove(root, tip, now, boardPaths(), { lanes: built.included.map((l) => l.task) });
  if (!move.ok) return move;
  const last = built.included[built.included.length - 1];
  if (!last || last.after !== built.head) return { ok: false, why: 'the verified train has a commit after its lanes (a pin refresh)' };
  const again = buildIntegration(sc, now, built.included, { id, unionFiles });
  const same = again.included.length === built.included.length && again.included.every((l, k) => l.task === built.included[k].task && JSON.stringify(l.union || []) === JSON.stringify(built.included[k].union || []));
  if (!same || again.deferred.length || again.conflictMain.length) return { ok: false, why: 'the lanes no longer merge onto it exactly as before' };
  const d = git(root, 'diff-tree', '-r', '--name-only', '--no-renames', '-z', built.tree, again.tree);
  if (d.status !== 0) return { ok: false, why: 'could not compare the trees' };
  const diff = String(d.stdout || '').split('\0').filter(Boolean);
  const blob = (rev, f) => out(git(root, 'rev-parse', '-q', '--verify', `${rev}:${f}`));
  const odd = diff.find((f) => !move.files.includes(f) || blob(again.tree, f) !== blob(now, f));
  if (odd) return { ok: false, why: `the new tree differs from the verified one in ${odd}, not only by ${mainBranch(root)}'s board files` };
  // 2.77.0 (P9.1): files some checks read (the Bible's controls list, a changed approval): those checks only, on the new tree.
  const rc = recheckBoardMove(root, sc, { id, tree: again.tree, ids: move.recheck || [], files: move.files });
  if (!rc.ok) return { ok: false, why: rc.why };
  return { ok: true, built: again, files: move.files, ...(rc.ran.length ? { rechecked: rc.ran } : {}) };
}

// ---- 2.78.2 (g, item 16): land the verified tree, then main's new non-code commits on top ------------------------

/**
 * What the game manifests at `rev` say their checks read: [{ glob, by }] from each game|web/<x>/studio.gates.json (the
 * required checks' "paths", the "shared" globs, the manifest itself). A manifest that can't be read: every studio file.
 */
export function gameReadGlobs(root, rev) {
  const found = [];
  for (const top of ['game', 'web']) {
    const ls = git(root, 'ls-tree', '--name-only', '-z', `${rev}:${top}`);
    if (ls.status !== 0) continue;
    for (const d of String(ls.stdout || '').split('\0').filter(Boolean)) {
      const rel = `${top}/${d}/studio.gates.json`;
      const r = git(root, 'show', `${rev}:${rel}`);
      if (r.status !== 0) continue;
      found.push({ glob: rel, by: `${rel} (the manifest)` });
      let j = null;
      try { j = JSON.parse(r.stdout); } catch { found.push({ glob: 'studio/**', by: `${rel} (not readable JSON)` }); continue; }
      for (const g of Array.isArray(j?.shared) ? j.shared : []) found.push({ glob: String(g), by: `${rel} "shared"` });
      for (const g of Array.isArray(j?.gates) ? j.gates : []) {
        if (!g || !g.id || g.required === false || !Array.isArray(g.paths)) continue;
        for (const p of g.paths) found.push({ glob: String(p), by: `game:${g.id} (its paths)` });
      }
    }
  }
  return found;
}

/**
 * Who reads this file, by the checks' own rules: [] means no required check does (a "non-code" file); else the reasons.
 * The train's copy tests every file outside studio/ from its own tree, and the studio's required checks declare no
 * paths (each reads the whole tree), so any such file is code. studio/ is never tested from the tree (sparse-excluded,
 * linked to the main checkout's); a studio file is non-code only when it is on the board list and no rule reads it: not
 * a task record, approval or recheckPaths file, not read by docs, session or reviewer (harness/check-reads.mjs), not in a
 * game check's "paths" or "shared" globs, not always-shared. ctx: { board, rechecks, records, addOnly, game }.
 */
export function nonCodeReaders(file, ctx) {
  const f = String(file || '').replace(/\\/g, '/');
  if (!f.startsWith('studio/')) return ['the train tests it from its own tree, and the studio\'s required checks declare no paths (each reads the whole tree)'];
  const why = [];
  if (matchAny(f, ALWAYS_SHARED)) why.push('every check (always shared)');
  if (!matchAny(f, ctx.board || [])) why.push('not on the board list (harness/train-board.json boardPaths)');
  if ((ctx.records || {})[f]) why.push('a task record (the board rule judges its entries)');
  if (matchAny(f, ctx.addOnly || [])) why.push('an approval');
  const rc = Object.entries(ctx.rechecks || {}).filter(([g]) => matchAny(f, [g])).flatMap(([, ids]) => (Array.isArray(ids) ? ids.map(String) : []));
  if (rc.length) why.push(`read by ${[...new Set(rc)].join(', ')} (recheckPaths)`);
  for (const id of studioCheckReaders(f)) why.push(`read by ${id}`);
  for (const g of ctx.game || []) if (matchAny(f, [g.glob])) why.push(`read by ${g.by}`);
  return why;
}

/**
 * Main's new commits tip..now, each judged file by file: { ok, commits: [{ sha, subject, files }], files } when every
 * file any of them touches (added, changed, deleted or renamed; a merge's against each parent) has no reader, else
 * { ok: false, why } naming the first file a check reads and why.
 */
export function mainNonCodeCommits(root, tip, now, ctx) {
  if (git(root, 'merge-base', '--is-ancestor', tip, now).status !== 0) return { ok: false, why: `the new ${now.slice(0, 8)} doesn't descend from ${tip.slice(0, 8)}` };
  const shas = out(git(root, 'rev-list', '--reverse', `${tip}..${now}`)).split('\n').filter(Boolean);
  if (!shas.length) return { ok: false, why: 'no new commit' };
  const max = Number(process.env.STUDIO_TRAIN_LAND_OVER_NONCODE_MAX || 200);
  if (shas.length > max) return { ok: false, why: `${shas.length} new commits (more than STUDIO_TRAIN_LAND_OVER_NONCODE_MAX=${max})` };
  const commits = [];
  const all = new Set();
  for (const sha of shas) {
    const d = git(root, '-c', 'core.quotePath=false', 'diff-tree', '-r', '-m', '--no-commit-id', '--name-only', '--no-renames', '-z', sha);
    if (d.status !== 0) return { ok: false, why: `could not read ${sha.slice(0, 8)}` };
    const files = [...new Set(String(d.stdout || '').split('\0').filter(Boolean))].sort();
    for (const f of files) {
      const r = nonCodeReaders(f, ctx);
      if (r.length) return { ok: false, why: `${sha.slice(0, 8)} touches ${f}: ${r.join('; ')}` };
      all.add(f);
    }
    commits.push({ sha, subject: out(git(root, 'log', '-1', '--format=%s', sha)).slice(0, 120), files });
  }
  return { ok: true, commits, files: [...all].sort() };
}

/**
 * Main moved after a green verify of the train's tree T, and the board rule (rebuildOverBoardMove) can't take it (a
 * deleted or renamed board file, a pin-refresh commit, ...). When every new main commit touches only files no check
 * reads (mainNonCodeCommits): merge main's new commits onto T in the train's copy (`git merge`, hooks on, as the lanes
 * are merged: parents T, then main) and land that, under the land lock, without a new verify. Checked with git before:
 * a clean merge (merge-tree) whose tree is T with exactly main's versions of those files; and the one required check
 * that reads every file, secrets, runs on the new commits themselves (secret-scan --since T). Any doubt: { ok: false,
 * why }, the copy back at T, and the caller builds and verifies again as before.
 */
function landOverNonCode(root, sc, { tip, now, verified, id }) {
  const ctx = { board: boardPaths(), rechecks: recheckPaths(), records: taskRecordPaths(), addOnly: addOnlyPaths(), game: gameReadGlobs(root, now) };
  const mv = mainNonCodeCommits(root, tip, now, ctx);
  if (!mv.ok) return mv;
  const head = verified.head;
  const back = () => { git(sc.dir, 'merge', '--abort'); git(sc.dir, 'reset', '-q', '--hard', head); git(sc.dir, 'clean', '-fdq'); };
  git(sc.dir, 'reset', '-q', '--hard', head); // a refused board rebuild left the copy on main's new tip
  git(sc.dir, 'clean', '-fdq');
  if (out(git(root, 'rev-parse', `refs/heads/${sc.branch}^{tree}`)) !== verified.tree) { back(); return { ok: false, why: 'the train branch is not at the verified tree' }; }
  const mt = git(root, 'merge-tree', '--write-tree', head, now);
  if (mt.status !== 0) return { ok: false, why: `main's new commits don't merge cleanly onto the verified tree (${out(mt).split('\n')[0].slice(0, 120) || `exit ${mt.status}`})` };
  const want = out(mt).split('\n')[0].trim();
  const d = git(root, 'diff-tree', '-r', '--name-only', '--no-renames', '-z', verified.tree, want);
  if (d.status !== 0) return { ok: false, why: 'could not compare the trees' };
  const blob = (rev, f) => out(git(root, 'rev-parse', '-q', '--verify', `${rev}:${f}`));
  const odd = String(d.stdout || '').split('\0').filter(Boolean).find((f) => !mv.files.includes(f) || blob(want, f) !== blob(now, f));
  if (odd) return { ok: false, why: `the merged tree differs from the verified one in ${odd}, not only by main's version of its non-code files` };
  const msg = [`train ${id}: land the verified tree ${verified.tree.slice(0, 8)}, then ${mv.commits.length} new commit(s) of main that touch only non-code files`, '', ...mv.commits.slice(0, 20).map((c) => `  ${c.sha.slice(0, 8)} ${c.subject}`), '', `Studio-Train: ${id} over-noncode`].join('\n');
  const env = { ...process.env };
  for (const k of ['STUDIO_LOCK_OWNER', 'STUDIO_EXPERIMENT', 'STUDIO_AGENT_MODEL']) delete env[k];
  const m = spawnSync('git', ['-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local', 'merge', '--no-ff', '--no-edit', '-m', msg, now], { windowsHide: true, cwd: sc.dir, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
  if (m.status !== 0) { back(); return { ok: false, why: `the merge stopped: ${`${m.stdout || ''}${m.stderr || ''}`.trim().split('\n').slice(-2).join(' ').slice(0, 200)}` }; }
  const merged = out(git(sc.dir, 'rev-parse', 'HEAD'));
  const tree = out(git(sc.dir, 'rev-parse', 'HEAD^{tree}'));
  if (tree !== want) { back(); return { ok: false, why: 'the merge commit\'s tree is not the one git predicted' }; }
  const sec = spawnSync(process.execPath, [path.join(sc.dir, 'scripts', 'secret-scan.mjs'), '--since', head], { windowsHide: true, cwd: sc.dir, encoding: 'utf8', env: { ...env, STUDIO_MAIN_ROOT: root }, maxBuffer: 16 * 1024 * 1024 });
  if (sec.status !== 0) { back(); return { ok: false, why: `the secrets check is red on main's new commits (${`${sec.stdout || ''}${sec.stderr || ''}`.trim().split('\n').filter((l) => /FAIL|secret/i.test(l)).slice(-1)[0]?.slice(0, 160) || `exit ${sec.status}`})` }; }
  return { ok: true, built: { ...verified, head: merged, tree }, commits: mv.commits, files: mv.files, merge: merged };
}

/**
 * 2.77.0 (P9.1): re-run only the checks `ids` (those the studio has) on the train copy's tree after main moved by files
 * they read. { ok, ran: [ids], why }. Nothing to run: ok.
 */
function recheckBoardMove(root, sc, { id, tree, ids, files }) {
  let have = [];
  try { have = (JSON.parse(fs.readFileSync(path.join(root, 'studio', 'gates.json'), 'utf8')).gates || []).map((x) => String(x.id)); } catch {}
  const run = ids.filter((x) => have.includes(x));
  if (!run.length) return { ok: true, ran: [] };
  const owner = `train-${id}-move`;
  const env = { ...process.env, STUDIO_MAIN_ROOT: root, STUDIO_LOCK_OWNER: owner, STUDIO_GATE_PRIORITY: 'landing', STUDIO_VERIFY_DETACH: 'off' };
  for (const k of ['STUDIO_GATE_CHANGED', 'STUDIO_GATE_PATHS', 'STUDIO_GATE_INCOMING_FILE', 'STUDIO_VERIFY_RUN', 'npm_lifecycle_event', 'STUDIO_TASK_BASE', 'STUDIO_GATE_FOCUS']) delete env[k];
  const r = spawnSync(process.execPath, [path.join(sc.dir, 'scripts', 'run-gates.mjs'), '--no-detach', '--only', run.join(',')], { windowsHide: true, cwd: sc.dir, env: gateEnv(env), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(path.join(root, '.studio', 'gates', `${owner}.json`), 'utf8')); } catch {}
  for (const f of [`${owner}.json`, `${owner}-full.json`]) { try { fs.rmSync(path.join(root, '.studio', 'gates', f), { force: true }); } catch {} }
  try { fs.writeFileSync(path.join(root, TRAIN_DIR, `${id}-move-recheck.log`), `${r.stdout || ''}${r.stderr || ''}`); } catch {}
  const rows = Array.isArray(rec?.rows) ? rec.rows : [];
  const green = r.status === 0 && rec?.tree === tree && rows.length > 0 && rows.every((x) => x.ok || x.required === false);
  return green ? { ok: true, ran: run } : { ok: false, ran: run, why: `the checks that read ${files.filter((f) => Object.keys(recheckPaths()).some((g) => matchAny(f, [g]))).join(', ')} (${run.join(', ')}) are ${r.status === 0 ? 'not clearly green' : 'red'} on the new tree` };
}

/**
 * Under the land lock: if main is still at `tip`, move it to the verified head (compare-and-swap, the main checkout's
 * files follow) and close each lane's task. A lane whose copy gained commits after its check lands as checked (its
 * content is in the verified tree) but stays queued with its new commits; 2.78.1 (d): if those are only merges of main
 * that bring nothing beyond it, the task closes as landed (task.train.main_merges_only). Returns 'moved', or nothing.
 */
function landTrain(root, sc, main, tip, { built: verified, v }, { id, by, deps, log, res, unionFiles = [] }) {
  const from = res.landed.length; // 2.78.1 (d): an empty-diff landing may come first in the same train: this call's lanes only
  let out1;
  let built = verified;
  let board = null;
  let over = null; // 2.78.2 (g): landed over main's non-code commits
  try {
    out1 = withLandLock(root, () => {
      const now = out(git(root, 'rev-parse', `refs/heads/${main}`));
      if (now !== tip) {
        // 2.60.1 (B-29): a board-only commit on main (a task type record, NEXT.md) restarted the whole verify (~9 min).
        const re = rebuildOverBoardMove(root, sc, { tip, now, built: verified, id, unionFiles });
        // 2.78.2 (g, item 16): main's new commits touch only files no check reads: land T, then those commits on top.
        const lo = re.ok ? null : v?.emptyDiff ? { ok: false, why: 'an empty-diff landing (no verify of its own)' } : landOverNonCode(root, sc, { tip, now, verified, id });
        if (!re.ok && !lo.ok) { log(`[train] ${id}: ${main} moved (${tip.slice(0, 8)} -> ${now.slice(0, 8)}) and the verify can't stand for it: ${re.why}; nor can the train land over those commits: ${lo.why}`); return 'moved'; }
        if (lo?.ok) {
          built = lo.built;
          over = { from: tip, to: now, merge: lo.merge, files: lo.files, commits: lo.commits.map((c) => ({ sha: c.sha, subject: c.subject, files: c.files })), verifiedTree: verified.tree };
          log(`[train] ${id}: ${main} moved (${tip.slice(0, 8)} -> ${now.slice(0, 8)}) by ${lo.commits.length} commit(s) that touch only files no check reads (${lo.files.join(', ')}): landing the verified tree ${verified.tree.slice(0, 8)} with them merged on top (${lo.merge.slice(0, 8)}), no new verify`);
        } else {
          built = re.built;
          board = { from: tip, to: now, files: re.files, ...(re.rechecked ? { rechecked: re.rechecked } : {}) };
          log(`[train] ${id}: ${main} moved by board/record files only (${re.files.join(', ')}); the lanes merged onto it again without a conflict and the tree is the verified tree plus those files: verify reused${re.rechecked ? ` (re-ran only ${re.rechecked.join(', ')}, the checks that read them: green)` : ''}`);
          ev('board_move', id, `${main} moved ${tip.slice(0, 8)} -> ${now.slice(0, 8)} by board/record files only (${re.files.join(', ')}): verify of ${verified.tree.slice(0, 8)} reused for ${built.tree.slice(0, 8)}`, { agent: by, status: 'ok', meta: board });
        }
      }
      if (out(git(root, 'rev-parse', `${sc.branch}^{tree}`)) !== built.tree) return { ok: false, message: 'the train branch changed after its verify' };
      const landedFrom = out(git(root, 'rev-parse', `refs/heads/${main}`));
      const ff = landFastForward(root, main, sc.branch, { taskId: `train ${id}` });
      if (!ff.ok) return { ok: false, message: ff.message };
      if (over) ev('landed_over_noncode', id, `${main} moved ${tip.slice(0, 8)} -> ${over.to.slice(0, 8)} while the train was verified, by ${over.commits.length} commit(s) that touch only files no check reads (${over.files.slice(0, 8).join(', ')}${over.files.length > 8 ? ', …' : ''}): landed the verified tree ${over.verifiedTree.slice(0, 8)} with them merged on top (${over.merge.slice(0, 8)}), no new verify`, { agent: by, status: 'ok', meta: over });
      // 2.65.0 (B-40): each landed lane's config proposal, in a commit right after the landing (Config-From: <task>).
      applyLandedConfig(root, main, built.included.map((l) => ({ task: l.task, base: out(git(root, 'merge-base', landedFrom, l.head)) || landedFrom, released: l.released || null })), { log, by, res, id });
      for (const lane of built.included) {
        const now = laneNow(lane);
        forgetLanded(lane.task, lane.branch, root);
        emitEvent({ type: 'lane.merged', agent: lane.agent, task: lane.task, msg: `${lane.task}: ${lane.branch || lane.head.slice(0, 8)} added to ${main} by train ${id}` });
        // 2.78.1 (d): the commits it gained are only merges of main that bring nothing beyond main (T-173): what was
        // checked is all its work, so the task closes as landed (STUDIO_TRAIN_CLOSE_MAIN_MERGES=off: stays open, 2.78.0).
        const mm = now.head && now.head !== lane.head && closeMainMergesOn() ? onlyMainMerges(root, { main: `refs/heads/${main}`, checked: lane.head, head: now.head }) : null;
        if (mm?.ok) {
          log(`[train] ${id}: ${lane.task}'s copy gained commits after its check, but ${mm.why}: it closes as landed`);
          ev('main_merges_only', id, `${lane.task}'s copy gained ${mm.commits.length} commit(s) after its check, only merges of ${main} that bring nothing beyond it: what was checked landed, and the task closes as landed`, { task: lane.task, agent: by, to: lane.agent, status: 'ok', meta: { checked: lane.head, head: now.head, commits: mm.commits } });
        } else if (now.head && now.head !== lane.head) {
          if (mm) log(`[train] ${id}: ${lane.task}: the commits after its check are not only merges of main (${mm.why})`);
          ev('partial', id,`${lane.task}'s copy gained commits after its check: what was checked landed; the task stays open and queued`, { task: lane.task, agent: by, to: lane.agent, status: 'warn' });
          requeue(root, lane, { head: now.head });
          continue;
        }
        // 2.76.0 follow-up: a trust-note or known-red landing closes with the record as the train judged it (closeRec).
        const c = deps.close ? deps.close(lane, { train: id, record: v.closeRec || v.rec, head: built.head }) : { ok: true };
        if (c?.ok === false) { ev('close_failed', id, `${lane.task} landed but couldn't be closed: ${c.message}`, { task: lane.task, agent: by, to: 'producer', status: 'warn' }); res.unclosed = [...(res.unclosed || []), { task: lane.task, why: c.message }]; }
        try { dequeue(root, lane.task); } catch {}
        if (lane.union?.length) res.union = [...(res.union || []), { task: lane.task, files: lane.union }];
        res.landed.push(lane.task);
        res.closed = [...(res.closed || []), ...(c?.target ? [c.target] : [])];
      }
      return { ok: true };
    });
  } catch (err) {
    if (err.code !== 'LAND_BUSY') throw err;
    out1 = { ok: false, message: `the land lock was busy too long (${err.message})` };
  }
  if (out1 === 'moved') return 'moved';
  if (!out1.ok) { res.ok = false; res.message = `The train's verify was green but ${main} didn't move: ${out1.message}. Nothing was closed; run the train again.`; log(`[train] ${id}: ${res.message}`); return undefined; }
  if (board) res.boardMove = board;
  if (over) res.overNonCode = over;
  ev('landed', id, `${main} moved to ${built.head.slice(0, 8)} (tree ${built.tree.slice(0, 8)}, verified${v.reused ? ' by an earlier record of this tree' : ''}${board ? `; the verify of ${verified.tree.slice(0, 8)} reused across a board-only move of ${main} (${board.files.join(', ')})` : ''}${over ? `; the verified tree ${verified.tree.slice(0, 8)} with ${over.commits.length} non-code commit(s) of ${main} merged on top` : ''}): ${res.landed.slice(from).join(', ')}`, { agent: by, status: 'ok', meta: { head: built.head, tree: built.tree, lanes: res.landed.slice(from), reused: Boolean(v.reused), ...(v.emptyDiff ? { emptyDiff: true } : {}), ...(board ? { boardMove: board, verifiedTree: verified.tree } : {}), ...(over ? { overNonCode: over, verifiedTree: verified.tree } : {}) } });
  return undefined;
}

const brief = (res) => ({ landed: res.landed, dropped: res.dropped.map((d) => d.task), deferred: res.deferred.map((d) => d.task), ...(res.held?.length ? { held: res.held.map((h) => h.task) } : {}), ...(res.tiers && Object.keys(res.tiers).length ? { tiers: res.tiers } : {}), verifies: res.verifies, reused: res.reused, ...(res.rechecks ? { rechecks: res.rechecks } : {}), ...(res.pinRefresh ? { pinRefresh: res.pinRefresh.lanes } : {}), ...(res.union ? { union: res.union } : {}), ...(res.boardMove ? { boardMove: res.boardMove.files } : {}), ...(res.overNonCode ? { overNonCode: res.overNonCode.commits.map((c) => c.sha) } : {}), ...(res.config ? { config: res.config } : {}), ...(res.redBudget ? { redBudget: res.redBudget } : {}) });
function summary(res) {
  const parts = [];
  if (res.landed.length) parts.push(`landed ${res.landed.join(', ')} with ${res.verifies} verify run(s)${res.reused ? ` (${res.reused} taken from a green record of the same tree)` : ''}${res.boardMove ? ` (kept across a board-only move of main: ${res.boardMove.files.join(', ')})` : ''}${res.overNonCode ? ` (main's ${res.overNonCode.commits.length} new non-code commit(s) merged on top: ${res.overNonCode.files.slice(0, 5).join(', ')})` : ''}${res.rechecks ? ` and ${res.rechecks} re-check(s) of the failing checks` : ''}${res.pinRefresh ? `, plus one pin-refresh commit for ${res.pinRefresh.lanes.join(', ')} (${res.pinRefresh.report})` : ''}${res.union ? `; union-merged ${res.union.map((u) => `${u.files.join(', ')} for ${u.task}`).join('; ')}` : ''}`);
  if (res.dropped.length) parts.push(`handed back ${res.dropped.map((d) => `${d.task} (${d.why.split('\n')[0]})`).join('; ')}`);
  if (res.deferred.length) parts.push(`waiting for the next train: ${res.deferred.map((d) => `${d.task} (${d.why.split('\n')[0]})`).join('; ')}`);
  if (res.config?.length) parts.push(`config proposals: ${res.config.map((c) => `${c.task} applied ${c.applied.join(', ') || 'nothing'}${c.held.length ? `, HELD for a person: ${c.held.map((h) => h.file).join(', ')} (npm run task -- train config ${c.task})` : ''}`).join('; ')}`);
  if (res.held?.length) parts.push(`needs the owner (held in the queue until a person releases it: npm run task -- train release <ID> --by <name>): ${res.held.map((h) => `${h.task} (tier ${h.tier}: ${String(h.why).split('\n')[0].slice(0, 300)})`).join('; ')}`);
  return parts.join('. ') || 'nothing to land';
}

// ---- 2.77.0 (p, P9.6): the speculative train behind a verifying one (harness/train-pipeline.mjs) ----------------

/**
 * B's "did main move" check, the ONE place for it: is main now exactly the tree B assumed (train A's verified head), or
 * that tree plus record files only? The record rule is boardOnlyMove (B-29's board/record paths, task records outside
 * B's lanes); P9.1's record-only rule plugs in here. { land, how: 'same'|'record', files? } | { land: false, why }.
 */
export function nextBaseVerdict(root, { assumed, now, lanes = [] }) {
  // 2.77.0 (maintainer): a record move that needs some checks re-run (P9.1's rechecks: the controls list, a changed
  // approval, reviews, notes) is not one B may land on without verifying: B is discarded and its lanes train normally.
  const recordMove = (r, from, to, l) => {
    const m = boardOnlyMove(r, from, to, boardPaths(), { lanes: l });
    return m?.ok && Array.isArray(m.recheck) && m.recheck.length ? { ok: false, why: `it changes ${m.files.join(', ')}, which needs ${m.recheck.join(', ')} re-run` } : m;
  };
  return speculativeBaseVerdict(root, { assumed, now, lanes }, { recordMove });
}

const nextPollMs = () => 1000;

/**
 * Run the speculative train behind train `after` (opts: { root, after, deps, log, by, quietJob }): its lanes from the
 * queue (not A's; held, tier-C, run-alone-behind-others, waiting and refused lanes left for the next normal train), built
 * on A's verified head in its own scratch copy, ONE verify, then it waits for A: landed exactly that tree (or plus record
 * files): B lands under the train lock without verifying again; anything else: discarded (lanes untouched, a
 * task.train.next_discarded event). Its own lock: .studio/locks/train-next.lock; its own life record (B-88).
 * Returns the train result plus { speculative: true, after, discarded?: why }.
 */
export async function runNextTrain(opts = {}) {
  const root = opts.root || mainRoot();
  const log = opts.log || ((m) => console.error(m));
  const deps = opts.deps || {};
  const after = String(opts.after || '');
  const by = opts.by || NEXT_BY;
  const id = `${stamp()}-${process.pid}`;
  const empty = (message, extra = {}) => ({ ok: true, id, after, speculative: true, landed: [], dropped: [], deferred: [], held: [], tiers: {}, verifies: 0, reused: 0, message, ...extra });
  const stopped = deps.stopped?.();
  if (stopped) return empty(`The studio is stopped (${stopped}): no speculative train.`, { ok: false });
  const a0 = trainState(root, after);
  if (!a0.live || a0.step !== 'verify' || !a0.head) return empty(`No speculative train: train ${after} is not verifying a known tree (${a0.step || 'not running'}).`);
  const nl = takeNextLock(root, { id, after, base: a0.head, by, lanes: [] });
  if (!nl.ok) return empty(`A speculative train is already running (${nl.holder?.id || '?'}).`, { busy: nl.holder });
  const t0 = Date.now();
  let res;
  try {
    res = await livedTrain(root, { id, by, dryRun: false }, (life) => nextBody({ root, log, deps, id, by, after, a0, lock: nl, life }));
  } finally { nl.release(); writeTrainsSummary(root); }
  if (!opts.quietJob) trainJobDone(res, t0, { extra: { speculative: true, after, ...(res.discarded ? { discarded: res.discarded } : {}) } });
  return res;
}

async function nextBody({ root, log, deps, id, by, after, a0, lock, life }) {
  const res = { ok: true, id, after, speculative: true, landed: [], dropped: [], deferred: [], held: [], tiers: {}, verifies: 0, reused: 0, message: '' };
  const main = mainBranch(root);
  const base = a0.head;
  const tip0 = out(git(root, 'rev-parse', `refs/heads/${main}`));
  const L = (m) => log(`[train] ${id} (speculative, after ${after}): ${m}`);
  const status = (step, text, extra = {}) => writeTrainStatus(root, id, { step, text: String(text).slice(0, 400), speculative: true, after, base, eta: null, ...extra });
  let names = [];
  const end = (message) => { res.message = message; L(message); status('done', message, { lanes: names.length || null }); return res; };
  const discard = (why) => {
    res.discarded = why;
    res.message = `Speculative train ${id} discarded: ${why}${names.length ? `. ${names.join(', ')} keep their place in the train queue (no hand-back) and go in the next normal train` : ''}.`;
    L(res.message);
    ev('next_discarded', id, `discarded: ${why}${names.length ? `; ${names.join(', ')} keep their place in the queue (no hand-back)` : ''}`, { agent: by, status: 'warn', meta: { after, base, why, lanes: names, speculative: true } });
    status('done', `discarded: ${why}`, { lanes: names.length || null });
    return res;
  };

  // (a) Which queued lanes go: the cheap facts, the tier (as A judges it), then the pick (pure), then the precheck.
  status('precheck', `choosing lanes behind train ${after}`);
  const settings0 = await trainManifest(root, tip0);
  const aTasks = new Set(a0.tasks);
  const cands = readQueue(root).map((l) => ({ ...l, fromQueue: true })).filter((l) => !aTasks.has(l.task));
  if (!cands.length) return end(`no lane is queued behind train ${after}`);
  let fixTask = null;
  try { fixTask = fixFirstOrder(root, cands, { tip: tip0, gameIds: gameGateIds(root), headOf: (l) => laneNow(l).head || null }).fix?.task || null; } catch {}
  const waits = laneWaits(root, cands, deps);
  try { waits.push(...chainTailWaits(root, cands.filter((l) => !waits.some((w) => w.lane === l)), deps)); } catch {}
  const rows = [];
  for (const l of cands) {
    const row = { task: l.task, lane: l };
    const w = waits.find((x) => x.lane === l);
    if (w) row.wait = w.why;
    if (l.task === fixTask) row.fixFirst = true;
    if (heldNow(l)) row.held = l.held;
    if (taskHoldOf(root, l.task)) row.out = true;
    if (!row.wait && !row.held && !row.out && !row.fixFirst) {
      const now = laneNow(l);
      if (now.error) row.wait = now.error;
      else if (l.branch && now.branch && now.branch !== l.branch) row.wait = `its copy is on ${now.branch} now`;
      else if (git(root, 'merge-base', '--is-ancestor', now.head, base).status === 0) row.wait = `it is already in train ${after}'s tree`;
      else {
        row.head = now.head;
        row.branch = now.branch || l.branch;
        if (!/^(off|0|false|no)$/i.test(process.env.STUDIO_TRAIN_MIXED || '')) {
          const dc = depContext(root, deps);
          const allowed = mayCarry(root, l.task, dc.map);
          const m = mixedLane(root, { task: l.task, tip: tip0, head: now.head, open: (t) => (dc.states?.open ? dc.states.open.has(t) : true) && !allowed.has(t) });
          if (m.mixed) row.wait = m.why;
        }
        const c = await laneTier(root, { head: now.head, task: l.task, agent: l.agent, dir: l.dir }, { tip: tip0, settings: settings0 });
        const kept = releasedFor(l, now.head) ? null : keptRelease(root, l.task, now.head);
        row.tier = c.tier;
        row.runAlone = c.runAlone;
        row.all = Boolean(c.needs.all);
        row.released = releasedFor(l, now.head) ? l.released : kept || null;
        if (c.needs.goldenReason.length) row.needs = 'it moves goldens with no Golden-Reason trailer';
        else if (c.needs.pinMoves.length) row.needs = 'it changes pinned expectations with no Pin-Moves trailer';
        const cp = laneProposal(root, { task: l.task, head: now.head, tip: tip0 });
        if (cp && !cp.ok) row.needs = `its config proposal: ${cp.why}`;
        if (c.tier === 'B' && !row.released && (deps.handBacks || handBackCount)(l.task) > maxHandBacks()) row.capped = true;
      }
    }
    rows.push(row);
  }
  const pick = pickNextLanes(rows, { batch: batchSize() });
  if (pick.wait) return end(`waits as before: ${pick.wait}`);
  for (const sk of pick.skipped) L(`${sk.task} is left for the next normal train: ${sk.why}`);
  const ready = [];
  for (const r of pick.lanes) {
    status('precheck', `checking ${r.task} in its own copy`);
    const lane = { ...r.lane, head: r.head, branch: r.branch };
    const pre = (deps.precheck || ((x) => precheckChild(root, x)))(lane);
    if (!pre.ok || (pre.head && pre.head !== r.head)) { L(`${r.task} is left for the next normal train: ${pre.ok ? 'its copy changed while it was checked' : String(pre.message || 'its checks failed').split('\n')[0].slice(0, 300)}`); continue; }
    ready.push({ ...lane, all: Boolean(pre.all || lane.all || r.all), tier: r.tier, runAlone: r.runAlone, released: r.released || null });
    res.tiers[r.task] = r.tier;
  }
  if (!ready.length) return end(`no lane behind train ${after} can go speculatively`);
  names = ready.map((l) => l.task);
  const judge = () => judgeTrainA({ a: trainState(root, after), base, tip0, mainNow: out(git(root, 'rev-parse', `refs/heads/${main}`)), verdict: (now) => nextBaseVerdict(root, { assumed: base, now, lanes: names }) });
  const j0 = judge();
  if (j0.discard) return discard(j0.discard);

  // (b) Build train A's tree + these lanes in its own scratch copy, then ONE verify.
  lock.update({ lanes: names });
  life?.lanes(ready);
  ev('start', id, `${names.length} lane(s) speculatively on train ${after}'s tree ${base.slice(0, 8)}: ${names.join(', ')}`, { agent: by, meta: { lanes: names, speculative: true, after, base } });
  for (const l of ready) deps.markRunning?.(l.task, l.agent);
  let sc = null;
  try {
    status('build', `building train ${after}'s tree + ${names.join(', ')}`, { lanes: names.length, tasks: names });
    sc = makeScratch(root, id, base);
    if (sc.error) { const why = sc.error; sc = null; return discard(`its scratch copy couldn't be made: ${why}`); }
    const settings = await trainManifest(root, tip0);
    const built = buildIntegration(sc, base, ready, { id, unionFiles: settings.unionFiles });
    for (const l of [...built.deferred, ...built.conflictMain]) L(`${l.task} is left for the next normal train: ${l.why}`);
    const set = built.included;
    if (!set.length) return discard(`no lane merges onto train ${after}'s tree`);
    names = set.map((l) => l.task);
    lock.update({ lanes: names });
    const j1 = judge();
    if (j1.discard) return discard(j1.discard);
    status('verify', `verify of train ${after}'s tree + ${names.join(', ')} (speculative)`, { lanes: names.length, head: built.head, tree: built.tree, tasks: names });
    const v = await verifyRemoteFirst(sc, { id, n: 1, tree: built.tree, changed: changedVs(sc.dir, tip0, built.head), all: set.some((l) => l.all), seen: new Map(), tasks: [...a0.tasks, ...names], lanes: set, whole: wholeEquiv(root, tip0, settings), log }, { head: built.head, by, deps, res });
    if (!v.cached && !v.reused && !v.remote) res.verifies += 1;
    if (v.reused) res.reused += 1;
    // (c) Wait for train A's outcome (B holds no machine claim while it waits), then land or discard.
    status(v.ok ? 'ready' : 'waiting', v.ok ? `green on train ${after}'s tree + ${names.join(', ')}; lands right after train ${after}` : `red (${v.why}); waits for train ${after}'s result`, { lanes: names.length, head: built.head, tree: built.tree, tasks: names });
    if (v.ok) L(`green on train ${after}'s tree + ${names.join(', ')}; it lands right after train ${after} if ${main} is then exactly that tree`);
    const stale = Number(process.env.STUDIO_TRAIN_STALE_MIN || 360) * 60000;
    let j = judge();
    for (const t1 = Date.now(); j.wait && Date.now() - t1 < stale; j = judge()) {
      const st = deps.stopped?.();
      if (st) return discard(`the studio was stopped (${st})`);
      sleep(nextPollMs());
    }
    if (j.wait) return discard(`train ${after} is still running after STUDIO_TRAIN_STALE_MIN`);
    if (j.discard) return discard(j.discard);
    if (!v.ok) return discard(v.noCheck ? `its verify ran no check (${v.why})` : `its own verify on train ${after}'s tree was red (${v.why}; log ${v.log || '-'}): the next normal train bisects it`);
    if (j.how === 'record') L(`${main} moved past train ${after}'s tree by record files only (${(j.files || []).join(', ')}): the verify stands`);
    // (d) Land, under the train lock (never two trains landing at once): main moves only from the tree B assumed.
    status('landing', `landing ${names.join(', ')} right after train ${after}`, { lanes: names.length, head: built.head, tree: built.tree, tasks: names });
    const r = await withTrainLock(root, { id, by, speculative: true, after }, () => {
      const q = readQueue(root);
      const gone = set.filter((l) => !q.some((e) => e.task === l.task));
      if (gone.length) return { gone: gone.map((l) => l.task) };
      const lt = landTrain(root, sc, main, base, { built, v }, { id, by, deps, log, res, unionFiles: settings.unionFiles });
      return lt === 'moved' ? { moved: true } : { done: true };
    }, { waitMs: 10 * 60000, poll: 500, log });
    if (r?.busy) return discard(`the train lock stayed busy (${r.busy.id || '?'}, by ${r.busy.by || '?'})`);
    if (r?.gone) return discard(`${r.gone.join(', ')} left the train queue while it verified`);
    if (r?.moved) return discard(`${main} moved before it could land`);
    if (res.landed.length) noteTrainLanded(root);
  } finally {
    for (const l of ready) deps.clearRunning?.(l.task);
    if (sc) removeScratch(sc);
  }
  if (res.ok) res.ok = res.landed.length > 0;
  res.message = res.message || `speculative train after ${after}: ${summary(res)}`;
  status('done', `done: ${res.message.slice(0, 300)}`, { lanes: names.length || null });
  ev('done', id, res.message, { agent: by, status: res.landed.length ? 'ok' : 'warn', meta: { ...brief(res), speculative: true, after, base } });
  return res;
}

/** 2.72.0 (b): a lane the train handed back is one red round of its task (harness/round-cap.mjs), signed by its reason. */
export function trainRound(lane, why) {
  if (!lane?.task || !lane?.agent) return null;
  return recordRound({ task: lane.task, agent: lane.agent, ok: false, sig: redSignature(String(why || ''), { gate: 'train' }), source: 'train' });
}
