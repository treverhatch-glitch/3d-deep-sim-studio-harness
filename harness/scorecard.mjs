#!/usr/bin/env node
/**
 * harness/scorecard.mjs — how each model is doing, from the event log. A script: no tokens.
 *
 *   npm run scorecard            table per model
 *   node harness/scorecard.mjs --json
 *
 * Per model:
 *   done, points      tasks it finished, and their difficulty (size 1-5; default by type, or --size on task add)
 *   bugs              confirmed: a bug task added with --caused-by <task it finished>, or a task of its reopened
 *   suspected         a closed-loop failure split across the models that finished code changes since the last pass
 *   per 10 points     confirmed bugs per 10 points of finished work, so hard work isn't punished for its size
 *   refused, forced   "done" refused by a done-check, and done forced past one
 *   handed back       tasks it handed back (out of usage, swapped, stuck)
 *
 * A model is whatever agents report (STUDIO_AGENT_MODEL, task start --model); "unknown" otherwise.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecentEvents } from './event.mjs';
import { parseNextQueue } from './task.mjs';
import { taskType } from './done-check.mjs';

export const DEFAULT_SIZE = { docs: 1, playtest: 1, fun: 1, review: 1, study: 2, balance: 2, change: 3, bug: 3, none: 0 };
const BUILDS = new Set(['change', 'bug']);

export function buildScorecard({ events = readRecentEvents(20000), queue = parseNextQueue() } = {}) {
  const tasks = new Map([...queue.inProgress, ...queue.backlog, ...queue.done].map((t) => [t.id, { ...t }]));
  const meta = new Map();
  const agentModel = new Map(); // agent -> latest model seen
  const closer = new Map(); // task -> { agent, model } of the last finish
  const startedBy = new Map(); // `${task}|${agent}` -> model at start
  const rows = new Map();
  const row = (model) => {
    const key = model || 'unknown';
    if (!rows.has(key)) rows.set(key, { model: key, agents: new Set(), done: 0, points: 0, bugs: 0, suspected: 0, refused: 0, forced: 0, handedBack: 0, bugTasks: [] });
    return rows.get(key);
  };
  const modelOf = (e) => e.model || startedBy.get(`${e.task}|${e.agent}`) || agentModel.get(e.agent) || 'unknown';
  const sizeOf = (id) => {
    const m = meta.get(id);
    if (m?.size) return m.size;
    const t = tasks.get(id);
    return t ? DEFAULT_SIZE[taskType(t)] ?? 2 : 2;
  };
  const isBuild = (id) => {
    const t = tasks.get(id);
    return t ? BUILDS.has(taskType(t)) : false;
  };

  const sinceFailureWindow = []; // build tasks finished since the last closed-loop pass or failure episode
  let inFailure = false;
  const bugLinks = [];

  for (const e of events) {
    if (e.agent && e.model) agentModel.set(e.agent, e.model);
    if (e.type === 'task.added' && e.task) {
      meta.set(e.task, e.meta || {});
      if (e.meta?.causedBy) bugLinks.push({ bug: e.task, causedBy: e.meta.causedBy });
    }
    if (e.type === 'task.start' && e.task) startedBy.set(`${e.task}|${e.agent}`, e.model || agentModel.get(e.agent) || null);
    if (e.type === 'task.done' && e.task) {
      const model = modelOf(e);
      closer.set(e.task, { agent: e.agent, model });
      const r = row(model);
      r.agents.add(e.agent);
      r.done += 1;
      r.points += sizeOf(e.task);
      if (isBuild(e.task)) sinceFailureWindow.push(model);
    }
    if (e.type === 'task.not_done') row(modelOf(e)).refused += 1;
    if (e.type === 'task.forced') row(modelOf(e)).forced += 1;
    if (e.type === 'task.paused' && e.agent !== 'watch') row(modelOf(e)).handedBack += 1;
    if (e.type === 'task.reopened' && closer.has(e.task)) {
      const c = closer.get(e.task);
      const r = row(c.model);
      r.bugs += 1;
      r.bugTasks.push(`${e.task} reopened`);
    }
    if (e.type === 'closedloop.pass') {
      inFailure = false;
      sinceFailureWindow.length = 0;
    }
    if ((e.type === 'closedloop.retry' || e.type === 'closedloop.escalate') && !inFailure && !/simulat/i.test(e.msg || '')) {
      inFailure = true;
      const suspects = [...sinceFailureWindow];
      sinceFailureWindow.length = 0;
      for (const m of suspects) row(m).suspected += 1 / suspects.length;
    }
  }
  for (const { bug, causedBy } of bugLinks) {
    const c = closer.get(causedBy);
    if (!c) continue;
    const r = row(c.model);
    r.bugs += 1;
    r.bugTasks.push(`${bug} (from ${causedBy})`);
  }

  const list = [...rows.values()]
    .filter((r) => r.done || r.bugs || r.suspected || r.refused || r.forced || r.handedBack)
    .map((r) => ({ ...r, agents: [...r.agents], suspected: Math.round(r.suspected * 10) / 10, per10: r.points ? Math.round((r.bugs / r.points) * 100) / 10 : null }))
    .sort((a, b) => (b.per10 ?? -1) - (a.per10 ?? -1) || b.bugs - a.bugs || b.done - a.done);
  return { at: new Date().toISOString(), models: list };
}

export function renderScorecard(sc) {
  if (!sc.models.length) return 'No finished work on record yet. Models appear once agents report them (STUDIO_AGENT_MODEL or task start --model).';
  const head = ['model', 'done', 'points', 'bugs', 'per 10 pts', 'suspected', 'refused', 'forced', 'handed back'];
  const rows = sc.models.map((m) => [m.model, m.done, m.points, m.bugs, m.per10 ?? '-', m.suspected || 0, m.refused, m.forced, m.handedBack]);
  const w = head.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => (i === 0 ? String(c).padEnd(w[i]) : String(c).padStart(w[i]))).join('  ');
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...rows.map(line)].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const sc = buildScorecard();
  if (process.argv.includes('--json')) console.log(JSON.stringify(sc, null, 2));
  else {
    console.log(renderScorecard(sc));
    console.log('\nbugs: confirmed (a bug added with --caused-by, or a task reopened). per 10 pts: bugs per 10 points of finished work.');
    console.log('suspected: closed-loop failures shared among models that finished code changes since the last clean pass.');
  }
}
