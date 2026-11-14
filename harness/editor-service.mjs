#!/usr/bin/env node
/**
 * harness/editor-service.mjs — 2.84 (s): one harness-owned engine editor that stays open, used two ways.
 *
 * UNTESTED ON A REAL EDITOR. Everything here is checked against a stand-in editor (qa/fixtures/fake-editor.mjs, a node
 * process speaking the same file protocol); the Unity side (engine/_unity/Assets/Editor/StudioService/
 * StudioEditorService.cs) has never been compiled or run. Everything is OFF by default, and any failure of the service
 * falls back to today's cold path (a land script starts its own editor; an agent's art waits for the train).
 *
 * Why (a crew's field notes): every engine land step started the editor cold and re-imported; and builder and porter
 * sessions cannot run the editor at all, so art and UI work was never compiled or looked at before the train.
 *
 *   1. A WARM editor for land runs (engines.<x>.warm: true or "land"): the train starts the "land" instance on the land
 *      tree (the gate worktree) before its first land run, keeps it between runs, and only OFFERS it to the land script:
 *      STUDIO_EDITOR_SERVICE=<folder> and STUDIO_EDITOR_SERVICE_CLI=<a command line> in the land command's environment
 *      (harness/unity-train.mjs). Not healthy: the variables are not set, engine.warm.fallback says why.
 *   2. An EDITOR SERVICE for agents (engines.<x>.service.check: true): `npm run editor -- check` from any session queues a
 *      compile (+ capture) of the caller's own branch; the supervisor's pass (editorServicePass) runs the oldest request
 *      in the "check" instance's own checkout (never a lane's folder, never the train's), writes the compiler errors
 *      and PNGs under .studio/editor-service/out/<lane>/<head8>/ and emits editor.check. Never while that engine's train
 *      runs (they would fight for CPU and RAM).
 *
 * The protocol is files, no sockets (no firewall prompt on Windows; survives a harness restart). In the service folder
 * (<project>/Temp/StudioService/, inside the editor's own project, never committed):
 *   requests/<id>.json   written atomically by the harness: { id, kind, ...args, at }
 *                        kind: ping | refresh | compile | test | capture | quit
 *                        test: { mode: EditMode|PlayMode, filter?, assemblyNames?, resultsPath }
 *                        capture: { scene, camera?, width, height, out }
 *   responses/<id>.json  written atomically by the editor: { id, ok, kind, ms, errors: [{ file, line, code, message }],
 *                        results?, images?, log?, why? }
 *   heartbeat.json       { pid, at, busy, unityVersion, domainReloads }, rewritten every few seconds.
 * The editor is started with `-batchmode -projectPath <dir> -studioService <folder> -studioHeartbeatSec <n> -logFile
 * <file>` (no -quit; no -nographics: a capture needs a GPU). Without -studioService the editor script does nothing, so a
 * person's own editor is never affected.
 *
 *   npm run editor -- start  [--engine x] [--instance check|land] [--project <dir>]
 *   npm run editor -- status [--engine x] [--json]
 *   npm run editor -- stop   [--engine x] [--instance check|land]
 *   npm run editor -- request <kind> [--engine x] [--instance check|land] [--mode EditMode] [--filter f]
 *                     [--assemblies a;b] [--results <file>] [--scene s] [--camera c] [--width w] [--height h] [--out f]
 *                     prints the response as JSON; exit 1 on ok:false, 3 when no healthy editor answers (fall back)
 *   npm run editor -- check  [--engine x] [--lane <agent>] [--branch b] [--capture <scene>[:<camera>]] [--wait]
 *   npm run editor -- result [--engine x] [--lane <agent>] [--json]
 *   npm run editor -- pass   (one queue pass by hand; the supervisor runs it when the queue is on)
 *
 * Settings (studio/game.json engines.<x>): warm (false | true | "land"); service = { check: false, dir, heartbeatSec: 5,
 * requestTimeoutMin: 30, recycleAfter: 20, recycleMin: 240, startTimeoutMin: 15, graceSec: 30 }. STUDIO_EDITOR_SERVICE=off
 * is the master switch. The editor binary is STUDIO_UNITY (harness/unity.mjs unityBin); a path ending in .mjs or .js is run
 * with node (the stand-in editor of the self-test).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitEvent } from './event.mjs';
import { mainRoot } from './worktree.mjs';
import { writeAtomic, readJson, withFileLock } from './fsafe.mjs';
import { pidAlive, liveAs, spawnedIdentity } from './proc-identity.mjs';
import { unityBin } from './unity.mjs';
import { runningUnityTrain, unityRepo } from './unity-train.mjs';
import { safeRefName } from './unity-gate.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
export const KINDS = ['ping', 'refresh', 'compile', 'test', 'capture', 'quit'];
export const INSTANCES = ['check', 'land'];
/** The protocol's field names, as the C# side spells them too (qa/selftest-284s.mjs compares the two files). */
export const PROTOCOL_FIELDS = {
  request: ['id', 'kind', 'at', 'mode', 'filter', 'assemblyNames', 'resultsPath', 'scene', 'camera', 'width', 'height', 'out'],
  response: ['id', 'ok', 'kind', 'ms', 'errors', 'results', 'images', 'log', 'why'],
  error: ['file', 'line', 'code', 'message'],
  heartbeat: ['pid', 'at', 'busy', 'unityVersion', 'domainReloads'],
  args: ['-studioService', '-studioHeartbeatSec'],
};

const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const isOff = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());
const fwd = (p) => String(p || '').split(path.sep).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const gitOut = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); writeAtomic(f, `${JSON.stringify(v, null, 2)}\n`); };
const safeName = (s) => String(s || 'x').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
let seq = 0;

