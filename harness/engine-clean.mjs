#!/usr/bin/env node
/**
 * harness/engine-clean.mjs — 2.83 (h): the disk an engine's work leaves behind.
 *
 * Why (a crew's PC, 2.83): engine work happens in git worktrees of a separate engine repo at <studio>/.lanes/engine/<task>
 * (about 3.2 GB each). After a lane's branch landed on the engine's target branch the worktree stayed for ever, and every
 * engine landing wrote a ~1.6 GB player build into a builds folder (gate-<stamp>/); 25 piled up (43 GB) and the disk fell
 * to 62 GB. `npm run lanes -- prune` did not look at .lanes/engine.
 *
 *   removeLandedLane   one lane folder, removed only when it is clean and its commit is already on the target
 *   pruneEngineLanes   every folder under .lanes/engine/ by the same rule (wired into `npm run lanes -- prune`)
 *   pruneBuilds        keep the newest N build folders of a builds folder, remove the rest, write LATEST.txt
 *   buildsConfig       studio/game.json engines.<x>.builds { dir, keep, pattern } (the owner's); STUDIO_ENGINE_KEEP_BUILDS
 *
 * Nothing here deletes by hand except old build folders (fs.rmSync after the safety rules); a lane goes only through
 * `git worktree remove` (never --force), so git itself refuses a folder with work in it.
 *
 *   node harness/engine-clean.mjs lanes [--engine x] [--dry-run]
 *   node harness/engine-clean.mjs builds [--engine x] [--dry-run]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent, readRecentEvents } from './event.mjs';
import { engineRepo, engineTarget, engineTargets, samePath } from './engine-tracks.mjs';
import { readJson } from './fsafe.mjs';
import { sparseState } from './engine-worktree.mjs';

const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000 });
const fwd = (p) => String(p).split(path.sep).join('/');
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const say = (log, m) => { try { (log || (() => {}))(m); } catch {} };

/** The worktrees git lists for `repo`: [{ dir, head, branch }]. null when git can't say. */
function listWorktrees(repo) {
  const r = git(repo, 'worktree', 'list', '--porcelain');
  if (r.status !== 0) return null;
  const out = []; let cur = null;
  for (const l of String(r.stdout || '').split(/\r?\n/)) {
    if (l.startsWith('worktree ')) { cur = { dir: l.slice(9).trim(), head: null, branch: null }; out.push(cur); }
    else if (cur && l.startsWith('HEAD ')) cur.head = l.slice(5).trim();
    else if (cur && l.startsWith('branch ')) cur.branch = l.slice(7).trim();
  }
  return out;
}

/** The lane folder `dir` as a registered worktree of `repo`, or null. */
export function registeredLane(repo, dir) {
  const all = listWorktrees(repo);
  return all ? all.find((w) => samePath(w.dir, dir)) || null : null;
}

/**
 * 2.86 (f): when an engine worktree may go, in one place. Today's rule (2.83) removed a lane only after a train landed it,
 * from the train itself; a task handed back, finished without a train, dropped, or landed by fast-forward kept its 3.8 GB
 * worktree for good (37 of them on a crew's PC). What keeps one, in order:
 *   a merge in progress there; uncommitted work (tracked changes, untracked files that are not git-ignored); its task
 *   claimed (in progress); its task queued for a train; commits not on the target while the task is still open (handed
 *   back with unlanded work); a fresh lane on the target's tip while the task is open (a launched pass, nobody committed yet).
 * What removes it: its commit is on the target (landed by a train); or its task is done or dropped (cancelled). The branch
 * is never deleted: the commits stay on it. `facts`: { merging, dirty: [paths], claimed, queued, status: 'open' | 'done' |
 * 'dropped' | null (not on the board), onTarget, atTip, target, ahead }. -> { safe, why }.
 */
