#!/usr/bin/env node
/**
 * harness/status.mjs — Zero-Token Studio Status Snapshot
 *
 * Reads `.studio/events.jsonl`, `.studio/cooldowns.json`, `studio/NEXT.md`,
 * and `studio/roles/` locally without calling any LLM. Solves the "Full-Context
 * Re-Read Tax" caused by asking an agent "What are you doing?".
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecentEvents } from './event.mjs';
import { parseNextQueue } from './task.mjs';
import { loadAllRoles, loadPresets } from './agents.mjs';
import { getRouterMatrix } from './route.mjs';

export function buildStudioSnapshot() {
  const events = readRecentEvents(200);
  const queue = parseNextQueue();
  const roles = loadAllRoles();
  const presets = loadPresets();
  const router = getRouterMatrix('producer');

  const totals = events.reduce(
    (acc, e) => {
      acc.tokensIn += Number(e.tokensIn || 0);
      acc.tokensOut += Number(e.tokensOut || 0);
      acc.tokensSaved += Number(e.tokensSaved || 0);
      if (e.type === 'route.failover') acc.failovers += 1;
      if (e.type === 'qa.bug' || e.status === 'error') acc.errors += 1;
      return acc;
    },
    { tokensIn: 0, tokensOut: 0, tokensSaved: 0, failovers: 0, errors: 0 }
  );

  // Estimate avoided check-in tax (each passive check-in saves ~45,000 input tokens of history re-read)
  const checkInTaxAvoided = Math.max(events.length * 4200, totals.tokensSaved);

  return {
    generatedAt: new Date().toISOString(),
    llmTokensUsedForStatus: 0,
    producerPreset: process.env.STUDIO_PRODUCER_PRESET || 'auto',
    rolesCount: roles.length,
    roles,
    presets,
    queue,
    router,
    telemetry: {
      totalEvents: events.length,
      ...totals,
      estimatedTokensSaved: checkInTaxAvoided,
    },
    recentEvents: events.slice(-25).reverse(),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const snap = buildStudioSnapshot();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(snap, null, 2));
    process.exit(0);
  }

  console.log('====================================================================');
  console.log(' 3D DEEP-SIM AI STUDIO — PASSIVE STATUS (0 LLM TOKENS CONSUMED)');
  console.log('====================================================================');
  console.log(` Producer Preset : ${snap.producerPreset} (${snap.rolesCount} roles loaded)`);
  console.log(` Active Tasks    : ${snap.queue.inProgress.length} in progress | ${snap.queue.backlog.length} backlog | ${snap.queue.done.length} done`);
  if (snap.queue.inProgress[0]) {
    const t = snap.queue.inProgress[0];
    console.log(` Current Focus   : [${t.id}] (${t.role}) ${t.title}`);
  } else if (snap.queue.backlog[0]) {
    const t = snap.queue.backlog[0];
    console.log(` Next Up         : [${t.id}] (${t.role}) ${t.title}`);
  }
  console.log(` Token Telemetry : ${snap.telemetry.tokensIn} in / ${snap.telemetry.tokensOut} out | ~${snap.telemetry.estimatedTokensSaved.toLocaleString()} saved | ${snap.telemetry.failovers} failovers`);
  console.log('--------------------------------------------------------------------');
  console.log(' Recent Events (.studio/events.jsonl):');
  for (const e of snap.recentEvents.slice(0, 6)) {
    console.log(`  [${e.ts.slice(11, 19)}] (${e.agent}) ${e.type}: ${e.msg}`);
  }
  console.log('====================================================================');
}
