#!/usr/bin/env node
/**
 * scripts/settings-map.mjs — 2.66.0 (d): the map of every STUDIO_* setting, and a ratchet on undocumented ones.
 *
 * About 390 STUDIO_* names are read across harness/, scripts/, hub/ and qa/, most explained only in a code comment
 * (OpenHands' settings sprawl forced its rewrite at 140+). This scans harness/, scripts/ and hub/ (their code files,
 * recursively, git hooks included) and qa/*.mjs for the names, and writes docs/SETTINGS.md: one line per name, grouped by its first word,
 * with its default (when a simple `?? x`, `|| x` or `name', x)` sits right next to it in the code), the files using
 * it, and the first docs/ page that mentions it, or "undocumented". A name ending in `_` is a family
 * (STUDIO_TIER_<x>), shown as `STUDIO_TIER_*`.
 *
 *   node scripts/settings-map.mjs                  write docs/SETTINGS.md
 *   node scripts/settings-map.mjs --check          exit 1 when a name used in the code is neither mentioned in a docs/
 *                                                  page (docs/SETTINGS.md itself doesn't count) nor listed in
 *                                                  docs/settings-baseline.json (the debt frozen on 2.66.0); the docs
 *                                                  gate (scripts/check-docs.mjs) runs it
 *   node scripts/settings-map.mjs --prune-baseline drop baseline names that are now documented or no longer used
 *   node scripts/settings-map.mjs --init-baseline  write the baseline when there is none (never adds to an existing one)
 *   --json                                         the map (or the check) as JSON
 *
 * The baseline only shrinks from here: a new setting is documented in docs/ (one line: what it does, its default)
 * in the same change, and --prune-baseline removes a name once its page exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = /STUDIO_[A-Z0-9_]+/g;
const CODE = /\.(mjs|cjs|js|ts|tsx|jsx|mts|sh|ps1|cmd|bat|py|gd)$/;
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite', '.git']);
const LIT = String.raw`(-?\d[\d_.]*(?:e\d+)?|'[^'\n]*'|"[^"\n]*"|true|false)`;
const DEFAULT_AFTER = [new RegExp(String.raw`^\s*\)?\s*(?:\?\?|\|\|)\s*${LIT}`), new RegExp(String.raw`^'\s*,\s*${LIT}\s*\)`)];
export const MAP_FILE = 'docs/SETTINGS.md';
export const BASELINE_FILE = 'docs/settings-baseline.json';

const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

function walk(dir, test, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, test, out);
    else if (e.isFile() && test(e.name)) out.push(full);
  }
  return out;
}

/** The code files scanned: harness/, scripts/, hub/ (recursive) and qa/*.mjs (top level only). Sorted. */
export function codeFiles(root = ROOT) {
  const files = [];
  for (const d of ['harness', 'scripts', 'hub']) walk(path.join(root, d), (n) => CODE.test(n) || !n.includes('.'), files); // extensionless: git hooks
  try { for (const n of fs.readdirSync(path.join(root, 'qa'))) if (n.endsWith('.mjs') && fs.statSync(path.join(root, 'qa', n)).isFile()) files.push(path.join(root, 'qa', n)); } catch {}
  return files.map((f) => rel(root, f)).sort();
}

const display = (name) => (name.endsWith('_') ? `${name}*` : name);
const isTest = (f) => /^qa\/selftest/.test(f);

/** Every name in the code: Map name → { files: [], defaults: [] } (defaults from non-test files first). */
export function scanCode(root = ROOT) {
  const names = new Map();
  for (const f of codeFiles(root)) {
    const text = read(path.join(root, f));
    for (const m of text.matchAll(NAME)) {
      const name = m[0];
      if (!names.has(name)) names.set(name, { files: [], defaults: [], testDefaults: [] });
      const e = names.get(name);
      if (!e.files.includes(f)) e.files.push(f);
      const after = text.slice(m.index + name.length, m.index + name.length + 80);
      for (const re of DEFAULT_AFTER) {
        const d = after.match(re)?.[1];
        if (d === undefined || d === "''" || d === '""') continue;
        const list = isTest(f) ? e.testDefaults : e.defaults;
        if (!list.includes(d)) list.push(d);
        break;
      }
    }
  }
  return names;
}

