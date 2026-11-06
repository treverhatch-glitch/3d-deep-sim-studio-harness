#!/usr/bin/env node
/**
 * harness/janitor.mjs — 2.68.0: the temp-file janitor. Deletes ONLY the harness's own temporary files.
 *
 *   npm run janitor                       dry run (the default): what it would delete, and how much
 *   npm run janitor -- --yes              delete them
 *   npm run janitor -- --lanes            also list stale lane copies, as proposals (never deleted without a decider)
 *   npm run janitor -- --lanes --yes --by <name> [--permission "…"]   delete those stale lane copies too
 *   npm run janitor -- --json
 *
 * What it may delete (each re-checked just before it is deleted):
 *   - train scratch copies (.lanes/_train-<id>) left by a train that is no longer running (no live train lock), when
 *     the copy has no uncommitted change and no commit of its own that isn't on another branch;
 *   - .studio/tmp entries older than STUDIO_JANITOR_TMP_H (24) hours;
 *   - old train logs (.studio/train/*.log) beyond the newest STUDIO_JANITOR_KEEP_LOGS (40) or STUDIO_JANITOR_LOGS_MB
 *     (200) in all; a running train's logs are kept;
 *   - temp folders the harness made for tests, by their marker file (.studio-temp.json naming THIS studio; markTemp()),
 *     older than STUDIO_JANITOR_TMP_H and whose process is gone; in the system temp folder (STUDIO_JANITOR_TMPDIR);
 *   - cache entries (.studio/unity-cache, .studio/assets/library), oldest first, while the caches are over
 *     STUDIO_CACHE_MAX_GB (20); an entry a Unity run holds (a lock under an hour old) is kept.
 *   - 2.79 (d): idle lane copies, in the automatic run and by `npm run lanes -- prune --idle <hours> [--dry-run]`: the
 *     session ended, the task isn't queued, held or parked, nobody works in the copy (no process, claim or recent change),
 *     no uncommitted change, no commit that isn't on main, and untouched for STUDIO_LANE_IDLE_HOURS (12; 0 or off: never).
 *     Only the worktree goes; the branch is kept.
 * What it never deletes: a lane copy with commits not on main, uncommitted changes, a running session or a held or
 * parked task; anything outside the studio except a temp folder carrying this studio's marker. Lanes that are merely
 * stale (older than STUDIO_JANITOR_LANE_H, 24 h, or STUDIO_JANITOR_LANDED_H, 6 h, once their work has landed (2.70.0);
 * nothing unique; clean; nobody in them) are listed with --lanes and deleted only with --yes --by <name>: a person, an
 * agent under the owner's delegation for janitor-lanes (2.70.0; before: hold), or a Producer/Director
 * session or outside agent on a person's direct permission (harness/decider.mjs; the people `task hold` allows, made
 * exact). One janitor.run event per run that deletes (or finds) something.
 *
 * It also runs by itself after each train and verify job (harness/jobs.mjs janitorAfterJob: --yes --auto, never lanes)
 * at most every STUDIO_JANITOR_EVERY_MIN (30) minutes; STUDIO_JANITOR=off turns that off. janitorEstimate() gives the
 * disk monitor its line: "the janitor can free N GB". Nothing imports this file at load (its CLI awaits modules that
 * import jobs.mjs: a static import of it from there would be a cycle).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent, getEventPaths } from './event.mjs';

const H = 3600000;
const num = (v, d) => (v === undefined || v === null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const git = (cwd, ...args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
export const MARKER = '.studio-temp.json';
const gb = (b) => Math.round((b / 1024 ** 3) * 100) / 100;
export const human = (b) => (b >= 1024 ** 3 ? `${gb(b)} GB` : b >= 1024 ** 2 ? `${Math.round(b / 1024 ** 2)} MB` : `${Math.round(b / 1024)} KB`);

/** The main checkout (a lane copy at <main>/.lanes/<x> names it), without importing worktree.mjs. */
export function studioRoot(env = process.env) {
  if (env.STUDIO_MAIN_ROOT) return path.resolve(env.STUDIO_MAIN_ROOT);
  const m = REPO_ROOT.replace(/\\/g, '/').match(/^(.*)\/\.lanes\/[^/]+$/);
  return m ? path.resolve(m[1]) : REPO_ROOT;
}
export function janitorLimits(env = process.env) {
  return {
    tmpMs: Math.max(0, num(env.STUDIO_JANITOR_TMP_H, 24)) * H,
    laneMs: Math.max(0, num(env.STUDIO_JANITOR_LANE_H, 24)) * H,
    // 2.70.0 (w): a lane copy whose work has landed (its task is done, or its branch was merged) is stale sooner.
    landedMs: Math.max(0, num(env.STUDIO_JANITOR_LANDED_H, 6)) * H,
    keepLogs: Math.max(0, Math.round(num(env.STUDIO_JANITOR_KEEP_LOGS, 40))),
    logsBytes: Math.max(0, num(env.STUDIO_JANITOR_LOGS_MB, 200)) * 1024 ** 2,
    cacheBytes: Math.max(0, num(env.STUDIO_CACHE_MAX_GB, 20)) * 1024 ** 3,
    tmpDir: env.STUDIO_JANITOR_TMPDIR ? path.resolve(env.STUDIO_JANITOR_TMPDIR) : os.tmpdir(),
  };
}

