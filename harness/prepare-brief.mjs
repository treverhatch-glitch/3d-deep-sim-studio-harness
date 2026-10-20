#!/usr/bin/env node
/**
 * harness/prepare-brief.mjs — cheap prepare, strong act.
 *
 *   npm run brief -- [<ID>]              prepare a brief for a task (default: the first one in progress)
 *   npm run brief -- T-012 --model       let a cheap model draft it (local or free tier only)
 *   npm run brief -- T-012 --template    never call a model
 *   npm run brief -- T-012 --force       prepare even when the history is already short
 *
 * The shape follows draft-then-verify and bounded replay:
 *   1. Gather a bounded window, never the full history: this task's last events, its hand-off notes,
 *      the lessons that match it, the newest QA result, and the files it has touched.
 *   2. Short history (under STUDIO_PREPARE_MIN_WORDS, default 500): skip the model; the strong agent
 *      reads the window as is.
 *   3. Otherwise a cheap model drafts a brief of at most 300 words: Goal, Relevant history, Known
 *      pitfalls, Files to touch, Verify. Only local and free providers are tried (or
 *      STUDIO_PREPARE_CHAIN). With no cheap provider, or with --template, a script writes it.
 *   4. The script verifies the draft: the five sections, the word cap, files that exist, task IDs
 *      that exist. A draft that fails is thrown away and the script's version is used, with the reason.
 * The strong agent gets `.studio/briefs/<ID>.prepared.md` instead of the history, and the Producer
 * sees it in the event log. Words in and out are counted; token savings are not claimed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents, emitEvent } from './event.mjs';
import { parseNextQueue, readTaskHandoff } from './task.mjs';
import { PROVIDERS } from './models.config.mjs';
import { routeChatCompletion } from './route.mjs';

const BRIEFS_DIR = path.join(STUDIO_STATE_DIR, 'briefs');
const MAX_WORDS = 300;
const SECTIONS = ['Goal', 'Relevant history', 'Known pitfalls', 'Files to touch', 'Verify'];
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'when', 'then', 'task', 'tasks', 'fix', 'bug', 'study', 'docs', 'review', 'balance', 'playtest', 'your', 'one', 'new']);

const words = (t) => (String(t || '').trim().match(/\S+/g) || []).length;
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return '';
  }
};
const posix = (p) => p.split(path.sep).join('/');

/** Cheap providers only: local first, then free tiers. STUDIO_PREPARE_CHAIN overrides (comma-separated ids). */
export function cheapChain() {
  const custom = (process.env.STUDIO_PREPARE_CHAIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (custom.length) return custom;
  const rank = { local: 0, free: 1, 'credit-free': 2 };
  return Object.values(PROVIDERS).filter((p) => p.tier in rank).sort((a, b) => rank[a.tier] - rank[b.tier]).map((p) => p.id);
}

function pickTask(taskId) {
  const q = parseNextQueue();
  const all = [...q.inProgress, ...q.backlog, ...q.done];
  if (taskId) return all.find((t) => t.id === taskId) || null;
  return q.inProgress[0] || q.backlog[0] || null;
}

/** The bounded window: what a strong agent needs about this task, and nothing older or wider. */
export function gatherWindow(task) {
  const events = readRecentEvents(5000);
  const mine = events.filter((e) => e.task === task.id && e.msg).slice(-25);
  const keys = [...new Set(task.title.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || [])].filter((w) => !STOP.has(w));
  const lessons = (read('studio/memory/failures.md').split('## Recorded Distilled Notes')[1] || '')
    .split(/^### /m)
    .slice(1)
    .map((l) => ({ text: l.trim(), hits: keys.filter((w) => l.toLowerCase().includes(w)).length }))
    .filter((l) => l.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3)
    .map((l) => l.text);
  const reportsDir = path.join(REPO_ROOT, 'qa', 'reports');
  const newest = fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir).filter((f) => f.endsWith('.json')).sort().pop() : null;
  let qa = null;
  if (newest) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(reportsDir, newest), 'utf8'));
      const s = r.stage1 || r;
      qa = `${newest}: ${r.passed ? 'passed' : 'FAILED'}, cartridge ${s.cartridge}, seed ${s.seed}, ticks ${s.ticksRun}${s.failingTick != null ? `, failing tick ${s.failingTick}` : ''}, hash ${s.finalHash}${(s.findings || []).length ? `, findings: ${s.findings.slice(0, 3).map((f) => f.message || f.id || JSON.stringify(f)).join('; ')}` : ''}`;
    } catch {
      qa = null;
    }
  }
  const files = [...new Set(mine.map((e) => e.target).filter((t) => t && fs.existsSync(path.join(REPO_ROOT, t))))].slice(0, 12);
  const handoff = readTaskHandoff(task.id) || '';
  const history = mine.map((e) => `- ${(e.ts || '').slice(0, 16).replace('T', ' ')} ${e.agent} ${e.type}: ${e.msg}`);
  const source = [task.title, handoff, ...history, ...lessons, qa || ''].join('\n');
  return { task, history, handoff, lessons, qa, files, sourceWords: words(source) };
}

