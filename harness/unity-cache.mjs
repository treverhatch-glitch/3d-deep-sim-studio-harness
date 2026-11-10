#!/usr/bin/env node
/**
 * harness/unity-cache.mjs — 2.67.1 (k): a warm Unity Library cache, so a fresh project copy skips the ~10 min import.
 *
 * Unity rebuilds a project's Library/ (its imported assets, compiled scripts, package cache) on the first editor run in
 * every new copy: a lane copy, a gate copy, a fresh clone. The editor runs the harness starts (harness/unity.mjs gate
 * and build) now reuse one warm Library per project, Unity version and branch base:
 *
 *   - before the editor runs, a copy without a Library/ gets the cached one (seed). A copy that already has a
 *     Library/ keeps its own (Unity brings it up to date itself);
 *   - after a green run (all tests passed, or the build passed) the copy's Library/ replaces the cached one (save).
 *
 * The cache is <STUDIO_UNITY_LIBRARY_CACHE>/<key>/Library (default <main checkout>/.studio/unity-cache; off: none). The
 * key is the project (its path in the checkout), the Unity version (ProjectSettings/ProjectVersion.txt), the branch
 * base (STUDIO_UNITY_LIBRARY_BASE, else studio/game.json engines.unity.target, else main) and a hash of
 * Packages/manifest.json and packages-lock.json: a version or package change starts fresh (a new key, a cold first
 * run). The newest STUDIO_UNITY_LIBRARY_CACHE_KEEP (2) keys per project are kept; older ones are deleted on save.
 *
 * Copied, never hard-linked or junctioned. The editor writes into Library files in place (its asset database is a
 * memory-mapped database file, rewritten under the same name): a hard link would write the lane's changes into the
 * cache, and a junction or symlink would make two editor runs share one live Library (on Windows a junction also
 * makes deleting the lane copy delete through into the cache with some tools). A copy costs a minute or two for a
 * few GB against a ~10 min import; lock files (*-lock, *.lock) are not copied. 2.70.0 (u): the copy runs up to
 * STUDIO_UNITY_CACHE_COPY_JOBS files at once (STUDIO_UNITY_CACHE_COPY=parallel, the default; serial: fs.cpSync).
 *
 * Never shared by two editor runs at once: each run works on its own copy, and the copy in or out takes
 * <cache>/<key>.lock (a live holder: the run goes cold, or doesn't save, and says so; it never waits or overwrites).
 * Editor runs already run one at a time under machine:heavy; the key lock covers STUDIO_HEAVY_SLOTS > 1 and land
 * scripts calling this CLI.
 *
 *   node harness/unity-cache.mjs status [<folder>] [--json]   the key for <folder> and what the cache holds
 *   node harness/unity-cache.mjs seed <folder>                copy the warm Library into <folder> (when it has none)
 *   node harness/unity-cache.mjs save <folder>                after a green run: <folder>'s Library becomes the warm one
 *   node harness/unity-cache.mjs clear [<folder>]             delete the cache (one project's keys, or all)
 *
 * A studio's own land script (harness/unity-gate.mjs runs it under machine:heavy) can call seed and save around its
 * editor steps in its gate worktree; the harness never touches the land script's files itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './event.mjs';
import { pidAlive, selfIdentity } from './proc-identity.mjs';
import { readJson } from './fsafe.mjs';

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const slug = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'project';
const span = (ms) => (ms < 120000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`);

/** The cache folder, or null when STUDIO_UNITY_LIBRARY_CACHE=off. mainRoot: the main checkout (lane copies share it). */
export function cacheRoot(mainRoot = REPO_ROOT, env = process.env) {
  const v = String(env.STUDIO_UNITY_LIBRARY_CACHE ?? '').trim();
  if (/^(off|0|false|no)$/i.test(v)) return null;
  return v ? path.resolve(mainRoot, v) : path.join(mainRoot, '.studio', 'unity-cache');
}

