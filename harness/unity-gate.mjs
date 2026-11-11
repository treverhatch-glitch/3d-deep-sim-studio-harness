#!/usr/bin/env node
/**
 * harness/unity-gate.mjs — 2.59.0 (#16): the Unity engine track's landing gate (harness side only).
 *
 * A Unity port lives in its own repo with its own landing script (tests in batch mode, a build, a merge into its
 * main branch). The harness doesn't know how to land Unity work and doesn't try: it runs the command the studio
 * configured, under the machine:heavy lock (harness/heavy.mjs: a Unity editor run must not overlap a full verify or
 * a browser playtest), and reads its exit code:
 *
 *   0 pass (landed)   1 red (a test or the build failed)   2 conflict (the merge didn't apply)
 *   3 refused (busy: an editor open, too little memory, another landing; not a failure of the work)
 *   4 error (the script itself failed)   anything else, a signal or a timeout: error
 *
 * Configured in studio/game.json (protected: only the owner changes it, so a branch can't swap the command for one
 * that always passes):
 *
 *   "engines": { "unity": { "land": "<command>", "cwd": "<folder>", "timeoutMin": 120 } }
 *
 * The command may use {branch}, {task} (--task) and {folder}. It runs in "cwd" (relative to the studio), else the
 * folder, else the studio. No land command: the gate is skipped with a note.
 *
 * 2.60.1 (B-41), from the crew's first Unity landings:
 *   - {branch} is --branch, else the task's Unity branch (task add --track engine:unity --branch <b>, or
 *     `node harness/unity-gate.mjs branch <ID> <b>` later). With neither the gate refuses: it no longer falls back
 *     to the Unity folder's checked-out branch (main), which would land main into itself. A branch name is checked
 *     (letters, digits, . _ / -) before it goes into the command.
 *   - {folder} is "folder" in the same settings (relative to the studio, or absolute) when set, else the Unity
 *     track's folder (engine/<game>/engine.json "folder"); one that doesn't exist is an error, not a guess.
 *   - "exits": { "<code>": { "status": "pass|red|conflict|refused|error", "why": "<what it means>" } } (or just
 *     "<why>", status error) is the land script's own contract. Without it the contract above applies. With it, a
 *     code it doesn't list is an error that names the code; the output's last lines always come with a non-pass.
 *
 *   node harness/unity-gate.mjs [--task T-012] [--branch <name>] [--json]
 *      exit 0 pass or skipped, 3 refused or not run (try again later), 1 red, conflict or error
 *   node harness/unity-gate.mjs branch <T-ID> <branch>     record the task's Unity branch (task.unity_branch)
 *
 * `task done` runs it for a task on the Unity track (task add --track engine:unity) once the task's other checks
 * pass; the task closes only on a pass, and a refusal leaves it in progress with "try again later".
 * Each run is recorded: .studio/gates/unity-last.json, an engine.land event, and a line in studio/engine/LOG.md.
 *
 * 2.63.0: the Unity merge train (harness/unity-train.mjs) lands several queued branches on ONE land run. The contract
 * gains (all optional; docs/UNITY-TRACK.md "The Unity merge train"):
 *   {branches}   the branches to land, in order, separated by spaces (a land command that can land a list);
 *   "landMany"   a second command for a list ({branches}), when "land" itself takes one {branch};
 *   {target}     "target", the branch the land script lands on (the train needs it: it checks the branches against it);
 *   "gateWorktree"  the land script's own worktree: the harness never touches its files (only the land script does).
 * A branch or task name that a shell could read as more than a name (anything but letters, digits, . _ / - and a
 * leading letter or digit) is refused before any command runs: the command line goes through a shell.
 *
 * 2.73.2 (e, B-73): a land run that started Unity with about 9 GB free beside a web verify aborted twice for memory and
 * was recorded as a FAIL. Now:
 *   - the run takes machine:heavy as a Unity kind, so it also waits for the free-RAM floor (STUDIO_UNITY_MIN_FREE_GB,
 *     12, never above 60% of the RAM; harness/heavy.mjs); a floor that stays unmet is status "not-run" (exit 3);
 *   - a red or error exit whose output shows an infrastructure abort (out of memory, no licence, the editor ended from
 *     outside, "Aborting batchmode" with no test failure and no compile error: harness/engine-proof.mjs infraAbort) is
 *     status "not-run", recorded as "not run: <why>" in unity-last.json, the engine.land event, the job record and
 *     studio/engine/LOG.md, never as red. A compile error or a failing test in the output keeps it red. The land
 *     script's own contract can name a not-run exit too: "exits": { "5": { "status": "not-run", "why": "..." } }.
 *   The Unity train tries a not-run land run again later like a refusal and hands nobody back for it.
 *
 * 2.77.0 (u, P5.3/P5.6): the gate is any engine's land gate (runUnityGate({ engine }), default unity; runEngineLand is the
 * same function): its settings are studio/game.json engines.<engine>, its files .studio/gates/<engine>-last.json and
 * out/<engine>.log, its machine:heavy job kind, RAM and free-RAM floor come from the engine table (harness/engine-tracks.mjs:
 * the owner's environment floor wins, then the lane's tuned ram-floor). Every run that ran to the end records its length
 * (.studio/engine/durations.json), which the Line Producer schedules by. The command may use {flags} (the lane's tuned
 * batch flags) and gets STUDIO_ENGINE_TUNE (the tuned settings as JSON), STUDIO_ENGINE_TUNE_FILE and STUDIO_ENGINE_FLAGS.
 * A task's engine and branch come from its engine record (.studio/engine/tasks.json) first, so an old task keeps them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent, readRecentEvents } from './event.mjs';
import { jobDone } from './jobs.mjs';
import { acquireHeavy, heavyRoot } from './heavy.mjs';
import { oomSignature } from './heavy-budget.mjs';
import { readTrack, logEngine } from './engine.mjs';
import { infraAbort } from './engine-proof.mjs';
import { landWaitMin, recordLandPeak } from './engine-ram.mjs';
import { engineTarget, engineTask, engineFloor, recordDuration, readTune, tunePath } from './engine-tracks.mjs';
import { readJson } from './fsafe.mjs';

export const UNITY_EXIT = { 0: 'pass', 1: 'red', 2: 'conflict', 3: 'refused', 4: 'error' };
const WORDS = {
  pass: 'passed and landed',
  red: 'is red: a test or the build failed',
  conflict: 'found a merge conflict: the branch does not apply to the target; rebase it on the target and try again',
  refused: 'refused to start (busy: an editor open, too little memory or another landing). Not a failure of the work: try again later',
  error: 'failed to run',
  'not-run': 'did not run to the end for a reason outside the work (an infrastructure abort): not a failure of the work; try again later',
};

/** The studio's Unity land settings (studio/game.json engines.unity), or null when no land command is set. */
export function unityConfig(root = REPO_ROOT, engine = 'unity') {
  const u = readJson(path.join(root, 'studio', 'game.json'))?.engines?.[engine];
  return u && typeof u.land === 'string' && u.land.trim() ? u : null;
}

