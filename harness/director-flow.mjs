#!/usr/bin/env node
/**
 * harness/director-flow.mjs — the Director keeps the builders working (2.30h, item 2).
 *
 *   npm run director -- flow [--json] [--no-fill]
 *
 * The Director owns the flow: every pass (the supervisor's loop, at most once a minute;
 * npm run director -- flow by hand) it looks at the whole board and the running sessions and
 *   1. hands back claims that ran out (in progress, nobody holds it, no running session on it); a task whose owner
 *      is still at work (harness/busy.mjs) is kept and its claim made again in the owner's name (2.58.5, H-5),
 *   2. counts idle builder slots against ready work across the whole backlog (every role, not one lane),
 *   3. refills idle slots through the launcher (the same caps, lanes and pace as always; a pace that
 *      doesn't start agents on its own gets a "starved" alert instead),
 *   4. sends back missing design-fidelity mechanics as builder work (harness/fidelity.mjs),
 *   5. writes .studio/director-flow.json (the War Room's Director card) and, when the studio has been
 *      starved for STUDIO_FLOW_IDLE_MIN (default 10) minutes, raises director.flow.starved (a phone alert
 *      when alerts are on) with the reasons the launcher gave.
 * A script, no model, no tokens; it never waits on anything, so it can't slow an agent down.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';

export const FLOW_FILE = () => path.join(STUDIO_STATE_DIR, 'director-flow.json');
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * The flow, from plain data (testable): queue {inProgress, backlog}, sessions [{agent, role, running,
 * task}], task locks [{key, owner}], a hold function, the pace (maxAgents, perRole), the previous report.
 */
export function flowReport({ queue, sessions = [], locks = [], held = () => null, failing = new Set(), mode = { maxAgents: 4, perRole: { builder: 3 } }, prev = null, now = Date.now(), idleMin = Number(process.env.STUDIO_FLOW_IDLE_MIN || 10) }) {
  const live = sessions.filter((s) => s.running);
  const builders = live.filter((s) => s.role === 'builder');
  const slots = Math.max(0, Math.min(mode.maxAgents ?? 4, mode.perRole?.builder ?? Math.max(1, Math.floor((mode.maxAgents ?? 4) / 2))));
  const holders = new Set(locks.filter((l) => l.key.startsWith('task:')).map((l) => l.key.slice(5)));
  const onTask = new Set(live.map((s) => s.task).filter(Boolean));
  const expired = queue.inProgress.filter((t) => !holders.has(t.id) && !onTask.has(t.id) && t.role !== 'human' && t.role !== 'producer' && !/^Watch:|^Check forced done/i.test(t.title)).map((t) => t.id);
  // 2.30h (#2): refill only from work that isn't parked or held (breakers included) and whose last hand-back wasn't a failure.
  const failed = queue.backlog.filter((t) => t.role !== 'human' && !held(t.id) && failing.has(t.id)).map((t) => t.id);
  const ready = queue.backlog.filter((t) => t.role !== 'human' && !held(t.id) && !failing.has(t.id));
  const readyByRole = {};
  for (const t of ready) readyByRole[t.role] = (readyByRole[t.role] || 0) + 1;
  const readyBuild = readyByRole.builder || 0;
  const idleSlots = Math.max(0, Math.min(slots, readyBuild) - builders.length);
  const freeRoom = Math.max(0, (mode.maxAgents ?? 4) - live.length);
  // Starved: ready work and room for it, but nothing on it. Waiting since the first pass that saw it.
  const starved = (idleSlots > 0 || (ready.length > 0 && live.length === 0)) && freeRoom > 0;
  const since = starved ? (prev?.starvedSince && prev.starved ? prev.starvedSince : new Date(now).toISOString()) : null;
  const idleFor = since ? Math.round((now - Date.parse(since)) / 60000) : 0;
  const state = !queue.backlog.length && !queue.inProgress.length ? 'empty' : starved ? (idleFor >= idleMin ? 'starved' : 'refilling') : ready.length && !freeRoom ? 'full' : 'flowing';
  return {
    at: new Date(now).toISOString(),
    state,
    builders: { running: builders.length, slots, idle: idleSlots, agents: builders.map((s) => `${s.agent}${s.task ? ` on ${s.task}` : ''}`) },
    agents: { running: live.length, max: mode.maxAgents ?? 4 },
    ready: { total: ready.length, byRole: readyByRole, held: queue.backlog.length - ready.length - failed.length, failing: failed.length },
    failing: failed,
    expired,
    starved,
    starvedSince: since,
    idleFor,
  };
}

