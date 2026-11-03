/**
 * harness/error-memory.mjs — 2.72.0 (c): error-signature memory. A red that was fixed once tells the next agent how.
 *
 * Every verify (scripts/run-gates.mjs) on a task (the one its owner, STUDIO_LOCK_OWNER, has claimed) is observed:
 *   - a failing required gate's signature (the gate, or the game check's sub-id, and its normalised first FAIL line:
 *     harness/handback-facts.mjs readGateLog + signatureKey, the same key the hand-back facts show as [sig …]) is kept
 *     as pending for that task, with the commit it failed on (.studio/error-memory-pending.json);
 *   - when a later verify on the same task runs that gate and it passes, the red counts as fixed: its signature is
 *     written to .studio/error-memory.jsonl with the fixing commit (HEAD then), its summary (the newest commit subject
 *     since the red) and the files changed since the red.
 * On a later red with the same signature, on any task, the hand-back facts and the kickoff say
 * "seen before: fixed in <commit> by changing <files> (<summary>)". The memory keeps the newest STUDIO_ERROR_MEMORY_MAX
 * (500) signatures (one line each, the newest fix of a signature wins). STUDIO_ERROR_MEMORY=off: nothing is observed
 * or shown. Plain files and git, no model calls; never blocks a verify.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { STUDIO_STATE_DIR } from './event.mjs';

export const MEMORY_FILE = 'error-memory.jsonl';
const PENDING_FILE = 'error-memory-pending.json';
const BOOKKEEPING = /^(studio|\.studio|\.lanes|node_modules|qa\/reports)(\/|$)/;
const off = (env = process.env) => /^(off|0|false|no)$/i.test(String(env.STUDIO_ERROR_MEMORY || '').trim());
export const memoryMax = (env = process.env) => (Number(env.STUDIO_ERROR_MEMORY_MAX) > 0 ? Math.floor(Number(env.STUDIO_ERROR_MEMORY_MAX)) : 500);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });

/** Every remembered fix, oldest first (one per signature key). */
export function readMemory(stateDir = STUDIO_STATE_DIR) {
  let text = '';
  try { text = fs.readFileSync(path.join(stateDir, MEMORY_FILE), 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { const j = JSON.parse(l); if (j && j.key) out.push(j); } catch { /* a torn line */ } }
  return out;
}

/** Remember one fix: the newest per key, at most `max` keys (the newest kept). Returns the entry. */
export function rememberFix(entry, { stateDir = STUDIO_STATE_DIR, max = memoryMax() } = {}) {
  const all = readMemory(stateDir).filter((e) => e.key !== entry.key);
  all.push(entry);
  const kept = all.slice(-max);
  const f = path.join(stateDir, MEMORY_FILE);
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.renameSync(tmp, f);
  return entry;
}

/** The remembered fix for a signature key, or null. */
export function seenBefore(key, { stateDir = STUDIO_STATE_DIR, env = process.env } = {}) {
  if (!key || off(env)) return null;
  const all = readMemory(stateDir);
  for (let i = all.length - 1; i >= 0; i--) if (all[i].key === key) return all[i];
  return null;
}

/** The line the hand-back facts and the kickoff show. */
export function seenLine(e) {
  const files = (e.files || []).slice(0, 6);
  const more = (e.files || []).length - files.length;
  return `seen before: fixed in ${e.commit} by changing ${files.length ? `${files.join(', ')}${more > 0 ? ` (+${more} more)` : ''}` : 'no tracked file'} (${String(e.summary || 'no summary').slice(0, 160)})${e.task ? ` [${e.task}, ${String(e.fixedAt || '').slice(0, 10)}]` : ''}`;
}

const readPending = (stateDir) => readJson(path.join(stateDir, PENDING_FILE)) || {};
function writePending(stateDir, p) {
  const f = path.join(stateDir, PENDING_FILE);
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, f);
}

/** The pending (not yet fixed) red signatures of a task: [{ gate, sub, line, key, head, at }]. */
export function pendingReds(task, { stateDir = STUDIO_STATE_DIR } = {}) {
  return Object.values(readPending(stateDir)[task]?.gates || {});
}