/** 2.63.0: a branch (or task) name safe to put on a shell command line as it is. */
export const safeRefName = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s) && !s.includes('..') && !s.endsWith('.lock') && !s.endsWith('/');

/** 2.63.0: the command that lands a list of branches ({branches}): "landMany", else "land" when it takes {branches}; else null. */
export function landManyCommand(cfg) {
  if (!cfg) return null;
  if (typeof cfg.landMany === 'string' && cfg.landMany.includes('{branches}')) return cfg.landMany;
  return typeof cfg.land === 'string' && cfg.land.includes('{branches}') ? cfg.land : null;
}

/** The Unity track (engine/<game>/engine.json with engine "unity"), or null. */
export function unityTrack(engine = 'unity') {
  try {
    const t = readTrack();
    return t?.engine === engine ? t : null;
  } catch {
    return null;
  }
}

/** The track a task was added on (task add --track), from its task.added event. */
export function taskTrack(taskId) {
  if (!taskId) return null;
  // 2.77.0 (u): the engine record (.studio/engine/tasks.json) first: it doesn't fall out of the last 20000 events.
  try { const r = engineTask(taskId); if (r?.track) return r.track; } catch {}
  return readRecentEvents(20000).filter((e) => e.type === 'task.added' && e.task === taskId).pop()?.meta?.track || null;
}

// 2.60.1 (B-41): a task's Unity branch, and the names allowed into the land command.
const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,200}$/;
export const validBranch = (b) => typeof b === 'string' && BRANCH_RE.test(b) && !b.endsWith('/') && !b.endsWith('.lock');

