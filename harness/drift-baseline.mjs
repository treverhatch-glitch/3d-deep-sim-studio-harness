/**
 * harness/drift-baseline.mjs — 2.84 (j): which uncommitted files are the SESSION's, for the drift check's
 * "edited files outside its scope" signal (harness/stall.mjs driftCheck).
 *
 * The overseer's report: drift.check said two builders edited "137 files outside scope" (.gitignore, harness/*.mjs,
 * scripts/...): the overseer's own uncommitted patches in the main checkout. The check lists `git status` of the folder
 * it is given. A session that starts in the main checkout (before `task start` gives it a lane copy, 2.76.0) is
 * observed there first, so every file the overseer had changed in main counted as the session's, and the Check is
 * raised once and never taken back. A lane copy is made from the studio branch's HEAD and never carries main's
 * uncommitted files, but a file the overseer pushed into a lane by hand would count the same way.
 *
 * Now the check skips a file the session did not touch:
 *   - a session in the main checkout: the dirty paths and their content hashes are recorded at its first observation
 *     (drift state `dirty0`); a path with the same content as then is not the session's. No record (a session that began
 *     before 2.84): as before.
 *   - a lane copy: createLaneCopy records the main checkout's dirty paths and hashes at creation
 *     (.studio/lanes/<agent>.dirty.json); a lane file whose content is the same as that record is not the session's.
 *     No record (a lane made before 2.84): a lane file whose content is identical to the main checkout's uncommitted
 *     content for the same path is not the session's.
 * Only the candidates (files already outside the scope) are hashed, in one git call; nothing here changes what a lane copies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { STUDIO_STATE_DIR } from './event.mjs';

const git = (cwd, args, input) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
const real = (p) => { try { return fs.realpathSync.native(p).replace(/\\/g, '/').toLowerCase(); } catch { return path.resolve(p).replace(/\\/g, '/').toLowerCase(); } };

/** The paths `git status` lists as changed in a folder (the same filter as the drift check's working state). */
export function dirtyPaths(cwd) {
  const r = git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  return (r.stdout || '').replace(/\r/g, '').split('\n').filter((l) => l.length > 3)
    .map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '').trim())
    .filter((f) => !/^(\.studio|\.lanes|node_modules)\//.test(f)).map(norm);
}

/** { path: content hash } for the given paths under cwd; 'gone' for a missing one. One git process for all of them. */
export function hashPaths(cwd, paths) {
  const out = {};
  const present = [];
  for (const p of paths) {
    let ok = false;
    try { ok = fs.statSync(path.join(cwd, p)).isFile(); } catch { ok = false; }
    if (ok) present.push(p); else out[p] = 'gone';
  }
  if (present.length) {
    const r = git(cwd, ['hash-object', '--no-filters', '--stdin-paths'], `${present.join('\n')}\n`);
    const hs = String(r.stdout || '').split('\n').filter(Boolean);
    present.forEach((p, i) => { out[p] = r.status === 0 && hs[i] ? hs[i] : `unreadable:${i}`; });
  }
  return out;
}

/** The main checkout a folder belongs to, and whether the folder is a lane copy of it (not the main checkout itself). */
export function mainOf(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const c = String(common.stdout || '').trim();
  if (top.status !== 0 || common.status !== 0 || !c || path.basename(c) !== '.git') return { main: null, lane: false };
  const main = path.dirname(c);
  return { main, lane: real(main) !== real(String(top.stdout || '').trim()) };
}

const recFile = (agent, stateDir = STUDIO_STATE_DIR) => path.join(stateDir, 'lanes', `${String(agent).replace(/[^\w.-]/g, '_')}.dirty.json`);

/** At lane creation: the main checkout's dirty paths with their content hashes, kept for the drift check. Never throws. */
export function writeLaneBaseline(agent, mainDir, { stateDir = STUDIO_STATE_DIR } = {}) {
  try {
    const files = hashPaths(mainDir, dirtyPaths(mainDir));
    fs.mkdirSync(path.dirname(recFile(agent, stateDir)), { recursive: true });
    fs.writeFileSync(recFile(agent, stateDir), `${JSON.stringify({ agent, at: new Date().toISOString(), files })}\n`);
    return Object.keys(files).length;
  } catch { return 0; }
}
export function readLaneBaseline(agent, { stateDir = STUDIO_STATE_DIR } = {}) {
  try { const j = JSON.parse(fs.readFileSync(recFile(agent, stateDir), 'utf8')); return j && typeof j.files === 'object' ? j.files : null; } catch { return null; }
}

/** At a session's first observation in the main checkout: { path: hash } of what is already dirty. */
export function snapshotDirty(cwd, paths = dirtyPaths(cwd)) { return hashPaths(cwd, paths); }

/**
 * Of the candidate paths (changed in cwd, outside the scope), the ones the session did NOT change: a Set.
 * dirty0: the session-start record of a session in the main checkout (undefined: none).
 */
export function notTheSessions(cwd, agent, candidates, { dirty0, stateDir = STUDIO_STATE_DIR } = {}) {
  const skip = new Set();
  const cands = [...new Set(candidates.map(norm))];
  if (!cands.length) return skip;
  const { main, lane } = mainOf(cwd);
  if (!lane) {
    if (!dirty0) return skip;
    const known = cands.filter((f) => Object.prototype.hasOwnProperty.call(dirty0, f));
    const now = hashPaths(cwd, known);
    for (const f of known) if (now[f] === dirty0[f]) skip.add(f);
    return skip;
  }
  const rec = readLaneBaseline(agent, { stateDir });
  const mine = hashPaths(cwd, cands);
  if (rec) {
    for (const f of cands) if (Object.prototype.hasOwnProperty.call(rec, f) && rec[f] === mine[f]) skip.add(f);
    return skip;
  }
  // A lane made before 2.84: compare with what the main checkout has uncommitted now.
  if (!main) return skip;
  const mainDirty = new Set(dirtyPaths(main));
  const both = cands.filter((f) => mainDirty.has(f));
  const theirs = hashPaths(main, both);
  for (const f of both) if (theirs[f] === mine[f]) skip.add(f);
  return skip;
}
