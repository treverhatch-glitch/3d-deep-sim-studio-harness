/**
 * harness/engine-train-control.mjs — 2.84 (u): control of an engine train: which lanes it takes, stopping it, and its
 * automatic start.
 *
 * What a crew hit in one day: an art batch had to land apart from 16 queued ports and there was no way to pick lanes
 * (the overseer carried a local env-var patch); the automatic start began a port train 40 seconds after the overseer
 * stopped one; `task train cancel` covered only the game's own train; one risky branch stalled a 16-branch train.
 *
 *   selectBatch     the train's batch from the queue: --only ids / a --tag (else untagged lanes only), then an "alone"
 *                   lane rides by itself (2.83), then engines.<x>.batchGroup "play" keeps only the head lane's Play Mode
 *                   class (harness/engine-rules.mjs playSelection per lane), then the cap (--max, engines.<x>.batchMax,
 *                   STUDIO_ENGINE_BATCH_MAX). Its `why` says, in plain words, why the batch is what it is.
 *   cancelEngineTrain  `npm run task -- train cancel --engine <x> --by <name>`: the cancel file first, the train's tree
 *                   killed, the gate worktree put back at the target, the train's integration refs deleted, the lock
 *                   released; the queue is left as it was (nobody handed back, nobody blamed).
 *   setEngineAuto   `npm run task -- train auto off|on --engine <x> --by <name> [--hours N]`: the Line Producer's
 *                   automatic start for that engine (.studio/train/<x>-auto.json).
 * Who may cancel or switch: the board-decision verdict (harness/permission.mjs mayDecide('board')): the owner, the
 * owner's stand-ins and outside agents; never a launched worker session.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { emitEvent, readRecentEvents } from './event.mjs';
import { visionFixIds, visionFirst } from './vision-fix.mjs';
import { writeAtomic, readJson } from './fsafe.mjs';
import { pidAlive } from './proc-identity.mjs';
import { changedPaths, playSelection, playFocusConfig } from './engine-rules.mjs';
import { engineTarget, engineFiles } from './engine-tracks.mjs';

const git = (cwd, ...args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); writeAtomic(f, `${JSON.stringify(v, null, 2)}\n`); };
const labelOf = (engine) => engineTarget(engine)?.label || engine;
const fwd = (p) => String(p || '').split(path.sep).join('/');

// ---- lane tags --------------------------------------------------------------------------------------------------

/** 2.84 (u): a lane tag is one plain word (letters, digits, _ and -, up to 31). */
export const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;
/** A tag as given: the word (lower case), null for none ("none", "off", empty), undefined when it is not a plain word. */
export function normTag(v) {
  const t = String(v ?? '').trim().toLowerCase();
  if (!t || /^(none|off|-)$/.test(t)) return null;
  return TAG_RE.test(t) ? t : undefined;
}
/** "T-1, T-2" -> ['T-1', 'T-2'] (a list, a string or nothing). */
export const onlyList = (v) => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(/[,\s]+/)).map((x) => String(x).trim()).filter(Boolean))];

// ---- the batch -----------------------------------------------------------------------------------------------------

/**
 * 2.84 (u): engines.<x>.batchMax (STUDIO_ENGINE_BATCH_MAX over it; 0: no cap) and engines.<x>.batchGroup ("play", else
 * off). { batchMax, group }.
 */
export function batchLimits(cfg = {}, env = process.env) {
  let batchMax = 0;
  for (const x of [env.STUDIO_ENGINE_BATCH_MAX, cfg?.batchMax]) { const t = String(x ?? '').trim(); if (t !== '' && Number.isFinite(Number(t)) && Number(t) >= 0) { batchMax = Math.floor(Number(t)); break; } }
  return { batchMax, group: String(cfg?.batchGroup || '').trim().toLowerCase() === 'play' ? 'play' : null };
}

/**
 * 2.84 (u): the Play Mode class of one queued lane: the `mode` playSelection gives for the paths the lane's branch
 * changes against the target (from their merge base). 'full' when there is no play.focus config or git can't tell.
 */
