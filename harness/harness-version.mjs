/**
 * harness/harness-version.mjs — 2.78.1 (B-122, B-116): which harness a long-lived process runs, and whether the harness
 * on disk changed underneath it.
 *
 * A process loads its harness modules from disk as it goes (dynamic imports). One that started before a harness update
 * and imports a module after it mixes the two: train 33704, started under 2.77.2, chain-started its successor after
 * the 2.78 merge, and the successor crashed ("./lane-sparse.mjs does not provide an export named protectSharedLinks").
 * And a train's re-check of main right after an update ran the old harness in its copy and said "main itself fails its
 * checks". So:
 *
 *   harnessStamp(dir)        { version (package.json), tree (git tree id of HEAD:harness + HEAD:scripts, the committed
 *                            harness), dirty (a hash of the uncommitted harness/ and scripts/ changes, '' when none),
 *                            commit (the last commit that changed them), at }. Never throws (unreadable parts: null).
 *   processHarness()         the stamp of the harness this process runs, taken once, at its first call (a train
 *                            calls it as it starts): the code it loads later comes from the same folder.
 *   harnessDrift(was, now)   null when the same harness, else why ("2.77.2 -> 2.78.0", "harness commit a1b2 -> c3d4").
 *   chainGuard()             before a train starts another train in the same process (or a speculative one beside
 *                            it): { ok, why }. Not ok when the harness changed since this process started; the lanes
 *                            stay queued and the train daemon (a fresh process, the new harness) starts the next one.
 *                            STUDIO_TRAIN_HARNESS_GUARD=off: never stops a chain (the 2.78.0 way).
 *   copyHarnessDrift(...)    B-116: a red re-check whose copy's harness (the tree checked) differs from the main
 *                            checkout's harness now, or whose process started under another harness, or whose log
 *                            shows an import error naming a harness file: not run (harness changed underneath).
 *
 * Imports only node's modules: train.mjs and train-daemon.mjs import it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The folder whose harness/ this process loads its code from (this file's checkout). */
export const RUNNING_ROOT = path.resolve(HERE, '..');
const HARNESS_DIRS = ['harness', 'scripts'];
const off = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(k)));
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: cleanEnv(), timeout: 30000 });
const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');

/** The committed harness of `rev` in `dir`: the tree ids of <rev>:harness and <rev>:scripts, joined ('' when unreadable). */
export function harnessTree(dir, rev = 'HEAD') {
  const ids = HARNESS_DIRS.map((d) => out(git(dir, 'rev-parse', '-q', '--verify', `${rev}:${d}`)));
  return ids.every((x) => !x) ? '' : ids.join('+');
}

/** The harness in `dir` now: { version, tree, dirty, commit, at }. Never throws. */
export function harnessStamp(dir = RUNNING_ROOT) {
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null; } catch {}
  const tree = harnessTree(dir) || null;
  const diff = git(dir, '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-color', 'HEAD', '--', ...HARNESS_DIRS);
  const dirty = diff.status === 0 && String(diff.stdout || '').trim() ? crypto.createHash('sha256').update(String(diff.stdout)).digest('hex').slice(0, 12) : '';
  const commit = out(git(dir, 'log', '-1', '--format=%H', 'HEAD', '--', ...HARNESS_DIRS)) || null;
  return { version, tree, dirty, commit, at: new Date().toISOString() };
}

let first = null;
/** The harness this process runs: the stamp at its first call (memoized). `reset` is for tests. */
export function processHarness({ dir = RUNNING_ROOT, reset = false } = {}) {
  if (reset) first = null;
  if (!first) first = harnessStamp(dir);
  return first;
}

