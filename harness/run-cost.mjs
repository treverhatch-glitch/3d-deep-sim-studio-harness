/**
 * harness/run-cost.mjs — 2.96 (a): what each kind of run costs, measured, and admission by reservation.
 * Every land run, rules command (whole, part or shard), compile check and quick test is sampled (run-sampler.mjs) into
 * .studio/engine/<x>-samples/<run>.csv (newest 60 per engine, none older than 14 days). Ended runs are folded into
 * .studio/engine-ram.json <x>.kinds (the last 20 per kind): peak GB, mean CPU %, minutes, when the peak comes, and
 * which kinds ran beside it. studio/game.json "machine": { "admit": "measured" } turns measured admission on (default
 * off: 2.95's rules); "cpuCapPct" (85), "sample" (true; false: no samples), "sampleSec" (10), "slowerPct" (10).
 * A job starts when free RAM - the floor - what running jobs still have to grow holds its own need, and CPU now plus
 * its share stays under the cap. Need = the peak of its last 5 runs + max(0.5 GB, 10%), with at least one of them exit 0.
 * Anything missing, stale or wrong (a run above its own need) falls back to today's rule, and says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeAtomic, pidAlive } from './fsafe.mjs';
import { ramFile } from './engine-ram.mjs';
import { claimOf } from './heavy-budget.mjs';
import { sampleCpuBusy } from './machine.mjs';
import { readFreeGb, floorGbOf } from './rules-parts.mjs';
import { sleepSync, numSplit as num } from './helpers.mjs';
import { emitEvent } from './event.mjs';

const r1 = (x) => Math.round(x * 10) / 10;
const PEAK_RUNS = 5;
const KEEP_RUNS = 20;
const KEEP_FILES = 60;
const KEEP_DAYS = 14;
const PAIR_RUNS = 3;
const RETRY_HOURS = 24;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const avg = (xs) => { const m = mean(xs.filter(Number.isFinite)); return m === null ? null : r1(m); };
/** A run too short for one sample (2.97): no peak is known. 2.96 stored it as 0 GB with no CPU and no peak time. */
export const unknownRun = (r) => r.short === true || r.gb == null || (r.gb === 0 && r.cpu == null && r.when == null);
export const shortText = (minutes) => `too short to sample${Number.isFinite(minutes) ? ` (${minutes} min)` : ''}`;

/** studio/game.json "machine", with defaults. */
export function machineCfg(root) {
  const m = readJson(path.join(root, 'studio', 'game.json'), null)?.machine;
  const c = m && typeof m === 'object' ? m : {};
  const n = (v, d, lo, hi) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, Number(v))) : d);
  return { measured: c.admit === 'measured', sample: c.sample !== false, everyMs: n(c.sampleSec, 10, 0.2, 600) * 1000, cpuCapPct: n(c.cpuCapPct, 85, 1, 100), slowerPct: n(c.slowerPct, 10, 0, 1000) };
}

