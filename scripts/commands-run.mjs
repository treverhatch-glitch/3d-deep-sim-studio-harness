#!/usr/bin/env node
/**
 * scripts/commands-run.mjs — 2.84: which harness commands this studio has run, and which it never has.
 *
 *   npm run commands-run [-- --json]
 *   npm run commands-run -- --functions [--all] [--json]   which functions ran (harness/usage-functions.mjs)
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
import { functionsFile, readFunctions } from '../harness/usage-functions.mjs';

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

/**
 * Which functions of harness/ and scripts/ ran, from the record harness/usage-functions.mjs keeps for this version:
 * { version, since, files: [{ file, lines, functions, ran, neverLines, never: [{ name, line, lines }] }], totals }.
 * A function ran when a recorded start lies in its header (from its first token to its body). neverLines counts each
 * line once, so a function inside one that never ran adds nothing. ts: the TypeScript module (the parser).
 */
export function functionsReport(ts, { root = REPO_ROOT, stateDir = STUDIO_STATE_DIR } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const file = functionsFile(stateDir, version);
  const rows = readFunctions(file);
  let since = null; try { const st = fs.statSync(file); since = new Date(st.birthtimeMs > 1e12 ? st.birthtimeMs : st.mtimeMs).toISOString().slice(0, 10); } catch { since = null; }
  const starts = new Map();
  for (const r of rows) (starts.get(r.file) || starts.set(r.file, []).get(r.file)).push(r.offset);
  const files = [];
  for (const dir of ['harness', 'scripts']) {
    let names = []; try { names = fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith('.mjs')).sort(); } catch { names = []; }
    for (const n of names) {
      const rel = `${dir}/${n}`;
      let src = ''; try { src = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
      const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
      const hits = starts.get(rel) || [];
      const fns = []; const dead = new Set();
      const visit = (node) => {
        if (ts.isFunctionLike(node) && node.body) {
          const from = node.getStart(sf); const to = node.body.getStart(sf);
          const ran = hits.some((o) => o >= from && o <= to);
          const first = lineOf(from); const last = lineOf(node.end);
          if (!ran) for (let l = first; l <= last; l++) dead.add(l);
          fns.push({ name: node.name?.getText(sf) || (node.parent?.name?.getText ? node.parent.name.getText(sf) : ''), line: first, lines: last - first + 1, ran });
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      files.push({ file: rel, lines: src.split('\n').length, loaded: hits.length > 0, functions: fns.length, ran: fns.filter((f) => f.ran).length, neverLines: dead.size, never: fns.filter((f) => !f.ran).map(({ name, line, lines }) => ({ name, line, lines })) });
    }
  }
  const sum = (k) => files.reduce((x, f) => x + f[k], 0);
  return { version, since, rows: rows.length, files, totals: { files: files.length, loaded: files.filter((f) => f.loaded).length, lines: sum('lines'), functions: sum('functions'), ran: sum('ran'), neverLines: sum('neverLines') } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) && process.argv.includes('--functions')) {
  let ts = null;
  try { ts = (await import('typescript')).default; } catch { console.error('[commands-run] typescript is not installed (npm ci): the functions page needs its parser.'); process.exit(2); }
  const r = functionsReport(ts);
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r)); process.exit(0); }
  if (!r.rows) { console.log(`No functions on record for ${r.version} yet (.studio/usage/functions/): they are recorded as commands run, from 2.89 on (STUDIO_USAGE_FUNCTIONS=off turns it off).`); process.exit(0); }
  const t = r.totals;
  console.log(`Functions run in this studio on ${r.version} (on record since ${r.since}): ${t.ran} of ${t.functions} in ${t.loaded} of ${t.files} file(s).`);
  console.log(`Lines inside functions that never ran: ${t.neverLines} of ${t.lines} (${(100 * t.neverLines / Math.max(1, t.lines)).toFixed(1)}%). A record of days, not proof: a rare path (a restore, a new studio's setup) runs rarely.`);
  console.log('\nFiles, most never-run lines first (file: functions run of all, never-run lines of lines):');
  for (const f of [...r.files].sort((a, b) => b.neverLines - a.neverLines).slice(0, process.argv.includes('--all') ? r.files.length : 40)) console.log(`  ${f.file}: ${f.ran} of ${f.functions}, ${f.neverLines} of ${f.lines}${f.loaded ? '' : '  (never loaded)'}`);
  process.exit(0);
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
