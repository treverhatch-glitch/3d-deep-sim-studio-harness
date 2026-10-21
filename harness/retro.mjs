#!/usr/bin/env node
/**
 * harness/retro.mjs — the studio writes its own retrospective. A script: no model, no tokens.
 *
 *   npm run retro                  write studio/memory/retros/<today>.md from the last 24 hours
 *   node harness/retro.mjs --hours 72
 *
 * It reads what actually happened (refused and forced "done"s, hand-backs, watcher findings, bugs,
 * closed-loop failures, gate results, meetings, the model scorecard) and turns repeating patterns into
 * suggestions: which skill to tighten, which tasks are too big, which model to route away from.
 * The Producer reads them in the briefing and accepts or rejects each one in its log. That is how
 * the studio improves itself without spending tokens on watching.
 *
 * The HUB writes one a day on its own; npm run session:start writes one if today's is missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, readRecentEvents, emitEvent } from './event.mjs';
import { parseNextQueue } from './task.mjs';
import { taskType } from './done-check.mjs';
import { buildScorecard } from './scorecard.mjs';

export const RETRO_DIR = path.join(REPO_ROOT, 'studio', 'memory', 'retros');
const today = () => new Date().toISOString().slice(0, 10);

export function latestRetro() {
  if (!fs.existsSync(RETRO_DIR)) return null;
  const f = fs.readdirSync(RETRO_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().pop();
  return f ? { file: `studio/memory/retros/${f}`, date: f.slice(0, 10), text: fs.readFileSync(path.join(RETRO_DIR, f), 'utf8') } : null;
}

export function buildRetro({ hours = 24 } = {}) {
  const since = Date.now() - hours * 3600 * 1000;
  const events = readRecentEvents(20000).filter((e) => Date.parse(e.ts) >= since);
  const q = parseNextQueue();
  const byId = new Map([...q.inProgress, ...q.backlog, ...q.done].map((t) => [t.id, t]));
  const count = (type) => events.filter((e) => e.type === type);
  const typeOf = (id) => (byId.get(id) ? taskType(byId.get(id)) : 'unknown');

  const done = count('task.done');
  const refused = count('task.not_done');
  const forced = count('task.forced');
  const paused = count('task.paused');
  const reopened = count('task.reopened');
  const watch = events.filter((e) => e.type === 'watch.alert' || e.type === 'watch.report');
  const loopFails = events.filter((e) => e.type === 'closedloop.retry' || e.type === 'closedloop.escalate').filter((e) => !/simulat/i.test(e.msg || ''));
  const escalated = loopFails.filter((e) => e.type === 'closedloop.escalate');
  const capped = count('route.capped');
  const exhausted = count('route.exhausted');
  const meetings = count('meeting.end');

  const tally = (list, key) => list.reduce((m, x) => m.set(key(x), (m.get(key(x)) || 0) + 1), new Map());
  const refusedByType = tally(refused, (e) => typeOf(e.task));
  const refusedWhy = tally(refused, (e) => String(e.msg || '').replace(/^T-\d+ not done yet: /, '').replace(/ \(.*\)$/, ''));
  const forcedByType = tally(forced, (e) => e.meta?.type || typeOf(e.task));
  const usageWords = /usage|quota|limit|credits|out of/i;
  const outOfUsage = paused.filter((e) => usageWords.test(e.msg || ''));

  const suggestions = [];
  const skillFile = (t) => ({ change: 'builder', docs: 'docs', fun: 'playtest' }[t] || t);
  for (const [t, n] of refusedByType) {
    if (n >= 2 && t !== 'unknown') {
      const why = [...refusedWhy.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      suggestions.push(`Agents tried to finish ${n} "${t}" tasks before the proof existed (most often: ${why}). Put that step earlier and in bold in studio/skills/${skillFile(t)}.md.`);
    }
  }
  for (const [t, n] of forcedByType) if (n >= 2) suggestions.push(`${n} "${t}" tasks were forced past their check. Ask why in a meeting: either the check is wrong for this work or agents are skipping it.`);
  if (outOfUsage.length >= 2) suggestions.push(`${outOfUsage.length} tasks were handed back because an agent ran out of usage. Split work into smaller tasks (size 3 or less), or give those roles a model with more headroom.`);
  else if (paused.length >= 3) suggestions.push(`${paused.length} tasks were handed back. Check the notes in studio/handoffs/ for a shared cause; the tasks may be too big or unclear.`);
  if (reopened.length) suggestions.push(`${reopened.length} finished task(s) were reopened. Add what was missed to the matching skill's "Done means", so the check catches it next time.`);
  if (escalated.length) suggestions.push(`${escalated.length} bug(s) escalated after 3 tries. After the fix, the lesson goes into studio/memory/failures.md (the bug done-check requires it).`);
  if (watch.some((e) => /silent/.test(e.msg || ''))) suggestions.push('Agents went silent while holding work. Make sure every agent sets STUDIO_AGENT_MODEL and hands work back with task pause before it stops.');
  if (capped.length) suggestions.push(`The daily spend cap stopped ${capped.length} model call(s). Raise STUDIO_DAILY_TOKEN_CAP on purpose, or move routine work to a cheaper model.`);
  if (exhausted.length >= 2) suggestions.push(`Every provider was busy or out ${exhausted.length} times. Add a fallback provider or a second key for the roles that hit it.`);

  const sc = buildScorecard().models.filter((m) => m.done >= 2);
  const worst = sc.filter((m) => m.bugs + (m.traced || 0) >= 2 && m.per10 != null).sort((a, b) => b.per10 - a.per10)[0];
  const avg = sc.length ? sc.reduce((s, m) => s + (m.per10 || 0), 0) / sc.length : 0;
  if (worst && worst.per10 > avg * 1.5) suggestions.push(`${worst.model} has ${worst.bugs + (worst.traced || 0)} bugs (confirmed or traced), ${worst.per10} per 10 points against a studio average of ${Math.round(avg * 10) / 10}. Consider routing code changes away from it, or pairing it with a review task.`);

  return {
    date: today(),
    hours,
    numbers: { done: done.length, refused: refused.length, forced: forced.length, handedBack: paused.length, reopened: reopened.length, closedLoopFailures: loopFails.length, escalated: escalated.length, watcherFindings: watch.length, meetings: meetings.length, spendCapped: capped.length },
    refusedWhy: [...refusedWhy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    handbacks: paused.slice(-5).map((e) => `${e.task} by ${e.agent}: ${e.msg}`),
    suggestions,
    scorecard: sc,
  };
}

export function writeRetro(opts) {
  const r = buildRetro(opts);
  const n = r.numbers;
  const md = `# Retro ${r.date} (last ${r.hours} hours)

> Written by \`harness/retro.mjs\` from the event log: a script, no model. The Producer reads the
> suggestions in \`npm run handoff\` and accepts or rejects each in \`studio/producer/LOG.md\`.

## What happened

- Finished: ${n.done}. Refused by a done-check: ${n.refused}. Forced: ${n.forced}. Reopened: ${n.reopened}.
- Handed back: ${n.handedBack}. Watcher findings: ${n.watcherFindings}. Meetings: ${n.meetings}.
- Closed-loop failures: ${n.closedLoopFailures} (escalated: ${n.escalated}). Calls stopped by the spend cap: ${n.spendCapped}.

## Why "done" was refused

${r.refusedWhy.map(([why, k]) => `- ${k}× ${why}`).join('\n') || '- Nothing was refused.'}

## Hand-backs

${r.handbacks.map((h) => `- ${h}`).join('\n') || '- None.'}

## Suggestions

${r.suggestions.map((s) => `- [ ] ${s}`).join('\n') || '- [ ] Nothing repeated often enough to suggest a change.'}

## Models (two or more finished tasks)

${r.scorecard.map((m) => `- ${m.model}: ${m.done} done, ${m.points} pts, ${m.bugs} bugs (${m.per10 ?? '–'} per 10 pts), ${m.refused} refused, ${m.forced} forced, ${m.handedBack} handed back`).join('\n') || '- Not enough finished work yet.'}
`;
  fs.mkdirSync(RETRO_DIR, { recursive: true });
  const file = path.join(RETRO_DIR, `${r.date}.md`);
  fs.writeFileSync(file, md);
  emitEvent({ type: 'retro.written', agent: 'watch', msg: `Retro ${r.date}: ${r.suggestions.length} suggestion(s)` });
  return { ...r, file: path.relative(REPO_ROOT, file) };
}

/** Write today's retro unless one was written in the last `minHours`. */
export function retroIfDue(minHours = 20) {
  const last = latestRetro();
  // Never rewrite a day that already has a retro: the files are committed, and a rewrite showed up as a
  // changed file in agents' hand-backs (Jed's run). A checkout also resets mtimes, so go by the date too.
  if (last && last.date >= new Date().toISOString().slice(0, 10)) return null;
  const lastAt = last ? fs.statSync(path.join(REPO_ROOT, last.file)).mtimeMs : 0;
  return Date.now() - lastAt > minHours * 3600 * 1000 ? writeRetro() : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const i = process.argv.indexOf('--hours');
  const r = process.argv.includes('--if-due') ? retroIfDue() : writeRetro({ hours: i >= 0 ? Number(process.argv[i + 1]) || 24 : 24 });
  if (!r) console.log('[retro] one was written recently; skipping (drop --if-due to force)');
  else {
    console.log(`[retro] wrote ${r.file}: ${r.suggestions.length} suggestion(s)`);
    for (const s of r.suggestions) console.log(`  - ${s}`);
  }
}
