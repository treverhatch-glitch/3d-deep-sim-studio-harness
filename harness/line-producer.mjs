#!/usr/bin/env node
/**
 * harness/line-producer.mjs — the Line Producer, the studio's flow desk. Code on the supervisor's loop, no model and no
 * tokens for the routine part. The Director ranks the plan, the Producer approves it (studio/roles/line-producer.md);
 * this executes it and never changes direction: a plan that can't run becomes one Producer note.
 *
 * Each supervisor pass (lineProducerPass, before the supervisor picks what to start):
 *   a. builders the rig can carry (harness/rig-budget.mjs rigBudget(), else harness/heavy-budget.mjs; STUDIO_LINE_RIG=heavy
 *      forces the second) against the pace's count; it only ever lowers the starts;
 *   b. why each waiting task can't start, and the mechanical fixes it makes, logged (.studio/line/actions.jsonl, line.fixed
 *      events): dead locks, lost lane copies queued for the train, past-due cooldowns/blocks/parks;
 *   c. chain-breakers (STUDIO_LINE_CHAIN_MIN (3) or more open tasks wait on it) start first, on the strongest model;
 *   d. a model per task by size (harness/routing.mjs tierModels, else STUDIO_TIER_<TIER>_MODEL), one tier up per red round;
 *   e. STUDIO_LINE_EXPANSION_SHARE (1/6) of the builders on research and expansion work, balanced across the Bible's phases;
 *      under STUDIO_LINE_EXPANSION_MIN (2) such tasks it files ONE "Director: next ranked slice for phase <n>" task;
 *   f. one Producer note (.studio/line/producer-note.md, a line.plan_blocked event when its reasons change);
 *   h. engine trains (harness/unity-train.mjs, harness/engine-tracks.mjs): enginePass starts `task train --engine <x>`
 *      detached when the engine slot is free (STUDIO_ENGINE_SLOTS), or in a quiet window (STUDIO_ENGINE_WINDOW=quiet).
 *      STUDIO_ENGINE_TRAIN_AUTO=off (or engines.<x>.trainAuto false) leaves it to a person;
 *   i. the game tester (testerPass, harness/tester.mjs; STUDIO_TESTER_EVERY_HOURS (24), STUDIO_TESTER_MIN_LANDINGS (10),
 *      STUDIO_TESTER_WIRE_TASKS).
 * It writes .studio/line/status.json (lineStatus(): what the Communicator posts and the supervisor reads for its order).
 *
 * STUDIO_LINE_PRODUCER: on (default) | report (status only: no fixes, no task filed, the supervisor ignores the plan) |
 * off. Its fixes are routine housekeeping, never an owner decision; what needs the owner (a yes, an unpark, an unhold) is
 * only reported, naming who may act (harness/delegation.mjs delegationFor; beta mode's agents).
 *
 *   npm run line -- status [--json]      the last pass (or a dry one when there is none)
 *   npm run line -- plan [--json]        a dry pass now: the order, the routes, what it would fix
 *   npm run line -- why <T-ID>           why that task isn't running, and what would start it
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { writeAtomic, readJson } from './fsafe.mjs';
import { OWNER_STEP_PROTECTED } from './owner-only.mjs';
import { postAsk } from './ask-post.mjs';

export const LINE_AGENT = 'line-producer';
export const LINE_DIR = () => path.join(STUDIO_STATE_DIR, 'line');
export const LINE_STATUS_FILE = () => path.join(LINE_DIR(), 'status.json');
export const LINE_ACTIONS_FILE = () => path.join(LINE_DIR(), 'actions.jsonl');
export const LINE_NOTE_FILE = () => path.join(LINE_DIR(), 'producer-note.md');
export const SLICE_TITLE = /^Director: next ranked slice\b/i;
export const PHASE_LABEL = { 1: 'early', 2: 'mid', 3: 'late' };
export const TIERS = ['cheap', 'mid', 'top'];
const KIND_ORDER = ['trunk', 'chain', 'park', 'cooldown', 'blocked', 'budget', 'lock', 'busy', 'merge', 'yes', 'held', 'protected', 'lane', 'unscoped'];
const OWNER_KINDS = new Set(['yes', 'park', 'held']);
const PRI = (p) => { const m = String(p || '').match(/P(\d)/i); return m ? Number(m[1]) : 9; };
const num = (v, d) => { const s = String(v ?? '').trim(); const n = Number(s); return s !== '' && Number.isFinite(n) ? n : d; };
const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);

/** on | report | off (STUDIO_LINE_PRODUCER, default on). */
export function lineMode(env = process.env) {
  const v = String(env.STUDIO_LINE_PRODUCER ?? '').trim().toLowerCase();
  if (/^(off|0|false|no)$/.test(v)) return 'off';
  if (/^(report|shadow|dry)$/.test(v)) return 'report';
  return 'on';
}
/** STUDIO_LINE_EXPANSION_SHARE: "1/6" (default), "0.2", "20%"; 0 turns the share off. */
export function expansionShare(env = process.env) {
  const v = String(env.STUDIO_LINE_EXPANSION_SHARE ?? '').trim();
  if (!v) return 1 / 6;
  const frac = v.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (frac) return Number(frac[2]) > 0 ? Math.min(1, Number(frac[1]) / Number(frac[2])) : 1 / 6;
  const pct = v.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pct) return Math.min(1, Number(pct[1]) / 100);
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(1, n) : 1 / 6;
}
export const phaseLabel = (p) => (Number(p) >= 3 ? 'late' : PHASE_LABEL[Number(p)] || 'unphased');

/** Research or expansion work: a research/study/idea task, engine track, meta.expansion, or Research:/Expansion: title. */
export function isExpansion(t, meta = {}, type = '') {
  if (!t || t.role === 'human' || t.role === 'producer' || t.role === 'director' || SLICE_TITLE.test(t.title || '')) return false;
  if (meta.expansion || meta.slice) return true;
  if (['research', 'study', 'idea'].includes(String(type || meta.type || '').toLowerCase())) return true;
  if (/^engine(:|$)/i.test(String(meta.track || ''))) return true;
  return /^(research|expansion|explore)\b\s*[:—–-]/i.test(String(t.title || ''));
}

/** Tasks STUDIO_LINE_CHAIN_MIN (3) or more open tasks wait on, directly or down a chain of --after: [{ task, waiting, n }], most first. */
export function chainBreakers(open, holds = {}, done = new Set(), min = 3) {
  const openIds = new Set(open.map((t) => t.id));
  const deps = new Map();
  for (const t of open) {
    const h = holds[t.id] || {};
    const after = (h.after || []).filter((id) => !done.has(id) && !(h.chainTail?.chain || []).includes(id));
    deps.set(t.id, after);
  }
  const waitingOn = new Map();
  const walk = (start) => {
    const seen = new Set();
    const stack = [...(deps.get(start) || [])];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id) || id === start) continue;
      seen.add(id);
      for (const d of deps.get(id) || []) stack.push(d);
    }
    return seen;
  };
  for (const t of open) for (const up of walk(t.id)) { if (!openIds.has(up)) continue; if (!waitingOn.has(up)) waitingOn.set(up, []); waitingOn.get(up).push(t.id); }
  return [...waitingOn.entries()].filter(([, w]) => w.length >= min).map(([task, waiting]) => ({ task, waiting: waiting.sort(), n: waiting.length })).sort((a, b) => b.n - a.n || a.task.localeCompare(b.task));
}

/** 1-2 cheap, 3 mid, 4-5 top; no size: chore/docs/test cheap, else mid. */
export function sizeTier(meta = {}, type = '') {
  const s = Number(meta.size);
  if (Number.isFinite(s) && s > 0) return s <= 2 ? 'cheap' : s >= 4 ? 'top' : 'mid';
  return ['chore', 'docs', 'test'].includes(String(type || '').toLowerCase()) ? 'cheap' : 'mid';
}

/** The route for one task: { tier, model, why }. model null: the launcher keeps its own choice (no model for the tier, a rescue, a started task). */
export function routeTask(t, { meta = {}, type = '', chainBreaker = false, failed = 0, started = false, models = {} } = {}) {
  if (/^Rescue:/i.test(String(t.title || ''))) return { tier: null, model: null, why: 'a rescue: the rescue model starts it' };
  const base = chainBreaker ? 'top' : sizeTier(meta, type);
  const idx = Math.min(TIERS.length - 1, TIERS.indexOf(base) + (chainBreaker ? 0 : Math.max(0, Number(failed) || 0)));
  const tier = TIERS[idx];
  const sized = chainBreaker ? 'a chain-breaker: the strongest model, no trials' : `size ${meta.size || '?'}${meta.size ? '' : ` (${type || 'change'})`}: ${base}${failed && !chainBreaker ? `, ${failed} red round(s): up to ${tier}` : ''}`;
  if (started && !failed && !chainBreaker) return { tier, model: null, why: `${sized}; it already started: it keeps its model until it lands or fails` };
  let model = models[tier] || null;
  if (!model && tier === 'top') model = models.mid || null;
  return { tier, model, why: model ? `${sized} -> ${model}` : `${sized}; no model listed for the ${tier} tier (studio/policy.json "routing".tiers or STUDIO_TIER_${tier.toUpperCase()}_MODEL): the launcher's default` };
}

/** The route by model pool (harness/model-pools.mjs pickPool), quota-aware: { tier (the size class), model, tool, pool, why }. A rescue keeps the rescue model. */
export function poolRoute(t, { chainBreaker = false, pools }) {
  if (/^Rescue:/i.test(String(t.title || ''))) return { tier: null, model: null, why: 'a rescue: the rescue model starts it' };
  const r = pickPoolFn(pools)({ size: t.size || 'normal', chainBreaker, failed: t.poolFailed ?? t.failed ?? 0, lastFailedPool: t.lastFailedPool || null, protectedHeavy: Boolean(t.protectedHeavy), startedOn: t.started && t.state !== 'running' ? t.startedOn || null : null }, pools);
  return { tier: r.size, model: r.model, ...(r.tool ? { tool: r.tool } : {}), ...(r.pool ? { pool: r.pool } : {}), why: r.why };
}
let pickPoolImpl = null;
const pickPoolFn = (pools) => pools.pickPool || pickPoolImpl;

/**
 * The plan from plain data (pure). facts: { now, tasks: [{ id, title, role, priority, meta, type, state: 'ready'|
 * 'running'|'blocked', block: { kind, why, fix, mechanical? }, failed, started }], holds, done (Set), sessions, pace,
 * rig, models, share, chainMin, expansionMin, sliceOpen, extraBlocked }.
 */