// ---- settings ----------------------------------------------------------------------------------------------

const enginesOf = (root) => readJson(path.join(root, 'studio', 'game.json'))?.engines || {};

/** STUDIO_EDITOR_SERVICE=off: the master switch (every use off, whatever studio/game.json says). */
export const masterOff = (env = process.env) => isOff(env.STUDIO_EDITOR_SERVICE);

/**
 * engines.<engine>.service and .warm, with the defaults. warm: false | 'land' (true means 'land').
 * Times may be fractions (the self-test runs on a scale of seconds).
 */
export function serviceSettings(root = mainRoot(), engine = 'unity', env = process.env) {
  const cfg = enginesOf(root)[engine] || {};
  const s = cfg.service && typeof cfg.service === 'object' ? cfg.service : {};
  const heartbeatSec = Math.max(0.05, num(s.heartbeatSec, 5));
  return {
    engine,
    cfg,
    off: masterOff(env),
    check: s.check === true,
    warm: cfg.warm === true || cfg.warm === 'land' ? 'land' : false,
    dir: typeof s.dir === 'string' && s.dir.trim() ? s.dir.trim() : null,
    heartbeatSec,
    // A heartbeat older than this, with no request in flight, is a hung editor. Twelve beats: an import or a domain reload
    // stops the editor's update loop for a while (UNTESTED on a real editor: tune heartbeatSec if it restarts too eagerly).
    staleSec: heartbeatSec * 12,
    requestTimeoutMin: Math.max(0.001, num(s.requestTimeoutMin, 30)),
    recycleAfter: Math.max(1, num(s.recycleAfter, 20)),
    recycleMin: Math.max(0.001, num(s.recycleMin, 240)),
    startTimeoutMin: Math.max(0.001, num(s.startTimeoutMin, 15)),
    graceSec: Math.max(0, num(s.graceSec, 30)),
  };
}

const stateDir = (root) => path.join(root, '.studio', 'editor-service');
export const stateFile = (root, engine) => path.join(stateDir(root), `${safeName(engine)}.json`);
export const queueFile = (root) => path.join(stateDir(root), 'queue.json');
export const outDir = (root, lane, head) => path.join(stateDir(root), 'out', safeName(lane), String(head || 'unknown').slice(0, 8));
/** The service folder inside an editor's project (Temp/ is the editor's own scratch space: never committed). */
export const serviceFolder = (project) => path.join(project, 'Temp', 'StudioService');
const lockOpts = (root) => ({ dir: path.join(root, '.studio', 'locks') });

export function readInstance(root, engine, instance) {
  return readJson(stateFile(root, engine))?.instances?.[instance] || null;
}
function patchInstance(root, engine, instance, patch) {
  return withFileLock(`editor-service-${safeName(engine)}`, () => {
    const f = stateFile(root, engine);
    const st = readJson(f) || { engine, instances: {} };
    st.instances ||= {};
    if (patch === null) delete st.instances[instance];
    else st.instances[instance] = { ...(st.instances[instance] || {}), ...patch };
    writeJson(f, st);
    return st.instances[instance] || null;
  }, lockOpts(root));
}

/** The heartbeat, read leniently: { pid, at (ms), busy (id or null), unityVersion, domainReloads } or null. */
export function readHeartbeat(folder) {
  const hb = readJson(path.join(folder, 'heartbeat.json'));
  if (!hb || typeof hb !== 'object') return null;
  const at = typeof hb.at === 'number' ? hb.at : Date.parse(hb.at);
  return { ...hb, at: Number.isFinite(at) ? at : 0, busy: hb.busy ? String(hb.busy) : null };
}

/** Unity's own lock: Temp/UnityLockfile exists while an editor has the project open (and after one crashed). */
export const unityLockFile = (project) => path.join(project, 'Temp', 'UnityLockfile');

/**
 * healthy(engine): { ok, why, rec, hb }. Ok: the recorded editor is alive (pid and its start identity), its heartbeat
 * is fresh (under staleSec), and it is not busy with one request for longer than the request timeout.
 */
export function healthy(engine = 'unity', { root = mainRoot(), instance = 'check', env = process.env, now = Date.now() } = {}) {
  const s = serviceSettings(root, engine, env);
  const rec = readInstance(root, engine, instance);
  if (!rec?.pid) return { ok: false, why: 'no editor is running', rec, hb: null };
  if (!editorAlive(rec)) return { ok: false, why: `the editor (pid ${rec.pid}) is gone`, rec, hb: null, dead: true };
  const hb = readHeartbeat(rec.folder);
  if (!hb) return { ok: false, why: 'no heartbeat yet', rec, hb };
  const age = now - hb.at;
  if (hb.busy) {
    const req = readJson(path.join(rec.folder, 'requests', `${hb.busy}.json`));
    const since = Date.parse(req?.at || '') || rec.lastSentAt || hb.at;
    if (now - since > s.requestTimeoutMin * 60000) return { ok: false, why: `busy with ${hb.busy} for ${Math.round((now - since) / 1000)} s (over requestTimeoutMin)`, rec, hb };
    return { ok: true, why: `busy with ${hb.busy}`, rec, hb };
  }
  if (age > s.staleSec * 1000) return { ok: false, why: `heartbeat ${Math.round(age / 1000)} s old (over ${s.staleSec} s)`, rec, hb };
  return { ok: true, why: 'alive', rec, hb };
}

