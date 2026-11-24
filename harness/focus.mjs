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
import { notesForBrief } from './verdict-notes.mjs';
import { failuresForBrief as godotFailuresForBrief } from './godot-unit.mjs';
const safe = (fn) => {
  try {
    return fn() || '';
  } catch {
    return '';
  }
};
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents } from './event.mjs';
import { parseNextQueue, readTaskHandoff } from './task.mjs';
import { listLocks } from './lock.mjs';
import { checkDone } from './done-check.mjs';
import { anchorBriefLines } from './anchors.mjs';
import { DEFAULT_SIZE } from './scorecard.mjs';
import { readAttached } from './cheatsheet.mjs';
import { HANDOFF_MAX } from './session-cap.mjs';
import { latestFacts, withoutFacts } from './handback-facts.mjs';
import { untrustedBlock } from './untrusted.mjs';
import { inboxForBrief } from './threads.mjs';
import { conductorForBrief } from './conductor.mjs';
import { regressionHowTo } from './regression-howto.mjs';
import { visionCard, visionSection } from './vision-card.mjs';
import { taskType } from './done-check.mjs';
import { readHolds, laneList } from './task-hold.mjs';
import { itemsOf, progress, itemLines } from './task-checklist.mjs';
import { toFollow, followLines, followQuoted } from './ask.mjs';

const read = (rel) => {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
};
const part = (text, label) => (text?.match(new RegExp(`\\*\\*${label}\\.?\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*[A-Z][^*]*\\*\\*|$)`)) || [, ''])[1].trim();
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'when', 'then', 'task', 'tasks', 'add', 'fix', 'bug', 'study', 'docs', 'review', 'balance', 'playtest', 'our', 'your', 'run', 'one', 'new']);

/**
 * 2.85 (f): the designer's vision card for a task (harness/vision-card.mjs), or null. A task with no --serves of its own
 * takes its causedBy/fixOf parent's (4 levels), as the scorecard's design link does. A review task (type review, or role
 * reviewer) shows the card of the task its title names, so the reviewer judges against what the builder saw:
 * { card, reviewed } with reviewed the id, else { card, reviewed: null }.
 */
export function visionFor(task, events = readRecentEvents(20000), { env = process.env } = {}) {
  if (!task) return { card: null, reviewed: null };
  const added = new Map();
  for (const e of events) if (e.type === 'task.added' && e.task) added.set(e.task, e.meta || {});
  const metaOf = (id) => {
    let m = added.get(id) || {};
    let p = m.causedBy || m.fixOf || null;
    for (let d = 0; !m.serves && p && d < 4; d += 1) { const pm = added.get(String(p)); if (!pm) break; if (pm.serves) { m = { ...m, serves: pm.serves, ...(m.phase === undefined && pm.phase !== undefined ? { phase: pm.phase } : {}) }; break; } p = pm.causedBy || pm.fixOf || null; }
    return m;
  };
  const q = (() => { try { return parseNextQueue(); } catch { return { inProgress: [], backlog: [], done: [] }; } })();
  const find = (id) => [...q.inProgress, ...q.backlog, ...q.done].find((t) => t.id === id) || null;
  const type = (() => { try { return taskType(task); } catch { return null; } })();
  if (type === 'review' || task.role === 'reviewer') {
    const rid = (String(task.title || '').match(/\bT-\d+\b/g) || []).find((x) => x !== task.id);
    const rt = rid ? find(rid) : null;
    if (!rt) return { card: null, reviewed: null };
    const rType = (() => { try { return taskType(rt); } catch { return null; } })();
    return { card: visionCard({ task: rt, meta: metaOf(rt.id), type: rType, root: REPO_ROOT, env }), reviewed: rt.id };
  }
  return { card: visionCard({ task, meta: metaOf(task.id), type, root: REPO_ROOT, env }), reviewed: null };
}

/**
 * 2.90 (e): the line ranges a task names (path:120-340, path#L120-L340, several as path:1-9,40-60) in its title, --scope,
 * --paths or lane, for files that exist: [{ file, from, to }]. The brief lists them first: read only those lines.
 */
