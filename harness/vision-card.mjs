/**
 * harness/vision-card.mjs — 2.85 (f): the designer's vision, cut to what one task needs, for the brief an agent reads
 * before it works (harness/focus.mjs).
 *
 * A review of a live crew found builders never saw the designer's pillars: the brief held the task line, notes, "Done
 * means", lane rules and gates, and none of the signed Game Bible (studio/bible/bible.json). The only vision check was
 * the Director's review after the work had landed. visionCard() returns the few lines from the signed Bible that bear on
 * this task, capped at about 300 words:
 *
 *   pillar  a task that serves a pillar (task add --serves pillar:<name>): the pillar as the Bible has it, the Bible's
 *           "never" answer as a short list (at most 6 items, the ones sharing a word with the title or pillar first),
 *           the "feel great" answer (2 sentences) and the phase's one-line goal.
 *   layer   a task that serves a kept layer: the layer's label and its Bible line, the pillar names as a reminder (the
 *           Bible does not tie layers to pillars), and the same never and feel lines.
 *   port    an engine port (role engine-porter or track engine:*, no --serves): match the web game exactly; never list
 *           capped at 3.
 *   null    tooling, infra, docs and other non-player work, an unsigned or missing Bible, or STUDIO_VISION_CARD=off.
 *
 * Pure apart from reading the Bible (when not given) and checking that studio/bible/FEEL.md exists; never throws.
 */
import fs from 'node:fs';
import path from 'node:path';
import { LAYERS } from './bible.mjs';

export const VISION_HEADING = "## The designer's vision for this task (studio/bible, signed)";
/** The task types whose work a player sees (the card is for these, and the scorecard counts them). */
export const PLAYER_TYPES = new Set(['change', 'bug', 'system', 'whole']);
const NEVER_MAX = 6;
const NEVER_PORT_MAX = 3;
const ITEM_MAX = 160;
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'when', 'then', 'task', 'tasks', 'never', 'must', 'should', 'game', 'player', 'players', 'make', 'more', 'than', 'they', 'them', 'have', 'what', 'your', 'about', 'over', 'every']);

const wordsOf = (s) => [...new Set(String(s || '').toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || [])].filter((w) => !STOP.has(w));
const countWords = (lines) => lines.join(' ').split(/\s+/).filter(Boolean).length;
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** The first n sentences of a text. */
export const sentences = (text, n) => (String(text || '').replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]*(\s|$)/g) || []).slice(0, n).join('').trim();

/** The card switch and cap: STUDIO_VISION_CARD (off removes it), STUDIO_VISION_CARD_WORDS (default 300). */
export const visionCardOn = (env = process.env) => !/^(off|0|false|no)$/i.test(String(env.STUDIO_VISION_CARD || '').trim());
export const visionCardWords = (env = process.env) => { const n = Number(env.STUDIO_VISION_CARD_WORDS); return Number.isFinite(n) && n >= 40 ? Math.floor(n) : 300; };

/**
 * The Bible's "never" answer as a short list: split on sentences, semicolons and new lines; each item at most 160
 * characters; at most `max`. With more items than that, the ones sharing a word with `about` (the title, the pillar)
 * come first, most shared words first; else the first ones.
 */
export function neverItems(never, { about = '', max = NEVER_MAX } = {}) {
  const raw = Array.isArray(never) ? never.join('\n') : String(never || '');
  const items = raw.split(/\r?\n|;|(?<=[.!?])\s+/).map((x) => x.replace(/^\s*[-*•\d.)]+\s*/, '').replace(/[.;,\s]+$/, '').trim()).filter((x) => x.length > 1).map((x) => cut(x, ITEM_MAX));
  if (items.length <= max) return items;
  const want = wordsOf(about);
  const scored = items.map((text, i) => ({ text, i, hits: want.filter((w) => text.toLowerCase().includes(w)).length }));
  if (!scored.some((s) => s.hits)) return items.slice(0, max);
  return scored.sort((a, b) => b.hits - a.hits || a.i - b.i).slice(0, max).map((s) => s.text);
}

/** The Bible at root (null when missing or unreadable). */
export function readBibleAt(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'studio', 'bible', 'bible.json'), 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

/** The pillar a --serves value names (the same prefix match as task add's gate), or null. */
export function pillarFor(bible, serves) {
  const want = String(serves || '').replace(/^pillar:/i, '').trim().toLowerCase();
  if (!want) return null;
  return (bible?.pillars || []).find((p) => p?.name && String(p.name).toLowerCase().startsWith(want)) || null;
}

/** What kind of card a task gets: 'pillar' | 'layer' | 'port' | null (no Bible needed for the answer's shape). */
export function visionKind({ task = {}, meta = {}, type = null } = {}) {
  if (meta.infra || meta.prototype) return null;
  if (type && !PLAYER_TYPES.has(type)) return null;
  const serves = String(meta.serves || '');
  if (/^pillar:/i.test(serves)) return 'pillar';
  if (/^layer:/i.test(serves)) return 'layer';
  if (!serves && (task.role === 'engine-porter' || /^engine:/.test(String(meta.track || '')))) return 'port';
  return null;
}