/** The task's Unity branch: the last `unity-gate branch` record, else task add --branch. null when none. */
export function taskBranch(taskId) {
  if (!taskId) return null;
  try { const r = engineTask(taskId); if (r?.branch && r.from !== 'event') return r.branch; } catch {}
  const evs = readRecentEvents(20000).filter((e) => e.task === taskId && (e.type === 'task.unity_branch' || e.type === 'task.added'));
  const set = evs.filter((e) => e.type === 'task.unity_branch').pop()?.meta?.branch;
  return set || evs.filter((e) => e.type === 'task.added').pop()?.meta?.branch || null;
}

/** Record the Unity branch a task lands from (a task.unity_branch event). { ok, why }. */
export function setTaskBranch(taskId, branch, { agent = process.env.STUDIO_LOCK_OWNER || 'unity-gate' } = {}) {
  if (!/^[A-Z]+-\d+$/.test(String(taskId || ''))) return { ok: false, why: `"${taskId}" is not a task id (T-012)` };
  if (!validBranch(branch)) return { ok: false, why: `"${branch}" is not a branch name the land command can take (letters, digits, . _ / -)` };
  emitEvent({ type: 'task.unity_branch', agent, task: taskId, track: 'engine:unity', msg: `${taskId} lands from the Unity branch ${branch}`, meta: { branch } });
  return { ok: true, why: `${taskId} lands from the Unity branch ${branch}` };
}

const STATUSES = new Set(['pass', 'red', 'conflict', 'refused', 'error', 'not-run']);

// 2.73.2 (e, B-73): signs in a land command's output that the work's own tests or compile failed (then a red stays red).
const WORK_FAILED = /<test-case\b[^>]*\bresult="Failed"|\b[1-9]\d* (?:test\(s\)|tests?) failed\b|\[gate\] FAIL\b|\[engine-gate\] FAIL (?:test-failed|compile-error)\b|\bTest(?:Run)? ?Failed\b/i;
/**
 * 2.79 (e): the names of the tests a land run's output says failed, sorted and unique ([] when none can be read).
 * Reads the formats the engines' runners print: an NUnit results tag (<test-case ... fullname="X" ... result="Failed">),
 * the console runner's "Failed : X", dotnet test's "  Failed X [12 ms]" and a "[  FAILED  ] X" line. CRLF is normalized first.
 */