/** Bytes under p, not following links (a link counts as itself). Stops counting past maxEntries. */
export function sizeOf(p, maxEntries = 200000) {
  let n = 0; let seen = 0;
  const walk = (q) => {
    if (seen++ > maxEntries) return;
    let st; try { st = fs.lstatSync(q); } catch { return; }
    if (st.isSymbolicLink() || !st.isDirectory()) { n += st.size || 0; return; }
    let names = []; try { names = fs.readdirSync(q); } catch { return; }
    for (const x of names) walk(path.join(q, x));
  };
  walk(p);
  return n;
}
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
/** Same folder? Real paths (a temp folder reached through a link, as on macOS), else resolved paths. */
const samePath = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(String(a)) === path.resolve(String(b)); } };
const pidAlive = (pid) => { if (!Number(pid)) return false; try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Mark a temp folder the harness made (for tests), so the janitor may remove it once it is old and its process gone. */
export function markTemp(dir, { root = studioRoot(), by = 'harness' } = {}) {
  try { fs.writeFileSync(path.join(dir, MARKER), `${JSON.stringify({ studio: path.resolve(root), pid: process.pid, by, at: new Date().toISOString() })}\n`); return true; } catch { return false; }
}

/** The train lock, if a train is running: { id, pid } or null. */
function liveTrain(root) {
  const h = readJson(path.join(root, '.studio', 'locks', 'train.lock'));
  if (!h) return null;
  const stale = Number(process.env.STUDIO_TRAIN_STALE_MIN || 360) * 60000;
  return pidAlive(h.pid) && Date.now() - Number(h.at || 0) < stale ? h : null;
}

/** A train scratch copy's own work: { dirty, unique } (commits not on any other branch; merge commits don't count). */
export function scratchWork(root, dir, branch) {
  const dirty = Boolean((git(dir, 'status', '--porcelain').stdout || '').trim());
  let unique = 0;
  if (branch) {
    const others = (git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads').stdout || '').split('\n').map((s) => s.trim()).filter((r) => r && r !== `refs/heads/${branch}`);
    const r = git(root, 'rev-list', '--count', '--no-merges', branch, '--not', ...others);
    unique = r.status === 0 ? Number(r.stdout.trim()) || 0 : 1; // unreadable: assume work
  }
  return { dirty, unique };
}

/**
 * What the janitor would delete now (lanes apart): { items: [{ kind, path, bytes, why, branch? }], kept: [{ path, why }],
 * bytes }. Sync, git and the file system only.
 */
export function janitorPlan({ root = studioRoot(), env = process.env, now = Date.now() } = {}) {
  const lim = janitorLimits(env);
  const items = []; const kept = [];
  const rel = (p) => path.relative(root, p).split(path.sep).join('/') || '.';
  // Train scratch copies.
  const lanesDir = path.join(root, '.lanes');
  const train = liveTrain(root);
  let names = []; try { names = fs.readdirSync(lanesDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('_train-')).map((e) => e.name); } catch {}
  for (const name of names) {
    const dir = path.join(lanesDir, name);
    if (train) { kept.push({ path: rel(dir), why: `a train is running (${train.id || '?'}, pid ${train.pid})` }); continue; }
    const branch = (git(dir, 'symbolic-ref', '--short', 'HEAD').stdout || '').trim() || null;
    const w = scratchWork(root, dir, branch);
    if (w.dirty) { kept.push({ path: rel(dir), why: 'it has uncommitted changes' }); continue; }
    if (w.unique) { kept.push({ path: rel(dir), why: `${w.unique} commit(s) of its own aren't on any other branch` }); continue; }
    items.push({ kind: 'train-scratch', path: rel(dir), name, branch, bytes: sizeOf(dir), why: 'a train scratch copy left by a train that is no longer running; nothing of its own' });
  }
  // .studio/tmp
  const tmp = path.join(root, '.studio', 'tmp');
  let tnames = []; try { tnames = fs.readdirSync(tmp); } catch {}
  for (const n of tnames) {
    const p = path.join(tmp, n);
    const age = now - mtime(p);
    if (age >= lim.tmpMs) items.push({ kind: 'studio-tmp', path: rel(p), bytes: sizeOf(p), why: `in .studio/tmp, ${Math.round(age / H)} h old` });
  }
  // Train logs beyond the count or size budget (newest kept).
  const tdir = path.join(root, '.studio', 'train');
  let logs = []; try { logs = fs.readdirSync(tdir).filter((n) => n.endsWith('.log')).map((n) => ({ n, p: path.join(tdir, n), t: mtime(path.join(tdir, n)), b: sizeOf(path.join(tdir, n)) })).sort((a, b) => b.t - a.t); } catch {}
  let sum = 0;
  logs.forEach((l, i) => {
    sum += l.b;
    if (train?.id && l.n.startsWith(`${train.id}-`)) return;
    if (i >= lim.keepLogs || sum > lim.logsBytes) items.push({ kind: 'train-log', path: rel(l.p), bytes: l.b, why: i >= lim.keepLogs ? `beyond the newest ${lim.keepLogs} train logs` : `train logs over ${Math.round(lim.logsBytes / 1024 ** 2)} MB` });
  });
  // Temp folders the harness marked for this studio.
  let tdirs = []; try { tdirs = fs.readdirSync(lim.tmpDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(lim.tmpDir, e.name)); } catch {}
  for (const d of tdirs) {
    const m = readJson(path.join(d, MARKER));
    if (!m || !m.studio || !samePath(String(m.studio), root)) continue;
    const age = now - (Date.parse(m.at) || mtime(d));
    if (age < lim.tmpMs) continue;
    if (pidAlive(m.pid) && m.pid !== process.pid) { kept.push({ path: d, why: `its process ${m.pid} is still running` }); continue; }
    items.push({ kind: 'test-temp', path: d, abs: true, bytes: sizeOf(d), why: `a temp folder the harness made (${m.by || 'harness'}), ${Math.round(age / H)} h old` });
  }
  // Caches over the budget, oldest first.
  const entries = [];
  const ucache = path.join(root, '.studio', 'unity-cache');
  try {
    for (const e of fs.readdirSync(ucache, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(ucache, e.name);
      const lock = path.join(ucache, `${e.name}.lock`);
      entries.push({ p, t: mtime(p), b: sizeOf(p), locked: fs.existsSync(lock) && now - mtime(lock) < H });
    }
  } catch {}
  const lib = path.join(root, '.studio', 'assets', 'library');
  try { for (const n of fs.readdirSync(lib)) { const p = path.join(lib, n); entries.push({ p, t: mtime(p), b: sizeOf(p), locked: false }); } } catch {}
  let total = entries.reduce((s, e) => s + e.b, 0);
  for (const e of entries.sort((a, b) => a.t - b.t)) {
    if (total <= lim.cacheBytes) break;
    if (e.locked) { kept.push({ path: rel(e.p), why: 'a Unity run holds it' }); continue; }
    items.push({ kind: 'cache', path: rel(e.p), bytes: e.b, why: `caches are over STUDIO_CACHE_MAX_GB (${gb(lim.cacheBytes)} GB); oldest first` });
    total -= e.b;
  }
  return { root, items, kept, bytes: items.reduce((s, i) => s + i.bytes, 0) };
}

/**
 * Lane copies (not train scratch): each with why it is kept, or a stale proposal. Async: reads the launcher's sessions,
 * the holds and the lane helpers. [{ agent, dir, path, task, bytes, stale, why }].
 */
export async function laneProposals({ root = studioRoot(), env = process.env, now = Date.now(), idleMs = null } = {}) {
  const lim = janitorLimits(env);
  const { laneCopies, laneLive } = await import('./worktree.mjs');
  let running = new Set();
  try { running = new Set((await import('./agent.mjs')).sessions().filter((s) => s.running).map((s) => s.agent)); } catch {}
  let holds = {}; try { holds = (await import('./task-hold.mjs')).readHolds(); } catch {}
  const landed = landedLanes(root);
  // 2.79 (d): a copy whose task waits for a train is kept (the train makes the lane from its branch, but never from a copy
  // someone removed under it), read through the queue's own reader.
  let queue = []; try { queue = (await import('./train.mjs')).readQueue(root); } catch {}
  let locks = []; try { locks = (await import('./lock.mjs')).listLocks(); } catch {}
  const out = [];
  for (const c of laneCopies(root)) {
    const rec = readJson(path.join(root, '.studio', 'agents', `${c.agent}.json`)) || {};
    const task = rec.task || null;
    const relp = path.relative(root, c.dir).split(path.sep).join('/');
    const last = Math.max(mtime(c.dir), Number((git(c.dir, 'log', '-1', '--format=%ct').stdout || '').trim()) * 1000 || 0);
    let why = '';
    if (running.has(c.agent)) why = 'its session is running';
    else if (c.unmerged > 0) why = `${c.unmerged} commit(s) not on main`;
    else if (c.dirty) why = 'it has uncommitted changes';
    else if (task && holds[task]?.held) why = `its task ${task} is held`;
    else if (task && holds[task]?.parked) why = `its task ${task} is parked`;
    else if (queue.some((e) => e && ((task && e.task === task) || e.agent === c.agent || (c.branch && e.branch === c.branch)))) why = 'its task is queued for a train';
    else if (locks.some((l) => l.owner === c.agent && Date.parse(l.expiresAt) > now)) why = `${c.agent} still holds a claim`;
    else { const l = laneLive(c.agent, root); if (l.live) why = `someone is working in it (${l.why})`; }
    const done = !why && (landed.agents.has(c.agent) || (task && landed.tasks.has(task)));
    const limMs = idleMs !== null ? idleMs : done ? lim.landedMs : lim.laneMs;
    if (!why && now - last < limMs) why = `used ${Math.round((now - last) / H)} h ago (under ${idleMs !== null ? `the idle limit, ${Math.round(limMs / H)} h` : done ? `STUDIO_JANITOR_LANDED_H, ${Math.round(limMs / H)} h, its work has landed` : `STUDIO_JANITOR_LANE_H, ${Math.round(limMs / H)} h`})`;
    out.push({ agent: c.agent, dir: c.dir, path: relp, task, landed: Boolean(done), bytes: why ? 0 : sizeOf(c.dir), stale: !why, why: why || `stale: ${Math.round((now - last) / H)} h untouched${done ? ', its work has landed' : ''}, nothing unique, clean, nobody in it` });
  }
  return out;
}

/** STUDIO_LANE_IDLE_HOURS (default 12) in hours; null when it is 0 or off (the janitor then leaves idle copies alone). */
export function laneIdleHours(env = process.env) {
  const raw = String(env.STUDIO_LANE_IDLE_HOURS ?? '').trim();
  if (/^(off|no|false)$/i.test(raw)) return null;
  const n = num(raw, 12);
  return n > 0 ? n : null;
}

/**
 * 2.79 (d): remove the idle lane copies, now. A copy goes when its session has ended, its task isn't queued for a train
 * and isn't held or parked, nobody works in it (no process, no claim, no change in the last minutes), it has no
 * uncommitted change and no commit that isn't on the studio's branch, and nothing touched it for `hours`. Only the
 * worktree goes: the branch stays. dryRun lists them. Returns { hours, removed, kept, freed, dryRun }.
 */
export async function pruneIdleLanes({ hours = laneIdleHours(), dryRun = false, root = studioRoot(), env = process.env, now = Date.now(), emit = emitEvent, by = 'janitor' } = {}) {
  if (!(hours > 0)) return { hours: null, removed: [], kept: [], freed: 0, dryRun, off: true };
  const props = await laneProposals({ root, env, now, idleMs: hours * H });
  const removed = []; const kept = props.filter((l) => !l.stale).map((l) => ({ agent: l.agent, path: l.path, why: l.why }));
  const { removeLaneCopy } = await import('./worktree.mjs');
  for (const l of props.filter((x) => x.stale)) {
    if (dryRun) { removed.push({ agent: l.agent, path: l.path, bytes: l.bytes, why: l.why }); continue; }
    // Re-check this one copy right before it goes.
    const again = (await laneProposals({ root, env, now: Date.now(), idleMs: hours * H })).find((x) => x.agent === l.agent);
    if (!again?.stale) { kept.push({ agent: l.agent, path: l.path, why: again?.why || 'gone' }); continue; }
    removeLaneCopy(l.agent, { keepBranch: true });
    if (fs.existsSync(l.dir)) kept.push({ agent: l.agent, path: l.path, why: 'could not remove it' });
    else removed.push({ agent: l.agent, path: l.path, bytes: l.bytes, why: l.why });
  }
  const freed = removed.reduce((n, x) => n + (x.bytes || 0), 0);
  if (removed.length) emit({ type: 'lanes.pruned', agent: String(by).slice(0, 60), msg: `${dryRun ? 'Would remove' : 'Removed'} ${removed.length} idle lane copy(ies) (idle over ${hours} h, nothing unsaved or unlanded; the branches are kept), ${human(freed)}`, meta: { dryRun, hours, agents: removed.map((x) => x.agent), freedBytes: freed } });
  return { hours, removed, kept, freed, dryRun };
}

/**
 * 2.70.0 (w): lanes whose work has landed: { tasks, agents } from studio/DONE.md (tasks marked done) and lane.merged
 * events (the agent that landed, the task).
 */
export function landedLanes(root) {
  const tasks = new Set(); const agents = new Set();
  try { for (const m of fs.readFileSync(path.join(root, 'studio', 'DONE.md'), 'utf8').matchAll(/^\s*[-*]\s+\[[xX]\]\s+\*\*([A-Z]+-\d+)\*\*/gm)) tasks.add(m[1]); } catch {}
  try {
    const text = fs.readFileSync(getEventPaths().primary, 'utf8');
    for (const l of text.slice(-4 * 1024 * 1024).split('\n')) {
      if (!l.includes('"lane.merged"')) continue;
      try { const e = JSON.parse(l); if (e.type === 'lane.merged') { if (e.task) tasks.add(e.task); if (e.agent) agents.add(e.agent); } } catch {}
    }
  } catch {}
  return { tasks, agents };
}

function removeItem(root, it) {
  const p = it.abs ? it.path : path.join(root, it.path);
  if (it.kind === 'test-temp') {
    // Inside the system temp folder only, a real folder (not a link), with this studio's marker.
    const m = readJson(path.join(p, MARKER));
    if (!m || !m.studio || !samePath(String(m.studio), root) || fs.lstatSync(p).isSymbolicLink()) return false;
  }
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  return !fs.existsSync(p);
}

/**
 * Run it. yes: delete (else a dry run); lanes: also lanes (proposals; deleted with yes + by). Returns
 * { dryRun, items, deleted, freed, lanes, lanesDeleted, kept, refused, text }.
 */
export async function runJanitor({ yes = false, lanes = false, by = '', permission = '', auto = false, env = process.env, now = Date.now(), root = studioRoot(env), emit = emitEvent } = {}) {
  const plan = janitorPlan({ root, env, now });
  const deleted = []; const failed = [];
  if (yes) {
    for (const it of plan.items) {
      try {
        if (it.kind === 'train-scratch') {
          // Re-check right before: a train may have started, or the copy gained work.
          const dir = path.join(root, it.path);
          if (liveTrain(root)) { failed.push({ ...it, why: 'a train started' }); continue; }
          const w = scratchWork(root, dir, it.branch);
          if (w.dirty || w.unique) { failed.push({ ...it, why: 'it has work now' }); continue; }
          (await import('./train.mjs')).removeScratch({ dir, branch: it.branch, name: it.name, root });
          if (fs.existsSync(dir)) { failed.push({ ...it, why: 'could not remove it' }); continue; }
        } else if (!removeItem(root, it)) { failed.push({ ...it, why: 'could not remove it' }); continue; }
        deleted.push(it);
      } catch (err) { failed.push({ ...it, why: err.message }); }
    }
  }
  let props = []; const lanesDeleted = []; let refused = null;
  if (lanes) {
    props = await laneProposals({ root, env, now });
    const stale = props.filter((l) => l.stale);
    if (yes && stale.length) {
      const { deciderCheck } = await import('./decider.mjs');
      // 2.70.0 (w): the owner's delegation for exactly this action (janitor-lanes), no longer the one for hold.
      const d = await deciderCheck({ by, permission, env, action: 'janitor-lanes', what: 'delete lane copies' });
      if (!d.ok) refused = d.why;
      else {
        const { removeLaneCopy } = await import('./worktree.mjs');
        for (const l of stale) {
          // Re-check this one lane right before deleting it.
          const again = (await laneProposals({ root, env, now: Date.now() })).find((x) => x.agent === l.agent);
          if (!again?.stale) { failed.push({ kind: 'lane', path: l.path, why: again?.why || 'gone' }); continue; }
          removeLaneCopy(l.agent);
          if (fs.existsSync(l.dir)) failed.push({ kind: 'lane', path: l.path, why: 'could not remove it' });
          else {
            lanesDeleted.push({ ...l, decided: { by: d.by, via: d.via, recordedBy: d.recordedBy, permission: d.permission || null } });
            try { const dm = await import('./decisions-log.mjs'); dm.logDecision({ action: 'janitor-lanes', subject: l.path || l.agent, by: d.by, as: dm.asOf(d), why: l.why || 'a stale lane copy', evidence: `${l.agent}, ${Math.round((l.bytes || 0) / 1048576)} MB`, undo: null, root }); } catch {}
          }
        }
      }
    }
  }
  // 2.79 (d): the automatic run (after a train or verify job) also removes idle lane copies: pruneIdleLanes' rule is stricter
  // than a stale proposal's (nothing unsaved or unlanded, no queued task), and it keeps the branch.
  let pruned = null;
  if (auto && yes) { try { pruned = await pruneIdleLanes({ root, env, now, emit, by: 'janitor' }); } catch {} }
  // 2.70.0 (w): what the digest, status --brief and the War Room show (harness/lane-disk.mjs), kept current.
  if (lanes) {
    try { await (await import('./lane-disk.mjs')).recordProposals({ root, env, now, emit: null, props: props.filter((l) => !lanesDeleted.some((x) => x.agent === l.agent)) }); } catch {}
  }
  const freed = deleted.reduce((s, i) => s + i.bytes, 0) + lanesDeleted.reduce((s, l) => s + l.bytes, 0);
  const staleLanes = props.filter((l) => l.stale);
  if (plan.items.length || staleLanes.length || deleted.length) {
    emit({ type: 'janitor.run', agent: auto ? 'janitor' : String(by || 'janitor').slice(0, 60), status: failed.length || refused ? 'warn' : 'ok', msg: `${yes ? `Janitor freed ${human(freed)}: ${deleted.length} item(s)${lanesDeleted.length ? ` and ${lanesDeleted.length} stale lane copy(ies) (${by})` : ''}` : `Janitor dry run: ${plan.items.length} item(s), ${human(plan.bytes)} could be freed`}${staleLanes.length && !lanesDeleted.length ? `; ${staleLanes.length} stale lane copy(ies) proposed (npm run janitor -- --lanes)` : ''}${failed.length ? `; ${failed.length} kept on re-check` : ''}${refused ? `; lanes not deleted: ${refused}` : ''}`.slice(0, 600), meta: { dryRun: !yes, auto, items: plan.items.length, deleted: deleted.length, freedBytes: freed, possibleBytes: plan.bytes, byKind: Object.fromEntries([...new Set(plan.items.map((i) => i.kind))].map((k) => [k, plan.items.filter((i) => i.kind === k).length])), staleLanes: staleLanes.map((l) => l.agent), lanesDeleted: lanesDeleted.map((l) => l.agent), failed: failed.length } });
  }
  const L = [];
  L.push(yes ? `Deleted ${deleted.length} item(s)${lanesDeleted.length ? ` and ${lanesDeleted.length} stale lane copy(ies)` : ''}, freed ${human(freed)}.` : `Dry run: ${plan.items.length} item(s), ${human(plan.bytes)} could be freed${plan.items.length ? ' (npm run janitor -- --yes deletes them)' : ''}.`);
  for (const it of yes ? deleted : plan.items) L.push(`  ${yes ? 'deleted' : 'would delete'} ${it.path} (${human(it.bytes)}): ${it.why}`);
  for (const f of failed) L.push(`  kept ${f.path}: ${f.why}`);
  for (const k of plan.kept) L.push(`  kept ${k.path}: ${k.why}`);
  if (lanes) {
    L.push(staleLanes.length ? `Stale lane copies (proposals; deleted only with --lanes --yes --by <name>): ${staleLanes.length}` : 'Stale lane copies: none.');
    for (const l of props) L.push(`  ${lanesDeleted.some((x) => x.agent === l.agent) ? 'deleted' : l.stale ? 'proposed' : 'kept'} ${l.path}${l.stale ? ` (${human(l.bytes)})` : ''}: ${l.why}`);
    if (refused) L.push(refused);
  }
  return { dryRun: !yes, pruned, items: plan.items, deleted, freed, lanes: props, lanesDeleted, kept: plan.kept, failed, refused, text: L.join('\n') };
}

/** For the disk monitor: { bytes, gb, line } (lanes not counted: they need a person). */
export function janitorEstimate({ root = studioRoot(), env = process.env } = {}) {
  let bytes = 0;
  try { bytes = janitorPlan({ root, env }).bytes; } catch {}
  return { bytes, gb: gb(bytes), line: bytes > 0 ? `the janitor can free ${gb(bytes) >= 0.1 ? `${gb(bytes)} GB` : human(bytes)} (npm run janitor -- --yes; npm run janitor -- --lanes lists stale lane copies)` : '' };
}

/**
 * For the disk-low warning (harness/machine.mjs): GB a `--yes` run would free now. A dry-run estimate only: it never
 * deletes anything, and lanes (which need a person) aren't counted. 0 when nothing can be freed or the scan fails.
 */
export function janitorFreeableGb({ root = studioRoot(), env = process.env } = {}) {
  return janitorEstimate({ root, env }).gb;
}
export const freeableGb = janitorFreeableGb;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const known = new Set(['--yes', '--lanes', '--json', '--auto', '--by', '--permission', '--root']);
  const bad = argv.filter((a, i) => a.startsWith('--') ? !known.has(a) : !['--by', '--permission', '--root'].includes(argv[i - 1]));
  if (bad.length) { console.error('Usage: npm run janitor [-- --yes] [--lanes] [--by <name> [--permission "…"]] [--json]   (a dry run without --yes)'); process.exit(2); }
  const r = await runJanitor({ yes: argv.includes('--yes'), lanes: argv.includes('--lanes'), by: flag('by') || '', permission: flag('permission') || '', auto: argv.includes('--auto'), root: flag('root') ? path.resolve(flag('root')) : studioRoot() });
  if (argv.includes('--json')) console.log(JSON.stringify({ ...r, text: undefined }, null, 2));
  else if (!argv.includes('--auto')) console.log(r.text);
  process.exit(r.refused ? 1 : 0);
}