/** Why the instance should be restarted before its next request, or null (recycleAfter requests, recycleMin minutes, a timeout). */
export function recycleDue(rec, s, now = Date.now()) {
  if (!rec) return null;
  if (rec.recycle) return rec.recycle;
  if (Number(rec.requests || 0) >= s.recycleAfter) return `${rec.requests} request(s) served (recycleAfter ${s.recycleAfter})`;
  if (rec.startedAt && now - rec.startedAt >= s.recycleMin * 60000) return `open ${Math.round((now - rec.startedAt) / 60000)} min (recycleMin ${s.recycleMin})`;
  return null;
}

// ---- the editor process --------------------------------------------------------------------------------------

/**
 * Is the recorded editor alive? pidAlive (the pid and, on Linux, its /proc start), and on Linux not a zombie: an editor
 * whose starting process has exited is reparented, and one killed there can stay a zombie that still answers kill(pid, 0).
 */
export function editorAlive(rec) {
  if (!rec?.pid || !pidAlive(rec.pid, rec.identity)) return false;
  if (process.platform === 'linux') {
    try { const st = fs.readFileSync(`/proc/${rec.pid}/stat`, 'utf8'); if (st.slice(st.lastIndexOf(')') + 2).startsWith('Z')) return false; } catch { /* unreadable: alive as far as known */ }
  }
  return true;
}

/** How to run the editor binary: [command, args before ours]. A .mjs/.js path is the stand-in editor, run with node. */
export function editorCommand(bin = unityBin()) {
  return /\.(mjs|cjs|js)$/i.test(bin) ? [process.execPath, [bin]] : [bin, []];
}

/**
 * Kill an editor this harness started (the recorded pid, only while it is still that process), with its tree.
 * 2.84: only a CONFIRMED identity is killed (liveAs strict: the OS's start of the pid matches the recorded one). A pid
 * whose start can't be read (on Windows a PowerShell that failed or timed out) is left alone: the old rule counted it
 * as ours and killed, with taskkill /T, whatever program had taken over the number.
 */