/** Under this CPU share the machine counts as idle (the scorecard's rig measure uses the same line). */
export const RIG_IDLE_PCT = 25;
export function linePlan(f) {
  const tasks = f.tasks || [];
  const live = (f.sessions || []).filter((s) => s.running);
  const builders = live.filter((s) => s.role === 'builder');
  const open = tasks.filter((t) => t.role !== 'human');
  const cbs = chainBreakers(open, f.holds || {}, f.done || new Set(), f.chainMin ?? 3);
  const cbSet = new Set(cbs.map((c) => c.task));
  const paceCap = Math.max(0, Math.min(Number(f.pace?.maxAgents ?? 1), Number(f.pace?.perRole?.builder ?? 1)));
  const rig = f.rig || { known: false };
  let rigCap = null;
  let rigWhy = rig.why || 'no fresh machine scan: the pace decides';
  if (rig.known) {
    if (rig.cpuHold) { rigCap = builders.length; rigWhy = `CPU ${Math.round(rig.cpuBusy * 100)}% busy (STUDIO_LINE_CPU_BUSY_PCT ${rig.cpuBusyPct}): no new builder until it drops`; } else if (Number.isFinite(rig.byRam)) { rigCap = rig.byRam; rigWhy = rig.why || `RAM room for ${rig.byRam}`; }
  }
  // While an engine land waits for RAM, the builder cap steps down one at a time (engine-ram.mjs) via rigCap; none is stopped.
  if (Number.isFinite(f.engineHold?.cap) && (rigCap === null || f.engineHold.cap < rigCap)) { rigCap = Math.max(0, f.engineHold.cap); rigWhy = `an engine land waits for RAM: builder cap stepped down to ${rigCap} (${f.engineHold.why})`; }
  const target = rigCap === null ? paceCap : Math.min(paceCap, rigCap);
  const readyB = tasks.filter((t) => t.state === 'ready' && t.role === 'builder');
  // Pace-limited but the machine is idle (CPU under RIG_IDLE_PCT, RAM room): the plan says how many more it could carry.
  // It starts none: the pace is the owner's spend decision (npm run mode).
  let room = null;
  if (rig.known && !rig.cpuHold && !f.engineHold && Number.isFinite(rig.cpuBusy) && rig.cpuBusy * 100 < RIG_IDLE_PCT && Number.isFinite(rig.byRam) && rig.byRam > paceCap && builders.length >= paceCap && readyB.length) {
    room = { extra: Math.min(rig.byRam - paceCap, readyB.length), cpuPct: Math.round(rig.cpuBusy * 100), byRam: rig.byRam, waiting: readyB.length };
  }
  const blocked = tasks.filter((t) => t.state === 'blocked').map((t) => ({ task: t.id, role: t.role, kind: t.block.kind, why: t.block.why, fix: t.block.fix || '', ...(t.block.mechanical ? { mechanical: true } : {}), ...(t.block.fixed ? { fixed: t.block.fixed } : {}) }));
  for (const b of f.extraBlocked || []) blocked.push(b);
  for (const u of f.lanes?.unscoped || []) blocked.push({ task: u.task, role: 'builder', kind: 'unscoped', why: u.why, fix: u.fix, runsAlone: true });
  blocked.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.task.localeCompare(b.task));
  const kinds = {};
  for (const b of blocked) kinds[b.kind] = (kinds[b.kind] || 0) + 1;
  const share = Number.isFinite(f.share) ? f.share : 1 / 6;
  const slots = share > 0 ? Math.round(target * share) : 0;
  const exp = tasks.filter((t) => isExpansion(t, t.meta || {}, t.type));
  const byTask = new Map(tasks.map((t) => [t.id, t]));
  const runningExp = live.filter((s) => s.task && byTask.has(s.task) && isExpansion(byTask.get(s.task), byTask.get(s.task).meta || {}, byTask.get(s.task).type));
  const byPhase = {};
  for (const p of ['1', '2', '3', 'unphased']) byPhase[p] = { label: p === 'unphased' ? 'unphased' : phaseLabel(p), open: 0, ready: 0, running: 0 };
  const pk = (t) => { const p = Number(t?.meta?.phase); return p >= 1 ? String(Math.min(3, p)) : 'unphased'; };
  for (const t of exp) { byPhase[pk(t)].open += 1; if (t.state === 'ready') byPhase[pk(t)].ready += 1; }
  for (const s of runningExp) byPhase[pk(byTask.get(s.task))].running += 1;
  const lowPhase = ['1', '2', '3'].sort((a, b) => (byPhase[a].open + byPhase[a].running) - (byPhase[b].open + byPhase[b].running) || Number(a) - Number(b))[0];
  const expMin = f.expansionMin ?? 2;
  const askSlice = slots > 0 && exp.length < expMin && !f.sliceOpen ? Number(lowPhase) : null;
  const ready = tasks.filter((t) => t.state === 'ready');
  const boardIdx = new Map(tasks.map((t, i) => [t.id, i]));
  const order = [];
  const take = (t) => { if (t && !order.includes(t.id)) order.push(t.id); };
  // 2.85 (f): a ready vision fix (task add --vision-fix, or a fix of one: meta.visionFix) goes before everything else.
  for (const t of ready) if (t.meta?.visionFix) take(t);
  // An engine push: that engine's ready porters and track builders go first, the game's work after.
  if (f.enginePush?.engine) for (const t of ready) if ((t.role === 'engine-porter' || t.role === 'builder') && String(t.meta?.track || '').replace(/^engine:/, '') === f.enginePush.engine) take(t);
  for (const c of cbs) take(ready.find((t) => t.id === c.task));
  const expNeed = Math.max(0, slots - runningExp.length);
  if (expNeed) {
    const phaseRank = (t) => { const p = pk(t); return p === 'unphased' ? 9 : byPhase[p].running + (p === lowPhase ? -1 : 0); };
    ready.filter((t) => exp.includes(t)).sort((a, b) => phaseRank(a) - phaseRank(b) || PRI(a.priority) - PRI(b.priority) || boardIdx.get(a.id) - boardIdx.get(b.id)).slice(0, expNeed).forEach(take);
  }
  ready.slice().sort((a, b) => PRI(a.priority) - PRI(b.priority) || boardIdx.get(a.id) - boardIdx.get(b.id)).forEach(take);
  // A lane-less ready task holds the whole game: it is skipped while other work can run (the Producer is asked once to
  // scope it) and may go alone when nothing else can.
  const skip = [];
  if (target > 1 && f.lanes?.unscoped?.length) {
    const unscoped = new Set(f.lanes.unscoped.map((u) => u.task));
    const otherWork = builders.length > 0 || ready.some((t) => t.role === 'builder' && !unscoped.has(t.id));
    if (otherWork) for (const id of unscoped) { skip.push(id); const i = order.indexOf(id); if (i >= 0) order.splice(i, 1); }
  }
  const routes = {};
  for (const t of tasks.filter((x) => x.state !== 'blocked' || cbSet.has(x.id))) routes[t.id] = f.pools ? poolRoute(t, { chainBreaker: cbSet.has(t.id), pools: f.pools }) : routeTask(t, { meta: t.meta || {}, type: t.type, chainBreaker: cbSet.has(t.id), failed: t.failed || 0, started: Boolean(t.started), models: f.models || {} });
  const reasons = [];
  for (const c of cbs) {
    const t = byTask.get(c.task);
    if (t?.state === 'blocked' && OWNER_KINDS.has(t.block.kind)) reasons.push(`chain-breaker ${c.task} (${c.n} task${c.n === 1 ? '' : 's'} wait on it: ${c.waiting.slice(0, 5).join(', ')}${c.n > 5 ? ' …' : ''}) can't start: ${t.block.why}`);
  }
  const free = target - builders.length;
  const bBlocked = blocked.filter((b) => b.role === 'builder' && !b.fixed);
  if (free > 0 && !readyB.length && bBlocked.length) {
    const k = {};
    for (const b of bBlocked) k[b.kind] = (k[b.kind] || 0) + 1;
    reasons.push(`${free} builder slot${free === 1 ? ' is' : 's are'} free but every open builder task is blocked (${Object.entries(k).map(([kk, n]) => `${n} ${kk}`).join(', ')})`);
  }
  if (target > 1 && f.lanes?.unscoped?.length) reasons.push(`${f.lanes.unscoped.length} ready builder task${f.lanes.unscoped.length === 1 ? ' has' : 's have'} no lane the Line Producer could work out (${f.lanes.unscoped.slice(0, 5).map((u) => u.task).join(', ')}${f.lanes.unscoped.length > 5 ? ' …' : ''}): a builder on one holds the whole game, so no other builder runs beside it; npm run task -- lane <ID> <folders> --by <you>`);
  // A dependency on a task that is on no list holds only that task; the plan "can't run" only when nothing else can run (askDangling asks once).
  const dangling = (f.dangling || []).filter((d) => !(f.done || new Set()).has(d.on));
  const otherWork = tasks.some((t) => t.state === 'running' || t.state === 'ready');
  if (!otherWork) for (const d of dangling) reasons.push(`${d.task} waits for ${d.on}, which isn't on the board: the chain can't finish`);
  if (blocked.some((b) => b.kind === 'trunk')) reasons.push('the trunk is red: only fix tasks start until it is green');
  const gates = cbs.map((c) => {
    const g = byTask.get(c.task);
    const waiters = c.waiting.filter((id) => { const w = byTask.get(id); return w && w.role === 'builder' && w.state === 'blocked' && w.block?.kind === 'chain'; });
    const train = (f.inTrain || {})[c.task] || (/train/i.test(g?.block?.why || '') ? (/unity/i.test(g.block.why) ? 'a Unity train' : 'the merge train') : null);
    const where = train ? `in ${train}` : g?.state === 'running' ? 'in progress' : g?.state === 'blocked' ? (g.block.kind === 'park' ? 'parked' : `blocked (${g.block.kind})`) : 'ready but not started';
    return { task: c.task, n: waiters.length, where, inTrain: Boolean(train), waiting: waiters.slice(0, 8) };
  }).filter((g) => g.n > 0).sort((a, b) => b.n - a.n || a.task.localeCompare(b.task));
  const why = [`pace ${f.pace?.label || '?'} allows ${paceCap} builder${paceCap === 1 ? '' : 's'}`, rigCap === null ? rigWhy : `rig: ${rigWhy}`, `${builders.length} running`, `${readyB.length} ready`, blocked.length ? `${blocked.length} blocked (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')})` : null].filter(Boolean).join('; ');
  return {
    builders: { running: builders.length, target, paceCap, rigCap, ready: readyB.length, why, ...(room ? { room } : {}) },
    order,
    skip,
    routes,
    blocked,
    gates,
    dangling,
    chainBreakers: cbs.map((c) => ({ ...c, state: byTask.get(c.task)?.state || 'unknown', ...(byTask.get(c.task)?.block ? { why: byTask.get(c.task).block.why } : {}) })),
    expansion: { share: Math.round(share * 1000) / 1000, slots, running: runningExp.length, open: exp.length, byPhase, lowPhase: Number(lowPhase), askSlice, sliceOpen: f.sliceOpen ? f.sliceOpen.id : null },
    reasons,
  };
}

// the rig (an adapter: rigBudget() when it is there, else the heavy budget)

const JOB_RANK = (h) => { const k = `${h.kind || ''} ${h.label || ''}`.toLowerCase(); return /train/.test(k) ? 0 : /verify|gate/.test(k) ? 1 : /unity|blender|art|asset|bake/.test(k) ? 2 : /soak|slow/.test(k) ? 3 : 4; };
/** The rig now: { source, known, byRam, cpuBusy, cpuHold, usableRamGb, claimedGb, freeRamGb, cores, heavy, train, why }. */
export async function rigNow({ env = process.env, now = Date.now(), deps = {} } = {}) {
  const busyPct = num(env.STUDIO_LINE_CPU_BUSY_PCT, 90);
  const perGb = Math.max(0.1, num(env.STUDIO_LINE_BUILDER_GB, 1));
  let train = null;
  try {
    const { mainRoot } = await import('./worktree.mjs');
    const t = deps.trainLock ? deps.trainLock() : (await import('./train-daemon.mjs')).trainLockHeld(mainRoot(), env, now);
    train = t ? { running: true, pid: t.pid || null, since: t.at ? new Date(Number(t.at)).toISOString() : null } : { running: false };
  } catch { train = null; }
  if (!/^heavy$/i.test(String(env.STUDIO_LINE_RIG || ''))) {
    try {
      const m = deps.rigBudget ? { rigBudget: deps.rigBudget } : await import('./rig-budget.mjs');
      if (typeof m.rigBudget === 'function') {
        const r = await m.rigBudget({ env, now });
        if (r && typeof r === 'object') {
          const byRam = [r.builders, r.builderRoom, r.sessions].map(Number).find(Number.isFinite);
          const cpuBusy = [r.cpuBusy, r.cpu?.busy].map(Number).find(Number.isFinite);
          const heavy = (Array.isArray(r.jobs) ? r.jobs : Array.isArray(r.heavy) ? r.heavy : Array.isArray(r.running) ? r.running : []).map((h) => ({ kind: h.kind || null, label: h.label || null, owner: h.owner || null, ramGb: h.ramGb ?? null, cpuThreads: h.cpuThreads ?? h.workers ?? null })).sort((a, b) => JOB_RANK(a) - JOB_RANK(b));
          return { source: 'rig-budget', known: r.known !== false && (Number.isFinite(byRam) || Number.isFinite(cpuBusy)), byRam: Number.isFinite(byRam) ? byRam : null, cpuBusy: Number.isFinite(cpuBusy) ? cpuBusy : null, cpuBusyPct: busyPct, cpuHold: Number.isFinite(cpuBusy) && cpuBusy * 100 >= busyPct, freeRamGb: r.freeRamGb ?? r.freeGb ?? null, usableRamGb: r.usableRamGb ?? null, claimedGb: r.claimedGb ?? null, cores: r.cores ?? null, heavy, train, why: r.why || (Number.isFinite(byRam) ? `the rig budget has room for ${byRam} builder session(s)` : '') };
        }
      }
    } catch { /* not there yet: the heavy budget below */ }
  }
  try {
    const hb = await import('./heavy-budget.mjs');
    const h = await import('./heavy.mjs');
    const root = await h.heavyRoot();
    const profile = deps.profile !== undefined ? deps.profile : hb.machineProfile(root, { env, now });
    const holders = deps.holders || h.heavyHolders(root, { env });
    const heavy = holders.map((x) => { const c = hb.claimOf(x); return { kind: c.kind || 'heavy', label: x.label || null, owner: x.owner || null, ramGb: c.ramGb ?? null, cpuThreads: c.cpuThreads ?? null, workers: c.workers ?? null, minutes: x.at ? Math.round((now - Number(x.at)) / 60000) : null }; }).sort((a, b) => JOB_RANK(a) - JOB_RANK(b));
    if (!profile) return { source: 'heavy-budget', known: false, heavy, train, why: 'no fresh machine scan: the pace decides', cpuBusyPct: busyPct };
    const st = hb.budgetState(profile, holders, { env });
    // A running engine train's RAM counts between its land runs too (heavy-budget.mjs engineTrainReserve).
    const er = deps.engineReserve || hb.engineTrainReserve(root, holders, { env, now });
    const room = Number.isFinite(st.usableRamGb) ? Math.max(0, st.usableRamGb - (st.claimedGb || 0) - (er.gb || 0)) : null;
    const byRam = room === null ? null : Math.floor(room / perGb);
    const cpuBusy = Number.isFinite(profile.cpu?.busy) ? profile.cpu.busy : null;
    return { source: 'heavy-budget', known: byRam !== null || cpuBusy !== null, byRam, cpuBusy, cpuBusyPct: busyPct, cpuHold: cpuBusy !== null && cpuBusy * 100 >= busyPct, freeRamGb: st.freeRamGb ?? null, usableRamGb: st.usableRamGb ?? null, claimedGb: st.claimedGb ?? null, engineReserveGb: er.gb || 0, cores: st.cores ?? null, heavy, train, why: byRam === null ? 'the scan has no RAM figure' : `RAM ${st.usableRamGb} GB budget - ${st.claimedGb} GB of heavy claims${er.gb ? ` - ${er.gb} GB for ${er.why}` : ''} = room for ${byRam} builder${byRam === 1 ? '' : 's'} at ${perGb} GB (STUDIO_LINE_BUILDER_GB)` };
  } catch (e) { return { source: 'none', known: false, heavy: [], train, why: `the machine budget couldn't be read (${e.message})` }; }
}

// gathering the facts, and the mechanical fixes

const gitIn = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });

/** One logged action: .studio/line/actions.jsonl (the last 200 kept) and a line.fixed event. */
function logAction(a, { emit = true } = {}) {
  const rec = { at: new Date().toISOString(), ...a };
  try {
    fs.mkdirSync(LINE_DIR(), { recursive: true });
    const f = LINE_ACTIONS_FILE();
    const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-199) : [];
    fs.writeFileSync(f, `${[...old, JSON.stringify(rec)].join('\n')}\n`);
  } catch { /* the event still says it */ }
  if (emit) { try { emitEvent({ type: a.kind === 'slice' ? 'line.slice_asked' : 'line.fixed', agent: LINE_AGENT, task: a.task || undefined, to: a.kind === 'slice' ? 'director' : 'producer', msg: `Line Producer: ${a.what}`.slice(0, 500), meta: { kind: a.kind, housekeeping: a.kind !== 'slice', ...(a.meta || {}) } }); } catch {} }
  return rec;
}
export function readActions(n = 10) {
  try { return fs.readFileSync(LINE_ACTIONS_FILE(), 'utf8').split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l)); } catch { return []; }
}

