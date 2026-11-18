/**
 * harness/rules-parts.mjs — the parts of a split rules check, run within the memory there is. rules.focus.split runs
 * one test command per filter group; each test process holds one system's data, so how many run at once depends on
 * free RAM: a part starts only while (free RAM - the floor) >= splitGb; always at least one runs; checked again
 * before every start.
 * rules.focus.splitMax caps the number (unset: 1, in sequence). rules.focus.splitGb is the GB one test process is
 * expected to take (default 4, raised to the largest peak in .studio/engine-ram.json). 2.95: a part with a measured peak
 * (rules.peak, the file the test command writes) needs that instead; peakClear/peakRead handle the file.
 * runParts is async and takes everything it reads (RAM reader, clock, starter) as arguments, so a test can inject
 * them. The runner is synchronous (engine-rules.mjs runRulesAt), so it calls this file as a script: `node
 * harness/rules-parts.mjs` reads one JSON job on stdin and writes one JSON result on stdout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RUN_LIMITED } from './run-limited.mjs';
import { readJson } from './fsafe.mjs';
import { ramCheck } from './ram.mjs';
import { numFiniteFirst as num } from './helpers.mjs';
import { matchAny } from './merge-lane.mjs';

const r1 = (n) => Math.round(n * 10) / 10;

/** The floor the free RAM is held against: STUDIO_RAM_FLOOR_GB (3 when unset; 0 is none). */
export const floorGbOf = (env = process.env) => Math.max(0, num(env.STUDIO_RAM_FLOOR_GB, 3));

/** Free RAM in GB by the harness's reader (ram.mjs: os.freemem, commit headroom on Windows), or null when unknown. */
export function readFreeGb(env = process.env) {
  try {
    const r = ramCheck({}, { ...env, STUDIO_RAM_FLOOR_GB: '0.1' });
    return Number.isFinite(r.freeGb) ? r.freeGb : null;
  } catch { return null; }
}

/** The largest RAM peak .studio/engine-ram.json holds for an engine (land runs, any status), or 0. */
export function measuredPeakGb(root, engine) {
  try {
    const peaks = (readJson(path.join(root, '.studio', 'engine-ram.json'), {}) || {})[engine]?.peaks;
    return Math.max(0, ...(Array.isArray(peaks) ? peaks : []).map((p) => Number(p.gb) || 0));
  } catch { return 0; }
}

/** { max, gb, floorGb, why } for a focus config (splitMax, splitGb). 2.95: peakGb, a rules run's own measured peak (rules.peak), when splitGb is unset. */
export function splitPlan(focus = {}, { root, engine = 'unity', env = process.env, peakGb = null } = {}) {
  const floorGb = floorGbOf(env);
  const max = Number(focus.splitMax) >= 1 ? Math.floor(Number(focus.splitMax)) : 1;
  const own = Number(focus.splitGb) > 0 ? 0 : Number(peakGb) > 0 ? Number(peakGb) : 0;
  const peak = root && !own ? measuredPeakGb(root, engine) : 0;
  const gb = Number(focus.splitGb) > 0 ? Number(focus.splitGb) : own || Math.max(4, peak);
  const gbWhy = Number(focus.splitGb) > 0 ? 'rules.focus.splitGb' : own ? `the measured peak of a rules run, ${own} GB (rules.peak)` : peak > 4 ? `the largest measured peak, ${peak} GB` : 'the default 4 GB';
  return { max, gb, floorGb, why: `up to ${max} at once${Number(focus.splitMax) >= 1 ? ' (rules.focus.splitMax)' : ' (rules.focus.splitMax is not set)'}, ${gb} GB per part (${gbWhy}), floor ${floorGb} GB` };
}

const GB_RE = /(\d+(?:[.,]\d+)?)\s*GB/i;
/** 2.95: the files rules.peak names in a test checkout (a path, or a glob walked from its fixed folder, a few thousand entries at most). */
function peakFiles(dir, peak) {
  const pat = String(peak?.file || '');
  if (!pat) return [];
  if (!/[*?]/.test(pat)) return [path.join(dir, ...pat.split('/'))];
  const segs = pat.split('/');
  const fixed = segs.slice(0, segs.findIndex((x) => /[*?]/.test(x))).join('/');
  const found = [];
  let seen = 0;
  const walk = (abs, rel, depth) => {
    let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (++seen > 5000 || depth > 12) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r, depth + 1);
      else if (e.isFile() && matchAny(r, [pat])) found.push(path.join(abs, e.name));
    }
  };
  walk(path.join(dir, ...fixed.split('/').filter(Boolean)), fixed, 0);
  return found;
}
/** 2.95: remove what rules.peak names before a test command, so a file left by an earlier run is never read. */
export function peakClear(dir, peak) { for (const f of peakFiles(dir, peak)) { try { fs.rmSync(f, { force: true }); } catch { /* peakRead may then read it: a number too high, never too low by much */ } } }
/** 2.95: the GB in what rules.peak names after a test command (the largest of its files), or null (none, unreadable, no number). */
export function peakRead(dir, peak) {
  let re = GB_RE;
  try { if (peak?.match) re = new RegExp(peak.match, 'i'); } catch { re = GB_RE; }
  let best = null;
  for (const f of peakFiles(dir, peak)) {
    let text = ''; try { text = fs.readFileSync(f, 'utf8').slice(0, 65536); } catch { continue; }
    const m = re.exec(text);
    const gb = m ? Number(String(m[1]).replace(',', '.')) : NaN;
    if (Number.isFinite(gb) && gb > 0) best = Math.max(best || 0, Math.round(gb * 100) / 100);
  }
  return best;
}