function killOwn(rec) {
  // liveAs: the pid and its recorded start (one OS query on Windows and macOS, where pid numbers are reused).
  if (!rec?.pid || !editorAlive(rec) || !liveAs(rec.pid, rec.identity, { strict: true })) return false;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(rec.pid), '/T', '/F'], { windowsHide: true });
  else {
    // Started detached, so it leads its own process group: the group is the editor and its workers.
    try { process.kill(-rec.pid, 'SIGKILL'); } catch { try { process.kill(rec.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  return true;
}

async function waitGone(rec, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!editorAlive(rec)) return true; await sleep(100); }
  return !editorAlive(rec);
}

/**
 * Start the editor detached on `project` and wait for its first heartbeat. { ok, rec } or { ok: false, why, refused? }.
 * Refused when Unity's lock file shows another editor has the project open (a leftover of OUR dead editor is removed).
 */
export async function startEditor(engine = 'unity', { root = mainRoot(), instance = 'check', project, env = process.env, log = () => {} } = {}) {
  const s = serviceSettings(root, engine, env);
  if (s.off) return { ok: false, off: true, why: 'STUDIO_EDITOR_SERVICE=off' };
  if (!project || !fs.existsSync(project)) return { ok: false, why: `the project folder ${fwd(project) || '(none)'} does not exist` };
  project = path.resolve(project);
  const old = readInstance(root, engine, instance);
  if (editorAlive(old)) return { ok: true, already: true, rec: old };
  const lockF = unityLockFile(project);
  if (fs.existsSync(lockF)) {
    const ours = old && path.resolve(old.project || '') === project;
    if (!ours) return { ok: false, refused: true, why: `another editor has ${fwd(project)} open (Temp/UnityLockfile exists); Unity allows one editor per project. If none is open, delete that file.` };
    try { fs.rmSync(lockF, { force: true }); } catch { /* the editor reports it */ }
  }
  const folder = serviceFolder(project);
  // A request left from before (a hung one) must not be picked up by the new editor.
  for (const d of ['requests', 'responses']) { fs.rmSync(path.join(folder, d), { recursive: true, force: true }); fs.mkdirSync(path.join(folder, d), { recursive: true }); }
  fs.rmSync(path.join(folder, 'heartbeat.json'), { force: true });
  const logFile = path.join(stateDir(root), 'logs', `${safeName(engine)}-${instance}-${Date.now()}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const [cmd, pre] = editorCommand();
  const args = [...pre, '-batchmode', '-projectPath', project, '-studioService', folder, '-studioHeartbeatSec', String(s.heartbeatSec), '-logFile', logFile];
  const startedAt = Date.now();
  let child;
  try {
    child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: project, env });
  } catch (e) { return { ok: false, why: `could not start the editor (${cmd}): ${e.message}` }; }
  let spawnError = null;
  child.on('error', (e) => { spawnError = e; });
  child.unref();
  if (!child.pid) { await sleep(50); return { ok: false, why: `could not start the editor (${cmd}): ${spawnError?.message || 'no process'}` }; }
  const rec = { instance, pid: child.pid, identity: spawnedIdentity(child.pid, cmd, startedAt), project, folder, logFile, startedAt, requests: 0, recycle: null, lastSentAt: null };
  patchInstance(root, engine, instance, { ...rec, recycle: null });
  log(`[editor-service] ${engine}/${instance}: started the editor (pid ${child.pid}) on ${fwd(project)}; waiting for its first heartbeat`);
  const end = startedAt + s.startTimeoutMin * 60000;
  while (Date.now() < end) {
    if (spawnError) break;
    const hb = readHeartbeat(folder);
    if (hb && hb.at >= startedAt - 1000) return { ok: true, rec: readInstance(root, engine, instance), hb };
    if (!editorAlive(rec)) return { ok: false, why: `the editor exited before its first heartbeat (log: ${fwd(logFile)})`, rec };
    await sleep(100);
  }
  killOwn(rec);
  return { ok: false, why: spawnError ? `could not start the editor (${cmd}): ${spawnError.message}` : `no heartbeat within ${s.startTimeoutMin} min (log: ${fwd(logFile)})`, rec };
}

// A stopped instance keeps its project and folder (the next ensure() opens the same project again).
const STOPPED = { pid: null, identity: null };

/**
 * A `quit` request, then (still alive after graceSec) a kill of the pid THIS harness started. Never another process.
 * 2.84: who the recorded pid is, before anything is sent:
 *  - its start differs from the recorded one, or it is gone: another program now; nothing sent, nothing killed;
 *  - its start matches (liveAs strict): ours; quit, then the kill;
 *  - its start can't be read (on Windows a PowerShell that failed or timed out): the editor's own heartbeat decides
 *    whether the quit is sent (a fresh heartbeat in the recorded folder naming this very pid: the editor says it is
 *    this process). A quit request only reaches the editor serving that folder. The kill still needs a confirmed
 *    start, so an unconfirmed pid is never killed; it is reported instead.
 */
export async function stopEditor(engine = 'unity', { root = mainRoot(), instance = 'check', env = process.env, log = () => {}, why = 'stopped' } = {}) {
  const s = serviceSettings(root, engine, env);
  const rec = readInstance(root, engine, instance);
  if (!rec?.pid) return { ok: true, running: false, why: 'no editor recorded' };
  const notOurs = () => { patchInstance(root, engine, instance, STOPPED); return { ok: true, running: false, why: `pid ${rec.pid} is not the editor this harness started (gone or another program now): nothing killed` }; };
  if (!editorAlive(rec) || !liveAs(rec.pid, rec.identity)) return notOurs();
  const note = {};
  const confirmed = liveAs(rec.pid, rec.identity, { strict: true, note });
  if (!confirmed) {
    const hb = readHeartbeat(rec.folder);
    const fresh = hb && Date.now() - hb.at <= s.staleSec * 1000;
    // The editor serving this folder is another pid: the record names a program that only has the number now.
    if (fresh && Number(hb.pid) !== Number(rec.pid)) return notOurs();
    if (!fresh || Number(hb.pid) !== Number(rec.pid)) {
      return { ok: false, running: true, unconfirmed: true, pid: rec.pid, why: `pid ${rec.pid} could not be confirmed as the editor this harness started (${note.why || 'start unreadable'}) and its heartbeat does not name it: nothing sent, nothing killed; the record is kept` };
    }
  }
  try { writeRequest(rec.folder, 'quit', {}); } catch { /* the kill below */ }
  let killed = false;
  if (!(await waitGone(rec, s.graceSec * 1000))) { killed = killOwn(rec); await waitGone(rec, 5000); }
  if (editorAlive(rec) && !killed) {
    const m = `editor pid ${rec.pid} did not quit within ${s.graceSec} s and was not killed: its start could not be confirmed (${note.why || 'start unreadable'}); stop it by hand if it is the editor`;
    log(`[editor-service] ${engine}/${instance}: ${m}`);
    return { ok: false, running: true, killed: false, unconfirmed: true, pid: rec.pid, why: m };
  }
  patchInstance(root, engine, instance, STOPPED);
  log(`[editor-service] ${engine}/${instance}: editor pid ${rec.pid} ${killed ? 'killed after the grace period' : 'quit'} (${why})`);
  return { ok: true, running: true, killed, pid: rec.pid };
}

/**
 * ensure(engine): a healthy editor for this instance, restarted ONCE when it is not healthy or is due a recycle.
 * A second failure (the restart) returns { ok: false, why } and leaves no editor of ours holding the project, so a
 * caller's cold path can open it.
 */
export async function ensure(engine = 'unity', { root = mainRoot(), instance = 'check', project = null, env = process.env, log = () => {} } = {}) {
  const s = serviceSettings(root, engine, env);
  if (s.off) return { ok: false, off: true, why: 'STUDIO_EDITOR_SERVICE=off' };
  const h = healthy(engine, { root, instance, env });
  const rec = h.rec;
  const proj = project ? path.resolve(project) : rec?.project || null;
  const moved = rec && proj && path.resolve(rec.project || '') !== proj;
  const due = recycleDue(rec, s);
  if (h.ok && !due && !moved) return { ok: true, rec, why: h.why };
  const reason = moved ? 'its project changed' : due ? `recycle: ${due}` : `not healthy: ${h.why}`;
  if (rec?.pid) await stopEditor(engine, { root, instance, env, log, why: reason });
  if (!proj) return { ok: false, why: 'no project folder to open' };
  const st = await startEditor(engine, { root, instance, project: proj, env, log });
  if (!st.ok) {
    const r = readInstance(root, engine, instance);
    if (r?.pid) { killOwn(r); patchInstance(root, engine, instance, STOPPED); }
    return { ok: false, refused: st.refused, why: `${reason}; the restart failed: ${st.why}` };
  }
  return { ok: true, rec: st.rec, restarted: Boolean(rec?.pid) || undefined, why: reason };
}

// ---- requests -------------------------------------------------------------------------------------------------

function writeRequest(folder, kind, args = {}) {
  const id = `${Date.now()}-${process.pid}-${(seq++).toString(36)}-${kind}`;
  const req = { ...args, id, kind, at: new Date().toISOString() };
  writeJson(path.join(folder, 'requests', `${id}.json`), req);
  return req;
}

/** Errors as the harness prints them: project-relative, forward slashes, a number for the line. */
export function normalizeErrors(list, project = null) {
  return (Array.isArray(list) ? list : []).filter((e) => e && typeof e === 'object').map((e) => {
    let file = String(e.file || '').replace(/\\/g, '/');
    if (project && file) { const abs = fwd(path.resolve(project)); if (file.toLowerCase().startsWith(`${abs.toLowerCase()}/`)) file = file.slice(abs.length + 1); }
    return { file, line: Number(e.line) || 0, code: String(e.code || ''), message: String(e.message || '').trim() };
  });
}
export const formatError = (e) => `${e.file || '?'}(${e.line || 0}): ${e.code ? `${e.code} ` : ''}${e.message}`;

/**
 * Send one request to a running instance and wait for its response (up to requestTimeoutMin, or timeoutMs).
 * A timed-out request recycles the editor at once (stopped now; the next ensure starts a fresh one).
 */
export async function sendRequest(engine = 'unity', kind = 'ping', args = {}, { root = mainRoot(), instance = 'check', env = process.env, timeoutMs = null, log = () => {} } = {}) {
  if (!KINDS.includes(kind)) return { ok: false, kind, why: `unknown request kind ${kind} (${KINDS.join(', ')})` };
  const s = serviceSettings(root, engine, env);
  const rec = readInstance(root, engine, instance);
  if (!rec?.pid || !editorAlive(rec)) return { ok: false, kind, down: true, why: 'no editor is running for this instance' };
  const req = writeRequest(rec.folder, kind, args);
  patchInstance(root, engine, instance, { lastSentAt: Date.now() });
  const t0 = Date.now();
  const limit = timeoutMs ?? s.requestTimeoutMin * 60000;
  const respF = path.join(rec.folder, 'responses', `${req.id}.json`);
  while (Date.now() - t0 < limit) {
    const resp = fs.existsSync(respF) ? readJson(respF) : null;
    if (resp && resp.id === req.id) {
      try { fs.rmSync(respF, { force: true }); fs.rmSync(path.join(rec.folder, 'requests', `${req.id}.json`), { force: true }); } catch { /* left for the next start */ }
      const cur = readInstance(root, engine, instance);
      if (cur?.pid === rec.pid) patchInstance(root, engine, instance, { requests: Number(cur.requests || 0) + 1 });
      const images = (Array.isArray(resp.images) ? resp.images : []).filter(Boolean).map((p) => path.resolve(rec.project, p));
      return { ...resp, ok: resp.ok === true, kind: resp.kind || kind, ms: Number(resp.ms) || Date.now() - t0, errors: normalizeErrors(resp.errors, rec.project), images, results: resp.results || undefined, log: resp.log || undefined, why: resp.why || undefined };
    }
    if (kind === 'quit' && !editorAlive(rec)) { patchInstance(root, engine, instance, STOPPED); return { ok: true, kind, ms: Date.now() - t0, errors: [], why: 'the editor quit' }; }
    if (!editorAlive(rec)) {
      patchInstance(root, engine, instance, { recycle: 'the editor ended during a request' });
      return { ok: false, kind, died: true, ms: Date.now() - t0, errors: [], why: `the editor (pid ${rec.pid}) ended during the ${kind} request` };
    }
    await sleep(100);
  }
  patchInstance(root, engine, instance, { recycle: `a ${kind} request timed out` });
  log(`[editor-service] ${engine}/${instance}: the ${kind} request timed out after ${Math.round(limit / 1000)} s: recycling the editor`);
  await stopEditor(engine, { root, instance, env, log, why: `a ${kind} request timed out` });
  return { ok: false, kind, timedOut: true, ms: Date.now() - t0, errors: [], why: `no answer within ${Math.round(limit / 1000)} s: the editor was recycled` };
}

/** ensure, then send. */
export async function request(engine, kind, args = {}, opts = {}) {
  const e = await ensure(engine, opts);
  if (!e.ok) return { ok: false, kind, down: true, errors: [], why: e.why };
  return sendRequest(engine, kind, args, opts);
}

// ---- the warm editor for land runs -----------------------------------------------------------------------------

/** The land tree: the land script's gate worktree, else the track's folder, else engines.<x>.cwd (the first that exists). */
export function landTree(root, engine, cfg = {}) {
  for (const d of [cfg?.gateWorktree, cfg?.folder, cfg?.cwd]) {
    if (typeof d === 'string' && d.trim() && fs.existsSync(path.resolve(root, d))) return path.resolve(root, d);
  }
  return null;
}

/**
 * What the engine train adds to a land command's environment: { STUDIO_EDITOR_SERVICE, STUDIO_EDITOR_SERVICE_CLI } when
 * engines.<x>.warm is on and the "land" instance is (or is restarted) healthy on the land tree; else {} (the cold
 * path), with engine.warm.fallback saying why. warm off: {} and no event.
 */
export async function warmLandEnv({ root = mainRoot(), engine = 'unity', cfg = null, env = process.env, log = () => {}, emit = emitEvent } = {}) {
  const s = serviceSettings(root, engine, env);
  if (!s.warm) return {};
  const fallback = (why) => {
    log(`[editor-service] ${engine}: no warm editor for this land run (${why}); the land command starts its own`);
    try { emit({ type: 'engine.warm.fallback', agent: `${engine}-train`, status: 'warn', track: `engine:${engine}`, msg: `${engine} land run: no warm editor (${why}); cold path`.slice(0, 500), meta: { engine, why: String(why).slice(0, 300) } }); } catch { /* an event only */ }
    return {};
  };
  if (s.off) return fallback('STUDIO_EDITOR_SERVICE=off');
  const project = landTree(root, engine, cfg || s.cfg);
  if (!project) return fallback('no land tree (engines.<x>.gateWorktree or cwd)');
  const e = await ensure(engine, { root, instance: 'land', project, env, log });
  if (!e.ok) return fallback(e.why);
  return { STUDIO_EDITOR_SERVICE: e.rec.folder, STUDIO_EDITOR_SERVICE_CLI: `"${process.execPath}" "${THIS_FILE}" request --engine ${engine} --instance land` };
}

// ---- the agents' queue -------------------------------------------------------------------------------------------

export function readQueue(root = mainRoot()) {
  const q = readJson(queueFile(root));
  return Array.isArray(q?.requests) ? q.requests : [];
}
function withQueue(root, fn) {
  return withFileLock('editor-service-queue', () => {
    const q = readQueue(root);
    const out = fn(q);
    writeJson(queueFile(root), { requests: q });
    return out;
  }, lockOpts(root));
}

/** The engine whose queue a check goes to: --engine, else the only engine with service.check on, else unity. */
function defaultEngine(root, explicit) {
  if (explicit) return explicit;
  const on = Object.entries(enginesOf(root)).filter(([, c]) => c?.service?.check === true).map(([n]) => n);
  return on.length === 1 ? on[0] : 'unity';
}

/**
 * Queue a compile (+ capture) of a lane's branch. One waiting request per lane and engine: a newer one replaces it.
 * { ok, id, replaced } or { ok: false, why }.
 */
export function enqueueCheck(root = mainRoot(), { engine = 'unity', lane, branch, capture = null, by = null, env = process.env } = {}) {
  const s = serviceSettings(root, engine, env);
  if (s.off) return { ok: false, why: 'the editor service is off (STUDIO_EDITOR_SERVICE=off)' };
  if (!s.check) return { ok: false, why: `the editor service is off for ${engine} (studio/game.json engines.${engine}.service.check)` };
  if (!lane) return { ok: false, why: 'no lane: pass --lane <agent> (or run it from an agent session)' };
  if (!safeRefName(branch || '')) return { ok: false, why: `not a branch name: ${JSON.stringify(branch ?? null)} (pass --branch <b>)` };
  const repo = unityRepo(s.cfg, root, engine);
  let head = null;
  if (repo) {
    head = gitOut(git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`));
    if (!head) return { ok: false, why: `the ${engine} repo has no branch ${branch}` };
  }
  const entry = { id: `chk-${Date.now()}-${process.pid}-${(seq++).toString(36)}`, engine, lane: String(lane), branch, head, capture, by: by || lane, at: new Date().toISOString() };
  const replaced = withQueue(root, (q) => {
    let n = 0;
    for (let i = q.length - 1; i >= 0; i -= 1) if (q[i].engine === engine && q[i].lane === entry.lane && !q[i].startedAt) { q.splice(i, 1); n += 1; }
    q.push(entry);
    return n;
  });
  return { ok: true, id: entry.id, replaced, entry };
}

