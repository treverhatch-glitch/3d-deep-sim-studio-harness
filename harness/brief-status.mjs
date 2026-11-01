/**
 * harness/brief-status.mjs — 2.65.0: `npm run status -- --brief`, the studio in under 100 words for a chat channel.
 *
 * The crew's orchestrator hand-assembled this every 30 minutes. It is a fixed format now, built by code from the
 * event log and the state files (no model, no tokens), so the same state always gives the same text:
 *
 *   Studio 14:30 UTC, since 14:00.
 *   Workers (2): builder T-012, qa-playtester T-015.
 *   Landed (2): T-010, T-011. Bugs fixed (1): T-011.
 *   Unity: land pass 13:50 (T-009).
 *   Blockers: halted (two sessions in a row ended with exit 1); owner hold C: T-020; asks: A-003.
 *   PC: 5.2 GB free; heavy: full verify (builder-2).
 *
 *   npm run status -- --brief [--since <iso>] [--now <iso>] [--peek] [--json]
 *
 * "Since": --since, else the last brief (.studio/brief-status.json; --peek doesn't move it), else 30 minutes
 * (STUDIO_BRIEF_DEFAULT_MIN). Workers: launched sessions running now (role and task). Landed: task.done, train
 * landings and lane merges in the window; bugs fixed: those whose board title starts "Bug" or that were added as
 * --type bug. Unity: the last Unity land gate (.studio/gates/unity-last.json). Blockers: a halted supervisor, a
 * stopped studio (.studio/STOP.json), lanes held in the train queue for the owner (tier C), open asks for a person. PC: free memory and who
 * holds machine:heavy. Lists are cut ("+3 more") until the whole text is under 100 words (BRIEF_MAX_WORDS).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents } from './event.mjs';
import { recordAlive } from './proc-identity.mjs';

export const BRIEF_MAX_WORDS = 99;
export const BRIEF_MARK = () => path.join(STUDIO_STATE_DIR, 'brief-status.json');
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
export const wordCount = (s) => String(s || '').split(/\s+/).filter(Boolean).length;

/** Task titles from the board (studio/NEXT.md and DONE.md), read directly: { id: title }. */
function boardTitles(root) {
  const t = {};
  for (const f of ['NEXT.md', 'DONE.md']) {
    let text = '';
    try { text = fs.readFileSync(path.join(root, 'studio', f), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/^\s*[-*]\s+\[[ xX>~]\]\s+\*\*([A-Z]+-\d+)\*\*\s*(?:\([^)]*\)\s*)?(.*)$/gm)) t[m[1]] = m[2].replace(/^[\s:—-]+/, '').trim();
  }
  return t;
}
const landingsOf = (e) => (e.type === 'task.done' || e.type === 'lane.merged' || e.type === 'task.forced' ? (e.task ? [e.task] : []) : e.type === 'task.train.landed' ? (Array.isArray(e.meta?.lanes) ? e.meta.lanes.map(String) : e.task ? [e.task] : []) : []);