export function laneClass({ repo, target, cfg = {}, lane }) {
  if (!playFocusConfig(cfg)) return 'full';
  const head = out(git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${lane.branch}^{commit}`)) || lane.head;
  const base = head ? out(git(repo, 'merge-base', `refs/heads/${target}`, head)) : '';
  const changed = base ? changedPaths(repo, base, head) : null;
  try { return String(playSelection({ changed, cfg, full: false }).mode || 'full'); } catch { return 'full'; }
}

/**
 * 2.86: does one queued lane change a path engines.<x>.batchAlone names (a list of regexes, like play.focus.skip: long Play Mode
 * scenario tests, say)? Then it lands alone, as --alone does. The first matching path, or null (no list, no match, git can't tell).
 */
export function laneAloneWhy({ repo, target, cfg = {}, lane }) {
  const pats = (Array.isArray(cfg?.batchAlone) ? cfg.batchAlone : []).map((p) => { try { return new RegExp(String(p)); } catch { return null; } }).filter(Boolean);
  if (!pats.length) return null;
  const head = out(git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${lane.branch}^{commit}`)) || lane.head;
  const base = head ? out(git(repo, 'merge-base', `refs/heads/${target}`, head)) : '';
  const changed = base ? changedPaths(repo, base, head) : null;
  return (changed || []).find((p) => pats.some((re) => re.test(p))) || null;
}

/**
 * 2.84 (u): this train's batch from the queue (in queue order). opts: only (task ids), tag, max (--max), batchMax,
 * group ('play' | null), classOf(lane) -> class. Order: --only and --tag first (a train with neither takes untagged lanes
 * only: a tagged lane is never swept into a general train), then an alone lane rides by itself, then grouping, then the
 * cap. { lanes, why, total, waiting, cls, alone, tagged } or { error: 'unknown', unknown, why } when an --only id is not
 * queued.
 */