/** Every name mentioned in docs/ (Markdown, recursive, not the map itself): Map name → "docs/X.md:line" (the first). */
export function scanDocs(root = ROOT) {
  const seen = new Map();
  const files = walk(path.join(root, 'docs'), (n) => n.endsWith('.md')).map((f) => rel(root, f)).filter((f) => f !== MAP_FILE).sort();
  for (const f of files) {
    read(path.join(root, f)).split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(NAME)) if (!seen.has(m[0])) seen.set(m[0], `${f}:${i + 1}`);
    });
  }
  return seen;
}

/** Where the docs explain a name (a family: any doc name starting with it), or null. */
function docFor(name, docs) {
  if (docs.has(name)) return docs.get(name);
  if (name.endsWith('_')) for (const [k, v] of docs) if (k.startsWith(name)) return v;
  return null;
}

/** The map: [{ name, display, group, default, files, doc }] sorted by name. */
export function settingsMap(root = ROOT) {
  const code = scanCode(root);
  const docs = scanDocs(root);
  const rows = [...code.entries()].map(([name, e]) => {
    const defs = e.defaults.length ? e.defaults : e.testDefaults;
    return { name, display: display(name), group: name.slice(7).split('_')[0] || 'OTHER', default: defs[0] ?? null, otherDefaults: defs.slice(1), files: [...e.files.filter((f) => !isTest(f)), ...e.files.filter(isTest)], doc: docFor(name, docs) };
  }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const counts = new Map();
  for (const r of rows) counts.set(r.group, (counts.get(r.group) || 0) + 1);
  for (const r of rows) if (counts.get(r.group) < 2) r.group = 'OTHER';
  return rows;
}

/** docs/SETTINGS.md's text for a map. Deterministic (no date), so a rerun with no change writes the same bytes. */
export function renderMap(rows) {
  const undocumented = rows.filter((r) => !r.doc).length;
  const groups = new Map();
  for (const r of rows) { if (!groups.has(r.group)) groups.set(r.group, []); groups.get(r.group).push(r); }
  const order = [...groups.keys()].filter((g) => g !== 'OTHER').sort();
  if (groups.has('OTHER')) order.push('OTHER');
  const lines = [
    '<!-- Generated by `node scripts/settings-map.mjs` from the code. Do not edit by hand: rerun it. -->',
    '# Settings map (`STUDIO_*`)',
    '',
    `Every \`STUDIO_*\` name the harness reads (harness/, scripts/, hub/, qa/*.mjs): ${rows.length} names, ${rows.length - undocumented} documented in docs/, ${undocumented} undocumented.`,
    'Each line: the name, its default when the code shows a simple one, the files that use it, and the first docs/ page that explains it.',
    'A name ending in `*` is a family (one setting per suffix). Undocumented names from before 2.66.0 are frozen in',
    '`docs/settings-baseline.json`; a new undocumented one fails `node scripts/settings-map.mjs --check` (the docs gate runs it).',
    'To document one: describe it (what it does, its default) on the docs/ page for its area, then rerun this script.',
    '',
  ];
  for (const g of order) {
    lines.push(`## ${g === 'OTHER' ? 'Other' : `${g}_*`} (${groups.get(g).length})`, '');
    for (const r of groups.get(g)) {
      const def = r.default === null ? 'no simple default' : `default \`${r.default}\`${r.otherDefaults.length ? ` (also \`${r.otherDefaults.join('`, `')}\`)` : ''}`;
      const where = r.files.slice(0, 3).join(', ') + (r.files.length > 3 ? ` (+${r.files.length - 3} more)` : '');
      let doc = 'undocumented';
      if (r.doc) { const [file, line] = r.doc.split(':'); doc = `[${file.replace(/^docs\//, '')}:${line}](${file.replace(/^docs\//, '')})`; }
      lines.push(`- \`${r.display}\` · ${def} · ${where} · ${doc}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function readBaseline(root = ROOT) {
  try { const j = JSON.parse(fs.readFileSync(path.join(root, BASELINE_FILE), 'utf8')); return Array.isArray(j.undocumented) ? j.undocumented.map(String) : []; } catch { return null; }
}

function writeBaseline(root, names) {
  const body = {
    note: 'STUDIO_* names used in the code and undocumented in docs/ when 2.66.0 froze the debt. This list only shrinks: document a name in docs/ and run node scripts/settings-map.mjs --prune-baseline. A new name is documented in the same change instead of being added here.',
    undocumented: [...new Set(names)].sort(),
  };
  fs.writeFileSync(path.join(root, BASELINE_FILE), `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * The ratchet: { ok, missing: [{ name, files }], prunable: [names], baseline: n|null, stale: bool }. missing = used in
 * the code, not mentioned in docs/, not in the baseline. stale = docs/SETTINGS.md differs from a fresh map (a note).
 */
export function checkSettings(root = ROOT) {
  const rows = settingsMap(root);
  const baseline = readBaseline(root);
  const base = new Set(baseline || []);
  const missing = rows.filter((r) => !r.doc && !base.has(r.name)).map((r) => ({ name: r.display, files: r.files }));
  const used = new Map(rows.map((r) => [r.name, r]));
  const prunable = [...base].filter((n) => !used.has(n) || used.get(n).doc).sort();
  const stale = read(path.join(root, MAP_FILE)) !== renderMap(rows);
  return { ok: missing.length === 0, missing, prunable, baseline: baseline ? baseline.length : null, names: rows.length, stale };
}

/** The lines check-docs (or the CLI) prints for a failing check. */
export function checkLines(c) {
  const out = [`[settings] FAIL ${c.missing.length} STUDIO_* setting(s) used in the code but not documented in docs/${c.baseline === null ? ` (no ${BASELINE_FILE})` : ''}:`];
  for (const m of c.missing.slice(0, 20)) out.push(`  ${m.name} (${m.files.slice(0, 3).join(', ')}${m.files.length > 3 ? ', …' : ''})`);
  if (c.missing.length > 20) out.push(`  … and ${c.missing.length - 20} more`);
  out.push('[settings] Fix: describe each on the docs/ page for its area (what it does, its default), then run node scripts/settings-map.mjs to refresh docs/SETTINGS.md');
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = process.argv.slice(2);
  const json = a.includes('--json');
  if (a.includes('--check')) {
    const c = checkSettings();
    if (json) console.log(JSON.stringify(c));
    else if (!c.ok) for (const l of checkLines(c)) console.error(l);
    else console.log(`[settings] PASS ${c.names} STUDIO_* names: each documented in docs/ or frozen in ${BASELINE_FILE}${c.prunable.length ? `; ${c.prunable.length} baseline name(s) can go (--prune-baseline)` : ''}${c.stale ? '; note: docs/SETTINGS.md is out of date (node scripts/settings-map.mjs)' : ''}`);
    process.exit(c.ok ? 0 : 1);
  }
  if (a.includes('--init-baseline')) {
    if (readBaseline() !== null) { console.error(`[settings] ${BASELINE_FILE} exists; it only shrinks (--prune-baseline). Document a new setting instead.`); process.exit(1); }
    const names = settingsMap().filter((r) => !r.doc).map((r) => r.name);
    writeBaseline(ROOT, names);
    console.log(`[settings] wrote ${BASELINE_FILE}: ${names.length} undocumented name(s) frozen`);
    process.exit(0);
  }
  if (a.includes('--prune-baseline')) {
    const base = readBaseline();
    if (base === null) { console.error(`[settings] no ${BASELINE_FILE}`); process.exit(1); }
    const { prunable } = checkSettings();
    writeBaseline(ROOT, base.filter((n) => !prunable.includes(n)));
    console.log(`[settings] ${BASELINE_FILE}: removed ${prunable.length} name(s)${prunable.length ? `: ${prunable.join(', ')}` : ''}`);
    process.exit(0);
  }
  const rows = settingsMap();
  if (json) { console.log(JSON.stringify(rows)); process.exit(0); }
  fs.writeFileSync(path.join(ROOT, MAP_FILE), renderMap(rows));
  console.log(`[settings] wrote ${MAP_FILE}: ${rows.length} names, ${rows.filter((r) => !r.doc).length} undocumented`);
}
