/**
 * harness/producer-log.mjs — read and add entries in studio/producer/LOG.md (newest first).
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, emitEvent } from './event.mjs';

export const LOG_FILE = path.join(REPO_ROOT, 'studio', 'producer', 'LOG.md');
const HEADER = `# Producer log (\`studio/producer/LOG.md\`)

> The Producer's notebook, newest first. One entry per session or decision: what changed, why,
> and what the next Producer should do. Add one with \`node harness/handoff.mjs note "…"\`.
> This is how a new Producer (another model, another tool) learns the reasons behind the plan.
`;

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Entries as { heading, when, who, body }, newest first. */
export function readLog() {
  if (!fs.existsSync(LOG_FILE)) return [];
  const text = fs.readFileSync(LOG_FILE, 'utf8').replace(/\r\n/g, '\n');
  return text
    .split(/^## /m)
    .slice(1)
    .map((chunk) => {
      const [heading, ...rest] = chunk.split('\n');
      const [when, who] = heading.split(' · ');
      return { heading: heading.trim(), when: (when || '').trim(), who: (who || '').trim(), body: rest.join('\n').trim() };
    });
}

export function addLogNote(text, agent = process.env.STUDIO_PRODUCER_NAME || process.env.STUDIO_LOCK_OWNER || 'producer') {
  const body = String(text || '').trim();
  if (!body) throw new Error('A log note needs text.');
  const existing = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').replace(/\r\n/g, '\n') : HEADER;
  const at = existing.search(/^## /m);
  const entry = `## ${stamp()} · ${agent}\n${body}\n\n`;
  const next = at === -1 ? `${existing.trimEnd()}\n\n${entry}` : `${existing.slice(0, at)}${entry}${existing.slice(at)}`;
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, next.trimEnd() + '\n');
  emitEvent({ type: 'producer.note', agent, msg: body.split('\n')[0].slice(0, 140) });
  return entry;
}