export function selectBatch(queue, { only = [], tag = null, max = 0, batchMax = 0, group = null, classOf = () => 'full', isVision = null, waits = null, aloneOf = null } = {}) {
  const q = Array.isArray(queue) ? queue.filter((e) => e && e.task) : [];
  const ids = onlyList(only);
  const unknown = ids.filter((id) => !q.some((e) => e.task === id));
  if (unknown.length) return { error: 'unknown', unknown, why: `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not in the queue` };
  const parts = [];
  let pool;
  const tagged = q.filter((e) => e.tag).length;
  if (ids.length) { pool = q.filter((e) => ids.includes(e.task)); parts.push(`only ${ids.join(',')}`); }
  else pool = q;
  if (tag) { pool = pool.filter((e) => e.tag === tag); parts.push(`tag ${tag}`); }
  else if (!ids.length) { pool = pool.filter((e) => !e.tag); if (tagged) parts.push(`untagged lanes only (${tagged} tagged wait for train --tag)`); }
  // 2.85 (f): a vision fix (harness/vision-fix.mjs; isVision, else read from the event log) goes to the front before
  // the alone lane, the grouping and the cap, so the batch forms around it: its class is the batch's class.
  if (!ids.length) {
    let vis = isVision;
    if (typeof vis !== 'function') { let vf = new Set(); try { vf = visionFixIds(readRecentEvents(20000)); } catch { /* none */ } vis = (l) => vf.has(l.task); }
    const front = pool.filter((l) => { try { return vis(l); } catch { return false; } });
    if (front.length) { pool = visionFirst(pool, (l) => front.includes(l)); parts.push(`vision fix first: ${front.map((l) => l.task).join(',')}`); }
  }
  // 2.86 (waits): lanes a train left waiting for the target (red on it alone) sit out until it moves; --only still takes them.
  if (!ids.length && waits && waits.size) { const n = pool.filter((l) => waits.has(l.task)).length; if (n) { pool = pool.filter((l) => !waits.has(l.task)); parts.push(`${n} wait for the target (red on it alone)`); } }
  // 2.86 (aloneOf): a lane that changes an engines.<x>.batchAlone path lands alone too; the batch line says which path.
  const soloWhy = new Map();
  const solo = (l) => { if (l.alone) return true; if (typeof aloneOf !== 'function') return false; if (!soloWhy.has(l.task)) { let w = null; try { w = aloneOf(l) || null; } catch { w = null; } soloWhy.set(l.task, w); } return Boolean(soloWhy.get(l.task)); };
  const why1 = (l) => (soloWhy.get(l.task) && !l.alone ? ` (it changes ${soloWhy.get(l.task)}, which engines.<x>.batchAlone lands alone)` : '');
  let alone = null;
  const soloAt = pool.findIndex(solo);
  if (soloAt === 0) { alone = pool[0].task; pool = [pool[0]]; parts.push(`${alone} lands alone${why1(pool[0])}`); }
  else if (soloAt > 0) { parts.push(`stops before ${pool[soloAt].task}, which lands alone${why1(pool[soloAt])}`); pool = pool.slice(0, soloAt); }
  const classes = new Map();
  const cls = (l) => { if (!classes.has(l.task)) { let c = 'full'; try { c = String(classOf(l) || 'full'); } catch { c = 'full'; } classes.set(l.task, c); } return classes.get(l.task); };
  let head = null;
  if (group === 'play' && pool.length && !alone) { head = cls(pool[0]); pool = pool.filter((l) => cls(l) === head); parts.push(`class ${head}`); }
  const caps = [Number(max) || 0, Number(batchMax) || 0].filter((n) => n > 0);
  const cap = caps.length ? Math.min(...caps) : 0;
  if (cap && pool.length > cap) pool = pool.slice(0, cap);
  if (cap) parts.push(`cap ${cap}`);
  const taken = new Set(pool.map((l) => l.task));
  const left = q.filter((e) => !taken.has(e.task));
  let byClass = '';
  if (group === 'play' && left.length) {
    const n = {};
    for (const l of left) n[cls(l)] = (n[cls(l)] || 0) + 1;
    byClass = ` (${Object.entries(n).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${v} ${k}`).join(', ')})`;
  }
  const why = `${pool.length} of ${q.length} queued${parts.length ? `: ${parts.join(', ')}` : ''}; ${left.length} wait${byClass}`;
  return { lanes: pool, why, total: q.length, waiting: left.length, cls: head, alone, tagged, classes: Object.fromEntries(classes) };
}

/** Tags in a queue: { <tag>: n } (untagged lanes left out). */
export function tagCounts(queue = []) {
  const n = {};
  for (const e of queue) if (e?.tag) n[e.tag] = (n[e.tag] || 0) + 1;
  return n;
}

// ---- who may ----------------------------------------------------------------------------------------------------

/**
 * 2.84 (u): may this caller cancel an engine train or switch its automatic start? The board-decision verdict
 * (permission.mjs mayDecide('board', actorOf)): the owner's terminal, outside agents and Producer/Director sessions yes;
 * a launched worker session (or a worker-shaped --by) no. { ok, why }.
 */
export async function mayControl({ by = '', env = process.env, root = process.cwd(), what = 'control an engine train' } = {}) {
  const pm = await import('./permission.mjs');
  if (by && !pm.permittedSetter(by)) return { ok: false, why: `${String(by).slice(0, 40)} is a worker's name: a worker session doesn't ${what}. Hand the task back (npm run task -- pause <ID> --note "…") and ask the Producer or the owner` };
  const d = pm.mayDecide('board', pm.actorOf({ env, root }), { root });
  return d.ok ? { ok: true, why: '' } : { ok: false, why: `Refused: ${d.why}` };
}

/**
 * 2.84 (q): when the caller is one of the owner's stand-ins in beta mode (a beta-mode agent or an outside signer), the
 * decision is also written as a beta.use event, so the owner's digest lists it. Anyone else: nothing extra. Never throws.
 */
async function noteStandIn({ by, env, root, msg, why }) {
  try {
    const bm = await import('./beta-mode.mjs');
    const si = bm.standInMay('engine-train', { by, env, root });
    if (si.ok) bm.recordStandInUse(si, { kind: 'engine-train', msg, why });
  } catch { /* the command's own event is the record */ }
}

// ---- automatic start on/off --------------------------------------------------------------------------------------

export const autoFile = (root, engine) => path.join(root, '.studio', 'train', `${engine}-auto.json`);
const offWord = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());

/**
 * 2.84 (u): the automatic start of engine <x>'s train: { on, source: 'env' | 'file' | 'config' | null, by?, at?, why?,
 * until?, expired? }. STUDIO_ENGINE_TRAIN_AUTO=off wins; then `train auto off --engine x` (until its --hours run out);
 * then engines.<x>.trainAuto false.
 */
export function engineAutoState(root, engine, { env = process.env, now = Date.now() } = {}) {
  if (offWord(env.STUDIO_ENGINE_TRAIN_AUTO)) return { on: false, source: 'env', why: 'STUDIO_ENGINE_TRAIN_AUTO=off' };
  const r = readJson(autoFile(root, engine));
  if (r && r.off) {
    const until = Date.parse(r.until || '');
    if (Number.isFinite(until) && until <= now) return { on: true, source: null, expired: r };
    return { on: false, source: 'file', by: r.by || '?', at: r.at || null, why: r.why || '', until: r.until || null };
  }
  try { if (engineTarget(engine, { root })?.trainAuto === false) return { on: false, source: 'config', why: `engines.${engine}.trainAuto is false` }; } catch {}
  return { on: true, source: null };
}

/** One line for `train status --engine`. */
export function autoLine(root, engine, opts = {}) {
  const a = engineAutoState(root, engine, opts);
  const L = labelOf(engine);
  if (a.on) return `${L} train automatic start: on${a.expired ? ` (the off by ${a.expired.by || '?'} ran out at ${String(a.expired.until).slice(0, 16)})` : ''}`;
  if (a.source === 'file') return `${L} train automatic start: OFF (by ${a.by}${a.at ? ` at ${String(a.at).slice(0, 16)}` : ''}${a.why ? `: ${a.why}` : ''}${a.until ? `; back on by itself at ${String(a.until).slice(0, 16)} UTC` : ''}); a person's npm run task -- train --engine ${engine} still starts one; train auto on --engine ${engine} --by <name> turns it back on`;
  return `${L} train automatic start: off (${a.why})`;
}

