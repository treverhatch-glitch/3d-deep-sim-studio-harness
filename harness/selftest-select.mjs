/**
 * harness/selftest-select.mjs — which self-test units run: `--only <patterns>` and `--changed [ref]`.
 *
 * The self-test (qa/selftest.mjs) is ~290 units, an hour in one process. A developer editing one module needs the
 * units that exercise it, not the hour; the full run stays the default and is what CI runs.
 *
 *   --only a,b      run the units whose label, line (L1234 or 1234), group or source block mentions a pattern
 *                   (case-insensitive; `230h` matches the block that imports qa/selftest-230h.mjs)
 *   --changed [ref] run the units affected by the files changed since `ref` (default: the merge base with
 *                   origin/main, else HEAD~1), committed or not: a unit whose block mentions a changed file (its
 *                   path or basename) or a test file that names it (with --deep: also one hop through the modules
 *                   that import it), a unit whose block has a diff hunk, every
 *                   unit when a shared file changed (package.json, studio/gates.json, the fixture, the runner's
 *                   preamble)
 *
 * A unit's block is the text from its `inShard(` line to the one before the next; a sabotage unit's text is its
 * label plus the gate's command. Pure functions plus `buildSelection` (reads the repo); nothing here asserts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * The `inShard(` call lines of the runner's source, in file order: { line, start, end }. A block runs from the
 * comment lines above its call (`start`: they describe it) to the line before the next block's comment (`end`).
 */
export function unitBlocks(source) {
  const lines = String(source).split('\n');
  const calls = [];
  lines.forEach((l, i) => { if (/\binShard\(/.test(l) && !/function inShard|^\s*(\/\/|\*)/.test(l)) calls.push(i + 1); });
  const isComment = (i) => /^\s*(\/\/|\/\*|\*|$)/.test(lines[i - 1] || '');
  const starts = calls.map((line) => { let s = line; while (s > 1 && isComment(s - 1)) s -= 1; return s; });
  return calls.map((line, k) => ({ line, start: starts[k], end: k + 1 < calls.length ? starts[k + 1] - 1 : lines.length }));
}

/** The block text (source lines) of the unit whose call is at `line`; '' when no block starts there. */
export function blockText(source, blocks, line) {
  const b = blocks.find((x) => x.line === line);
  if (!b) return '';
  return String(source).split('\n').slice(b.start - 1, b.end).join('\n');
}

/** Does a `--only` pattern pick this unit? label/group substring, its line, or a mention in its block text. */
export function matchesOnly(unit, text, patterns) {
  const pats = (patterns || []).map((p) => String(p).trim()).filter(Boolean);
  if (!pats.length) return false;
  const label = String(unit.label || '').toLowerCase();
  const group = String(unit.group || '').toLowerCase();
  const low = String(text || '').toLowerCase();
  return pats.some((p) => {
    const q = p.toLowerCase();
    const n = /^l?(\d+)$/i.exec(q);
    if (n && Number(n[1]) === unit.line) return true;
    if (label.includes(q) || (group && group === q)) return true;
    return low.includes(`selftest-${q}.mjs`) || low.includes(q);
  });
}

/** `@@ -a,b +c,d @@` → the new-side ranges [{ from, to }] of a unified diff. */
export function diffHunks(diff) {
  const out = [];
  for (const m of String(diff || '').matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const from = Number(m[1]);
    const len = m[2] === undefined ? 1 : Number(m[2]);
    out.push({ from, to: from + Math.max(len, 1) - 1 });
  }
  return out;
}

/** Does `text` name `name` as a whole file name? (2.81: `ask.mjs` is not a mention inside `task.mjs`.) */
export function mentions(text, name) {
  const s = String(text); const n = String(name);
  for (let i = s.indexOf(n); i >= 0; i = s.indexOf(n, i + 1)) if (i === 0 || !/[\w-]/.test(s[i - 1])) return true;
  return false;
}

/** Files that mention a changed file's basename (one hop), so a unit testing the importer's command still runs. */
export function importersOf(root, files, dirs = ['harness', 'scripts', 'qa', 'tools']) {
  const bases = [...new Set(files.map((f) => path.basename(f)).filter((b) => !GENERIC.has(b) && /\.(mjs|js|cjs|json|py)$/.test(b)))];
  if (!bases.length) return [];
  const out = new Set();
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/^(node_modules|dist|\.git|fixtures|golden|regressions|reports)$/.test(e.name)) walk(p); continue; }
      if (!/\.(mjs|js|cjs|py)$/.test(e.name)) continue;
      const rel = path.relative(root, p).replace(/\\/g, '/');
      if (files.includes(rel)) continue;
      let s = '';
      try { s = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (bases.some((b) => mentions(s, b))) out.add(rel);
    }
  };
  for (const d of dirs) walk(path.join(root, d));
  return [...out].sort();
}

