/**
 * harness/train-parallel.mjs — 2.69.0 (q): a red merge train's prefix search checks several prefixes at once.
 *
 * Two red trains overnight bisected for 75-95 min each: 2.65.3 made each re-check short (the failing test files only)
 * but still asked one prefix per round. Zuul and Uber's SubmitQueue check candidate prefixes in parallel; here the
 * binary search becomes a K-ary search: [lo, hi] (lo green, hi red) is split into K+1 parts and the K boundary
 * prefixes are re-checked at once, each in its own scratch copy, each run-gates taking its own machine:heavy claim.
 * The answer is the same (the first red prefix: the smallest red boundary, the largest green one before it), in about
 * log_{K+1} N rounds instead of log2 N.
 *
 * K (bisectWidth) = how many focused re-check claims fit the machine budget NOW (harness/heavy-budget.mjs: the last
 * machine scan, the live heavy holders, the slot count, RAM, CPU), capped by STUDIO_TRAIN_BISECT_PARALLEL (default 4;
 * 1/off: one at a time). No scan (or a machine too busy for a second claim): K = 1, the 2.65.3 search unchanged.
 * A focused re-check runs a few test files: its claim (and its run) uses that many test workers (2..8), not a whole
 * verify's. If the estimate is off, run-gates still waits for its own claim: never two jobs past the budget.
 * Imports nothing from train.mjs (no cycle); heavy.mjs only dynamically.
 */
import { spawn } from 'node:child_process';
import { busyWhy, ranNoCheck, busyWaitMs } from './train-busy.mjs';
import { machineProfile, slotsFor, budgetState, jobClaim, admit, maxConcurrent } from './heavy-budget.mjs';

const isOff = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());

/** STUDIO_TRAIN_BISECT_PARALLEL: the most prefixes checked at once (default 4; off/0/1: one). */
export function parallelCap(env = process.env) {
  const raw = String(env.STUDIO_TRAIN_BISECT_PARALLEL ?? '').trim();
  if (raw === '') return 4;
  if (isOff(raw)) return 1;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 16) : 4;
}

/** Test workers for a focused re-check of nFiles test files: 2..8 (STUDIO_TEST_WORKERS wins). */
export const focusWorkers = (nFiles, env = process.env) => (Number(env.STUDIO_TEST_WORKERS) > 0 ? Math.floor(Number(env.STUDIO_TEST_WORKERS)) : Math.max(2, Math.min(8, Number(nFiles) || 2)));

/**
 * How many re-checks may run at once now: { k, why, cap }. Simulates taking one focused re-check claim after another
 * (admit, as run-gates' own take will) until one doesn't fit. opts.machine / opts.holders are test hooks.
 */
export async function bisectWidth({ root, env = process.env, machine, holders, nFiles = 0 } = {}) {
  const cap = parallelCap(env);
  if (cap <= 1) return { k: 1, cap, why: `STUDIO_TRAIN_BISECT_PARALLEL=${env.STUDIO_TRAIN_BISECT_PARALLEL}: one prefix at a time` };
  const profile = machineProfile(root, { env, ...(machine !== undefined ? { machine } : {}) });
  if (!profile) return { k: 1, cap, why: 'no machine scan: one prefix at a time, as before (npm run machine writes one)' };
  let live = holders;
  if (!Array.isArray(live)) { try { live = (await import('./heavy.mjs')).heavyHolders(root, { env }); } catch { live = []; } }
  const slots = slotsFor(profile, env);
  const kindMax = maxConcurrent('verify', { root, env });
  const e = nFiles > 0 ? { ...env, STUDIO_TEST_WORKERS: String(focusWorkers(nFiles, env)) } : env;
  const sim = [...live];
  let k = 0;
  let stop = '';
  for (; k < cap; k += 1) {
    const state = budgetState(profile, sim, { env: e });
    const claim = jobClaim('verify', { root, env: e, state, profile, label: 'train re-check', as: 'train' }); // 2.76.0 (j, B-89): the train's own
    const a = admit(claim, state, { slots, holders: sim, kindMax });
    if (!a.ok || a.alone) { stop = a.line || 'it would run alone'; break; }
    sim.push({ at: Date.now() + 1 + k, claim, pid: 0 });
  }
  const n = Math.max(1, k);
  const held = live.length ? `, ${live.length} heavy job(s) running` : '';
  return { k: n, cap, why: `${n} re-check(s) fit the machine budget now${held}${k < cap && stop ? ` (the next: ${stop})` : ''}; cap ${cap} (STUDIO_TRAIN_BISECT_PARALLEL)` };
}