/** The project's key parts: { project, version, base, packages, key } (key null when there is no ProjectVersion.txt). */
export function cacheKey(dir, { root = REPO_ROOT, env = process.env } = {}) {
  const version = ((read(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt')) || '').match(/m_EditorVersion:\s*(\S+)/) || [])[1] || null;
  const relDir = path.relative(root, dir);
  const project = slug(relDir && !relDir.startsWith('..') && !path.isAbsolute(relDir) ? relDir.split(path.sep).join('/') : path.basename(dir));
  const base = slug(String(env.STUDIO_UNITY_LIBRARY_BASE || '').trim() || readJson(path.join(root, 'studio', 'game.json'))?.engines?.unity?.target || 'main');
  const h = crypto.createHash('sha256');
  for (const f of ['manifest.json', 'packages-lock.json']) h.update(`${f}\n${(read(path.join(dir, 'Packages', f)) || '').replace(/\r\n/g, '\n')}\n`);
  const packages = h.digest('hex').slice(0, 12);
  return { project, version, base, packages, key: version ? `${project}--${slug(version)}--${base}--${packages}` : null };
}

const hasLibrary = (dir) => { try { return fs.readdirSync(path.join(dir, 'Library')).length > 0; } catch { return false; } };
const skipLock = (src) => !/(?:-lock|\.lock)$/i.test(path.basename(src));
const serialCopy = (from, to) => fs.cpSync(from, to, { recursive: true, force: true, preserveTimestamps: true, filter: skipLock });

// ---- 2.70.0 (u): a parallel Library copy -------------------------------------------------------------------------
// fs.cpSync copies one file at a time; a Library is tens of thousands of small files, so the copy waits on each one in
// turn. The parallel copy runs in a child node process (seed and save are synchronous, like the gate that calls them)
// with up to STUDIO_UNITY_CACHE_COPY_JOBS copyFile calls at once. Files are copied (copyFile: on a ReFS Dev Drive
// Windows clones the blocks), never hard-linked; timestamps are kept; lock files are skipped, as before.

/** STUDIO_UNITY_CACHE_COPY: 'parallel' (default) or 'serial' (fs.cpSync, as in 2.67.1). */
export const copyMode = (env = process.env) => (/^serial$/i.test(String(env.STUDIO_UNITY_CACHE_COPY || '').trim()) ? 'serial' : 'parallel');
/** How many files the parallel copy copies at once: STUDIO_UNITY_CACHE_COPY_JOBS, else twice the cores (4 to 16). */
export function copyJobs(env = process.env) {
  const v = Math.floor(num(env.STUDIO_UNITY_CACHE_COPY_JOBS, 0));
  if (v > 0) return Math.min(64, v);
  const cores = (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 2;
  return Math.max(4, Math.min(16, cores * 2));
}

/** Copy a folder with `jobs` copies in flight (the child process's work). { files, bytes }. */
export async function parallelCopy(from, to, jobs = 8) {
  const files = [];
  const links = [];
  const dirs = [to];
  const stack = [[from, to]];
  while (stack.length) {
    const [s, d] = stack.pop();
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, e.name);
      const dp = path.join(d, e.name);
      if (!skipLock(sp)) continue;
      if (e.isDirectory()) { dirs.push(dp); stack.push([sp, dp]); } else if (e.isSymbolicLink()) links.push([sp, dp]); else if (e.isFile()) files.push([sp, dp]);
    }
  }
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  for (const [s, d] of links) { try { fs.rmSync(d, { force: true }); } catch {} fs.symlinkSync(fs.readlinkSync(s), d); }
  let next = 0;
  let bytes = 0;
  const worker = async () => {
    while (next < files.length) {
      const [s, d] = files[next++];
      await fs.promises.copyFile(s, d);
      const st = await fs.promises.stat(s);
      bytes += st.size;
      await fs.promises.utimes(d, st.atime, st.mtime);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, files.length || 1)) }, worker));
  return { files: files.length, bytes };
}

/** Copy a Library folder: parallel (a child process) or serial. { mode, jobs, files, note }. Throws when the copy fails. */
export function copyDir(from, to, env = process.env) {
  if (copyMode(env) === 'parallel') {
    const jobs = copyJobs(env);
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '_copy', from, to, String(jobs)], { encoding: 'utf8', windowsHide: true, timeout: 60 * 60000, maxBuffer: 16 * 1024 * 1024 });
    const j = (() => { try { return JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { return null; } })();
    if (r.status === 0 && j && Number.isFinite(j.files)) return { mode: 'parallel', jobs, files: j.files, note: `parallel copy, ${jobs} at a time, ${j.files} file(s), ${Math.round(j.bytes / 1048576)} MB` };
    fs.rmSync(to, { recursive: true, force: true });
    serialCopy(from, to);
    return { mode: 'serial', jobs: 1, files: null, note: `serial copy: the parallel copy failed (${String(r.error?.code || r.stderr || `exit ${r.status}`).trim().split('\n').pop().slice(0, 160)})` };
  }
  serialCopy(from, to);
  return { mode: 'serial', jobs: 1, files: null, note: 'serial copy (STUDIO_UNITY_CACHE_COPY=serial)' };
}

