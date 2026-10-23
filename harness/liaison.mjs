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

/**
 * One turn of the War Room's Liaison chat, on a cheap model through the router (spend cap applies).
 * The model asks until it understands, then answers with a BRIEF line; that becomes a draft read back
 * to the game dev, who confirms with a button (confirmBrief). The transcript is kept in
 * studio/liaison/chat.md so the Producer and the Director can see what was said.
 */
export function isClassifierReply(text) {
  text = String(text || '').trim();
  if (!text || /^safe$/i.test(text) || /^unsafe$/i.test(text)) return true;
  return /^\s*(user\s*safety|safety|content\s*safety)\s*[:=]\s*(safe|unsafe)\b/i.test(text);
}

export async function chatTurn({ messages = [], from = 'game-dev', pending = null }) {
  const turns = (Array.isArray(messages) ? messages : []).filter((m) => m && ['user', 'assistant'].includes(m.role) && String(m.content || '').trim()).slice(-12).map((m) => ({ role: m.role, content: String(m.content).slice(0, 1500) }));
  if (!turns.length || turns[turns.length - 1].role !== 'user') return { ok: false, message: 'Say something first.' };
  const { readBible } = await import('./bible.mjs');
  const { routeChatCompletion } = await import('./route.mjs');
  const { cheapChain } = await import('./prepare-brief.mjs');
  const b = readBible();
  const game = b ? `The game: ${b.answers?.title || '(untitled)'}. ${b.answers?.fantasy || ''} Pillars: ${(b.pillars || []).map((p) => p.name).join(', ') || 'none yet'}. Crossed out: ${Object.entries(b.layers || {}).filter(([, v]) => v.answer === 'no').map(([k]) => k).join(', ') || 'nothing'}.` : 'There is no Game Bible yet.';
  const system = `You are the Liaison of a small game studio, talking with the game's developer in the studio's control room. ${game}
Your job: understand what they want and turn it into one brief for the studio. Ask one short, plain question at a time until you could explain it to a builder. Don't promise dates, don't design it yourself, don't say it's done.
When you understand, reply with exactly one line and nothing else:
BRIEF {"kind":"idea|direction|asset|question","title":"<under 80 chars, their words>","summary":"<2-3 sentences>","detail":"<anything specific they said>"}
idea = something new for the game; direction = change how the studio works or what it focuses on; asset = a file they own or want used; question = they want an answer from the studio.`;
  const res = await routeChatCompletion({ role: 'liaison', customChain: cheapChain(), maxTokens: 400, temperature: 0.3, messages: [{ role: 'system', content: system }, ...turns] });
  const log = path.join(LIAISON_DIR, 'chat.md');
  fs.mkdirSync(LIAISON_DIR, { recursive: true });
  if (!fs.existsSync(log)) fs.writeFileSync(log, '# Liaison chat (War Room)\n\n> What the game dev and the Liaison said in the War Room. Nothing here is work until the dev confirms a brief.\n');
  fs.appendFileSync(log, `\n- ${now().slice(0, 16).replace('T', ' ')} **${from}**: ${turns[turns.length - 1].content.replace(/\n+/g, ' ')}\n`);
  if (!res.ok) {
    const why = res.capped ? 'the daily spend cap is reached' : 'no cheap model answered (Ollama, or a free key like NVIDIA or Groq in .env)';
    return { ok: true, reply: `I can't chat right now: ${why}. Send it as a pitch or a message to the Producer instead; both still reach the studio.`, offline: true };
  }
  const text = String(res.content || '').trim();
  if (isClassifierReply(text)) {
    const r = "The Liaison's model gave no real answer (a safety-check reply). Try again, or send it as a pitch or a message to the Producer.";
    fs.appendFileSync(log, `- ${now().slice(0, 16).replace('T', ' ')} **liaison**: (classifier output blocked)\n`);
    return { ok: true, reply: r, offline: true };
  }
  const m = text.match(/BRIEF\s*(\{[\s\S]*\})/);
  if (m) {
    let j = null;
    try {
      j = JSON.parse(m[1]);
    } catch {
      // fall through to a plain reply
    }
    if (j) {
      // The dev corrected a brief that's still waiting: change that one instead of drafting another.
      const open = pending ? readBrief(pending) : null;
      const r = open && open.stage === 'read-back' ? changeBrief(pending, { title: j.title, summary: j.summary, detail: j.detail || '' }, 'liaison-chat') : draftBrief({ kind: KINDS.includes(j.kind) ? j.kind : 'idea', title: j.title, summary: j.summary, detail: j.detail || '', from, liaison: 'liaison-chat' });
      if (r.ok) {
        fs.appendFileSync(log, `- ${now().slice(0, 16).replace('T', ' ')} **liaison**: drafted ${r.brief.id} and read it back.\n`);
        return { ok: true, reply: r.readBack, brief: r.brief.id, model: res.model || null };
      }
    }
  }
  const reply = text.replace(/BRIEF\s*\{[\s\S]*$/, '').trim().slice(0, 1500) || 'Tell me a bit more?';
  fs.appendFileSync(log, `- ${now().slice(0, 16).replace('T', ' ')} **liaison**: ${reply.replace(/\n+/g, ' ')}\n`);
  return { ok: true, reply, model: res.model || null };
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
