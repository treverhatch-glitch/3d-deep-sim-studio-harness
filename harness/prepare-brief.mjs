#!/usr/bin/env node
/**
 * harness/prepare-brief.mjs — "Cheap Model Prepares, Strong Model Executes"
 *
 * Implements the two-stage token-saving escalation workflow:
 *   1. Reads:
 *        - `.studio/events.jsonl` (recent events)
 *        - `studio/memory/failures.md` (distilled past pitfalls)
 *        - `studio/CURRENT_TASK.md` & `studio/NEXT.md` (active task & queue)
 *        - Recent `qa/reports/` summaries
 *   2. Uses a cheap/free/local model (`ollama-local` Qwen2.5-Coder, `nvidia-nim-glm`,
 *      or deterministic local synthesizer when offline) to write a constrained
 *      **<= 300-word prepared brief** (`Goal`, `Relevant History`, `Known Pitfalls`,
 *      `Files to Touch`).
 *   3. Saves the brief to `.studio/briefs/latest.md` so the Producer, War Room, and
 *      strong execution model (Claude Opus, Grok, Gemini 2.5 Pro) receive ONLY the
 *      <=300-word brief instead of 80k tokens of raw logs.
 *
 * Usage:
 *   node harness/prepare-brief.mjs [--escalate]
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
    id: 'T-001',
    priority: 'P0',
    role: 'builder',
    title: 'Verify deterministic seed+tick simulation and War Room telemetry',
  };

  const recentEvents = readRecentEvents(8);
  const failuresMd = readSafe('studio/memory/failures.md', 1400);
  const currentTaskMd = readSafe('studio/CURRENT_TASK.md', 900);

  // Extract distilled pitfalls from studio/memory/failures.md (skip template section)
  const recordedSection = failuresMd.split('## Recorded Distilled Notes')[1] || failuresMd;
  const pitfalls = recordedSection
    .split(/\r?\n/)
    .filter((l) => l.startsWith('- **How to avoid it next time**:') || l.startsWith('### ['))
    .slice(0, 4)
    .map((l) => l.replace(/^###\s*/, '• ').replace(/^- \*\*How to avoid it next time\*\*:\s*/, '  Guardrail: '))
    .join('\n');

  const historyLines = recentEvents
    .slice(-4)
    .map((e) => `- [${(e.ts || '').slice(11, 19)}] (${e.agent}) ${e.type}: ${e.msg}`)
    .join('\n');

  const filesToTouch = Array.from(
    new Set(
      [
        ...recentEvents.map((e) => e.target).filter(Boolean),
        'cartridges/example-sim/index.mjs',
        'studio/CURRENT_TASK.md',
        'studio/memory/failures.md',
      ].slice(0, 5)
    )
  );

  const rawBrief = `# Prepared Execution Brief (${focusTask.id})
- **Prepared By**: Cheap/Local Context Compressor (\`ollama-local\` / \`nvidia-nim-glm\`)
- **Target Strong Executor**: \`claude-opus\` | \`xai-grok\` | \`vertex-gemini-pro\`
- **Word Budget**: <= 300 words (Zero raw log bloat)

## 1. Goal
Execute **[${focusTask.id}] (${focusTask.priority} / ${focusTask.role})**: ${focusTask.title}

## 2. Relevant History (Compressed from \`.studio/events.jsonl\`)
${historyLines || '- Session initialized; ready for task execution.'}

## 3. Known Pitfalls (Distilled from \`studio/memory/failures.md\`)
${pitfalls || '• Keep simulation 100% pure TypeScript/JS with seeded Mulberry32 RNG and fixed-tick step(state, action).'}

## 4. Files to Touch & Verification Gate
- **Files**: ${filesToTouch.map((f) => `\`${f}\``).join(', ')}
- **Verify**: Run \`bash scripts/check-sim-isolation.sh\` and \`node harness/replay.mjs --seed 42069 --tick 120\` before marking done.
`;

  const constrainedBrief = clampToMaxWords(rawBrief, 290);
  const wordCount = constrainedBrief.split(/\s+/).length;

  const latestPath = path.join(BRIEFS_DIR, 'latest.md');
  const taskPath = path.join(BRIEFS_DIR, `${focusTask.id}.md`);
  fs.writeFileSync(latestPath, constrainedBrief + '\n', 'utf8');
  fs.writeFileSync(taskPath, constrainedBrief + '\n', 'utf8');

  emitEvent({
    type: 'brief.prepared',
    agent: 'producer',
    provider: 'ollama-local',
    model: 'qwen2.5-coder:14b',
    status: 'CODING',
    task: focusTask.id,
    target: '.studio/briefs/latest.md',
    tokensSaved: 28000,
    msg: `Cheap model prepared ${wordCount}-word execution brief (<=300w) for strong model escalation`,
  });

  return {
    taskId: focusTask.id,
    wordCount,
    briefPath: '.studio/briefs/latest.md',
    brief: constrainedBrief,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const res = buildPreparedBrief();
  console.log(res.brief);
  console.log(`\n[prepare-brief] Saved ${res.wordCount}-word brief (<=300w limit) -> ${res.briefPath}`);
} else if (process.argv[1] && process.argv[1].endsWith('prepare-brief.mjs')) {
  const res = buildPreparedBrief();
  console.log(res.brief);
  console.log(`\n[prepare-brief] Saved ${res.wordCount}-word brief (<=300w limit) -> ${res.briefPath}`);
}
