#!/usr/bin/env node
// Rolls the day's events and studio/NEXT.md into studio/daily/<date>.md.
//   node scripts/daily-summary.mjs [YYYY-MM-DD]
// Token numbers come only from measured agent.session.end events; nothing is estimated here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const date = process.argv[2] || new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Usage: node scripts/daily-summary.mjs [YYYY-MM-DD]');
  process.exit(2);
}
const read = (p) => (fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : '');
const events = read('.studio/events.jsonl')
  .split(/\r?\n/)
  .filter((l) => l.includes(date))
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((e) => e && String(e.ts || '').startsWith(date));

const ends = events.filter((e) => e.type === 'agent.session.end');
const sum = (f) => ends.reduce((s, e) => s + (Number(f(e)) || 0), 0);
const fmt = (n) => n.toLocaleString('en-US');
const tokensIn = sum((e) => e.tokensIn);
const tokensOut = sum((e) => e.tokensOut);
const cacheRead = sum((e) => e.meta?.cacheRead);
const done = events.filter((e) => e.type === 'task.done').length;
const recent = events.slice(-10).map((e) => `- \`${String(e.ts).slice(11, 19)}\` **${e.agent}** (\`${e.type}\`): ${e.msg || ''}`);

const md = `# Daily studio summary: ${date}

Written by \`scripts/daily-summary.mjs\` from \`.studio/events.jsonl\`.

## What happened

- Events: ${events.length}
- Tasks done: ${done}
- Agent sessions ended: ${ends.length}
- Measured tokens from those sessions: ${ends.length ? `${fmt(tokensIn)} in, ${fmt(tokensOut)} out, ${fmt(cacheRead)} cache reads` : 'none recorded (not measured)'}

${recent.length ? recent.join('\n') : '- No events recorded on this day.'}

## Task queue (\`studio/NEXT.md\`)

${read('studio/NEXT.md').trim() || '(empty)'}

## Before and after

Put clips in \`studio/daily/videos/\` (for example \`${date}-before.mp4\` and \`${date}-after.mp4\`) and the seed and tick that reproduce them.

## Links

- Failure notes: [\`studio/memory/failures.md\`](../memory/failures.md)
- Playtest reports: \`qa/reports/\`
`;
fs.mkdirSync(path.join(ROOT, 'studio', 'daily', 'videos'), { recursive: true });
const out = path.join(ROOT, 'studio', 'daily', `${date}.md`);
fs.writeFileSync(out, md);
console.log(`[daily-summary] Wrote ${path.relative(ROOT, out)}`);
