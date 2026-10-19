#!/usr/bin/env node
/**
 * harness/prepare-brief.mjs
 * Builds a short brief from local files.
 * This default path is a TEMPLATE synthesizer. It does not call a model
 * and must not claim model usage or token savings.
 */

import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents, emitEvent } from './event.mjs';
import { parseNextQueue } from './task.mjs';

const BRIEFS_DIR = path.join(STUDIO_STATE_DIR, 'briefs');
fs.mkdirSync(BRIEFS_DIR, { recursive: true });

function readSafe(relPath, maxChars = 1800) {
  const full = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(full)) return '';
  return fs.readFileSync(full, 'utf8').slice(0, maxChars);
}

function clampToMaxWords(text, maxWords = 300) {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(' ') + ' ...';
}

export function buildPreparedBrief() {
  const queue = parseNextQueue();
  const focusTask = queue.inProgress[0] || queue.backlog[0] || {
    id: 'T-000',
    priority: 'P1',
    role: 'builder',
    title: 'No active task',
  };

  const recentEvents = readRecentEvents(8);
  const failuresMd = readSafe('studio/memory/failures.md', 1400);
  const historyLines = recentEvents
    .slice(-4)
    .map((e) => `- [${(e.ts || '').slice(11, 19)}] (${e.agent}) ${e.type}: ${e.msg}`)
    .join('\n');

  const rawBrief = `# Prepared Execution Brief (${focusTask.id})
- **Prepared By**: template (no model called)
- **Mode**: local file synthesis
- **Word Budget**: <= 300 words

## 1. Goal
[${focusTask.id}] (${focusTask.priority} / ${focusTask.role}): ${focusTask.title}

## 2. Relevant History
${historyLines || '- No recent events.'}

## 3. Known Pitfalls
${failuresMd ? failuresMd.slice(0, 500) : '- None recorded.'}

## 4. Verify
- bash scripts/check-sim-isolation.sh
- node harness/replay.mjs --trace .studio/last-seed-failure.json
`;

  const constrainedBrief = clampToMaxWords(rawBrief, 290);
  const wordCount = constrainedBrief.split(/\s+/).length;
  const latestPath = path.join(BRIEFS_DIR, 'latest.md');
  fs.writeFileSync(latestPath, constrainedBrief + '\n', 'utf8');

  emitEvent({
    type: 'brief.prepared',
    agent: 'producer',
    provider: 'template',
    model: 'none',
    status: 'IDLE',
    task: focusTask.id,
    target: '.studio/briefs/latest.md',
    tokensSaved: 0,
    msg: `Template brief prepared (${wordCount} words). No model called; savings not measured.`,
  });

  return {
    taskId: focusTask.id,
    wordCount,
    mode: 'template',
    briefPath: '.studio/briefs/latest.md',
    brief: constrainedBrief,
  };
}

if (process.argv[1] && process.argv[1].endsWith('prepare-brief.mjs')) {
  const res = buildPreparedBrief();
  console.log(res.brief);
  console.log(`\n[prepare-brief] mode=template words=${res.wordCount} path=${res.briefPath}`);
}
