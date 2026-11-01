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
 *      added lines kept, ours first) and the merge commit says so (Union-Merge:); any other conflict is as before.
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
import { withLandLock, judgeVerifyReuse, matchAny, withGateSlot } from './merge-lane.mjs';
import { engineGates, relatedTestsOn, studioGame } from './game-gates.mjs';
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

// ---- 2.60.0: the game's train settings (pins, unionFiles) -----------------------------------------------

/**
 * The train's part of a game manifest (pure; see docs/ONBOARDING-A-GAME.md "Pins and union files"):
 *   "pins": { "tests": [<test names or globs>], "report": "<cmd with {out}>", "refresh": "<cmd with {in}>",
 *             "invariants": [<pin names or globs never auto-refreshed>] }
 *   "unionFiles": [<repo-relative paths or globs of one-import-per-line files>]
 * Returns { pins: {...} | null, unionFiles: [], notes: [problems] }. A pins block with a problem is off (noted).
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
  return { pins, unionFiles, notes };
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
    const merge = (extra, message) => spawnSync('git', [...extra, '-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local', 'merge', '--ff', '--no-edit', '-m', message, lane.head], { cwd: dir, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
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
function recheck(sc, { id, tree, gates, changed, all, cache, log, res, label }) {
  const key = `${tree}:${gates.join(',')}`;
  if (cache.has(key)) return cache.get(key);
  const root = sc.root;
  const owner = `train-${id}-re`;
  const env = { ...process.env, STUDIO_MAIN_ROOT: root, STUDIO_LOCK_OWNER: owner, STUDIO_GATE_PRIORITY: 'landing', STUDIO_VERIFY_DETACH: 'off' };
  for (const k of ['STUDIO_GATE_CHANGED', 'STUDIO_GATE_PATHS', 'STUDIO_GATE_INCOMING_FILE', 'STUDIO_VERIFY_RUN', 'npm_lifecycle_event', 'STUDIO_TASK_BASE']) delete env[k];
  if (!all && changed.length) { env.STUDIO_GATE_CHANGED = changed.join(','); env.STUDIO_GATE_PATHS = changed.join(','); }
  res.rechecks = (res.rechecks || 0) + 1;
  const n = res.rechecks;
  log(`[train] ${id}: re-check ${n}: ${gates.join(', ')} on ${label} (tree ${tree.slice(0, 8)})`);
  const r = spawnSync(process.execPath, [path.join(sc.dir, 'scripts', 'run-gates.mjs'), '--no-detach', '--only', gates.join(','), ...(all ? ['--all'] : [])], { cwd: sc.dir, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const logFile = path.join(root, TRAIN_DIR, `${id}-recheck-${n}.log`);
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, text); } catch {}
  for (const f of [`${owner}.json`, `${owner}-full.json`]) { try { fs.rmSync(path.join(root, '.studio', 'gates', f), { force: true }); } catch {} }
  const { gates: failed, detail } = failLines(text);
  const c = { ok: r.status === 0, gates: failed, detail, text, log: path.relative(root, logFile).split(path.sep).join('/') };
  cache.set(key, c);
  return c;
}

/** Run the pins' report on the scratch copy's tree: { report } ({ pin: value }) or { error }. Cached by tree. */
function pinReport(sc, pins, { id, k, tree, cache, log }) {
  if (cache.has(tree)) return cache.get(tree);
  const f = path.join(sc.root, TRAIN_DIR, String(id), `pins-report-${k}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  try { fs.rmSync(f, { force: true }); } catch {}
  const cmd = pins.report.split('{out}').join(`"${f}"`);
  const env = /^(off|0|false|no)$/i.test(process.env.STUDIO_GAME_GATE_CI || '') ? process.env : { ...process.env, CI: 'true' };
  const r = withGateSlot(sc.root, `train-${id}-pins`, () => spawnSync(cmd, { cwd: sc.dir, shell: true, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, timeout: Number(process.env.STUDIO_GAME_GATE_TIMEOUT_MS || 600000) }), { log });
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
function redPlan(ctx, { pins: tryPins = true, bisect = true } = {}) {
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
  const check = (k) => { const b = prefix(k); if (!b) return null; return { ...recheck(sc, { id, tree: b.tree, gates: failGates, changed, all, cache: cache.checks, log, res, label: label(k) }), b }; };
  const steps = [];
  const c0 = check(0);
  if (!c0) return { kind: 'alone', why: `${main} alone doesn't build` };
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
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const c = check(mid);
    if (!c) return { kind: 'alone', why: `${label(mid)} doesn't build` };
    steps.push({ prefix: set.slice(0, mid).map((l) => l.task), ok: c.ok });
    if (c.ok) lo = mid; else { hi = mid; red = c; }
  }
  if (!red) {
    // Only the full verify said the whole train is red: confirm it before anyone is handed back.
    const c = check(hi);
    if (!c) return { kind: 'alone', why: `${label(hi)} doesn't build` };
    steps.push({ prefix: set.slice(0, hi).map((l) => l.task), ok: c.ok });
    if (c.ok) return { kind: 'flaky', steps, why: `${failGates.join(', ')} failed in the train's verify but passed when run again on the same tree` };
    red = c;
  }
  const lane = set[hi - 1];
  const before = set.slice(0, hi - 1).map((l) => l.task);
  const what = `${failGates.join(', ')}${red.gates.length && red.gates.join(',') !== failGates.join(',') ? ` (${red.gates.join(', ')})` : ''}`;
  const why = before.length
    ? `the checks ${what} pass on ${main} + ${before.join(' + ')} (the lanes before it in this train) and fail once this lane is added (${label(hi)}): it breaks them, alone or only together with those lanes`
    : `the checks ${what} pass on ${main} and fail on ${main} + this lane`;
  return { kind: 'culprit', lane, steps, why: `${why}${red.detail.length ? `:\n${red.detail.join('\n')}` : ''}\nLog: ${red.log}. ${before.length ? `Once ${before.join(', ')} land${before.length === 1 ? 's' : ''}, merge ${main} into your copy (git merge ${main}), fix it there` : 'Fix it in your copy'}, commit, run npm run verify, then task done again` };
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
  const rr = spawnSync(cmd, { cwd: sc.dir, shell: true, encoding: 'utf8', env: /^(off|0|false|no)$/i.test(process.env.STUDIO_GAME_GATE_CI || '') ? env : { ...env, CI: 'true' }, maxBuffer: 64 * 1024 * 1024, timeout: Number(process.env.STUDIO_GAME_GATE_TIMEOUT_MS || 600000) });
  if (rr.status !== 0) { save(); return { kind: 'none', why: `the pins' refresh exited ${rr.status}: ${`${rr.stdout || ''}${rr.stderr || ''}`.trim().split('\n').slice(-2).join(' ').slice(0, 200)}` }; }
  git(sc.dir, 'add', '-A');
  if (!out(git(sc.dir, 'diff', '--cached', '--name-only'))) { save(); return { kind: 'none', why: 'the pins\' refresh changed no file' }; }
  const lines = moved.map((p) => `  ${p}: ${short(movedBy[p].from)} -> ${short(movedBy[p].to)} (${movedBy[p].by.join(', ')})`);
  const msg = [`train ${id}: pin refresh`, '', `Pinned values moved by lanes of this train, each declared by the lane that moved it (Pin-Moves):`, ...lines, `Report (before/after per pin and per prefix): ${repRel}`, '', `Golden-Reason: pin refresh by merge train ${id}: values moved by ${lanesMoving.join(', ')} (declared Pin-Moves)`, `Pin-Refresh: ${lanesMoving.join(', ')}`, `Studio-Train: ${id} pin-refresh`].join('\n');
  const c = spawnSync('git', ['-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local', 'commit', '-q', '-m', msg], { cwd: sc.dir, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
  if (c.status !== 0) { git(sc.dir, 'reset', '-q', '--hard', b.head); save(); return { kind: 'none', why: `the pin-refresh commit was refused: ${`${c.stdout || ''}${c.stderr || ''}`.trim().split('\n').slice(-2).join(' ').slice(0, 200)}` }; }
  const head = out(git(sc.dir, 'rev-parse', 'HEAD'));
  record.refreshed = true;
  record.commit = head;
  record.files = out(git(sc.dir, 'diff', '--name-only', `${b.head}..${head}`)).split('\n').filter(Boolean);
  save();
  log(`[train] ${id}: red only on declared pins; refreshed ${moved.join(', ')} in one commit (${head.slice(0, 8)}); verifying it in full`);
  return { kind: 'refreshed', built: { ...b, head, tree: out(git(sc.dir, 'rev-parse', 'HEAD^{tree}')) }, info: { lanes: lanesMoving, pins: movedBy, report: repRel, commit: head } };
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
      // 2.60.0: the game's pins and union files (its manifest, as main has it).
      const settings = await trainManifest(root, tip);
      for (const n of settings.notes) log(`[train] ${id}: ${settings.manifest}: ${n} (ignored)`);
      const unionFiles = settings.unionFiles;
      const cache = { checks: new Map(), reports: new Map() };
      let set = ready.filter((l) => !res.dropped.some((d) => d.task === l.task) && !res.deferred.some((d) => d.task === l.task));
      // (b) Build: main + each lane, in order.
      let built = buildIntegration(sc, tip, set, { id, unionFiles });
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
        if (round > 0) built = buildIntegration(sc, tip, set, { id, unionFiles });
        // (Round 0's build was handled above; 2.59.0 handled it twice: a deferral logged twice, a hand-back made twice.)
        if (round > 0 && (built.conflictMain.length || built.deferred.length)) {
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
        // 2.60.0: prefix bisection on the failing checks only, and pin refresh (redPlan). STUDIO_TRAIN_BISECT=alone, or
        // a plan that can't name the failing checks: the 2.59 way below.
        if (bisectMode() === 'prefix' && !(oneLane && set.length === 1 && !settings.pins)) {
          let text = '';
          try { text = v.log ? fs.readFileSync(path.join(root, v.log), 'utf8') : ''; } catch {}
          const ctx = { sc, tip, set, built, v, id, log, res, settings, all, cache, main, root, text };
          let plan = redPlan(ctx, { bisect: !oneLane });
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
            plan = redPlan(ctx, { pins: false, bisect: !oneLane });
          }
          if (plan.kind === 'redMain') {
            res.ok = false;
            res.redMain = true;
            res.message = `${main} itself fails its checks (${plan.why}; log ${plan.log || '-'}): nothing landed and no lane was handed back. Fix ${main} first.`;
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
            ev('bisect', id, `${plan.steps.map((st) => `${st.prefix.length ? `${main} + ${st.prefix.join(' + ')}` : main}: ${st.ok ? 'green' : 'red'}`).join(', ')}; first red with ${plan.lane.task}`, { agent: by, meta: { mode: 'prefix', steps: plan.steps, culprit: plan.lane.task } });
            drop(plan.lane, plan.why);
            set = set.filter((l) => l.task !== plan.lane.task);
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
        }
        ev('bisect', id, alone.map(({ l, v1 }) => `${l.task} alone: ${v1.ok ? 'green' : 'red'}`).join(', '), { agent: by, meta: { alone: alone.map(({ l, v1 }) => ({ task: l.task, ok: v1.ok })) } });
        const bad = alone.filter((x) => !x.v1.ok);
        if (bad.length && bad.length === alone.length) {
          // Every lane fails alone: is main itself red? Then nobody is handed back.
          const b0 = buildIntegration(sc, tip, [], { id, unionFiles });
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
  ev('landed', id, `${main} moved to ${built.head.slice(0, 8)} (tree ${built.tree.slice(0, 8)}, verified${v.reused ? ' by an earlier record of this tree' : ''}): ${res.landed.join(', ')}`, { agent: by, status: 'ok', meta: { head: built.head, tree: built.tree, lanes: res.landed, reused: Boolean(v.reused) } });
  return undefined;
}

const brief = (res) => ({ landed: res.landed, dropped: res.dropped.map((d) => d.task), deferred: res.deferred.map((d) => d.task), verifies: res.verifies, reused: res.reused, ...(res.rechecks ? { rechecks: res.rechecks } : {}), ...(res.pinRefresh ? { pinRefresh: res.pinRefresh.lanes } : {}), ...(res.union ? { union: res.union } : {}) });
function summary(res) {
  const parts = [];
  if (res.landed.length) parts.push(`landed ${res.landed.join(', ')} with ${res.verifies} verify run(s)${res.reused ? ` (${res.reused} taken from a green record of the same tree)` : ''}${res.rechecks ? ` and ${res.rechecks} re-check(s) of the failing checks` : ''}${res.pinRefresh ? `, plus one pin-refresh commit for ${res.pinRefresh.lanes.join(', ')} (${res.pinRefresh.report})` : ''}${res.union ? `; union-merged ${res.union.map((u) => `${u.files.join(', ')} for ${u.task}`).join('; ')}` : ''}`);
  if (res.dropped.length) parts.push(`handed back ${res.dropped.map((d) => `${d.task} (${d.why.split('\n')[0]})`).join('; ')}`);
  if (res.deferred.length) parts.push(`waiting for the next train: ${res.deferred.map((d) => `${d.task} (${d.why.split('\n')[0]})`).join('; ')}`);
  return parts.join('. ') || 'nothing to land';
}

/** The lane copy this process runs in, as a train lane: { dir, branch, head } (task done's one-lane train). */
export function thisLane(dir) {
  return { dir, branch: out(git(dir, 'symbolic-ref', '--short', 'HEAD')), head: out(git(dir, 'rev-parse', 'HEAD')) };
}
