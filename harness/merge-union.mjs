/**
 * harness/merge-union.mjs — 2.96 (c4): list files that only grow, merged as a union (engines.<x>.merge.union).
 *   unionGlobs(cfg)   the engine's merge.union globs ([] when unset)
 *   unionMerge(repo, ours, theirs, globs)   { tree, files } when ours and theirs conflict ONLY in files the globs name and,
 *     in each, both sides only added lines or lengthened a line (one run of text put into it); else null.
 *   unionWhy(repo, ours, theirs, globs)   why it is null, in one sentence naming the file and line ('' when not set).
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

/** What `to` changes in `from` (two blobs): { adds: Map(place in from (0 = before line 1) -> lines), grown: Map(line no -> { p, ins }) }, or { bad } (a line no, 0 = not text) when it removes or rewrites a line. */
function changes(repo, from, to) {
  const d = run(repo, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', from, to]);
  if (d.status !== 0) return { bad: 0 };
  const hunks = [];
  let cur = null;
  for (const l of String(d.stdout).split('\n')) {
    const m = l.startsWith('@@') && l.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (l.startsWith('@@') && !m) return { bad: 0 };
    if (m) hunks.push(cur = { s: Number(m[1]), n: m[2] === undefined ? 1 : Number(m[2]), m: m[3] === undefined ? 1 : Number(m[3]), minus: [], plus: [] });
    else if (cur && (l[0] === '-' || l[0] === '+')) (l[0] === '-' ? cur.minus : cur.plus).push(l.slice(1));
    else if (cur ? l !== '' : /^(Binary|-[^-]|\+[^+])/.test(l)) return { bad: cur ? cur.s : 0 };
  }
  const adds = new Map();
  const grown = new Map();
  for (const h of hunks) {
    if (h.n === 0) { adds.set(h.s, h.plus); continue; }
    if (h.m !== h.n || h.plus.length !== h.n || h.minus.length !== h.n) return { bad: h.s };
    for (let i = 0; i < h.n; i += 1) {
      const b = h.minus[i];
      const w = h.plus[i];
      let p = 0;
      while (p < b.length && b[p] === w[p]) p += 1;
      if (w.length <= b.length || !w.endsWith(b.slice(p))) return { bad: h.s + i };
      grown.set(h.s + i, { p, ins: w.slice(p, w.length - (b.length - p)) });
    }
  }
  return { adds, grown };
}

/** One base line that one or both sides lengthened: ours' text first, then theirs' (the same text once). */
function lengthen(line, o, t) {
  if (!o || !t) { const x = o || t; return x ? line.slice(0, x.p) + x.ins + line.slice(x.p) : line; }
  if (o.p === t.p) return line.slice(0, o.p) + o.ins + (o.ins === t.ins ? '' : t.ins) + line.slice(o.p);
  const [x, y] = o.p < t.p ? [o, t] : [t, o];
  return line.slice(0, x.p) + x.ins + line.slice(x.p, y.p) + y.ins + line.slice(y.p);
}

/** { text }: base plus both sides' added lines (ours first, a shared line once) and lengthened lines; or { bad } as in changes(). */
function unionText(repo, base, ours, theirs) {
  const text = run(repo, ['cat-file', 'blob', base]);
  if (text.status !== 0 || String(text.stdout).includes('\0')) return { bad: 0 };
  const o = changes(repo, base, ours);
  const t = o.bad === undefined ? changes(repo, base, theirs) : o;
  if (t.bad !== undefined) return t;
  const s = String(text.stdout);
  const endNl = s === '' || s.endsWith('\n');
  const lines = s === '' ? [] : (endNl ? s.slice(0, -1) : s).split('\n');
  const outLines = [];
  for (let g = 0; g <= lines.length; g += 1) {
    const mine = o.adds.get(g) || [];
    const left = new Map();
    for (const x of mine) if (/[A-Za-z0-9]/.test(x)) left.set(x, (left.get(x) || 0) + 1);
    outLines.push(...mine);
    for (const x of t.adds.get(g) || []) { if (left.get(x) > 0) left.set(x, left.get(x) - 1); else outLines.push(x); }
    if (g < lines.length) outLines.push(lengthen(lines[g], o.grown.get(g + 1), t.grown.get(g + 1)));
  }
  return { text: outLines.join('\n') + (endNl && outLines.length ? '\n' : '') };
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

/** The merge ({ tree, files }) or the reason there is none ({ why }, '' when merge.union is not set or names no conflicted file). */
function tryUnion(repo, ours, theirs, globs) {
  if (!globs.length) return { why: '' };
  const mt = run(repo, ['merge-tree', '--write-tree', '-z', ours, theirs]);
  if (mt.status !== 1) return { why: '' };
  const c = contentConflicts(mt.stdout);
  if (!c) return { why: 'a conflict is not one of file contents (a rename or a delete)' };
  const names = Object.keys(c.files);
  if (!names.some((f) => matchAny(f, globs))) return { why: '' };
  const out = names.filter((f) => !matchAny(f, globs));
  if (out.length) return { why: `${out.slice(0, 3).join(', ')} conflicts and is not listed in merge.union` };
  if (!names.length || !/^[0-9a-f]{40,64}$/.test(c.tree)) return { why: 'git gave no conflicted file' };
  const blobs = [];
  for (const f of names) {
    const v = c.files[f];
    if (!v[1] || !v[2] || !v[3] || !/^100(644|755)$/.test(v[1].mode) || v[2].mode !== v[1].mode || v[3].mode !== v[1].mode) return { why: `${f} was added, deleted or changed its mode on one side` };
    const u = unionText(repo, v[1].oid, v[2].oid, v[3].oid);
    if (u.bad !== undefined) return { why: u.bad ? `${f} line ${u.bad} was rewritten, not only lengthened` : `${f} is not plain text` };
    const h = run(repo, ['hash-object', '-w', '--stdin'], { input: Buffer.from(u.text, 'latin1') });
    if (h.status !== 0) return { why: `git could not write the merged ${f}` };
    blobs.push(`${v[1].mode},${String(h.stdout).trim()},${f}`);
  }
  const idx = path.join(os.tmpdir(), `studio-union-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.idx`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  const fail = { why: 'git could not build the merged tree' };
  try {
    if (run(repo, ['read-tree', c.tree], { env }).status !== 0) return fail;
    for (const b of blobs) if (run(repo, ['update-index', '--cacheinfo', b], { env }).status !== 0) return fail;
    const w = run(repo, ['write-tree'], { env });
    return w.status === 0 ? { tree: String(w.stdout).trim(), files: names } : fail;
  } finally { try { fs.rmSync(idx, { force: true }); } catch { /* a temp file */ } }
}

/** See the header. Every conflicted file must match a glob, be text with the same regular mode in all three versions, and only grow on both sides. */
export function unionMerge(repo, ours, theirs, globs = []) {
  const r = tryUnion(repo, ours, theirs, globs);
  return r.tree ? r : null;
}

/** Why unionMerge gave null, as one plain sentence ('' when merge.union is not set or names no conflicted file). */
export const unionWhy = (repo, ours, theirs, globs = []) => tryUnion(repo, ours, theirs, globs).why || '';