/** Recreates a train queue entry's lost lane copy from its branch. */
export function restoreLaneCopy(root, entry, { dryRun = false } = {}) {
  const rel = path.relative(path.join(root, '.lanes'), path.resolve(root, entry.dir || ''));
  if (!entry.dir || !entry.branch || rel.startsWith('..') || path.isAbsolute(rel) || !rel || rel.includes(path.sep) || rel.startsWith('_train-')) return { ok: false, why: `its lane copy ${entry.dir || '(none)'} isn't a lane folder under .lanes/` };
  if (gitIn(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${entry.branch}`).status !== 0) return { ok: false, why: `its lane copy ${entry.dir} is gone and so is its branch ${entry.branch}: nothing to rebuild it from` };
  if (dryRun) return { ok: true, dry: true, why: `would recreate ${entry.dir} from ${entry.branch}` };
  gitIn(root, 'worktree', 'prune');
  const add = gitIn(root, 'worktree', 'add', entry.dir, entry.branch);
  if (add.status !== 0) return { ok: false, why: `git worktree add failed: ${String(add.stderr || '').trim().split('\n').pop()}` };
  const link = (target, at) => { try { if (!fs.existsSync(at) && fs.existsSync(target)) fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir'); } catch {} };
  for (const d of ['studio', '.studio']) { const at = path.join(entry.dir, d); try { fs.rmSync(at, { recursive: true, force: true }); } catch {} link(path.join(root, d), at); }
  link(path.join(root, 'node_modules'), path.join(entry.dir, 'node_modules'));
  try {
    const name = path.basename(entry.dir);
    const exclude = path.join(root, '.studio', 'lanes', `${name}.exclude`);
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    if (!fs.existsSync(exclude)) fs.writeFileSync(exclude, ['/studio', '/.studio', '/.env', 'node_modules', ''].join('\n'));
    gitIn(entry.dir, 'config', '--worktree', 'core.excludesFile', exclude);
    gitIn(entry.dir, 'update-index', '--skip-worktree', '--', ...['studio', '.studio'].flatMap((d) => (gitIn(entry.dir, 'ls-files', '--', d).stdout || '').split('\n').filter(Boolean)).slice(0, 5000));
  } catch {}
  const head = (gitIn(entry.dir, 'rev-parse', 'HEAD').stdout || '').trim();
  return { ok: true, why: `recreated ${entry.dir} from ${entry.branch}${head ? ` at ${head.slice(0, 8)}` : ''}`, head };
}

/** Who may act where the owner is needed: beta mode's agents and the owner's delegate. */
async function ownerHelpers(action) {
  const out = [];
  try {
    const { readBeta } = await import('./beta-mode.mjs');
    const b = readBeta();
    if (b.on) out.push(...(b.doc.agents || []).map((a) => `${a} (beta mode)`), 'a Producer/Director session (beta mode)');
  } catch {}
  try {
    const d = await import('./delegation.mjs');
    const doc = d.readDelegation().doc;
    if (doc?.agent && d.delegationFor({ action, by: doc.agent }).ok) out.push(`${doc.agent} (delegation)`);
  } catch {}
  return [...new Set(out)];
}

/** The facts for linePlan, and the mechanical fixes (unless dryRun or report mode). deps are for tests. */
export async function gatherFacts({ now = Date.now(), dryRun = false, env = process.env, deps = {} } = {}) {
  const fix = !dryRun && lineMode(env) === 'on';
  const task = await import('./task.mjs');
  const th = await import('./task-hold.mjs');
  const lock = await import('./lock.mjs');
  const { mainRoot } = await import('./worktree.mjs');
  const root = deps.root || mainRoot();
  const events = deps.events || readRecentEvents(20000);
  const fixed = [];
  if (fix) {
    try {
      const freed = lock.releaseDeadOwners((owner, l) => lock.holderGone(l) === true);
      for (const k of freed) fixed.push(logAction({ kind: 'lock', task: (k.match(/^task:(\S+)/) || [])[1] || null, what: `freed ${k}: its holder's session is over` }));
    } catch { /* the watcher frees them too */ }
  }
  let holds = deps.holds || th.readHolds();
  const q = deps.queue || task.parseNextQueue();
  const doneSet = new Set(q.done.map((t) => t.id));
  if (fix) {
    for (const [id, h] of Object.entries(holds)) {
      const patch = {};
      const what = [];
      if (h.cooldownUntil && Date.parse(h.cooldownUntil) <= now) { patch.cooldownUntil = null; patch.cooldownBy = null; patch.cooldownRole = null; what.push(`a cooldown past due (${String(h.cooldownUntil).slice(0, 16)})`); }
      if (h.until && Date.parse(h.until) <= now) { patch.until = null; what.push(`a block past due (${String(h.until).slice(0, 16)})`); }
      if (h.parked?.until && th.parkOver(h.parked.until, doneSet, now)) { patch.parked = null; what.push(`a park whose --until (${h.parked.until}) has come`); }
      if (!what.length) continue;
      try { th.setHold(id, patch, { by: LINE_AGENT }); fixed.push(logAction({ kind: 'hold', task: id, what: `cleared ${what.join(' and ')} on ${id}` })); } catch {}
    }
    holds = th.readHolds();
  }
  // Lane copies gone for the train's queue: recreated from the branch (never while a train runs).
  const extraBlocked = [];
  try {
    const tq = deps.trainQueue || readJson(path.join(root, '.studio', 'train', 'queue.json'), []);
    const gone = (Array.isArray(tq) ? tq : []).filter((e) => e?.dir && !fs.existsSync(e.dir));
    if (gone.length) {
      const running = (await import('./train-daemon.mjs')).trainLockHeld(root, env, now);
      for (const e of gone) {
        if (running) { extraBlocked.push({ task: e.task, role: 'builder', kind: 'lane', why: `its lane copy ${e.dir} is gone (queued for the train)`, fix: 'recreated from its branch once the running train ends' }); continue; }
        const r = restoreLaneCopy(root, e, { dryRun: !fix });
        if (r.ok && !r.dry) { fixed.push(logAction({ kind: 'lane', task: e.task, what: `${e.task}: ${r.why}`, meta: { dir: e.dir, branch: e.branch } })); continue; }
        extraBlocked.push({ task: e.task, role: 'builder', kind: 'lane', why: `its lane copy ${e.dir} is gone (queued for the train)`, fix: r.ok ? `${r.why} (STUDIO_LINE_PRODUCER=on)` : r.why, ...(r.ok ? { mechanical: true } : {}) });
      }
    }
  } catch { /* the train hands it back as before */ }
  const inTrain = {};
  try {
    const mq = deps.trainQueue || readJson(path.join(root, '.studio', 'train', 'queue.json'), []);
    for (const e of Array.isArray(mq) ? mq : []) if (e?.task) inTrain[e.task] = 'the merge train';
    const uq = deps.unityQueue || readJson(path.join(root, '.studio', 'train', 'unity-queue.json'), []);
    for (const e of Array.isArray(uq) ? uq : []) if (e?.task) inTrain[e.task] = 'a Unity train';
  } catch { /* "where" falls back to the task's own state */ }
  const live = (deps.sessions || (await import('./agent.mjs')).sessions()).map((s) => ({ agent: s.agent, role: s.role, task: s.task || null, running: Boolean(s.running), model: s.model || null }));
  const locks = deps.locks || lock.listLocks();
  const { claimActive } = await import('./busy.mjs');
  const { handoutBlock } = await import('./handout.mjs');
  const { overBudget } = await import('./task-budget.mjs');
  const { taskType } = await import('./done-check.mjs');
  const { escalationFor } = await import('./model-tiers.mjs');
  const { unmerged } = await import('./worktree.mjs');
  const added = new Map();
  for (const e of events) if (e.type === 'task.added' && e.task) added.set(e.task, e.meta || {});
  const onBoard = new Set([...q.inProgress, ...q.backlog, ...q.done].map((t) => t.id));
  const helpers = { yes: await ownerHelpers('yes'), hold: await ownerHelpers('hold') };
  const who = (k) => (helpers[k].length ? `; may act for the owner: ${helpers[k].join(', ')}` : '');
  const tasks = [];
  const dangling = [];
  const runningTask = new Set(live.filter((s) => s.running && s.task).map((s) => s.task));
  for (const [sec, list] of [['inProgress', q.inProgress], ['backlog', q.backlog]]) {
    for (const t of list) {
      if (!t.role || t.role === 'human') continue;
      const meta = added.get(t.id) || {};
      let type = 'change';
      try { type = taskType(t); } catch {}
      const mine = events.filter((e) => e.task === t.id);
      const lastDone = mine.filter((e) => e.type === 'task.done').pop();
      const since = lastDone ? mine.slice(mine.indexOf(lastDone) + 1) : mine;
      const started = since.some((e) => e.type === 'agent.session.start' || e.type === 'task.start');
      let failed = 0;
      try { failed = escalationFor(t.id, { events, env: {} })?.failed || 0; } catch {}
      const row = { id: t.id, title: t.title, role: t.role, priority: t.priority, meta, type, failed, started };
      for (const a of (holds[t.id]?.after || [])) if (!onBoard.has(a)) dangling.push({ task: t.id, on: a });
      if (sec === 'inProgress' || runningTask.has(t.id)) { tasks.push({ ...row, state: 'running' }); continue; }
      const h = holds[t.id] || {};
      const hr = th.holdReason(t.id, q, now, holds);
      let block = null;
      if (hr) {
        const kind = /trunk is red/.test(hr) ? 'trunk' : /^a rescue for/.test(hr) || (h.held && /held for landing/.test(hr)) ? 'held' : h.needsYes && /dev says yes/.test(hr) ? 'yes' : /^parked by/.test(hr) ? 'park' : /^waits for/.test(hr) ? 'chain' : /^blocked until/.test(hr) ? 'blocked' : /^stopped by/.test(hr) ? 'cooldown' : 'held';
        const fixText = { trunk: 'a fix task turns the trunk green (npm run task -- trunk green --by <name>)', chain: `starts when ${(h.after || []).filter((x) => !doneSet.has(x)).join(', ')} land${(h.after || []).filter((x) => !doneSet.has(x)).length === 1 ? 's' : ''}`, park: `npm run task -- unpark ${t.id} --by <name> (a person's or the Producer's call)${who('hold')}`, yes: `npm run task -- yes ${t.id} --by <dev>${who('yes')}`, held: `npm run task -- unhold ${t.id} --by <name>${who('hold')}`, blocked: 'starts on its own at that time', cooldown: 'starts on its own after the cooldown' }[kind];
        block = { kind, why: hr, fix: fixText };
      }
      if (!block) {
        const ls = lock.status(`task:${t.id}`);
        if (ls.locked) { const gone = lock.holderGone(ls.lock); block = { kind: 'lock', why: `claimed by ${ls.lock.owner}`, fix: gone === true ? 'its holder\'s session is over: freed on the next pass (STUDIO_LINE_PRODUCER=on)' : `${ls.lock.owner} holds it; it is freed when that session ends`, ...(gone === true ? { mechanical: true } : {}) }; }
      }
      if (!block) {
        try { const a = claimActive(t.id, { root, now, events, orphaned: true }); if (a.busy) block = { kind: 'busy', why: `waits for ${a.owner}: ${a.why}`, fix: `${a.owner} is still at work on it` }; } catch {}
      }
      if (!block) {
        try { const b = overBudget(t.id, { events, now, env }); if (b.over) block = { kind: 'budget', why: b.why, fix: 'the Producer re-scopes or splits it (its session budget, STUDIO_TASK_BUDGET)' }; } catch {}
      }
      if (!block) {
        try { const hb = handoutBlock(t.id, q, { locks, unmerged, holds }); if (hb) block = { kind: /holds path:/.test(hb.why) ? 'lock' : 'merge', why: hb.why, fix: /holds path:/.test(hb.why) ? `${hb.owner} holds the folder` : `starts when ${hb.owner}'s branch lands` }; } catch {}
      }
      tasks.push({ ...row, state: block ? 'blocked' : 'ready', ...(block ? { block } : {}) });
    }
  }
  // Lanes for unscoped ready builder tasks, and phase awareness: a task on shared sim code waits for the open one on the same files.
  let lanes = null;
  try {
    const lp = await import('./lane-plan.mjs');
    lanes = await lp.lanePass({ tasks, holds, events, root, env, act: fix, by: LINE_AGENT, ...(deps.files ? { files: deps.files } : {}) });
    if (lanes.changed) holds = th.readHolds();
    for (const st of lanes.stacked || []) {
      const t = tasks.find((x) => x.id === st.task);
      if (t && t.state === 'ready') { t.state = 'blocked'; t.block = { kind: 'chain', why: `waits for ${st.after}: both touch shared sim code (${st.via.slice(0, 3).join(', ')})${st.dry ? ' (the pass would stack it)' : ''}`, fix: `starts when ${st.after} lands (phase awareness: STUDIO_SHARED_SIM)` }; }
    }
  } catch (e) { lanes = { error: e.message }; }
  // Model pools (harness/model-pools.mjs), when on: each task's size class, last failed pool, started model; the outcomes file is rebuilt (written only when this pass acts).
  let pools = null;
  let protectedSteps = [];
  try {
    const mp = await import('./model-pools.mjs');
    pickPoolImpl = mp.pickPool;
    const sizes = new Map(tasks.map((t) => [t.id, mp.sizeClass(t.meta || {}, t.type)]));
    const mc = await mp.modelContext({ env, now, events, sizeOf: (id) => sizes.get(String(id)) || mp.sizeClass(added.get(String(id)) || {}, ''), write: fix, deps: deps.models || {} });
    const byTaskOut = new Map();
    for (const o of mc.outcomes) { if (!byTaskOut.has(o.task)) byTaskOut.set(o.task, []); byTaskOut.get(o.task).push(o); }
    for (const t of tasks) {
      const outs = byTaskOut.get(t.id) || [];
      t.size = sizes.get(t.id);
      // A red round: a session handed back since the task last landed, not for a protected step, a usage limit or a person's stop.
      const sinceLand = outs.slice(outs.map((o) => o.result).lastIndexOf('landed') + 1);
      t.poolFailed = sinceLand.filter((o) => o.result === 'handed' && !o.protected).length;
      t.lastFailedPool = sinceLand.filter((o) => o.result === 'handed' && !o.protected).pop()?.pool || null;
      t.protectedHeavy = Boolean(t.meta?.protected) || outs.some((o) => o.protected);
      const mine = events.filter((e) => e.task === t.id);
      const lastDone = mine.filter((e) => e.type === 'task.done').pop();
      const st = (lastDone ? mine.slice(mine.indexOf(lastDone) + 1) : mine).filter((e) => e.type === 'agent.session.start' && e.model && e.model !== 'unknown').pop();
      if (st) t.startedOn = { model: st.model, tool: st.meta?.tool || null };
    }
    if (mc.on) pools = { cfg: mc.cfg, state: mc.state, rates: mc.rates, recentProt: mc.recentProt, pickPool: mp.pickPool, why: mc.why, quota: mc.quota.why };
    // A protected step a builder handed back goes to someone who may approve it (beta mode or the owner proxy); the task is
    // held from new builders until approved (or the hold ends).
    protectedSteps = await protectedRoutes({ tasks, events, now, env, act: fix });
    for (const ps of protectedSteps) {
      const t = tasks.find((x) => x.id === ps.task);
      if (t && ps.hold && t.state === 'ready') { t.state = 'blocked'; t.block = { kind: 'protected', why: ps.why, fix: ps.fix }; }
    }
  } catch { pools = null; }
  const sliceOpen = [...q.inProgress, ...q.backlog].find((t) => SLICE_TITLE.test(t.title || '')) || null;
  const pace = deps.pace || (await import('./mode.mjs')).effectiveMode();
  const rig = deps.rig || (await rigNow({ env, now }));
  let models = {};
  try {
    const { readPolicy } = await import('./policy-rules.mjs');
    const rt = await import('./routing.mjs');
    const rp = rt.routingPolicy(readPolicy());
    models = rp.models?.length || Object.keys(rp.tiers || {}).length ? rt.tierModels(rp, env) : {};
  } catch { models = {}; }
  if (!Object.keys(models).length) for (const t of TIERS) { const m = String(env[`STUDIO_TIER_${t.toUpperCase()}_MODEL`] || '').trim(); if (m) models[t] = m; }
  return { now, tasks, holds, done: doneSet, sessions: live, pace: { maxAgents: pace.maxAgents, perRole: pace.perRole, label: pace.label }, rig, models, share: expansionShare(env), chainMin: Math.max(1, num(env.STUDIO_LINE_CHAIN_MIN, 3)), expansionMin: Math.max(0, num(env.STUDIO_LINE_EXPANSION_MIN, 2)), sliceOpen: sliceOpen ? { id: sliceOpen.id, title: sliceOpen.title } : null, extraBlocked, dangling, inTrain, fixed, pools, protectedSteps, lanes };
}

