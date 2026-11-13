/**
 * harness/rules-parts.mjs — 2.85: the parts of a split rules check, run within the memory there is.
 *
 * rules.focus.split (2.84) runs one test command per filter group. Each test process holds one system's data (a crew's
 * machine showed 7.3, 4.1 and 2.4 GB for three), so how many run at once is a decision about free RAM, not a constant:
 *   a part starts only while (free RAM - the floor) >= splitGb; always at least one runs; the check is made again
 *   before every start. rules.focus.splitMax caps the number; unset means 1 (the 2.84 behaviour: in sequence).
 *   rules.focus.splitGb is the GB one test process is expected to take (default 4, raised to the largest peak
 *   .studio/engine-ram.json holds: the one RAM measurer the harness has).
 *
 * runParts is async and takes everything it reads (the RAM reader, the clock, the starter) as arguments, so a test
 * can inject them. The runner is synchronous (engine-rules.mjs runRulesAt), so it calls this file as a script:
 * `node harness/rules-parts.mjs` reads one JSON job on stdin and writes one JSON result on stdout.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson } from './fsafe.mjs';
import { ramCheck } from './ram.mjs';

const num = (v, d) => (Number.isFinite(Number(v)) && String(v ?? '').trim() !== '' ? Number(v) : d);
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

/** { max, gb, floorGb, why } for a focus config (splitMax, splitGb). */
export function splitPlan(focus = {}, { root, engine = 'unity', env = process.env } = {}) {
  const floorGb = floorGbOf(env);
  const max = Number(focus.splitMax) >= 1 ? Math.floor(Number(focus.splitMax)) : 1;
  const peak = root ? measuredPeakGb(root, engine) : 0;
  const gb = Number(focus.splitGb) > 0 ? Number(focus.splitGb) : Math.max(4, peak);
  const gbWhy = Number(focus.splitGb) > 0 ? 'rules.focus.splitGb' : peak > 4 ? `the largest measured peak, ${peak} GB` : 'the default 4 GB';
  return { max, gb, floorGb, why: `up to ${max} at once${Number(focus.splitMax) >= 1 ? ' (rules.focus.splitMax)' : ' (rules.focus.splitMax is not set)'}, ${gb} GB per part (${gbWhy}), floor ${floorGb} GB` };
}

/**
 * Run parts[i] through start(part, i) -> Promise<{ status: 'pass' | 'red' | 'error', ... }>, at most `max` at once and only
 * while free RAM - floor >= gb (at least one always). After a part is not 'pass' no new part starts; the ones running finish.
 * { results (in part order; a part never started is null), atOnce (the most that ran together), decisions: [line] }.
 */
export async function runParts({ parts, start, max = 1, gb = 4, floorGb = 3, freeGb = () => null, log = () => {}, pollMs = 1000 } = {}) {
  const results = parts.map(() => null);
  const decisions = [];
  const say = (m) => { decisions.push(m); log(m); };
  const running = new Map();
  let next = 0;
  let atOnce = 0;
  let stop = false;
  let lastWait = '';
  while (true) {
    while (!stop && next < parts.length) {
      let why;
      if (!running.size) why = 'none is running: the first part always starts';
      else if (running.size >= max) { if (lastWait !== 'max') say(`part ${next + 1} of ${parts.length} waits: ${running.size} running is the most at once (rules.focus.splitMax ${max})`); lastWait = 'max'; break; }
      else {
        const f = freeGb();
        if (Number.isFinite(f) && f - floorGb >= gb) why = `${r1(f)} GB free - ${floorGb} GB floor >= ${gb} GB per part`;
        else {
          const w = Number.isFinite(f) ? `free ${r1(f)} GB` : 'unknown';
          if (lastWait !== w) say(`part ${next + 1} of ${parts.length} waits: ${Number.isFinite(f) ? `${r1(f)} GB free - ${floorGb} GB floor < ${gb} GB per part` : 'free RAM is unknown'}; ${running.size} running`);
          lastWait = w;
          break;
        }
      }
      lastWait = '';
      const i = next++;
      say(`part ${i + 1} of ${parts.length} starts (${running.size + 1} at once): ${why}`);
      const p = Promise.resolve().then(() => start(parts[i], i)).catch((e) => ({ status: 'error', why: String(e?.message || e) })).then((r) => { results[i] = r; running.delete(i); if (r.status !== 'pass') stop = true; });
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
  const start = (part) => new Promise((resolve) => {
    const g0 = Date.now();
    const left = job.timeoutMs - (g0 - t0);
    if (left <= 0) { resolve({ status: 'error', timedOut: true, filter: part.filter, seconds: 0, text: '' }); return; }
    let buf = '';
    const keep = (d) => { buf += d.toString('utf8'); if (buf.length > 4e6) buf = buf.slice(-2e6); };
    let done = false;
    const fin = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ filter: part.filter, seconds: Math.round((Date.now() - g0) / 1000), text: buf, ...r }); };
    const child = spawn(part.command, { shell: true, cwd: job.cwd, env: job.env, windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* it ended */ } fin({ status: 'error', timedOut: true }); }, left);
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('error', (e) => fin({ status: 'error', errorCode: e.code || e.message }));
    child.on('close', (code, signal) => fin({ status: code === 0 ? 'pass' : 'red', code, signal }));
  });
  const r = await runParts({ parts: job.parts, start, max: job.max, gb: job.gb, floorGb: job.floorGb, freeGb, log: (m) => logs.push(m), pollMs: job.pollMs || 1000 });
  process.stdout.write(`${JSON.stringify({ ...r, logs })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  cli().then(() => process.exit(0), (e) => { console.error(`[rules-parts] ${e?.stack || e}`); process.exit(1); });
}
