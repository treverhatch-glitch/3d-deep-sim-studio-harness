#!/usr/bin/env node
/**
 * harness/rules-times.mjs — what the rules tests cost. engines.<x>.rules.times is a result file (a glob in the test
 * checkout) the test command writes with a time per test: .trx, NUnit or JUnit XML. After each rules command the slowest
 * tests are kept for 48 hours (.studio/engine/<x>-times.json). The daily digest gets a short block:
 *   npm run engine -- test-cost [--engine <x>]   the long form: the 10 slowest tests and their share of the test time,
 *   tests that ran more than once in one train, the shards that took most memory, hand-backs of kind ratchet today
 * Only files written since the command started are read, so a file left by an earlier run is never counted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './event.mjs';
import { enginesConfig } from './engine-tracks.mjs';
import { globRe } from './merge-lane.mjs';
import { readJson, writeAtomic } from './fsafe.mjs';
import { ramFile } from './engine-ram.mjs';
import { kindCost, shortText } from './run-cost.mjs';
import { flagOf } from './helpers.mjs';

const DAY = 86400000;
const KEEP_TESTS = 200;
const MAX_FILE = 64 * 1024 * 1024;
const timesFile = (root, engine) => path.join(root, '.studio', 'engine', `${engine}-times.json`);
const relOk = (s) => Boolean(s) && !s.startsWith('/') && !/^[A-Za-z]:/.test(s) && !s.split('/').includes('..');
const unxml = (s) => String(s).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? unxml(m[1]) : ''; };
const secs = (v) => { const m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(v); return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(v); };

/** engines.<x>.rules.times: a path or glob inside the test checkout, or ''. */
export function timesConfig(root, engine) {
  const v = enginesConfig(root)[engine]?.rules?.times;
  const f = typeof v === 'string' ? v.trim().replace(/\\/g, '/') : '';
  return relOk(f) ? f : '';
}

/** [{ name, seconds }] from .trx, NUnit or JUnit text. Small regexes, no XML library. */
export function parseTimes(text) {
  const t = String(text || '').replace(/\r\n?/g, '\n');
  const out = [];
  const add = (name, v) => { const s = secs(v); if (name && Number.isFinite(s) && s >= 0) out.push({ name, seconds: Math.round(s * 1000) / 1000 }); };
  for (const m of t.matchAll(/<UnitTestResult\b[^>]*>/g)) add(attr(m[0], 'testName'), attr(m[0], 'duration'));
  for (const m of t.matchAll(/<test-case\b[^>]*>/g)) add(attr(m[0], 'fullname') || attr(m[0], 'name'), attr(m[0], 'duration') || attr(m[0], 'time'));
  for (const m of t.matchAll(/<testcase\b[^>]*>/g)) { const c = attr(m[0], 'classname'); const n = attr(m[0], 'name'); add(c && n ? `${c}.${n}` : n, attr(m[0], 'time')); }
  return out;
}

function filesOf(dir, glob) {
  if (!/[*?]/.test(glob)) return [path.join(dir, ...glob.split('/'))];
  const re = globRe(glob);
  const fixed = glob.split('/').slice(0, glob.split('/').findIndex((x) => /[*?]/.test(x))).join('/');
  const found = [];
  let seen = 0;
  const walk = (abs, rel, depth) => {
    let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (++seen > 5000 || depth > 12) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r, depth + 1);
      else if (e.isFile() && re.test(r)) found.push(path.join(abs, e.name));
    }
  };
  walk(path.join(dir, ...fixed.split('/').filter(Boolean)), fixed, 0);
  return found;
}

/** The tests in the files the glob names that were written at or after `since` (ms), slowest first. */
export function timesRead(dir, glob, { since = 0 } = {}) {
  const all = new Map();
  for (const f of filesOf(dir, glob)) {
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs < since || st.size > MAX_FILE) continue;
      for (const x of parseTimes(fs.readFileSync(f, 'utf8'))) all.set(x.name, Math.max(all.get(x.name) || 0, x.seconds));
    } catch { /* an unreadable file is skipped */ }
  }
  return [...all].map(([name, seconds]) => ({ name, seconds })).sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));
}

/** engines.<x>.rules.memory: { file (glob), name (column), mb | gb (column) } of a table the test run writes, or null. */
export function memoryConfig(root, engine) {
  const v = enginesConfig(root)[engine]?.rules?.memory;
  const f = typeof v?.file === 'string' ? v.file.trim().replace(/\\/g, '/') : '';
  const col = typeof v?.gb === 'string' ? v.gb : typeof v?.mb === 'string' ? v.mb : '';
  return relOk(f) && typeof v?.name === 'string' && col ? { file: f, name: v.name, col, perGb: typeof v.gb === 'string' ? 1 : 1024 } : null;
}

