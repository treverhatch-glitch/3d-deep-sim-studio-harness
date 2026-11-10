#!/usr/bin/env node
/**
 * harness/next-board.mjs — 2.71.0 (y): the what's-next board, one screen (overseer duty 10).
 *
 *   npm run next-board [-- --n 3] [--json]
 *
 * The crew's overseer wrote "what's next" for the owner by hand each session. This prints it from the studio's own
 * files, under 150 words (NEXT_BOARD_MAX_WORDS), no model:
 *   - per role, the next N tasks that could start now (waiting, unclaimed, no hold: harness/task-hold.mjs holdReason,
 *     the same test `task next` and the supervisor use; no folder another agent holds: harness/handout.mjs), by
 *     priority then board order;
 *   - per role, what blocks the rest: holds, parks, --after chains ("waits for T-5"), a held folder;
 *   - overlaps 2.69's overlap check recorded for those tasks (task.overlap events: "T-7 with T-5"), never re-run here;
 *   - trains waiting: lanes queued for the merge train, the ones held for a person's release, a running train's step;
 *   - what needs a person (the digest's list, harness/digest.mjs needsPerson): the count and the first line.
 * Lists are cut ("+2") until the text fits. `npm run report -- post --what next` sends it to the owner's webhook
 * (harness/report-post.mjs). Read-only: it writes nothing and records nothing. Every source is optional.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, readRecentEvents } from './event.mjs';
import { readJson } from './fsafe.mjs';

export const NEXT_BOARD_MAX_WORDS = 149;
const PRI = { P0: 0, P1: 1, P2: 2, P3: 3 };
export const wordCount = (s) => String(s || '').split(/\s+/).filter(Boolean).length;
const short = (s, n) => { const w = String(s || '').replace(/\s+/g, ' ').trim().split(' '); return w.length <= n ? w.join(' ') : `${w.slice(0, n).join(' ')}…`; };

/**
 * The board's facts: { now, startable, inProgress, roles: [{ role, ready: [{ id, title }], blocked: [{ id, why }] }],
 * overlaps: [{ id, with: [] }], trains: { queued: [], held: [], running }, needs: { count, first }, sig: [] }.
 * deps (tests): { q, holds, locks, events, needs: false to skip the digest's list }.
 */
export async function nextBoardFacts({ root = REPO_ROOT, now = Date.now(), n = 3, deps = {} } = {}) {
  const q = deps.q || (await import('./task.mjs')).parseNextQueue();
  const evs = deps.events || readRecentEvents(20000);
  let holds = deps.holds || {};
  let holdReason = () => null;
  let laneOf = () => null;
  try { const h = await import('./task-hold.mjs'); holds = deps.holds || h.readHolds(); holdReason = h.holdReason; laneOf = h.laneOf; } catch {}
  let locks = deps.locks || [];
  try { if (!deps.locks) locks = (await import('./lock.mjs')).listLocks(); } catch { locks = []; }
  let handoutBlock = () => null;
  try { handoutBlock = (await import('./handout.mjs')).handoutBlock; } catch {}
  let unmerged = () => 0;
  try { if (!deps.q) unmerged = (await import('./worktree.mjs')).unmerged; } catch {}
  const claimed = new Set(locks.filter((l) => String(l.key || '').startsWith('task:')).map((l) => l.key.slice(5)));
  const byRole = new Map();
  const order = (q.backlog || []).map((t, i) => [t, i]).sort((a, b) => (PRI[a[0].priority] ?? 9) - (PRI[b[0].priority] ?? 9) || a[1] - b[1]).map(([t]) => t);
  for (const t of order) {
    if (claimed.has(t.id)) continue;
    const role = t.role || 'any';
    if (!byRole.has(role)) byRole.set(role, { role, ready: [], blocked: [] });
    let why = null;
    try { why = holdReason(t.id, q, now, holds); } catch { why = null; }
    if (!why) {
      let lane = null;
      try { lane = laneOf(t.id, evs, holds) || null; } catch {}
      try { const b = handoutBlock(t.id, q, { locks, unmerged, lane, holds }); if (b) why = b.why; } catch {}
    }
    if (why) byRole.get(role).blocked.push({ id: t.id, why: String(why).replace(/\s*\(npm run [^)]*\)/g, '') });
    else byRole.get(role).ready.push({ id: t.id, title: t.title });
  }
  const roles = [...byRole.values()].sort((a, b) => (a.role === 'builder' ? -1 : b.role === 'builder' ? 1 : b.ready.length - a.ready.length || a.role.localeCompare(b.role)));
  // Overlaps the 2.69 check recorded (task add / task start), for the tasks that could start, with tasks still open.
  const open = new Set([...(q.backlog || []), ...(q.inProgress || [])].map((t) => t.id));
  const readyIds = new Set(roles.flatMap((r) => r.ready.map((t) => t.id)));
  const titleOf = new Map((q.backlog || []).map((t) => [String(t.title || '').replace(/^\w+:\s*/, '').trim().toLowerCase(), t.id]));
  const ov = new Map();
  for (const e of evs) {
    if (e.type !== 'task.overlap') continue;
    const id = e.task || titleOf.get(String(e.meta?.title || '').replace(/^\w+:\s*/, '').trim().toLowerCase()) || null;
    if (!id || !readyIds.has(id)) continue;
    const w = (e.meta?.with || []).filter((x) => x !== id && open.has(x));
    if (w.length) ov.set(id, [...new Set([...(ov.get(id) || []), ...w])]);
  }
  const overlaps = [...ov.entries()].map(([id, w]) => ({ id, with: w }));
  // Trains: the merge train's queue in the main checkout.
  let qroot = root;
  try { if (!deps.q) qroot = (await import('./worktree.mjs')).mainRoot(); } catch {}
  const tq = readJson(path.join(qroot, '.studio', 'train', 'queue.json'), []);
  const entries = Array.isArray(tq) ? tq.filter((e) => e && e.task) : [];
  const held = entries.filter((e) => e.held && !(e.released && e.released.head === e.head)).map((e) => e.task);
  const queued = entries.map((e) => e.task).filter((t) => !held.includes(t));
  let running = '';
  try { const ts = await import('./train-status.mjs'); const s = ts.readTrainStatus(qroot); if (s) running = ts.trainStatusLine(s, { short: true }); } catch { running = ''; }
  // What needs a person (the digest's list).
  let needs = { count: 0, first: '' };
  if (deps.needs !== false) {
    try { const list = await (await import('./digest.mjs')).needsPerson({ now, root, events: evs }); needs = { count: list.length, first: list[0]?.line || '' }; } catch { needs = { count: 0, first: '' }; }
  }
  const startable = roles.reduce((k, r) => k + r.ready.length, 0);
  // The signature the report's "changed a lot" test compares (harness/report-post.mjs): tasks and trains, not wording.
  const sig = [...roles.flatMap((r) => [...r.ready.map((t) => `r:${t.id}`), ...r.blocked.map((t) => `b:${t.id}`)]), ...queued.map((t) => `t:${t}`), ...held.map((t) => `h:${t}`)].sort();
  return { now, n, startable, inProgress: (q.inProgress || []).length, roles, overlaps, trains: { queued, held, running }, needs, sig };
}

