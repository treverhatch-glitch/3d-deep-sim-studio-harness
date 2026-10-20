#!/usr/bin/env node
/**
 * harness/ideas.mjs — the Idea Board. Ideas never go straight to builders.
 *
 *   npm run idea -- add "<title>" [--detail "…"] [--by <name>] [--source dev-confirmed|dev-pitched|agent|playtest]   captured
 *   npm run idea -- route <id>                                          Producer: queue R&D to shape it
 *   npm run idea -- shape <id> --notes "…"                              R&D: shaped (queues placing)
 *   npm run idea -- place <id> --phase 1|2|3 [--layer <id>] --unlock "…" --schedule "…"
 *                                                                        planner: placed (pings the Director)
 *   npm run idea -- decide <id> approve|park|reject --by <name> [--note "…"]   Director decides
 *   npm run idea -- list [--stage placed] | show <id> | collect
 *
 * After approval the Producer schedules it: `task add "…" --idea I-001 --phase n` (refused for any
 * idea that isn't approved). The watcher's regular pass runs `collect`: new ideas give the Producer
 * one "Ideas: N new" task, never one per idea. Ideas live in studio/bible/ideas/I-001.json, so a UI
 * can read and write them the same way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitEvent } from './event.mjs';
import { parseNextQueue, addTask } from './task.mjs';
import { readBible, writeBible, readIdeas, readIdea, writeIdea, renderBible, LAYERS, IDEAS_DIR } from './bible.mjs';
import { pingDirector } from './director.mjs';

const now = () => new Date().toISOString();
const step = (idea, stage, by, note = '') => ({ ...idea, stage, history: [...(idea.history || []), { stage, at: now(), by, note }] });

/** Where an idea came from, shown as a label on the board. Dev-confirmed ideas are routed first. */
export const SOURCES = { 'dev-confirmed': 'dev, confirmed', 'dev-pitched': 'dev, pitched', agent: 'agent', playtest: 'playtest' };
const AGENTISH = /^(producer|director|liaison|builder|rnd|planner|reviewer|watch|agent|qa|claude|codex|cursor|grok|gemini)(-|$)/i;

export function addIdea({ title, detail = '', by = 'game-dev', source = null, brief = null }) {
  if (!String(title || '').trim()) return { ok: false, message: 'An idea needs a title.' };
  if (source && !SOURCES[source]) return { ok: false, message: `--source is one of ${Object.keys(SOURCES).join(', ')}.` };
  const n = readIdeas().reduce((m, i) => Math.max(m, Number(i.id.slice(2))), 0) + 1;
  const src = source || (AGENTISH.test(by) ? 'agent' : 'dev-pitched');
  const idea = step({ id: `I-${String(n).padStart(3, '0')}`, title: String(title).trim().slice(0, 160), detail: String(detail).slice(0, 4000), by, source: src, brief, at: now(), tasks: [] }, 'captured', by);
  fs.mkdirSync(IDEAS_DIR, { recursive: true });
  writeIdea(idea);
  emitEvent({ type: 'idea.captured', agent: by, to: 'producer', msg: `Idea ${idea.id} (${SOURCES[src]}) captured: ${idea.title}` });
  return { ok: true, idea };
}

/** The watcher's pass: one Producer task for all new ideas. */
export function collectIdeas() {
  const order = Object.keys(SOURCES);
  const fresh = readIdeas().filter((i) => i.stage === 'captured' && !i.announced && !i.routed).sort((a, b) => order.indexOf(a.source || 'dev-pitched') - order.indexOf(b.source || 'dev-pitched'));
  if (!fresh.length) return null;
  const q = parseNextQueue();
  const open = [...q.inProgress, ...q.backlog].find((t) => /^Ideas:/.test(t.title));
  let task = open;
  if (!open) task = addTask({ agent: 'watch', title: `Ideas: ${fresh.length} new (${fresh.map((i) => i.id).join(', ')}): route each to R&D with npm run idea -- route <id>`, role: 'producer', priority: 'P2' });
  for (const i of fresh) writeIdea({ ...i, announced: now() });
  emitEvent({ type: 'idea.collected', agent: 'watch', to: 'producer', task: task?.id, msg: `New ideas for the Producer: ${fresh.map((i) => `${i.id} ${i.title}`).join('; ')}` });
  return { task: task?.id, ideas: fresh.map((i) => i.id) };
}

