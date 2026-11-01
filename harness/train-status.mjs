/**
 * harness/train-status.mjs — 2.65.3 (B-43): what a running merge train is doing now, and when it should end.
 *
 * The crew watched a 9-lane red train run re-check after re-check for an hour with no word on what each one decided
 * or how long was left. Now each step of a train (verify, re-check, round, prefix landing) is written to
 * .studio/train/<id>/status.json: { train, at, step, text, lanes, round, eta: { ms, text } }. `npm run lanes` and
 * `status --brief` read it while that train holds .studio/locks/train.lock (readTrainStatus), and mention
 * STUDIO_TRAIN_MAX when the running train has more than 6 lanes (capNote).
 *
 * The ETA (trainEta) comes from this train's own measured durations: the bisection's re-checks left x the mean
 * re-check time, plus one full verify (the last verify's duration, else the game checks' recorded quiet runs). Before
 * any re-check is timed the verify's duration stands in for one, and says so; with nothing measured at all it says
 * "ETA unknown (no timing yet)". Imports nothing from train.mjs (no cycle).
 */
import fs from 'node:fs';
import path from 'node:path';

const statusFile = (root, id) => path.join(root, '.studio', 'train', String(id), 'status.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Seconds or minutes, in words: "40 s", "12 min", "1 h 5 min". */
export function durText(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Bisection re-checks left between a green lo and a red hi (lanes lo+1..hi), plus the confirm when no red was seen. */
export const stepsLeft = (lo, hi, sawRed = true) => Math.max(0, Math.ceil(Math.log2(Math.max(1, hi - lo)))) + (sawRed ? 0 : 1);

/**
 * { ms, text } for `rechecks` re-checks left plus `verifies` full verifies. recheckMs: this train's timed re-checks;
 * verifyMs: its last verify's duration (or a recorded quiet-run figure, quiet: true). ms is null when unknown.
 */
export function trainEta({ rechecks = 0, verifies = 1, recheckMs = [], verifyMs = null, quiet = false } = {}) {
  const timed = (recheckMs || []).filter((x) => Number(x) > 0);
  const v = Number(verifyMs) > 0 ? Number(verifyMs) : null;
  if (!v && !timed.length) return { ms: null, text: 'ETA unknown (no timing yet)' };
  const per = timed.length ? timed.reduce((a, b) => a + b, 0) / timed.length : v;
  const vMs = v || per;
  const ms = Math.round(rechecks * per + verifies * vMs);
  const how = [rechecks ? `${rechecks} re-check(s) x ${durText(per)}${timed.length ? '' : ` (no re-check timed yet: the ${quiet ? 'recorded quiet run' : 'verify'} stands in)`}` : '', verifies ? `${verifies} verify x ${durText(vMs)}${v ? (quiet ? ' (recorded quiet runs)' : '') : ' (no verify timed: a re-check stands in)'}` : ''].filter(Boolean).join(' + ');
  return { ms, text: `ETA ~${durText(ms)} (${how})` };
}

/** The game checks' recorded quiet runs, summed (.studio/gates/game-gate-times.json, "<game>:<check>"), or null. */
export function quietVerifyMs(root, game) {
  if (!game) return null;
  const j = readJson(path.join(root, '.studio', 'gates', 'game-gate-times.json'));
  if (!j || typeof j !== 'object') return null;
  let sum = 0;
  for (const [k, v] of Object.entries(j)) if (k.startsWith(`${game}:`) && Number(v?.ms) > 0) sum += Number(v.ms);
  return sum > 0 ? sum : null;
}

/** Write train `id`'s current step. Never throws. */
export function writeTrainStatus(root, id, s) {
  try {
    const f = statusFile(root, id);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ train: id, at: new Date().toISOString(), ...s }, null, 2)}\n`);
    fs.renameSync(tmp, f);
  } catch {}
}

/** The running train's status (the one holding .studio/locks/train.lock, its process alive), or null. */
export function readTrainStatus(root) {
  const lock = readJson(path.join(root, '.studio', 'locks', 'train.lock'));
  if (!lock?.id || (lock.pid && !alive(lock.pid))) return null;
  const s = readJson(statusFile(root, lock.id));
  return s ? { ...s, by: lock.by || null, since: lock.at ? new Date(lock.at).toISOString() : null } : { train: lock.id, by: lock.by || null, since: lock.at ? new Date(lock.at).toISOString() : null, step: 'starting', text: 'starting', eta: null };
}

/** A note when a train has more than 6 lanes: STUDIO_TRAIN_MAX caps them ('' otherwise). */
export function capNote(lanes, env = process.env) {
  const n = Number(lanes) || 0;
  if (n <= 6) return '';
  const max = Number(String(env.STUDIO_TRAIN_MAX ?? '').trim() || 0);
  return `this train has ${n} lanes; a red one bisects longer (about log2 ${n} re-checks per bad lane). STUDIO_TRAIN_MAX caps a train's lanes (${max > 0 ? `now ${max}` : 'now 0: no cap'}; 4-6 keeps a red train short)`;
}

/** One line for the lanes table and the brief: "Train <id>: <step text>; <ETA>". */
export function trainStatusLine(s, { short = false } = {}) {
  if (!s) return '';
  const eta = s.eta?.text ? (short ? s.eta.text.replace(/\s*\(.*\)$/, '') : s.eta.text) : '';
  const text = short ? String(s.text || s.step || '').split(';')[0].slice(0, 80) : String(s.text || s.step || '');
  return `Train ${s.train}${s.lanes ? ` (${s.lanes} lanes)` : ''}: ${text}${eta ? `; ${eta}` : ''}`;
}
