#!/usr/bin/env node
/**
 * harness/liaison.mjs — the Liaison turns a conversation with the game dev into a confirmed brief.
 *
 * The conversation happens in the Liaison's own agent tool (kickoff: --role liaison). It asks until
 * it understands, then records what it heard and reads it back to the game dev:
 *
 *   npm run liaison -- draft --kind idea|direction|asset|question --title "…" --summary "…" [--detail "…"] [--from <dev>]
 *   npm run liaison -- confirm B-001 --by <dev> [--quote "their words of agreement"]
 *   npm run liaison -- change B-001 --summary "…"      the dev corrected it; read it back again
 *   npm run liaison -- drop B-001 [--why "…"]           the dev changed their mind
 *   npm run liaison -- list | show B-001
 *
 * Nothing moves until the game dev confirms. Then it goes to both the Producer (work) and the
 * Director (where it fits in the game's logic), and the studio keeps running:
 *   idea       a dev-confirmed idea on the Idea Board, sent to R&D straight away
 *   direction  a Producer task to turn it into work, and a Director ping to check it against the Bible
 *   asset      a Producer task to record it (`npm run asset -- add`, owned or reference only)
 *   question   a Producer task to answer the game dev
 * Briefs live in studio/liaison/B-001.json, so a chat panel in the War Room can use the same steps.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { addTask } from './task.mjs';
import { addIdea, routeIdea } from './ideas.mjs';
import { pingDirector } from './director.mjs';

export const LIAISON_DIR = path.join(REPO_ROOT, 'studio', 'liaison');
const KINDS = ['idea', 'direction', 'asset', 'question'];
const AGENT_NAMES = /^(producer|director|liaison|builder|agent|rnd|planner|reviewer|unknown)(-|$)/i;
const now = () => new Date().toISOString();

export function readBriefs() {
  if (!fs.existsSync(LIAISON_DIR)) return [];
  return fs.readdirSync(LIAISON_DIR).filter((f) => /^B-\d+\.json$/.test(f)).sort().map((f) => JSON.parse(fs.readFileSync(path.join(LIAISON_DIR, f), 'utf8')));
}
const readBrief = (id) => readBriefs().find((b) => b.id === id) || null;
function writeBrief(b) {
  fs.mkdirSync(LIAISON_DIR, { recursive: true });
  b.updatedAt = now();
  fs.writeFileSync(path.join(LIAISON_DIR, `${b.id}.json`), `${JSON.stringify(b, null, 2)}\n`);
  return b;
}

/** What the Liaison reads back to the game dev before anything moves. */
export function readBack(b) {
  const where = { idea: 'the Idea Board (R&D works it out, the Director decides where it fits)', direction: 'the Producer (to turn into work) and the Director (to check it fits the game)', asset: 'the asset list (you say if you own it or it is a reference only)', question: 'the Producer, who answers you' }[b.kind];
  return `Here is what I understood, as ${b.kind === 'idea' ? 'an idea' : `a ${b.kind}`}:\n\n  ${b.title}\n  ${b.summary}${b.detail ? `\n  (${b.detail})` : ''}\n\nIf that's right, I'll send it to ${where}. Nothing running stops. Shall I push it on? (yes, or tell me what to change)`;
}

export function draftBrief({ kind, title, summary, detail = '', from = 'game-dev', liaison = process.env.STUDIO_LOCK_OWNER || 'liaison' }) {
  if (!KINDS.includes(kind)) return { ok: false, message: `--kind is one of ${KINDS.join(', ')}.` };
  if (!String(title || '').trim() || !String(summary || '').trim()) return { ok: false, message: 'A brief needs --title and --summary (in plain words the game dev would recognise).' };
  const n = readBriefs().reduce((m, b) => Math.max(m, Number(b.id.slice(2))), 0) + 1;
  const b = writeBrief({ id: `B-${String(n).padStart(3, '0')}`, kind, title: String(title).trim().slice(0, 160), summary: String(summary).trim().slice(0, 2000), detail: String(detail).slice(0, 4000), from, liaison, stage: 'read-back', at: now(), history: [{ stage: 'read-back', at: now(), by: liaison }] });
  emitEvent({ type: 'liaison.draft', agent: liaison, msg: `${b.id} (${kind}) read back to ${from}: ${b.title}` });
  return { ok: true, brief: b, readBack: readBack(b) };
}

export function changeBrief(id, { summary, title, detail }, by = process.env.STUDIO_LOCK_OWNER || 'liaison') {
  const b = readBrief(id);
  if (!b || b.stage !== 'read-back') return { ok: false, message: `${id} isn't waiting for the game dev's answer.` };
  Object.assign(b, title ? { title } : {}, summary ? { summary } : {}, detail ? { detail } : {});
  b.history.push({ stage: 'changed', at: now(), by });
  writeBrief(b);
  return { ok: true, brief: b, readBack: readBack(b) };
}

