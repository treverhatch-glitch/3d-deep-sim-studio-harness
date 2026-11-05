#!/usr/bin/env node
/**
 * harness/line-producer.mjs — 2.76.0 (k): the Line Producer, the studio's flow desk. Code on the supervisor's loop, no
 * model and no tokens for the routine part.
 *
 * The owner's words: "add the line producer with the logic of keeping things running and watching the rigs available
 * resources and handing out tasks based on priority and free resources as well (also considering additional research,
 * building out the game with early, mid, late game in mind, and working with and through the director and planning with
 * the producer etc.)". Chain of command (studio/roles/line-producer.md): the Director owns creative direction and turns
 * it into a ranked, sized plan; the Producer approves it against the Bible; the Line Producer executes it: it orders
 * the launches, routes the models, watches the machine, unblocks what is mechanical and reports up. It never changes
 * direction: a plan that can't run becomes one Producer note ("this plan can't run because …").
 *
 * Each supervisor pass (lineProducerPass, before the supervisor picks what to start):
 *   a. builders: how many the rig can carry now (the rig budget: harness/rig-budget.mjs rigBudget() when it is there,
 *      else the machine scan and the heavy claims of harness/heavy-budget.mjs; STUDIO_LINE_RIG=heavy forces the
 *      second), against the pace's builder count. It only ever lowers the supervisor's starts (a full machine), never
 *      raises them past the pace's caps;
 *   b. why each waiting task can't start (trunk, chain, park, cooldown, budget, lock, busy, merge, waiting on a yes,
 *      held), and the mechanical fixes it makes itself, logged (.studio/line/actions.jsonl, line.fixed events): a lock
 *      whose holder's session is over, a lane copy queued for the train that is gone while its branch is still there
 *      (recreated from the branch), a cooldown, block or park whose time has passed (cleared);
 *   c. chain-breakers (a task STUDIO_LINE_CHAIN_MIN (3) or more open tasks wait on) start first, on the strongest model;
 *   d. a model per task by size (2.73 routing's tiers: harness/routing.mjs tierModels, else STUDIO_TIER_<TIER>_MODEL):
 *      size 1-2 cheap, 3 (or none) mid, 4-5 and chain-breakers top, one tier up per red round; a task already started
 *      keeps its model (never mid-task) and a rescue keeps the rescue model;
 *   e. a share of the builders (STUDIO_LINE_EXPANSION_SHARE, default 1/6: round(N × share) slots) on research and
 *      expansion work, balanced across the Bible's phases (1 early, 2 mid, 3 late); when fewer than
 *      STUDIO_LINE_EXPANSION_MIN (2) such tasks are open it files ONE "Director: next ranked slice for phase <n>" task
 *      (never two open);
 *   f. one Producer note (.studio/line/producer-note.md, a line.plan_blocked event when its reasons change) when the plan
 *      can't run;
 *   g. 2.77.0 (o): remote workers (harness/remote-workers.mjs): when the local builders are at their target, the
 *      remote-eligible ready tasks are offered to remote (cloud) workers (status "remote", `line -- plan`); with
 *      STUDIO_REMOTE=on the pass also ends leases that ran out and starts a background fetch of remote/* when due.
 *   h. 2.77.0 (u, P5.2/P5.3): each engine train (harness/unity-train.mjs, any engine target of harness/engine-tracks.mjs)
 *      with branches queued is started in a quiet window (enginePass/engineWindow): no web train running (train >
 *      builder verifies > engine > soaks), no other job of the same heavy kind, free RAM at or over the engine's floor,
 *      CPU under STUDIO_ENGINE_QUIET_CPU_PCT (75), and no web lane queued unless the engine queue waited
 *      STUDIO_ENGINE_TRAIN_MAX_WAIT_MIN (120). It runs `task train --engine <x>` detached; the train itself still takes
 *      machine:heavy with the RAM floor, and an infrastructure abort stays NOT RUN (2.73.2). STUDIO_ENGINE_TRAIN_AUTO=off
 *      (or engines.<x>.trainAuto false) leaves starting it to a person.
 * It writes .studio/line/status.json (lineStatus(): what the Communicator posts and the supervisor reads for its order).
 *
 * STUDIO_LINE_PRODUCER: on (default) | report (status only: no fixes, no task filed, the supervisor ignores the plan) |
 * off. Beta mode: its own fixes are routine harness housekeeping, never an owner decision; what needs the owner (a yes,
 * an unpark, an unhold) is only reported, naming who may act (harness/delegation.mjs delegationFor; beta mode's agents).
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
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
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

/** Research or expansion work: a research/study/idea task, an engine track, meta.expansion, or a Research:/Expansion: title. */
export function isExpansion(t, meta = {}, type = '') {
  if (!t || t.role === 'human' || t.role === 'producer' || t.role === 'director' || SLICE_TITLE.test(t.title || '')) return false;
  if (meta.expansion || meta.slice) return true;
  if (['research', 'study', 'idea'].includes(String(type || meta.type || '').toLowerCase())) return true;
  if (/^engine(:|$)/i.test(String(meta.track || ''))) return true;
  return /^(research|expansion|explore)\b\s*[:—–-]/i.test(String(t.title || ''));
}