/** Who may approve a protected step now: beta mode's agents (harness/beta-mode.mjs), else the owner proxy's agent (harness/delegation.mjs; needs the owner's recorded yes as --permission). { who, via, note } or null. */
export async function protectedApprover({ env = process.env } = {}) {
  try {
    const { readBeta, betaActor } = await import('./beta-mode.mjs');
    const b = readBeta();
    if (b.on) {
      for (const a of b.doc.agents || []) { const x = betaActor({ env: { STUDIO_LOCK_OWNER: String(a) }, kind: 'protected' }); if (x.ok) return { who: String(a), via: 'beta mode', note: 'approves without the owner key while beta mode is on' }; }
      // A Producer session approves a protected step only with the owner's switch (permission.mjs mayDecide).
      const { producerApprovesProtected } = await import('./permission.mjs');
      if (producerApprovesProtected()) return { who: 'producer', via: 'beta mode (a Producer session)', note: 'a Producer session approves while beta mode is on (STUDIO_PRODUCER_APPROVES=protected)' };
    }
  } catch {}
  try {
    const d = await import('./delegation.mjs');
    const doc = d.readDelegation().doc;
    if (doc?.agent && doc.proxy && d.delegationFor({ action: 'approve-protected', by: doc.agent, env: { STUDIO_LOCK_OWNER: String(doc.agent) }, autonomy: false }).ok) return { who: String(doc.agent), via: 'the owner proxy', note: 'signs with the owner\'s recorded yes (--permission "<the owner\'s words>")' };
  } catch {}
  void env;
  return null;
}

/**
 * The protected steps waiting (a task whose newest hand-back names a protected file, with no approval since): routed
 * once per hand-back (a line.protected_routed event) and held from new builders for STUDIO_LINE_PROTECTED_HOLD_MIN (120),
 * or until an approval.protected / approval.proposal or an approve-protected use follows. No approver: reported only.
 */
export async function protectedRoutes({ tasks, events, now = Date.now(), env = process.env, act = true } = {}) {
  const holdMs = Math.max(0, num(env.STUDIO_LINE_PROTECTED_HOLD_MIN, 120)) * 60000;
  const out = [];
  let approver;
  for (const t of tasks) {
    if (t.state === 'running') continue;
    const mine = events.filter((e) => e.task === t.id || (e.type && /^approval\.|^delegation\.used$/.test(e.type) && String(e.msg || '').includes(t.id)));
    const lastStart = mine.filter((e) => e.type === 'task.start' || e.type === 'agent.session.start').pop();
    const pause = mine.filter((e) => e.type === 'task.paused' && (!lastStart || Date.parse(e.ts) >= Date.parse(lastStart.ts))).pop();
    if (!pause || pause.meta?.ownerStep !== OWNER_STEP_PROTECTED) continue;
    const at = Date.parse(pause.ts);
    const approved = mine.some((e) => Date.parse(e.ts) > at && (/^approval\.(protected|proposal)$/.test(e.type) || (e.type === 'delegation.used' && /approve-(protected|proposal)/.test(String(e.meta?.action || '')))));
    if (approved) continue;
    if (approver === undefined) approver = await protectedApprover({ env });
    const note = String(pause.msg || '').replace(/^Handed back \S+: /, '').slice(0, 220);
    if (!approver) { out.push({ task: t.id, at: pause.ts, by: pause.agent || null, actor: null, hold: false, why: `handed back a protected step: ${note}`, fix: 'only the owner approves it (no beta mode or owner proxy): npm run approve -- protected --note "…" in its lane' }); continue; }
    const routedEv = events.filter((e) => e.type === 'line.protected_routed' && e.task === t.id && e.meta?.handBack === pause.ts).pop();
    const routed = Boolean(routedEv);
    const routedAt = routedEv ? Date.parse(routedEv.ts) : now;
    const fixText = `routed to ${approver.who} (${approver.via}): in ${t.id}'s lane copy run npm run approve -- protected --note "${t.id}: <which file and why>"${/proxy/.test(approver.via) ? ' --permission "<the owner\'s words>"' : ''}, then it restarts`;
    if (!routed && act) {
      try { emitEvent({ type: 'line.protected_routed', agent: LINE_AGENT, to: approver.who, task: t.id, msg: `Line Producer: ${t.id}'s protected step (handed back by ${pause.agent || 'its builder'}: "${note.slice(0, 160)}") goes to ${approver.who} (${approver.via}), who may approve it: ${fixText}`.slice(0, 600), meta: { handBack: pause.ts, by: pause.agent || null, actor: approver.who, via: approver.via } }); } catch {}
      logAction({ kind: 'protected', task: t.id, what: `routed ${t.id}'s protected step to ${approver.who} (${approver.via})`, meta: { handBack: pause.ts } }, { emit: false });
    }
    out.push({ task: t.id, at: pause.ts, by: pause.agent || null, actor: approver.who, via: approver.via, hold: (routed || act) && now - routedAt < holdMs, routed: routed || act, why: `its protected step waits for ${approver.who} (${approver.via}): ${note}`, fix: fixText });
  }
  return out;
}

// planner state, the chain gate, dangling asks, the Producer wake back-off

export const LINE_STATE_FILE = () => path.join(LINE_DIR(), 'state.json');
export const readLineState = () => { const j = readJson(LINE_STATE_FILE(), {}); return j && typeof j === 'object' ? j : {}; };
export function writeLineState(st) { try { fs.mkdirSync(LINE_DIR(), { recursive: true }); writeAtomic(LINE_STATE_FILE(), `${JSON.stringify(st, null, 1)}\n`); } catch { /* the next pass tries again */ } }
export const chainGateN = (env = process.env) => Math.max(0, num(env.STUDIO_CHAIN_GATE_N, 3));
export const chainGateMin = (env = process.env) => Math.max(0, num(env.STUDIO_CHAIN_GATE_MIN, 60));
export const producerBlockedWakeMin = (env = process.env) => Math.max(0, num(env.STUDIO_PRODUCER_BLOCKED_WAKE_MIN, 60));
export const CHAIN_GATE_REPEAT_MIN = 120;
export const PLAN_BLOCKED_REPEAT_MIN = 30;
export const WAKE_SKIP_EVERY_MIN = 30;
const hm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/**
 * One task gating more than STUDIO_CHAIN_GATE_N builder tasks for more than STUDIO_CHAIN_GATE_MIN minutes. Pure: `gates`
 * are the plan's, `gateState` is { <task>: { since, lastEmit } }. Returns { gateState, active, fire } (fire: to be said
 * now, at most every 120 minutes).
 */
export function chainGateStep({ gates = [], gateState = {}, now = Date.now(), env = process.env } = {}) {
  const N = chainGateN(env);
  const next = {};
  const active = [];
  const fire = [];
  for (const g of gates) {
    if (!(g.n > N)) continue;
    const prev = gateState[g.task] || {};
    const rec = { since: Number.isFinite(prev.since) ? prev.since : now, lastEmit: Number.isFinite(prev.lastEmit) ? prev.lastEmit : null };
    const old = now - rec.since >= chainGateMin(env) * 60000;
    if (old && (rec.lastEmit === null || now - rec.lastEmit >= CHAIN_GATE_REPEAT_MIN * 60000)) { rec.lastEmit = now; fire.push({ ...g, since: rec.since }); }
    next[g.task] = rec;
    if (old) active.push({ ...g, since: rec.since });
  }
  return { gateState: next, active, fire };
}

export const chainGateText = (g, now = Date.now()) => `Line Producer: ${g.task} gates ${g.n} builder task${g.n === 1 ? '' : 's'} (${g.waiting.slice(0, 5).join(', ')}${g.n > 5 ? ' …' : ''}) since ${hm(g.since)} (${Math.round((now - g.since) / 60000)} min); it is ${g.where}. Split off the parts that do not need it, or remove the dependency: npm run task -- after <ID> --remove ${g.task}`;

/**
 * The planner's own reason in one line for the alerts and the wake back-off: { lead, blocker }. blocker: { key, text }
 * when everything startable waits on a task in a train, or a chain gate stands; else null.
 */
export function planLead(p, { gateState = {}, active = [] } = {}) {
  const g = (p.gates || [])[0];
  const kinds = {};
  for (const b of p.blocked || []) kinds[b.kind] = (kinds[b.kind] || 0) + 1;
  const counts = ['park', 'held'].filter((k) => kinds[k]).map((k) => `${kinds[k]} ${k === 'park' ? 'parked' : 'held'}`);
  const readyNone = !(p.builders?.ready > 0);
  let head = null;
  let blocker = null;
  if (g && readyNone) {
    const since = gateState[g.task]?.since;
    head = `all ready work waits on ${g.task}, which is ${g.where}${since ? ` since ${hm(since)}` : ''} (${g.n} task${g.n === 1 ? '' : 's'})`;
    if (g.inTrain || active.some((a) => a.task === g.task)) blocker = { key: `${g.task}|${g.where}`, text: head };
  } else if ((p.reasons || [])[0]) head = String(p.reasons[0]).slice(0, 200);
  const lead = head ? [head, ...(counts.length ? [counts.join(', ')] : [])].join('; ') : '';
  return { lead, blocker };
}

/** Asks the Producer once per (task, missing id) about a dependency on no list (state.json "asked"). */
export function askDangling({ dangling = [], state, now = Date.now(), deps = {} } = {}) {
  const asked = state.asked && typeof state.asked === 'object' ? state.asked : {};
  const live = new Set(dangling.map((d) => `${d.task}|${d.on}`));
  for (const k of Object.keys(asked)) if (!live.has(k)) delete asked[k];
  const out = [];
  const post = deps.postAsk || postAsk;
  for (const d of dangling) {
    const k = `${d.task}|${d.on}`;
    if (asked[k]) continue;
    asked[k] = new Date(now).toISOString();
    out.push(k);
    try { post({ agent: LINE_AGENT, to: 'producer', task: d.task, subject: `dangling:${d.on}`, status: 'warn', now, msg: `Needs you: ${d.task} waits for ${d.on}, which is on neither the open board nor the done list, so it can never start. The rest of the plan runs. Fix: npm run task -- after ${d.task} --remove ${d.on}`, meta: { task: d.task, missing: d.on }, ...(deps.emit ? { emit: deps.emit } : {}), ...(deps.askRoot ? { r: deps.askRoot } : {}) }); } catch { /* asked again next pass */ }
  }
  state.asked = asked;
  return out;
}

/** Should a plan_blocked event go out for this reason text (changed, or the last one over 30 minutes old)? Pure over state.blocked { key, at }. */
export function planBlockedDue(key, state, now = Date.now()) {
  const b = state.blocked || {};
  const emit = b.key !== key || !Number.isFinite(b.at) || now - b.at >= PLAN_BLOCKED_REPEAT_MIN * 60000;
  return emit ? { emit: true, blocked: { key, at: now } } : { emit: false, blocked: b };
}

/**
 * The Producer's wake while the only blocker is a running train or a chain gate: the first wake goes out, then one per
 * STUDIO_PRODUCER_BLOCKED_WAKE_MIN minutes (state.json "wake"; agent.wake.skipped at most every 30 minutes). { skip, why }.
 */
export function producerWakeBackoff({ now = Date.now(), env = process.env, kind = 'wake', status = undefined, emit = emitEvent } = {}) {
  try {
    const min = producerBlockedWakeMin(env);
    const s = status === undefined ? readLineStatus() : status;
    const at = Date.parse(s?.at || '');
    const b = s?.blocker && Number.isFinite(at) && now - at <= 15 * 60000 ? s.blocker : null;
    const st = readLineState();
    if (!b || min <= 0) { if (st.wake) { delete st.wake; writeLineState(st); } return { skip: false, why: b ? 'back-off is off' : 'no train or chain-gate blocker stands' }; }
    const w = st.wake || {};
    if (w.key !== b.key) { st.wake = { key: b.key, lastWake: now }; writeLineState(st); return { skip: false, why: 'first wake for this blocker' }; }
    if (now - w.lastWake >= min * 60000) { st.wake = { ...w, lastWake: now }; writeLineState(st); return { skip: false, why: `${min} min since the last wake` }; }
    const why = `the only blocker is ${b.text}; the Producer was woken ${Math.round((now - w.lastWake) / 60000)} min ago and is woken at most every ${min} min while it stands`;
    if (!Number.isFinite(w.lastSkip) || now - w.lastSkip >= WAKE_SKIP_EVERY_MIN * 60000) {
      st.wake = { ...w, lastSkip: now }; writeLineState(st);
      try { emit({ type: 'agent.wake.skipped', agent: LINE_AGENT, to: 'producer', msg: `Producer wake skipped (${kind}): ${why}`.slice(0, 400), meta: { kind, blocker: b.key } }); } catch {}
    }
    return { skip: true, why };
  } catch (e) { return { skip: false, why: `error: ${e.message}` }; }
}

/** The Producer note file, rewritten when its reasons change, plus one line.plan_blocked event per change. */
function writeNote(reasons, { now = Date.now() } = {}) {
  const f = LINE_NOTE_FILE();
  const prev = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  const key = reasons.join('\n');
  const prevKey = (prev.match(/<!-- reasons: ([\s\S]*?) -->/) || [])[1] || '';
  if (!reasons.length) {
    if (prev) { try { fs.rmSync(f, { force: true }); } catch {} try { emitEvent({ type: 'line.plan_ok', agent: LINE_AGENT, to: 'producer', msg: 'Line Producer: the plan can run again (the earlier note is cleared)' }); } catch {} }
    return null;
  }
  if (Buffer.from(key).toString('base64') === prevKey) return { file: f, changed: false };
  fs.mkdirSync(LINE_DIR(), { recursive: true });
  fs.writeFileSync(f, `# Line Producer: this plan can't run because …\n\n> Written by harness/line-producer.mjs at ${new Date(now).toISOString()}. The Line Producer never changes direction:\n> the Producer (with the Director for the plan) decides. This note is rewritten when its reasons change and removed\n> when the plan can run. <!-- reasons: ${Buffer.from(key).toString('base64')} -->\n\n${reasons.map((r) => `- ${r}`).join('\n')}\n`);
  // Said when the reason text changes (ids and counts included), else at most once per 30 minutes.
  const st = readLineState();
  const due = planBlockedDue(key, st, now);
  if (due.emit) {
    st.blocked = due.blocked; writeLineState(st);
    try { emitEvent({ type: 'line.plan_blocked', agent: LINE_AGENT, to: 'producer', status: 'warn', msg: `Line Producer: this plan can't run because ${reasons.join('; ')}`.slice(0, 600), meta: { reasons, note: '.studio/line/producer-note.md' } }); } catch {}
  }
  return { file: f, changed: true };
}