/** The Line Producer's why while auto is off by `train auto off --engine x`. */
export function autoOffWhy(a, engine) {
  return `the ${labelOf(engine)} train's automatic start is off (train auto off by ${a.by || '?'}${a.why ? `: ${a.why}` : ''}${a.until ? `; until ${String(a.until).slice(0, 16)} UTC` : ''}): npm run task -- train auto on --engine ${engine} --by <name> turns it on; a person's train --engine ${engine} still starts one`;
}

/**
 * 2.84 (u): `train auto off|on --engine <x> --by <name> [--why "…"] [--hours N]`. { ok, message }. Off writes
 * .studio/train/<x>-auto.json (with `until` when --hours is given); on removes it. One task.train.<x>.auto_off|auto_on event.
 */
export async function setEngineAuto(root, { engine, on, by = '', why = '', hours = null, env = process.env, emit = emitEvent, now = Date.now() } = {}) {
  const L = labelOf(engine);
  const who = String(by || '').trim().slice(0, 60);
  if (!who) return { ok: false, message: `Say who switches it: npm run task -- train auto ${on ? 'on' : 'off'} --engine ${engine} --by <name>.` };
  const may = await mayControl({ by: who, env, root, what: `switch the ${L} train's automatic start` });
  if (!may.ok) return { ok: false, message: `The ${L} train's automatic start was not changed. ${may.why}` };
  const reason = String(why || '').trim().slice(0, 300);
  let until = null;
  if (!on && hours !== null && hours !== undefined && hours !== true) {
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0 || h > 24 * 14) return { ok: false, message: `--hours takes a number of hours above 0 and at most ${24 * 14}; nothing was changed.` };
    until = new Date(now + h * 3600000).toISOString();
  }
  const at = new Date(now).toISOString();
  const f = autoFile(root, engine);
  if (on) { try { fs.rmSync(f, { force: true }); } catch {} }
  else writeJson(f, { off: true, engine, by: who, why: reason, at, ...(until ? { until } : {}) });
  try { emit({ type: `task.train.${engine}.auto_${on ? 'on' : 'off'}`, agent: who, to: 'producer', track: `engine:${engine}`, status: on ? 'ok' : 'warn', msg: `${who} turned the ${L} train's automatic start ${on ? 'on' : 'off'}${until ? ` until ${until.slice(0, 16)} UTC` : ''}${reason ? `: ${reason}` : ''}`.slice(0, 600), meta: { engine, on, by: who, why: reason || null, until } }); } catch {}
  await noteStandIn({ by: who, env, root, msg: `${who} turned the ${L} train's automatic start ${on ? 'on' : 'off'} in beta mode`, why: reason });
  const envOff = offWord(env.STUDIO_ENGINE_TRAIN_AUTO);
  return { ok: true, message: on
    ? `The ${L} train's automatic start is on: the Line Producer starts it when branches wait${envOff ? ' (but STUDIO_ENGINE_TRAIN_AUTO is off in this environment, which wins)' : ''}.`
    : `The ${L} train's automatic start is off${until ? ` until ${until.slice(0, 16)} UTC (then on by itself)` : ''}: the Line Producer starts no ${L} train; a person's npm run task -- train --engine ${engine} still does. npm run task -- train auto on --engine ${engine} --by <name> turns it back on.` };
}

