/**
 * harness/rescue.mjs — 2.35.0: a task that used its budget climbs a ladder before it reaches a person, and
 * no step can gridlock the studio.
 *
 *   1. Rescue      on a stronger model from a different family than the ones that got stuck. It diagnoses
 *                  and decides: retry (blocker cleared), split (smaller tasks queued) or needs-person.
 *   2. Split       if the rescue is stuck too (its own budget ran out, nobody picked it up within
 *                  STUDIO_RESCUE_WAIT_MIN, 60, or it chose retry and the task got stuck again): a second
 *                  rescue whose only allowed outcomes are split or needs-person, on the next model on the list.
 *   3. Shelve      if that is stuck too: the task is parked as shelved with the diagnoses so far, the
 *                  Producer plans around it, and it is listed under "Needs you" in the morning report.
 *                  Nothing else waits for it.
 * STUDIO_RESCUE_LEVELS (2) sets how many rescue steps come before the shelf; STUDIO_RESCUE=off sends budget
 * stops straight to a person.
 *
 * The model at each step: the first available of STUDIO_RESCUE_MODEL, STUDIO_RESCUE_MODELS (comma-separated)
 * and STUDIO_TIER_TOP_MODEL whose family didn't work on the task (and, for step 2, isn't the step-1 model),
 * else one of those from the same family, else none (the launcher's own model and tier escalation). A model
 * whose tool or family is marked out (quota, spend guard: harness/budget.mjs) is skipped, so a rescue never
 * waits on one provider.
 *
 * A rescue writes studio/rescues/<T-ID>.md: "Diagnosis:" (40+ words) and one "Decision:" (studio/skills/rescue.md).
 *
 * 2.60.1 (B-39): a lane held for landing (`task hold`) or queued for the merge train is waiting on purpose, not stuck:
 * no rescue is filed or escalated for it, its open rescues can't start, and when a task lands (task done, a train)
 * its open rescues are closed with a note (closeRescuesFor; the watchdog's pass also sweeps any it missed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, emitEvent, readRecentEvents } from './event.mjs';
import { modelFamily } from './families.mjs';
import { setHold, heldForLanding, heldWords } from './task-hold.mjs';
import { budgetStopFor } from './budget.mjs';

export const RESCUE_RE = /^Rescue:\s*(T-\d+)\b/;
export const DECISIONS = ['retry', 'split', 'needs-person'];
export const rescueOf = (title) => (RESCUE_RE.exec(String(title || '')) || [])[1] || null;
export const rescueFile = (taskId) => path.join(REPO_ROOT, 'studio', 'rescues', `${taskId}.md`);
const DAY = 86400000;
const off = (env) => /^(off|0|false|no)$/i.test(env.STUDIO_RESCUE || '');

/** Rescue steps already taken for this task today (task.rescue events). */
export function rescueLevel(taskId, events = readRecentEvents(20000), now = Date.now()) {
  return events.filter((e) => e.type === 'task.rescue' && e.task === taskId && Date.parse(e.ts) > now - DAY);
}

/** The model for a rescue step: a different family, available now, not one already tried on this task's rescues. */
export function rescueModelFor(taskId, { events = readRecentEvents(20000), env = process.env, now = Date.now(), exclude = [] } = {}) {
  const used = new Set(events.filter((e) => e.task === taskId && (e.type === 'task.start' || e.type === 'agent.session.start') && e.model && e.model !== 'unknown').map((e) => modelFamily(e.model)));
  const candidates = [...new Set([env.STUDIO_RESCUE_MODEL, ...String(env.STUDIO_RESCUE_MODELS || '').split(','), env.STUDIO_TIER_TOP_MODEL].map((m) => String(m || '').trim()).filter(Boolean))];
  const available = candidates.filter((m) => !exclude.includes(m) && !budgetStopFor({ tool: 'custom', model: m }, now, env).stopped);
  const skipped = candidates.filter((m) => !available.includes(m) && !exclude.includes(m));
  const other = available.find((m) => !used.has(modelFamily(m)));
  const model = other || available[0] || null;
  return { model, usedFamilies: [...used], differentFamily: model ? !used.has(modelFamily(model)) : null, skipped };
}