/** One pass: gather, fix, plan, file at most one Director slice, write the note and status.json. Returns the status; never throws. */
export async function lineProducerPass({ now = Date.now(), dryRun = false, env = process.env, deps = {} } = {}) {
  const mode = lineMode(env);
  if (mode === 'off') return { mode, off: true, why: 'STUDIO_LINE_PRODUCER=off' };
  try {
    const f = await gatherFacts({ now, dryRun, env, deps });
    const acting = !dryRun && mode === 'on';
    // Engine trains, then the room an engine land needs (before the plan: its builder-target step-down is part of it).
    let engines = [];
    try { engines = await enginePass({ now, env, dryRun: !acting, rig: f.rig, deps }); } catch (e) { engines = [{ error: e.message }]; }
    // An engine push (npm run mode -- engine-push): that engine's porters first, the machine's priority for its lands.
    let enginePush = null;
    try { const pm = await import('./mode.mjs'); const ep = pm.enginePushOf(pm.readMode(), now); enginePush = ep ? { engine: ep.engine, until: ep.until || null, by: ep.by || null } : null; } catch { enginePush = null; }
    f.enginePush = enginePush;
    let engineHold = null;
    try { engineHold = await engineRoomPass({ now, env, act: acting, f, deps }); } catch (e) { engineHold = { hold: false, why: `error: ${e.message}` }; }
    const p = linePlan({ ...f, engineHold });
    let slice = null;
    if (p.expansion.askSlice && acting) {
      const ph = p.expansion.askSlice;
      try {
        const { addTask } = await import('./task.mjs');
        const title = `Director: next ranked slice for phase ${ph} (${phaseLabel(ph)} game): rank and size the next research and expansion tasks it needs (titles "Research: …" or "Expansion: …", each with --phase ${ph} --size 1-5)`;
        const r = addTask({ title, role: 'director', priority: 'P2', agent: LINE_AGENT, meta: { origin: LINE_AGENT, promoted: true, infra: true, phase: ph, lineSlice: true } });
        if (r?.id && !r.error) { slice = r.id; logAction({ kind: 'slice', task: r.id, what: `asked the Director for the next ranked slice for phase ${ph} (${phaseLabel(ph)} game): ${p.expansion.open} research/expansion task(s) open, under STUDIO_LINE_EXPANSION_MIN`, meta: { phase: ph } }); }
      } catch { /* asked again next pass */ }
    }
    let note = null;
    if (acting) { try { note = writeNote(p.reasons, { now }); } catch {} }
    let lineState = readLineState();
    const gateStep = chainGateStep({ gates: p.gates, gateState: lineState.gates || {}, now, env });
    let danglingAsked = [];
    if (acting) {
      for (const g of gateStep.fire) { try { emitEvent({ type: 'line.chain_gate', agent: LINE_AGENT, to: 'producer', status: 'warn', task: g.task, msg: chainGateText(g, now).slice(0, 600), meta: { task: g.task, n: g.n, waiting: g.waiting, where: g.where, since: new Date(g.since).toISOString() } }); } catch {} }
      danglingAsked = askDangling({ dangling: p.dangling, state: lineState, now, deps: deps.askDeps || {} });
    }
    lineState.gates = gateStep.gateState;
    if (acting) writeLineState(lineState);
    const leadInfo = planLead(p, { gateState: lineState.gates, active: gateStep.active });
    let paged = [];
    if (acting) { try { paged = pagePlanBlockers({ p, f, now, deps }); } catch { paged = []; } }
    let chainPush = null;
    try { chainPush = await chainBreakerPush({ chainBreakers: p.chainBreakers, now, env, act: acting, deps: { ...(deps.root ? { root: deps.root } : {}), ...(deps.trainQueue ? { trainQueue: deps.trainQueue } : {}), ...(deps.heavy ? { heavy: deps.heavy } : {}) } }); } catch (e) { chainPush = { on: false, holding: false, why: `error: ${e.message}` }; }
    let twins = null;
    try { twins = await twinPass({ now, env, act: acting, deps: { ...(deps.root ? { root: deps.root } : {}), ...(deps.events ? { events: deps.events } : {}), ...(deps.queue ? { queue: deps.queue } : {}), ...(deps.engines ? { engines: deps.engines } : {}), ...(deps.filesOf ? { filesOf: deps.filesOf } : {}), ...(deps.addTask ? { addTask: deps.addTask } : {}) } }); } catch (e) { twins = { on: false, checked: [], why: `error: ${e.message}` }; }
    let tester = null;
    try { tester = await testerPass({ now, env, act: acting, rig: f.rig, deps }); } catch (e) { tester = { state: 'error', why: e.message }; }
    const status = {
      at: new Date(now).toISOString(),
      mode,
      dryRun: Boolean(dryRun),
      builders: p.builders,
      blocked: p.blocked,
      chainBreakers: p.chainBreakers,
      expansion: { ...p.expansion, ...(slice ? { sliceFiled: slice } : {}) },
      rig: f.rig,
      order: p.order,
      routes: Object.fromEntries(Object.entries(p.routes).filter(([id]) => p.order.includes(id) || p.chainBreakers.some((c) => c.task === id))),
      reasons: p.reasons,
      note: p.reasons.length ? '.studio/line/producer-note.md' : null,
      fixed: f.fixed.map((a) => ({ kind: a.kind, task: a.task, what: a.what })),
      actions: readActions(10),
      models: f.pools ? { on: true, why: f.pools.why, pools: Object.fromEntries(Object.entries(f.pools.state).map(([k, v]) => [k, { model: v.model, tool: v.tool, usedPct: v.usedPct, near: v.near, out: v.out }])) } : { on: false },
      protectedSteps: (f.protectedSteps || []).map(({ task, actor, via, hold, why, fix }) => ({ task, actor, via: via || null, hold, why, fix })),
      engines,
      lanes: f.lanes ? (f.lanes.error ? { error: f.lanes.error } : { mode: f.lanes.mode, set: f.lanes.set, unscoped: f.lanes.unscoped, running: f.lanes.running, stacked: f.lanes.stacked, shared: f.lanes.shared }) : null,
      chainPush,
      engineHold: engineHold ? { hold: Boolean(engineHold.hold), why: engineHold.why, cap: engineHold.cap ?? null, land: engineHold.land?.engine || null, until: engineHold.until ? new Date(engineHold.until).toISOString() : null } : null,
      skip: p.skip,
      enginePush,
      paged,
      lead: leadInfo.lead,
      blocker: leadInfo.blocker,
      chainGates: gateStep.active.map((g) => ({ task: g.task, n: g.n, where: g.where, since: new Date(g.since).toISOString() })),
      danglingAsked,
      twins,
      tester,
    };
    status.text = summaryLine(status);
    if (!dryRun) { try { fs.mkdirSync(LINE_DIR(), { recursive: true }); writeAtomic(LINE_STATUS_FILE(), `${JSON.stringify(status, null, 2)}\n`); } catch {} }
    void note;
    return status;
  } catch (e) { return { mode, error: e.message, at: new Date(now).toISOString() }; }
}

/** "Line: 2/5 builders (rig: …); 4 blocked (2 chain, 1 yes, 1 park); chain-breaker T-010 (3 wait); fixed 1" */
export function summaryLine(s) {
  const kinds = {};
  for (const b of s.blocked || []) kinds[b.kind] = (kinds[b.kind] || 0) + 1;
  const cb = (s.chainBreakers || [])[0];
  return [
    `Line: ${s.builders?.running ?? 0}/${s.builders?.target ?? 0} builders${s.builders?.rigCap !== null && s.builders?.rigCap !== undefined && s.builders.rigCap < (s.builders.paceCap ?? Infinity) ? ` (the rig carries ${s.builders.rigCap})` : ''}${s.builders?.room ? ` (the machine is idle at ${s.builders.room.cpuPct}% CPU with room for ${s.builders.room.extra} more and ${s.builders.room.waiting} ready: the pace is the limit, npm run mode)` : ''}`,
    s.blocked?.length ? `${s.blocked.length} blocked (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')})` : 'nothing blocked',
    cb ? `chain-breaker ${cb.task} (${cb.n} wait${cb.state === 'blocked' ? ', blocked' : ''})` : null,
    s.expansion?.slots ? `expansion ${s.expansion.running}/${s.expansion.slots}` : null,
    s.fixed?.length ? `fixed ${s.fixed.length}` : null,
    s.reasons?.length ? 'a Producer note is open' : null,
    s.chainPush?.holding ? `holding new builder verifies for chain-breaker ${s.chainPush.task}` : null,
    s.enginePush ? `ENGINE PUSH ${s.enginePush.engine}${s.enginePush.until ? ` until ${s.enginePush.until.slice(11, 16)} UTC` : ''}: its porters first, the game gets what is left` : null,
    s.engineHold?.hold ? `holding new verifies for the ${s.engineHold.land} land: ${s.engineHold.why}` : null,
    s.skip?.length ? `skipping lane-less ${s.skip.join(', ')}` : null,
    ...(s.twins?.checked || []).filter((r) => r.need).map((r) => `${r.engine} twin ${r.added || '(to add)'} for ${r.task}`),
    ...(s.engines || []).filter((e) => e.queued || e.running).map((e) => `${e.engine} train: ${e.running ? 'running' : e.started ? 'started' : `${e.queued} queued, waits (${e.why})`}`),
    s.tester?.line || null,
  ].filter(Boolean).join('; ');
}

// the game tester (harness/tester.mjs)

/**
 * The game tester's schedule: advances the run that is going or starts one that is due (STUDIO_TESTER_EVERY_HOURS AND
 * STUDIO_TESTER_MIN_LANDINGS, or `npm run tester -- now`) when the rig isn't starved and a gate slot is free. Then the
 * wire-it pass: a landed module nothing imports gets a "Wire <module> into the game" task. act false: dry.
 */
export async function testerPass({ now = Date.now(), env = process.env, act = true, rig = null, deps = {} } = {}) {
  const t = await import('./tester.mjs');
  let root = deps.root || null;
  if (!root) root = (await import('./worktree.mjs')).mainRoot();
  // A native-engine studio's game is not its web build: no scheduled tester run, no wire-it pass.
  const ne = (await import('./native.mjs')).nativeEngine(root, env);
  if (ne) return { state: 'off', why: `native ${ne}: the game tester's schedule plays the web build, which is not the game here (npm run tester -- now runs one on demand)`, line: '' };
  const td = deps.tester || {};
  const run = await t.testerPass({ root, now, env, act, rig, deps: td });
  let wire = null;
  try { wire = await t.wirePass({ root, now, env, act, deps: { filesOf: (id) => landedFiles(root, id), ...td } }); } catch (e) { wire = { on: false, added: [], why: `error: ${e.message}` }; }
  const line = [run.line || null, wire?.added?.length ? `wire tasks ${wire.added.map((a) => a.task || '(to add)').join(', ')}` : null].filter(Boolean).join('; ') || null;
  return { ...run, wire, line };
}

// page once, keep going

const PAGED_FILE = () => path.join(LINE_DIR(), 'paged.json');
/** A blocker is told once: a parked/owner-only chain-breaker pages the orchestrator (line.blocker_paged), lane-less ready tasks ask the Producer to scope them (line.scope_asked). Returns the keys paged now. */
export function pagePlanBlockers({ p, f, now = Date.now(), deps = {} } = {}) {
  const seen = readJson(PAGED_FILE(), {}) || {};
  const emit = deps.emit || emitEvent;
  const out = [];
  const once = (key, ev) => { if (seen[key]) return; seen[key] = new Date(now).toISOString(); out.push(key); try { emit({ agent: LINE_AGENT, ...ev }); } catch {} };
  const byTask = new Map((f.tasks || []).map((t) => [t.id, t]));
  for (const c of p.chainBreakers || []) {
    const t = byTask.get(c.task);
    if (t?.state !== 'blocked' || !OWNER_KINDS.has(t.block?.kind)) continue;
    once(`blocker:${c.task}:${t.block.kind}`, { type: 'line.blocker_paged', to: 'orchestrator', status: 'warn', task: c.task, msg: `Line Producer: chain-breaker ${c.task} (${c.n} task${c.n === 1 ? '' : 's'} wait on it) can't start: ${t.block.why}. ${t.block.fix ? `Fix: ${t.block.fix}. ` : ''}Everything that doesn't wait on it keeps running; this is said once.`.slice(0, 600), meta: { kind: t.block.kind, waiting: c.waiting } });
  }
  const un = (f.lanes?.unscoped || []).filter((u) => (p.skip || []).includes(u.task));
  if (un.length) {
    const fresh = un.filter((u) => !seen[`scope:${u.task}`]);
    if (fresh.length) {
      for (const u of fresh) seen[`scope:${u.task}`] = new Date(now).toISOString();
      out.push(...fresh.map((u) => `scope:${u.task}`));
      try { emit({ agent: LINE_AGENT, type: 'line.scope_asked', to: 'producer', status: 'warn', msg: `Line Producer: ${fresh.map((u) => u.task).join(', ')} ${fresh.length === 1 ? 'has' : 'have'} no lane, so ${fresh.length === 1 ? 'it is' : 'they are'} skipped while other builders can run (a lane-less builder holds the whole game). Scope ${fresh.length === 1 ? 'it' : 'them'}: npm run task -- lane <ID> <folders> --by <you>. Asked once.`.slice(0, 600), meta: { tasks: fresh.map((u) => u.task) } }); } catch {}
    }
  }
  if (out.length) {
    const keep = Object.entries(seen).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, 500);
    try { fs.mkdirSync(LINE_DIR(), { recursive: true }); writeAtomic(PAGED_FILE(), `${JSON.stringify(Object.fromEntries(keep))}\n`); } catch {}
  }
  return out;
}

// room for an engine land