export function failingTests(text) {
  const names = new Set();
  const t = String(text || '').replace(/\r\n?/g, '\n');
  for (const m of t.matchAll(/<test-case\b[^>]*>/g)) {
    if (!/\bresult="Failed"/.test(m[0])) continue;
    const n = (/\bfullname="([^"]+)"/.exec(m[0]) || /\bname="([^"]+)"/.exec(m[0]))?.[1];
    if (n) names.add(n);
  }
  for (const l of t.split('\n')) {
    const x = /^\s*(?:\d+\)\s+)?Failed\s*:\s*(\S.*?)\s*$/.exec(l) || /^\s*Failed\s+([\w.<>,()+`-]+)(?:\s*\[.*)?\s*$/.exec(l) || /^\s*\[\s*FAILED\s*\]\s+(\S.*?)\s*$/.exec(l);
    if (x) names.add(x[1]);
  }
  return [...names].sort();
}

/**
 * 2.83: the source files a land run's output names in compiler errors ("Assets/Tests/Foo.cs(12,5): error CS0117: …"),
 * with forward slashes, unique, 20 at most. A compile error names no test; the file it names is the evidence instead.
 */
export function compileErrorFiles(text) {
  const files = new Set();
  for (const l of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^\s*(?:\[[^\]]*\]\s*)?((?:[A-Za-z]:)?[^\s():*?"<>|][^():*?"<>|\n]*\.[A-Za-z0-9]{1,8})\(\d+,\d+\):\s*error\b/.exec(l);
    if (m) files.add(m[1].trim().replace(/\\/g, '/'));
    if (files.size >= 20) break;
  }
  return [...files];
}

/**
 * 2.73.2 (e, B-73): was a red or error land run an infrastructure abort? { kind, text } or null. The output shows out of
 * memory (or exit 0xC0000017), no licence, the editor or the script ended from outside, or "Aborting batchmode", and
 * shows no failing test and no compile error (harness/engine-proof.mjs infraAbort). A timeout is never one here.
 */
export function landInfra(text, { status = null, signal = null, timedOut = false } = {}) {
  if (timedOut) return null;
  const failed = WORK_FAILED.test(String(text || ''));
  return infraAbort({ log: text, status, signal, results: failed ? { failed: 1 } : null, engine: 'unity' });
}

/**
 * 2.82: what each stage of a land run took. A land command may say so in the file the harness names in
 * STUDIO_LAND_RESULT (JSON: { "stages" | "gates": { "<name>": { "status": "pass", "seconds": 510 } } }, or a list of
 * { name, status, seconds }), or in its output, one line per stage: `[land-stage] <name> <status> <seconds>`.
 * [{ name, status, seconds }] in the order given ([] when it says nothing): the stages go on the engine.land event, so
 * the scorecard can show where a land's minutes go and which stage fails first.
 */
export function landStages(file, text = '') {
  const clean = (name, status, seconds) => {
    const n = String(name || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 24);
    const sec = Number(seconds);
    if (!n) return null;
    return { name: n, status: String(status || '').trim().toLowerCase().replace(/[^a-z-]/g, '').slice(0, 12) || 'unknown', seconds: Number.isFinite(sec) && sec >= 0 ? Math.round(sec) : null };
  };
  let rows = [];
  try {
    const j = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : null;
    const g = Array.isArray(j) ? j : j && typeof j === 'object' ? j.stages || j.gates : null;
    if (Array.isArray(g)) rows = g.map((x) => clean(x?.name, x?.status, x?.seconds ?? x?.durationSec));
    else if (g && typeof g === 'object') rows = Object.entries(g).map(([k, v]) => clean(k, v?.status, v?.seconds ?? v?.durationSec));
  } catch { rows = []; }
  rows = rows.filter(Boolean);
  if (!rows.length) for (const m of String(text || '').matchAll(/^\[land-stage\]\s+(\S+)\s+(\S+)(?:\s+([0-9.]+))?\s*$/gm)) rows.push(clean(m[1], m[2], m[3]));
  return rows.filter(Boolean).slice(0, 12);
}

/**
 * Map a land command's exit to a result. 2.60.1 (B-41): `exits` (studio/game.json engines.unity.exits) is the land
 * script's own contract and replaces the default one; a code it doesn't list is an error naming the code.
 */
export function mapUnityExit(code, { signal = null, timedOut = false, timeoutMin = null, exits = null } = {}) {
  if (timedOut) return { status: 'error', why: `timed out after ${timeoutMin} min (engines.unity.timeoutMin or STUDIO_UNITY_GATE_TIMEOUT_MIN)` };
  if (code === null || code === undefined) return { status: 'error', why: `stopped${signal ? ` by ${signal}` : ''} before it ended` };
  if (exits && typeof exits === 'object') {
    const e = exits[String(code)];
    if (typeof e === 'string' && e.trim()) return { status: code === 0 ? 'pass' : 'error', why: `exited ${code}: ${e.trim()} (studio/game.json engines.unity.exits)` };
    if (e && typeof e === 'object') {
      const status = STATUSES.has(e.status) ? e.status : 'error';
      return { status, why: `exited ${code}: ${String(e.why || WORDS[status] || status).trim()} (studio/game.json engines.unity.exits)` };
    }
    if (code === 0) return { status: 'pass', why: WORDS.pass };
    return { status: 'error', why: `exited ${code}, which the land script's contract (studio/game.json engines.unity.exits: ${Object.keys(exits).join(', ') || 'none'}) doesn't name: see its last lines` };
  }
  const status = UNITY_EXIT[code] || 'error';
  if (!UNITY_EXIT[code]) return { status, why: `exited ${code}, which the land contract doesn't define (0 pass, 1 red, 2 conflict, 3 refused, 4 error): see its last lines` };
  return { status, why: code === 0 ? WORDS[status] : `exited ${code}: ${WORDS[status]} (the default land contract; if the script means something else by ${code}, set studio/game.json engines.unity.exits)` };
}

/**
 * Run the Unity landing gate. { status: pass|red|conflict|refused|error|skipped, ok, code, why, ms, log }.
 * onlyUnityTask: a `task` not on the Unity track is skipped (notUnity). A busy lock is a refusal, never a throw.
 */
export async function runUnityGate({ engine = 'unity', task = null, branch = null, branches = null, label = null, env = process.env, log = () => {}, onlyUnityTask = false } = {}) {
  const t0 = Date.now();
  const et = engineTarget(engine) || engineTarget('unity');
  const L = et.label;
  if (task && onlyUnityTask) {
    const track = taskTrack(task);
    if (track !== `engine:${engine}`) return { status: 'skipped', ok: true, notUnity: true, why: `${task} is not on the ${L} track (${track || 'no track'})` };
  }
  const cfg = unityConfig(REPO_ROOT, engine);
  const track = unityTrack(engine);
  if (!cfg) return { status: 'skipped', ok: true, why: `no ${L} land command is configured (studio/game.json "engines": { "${engine}": { "land": "<command>" } })${track ? '' : ` and there is no ${L} track`}: nothing to run` };
  // 2.60.1 (B-41): --branch, else the task's Unity branch; never the folder's checked-out branch (checked below).
  let br = branch || (task ? taskBranch(task) : null);
  // 2.63.0: a list of branches (the Unity merge train) goes to the command that lands a list. (Declared before any
  // finish(), which reads it.)
  const many = Array.isArray(branches) ? branches : null;
  // 2.60.1 (B-41): engines.unity.folder, else the track's folder; a missing one is an error, never a guess.
  const folderSet = typeof cfg.folder === 'string' && cfg.folder.trim() ? cfg.folder.trim() : null;
  const folder = folderSet ? path.resolve(REPO_ROOT, folderSet) : track?.folder ? path.resolve(REPO_ROOT, track.folder) : null;
  const folderFrom = folderSet ? `studio/game.json engines.${engine}.folder` : `the ${L} track's folder (engine.json "folder")`;
  if (folder && !fs.existsSync(folder) && (folderSet || /\{folder\}/.test(cfg.land))) return finish({ status: 'error', ok: false, code: null, why: `the Unity folder ${folder} (${folderFrom}) doesn't exist: set "folder" in studio/game.json engines.unity to the Unity checkout that has the land script` });
  if (!folder && /\{folder\}/.test(cfg.land)) return finish({ status: 'error', ok: false, code: null, why: 'the land command needs {folder} and none is known: set "folder" in studio/game.json engines.unity' });
  const cwd = cfg.cwd ? path.resolve(REPO_ROOT, cfg.cwd) : folder && fs.existsSync(folder) ? folder : REPO_ROOT;
  const template = many ? landManyCommand(cfg) : cfg.land;
  if (many && !template) return finish({ status: 'error', ok: false, code: null, why: 'the land command takes one {branch}, not a list: set "landMany" (a command with {branches}) in studio/game.json engines.unity, or land one branch at a time' });
  for (const name of [...(many || []), ...(branch ? [branch] : []), ...(task ? String(task).split(',') : [])]) {
    if (!safeRefName(name)) return finish({ status: 'error', ok: false, code: null, why: `"${String(name).slice(0, 80)}" is not a plain branch or task name (letters, digits, . _ / - only): it is not put on a command line` });
  }
  if (many) br = many.length === 1 ? many[0] : null;
  if (br && !validBranch(br)) return finish({ status: 'error', ok: false, code: null, why: `"${br}" is not a branch name the land command can take (letters, digits, . _ / -)` });
  if (!many && !br && /\{branch\}/.test(cfg.land)) {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true, cwd: folder && fs.existsSync(folder) ? folder : cwd, encoding: 'utf8' });
    const here = r.status === 0 ? r.stdout.trim() : '';
    return finish({ status: 'error', ok: false, code: null, why: `the land command needs {branch} and no Unity branch is known${task ? ` for ${task}` : ''}: ${task ? `node harness/unity-gate.mjs branch ${task} <branch> records it (or add the task with --branch <branch>)` : 'pass --branch <name>'}. The Unity folder's checked-out branch${here && here !== 'HEAD' ? ` (${here})` : ''} is not used: landing it could merge the target into itself` });
  }
  if (/\{task\}/.test(template) && !task) return finish({ status: 'error', ok: false, code: null, why: 'the land command needs {task}: pass --task <ID>' });
  if (/\{target\}/.test(template) && !safeRefName(cfg.target)) return finish({ status: 'error', ok: false, code: null, why: 'the land command needs {target}: set "target" (the branch it lands on) in studio/game.json engines.unity' });
  const q = (s) => (/[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s);
  // 2.77.0 (u, P5.4): the lane's tuned settings go to the land command ({flags}; STUDIO_ENGINE_TUNE*).
  const tune = (() => { try { return readTune(engine).values; } catch { return {}; } })();
  const flags = Array.isArray(tune['batch-flags']) && et.tune.includes('batch-flags') ? tune['batch-flags'].filter((f) => /^-{1,2}[A-Za-z][A-Za-z0-9_-]*(=[A-Za-z0-9_.:,/-]+)?$/.test(f)) : [];
  const cmd = template.replaceAll('{flags}', flags.join(' ')).replaceAll('{branches}', many ? many.join(' ') : '').replaceAll('{branch}', br ? q(br) : '').replaceAll('{task}', task ? q(task) : '').replaceAll('{target}', cfg.target ? q(cfg.target) : '').replaceAll('{folder}', folder ? q(folder) : '');
  const timeoutMin = Number(cfg.timeoutMin || env.STUDIO_UNITY_GATE_TIMEOUT_MIN || 120);
  // 2.77.0 (u, P5.3): the engine table's job kind, RAM and floor (unity: the "unity" kind and STUDIO_UNITY_MIN_FREE_GB as before).
  const floor = engineFloor(engine, { env });
  // 2.78.1 (f, B-117): engine: the land takes the engine line (STUDIO_ENGINE_SLOTS), not one of the game's slots.
  // 2.79.1 (3.2): the land waits for RAM as long as the Line Producer's hold makes room for it, else its own shorter wait (STUDIO_ENGINE_LAND_WAIT_MIN).
  const hroot = await heavyRoot();
  const landWait = (() => { try { return landWaitMin(hroot, env); } catch { return undefined; } })();
  const heavyOpts = { log, env, kind: et.heavyKind, engine, ...(landWait && !(env.STUDIO_HEAVY_WAIT_MIN) ? { waitMin: landWait } : {}),...(et.heavyKind === 'unity' ? {} : { ramGb: et.rig.ramGb }), ...(et.heavyKind === 'unity' ? (/tuned|measured/.test(floor.from) ? { minFreeGb: floor.gb } : {}) : floor.gb > 0 ? { minFreeGb: floor.gb } : {}) };
  const landLabel = label || `${engine} land${task ? ` (${task})` : ''}`;
  let lk;
  try {
    lk = acquireHeavy(await heavyRoot(), landLabel, heavyOpts);
  } catch (err) {
    if (err.code !== 'HEAVY_BUSY') throw err;
    // 2.73.2 (e, B-73): free RAM stayed under STUDIO_UNITY_MIN_FREE_GB: Unity never started, so not run (never red).
    if (err.floor) return finish({ status: 'not-run', ok: false, code: 3, infra: { kind: 'ram-floor', text: err.message.replace(/^\[heavy\]\s*NOT RUN\s*/, '') }, why: `not run: ${err.message.replace(/^\[heavy\]\s*NOT RUN\s*/, '')}` });
    return finish({ status: 'refused', ok: false, code: 3, why: `the machine:heavy lock stayed busy: ${err.message.replace(/^\[heavy\]\s*/, '')}` });
  }
  let r;
  const landStart = Date.now();
  // 2.82: the land command may write its stages' results there (landStages above).
  const stageFile = path.join(REPO_ROOT, '.studio', 'gates', `${engine}-land-stages.json`);
  try { fs.mkdirSync(path.dirname(stageFile), { recursive: true }); fs.rmSync(stageFile, { force: true }); } catch { /* an old file is only ever read after a run that wrote it again */ }
  const tuneEnv = { STUDIO_ENGINE: engine, STUDIO_ENGINE_TUNE: JSON.stringify(tune || {}), STUDIO_ENGINE_TUNE_FILE: tunePath(REPO_ROOT, engine), STUDIO_ENGINE_FLAGS: flags.join(' '), STUDIO_LAND_RESULT: stageFile };
  // 2.82: for a Unity land script: which Edit Mode assemblies the editor still has to run after its .NET tests passed
  // (harness/unity.mjs editModePlan on the land's own checkout; "SKIP": none). The script decides whether to use it.
  // 2.83: a full land run (STUDIO_LAND_FULL=1, set by the engine train once a day) gets no plan: the editor runs every
  // Edit Mode test. And the owner may give the arguments outright (engines.unity.editModeArgs, e.g. `-testCategory
  // "!Slow"`): tests that are compiled outside the editor too can still behave differently on the editor's runtime, so a
  // studio keeps its fast ported-rules tests in Edit Mode and leaves out only a category it names.
  if (engine === 'unity' && env.STUDIO_LAND_FULL === '1') { /* no plan on a full run */ }
  else if (engine === 'unity' && typeof cfg.editModeArgs === 'string' && cfg.editModeArgs.trim()) tuneEnv.STUDIO_UNITY_EDITMODE_ARGS = cfg.editModeArgs.trim();
  else if (engine === 'unity' && !/^(off|0|false|no)$/i.test(String(env.STUDIO_UNITY_EDITMODE_PLAN || ''))) {
    try {
      const proj = [cfg.gateWorktree ? path.resolve(REPO_ROOT, cfg.gateWorktree) : null, folder, cwd].find((d) => d && fs.existsSync(path.join(d, 'Assets')));
      if (proj) {
        const plan = (await import('./unity.mjs')).editModePlan(proj);
        if (plan.skip) tuneEnv.STUDIO_UNITY_EDITMODE_ARGS = 'SKIP';
        else if (plan.args.length) tuneEnv.STUDIO_UNITY_EDITMODE_ARGS = plan.args.join(' ');
      }
    } catch { /* a help for the script, never a condition of the land run */ }
  }
  const landOnce = () => spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', env: { ...env, ...tuneEnv, STUDIO_HEAVY_HELD: process.env.STUDIO_HEAVY_HELD || '' }, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMin * 60000, windowsHide: true });
  try {
    log(`[unity-gate] running the studio's ${L} land command${task ? ` for ${task}` : ''}${many ? ` (branches ${many.join(' ')})` : br ? ` (branch ${br})` : ''} in ${path.relative(REPO_ROOT, cwd) || '.'}; up to ${timeoutMin} min`);
    r = landOnce();
  } finally {
    lk.release();
  }
  const landEnd = Date.now();
  // 2.79.1 (3.2): keep what this run took in RAM (the machine monitor's samples while it ran) for the next land's floor.
  const keepPeak = (status) => { try { recordLandPeak(engine, { root: hroot, startMs: landStart, endMs: landEnd, status }); } catch { /* the table's floor stays */ } };
  // 2.68.0 (n): a run killed for memory (heavy-budget.mjs oomSignature) queues once more for the budget, with a note.
  const oom = !/^(off|0|false|no)$/i.test(String(env.STUDIO_HEAVY_OOM_RETRY || '')) ? oomSignature(r) : '';
  if (oom) {
    log(`[unity-gate] the Unity land command died out of memory (${oom}): queued once more for the machine:heavy budget`);
    try { emitEvent({ type: 'heavy.oom_retry', agent: env.STUDIO_LOCK_OWNER || 'gates', status: 'warn', msg: `Unity land${task ? ` for ${task}` : ''} died out of memory (${oom}); re-queued once`, meta: { signature: oom } }); } catch {}
    try {
      lk = acquireHeavy(await heavyRoot(), landLabel, heavyOpts);
    } catch (err) {
      if (err.code !== 'HEAVY_BUSY') throw err;
      if (err.floor) return finish({ status: 'not-run', ok: false, code: 3, infra: { kind: 'out-of-memory', text: `the Unity land command died out of memory (${oom})` }, why: `not run: the Unity land command died out of memory (${oom}), and free RAM stayed under the floor for its one retry: ${err.message.replace(/^\[heavy\]\s*NOT RUN\s*/, '')}` });
      return finish({ status: 'refused', ok: false, code: 3, why: `out of memory (${oom}), and the machine:heavy lock stayed busy for its one retry: ${err.message.replace(/^\[heavy\]\s*/, '')}` });
    }
    try { r = landOnce(); } finally { lk.release(); }
  }
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const out = path.join(REPO_ROOT, '.studio', 'gates', 'out', et.files.gateLog);
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, text); } catch {}
  const timedOut = r.error?.code === 'ETIMEDOUT';
  let m = r.error && !timedOut ? { status: 'error', why: `could not run it: ${r.error.code || r.error.message}` } : mapUnityExit(r.status, { signal: r.signal, timedOut, timeoutMin, exits: cfg.exits && typeof cfg.exits === 'object' ? cfg.exits : null });
  // 2.73.2 (e, B-73): a red or error that the output shows was an infrastructure abort is "not run", never red.
  let infra = null;
  if ((m.status === 'red' || (m.status === 'error' && !r.error)) && (infra = landInfra(text, { status: r.status, signal: r.signal, timedOut }))) {
    m = { status: 'not-run', why: `not run (${infra.kind}): ${infra.text}; the land command exited ${r.status ?? r.signal ?? '?'} (${m.status} by its contract), but nothing in its output shows a failing test or a compile error: ${WORDS['not-run']}` };
  } else if (m.status === 'not-run') m = { ...m, why: `not run: ${m.why}` };
  keepPeak(m.status);
  const tail = text.trimEnd().split('\n').slice(-12).join('\n');
  // 2.79 (e): a red run's failing test names (the train's bisect stops on the batch's signature).
  const failures = m.status === 'red' ? failingTests(text) : [];
  const errorFiles = m.status === 'red' ? compileErrorFiles(text) : [];
  const stages = (() => { try { return landStages(stageFile, text); } catch { return []; } })();
  return finish({ ...m, ok: m.status === 'pass', code: r.status, ...(infra ? { infra } : {}), ...(failures.length ? { failures } : {}), ...(errorFiles.length ? { errorFiles } : {}), ...(stages.length ? { stages } : {}), log: path.relative(REPO_ROOT, out).split(path.sep).join('/'), ...(m.status === 'pass' ? {} : { tail }) });

  function finish(res) {
    const full = { ...res, engine, ms: Date.now() - t0, ...(task ? { task } : {}), ...(br ? { branch: br } : {}), ...(many ? { branches: many } : {}), at: new Date().toISOString() };
    try { fs.mkdirSync(path.join(REPO_ROOT, '.studio', 'gates'), { recursive: true }); fs.writeFileSync(path.join(REPO_ROOT, '.studio', 'gates', et.files.gateLast), JSON.stringify({ ...full, engine }, null, 2)); } catch {}
    // 2.77.0 (u, P5.3): a run that ran to the end keeps its length for the Line Producer's schedule.
    if (['pass', 'red', 'conflict'].includes(full.status)) { try { recordDuration(engine, { kind: 'land', ms: full.ms, status: full.status }); } catch {} }
    try { emitEvent({ type: 'engine.land', agent: env.STUDIO_LOCK_OWNER || 'gates', task: task && !String(task).includes(',') ? task : undefined, track: `engine:${engine}`, status: full.ok ? 'ok' : full.status === 'refused' || full.status === 'not-run' ? 'warn' : 'blocked', msg: `${L} land${task ? ` for ${task}` : ''}: ${full.status} (${full.why})`.slice(0, 400), meta: { engine, status: full.status, code: full.code ?? null, ms: full.ms, ...(full.infra ? { infra: full.infra.kind } : {}), ...(full.stages ? { stages: full.stages } : {}), ...(many ? { branches: many } : {}), ...(String(task || '').includes(',') ? { tasks: String(task).split(',') } : {}), ...(env.STUDIO_PLAY_MODE ? { playMode: env.STUDIO_PLAY_MODE, playFilter: env.STUDIO_PLAY_FILTER || '' } : {}) } }); } catch {}
    // 2.84: playMode / playFilter above: what the engine train told the land's Play Mode stage (focus or full).
    // 2.65.0: the uniform job.done (harness/jobs.mjs) beside engine.land.
    if (full.status !== 'skipped') jobDone({ kind: `${engine}-gate`, id: task || br || null, code: full.code ?? null, result: full.status, ms: full.ms, tail: full.tail || full.why || '', log: full.log || null, task: task && !String(task).includes(',') ? task : null, agent: env.STUDIO_LOCK_OWNER || 'gates' });
    try { logEngine(`${engine} land${task ? ` ${task}` : ''}: ${full.status === 'not-run' ? `not run${full.infra ? ` (${full.infra.kind})` : ''}` : full.status}${full.code !== null && full.code !== undefined ? ` (exit ${full.code})` : ''}`, env.STUDIO_LOCK_OWNER || undefined); } catch {}
    return full;
  }
}