/** Basenames too common to identify a module (a mention of them says nothing about what changed). */
export const GENERIC = new Set(['index.mjs', 'index.js', 'index.html', 'qa.mjs', 'package.json', 'README.md', 'main.mjs', 'config.json', 'test.mjs', 'server.mjs']);
/** A change here can move any unit: the whole self-test runs. */
export const SHARED = ['package.json', 'package-lock.json', 'studio/gates.json', 'qa/fixtures/', 'harness/selftest-timing.mjs', 'harness/selftest-select.mjs'];

/** The names a unit's text is searched for: each changed or importing file's path and (when telling) basename. */
export function changeNames(files) {
  const names = new Set();
  for (const f of files) {
    const rel = String(f).replace(/\\/g, '/');
    names.add(rel);
    const b = path.basename(rel);
    if (!GENERIC.has(b) && b.includes('.')) names.add(b);
  }
  return [...names];
}

/**
 * Is a unit affected? Its text mentions a name, or (for the runner's own diff) its block overlaps a hunk.
 * `hunks` are the runner's (qa/selftest.mjs) new-side ranges; `block` is { line, end } or null.
 */
export function affectedByChange(unit, text, names, hunks = [], block = null) {
  if (block && hunks.some((h) => h.from <= block.end && h.to >= (block.start || block.line))) return true;
  const low = String(text || '');
  return (names || []).some((n) => mentions(low, n));
}

/** The changed files since `ref` (committed and not) plus untracked ones; also the runner's own hunks. */
export function changedFiles(root, ref = null) {
  const git = (args) => spawnSync('git', args, { windowsHide: true, cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let base = ref;
  if (!base) {
    const mb = git(['merge-base', 'HEAD', 'origin/main']);
    base = mb.status === 0 && /^[0-9a-f]{40}/.test(mb.stdout) ? mb.stdout.trim() : 'HEAD~1';
    if (base === 'HEAD~1' && git(['rev-parse', '--verify', '-q', 'HEAD~1']).status !== 0) base = 'HEAD';
  }
  const files = new Set();
  for (const l of String(git(['diff', '--name-only', base]).stdout || '').split('\n')) if (l.trim()) files.add(l.trim().replace(/\\/g, '/'));
  for (const l of String(git(['ls-files', '--others', '--exclude-standard']).stdout || '').split('\n')) if (l.trim()) files.add(l.trim().replace(/\\/g, '/'));
  const hunks = diffHunks(git(['diff', '-U0', base, '--', 'qa/selftest.mjs']).stdout);
  return { base, files: [...files].sort(), hunks };
}

/**
 * The selection for a run: { kind, describe, runs(unit) }. `source` is the runner's text; `extraText(unit)` adds
 * what the block cannot show (a sabotage unit's gate command). `firstUnitLine` is where the runner's preamble ends.
 */
export function buildSelection(root, { only = null, changed = null, deep = false, source, extraText = () => '' } = {}) {
  const blocks = unitBlocks(source);
  const text = (u) => `${u.label || ''}\n${blockText(source, blocks, u.line)}\n${extraText(u) || ''}`;
  if (only !== null) {
    const patterns = String(only).split(',').map((s) => s.trim()).filter(Boolean);
    return { kind: 'only', describe: `--only ${patterns.join(',')}`, runs: (u) => matchesOnly(u, text(u), patterns) };
  }
  const ch = changedFiles(root, changed && !String(changed).startsWith('--') ? String(changed) : null);
  const firstUnit = blocks[0]?.line || 1;
  const shared = ch.files.filter((f) => SHARED.some((s) => (s.endsWith('/') ? f.startsWith(s) : f === s)));
  const preamble = ch.hunks.some((h) => h.from < firstUnit);
  const all = shared.length > 0 || preamble;
  // 2.81: by default only the test files that name a changed file count (a change to harness/lock.mjs: 9 units); --deep
  // also follows one hop through the harness modules that import it (98 units), which is most of the corpus for a
  // widely used module. The full run on CI is the net either way.
  const importers = all ? [] : importersOf(root, ch.files, deep ? undefined : ['qa']);
  const names = changeNames([...ch.files, ...importers]);
  const why = all ? `${shared[0] || 'the runner preamble'} changed: every unit runs` : `${ch.files.length} changed file(s), ${importers.length} importer(s)`;
  return {
    kind: 'changed',
    base: ch.base,
    files: ch.files,
    importers,
    all,
    describe: `--changed (since ${ch.base.slice(0, 12)}; ${why})`,
    runs: (u) => all || affectedByChange(u, text(u), names, ch.hunks, blocks.find((b) => b.line === u.line) || null),
  };
}
