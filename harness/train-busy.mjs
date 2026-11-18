/**
 * harness/train-busy.mjs — a train's verify that ran no check is "busy", never red: a run refused before any gate ran
 * (e.g. "a full verify of this checkout is already running") says nothing about the tree it was given.
 *   busyWhy(text)       why the run didn't start (a full verify of the same checkout running, the machine:heavy lock
 *                       still held past its wait, free memory under the floor), or '';
 *   ranNoCheck(text)    the run printed no gate result at all ([gates] PASS / FAIL);
 *   runGatesWaiting()   runs the gates; while refused as busy it waits and runs again (STUDIO_TRAIN_BUSY_WAIT_MIN,
 *                       default 20 minutes in all), then returns the last run with { busy, noCheck } so the train
 *                       defers its lanes.
 * No imports from the rest of the harness: train.mjs loads it.
 */

const BUSY = [
  /\[verify\] refused: a full verify of this checkout is already running[^\n]*/,
  /\[heavy\][^\n]* did not (?:run|start)[^\n]*/,
];

/** Why a run refused to start (busy), or ''. */
export function busyWhy(text) {
  for (const re of BUSY) { const m = String(text || '').match(re); if (m) return m[0].trim().slice(0, 400); }
  return '';
}

/** True when the run's output shows no gate result at all: it judged nothing. */
export const ranNoCheck = (text) => !/^\[gates\] (?:PASS|FAIL) /m.test(String(text || ''));

/** How long a train waits in all for a busy verify (STUDIO_TRAIN_BUSY_WAIT_MIN, default 20; 0: no wait). */
export function busyWaitMs(env = process.env) {
  const raw = String(env.STUDIO_TRAIN_BUSY_WAIT_MIN ?? '').trim();
  const v = raw === '' ? 20 : Number(raw);
  return Number.isFinite(v) && v > 0 ? v * 60000 : 0;
}

/**
 * Judge one run of a waiting loop: { out } when the loop is over (the result to return), else { busy, waited, step },
 * the busy reason, the ms waited so far and the ms to wait before the next run.
 */
export function busyVerdict(r, { t0, limit, tries, label, now, log }) {
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const busy = r.status !== 0 ? busyWhy(text) : '';
  const noCheck = r.status !== 0 && ranNoCheck(text);
  const waited = now() - t0;
  if (!busy || waited >= limit) {
    if (busy) log(`${label}: still busy after ${Math.round(waited / 1000)} s (STUDIO_TRAIN_BUSY_WAIT_MIN): ${busy}`);
    return { out: { r, text, busy, noCheck: noCheck || Boolean(busy), tries, waitedMs: waited } };
  }
  return { busy, waited, step: Math.min(30000, Math.max(1000, Math.round(limit / 10)), Math.max(0, limit - waited)) };
}

const nap = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Run `once()` (a spawnSync of run-gates; returns { status, stdout, stderr }) until it isn't refused as busy or the wait
 * is spent. Returns { r, text, busy, noCheck, tries, waitedMs }.
 */
export function runGatesWaiting(once, { log = () => {}, label = 'verify', env = process.env, now = () => Date.now() } = {}) {
  const limit = busyWaitMs(env);
  const t0 = now();
  let tries = 0;
  for (;;) {
    tries += 1;
    const r = once();
    const v = busyVerdict(r, { t0, limit, tries, label, now, log });
    if (v.out) return v.out;
    const { busy, step } = v;
    log(`${label}: busy, not red (${busy}); waiting ${Math.round(step / 1000)} s and running it again (${Math.round((limit - v.waited) / 1000)} s of STUDIO_TRAIN_BUSY_WAIT_MIN left)`);
    nap(step);
  }
}
