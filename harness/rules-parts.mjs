/**
 * harness/rules-parts.mjs — the parts of a split rules check, run within the memory there is. rules.focus.split runs
 * one test command per filter group; each test process holds one system's data, so how many run at once depends on
 * free RAM: a part starts only while (free RAM - the floor) >= splitGb; always at least one runs; checked again
 * before every start.
 * rules.focus.splitMax caps the number (unset: 1, in sequence). rules.focus.splitGb is the GB one test process is
 * expected to take. 2.98: unset, each part takes its own recent sampled peak (run-cost.mjs partMemory, passed in).
 * runParts is async and takes everything it reads (RAM reader, clock, starter) as arguments, so a test can inject
 * them. 2.98: judged() reads every rules command's result; a build fault (rules.infra) runs once more, alone. The runner is synchronous (engine-rules.mjs runRulesAt), so it calls this file as a script: `node
 * harness/rules-parts.mjs` reads one JSON job on stdin and writes one JSON result on stdout.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { limitedArgs } from './run-limited.mjs';
import { ramCheck } from './ram.mjs';
import { numFiniteFirst as num } from './helpers.mjs';

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

/** { max, gb, floorGb, parts, why } for a focus config (splitMax, splitGb). memory: run-cost.mjs partMemory, used when splitGb is unset. */
export function splitPlan(focus = {}, { env = process.env, memory = null } = {}) {
  const floorGb = floorGbOf(env);
  const max = Number(focus.splitMax) >= 1 ? Math.floor(Number(focus.splitMax)) : 1;
  const hand = Number(focus.splitGb) > 0 ? Number(focus.splitGb) : 0;
  const gb = hand || memory?.gb || 4;
  const per = hand ? `${gb} GB per part (rules.focus.splitGb)` : memory ? `memory per part ${memory.line}` : `${gb} GB per part (the default)`;
  return { max, gb, floorGb, parts: hand ? null : memory?.list || null, why: `up to ${max} at once${Number(focus.splitMax) >= 1 ? ' (rules.focus.splitMax)' : ' (rules.focus.splitMax is not set)'}, ${per}, floor ${floorGb} GB` };
}

/** 2.98: output lines that say a build fault, not a test result: a file another build holds (rules.infra adds to these for dotnet). */
export const INFRA_DOTNET = ['error CS2012', 'MSB3021', 'MSB3026', 'MSB3027', 'being used by another process', 'locked by'];
/** 2.98: the first line of `text` that one of `infra` (regex sources, any case) matches, trimmed, or ''. */
function infraLine(text, infra = []) {
  const res = infra.map((x) => { try { return new RegExp(x, 'i'); } catch { return null; } }).filter(Boolean);
  if (!res.length) return '';
  const l = String(text || '').split(/\r?\n/).find((x) => res.some((re) => re.test(x)));
  return l ? l.trim().slice(0, 300) : '';
}
/** 2.98: a rules command's result, the one reading for every run: { status: 'pass' | 'red' } or { status: 'infra', line }. */
export function judged(code, text, infra = []) {
  if (code === 0) return { status: 'pass' };
  const line = infraLine(text, infra);
  return line ? { status: 'infra', line } : { status: 'red' };
}

/**
 * Run parts[i] through start(part, i) -> Promise<{ status: 'pass' | 'red' | 'error', ... }>, at most `max` at once and only
 * while free RAM - floor >= gb, or the part's own measured gb (at least one always). After a part is not 'pass' no new part starts; the ones running finish.
 * 2.96 (a): admitPart(part) -> a run-cost.mjs decision. 2.98: 'infra' (judged) runs once more alone; again, 'error' + notJudged.
 * { results (in part order; a part never started is null), atOnce (the most that ran together), decisions: [line] }.
 */
