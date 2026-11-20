/**
 * harness/merge-union.mjs — 2.96 (c4): list files that only grow, merged as a union (engines.<x>.merge.union).
 *   unionGlobs(cfg)   the engine's merge.union globs ([] when unset)
 *   unionMerge(repo, ours, theirs, globs)   { tree, files } when ours and theirs conflict ONLY in files the globs name and,
 *     in each, both sides only added lines to the merge base's file; else null (the merge stays a conflict).
 * The merged file: at each place in the base, ours' added lines, then theirs'; a line theirs adds there that ours added
 * too is kept once (a line with no letter or digit, such as "}," is always kept). What it cannot know: two lanes adding
 * the same key with different values both stay; the compile check and the tests decide. Blobs and a temporary index
 * only, never a worktree. Text is read as latin1, so every byte goes back as it came.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { matchAny } from './merge-lane.mjs';

const run = (repo, args, extra = {}) => spawnSync('git', args, { cwd: repo, encoding: 'latin1', maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...extra });

/** engines.<x>.merge.union: the globs, as repo-relative paths with forward slashes. */
export function unionGlobs(cfg) {
  const u = cfg?.merge?.union;
  return Array.isArray(u) ? u.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().replace(/\\/g, '/')) : [];
}

/** The lines `to` adds to `from` (two blobs), by place in `from` (0 = before its first line); null when it removes or changes one. */
function addedLines(repo, from, to) {
  const d = run(repo, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', from, to]);
  if (d.status !== 0) return null;
  const at = new Map();
  let cur = null;
  for (const l of String(d.stdout).split('\n')) {
    if (l.startsWith('@@')) {
      const m = l.match(/^@@ -(\d+),0 \+\d+(?:,\d+)? @@/);
      if (!m) return null;
      cur = [];
      at.set(Number(m[1]), cur);
    } else if (cur && l.startsWith('+')) cur.push(l.slice(1));
    else if (cur && l !== '') return null;
    else if (!cur && /^(Binary|-[^-]|\+[^+])/.test(l)) return null;
  }
  return at;
}

/** Base plus both sides' added lines (ours first, a shared line once); null when a side does more than add lines. */
function unionText(repo, base, ours, theirs) {
  const text = run(repo, ['cat-file', 'blob', base]);
  if (text.status !== 0 || String(text.stdout).includes('\0')) return null;
  const o = addedLines(repo, base, ours);
  const t = o && addedLines(repo, base, theirs);
  if (!t) return null;
  const s = String(text.stdout);
  const endNl = s === '' || s.endsWith('\n');
  const lines = s === '' ? [] : (endNl ? s.slice(0, -1) : s).split('\n');
  const outLines = [];
  for (let g = 0; g <= lines.length; g += 1) {
    const mine = o.get(g) || [];
    const left = new Map();
    for (const x of mine) if (/[A-Za-z0-9]/.test(x)) left.set(x, (left.get(x) || 0) + 1);
    outLines.push(...mine);
    for (const x of t.get(g) || []) { if (left.get(x) > 0) left.set(x, left.get(x) - 1); else outLines.push(x); }
    if (g < lines.length) outLines.push(lines[g]);
  }
  return outLines.join('\n') + (endNl && outLines.length ? '\n' : '');
}

/** git merge-tree -z's conflicted files ({ path: { 1, 2, 3: { mode, oid } } }), or null when a conflict is not one of contents. */
function contentConflicts(stdout) {
  const p = String(stdout).split('\0');
  const files = {};
  let i = 1;
  for (; i < p.length && p[i] !== ''; i += 1) {
    const m = p[i].match(/^(\d{6}) ([0-9a-f]+) ([123])\t([\s\S]+)$/);
    if (!m) return null;
    (files[m[4]] ||= {})[m[3]] = { mode: m[1], oid: m[2] };
  }
  for (i += 1; i < p.length && p[i] !== '';) {
    const n = Number(p[i]);
    if (!Number.isInteger(n) || n < 1) return null;
    const type = p[i + n + 1] || '';
    if (/^CONFLICT/.test(type) && type !== 'CONFLICT (contents)') return null;
    i += n + 3;
  }
  return { tree: p[0].trim(), files };
}

/** See the header. Every conflicted file must match a glob, be text with the same regular mode in all three versions, and only grow on both sides. */
export function unionMerge(repo, ours, theirs, globs = []) {
  if (!globs.length) return null;
  const mt = run(repo, ['merge-tree', '--write-tree', '-z', ours, theirs]);
  if (mt.status !== 1) return null;
  const c = contentConflicts(mt.stdout);
  const names = c ? Object.keys(c.files) : [];
  if (!names.length || !/^[0-9a-f]{40,64}$/.test(c.tree) || !names.every((f) => matchAny(f, globs))) return null;
  const blobs = [];
  for (const f of names) {
    const v = c.files[f];
    if (!v[1] || !v[2] || !v[3] || !/^100(644|755)$/.test(v[1].mode) || v[2].mode !== v[1].mode || v[3].mode !== v[1].mode) return null;
    const merged = unionText(repo, v[1].oid, v[2].oid, v[3].oid);
    if (merged === null) return null;
    const h = run(repo, ['hash-object', '-w', '--stdin'], { input: Buffer.from(merged, 'latin1') });
    if (h.status !== 0) return null;
    blobs.push(`${v[1].mode},${String(h.stdout).trim()},${f}`);
  }
  const idx = path.join(os.tmpdir(), `studio-union-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.idx`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    if (run(repo, ['read-tree', c.tree], { env }).status !== 0) return null;
    for (const b of blobs) if (run(repo, ['update-index', '--cacheinfo', b], { env }).status !== 0) return null;
    const w = run(repo, ['write-tree'], { env });
    return w.status === 0 ? { tree: String(w.stdout).trim(), files: names } : null;
  } finally { try { fs.rmSync(idx, { force: true }); } catch { /* a temp file */ } }
}