/**
 * The Line Producer's half of engine-ram.mjs: hold new verifies, step the builder target down, or release (engineHoldPlan)
 * for a queued or near engine land. "Near": an engine-porter task that ran `task done --check` in the last
 * STUDIO_ENGINE_NEAR_MIN (30) minutes.
 */
export async function engineRoomPass({ now = Date.now(), env = process.env, act = true, f, deps = {} } = {}) {
  const er = await import('./engine-ram.mjs');
  const et = await import('./engine-tracks.mjs');
  const ut = await import('./unity-train.mjs');
  const { mainRoot } = await import('./worktree.mjs');
  const root = deps.root || mainRoot();
  const targets = deps.engineTargets || et.engineTargets({ root }).filter((t) => t.land);
  if (!targets.length) return { hold: false, why: 'no engine target with a land command' };
  const nearMs = Math.max(1, num(env.STUDIO_ENGINE_NEAR_MIN, 30)) * 60000;
  const events = deps.events || readRecentEvents(5000);
  const porters = (f.tasks || []).filter((t) => t.role === 'engine-porter' && t.state === 'running');
  const near = (engine) => porters.some((t) => String(t.meta?.track || '').replace(/^engine:/, '') === engine && events.some((e) => e.type === 'task.done_check' && e.task === t.id && now - Date.parse(e.ts) < nearMs));
  let freeGb = Number.isFinite(deps.freeGb) ? deps.freeGb : Number.isFinite(f.rig?.freeRamGb) ? f.rig.freeRamGb : null;
  if (!Number.isFinite(freeGb) && deps.freeGb === undefined) { try { freeGb = (await import('./ram.mjs')).ramCheck({}, env).freeGb; } catch { freeGb = null; } }
  const builders = (f.sessions || []).filter((s) => s.running && s.role === 'builder').length;
  return er.engineHoldPass({ now, env, act, builders, owner: LINE_AGENT, deps: { root, targets, near, freeGb, push: deps.push ?? f.enginePush?.engine ?? null, ...(deps.holders ? { holders: deps.holders } : {}), ...(deps.heavy ? { heavy: deps.heavy } : {}), readQueue: deps.readQueue || ((e) => ut.readUnityQueue(root, e)), needGb: deps.needGb || ((e) => et.engineFloor(e, { env, root }).gb), emit: deps.emit || ((ev) => { try { emitEvent(ev); } catch {} }) } });
}

// the chain-breaker push

/** STUDIO_LINE_CHAIN_HOLD_MIN: minutes from a chain-breaker's queueing that new builder verifies are held back (60; 0/off: none). */
export function chainHoldMin(env = process.env) {
  const v = String(env.STUDIO_LINE_CHAIN_HOLD_MIN ?? '').trim();
  if (/^(off|no|false)$/i.test(v)) return 0;
  return Math.max(0, num(v, 60));
}
/** STUDIO_LINE_HOLD_MAX_MIN: no Line Producer hold on builder verifies lasts longer than this (20). */
export const lineHoldMaxMin = (env = process.env) => Math.max(0, num(env.STUDIO_LINE_HOLD_MAX_MIN, 20));
export const CHAIN_HOLD_TAG = 'chain-breaker';
/**
 * While a chain-breaker is queued for the merge train (.studio/train/queue.json, not held for a person), leaves a quiet
 * hold (harness/heavy.mjs markQuietHold, tag "chain-breaker"): heavy waiters that aren't game landings don't start;
 * running holders are never stopped. Bounded by STUDIO_LINE_CHAIN_HOLD_MIN (60). act false: nothing is written.
 * { on, holding, task?, until?, why }.
 */
export async function chainBreakerPush({ chainBreakers = [], now = Date.now(), env = process.env, act = true, deps = {} } = {}) {
  const h = deps.heavy || (await import('./heavy.mjs'));
  let root = deps.root || null;
  if (!root) { try { root = await h.heavyRoot(); } catch { root = null; } }
  if (!root) return { on: false, holding: false, why: 'no studio root' };
  const clear = () => { if (act) { try { h.clearQuietHold(root, CHAIN_HOLD_TAG); } catch {} } };
  const min = Math.min(chainHoldMin(env), lineHoldMaxMin(env) || Infinity);
  if (!(min > 0)) { clear(); return { on: false, holding: false, why: 'STUDIO_LINE_CHAIN_HOLD_MIN=0: no chain-breaker push' }; }
  const cbs = new Map((chainBreakers || []).map((c) => [c.task, c]));
  const q = deps.trainQueue || readJson(path.join(root, '.studio', 'train', 'queue.json'), []) || [];
  const queued = (Array.isArray(q) ? q : []).filter((e) => e?.task && cbs.has(e.task) && !(e.held && !(e.released && e.released.head === e.head)));
  const atOf = (e) => { const t = typeof e.at === 'number' ? e.at : Date.parse(e.at); return Number.isFinite(t) ? t : now; };
  const live = queued.map((e) => ({ e, until: atOf(e) + min * 60000 })).filter((x) => x.until > now).sort((a, b) => b.until - a.until);
  // The hold is for the wait BEFORE the train starts: a running train needs none (it would freeze builder verifies).
  let trainRunning = false;
  if (queued.length) { try { trainRunning = deps.trainRunning !== undefined ? Boolean(deps.trainRunning) : Boolean((await import('./train-daemon.mjs')).trainLockHeld(root, env, now)); } catch { trainRunning = false; } }
  if (queued.length && trainRunning) {
    clear();
    return { on: true, holding: false, why: `the merge train is running chain-breaker ${queued.map((e) => e.task).join(', ')}: no builder verify hold while its train runs` };
  }
  if (!live.length) {
    clear();
    return { on: true, holding: false, why: queued.length ? `chain-breaker ${queued.map((e) => e.task).join(', ')} has been queued for more than ${min} min (STUDIO_LINE_CHAIN_HOLD_MIN, STUDIO_LINE_HOLD_MAX_MIN): no more hold for it` : 'no chain-breaker queued for the merge train' };
  }
  const { e, until } = live[0];
  const n = cbs.get(e.task)?.n || 0;
  const why = `chain-breaker ${e.task} (${n} task${n === 1 ? '' : 's'} wait on it) is queued for the merge train: new builder verifies wait so its train gets a quiet machine (at most ${min} min from its queueing, STUDIO_LINE_CHAIN_HOLD_MIN / STUDIO_LINE_HOLD_MAX_MIN; it ends when its train starts)`;
  if (act) {
    const rec = h.markQuietHold(root, { ms: until - now, tag: CHAIN_HOLD_TAG, owner: LINE_AGENT, task: e.task, why, now });
    if (rec && !deps.quiet) {
      const prev = readJson(path.join(LINE_DIR(), 'chain-push.json'), null);
      if (prev?.task !== e.task) {
        try { fs.mkdirSync(LINE_DIR(), { recursive: true }); fs.writeFileSync(path.join(LINE_DIR(), 'chain-push.json'), `${JSON.stringify({ task: e.task, at: new Date(now).toISOString(), until: new Date(until).toISOString() })}\n`); } catch {}
        logAction({ kind: 'chain-push', task: e.task, what: why, meta: { until: new Date(until).toISOString() } });
      }
    }
  }
  return { on: true, holding: true, task: e.task, until: new Date(until).toISOString(), why };
}

// engine twins

/**
 * The engine twins the owner listed: studio/game.json engines.<name>.twins (protected), either game path globs that have
 * a twin in that engine's slice, or { paths, role, priority, branch, lane }. Default: none.
 */
export function twinConfigs(engines = {}, labelOf = (n) => n) {
  const out = [];
  for (const [engine, cfg] of Object.entries(engines || {})) {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(engine) || !cfg || typeof cfg !== 'object') continue;
    const t = Array.isArray(cfg.twins) ? { paths: cfg.twins } : cfg.twins && typeof cfg.twins === 'object' ? cfg.twins : null;
    const paths = (Array.isArray(t?.paths) ? t.paths : []).map((p) => String(p || '').trim()).filter(Boolean);
    if (!paths.length) continue;
    out.push({ engine, label: labelOf(engine) || engine, paths, role: typeof t.role === 'string' && t.role ? t.role : 'engine-porter', priority: /^P[0-4]$/i.test(String(t.priority || '')) ? String(t.priority).toUpperCase() : 'P2', branch: typeof t.branch === 'string' && t.branch.includes('{task}') ? t.branch : `${engine}/twin-{task}`, lane: typeof t.lane === 'string' && t.lane ? t.lane : null });
  }
  return out;
}
export const twinTitle = (label, id, title) => `${label} twin of ${id}: ${String(title || '').replace(/\s+/g, ' ').slice(0, 110)}`;
const TWIN_TITLE_RE = (label) => new RegExp(`^${String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} twin of T-\\d+\\b`);

/** Files changed by the main branch's commits whose message names the task. */
export function landedFiles(root, taskId, { max = 200 } = {}) {
  const id = String(taskId || '');
  if (!/^T-\d+$/.test(id)) return [];
  const r = gitIn(root, '-c', 'core.quotePath=false', 'log', '-F', `--grep=${id}`, `-n${max}`, '--format=%H%x1f%B%x1e', 'HEAD');
  if (r.status !== 0) return [];
  const named = new RegExp(`\\b${id}\\b`);
  const files = new Set();
  for (const block of String(r.stdout || '').split('\x1e')) {
    const [sha, body] = block.trim().split('\x1f');
    if (!/^[0-9a-f]{40}$/.test(String(sha || '')) || !named.test(String(body || ''))) continue;
    const d = gitIn(root, '-c', 'core.quotePath=false', 'diff-tree', '-r', '--name-only', '--no-commit-id', '-m', '--first-parent', sha);
    for (const f of String(d.stdout || '').split('\n').map((x) => x.trim()).filter(Boolean)) files.add(f.replace(/\\/g, '/'));
  }
  return [...files].sort();
}

/**
 * A landed game task whose changed files (landedFiles) match an engine's twin paths gets ONE twin task for that engine
 * (role engine-porter or the config's, track engine:<name>, stacked --after the engine's open twins and the landed task).
 * Each task is looked at once (.studio/line/twins.json; the first pass only starts the record). act false: dry.
 * STUDIO_LINE_TWINS=off: nothing. { on, checked: [{ task, engine, need, added?, files?, why }], why }.
 */
export async function twinPass({ now = Date.now(), env = process.env, act = true, deps = {} } = {}) {
  if (/^(off|0|false|no)$/i.test(String(env.STUDIO_LINE_TWINS ?? ''))) return { on: false, checked: [], why: 'STUDIO_LINE_TWINS=off' };
  let root = deps.root || null;
  if (!root) { try { root = (await import('./worktree.mjs')).mainRoot(); } catch { return { on: false, checked: [], why: 'no studio root' }; } }
  let cfgs = [];
  try {
    const et = await import('./engine-tracks.mjs');
    cfgs = twinConfigs(deps.engines || et.enginesConfig(root), (n) => { try { return et.engineTarget(n, { root })?.label || n; } catch { return n; } });
  } catch { cfgs = []; }
  if (!cfgs.length) return { on: false, checked: [], why: 'no engine twins listed (studio/game.json engines.<name>.twins: the game paths that have an engine twin)' };
  // A native-engine studio builds a feature once, in the engine: a web task has no twin to add.
  { const ne = (await import('./native.mjs')).nativeEngine(root, env); if (ne) return { on: false, checked: [], why: `native ${ne}: features are built once, in the engine, so there are no twins of web tasks` }; }
  const f = path.join(LINE_DIR(), 'twins.json');
  const st = readJson(f, null);
  const save = (s) => { if (!act) return; try { fs.mkdirSync(LINE_DIR(), { recursive: true }); writeAtomic(f, `${JSON.stringify(s, null, 2)}\n`); } catch {} };
  if (!st || !st.since) { save({ since: new Date(now).toISOString(), seen: {} }); return { on: true, checked: [], why: 'first look: game tasks that land from now on are checked for engine twins' }; }
  const seen = st.seen && typeof st.seen === 'object' ? st.seen : {};
  const events = deps.events || readRecentEvents(20000);
  const since = Date.parse(st.since) || 0;
  const added = new Map(events.filter((e) => e.type === 'task.added' && e.task).map((e) => [e.task, e]));
  const landed = [...new Map(events.filter((e) => e.type === 'task.done' && e.task && Date.parse(e.ts) >= since && !seen[e.task]).map((e) => [e.task, e])).values()];
  const { globRe } = await import('./merge-lane.mjs');
  const board = deps.queue || (await import('./task.mjs')).parseNextQueue();
  const open = [...(board.inProgress || []), ...(board.backlog || [])];
  const checked = [];
  for (const ev of landed) {
    const id = ev.task;
    const meta = added.get(id)?.meta || {};
    const title = String(added.get(id)?.msg || ev.msg || '').replace(/^Queued T-\d+ \[[^\]]*\] \([^)]*\):\s*/, '').replace(/^Completed T-\d+:\s*/, '').replace(/\s*\(merge train [^)]*\)$/, '');
    const rows = [];
    if (/^engine:/.test(String(meta.track || '')) || meta.twinOf) {
      rows.push({ task: id, engine: null, need: false, why: 'an engine task itself' });
    } else {
      const files = deps.filesOf ? deps.filesOf(id) : landedFiles(root, id);
      for (const c of cfgs) {
        const res = c.paths.map((g) => globRe(g));
        const hit = files.filter((x) => res.some((re) => re.test(x)));
        if (!hit.length) { rows.push({ task: id, engine: c.engine, need: false, why: files.length ? `none of its ${files.length} changed file(s) has a ${c.label} twin` : `no commit naming ${id} found on the main branch` }); continue; }
        const t = twinTitle(c.label, id, title);
        const twins = open.filter((x) => TWIN_TITLE_RE(c.label).test(String(x.title || '')) && x.title !== t).map((x) => x.id);
        const row = { task: id, engine: c.engine, need: true, files: hit.slice(0, 20), why: `${hit.length} changed file(s) have a ${c.label} twin (${hit.slice(0, 3).join(', ')}${hit.length > 3 ? ', …' : ''})`, after: [id, ...twins] };
        if (act) {
          try {
            const { addTask } = deps.addTask ? { addTask: deps.addTask } : await import('./task.mjs');
            const r = addTask({ title: t, role: c.role, priority: c.priority, agent: LINE_AGENT, meta: { origin: LINE_AGENT, promoted: true, infra: true, track: `engine:${c.engine}`, twinOf: id, after: [id, ...twins], branch: c.branch.replaceAll('{task}', id.toLowerCase()), scope: `match ${id} (${title.slice(0, 80)}) in the ${c.label} slice: ${hit.slice(0, 5).join(', ')}${hit.length > 5 ? ', …' : ''}`, ...(c.lane ? { lane: c.lane } : {}) } });
            if (r?.id && !r.error) { row.added = r.id; if (r.duplicate) row.duplicate = true; logAction({ kind: 'twin', task: r.id, what: `${r.duplicate ? 'found' : 'added'} ${r.id}, the ${c.label} twin of ${id} (${row.why}), after ${row.after.join(', ')}`, meta: { twinOf: id, engine: c.engine, files: hit.slice(0, 10) } }); } else row.error = r?.message || r?.error || 'not added';
          } catch (e) { row.error = e.message; }
        }
        rows.push(row);
      }
    }
    checked.push(...rows);
    if (act && rows.every((r) => !r.error)) seen[id] = { at: new Date(now).toISOString(), twins: rows.filter((r) => r.added).map((r) => r.added) };
  }
  const keep = Object.entries(seen).sort((a, b) => String(b[1]?.at || '').localeCompare(String(a[1]?.at || ''))).slice(0, 500);
  save({ since: st.since, seen: Object.fromEntries(keep) });
  const need = checked.filter((r) => r.need);
  return { on: true, checked, why: !landed.length ? 'no game task landed since the last look' : need.length ? `${need.length} engine twin${need.length === 1 ? '' : 's'}: ${need.map((r) => `${r.added || '(would add)'} for ${r.task} (${r.engine})`).join(', ')}` : `no twin needed for ${landed.map((e) => e.task).join(', ')}` };
}