/** The script's own brief: always available, never calls a model. */
export function templateBrief(w) {
  const t = w.task;
  return [
    `## Goal`,
    `${t.id} (${t.priority}, ${t.role}): ${t.title}`,
    ``,
    `## Relevant history`,
    ...(w.history.length ? w.history.slice(-6) : ['- Nothing recorded for this task yet.']),
    ...(w.handoff ? [`- Hand-off notes: ${w.handoff.replace(/^# .*\n+/, '').replace(/\s+/g, ' ').trim().slice(0, 400)}`] : []),
    ``,
    `## Known pitfalls`,
    ...(w.lessons.length ? w.lessons.map((l) => `- ${l.replace(/\s+/g, ' ').slice(0, 220)}`) : ['- No matching lessons in studio/memory/failures.md.']),
    ...(w.qa ? [`- Newest QA: ${w.qa}`] : []),
    ``,
    `## Files to touch`,
    ...(w.files.length ? w.files.map((f) => `- ${f}`) : ['- Not known yet; the focus brief lists what you hold.']),
    ``,
    `## Verify`,
    `- node harness/done-check.mjs ${t.id}`,
    `- npm run verify`,
  ].join('\n');
}

/** Checks a drafted brief. Returns the reasons it fails (empty when it passes). */
export function verifyDraft(text, w) {
  const why = [];
  for (const s of SECTIONS) if (!new RegExp(`^##\\s*${s}\\b`, 'mi').test(text)) why.push(`missing section "${s}"`);
  if (words(text) > MAX_WORDS) why.push(`${words(text)} words, over ${MAX_WORDS}`);
  if (!text.includes(w.task.id)) why.push(`does not name ${w.task.id}`);
  const q = parseNextQueue();
  const known = new Set([...q.inProgress, ...q.backlog, ...q.done].map((t) => t.id));
  const ids = [...new Set(text.match(/\bT-\d+\b/g) || [])].filter((id) => !known.has(id));
  if (ids.length) why.push(`names tasks that don't exist: ${ids.join(', ')}`);
  const paths = [...new Set(text.match(/\b(?:cartridges|harness|qa|scripts|src|studio|hub|docs|tools)\/[\w./-]+\.\w+/g) || [])];
  const missing = paths.filter((p) => !fs.existsSync(path.join(REPO_ROOT, p)));
  if (missing.length) why.push(`names files that don't exist: ${missing.slice(0, 4).join(', ')}`);
  return why;
}

function render(task, body, meta) {
  return `# Prepared brief: ${task.id} ${task.title}\n\n> Prepared by ${meta.by}. ${meta.note} Read this instead of the history; your focus brief (.studio/briefs/${task.id}.md) has the steps and finish commands.\n\n${body.trim()}\n`;
}