const short = (s) => String(s || '?').split('+').map((x) => x.slice(0, 8)).join('+');
/** null when `was` and `now` are the same harness (version, committed tree, uncommitted changes); else why. */
export function harnessDrift(was, now) {
  if (!was || !now) return null;
  const why = [];
  if (was.version && now.version && was.version !== now.version) why.push(`version ${was.version} -> ${now.version}`);
  if (was.tree && now.tree && was.tree !== now.tree) why.push(`harness commit ${String(was.commit || '').slice(0, 8) || short(was.tree)} -> ${String(now.commit || '').slice(0, 8) || short(now.tree)}`);
  else if ((was.dirty || '') !== (now.dirty || '') && was.tree && now.tree) why.push(`uncommitted harness changes ${was.dirty || 'none'} -> ${now.dirty || 'none'}`);
  return why.length ? why.join(', ') : null;
}

/**
 * B-122: may this process start another train (in-process, or a speculative one beside it)? { ok, why, was, now }.
 * Not when the harness on disk changed since this process started. STUDIO_TRAIN_HARNESS_GUARD=off: always.
 */
export function chainGuard({ env = process.env, dir = RUNNING_ROOT, was = processHarness({ dir }), now = null } = {}) {
  if (off(env.STUDIO_TRAIN_HARNESS_GUARD)) return { ok: true, why: 'STUDIO_TRAIN_HARNESS_GUARD=off' };
  const cur = now || harnessStamp(dir);
  const d = harnessDrift(was, cur);
  return d ? { ok: false, why: `the harness changed since this train's process started (${d})`, was, now: cur } : { ok: true, why: '', was, now: cur };
}

/** An import error that names a harness file (the old and new harness mixed): the first such line, or ''. */
export function harnessImportError(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rx = /(does not provide an export named|ERR_MODULE_NOT_FOUND|Cannot find module|ERR_PACKAGE_PATH_NOT_EXPORTED|is not a function|SyntaxError: The requested module)/;
  for (let i = 0; i < lines.length; i += 1) {
    if (!rx.test(lines[i])) continue;
    const near = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
    if (/(^|[\s'"(/\\])(harness|scripts)[\\/][\w.-]+\.m?js|\.\/[\w.-]+\.mjs/.test(near)) return lines[i].trim().slice(0, 240);
  }
  return '';
}

/**
 * B-116: did the harness change underneath a red re-check? { changed, why }. `copyRev` is the commit the checked copy
 * was built from (main's tip as the train saw it; its harness is what ran in the copy), `mainDir` the main checkout.
 * Changed when the copy's committed harness differs from the main checkout's now, or the harness this process runs
 * (its own folder) changed since it started; an import error naming a harness file in the log is named with it
 * (on its own, with the same harness everywhere, it is a real red of main and stays one). STUDIO_TRAIN_HARNESS_GUARD=off:
 * never (the 2.78.0 way).
 */
export function copyHarnessDrift({ mainDir, copyRev, logText = '', env = process.env, was = processHarness() } = {}) {
  if (off(env.STUDIO_TRAIN_HARNESS_GUARD) || !mainDir) return { changed: false, why: '' };
  const nowMain = harnessStamp(mainDir);
  const copyTree = copyRev ? harnessTree(mainDir, copyRev) : '';
  const why = [];
  if (copyTree && nowMain.tree && copyTree !== nowMain.tree) {
    let v = null;
    try { v = JSON.parse(out(git(mainDir, 'show', `${copyRev}:package.json`)) || 'null')?.version || null; } catch {}
    why.push(`the checked copy ran the harness of ${String(copyRev).slice(0, 8)}${v ? ` (${v})` : ''}, and ${path.basename(mainDir)}'s harness is now ${nowMain.version || '?'} (${String(nowMain.commit || '').slice(0, 8) || short(nowMain.tree)})`);
  }
  // The running harness (this process's own folder: a lane's copy may run a harness that lags main on purpose) since
  // this process started.
  const d = harnessDrift(was, harnessStamp(RUNNING_ROOT));
  if (d) why.push(`the harness this train runs changed since it started (${d})`);
  if (!why.length) return { changed: false, why: '' };
  const imp = harnessImportError(logText);
  return { changed: true, why: `${why.join('; ')}${imp ? `; the log shows: ${imp}` : ''}` };
}