/** The table's rows as [{ name, gb }], most memory first: tab or comma separated, a header line names the columns. */
export function memoryRead(dir, m, { since = 0 } = {}) {
  const all = new Map();
  for (const f of filesOf(dir, m.file)) {
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs < since || st.size > MAX_FILE) continue;
      const rows = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split(l.includes('\t') ? '\t' : ','));
      const ni = rows[0].indexOf(m.name); const vi = rows[0].indexOf(m.col);
      if (ni < 0 || vi < 0) continue;
      for (const r of rows.slice(1)) { const gb = Number(r[vi]) / m.perGb; if (r[ni] && gb > 0) all.set(r[ni], Math.max(all.get(r[ni]) || 0, Math.round(gb * 100) / 100)); }
    } catch { /* an unreadable file is skipped */ }
  }
  return [...all].map(([name, gb]) => ({ name, gb })).sort((a, b) => b.gb - a.gb || a.name.localeCompare(b.name));
}

/** Keep one rules command's times. Never throws; does nothing when neither rules.times nor rules.memory is set. */
export function recordTimes(root, engine, { dir, train = '', command = '', since = 0, now = Date.now() } = {}) {
  try {
    const glob = timesConfig(root, engine);
    const mc = memoryConfig(root, engine);
    const tests = glob ? timesRead(dir, glob, { since: since - 2000 }) : [];
    const mem = mc ? memoryRead(dir, mc, { since: since - 2000 }) : [];
    if (!tests.length && !mem.length) return null;
    const f = timesFile(root, engine);
    const j = readJson(f, null);
    const runs = (Array.isArray(j?.runs) ? j.runs : []).filter((r) => now - (Date.parse(r.at) || 0) < 2 * DAY);
    const run = { at: new Date(now).toISOString(), train: String(train || ''), command: String(command || '(full run)'), count: tests.length, seconds: Math.round(tests.reduce((a, x) => a + x.seconds, 0)), tests: tests.slice(0, KEEP_TESTS).map((x) => [x.name, x.seconds]), ...(mem.length ? { mem: mem.slice(0, 20).map((x) => [x.name, x.gb]) } : {}) };
    fs.mkdirSync(path.dirname(f), { recursive: true });
    writeAtomic(f, `${JSON.stringify({ runs: [...runs, run].slice(-60) }, null, 1)}\n`);
    return run;
  } catch { return null; }
}

/** The report of the last 24 hours for one engine: { runs, total, slowest, twice, heavy, ratchets } or null when nothing was kept. */
export async function costReport(root, engine, { now = Date.now(), events = null } = {}) {
  const runs = (readJson(timesFile(root, engine), null)?.runs || []).filter((r) => now - (Date.parse(r.at) || 0) < DAY);
  if (!runs.length) return null;
  const by = new Map();
  for (const r of runs) for (const [name, s] of r.tests || []) by.set(name, (by.get(name) || 0) + s);
  const total = runs.reduce((a, r) => a + (r.seconds || 0), 0);
  const slowest = [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([name, seconds]) => ({ name, seconds: Math.round(seconds), share: total ? Math.round((seconds / total) * 100) : 0 }));
  // The same test name in two runs (two commands) of one train.
  const seen = new Map();
  for (const r of runs) if (r.train) for (const [name] of r.tests || []) { const k = `${r.train}\n${name}`; seen.set(k, [...(seen.get(k) || []), r.command]); }
  const twice = [...seen].filter(([, c]) => c.length > 1).map(([k, c]) => ({ train: k.split('\n')[0], name: k.split('\n').slice(1).join('\n'), commands: c })).slice(0, 20);
  // Sampled peaks (run-cost.mjs) of the rules kinds.
  const ram = readJson(ramFile(root), null)?.[engine];
  const sampled = Object.keys(ram?.kinds || {}).filter((k) => k === 'rules' || k.startsWith('rules ')).map((k) => ({ filter: k === 'rules' ? '(the whole command)' : k.slice(6), peakGb: kindCost(ram, k)?.peakGb || 0, minutes: kindCost(ram, k)?.minutes, unknown: Boolean(kindCost(ram, k)?.unknown) }));
  const heavy = sampled.filter((x) => x.peakGb > 0).sort((a, b) => b.peakGb - a.peakGb).slice(0, 5);
  let ratchets = 0;
  try {
    const ev = events || (await import('./event.mjs')).readRecentEvents(20000);
    ratchets = (await import('./handback-kind.mjs')).handBackTally(ev, { from: now - DAY, to: now }).byKind.ratchet || 0;
  } catch { ratchets = 0; }
  // The most memory the test run's own table shows after a test group (rules.memory), the largest of the day per name.
  const mm = new Map();
  for (const r of runs) for (const [name, gb] of r.mem || []) mm.set(name, Math.max(mm.get(name) || 0, gb));
  const memory = [...mm].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([name, gb]) => ({ name, gb }));
  return { engine, runs: runs.length, total, slowest, twice, heavy, short: sampled.filter((x) => x.unknown).slice(0, 5), memory, ratchets };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * 2.98: lines about each rules part that has sampled runs. A part whose last passed run took over twice the median of
 * its earlier passed runs (at least 3) and 5+ minutes more says so, with its slowest tests when rules.times has them.
 * With rules.times set, a part none of whose tests the times file names says that.
 */