/**
 * The card for one task: { lines, words, kind, pillar?, layer? } or null. task: { id, title, role }; meta: its
 * task.added meta (serves, phase, part, lane, track); type: its task type (harness/done-check.mjs taskType), when
 * known; bible: the Bible (read from root when undefined).
 */
export function visionCard({ task = {}, meta = {}, type = null, bible, root = process.cwd(), env = process.env } = {}) {
  try {
    if (!visionCardOn(env)) return null;
    const kind = visionKind({ task, meta, type });
    if (!kind) return null;
    const b = bible === undefined ? readBibleAt(root) : bible;
    if (!b || !b.signed) return null;
    const answers = b.answers || {};
    // Each line has a priority: 0 always stays; the cap trims 1 (phase goal) first, then 2 (feel), then 3 (never items, from the end).
    const L = [];
    const add = (text, prio = 0) => L.push({ text, prio });
    let pillar = null;
    let layer = null;
    if (kind === 'port') {
      add('- This is a port: match the web game\'s behaviour exactly; the web game is the spec. Do not improve, rename or re-balance. If the web game seems wrong, hand back with the evidence instead of fixing it in the port.');
      const nv = neverItems(answers.never, { about: task.title, max: NEVER_PORT_MAX });
      if (nv.length) { add('- The game must never:'); for (const x of nv) add(`  - ${x}`, 3); }
    } else {
      if (kind === 'pillar') {
        const p = pillarFor(b, meta.serves);
        if (!p) return null;
        pillar = String(p.name);
        const text = String(p.text || p.rulesOut || '').trim();
        add(`- Pillar **${pillar}**${text ? `: ${p.text ? text : `rules out ${text}`}` : ''}`);
      } else {
        const id = String(meta.serves).slice(6).trim();
        const rec = b.layers?.[id];
        if (!rec || rec.answer !== 'yes') return null;
        layer = id;
        const label = LAYERS.find((l) => l.id === id)?.label || id;
        add(`- Layer **${label}** (kept${rec.phase ? `, phase ${rec.phase}` : ''})${String(rec.why || '').trim() ? `: ${String(rec.why).trim()}` : ''}`);
        // The Bible doesn't tie a layer to pillars (bible.mjs): the pillar names, as a reminder.
        const names = (b.pillars || []).map((p) => p?.name).filter(Boolean);
        if (names.length) add(`- The pillars it must not break: ${names.join(', ')}`);
      }
      const about = `${task.title || ''} ${pillar || ''} ${pillar ? pillarFor(b, meta.serves)?.rulesOut || '' : ''}`;
      const nv = neverItems(answers.never, { about });
      if (nv.length) { add('- The game must never:'); for (const x of nv) add(`  - ${x}`, 3); }
      const feel = sentences(answers.feelGreat, 2);
      if (feel) add(`- What has to feel great: ${feel}`, 2);
      const ph = Number(meta.phase);
      const phaseText = ph >= 1 && ph <= 3 ? String(b.phases?.[ph]?.goal || b.phases?.[ph]?.player || '').trim() : '';
      if (phaseText) add(`- Phase ${ph} goal: ${cut(sentences(phaseText, 1), ITEM_MAX)}`, 1);
    }
    const cap = visionCardWords(env);
    const words = () => countWords(L.map((l) => l.text));
    for (const prio of [1, 2, 3]) {
      while (words() > cap) {
        let i = -1;
        for (let j = L.length - 1; j >= 0; j -= 1) if (L[j].prio === prio) { i = j; break; }
        if (i < 0) break;
        L.splice(i, 1);
      }
    }
    // A "never" heading with no item left goes too.
    const h = L.findIndex((l) => l.text === '- The game must never:');
    if (h >= 0 && !(L[h + 1]?.prio === 3)) L.splice(h, 1);
    if (kind !== 'port' && fs.existsSync(path.join(root, 'studio', 'bible', 'FEEL.md'))) {
      const partName = meta.part || meta.lane || (Array.isArray(meta.paths) && meta.paths[0]) || task.role || 'this task';
      L.push({ text: `- More on feel: studio/bible/FEEL.md (read the part for ${partName} only)`, prio: 0 });
    }
    const lines = L.map((l) => l.text);
    return { lines, words: countWords(lines), kind, ...(pillar ? { pillar } : {}), ...(layer ? { layer } : {}) };
  } catch {
    return null;
  }
}

/** The brief's section for a card: the heading, the card's lines and the hand-back line. reviewed: the reviewed task's id, for a reviewer's brief. */
export function visionSection(card, taskId, { reviewed = null } = {}) {
  if (!card) return [];
  if (reviewed) return [VISION_HEADING, `This is the card ${reviewed}'s builder saw; judge ${reviewed} against it.`, ...card.lines, `If ${reviewed} breaks one of these, request changes and name the line in your review note.`];
  return [VISION_HEADING, ...card.lines, `If what you are about to build breaks one of these, stop and hand back: \`npm run task -- pause ${taskId} --note "vision: <which line and why>"\`.`];
}