/** The kind of a land run from what the train told it: rules stage skipped or run, Play Mode or none; 2.98: the full run's part. */
export function landKind(env = process.env) {
  const play = String(env.STUDIO_PLAY_MODE || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  const part = env.STUDIO_LAND_FULL === '1' ? String(env.STUDIO_LAND_PART || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) : '';
  return `land${env.STUDIO_RULES_GREEN === '1' ? ' no-rules' : ' with-rules'}${play && play !== 'off' ? ` play-${play}` : ''}${part ? ` part-${part}` : ''}`;
}
/** The kind of a rules command: 'rules' for the whole command, 'rules <filter>' for a part or shard. */
export const rulesKind = (filter) => (filter && filter !== '(full run)' ? `rules ${String(filter).slice(0, 80)}` : 'rules');

export const samplesDir = (root, engine) => path.join(root, '.studio', 'engine', `${engine}-samples`);
let seq = 0;
/** The `sample` option for runLimitedSync, or null when sampling is off. Never throws. */
export function runSample(root, engine, kind, { label = null } = {}) {
  try {
    const cfg = machineCfg(root);
    if (!cfg.sample) return null;
    const dir = samplesDir(root, engine);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${process.pid}-${++seq}-${String(kind).replace(/[^A-Za-z0-9.-]+/g, '_').slice(0, 60)}.csv`);
    return { file, meta: { kind, engine, ...(label ? { label: String(label).slice(0, 120) } : {}) }, everyMs: cfg.everyMs };
  } catch { return null; }
}

/** One samples file: { file, meta, rows, end } or null. */
export function readRun(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  let meta = null; let end = null; const rows = [];
  for (const l of lines) {
    if (l.startsWith('# end ')) { try { end = JSON.parse(l.slice(6)); } catch { end = { code: null }; } continue; }
    if (l.startsWith('# ')) { try { meta = meta || JSON.parse(l.slice(2)); } catch { /* not ours */ } continue; }
    const f = l.split(',');
    if (f.length < 8 || !/^\d+$/.test(f[0])) continue;
    const v = f.map((x) => (x === '' ? NaN : Number(x)));
    if (Number.isFinite(v[5])) rows.push({ t: v[0], availGb: v[1], commitUsedGb: v[2], commitLimitGb: v[3], cpuPct: v[4], treeGb: v[5], treeCpuPct: v[6], procs: v[7] });
  }
  return meta ? { file, id: path.basename(file, '.csv'), meta, rows, end } : null;
}

/** A run's numbers: { peakGb, cpuPct, minutes, when, code, at, endAt }. */
export function summarize(run) {
  const rows = run.rows;
  const peak = rows.length ? Math.max(...rows.map((r) => r.treeGb)) : 0;
  const i = rows.findIndex((r) => r.treeGb === peak);
  const high = rows.filter((r) => r.treeGb >= 0.8 * peak).length;
  const when = !rows.length ? null : high >= 0.6 * rows.length && rows.length >= 3 ? 'throughout' : i < rows.length / 3 ? 'start' : i >= (2 * rows.length) / 3 ? 'end' : 'middle';
  const cpu = mean(rows.map((r) => r.treeCpuPct).filter(Number.isFinite));
  const endAt = Number(run.end?.at) || (rows.length ? rows[rows.length - 1].t : Number(run.meta.at));
  return { peakGb: Math.round(peak * 100) / 100, cpuPct: cpu === null ? null : r1(cpu), minutes: r1(Math.max(0, endAt - Number(run.meta.at)) / 60000), when, code: run.end ? run.end.code ?? null : null, at: Number(run.meta.at), endAt };
}

const allSampleFiles = (root) => {
  const base = path.join(root, '.studio', 'engine');
  const out = [];
  try { for (const d of fs.readdirSync(base)) if (d.endsWith('-samples')) for (const f of fs.readdirSync(path.join(base, d))) if (f.endsWith('.csv')) out.push(path.join(base, d, f)); } catch { /* none */ }
  return out;
};
const runAlive = (run, now) => !run.end && pidAlive(run.meta.pid) && now - Number(run.meta.at) < 24 * 3600000;

/** Runs going on now, every engine: [{ id, engine, kind, label, holder, nowGb, peakGb, cpuPct, machineCpuPct, ageMs, everyMs, sample }]. */
export function liveRuns(root, now = Date.now()) {
  const out = [];
  for (const f of allSampleFiles(root)) {
    const run = readRun(f);
    if (!run || !runAlive(run, now)) continue;
    const last = run.rows[run.rows.length - 1] || null;
    out.push({ id: run.id, engine: run.meta.engine, kind: run.meta.kind, label: run.meta.label || run.meta.kind, holder: run.meta.ppid, at: Number(run.meta.at), nowGb: last ? r1(last.treeGb) : 0, peakGb: run.rows.length ? r1(Math.max(...run.rows.map((r) => r.treeGb))) : 0, cpuPct: last && Number.isFinite(last.treeCpuPct) ? r1(last.treeCpuPct) : null, machineCpuPct: last && Number.isFinite(last.cpuPct) ? last.cpuPct : null, ageMs: now - (last ? last.t : Number(run.meta.at)), everyMs: Number(run.meta.everyMs) || 10000, sample: last });
  }
  return out;
}

const pairKey = (a, b) => [a, b].sort().join(' + ');
/** Is pair a+b slower together than alone by more than slowerPct, after PAIR_RUNS of each? { slower, why } or null. */
function pairVerdict(kinds, a, b, since, slowerPct) {
  for (const [x, y] of [[a, b], [b, a]]) {
    const list = (kinds[x] || []).filter((r) => r.code === 0 && r.minutes > 0);
    const alone = list.filter((r) => !(r.with || []).length).map((r) => r.minutes);
    const together = list.filter((r) => (r.with || []).includes(y) && r.at > since).map((r) => r.minutes);
    if (alone.length < PAIR_RUNS || together.length < PAIR_RUNS) continue;
    const pct = (mean(together) / mean(alone) - 1) * 100;
    if (pct > slowerPct) return { why: `${x} took ${r1(mean(together))} min beside ${y} (${together.length} runs) and ${r1(mean(alone))} min alone (${alone.length} runs): ${Math.round(pct)}% slower, over the ${slowerPct}% limit (studio/game.json machine.slowerPct)` };
  }
  return null;
}

/**
 * Fold ended runs of `engine` into the store, check the pairs they ran in, prune old files. Returns the store entry
 * { kinds, seen, pairs }. emit: an event function (one machine.overlap_stopped per pair stopped). Never throws.
 */
export function foldRuns(root, engine, { now = Date.now(), emit = emitEvent } = {}) {
  let all = {};
  try { all = readJson(ramFile(root), {}) || {}; } catch { all = {}; }
  const e = { ...(all[engine] || {}) };
  e.kinds = e.kinds && typeof e.kinds === 'object' ? e.kinds : {};
  e.seen = Array.isArray(e.seen) ? e.seen : [];
  e.pairs = e.pairs && typeof e.pairs === 'object' ? e.pairs : {};
  try {
    const files = allSampleFiles(root);
    const runs = files.map(readRun).filter(Boolean);
    const span = (r) => [Number(r.meta.at), Number(r.end?.at) || (r.rows.length ? r.rows[r.rows.length - 1].t : Number(r.meta.at))];
    const seen = new Set(e.seen);
    let changed = false;
    const cfg = machineCfg(root);
    for (const run of runs) {
      if (run.meta.engine !== engine || seen.has(run.id) || runAlive(run, now)) continue;
      const s = summarize(run);
      const [a0, a1] = span(run);
      const beside = [...new Set(runs.filter((o) => o !== run && o.meta.pid !== run.meta.pid && span(o)[0] < a1 && (runAlive(o, now) ? now : span(o)[1]) > a0).map((o) => o.meta.kind))].sort();
      const list = (e.kinds[run.meta.kind] || []).filter((x) => x.id !== run.id);
      const short = !run.rows.length;
      list.push({ id: run.id, at: s.at, gb: short ? null : s.peakGb, ...(short ? { short: true } : {}), cpu: s.cpuPct, minutes: s.minutes, when: s.when, code: s.code, ...(beside.length ? { with: beside } : {}) });
      e.kinds[run.meta.kind] = list.slice(-KEEP_RUNS);
      seen.add(run.id);
      changed = true;
      for (const other of beside) {
        const k = pairKey(run.meta.kind, other);
        const p = e.pairs[k];
        if (p && now < p.stoppedAt + RETRY_HOURS * 3600000) continue;
        const v = pairVerdict(e.kinds, run.meta.kind, other, p ? p.stoppedAt : 0, cfg.slowerPct);
        if (!v) continue;
        e.pairs[k] = { stoppedAt: now, why: v.why };
        try { emit?.({ type: 'machine.overlap_stopped', agent: 'harness', status: 'warn', msg: `${k} no longer run at the same time: ${v.why}. They are tried together again after ${RETRY_HOURS} h.`.slice(0, 600), meta: { engine, pair: [run.meta.kind, other].sort(), retryAt: new Date(now + RETRY_HOURS * 3600000).toISOString() } }); } catch { /* the store says it */ }
      }
    }
    // Prune: per folder, ended or dead files beyond the newest KEEP_FILES or older than KEEP_DAYS.
    const byDir = new Map();
    for (const run of runs) { const d = path.dirname(run.file); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(run); }
    for (const list of byDir.values()) {
      list.sort((x, y) => Number(y.meta.at) - Number(x.meta.at));
      list.forEach((run, i) => { if (!runAlive(run, now) && (i >= KEEP_FILES || now - Number(run.meta.at) > KEEP_DAYS * 86400000)) { try { fs.rmSync(run.file, { force: true }); } catch { /* next time */ } } });
    }
    if (changed) {
      e.seen = [...seen].slice(-400);
      const cur = readJson(ramFile(root), {}) || {};
      cur[engine] = { ...(cur[engine] || {}), kinds: e.kinds, seen: e.seen, pairs: e.pairs };
      writeAtomic(ramFile(root), `${JSON.stringify(cur, null, 2)}\n`);
    }
  } catch { /* the store stays as it was */ }
  return e;
}

/**
 * A kind's cost from its kept runs: { kind, runs, measured, peakGb, needGb, passPeakGb, passN, cpuPct, minutes, when } or
 * null. A run too short to sample is unknown: it adds no peak. A kind with only such runs has unknown: true and no peak.
 */
export function kindCost(entry, kind) {
  const list = (entry?.kinds?.[kind] || []).slice(-PEAK_RUNS);
  if (!list.length) return null;
  const known = list.filter((r) => !unknownRun(r));
  const passed = list.filter((r) => r.code === 0);
  if (!known.length) return { kind, runs: list.length, unknown: true, measured: false, peakGb: null, needGb: null, passPeakGb: null, passN: 0, cpuPct: null, minutes: avg(list.map((r) => r.minutes)), when: null };
  const peak = Math.max(...known.map((r) => Number(r.gb)));
  const passedKnown = known.filter((r) => r.code === 0);
  return { kind, runs: list.length, measured: passedKnown.length > 0 && peak > 0, peakGb: peak, needGb: r1(peak + Math.max(0.5, peak * 0.1)), passPeakGb: passedKnown.length ? Math.max(...passedKnown.map((r) => Number(r.gb))) : null, passN: passedKnown.length, cpuPct: avg(known.map((r) => r.cpu)), minutes: avg(passed.map((r) => r.minutes)), when: known.find((r) => Number(r.gb) === peak)?.when || null };
}

/**
 * 2.97: the free RAM a land run of `kind` waits for, from that kind's own passed sampled runs: the peak of the last
 * ones plus STUDIO_ENGINE_RAM_MARGIN_GB (1.5), at least STUDIO_ENGINE_RAM_MIN_GB (4). No kind: the heaviest land kind
 * measured, and the text says so. { gb, kind, n, from } or null (no such run, or STUDIO_ENGINE_RAM_RUNS=0).
 */
export function landNeed(engine, kind, { root, env = process.env } = {}) {
  if (!(num(env.STUDIO_ENGINE_RAM_RUNS, 3) > 0)) return null;
  const entry = (readJson(ramFile(root), {}) || {})[engine];
  const margin = Math.max(0, num(env.STUDIO_ENGINE_RAM_MARGIN_GB, 1.5));
  const min = Math.max(0, num(env.STUDIO_ENGINE_RAM_MIN_GB, 4));
  const one = (k) => { const c = kindCost(entry, k); return c?.passN > 0 ? { kind: k, n: c.passN, gb: Math.max(min, Math.ceil((c.passPeakGb + margin) * 10) / 10), peak: c.passPeakGb } : null; };
  const all = kind ? [one(kind)] : Object.keys(entry?.kinds || {}).filter((k) => k.startsWith('land')).map(one);
  const top = all.filter(Boolean).sort((x, y) => y.gb - x.gb)[0];
  if (!top) return null;
  return { ...top, from: `${kind ? '' : 'no kind given, so the heaviest land kind measured: '}need of ${top.kind} (peak of its last ${top.n} passed run${top.n > 1 ? 's' : ''} plus ${margin} GB)` };
}

/**
 * The decision, pure. f: { kind, label, own (kindCost or null), handGb, running: [{ kind, label, nowGb, cost, ageMs,
 * everyMs }], unsampled: [{ label, gb }], freeGb, floorGb, cpuNowPct, cpuCapPct, stopped: [{ kinds: [a, b], why, until }] }.
 * { decided: false, why } means today's rule decides; else { decided: true, ok, area, line, needGb, roomGb }.
 */
export function admitPlan(f) {
  const back = (why) => ({ decided: false, why: `${why}: today's rule decides` });
  const L = f.label || f.kind;
  const need = Number(f.handGb) > 0 ? Number(f.handGb) : f.own?.measured ? f.own.needGb : null;
  if (need === null) return back(f.own?.unknown ? `${L} is ${shortText(f.own.minutes)}, so it has no measured peak` : `${L} has no measured peak yet (this run measures it)`);
  if (!Number.isFinite(f.freeGb)) return back('free RAM is not known');
  let grow = 0;
  const growing = [];
  for (const r of f.running || []) {
    const rl = `${r.label || r.kind}`;
    if (!r.cost?.measured) return back(r.cost?.unknown ? `${rl} is running and is ${shortText(r.cost.minutes)}, so it has no measured peak` : `${rl} is running and has no measured peak yet`);
    if (r.ageMs > Math.max(3 * (r.everyMs || 10000), 60000)) return back(`${rl}'s last sample is ${Math.round(r.ageMs / 1000)} s old`);
    if (r.nowGb > r.cost.needGb) return back(`${rl} uses ${r.nowGb} GB now, more than its measured ${r.cost.needGb} GB: the number looks wrong`);
    const g = r1(r.cost.needGb - r.nowGb);
    grow += g;
    if (g > 0) growing.push(`${rl} still has ${g} GB to grow`);
  }
  for (const u of f.unsampled || []) { grow += Number(u.gb) || 0; if (u.gb > 0) growing.push(`${u.label} is counted at ${u.gb} GB (no sample of it yet)`); }
  for (const p of f.stopped || []) {
    const other = (f.running || []).find((r) => p.kinds.includes(r.kind) && p.kinds.includes(f.kind) && (r.kind !== f.kind || p.kinds[0] === p.kinds[1]));
    if (other) return { decided: true, ok: false, area: 'pair', needGb: need, line: `waits: ${f.kind} and ${other.kind} do not run together until ${new Date(p.until).toISOString().slice(0, 16)} UTC (${p.why})` };
  }
  const above = r1(f.freeGb - (f.floorGb || 0));
  const room = r1(above - grow);
  const besides = growing.length ? `; ${growing.join('; ')}` : '';
  if (room < need) return { decided: true, ok: false, area: 'ram', needGb: need, roomGb: room, line: `waits for memory: needs ${need} GB, ${above} GB free above the floor${besides}` };
  const cpuOwn = f.own?.cpuPct;
  if (Number.isFinite(f.cpuNowPct) && Number.isFinite(cpuOwn) && f.cpuNowPct + cpuOwn > f.cpuCapPct) return { decided: true, ok: false, area: 'cpu', needGb: need, roomGb: room, line: `waits for CPU: ${Math.round(f.cpuNowPct)}% busy now plus its ${cpuOwn}% is over the ${f.cpuCapPct}% cap (studio/game.json machine.cpuCapPct)` };
  return { decided: true, ok: true, area: null, needGb: need, roomGb: room, line: `measured: needs ${need} GB, ${above} GB free above the floor${besides}: it fits` };
}

/**
 * Gather the facts and decide for one job of `kind` (engine `engine`). holders: the live machine:heavy records (their
 * claims count when no sampled run of theirs is seen). { decided: false, off: true } when measured admission is off.
 */
export function measuredAdmit({ root, engine, kind, label = null, handGb = null, holders = [], env = process.env, now = Date.now(), cpuNowPct = undefined, emit = emitEvent } = {}) {
  try {
    const cfg = machineCfg(root);
    if (!cfg.measured) return { decided: false, off: true, why: 'measured admission is off (studio/game.json machine.admit)' };
    const live = liveRuns(root, now);
    const entries = {};
    const entry = (eng) => (entries[eng] = entries[eng] || foldRuns(root, eng, { now, emit }));
    const running = live.map((r) => ({ ...r, cost: kindCost(entry(r.engine), r.kind) }));
    const seenHolders = new Set(live.map((r) => Number(r.holder)));
    // A heavy job with no sampled run yet (its run about to start) counts the larger of its claim and its measured need.
    const unsampled = (holders || []).filter((h) => h && Number(h.pid) !== process.pid && !seenHolders.has(Number(h.pid))).map((h) => {
      const c = h.measure?.kind ? kindCost(entry(String(h.measure.engine)), String(h.measure.kind)) : null;
      return { label: h.label || 'a heavy job', gb: Math.max(Number(claimOf(h).ramGb) || 0, c?.measured ? c.needGb : 0) };
    });
    let freeGb = readFreeGb(env);
    for (const r of live) {
      const s = r.sample;
      if (!s || r.ageMs > 2 * r.everyMs + 5000) continue;
      const commit = Number.isFinite(s.commitLimitGb) && Number.isFinite(s.commitUsedGb) ? s.commitLimitGb - s.commitUsedGb : NaN;
      for (const x of [s.availGb, commit]) if (Number.isFinite(x) && (freeGb === null || x < freeGb) && env.STUDIO_TEST_FREEMEM_MB === undefined) freeGb = r1(x);
    }
    let cpu = cpuNowPct;
    if (cpu === undefined) { const fresh = live.find((r) => r.ageMs < 2 * r.everyMs && Number.isFinite(r.machineCpuPct)); cpu = fresh ? fresh.machineCpuPct : (() => { const b = sampleCpuBusy(); return b === null ? null : b * 100; })(); }
    const pairs = entry(engine).pairs || {};
    const stopped = Object.entries(pairs).filter(([, p]) => now < p.stoppedAt + RETRY_HOURS * 3600000).map(([k, p]) => ({ kinds: k.split(' + '), why: p.why, until: p.stoppedAt + RETRY_HOURS * 3600000 }));
    return admitPlan({ kind, label, own: kindCost(entry(engine), kind), handGb, running, unsampled, freeGb: freeGb === null ? NaN : freeGb, floorGb: floorGbOf(env), cpuNowPct: cpu, cpuCapPct: cfg.cpuCapPct, stopped });
  } catch (e) { return { decided: false, why: `the measured numbers could not be read (${String(e?.message || e).slice(0, 80)}): today's rule decides` }; }
}

/**
 * Wait until a measured decision admits the job (or none applies). { ...decision, waitedMs, timedOut? }. log gets a line
 * each time what it waits for changes. holders(): the live heavy records, read again each poll.
 */
export function waitAdmit({ waitMs = 20 * 60000, pollMs = 2000, log = () => {}, holders = () => [], sleep = sleepSync, ...o } = {}) {
  const t0 = Date.now();
  let told = '';
  for (;;) {
    const d = measuredAdmit({ ...o, holders: holders() });
    if (!d.decided || d.ok) { if (d.decided && told) log(`${o.label || o.kind} ${d.line}`); return { ...d, waitedMs: Date.now() - t0 }; }
    if (Date.now() - t0 >= waitMs) return { ...d, waitedMs: Date.now() - t0, timedOut: true };
    if (d.line !== told) { log(`${o.label || o.kind} ${d.line}`); told = d.line; }
    sleep(pollMs);
  }
}

/** The numbers of one sampled run for its result line and event: { peakGb, cpuPct, minutes } or null. */
export function runNumbers(sample) {
  const run = sample?.file ? readRun(sample.file) : null;
  if (!run || !run.rows.length) return null;
  const s = summarize(run);
  return { peakGb: s.peakGb, cpuPct: s.cpuPct, minutes: s.minutes };
}
export const numbersText = (m) => (m ? `peak ${m.peakGb} GB, CPU ${m.cpuPct ?? '?'}%, ${m.minutes} min` : '');

/** For train status: one line per run going on, with its numbers now, its peak so far and its reservation. */
export function runningLines(root, now = Date.now()) {
  const entries = {};
  return liveRuns(root, now).map((r) => {
    const c = kindCost((entries[r.engine] = entries[r.engine] || foldRuns(root, r.engine, { now })), r.kind);
    return `Running ${r.label}: ${r.nowGb} GB and ${r.cpuPct ?? '?'}% CPU now, ${r.peakGb} GB at most so far; reservation ${c?.unknown ? shortText(c.minutes) : c?.measured ? `${c.needGb} GB (peak ${c.peakGb} GB of its last ${c.runs} run(s) plus margin)` : 'not measured yet (today\'s rule)'}`;
  });
}

/** For rules show: each measured kind of `engine` whose name starts with one of `prefixes`, and the setting. */
export function costLines(root, engine, prefixes = ['rules', 'land']) {
  const e = foldRuns(root, engine);
  const cfg = machineCfg(root);
  const lines = [`measured admission: ${cfg.measured ? 'on' : 'off'} (studio/game.json machine.admit "measured"); CPU cap ${cfg.cpuCapPct}%; samples ${cfg.sample ? `every ${cfg.everyMs / 1000} s` : 'off'}`];
  for (const kind of Object.keys(e.kinds).filter((k) => prefixes.some((p) => k === p || k.startsWith(`${p} `))).sort()) {
    const c = kindCost(e, kind);
    if (c?.unknown) lines.push(`  ${kind}: ${shortText(c.minutes)}, no peak known; ${c.runs} run(s)`);
    else if (c) lines.push(`  ${kind}: peak ${c.peakGb} GB (reserves ${c.needGb} GB${c.measured ? '' : '; no run passed yet, so not used'}), CPU ${c.cpuPct ?? '?'}%, ${c.minutes ?? '?'} min, peak ${c.when === 'throughout' ? 'throughout' : `at the ${c.when || '?'}`}; ${c.runs} run(s)`);
  }
  for (const [k, p] of Object.entries(e.pairs)) lines.push(`  not run together: ${k} until ${new Date(p.stoppedAt + RETRY_HOURS * 3600000).toISOString().slice(0, 16)} UTC (${p.why})`);
  return lines;
}