// ---- cancel -----------------------------------------------------------------------------------------------------

export const cancelFile = (root, engine) => path.join(root, '.studio', 'train', `${engine}-cancel.json`);
/**
 * Is the train's process still running? A killed process its parent has not reaped yet (a zombie, Linux /proc state Z)
 * runs nothing any more: it counts as gone.
 */
export function trainProcessLive(pid, identity) {
  if (!pidAlive(pid, identity)) return false;
  try { const st = fs.readFileSync(`/proc/${Number(pid)}/stat`, 'utf8'); const state = st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3); if (state === 'Z' || state === 'X') return false; } catch { /* no /proc: pidAlive answers */ }
  return true;
}
/** How long cancel waits for the killed train to go (30 s). */
export const CANCEL_WAIT_MS = 30000;

/** Is `dir` a linked worktree (never a main checkout) of the repo whose common git dir is `common`? */
function linkedWorktreeOf(dir, common) {
  if (!dir || !fs.existsSync(dir)) return false;
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const fold = (p) => (process.platform === 'win32' ? real(p).toLowerCase() : real(p));
  const top = out(git(dir, 'rev-parse', '--show-toplevel'));
  const gd = out(git(dir, 'rev-parse', '--git-dir'));
  const cd = out(git(dir, 'rev-parse', '--git-common-dir'));
  if (!top || !gd || !cd) return false;
  if (fold(top) !== fold(dir)) return false;
  const g = fold(path.resolve(dir, gd));
  const c = fold(path.resolve(dir, cd));
  return g !== c && (!common || c === common);
}

/**
 * Put the gate worktree back at the target: merge --abort when a merge is in progress, reset --hard to the target,
 * clean -fd (untracked files; ignored ones such as an editor's cache stay). Only a linked worktree of the engine repo,
 * never its main checkout and never a lane. { done, steps, why? }.
 */
