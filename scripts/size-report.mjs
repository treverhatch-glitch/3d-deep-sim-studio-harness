#!/usr/bin/env node
/**
 * scripts/size-report.mjs — 2.79 (a), PU-68: how big the harness is, in numbers. Measurement only: nothing is gated.
 *
 *   node scripts/size-report.mjs [--json] [--against <git ref>]
 *
 * Modules and lines in harness/, scripts/ (code files, recursive), the 15 largest harness modules, qa/ selftest
 * files (qa/selftest*.mjs) and lines, test units (`node qa/selftest.mjs --list-shards 1000`), docs/ pages, and the
 * STUDIO_* settings count (scripts/settings-map.mjs's scan). With --against, the same numbers at that ref (read with
 * `git archive`, nothing checked out) and the delta per number. No test is run; about a second.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scanCode } from './settings-map.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = /\.(mjs|cjs|js|ts|tsx|jsx|mts)$/;
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite', '.git']);

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

/** Lines of a file: its newline count, plus one when the last line has no newline. */
export function lineCount(file) {
  let t = '';
  try { t = fs.readFileSync(file, 'utf8'); } catch { return 0; }
  if (!t) return 0;
  let n = 0;
  for (let i = t.indexOf('\n'); i >= 0; i = t.indexOf('\n', i + 1)) n++;
  return t.endsWith('\n') ? n : n + 1;
}

const area = (root, dir, test = (n) => CODE.test(n)) => walk(path.join(root, dir), test).map((f) => ({ file: path.relative(root, f).split(path.sep).join('/'), lines: lineCount(f) }));
const sum = (list) => list.reduce((a, f) => a + f.lines, 0);

export function testUnits(root) {
  const r = spawnSync(process.execPath, ['qa/selftest.mjs', '--list-shards', '1000'], { windowsHide: true, cwd: root, encoding: 'utf8', timeout: 60000 });
  try { return JSON.parse(String(r.stdout).trim().split('\n').pop()).units.length; } catch { return null; }
}

export function measure(root = ROOT) {
  const harness = area(root, 'harness');
  const scripts = area(root, 'scripts');
  let qaFiles = [];
  try { qaFiles = fs.readdirSync(path.join(root, 'qa')).filter((n) => /^selftest.*\.mjs$/.test(n)).map((n) => ({ file: `qa/${n}`, lines: lineCount(path.join(root, 'qa', n)) })); } catch {}
  const docs = walk(path.join(root, 'docs'), (n) => n.endsWith('.md')).length;
  return {
    harness: { modules: harness.length, lines: sum(harness), largest: [...harness].sort((a, b) => b.lines - a.lines || (a.file < b.file ? -1 : 1)).slice(0, 15) },
    scripts: { modules: scripts.length, lines: sum(scripts) },
    qa: { selftestFiles: qaFiles.length, selftestLines: sum(qaFiles) },
    testUnits: testUnits(root),
    docs,
    settings: scanCode(root).size,
  };
}

/** The measure at a git ref (via git archive into a temp dir), or null when the ref can't be read. */
export function measureAt(ref, root = ROOT) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'size-report-'));
  try {
    const tar = path.join(tmp, 'a.tar');
    const g = spawnSync('git', ['archive', '-o', tar, ref], { windowsHide: true, cwd: root, encoding: 'utf8' });
    if (g.status !== 0) return null;
    const dir = path.join(tmp, 'tree');
    fs.mkdirSync(dir);
    const x = spawnSync('tar', ['-xf', tar, '-C', dir], { windowsHide: true, encoding: 'utf8' });
    if (x.status !== 0) return null;
    return measure(dir);
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
}

const FLAT = [['harness modules', (m) => m.harness.modules], ['harness lines', (m) => m.harness.lines], ['scripts modules', (m) => m.scripts.modules], ['scripts lines', (m) => m.scripts.lines], ['qa selftest files', (m) => m.qa.selftestFiles], ['qa selftest lines', (m) => m.qa.selftestLines], ['test units', (m) => m.testUnits], ['docs pages', (m) => m.docs], ['STUDIO_* settings', (m) => m.settings]];
export function deltas(now, was) {
  return FLAT.map(([label, f]) => ({ label, now: f(now), was: f(was), delta: f(now) === null || f(was) === null ? null : f(now) - f(was) }));
}

export function renderSize(m, against, ref) {
  const out = ['Size report (no tests run)', ''];
  const d = against ? new Map(deltas(m, against).map((x) => [x.label, x])) : null;
  for (const [label, f] of FLAT) {
    const x = d?.get(label);
    out.push(`${label.padEnd(20)} ${String(f(m)).padStart(8)}${x ? `   was ${String(x.was).padStart(8)} at ${ref}   ${x.delta === null ? 'n/a' : (x.delta >= 0 ? '+' : '') + x.delta}` : ''}`);
  }
  out.push('', '15 largest harness modules:');
  const was = against ? new Map(against.harness.largest.map((f) => [f.file, f.lines])) : null;
  m.harness.largest.forEach((f, i) => out.push(`${String(i + 1).padStart(3)}. ${String(f.lines).padStart(6)}  ${f.file}${was && was.has(f.file) ? `  (${f.lines - was.get(f.file) >= 0 ? '+' : ''}${f.lines - was.get(f.file)})` : ''}`));
  return out.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = process.argv.slice(2);
  const i = a.indexOf('--against');
  const ref = i >= 0 ? a[i + 1] : null;
  const m = measure();
  let was = null;
  if (ref) { was = measureAt(ref); if (!was) { console.error(`[size] cannot read git ref ${ref}`); process.exit(1); } }
  console.log(a.includes('--json') ? JSON.stringify({ ref, now: m, was, deltas: was ? deltas(m, was) : null }) : renderSize(m, was, ref));
}
