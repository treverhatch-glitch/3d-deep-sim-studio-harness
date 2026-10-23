#!/usr/bin/env node
/**
 * harness/token-norms.mjs — per-task-type token usage norms and outliers (2.30g). Flags only: nothing is ever capped or blocked.
 *
 * A "cost unit" is a blend of input, output, and cache-read tokens, with cache reads
 * weighted at 10% (they are much cheaper). This script calculates the median and
 * Median Absolute Deviation (MAD) of cost units for each task type, providing a
 * baseline for "normal" token consumption. Sessions far outside this norm are flagged
 * as outliers for review, but are not blocked.
 */
import { pathToFileURL } from 'node:url';
import { readRecentEvents } from './event.mjs';

function getTaskTypes(events) {
  const taskTypes = new Map();
  for (const e of events) {
    if (e.type === 'task.added' && e.task) {
      if (e.meta?.type) taskTypes.set(e.task, e.meta.type);
    }
  }
  return taskTypes;
}

function getSessionData(events) {
  const taskTypes = getTaskTypes(events);
  const sessionStarts = new Map();
  for (const e of events) {
    if (e.type === 'agent.session.start') sessionStarts.set(e.agent, e);
  }

  const sessions = [];
  for (const e of events) {
    if (e.type !== 'agent.session.end') continue;
    const start = sessionStarts.get(e.agent);
    const role = e.meta?.role || start?.meta?.role || 'unknown';
    const task = e.task || start?.task;
    const type = e.meta?.taskType || (task ? taskTypes.get(task) : null) || role;
    const units = (e.tokensIn || 0) + (e.tokensOut || 0) + 0.1 * (e.meta?.cacheRead || 0);
    if (units > 0) {
      sessions.push({ agent: e.agent, task, type, units, at: e.ts });
    }
  }
  return sessions;
}

const median = (arr) => {
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  const nums = [...arr].sort((a, b) => a - b);
  return arr.length % 2 !== 0 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
};

export function tokenNorms({ events }) {
  const sessions = getSessionData(events || readRecentEvents(50000));
  const byType = {};
  for (const s of sessions) {
    byType[s.type] ||= [];
    byType[s.type].push(s.units);
  }

  const norms = {};
  for (const type in byType) {
    const units = byType[type];
    if (units.length < 5) continue;
    const med = median(units);
    const deviations = units.map(u => Math.abs(u - med));
    const mad = median(deviations);
    norms[type] = { n: units.length, median: med, mad };
  }
  return norms;
}

export function outliers({ events, k = 3, minN = 5 }) {
  const allEvents = events || readRecentEvents(50000);
  const norms = tokenNorms({ events: allEvents });
  const sessions = getSessionData(allEvents);
  const result = [];

  for (const s of sessions) {
    const norm = norms[s.type];
    if (!norm || norm.n < minN) continue;
    const threshold = norm.median + k * Math.max(norm.mad, 0.25 * norm.median);
    if (s.units > threshold) {
      result.push({
        agent: s.agent,
        task: s.task,
        type: s.type,
        units: s.units,
        median: norm.median,
        ratio: norm.median > 0 ? s.units / norm.median : Infinity,
      });
    }
  }
  return result.sort((a, b) => b.ratio - a.ratio);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  const norms = tokenNorms({});
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ norms, outliers: outliers({}) }, null, 2));
  } else {
    console.log('Token Usage Norms (cost units = in + out + 0.1*cacheRead)');
    console.log('Task Type'.padEnd(24) + 'N'.padStart(8) + 'Median'.padStart(12) + 'MAD'.padStart(12));
    for (const [type, norm] of Object.entries(norms)) {
      console.log(
        type.padEnd(24) +
        String(norm.n).padStart(8) +
        Math.round(norm.median).toLocaleString().padStart(12) +
        Math.round(norm.mad).toLocaleString().padStart(12)
      );
    }
    console.log('\nOutliers (units > median + 3 * max(MAD, 0.25*median))');
    const outs = outliers({});
    if (outs.length) {
      for (const o of outs.slice(0, 20)) {
        console.log(`- ${o.agent} on ${o.task || 'taskless'} (${o.type}): ${Math.round(o.units).toLocaleString()} units, ${o.ratio.toFixed(1)}x median`);
      }
    } else {
      console.log('None found.');
    }
  }
}