export async function runParts({ parts, start, max = 1, gb = 4, floorGb = 3, freeGb = () => null, log = () => {}, pollMs = 1000, admitPart = null } = {}) {
  const results = parts.map(() => null);
  const decisions = [];
  const say = (m) => { decisions.push(m); log(m); };
  const running = new Map();
  let next = 0;
  let atOnce = 0;
  let stop = false;
  let lastWait = '';
  const again = [];
  const tried = new Set();
  let solo = -1;
  const launch = (i, why) => {
    say(`part ${i + 1} of ${parts.length} starts (${running.size + 1} at once): ${why}`);
    const p = Promise.resolve().then(() => start(parts[i], i)).catch((e) => ({ status: 'error', why: String(e?.message || e) })).then((r) => {
      running.delete(i);
      if (solo === i) solo = -1;
      if (r.status === 'infra' && !tried.has(i)) { tried.add(i); again.push(i); say(`part ${i + 1} of ${parts.length} met a build fault, not a test result (${r.line}): it runs once more, alone`); return; }
      results[i] = r.status === 'infra' ? { ...r, status: 'error', notJudged: r.line } : r;
      if (results[i].status !== 'pass') stop = true;
    });
    running.set(i, p);
    atOnce = Math.max(atOnce, running.size);
  };
  while (true) {
    if (again.length && !running.size && !stop) { solo = again.shift(); launch(solo, 'alone, after a build fault'); }
    while (!stop && !again.length && solo < 0 && next < parts.length) {
      let why;
      let md = null;
      // A part with its own number needs that, not the plan's.
      const need = Number(parts[next]?.gb) > 0 ? Number(parts[next].gb) : gb;
      if (!running.size) why = 'none is running: the first part always starts';
      else if (running.size >= max) { if (lastWait !== 'max') say(`part ${next + 1} of ${parts.length} waits: ${running.size} running is the most at once (rules.focus.splitMax ${max})`); lastWait = 'max'; break; }
      else if ((md = admitPart ? admitPart(parts[next]) : null)?.decided) {
        if (md.ok) why = md.line;
        else { if (lastWait !== md.line) say(`part ${next + 1} of ${parts.length} ${md.line}; ${running.size} running`); lastWait = md.line; break; }
      } else {
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
      launch(next++, why);
    }
    if (!running.size) break;
    await Promise.race([...running.values(), new Promise((res) => setTimeout(res, pollMs))]);
  }
  return { results, atOnce, decisions };
}

/** The script: one JSON job on stdin ({ parts: [{ filter, command }], cwd, env, timeoutMs, max, gb, floorGb, freeGb?, infra? }), one result on stdout. */
async function cli() {
  let text = '';
  for await (const c of process.stdin) text += c;
  const job = JSON.parse(text);
  // 2.96 (a): loaded here, not at the top: run-cost.mjs imports this file.
  const cost = job.root ? await import('./run-cost.mjs').catch(() => null) : null;
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
    const fin = (r) => { if (done) return; done = true; clearTimeout(timer); const mz = smp ? cost.runNumbers(smp) : null; resolve({ filter: part.filter, seconds: Math.round((Date.now() - g0) / 1000), text: buf, ...(mz ? { measured: mz } : {}), ...r }); };
    const smp = cost && job.root ? cost.runSample(job.root, job.engine, cost.rulesKind(part.filter), { label: `${job.engine} rules ${part.filter}` }) : null;
    const child = spawn(process.execPath, limitedArgs(left, part.command, smp), { cwd: job.cwd, env: job.env, windowsHide: true });
    // The wrapper ends the tree at `left`; this timer is only the safety net.
    const timer = setTimeout(() => { try { child.kill(); } catch { /* it ended */ } fin({ status: 'error', timedOut: true }); }, left + 15000);
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('error', (e) => fin({ status: 'error', errorCode: e.code || e.message }));
    child.on('close', (code, signal) => fin(code === 124 && buf.includes('[run-limited] ended after') ? { status: 'error', timedOut: true } : { ...judged(code, buf, job.infra), code, signal }));
  });
  const heavy = job.root ? await import('./heavy.mjs').catch(() => null) : null;
  const admitPart = cost && heavy && job.root ? (part) => cost.measuredAdmit({ root: job.root, engine: job.engine, kind: cost.rulesKind(part.filter), handGb: job.handGb || null, holders: heavy.heavyHolders(job.root, { env: job.env }), env: job.env }) : null;
  const r = await runParts({ parts: job.parts, start, max: job.max, gb: job.gb, floorGb: job.floorGb, freeGb, log: (m) => logs.push(m), pollMs: job.pollMs || 1000, admitPart });
  process.stdout.write(`${JSON.stringify({ ...r, logs })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  cli().then(() => process.exit(0), (e) => { console.error(`[rules-parts] ${e?.stack || e}`); process.exit(1); });
}