/** The service's own checkout for the "check" instance: engines.<x>.service.dir, else a git worktree under .studio/editor-service/. */
function checkTree(root, engine, s, repo, head) {
  if (s.dir) { const d = path.resolve(root, s.dir); return fs.existsSync(d) ? { dir: d } : { why: `engines.${engine}.service.dir ${fwd(s.dir)} does not exist` }; }
  const d = path.join(stateDir(root), `${safeName(engine)}-tree`);
  if (!fs.existsSync(path.join(d, '.git'))) {
    git(repo, 'worktree', 'prune');
    const r = git(repo, 'worktree', 'add', '--detach', d, head);
    if (r.status !== 0) return { why: `could not make the service's checkout: ${String(r.stderr || '').trim().split('\n')[0]}` };
  }
  return { dir: d };
}

const passing = new Set();
/** 2.86: a background pass of this process still runs (the supervisor restarts on new code only when none does). */
export const editorServiceBusy = () => passing.size > 0;

/**
 * One queue pass: the oldest waiting check request of each engine with service.check on. Skipped while that engine's
 * train runs. background: start the work and return at once (the supervisor never waits minutes for a compile).
 */
export function editorServicePass(opts = {}) {
  const root = opts.root || mainRoot();
  const env = opts.env || process.env;
  if (masterOff(env)) return opts.background ? { off: true } : Promise.resolve({ off: true });
  const engines = Object.entries(enginesOf(root)).filter(([, c]) => c?.service?.check === true).map(([n]) => n);
  if (!engines.length) return opts.background ? { off: true } : Promise.resolve({ off: true });
  if (passing.has(root)) return opts.background ? { busy: true } : Promise.resolve({ busy: true, why: 'a pass is running in this process' });
  passing.add(root);
  const work = (async () => {
    const results = [];
    try { for (const engine of engines) results.push(await passOne(root, engine, env, opts.log || (() => {}), opts.emit || emitEvent)); }
    finally { passing.delete(root); }
    return { engines: results };
  })();
  if (opts.background) { work.catch(() => {}); return { started: true }; }
  return work;
}

