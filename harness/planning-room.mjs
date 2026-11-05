/**
 * harness/planning-room.mjs — 2.78.1 (g): the Planning Room, the Line Producer's own room on the War Room's Studio floor.
 *
 * The owner's words: "Does the line producer have their own room in the studio view in the War Room? Can we add one and
 * make it big please so it shows the line producer's plans plainly and clearly." The Line Producer worked from the
 * Production room and its plan was only in `npm run line -- status`. This module is what the room shows, read from the
 * harness's own files (nothing estimated, nothing invented: a field that isn't on file is left out):
 *
 *   now       running builders: task, title, lane (or the whole game), who, model, when it started. The live board
 *             (studio/NEXT.md IN_PROGRESS, builder role) and the launcher's sessions (role builder, running); the start is
 *             the session's startedAt, else the task's last task.start event.
 *   next      the ready queue in the order the Line Producer will start them: the last pass's order
 *             (.studio/line/status.json "order", harness/line-producer.mjs), tasks still waiting on the board only. Each
 *             with its lane (harness/task-hold.mjs laneOf, the supervisor's own lane), "unscoped" for a builder task with
 *             none (unless the whole game on purpose), its wave from plan-waves (the last waves.shadow event), its model
 *             route (the pass's "routes"), and whether it is a chain-breaker.
 *   waiting   stacked: open tasks with an --after (studio/task-holds.json "after") on a task not done yet: on what, and
 *             why (the Line Producer's stack on shared sim code: the pass's lanes.stacked, else the task.hold event's
 *             meta.via; else that event's words, the hold's own why, or "--after when it was added"); blocked: the last
 *             pass's blocked list (kind, why, fix; "unscoped" among them), still open, without the chains above.
 *   lastPass  when, what it decided (lanes it set, stacks it added, mechanical fixes), its one-line status and the
 *             reasons in its Producer note; builders running against the target; its recent decisions in the events
 *             (task.lane, task.hold, line.fixed by line-producer, the last 24 hours).
 *
 * No plan on file: { hasPlan: false, why: "No plan yet: the Line Producer hasn't run" } (now still shows the board). A
 * plan older than STUDIO_LINE_PLAN_MAX_SEC (300), or with the supervisor not running, is shown with its age (live false).
 * STUDIO_PLANNING_ROOM=off: no Planning Room; the Line Producer sits in Production again (harness/war-room.mjs).
 * Read-only: nothing here writes. Never throws (an error is { error }).
 */
import fs from 'node:fs';
import path from 'node:path';
import { STUDIO_STATE_DIR } from './event.mjs';
import { laneOf as boardLaneOf } from './task-hold.mjs';

const OFF = /^(off|0|false|no)$/i;
const num = (v, d) => { const s = String(v ?? '').trim(); const n = Number(s); return s !== '' && Number.isFinite(n) ? n : d; };
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const DAY = 24 * 3600000;
/** How many rows each list carries (the room says "+N more" for the rest). */
export const PLAN_ROWS = { now: 8, next: 12, stacked: 10, blocked: 10, recent: 6 };

/**
 * The room on the Studio floor: the whole width (wide), right after Production (after), taller than the others. The page
 * draws it from the HUD's "planning" (its "room" field), beside the assignment rooms of harness/war-room.mjs.
 */
export const PLANNING_ROOM = { id: 'planning', name: 'Planning Room', roles: ['line-producer'], about: 'the Line Producer\'s plan: running builders, what starts next and in which lane, what waits and why, its last pass', after: 'production', wide: true };
/** STUDIO_PLANNING_ROOM: on (default) | off. */
export const planningRoomOn = (env = process.env) => !OFF.test(String(env.STUDIO_PLANNING_ROOM ?? '').trim());
/** The Line Producer's last pass on file, or null. */
export const readPlanStatus = (stateDir = STUDIO_STATE_DIR) => readJson(path.join(stateDir, 'line', 'status.json'), null);