/**
 * Tasks STUDIO_LINE_CHAIN_MIN (3) or more open tasks wait on (directly or down a chain of --after): [{ task, waiting,
 * n }], most first. `open` the open tasks, `holds` studio/task-holds.json's map, `done` the done ids.
 */
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

/** The tier a task's size gives: 1-2 cheap, 3 mid, 4-5 top; no size: chore/docs/test cheap, else mid. */
export function sizeTier(meta = {}, type = '') {
  const s = Number(meta.size);
  if (Number.isFinite(s) && s > 0) return s <= 2 ? 'cheap' : s >= 4 ? 'top' : 'mid';
  return ['chore', 'docs', 'test'].includes(String(type || '').toLowerCase()) ? 'cheap' : 'mid';
}

/**
 * The route for one task: { tier, model, why }. model null: the launcher keeps its own choice (no model listed for the
 * tier, a rescue, a task that already started and hasn't failed since). models: { cheap, mid, top } (only those set).
 */
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

/**
 * 2.77.0 (n): the route by model pool (harness/model-pools.mjs pickPool): Gemini first (Flash small, Argon normal),
 * Claude for hard work, chain-breakers and after a Gemini failure, quota-aware. { tier (the size class), model, tool,
 * pool, why }; model null: the launcher's default. A rescue keeps the rescue model.
 */
export function poolRoute(t, { chainBreaker = false, pools }) {
  if (/^Rescue:/i.test(String(t.title || ''))) return { tier: null, model: null, why: 'a rescue: the rescue model starts it' };
  const r = pickPoolFn(pools)({ size: t.size || 'normal', chainBreaker, failed: t.poolFailed ?? t.failed ?? 0, lastFailedPool: t.lastFailedPool || null, protectedHeavy: Boolean(t.protectedHeavy), startedOn: t.started && t.state !== 'running' ? t.startedOn || null : null }, pools);
  return { tier: r.size, model: r.model, ...(r.tool ? { tool: r.tool } : {}), ...(r.pool ? { pool: r.pool } : {}), why: r.why };
}
let pickPoolImpl = null;
const pickPoolFn = (pools) => pools.pickPool || pickPoolImpl;

/**
 * The plan from plain data (pure, testable). facts: { now, tasks: [{ id, title, role, priority, meta, type, state:
 * 'ready'|'running'|'blocked', block: { kind, why, fix, mechanical? }, failed, started }], holds, done (Set), sessions:
 * [{ role, task, running }], pace: { maxAgents, perRole, label }, rig: { known, byRam, cpuBusy, cpuHold, why },
 * models, share, chainMin, expansionMin, sliceOpen: { id, title } | null, extraBlocked: [] }.
 */
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
  const target = rigCap === null ? paceCap : Math.min(paceCap, rigCap);
  const readyB = tasks.filter((t) => t.state === 'ready' && t.role === 'builder');
  const blocked = tasks.filter((t) => t.state === 'blocked').map((t) => ({ task: t.id, role: t.role, kind: t.block.kind, why: t.block.why, fix: t.block.fix || '', ...(t.block.mechanical ? { mechanical: true } : {}), ...(t.block.fixed ? { fixed: t.block.fixed } : {}) }));
  for (const b of f.extraBlocked || []) blocked.push(b);
  // 2.78.1 (B-123): a ready builder task with no lane runs, but alone: it is listed as "unscoped" for the Producer.
  for (const u of f.lanes?.unscoped || []) blocked.push({ task: u.task, role: 'builder', kind: 'unscoped', why: u.why, fix: u.fix, runsAlone: true });
  blocked.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.task.localeCompare(b.task));
  const kinds = {};
  for (const b of blocked) kinds[b.kind] = (kinds[b.kind] || 0) + 1;
  // Expansion share, balanced across the phases.
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
  // Order: chain-breakers, then the expansion share (lowest-covered phase first), then priority and board order.
  const ready = tasks.filter((t) => t.state === 'ready');
  const boardIdx = new Map(tasks.map((t, i) => [t.id, i]));
  const order = [];
  const take = (t) => { if (t && !order.includes(t.id)) order.push(t.id); };
  for (const c of cbs) take(ready.find((t) => t.id === c.task));
  const expNeed = Math.max(0, slots - runningExp.length);
  if (expNeed) {
    const phaseRank = (t) => { const p = pk(t); return p === 'unphased' ? 9 : byPhase[p].running + (p === lowPhase ? -1 : 0); };
    ready.filter((t) => exp.includes(t)).sort((a, b) => phaseRank(a) - phaseRank(b) || PRI(a.priority) - PRI(b.priority) || boardIdx.get(a.id) - boardIdx.get(b.id)).slice(0, expNeed).forEach(take);
  }
  ready.slice().sort((a, b) => PRI(a.priority) - PRI(b.priority) || boardIdx.get(a.id) - boardIdx.get(b.id)).forEach(take);
  const routes = {};
  for (const t of tasks.filter((x) => x.state !== 'blocked' || cbSet.has(x.id))) routes[t.id] = f.pools ? poolRoute(t, { chainBreaker: cbSet.has(t.id), pools: f.pools }) : routeTask(t, { meta: t.meta || {}, type: t.type, chainBreaker: cbSet.has(t.id), failed: t.failed || 0, started: Boolean(t.started), models: f.models || {} });
  // Plans that can't run: for the Producer.
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
  for (const d of f.dangling || []) reasons.push(`${d.task} waits for ${d.on}, which isn't on the board: the chain can't finish`);
  if (blocked.some((b) => b.kind === 'trunk')) reasons.push('the trunk is red: only fix tasks start until it is green');
  const why = [`pace ${f.pace?.label || '?'} allows ${paceCap} builder${paceCap === 1 ? '' : 's'}`, rigCap === null ? rigWhy : `rig: ${rigWhy}`, `${builders.length} running`, `${readyB.length} ready`, blocked.length ? `${blocked.length} blocked (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')})` : null].filter(Boolean).join('; ');
  // 2.77.0 (o): remote (cloud) workers: remote-eligible ready tasks offered when the local builders are at their target.
  let remote = null;
  if (f.remote && f.remote.remotePlan) remote = f.remote.remotePlan(f.remote, { order, target, running: builders.length, roleOf: (id) => byTask.get(id)?.role });
  return {
    builders: { running: builders.length, target, paceCap, rigCap, ready: readyB.length, why },
    ...(remote ? { remote } : {}),
    order,
    routes,
    blocked,
    chainBreakers: cbs.map((c) => ({ ...c, state: byTask.get(c.task)?.state || 'unknown', ...(byTask.get(c.task)?.block ? { why: byTask.get(c.task).block.why } : {}) })),
    expansion: { share: Math.round(share * 1000) / 1000, slots, running: runningExp.length, open: exp.length, byPhase, lowPhase: Number(lowPhase), askSlice, sliceOpen: f.sliceOpen ? f.sliceOpen.id : null },
    reasons,
  };
}