export function namedRanges(texts, root = REPO_ROOT) {
  const out = [];
  const R = /([\w./-]+\.\w+)(?::|#L?)(L?\d+\s*-\s*L?\d+(?:\s*,\s*L?\d+\s*-\s*L?\d+)*)/g;
  for (const m of texts.filter(Boolean).map(String).join('\n').matchAll(R)) {
    const file = m[1].replace(/^\.\//, '');
    if (file.includes('..') || !fs.existsSync(path.join(root, file))) continue;
    for (const r of m[2].split(',')) {
      const [a, b] = r.replace(/L/gi, '').split('-').map((x) => Number(x.trim()));
      const one = { file, from: Math.min(a, b), to: Math.max(a, b) };
      if (!out.some((x) => x.file === one.file && x.from === one.from && x.to === one.to)) out.push(one);
    }
  }
  return out.slice(0, 40);
}

/**
 * 2.91: the repo-relative files and folders (forward slashes) a task names that exist under root: the files of
 * namedRanges, the entries of its lane, paths and holds, and path-like words in its title and scope.
 * task = { title, scope, paths, lane, holds }.
 */
export function namedFiles(task, root = REPO_ROOT) {
  const t = task || {};
  const list = (v) => (Array.isArray(v) ? v.join(',') : String(v ?? ''));
  const words = `${t.title || ''}\n${t.scope || ''}`.match(/[\w.-]+(?:\/[\w.-]+)+\/?|[\w-]+\.\w+/g) || [];
  const found = [...namedRanges([t.title, t.scope, list(t.paths), t.lane, list(t.holds)], root).map((r) => r.file), ...laneList([list(t.lane), list(t.paths), list(t.holds)].filter(Boolean).join(',')), ...words];
  const out = [];
  for (const f of found) {
    const rel = String(f).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!rel || rel.startsWith('/') || rel.includes('..') || out.includes(rel)) continue;
    if (fs.existsSync(path.join(root, rel))) out.push(rel);
  }
  return out;
}

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
  const anchors = Array.isArray(added?.meta?.anchors) ? added.meta.anchors.map(String) : [];
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
  const vision = safe(() => visionFor(task, events)) || { card: null, reviewed: null };
  const lane = (() => { try { return readHolds()[taskId]?.lane || ''; } catch { return ''; } })();
  const follow = safe(() => toFollow({ role: task.role, task: taskId })) || [];
  const ranges = namedRanges([task.title, added?.meta?.scope, (added?.meta?.paths || []).join(','), added?.meta?.lane, lane]);
  return { items: safe(() => itemsOf(taskId)) || [], follow, ranges, vision, task, check, skill, size, causedBy, anchors, handoff: readTaskHandoff(taskId), tricks: readAttached(taskId)?.tricks || [], tricksBy: readAttached(taskId)?.preapproved?.approvedBy || null, mine, others, offLimits, lessons, gates, red, meetingNotes, agent, prepared, historyWords, identity, roleRefusals, roleLessons, voice, verdictNotes: safe(() => notesForBrief({ id: task.id, title: task.title, role: task.role })), godotFailures: safe(() => godotFailuresForBrief()), inbox: safe(() => inboxForBrief(task.id)) || null, conductor: safe(() => conductorForBrief(task.id)) || null };
}

export function renderVoice(v) {
  return [v.tone ? `- Tone: ${v.tone}` : '', ...(v.do || []).map((x) => `- Do: ${x}`), ...(v.dont || []).map((x) => `- Don't: ${x}`), ...(v.never || []).length ? [`- Never say: ${v.never.join(', ')}`] : [], ...(v.examples || []).map((x) => `- Sounds like: "${x}"`)].filter(Boolean).join('\n');
}

