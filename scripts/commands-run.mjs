#!/usr/bin/env node
/**
 * scripts/commands-run.mjs — 2.84: which harness commands this studio has run, and which it never has.
 *
 *   npm run commands-run [-- --json]
 *
 * Reads the monthly marker files harness/event.mjs makes (.studio/usage/<YYYY-MM>/<script>~<word>). Lists the commands
 * run in each month on record, then every harness/ and scripts/ file that can be run as a command and has no marker at
 * all, with its npm script names and line count. A marker is made when a command writes its first event, so a command
 * that only reads (a status page, --help) leaves none, and a file never run as a command may still be used by import:
 * this page judges commands that change something, not modules. Evidence for cutting a feature starts at a month of markers from a live studio.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR } from '../harness/event.mjs';

/** { months: { 'YYYY-MM': { 'harness/task': ['add', 'done', …] } }, since } from the marker files. */
export function usageMarks(stateDir = STUDIO_STATE_DIR) {
  const months = {};
  let names = [];
  try { names = fs.readdirSync(path.join(stateDir, 'usage')).filter((n) => /^\d{4}-\d{2}$/.test(n)).sort(); } catch { names = []; }
  for (const mo of names) {
    const by = {};
    let files = [];
    try { files = fs.readdirSync(path.join(stateDir, 'usage', mo)); } catch { files = []; }
    for (const f of files) {
      const m = /^(harness|scripts)-(.+)~([a-z0-9_-]+)$/.exec(f);
      if (!m) continue;
      const key = `${m[1]}/${m[2]}`;
      (by[key] ||= []).push(m[3]);
    }
    for (const k of Object.keys(by)) by[k].sort();
    months[mo] = by;
  }
  return { months, since: names[0] || null };
}

/** Every harness/ and scripts/ file with a command-line part: [{ file, key, lines, npm: [names] }]. */
export function commandFiles(root = REPO_ROOT) {
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {}; } catch { pkg = {}; }
  const out = [];
  for (const dir of ['harness', 'scripts']) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith('.mjs')).sort(); } catch { names = []; }
    for (const n of names) {
      let src = '';
      try { src = fs.readFileSync(path.join(root, dir, n), 'utf8'); } catch { continue; }
      if (!/process\.argv\[1\]/.test(src)) continue;
      const rel = `${dir}/${n}`;
      const npm = Object.entries(pkg).filter(([, cmd]) => new RegExp(`(^|[\\s/])${rel.replace(/[.]/g, '\\.')}(\\s|$)`).test(String(cmd))).map(([k]) => k);
      out.push({ file: rel, key: rel.replace(/\.mjs$/, ''), lines: src.split('\n').length, npm });
    }
  }
  return out;
}

/** The report as data: { since, months, used: [key], never: [{ file, lines, npm }] }. */
export function usageReport({ root = REPO_ROOT, stateDir = STUDIO_STATE_DIR } = {}) {
  const marks = usageMarks(stateDir);
  const used = new Set(Object.values(marks.months).flatMap((by) => Object.keys(by)));
  const files = commandFiles(root);
  return { since: marks.since, months: marks.months, used: [...used].sort(), never: files.filter((f) => !used.has(f.key)).sort((a, b) => b.lines - a.lines) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const r = usageReport();
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r)); process.exit(0); }
  if (!r.since) { console.log('No usage markers yet (.studio/usage/): they are made as commands run, from 2.84 on.'); process.exit(0); }
  console.log(`Commands run in this studio, by month (markers since ${r.since}):`);
  for (const [mo, by] of Object.entries(r.months)) console.log(`  ${mo}: ${Object.keys(by).length} command file(s): ${Object.entries(by).map(([k, w]) => `${k.replace(/^harness\//, '')}${w.filter((x) => x !== '_').length ? ` (${w.filter((x) => x !== '_').join(', ')})` : ''}`).join('; ')}`);
  console.log(`\nNever run as a command since ${r.since} (${r.never.length} file(s), ${r.never.reduce((n, f) => n + f.lines, 0)} lines; a file may still be used by import):`);
  for (const f of r.never) console.log(`  ${f.file}  ${f.lines} lines${f.npm.length ? `  npm run ${f.npm.join(', ')}` : ''}`);
}