/** Take <cache>/<key>.lock: { release } or { busy: why }. A dead or reused-pid holder's lock is taken over. */
export function takeKeyLock(cache, key, what) {
  fs.mkdirSync(cache, { recursive: true });
  const f = path.join(cache, `${key}.lock`);
  for (let i = 0; i < 2; i += 1) {
    try {
      fs.writeFileSync(f, JSON.stringify({ pid: process.pid, identity: selfIdentity(), at: Date.now(), what }), { flag: 'wx' });
      return { release: () => { try { if (readJson(f)?.pid === process.pid) fs.rmSync(f, { force: true }); } catch {} } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const h = readJson(f);
      if (h && pidAlive(Number(h.pid), h.identity)) return { busy: `${h.what || 'another run'} (pid ${h.pid}) is copying this Library now` };
      if (!h && Date.now() - (fs.statSync(f, { throwIfNoEntry: false })?.mtimeMs || 0) < 5000) return { busy: 'another run is taking the cache lock now' };
      try { fs.rmSync(f, { force: true }); } catch {}
    }
  }
  return { busy: 'the cache lock could not be taken' };
}

/**
 * Before an editor run: copy the warm Library into dir when it has none. { status, why, key, ms }:
 * off | skipped (not a Unity project) | warm-here (dir has its own Library) | cold (none cached for this key) |
 * busy (another run is copying it: this run goes cold) | seeded | error. Never throws.
 */
export function seedLibrary(dir, { mainRoot = REPO_ROOT, root = REPO_ROOT, env = process.env } = {}) {
  const cache = cacheRoot(mainRoot, env);
  if (!cache) return { status: 'off', why: 'STUDIO_UNITY_LIBRARY_CACHE=off: no Library cache' };
  const k = cacheKey(dir, { root, env });
  if (!k.key) return { status: 'skipped', why: 'no ProjectSettings/ProjectVersion.txt: not a Unity project' };
  if (hasLibrary(dir)) return { status: 'warm-here', key: k.key, why: 'this copy has its own Library/ (the editor brings it up to date)' };
  const src = path.join(cache, k.key, 'Library');
  if (!fs.existsSync(src)) return { status: 'cold', key: k.key, why: `no warm Library for ${k.key} yet: the editor imports from scratch, and a green run saves it` };
  const lk = takeKeyLock(cache, k.key, `seed ${k.project}`);
  if (lk.busy) return { status: 'busy', key: k.key, why: `${lk.busy}: this run imports from scratch instead of sharing it` };
  const t0 = Date.now();
  const tmp = path.join(dir, `Library.seed-${process.pid}`);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    const cp = copyDir(src, tmp, env);
    fs.rmSync(path.join(dir, 'Library'), { recursive: true, force: true });
    fs.renameSync(tmp, path.join(dir, 'Library'));
    return { status: 'seeded', key: k.key, ms: Date.now() - t0, copy: cp.mode, files: cp.files, why: `copied the warm Library (${k.key}) in ${span(Date.now() - t0)} (${cp.note})` };
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    return { status: 'error', key: k.key, why: `could not copy the warm Library (${err.code || err.message}): the editor imports from scratch` };
  } finally {
    lk.release();
  }
}

