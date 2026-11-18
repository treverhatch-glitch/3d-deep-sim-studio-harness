/**
 * harness/brief-status.mjs — `npm run status -- --brief`: the studio in under 100 words for a chat channel.
 *
 * A fixed format built by code from the event log and state files (no model, no tokens). Lines: Workers (launched
 * sessions); Landed and bugs fixed; Unity (.studio/gates/unity-last.json); Blockers (halted supervisor,
 * .studio/STOP.json, lanes held for the owner, open asks, tasks waiting on `task yes`, paused roles, usage wind-down,
 * assets awaiting review); PC (free memory, machine:heavy holder; harness/machine.mjs); a running train's step and
 * ETA.
 * npm run status -- --brief [--since <iso>] [--now <iso>] [--peek] [--json]
 * "Since": --since, else the last brief (.studio/brief-status.json; --peek doesn't move it), else
 * STUDIO_BRIEF_DEFAULT_MIN (30). Lists are cut ("+3 more") to fit BRIEF_MAX_WORDS (100).
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents } from './event.mjs';
import { recordAlive } from './proc-identity.mjs';
import { readTrainStatus, trainStatusLine } from './train-status.mjs';
import { readJson } from './fsafe.mjs';
import { landedMeasure, landedCounts, tasksOf } from './landings.mjs';

export const BRIEF_MAX_WORDS = 99;
export const BRIEF_MARK = () => path.join(STUDIO_STATE_DIR, 'brief-status.json');
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
// 2.88: "Landed" is what reached the main branch or an engine target; a task closed or forced with no landing is not
// (a studio with no landing record at all: its closes, landedMeasure).

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
  const measure = landedMeasure(evs);
  for (const e of evs) if (inWin(e)) for (const t of tasksOf(e, measure)) if (!landed.includes(t)) landed.push(t);
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
  // 2.76.0 (j, B-87): agent-proposed tasks waiting on the dev's yes (harness/yes-wait.mjs).
  try { const w = await (await import('./yes-wait.mjs')).readYesWaiting({ root }); if (w.count) blockers.push({ kind: 'yes', ids: w.ids, text: `waiting on yes (${w.count}${w.beta.on ? ', beta mode may say it' : ''})` }); } catch {}
  // 2.68.0: roles the crew watchdog paused (.studio/crew-paused.json) and a usage wind-down (.studio/winddown.json).
  const crew = Object.keys(readJson(path.join(root, '.studio', 'crew-paused.json'), {})?.roles || {});
  if (crew.length) blockers.push({ kind: 'crew', ids: crew, text: 'crew paused (sessions, nothing landed)' });
  // 2.70.0 (v): assets waiting for a review of their previews (.studio/asset-reviews/), oldest first.
  try { const rv = (await import('./asset-review.mjs')).pendingReviews(root); if (rv.length) blockers.push({ kind: 'asset-review', ids: rv.map((r) => r.asset), text: 'asset reviews (oldest first)' }); } catch {}
  const wd = readJson(path.join(root, '.studio', 'winddown.json'));
  if (wd?.at && !(await import('./winddown.mjs')).winddownOver(wd, { env, now })) blockers.push({ kind: 'winddown', text: `winding down${wd.pct !== null && wd.pct !== undefined ? ` (usage ${Math.round(wd.pct)}%)` : ''}` });
  // PC.
  const test = env.STUDIO_TEST_FREEMEM_MB;
  const freeGb = Math.round(((test !== undefined && test !== '' ? Number(test) * 1024 * 1024 : os.freemem()) / 1024 ** 3) * 10) / 10;
  let heavy = [];
  try { heavy = (await import('./heavy.mjs')).heavyHolders(root).map((h) => ({ label: h.label || 'heavy work', owner: h.owner || null })); } catch {}
  let train = null;
  try { train = readTrainStatus(root); } catch {}
  // 2.68.0 (m): the machine line (the last scan, or a new one when it is older than 2 x STUDIO_MACHINE_SAMPLE_S).
  let machine = '';
  try { const m = await import('./machine.mjs'); machine = m.machineLine(m.readMachine({ root, env })); } catch { machine = ''; }
  // 2.70.0 (t): the latest playable build and clip made after a landing (harness/landing-build.mjs).
  let build = '';
  try { build = (await import('./landing-build.mjs')).landingLine(evs, { max: 2 }); } catch { build = ''; }
    // 2.70.0 (w): stale lane copies the janitor proposed (harness/lane-disk.mjs).
  let staleLanes = '';
  try { staleLanes = (await import('./lane-disk.mjs')).staleLanesLine({ root, now }); } catch { staleLanes = ''; }
  const lc = landedCounts(evs.filter(inWin), evs);
  return { now, from: fromMs, workers, landed, landedWord: lc.measure, closedWithoutLanding: lc.closedWithoutLanding, bugs, unity, blockers, freeGb, heavy, ...(train ? { train } : {}), ...(machine ? { machine } : {}), ...(build ? { build } : {}), ...(staleLanes ? { staleLanes } : {}) };
}

const cut = (ids, k) => (ids.length <= k ? ids.join(', ') : `${ids.slice(0, k).join(', ')} +${ids.length - k} more`);

/** The text, at most BRIEF_MAX_WORDS words: lists shrink until it fits. */
export function briefText(f, { maxWords = BRIEF_MAX_WORDS } = {}) {
  const render = (k) => {
    const L = [];
    L.push(`Studio ${hhmm(f.now)} UTC, since ${hhmm(f.from)}.`);
    L.push(f.workers.length ? `Workers (${f.workers.length}): ${cut(f.workers.map((w) => `${w.role}${w.task ? ` ${w.task}` : ''}`), k)}.` : 'Workers: none running.');
    L.push(`${f.landedWord === 'closed' ? 'Closed' : 'Landed'} (${f.landed.length})${f.landed.length ? `: ${cut(f.landed, k)}` : ''}${f.closedWithoutLanding > 0 ? `; closed without a landing (${f.closedWithoutLanding})` : ''}. Bugs fixed (${f.bugs.length})${f.bugs.length ? `: ${cut(f.bugs, k)}` : ''}.`);
    L.push(f.unity ? `Unity: land ${f.unity.status}${f.unity.at ? ` ${String(f.unity.at).slice(11, 16)}` : ''}${f.unity.task ? ` (${cut(String(f.unity.task).split(','), Math.max(1, Math.min(k, 2)))})` : ''}.` : 'Unity: no land run recorded.');
    if (f.train) L.push(`${trainStatusLine(f.train, { short: true }).replace(/^Train \S+/, 'Train')}${Number(f.train.lanes) > 6 ? ' (STUDIO_TRAIN_MAX caps lanes)' : ''}.`);
    L.push(f.blockers.length ? `Blockers: ${f.blockers.map((b) => (b.ids ? `${b.text}: ${cut(b.ids, k)}` : b.text)).join('; ')}.` : 'Blockers: none.');
    if (f.machine) L.push(`${f.machine}.`);
    if (f.build) L.push(`${f.build}.`);
    if (f.staleLanes) L.push(`Lanes: ${f.staleLanes}.`);
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

// Run as a script: `npm run status` prints the brief (with or without --brief).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const opt = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
  const nowArg = Date.parse(opt('--now') || '');
  const b = await briefStatus({ since: opt('--since'), now: Number.isFinite(nowArg) ? nowArg : Date.now(), peek: process.argv.includes('--peek') });
  console.log(process.argv.includes('--json') ? JSON.stringify({ text: b.text, words: b.words, facts: b.facts }) : b.text);
  process.exit(0);
}
