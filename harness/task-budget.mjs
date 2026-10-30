#!/usr/bin/env node
/**
 * harness/task-budget.mjs — 2.31.0: a budget per task, across every session that works on it.
 *
 * The session cap (session-cap.mjs) refreshes a session at 40 turns or 120k context, and the stall check
 * (stall.mjs) ends one with no progress or past 90 min. Neither stops the same task being picked up
 * again and again: the launcher relaunches a refreshed session up to 5 times, the watchdog and the
 * Director's flow pass start new ones, and builders outside the harness re-claim it. A task could keep
 * one agent busy for 12 hours. This module adds up everything spent on one task since it was last
 * finished, reopened or unparked, and stops it when any limit is reached:
 *
 *   sessions  STUDIO_TASK_MAX_SESSIONS   6     launched sessions on the task, plus claims by agents the
 *                                              harness never launched (outside builders)
 *   minutes   STUDIO_TASK_MAX_MIN        240   time the task was claimed, summed over every claim
 *   tokens    STUDIO_TASK_MAX_TOKENS     10M   weighted tokens (cache reads at STUDIO_CACHE_READ_WEIGHT),
 *                                              from launched sessions and `task done --usage` reports
 *
 * 0 turns one limit off; STUDIO_TASK_BUDGET=off turns the whole check off. A task over budget is parked
 * (by "budget") with the numbers, the Producer and the War Room get "needs you", and it never starts
 * again until someone unparks it (`npm run task -- unpark <ID> --by <name>`), which also resets the count.
 *
 *   node harness/task-budget.mjs <TASK_ID> [--json]     what the task has spent, against its limits
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecentEvents, emitEvent } from './event.mjs';
import { weightedTokens } from './budget.mjs';
import { readHolds, setHold } from './task-hold.mjs';

const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const off = (env) => /^(off|0|false|no)$/i.test(String(env.STUDIO_TASK_BUDGET || ''));

export function taskBudgetLimits(env = process.env) {
  return {
    sessions: num(env.STUDIO_TASK_MAX_SESSIONS, 6),
    minutes: num(env.STUDIO_TASK_MAX_MIN, 240),
    tokens: num(env.STUDIO_TASK_MAX_TOKENS, 10_000_000),
  };
}

/** Events that start the count again: the task finished, was reopened, or a person unparked it. */
const isReset = (e) => ['task.done', 'task.forced', 'task.reopened', 'task.budget.reset'].includes(e.type) || (e.type === 'task.hold' && /unparked/.test(e.msg || ''));
const ENDS_CLAIM = new Set(['task.paused', 'task.done', 'task.forced', 'task.reopened']);

/**
 * What a task has spent since its last reset: { sessions, minutes, tokens, since }.
 * events: oldest first (readRecentEvents order).
 */
export function taskSpend(taskId, events = readRecentEvents(20000), now = Date.now()) {
  let start = 0;
  events.forEach((e, i) => { if (e.task === taskId && isReset(e)) start = i + 1; });
  const launched = new Set(events.filter((e) => e.type === 'agent.session.start').map((e) => e.agent));
  // Which task each launched agent is on, so a session's tokens land on the right task (session.end
  // events don't carry the task). Built over every event, counted only after the reset.
  const onTask = new Map();
  const open = new Map(); // claimant -> claim start (ms)
  const countedFor = new Map(); // launched agent -> its current session already counted for this task
  let sessions = 0;
  let tokens = 0;
  let ms = 0;
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    const at = Date.parse(e.ts) || 0;
    const counted = i >= start;
    if (e.type === 'agent.session.start') {
      onTask.set(e.agent, e.task || null);
      countedFor.set(e.agent, counted && e.task === taskId);
      if (counted && e.task === taskId) sessions += 1;
    }
    if (e.type === 'task.start' && e.agent) {
      if (launched.has(e.agent)) onTask.set(e.agent, e.task);
      if (counted && e.task === taskId) {
        // A launched session counts once, whether it started on the task or claimed it later; an outside
        // builder (never launched by the harness) counts each claim as a session.
        if (!launched.has(e.agent)) sessions += 1;
        else if (!countedFor.get(e.agent)) { sessions += 1; countedFor.set(e.agent, true); }
        if (!open.has(e.agent)) open.set(e.agent, at);
      }
    }
    if (counted && e.type === 'agent.session.end' && onTask.get(e.agent) === taskId) tokens += weightedTokens(e);
    if (counted && e.type === 'usage.reported' && e.task === taskId) tokens += (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0);
    if (e.task === taskId && ENDS_CLAIM.has(e.type)) {
      if (counted) for (const t of open.values()) ms += Math.max(0, at - t);
      open.clear();
    }
  }
  for (const t of open.values()) ms += Math.max(0, now - t);
  return { sessions, minutes: Math.round(ms / 60000), tokens: Math.round(tokens), since: start > 0 ? events[start - 1]?.ts || null : null };
}

