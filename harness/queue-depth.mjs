/**
 * harness/queue-depth.mjs — 2.69.0 (s): a queue-depth target, so builders don't run out of startable work.
 *
 * The crew's orchestrator kept 5–6 builders busy by hand: whenever the startable builder tasks ran low it planned more.
 * Now each supervisor pass counts the builder tasks that could start now (waiting, unclaimed, not held: no --after
 * still open, no hold, park or block, no folder another agent holds) against STUDIO_QUEUE_DEPTH (default: the
 * supervisor's session cap for this pass, 2.68.0 harness/heavy-budget.mjs sessionCap; `off` turns it off). Below it,
 * the Producer is asked the way the refill asks (a queue.depth event to the Producer, a line in
 * studio/producer/INBOX.md, and a wake unless STUDIO_REFILL_WAKE=off), naming the areas that are blocked by chains
 * and holds so it plans work elsewhere. It never adds a task itself. One ask per STUDIO_QUEUE_DEPTH_ASK_MIN (30)
 * minutes while the shortfall lasts (a bigger shortfall asks again at once).
 *
 * Imports only event.mjs, task-hold.mjs and handout.mjs: the supervisor loads it with a dynamic import.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { holdReason, laneOf, readHolds } from './task-hold.mjs';
import { handoutBlock } from './handout.mjs';

const STATE = () => path.join(STUDIO_STATE_DIR, 'queue-depth.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

/** The target: STUDIO_QUEUE_DEPTH (a number, or off: null), else the session cap given. */
export function depthTarget(cap, env = process.env) {
  const v = String(env.STUDIO_QUEUE_DEPTH ?? '').trim().toLowerCase();
  if (/^(off|false|no)$/.test(v)) return null;
  if (v !== '' && Number.isFinite(Number(v))) return Math.max(0, Math.round(Number(v))) || null;
  return Number.isFinite(cap) && cap > 0 ? Math.round(cap) : null;
}
export const askEveryMs = (env = process.env) => Math.max(1, Number(env.STUDIO_QUEUE_DEPTH_ASK_MIN) || 30) * 60000;

/**
 * Builder tasks that could start now, and the blocked ones grouped by area:
 * { ready: [ids], blocked: [{ area, tasks: [{ id, why }] }] }.
 */
export function readiness(q, { now = Date.now(), holds = readHolds(), events = null, locks = [], unmerged = () => 0, locked = () => false } = {}) {
  const evs = events || readRecentEvents(20000);
  const ready = [];
  const areas = new Map();
  for (const t of q.backlog || []) {
    if (t.role !== 'builder' || locked(t.id)) continue;
    let lane = null;
    try { lane = laneOf(t.id, evs, holds) || null; } catch {}
    let why = holdReason(t.id, q, now, holds);
    if (!why) { const b = handoutBlock(t.id, q, { locks, unmerged, lane, holds }); if (b) why = b.why; }
    if (!why) { ready.push(t.id); continue; }
    const area = lane || 'the whole game';
    if (!areas.has(area)) areas.set(area, []);
    areas.get(area).push({ id: t.id, why });
  }
  return { ready, blocked: [...areas.entries()].map(([area, tasks]) => ({ area, tasks })) };
}

export const blockedText = (blocked) => blocked.slice(0, 6).map((b) => `${b.area} (${b.tasks.slice(0, 3).map((t) => `${t.id} ${String(t.why).slice(0, 80)}`).join('; ')}${b.tasks.length > 3 ? `; +${b.tasks.length - 3}` : ''})`).join(' | ') + (blocked.length > 6 ? ` | +${blocked.length - 6} more areas` : '');

function inbox(text) {
  const f = path.join(REPO_ROOT, 'studio', 'producer', 'INBOX.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, '# Producer inbox\n\n> Messages from people. The Producer reads new ones in its briefing (`npm run handoff`).\n\n');
  fs.appendFileSync(f, `- [${new Date().toISOString().slice(0, 16).replace('T', ' ')}] **harness**: ${text.replace(/\n+/g, ' ')}\n`);
}

/**
 * One check: { target, ready, short, asked, blocked, why }. q: the board (parseNextQueue). cap: the supervisor's session
 * cap now. deps (tests): { wake, locks, unmerged, locked, holds, events }. Never adds a task.
 */
export async function queueDepthPass({ q, cap, now = Date.now(), dryRun = false, env = process.env, deps = {} } = {}) {
  const target = depthTarget(cap, env);
  if (!target) return { target: null, asked: false, why: 'STUDIO_QUEUE_DEPTH=off' };
  const r = readiness(q, { now, holds: deps.holds, events: deps.events, locks: deps.locks || [], unmerged: deps.unmerged || (() => 0), locked: deps.locked || (() => false) });
  const short = target - r.ready.length;
  const st = readJson(STATE(), {});
  if (short <= 0) {
    if (st.short && !dryRun) { try { fs.writeFileSync(STATE(), `${JSON.stringify({ short: 0, at: null }, null, 2)}\n`); } catch {} }
    return { target, ready: r.ready, short: 0, asked: false, blocked: r.blocked, why: `${r.ready.length} builder task(s) ready, target ${target}` };
  }
  const recent = st.at && now - Date.parse(st.at) < askEveryMs(env) && short <= (st.short || 0);
  if (recent || dryRun) return { target, ready: r.ready, short, asked: false, blocked: r.blocked, why: recent ? `asked at ${st.at}` : 'dry run' };
  const areas = r.blocked.length ? ` Blocked areas (don't fill these; they wait on chains or holds): ${blockedText(r.blocked)}.` : '';
  const msg = `Queue below target: ${r.ready.length} builder task(s) ready to start, target ${target} (STUDIO_QUEUE_DEPTH, default the session cap). Plan ${short} more builder task(s) from the plan, in areas that can start now.${areas} The harness adds no task itself.`;
  emitEvent({ type: 'queue.depth', agent: 'supervisor', to: 'producer', status: 'warn', msg: msg.slice(0, 900), meta: { target, ready: r.ready.length, short, readyTasks: r.ready.slice(0, 20), blocked: r.blocked.slice(0, 12).map((b) => ({ area: b.area, tasks: b.tasks.slice(0, 6).map((t) => t.id) })) } });
  try { inbox(msg); } catch {}
  let woke = null;
  if (String(env.STUDIO_REFILL_WAKE || '') !== 'off') {
    const wake = deps.wake || (async (why) => (await import('./agent.mjs')).wake('producer', { why, auto: true }));
    try { woke = await wake(`the queue is below its depth target (${r.ready.length} ready, target ${target}): plan builder tasks outside the blocked areas; never re-list done work`); } catch {}
  }
  try { fs.mkdirSync(path.dirname(STATE()), { recursive: true }); fs.writeFileSync(STATE(), `${JSON.stringify({ short, at: new Date(now).toISOString() }, null, 2)}\n`); } catch {}
  return { target, ready: r.ready, short, asked: true, woke, blocked: r.blocked, why: msg };
}
