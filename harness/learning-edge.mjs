/**
 * harness/learning-edge.mjs — 2.61 (the learning edge): what past failures say about how to plan and cut the work.
 *
 * A script: no model, no tokens. It reads the same files `npm run learn` reads, without importing harness/learn.mjs
 * (that file is someone else's to change, and pulls in the scorecard):
 *   - lessons from fixed bugs (studio/memory/failures.md), each with its "How to avoid it next time" rule,
 *   - what keeps happening: the same failure on two or more days (.studio/events.jsonl), merged into the lesson it
 *     matches (a lesson that didn't stick counts its repeats),
 *   - causes a person accepted (studio/decisions/accepted-causes.json, from `npm run causes -- accept`),
 *   - retro suggestions the Producer accepted and ticked (`- [x]` in studio/memory/retros/*.md).
 * Each becomes one line with its source id, ranked by repeat count × recency (half-life
 * STUDIO_CONSTRAINTS_HALFLIFE_DAYS, default 14). The top STUDIO_CONSTRAINTS_K (default 5) lines, each cut to
 * STUDIO_CONSTRAINTS_LINE characters (default 200), go into the Director's brief, the Producer's handoff, the
 * planner's prepared brief and the planning roles' kickoffs as "constraints from past failures": rules for how the
 * work is planned and cut, not only for the worker who does it. The text was written by agents and people, so it
 * sits in the marked block (harness/untrusted.mjs).
 *
 * The same matching (keywords, failure kinds) measures how useful a pitfall line is (harness/pitfalls.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPO_ROOT, readRecentEvents } from './event.mjs';
import { untrustedBlock } from './untrusted.mjs';

/** Failure events (the kinds `npm run learn` counts as "keeps happening"). */
export const FAILURE_KINDS = /^(closedloop\.(retry|escalate)|task\.not_done|task\.forced|task\.reopened|route\.exhausted|watch\.alert|task\.refused)$/;
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'task', 'tasks', 'after', 'since', 'when', 'not', 'was', 'has', 'have', 'its', 'are', 'but', 'agent', 'never', 'always', 'dont', "don't", 'must', 'avoid', 'only', 'ever']);
export const keywords = (s) => [...new Set(String(s || '').toLowerCase().match(/[a-z][a-z-]{3,}/g) || [])].filter((w) => !STOP.has(w));
/** Two texts are about the same thing when they share two or more keywords (the rule `npm run learn` uses). */
export const related = (a, b, min = 2) => {
  const B = new Set(Array.isArray(b) ? b : keywords(b));
  return (Array.isArray(a) ? a : keywords(a)).filter((w) => B.has(w)).length >= min;
};

/** A failure's shape without the parts that change every time (ids, numbers, hashes, quoted names). */
export function signature(msg) {
  return String(msg || '')
    .toLowerCase()
    .replace(/\b[0-9a-f]{12,}\b/g, '#')
    .replace(/\b(t|bug|reg|i|x)-[\w-]+/g, '#')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/"[^"]*"|`[^`]*`/g, '"…"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

const read = (rel) => {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return '';
  }
};
const oneLine = (s) => String(s || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
const shortHash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 6);
const day = (ts) => String(ts || '').slice(0, 10);

/** Lessons from fixed bugs: { id, source, heading, date, rule, words }. */
export function readLessons() {
  const parts = (read('studio/memory/failures.md').split('## Recorded Distilled Notes')[1] || '').split(/^### /m).slice(1);
  return parts.map((l, i) => {
    const heading = l.split('\n')[0].trim();
    const date = (heading.match(/\[(\d{4}-\d{2}-\d{2})\]/) || [])[1] || null;
    const id = (heading.replace(/\[[^\]]*\]\s*/, '').match(/^([A-Za-z][\w.-]*-[\w.-]+)\s/) || [])[1] || `L${i + 1}`;
    const avoid = (l.match(/^- \*\*How to avoid it next time\*\*:\s*(.+)$/m) || [])[1];
    const title = heading.replace(/\[[^\]]*\]\s*/, '').replace(/^[\w.-]+\s+[—-]\s+/, '');
    return { id, source: `failures.md#${id}`, heading, date, rule: oneLine(avoid || title), words: keywords(l) };
  });
}

/** The same failure on two or more days: { sig, type, sample, days, count, last, words }. */
export function readRepeats(events) {
  const groups = new Map();
  for (const e of events) {
    if (!FAILURE_KINDS.test(e.type || '') || !e.msg) continue;
    const sig = `${e.type}: ${signature(e.msg)}`;
    const g = groups.get(sig) || { sig, type: e.type, sample: e.msg, days: new Set(), count: 0, last: '' };
    g.days.add(day(e.ts));
    g.count += 1;
    if (String(e.ts) > g.last) g.last = String(e.ts);
    groups.set(sig, g);
  }
  return [...groups.values()].filter((g) => g.days.size >= 2).map((g) => ({ ...g, days: [...g.days].sort(), words: keywords(g.sample) }));
}

/** Causes a person accepted with `npm run causes -- accept` (read here, never written). */
export function readAcceptedCauses() {
  try {
    return JSON.parse(read('studio/decisions/accepted-causes.json')).accepted || [];
  } catch {
    return [];
  }
}