/** The fix's commit, summary and files: what changed in `cwd` since the red's commit. */
export function fixFacts(cwd, redHead) {
  const head = git(cwd, 'rev-parse', 'HEAD').stdout.trim() || null;
  const short = (h) => String(h || '').slice(0, 8);
  const known = redHead && git(cwd, 'cat-file', '-e', `${redHead}^{commit}`).status === 0;
  const range = known && head && head !== redHead;
  const subjects = range ? git(cwd, 'log', '--format=%s', `${redHead}..HEAD`).stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const d = known ? git(cwd, 'diff', '--name-only', redHead) : null;
  const files = d && d.status === 0 ? [...new Set(d.stdout.split('\n').map((f) => f.trim()).filter((f) => f && !BOOKKEEPING.test(f)))].sort() : [];
  return {
    commit: range ? short(head) : `uncommitted work on ${short(head) || 'an unknown commit'}`,
    summary: subjects.length ? `${subjects[0]}${subjects.length > 1 ? ` (+${subjects.length - 1} more commit(s))` : ''}` : range ? 'no commit message' : 'not committed yet',
    files,
    head,
  };
}

/** The task a verify belongs to: the one task its owner has claimed (task:<ID> locks), or null. */
export async function taskOfOwner(owner) {
  if (!owner || !/^[\w.-]+$/.test(owner)) return null;
  try {
    const { listLocks } = await import('./lock.mjs');
    const mine = listLocks().filter((l) => l.owner === owner && /^task:[A-Z]+-\d+$/.test(l.key)).map((l) => l.key.slice(5));
    return mine.length === 1 ? mine[0] : null;
  } catch { return null; }
}

/**
 * Observe one verify. rows: run-gates' rows ({ id, ok, required }); outputOf(id): the gate's output text (its
 * .studio/gates/out/<id>.log); cwd: the checkout it ran in; head: the commit it ran on. Returns { pending, fixed }.
 */
export async function observeVerify({ task, rows = [], outputOf = () => '', cwd, head, stateDir = STUDIO_STATE_DIR, env = process.env, now = Date.now() }) {
  if (off(env) || !task) return { pending: [], fixed: [] };
  const { readGateLog, signatureKey } = await import('./handback-facts.mjs');
  const all = readPending(stateDir);
  const mine = all[task] || { gates: {} };
  const fixed = [];
  for (const r of rows) {
    if (r.cached) continue;
    if (!r.ok && r.required !== false) {
      const text = String(outputOf(r.id) || '');
      const g = readGateLog(`${text}\n[gates] FAIL ${r.id}`);
      const sub = (text.match(/\[(?:game-gates|engine-gate)\] FAIL ([\w:.\/-]+)/) || [])[1] || null;
      mine.gates[r.id] = { gate: r.id, sub, line: g.failLine, key: signatureKey(r.id, g.failLine || ''), head: head || null, at: new Date(now).toISOString() };
    } else if (r.ok && mine.gates[r.id]) {
      const red = mine.gates[r.id];
      delete mine.gates[r.id];
      const fx = fixFacts(cwd, red.head);
      fixed.push(rememberFix({ key: red.key, gate: red.gate, sub: red.sub, line: red.line, task, redAt: red.at, redHead: red.head, fixedAt: new Date(now).toISOString(), commit: fx.commit, summary: fx.summary, files: fx.files }, { stateDir, max: memoryMax(env) }));
    }
  }
  if (Object.keys(mine.gates).length) all[task] = mine; else delete all[task];
  // Pending reds of tasks nobody verified for 30 days go.
  for (const [t, v] of Object.entries(all)) if (Object.values(v.gates || {}).every((x) => now - (Date.parse(x.at) || 0) > 30 * 86400000)) delete all[t];
  writePending(stateDir, all);
  return { pending: Object.values(mine.gates), fixed };
}

/** The "seen before" lines for a task's red signatures (keys), deduplicated. */
export function seenLinesFor(keys, opts = {}) {
  const out = [];
  for (const k of [...new Set(keys.filter(Boolean))]) { const e = seenBefore(k, opts); if (e) out.push(`${e.sub || e.gate}: ${seenLine(e)}`); }
  return out;
}