// ---- the rig (an adapter: helper j's rigBudget() when it is there, else the heavy budget) ----------------------------

const JOB_RANK = (h) => { const k = `${h.kind || ''} ${h.label || ''}`.toLowerCase(); return /train/.test(k) ? 0 : /verify|gate/.test(k) ? 1 : /unity|blender|art|asset|bake/.test(k) ? 2 : /soak|slow/.test(k) ? 3 : 4; };
/** The rig now: { source, known, byRam, cpuBusy, cpuBusyPct, cpuHold, usableRamGb, claimedGb, freeRamGb, cores, heavy: [...], train, why }. */
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
    // 2.78.1 (f): a running engine train's RAM counts between its land runs too (heavy-budget.mjs engineTrainReserve).
    const er = deps.engineReserve || hb.engineTrainReserve(root, holders, { env, now });
    const room = Number.isFinite(st.usableRamGb) ? Math.max(0, st.usableRamGb - (st.claimedGb || 0) - (er.gb || 0)) : null;
    const byRam = room === null ? null : Math.floor(room / perGb);
    const cpuBusy = Number.isFinite(profile.cpu?.busy) ? profile.cpu.busy : null;
    return { source: 'heavy-budget', known: byRam !== null || cpuBusy !== null, byRam, cpuBusy, cpuBusyPct: busyPct, cpuHold: cpuBusy !== null && cpuBusy * 100 >= busyPct, freeRamGb: st.freeRamGb ?? null, usableRamGb: st.usableRamGb ?? null, claimedGb: st.claimedGb ?? null, engineReserveGb: er.gb || 0, cores: st.cores ?? null, heavy, train, why: byRam === null ? 'the scan has no RAM figure' : `RAM ${st.usableRamGb} GB budget - ${st.claimedGb} GB of heavy claims${er.gb ? ` - ${er.gb} GB for ${er.why}` : ''} = room for ${byRam} builder${byRam === 1 ? '' : 's'} at ${perGb} GB (STUDIO_LINE_BUILDER_GB)` };
  } catch (e) { return { source: 'none', known: false, heavy: [], train, why: `the machine budget couldn't be read (${e.message})` }; }
}

// ---- gathering the facts, and the mechanical fixes ------------------------------------------------------------------

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

/** A train queue entry whose lane copy is gone and whose branch is still there: recreate the copy from the branch. */
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

/** Who may act where the owner is needed (a yes, an unpark, an unhold): beta mode's agents and the owner's delegate. */
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

/**
 * The facts for linePlan, and the mechanical fixes (unless dryRun or mode report). deps (tests): { queue, holds,
 * events, sessions, locks, pace, rig, trainQueue, root }.
 */