export function laneRemoval(f = {}) {
  const t = f.target || 'the target';
  const keep = (why) => ({ safe: false, why });
  if (f.merging) return keep('a merge is in progress there (finish or abort it first)');
  const dirty = f.dirty || [];
  if (dirty.length) return keep(`it holds ${dirty.length} change(s) or untracked file(s) (${String(dirty[0]).trim().slice(0, 80)}): uncommitted work is never removed (commit it, or hand the task back with a note)`);
  if (f.claimed) return keep(`its task is in progress (claimed by ${f.claimed})`);
  if (f.queued) return keep('its task is queued for a train (the train reads its branch)');
  if (f.status === 'done') return { safe: true, why: `its task is done (the branch is kept)${f.onTarget ? `, its commit is on ${t}` : ''}` };
  if (f.status === 'dropped') return { safe: true, why: 'its task was dropped (the branch is kept)' };
  if (!f.onTarget) return keep(`its commit is not on ${t} yet (unlanded work${f.ahead ? `: ${f.ahead} commit(s)` : ''}; handed back or not finished)`);
  // A lane just made from the target has the target's own commit: that is a fresh lane as often as a landed one.
  if (f.atTip) return keep(`its commit is ${t}'s tip itself (a fresh lane, or landed by fast-forward: kept until ${t} moves on or its task is done)`);
  return { safe: true, why: `landed on ${t}, clean` };
}

/** The board's word on a task: 'done' (a [x] line), 'open' (any other task line), 'dropped' (a task.dropped event), or null. */
export function boardStatus(task, { root = REPO_ROOT, events = null } = {}) {
  const re = new RegExp(`^\\s*[-*]\\s+\\[([ xX>~])\\]\\s+\\*\\*${String(task).replace(/[^A-Za-z0-9-]/g, '')}\\*\\*`, 'm');
  let st = null;
  for (const f of ['NEXT.md', 'DONE.md']) {
    let text = '';
    try { text = fs.readFileSync(path.join(root, 'studio', f), 'utf8'); } catch { continue; }
    const m = text.match(re);
    if (m) { if (/[xX]/.test(m[1])) return 'done'; st = 'open'; }
  }
  if (st) return st;
  let ev = events;
  if (!ev) { try { ev = readRecentEvents(20000); } catch { ev = []; } }
  return (ev || []).some((e) => e?.type === 'task.dropped' && e.task === task) ? 'dropped' : null;
}

/** Who holds task:<id>'s claim now (a live lock file in <root>/.studio/locks), or null. Read only. */
function claimHolder(task, root, now = Date.now()) {
  const dir = path.join(root, '.studio', 'locks');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.lock')); } catch { return null; }
  for (const n of names) {
    const j = readJson(path.join(dir, n));
    if (j?.key === `task:${task}` && (!j.expiresAt || Date.parse(j.expiresAt) > now)) return j.owner || 'someone';
  }
  return null;
}

/** Is the task in the engine's train queue (.studio/train/<engine>-queue.json)? */
function queuedFor(task, root, engine) {
  const q = readJson(path.join(root, '.studio', 'train', `${engine}-queue.json`));
  return Array.isArray(q) && q.some((e) => e && e.task === task);
}

/**
 * Remove <root>/.lanes/engine/<task> when laneRemoval says it is safe; else keep it and say why. Only `git worktree
 * remove` (never --force), so git itself still refuses a folder with work in it. { removed, why, dir, would? }.
 */
export function removeLandedLane({ root = REPO_ROOT, engine = 'unity', task, log, dryRun = false, events = null } = {}) {
  const dir = path.join(root, '.lanes', 'engine', String(task || ''));
  const keep = (why) => ({ removed: false, why, dir });
  if (!/^[A-Za-z0-9._-]+$/.test(String(task || '')) || /^\.+$/.test(String(task))) return keep('not a task folder name');
  if (!fs.existsSync(dir)) return keep('no such folder');
  const f = laneFacts({ root, engine, task, dir, events });
  if (f.error) return keep(f.error);
  const v = laneRemoval(f);
  if (!v.safe) return keep(v.why);
  if (dryRun) return { removed: false, why: `${v.why}: would remove`, dir, would: true };
  const rm = git(f.repo, 'worktree', 'remove', dir);
  if (rm.status !== 0) return keep(`git refused to remove it: ${String(rm.stderr || rm.stdout).trim().split(/\r?\n/)[0].slice(0, 200)}`);
  git(f.repo, 'worktree', 'prune');
  try { emitEvent({ type: 'engine.lane.removed', agent: 'engine-clean', task, msg: `${task}: its engine lane folder was removed (${v.why}, nothing unsaved): ${fwd(dir)}`.slice(0, 400), meta: { engine, folder: fwd(dir), target: f.target, status: f.status, onTarget: f.onTarget } }); } catch {}
  say(log, `removed ${fwd(dir)}`);
  return { removed: true, why: v.why, dir };
}