// engine trains in quiet windows

/** Should engine <x>'s train start now? Pure. f carries the queue, running state, web train, heavy jobs, free RAM and CPU. { start, wait, why }. Priority: the web train > builder verifies > Unity/art > soaks. */
export function engineWindow(f, env = process.env) {
  const L = f.label || f.engine;
  const quietPct = num(env.STUDIO_ENGINE_QUIET_CPU_PCT, 75);
  const maxWait = num(env.STUDIO_ENGINE_TRAIN_MAX_WAIT_MIN, 120);
  const waited = f.oldestAt ? Math.round(((f.now ?? Date.now()) - Date.parse(f.oldestAt)) / 60000) : 0;
  const no = (why) => ({ start: false, wait: true, why });
  if (!f.auto) return { start: false, wait: false, why: `starting the ${L} train is left to a person (STUDIO_ENGINE_TRAIN_AUTO=off or engines.${f.engine}.trainAuto false): npm run task -- train --engine ${f.engine}` };
  if (!f.queued) return { start: false, wait: false, why: `no ${L} branch queued` };
  if (f.running) return { start: false, wait: false, why: `the ${L} train is running` };
  if (f.startedRecently) return { start: false, wait: false, why: `started it ${f.startedRecently} min ago` };
  // The engine's own slot (STUDIO_ENGINE_SLOTS, heavy.mjs engineSlotsAt): the train starts when that slot is free, whatever
  // the game's trains and verifies are doing. Free RAM and CPU are the land's own heavy wait. The quiet window below is
  // kept for an engine with "window": "quiet" in its config, or STUDIO_ENGINE_WINDOW=quiet, and when STUDIO_ENGINE_SLOTS=off.
  if (f.engineSlots > 0 && f.window !== 'quiet' && !/^quiet$/i.test(String(env.STUDIO_ENGINE_WINDOW || ''))) {
    if (!f.slotFree) return no(`the ${L} slot is taken (${(f.engineHolders || []).slice(0, 2).join(', ') || 'another engine land'}; STUDIO_ENGINE_SLOTS ${f.engineSlots})`);
    return { start: true, wait: false, why: `the ${L} slot is free (STUDIO_ENGINE_SLOTS ${f.engineSlots}): game trains and verifies don't take it${f.webTrain ? ' (a web train is running beside it)' : ''}; one land run ~${f.expectedMin ?? '?'} min` };
  }
  if (f.webTrain) return no('the web train is running (its verify goes first: train > builder verifies > engine > soaks)');
  const sameKind = (f.heavy || []).filter((h) => (f.heavyKind === 'unity' ? /unity/i.test(`${h.kind || ''}`) : false) || /\btrain\b/i.test(`${h.kind || ''}`));
  if (sameKind.length) return no(`machine:heavy holds ${sameKind.map((h) => h.label || h.kind).slice(0, 2).join(', ')}`);
  if (Number.isFinite(f.freeGb) && f.floorGb > 0 && f.freeGb < f.floorGb) return no(`free RAM ${f.freeGb} GB is under the ${L} floor ${f.floorGb} GB (${f.floorFrom})`);
  if (Number.isFinite(f.cpuBusy) && f.cpuBusy * 100 >= quietPct) return no(`CPU ${Math.round(f.cpuBusy * 100)}% busy (STUDIO_ENGINE_QUIET_CPU_PCT ${quietPct})`);
  if (f.webQueued > 0 && waited < maxWait) return no(`${f.webQueued} web lane(s) wait for the web train, which goes first (the ${L} queue waited ${waited} of ${maxWait} min: STUDIO_ENGINE_TRAIN_MAX_WAIT_MIN)`);
  return { start: true, wait: false, why: `quiet window: no web train${f.webQueued ? ` (the ${L} queue waited ${waited} min, past ${maxWait})` : ''}, ${Number.isFinite(f.freeGb) ? `${f.freeGb} GB free (floor ${f.floorGb} GB)` : 'free RAM unknown (the train waits for its floor)'}${Number.isFinite(f.cpuBusy) ? `, CPU ${Math.round(f.cpuBusy * 100)}%` : ''}; one land run ~${f.expectedMin ?? '?'} min` };
}

const ENGINE_STARTS = () => path.join(LINE_DIR(), 'engine-trains.json');
const ENGINE_BATCH = () => path.join(LINE_DIR(), 'engine-batch.json');
const ENGINE_AUTO_TOLD = () => path.join(LINE_DIR(), 'engine-auto-told.json');

/**
 * The engine train's batch window, like the game train's (STUDIO_TRAIN_MIN / STUDIO_TRAIN_WAIT_MIN): engines.<x>.batchMin
 * (1: start as soon as one branch waits) and engines.<x>.batchWaitMin (0: never wait); the env STUDIO_ENGINE_BATCH_MIN and
 * STUDIO_ENGINE_BATCH_WAIT_MIN win. { min, waitMin }.
 */
export function engineBatchRules(cfg = {}, env = process.env) {
  const pick = (k, v, d) => { for (const x of [env[k], v]) { const t = String(x ?? '').trim(); if (t !== '' && Number.isFinite(Number(t)) && Number(t) >= 0) return Number(t); } return d; };
  return { min: Math.max(1, Math.floor(pick('STUDIO_ENGINE_BATCH_MIN', cfg?.batchMin, 1))), waitMin: pick('STUDIO_ENGINE_BATCH_WAIT_MIN', cfg?.batchWaitMin, 0) };
}

/**
 * Should the automatic start of engine <x>'s train wait for more branches? Pure. f: { engine, label, queue: [{ task, at,
 * alone? }], rules: { min, waitMin }, working: [task ids of sessions on this engine's track, branch not queued], now }.
 * { wait, why, counted, waitedMin, left }. Waits only while fewer than min branches are queued (a branch that lands alone
 * does not count), the oldest has waited under waitMin minutes, and a session still works on an engine task.
 */
export function engineBatchWait(f) {
  const L = f.label || f.engine;
  const q = Array.isArray(f.queue) ? f.queue : [];
  const rules = f.rules || { min: 1, waitMin: 0 };
  const now = f.now ?? Date.now();
  const counted = q.filter((e) => !e?.alone).length;
  const oldest = Math.min(...q.map((e) => Date.parse(e?.at) || now), now);
  const waitedMin = Math.max(0, (now - oldest) / 60000);
  const base = { wait: false, counted, waitedMin: Math.round(waitedMin * 10) / 10, left: 0 };
  if (!q.length) return { ...base, why: `no ${L} branch queued` };
  if (q[0]?.alone) return { ...base, why: `${q[0].task} lands alone at the head of the ${L} queue: no batch to wait for` };
  if (rules.min <= 1 || rules.waitMin <= 0) return { ...base, why: 'no batch window (batchMin 1 or batchWaitMin 0)' };
  if (counted >= rules.min) return { ...base, why: `${counted} of ${rules.min} ${L} branches queued: the batch is full` };
  if (waitedMin >= rules.waitMin) return { ...base, why: `the oldest ${L} branch has waited ${Math.round(waitedMin)} min, the batch window's ${rules.waitMin}: starting with ${counted} of ${rules.min}` };
  const working = Array.isArray(f.working) ? f.working : [];
  if (!working.length) return { ...base, why: `${counted} of ${rules.min} ${L} branches queued, and no session is working on a ${L} task: nothing more is coming` };
  const left = Math.max(1, Math.ceil(rules.waitMin - waitedMin));
  return { ...base, wait: true, left, why: `waiting up to ${rules.waitMin} min for more ${L} branches: ${counted} of ${rules.min} queued, the oldest for ${Math.round(waitedMin)} min, ${working.length} session${working.length === 1 ? '' : 's'} still working on ${L} tasks (${working.slice(0, 4).join(', ')}); ${left} min left` };
}

/** One look at every engine train: [{ engine, queued, running, expectedMin, floorGb, start, why, started? }]. Starts those whose window is open (unless dryRun or report mode). deps: rig, rigBudget, machine, root, startTrain(engine) -> { pid }. */
export async function enginePass({ now = Date.now(), env = process.env, dryRun = false, rig = null, deps = {} } = {}) {
  const et = await import('./engine-tracks.mjs');
  const ut = await import('./unity-train.mjs');
  const { mainRoot } = await import('./worktree.mjs');
  const root = deps.root || mainRoot();
  const targets = et.engineTargets({ root }).filter((t) => t.land);
  if (!targets.length) return [];
  let rb = null;
  try { rb = deps.rigBudget ? await deps.rigBudget() : await (await import('./rig-budget.mjs')).rigBudget({ env, now }); } catch { rb = null; }
  let cpuBusy = null;
  try { const prof = deps.machine !== undefined ? deps.machine : (await import('./heavy-budget.mjs')).machineProfile(root, { env, now }); cpuBusy = Number.isFinite(prof?.cpu?.busy) ? prof.cpu.busy : null; } catch {}
  const heavy = (rb?.running || rig?.heavy || []).map((h) => ({ kind: h.kind, label: h.label }));
  let webTrain = Boolean(rig?.train?.running);
  try { if (!webTrain && !deps.rig) webTrain = Boolean((await import('./train-daemon.mjs')).trainLockHeld(root, env, now)); } catch {}
  if (deps.webTrain !== undefined) webTrain = deps.webTrain;
  const webQ = (readJson(path.join(root, '.studio', 'train', 'queue.json'), []) || []).filter((e) => e?.task && !(e.held && !(e.released && e.released.head === e.head)));
  const starts = readJson(ENGINE_STARTS(), {}) || {};
  // The batch window: the running sessions (who may still queue a branch) and the waits already announced.
  let liveSessions = null;
  const sessionsNow = async () => {
    if (liveSessions) return liveSessions;
    try { liveSessions = (deps.sessions ? await deps.sessions() : (await import('./agent.mjs')).sessions()).filter((x) => x && x.running && x.task); } catch { liveSessions = []; }
    return liveSessions;
  };
  const batchState = readJson(ENGINE_BATCH(), {}) || {};
  let batchChanged = false;
  const autoOn = !/^(off|0|false|no)$/i.test(String(env.STUDIO_ENGINE_TRAIN_AUTO ?? ''));
  const acting = !dryRun && lineMode(env) === 'on';
  const ctl = await import('./engine-train-control.mjs');
  const told = readJson(ENGINE_AUTO_TOLD(), {}) || {};
  let toldChanged = false;
  const out = [];
  for (const t of targets) {
    // The automatic start takes untagged lanes only: a tagged lane waits for train --engine <x> --tag <tag>.
    const qAll = ut.readUnityQueue(root, t.name);
    const q = qAll.filter((e) => !e?.tag);
    const taggedN = qAll.length - q.length;
    // `train auto off --engine <x>` (.studio/train/<x>-auto.json; --hours runs out by itself).
    const ea = ctl.engineAutoState(root, t.name, { env, now });
    if (ea.expired && acting) {
      try { fs.rmSync(ctl.autoFile(root, t.name), { force: true }); } catch {}
      try { emitEvent({ type: `task.train.${t.name}.auto_on`, agent: LINE_AGENT, to: 'producer', track: `engine:${t.name}`, msg: `Line Producer: the ${t.label} train's automatic start is on again: the off by ${ea.expired.by || '?'} ran out at ${String(ea.expired.until).slice(0, 16)} UTC`, meta: { engine: t.name, expired: true, by: ea.expired.by || null } }); } catch {}
    }
    const running = ut.runningUnityTrain(root, t.name);
    const floor = et.engineFloor(t.name, { env, root });
    const exp = et.expectedMinutes(t.name, { root });
    const last = starts[t.name];
    const since = last ? Math.round((now - Date.parse(last.at)) / 60000) : null;
    const f = { engine: t.name, label: t.label, heavyKind: t.heavyKind, queued: q.length, oldestAt: q[0]?.at || null, running: Boolean(running), startedRecently: since !== null && since < num(env.STUDIO_ENGINE_TRAIN_COOLDOWN_MIN, 3) ? Math.max(0, since) : 0, auto: autoOn && t.trainAuto && (ea.on || ea.source !== 'file'), webTrain, webQueued: webQ.length, heavy, freeGb: Number.isFinite(rb?.freeGb) ? rb.freeGb : Number.isFinite(rig?.freeRamGb) ? rig.freeRamGb : null, floorGb: floor.gb, floorFrom: floor.from, cpuBusy, expectedMin: exp.minutes, now };
    try {
      const hv = await import('./heavy.mjs');
      f.engineSlots = hv.engineSlotsAt(root, env);
      const mine = hv.heavyHolders(root, { env }).filter((h) => h?.claim?.engine);
      f.engineHolders = mine.map((h) => h.label || 'an engine land');
      f.slotFree = mine.length < f.engineSlots;
    } catch { f.engineSlots = 0; }
    f.window = t.cfg?.window === 'quiet' ? 'quiet' : 'slot';
    const w = engineWindow(f, env);
    if (autoOn && t.trainAuto && !ea.on && ea.source === 'file') {
      w.start = false; w.wait = false; w.why = ctl.autoOffWhy(ea, t.name);
      const last = Date.parse(told[t.name] || '');
      if (acting && (q.length || taggedN) && (!Number.isFinite(last) || now - last >= 3600000)) {
        told[t.name] = new Date(now).toISOString(); toldChanged = true;
        try { emitEvent({ type: `task.train.${t.name}.auto_off`, agent: LINE_AGENT, to: 'producer', track: `engine:${t.name}`, status: 'warn', msg: `Line Producer: ${qAll.length} ${t.label} branch(es) queued, none started: ${w.why}`.slice(0, 600), meta: { engine: t.name, queued: qAll.length, by: ea.by, until: ea.until || null, reminder: true } }); } catch {}
      }
    } else if (!q.length && taggedN && w.why === `no ${t.label} branch queued`) {
      const tc = ctl.tagCounts(qAll);
      w.why = `no untagged ${t.label} branch queued; ${taggedN} tagged lane(s) wait (${Object.entries(tc).map(([k, v]) => `${k} ${v}`).join(', ')}): the automatic start takes untagged lanes only, npm run task -- train --engine ${t.name} --tag <tag> lands them`;
    }
    // The batch window applies only to this automatic start (a person's `task train --engine <x>` starts at once).
    const br = engineBatchRules(t.cfg, env);
    let batchWaiting = false;
    if (w.start && br.min > 1 && br.waitMin > 0) {
      const queuedTasks = new Set(q.map((e) => e.task));
      const working = [];
      if (!q[0]?.alone) {
        for (const x of await sessionsNow()) {
          if (queuedTasks.has(x.task) || working.includes(x.task)) continue;
          let rec = null;
          try { rec = deps.engineTask ? deps.engineTask(x.task) : et.engineTask(x.task, { root, env }); } catch { rec = null; }
          if (rec?.engine === t.name) working.push(x.task);
        }
      }
      const bw = engineBatchWait({ engine: t.name, label: t.label, queue: q, rules: br, working, now });
      if (bw.wait) {
        w.start = false; w.wait = true; w.why = bw.why; batchWaiting = true;
        const prev = batchState[t.name];
        if (!prev || prev.oldestAt !== (q[0]?.at || null)) {
          if (acting) {
            batchState[t.name] = { since: new Date(now).toISOString(), oldestAt: q[0]?.at || null };
            batchChanged = true;
            try { emitEvent({ type: `task.train.${t.name}.batch_wait`, agent: LINE_AGENT, track: `engine:${t.name}`, msg: `Line Producer: ${bw.why}`.slice(0, 500), meta: { engine: t.name, queued: q.length, counted: bw.counted, batchMin: br.min, batchWaitMin: br.waitMin, waitedMin: bw.waitedMin, working: working.slice(0, 10), tasks: q.map((e) => e.task) } }); } catch {}
          }
        }
      } else if (batchState[t.name]) { delete batchState[t.name]; batchChanged = true; }
    } else if (batchState[t.name] && !w.wait) { delete batchState[t.name]; batchChanged = true; }
    const row = { engine: t.name, queued: q.length, ...(taggedN ? { tagged: taggedN } : {}), ...(!ea.on && ea.source === 'file' ? { autoOff: true } : {}), running: Boolean(running), expectedMin: exp.minutes, expectedFrom: exp.from, floorGb: floor.gb, start: w.start, why: w.why, ...(batchWaiting ? { batchWait: true } : {}) };
    if (w.start && acting) {
      try {
        const r = deps.startTrain ? await deps.startTrain(t.name) : startEngineTrain(root, t.name, env);
        row.started = true;
        row.pid = r?.pid || null;
        starts[t.name] = { at: new Date(now).toISOString(), pid: row.pid };
        fs.mkdirSync(LINE_DIR(), { recursive: true });
        fs.writeFileSync(ENGINE_STARTS(), `${JSON.stringify(starts, null, 2)}\n`);
        logAction({ kind: 'engine-train', what: `started the ${t.label} train (${q.length} branch(es): ${q.map((e) => e.task).join(', ')}): ${w.why}`, meta: { engine: t.name, tasks: q.map((e) => e.task), expectedMin: exp.minutes } });
      } catch (e) { row.started = false; row.why = `${w.why}; could not start it: ${e.message}`; }
    }
    out.push(row);
  }
  if (toldChanged && acting) { try { fs.mkdirSync(LINE_DIR(), { recursive: true }); fs.writeFileSync(ENGINE_AUTO_TOLD(), `${JSON.stringify(told, null, 2)}\n`); } catch { /* a second event at worst */ } }
  if (batchChanged && acting) { try { fs.mkdirSync(LINE_DIR(), { recursive: true }); fs.writeFileSync(ENGINE_BATCH(), `${JSON.stringify(batchState, null, 2)}\n`); } catch { /* a second event at worst */ } }
  return out;
}

