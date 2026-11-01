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
 *   6. red: each lane is verified alone on main; one that fails alone is handed back with the failing checks; the rest
 *      train again. Lanes that pass alone but fail together: the last one waits for the next train. When every lane
 *      fails alone, main itself is verified: red main hands nobody back.
 *
 * Safety: main moves only after a green full verify of exactly the tree it ends at, and only from the tip the train
 * was built on (if main moved meanwhile, the train is rebuilt and verified again); one train at a time
 * (.studio/locks/train.lock); drain and stop are respected; the verify takes gate slots as a landing
 * (STUDIO_GATE_PRIORITY=landing). A lane that gained commits after its check lands as checked and stays queued.
 *
 * `task done <ID>` in a lane copy is a one-lane train (STUDIO_TRAIN=off: the old deliver path). This module never
 * imports harness/task.mjs (its CLI imports this one): the board operations come in as `deps`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { emitEvent } from './event.mjs';
import { mainRoot, mainBranch, linkDir, nodeModuleDirs, ignoreLanes, landFastForward, forgetLanded, rememberTaskBranch, LANES_DIR } from './worktree.mjs';
import { withLandLock, judgeVerifyReuse } from './merge-lane.mjs';
import { engineGates, relatedTestsOn } from './game-gates.mjs';
import { readBaseline, judgeRed } from './baseline.mjs';

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(q, null, 2)}\n`);
  fs.renameSync(tmp, f);
}
const withQueue = (root, fn) => withLandLock(root, () => { const q = readQueue(root); const r = fn(q); writeQueue(root, q); return r; }, { name: 'train-queue', waitMs: 30000 });

/** Put a checked lane in the queue (replacing the task's older entry). entry: { task, agent, dir, branch, head, all }. */
export function enqueue(root, entry) {
  return withQueue(root, (q) => {
    const i = q.findIndex((e) => e.task === entry.task);
    const rec = { ...entry, at: new Date().toISOString() };
    if (i >= 0) q.splice(i, 1, { ...rec, at: q[i].at });
    else q.push(rec);
    return rec;
  });
}
export function dequeue(root, task) {
  return withQueue(root, (q) => { const i = q.findIndex((e) => e.task === task); if (i >= 0) q.splice(i, 1); return i >= 0; });
}
const requeue = (root, lane, patch) => withQueue(root, (q) => { const e = q.find((x) => x.task === lane.task); if (e) Object.assign(e, patch); });

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

/**
 * Reset the scratch copy to `tip` and merge the lanes in order. Returns { included, deferred, conflictMain, head, tree }.
 * A lane is merged at its checked head (never its branch name, which may move). A merge that stops (a conflict, or a
 * commit hook refusing) is aborted: the lane waits for the next train if it merges cleanly onto main alone, else it
 * conflicts with main (conflictMain) and is handed back.
 */
export function buildIntegration(sc, tip, lanes, { id }) {
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
    const m = spawnSync('git', ['-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local', 'merge', '--ff', '--no-edit', '-m', msg, lane.head], { cwd: dir, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
    if (m.status === 0) { included.push({ ...lane, before, after: out(git(dir, 'rev-parse', 'HEAD')) }); continue; }
    git(dir, 'merge', '--abort');
    git(dir, 'reset', '-q', '--hard', before);
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
 * May this verify record stand for the train's verify of `tree`? The same rules as task done's (merge-lane.mjs
 * judgeVerifyReuse: same tree, clean, at least as wide, engine gate, not related-only, at most 24 h old), and every
 * required row green (task done reruns the safety checks itself; a train has only this verify).
 */
export function recordCovers(rec, { root, tree, changed, all = false }) {
  if (!recordGreen(rec)) return { ok: false, why: 'not a green full verify' };
  if (all && rec.scoped) return { ok: false, why: 'scoped, and this train needs the whole game (--all)' };
  const recTree = rec.head && /^[0-9a-f]{40,64}$/.test(String(rec.head)) ? out(git(root, 'rev-parse', '--verify', '--quiet', `${rec.head}^{tree}`)) : '';
  const hadPaths = Array.isArray(rec.gatePaths) ? rec.gatePaths : rec.scoped ? rec.changed || [] : [];
  return judgeVerifyReuse(rec, { tree, recTree: recTree || null, clean: true, changed: changed?.length ? changed : null, needEngine: engineGates(changed || []).map((e) => e.project), hadEngine: engineGates(hadPaths).map((e) => e.project), relatedNow: relatedTestsOn(), maxAgeH: Number(process.env.STUDIO_DONE_REUSE_MAX_H || 24) });
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

/** Recorded full verifies in the shared .studio/ (each agent's own, the studio's, earlier trains'). */
function recordedVerifies(root) {
  const files = [];
  const add = (f) => { try { files.push(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch {} };
  add(path.join(root, '.studio', 'gates-last-full.json'));
  for (const d of [path.join(root, '.studio', 'gates'), path.join(root, TRAIN_DIR, 'records')]) {
    try { for (const n of fs.readdirSync(d)) if (n.endsWith('-full.json') || d.endsWith('records')) add(path.join(d, n)); } catch {}
  }
  return files;
}

/** The FAIL lines of a verify's output, for a hand-back note: the gates, and the game checks' own lines. */
export function failLines(text) {
  const lines = String(text || '').split('\n');
  const gates = [...new Set(lines.map((l) => (l.match(/^\[gates\] FAIL (\S+)/) || [])[1]).filter(Boolean))];
  const detail = lines.filter((l) => /\bFAIL\b|Error:|failed/i.test(l) && !/^\[gates\] (FAIL|in plain words)/.test(l)).slice(-8).map((l) => l.trim().slice(0, 240));
  return { gates, detail };
}

/**
 * Verify the scratch copy's tree once (or take a record that already covers it). Returns
 * { ok, reused?, cached?, rec, gates, detail, log }. `seen` caches the runs by tree for this train; `tasks` are the
 * lanes in it, whose claim baselines may excuse checks that were already red (excusedRed).
 */
export function verifyTree(sc, { id, n, tree, changed, all, seen, tasks = [], log = () => {} }) {
  const judged = (raw) => {
    if (raw.ok || raw.reused || !raw.rec || raw.rec.tree !== tree || (all && raw.rec.scoped)) return raw;
    const ex = excusedRed(raw.rec, tasks);
    return ex.ok ? { ...raw, ok: true, excused: ex.excused } : raw;
  };
  if (seen.has(tree)) return { ...judged(seen.get(tree)), cached: true };
  const root = sc.root;
  for (const rec of recordedVerifies(root)) {
    if (rec.tree !== tree) continue;
    const c = recordCovers(rec, { root, tree, changed, all });
    if (c.ok) {
      log(`[train] ${id}: the tree ${tree.slice(0, 8)} already has a green full verify (${c.why}); not run again`);
      const res = { ok: true, reused: true, rec, gates: [], detail: [] };
      seen.set(tree, res);
      return res;
    }
  }
  const owner = `train-${id}`;
  const env = { ...process.env, STUDIO_MAIN_ROOT: root, STUDIO_LOCK_OWNER: owner, STUDIO_GATE_PRIORITY: 'landing', STUDIO_VERIFY_DETACH: 'off' };
  for (const k of ['STUDIO_GATE_CHANGED', 'STUDIO_GATE_PATHS', 'STUDIO_GATE_INCOMING_FILE', 'STUDIO_VERIFY_RUN', 'npm_lifecycle_event', 'STUDIO_TASK_BASE']) delete env[k];
  const t0 = Date.now();
  log(`[train] ${id}: verify ${n} of tree ${tree.slice(0, 8)} (${changed.length} changed file(s)${all ? ', --all' : ''})`);
  const r = spawnSync(process.execPath, [path.join(sc.dir, 'scripts', 'run-gates.mjs'), '--no-detach', ...(all ? ['--all'] : [])], { cwd: sc.dir, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
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
  const ok = r.status === 0 && recordGreen(rec) && rec.tree === tree && (!all || !rec.scoped);
  const { gates, detail } = failLines(text);
  const why = ok ? '' : r.status !== 0 ? `failed: ${gates.join(', ') || `exit ${r.status}`}` : !rec ? 'wrote no verify record' : rec.tree !== tree ? `tested tree ${String(rec.tree).slice(0, 8)}, not ${tree.slice(0, 8)}` : 'its record is not a clean full verify';
  emitEvent({ type: 'task.train.verify', agent: owner, status: ok ? 'ok' : 'blocked', msg: `train ${id}: verify ${n} of ${tree.slice(0, 8)} ${ok ? 'green' : why} in ${Math.round((Date.now() - t0) / 1000)} s`, meta: { train: id, tree, ok, gates, ms: Date.now() - t0 } });
  const res = { ok, rec, gates, detail, why, log: path.relative(root, logFile).split(path.sep).join('/') };
  seen.set(tree, res);
  const j = judged(res);
  if (j.excused?.length) log(`[train] ${id}: red only in ${j.excused.join(', ')}, already red when ${tasks.join(', ')} ${tasks.length === 1 ? 'was' : 'were'} claimed: counts as green, as at task done`);
  return j;
}

// ---- the train ---------------------------------------------------------------------------------------

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const ev = (type, id, msg, extra = {}) => emitEvent({ type: `task.train.${type}`, agent: extra.agent || 'train', task: extra.task, to: extra.to, status: extra.status, msg: `train ${id}: ${msg}`.slice(0, 600), meta: { train: id, ...(extra.meta || {}) } });

/** Read a queue entry's lane copy as it is now: { dir, branch, head } or { error }. */
export function laneNow(lane) {
  if (!lane.dir || !fs.existsSync(lane.dir)) return { error: `its lane copy ${lane.dir || '(none)'} is gone` };
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
  const env = { ...process.env, STUDIO_MAIN_ROOT: root, STUDIO_LOCK_OWNER: lane.agent };
  const r = spawnSync(process.execPath, [script, 'done', lane.task, '--agent', lane.agent, '--train-check'], { cwd: lane.dir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
export async function runTrain(opts = {}) {
  const root = opts.root || mainRoot();
  const log = opts.log || ((m) => console.error(m));
  const deps = opts.deps || {};
  const id = `${stamp()}-${process.pid}`;
  const by = opts.by || process.env.STUDIO_LOCK_OWNER || 'human';
  const stopped = deps.stopped?.();
  if (stopped) return { ok: false, id, message: `The studio is stopped (${stopped}); no train runs until npm run task -- resume.`, landed: [], dropped: [], deferred: [] };
  if (!opts.dryRun && deps.waitForDrain) {
    const w = await deps.waitForDrain();
    if (!w.ok) return { ok: false, id, message: w.message, landed: [], dropped: [], deferred: [] };
  }
  const locked = await withTrainLock(root, { id, by }, () => trainBody({ ...opts, root, log, deps, id, by }), { waitMs: opts.waitMs ?? 0, log });
  if (locked?.busy) return { ok: false, id, busy: locked.busy, message: `Another train is running (${locked.busy.id || '?'}, by ${locked.busy.by || '?'}); run this again when it ends.`, landed: [], dropped: [], deferred: [] };
  return locked;
}

/** Scratch copies and train/* branches a killed train left (only called while holding the train lock). */
function sweepScratch(root, log) {
  const d = path.join(root, LANES_DIR);
  let names = [];
  try { names = fs.readdirSync(d).filter((n) => n.startsWith('_train-')); } catch {}
  for (const n of names) { removeScratch({ dir: path.join(d, n), root, name: n, branch: `train/${n.slice('_train-'.length)}` }); log(`[train] removed ${LANES_DIR}/${n}, left by a train that didn't finish`); }
  for (const b of out(git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/train/')).split('\n').filter(Boolean)) git(root, 'branch', '-D', b);
}

async function trainBody({ root, log, deps, id, by, lanes: given, max, dryRun = false, oneLane = false }) {
  const res = { ok: true, id, landed: [], dropped: [], deferred: [], verifies: 0, reused: 0, message: '' };
  sweepScratch(root, log);
  const queued = !given;
  let lanes = given ? given.map((l) => ({ ...l })) : readQueue(root);
  if (Number(max) > 0) lanes = lanes.slice(0, Number(max));
  if (!lanes.length) { res.message = 'No lane is waiting to land (the train queue is empty: task done <ID> --train adds one).'; return res; }
  ev('start', id, `${lanes.length} lane(s): ${lanes.map((l) => l.task).join(', ')}${dryRun ? ' (dry run)' : ''}`, { agent: by, meta: { lanes: lanes.map((l) => l.task), dryRun } });
  (await import('./hotspots.mjs')).trainStart(root, lanes, log, id); // 2.60.0 (helper b): lines two lanes change, in the start log
  const drop = (lane, why, { handBack = true } = {}) => {
    res.dropped.push({ task: lane.task, why });
    if (dryRun) return;
    if (queued) dequeue(root, lane.task);
    ev('dropped', id, `${lane.task} handed back: ${why}`, { task: lane.task, agent: by, to: lane.agent, status: 'blocked' });
    if (handBack && !oneLane) {
      try { if (lane.branch) rememberTaskBranch(lane.task, lane.branch); } catch {}
      try { deps.handBack?.(lane, `Not landed by merge train ${id}: ${why}`); } catch (e) { log(`[train] ${id}: could not hand ${lane.task} back: ${e.message}`); }
    }
  };
  const defer = (lane, why) => { res.deferred.push({ task: lane.task, why }); if (!dryRun) ev('deferred', id, `${lane.task} waits for the next train: ${why}`, { task: lane.task, agent: by, to: lane.agent, status: 'warn' }); };

  // (a) The lanes, as they are now, each checked again in its own copy.
  const ready = [];
  for (const lane of lanes) {
    const now = laneNow(lane);
    if (now.error) { drop(lane, now.error, { handBack: false }); continue; }
    if (lane.branch && now.branch && now.branch !== lane.branch) { drop(lane, `its copy is on ${now.branch} now, not ${lane.branch}; queue it again`, { handBack: false }); continue; }
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
    ready.push({ ...lane, head: now.head, branch: now.branch || lane.branch, all: Boolean(pre.all || lane.all) });
  }
  if (!ready.length) { res.ok = !res.dropped.length; res.message = summary(res); ev('done', id, res.message, { agent: by, meta: brief(res) }); return res; }

  const main = mainBranch(root);
  for (const l of ready) deps.markRunning?.(l.task, l.agent);
  let sc = null;
  try {
    for (let attempt = 0; attempt < Number(process.env.STUDIO_TRAIN_TRIES || 3); attempt += 1) {
      const tip = out(git(root, 'rev-parse', `refs/heads/${main}`));
      if (!sc) {
        sc = makeScratch(root, id, tip);
        if (sc.error) { res.ok = false; res.message = `The train couldn't make its scratch copy: ${sc.error}`; sc = null; return res; }
      }
      const seen = new Map();
      let set = ready.filter((l) => !res.dropped.some((d) => d.task === l.task) && !res.deferred.some((d) => d.task === l.task));
      // (b) Build: main + each lane, in order.
      let built = buildIntegration(sc, tip, set, { id });
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
      const all = set.some((l) => l.all);
      // (c) ONE full verify of the final tree; (e) red: find who fails alone.
      let verdict = null;
      for (let round = 0; set.length && round <= ready.length + 1; round += 1) {
        if (round > 0) built = buildIntegration(sc, tip, set, { id });
        if (built.conflictMain.length || built.deferred.length) {
          for (const l of built.conflictMain) drop(l, l.why);
          for (const l of built.deferred) defer(l, l.why);
          set = built.included;
          if (!set.length) break;
        }
        const v = verifyTree(sc, { id, n: res.verifies + 1, tree: built.tree, changed: changedVs(sc.dir, tip, built.head), all, seen, tasks: set.map((l) => l.task), log });
        if (!v.cached && !v.reused) res.verifies += 1;
        if (v.reused) res.reused += 1;
        if (v.ok) { verdict = { built, v }; break; }
        ev('red', id, `the train of ${set.map((l) => l.task).join(', ')} is red (${v.why}); log ${v.log || '-'}`, { agent: by, status: 'blocked', meta: { lanes: set.map((l) => l.task), gates: v.gates } });
        if (set.length === 1) {
          drop(set[0], `the checks fail on main + this lane (${v.gates.join(', ') || v.why})${v.detail.length ? `:\n${v.detail.join('\n')}` : ''}\nFull log: ${v.log || '(none)'}. Fix it in your copy, commit, run npm run verify, then task done again`);
          set = [];
          break;
        }
        // Each lane alone on main.
        const alone = [];
        for (const l of set) {
          const b1 = buildIntegration(sc, tip, [l], { id });
          if (!b1.included.length) { drop(l, (b1.conflictMain[0] || b1.deferred[0])?.why || 'it no longer merges onto main'); continue; }
          const v1 = verifyTree(sc, { id, n: res.verifies + 1, tree: b1.tree, changed: changedVs(sc.dir, tip, b1.head), all: Boolean(l.all), seen, tasks: [l.task], log });
          if (!v1.cached && !v1.reused) res.verifies += 1;
          if (v1.reused) res.reused += 1;
          alone.push({ l, v1 });
        }
        ev('bisect', id, alone.map(({ l, v1 }) => `${l.task} alone: ${v1.ok ? 'green' : 'red'}`).join(', '), { agent: by, meta: { alone: alone.map(({ l, v1 }) => ({ task: l.task, ok: v1.ok })) } });
        const bad = alone.filter((x) => !x.v1.ok);
        if (bad.length && bad.length === alone.length) {
          // Every lane fails alone: is main itself red? Then nobody is handed back.
          const b0 = buildIntegration(sc, tip, [], { id });
          const v0 = verifyTree(sc, { id, n: res.verifies + 1, tree: b0.tree, changed: [], all: false, seen, tasks: alone.map(({ l }) => l.task), log });
          if (!v0.cached && !v0.reused) res.verifies += 1;
          if (!v0.ok) {
            res.ok = false;
            res.redMain = true;
            res.message = `${main} itself fails its checks (${v0.gates.join(', ') || v0.why}; log ${v0.log || '-'}): nothing landed and no lane was handed back. Fix ${main} first.`;
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
      if (!verdict) break;
      // (d) Green: main moves to exactly the verified tree, then each task closes.
      const landed = landTrain(root, sc, main, tip, verdict, { id, by, deps, log, res });
      if (landed === 'moved') {
        ev('moved', id, `${main} moved while the train was verified; building it again on the new ${main}`, { agent: by, status: 'warn' });
        continue;
      }
      break;
    }
  } finally {
    for (const l of ready) deps.clearRunning?.(l.task);
    if (sc) removeScratch(sc);
  }
  if (res.ok) res.ok = res.landed.length > 0 || (!res.dropped.length && !res.deferred.length);
  res.message = res.message || summary(res);
  ev('done', id, res.message, { agent: by, status: res.landed.length ? 'ok' : 'warn', meta: brief(res) });
  return res;
}

/**
 * Under the land lock: if main is still at `tip`, move it to the verified head (compare-and-swap, the main checkout's
 * files follow) and close each lane's task. A lane whose copy gained commits after its check lands as checked (its
 * content is in the verified tree) but stays queued with its new commits. Returns 'moved', or nothing.
 */
function landTrain(root, sc, main, tip, { built, v }, { id, by, deps, log, res }) {
  let out1;
  try {
    out1 = withLandLock(root, () => {
      if (out(git(root, 'rev-parse', `refs/heads/${main}`)) !== tip) return 'moved';
      if (out(git(root, 'rev-parse', `${sc.branch}^{tree}`)) !== built.tree) return { ok: false, message: 'the train branch changed after its verify' };
      const ff = landFastForward(root, main, sc.branch, { taskId: `train ${id}` });
      if (!ff.ok) return { ok: false, message: ff.message };
      for (const lane of built.included) {
        const now = laneNow(lane);
        forgetLanded(lane.task, lane.branch, root);
        emitEvent({ type: 'lane.merged', agent: lane.agent, task: lane.task, msg: `${lane.task}: ${lane.branch || lane.head.slice(0, 8)} added to ${main} by train ${id}` });
        if (now.head && now.head !== lane.head) {
          ev('partial', id, `${lane.task}'s copy gained commits after its check: what was checked landed; the task stays open and queued`, { task: lane.task, agent: by, to: lane.agent, status: 'warn' });
          requeue(root, lane, { head: now.head });
          continue;
        }
        const c = deps.close ? deps.close(lane, { train: id, record: v.rec, head: built.head }) : { ok: true };
        if (c?.ok === false) { ev('close_failed', id, `${lane.task} landed but couldn't be closed: ${c.message}`, { task: lane.task, agent: by, to: 'producer', status: 'warn' }); res.unclosed = [...(res.unclosed || []), { task: lane.task, why: c.message }]; }
        try { dequeue(root, lane.task); } catch {}
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
  ev('landed', id, `${main} moved to ${built.head.slice(0, 8)} (tree ${built.tree.slice(0, 8)}, verified${v.reused ? ' by an earlier record of this tree' : ''}): ${res.landed.join(', ')}`, { agent: by, status: 'ok', meta: { head: built.head, tree: built.tree, lanes: res.landed, reused: Boolean(v.reused) } });
  return undefined;
}

const brief = (res) => ({ landed: res.landed, dropped: res.dropped.map((d) => d.task), deferred: res.deferred.map((d) => d.task), verifies: res.verifies, reused: res.reused });
function summary(res) {
  const parts = [];
  if (res.landed.length) parts.push(`landed ${res.landed.join(', ')} with ${res.verifies} verify run(s)${res.reused ? ` (${res.reused} taken from a green record of the same tree)` : ''}`);
  if (res.dropped.length) parts.push(`handed back ${res.dropped.map((d) => `${d.task} (${d.why.split('\n')[0]})`).join('; ')}`);
  if (res.deferred.length) parts.push(`waiting for the next train: ${res.deferred.map((d) => `${d.task} (${d.why.split('\n')[0]})`).join('; ')}`);
  return parts.join('. ') || 'nothing to land';
}

/** The lane copy this process runs in, as a train lane: { dir, branch, head } (task done's one-lane train). */
export function thisLane(dir) {
  return { dir, branch: out(git(dir, 'symbolic-ref', '--short', 'HEAD')), head: out(git(dir, 'rev-parse', 'HEAD')) };
}