/** The facts laneRemoval judges, for one lane folder, or { error } when it is not an engine worktree this can judge. */
export function laneFacts({ root = REPO_ROOT, engine = 'unity', task, dir, events = null, now = Date.now() } = {}) {
  const repo = engineRepo(engine, { root });
  if (!repo) return { error: `no separate ${engine} repo is configured` };
  const target = engineTarget(engine, { root })?.cfg?.target;
  if (!target || git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${target}`).status !== 0) return { error: `the target branch ${target || '(none)'} was not found in the repo` };
  const wt = registeredLane(repo, dir);
  if (!wt) return { error: 'not a registered worktree of the engine repo' };
  if (samePath(wt.dir, repo)) return { error: 'this is the engine repo itself' };
  const head = git(dir, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}');
  if (head.status !== 0) return { error: 'its HEAD could not be read' };
  const sha = head.stdout.trim();
  const tip = git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${target}^{commit}`).stdout.trim();
  const onTarget = git(repo, 'merge-base', '--is-ancestor', sha, target).status === 0;
  const ahead = onTarget ? 0 : Number(git(repo, 'rev-list', '--count', `${target}..${sha}`).stdout.trim()) || 0;
  const merging = git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0;
  const st = git(dir, 'status', '--porcelain');
  if (st.status !== 0) return { error: 'git status failed there' };
  const dirty = String(st.stdout || '').split(/\r?\n/).filter(Boolean);
  return { repo, target, onTarget, atTip: sha === tip, ahead, merging, dirty, claimed: claimHolder(task, root, now), queued: queuedFor(task, root, engine), status: boardStatus(task, { root, events }), branch: wt.branch ? wt.branch.replace(/^refs\/heads\//, '') : null };
}

/**
 * Every folder under <root>/.lanes/engine/ by the same rule: [{ task, dir, removed, why }]. `skipForeign`: a folder that
 * is not a worktree of THIS engine's repo is left out (many engines share the folder).
 */
export function pruneEngineLanes({ root = REPO_ROOT, engine = 'unity', dryRun = false, log, skipForeign = false } = {}) {
  const base = path.join(root, '.lanes', 'engine');
  let names = [];
  try { names = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; }
  const repo = engineRepo(engine, { root });
  const res = [];
  let events = [];
  try { events = readRecentEvents(20000); } catch { events = []; }
  for (const task of names) {
    const dir = path.join(base, task);
    if (skipForeign && (!repo || !registeredLane(repo, dir))) continue;
    const r = removeLandedLane({ root, engine, task, log, dryRun, events });
    res.push({ task, dir, removed: r.removed, would: Boolean(r.would), why: r.why });
  }
  return res;
}

// ---- builds ----------------------------------------------------------------------------------------------------------

const globRe = (pat) => new RegExp(`^${String(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

/**
 * Keep the newest `keep` (min 1) direct child folders of `dir` that match `pattern` (plus the one named `latest`), remove
 * the rest, write <dir>/LATEST.txt. { kept, removed, latestFile } or { kept: [], removed: [], latestFile: null, refused: why }.
 */
export function pruneBuilds({ dir, keep = 3, pattern = 'gate-*', latest = null, root = REPO_ROOT, dryRun = false, log } = {}) {
  const refuse = (why) => { say(log, `builds not pruned: ${why}`); return { kept: [], removed: [], latestFile: null, refused: why }; };
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return refuse('the builds folder is not an absolute path');
  let st; try { st = fs.statSync(dir); } catch { return refuse('the builds folder does not exist'); }
  if (!st.isDirectory()) return refuse('the builds path is not a folder');
  const d = fold(real(dir)).replace(/[\\/]+$/, '');
  if (path.parse(real(dir)).root === real(dir)) return refuse('the builds folder is a filesystem root');
  if (d === fold(real(os.homedir())).replace(/[\\/]+$/, '')) return refuse('the builds folder is the home folder');
  const studio = fold(real(root));
  if (studio === d || studio.startsWith(d + path.sep)) return refuse('the builds folder is the studio root or a parent of it');
  const lit = String(pattern || '').split(/[*?]/)[0];
  if (typeof pattern !== 'string' || lit.length < 3) return refuse('the pattern needs at least 3 literal characters before any wildcard');
  const re = globRe(pattern);
  const items = [];
  for (const e of fs.readdirSync(dir)) {
    if (!re.test(e)) continue;
    const p = path.join(dir, e);
    let l; try { l = fs.lstatSync(p); } catch { continue; }
    if (l.isSymbolicLink() || !l.isDirectory()) continue;
    items.push({ name: e, p, m: l.mtimeMs });
  }
  items.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : b.m - a.m));
  const n = Math.max(1, Math.floor(Number(keep)) || 1);
  const latestName = latest ? path.basename(String(latest)) : null;
  const kept = []; const removed = [];
  items.forEach((it, i) => { (i < n || it.name === latestName ? kept : removed).push(it); });
  const failed = [];
  for (const it of removed) {
    if (dryRun) continue;
    try { fs.rmSync(it.p, { recursive: true, force: true }); } catch (e) { failed.push(it.name); }
    if (fs.existsSync(it.p)) failed.push(it.name);
  }
  const target = latestName && items.some((i) => i.name === latestName) ? path.join(dir, latestName) : kept[0] ? kept[0].p : null;
  const latestFile = target ? path.join(dir, 'LATEST.txt') : null;
  if (latestFile && !dryRun) fs.writeFileSync(latestFile, `${target}\n`);
  const res = { kept: kept.map((i) => i.name), removed: removed.filter((i) => !failed.includes(i.name)).map((i) => i.name), latestFile };
  if (failed.length) res.failed = [...new Set(failed)];
  if (!dryRun) try { emitEvent({ type: 'engine.builds.pruned', agent: 'engine-clean', msg: `builds in ${fwd(dir)}: ${res.kept.length} kept, ${res.removed.length} removed`.slice(0, 400), meta: { dir: fwd(dir), kept: res.kept.length, removed: res.removed.length, pattern } }); } catch {}
  say(log, `builds in ${fwd(dir)}: ${dryRun ? 'would remove' : 'removed'} ${removed.length}, kept ${kept.length}`);
  return res;
}

/** studio/game.json engines.<x>.builds -> { dir, keep, pattern } | null. STUDIO_ENGINE_KEEP_BUILDS overrides keep (0 or "off": no pruning). */
export function buildsConfig(engine, { root = REPO_ROOT, env = process.env } = {}) {
  const b = readJson(path.join(root, 'studio', 'game.json'))?.engines?.[engine]?.builds;
  if (!b || typeof b !== 'object' || typeof b.dir !== 'string' || !b.dir.trim()) return null;
  let keep = Number.isFinite(Number(b.keep)) && Number(b.keep) >= 1 ? Math.floor(Number(b.keep)) : 3;
  const ov = String(env.STUDIO_ENGINE_KEEP_BUILDS ?? '').trim();
  if (ov) {
    if (/^(off|0|false|no)$/i.test(ov)) return null;
    if (Number(ov) >= 1) keep = Math.floor(Number(ov));
  }
  return { dir: path.resolve(root, b.dir), keep, pattern: typeof b.pattern === 'string' && b.pattern ? b.pattern : 'gate-*' };
}

/** The lane folders of every engine the studio names, for `npm run lanes -- prune`: [{ engine, task, dir, removed, would, why }]. */
export function pruneAllEngineLanes({ root = REPO_ROOT, dryRun = false, log } = {}) {
  const out = []; const seen = new Set();
  for (const t of engineTargets({ root })) {
    for (const r of pruneEngineLanes({ root, engine: t.name, dryRun, log, skipForeign: true })) { seen.add(r.task); out.push({ engine: t.name, ...r }); }
  }
  return out;
}

// ---- 2.86 (f): the listing, the disk users, the supervisor's pass ------------------------------------------------------

/** Tracked bytes of `ref` in `repo`, in total and under `paths` (plus top-level files). One git ls-tree; null when unreadable. */
function trackedBytes(repo, ref, paths = null) {
  const r = spawnSync('git', ['ls-tree', '-r', '-l', '-z', ref], { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 512 * 1024 * 1024, timeout: 120000 });
  if (r.status !== 0) return null;
  let total = 0; let inside = 0;
  for (const l of String(r.stdout || '').split('\0')) {
    const tab = l.indexOf('\t'); if (tab < 0) continue;
    const b = Number(l.slice(0, tab).split(/\s+/)[3]) || 0; const p = l.slice(tab + 1);
    total += b;
    if (paths && (!p.includes('/') || paths.some((d) => p === d || p.startsWith(`${d}/`)))) inside += b;
  }
  return { total, inside };
}

/**
 * Every engine worktree under .lanes/engine: [{ engine, task, dir, size: 'sparse' | 'full', paths, state, safe, why }].
 * state: done | dropped | in progress | queued | open | not on the board. Read only.
 */
export function engineLaneList({ root = REPO_ROOT } = {}) {
  const base = path.join(root, '.lanes', 'engine');
  let names = [];
  try { names = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; }
  let events = []; try { events = readRecentEvents(20000); } catch { events = []; }
  const engines = engineTargets({ root }).map((t) => ({ name: t.name, repo: engineRepo(t.name, { root }) })).filter((e) => e.repo);
  const out = [];
  for (const task of names) {
    const dir = path.join(base, task);
    const eng = engines.find((e) => registeredLane(e.repo, dir));
    const ss = sparseState(dir);
    if (!eng) { out.push({ engine: null, task, dir, size: ss.sparse ? 'sparse' : 'full', paths: ss.paths, state: '?', safe: false, why: 'not a registered worktree of an engine repo' }); continue; }
    const f = laneFacts({ root, engine: eng.name, task, dir, events });
    const v = f.error ? { safe: false, why: f.error } : laneRemoval(f);
    const state = f.error ? '?' : f.claimed ? 'in progress' : f.queued ? 'queued' : f.status === null ? 'not on the board' : f.status;
    out.push({ engine: eng.name, task, dir, size: ss.sparse ? 'sparse' : 'full', paths: ss.paths, state, safe: v.safe, why: v.why });
  }
  return out;
}

const usersFile = (root) => path.join(root, '.studio', 'engine', 'disk-users.json');
const GB = 1024 ** 3;
const gbOf = (b) => Math.round((b / GB) * 10) / 10;

/**
 * The biggest disk users the harness knows, estimated cheaply and cached for an hour (.studio/engine/disk-users.json):
 * engine worktrees (count by sparse/full times the target's tracked bytes, whole or under the sparse folders: one git
 * ls-tree per engine, never a walk of the worktrees), lane copies (the last lane disk report, harness/lane-disk.mjs) and
 * saved builds (engines.<x>.builds: their count times the newest one's size, walked with a cap).
 * { at, items: [{ what, gb, n? }], line }.
 */
export function diskUsers({ root = REPO_ROOT, env = process.env, now = Date.now(), maxAgeMs = 3600000 } = {}) {
  const c = readJson(usersFile(root));
  if (c && Array.isArray(c.items) && now - (Date.parse(c.at) || 0) < maxAgeMs && now >= (Date.parse(c.at) || 0)) return c;
  const items = [];
  for (const t of engineTargets({ root })) {
    const repo = engineRepo(t.name, { root });
    const target = t.cfg?.target;
    if (!repo || !target) continue;
    const base = path.join(root, '.lanes', 'engine');
    let names = []; try { names = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { names = []; }
    let full = 0; let sparse = 0; let sparseBytes = 0; let tb = null; const memo = new Map();
    for (const n of names) {
      const d = path.join(base, n);
      if (!fs.existsSync(path.join(d, '.git'))) continue;
      const ss = sparseState(d);
      if (!ss.sparse) { full += 1; continue; }
      sparse += 1;
      const k = ss.paths.join('|');
      if (!memo.has(k)) memo.set(k, trackedBytes(repo, target, ss.paths));
      if (memo.get(k)) sparseBytes += memo.get(k).inside;
    }
    if (full) tb = trackedBytes(repo, target);
    const bytes = (tb ? tb.total * full : 0) + sparseBytes;
    if (full || sparse) items.push({ what: `${t.name} engine worktrees`, n: full + sparse, full, sparse, gb: gbOf(bytes) });
    const b = buildsConfig(t.name, { root, env });
    if (b) {
      let dirs = []; try { dirs = fs.readdirSync(b.dir, { withFileTypes: true }).filter((e) => e.isDirectory() && globRe(b.pattern).test(e.name)).map((e) => e.name).sort(); } catch { dirs = []; }
      if (dirs.length) { const one = capSize(path.join(b.dir, dirs[dirs.length - 1])); items.push({ what: `${t.name} saved builds`, n: dirs.length, gb: gbOf(one * dirs.length) }); }
    }
  }
  const ld = readJson(path.join(root, '.studio', 'lanes', 'disk.json'));
  if (Number.isFinite(ld?.totalGb)) items.push({ what: 'lane copies', n: ld.lanes ?? null, gb: ld.totalGb });
  items.sort((a, b) => b.gb - a.gb);
  const line = items.map((i) => `${i.what}${i.n ? ` (${i.n}${i.full !== undefined ? `: ${i.full} full, ${i.sparse} sparse` : ''})` : ''} ~${i.gb} GB`).join(', ');
  const rec = { at: new Date(now).toISOString(), items, line };
  try { fs.mkdirSync(path.dirname(usersFile(root)), { recursive: true }); fs.writeFileSync(usersFile(root), `${JSON.stringify(rec, null, 2)}\n`); } catch { /* a cache */ }
  return rec;
}

/** Bytes under p, not following links, stopping after 50000 entries (an estimate). */
function capSize(p, max = 50000) {
  let n = 0; let seen = 0;
  const walk = (q) => {
    if (seen++ > max) return;
    let st; try { st = fs.lstatSync(q); } catch { return; }
    if (st.isSymbolicLink() || !st.isDirectory()) { n += st.size || 0; return; }
    let names = []; try { names = fs.readdirSync(q); } catch { return; }
    for (const x of names) walk(path.join(q, x));
  };
  walk(p);
  return n;
}

/**
 * The supervisor's engine lane pass: every 30 minutes, a detached child (`node harness/engine-clean.mjs lanes`) removes
 * the engine worktrees laneRemoval says are safe. STUDIO_ENGINE_LANE_CLEAN=off turns it off (as for the train's removal).
 */
export function engineLanesPass({ root = REPO_ROOT, env = process.env, now = Date.now(), inline = false } = {}) {
  if (/^(off|0|false|no)$/i.test(String(env.STUDIO_ENGINE_LANE_CLEAN || ''))) return { ran: false, why: 'STUDIO_ENGINE_LANE_CLEAN=off' };
  if (!fs.existsSync(path.join(root, '.lanes', 'engine'))) return { ran: false, why: 'no engine lanes' };
  const f = path.join(root, '.studio', 'engine', 'lanes-pass.json');
  const last = Date.parse(readJson(f)?.at || '') || 0;
  if (now - last < 30 * 60000 && now >= last) return { ran: false, why: 'ran recently' };
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify({ at: new Date(now).toISOString() })}\n`); } catch { /* next pass again */ }
  if (inline) return { ran: true, results: pruneAllEngineLanes({ root }) };
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'lanes'], { cwd: root, env: { ...env, STUDIO_MAIN_ROOT: root }, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ran: true, detached: true };
  } catch (e) { return { ran: false, why: e.message }; }
}