async function passOne(root, engine, env, log, emit) {
  const s = serviceSettings(root, engine, env);
  const waiting = readQueue(root).filter((e) => e.engine === engine && !e.startedAt);
  if (!waiting.length) return { engine, idle: true };
  const train = runningUnityTrain(root, engine);
  if (train) {
    const why = `the ${engine} train ${train.id || '?'} is running: the editor service waits so it does not fight the train for CPU and RAM`;
    log(`[editor-service] ${why}`);
    try { writeJson(path.join(stateDir(root), 'status.json'), { at: new Date().toISOString(), engine, skipped: why, waiting: waiting.length }); } catch { /* status only */ }
    return { engine, skipped: why };
  }
  const entry = waiting[0];
  withQueue(root, (q) => { const e = q.find((x) => x.id === entry.id); if (e) { e.startedAt = new Date().toISOString(); e.runner = process.pid; } });
  const t0 = Date.now();
  const repo = unityRepo(s.cfg, root, engine);
  const head = (repo && gitOut(git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${entry.branch}^{commit}`))) || entry.head;
  const out = outDir(root, entry.lane, head);
  const result = { id: entry.id, engine, lane: entry.lane, branch: entry.branch, head, ok: false, errors: [], images: [], ms: 0, at: null };
  try {
    if (!repo || !head) throw new Error(!repo ? `the ${engine} repo was not found (engines.${engine}.gateWorktree or cwd)` : `branch ${entry.branch} not found`);
    const tree = checkTree(root, engine, s, repo, head);
    if (!tree.dir) throw new Error(tree.why);
    const co = git(tree.dir, 'checkout', '-q', '-f', '--detach', head);
    if (co.status !== 0) throw new Error(`could not check out ${String(head).slice(0, 8)} in the service's checkout: ${String(co.stderr || '').trim().split('\n')[0]}`);
    const opts = { root, instance: 'check', project: tree.dir, env, log };
    const c = await request(engine, 'compile', {}, opts);
    result.errors = c.errors || [];
    if (!c.ok && !result.errors.length) throw new Error(c.why || 'the compile request failed');
    if (c.ok && entry.capture?.scene) {
      fs.mkdirSync(out, { recursive: true });
      const png = path.join(out, `${safeName(path.basename(entry.capture.scene, path.extname(entry.capture.scene)))}.png`);
      const cap = await sendRequest(engine, 'capture', { scene: entry.capture.scene, camera: entry.capture.camera || '', width: 1280, height: 720, out: png }, opts);
      if (!cap.ok) result.why = `capture: ${cap.why || 'failed'}`;
      result.images = (cap.images?.length ? cap.images : fs.existsSync(png) ? [png] : []).map(fwd);
    }
    result.ok = c.ok && !result.errors.length && !result.why;
  } catch (e) { result.why = e.message; }
  result.ms = Date.now() - t0;
  result.at = new Date().toISOString();
  writeJson(path.join(out, 'result.json'), result);
  writeJson(path.join(stateDir(root), 'out', safeName(entry.lane), 'latest.json'), result);
  withQueue(root, (q) => { const i = q.findIndex((x) => x.id === entry.id); if (i >= 0) q.splice(i, 1); });
  try {
    emit({ type: 'editor.check', agent: 'editor-service', to: entry.lane, status: result.ok ? 'ok' : 'error', track: `engine:${engine}`, msg: `editor check of ${entry.lane} (${entry.branch} at ${String(head || '?').slice(0, 8)}): ${result.ok ? 'compiles' : result.errors.length ? `${result.errors.length} compiler error(s): ${formatError(result.errors[0])}` : result.why}${result.images.length ? `; ${result.images.length} image(s)` : ''}`.slice(0, 600), meta: { lane: entry.lane, head, errors: result.errors.length, images: result.images.length, ms: result.ms } });
  } catch { /* an event only */ }
  log(`[editor-service] ${engine}: checked ${entry.lane} (${entry.branch}): ${result.ok ? 'ok' : result.why || `${result.errors.length} error(s)`}`);
  return { engine, ran: entry.id, result };
}

/** The last result of a lane, as lines: a summary, `file(line): code message` per error, `image: <path>` per PNG. */
export function resultText(r) {
  if (!r) return 'No editor check result for this lane yet.';
  const lines = [`editor check ${r.ok ? 'OK' : 'ERROR'}: ${r.lane} ${r.branch} at ${String(r.head || '?').slice(0, 8)} (${Math.round((r.ms || 0) / 1000)} s)${r.why ? `: ${r.why}` : ''}`];
  for (const e of r.errors || []) lines.push(formatError(e));
  for (const i of r.images || []) lines.push(`image: ${fwd(i)}`);
  return lines.join('\n');
}
export const readResult = (root, lane) => readJson(path.join(stateDir(root), 'out', safeName(lane), 'latest.json'));

// ---- command line ---------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) o[k] = true; else { o[k] = v; i += 1; } }
    else o._.push(a);
  }
  return o;
}

