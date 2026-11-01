#!/usr/bin/env node
/**
 * harness/overnight.mjs — the one-page overnight summary (2.30c, G6).
 *
 *   npm run overnight [-- --since 8h|<ISO>]     write it now for the last 8 h (or since a time)
 *
 * The supervisor writes it on its own when --until is reached. One page: (2.64.0) one autonomy line, then tasks done,
 * tokens per finished task (model named), sessions that finished nothing, forced closes, reviews,
 * the top 5 sessions by tokens, and the cards still open. Files only, no model, no tokens.
 * Saved to studio/daily/overnight-<date>.md (it travels with the studio) and logged as an event.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, readRecentEvents, emitEvent } from './event.mjs';
import { weightedTokens } from './budget.mjs';

const M = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const hm = (iso) => new Date(iso).toTimeString().slice(0, 5);
const day = (t) => new Date(t).toLocaleDateString('sv'); // local date, YYYY-MM-DD

export function buildOvernight({ from, to = Date.now(), events = readRecentEvents(200000), openCards = null } = {}) {
  const win = events.filter((e) => Date.parse(e.ts) >= from && Date.parse(e.ts) <= to);
  const done = win.filter((e) => e.type === 'task.done');
  const ends = win.filter((e) => e.type === 'agent.session.end');
  const starts = win.filter((e) => e.type === 'agent.session.start');
  const byModel = new Map();
  for (const e of ends) {
    const m = e.model || 'unknown model';
    const x = byModel.get(m) || { model: m, sessions: 0, tokens: 0 };
    x.sessions += 1;
    x.tokens += weightedTokens(e);
    byModel.set(m, x);
  }
  const doneBy = new Map();
  for (const d of done) doneBy.set(d.agent, (doneBy.get(d.agent) || 0) + 1);
  for (const f of win.filter((e) => e.type === 'agent.finished_for')) {
    const who = (String(f.msg).match(/^(\S+) ended/) || [])[1];
    if (who) doneBy.set(who, (doneBy.get(who) || 0) + 1);
  }
  const sessions = ends.map((e) => ({ agent: e.agent, model: e.model || 'unknown model', task: starts.filter((s) => s.agent === e.agent && s.ts <= e.ts).pop()?.task || null, tokens: weightedTokens(e), reason: e.meta?.reason || '', refreshed: Boolean(e.meta?.refreshed) }));
  const noDone = sessions.filter((s) => !doneBy.get(s.agent) && !s.refreshed);
  const forced = win.filter((e) => e.type === 'task.forced');
  const reviews = win.filter((e) => /^review\.(written|cli)$/.test(e.type));
  const owed = win.filter((e) => e.type === 'review.owed');
  const total = [...byModel.values()].reduce((n, x) => n + x.tokens, 0);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), done: done.map((e) => ({ task: e.task, agent: e.agent, msg: e.msg })), byModel: [...byModel.values()].sort((a, b) => b.tokens - a.tokens), total, perDone: done.length ? total / done.length : null, sessions: sessions.length, noDone, forced: forced.map((e) => ({ task: e.task, msg: e.msg })), reviews: reviews.length, owed: owed.length, top: [...sessions].sort((a, b) => b.tokens - a.tokens).slice(0, 5), openCards: openCards || [] };
}

export function renderOvernight(o) {
  const L = [`# Overnight summary, ${hm(o.from)} to ${hm(o.to)} (${day(o.to)}, local time)`, ''];
  // 2.64.0: one line from the autonomy scorecard (npm run autonomy), not a heading, so the War Room's head lines stay.
  if (o.autonomy) L.push(o.autonomy, '');
  L.push(`## Tasks done: ${o.done.length}`, ...(o.done.length ? o.done.slice(0, 12).map((d) => `- ${d.task} (${d.agent}): ${String(d.msg).replace(/^Completed [^:]+:\s*/, '').slice(0, 90)}`) : ['- None.']), ...(o.done.length > 12 ? [`- … and ${o.done.length - 12} more (studio/DONE.md)`] : []), '');
  L.push(`## Tokens per finished task: ${o.perDone === null ? 'no task finished' : `${M(o.perDone)} counted tokens`}`, ...o.byModel.map((m) => `- ${m.model}: ${m.sessions} session${m.sessions === 1 ? '' : 's'}, ${M(m.tokens)} counted tokens`), `- Total: ${M(o.total)} counted tokens (in + out + cache reads at their weight) over ${o.sessions} session${o.sessions === 1 ? '' : 's'}`, '');
  L.push(`## Sessions that finished nothing: ${o.noDone.length}`, ...o.noDone.slice(0, 6).map((s) => `- ${s.agent} (${s.model}) on ${s.task || 'no task'}: ${M(s.tokens)} tokens; ${s.reason || 'ended'}`), '');
  L.push(`## Forced closes: ${o.forced.length}`, ...o.forced.slice(0, 6).map((f) => `- ${f.task}: ${String(f.msg).slice(0, 140)}`), '');
  L.push(`## Reviews: ${o.reviews} written${o.owed ? `, ${o.owed} owed` : ''}`, '');
  L.push('## Top 5 sessions by tokens', ...(o.top.length ? o.top.map((s, i) => `${i + 1}. ${s.agent} (${s.model}) on ${s.task || 'no task'}: ${M(s.tokens)} counted tokens${s.refreshed ? ', refreshed' : ''}`) : ['- None.']), '');
  L.push(`## Open cards: ${o.openCards.length}`, ...(o.openCards.length ? o.openCards.slice(0, 8).map((c) => `- ${c}`) : ['- None: nothing waits on you.']), '');
  return L.join('\n');
}

/** Write it (studio/daily/overnight-<date>.md) and log it. Returns the file, relative to the repo. */
export async function writeOvernight({ from, to = Date.now() } = {}) {
  let cards = [];
  try {
    const { buildHudState } = await import('./hud.mjs');
    cards = buildHudState().signals?.needsYou || [];
  } catch {}
  const o = buildOvernight({ from, to, openCards: cards });
  try {
    const { autonomyReport } = await import('./autonomy.mjs');
    o.autonomy = (await autonomyReport({ now: to })).line;
  } catch {}
  const md = renderOvernight(o);
  const rel = `studio/daily/overnight-${day(to)}.md`;
  fs.mkdirSync(path.join(REPO_ROOT, 'studio', 'daily'), { recursive: true });
  fs.writeFileSync(path.join(REPO_ROOT, rel), md);
  emitEvent({ type: 'supervisor.overnight', agent: 'supervisor', to: 'producer', msg: `Overnight summary: ${o.done.length} done, ${o.noDone.length} sessions finished nothing, ${o.forced.length} forced, ${o.openCards.length} open cards (${rel})`, meta: { file: rel } });
  return { file: rel, summary: o, md };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const i = process.argv.indexOf('--since');
  const s = i >= 0 ? process.argv[i + 1] : '8h';
  const rel = String(s).match(/^(\d+(?:\.\d+)?)h$/);
  const from = rel ? Date.now() - Number(rel[1]) * 3600000 : Date.parse(s);
  if (!Number.isFinite(from)) {
    console.error('Usage: npm run overnight [-- --since 8h|<ISO time>]');
    process.exit(1);
  }
  const r = await writeOvernight({ from });
  console.log(r.md);
  console.log(`Saved to ${r.file}`);
}