let lastPass = 0;
/** One pass. `fill` starts agents through the launcher; `throttleMs` keeps it to about once a minute. */
export async function flowPass({ fill = true, dryRun = false, launcherWhy = null, throttleMs = 0, now = Date.now() } = {}) {
  if (throttleMs && now - lastPass < throttleMs) return readJson(FLOW_FILE());
  lastPass = now;
  const { parseNextQueue, pauseTask } = await import('./task.mjs');
  const { holdReason } = await import('./task-hold.mjs');
  const { listLocks } = await import('./lock.mjs');
  const { sessions, fillAgents, releaseDeadLocks } = await import('./agent.mjs');
  let freedLocks = [];
  if (!dryRun) freedLocks = await releaseDeadLocks().catch(() => []);
  const { effectiveMode } = await import('./mode.mjs');
  const queue = parseNextQueue();
  const mode = effectiveMode();
  const prev = readJson(FLOW_FILE());
  const { failingTasks } = await import('./breaker.mjs');
  let failing = new Set();
  try {
    failing = failingTasks();
  } catch {}
  const r = flowReport({ queue, sessions: sessions(), locks: listLocks(), held: (id) => holdReason(id, queue, now), failing, mode, prev, now });
  const actions = freedLocks.length ? [`freed ${freedLocks.length} lock(s) of agents whose process is gone`] : [];
  // 2.30q (#6): a task whose done is running or whose lane is queued to land is busy, not abandoned.
  // 2.58.3 (N2): so is one whose claim's owner (an agent working outside the launcher) is still active.
  // 2.58.5 (H-5): and its claim is made again in the owner's name, so no crew builder's `task start` takes it meanwhile.
  const { taskBusy, keepClaim } = await import('./busy.mjs');
  // 2.85: a task queued for a train (the web train's queue, an engine train's queue, or a running train's lanes) is
  // finished work, not abandoned: its expired claim is let go quietly (no hand-back, no note, the board left as the train
  // expects), with one task.claim.released, and never kept as "its owner is still working on it". The train lands it or
  // hands it back. On 2.84 the flow pass handed such tasks back an hour after their session queued them (30 of a crew's
  // 73 hand-backs in 16 h), and the supervisor then refused to start anyone on them.
  const released = await releaseWaitingClaims(r.expired, { now, dryRun });
  if (released.length) {
    r.expired = r.expired.filter((id) => !released.some((x) => x.id === id));
    r.waiting = released;
  }
  const busyNow = [];
  let keptSig = null;
  const evs = r.expired.length ? readRecentEvents(20000) : [];
  for (const id of r.expired) {
    const b = await taskBusy(id, { now, events: evs });
    if (!b.busy) continue;
    busyNow.push({ id, why: b.why, short: b.short });
    if (b.owner && !dryRun) keepClaim(id, b.owner, { by: 'director', why: b.short || b.why });
  }
  if (busyNow.length) {
    r.expired = r.expired.filter((id) => !busyNow.some((b) => b.id === id));
    r.busy = busyNow;
    actions.push(`kept ${busyNow.map((b) => b.id).join(', ')} (busy: ${busyNow.map((b) => b.short || b.why).join('; ')})`);
    keptSig = `kept ${busyNow.map((b) => `${b.id}:${String(b.short || b.why).replace(/\d+/g, '#')}`).join(', ')}`; // the ticking "N min ago" is not a change
  }
  for (const id of r.expired) {
    if (!dryRun) pauseTask(id, 'director', 'The claim ran out with no running session on it: handed back by the Director\'s flow pass so a free builder can take it.', { force: true });
    actions.push(`handed back ${id} (claim ran out)`);
  }
  if (r.starved && fill && !dryRun) {
    const f = await fillAgents({ byDirector: true }).catch((err) => ({ started: [], why: err.message }));
    if (f.started.length) actions.push(`started ${f.started.join(', ')}`);
    else if (f.why) launcherWhy = launcherWhy || f.why;
    if (mode.chosen && !mode.autoLaunch) actions.push(`the ${mode.label || 'current'} pace doesn't start agents on its own`);
  }
  // 2.85: a task held because task done refused it twice for the same reason is let go once that reason is gone.
  if (!dryRun) {
    try { const lifted = await liftSameRefusalHolds({ now }); if (lifted.length) actions.push(`lifted the same-refusal hold on ${lifted.join(', ')} (task done --check no longer gives that reason)`); } catch { /* a help, never a blocker */ }
  }
  // 4. Missing mechanics go back as builder work (once each).
  try {
    const { readLastFidelity, sendBack } = await import('./fidelity.mjs');
    const fid = readLastFidelity();
    if (fid?.configured && !fid.ok && !dryRun) {
      const s = await sendBack({ by: 'director', result: fid });
      if (s.added.length) actions.push(`sent back missing mechanics: ${s.added.join(', ')}`);
    }
  } catch {}
  const out = { ...r, actions, launcherWhy: Array.isArray(launcherWhy) ? launcherWhy.slice(0, 4).join('; ') : launcherWhy || null, autoLaunch: Boolean(mode.autoLaunch) };
  // 2.79.1 (d): director.flow is written on change only. What counts as a change leaves out the numbers that tick every pass
  // (a kept task's "active N min ago"); the 30-minute repeat of an unchanged line is gone (the flow file and the brief carry the state).
  out.sig = actions.map((a) => (a.startsWith('kept ') && keptSig ? keptSig : a)).join('; ');
  if (!dryRun) {
    fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
    fs.writeFileSync(FLOW_FILE(), `${JSON.stringify(out, null, 2)}\n`);
    // One event when the flow turns starved (and every 30 min while it stays so), never one a minute.
    const lastAlert = readRecentEvents(2000).filter((e) => e.type === 'director.flow.starved').pop();
    if (out.state === 'starved' && (!prev || prev.state !== 'starved' || !lastAlert || now - Date.parse(lastAlert.ts) > 30 * 60000)) {
      emitEvent({ type: 'director.flow.starved', agent: 'director', to: 'producer', status: 'warn', msg: `Builders idle ${out.idleFor} min with ${out.ready.byRole.builder || 0} builder task(s) ready (${out.builders.running}/${out.builders.slots} builder slots used)${out.launcherWhy ? `: ${out.launcherWhy}` : ''}`.slice(0, 300), meta: { ready: out.ready, builders: out.builders } });
    }
    if (actions.length) {
      const actionsText = actions.join('; ');
      if (!prev || (prev.sig ?? prev.actions?.join('; ')) !== out.sig) {
        emitEvent({ type: 'director.flow', agent: 'director', to: 'producer', msg: `Flow: ${actionsText}`.slice(0, 300) });
      }
    }
  }
  return out;
}

