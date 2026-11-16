/**
 * harness/harness-version.mjs — tells which harness a long-lived process runs, and whether the harness on disk changed
 * underneath it (a process loads harness modules as it goes, so one that outlives an update mixes old and new).
 *   harnessStamp(dir)   { version, tree (git tree id of HEAD:harness + HEAD:scripts), dirty, commit, at }; never throws
 *   processHarness()    the stamp of the harness this process runs, taken once at its first call
 *   harnessDrift(was, now)   null when the same harness, else why
 *   chainGuard()        before a train starts another in this process: { ok, why }; not ok when the harness changed;
 *                       the lanes stay queued for the train daemon. STUDIO_TRAIN_HARNESS_GUARD=off: never stops
 *   copyHarnessDrift(...)   a red re-check whose copy's harness differs from main's now, or whose log shows an import
 *                       error naming a harness file: not run. Imports only node's modules (train.mjs imports it).
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
 * Did the harness change underneath a red re-check? { changed, why }. `copyRev` is the commit the checked copy was
 * built from, `mainDir` the main checkout. Changed when the copy's committed harness differs from main's now, or this
 * process's harness changed since it started. STUDIO_TRAIN_HARNESS_GUARD=off: never.
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
