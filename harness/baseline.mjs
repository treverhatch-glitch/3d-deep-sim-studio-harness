/**
 * harness/baseline.mjs — 2.54.0 (PU-06): what was already red when a task was claimed, and a red trunk.
 *
 * Why: in the first crew run on Hatchfield, the game's own trunk had 8 browser tests failing (red on GitHub since
 * Oct 17). Every task's done-check then failed on checks the task never touched, and the only way out was --force.
 * Following SWE-bench's pass-to-pass rule (a task must keep green what was green; it isn't blamed for what was
 * already red):
 *
 *   1. task start records the last full check run as the task's baseline: each required check that was red, with
 *      the failing test names when the check printed them (.studio/baseline/<task>.json);
 *   2. the done-check then fails only on checks that were green at claim, or on failing tests that are new. A
 *      check that was red with no test names to compare stays excused, with a note saying so;
 *   3. a red trunk: `npm run task -- trunk red --by <name> --why "<why>"` (for example the game's GitHub CI), or
 *      the whole-game check (STUDIO_WHOLE_GAME=on) last finishing red. While it is red, only fix tasks start
 *      (a title starting Fix/Bug/Hotfix/Repair/Revert, a [fix] or [bug] tag, or a whole-game red task); work
 *      already in progress carries on. `npm run task -- trunk green --by <name>` ends it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';

const BASE_DIR = () => path.join(STUDIO_STATE_DIR, 'baseline');
const TRUNK_FILE = () => path.join(STUDIO_STATE_DIR, 'trunk.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const ANSI = /\u001b\[[0-9;]*m/g;

/** Failing test names from a check's output (Vitest, Jest, Node test, pytest, gdUnit-style lines). */
export function failingTests(output) {
  const out = new Set();
  for (const raw of String(output || '').replace(ANSI, '').split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:FAIL|FAILED|×|✗|✖|not ok \d+)\s+(?:-\s+)?(.+?)\s*$/);
    if (!m) continue;
    const name = m[1].replace(/\s+\d+(?:\.\d+)?\s*m?s$/, '').replace(/\s+\[[^\]]*\]$/, '').replace(/\s+/g, ' ').trim();
    if (name && !/^(Tests?|Test Files|Suites?)\b/.test(name)) out.add(name);
  }
  return [...out].slice(0, 300);
}

/** The studio's last full check record (the same one the done-check reads), or null. */
export function lastRecord(owner = process.env.STUDIO_LOCK_OWNER) {
  const abs = (rel) => path.join(REPO_ROOT, rel);
  const own = owner && /^[\w.-]+$/.test(owner) ? `.studio/gates/${owner}-full.json` : null;
  for (const f of [own, '.studio/gates-last-full.json', '.studio/gates-last.json']) if (f && fs.existsSync(abs(f))) return readJson(abs(f));
  return null;
}

/** Record what was red when a task was claimed. Returns the record, or null with nothing to compare against. */
export function recordBaseline(taskId, rec = lastRecord(null)) {
  if (!/^T-\d+$/.test(String(taskId || '')) || !rec?.rows) return null;
  const red = rec.rows.filter((r) => r.required && !r.ok).map((r) => ({ id: r.id, failures: Array.isArray(r.failures) ? r.failures : null }));
  const b = { task: taskId, at: new Date().toISOString(), from: { at: rec.at || null, head: rec.head || null, partial: Boolean(rec.partial) }, red };
  fs.mkdirSync(BASE_DIR(), { recursive: true });
  fs.writeFileSync(path.join(BASE_DIR(), `${taskId}.json`), `${JSON.stringify(b, null, 2)}\n`);
  if (red.length) emitEvent({ type: 'task.baseline', agent: 'gates', task: taskId, msg: `${taskId}: ${red.length} check(s) already red at claim (${red.map((r) => r.id).join(', ')}); the done-check won't blame the task for those`, meta: { red: red.map((r) => r.id) } });
  return b;
}

export const readBaseline = (taskId) => readJson(path.join(BASE_DIR(), `${taskId}.json`));

/**
 * Split a run's red required checks into new ones (the task's) and excused ones (already red at claim).
 * new: [{ id, failures }] where failures are only the new failing tests when both sides listed them.
 */
export function judgeRed(rows, base) {
  const red = (rows || []).filter((r) => r.required && !r.ok);
  const was = new Map((base?.red || []).map((r) => [r.id, r]));
  const fresh = [];
  const excused = [];
  for (const r of red) {
    const b = was.get(r.id);
    if (!b) { fresh.push({ id: r.id, failures: r.failures || null }); continue; }
    if (Array.isArray(r.failures) && r.failures.length && Array.isArray(b.failures) && b.failures.length) {
      const before = new Set(b.failures);
      const added = r.failures.filter((f) => !before.has(f));
      if (added.length) fresh.push({ id: r.id, failures: added });
      else excused.push({ id: r.id, why: `the same ${r.failures.length} failing test(s) as at claim` });
    } else excused.push({ id: r.id, why: 'already red at claim (no test names to compare, so new failures inside it can\'t be told apart)' });
  }
  return { fresh, excused };
}

/** The trunk's state: { red, why, by, source } (a person's word wins over the whole-game check). */
export function trunkState(root = REPO_ROOT) {
  const manual = readJson(path.join(root, '.studio', 'trunk.json'));
  if (manual?.state === 'red') return { red: true, why: manual.why || 'marked red', by: manual.by || null, source: 'manual' };
  if (manual?.state === 'green') return { red: false, why: '', by: manual.by || null, source: 'manual' };
  const whole = readJson(path.join(root, '.studio', 'whole-game.json'));
  const last = whole?.last;
  if (last?.result === 'red') return { red: true, why: `the whole-game check is red at ${String(last.sha || '').slice(0, 8)}${last.failed?.length ? ` (${last.failed.join(', ')})` : ''}`, by: 'whole-game', source: 'whole-game' };
  return { red: false, why: '', by: null, source: null };
}

export function setTrunk(state, { by, why = '' } = {}) {
  if (!['red', 'green'].includes(state)) return { ok: false, message: 'npm run task -- trunk red|green --by <name> [--why "<why>"]' };
  if (!by) return { ok: false, message: 'Say who: --by <name>.' };
  const rec = { state, by, why, at: new Date().toISOString() };
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  fs.writeFileSync(TRUNK_FILE(), `${JSON.stringify(rec, null, 2)}\n`);
  emitEvent({ type: `trunk.${state}`, agent: by, to: 'producer', status: state === 'red' ? 'blocked' : 'ok', msg: state === 'red' ? `Trunk marked red by ${by}${why ? `: ${why}` : ''}. Only fix tasks start until it is green.` : `Trunk marked green by ${by}. All tasks can start again.` });
  return { ok: true, trunk: rec };
}

/** A task that fixes the trunk (its title or tags say so). */
export const isFixTask = (t) => /^\s*(fix|bug|hotfix|repair|revert)\b/i.test(String(t?.title || '')) || /\[(fix|bug)(:[^\]]*)?\]/i.test(String(t?.title || '')) || /^Whole-game check red\b/i.test(String(t?.title || ''));