/**
 * 2.85: the expired claims whose task waits for a train: [{ id, engine, why }]. Each is released quietly: any claim left
 * on it is freed, and one task.claim.released (status ok) says so per task and train entry (emitOnChange), so a pass a
 * minute never repeats it. Nothing is handed back and the board is not touched.
 */
export async function releaseWaitingClaims(ids, { now = Date.now(), dryRun = false } = {}) {
  if (!ids?.length) return [];
  const { heldForLanding } = await import('./task-hold.mjs');
  const out = [];
  for (const id of ids) {
    let tq = null;
    try { tq = heldForLanding(id, { holds: {} }); } catch { tq = null; }
    if (tq?.via !== 'train') continue;
    const train = tq.engine ? `${tq.engine}` : 'merge';
    out.push({ id, engine: tq.engine || null, why: tq.why });
    if (dryRun) continue;
    try {
      const { status, release } = await import('./lock.mjs');
      const l = status(`task:${id}`);
      if (l?.locked && l.lock?.owner) release(`task:${id}`, l.lock.owner);
    } catch { /* an expired claim is free already */ }
    try {
      const { emitOnChange } = await import('./telemetry.mjs');
      emitOnChange({ type: 'task.claim.released', agent: 'director', task: id, status: 'ok', msg: `Released ${id}'s claim quietly: it waits for the ${train} train (${tq.why}); not a hand-back, the train lands it or hands it back`.slice(0, 400), meta: { why: `waits for the ${train} train`, train, at: tq.at || null } },
        `claim.released|${id}`, `${train}|${tq.at || ''}`, { now });
    } catch { /* the release stands without its event */ }
  }
  return out;
}