export function partLines(root, engine) {
  const kinds = readJson(ramFile(root), null)?.[engine]?.kinds || {};
  const set = Boolean(timesConfig(root, engine));
  const runs = set ? readJson(timesFile(root, engine), null)?.runs || [] : [];
  const L = [];
  for (const kind of Object.keys(kinds).filter((k) => k.startsWith('rules ')).sort()) {
    const part = kind.slice(6);
    const mine = runs.filter((r) => r.tests?.length && String(r.command).split('+').includes(part));
    if (set && !mine.length) L.push(`${part}: no test times for this part (the times file names none of its tests).`);
    const passed = kinds[kind].filter((r) => r.code === 0 && Number.isFinite(r.minutes)).map((r) => r.minutes);
    const last = passed[passed.length - 1];
    const med = passed.length > 3 ? median(passed.slice(0, -1)) : 0;
    if (!(last > 2 * med && last - med >= 5)) continue;
    const slow = mine.length ? mine[mine.length - 1].tests.slice(0, 3).map(([n, sec]) => `${n} ${mins(sec)}`).join(', ') : '';
    L.push(`${part} slowed down: its last passed run took ${last} min, the median of its ${passed.length - 1} earlier runs is ${med} min.${slow ? ` Slowest tests: ${slow}.` : ''}`);
  }
  return L;
}
const mins = (s) => (s >= 90 ? `${Math.round(s / 6) / 10} min` : `${s} s`);
export function costText(r) {
  const L = [`Test cost for ${r.engine}, last 24 hours: ${r.runs} test run(s), ${mins(r.total)} of test time.`, 'Slowest tests:'];
  for (const x of r.slowest) L.push(`  ${mins(x.seconds)} (${x.share}%) ${x.name}`);
  L.push(r.twice.length ? `Ran more than once in one train (${r.twice.length}):` : 'No test ran more than once in one train.');
  for (const x of r.twice.slice(0, 10)) L.push(`  ${x.name} (train ${x.train}: ${x.commands.join(' and ')})`);
  L.push(r.heavy.length ? 'Heaviest rules runs by sampled memory:' : 'No rules run has a measured peak yet.');
  for (const x of r.heavy) L.push(`  ${x.peakGb} GB ${x.filter}`);
  for (const x of r.short || []) L.push(`  ${shortText(x.minutes)}: ${x.filter}`);
  if (r.memory?.length) { L.push("Most memory in the test run's own table (rules.memory):"); for (const x of r.memory) L.push(`  ${x.gb} GB ${x.name}`); }
  L.push(`Hand-backs of kind ratchet in the last 24 hours: ${r.ratchets}.`);
  return L.join('\n');
}

/** Up to 2 digest lines (engines with data, most test time first); '' when nothing was kept. */
export async function costDigestLines(root, { now = Date.now(), events = null } = {}) {
  const out = [];
  for (const engine of Object.keys(enginesConfig(root))) {
    const r = await costReport(root, engine, { now, events });
    if (r?.slowest.length) out.push(r);
  }
  out.sort((a, b) => b.total - a.total);
  return out.slice(0, 2).map((r) => `Test cost (${r.engine}, 24 h): slowest ${r.slowest[0].name.split('.').pop().slice(0, 40)} ${mins(r.slowest[0].seconds)} (${r.slowest[0].share}%)${r.twice.length ? `; ${r.twice.length} ran twice in a train` : ''}${r.memory?.length ? `; most memory ${r.memory[0].name.split('.').pop().slice(0, 40)} ${r.memory[0].gb} GB` : ''}; npm run engine -- test-cost`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const want = flagOf(argv)('engine');
  const names = Object.keys(enginesConfig(REPO_ROOT)).filter((n) => !want || n === want);
  const reps = [];
  for (const n of names) { const r = await costReport(REPO_ROOT, n); const pl = partLines(REPO_ROOT, n); if (r || pl.length) reps.push(`${r ? costText(r) : `Test cost for ${n}:`}${pl.length ? `\n${pl.join('\n')}` : ''}`); }
  console.log(reps.length ? reps.join('\n\n') : `No test times kept${want ? ` for ${want}` : ''}: set engines.<x>.rules.times to the result file the test command writes (.trx, NUnit or JUnit XML).`);
}
