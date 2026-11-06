/**
 * harness/lane-infer.mjs — 2.79.1: a lane for a new builder task from the paths its title names.
 *
 * `task add "Fix the clock in game/demo/src/clock.ts"` with no --lane: the paths in the text that exist in the repo give
 * the lane: their common folder (two or more files), or the single file. A common folder at the repo root, or no existing
 * path, infers nothing (the task is gated as before: it needs a lane). Pure reads; the caller prints what it inferred.
 */
import fs from 'node:fs';
import path from 'node:path';

const SKIP = /^(\.git|node_modules|\.studio|\.lanes)(\/|$)/;

/** Repo-relative paths (forward slashes) named in `text` that exist under `root`. */
export function pathsNamed(text, root) {
  const found = [];
  for (const raw of String(text || '').split(/[\s"'`,;()[\]{}<>]+/)) {
    const tok = raw.replace(/[.:!?]+$/, '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!tok || tok.startsWith('/') || /^[a-z]:/i.test(tok) || tok.split('/').includes('..') || SKIP.test(tok)) continue;
    if (!tok.includes('/') && !/\.[A-Za-z0-9]{1,6}$/.test(tok)) continue;
    let ok = false;
    try { ok = fs.existsSync(path.join(root, tok)); } catch { ok = false; }
    if (ok && !found.includes(tok)) found.push(tok);
  }
  return found;
}

/** { lane, from: [paths] } or null. */
export function inferLaneFromText(text, root) {
  const files = pathsNamed(text, root);
  if (!files.length) return null;
  if (files.length === 1) {
    let dir = false;
    try { dir = fs.statSync(path.join(root, files[0])).isDirectory(); } catch {}
    return { lane: files[0], from: files, kind: dir ? 'folder' : 'file' };
  }
  const dirs = files.map((f) => {
    let isDir = false;
    try { isDir = fs.statSync(path.join(root, f)).isDirectory(); } catch {}
    return (isDir ? f : path.posix.dirname(f)).split('/').filter((x) => x && x !== '.');
  });
  const common = [];
  for (let i = 0; i < Math.min(...dirs.map((d) => d.length)); i += 1) {
    if (dirs.every((d) => d[i] === dirs[0][i])) common.push(dirs[0][i]); else break;
  }
  return common.length ? { lane: common.join('/'), from: files, kind: 'folder' } : null;
}
