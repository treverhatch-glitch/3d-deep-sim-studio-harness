/**
 * harness/cause-store.mjs — why forced tasks were forced, grouped, and which causes a person accepted.
 * Kept apart from harness/causes.mjs so harness/task.mjs can read it without an import cycle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './event.mjs';

export const ACCEPTED_FILE = path.join(REPO_ROOT, 'studio', 'decisions', 'accepted-causes.json');

/** The cause behind a missing check, without the task-specific parts, so the same cause groups. */
export const causeOf = (missing) =>
  String(missing || 'unknown')
    .replace(/\bT-\d+\b/g, 'T-…')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);

export function readAccepted() {
  try {
    return JSON.parse(fs.readFileSync(ACCEPTED_FILE, 'utf8')).accepted || [];
  } catch {
    return [];
  }
}
export const isAccepted = (cause) => readAccepted().some((a) => a.cause === cause);

/** Open "Check forced done" tasks, grouped by cause. */
export function forcedGroups(queue) {
  const groups = new Map();
  for (const t of [...queue.inProgress, ...queue.backlog]) {
    const m = t.title.match(/^Check forced done (.+?) \(([^)]+)\): (.+)$/);
    if (!m) continue;
    const cause = causeOf(m[3]);
    const g = groups.get(cause) || { cause, tasks: [], checks: [] };
    g.tasks.push(...m[1].split(/,\s*/).filter((x) => /^T-\d+$/.test(x)));
    g.checks.push(t.id);
    groups.set(cause, g);
  }
  return [...groups.values()];
}