export function renderFocus(f) {
  const a = f.agent || '<you>';
  const L = [];
  // 2.58.0 (PU-36, P-049): what agents or people wrote (the title, hand-off notes, meeting and review notes, lessons,
  // the game's off-limits line) goes in one marked block (harness/untrusted.mjs), never among this page's steps.
  // 2.66.0 (c): the newest hand-back facts (harness-written: changed files, gates, failure signature, seed, log) come
  // first; the older blocks are taken out of the notes (stale, and they'd fill the 3k carry-forward).
  const facts = latestFacts(f.handoff);
  const handoff = f.handoff ? withoutFacts(f.handoff).replace(/^# .*\n+/, '').replace(/^Newest last.*\n/m, '').trim() : '';
  const told = untrustedBlock([
    { label: `Hand-back facts from the newest hand-back${facts?.heading ? ` (${facts.heading})` : ''}, written by the harness from git and the gate logs`, text: facts ? facts.block.split('\n').slice(1, -1).join('\n') : '' },
    { label: `Task title (${f.task.id})`, text: f.task.title },
    { label: `Checklist (${progress(f.items || [])}): [x] done, [ ] open, [-] skipped, [>] moved to another task`, text: itemLines(f.items || []).join('\n') },
    { label: 'Answered asks whose follow-up is not filed yet (studio/asks/)', text: f.follow?.length ? followQuoted(f.follow) : '' },
    // 2.29.2: the carry-forward is the newest notes, at most 3k characters (test #4: hand-offs had a median of 21k).
    { label: `Notes from whoever worked on this before, newest last (${handoff.length > HANDOFF_MAX ? `the newest ${Math.round(HANDOFF_MAX / 1000)}k characters. Older notes in studio/handoffs/${f.task.id}.md` : `studio/handoffs/${f.task.id}.md`})`, text: handoff.length > HANDOFF_MAX ? `…${handoff.slice(-HANDOFF_MAX)}` : handoff },
    // 2.64.0: follow-ups routed to this task (harness/threads.mjs): CI and merge-train results, messages tied to it.
    { label: `Inbox: follow-ups routed to this task, newest last (${f.inbox ? `${f.inbox.lines.length} of ${f.inbox.total}, ${f.inbox.file}` : ''})`, text: f.inbox ? f.inbox.lines.join('\n') : '' },
    // 2.65.0: rulings on this task by a person, the Producer/Director or an orchestrator outside the harness (npm run task -- note).
    { label: `Conductor notes: rulings on this task, newest last (${f.conductor ? `${f.conductor.lines.length} of ${f.conductor.total}, ${f.conductor.file}` : ''})`, text: f.conductor ? f.conductor.lines.join('\n') : '' },
    { label: 'Mentioned in a meeting (studio/meetings/)', text: f.meetingNotes.map((t) => `- ${(t.match(/^# (.+)$/m) || [, ''])[1]}`).join('\n') },
    // 2.30g: the dev's earlier verdicts that touch this task (context, never rules).
    { label: 'Review notes: earlier verdicts that touch this task', text: f.verdictNotes ? f.verdictNotes.trim() : '' },
    { label: 'Lessons that look related (studio/memory/failures.md)', text: f.lessons.map((l) => `### ${l.text}`).join('\n') },
    { label: `Lessons filed for \`${f.task.role}\` (studio/memory/failures.md)`, text: (f.roleLessons || []).map((l) => `### ${l}`).join('\n') },
    { label: 'Off-limits for agents (studio/game/GAME.md): keep out of these', text: f.offLimits && !/^_.*_$/.test(f.offLimits.trim()) ? f.offLimits : '' },
  ]);
  L.push(`# Focus: ${f.task.id}`, '');
  L.push(`${f.task.priority}, size ${f.size} of 5, a "${f.check.type}" task for \`${f.task.role}\`${f.causedBy ? `. It is a bug traced to ${f.causedBy}` : ''}. Read this page instead of the repo; open other files only when a step needs them.`);
  // 2.90 (h): an answered ask stays a must-do until its follow-up is recorded (npm run ask -- followed).
  if (f.follow?.length) L.push('', '## Must do first: answered asks', 'Their questions and answers are in the marked block below.', ...followLines(f.follow));
  if (f.ranges?.length) L.push('', '## Read only these lines', 'This task names the parts of the files it needs. Read only these lines (your Read tool\'s offset and limit, or `sed -n \'<from>,<to>p\' <file>`); never read a whole file to find them.', ...f.ranges.map((r) => `- \`${r.file}\` lines ${r.from}-${r.to}: offset ${r.from}, limit ${r.to - r.from + 1}`));
  if (told) L.push('', '## What this task is, and what others left on it', told.trimEnd());
  // 2.85 (f): the designer's vision for this task (the signed Bible's pillar, never list, feel and phase goal), between
  // what the task is and what done means, so the builder sees it before working (harness/vision-card.mjs).
  if (f.vision?.card) L.push('', ...visionSection(f.vision.card, f.task.id, { reviewed: f.vision.reviewed }));
  if (f.inbox) L.push('', '## Inbox', `${f.inbox.total} follow-up(s) routed to this task (${f.inbox.unread} unread), quoted in the marked block above. Read them before you start: \`npm run thread -- inbox ${f.task.id}\`. New ones arrive while you work; a Claude Code session is told at its next tool call.`);
  if (f.identity) L.push('', `## Who you are (studio/roles/${f.task.role}.md)`, f.identity);
  // 2.98 (c): a task with a checklist lands in slices: every landing with an item open sends it back to ready.
  if (f.items?.length) L.push('', `## Checklist: ${progress(f.items)}`, `The items are in the marked block above. Close each as you finish it: \`npm run task -- checklist ${f.task.id} done "<item>"\` (or \`skip "<item>" --why "<reason>"\`). While an item is open, task done queues your work as a slice and the task comes back for the next session; it closes when the list is empty.`);
  L.push('', '## Done means', `${f.check.means}.${f.check.ok ? ' (Already true; confirm before you finish.)' : ''}`);
  // 2.81 (b2): the anchors the task cites (task add --anchors): the reference's behaviours, numbers and acceptance
  // lines, and how the deliverable proves them (harness/anchors.mjs). Unknown evidence is said, never assumed.
  if (f.anchors?.length) L.push('', '## Anchors this task must match (studio/references/anchors.json)', ...anchorBriefLines(f.anchors), 'An anchor whose evidence is unknown or needs a reference is reported as unknown at done: it is never green, so say what you assumed in your hand-back note.');
  // 2.67.2: a bug task's regression, exactly (the path, the fields, the pin and fails-before commands), as task done asks.
  if (f.check.type === 'bug') L.push('', '## The regression this bug needs', ...regressionHowTo(f.task.id).map((x) => `- ${x}`));
  if (f.roleRefusals?.length) L.push('', `## Where \`${f.task.role}\` agents get refused most`, ...f.roleRefusals.map((r) => `- ${r.n}x: ${r.why}`), 'Do these before you run done.');
  if (f.skill) {
    const steps = part(f.skill, 'Steps');
    const never = part(f.skill, 'Never');
    if (steps) L.push('', `## Steps (${f.check.skill})`, steps);
    if (never) L.push('', '## Never', never);
  }
  if (f.prepared) L.push('', '## Prepared brief', `A short summary of this task's history is in \`${f.prepared}\`. Read it instead of the event log.`);
  else if (f.historyWords >= Number(process.env.STUDIO_PREPARE_MIN_WORDS || 500)) L.push('', '## Long history', `This task has ${f.historyWords} words of history. Run \`npm run brief -- ${f.task.id}\` for a 300-word summary (a cheap or local model drafts it, a script checks it).`);
  if (f.tricks?.length) L.push('', `## Pre-approved tricks for this task (studio/CHEATSHEET.md, approved by ${f.tricksBy || 'the assigner'})`, 'Use these for this task without asking. Anything not listed here follows the normal approval rules.', ...f.tricks.map((t) => `- ${t.id ? `${t.id} ` : ''}${t.text}`));
  // The failing Godot unit tests (the hand-off, meeting and review notes are in the marked block above).
  if (f.godotFailures) L.push('', f.godotFailures.trim());
  L.push('', '## Stay in your lane');
  L.push(f.mine.length ? `- You hold: ${f.mine.map((l) => `\`${l.key}\``).join(', ')}` : `- Claim the files you will touch first: \`node harness/lock.mjs claim path:<folder> --owner ${a}\``);
  L.push(f.others.length ? `- Others hold (don't edit): ${f.others.map((l) => `\`${l.key}\` (${l.owner})`).join(', ')}` : '- Nobody else holds anything right now.');
  if (f.offLimits && !/^_.*_$/.test(f.offLimits.trim())) L.push('- The game\'s off-limits list (studio/game/GAME.md) is in the marked block above.');
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
