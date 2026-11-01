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
 * The command may use {branch} (--branch, else the Unity folder's current branch), {task} (--task) and {folder}
 * (the Unity track's folder, engine/<game>/engine.json "folder"). It runs in "cwd" (relative to the studio), else
 * the Unity track's folder, else the studio. No land command: the gate is skipped with a note.
 *
 *   node harness/unity-gate.mjs [--task T-012] [--branch <name>] [--json]
 *      exit 0 pass or skipped, 3 refused (try again later), 1 red, conflict or error
 *
 * `task done` runs it for a task on the Unity track (task add --track engine:unity) once the task's other checks
 * pass; the task closes only on a pass, and a refusal leaves it in progress with "try again later".
 * Each run is recorded: .studio/gates/unity-last.json, an engine.land event, and a line in studio/engine/LOG.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent, readRecentEvents } from './event.mjs';
import { acquireHeavy, heavyRoot } from './heavy.mjs';
import { readTrack, logEngine } from './engine.mjs';

export const UNITY_EXIT = { 0: 'pass', 1: 'red', 2: 'conflict', 3: 'refused', 4: 'error' };
const WORDS = {
  pass: 'passed and landed',
  red: 'is red: a test or the build failed',
  conflict: 'found a merge conflict: the branch does not apply to the target; rebase it on the target and try again',
  refused: 'refused to start (busy: an editor open, too little memory or another landing). Not a failure of the work: try again later',
  error: 'failed to run',
};
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** The studio's Unity land settings (studio/game.json engines.unity), or null when no land command is set. */
export function unityConfig(root = REPO_ROOT) {
  const u = readJson(path.join(root, 'studio', 'game.json'))?.engines?.unity;
  return u && typeof u.land === 'string' && u.land.trim() ? u : null;
}

/** The Unity track (engine/<game>/engine.json with engine "unity"), or null. */
function unityTrack() {
  try {
    const t = readTrack();
    return t?.engine === 'unity' ? t : null;
  } catch {
    return null;
  }
}

/** The track a task was added on (task add --track), from its task.added event. */
export function taskTrack(taskId) {
  if (!taskId) return null;
  return readRecentEvents(20000).filter((e) => e.type === 'task.added' && e.task === taskId).pop()?.meta?.track || null;
}

/** Map a land command's exit to a result. */
export function mapUnityExit(code, { signal = null, timedOut = false, timeoutMin = null } = {}) {
  if (timedOut) return { status: 'error', why: `timed out after ${timeoutMin} min (engines.unity.timeoutMin or STUDIO_UNITY_GATE_TIMEOUT_MIN)` };
  if (code === null || code === undefined) return { status: 'error', why: `stopped${signal ? ` by ${signal}` : ''} before it ended` };
  const status = UNITY_EXIT[code] || 'error';
  return { status, why: UNITY_EXIT[code] ? WORDS[status] : `exited ${code}, which the land contract doesn't define (0 pass, 1 red, 2 conflict, 3 refused, 4 error)` };
}

/**
 * Run the Unity landing gate. { status: pass|red|conflict|refused|error|skipped, ok, code, why, ms, log }.
 * onlyUnityTask: a `task` not on the Unity track is skipped (notUnity). A busy lock is a refusal, never a throw.
 */
export async function runUnityGate({ task = null, branch = null, env = process.env, log = () => {}, onlyUnityTask = false } = {}) {
  const t0 = Date.now();
  if (task && onlyUnityTask) {
    const track = taskTrack(task);
    if (track !== 'engine:unity') return { status: 'skipped', ok: true, notUnity: true, why: `${task} is not on the Unity track (${track || 'no track'})` };
  }
  const cfg = unityConfig();
  const track = unityTrack();
  if (!cfg) return { status: 'skipped', ok: true, why: `no Unity land command is configured (studio/game.json "engines": { "unity": { "land": "<command>" } })${track ? '' : ' and there is no Unity track'}: nothing to run` };
  const folder = track?.folder ? path.resolve(REPO_ROOT, track.folder) : null;
  const cwd = cfg.cwd ? path.resolve(REPO_ROOT, cfg.cwd) : folder && fs.existsSync(folder) ? folder : REPO_ROOT;
  let br = branch;
  if (!br && /\{branch\}/.test(cfg.land)) {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: folder && fs.existsSync(folder) ? folder : cwd, encoding: 'utf8' });
    br = r.status === 0 && r.stdout.trim() !== 'HEAD' ? r.stdout.trim() : null;
    if (!br) return finish({ status: 'error', ok: false, code: null, why: 'the land command needs {branch} and none is known: pass --branch <name>' });
  }
  if (/\{task\}/.test(cfg.land) && !task) return finish({ status: 'error', ok: false, code: null, why: 'the land command needs {task}: pass --task <ID>' });
  const q = (s) => (/[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s);
  const cmd = cfg.land.replaceAll('{branch}', br ? q(br) : '').replaceAll('{task}', task ? q(task) : '').replaceAll('{folder}', folder ? q(folder) : '');
  const timeoutMin = Number(cfg.timeoutMin || env.STUDIO_UNITY_GATE_TIMEOUT_MIN || 120);
  let lk;
  try {
    lk = acquireHeavy(await heavyRoot(), `unity land${task ? ` (${task})` : ''}`, { log, env });
  } catch (err) {
    if (err.code !== 'HEAVY_BUSY') throw err;
    return finish({ status: 'refused', ok: false, code: 3, why: `the machine:heavy lock stayed busy: ${err.message.replace(/^\[heavy\]\s*/, '')}` });
  }
  let r;
  try {
    log(`[unity-gate] running the studio's Unity land command${task ? ` for ${task}` : ''}${br ? ` (branch ${br})` : ''} in ${path.relative(REPO_ROOT, cwd) || '.'}; up to ${timeoutMin} min`);
    r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', env: { ...env, STUDIO_HEAVY_HELD: process.env.STUDIO_HEAVY_HELD || '' }, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMin * 60000, windowsHide: true });
  } finally {
    lk.release();
  }
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const out = path.join(REPO_ROOT, '.studio', 'gates', 'out', 'unity.log');
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, text); } catch {}
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const m = r.error && !timedOut ? { status: 'error', why: `could not run it: ${r.error.code || r.error.message}` } : mapUnityExit(r.status, { signal: r.signal, timedOut, timeoutMin });
  const tail = text.trimEnd().split('\n').slice(-12).join('\n');
  return finish({ ...m, ok: m.status === 'pass', code: r.status, log: path.relative(REPO_ROOT, out).split(path.sep).join('/'), ...(m.status === 'pass' ? {} : { tail }) });

  function finish(res) {
    const full = { ...res, ms: Date.now() - t0, ...(task ? { task } : {}), ...(br ? { branch: br } : {}), at: new Date().toISOString() };
    try { fs.mkdirSync(path.join(REPO_ROOT, '.studio', 'gates'), { recursive: true }); fs.writeFileSync(path.join(REPO_ROOT, '.studio', 'gates', 'unity-last.json'), JSON.stringify(full, null, 2)); } catch {}
    try { emitEvent({ type: 'engine.land', agent: env.STUDIO_LOCK_OWNER || 'gates', task: task || undefined, track: 'engine:unity', status: full.ok ? 'ok' : full.status === 'refused' ? 'warn' : 'blocked', msg: `Unity land${task ? ` for ${task}` : ''}: ${full.status} (${full.why})`.slice(0, 400), meta: { status: full.status, code: full.code ?? null, ms: full.ms } }); } catch {}
    try { logEngine(`unity land${task ? ` ${task}` : ''}: ${full.status}${full.code !== null && full.code !== undefined ? ` (exit ${full.code})` : ''}`, env.STUDIO_LOCK_OWNER || undefined); } catch {}
    return full;
  }
}

/** One line for people: "PASS unity: ..." etc. */
export const unityLine = (res) => `[unity-gate] ${res.status === 'skipped' ? 'SKIP' : res.status.toUpperCase()} unity: ${res.why}${res.ms && res.status !== 'skipped' ? ` (${Math.round(res.ms / 1000)} s)` : ''}`;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const json = argv.includes('--json');
  const res = await runUnityGate({ task: flag('task'), branch: flag('branch'), log: (m) => console.error(m), onlyUnityTask: argv.includes('--if-unity-task') });
  if (json) console.log(JSON.stringify(res));
  else {
    console.log(unityLine(res));
    if (res.tail) console.log(`[unity-gate] its last lines (all of it: ${res.log}):\n${res.tail}`);
  }
  process.exit(res.status === 'pass' || res.status === 'skipped' ? 0 : res.status === 'refused' ? 3 : 1);
}