/**
 * The next step for a stuck task: queue a rescue (step 1 or 2) or shelve it (past the last step).
 * Returns { id, level, model } when a rescue was queued, { shelved: why } when shelved, { person: why } when
 * rescues are off.
 */
export async function fileRescue(taskId, why, { now = Date.now(), env = process.env, waiting = null } = {}) {
  if (off(env)) return { person: 'rescues are off (STUDIO_RESCUE=off)' };
  const events = readRecentEvents(20000);
  const done = rescueLevel(taskId, events, now);
  const levels = Number(env.STUDIO_RESCUE_LEVELS ?? 2);
  const level = done.length + 1;
  const short = String(why || '').replace(/^T-\d+ has used its budget:\s*/, '').split('. ')[0].slice(0, 80);
  if (level > levels) return shelve(taskId, `${done.length} rescue step${done.length === 1 ? '' : 's'} didn't get it unstuck (${short})`, { now });
  const { addTask } = await import('./task.mjs');
  const m = rescueModelFor(taskId, { events, env, now, exclude: done.map((e) => e.meta?.model).filter(Boolean) });
  const title = level === 1 ? `Rescue: ${taskId} stuck (${short})` : `Rescue: ${taskId} split it into small pieces (step ${level}: ${short})`;
  const res = addTask({ title, role: 'builder', priority: 'P0', agent: 'budget', meta: { promoted: true, rescueOf: taskId, rescueLevel: level, rescueModel: m.model, origin: 'harness' } });
  if (!res || res.error) return shelve(taskId, `the rescue couldn't be queued (${res?.message || 'unknown'})`, { now });
  emitEvent({ type: 'task.rescue', agent: 'budget', to: 'producer', task: taskId, msg: `${taskId}: rescue step ${level} ${res.id} queued${m.model ? ` on ${m.model}${m.differentFamily ? ' (a different model family)' : ''}` : ' (no rescue model available: the launcher picks)'}${m.skipped.length ? `; skipped ${m.skipped.join(', ')} (out of quota or budget)` : ''}${waiting ? `; waiting: ${waiting}` : ''}`, meta: { rescue: res.id, level, model: m.model, usedFamilies: m.usedFamilies } });
  return { id: res.id, level, model: m.model };
}

/** Park a task as shelved: the studio plans around it; a person sees it in the morning report. */
export function shelve(taskId, why, { now = Date.now() } = {}) {
  const reason = `shelved: ${why}. The studio carries on without it; see studio/rescues/${taskId}.md`;
  setHold(taskId, { parked: { by: 'rescue', why: reason, shelved: true, budget: true, rescue: 'shelved', at: new Date(now).toISOString() } }, { by: 'rescue', msg: `${taskId} ${reason}` });
  emitEvent({ type: 'task.shelved', agent: 'rescue', to: 'producer', task: taskId, msg: `${taskId} ${reason}` });
  emitEvent({ type: 'agent.ask', agent: 'rescue', to: 'producer', task: taskId, msg: `Needs you (not urgent, nothing waits on it): ${taskId} ${reason}` });
  return { shelved: reason };
}

/**
 * 2.60.1 (B-39): close the open rescue tasks of a task that landed (or is held for landing). Waiting ones are dropped
 * with a note; one somebody already claimed gets a message to its claimant instead (its work isn't thrown away).
 * board: { parseNextQueue, dropTask } (from harness/task.mjs: this module never imports it statically).
 * Returns [{ id, action: 'closed'|'told', why }].
 */
export function closeRescuesFor(taskId, { by = 'harness', why = 'landed', board } = {}) {
  if (!taskId || !board?.parseNextQueue) return [];
  const q = board.parseNextQueue();
  const out = [];
  const note = `${taskId} ${why}; this rescue isn't needed any more (closed automatically, harness/rescue.mjs)`;
  for (const t of q.backlog.filter((x) => rescueOf(x.title) === taskId)) {
    const r = board.dropTask(t.id, { by, why: note });
    if (r?.ok) {
      out.push({ id: t.id, action: 'closed', why: note });
      emitEvent({ type: 'task.rescue.closed', agent: by, task: t.id, to: 'producer', msg: `${t.id} closed: ${note}`, meta: { stuck: taskId, why } });
    }
  }
  for (const t of q.inProgress.filter((x) => rescueOf(x.title) === taskId)) {
    out.push({ id: t.id, action: 'told', why: note });
    emitEvent({ type: 'task.rescue.obsolete', agent: by, task: t.id, to: 'producer', msg: `${t.id}: ${note}. Its claimant hands it back (npm run task -- pause ${t.id} --note "…") or closes it with --no-op.`, meta: { stuck: taskId, why } });
  }
  return out;
}