/** 2.77.0 (u, P5.6): the same gate for any engine target. */
export const runEngineLand = (opts = {}) => runUnityGate(opts);

/** One line for people: "PASS unity: ..." etc. */
export const unityLine = (res) => `[unity-gate] ${res.status === 'skipped' ? 'SKIP' : res.status === 'not-run' ? 'NOT RUN' : res.status.toUpperCase()} ${res.engine || 'unity'}: ${res.why}${res.ms && res.status !== 'skipped' ? ` (${Math.round(res.ms / 1000)} s)` : ''}`;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const json = argv.includes('--json');
  if (argv[0] === 'branch') {
    const r = setTaskBranch(argv[1], argv[2]);
    (r.ok ? console.log : console.error)(`[unity-gate] ${r.why}`);
    process.exit(r.ok ? 0 : 2);
  }
  const res = await runUnityGate({ engine: flag('engine') || 'unity', task: flag('task'), branch: flag('branch'), log: (m) => console.error(m), onlyUnityTask: argv.includes('--if-unity-task') });
  if (json) console.log(JSON.stringify(res));
  else {
    console.log(unityLine(res));
    if (res.tail) console.log(`[unity-gate] its last lines (all of it: ${res.log}):\n${res.tail}`);
  }
  process.exit(res.status === 'pass' || res.status === 'skipped' ? 0 : res.status === 'refused' || res.status === 'not-run' ? 3 : 1);
}
