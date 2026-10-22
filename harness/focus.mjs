#!/usr/bin/env node
/**
 * harness/focus.mjs — one page an agent reads instead of the repo. A script: no tokens.
 *
 *   npm run focus -- T-003 [--agent claude-a]     write and print .studio/briefs/T-003.md
 *
 * `task start` writes it for you. It holds only what this task needs: what done means and the
 * skill's steps, notes from whoever worked on it before, what you hold and what others hold (don't
 * touch), what the game says is off-limits, lessons that match the task, the state of the gates,
 * and the exact commands to finish or hand back. Small context, focused agent, fewer tokens.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents } from './event.mjs';
import { parseNextQueue, readTaskHandoff } from './task.mjs';
import { listLocks } from './lock.mjs';
import { checkDone } from './done-check.mjs';
import { DEFAULT_SIZE } from './scorecard.mjs';
import { readAttached } from './cheatsheet.mjs';
import { HANDOFF_MAX } from './session-cap.mjs';

const read = (rel) => {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
};
const part = (text, label) => (text?.match(new RegExp(`\\*\\*${label}\\.?\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*[A-Z][^*]*\\*\\*|$)`)) || [, ''])[1].trim();
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'when', 'then', 'task', 'tasks', 'add', 'fix', 'bug', 'study', 'docs', 'review', 'balance', 'playtest', 'our', 'your', 'run', 'one', 'new']);

export function buildFocus(taskId, agent = null) {
  const q = parseNextQueue();
  const task = [...q.inProgress, ...q.backlog, ...q.done].find((t) => t.id === taskId);
  if (!task) return null;
  const check = checkDone(task);
  const skill = check.skill ? read(check.skill) : null;
  const events = readRecentEvents(5000);
  const added = events.find((e) => e.type === 'task.added' && e.task === taskId);
  const size = added?.meta?.size || DEFAULT_SIZE[check.type] || 2;
  const causedBy = added?.meta?.causedBy || null;
  const locks = listLocks();
  const mine = agent ? locks.filter((l) => l.owner === agent) : [];
  const others = locks.filter((l) => l.owner !== agent && l.key.startsWith('path:'));
  const game = read('studio/game/GAME.md');
  const offLimits = game?.match(/\*\*Off-limits\*\*[^:]*:\s*(.+)/)?.[1];
  const words = [...new Set(task.title.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || [])].filter((w) => !STOP.has(w));
  const lessons = ((read('studio/memory/failures.md') || '').split('## Recorded Distilled Notes')[1] || '')
    .split(/^### /m)
    .slice(1)
    .map((l) => ({ text: l.trim(), hits: words.filter((w) => l.toLowerCase().includes(w)).length }))
    .filter((l) => l.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 2);
  const gates = (() => {
    try {
      return JSON.parse(read('.studio/gates-last.json'));
    } catch {
      return null;
    }
  })();
  const red = gates ? (gates.rows || []).filter((r) => r.required && !r.ok).map((r) => r.id) : [];
  const meetingNotes = fs.existsSync(path.join(REPO_ROOT, 'studio', 'meetings'))
    ? fs.readdirSync(path.join(REPO_ROOT, 'studio', 'meetings')).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => read(`studio/meetings/${f}`)).filter((t) => t && t.includes(taskId))
    : [];
  // Who this role is, the refusals agents in this role hit most, and lessons filed for the role.
  const roleText = read(`studio/roles/${task.role}.md`) || '';
  const identity = (roleText.split(/^## Who you are\s*$/m)[1] || '').split(/^## /m)[0].trim();
  const sig = (m) => String(m).replace(/\bT-\d+\b/g, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const refusals = new Map();
  const roleOf = new Map(events.filter((e) => e.type === 'task.added' && e.task).map((e) => [e.task, (e.msg.match(/\(([^)]+)\):/) || [])[1]]));
  for (const e of events.filter((x) => x.type === 'task.not_done' && roleOf.get(x.task) === task.role && x.msg)) {
    const why = e.msg.replace(/^T-\d+ not done yet:\s*/, '');
    const k = sig(why);
    refusals.set(k, { why, n: (refusals.get(k)?.n || 0) + 1 });
  }
  const roleRefusals = [...refusals.values()].sort((a, b) => b.n - a.n).slice(0, 3);
  const roleLessons = ((read('studio/memory/failures.md') || '').split('## Recorded Distilled Notes')[1] || '')
    .split(/^### /m)
    .slice(1)
    .filter((l) => new RegExp(`^- \\*\\*Role\\*\\*:.*\\b${task.role.replace(/[-]/g, '\\-')}\\b`, 'mi').test(l))
    .slice(-2)
    .map((l) => l.trim());
  const voice = (() => {
    try {
      return JSON.parse(read('studio/bible/bible.json') || 'null')?.voice || null;
    } catch {
      return null;
    }
  })();
  const preparedRel = `.studio/briefs/${taskId}.prepared.md`;
  const prepared = fs.existsSync(path.join(REPO_ROOT, preparedRel)) ? preparedRel : null;
  const historyWords = events.filter((e) => e.task === taskId && e.msg).reduce((n, e) => n + String(e.msg).split(/\s+/).length, 0);
  return { task, check, skill, size, causedBy, handoff: readTaskHandoff(taskId), tricks: readAttached(taskId)?.tricks || [], tricksBy: readAttached(taskId)?.preapproved?.approvedBy || null, mine, others, offLimits, lessons, gates, red, meetingNotes, agent, prepared, historyWords, identity, roleRefusals, roleLessons, voice };
}