export async function prepareBrief({ taskId = null, mode = 'auto', force = false } = {}) {
  const task = pickTask(taskId);
  if (!task) return { ok: false, error: taskId ? `No task ${taskId}` : 'No task in progress or queued' };
  const w = gatherWindow(task);
  const minWords = Number(process.env.STUDIO_PREPARE_MIN_WORDS || 500);
  const useModel = mode === 'model' || (mode === 'auto' && process.env.STUDIO_PREPARE === 'model');
  let body = templateBrief(w);
  let by = 'a script (no model)';
  let note = '';
  let provider = 'template';
  let model = 'none';
  let tokens = 0;

  if (mode === 'template') note = 'Template asked for.';
  else if (!force && w.sourceWords < minWords) note = `History is short (${w.sourceWords} words), so no model was called.`;
  else if (!useModel) note = 'Model drafting is off (pass --model or set STUDIO_PREPARE=model).';
  else {
    const chain = cheapChain();
    const res = await routeChatCompletion({
      role: 'preparer',
      customChain: chain,
      task: task.id,
      maxTokens: 700,
      temperature: 0.1,
      messages: [
        { role: 'system', content: `You compress a game-studio task's history into a brief for a stronger model. Use only the material given. Write at most ${MAX_WORDS} words in exactly these markdown sections: ${SECTIONS.map((s) => `## ${s}`).join(', ')}. Name the task ID. Only name files and task IDs that appear in the material. No preamble.` },
        { role: 'user', content: `Task ${task.id} (${task.priority}, ${task.role}): ${task.title}\n\nEvents for this task:\n${w.history.join('\n') || 'none'}\n\nHand-off notes:\n${w.handoff || 'none'}\n\nLessons:\n${w.lessons.join('\n\n') || 'none'}\n\nNewest QA: ${w.qa || 'none'}\n\nFiles seen: ${w.files.join(', ') || 'none'}` },
      ],
    });
    if (!res.ok) note = `No cheap provider answered (${res.capped ? 'spend cap reached' : (res.attempts || []).map((a) => `${a.providerId}: ${a.status}`).join(', ') || res.error}); the script wrote it instead.`;
    else {
      const draft = String(res.content || '').replace(/^```\w*\n|```$/g, '').trim();
      const problems = verifyDraft(draft, w);
      tokens = (res.tokensIn || 0) + (res.tokensOut || 0);
      if (problems.length) note = `${res.provider} drafted one but it failed checks (${problems.join('; ')}), so the script wrote it instead.`;
      else {
        body = draft;
        by = `${res.provider} (${res.model})`;
        provider = res.provider;
        model = res.model;
        note = 'Draft checked: sections, word cap, files and task IDs.';
      }
    }
  }

  fs.mkdirSync(BRIEFS_DIR, { recursive: true });
  const md = render(task, body, { by, note });
  const file = path.join(BRIEFS_DIR, `${task.id}.prepared.md`);
  fs.writeFileSync(file, md);
  fs.writeFileSync(path.join(BRIEFS_DIR, 'latest.md'), md);
  const outWords = words(body);
  emitEvent({
    type: 'brief.prepared',
    agent: 'preparer',
    to: 'producer',
    provider,
    model,
    task: task.id,
    target: posix(path.relative(REPO_ROOT, file)),
    msg: `Brief for ${task.id}: ${w.sourceWords} words of history in, ${outWords} out, by ${by}. ${note}`,
    meta: { wordsIn: w.sourceWords, wordsOut: outWords, tokens },
  });
  return { ok: true, taskId: task.id, by, provider, model, note, wordsIn: w.sourceWords, wordsOut: outWords, file: posix(path.relative(REPO_ROOT, file)), brief: md };
}

/** Kept for the HUB's "prepare brief" button: the script's version, no model, synchronous. */
export function buildPreparedBrief() {
  const task = pickTask(null);
  if (!task) return { taskId: null, wordCount: 0, mode: 'template', briefPath: null, brief: 'No task in progress or queued.' };
  const w = gatherWindow(task);
  const md = render(task, templateBrief(w), { by: 'a script (no model)', note: 'From the HUB button.' });
  fs.mkdirSync(BRIEFS_DIR, { recursive: true });
  fs.writeFileSync(path.join(BRIEFS_DIR, `${task.id}.prepared.md`), md);
  fs.writeFileSync(path.join(BRIEFS_DIR, 'latest.md'), md);
  emitEvent({ type: 'brief.prepared', agent: 'preparer', to: 'producer', provider: 'template', model: 'none', task: task.id, target: `.studio/briefs/${task.id}.prepared.md`, msg: `Brief for ${task.id} by a script (no model).` });
  return { taskId: task.id, wordCount: words(md), mode: 'template', briefPath: `.studio/briefs/${task.id}.prepared.md`, brief: md };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const id = argv.find((a) => /^T-\d+$/.test(a)) || null;
  const mode = argv.includes('--template') ? 'template' : argv.includes('--model') ? 'model' : 'auto';
  const res = await prepareBrief({ taskId: id, mode, force: argv.includes('--force') });
  if (!res.ok) {
    console.error(`[brief] ${res.error}`);
    process.exit(1);
  }
  console.log(res.brief);
  console.log(`[brief] ${res.file}: ${res.wordsIn} words in, ${res.wordsOut} out, by ${res.by}. ${res.note}`);
}