/**
 * Run parts[i] through start(part, i) -> Promise<{ status: 'pass' | 'red' | 'error', ... }>, at most `max` at once and only
 * while free RAM - floor >= gb, or the part's own measured gb (at least one always). After a part is not 'pass' no new part starts; the ones running finish.
 * { results (in part order; a part never started is null), atOnce (the most that ran together), decisions: [line] }.
 */
export async function runParts({ parts, start, max = 1, gb = 4, floorGb = 3, freeGb = () => null, log = () => {}, pollMs = 1000 } = {}) {
  const results = parts.map(() => null);
  const decisions = [];
  const say = (m) => { decisions.push(m); log(m); };
  const running = new Map();
  const overlap = new Set();
  let next = 0;
  let atOnce = 0;
  let stop = false;
  let lastWait = '';
  while (true) {
    while (!stop && next < parts.length) {
      let why;
      // 2.95: a part with a measured peak (rules.peak) needs that, not the plan's guess.
      const need = Number(parts[next]?.gb) > 0 ? Number(parts[next].gb) : gb;
      if (!running.size) why = 'none is running: the first part always starts';
      else if (running.size >= max) { if (lastWait !== 'max') say(`part ${next + 1} of ${parts.length} waits: ${running.size} running is the most at once (rules.focus.splitMax ${max})`); lastWait = 'max'; break; }
      else {
        const f = freeGb();
        if (Number.isFinite(f) && f - floorGb >= need) why = `${r1(f)} GB free - ${floorGb} GB floor >= ${need} GB ${need === gb ? 'per part' : 'measured for this part'}`;
        else {
          const w = Number.isFinite(f) ? `free ${r1(f)} GB` : 'unknown';
          if (lastWait !== w) say(`part ${next + 1} of ${parts.length} waits: ${Number.isFinite(f) ? `${r1(f)} GB free - ${floorGb} GB floor < ${need} GB ${need === gb ? 'per part' : 'measured for this part'}` : 'free RAM is unknown'}; ${running.size} running`);
          lastWait = w;
          break;
        }
      }
      lastWait = '';
      const i = next++;
      // 2.95: a part that ran beside another cannot tell its own peak from the file they share.
      if (running.size) { overlap.add(i); for (const k of running.keys()) overlap.add(k); }
      say(`part ${i + 1} of ${parts.length} starts (${running.size + 1} at once): ${why}`);
      const p = Promise.resolve().then(() => start(parts[i], i, () => overlap.has(i))).catch((e) => ({ status: 'error', why: String(e?.message || e) })).then((r) => { results[i] = r; running.delete(i); if (r.status !== 'pass') stop = true; });
      running.set(i, p);
      atOnce = Math.max(atOnce, running.size);
    }
    if (!running.size) break;
    await Promise.race([...running.values(), new Promise((res) => setTimeout(res, pollMs))]);
  }
  return { results, atOnce, decisions };
}

/** The script: one JSON job on stdin ({ parts: [{ filter, command }], cwd, env, timeoutMs, max, gb, floorGb, freeGb? }), one result on stdout. */
async function cli() {
  let text = '';
  for await (const c of process.stdin) text += c;
  const job = JSON.parse(text);
  const t0 = Date.now();
  const logs = [];
  const freeGb = Number.isFinite(job.freeGb) ? () => job.freeGb : () => readFreeGb(job.env || process.env);
  const start = (part, i, shared) => new Promise((resolve) => {
    const g0 = Date.now();
    const left = job.timeoutMs - (g0 - t0);
    if (left <= 0) { resolve({ status: 'error', timedOut: true, filter: part.filter, seconds: 0, text: '' }); return; }
    let buf = '';
    const keep = (d) => { buf += d.toString('utf8'); if (buf.length > 4e6) buf = buf.slice(-2e6); };
    let done = false;
    if (job.peak) peakClear(job.cwd, job.peak);
    const fin = (r) => { if (done) return; done = true; clearTimeout(timer); const pg = job.peak && !shared() ? peakRead(job.cwd, job.peak) : null; resolve({ filter: part.filter, seconds: Math.round((Date.now() - g0) / 1000), text: buf, ...(pg ? { peakGb: pg } : {}), ...r }); };
    const child = spawn(process.execPath, [RUN_LIMITED, String(left), '--', part.command], { cwd: job.cwd, env: job.env, windowsHide: true });
    // The wrapper ends the tree at `left`; this timer is only the safety net.
    const timer = setTimeout(() => { try { child.kill(); } catch { /* it ended */ } fin({ status: 'error', timedOut: true }); }, left + 15000);
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('error', (e) => fin({ status: 'error', errorCode: e.code || e.message }));
    child.on('close', (code, signal) => fin(code === 124 && buf.includes('[run-limited] ended after') ? { status: 'error', timedOut: true } : { status: code === 0 ? 'pass' : 'red', code, signal }));
  });
  const r = await runParts({ parts: job.parts, start, max: job.max, gb: job.gb, floorGb: job.floorGb, freeGb, log: (m) => logs.push(m), pollMs: job.pollMs || 1000 });
  process.stdout.write(`${JSON.stringify({ ...r, logs })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  cli().then(() => process.exit(0), (e) => { console.error(`[rules-parts] ${e?.stack || e}`); process.exit(1); });
}