async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const cmd = o._[0] || 'status';
  const root = mainRoot();
  const engine = defaultEngine(root, typeof o.engine === 'string' ? o.engine : null);
  const instance = typeof o.instance === 'string' ? o.instance : 'check';
  const log = (m) => console.error(m);
  const print = (v) => console.log(JSON.stringify(v, null, 2));
  if (!INSTANCES.includes(instance)) { console.error(`[editor-service] --instance is one of ${INSTANCES.join(', ')}`); return 2; }
  if (cmd === 'start') {
    const s = serviceSettings(root, engine);
    const project = typeof o.project === 'string' ? path.resolve(o.project) : instance === 'land' ? landTree(root, engine, s.cfg) : s.dir ? path.resolve(root, s.dir) : null;
    if (!project) { console.error('[editor-service] which project? pass --project <dir> (or set engines.<x>.service.dir)'); return 2; }
    const r = await startEditor(engine, { root, instance, project, log });
    print({ ok: r.ok, already: r.already || undefined, refused: r.refused || undefined, why: r.why, pid: r.rec?.pid, folder: r.rec?.folder ? fwd(r.rec.folder) : undefined });
    return r.ok ? 0 : r.refused ? 3 : 1;
  }
  if (cmd === 'status') {
    const s = serviceSettings(root, engine);
    const rows = INSTANCES.map((i) => { const h = healthy(engine, { root, instance: i }); return { instance: i, healthy: h.ok, why: h.why, pid: h.rec?.pid || null, project: h.rec?.project ? fwd(h.rec.project) : null, requests: h.rec?.requests || 0, busy: h.hb?.busy || null }; });
    const st = { engine, off: s.off, check: s.check, warm: s.warm, instances: rows, queue: readQueue(root).filter((e) => e.engine === engine).length, last: readJson(path.join(stateDir(root), 'status.json')) };
    if (o.json) print(st);
    else {
      console.log(`Editor service (${engine}): ${s.off ? 'off (STUDIO_EDITOR_SERVICE=off)' : `queue ${s.check ? 'on' : 'off'}, warm land ${s.warm ? 'on' : 'off'}`}; ${st.queue} check request(s) waiting. UNTESTED on a real editor.`);
      for (const r of rows) console.log(`  ${r.instance}: ${r.healthy ? 'healthy' : 'not healthy'} (${r.why})${r.pid ? `, pid ${r.pid}, ${r.requests} request(s), ${r.project}` : ''}`);
      if (st.last?.skipped) console.log(`  last pass skipped: ${st.last.skipped}`);
    }
    return 0;
  }
  if (cmd === 'stop') { print(await stopEditor(engine, { root, instance, log })); return 0; }
  if (cmd === 'request') {
    const kind = o._[1];
    const args = {};
    if (kind === 'test') { args.mode = typeof o.mode === 'string' ? o.mode : 'EditMode'; if (typeof o.filter === 'string') args.filter = o.filter; if (typeof o.assemblies === 'string') args.assemblyNames = o.assemblies.split(';').filter(Boolean); args.resultsPath = path.resolve(typeof o.results === 'string' ? o.results : `TestResults-service-${Date.now()}.xml`); }
    if (kind === 'capture') { args.scene = o.scene || ''; args.camera = typeof o.camera === 'string' ? o.camera : ''; args.width = num(o.width, 1280); args.height = num(o.height, 720); args.out = path.resolve(typeof o.out === 'string' ? o.out : `capture-${Date.now()}.png`); }
    const h = healthy(engine, { root, instance });
    if (!h.ok) {
      // An editor of ours that is not healthy still holds the project: stop it so the caller's cold path can open it.
      if (h.rec?.pid) await stopEditor(engine, { root, instance, log, why: `not healthy: ${h.why}` });
      print({ ok: false, kind, down: true, why: `no healthy editor (${h.why}): fall back to the cold path` });
      return 3;
    }
    const r = await sendRequest(engine, kind, args, { root, instance, log, timeoutMs: o['timeout-min'] ? num(o['timeout-min'], 30) * 60000 : null });
    print(r);
    return r.ok ? 0 : r.down || r.timedOut || r.died ? 3 : 1;
  }
  if (cmd === 'check') {
    const lane = typeof o.lane === 'string' ? o.lane : process.env.STUDIO_LOCK_OWNER || process.env.STUDIO_AGENT || '';
    let branch = typeof o.branch === 'string' ? o.branch : '';
    if (!branch) { const b = gitOut(git(process.cwd(), 'rev-parse', '--abbrev-ref', 'HEAD')); if (b && b !== 'HEAD') branch = b; }
    let capture = null;
    if (typeof o.capture === 'string') { const [scene, camera] = o.capture.split(':'); capture = { scene, camera: camera || null }; }
    const r = enqueueCheck(root, { engine, lane, branch, capture });
    if (!r.ok) { console.error(`[editor-service] not queued: ${r.why}`); return 1; }
    console.log(`[editor-service] queued ${r.id}: compile${capture ? ` + capture of ${capture.scene}` : ''} of ${branch} for ${lane}${r.replaced ? ` (replaced ${r.replaced} waiting request)` : ''}. UNTESTED on a real editor.`);
    if (!o.wait) { console.log('Read the result later: npm run editor -- result'); return 0; }
    const s = serviceSettings(root, engine);
    const end = Date.now() + num(o['timeout-min'], s.requestTimeoutMin * 2 + s.startTimeoutMin) * 60000;
    while (Date.now() < end) {
      const res = readResult(root, lane);
      if (res?.id === r.id) { console.log(resultText(res)); return res.ok ? 0 : 1; }
      await sleep(1000);
    }
    console.error('[editor-service] no result yet (the supervisor runs the queue): npm run editor -- result'); return 3;
  }
  if (cmd === 'result') {
    const lane = typeof o.lane === 'string' ? o.lane : process.env.STUDIO_LOCK_OWNER || process.env.STUDIO_AGENT || '';
    const res = readResult(root, lane);
    if (o.json) print(res); else console.log(resultText(res));
    return res ? (res.ok ? 0 : 1) : 3;
  }
  if (cmd === 'pass') { const r = await editorServicePass({ root, log }); print(r); return 0; }
  console.error('usage: npm run editor -- start|status|stop|request <kind>|check|result|pass [--engine x] (docs/NATIVE-ENGINE.md)');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`[editor-service] ${e?.stack || e}`); process.exitCode = 1; });
}