/** The rescue report: { diagnosis, decision, words } or null. */
export function readRescue(taskId) {
  const f = rescueFile(taskId);
  if (!fs.existsSync(f)) return null;
  const text = fs.readFileSync(f, 'utf8');
  const decision = ((text.match(/^\s*Decision:\s*([\w-]+)/im) || [])[1] || '').toLowerCase();
  const diag = text.split(/^\s*Diagnosis:\s*/im)[1] || '';
  return { text, decision: DECISIONS.includes(decision) ? decision : null, rawDecision: decision, diagnosis: diag.split(/^\s*Decision:/im)[0].trim(), words: (diag.match(/[A-Za-z0-9]{2,}/g) || []).length, mtime: fs.statSync(f).mtimeMs };
}

/** After a rescue task is done: act on its decision. */
export function applyRescue(rescueTask, { by = 'rescue' } = {}) {
  const stuck = rescueOf(rescueTask.title);
  if (!stuck) return null;
  const r = readRescue(stuck);
  if (r?.decision === 'retry') {
    setHold(stuck, { parked: null }, { by, msg: `${by} unparked ${stuck}: rescue ${rescueTask.id} cleared it (budget starts again)` });
    emitEvent({ type: 'task.rescue.done', agent: by, task: stuck, msg: `${stuck} back in the queue after rescue ${rescueTask.id}: ${r.diagnosis.split('\n')[0].slice(0, 200)}`, meta: { decision: 'retry', rescue: rescueTask.id } });
  } else if (r?.decision === 'split') {
    setHold(stuck, { parked: { by: 'rescue', why: `split by rescue ${rescueTask.id} into smaller tasks; close it when they land`, rescue: 'split', at: new Date().toISOString() } }, { by, msg: `${stuck} split by rescue ${rescueTask.id}` });
    emitEvent({ type: 'task.rescue.done', agent: by, task: stuck, to: 'producer', msg: `${stuck} split by rescue ${rescueTask.id}`, meta: { decision: 'split', rescue: rescueTask.id } });
  } else {
    setHold(stuck, { parked: { by: 'rescue', why: `rescue ${rescueTask.id} needs a person: ${r?.diagnosis ? r.diagnosis.split('\n')[0].slice(0, 200) : 'see the rescue report'}`, rescue: 'person', at: new Date().toISOString() } }, { by, msg: `${stuck} waits for a person (rescue ${rescueTask.id})` });
    emitEvent({ type: 'agent.ask', agent: by, to: 'producer', task: stuck, msg: `Needs you: rescue ${rescueTask.id} says a person must decide ${stuck}. ${r?.diagnosis ? r.diagnosis.split('\n')[0].slice(0, 300) : ''} (studio/rescues/${stuck}.md)` });
    emitEvent({ type: 'task.rescue.done', agent: by, task: stuck, msg: `${stuck}: rescue ${rescueTask.id} asks for a person`, meta: { decision: 'needs-person', rescue: rescueTask.id } });
  }
  return r?.decision || 'needs-person';
}

/**
 * The watchdog's pass over stuck tasks (harness/watchdog.mjs): budget-stopped tasks get their next step;
 * a rescue that is itself stuck (its own budget, or unclaimed past STUDIO_RESCUE_WAIT_MIN) moves its
 * task to the next step. Returns the actions taken.
 */