// ---- command line ----------------------------------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const dry = argv.includes('--dry-run');
  const root = REPO_ROOT;
  const only = opt('--engine');
  const engines = engineTargets({ root }).map((t) => t.name).filter((n) => !only || n === only);
  const cmd = argv[0];
  if (cmd === 'lanes') {
    const rs = only ? pruneEngineLanes({ root, engine: only, dryRun: dry, log: () => {} }).map((r) => ({ engine: only, ...r })) : pruneAllEngineLanes({ root, dryRun: dry });
    for (const r of rs) console.log(`  ${r.removed ? 'removed' : r.would ? 'would remove' : 'kept'} ${fwd(r.dir)}: ${r.why}`);
    if (!rs.length) console.log('no engine lane folders');
  } else if (cmd === 'builds') {
    let any = false;
    for (const e of engines) {
      const c = buildsConfig(e, { root });
      if (!c) continue;
      any = true;
      const r = pruneBuilds({ ...c, root, dryRun: dry, log: (m) => console.log(m) });
      if (r.refused) console.log(`${e}: refused: ${r.refused}`);
      else console.log(`${e}: ${dry ? 'would remove' : 'removed'} ${r.removed.length}, kept ${r.kept.join(', ') || 'none'}`);
    }
    if (!any) console.log('no engines.<x>.builds is set in studio/game.json (or STUDIO_ENGINE_KEEP_BUILDS is off): nothing to prune');
  } else if (cmd === 'list') {
    // 2.86 (f): npm run engine -- lanes
    const rs = engineLaneList({ root });
    if (argv.includes('--json')) console.log(JSON.stringify(rs));
    else if (!rs.length) console.log('no engine worktrees');
    else for (const r of rs) console.log(`  ${r.task.padEnd(8)} ${r.size.padEnd(6)} ${r.state.padEnd(16)} ${r.safe ? 'safe to remove' : 'keep'}: ${r.why}${r.size === 'sparse' && r.paths.length ? ` [${r.paths.join(', ')}]` : ''}`);
  } else { console.error('Usage: node harness/engine-clean.mjs lanes|builds|list [--engine <x>] [--dry-run] [--json]'); process.exit(2); }
}