export async function gatherFacts({ now = Date.now(), dryRun = false, env = process.env, deps = {} } = {}) {
  const fix = !dryRun && lineMode(env) === 'on';
  const task = await import('./task.mjs');
  const th = await import('./task-hold.mjs');
  const lock = await import('./lock.mjs');
  const { mainRoot } = await import('./worktree.mjs');
  const root = deps.root || mainRoot();
  const events = deps.events || readRecentEvents(20000);
  const fixed = [];
  // 1. Locks whose holder's session is over (a dead process, an ended record): freed at once.
  if (fix) {
    try {
      const freed = lock.releaseDeadOwners((owner, l) => lock.holderGone(l) === true);
      for (const k of freed) fixed.push(logAction({ kind: 'lock', task: (k.match(/^task:(\S+)/) || [])[1] || null, what: `freed ${k}: its holder's session is over` }));
    } catch { /* the watcher frees them too */ }
  }
  // 2. Holds whose time has passed: a cooldown, a block, a park until a time or a landed task.
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
  // 3. Lanes queued for the train whose copy is gone: recreated from their branch (never while a train runs).
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
  // 2.78.1 (B-123): lanes for unscoped ready builder tasks (the Producer's decision, made by this pass), "unscoped" for
  // those it can't work out, and phase awareness: a task on shared sim code waits for the open one on the same files.
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
  // 2.77.0 (n): model pools (harness/model-pools.mjs), when on: each task's size class, its last failed pool, the model
  // it started on, whether it is protected-heavy; the outcomes file is rebuilt (written only when this pass acts).
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
      // A red round here is a session handed back for its own reasons since the task last landed: not a protected
      // step (that is correct behaviour, routed to an approver below), not a usage limit or a person's stop.
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
    // 2.77.0 (n, Priority 8): a protected step a builder handed back goes to someone who may approve it (beta mode or
    // the owner proxy) instead of stranding the task; it is held from new builders until approved (or the hold ends).
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
  // 2.77.0 (o): remote workers (harness/remote-workers.mjs): the live leases and which ready tasks may go out.
  let remote = deps.remote || null;
  if (!remote) {
    try { const rw = await import('./remote-workers.mjs'); remote = { ...(await rw.remoteFacts({ tasks, holds, events, env, root })), remotePlan: rw.remotePlan }; } catch { remote = null; }
  } else if (!remote.remotePlan) { try { remote = { ...remote, remotePlan: (await import('./remote-workers.mjs')).remotePlan }; } catch {} }
  return { now, tasks, holds, done: doneSet, sessions: live, pace: { maxAgents: pace.maxAgents, perRole: pace.perRole, label: pace.label }, rig, models, remote, share: expansionShare(env), chainMin: Math.max(1, num(env.STUDIO_LINE_CHAIN_MIN, 3)), expansionMin: Math.max(0, num(env.STUDIO_LINE_EXPANSION_MIN, 2)), sliceOpen: sliceOpen ? { id: sliceOpen.id, title: sliceOpen.title } : null, extraBlocked, dangling, fixed, pools, protectedSteps, lanes };
}

/**
 * 2.77.0 (n): who may approve a protected step now: beta mode's named agents (harness/beta-mode.mjs; betaActor asked as
 * each), else the owner proxy's agent (harness/delegation.mjs delegationFor, which then needs the owner's recorded yes
 * as --permission). { who, via, note } or null (only the owner).
 */