/** { over, why, spend, limits }. why names the first limit reached, in plain words. */
export function overBudget(taskId, { events, now = Date.now(), env = process.env } = {}) {
  const limits = taskBudgetLimits(env);
  if (off(env)) return { over: false, why: null, spend: null, limits };
  const spend = taskSpend(taskId, events || readRecentEvents(20000), now);
  const hits = [];
  if (limits.sessions > 0 && spend.sessions >= limits.sessions) hits.push(`${spend.sessions} sessions (limit ${limits.sessions})`);
  if (limits.minutes > 0 && spend.minutes >= limits.minutes) hits.push(`${spend.minutes} min claimed (limit ${limits.minutes})`);
  if (limits.tokens > 0 && spend.tokens >= limits.tokens) hits.push(`${(spend.tokens / 1e6).toFixed(1)}M tokens (limit ${(limits.tokens / 1e6).toFixed(1)}M)`);
  return { over: hits.length > 0, why: hits.length ? `${taskId} has used its budget: ${hits.join(', ')}` : null, spend, limits };
}

/**
 * Park a task that is over budget, once. Returns the reason when it parked (or was already parked by
 * the budget), null when the task is within budget.
 */
export function stopIfOverBudget(taskId, { by = 'budget', events, now = Date.now() } = {}) {
  if (!taskId) return null;
  const b = overBudget(taskId, { events, now });
  if (!b.over) return null;
  const held = readHolds()[taskId]?.parked;
  if (held?.budget) return held.why;
  const why = `${b.why}. A rescue on another model looks first (it retries, splits or asks a person); a person can also split it, fix the blocker or raise the limit, then npm run task -- unpark ${taskId} --by <name>`;
  setHold(taskId, { parked: { by: 'budget', why, budget: true, spend: b.spend, at: new Date(now).toISOString() } }, { by, msg: `Parked ${taskId}: ${why}` });
  emitEvent({ type: 'task.budget', agent: by, to: 'producer', task: taskId, status: 'blocked', msg: `${taskId} stopped: ${b.why}`, meta: { spend: b.spend, limits: b.limits } });
  // 2.35.0: a rescue on a different model comes first (the watchdog's next pass files it, harness/rescue.mjs);
  // a person is asked here only when rescues are off.
  if (/^(off|0|false|no)$/i.test(process.env.STUDIO_RESCUE || '')) emitEvent({ type: 'agent.ask', agent: by, to: 'producer', task: taskId, msg: `Needs you: ${b.why}. It is parked until someone unparks it.` });
  return why;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const id = process.argv[2];
  if (!id || !/^[A-Z]+-\d+$/.test(id)) {
    console.error('Usage: node harness/task-budget.mjs <TASK_ID> [--json]');
    process.exit(1);
  }
  const b = overBudget(id);
  if (process.argv.includes('--json')) console.log(JSON.stringify(b));
  else if (!b.spend) console.log('Task budgets are off (STUDIO_TASK_BUDGET=off).');
  else {
    const l = b.limits;
    console.log(`${id} since ${b.spend.since || 'it was added'}: ${b.spend.sessions}/${l.sessions || '∞'} sessions, ${b.spend.minutes}/${l.minutes || '∞'} min, ${(b.spend.tokens / 1e6).toFixed(2)}M/${l.tokens ? `${(l.tokens / 1e6).toFixed(1)}M` : '∞'} tokens.${b.over ? ` OVER: ${b.why}` : ''}`);
  }
  process.exit(b.over ? 3 : 0);
}