/** The cache's entries for a project: [{ key, savedAt }], newest first. */
export function cacheEntries(cache, project = null) {
  let names = [];
  try { names = fs.readdirSync(cache, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  return names.filter((n) => !project || n.startsWith(`${project}--`)).map((n) => ({ key: n, ...(readJson(path.join(cache, n, 'meta.json')) || {}) })).sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
}

/**
 * After a green editor run: dir's Library becomes the warm one for its key (copied to a temp folder, then swapped in,
 * so a reader never sees half of it). { status: off|skipped|busy|saved|error, why, key, ms, pruned }. Never throws.
 */
export function saveLibrary(dir, { mainRoot = REPO_ROOT, root = REPO_ROOT, env = process.env } = {}) {
  const cache = cacheRoot(mainRoot, env);
  if (!cache) return { status: 'off', why: 'STUDIO_UNITY_LIBRARY_CACHE=off: no Library cache' };
  const k = cacheKey(dir, { root, env });
  if (!k.key) return { status: 'skipped', why: 'no ProjectSettings/ProjectVersion.txt: not a Unity project' };
  if (!hasLibrary(dir)) return { status: 'skipped', key: k.key, why: 'this copy has no Library/ to save' };
  const lk = takeKeyLock(cache, k.key, `save ${k.project}`);
  if (lk.busy) return { status: 'busy', key: k.key, why: `${lk.busy}: the warm Library is left as it is` };
  const t0 = Date.now();
  const entry = path.join(cache, k.key);
  const tmp = path.join(entry, `Library.tmp-${process.pid}`);
  const old = path.join(entry, `Library.old-${process.pid}`);
  let cp = { mode: null, files: null, note: '' };
  try {
    fs.mkdirSync(entry, { recursive: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    cp = copyDir(path.join(dir, 'Library'), tmp, env);
    if (fs.existsSync(path.join(entry, 'Library'))) fs.renameSync(path.join(entry, 'Library'), old);
    fs.renameSync(tmp, path.join(entry, 'Library'));
    fs.rmSync(old, { recursive: true, force: true });
    fs.writeFileSync(path.join(entry, 'meta.json'), `${JSON.stringify({ project: k.project, version: k.version, base: k.base, packages: k.packages, savedAt: Date.now(), from: path.resolve(dir) }, null, 2)}\n`);
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    lk.release();
    return { status: 'error', key: k.key, why: `could not save the warm Library (${err.code || err.message})` };
  }
  lk.release();
  // Keep the newest STUDIO_UNITY_LIBRARY_CACHE_KEEP keys of this project; skip one another run is copying.
  const keep = Math.max(1, num(env.STUDIO_UNITY_LIBRARY_CACHE_KEEP, 2));
  const pruned = [];
  for (const e of cacheEntries(cache, k.project).filter((x) => x.key !== k.key).slice(keep - 1)) {
    const l = takeKeyLock(cache, e.key, 'prune');
    if (l.busy) continue;
    try { fs.rmSync(path.join(cache, e.key), { recursive: true, force: true }); pruned.push(e.key); } catch {}
    l.release();
  }
  return { status: 'saved', key: k.key, ms: Date.now() - t0, pruned, copy: cp.mode, files: cp.files, why: `saved this copy's Library as the warm one (${k.key}) in ${span(Date.now() - t0)} (${cp.note})${pruned.length ? `; deleted ${pruned.length} older key(s)` : ''}` };
}

/** One line for the gate's output. */
export const cacheLine = (r, when) => `[unity] Library cache (${when}): ${r.status}: ${r.why}`;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) && process.argv[2] === '_copy') {
  // 2.70.0 (u): the parallel copy's child process (copyDir): _copy <from> <to> <jobs>; prints { files, bytes }.
  const [from, to, jobs] = process.argv.slice(3);
  try { console.log(JSON.stringify(await parallelCopy(from, to, Number(jobs) || 8))); } catch (err) { console.error(String(err.code || err.message || err)); process.exit(1); }
} else if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const [cmd, folderArg] = argv;
  let mainRoot = REPO_ROOT;
  try { mainRoot = await (await import('./heavy.mjs')).heavyRoot(); } catch {}
  const dir = folderArg && !folderArg.startsWith('--') ? path.resolve(process.cwd(), folderArg) : null;
  const cache = cacheRoot(mainRoot);
  if (cmd === 'seed' || cmd === 'save') {
    if (!dir) { console.error(`usage: node harness/unity-cache.mjs ${cmd} <folder>`); process.exit(2); }
    const r = cmd === 'seed' ? seedLibrary(dir, { mainRoot }) : saveLibrary(dir, { mainRoot });
    console.log(cacheLine(r, cmd));
    process.exit(r.status === 'error' ? 1 : 0);
  } else if (cmd === 'status') {
    const k = dir ? cacheKey(dir) : null;
    const entries = cache ? cacheEntries(cache) : [];
    if (argv.includes('--json')) console.log(JSON.stringify({ cache, key: k?.key || null, entries }));
    else {
      console.log(cache ? `[unity-cache] ${cache}: ${entries.length} warm Library key(s)` : '[unity-cache] off (STUDIO_UNITY_LIBRARY_CACHE=off)');
      if (k) console.log(`[unity-cache] ${path.relative(process.cwd(), dir) || '.'}: key ${k.key || '(not a Unity project)'}${k.key && entries.some((e) => e.key === k.key) ? ' (warm)' : ' (cold)'}`);
      for (const e of entries) console.log(`  ${e.key}${e.savedAt ? `  saved ${new Date(e.savedAt).toISOString()}` : ''}`);
    }
  } else if (cmd === 'clear') {
    if (!cache) { console.log('[unity-cache] off: nothing to clear'); process.exit(0); }
    const k = dir ? cacheKey(dir) : null;
    const gone = [];
    for (const e of cacheEntries(cache, k?.project || null)) {
      const l = takeKeyLock(cache, e.key, 'clear');
      if (l.busy) { console.log(`[unity-cache] kept ${e.key}: ${l.busy}`); continue; }
      fs.rmSync(path.join(cache, e.key), { recursive: true, force: true });
      gone.push(e.key);
      l.release();
    }
    console.log(`[unity-cache] cleared ${gone.length} key(s)`);
  } else {
    console.error('usage: node harness/unity-cache.mjs status [<folder>] [--json] | seed <folder> | save <folder> | clear [<folder>]');
    process.exit(2);
  }
}