function need(id, stages) {
  const idea = readIdea(id);
  if (!idea) return { error: `No idea ${id}.` };
  if (stages && !stages.includes(idea.stage)) return { error: `${id} is "${idea.stage}"; this step needs it to be ${stages.join(' or ')}.` };
  return { idea };
}

export function routeIdea(id, by = 'producer') {
  const { idea, error } = need(id, ['captured', 'parked']);
  if (error) return { ok: false, message: error };
  const t = addTask({ title: `Idea: shape ${id} ${idea.title}`.slice(0, 160), role: 'rnd', priority: 'P2', agent: by });
  if (t.error) return { ok: false, message: t.message };
  writeIdea({ ...idea, routed: t.id });
  emitEvent({ type: 'idea.routed', agent: by, task: t.id, msg: `${id} sent to R&D (${t.id})` });
  return { ok: true, task: t.id };
}

export function shapeIdea(id, { notes, by = 'rnd' }) {
  const { idea, error } = need(id, ['captured', 'parked']);
  if (error) return { ok: false, message: error };
  if (!String(notes || '').trim()) return { ok: false, message: 'Shaping needs --notes: what the player does with it, its phase and layer, its cost, and any conflicts.' };
  const NOTES_CAP = 20000;
  const cut = String(notes).length > NOTES_CAP;
  const shaped = step({ ...idea, shape: { notes: String(notes).slice(0, NOTES_CAP), by, at: now(), ...(cut ? { cut: String(notes).length } : {}) } }, 'shaped', by);
  const t = addTask({ title: `Idea: place ${id} ${idea.title}`.slice(0, 160), role: 'planner', priority: 'P2', agent: by });
  writeIdea({ ...shaped, placeTask: t.id || null });
  emitEvent({ type: 'idea.shaped', agent: by, to: 'producer', msg: `${id} shaped by ${by}; ${t.id ? `${t.id} places it` : t.message}` });
  return { ok: true, task: t.id, warning: cut ? `the notes were ${String(notes).length} characters; the first ${NOTES_CAP} were kept. Put the rest in a study file and link it.` : null };
}

export function placeIdea(id, { phase, layer = null, unlock = '', schedule = '', by = 'planner' }) {
  const { idea, error } = need(id, ['shaped']);
  if (error) return { ok: false, message: error };
  phase = Number(phase);
  if (![1, 2, 3].includes(phase)) return { ok: false, message: 'Placing needs --phase 1, 2 or 3 (where it lands in the player\'s progression).' };
  if (layer && !LAYERS.some((l) => l.id === layer)) return { ok: false, message: `Unknown layer ${layer}.` };
  const b = readBible();
  const crossed = layer && b?.layers?.[layer]?.answer === 'no';
  writeIdea(step({ ...idea, place: { phase, layer, unlock, schedule, by, at: now(), crossed } }, 'placed', by));
  const ping = pingDirector({ reason: `Decide idea ${id} (${idea.title}), placed in Phase ${phase}${layer ? `, ${layer}` : ''}${crossed ? ' (a crossed-out layer)' : ''}`, from: by });
  emitEvent({ type: 'idea.placed', agent: by, to: 'director', msg: `${id} placed in Phase ${phase}${layer ? ` (${layer})` : ''}; waiting for the Director` });
  return { ok: true, director: ping.task };
}