export function dropBrief(id, why = '', by = process.env.STUDIO_LOCK_OWNER || 'liaison') {
  const b = readBrief(id);
  if (!b || b.stage !== 'read-back') return { ok: false, message: `${id} isn't waiting for the game dev's answer.` };
  b.stage = 'dropped';
  b.history.push({ stage: 'dropped', at: now(), by, note: why });
  writeBrief(b);
  emitEvent({ type: 'liaison.dropped', agent: by, msg: `${id} dropped: ${why || 'the game dev changed their mind'}` });
  return { ok: true };
}

/** The game dev said yes: send it on to the Producer and the Director. */
export function confirmBrief(id, { by, quote = '' }) {
  const b = readBrief(id);
  if (!b) return { ok: false, message: `No brief ${id}.` };
  if (b.stage !== 'read-back') return { ok: false, message: `${id} is already ${b.stage}.` };
  if (!by || AGENT_NAMES.test(by)) return { ok: false, message: 'Only the game dev confirms: --by <their name>, after they said yes to the read-back.' };
  b.stage = 'confirmed';
  b.confirmed = { by, at: now(), quote };
  const out = { idea: null, rnd: null, producer: null, director: null };
  const ref = `(from ${by}, confirmed ${b.id})`;
  if (b.kind === 'idea') {
    const r = addIdea({ title: b.title, detail: `${b.summary}${b.detail ? `\n\n${b.detail}` : ''}`, by, source: 'dev-confirmed', brief: b.id });
    out.idea = r.idea.id;
    const routed = routeIdea(r.idea.id, b.liaison);
    out.rnd = routed.task || null;
    out.director = pingDirector({ reason: `New dev-confirmed idea ${r.idea.id}: ${b.title} (R&D is shaping it)`, from: b.liaison }).task;
  } else if (b.kind === 'direction') {
    out.producer = addTask({ title: `Plan: turn the game dev's direction into tasks: ${b.title} ${ref}`.slice(0, 180), role: 'producer', priority: 'P1', agent: b.liaison, meta: { brief: b.id } }).id;
    out.director = pingDirector({ reason: `Check the game dev's direction ${b.id} against the Bible: ${b.title}`, from: b.liaison }).task;
  } else if (b.kind === 'asset') {
    out.producer = addTask({ title: `Plan: record the game dev's asset (owned or reference only, npm run asset -- add): ${b.title} ${ref}`.slice(0, 180), role: 'producer', priority: 'P1', agent: b.liaison, meta: { brief: b.id } }).id;
  } else {
    out.producer = addTask({ title: `Plan: answer the game dev: ${b.title} ${ref}`.slice(0, 180), role: 'producer', priority: 'P1', agent: b.liaison, meta: { brief: b.id } }).id;
  }
  b.routed = out;
  b.history.push({ stage: 'confirmed', at: now(), by, note: quote });
  writeBrief(b);
  emitEvent({ type: 'liaison.confirmed', agent: b.liaison, to: 'producer', msg: `${by} confirmed ${b.id} (${b.kind}): ${b.title}${out.idea ? ` -> ${out.idea}` : ''}${out.producer ? `, ${out.producer}` : ''}${out.director ? `, Director ${out.director}` : ''}` });
  return { ok: true, brief: b, routed: out };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const [cmd = 'list', id] = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  const fail = (m) => {
    console.error(m);
    process.exit(1);
  };
  if (cmd === 'draft') {
    const r = draftBrief({ kind: flag('kind'), title: flag('title'), summary: flag('summary'), detail: flag('detail') || '', from: flag('from') || 'game-dev' });
    if (!r.ok) fail(r.message);
    console.log(`${r.brief.id} drafted. Read this back to the game dev:\n\n${r.readBack}\n\nOn a clear yes: npm run liaison -- confirm ${r.brief.id} --by <their name> --quote "<their words>"`);
  } else if (cmd === 'confirm') {
    const r = confirmBrief(id, { by: flag('by'), quote: flag('quote') || '' });
    if (!r.ok) fail(r.message);
    console.log(`${id} confirmed and sent on: ${Object.entries(r.routed).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  } else if (cmd === 'change') {
    const r = changeBrief(id, { summary: flag('summary'), title: flag('title'), detail: flag('detail') });
    if (!r.ok) fail(r.message);
    console.log(`Read it back again:\n\n${r.readBack}`);
  } else if (cmd === 'drop') {
    const r = dropBrief(id, flag('why') || '');
    if (!r.ok) fail(r.message);
    console.log(`${id} dropped.`);
  } else if (cmd === 'show') {
    const b = readBrief(id);
    if (!b) fail(`No brief ${id}`);
    console.log(JSON.stringify(b, null, 2));
  } else {
    const list = readBriefs();
    console.log(list.length ? list.map((b) => `${b.id} [${b.stage}] ${b.kind}: ${b.title}${b.confirmed ? ` (confirmed by ${b.confirmed.by})` : ''}`).join('\n') : 'No briefs yet.');
  }
}