/** 2.85: how often a same-refusal hold's check runs, at most (ms). */
const LIFT_EVERY_MS = 10 * 60000;
/** `task done <ID> --check`'s output, or '' when it passes; null when it could not run. */
function doneCheckText(id, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => import('./event.mjs').then(({ REPO_ROOT }) => {
      let text = '';
      let child;
      try {
        child = spawn(process.execPath, [path.join(REPO_ROOT, 'harness', 'task.mjs'), 'done', id, '--check'], { cwd: REPO_ROOT, windowsHide: true, env: { ...process.env, STUDIO_LOCK_OWNER: 'harness' }, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch { resolve(null); return; }
      const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(null); }, timeoutMs);
      child.stdout.on('data', (d) => { text += d; });
      child.stderr.on('data', (d) => { text += d; });
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? '' : text); });
    })).catch(() => resolve(null));
  });
}

/**
 * 2.85: lift the holds made for "task done is refused for the same reason twice" (session-outcome.mjs holdIfSameRefusal)
 * whose refusal is gone: `task done <ID> --check` (seconds) no longer gives that reason. Checked at most every 10 minutes
 * per task; a check that can't run keeps the hold. `check(id)` -> text ('' = passes) | null is for tests. Returns the ids lifted.
 */
export async function liftSameRefusalHolds({ now = Date.now(), check = doneCheckText, everyMs = LIFT_EVERY_MS } = {}) {
  const { readHolds, updateHolds } = await import('./task-hold.mjs');
  const { refusalKey } = await import('./handback-kind.mjs');
  const lifted = [];
  for (const [id, h] of Object.entries(readHolds())) {
    const p = h?.parked;
    if (!p || p.reason !== 'same-refusal' || !p.key) continue;
    if (now - (Date.parse(p.checkedAt || p.at || '') || 0) < everyMs) continue;
    const text = await check(id);
    const still = text === null || (text !== '' && refusalKey(text).includes(String(p.key).slice(0, 120)));
    let did = false;
    updateHolds((all) => {
      const cur = all[id]?.parked;
      if (!cur || cur.reason !== 'same-refusal' || cur.key !== p.key) return false;
      if (still) all[id] = { ...all[id], parked: { ...cur, checkedAt: new Date(now).toISOString() } };
      else { const { parked, ...rest } = all[id]; all[id] = rest; did = true; }
      return true;
    });
    if (did) {
      lifted.push(id);
      emitEvent({ type: 'task.hold', agent: 'harness', task: id, to: 'producer', msg: `harness unparked ${id}: task done --check no longer gives the refusal it was held for (${String(p.why || '').slice(0, 200)})`.slice(0, 400), meta: { reason: 'same-refusal', lifted: true } });
    }
  }
  return lifted;
}

/** Lines for the Director's brief. */
export function flowBrief(r = readJson(FLOW_FILE())) {
  if (!r) return ['- No flow pass yet (npm run director -- flow).'];
  return [
    `- State: **${r.state}**${r.starved ? ` for ${r.idleFor} min` : ''}. Builders ${r.builders.running}/${r.builders.slots}${r.builders.agents.length ? ` (${r.builders.agents.join(', ')})` : ''}; ${r.ready.total} task(s) ready (${Object.entries(r.ready.byRole).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}), ${r.ready.held} held.`,
    ...(r.actions?.length ? [`- Last pass: ${r.actions.join('; ')}`] : []),
    ...(r.launcherWhy ? [`- Why nothing started: ${r.launcherWhy}`] : []),
    '- You own the flow: if builders sit idle with work ready, find out why (a hold, a lane clash, a pace that doesn\'t auto-start, quota) and tell the Producer what to change.',
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await flowPass({ fill: !process.argv.includes('--no-fill') });
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : flowBrief(r).join('\n'));
  process.exit(0);
}