export function decideIdea(id, verdict, { by, note = '' }) {
  const { idea, error } = need(id, ['placed']);
  if (error) return { ok: false, message: error };
  const stage = { approve: 'approved', park: 'parked', reject: 'rejected' }[verdict];
  if (!stage) return { ok: false, message: 'Decide with approve, park or reject.' };
  if (!by) return { ok: false, message: 'Say who decides: --by <name>.' };
  const b = readBible();
  if (stage === 'approved' && idea.place?.layer && b?.layers?.[idea.place.layer]?.answer === 'no') return { ok: false, message: `${id} needs ${idea.place.layer}, which is crossed out. A person brings the layer back first, or park or reject it.` };
  const decided = step({ ...idea, decision: { verdict: stage, by, note, at: now() } }, stage, by, note);
  writeIdea(decided);
  if (stage === 'approved' && b) {
    if (idea.place?.layer && b.layers?.[idea.place.layer]?.answer === 'explore') b.layers[idea.place.layer] = { ...b.layers[idea.place.layer], answer: 'yes', phase: idea.place.phase, why: `approved with ${id}`, by, at: now() };
    writeBible(b);
  } else if (b) renderBible(b);
  emitEvent({ type: `idea.${stage}`, agent: by, to: 'producer', msg: stage === 'approved' ? `${id} approved by ${by}. Schedule it: task add "…" --idea ${id} --phase ${idea.place?.phase}` : `${id} ${stage} by ${by}${note ? `: ${note}` : ''}` });
  return { ok: true, stage };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
    } else positional.push(argv[i]);
  }
  const [cmd = 'list', a1, a2] = positional;
  if (argv.includes('--help') || argv.includes('-h') || cmd === 'help') {
    console.log('Usage: npm run idea -- add "<title>" | route <id> | shape <id> --notes "…" | place <id> --phase n [--layer id] --unlock "…" --schedule "…" | decide <id> approve|park|reject --by <name> | list | show <id> | collect');
    process.exit(0);
  }
  const who = flag('by') || process.env.STUDIO_LOCK_OWNER;
  const done = (res, okMsg) => {
    if (!res || res.ok === false) {
      console.error(res?.message || 'Nothing to do.');
      process.exit(1);
    }
    console.log(okMsg(res));
    process.exit(0);
  };
  if (cmd === 'add') done(addIdea({ title: positional.slice(1).join(' '), detail: flag('detail') || '', by: who || 'game-dev', source: flag('source') }), (r) => `${r.idea.id} captured. The watcher hands new ideas to the Producer; nothing is built until the Director approves it.`);
  if (cmd === 'route') done(routeIdea(a1, who || 'producer'), (r) => `${a1} goes to R&D: ${r.task}`);
  if (cmd === 'shape') done(shapeIdea(a1, { notes: flag('notes'), by: who || 'rnd' }), (r) => `${a1} shaped; ${r.task || 'no'} task to place it${r.warning ? `\nWarning: ${r.warning}` : ''}`);
  if (cmd === 'place') done(placeIdea(a1, { phase: flag('phase'), layer: flag('layer'), unlock: flag('unlock') || '', schedule: flag('schedule') || '', by: who || 'planner' }), (r) => `${a1} placed; the Director decides (${r.director})`);
  if (cmd === 'decide') done(decideIdea(a1, a2, { by: who, note: flag('note') || '' }), (r) => `${a1} ${r.stage}`);
  if (cmd === 'collect') {
    const r = collectIdeas();
    console.log(r ? `Ideas for the Producer (${r.task}): ${r.ideas.join(', ')}` : 'No new ideas.');
    process.exit(0);
  }
  if (cmd === 'show') {
    const i = readIdea(a1);
    if (!i) done({ ok: false, message: `No idea ${a1}` });
    console.log(JSON.stringify(i, null, 2));
    process.exit(0);
  }
  if (cmd === 'list') {
    const stage = flag('stage');
    const list = readIdeas().filter((i) => !stage || i.stage === stage);
    console.log(list.length ? list.map((i) => `${i.id} [${i.stage}] (${SOURCES[i.source] || 'dev, pitched'}) ${i.title}${i.place ? ` (Phase ${i.place.phase}${i.place.layer ? `, ${i.place.layer}` : ''})` : ''}`).join('\n') : 'No ideas yet: npm run idea -- add "<title>"');
    process.exit(0);
  }
  console.log('Usage: npm run idea -- add "<title>" | route <id> | shape <id> --notes "…" | place <id> --phase n [--layer id] --unlock "…" --schedule "…" | decide <id> approve|park|reject --by <name> | list | show <id> | collect');
  process.exit(1);
}