/** The facts the brief is built from (deterministic for the same files, events and `now`). */
export async function briefFacts({ root = REPO_ROOT, since = null, now = Date.now(), events = null, env = process.env } = {}) {
  const evs = events || readRecentEvents(20000);
  const mark = readJson(BRIEF_MARK(), null);
  const fromMs = Number.isFinite(Date.parse(since)) ? Date.parse(since) : Number.isFinite(Date.parse(mark?.at)) ? Date.parse(mark.at) : now - (Number(env.STUDIO_BRIEF_DEFAULT_MIN) > 0 ? Number(env.STUDIO_BRIEF_DEFAULT_MIN) : 30) * 60000;
  const inWin = (e) => { const t = Date.parse(e.ts) || 0; return t > fromMs && t <= now; };
  // Workers: launched sessions running now.
  const workers = [];
  const dir = path.join(root, '.studio', 'agents');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch {}
  for (const n of names) {
    const s = readJson(path.join(dir, n));
    if (!s || s.status !== 'running') continue;
    let alive = false;
    try { alive = recordAlive(s); } catch {}
    if (alive) workers.push({ agent: s.agent || n.slice(0, -5), role: s.role || 'agent', task: s.task || null });
  }
  // Landed and bugs fixed.
  const titles = boardTitles(root);
  const bugType = new Set(evs.filter((e) => e.type === 'task.added' && e.meta?.type === 'bug' && e.task).map((e) => e.task));
  const landed = [];
  for (const e of evs) if (inWin(e)) for (const t of landingsOf(e)) if (!landed.includes(t)) landed.push(t);
  const bugs = landed.filter((t) => bugType.has(t) || /^bug\b/i.test(titles[t] || ''));
  // Unity.
  const u = readJson(path.join(root, '.studio', 'gates', 'unity-last.json'));
  const unity = u?.status ? { status: u.status, at: u.at || null, task: u.task || null } : null;
  // Blockers.
  const blockers = [];
  const sup = readJson(path.join(root, '.studio', 'supervisor.json'));
  if (sup?.halted && sup.status === 'running') blockers.push({ kind: 'halt', text: `halted (${String(sup.halted.why || 'see npm run studio:status').split(':')[0].slice(0, 80)})` });
  const stop = readJson(path.join(root, '.studio', 'STOP.json'));
  if (stop) blockers.push({ kind: 'stop', text: `studio stopped${stop.by ? ` by ${String(stop.by).slice(0, 30)}` : ''}` });
  const queue = readJson(path.join(root, '.studio', 'train', 'queue.json'), []);
  const held = (Array.isArray(queue) ? queue : []).filter((e) => e?.held && !(e.released && e.released.head === e.head)).map((e) => ({ task: e.task, tier: e.held.tier || '?' }));
  if (held.length) blockers.push({ kind: 'held', ids: held.map((h) => `${h.task}${h.tier !== 'C' ? ` (${h.tier})` : ''}`), text: 'owner hold' });
  let asks = [];
  try { asks = fs.readdirSync(path.join(root, 'studio', 'asks')).filter((f) => /^A-\d+\.json$/.test(f)).sort().map((f) => readJson(path.join(root, 'studio', 'asks', f))).filter((a) => a && a.status === 'open').map((a) => a.id); } catch {}
  if (asks.length) blockers.push({ kind: 'asks', ids: asks, text: 'asks' });
  // PC.
  const test = env.STUDIO_TEST_FREEMEM_MB;
  const freeGb = Math.round(((test !== undefined && test !== '' ? Number(test) * 1024 * 1024 : os.freemem()) / 1024 ** 3) * 10) / 10;
  let heavy = [];
  try { heavy = (await import('./heavy.mjs')).heavyHolders(root).map((h) => ({ label: h.label || 'heavy work', owner: h.owner || null })); } catch {}
  return { now, from: fromMs, workers, landed, bugs, unity, blockers, freeGb, heavy };
}

const cut = (ids, k) => (ids.length <= k ? ids.join(', ') : `${ids.slice(0, k).join(', ')} +${ids.length - k} more`);

/** The text, at most BRIEF_MAX_WORDS words: lists shrink until it fits. */
export function briefText(f, { maxWords = BRIEF_MAX_WORDS } = {}) {
  const render = (k) => {
    const L = [];
    L.push(`Studio ${hhmm(f.now)} UTC, since ${hhmm(f.from)}.`);
    L.push(f.workers.length ? `Workers (${f.workers.length}): ${cut(f.workers.map((w) => `${w.role}${w.task ? ` ${w.task}` : ''}`), k)}.` : 'Workers: none running.');
    L.push(`Landed (${f.landed.length})${f.landed.length ? `: ${cut(f.landed, k)}` : ''}. Bugs fixed (${f.bugs.length})${f.bugs.length ? `: ${cut(f.bugs, k)}` : ''}.`);
    L.push(f.unity ? `Unity: land ${f.unity.status}${f.unity.at ? ` ${String(f.unity.at).slice(11, 16)}` : ''}${f.unity.task ? ` (${cut(String(f.unity.task).split(','), Math.max(1, Math.min(k, 2)))})` : ''}.` : 'Unity: no land run recorded.');
    L.push(f.blockers.length ? `Blockers: ${f.blockers.map((b) => (b.ids ? `${b.text}: ${cut(b.ids, k)}` : b.text)).join('; ')}.` : 'Blockers: none.');
    L.push(`PC: ${f.freeGb} GB free; heavy: ${f.heavy.length ? cut(f.heavy.map((h) => `${h.label}${h.owner ? ` (${h.owner})` : ''}`), Math.max(1, Math.min(k, 2))) : 'free'}.`);
    return L.join('\n');
  };
  for (let k = 6; k >= 1; k -= 1) { const t = render(k); if (wordCount(t) <= maxWords) return t; }
  // Still too long (very long labels): cut words, keeping lines.
  let n = 0;
  return render(1).split('\n').map((line) => line.split(' ').filter((w) => { if (!w) return true; n += 1; return n <= maxWords; }).join(' ')).filter(Boolean).join('\n');
}

/** Build the brief; moves the "since last brief" mark unless peek. Returns { text, words, facts }. */
export async function briefStatus({ since = null, now = Date.now(), peek = false, root = REPO_ROOT } = {}) {
  const facts = await briefFacts({ root, since, now });
  const text = briefText(facts);
  if (!peek) { try { fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true }); fs.writeFileSync(BRIEF_MARK(), `${JSON.stringify({ at: new Date(now).toISOString() })}\n`); } catch {} }
  return { text, words: wordCount(text), facts };
}