/** Retro suggestions the Producer accepted and ticked (`- [x] …`), with how many retros raised them. */
export function acceptedRetroSuggestions() {
  const dir = path.join(REPO_ROOT, 'studio', 'memory', 'retros');
  if (!fs.existsSync(dir)) return [];
  const seen = new Map();
  for (const f of fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(n)).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').split('\n')) {
      const m = line.match(/^- \[( |x)\] (.+)$/i);
      if (!m || /Nothing repeated/.test(m[2])) continue;
      const sig = signature(m[2]);
      const s = seen.get(sig) || { text: m[2], retros: [], accepted: false, last: '' };
      s.retros.push(f.slice(0, 10));
      if (m[1].toLowerCase() === 'x') {
        s.accepted = true;
        s.last = f.slice(0, 10);
      }
      seen.set(sig, s);
    }
  }
  return [...seen.values()].filter((s) => s.accepted);
}

/** K, the line budget and the half-life, from the environment. */
export function constraintSettings(env = process.env) {
  const num = (v, d, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && v !== '' && v != null ? Math.min(max, Math.max(min, Math.round(n))) : d;
  };
  return { k: num(env.STUDIO_CONSTRAINTS_K, 5, 0, 20), lineChars: num(env.STUDIO_CONSTRAINTS_LINE, 200, 60, 400), halfLifeDays: num(env.STUDIO_CONSTRAINTS_HALFLIFE_DAYS, 14, 1, 365) };
}

/**
 * Every constraint, ranked: { total, items: [{ source, text, count, last, score }] } (items cut to k).
 * score = count × 0.5^(age in days / half-life); ties go to the newer one.
 */
export function buildConstraints({ events = null, now = Date.now(), env = process.env, ...over } = {}) {
  const set = { ...constraintSettings(env), ...over };
  const ev = events || readRecentEvents(50000);
  const items = [];
  const lessons = readLessons();
  const byLesson = new Map(lessons.map((l) => [l.id, { source: l.source, text: l.rule, count: 1, last: l.date || '' }]));
  for (const r of readRepeats(ev)) {
    const lesson = lessons.map((l) => ({ l, hits: r.words.filter((w) => l.words.includes(w)).length })).filter((x) => x.hits >= 2).sort((a, b) => b.hits - a.hits)[0]?.l;
    if (lesson) {
      // A lesson that didn't stick: its repeats count, and it is as recent as its last repeat.
      const it = byLesson.get(lesson.id);
      it.count += r.count;
      it.repeated = (it.repeated || 0) + r.days.length;
      if (day(r.last) > it.last) it.last = day(r.last);
    } else items.push({ source: `repeat:${r.type}#${shortHash(r.sig)}`, text: `${r.type} on ${r.days.length} days: ${oneLine(r.sample)}`, count: r.count, last: day(r.last) });
  }
  items.push(...byLesson.values());
  readAcceptedCauses().forEach((c, i) => items.push({ source: `cause:${i + 1}`, text: `Tasks were forced past "${oneLine(c.cause)}" (accepted by ${oneLine(c.by)}${c.why ? `: ${oneLine(c.why)}` : ''})`, count: Math.max(1, (c.tasks || []).length), last: day(c.at) }));
  for (const s of acceptedRetroSuggestions()) items.push({ source: `retro:${s.last}`, text: oneLine(s.text), count: s.retros.length, last: s.last });
  for (const it of items) {
    const t = Date.parse(it.last || '');
    const age = Number.isFinite(t) ? Math.max(0, (now - t) / 86400000) : 365;
    it.score = Math.round(it.count * 0.5 ** (age / set.halfLifeDays) * 1000) / 1000;
  }
  items.sort((a, b) => b.score - a.score || String(b.last).localeCompare(String(a.last)) || a.source.localeCompare(b.source));
  return { total: items.length, settings: set, items: items.slice(0, set.k) };
}

/** One line per constraint, inside the line budget: "[source · N× · last date] text". */
export function constraintLines(c) {
  const max = c.settings?.lineChars || 200;
  return c.items.map((it) => {
    const line = `- [${it.source} · ${it.count}× · last ${it.last || 'undated'}] ${it.text}`;
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  });
}

/**
 * The block for a planning brief ('' when there is nothing): a heading in the harness's words, then the lines in
 * the marked block. `heading` is the markdown prefix ('##' in briefs, '' for a plain bold line).
 */
export function constraintsBlock({ heading = '##', for: who = 'planning', ...opts } = {}) {
  const c = buildConstraints(opts);
  if (!c.items.length) return '';
  const title = `Constraints from past failures (top ${c.items.length} of ${c.total}, by repeats × recency)`;
  const how = who === 'director'
    ? 'Cut the next work around these: say which task carries each one (a check first, or a split that keeps a lane away from it) when you point the Producer at the next work.'
    : 'Plan and cut work so these can\'t happen again: give a repeated one its own check task first, keep a lane that would trip one apart, and name the constraint in the task that touches it.';
  return [heading ? `${heading} ${title}` : `**${title}**`, how, 'Source ids: failures.md#<lesson>, repeat:<event kind>#<id> (npm run learn), cause:<n> (npm run causes), retro:<date> (a ticked retro suggestion).', '', untrustedBlock([{ label: 'Lessons, repeated failures, accepted causes and accepted retro suggestions (written by agents and people)', text: constraintLines(c).join('\n') }]).trimEnd()].join('\n');
}

/** For JSON consumers (handoff --json): the ranked items without the block. */
export const constraintsData = (opts = {}) => buildConstraints(opts);