export async function protectedApprover({ env = process.env } = {}) {
  try {
    const { readBeta, betaActor } = await import('./beta-mode.mjs');
    const b = readBeta();
    if (b.on) {
      for (const a of b.doc.agents || []) { const x = betaActor({ env: { STUDIO_LOCK_OWNER: String(a) }, kind: 'protected' }); if (x.ok) return { who: String(a), via: 'beta mode', note: 'approves without the owner key while beta mode is on' }; }
      // 2.78.2 (h): a Producer session approves a protected step only with the owner's switch (permission.mjs mayDecide).
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
 * The protected steps waiting (each task whose newest hand-back since its last start names a protected file and has
 * no approval since): routed once per hand-back (a line.protected_routed event to the approver) and held from new
 * builders for STUDIO_LINE_PROTECTED_HOLD_MIN (120) after it was routed, or until an approval names it (approval.protected
 * or .proposal, or a beta/proxy approve-protected use, after the hand-back). No approver: reported only.
 */
export async function protectedRoutes({ tasks, events, now = Date.now(), env = process.env, act = true } = {}) {
  const { PROTECTED_RX } = await import('./model-pools.mjs');
  const holdMs = Math.max(0, num(env.STUDIO_LINE_PROTECTED_HOLD_MIN, 120)) * 60000;
  const out = [];
  let approver;
  for (const t of tasks) {
    if (t.state === 'running') continue;
    const mine = events.filter((e) => e.task === t.id || (e.type && /^approval\.|^delegation\.used$/.test(e.type) && String(e.msg || '').includes(t.id)));
    const lastStart = mine.filter((e) => e.type === 'task.start' || e.type === 'agent.session.start').pop();
    const pause = mine.filter((e) => e.type === 'task.paused' && (!lastStart || Date.parse(e.ts) >= Date.parse(lastStart.ts))).pop();
    if (!pause || !PROTECTED_RX.test(String(pause.msg || ''))) continue;
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

/** The Producer note: one file, rewritten when its reasons change, and one line.plan_blocked event per change. */
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
  try { emitEvent({ type: 'line.plan_blocked', agent: LINE_AGENT, to: 'producer', status: 'warn', msg: `Line Producer: this plan can't run because ${reasons.join('; ')}`.slice(0, 600), meta: { reasons, note: '.studio/line/producer-note.md' } }); } catch {}
  return { file: f, changed: true };
}

/**
 * One pass: gather, fix what is mechanical, plan, file at most one Director slice, write the note and
 * .studio/line/status.json. Returns the status (lineStatus's shape). Never throws.
 */
export async function lineProducerPass({ now = Date.now(), dryRun = false, env = process.env, deps = {} } = {}) {
  const mode = lineMode(env);
  if (mode === 'off') return { mode, off: true, why: 'STUDIO_LINE_PRODUCER=off' };
  try {
    const f = await gatherFacts({ now, dryRun, env, deps });
    const p = linePlan(f);
    const acting = !dryRun && mode === 'on';
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
    // 2.77.0 (o): STUDIO_REMOTE=on: leases that ran out end (the claim released, the task back on the board), a
    // background fetch of remote/* starts when one is due, and a changed offer is one remote.offer event.
    let remotePass = null;
    if (acting && p.remote?.on) { try { remotePass = await (await import('./remote-workers.mjs')).remotePass({ env, now, plan: p.remote, ...(deps.spawnFetch ? { spawnFetch: deps.spawnFetch } : {}), ...(deps.root ? { root: deps.root } : {}) }); } catch {} }
    // 2.77.0 (u, P5.2/P5.3): engine trains in quiet windows.
    let engines = [];
    try { engines = await enginePass({ now, env, dryRun: !acting, rig: f.rig, deps }); } catch (e) { engines = [{ error: e.message }]; }
    // 2.78.1 (f): the chain-breaker push (a quiet hold while a chain-breaker waits for the train) and engine twins.
    let chainPush = null;
    try { chainPush = await chainBreakerPush({ chainBreakers: p.chainBreakers, now, env, act: acting, deps: { ...(deps.root ? { root: deps.root } : {}), ...(deps.trainQueue ? { trainQueue: deps.trainQueue } : {}), ...(deps.heavy ? { heavy: deps.heavy } : {}) } }); } catch (e) { chainPush = { on: false, holding: false, why: `error: ${e.message}` }; }
    let twins = null;
    try { twins = await twinPass({ now, env, act: acting, deps: { ...(deps.root ? { root: deps.root } : {}), ...(deps.events ? { events: deps.events } : {}), ...(deps.queue ? { queue: deps.queue } : {}), ...(deps.engines ? { engines: deps.engines } : {}), ...(deps.filesOf ? { filesOf: deps.filesOf } : {}), ...(deps.addTask ? { addTask: deps.addTask } : {}) } }); } catch (e) { twins = { on: false, checked: [], why: `error: ${e.message}` }; }
    const status = {
      at: new Date(now).toISOString(),
      mode,
      dryRun: Boolean(dryRun),
      builders: p.builders,
      blocked: p.blocked,
      chainBreakers: p.chainBreakers,
      expansion: { ...p.expansion, ...(slice ? { sliceFiled: slice } : {}) },
      rig: f.rig,
      ...(p.remote ? { remote: { ...p.remote, ...(remotePass ? { swept: remotePass.swept, fetch: remotePass.fetch } : {}) } } : {}),
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
      twins,
    };
    // One plain line for the Communicator (helper l reads { at, builders: { running, target }, blocked, text }).
    status.text = summaryLine(status);
    if (!dryRun) { try { fs.mkdirSync(LINE_DIR(), { recursive: true }); const tmp = `${LINE_STATUS_FILE()}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`); fs.renameSync(tmp, LINE_STATUS_FILE()); } catch {} }
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
    `Line: ${s.builders?.running ?? 0}/${s.builders?.target ?? 0} builders${s.builders?.rigCap !== null && s.builders?.rigCap !== undefined && s.builders.rigCap < (s.builders.paceCap ?? Infinity) ? ` (the rig carries ${s.builders.rigCap})` : ''}`,
    s.blocked?.length ? `${s.blocked.length} blocked (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')})` : 'nothing blocked',
    cb ? `chain-breaker ${cb.task} (${cb.n} wait${cb.state === 'blocked' ? ', blocked' : ''})` : null,
    s.expansion?.slots ? `expansion ${s.expansion.running}/${s.expansion.slots}` : null,
    s.remote?.on && (s.remote.out || s.remote.queued || s.remote.offer?.length) ? `remote ${s.remote.out}/${s.remote.max}${s.remote.offer?.length ? ` (offer ${s.remote.offer.map((o) => o.task).join(', ')})` : ''}` : null,
    s.fixed?.length ? `fixed ${s.fixed.length}` : null,
    s.reasons?.length ? 'a Producer note is open' : null,
    s.chainPush?.holding ? `holding new builder verifies for chain-breaker ${s.chainPush.task}` : null,
    ...(s.twins?.checked || []).filter((r) => r.need).map((r) => `${r.engine} twin ${r.added || '(to add)'} for ${r.task}`),
    ...(s.engines || []).filter((e) => e.queued || e.running).map((e) => `${e.engine} train: ${e.running ? 'running' : e.started ? 'started' : `${e.queued} queued, waits (${e.why})`}`),
  ].filter(Boolean).join('; ');
}

// ---- 2.78.1 (f): the chain-breaker push ----------------------------------------------------------------------------

/** STUDIO_LINE_CHAIN_HOLD_MIN: minutes from a chain-breaker's queueing that new builder verifies are held back (60; 0/off: none). */
export function chainHoldMin(env = process.env) {
  const v = String(env.STUDIO_LINE_CHAIN_HOLD_MIN ?? '').trim();
  if (/^(off|no|false)$/i.test(v)) return 0;
  return Math.max(0, num(v, 60));
}
export const CHAIN_HOLD_TAG = 'chain-breaker';
/**
 * T-173, a chain-breaker, waited 4 h behind load for its train. While a chain-breaker (linePlan's chainBreakers) is
 * queued for the merge train (.studio/train/queue.json, not held for a person), this leaves a quiet hold (harness/heavy.mjs
 * markQuietHold, tag "chain-breaker", the 2.78.0 C2c mechanism): a heavy waiter that isn't a game landing (a builder's
 * verify, a lane check's heavy run, an engine land) doesn't start, so the train's own checks (landings) get a quiet
 * machine. Running holders are never stopped. Bounded: STUDIO_LINE_CHAIN_HOLD_MIN (60) from when the chain-breaker was
 * queued; then no hold for it. The hold ends when no chain-breaker is queued any more (landed, handed back) or the
 * supervisor that made it is gone. act false (a dry pass, report mode): nothing is written.
 * { on, holding, task?, until?, why }.
 */
export async function chainBreakerPush({ chainBreakers = [], now = Date.now(), env = process.env, act = true, deps = {} } = {}) {
  const h = deps.heavy || (await import('./heavy.mjs'));
  let root = deps.root || null;
  if (!root) { try { root = await h.heavyRoot(); } catch { root = null; } }
  if (!root) return { on: false, holding: false, why: 'no studio root' };
  const clear = () => { if (act) { try { h.clearQuietHold(root, CHAIN_HOLD_TAG); } catch {} } };
  const min = chainHoldMin(env);
  if (!(min > 0)) { clear(); return { on: false, holding: false, why: 'STUDIO_LINE_CHAIN_HOLD_MIN=0: no chain-breaker push' }; }
  const cbs = new Map((chainBreakers || []).map((c) => [c.task, c]));
  const q = deps.trainQueue || readJson(path.join(root, '.studio', 'train', 'queue.json'), []) || [];
  const queued = (Array.isArray(q) ? q : []).filter((e) => e?.task && cbs.has(e.task) && !(e.held && !(e.released && e.released.head === e.head)));
  const atOf = (e) => { const t = typeof e.at === 'number' ? e.at : Date.parse(e.at); return Number.isFinite(t) ? t : now; };
  const live = queued.map((e) => ({ e, until: atOf(e) + min * 60000 })).filter((x) => x.until > now).sort((a, b) => b.until - a.until);
  if (!live.length) {
    clear();
    return { on: true, holding: false, why: queued.length ? `chain-breaker ${queued.map((e) => e.task).join(', ')} has been queued for more than ${min} min (STUDIO_LINE_CHAIN_HOLD_MIN): no more hold for it` : 'no chain-breaker queued for the merge train' };
  }
  const { e, until } = live[0];
  const n = cbs.get(e.task)?.n || 0;
  const why = `chain-breaker ${e.task} (${n} task${n === 1 ? '' : 's'} wait on it) is queued for the merge train: new builder verifies wait so its train gets a quiet machine (at most ${min} min from its queueing, STUDIO_LINE_CHAIN_HOLD_MIN)`;
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

// ---- 2.78.1 (f): engine twins --------------------------------------------------------------------------------------

/**
 * The engine twins the owner listed: studio/game.json engines.<name>.twins (protected, the owner's), either the game
 * paths (globs) that have a twin in that engine's slice, or { paths, role, priority, branch, lane }. Generic default:
 * none. [{ engine, label, paths, role, priority, branch, lane }].
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

/** The files a landed task's commits on the main checkout's branch changed (commits whose message names the task). */
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
 * Patch's T-246 by hand: a game feature landed and the engine slice needed its twin. Each pass looks at the game tasks
 * that landed (task.done events) since the last one; a task whose changed files (landedFiles) match an engine's twin
 * paths gets ONE twin task for that engine: role engine-porter (or the config's), track engine:<name>, its branch
 * (<engine>/twin-<task>, or the config's {task} template), stacked --after the engine's open twins (and the landed task),
 * filed by the Line Producer (task add, promoted). A task that matches nothing is reported "no twin needed". Each task is
 * looked at once (.studio/line/twins.json; the first pass only starts the record). act false: what it would add.
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
  const f = path.join(LINE_DIR(), 'twins.json');
  const st = readJson(f, null);
  const save = (s) => { if (!act) return; try { fs.mkdirSync(LINE_DIR(), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`); fs.renameSync(tmp, f); } catch {} };
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

// ---- engine trains in quiet windows (2.77.0, u: P5.2/P5.3) -----------------------------------------------------------

/**
 * Should engine <x>'s train start now? Pure. f: { engine, label, heavyKind, queued, oldestAt, running, startedRecently,
 * auto, webTrain, webQueued, heavy: [{ kind, label }], freeGb, floorGb, floorFrom, cpuBusy, expectedMin, now }.
 * { start, wait, why }. Priority (the owner's): the web train > builder verifies > Unity/art > soaks.
 */
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
  if (f.webTrain) return no('the web train is running (its verify goes first: train > builder verifies > engine > soaks)');
  const sameKind = (f.heavy || []).filter((h) => (f.heavyKind === 'unity' ? /unity/i.test(`${h.kind || ''}`) : false) || /\btrain\b/i.test(`${h.kind || ''}`));
  if (sameKind.length) return no(`machine:heavy holds ${sameKind.map((h) => h.label || h.kind).slice(0, 2).join(', ')}`);
  if (Number.isFinite(f.freeGb) && f.floorGb > 0 && f.freeGb < f.floorGb) return no(`free RAM ${f.freeGb} GB is under the ${L} floor ${f.floorGb} GB (${f.floorFrom})`);
  if (Number.isFinite(f.cpuBusy) && f.cpuBusy * 100 >= quietPct) return no(`CPU ${Math.round(f.cpuBusy * 100)}% busy (STUDIO_ENGINE_QUIET_CPU_PCT ${quietPct})`);
  if (f.webQueued > 0 && waited < maxWait) return no(`${f.webQueued} web lane(s) wait for the web train, which goes first (the ${L} queue waited ${waited} of ${maxWait} min: STUDIO_ENGINE_TRAIN_MAX_WAIT_MIN)`);
  return { start: true, wait: false, why: `quiet window: no web train${f.webQueued ? ` (the ${L} queue waited ${waited} min, past ${maxWait})` : ''}, ${Number.isFinite(f.freeGb) ? `${f.freeGb} GB free (floor ${f.floorGb} GB)` : 'free RAM unknown (the train waits for its floor)'}${Number.isFinite(f.cpuBusy) ? `, CPU ${Math.round(f.cpuBusy * 100)}%` : ''}; one land run ~${f.expectedMin ?? '?'} min` };
}

const ENGINE_STARTS = () => path.join(LINE_DIR(), 'engine-trains.json');

/**
 * One look at every engine train: [{ engine, queued, running, expectedMin, floorGb, start, why, started? }]. Starts the
 * ones whose window is open (unless dryRun or STUDIO_LINE_PRODUCER=report). deps: { rig, rigBudget, machine, root,
 * startTrain(engine) -> { pid } }.
 */
export async function enginePass({ now = Date.now(), env = process.env, dryRun = false, rig = null, deps = {} } = {}) {
  const et = await import('./engine-tracks.mjs');
  const ut = await import('./unity-train.mjs');
  const { mainRoot } = await import('./worktree.mjs');
  const root = deps.root || mainRoot();
  const targets = et.engineTargets({ root }).filter((t) => t.land);
  if (!targets.length) return [];
  // The machine: rigBudget's running jobs and free RAM, the scan's CPU.
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
  const autoOn = !/^(off|0|false|no)$/i.test(String(env.STUDIO_ENGINE_TRAIN_AUTO ?? ''));
  const acting = !dryRun && lineMode(env) === 'on';
  const out = [];
  for (const t of targets) {
    const q = ut.readUnityQueue(root, t.name);
    const running = ut.runningUnityTrain(root, t.name);
    const floor = et.engineFloor(t.name, { env, root });
    const exp = et.expectedMinutes(t.name, { root });
    const last = starts[t.name];
    const since = last ? Math.round((now - Date.parse(last.at)) / 60000) : null;
    const f = { engine: t.name, label: t.label, heavyKind: t.heavyKind, queued: q.length, oldestAt: q[0]?.at || null, running: Boolean(running), startedRecently: since !== null && since < num(env.STUDIO_ENGINE_TRAIN_COOLDOWN_MIN, 3) ? Math.max(0, since) : 0, auto: autoOn && t.trainAuto, webTrain, webQueued: webQ.length, heavy, freeGb: Number.isFinite(rb?.freeGb) ? rb.freeGb : Number.isFinite(rig?.freeRamGb) ? rig.freeRamGb : null, floorGb: floor.gb, floorFrom: floor.from, cpuBusy, expectedMin: exp.minutes, now };
    const w = engineWindow(f, env);
    const row = { engine: t.name, queued: q.length, running: Boolean(running), expectedMin: exp.minutes, expectedFrom: exp.from, floorGb: floor.gb, start: w.start, why: w.why };
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

/** The last pass's status (.studio/line/status.json), or null. */
export const readLineStatus = () => readJson(LINE_STATUS_FILE(), null);
/** The status the Communicator posts: the last pass's, or a dry pass now when there is none (or fresh: true). */
export async function lineStatus({ fresh = false, env = process.env } = {}) {
  const s = fresh ? null : readLineStatus();
  return s || lineProducerPass({ dryRun: true, env });
}

/**
 * The supervisor's half: the plan it follows this pass, or null (off, report, an error, or older than
 * STUDIO_LINE_PLAN_MAX_SEC (300)). { order: Map(id -> rank), routes, rigCap, cbs }.
 */
export function supervisorPlan({ now = Date.now(), env = process.env } = {}) {
  if (lineMode(env) !== 'on') return null;
  const s = readLineStatus();
  if (!s || s.mode !== 'on' || s.error || s.dryRun || !Array.isArray(s.order)) return null;
  if (now - Date.parse(s.at) > num(env.STUDIO_LINE_PLAN_MAX_SEC, 300) * 1000) return null;
  return { order: new Map(s.order.map((id, i) => [id, i])), routes: s.routes || {}, hold: new Map((s.protectedSteps || []).filter((p) => p.hold).map((p) => [p.task, p.why])), rigCap: Number.isFinite(s.builders?.rigCap) ? s.builders.rigCap : null, rigWhy: s.builders?.why || '', cbs: new Set((s.chainBreakers || []).map((c) => c.task)) };
}
/** Sort the supervisor's groups (and each group's tasks) by the plan's order; tasks not in it keep their place after. */
export function orderGroups(groups, plan) {
  if (!plan) return groups;
  const rank = (id) => (plan.order.has(id) ? plan.order.get(id) : 1e6);
  for (const g of groups) g.tasks = g.tasks.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t.id) - rank(b.t.id) || a.i - b.i).map((x) => x.t);
  return groups.map((g, i) => ({ g, i })).sort((a, b) => (a.g.role === 'dev-hacker') - (b.g.role === 'dev-hacker') || rank(a.g.tasks[0]?.id) - rank(b.g.tasks[0]?.id) || a.i - b.i).map((x) => x.g);
}

// ---- the CLI -------------------------------------------------------------------------------------------------------

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
  if (s.remote) L.push(remoteText(s.remote));
  if (s.blocked?.length) { L.push('Blocked:'); for (const b of s.blocked.slice(0, 12)) L.push(`  ${b.task} [${b.kind}] ${b.why}${b.fix ? ` -> ${b.fix}` : ''}`); if (s.blocked.length > 12) L.push(`  … and ${s.blocked.length - 12} more (npm run line -- status --json)`); }
  if (s.models?.on) L.push(`Model pools (npm run models -- status): ${Object.entries(s.models.pools || {}).map(([k, v]) => `${k} ${v.out ? 'out' : v.near ? `near (${v.usedPct}%)` : `${v.usedPct}%`}`).join(', ')}.`);
  if (s.protectedSteps?.length) L.push(`Protected steps: ${s.protectedSteps.map((p) => `${p.task} -> ${p.actor || 'the owner'}${p.hold ? ' (held)' : ''}`).join('; ')}.`);
  if (s.lanes && !s.lanes.error) L.push(...laneLinesOf(s.lanes));
  if (s.reasons?.length) L.push(`For the Producer (this plan can't run because): ${s.reasons.join('; ')}.`);
  if (s.fixed?.length) L.push(`Fixed this pass: ${s.fixed.map((a) => a.what).join('; ')}.`);
  if (s.actions?.length) L.push(`Last actions: ${s.actions.slice(-5).map((a) => `${String(a.at).slice(11, 16)} ${a.what}`).join('; ')}.`);
  return L.join('\n');
}

/** 2.77.0 (o): the "remote" line (harness/remote-workers.mjs remoteLine's words; inline so the CLI never fails on it). */
export function remoteText(r) {
  return `Remote: ${r.out} out${r.queued ? `, ${r.queued} queued for the train` : ''} (0 local CPU until queued; at most ${r.max}); ${r.offer?.length ? `offer: ${r.offer.map((o) => o.task).join(', ')} -> npm run remote -- brief <T-ID> --worker <name> --by <you>` : r.why}${r.leases?.length ? `; leases: ${r.leases.map((l) => `${l.task} ${l.owner} ${l.status} until ${String(l.until).slice(11, 16)} UTC`).join(', ')}` : ''}.`;
}

/** 2.78.1 (B-123): the lane lines (harness/lane-plan.mjs laneLines' words; inline so the CLI never fails on an import). */
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