const cut = (items, k) => (items.length <= k ? items.join(', ') : `${items.slice(0, k).join(', ')} +${items.length - k}`);

/** The board's text, at most NEXT_BOARD_MAX_WORDS words: lists shrink, then titles, until it fits. */
export function nextBoardText(f, { maxWords = NEXT_BOARD_MAX_WORDS } = {}) {
  const hhmm = new Date(f.now).toISOString().slice(11, 16);
  const render = (k, tw, bk) => {
    const L = [`What's next ${hhmm} UTC: ${f.startable} can start, ${f.inProgress} in progress.`];
    const shown = f.roles.filter((r) => r.ready.length || r.blocked.length);
    for (const r of shown.slice(0, Math.max(2, k + 1))) {
      const ready = r.ready.slice(0, Math.min(k, f.n || 3)).map((t) => `${t.id} ${short(t.title, tw)}`);
      const more = r.ready.length - ready.length;
      const blocked = r.blocked.map((b) => `${b.id} ${short(b.why, 7)}`);
      const line = `${r.role}: ${ready.length ? `${ready.join('; ')}${more > 0 ? ` (+${more})` : ''}` : 'nothing can start'}${blocked.length ? `. Blocked: ${cut(blocked, bk)}` : ''}`;
      L.push(/[.…]$/.test(line) ? line : `${line}.`);
    }
    if (shown.length > Math.max(2, k + 1)) L.push(`+${shown.length - Math.max(2, k + 1)} more roles (npm run next-board).`);
    if (!shown.length) L.push('The board is empty: nothing waits.');
    if (f.overlaps.length) L.push(`Overlaps: ${cut(f.overlaps.map((o) => `${o.id} with ${o.with.slice(0, 2).join('+')}`), Math.max(1, k))}.`);
    const t = f.trains;
    L.push(`Trains: ${t.queued.length ? `${t.queued.length} queued (${cut(t.queued, Math.max(1, k))})` : 'none queued'}${t.held.length ? `; ${t.held.length} held for your release (${cut(t.held, Math.max(1, k))})` : ''}${t.running ? `; ${short(t.running, 14)}` : ''}.`);
    L.push(f.needs.count ? `Needs a person (${f.needs.count}): ${short(f.needs.first, 18)}${f.needs.count > 1 ? ' (npm run digest -- --all)' : ''}` : 'Needs a person: nothing.');
    return L.join('\n');
  };
  for (const [k, tw, bk] of [[3, 8, 3], [3, 5, 2], [2, 5, 2], [2, 3, 1], [1, 3, 1], [1, 2, 0]]) { const t = render(k, tw, bk); if (wordCount(t) <= maxWords) return t; }
  let c = 0;
  return render(1, 2, 0).split('\n').map((line) => line.split(' ').filter((w) => { if (!w) return true; c += 1; return c <= maxWords; }).join(' ')).filter(Boolean).join('\n');
}

/** The board: { text, words, facts }. */
export async function nextBoard(opts = {}) {
  const facts = await nextBoardFacts(opts);
  const text = nextBoardText(facts);
  return { text, words: wordCount(text), facts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: npm run next-board [-- --n 3] [--json]   (the next startable tasks by role, their blockers, trains waiting, what needs a person; under 150 words)'); process.exit(0); }
  const n = argv.includes('--n') ? Math.max(1, Math.min(10, Number(argv[argv.indexOf('--n') + 1]) || 3)) : 3;
  const b = await nextBoard({ n });
  console.log(argv.includes('--json') ? JSON.stringify({ text: b.text, words: b.words, facts: b.facts }, null, 2) : b.text);
}