/** The K boundary prefixes between a green lo and a red hi (exclusive), split into K+1 parts; all of them when few. */
export function karyPoints(lo, hi, k) {
  const m = hi - lo;
  if (m <= 1) return [];
  if (m - 1 <= k) return Array.from({ length: m - 1 }, (_, i) => lo + i + 1);
  const pts = [];
  for (let i = 1; i <= k; i += 1) { const p = lo + Math.floor((i * m) / (k + 1)); if (p > lo && p < hi && !pts.includes(p)) pts.push(p); }
  return pts;
}

/** Worst-case { rounds, probes } of a K-ary search over m lanes (K = 1: ceil(log2 m) rounds, as stepsLeft). */
export function karyCost(m, k) {
  let rounds = 0;
  let probes = 0;
  let size = Math.max(1, m);
  while (size > 1) {
    const pts = karyPoints(0, size, Math.max(1, k));
    rounds += 1;
    probes += pts.length;
    let gap = 0;
    let prev = 0;
    for (const p of [...pts, size]) { gap = Math.max(gap, p - prev); prev = p; }
    size = gap;
  }
  return { rounds, probes };
}

/**
 * The K-ary search for the first red prefix. lo is green, hi is red (or only said red by the verify). Each round
 * probe(points, round, { lo, hi, sawRed }) resolves to one result per point ({ ok } or { stop }: stop ends the search).
 * Returns { lo, hi, red, steps: [{ k, ok }], rounds } or { stop, steps, rounds }.
 */
export async function karySearch({ lo = 0, hi, k = 1, probe }) {
  const steps = [];
  let red = null;
  let rounds = 0;
  while (hi - lo > 1) {
    const pts = karyPoints(lo, hi, k);
    rounds += 1;
    const rs = await probe(pts, rounds, { lo, hi, sawRed: Boolean(red) });
    const stopAt = rs.findIndex((r) => !r || r.stop);
    if (stopAt >= 0) return { stop: rs[stopAt]?.stop || { why: 'no result' }, steps, rounds };
    let nlo = lo;
    let nhi = hi;
    let nred = red;
    let seenRed = false;
    for (let i = 0; i < pts.length; i += 1) {
      steps.push({ k: pts[i], ok: Boolean(rs[i].ok) });
      if (seenRed) continue;
      if (rs[i].ok) nlo = pts[i];
      else { nhi = pts[i]; nred = rs[i]; seenRed = true; }
    }
    lo = nlo; hi = nhi; red = nred;
  }
  return { lo, hi, red, steps, rounds };
}

/** spawn, collected: resolves { status, stdout, stderr } (never rejects). */
export function spawnCollect(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try { child = spawn(cmd, args, { ...opts, windowsHide: true }); } catch (e) { resolve({ status: 1, stdout: '', stderr: String(e?.message || e) }); return; }
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += String(e?.message || e); });
    child.on('close', (code, signal) => resolve({ status: code ?? (signal ? 1 : 0), signal, stdout, stderr }));
  });
}

/** runGatesWaiting (harness/train-busy.mjs) for an async run: a busy refusal waits and runs again, bounded. */
export async function runGatesWaitingAsync(once, { log = () => {}, label = 're-check', env = process.env, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const limit = busyWaitMs(env);
  const t0 = now();
  let tries = 0;
  for (;;) {
    tries += 1;
    const r = await once();
    const text = `${r.stdout || ''}${r.stderr || ''}`;
    const busy = r.status !== 0 ? busyWhy(text) : '';
    const noCheck = r.status !== 0 && ranNoCheck(text);
    const waited = now() - t0;
    if (!busy || waited >= limit) {
      if (busy) log(`${label}: still busy after ${Math.round(waited / 1000)} s (STUDIO_TRAIN_BUSY_WAIT_MIN): ${busy}`);
      return { r, text, busy, noCheck: noCheck || Boolean(busy), tries, waitedMs: waited };
    }
    const step = Math.min(30000, Math.max(1000, Math.round(limit / 10)), Math.max(0, limit - waited));
    log(`${label}: busy, not red (${busy}); waiting ${Math.round(step / 1000)} s and running it again`);
    await sleep(step);
  }
}