export function resetGate({ gate, repo, target, root }) {
  const steps = [];
  if (!gate) return { done: false, steps, why: 'no gateWorktree is configured: the land script\'s own folder was left as it is' };
  const lanes = path.resolve(root, '.lanes');
  const rel = path.relative(lanes, gate);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return { done: false, steps, why: `${fwd(gate)} is under .lanes/: never reset` };
  const common = (() => { const c = out(git(repo, 'rev-parse', '--git-common-dir')); if (!c) return ''; const p = path.resolve(repo, c); try { const r = fs.realpathSync.native(p); return process.platform === 'win32' ? r.toLowerCase() : r; } catch { return p; } })();
  if (!linkedWorktreeOf(gate, common)) return { done: false, steps, why: `${fwd(gate)} is not a linked worktree of the engine repo (a main checkout is never reset)` };
  const gd = path.resolve(gate, out(git(gate, 'rev-parse', '--git-dir')));
  // A git command killed with the train leaves its index lock: the gate's own, nobody else's.
  if (fs.existsSync(path.join(gd, 'index.lock'))) { try { fs.rmSync(path.join(gd, 'index.lock'), { force: true }); steps.push('removed the index lock the killed run left'); } catch {} }
  if (git(gate, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0) { const a = git(gate, 'merge', '--abort'); steps.push(a.status === 0 ? 'git merge --abort' : `git merge --abort failed (${String(a.stderr || '').trim().split('\n').pop()})`); }
  const r = git(gate, 'reset', '-q', '--hard', `refs/heads/${target}`);
  if (r.status !== 0) return { done: false, steps, why: `git reset --hard ${target} failed: ${String(r.stderr || '').trim().split('\n').pop()}` };
  steps.push(`git reset --hard ${target}`);
  const c = git(gate, 'clean', '-fdq');
  steps.push(c.status === 0 ? 'git clean -fd' : `git clean -fd failed (${String(c.stderr || '').trim().split('\n').pop()})`);
  return { done: true, steps };
}

/**
 * 2.84 (u): cancel the running train of engine <x>. opts: { engine, by, why, env, waitMs, kill(holder) -> { killed,
 * survivors }, emit }. { ok, message, id?, gate?, refs? }. The queue is left as it was: every lane still queued, nobody
 * handed back, nobody blamed.
 */
export async function cancelEngineTrain(root, { engine = 'unity', by = '', why = '', env = process.env, waitMs = CANCEL_WAIT_MS, kill = null, emit = emitEvent } = {}) {
  const L = labelOf(engine);
  const who = String(by || '').trim().slice(0, 60);
  if (!who) return { ok: false, message: `Say who cancels it: npm run task -- train cancel --engine ${engine} --by <name> [--why "…"].` };
  const may = await mayControl({ by: who, env, root, what: `cancel the ${L} train` });
  if (!may.ok) return { ok: false, message: `The ${L} train was not cancelled. ${may.why}` };
  const ut = await import('./unity-train.mjs');
  const lockF = path.join(root, '.studio', 'locks', engineFiles(engine).lock);
  const h = ut.runningUnityTrain(root, engine);
  if (!h) return { ok: false, message: `No ${L} train is running (npm run task -- train status --engine ${engine}); nothing was changed.` };
  const reason = String(why || '').trim().slice(0, 300);
  const at = new Date().toISOString();
  // 1. The cancel file first: the train's land loop reads it and neither retries nor blames.
  writeJson(cancelFile(root, engine), { train: h.id, by: who, at, why: reason });
  await noteStandIn({ by: who, env, root, msg: `${who} cancelled the ${L} train ${h.id} in beta mode`, why: reason });
  // 2. The train's process tree (the land run below it included); Windows: taskkill /T /F (harness/heavy.mjs).
  // 2.84: the lock's start identity goes with it, so a train pid another program has taken over is not killed (heavy.mjs
  // holderTree: a root whose start differs is not a member, nor are its children). What the kill saw is kept for the
  // message: on Windows the process list is one PowerShell call, and when it fails nothing can be confirmed or killed.
  const killer = kill || (async (holder) => { const hv = await import('./heavy.mjs'); const r = hv.killHolderTree(holder, { self: process.pid }); return { killed: r.killed || [], survivors: r.survivors || [], members: r.members || [], rootLive: r.rootLive }; });
  let k = { killed: [], survivors: [] };
  try { k = await killer({ pid: h.pid, identity: h.identity, tree: { root: h.pid, groups: [] } }) || k; } catch (e) { k = { killed: [], survivors: [], error: String(e?.message || e).slice(0, 200) }; }
  for (const until = Date.now() + waitMs; trainProcessLive(h.pid, h.identity) && Date.now() < until;) sleep(200);
  if (trainProcessLive(h.pid, h.identity)) {
    const saw = k.error ? `the process list could not be read: ${k.error}` : k.rootLive === false ? 'its process start did not match the lock\'s record, so it was not killed' : `${(k.killed || []).length} of ${(k.members || []).length} process(es) of its tree ended, ${(k.survivors || []).length} still running`;
    const m = `The ${L} train ${h.id} (pid ${h.pid}) did not end within ${Math.round(waitMs / 1000)} s of being killed (${saw}); its gate worktree, refs and lock were left as they are (the cancel file is written: it neither retries nor blames). Try again, or stop pid ${h.pid} by hand.`;
    try { emit({ type: `task.train.${engine}.cancel_failed`, agent: who, to: 'producer', track: `engine:${engine}`, status: 'blocked', msg: m.slice(0, 600), meta: { train: h.id, engine, pid: h.pid } }); } catch {}
    return { ok: false, id: h.id, message: m };
  }
  // 3. The gate worktree back at the target, and the train's own integration refs.
  const s = ut.unityTrainSettings(root, engine);
  let gate = { done: false, steps: [], why: s.error ? s.message : '' };
  const refs = [];
  let moved = '';
  if (!s.error) {
    gate = resetGate({ gate: s.cfg.gateWorktree ? path.resolve(root, s.cfg.gateWorktree) : null, repo: s.repo, target: s.target, root });
    const prefix = `refs/heads/${engineFiles(engine).refPrefix}${h.id}`;
    for (const r of out(git(s.repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${engineFiles(engine).refPrefix}`)).split('\n').filter(Boolean)) {
      if (r === prefix || r.startsWith(`${prefix}-`) || r.startsWith(`${prefix}/`)) { if (git(s.repo, 'update-ref', '-d', r).status === 0) refs.push(r.replace(/^refs\/heads\//, '')); }
    }
    const now = out(git(s.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${s.target}`));
    if (h.targetAt && now && now !== h.targetAt) moved = ` Note: ${s.target} moved while the train ran (${h.targetAt.slice(0, 8)} -> ${now.slice(0, 8)}); a killed land may have moved it: check it before the next train.`;
  }
  // 4. The lock (still this train's), and the "landing" markers of its lanes.
  try { if (readJson(lockF)?.id === h.id) fs.rmSync(lockF, { force: true }); } catch {}
  try { const b = await import('./busy.mjs'); for (const t of h.lanes || []) { try { await b.clearDoneRunning(t); } catch {} } } catch {}
  const lanes = (h.lanes || []).filter(Boolean);
  const msg = `${L} train ${h.id} cancelled by ${who}${reason ? `: ${reason}` : ''}; its process tree was ended${k.killed?.length ? ` (${k.killed.length} process(es))` : ''}; ${gate.done ? `the gate worktree is back at ${s.target} (${gate.steps.join(', ')})` : `the gate worktree was not touched (${gate.why})`}${refs.length ? `; integration ref(s) ${refs.join(', ')} deleted` : ''}; the queue is as it was: nobody handed back, nobody blamed${lanes.length ? `, ${lanes.join(', ')} keep their place` : ''}.`;
  try { emit({ type: `task.train.${engine}.cancelled`, agent: who, to: 'producer', track: `engine:${engine}`, status: 'warn', msg: msg.slice(0, 600), meta: { train: h.id, engine, by: who, why: reason || null, lanes, killed: k.killed || [], gate: gate.done ? gate.steps : null, refs } }); } catch {}
  const hint = engineAutoState(root, engine, { env }).on ? `\nThe automatic start may begin the next ${L} train at its next pass: npm run task -- train auto off --engine ${engine} --by <name> [--hours N] keeps it from starting.` : '';
  return { ok: true, id: h.id, gate, refs, message: `${msg}${moved}${hint}` };
}