export function renderVoice(v) {
  return [v.tone ? `- Tone: ${v.tone}` : '', ...(v.do || []).map((x) => `- Do: ${x}`), ...(v.dont || []).map((x) => `- Don't: ${x}`), ...(v.never || []).length ? [`- Never say: ${v.never.join(', ')}`] : [], ...(v.examples || []).map((x) => `- Sounds like: "${x}"`)].filter(Boolean).join('\n');
}

export function renderFocus(f) {
  const a = f.agent || '<you>';
  const L = [];
  L.push(`# Focus: ${f.task.id} ${f.task.title}`, '');
  L.push(`${f.task.priority}, size ${f.size} of 5, a "${f.check.type}" task for \`${f.task.role}\`${f.causedBy ? `. It is a bug traced to ${f.causedBy}` : ''}. Read this page instead of the repo; open other files only when a step needs them.`);
  if (f.identity) L.push('', `## Who you are (studio/roles/${f.task.role}.md)`, f.identity);
  L.push('', '## Done means', `${f.check.means}.${f.check.ok ? ' (Already true; confirm before you finish.)' : ''}`);
  if (f.roleRefusals?.length) L.push('', `## Where \`${f.task.role}\` agents get refused most`, ...f.roleRefusals.map((r) => `- ${r.n}x: ${r.why}`), 'Do these before you run done.');
  if (f.skill) {
    const steps = part(f.skill, 'Steps');
    const never = part(f.skill, 'Never');
    if (steps) L.push('', `## Steps (${f.check.skill})`, steps);
    if (never) L.push('', '## Never', never);
  }
  if (f.prepared) L.push('', '## Prepared brief', `A short summary of this task's history is in \`${f.prepared}\`. Read it instead of the event log.`);
  else if (f.historyWords >= Number(process.env.STUDIO_PREPARE_MIN_WORDS || 500)) L.push('', '## Long history', `This task has ${f.historyWords} words of history. Run \`npm run brief -- ${f.task.id}\` for a 300-word summary (a cheap or local model drafts it, a script checks it).`);
  if (f.handoff) {
    // 2.29.2: the carry-forward is the newest notes, at most 3k characters (test #4: hand-offs had a median of 21k).
    const h = f.handoff.replace(/^# .*\n+/, '').replace(/^Newest last.*\n/m, '').trim();
    L.push('', '## Notes from whoever worked on this before', h.length > HANDOFF_MAX ? `(Older notes in studio/handoffs/${f.task.id}.md.)\n…${h.slice(-HANDOFF_MAX)}` : h);
  }
  if (f.tricks?.length) L.push('', `## Pre-approved tricks for this task (studio/CHEATSHEET.md, approved by ${f.tricksBy || 'the assigner'})`, 'Use these for this task without asking. Anything not listed here follows the normal approval rules.', ...f.tricks.map((t) => `- ${t.id ? `${t.id} ` : ''}${t.text}`));
  if (f.meetingNotes.length) L.push('', '## Mentioned in a meeting', ...f.meetingNotes.map((t) => `- ${(t.match(/^# (.+)$/m) || [, ''])[1]}`));
  L.push('', '## Stay in your lane');
  L.push(f.mine.length ? `- You hold: ${f.mine.map((l) => `\`${l.key}\``).join(', ')}` : `- Claim the files you will touch first: \`node harness/lock.mjs claim path:<folder> --owner ${a}\``);
  L.push(f.others.length ? `- Others hold (don't edit): ${f.others.map((l) => `\`${l.key}\` (${l.owner})`).join(', ')}` : '- Nobody else holds anything right now.');
  if (f.offLimits && !/^_.*_$/.test(f.offLimits.trim())) L.push(`- Off-limits for agents (studio/game/GAME.md): ${f.offLimits}`);
  if (f.lessons.length) L.push('', '## Lessons that look related (studio/memory/failures.md)', ...f.lessons.map((l) => `### ${l.text}`));
  if (f.roleLessons?.length) L.push('', `## Lessons filed for \`${f.task.role}\``, ...f.roleLessons.map((l) => `### ${l}`));
  if (f.voice && ['docs', 'change', 'idea'].includes(f.check.type)) L.push('', '## The game\'s voice (anything the player reads or hears)', renderVoice(f.voice));
  L.push('', '## Gates right now');
  L.push(f.gates ? (f.red.length ? `- Last verify had failures: ${f.red.join(', ')}. Don't make them worse; say so if your task can't pass because of them.` : `- Last verify was green (${f.gates.at}).`) : '- No verify recorded yet.');
  L.push('', '## Finish or hand back');
  L.push('```bash', `node harness/done-check.mjs ${f.task.id}            # what is still missing`, `node harness/task.mjs done ${f.task.id} --agent ${a}`, `node harness/task.mjs pause ${f.task.id} --agent ${a} --note "what is done, what is left, files touched"`, '```');
  L.push('', 'Running low on usage? Hand it back before you stop. Stuck after three tries? Pause with a note; the Producer will see it.');
  return L.join('\n') + '\n';
}

export function writeFocus(taskId, agent = null) {
  const f = buildFocus(taskId, agent);
  if (!f) return null;
  const md = renderFocus(f);
  const dir = path.join(STUDIO_STATE_DIR, 'briefs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${taskId}.md`);
  fs.writeFileSync(file, md);
  return { file: path.relative(REPO_ROOT, file).split(path.sep).join('/'), md };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const id = process.argv[2];
  const i = process.argv.indexOf('--agent');
  const res = id && writeFocus(id, i >= 0 ? process.argv[i + 1] : process.env.STUDIO_LOCK_OWNER || null);
  if (!res) {
    console.error('Usage: npm run focus -- <TASK_ID> [--agent <you>]');
    process.exit(1);
  }
  console.log(res.md);
  console.log(`Saved to ${res.file}`);
}