/**
 * The Planning Room from plain data (pure but for laneOf, which is passed in for tests). status: the Line Producer's
 * status.json (or null); queue: the board (parseNextQueue); holds: studio/task-holds.json's map; launched: the launcher's
 * sessions; events: recent events (task.added, task.start, task.hold, task.lane, line.fixed, waves.shadow);
 * holders: Map task -> lock owner; supervisorRunning: the supervisor's loop is up (the Line Producer runs on it).
 */
export function planningRoom({ status = null, queue = { inProgress: [], backlog: [], done: [] }, holds = {}, launched = [], events = [], holders = new Map(), supervisorRunning = false, now = Date.now(), env = process.env, laneOf = null } = {}) {
  try {
    const added = events.filter((e) => e.type === 'task.added' && e.task);
    const addedMeta = new Map(added.map((e) => [e.task, e.meta || {}]));
    const lane = (id) => { try { return (laneOf || ((t) => boardLaneOf(t, added, holds)))(id) || null; } catch { return null; } };
    const wholeGame = (id) => Boolean(addedMeta.get(id)?.wholeGame) || (holds[id] && 'lane' in holds[id] && !holds[id].lane);
    const done = new Set((queue.done || []).map((t) => t.id));
    const open = [...(queue.inProgress || []), ...(queue.backlog || [])];
    const byId = new Map(open.map((t) => [t.id, t]));
    const inProg = new Set((queue.inProgress || []).map((t) => t.id));
    const running = (launched || []).filter((s) => s.running);

    // ---- now: running builders ----
    const lastOf = (type, id) => { for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].type === type && events[i].task === id) return events[i]; return null; };
    const nowRows = [];
    const seen = new Set();
    const builderTasks = [...(queue.inProgress || []).filter((t) => t.role === 'builder').map((t) => t.id), ...running.filter((s) => s.role === 'builder' && s.task).map((s) => s.task)];
    for (const id of builderTasks) {
      if (seen.has(id)) continue;
      seen.add(id);
      const t = byId.get(id);
      const sess = running.find((s) => s.task === id) || null;
      const st = lastOf('task.start', id);
      const l = lane(id);
      nowRows.push({
        task: id,
        title: clip(t?.title || '', 140),
        lane: l,
        wholeGame: !l,
        ...(sess?.agent || holders.get(id) || st?.agent ? { agent: sess?.agent || holders.get(id) || st.agent } : {}),
        ...(sess?.model || st?.model ? { model: sess?.model || st.model } : {}),
        ...(sess?.startedAt || st?.ts ? { startedAt: sess?.startedAt || st.ts } : {}),
      });
    }

    // ---- waves: plan-waves' last shadow plan (harness/plan-waves.mjs shadowPass) ----
    let wavesEv = null;
    for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].type === 'waves.shadow' && Array.isArray(events[i].meta?.waves)) { wavesEv = events[i]; break; }
    const waveOf = new Map();
    (wavesEv?.meta?.waves || []).forEach((w, i) => { for (const id of Array.isArray(w) ? w : []) if (!waveOf.has(id)) waveOf.set(id, i + 1); });

    const room = { room: 'planning', on: planningRoomOn(env), roomInfo: PLANNING_ROOM, hasPlan: false, now: nowRows.slice(0, PLAN_ROWS.now), nowMore: Math.max(0, nowRows.length - PLAN_ROWS.now) };
    if (!status) return { ...room, why: "No plan yet: the Line Producer hasn't run", hint: 'It runs on the supervisor\'s loop (npm run supervise); npm run line -- plan shows a dry pass' };
    if (status.off) return { ...room, why: `The Line Producer is off (${status.why || 'STUDIO_LINE_PRODUCER=off'})` };

    const at = Date.parse(status.at) || null;
    const ageMin = at ? Math.max(0, Math.round((now - at) / 60000)) : null;
    const maxSec = num(env.STUDIO_LINE_PLAN_MAX_SEC, 300);
    const live = Boolean(supervisorRunning && at && now - at <= maxSec * 1000 && !status.dryRun && !status.error);
    const routes = status.routes || {};
    const cbs = new Set((status.chainBreakers || []).map((c) => c.task));
    const unscopedSet = new Set([...(status.lanes?.unscoped || []).map((u) => u.task), ...(status.blocked || []).filter((b) => b.kind === 'unscoped').map((b) => b.task)]);

    // ---- next up: the pass's order, still waiting on the board ----
    const order = (status.order || []).filter((id) => byId.has(id) && !inProg.has(id) && !seen.has(id));
    const nextRows = order.map((id, i) => {
      const t = byId.get(id);
      const l = lane(id);
      const r = routes[id] || {};
      const isBuilder = t.role === 'builder';
      const whole = !l && wholeGame(id);
      return {
        task: id, rank: i + 1, title: clip(t.title, 140), role: t.role, priority: t.priority,
        lane: l,
        ...(isBuilder && !l && !whole ? { unscoped: true } : {}),
        ...(isBuilder && whole ? { wholeGame: true } : {}),
        ...(waveOf.has(id) ? { wave: waveOf.get(id) } : {}),
        ...(r.model ? { model: r.model } : {}),
        ...(r.tool ? { tool: r.tool } : {}),
        ...(r.tier ? { tier: r.tier } : {}),
        ...(cbs.has(id) ? { chainBreaker: true } : {}),
      };
    });

    // ---- waiting: stacked (--after on a task not done) and blocked ----
    const stackInfo = new Map();
    for (const s of status.lanes?.stacked || []) stackInfo.set(`${s.task}>${s.after}`, { via: s.via || [], by: 'line-producer', dry: Boolean(s.dry) });
    for (const e of events) {
      if (e.type !== 'task.hold' || !e.task) continue;
      const after = e.meta?.after;
      if (after && Array.isArray(e.meta?.via)) stackInfo.set(`${e.task}>${after}`, { via: e.meta.via, by: e.agent || null });
    }
    const holdMsg = (id, on) => { for (let i = events.length - 1; i >= 0; i -= 1) { const e = events[i]; if (e.type === 'task.hold' && e.task === id && String(e.msg || '').includes(on)) return e; } return null; };
    const stacked = [];
    for (const t of queue.backlog || []) {
      const h = holds[t.id] || {};
      const tail = new Set(h.chainTail?.chain || []);
      const on = (h.after || []).filter((a) => !done.has(a) && !tail.has(a));
      if (!on.length) continue;
      const why = [];
      const via = [];
      for (const a of on) {
        const si = stackInfo.get(`${t.id}>${a}`);
        if (si) { via.push(...si.via); why.push(`shared sim code: ${si.via.slice(0, 3).join(', ')}${si.via.length > 3 ? ` (+${si.via.length - 3})` : ''}`); continue; }
        const ev = holdMsg(t.id, a);
        if (ev) { why.push(clip(String(ev.msg).replace(new RegExp(`^${ev.agent}:\\s*`), ''), 160)); continue; }
        if ((addedMeta.get(t.id)?.after || []).includes(a)) why.push('--after when it was added');
      }
      if (h.why && !why.length) why.push(clip(h.why, 160));
      stacked.push({
        task: t.id, title: clip(t.title, 120), role: t.role,
        after: on.map((a) => ({ task: a, state: inProg.has(a) ? 'running' : byId.has(a) ? 'waiting' : 'not on the board' })),
        ...(why.length ? { why: [...new Set(why)].join('; ') } : {}),
        ...(via.length ? { via: [...new Set(via)] } : {}),
        ...(stackInfo.has(`${t.id}>${on[0]}`) && stackInfo.get(`${t.id}>${on[0]}`).by === 'line-producer' ? { byLine: true } : {}),
      });
    }
    const stackedIds = new Set(stacked.map((s) => s.task));
    const blocked = (status.blocked || [])
      .filter((b) => byId.has(b.task) && !inProg.has(b.task) && !(b.kind === 'chain' && stackedIds.has(b.task)))
      .filter((b) => b.kind !== 'unscoped' || !lane(b.task))
      .map((b) => ({ task: b.task, title: clip(byId.get(b.task)?.title || '', 120), role: b.role || byId.get(b.task)?.role || null, kind: b.kind, why: clip(b.why, 220), ...(b.fix ? { fix: clip(b.fix, 200) } : {}), ...(b.runsAlone ? { runsAlone: true } : {}) }));

    // ---- the last pass ----
    // Its earlier decisions: what the last pass decided is listed above, not again here.
    const thisPass = new Set([...(status.lanes?.set || []).map((x) => `task.lane:${x.task}`), ...(status.lanes?.stacked || []).map((x) => `task.hold:${x.task}`), ...(status.fixed || []).map((x) => `line.fixed:${x.task}`)]);
    const recent = events.filter((e) => e.agent === 'line-producer' && /^(task\.lane|task\.hold|line\.fixed|line\.plan_blocked)$/.test(e.type) && Date.parse(e.ts) > now - DAY && !(thisPass.has(`${e.type}:${e.task}`) && Date.parse(e.ts) >= (at || 0) - 10 * 60000))
      .slice(-PLAN_ROWS.recent).reverse().map((e) => ({ at: e.ts, type: e.type, ...(e.task ? { task: e.task } : {}), what: clip(String(e.msg || '').replace(/^line-producer \(for the Producer\):\s*/, ''), 200) }));
    const b = status.builders || {};
    const lastPass = {
      at: status.at || null,
      ...(ageMin !== null ? { ageMin } : {}),
      mode: status.mode || null,
      ...(status.dryRun ? { dryRun: true } : {}),
      ...(status.error ? { error: clip(status.error, 300) } : {}),
      text: clip(status.text || '', 400),
      lanesSet: (status.lanes?.set || []).map((s) => ({ task: s.task, lane: s.lane, from: s.from || [], ...(s.dry ? { dry: true } : {}), ...(s.error ? { error: clip(s.error, 160) } : {}) })),
      stacked: (status.lanes?.stacked || []).map((s) => ({ task: s.task, after: s.after, via: s.via || [], ...(s.dry ? { dry: true } : {}) })),
      runningNoLane: (status.lanes?.running || []).map((r) => r.task),
      fixed: (status.fixed || []).map((f) => ({ task: f.task || null, what: clip(f.what, 200) })),
      reasons: (status.reasons || []).map((r) => clip(r, 300)),
      ...(status.lanes?.shared?.from ? { sharedFrom: status.lanes.shared.from } : {}),
      recent,
    };
    return {
      ...room,
      hasPlan: true,
      live,
      ...(live ? {} : { stale: supervisorRunning ? `the last pass is ${ageMin ?? '?'} min old` : "the supervisor isn't running (the Line Producer runs on its loop)" }),
      builders: {
        running: nowRows.length,
        ...(Number.isFinite(b.target) ? { target: b.target } : {}),
        ...(Number.isFinite(b.paceCap) ? { paceCap: b.paceCap } : {}),
        ...(Number.isFinite(b.rigCap) ? { rigCap: b.rigCap } : {}),
        ...(Number.isFinite(b.running) ? { atPass: b.running } : {}),
        ...(b.why ? { why: clip(b.why, 300) } : {}),
      },
      next: nextRows.slice(0, PLAN_ROWS.next),
      nextMore: Math.max(0, nextRows.length - PLAN_ROWS.next),
      ...(wavesEv ? { wavesAt: wavesEv.ts } : {}),
      waiting: {
        stacked: stacked.slice(0, PLAN_ROWS.stacked), stackedMore: Math.max(0, stacked.length - PLAN_ROWS.stacked),
        blocked: blocked.slice(0, PLAN_ROWS.blocked), blockedMore: Math.max(0, blocked.length - PLAN_ROWS.blocked),
      },
      lastPass,
    };
  } catch (e) {
    return { room: 'planning', on: planningRoomOn(env), roomInfo: PLANNING_ROOM, hasPlan: false, error: e.message, now: [] };
  }
}