export async function rescuePass({ now = Date.now(), env = process.env, launcher = null, clockFrom = 0 } = {}) {
  const { readHolds } = await import('./task-hold.mjs');
  const { parseNextQueue, dropTask } = await import('./task.mjs');
  let q = parseNextQueue();
  const holds = readHolds();
  const actions = [];
  // 2.60.1 (B-39): rescues of a task that has landed since are closed (task done closes them too; this sweeps the rest).
  const doneIds = new Set(q.done.map((t) => t.id));
  for (const stuck of [...new Set([...q.backlog, ...q.inProgress].map((t) => rescueOf(t.title)).filter((id) => id && doneIds.has(id)))]) {
    for (const r of closeRescuesFor(stuck, { by: 'watchdog', why: 'has landed', board: { parseNextQueue, dropTask } })) if (r.action === 'closed') actions.push({ kind: 'rescue-closed', task: r.id, msg: `closed ${r.id}: ${stuck} has landed` });
  }
  q = parseNextQueue();
  const open = [...q.inProgress, ...q.backlog];
  const landing = (id) => { try { return heldForLanding(id, { holds }); } catch { return null; } };
  const waitMs = Number(env.STUDIO_RESCUE_WAIT_MIN ?? 60) * 60000;
  const events = readRecentEvents(20000);
  // A rescue that is stuck itself: parked by its own budget, or nobody picked it up in time.
  for (const t of open) {
    const stuck = rescueOf(t.title);
    if (!stuck) continue;
    if (landing(stuck)) continue; // waiting to land on purpose: its rescue isn't escalated
    const h = holds[t.id]?.parked;
    const added = Date.parse(events.filter((e) => e.type === 'task.added' && e.task === t.id).pop()?.ts || '') || now;
    const claimed = events.some((e) => e.type === 'task.start' && e.task === t.id);
    // 2.58.3 (N4): `launcher` (from the watchdog): while nothing can pick a rescue up (no launcher running, the
    // supervisor halted, the studio stopped) its pick-up clock doesn't run; it runs again from `clockFrom`, the
    // last time that was so, never from when the rescue was queued.
    if (!h?.budget && !claimed && launcher && !launcher.picking) continue;
    const from = Math.max(added, Number(clockFrom) || 0);
    const why = h?.budget ? 'the rescue ran out of its own budget' : !claimed && now - from > waitMs ? `nobody picked the rescue up in ${Math.round(waitMs / 60000)} min` : null;
    if (!why || h?.superseded) continue;
    setHold(t.id, { parked: { by: 'rescue', why: `${why}; the next step takes over`, superseded: true, at: new Date(now).toISOString() } }, { by: 'watchdog', msg: `${t.id} superseded: ${why}` });
    const r = await fileRescue(stuck, why, { now, env });
    actions.push({ kind: r.id ? 'rescue' : 'shelve', task: stuck, msg: r.id ? `${t.id} was stuck (${why}); rescue step ${r.level} ${r.id} queued for ${stuck}` : `${stuck} ${r.shelved || r.person}` });
  }
  // A task stopped by its budget, with no step taken for this stop yet.
  for (const [id, h] of Object.entries(holds)) {
    if (!h?.parked?.budget || h.parked.rescue) continue;
    const task = open.find((t) => t.id === id);
    if (!task || rescueOf(task.title)) continue;
    const hl = landing(id);
    if (hl) continue; // held or queued to land: not stuck
    const r = await fileRescue(id, h.parked.why, { now, env, waiting: launcher && !launcher.picking ? launcher.why : null });
    if (!r.shelved) setHold(id, { parked: { ...h.parked, rescue: r.id || 'person' } }, { by: 'watchdog', msg: r.id ? `rescue ${r.id} queued for ${id}` : `${id}: a person is needed (${r.person})` });
    if (r.id) actions.push({ kind: 'rescue', task: id, msg: `queued rescue step ${r.level} ${r.id} for ${id}${r.model ? ` on ${r.model}` : ''}` });
    else if (r.shelved) actions.push({ kind: 'shelve', task: id, msg: `${id} ${r.shelved}` });
    else {
      emitEvent({ type: 'agent.ask', agent: 'watchdog', to: 'producer', task: id, msg: `Needs you: ${String(h.parked.why || '').split('. ')[0]}; ${r.person}.` });
      actions.push({ kind: 'ask', task: id, msg: `asked a person about ${id}: ${r.person}` });
    }
  }
  return actions;
}