/** `node harness/task.mjs train --engine <x> --by line-producer`, detached, its output in .studio/line/<x>-train.log. */
export function startEngineTrain(root, engine, env = process.env) {
  fs.mkdirSync(LINE_DIR(), { recursive: true });
  const fd = fs.openSync(path.join(LINE_DIR(), `${engine}-train.log`), 'a');
  const child = spawn(process.execPath, [path.join(root, 'harness', 'task.mjs'), 'train', '--engine', engine, '--by', LINE_AGENT], { cwd: root, env: { ...env, STUDIO_LOCK_OWNER: LINE_AGENT }, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  child.unref();
  try { fs.closeSync(fd); } catch {}
  return { pid: child.pid };
}

export const readLineStatus = () => readJson(LINE_STATUS_FILE(), null);
/** The status the Communicator posts: the last pass's, or a dry pass when there is none (or fresh: true). */
export async function lineStatus({ fresh = false, env = process.env } = {}) {
  const s = fresh ? null : readLineStatus();
  return s || lineProducerPass({ dryRun: true, env });
}

/** The supervisor's half: the plan to follow, or null (off, report, an error, or older than STUDIO_LINE_PLAN_MAX_SEC (300)). { order: Map(id -> rank), routes, rigCap, cbs }. */
export function supervisorPlan({ now = Date.now(), env = process.env } = {}) {
  if (lineMode(env) !== 'on') return null;
  const s = readLineStatus();
  if (!s || s.mode !== 'on' || s.error || s.dryRun || !Array.isArray(s.order)) return null;
  if (now - Date.parse(s.at) > num(env.STUDIO_LINE_PLAN_MAX_SEC, 300) * 1000) return null;
  return { order: new Map(s.order.map((id, i) => [id, i])), routes: s.routes || {}, hold: new Map((s.protectedSteps || []).filter((p) => p.hold).map((p) => [p.task, p.why])), rigCap: Number.isFinite(s.builders?.rigCap) ? s.builders.rigCap : null, rigWhy: s.builders?.why || '', cbs: new Set((s.chainBreakers || []).map((c) => c.task)), skip: new Set(Array.isArray(s.skip) ? s.skip : []) };
}
/** Sorts the supervisor's groups and their tasks by the plan's order; unlisted tasks keep their place after. */
export function orderGroups(groups, plan) {
  if (!plan) return groups;
  // Tasks the plan skips (no lane, other work can run) are not started this pass; a group with nothing left drops out.
  if (plan.skip?.size) groups = groups.map((g) => (g.tasks.some((t) => plan.skip.has(t.id)) ? { ...g, tasks: g.tasks.filter((t) => !plan.skip.has(t.id)) } : g)).filter((g) => g.tasks.length);
  const rank = (id) => (plan.order.has(id) ? plan.order.get(id) : 1e6);
  for (const g of groups) g.tasks = g.tasks.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t.id) - rank(b.t.id) || a.i - b.i).map((x) => x.t);
  return groups.map((g, i) => ({ g, i })).sort((a, b) => (a.g.role === 'dev-hacker') - (b.g.role === 'dev-hacker') || rank(a.g.tasks[0]?.id) - rank(b.g.tasks[0]?.id) || a.i - b.i).map((x) => x.g);
}

// the CLI

export function statusText(s) {
  if (!s) return 'Line Producer: no pass yet.';
  if (s.off) return `Line Producer: off (${s.why}).`;
  if (s.error) return `Line Producer: the pass failed (${s.error}).`;
  const L = [`Line Producer (${s.mode}${s.dryRun ? ', dry pass' : ''}, ${String(s.at).slice(0, 16).replace('T', ' ')}): builders ${s.builders.running} running, target ${s.builders.target}: ${s.builders.why}.`];
  const r = s.rig || {};
  L.push(`Rig (${r.source || '?'}): ${r.known ? `${Number.isFinite(r.cpuBusy) ? `CPU ${Math.round(r.cpuBusy * 100)}%, ` : ''}${r.freeRamGb ?? '?'} GB free, ${r.claimedGb ?? 0} GB claimed by heavy jobs` : r.why}${r.train?.running ? '; a train is running' : ''}${r.heavy?.length ? `; heavy jobs (train > verifies > Unity/art > soaks): ${r.heavy.map((h) => `${h.label || h.kind}${h.ramGb ? ` ${h.ramGb} GB` : ''}`).join(', ')}` : ''}.`);
  if (s.chainBreakers?.length) L.push(`Chain-breakers (first, strongest model): ${s.chainBreakers.map((c) => `${c.task} (${c.n} wait${c.state === 'blocked' ? `; blocked: ${c.why}` : `; ${c.state}`})`).join('; ')}.`);
  L.push(`Order: ${s.order?.length ? s.order.slice(0, 8).map((id) => `${id}${s.routes?.[id]?.model ? ` (${s.routes[id].model})` : ''}`).join(', ') : 'nothing ready'}${s.order?.length > 8 ? ` (+${s.order.length - 8})` : ''}.`);
  const e = s.expansion || {};
  L.push(`Expansion: ${e.slots} slot(s) at share ${e.share}, ${e.running} running, ${e.open} open (${['1', '2', '3'].map((p) => `${e.byPhase?.[p]?.label} ${e.byPhase?.[p]?.open}`).join(', ')}${e.byPhase?.unphased?.open ? `, unphased ${e.byPhase.unphased.open}` : ''})${e.sliceOpen ? `; Director slice open: ${e.sliceOpen}` : ''}${e.sliceFiled ? `; asked the Director: ${e.sliceFiled}` : ''}.`);
  if (s.blocked?.length) { L.push('Blocked:'); for (const b of s.blocked.slice(0, 12)) L.push(`  ${b.task} [${b.kind}] ${b.why}${b.fix ? ` -> ${b.fix}` : ''}`); if (s.blocked.length > 12) L.push(`  … and ${s.blocked.length - 12} more (npm run line -- status --json)`); }
  if (s.models?.on) L.push(`Model pools (npm run models -- status): ${Object.entries(s.models.pools || {}).map(([k, v]) => `${k} ${v.out ? 'out' : v.near ? `near (${v.usedPct}%)` : `${v.usedPct}%`}`).join(', ')}.`);
  if (s.protectedSteps?.length) L.push(`Protected steps: ${s.protectedSteps.map((p) => `${p.task} -> ${p.actor || 'the owner'}${p.hold ? ' (held)' : ''}`).join('; ')}.`);
  if (s.lanes && !s.lanes.error) L.push(...laneLinesOf(s.lanes));
  if (s.reasons?.length) L.push(`For the Producer (this plan can't run because): ${s.reasons.join('; ')}.`);
  if (s.fixed?.length) L.push(`Fixed this pass: ${s.fixed.map((a) => a.what).join('; ')}.`);
  if (s.actions?.length) L.push(`Last actions: ${s.actions.slice(-5).map((a) => `${String(a.at).slice(11, 16)} ${a.what}`).join('; ')}.`);
  return L.join('\n');
}

/** The lane lines (harness/lane-plan.mjs laneLines' words; inline so the CLI never fails on an import). */
export function laneLinesOf(l) {
  const L = [];
  if (l.set?.length) L.push(`Lanes ${l.set.some((x) => x.dry) ? 'it would set' : 'set'} (for the Producer): ${l.set.map((x) => `${x.task} -> ${x.lane} (from ${(x.from || []).join(', ')})`).join('; ')}.`);
  if (l.unscoped?.length) L.push(`Unscoped (no lane could be worked out; each holds the whole game): ${l.unscoped.map((u) => u.task).join(', ')} -> npm run task -- lane <ID> <folders> --by <you>.`);
  if (l.running?.length) L.push(`Running with no lane (holds the whole game until it ends): ${l.running.map((u) => u.task).join(', ')} -> npm run task -- lane <ID> <folders> --by <you>.`);
  if (l.stacked?.length) L.push(`Stacked on shared sim code (${l.shared?.from || 'shared sim globs'}): ${l.stacked.map((x) => `${x.task} after ${x.after} (${(x.via || []).slice(0, 2).join(', ')})${x.dry ? ', would' : ''}`).join('; ')}.`);
  return L;
}

export function whyText(s, id) {
  if (!s || s.error || s.off) return statusText(s);
  const b = (s.blocked || []).find((x) => x.task === id && x.kind !== 'unscoped');
  const unscoped = (s.blocked || []).find((x) => x.task === id && x.kind === 'unscoped');
  const cb = (s.chainBreakers || []).find((c) => c.task === id);
  const rank = (s.order || []).indexOf(id);
  const route = s.routes?.[id];
  const L = [];
  if (b) L.push(`${id} can't start: [${b.kind}] ${b.why}.${b.fix ? ` Fix: ${b.fix}.` : ''}`);
  else if (rank >= 0) L.push(`${id} is ready: number ${rank + 1} in the Line Producer's order${rank + 1 > Math.max(0, s.builders.target - s.builders.running) ? ` (${s.builders.target - s.builders.running} builder slot(s) free now: ${s.builders.why})` : ''}.`);
  else L.push(`${id} isn't waiting: it is running, done, a person's task, or not on the board.`);
  if (unscoped) L.push(`It is unscoped: ${unscoped.why}. Fix: ${unscoped.fix}.`);
  if (cb) L.push(`It is a chain-breaker: ${cb.n} task(s) wait on it (${cb.waiting.join(', ')}).`);
  if (route) L.push(`Model: ${route.why}.`);
  return L.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'status';
  const json = argv.includes('--json');
  if (argv.includes('--help') || argv.includes('-h') || !['status', 'plan', 'why', 'pass'].includes(cmd)) {
    console.log('Usage: npm run line -- status [--json] | plan [--json] | why <T-ID>');
    process.exit(cmd === 'help' || argv.includes('--help') || argv.includes('-h') ? 0 : 1);
  }
  let s;
  if (cmd === 'pass') s = await lineProducerPass({});
  else if (cmd === 'status') s = await lineStatus({});
  else s = await lineProducerPass({ dryRun: true });
  if (cmd === 'why') {
    const id = argv[1];
    if (!id) { console.error('Usage: npm run line -- why <T-ID>'); process.exit(1); }
    console.log(json ? JSON.stringify({ task: id, blocked: (s.blocked || []).find((b) => b.task === id) || null, rank: (s.order || []).indexOf(id), route: s.routes?.[id] || null, chainBreaker: (s.chainBreakers || []).find((c) => c.task === id) || null }) : whyText(s, id));
    process.exit(0);
  }
  console.log(json ? JSON.stringify(s, null, 2) : statusText(s));
  process.exit(0);
}
