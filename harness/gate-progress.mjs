/**
 * harness/gate-progress.mjs — 2.77.0: a verify's live progress, so the War Room's Train Room shows a real loading bar.
 *
 * scripts/run-gates.mjs writes, as it goes:
 *   .studio/gates/progress/<owner>.json   { owner, startedAt, gates: [ids in run order], done: [{ id, ms, ok, cached }],
 *                                          current: { id, startedAt } | null, endedAt }   (owner: STUDIO_LOCK_OWNER, the
 *                                          merge train's verify runs as train-<id>; "full" without one)
 *   .studio/gates/gate-times.json         { <gate id>: [ms, …] } the last 10 passing runs of each gate (cached rows
 *                                          don't count), the history the ETA comes from
 * progressOf() turns them into { percent, done, total, step, etaMs, estimate, why }: percent is the gates finished out
 * of the gates this run has; the ETA is the median recorded time of each gate still to run plus what is left of the
 * running one; `estimate` is true when any of those gates has fewer than 3 recorded runs. Writes never throw.
 */
import fs from 'node:fs';
import path from 'node:path';

const KEEP = 10;
const safeName = (s) => String(s || 'full').replace(/[^\w.-]/g, '_').slice(0, 80) || 'full';
export const progressFile = (stateDir, owner) => path.join(stateDir, 'gates', 'progress', `${safeName(owner)}.json`);
export const timesFile = (stateDir) => path.join(stateDir, 'gates', 'gate-times.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeJson(f, v) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(v)}\n`);
    fs.renameSync(tmp, f);
  } catch { /* progress is a convenience: the verify itself never depends on it */ }
}

/** A run's progress writer. gates: the ids in the order they run. */
export function startProgress({ stateDir, owner = null, gates = [], now = Date.now() } = {}) {
  const file = progressFile(stateDir, owner);
  const state = { owner: owner || 'full', pid: process.pid, startedAt: new Date(now).toISOString(), gates: gates.map(String), done: [], current: null, endedAt: null };
  writeJson(file, state);
  return {
    started(id, at = Date.now()) { state.current = { id: String(id), startedAt: new Date(at).toISOString() }; writeJson(file, state); },
    finished(id, { ms = 0, ok = true, cached = false } = {}) { state.done.push({ id: String(id), ms: Math.max(0, Math.round(ms)), ok: Boolean(ok), cached: Boolean(cached) }); state.current = null; writeJson(file, state); },
    end(at = Date.now()) { state.current = null; state.endedAt = new Date(at).toISOString(); writeJson(file, state); },
    state,
  };
}

/** Add this run's passing, not cached rows to the gate history (the last KEEP runs of each gate). */
export function recordGateTimes(stateDir, rows = []) {
  const f = timesFile(stateDir);
  const t = readJson(f) || {};
  let changed = false;
  for (const r of rows) {
    if (!r || !r.ok || r.cached || !Number.isFinite(r.ms) || r.ms <= 0) continue;
    t[r.id] = [...(Array.isArray(t[r.id]) ? t[r.id] : []), Math.round(r.ms)].slice(-KEEP);
    changed = true;
  }
  if (changed) writeJson(f, t);
  return t;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

/**
 * The bar for a run: { owner, percent, done, total, step, stepElapsedMs, etaMs, estimate, ended, why } or null (no
 * progress file). The percent counts finished gates; within the running gate nothing is guessed.
 */
export function progressOf(stateDir, owner, { now = Date.now(), times = null } = {}) {
  const p = readJson(progressFile(stateDir, owner));
  if (!p || !Array.isArray(p.gates)) return null;
  const hist = times || readJson(timesFile(stateDir)) || {};
  const total = p.gates.length;
  const doneIds = new Set((p.done || []).map((d) => d.id));
  const done = doneIds.size;
  const left = p.gates.filter((g) => !doneIds.has(g) && g !== p.current?.id);
  const sample = (g) => (Array.isArray(hist[g]) ? hist[g] : []);
  const cur = p.current?.id || null;
  const curElapsed = cur ? Math.max(0, now - (Date.parse(p.current.startedAt) || now)) : 0;
  const need = [...left, ...(cur ? [cur] : [])];
  const unknown = need.filter((g) => !sample(g).length);
  let etaMs = null;
  if (!p.endedAt && !unknown.length) {
    etaMs = left.reduce((n, g) => n + median(sample(g)), 0) + (cur ? Math.max(0, median(sample(cur)) - curElapsed) : 0);
    etaMs = Math.round(etaMs);
  }
  const thin = need.filter((g) => sample(g).length < 3);
  return {
    owner: p.owner, startedAt: p.startedAt, ended: Boolean(p.endedAt), percent: total ? Math.round((100 * done) / total) : 0, done, total,
    step: cur, stepElapsedMs: curElapsed, failed: (p.done || []).filter((d) => !d.ok).map((d) => d.id),
    etaMs, estimate: Boolean(thin.length), why: unknown.length ? `no recorded run yet of ${unknown.slice(0, 3).join(', ')}` : thin.length ? `fewer than 3 recorded runs of ${thin.slice(0, 3).join(', ')}` : '',
  };
}
