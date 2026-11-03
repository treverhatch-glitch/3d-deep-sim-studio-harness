/**
 * harness/decisions-log.mjs — 2.71.0 (x): one decision log, the autonomous review list, and what autonomous mode saves.
 *
 * Every decision the harness leaves to the owner or a game dev (train release, type, visual, yes, hold/unhold, asset
 * review, quarantine confirm/release, janitor lanes, train auto, upgrade auto, crew resume, wind-down end, studio
 * resume, a held config proposal, the autonomy level, the owner's delegation, autonomous mode itself) writes ONE record
 * to .studio/decisions.jsonl (the main checkout's) plus one `decision` event, at the place it is decided:
 *   { kind: 'decision', id, at, action, subject, by, as, why, evidence, undo }
 *   as: "person" | "delegation <grant time>" | "autonomous" | 'permission "<the person's words>"' | "agent" (a decision
 *       the harness lets an agent take on its own, such as a hold or an asset review under its own name)
 *   undo: { kind, text, ... } (how to revert it; the review list's revert runs it) or null.
 * The existing records (task-types.json, the train queue's release, the hold file, delegation.used) stay what they
 * are; this log points at them instead of repeating them, and a revert run from here never logs the decisions it undoes
 * again (suppressed while it runs).
 *
 *   npm run decisions [-- --since 24h|7d|<ISO>] [--by <name>] [--action <a>] [--json]
 *   npm run decisions -- review                     autonomous decisions waiting for review, oldest first
 *   npm run decisions -- approve <id> --by <name> [--permission "…"]
 *   npm run decisions -- revert <id> --by <name> [--why "…"] [--permission "…"]   runs the record's undo
 *   npm run decisions -- edit <id> --note "what you changed" --by <name> [--permission "…"]
 *   npm run decisions -- stats [--days 14] [--json]  autonomous decisions per day, approved vs reverted, time saved
 * A review is a person's (or an agent's on a person's direct permission, harness/decider.mjs); never the agent that
 * took the decision, never in autonomous mode itself. Work never waits for the review.
 * (The CLI is harness/decisions.mjs. Modules import this one, never the CLI: see harness/policy-rules.mjs.)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { emitEvent, readRecentEvents } from './event.mjs';
import { appendLine } from './fsafe.mjs';
import { mainRoot } from './worktree.mjs';

export const DECISIONS_REL = '.studio/decisions.jsonl';
const H = 3600000;
const DAY = 24 * H;
export const decisionsFile = (root = mainRoot()) => path.join(root, DECISIONS_REL);
const clip = (s, n) => (s === null || s === undefined ? null : String(s).replace(/\s+/g, ' ').trim().slice(0, n));
let suppress = 0;

/** "as" from a decider/delegation result: { via, autonomous, at, permission }. */
export function asOf(d = {}) {
  if (d.autonomous || d.via === 'autonomous') return 'autonomous';
  if (d.via === 'delegation' || d.delegation) return `delegation ${clip(d.at || d.delegation?.at || d.delegation || '', 40)}`;
  const p = clip(d.permission, 200);
  if (p && d.via !== 'person') return `permission "${p}"`;
  return 'person';
}

/**
 * "as" for a decision the harness lets the caller take without anyone's permission (a hold, an asset review under an
 * agent's own name): the delegation/autonomous/permission result when there is one, else "agent" in an agent's shell
 * (a launched session, a coding agent, STUDIO_LOCK_OWNER set), else "person".
 */
export function asCaller(d = null, env = process.env) {
  if (d && (d.autonomous || d.via === 'autonomous' || d.via === 'delegation' || (d.permission && d.via && d.via !== 'person' && d.via !== 'agent'))) return asOf(d);
  const shell = ['STUDIO_ROLE', 'STUDIO_LOCK_OWNER', 'STUDIO_AGENT', 'CLAUDECODE', 'AI_AGENT', 'CODEX_SANDBOX', 'GEMINI_CLI'].some((k) => String(env[k] || '').trim());
  return shell || d?.via === 'agent' ? 'agent' : 'person';
}

/** Append one decision record and one `decision` event. Never throws; returns the record (null when suppressed). */
export function logDecision({ action, subject = null, by, as = 'person', why = '', evidence = '', undo = null, at = null, root = mainRoot() } = {}) {
  if (suppress > 0) return null;
  try {
    const rec = { kind: 'decision', id: `D-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, at: at || new Date().toISOString(), action: String(action || 'decision'), subject: clip(subject, 200), by: clip(by, 60) || 'someone', as: clip(as, 260) || 'person', why: clip(why, 400) || '', evidence: clip(evidence, 300) || '', undo: undo && typeof undo === 'object' ? undo : null };
    const f = decisionsFile(root);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    appendLine(f, JSON.stringify(rec));
    const task = /^[A-Z]+-\d+$/.test(String(rec.subject || '')) ? rec.subject : undefined;
    emitEvent({ type: 'decision', agent: rec.by, task, to: rec.as === 'autonomous' ? 'human' : 'producer', msg: `${rec.by} decided ${rec.action}${rec.subject ? ` ${rec.subject}` : ''} (${rec.as === 'autonomous' ? 'autonomous: on the review list' : rec.as.split(' ')[0]})${rec.why ? `: ${rec.why}` : ''}`.slice(0, 400), meta: rec });
    return rec;
  } catch { return null; }
}

/** Run fn without logging the decisions it makes (a revert undoes one; it is recorded as the review, once). */
export async function quietly(fn) { suppress++; try { return await fn(); } finally { suppress--; } }

/** Every line of the log: { decisions: [], reviews: [] }. */
export function readLog(root = mainRoot()) {
  let text = '';
  try { text = fs.readFileSync(decisionsFile(root), 'utf8'); } catch { return { decisions: [], reviews: [] }; }
  const decisions = [];
  const reviews = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    if (r?.kind === 'review') reviews.push(r);
    else if (r?.kind === 'decision' && r.id) decisions.push(r);
  }
  return { decisions, reviews };
}

/** Decisions with their review state: review = the last approve/revert/edit, or null. */
export function decisionsWithState(root = mainRoot()) {
  const { decisions, reviews } = readLog(root);
  const last = new Map();
  for (const r of reviews) last.set(r.of, r);
  return decisions.map((d) => ({ ...d, review: last.get(d.id) || null }));
}

export const sinceMs = (s, now = Date.now()) => {
  if (!s) return null;
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*([hd])$/i);
  if (m) return now - Number(m[1]) * (m[2].toLowerCase() === 'd' ? DAY : H);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
};

/** The list command's filter. */
export function listDecisions({ since = null, by = null, action = null, root = mainRoot(), now = Date.now() } = {}) {
  const t = sinceMs(since, now);
  return decisionsWithState(root).filter((d) => (t === null || (Date.parse(d.at) || 0) >= t) && (!by || String(d.by).toLowerCase() === String(by).toLowerCase()) && (!action || d.action === action));
}

/** Autonomous decisions nobody reviewed yet, oldest first. */
export function pendingReview(root = mainRoot()) {
  return decisionsWithState(root).filter((d) => d.as === 'autonomous' && !d.review).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

async function reviewWindowH(root) {
  try { return (await import('./policy-rules.mjs')).readPolicy({ root }).effective.autonomous.reviewWithinH; } catch { return 72; }
}

/** The War Room / digest summary of the review list: { pending, oldest, overdue, reviewWithinH, mode }. */
export async function reviewSummary({ root = mainRoot(), now = Date.now() } = {}) {
  const p = pendingReview(root);
  const h = await reviewWindowH(root);
  const overdue = p.filter((d) => now - (Date.parse(d.at) || now) > h * H);
  let mode = 'off';
  try {
    const pol = (await import('./policy-rules.mjs')).readPolicy({ root });
    const a = pol.effective.autonomous;
    mode = pol.counts && a.allowed ? (pol.paused ? `paused (${a.agent})` : `on for ${a.agent}`) : 'off';
  } catch {}
  const o = p[0] || null;
  return { mode, pending: p.length, overdue: overdue.length, reviewWithinH: h, oldest: o ? { id: o.id, at: o.at, action: o.action, subject: o.subject, ageH: Math.round(((now - Date.parse(o.at)) / H) * 10) / 10 } : null, overdueList: overdue.slice(0, 5).map((d) => ({ id: d.id, action: d.action, subject: d.subject, at: d.at })) };
}

/** A synchronous card for the War Room snapshot (harness/status.mjs is sync): no policy lookups beyond the file. */
export function reviewCard({ root = mainRoot(), now = Date.now() } = {}) {
  const p = pendingReview(root);
  let h = 72;
  try { const j = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'policy.json'), 'utf8')); if (Number(j?.autonomous?.reviewWithinH) > 0) h = Number(j.autonomous.reviewWithinH); } catch {}
  const o = p[0] || null;
  return { pending: p.length, overdue: p.filter((d) => now - (Date.parse(d.at) || now) > h * H).length, reviewWithinH: h, oldest: o ? { id: o.id, action: o.action, subject: o.subject, at: o.at, ageH: Math.round(((now - Date.parse(o.at)) / H) * 10) / 10 } : null };
}

// ---- reviewing --------------------------------------------------------------------------------------------------

async function reviewer({ by, permission = '', env, rec }) {
  const who = String(by || '').trim();
  if (!who) return { ok: false, why: 'Say who reviews it: --by <name>.' };
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim().toLowerCase();
  if ([who.toLowerCase(), owner].includes(String(rec.by).toLowerCase())) return { ok: false, why: `Refused: ${rec.by} took this decision; the agent that decided never reviews its own decision. A person does (or an agent on a person's direct permission).` };
  const { deciderCheck } = await import('./decider.mjs');
  const d = await deciderCheck({ by: who, permission, env, action: 'review', what: 'review a decision' });
  return d.ok ? { ok: true, d } : { ok: false, why: d.why };
}

function writeReview(root, rec, { verdict, d, note = '', result = '' }) {
  const r = { kind: 'review', of: rec.id, verdict, at: new Date().toISOString(), by: clip(d.by, 60), as: asOf(d), note: clip(note, 400) || '', result: clip(result, 400) || '' };
  appendLine(decisionsFile(root), JSON.stringify(r));
  emitEvent({ type: `decision.${verdict}`, agent: clip(d.recordedBy || d.by, 60), task: /^[A-Z]+-\d+$/.test(String(rec.subject || '')) ? rec.subject : undefined, to: rec.by, msg: `${r.by} ${verdict} ${rec.id} (${rec.action}${rec.subject ? ` ${rec.subject}` : ''} by ${rec.by}, ${rec.as === 'autonomous' ? 'autonomous' : rec.as.split(' ')[0]})${r.note ? `: ${r.note}` : ''}${r.result ? ` — ${r.result}` : ''}`.slice(0, 500), meta: { ...r, action: rec.action, subject: rec.subject, decidedBy: rec.by, decidedAs: rec.as, decidedAt: rec.at } });
  return r;
}

function find(root, id) { return decisionsWithState(root).find((d) => d.id === id) || null; }

/** approve | edit: record the review. Returns { ok, message }. */
export async function reviewDecision(id, { verdict, by, permission = '', note = '', env = process.env, root = mainRoot() } = {}) {
  const rec = find(root, id);
  if (!rec) return { ok: false, message: `No decision ${id} in ${DECISIONS_REL} (npm run decisions -- review lists the waiting ones).` };
  if (verdict === 'edited' && String(note || '').trim().length < 5) return { ok: false, message: 'Say what you changed or want changed: --note "…" (5+ characters).' };
  const w = await reviewer({ by, permission, env, rec });
  if (!w.ok) return { ok: false, message: w.why };
  writeReview(root, rec, { verdict, d: w.d, note });
  return { ok: true, message: `${rec.id} (${rec.action}${rec.subject ? ` ${rec.subject}` : ''} by ${rec.by}) ${verdict} by ${w.d.by}${note ? `: ${note}` : ''}.${rec.review ? ` (It was ${rec.review.verdict} by ${rec.review.by} before.)` : ''}` };
}

/** The undo runners: each returns { ok, text }. They never log a decision (quietly). */
async function runUndo(rec, { d, why, env, root }) {
  const u = rec.undo || {};
  const by = String(d.by);
  const task = u.task || rec.subject;
  if (u.kind === 'unhold' || u.kind === 'hold' || u.kind === 'needs-yes') {
    const { setHold, readHolds } = await import('./task-hold.mjs');
    if (u.kind === 'unhold') {
      if (!readHolds()[task]?.held) return { ok: true, text: `${task} isn't held any more; nothing to undo` };
      setHold(task, { held: null });
      emitEvent({ type: 'task.unheld', agent: by, task, msg: `${by} released ${task} (revert of ${rec.id}): its claim clock runs again`, meta: { revertOf: rec.id } });
      return { ok: true, text: `${task} is no longer held` };
    }
    if (u.kind === 'hold') {
      setHold(task, { held: { ...(u.held || {}), by: u.held?.by || by, why: u.held?.why || `held again (revert of ${rec.id})`, at: new Date().toISOString() } });
      emitEvent({ type: 'task.held', agent: by, task, to: 'producer', msg: `${by} holds ${task} again (revert of ${rec.id})`, meta: { revertOf: rec.id } });
      return { ok: true, text: `${task} is held again` };
    }
    setHold(task, { needsYes: u.needsYes || { by: rec.by, at: new Date().toISOString() } });
    emitEvent({ type: 'task.needs_yes', agent: by, task, to: 'human', msg: `${by} took back the yes to ${task} (revert of ${rec.id}): it waits for the dev's yes again`, meta: { revertOf: rec.id } });
    return { ok: true, text: `${task} waits for the dev's yes again (if it already started, its session carries on: pause it if needed)` };
  }
  if (u.kind === 'retype' || u.kind === 'visual') {
    const tm = await import('./task.mjs');
    const q = tm.parseNextQueue();
    const t = [...q.inProgress, ...q.backlog, ...q.done].find((x) => x.id === task);
    if (!t) return { ok: false, text: `${task} isn't on the board` };
    const rc = await import('./reclassify.mjs');
    let r;
    if (u.kind === 'retype') {
      const dc = await import('./done-check.mjs');
      const from = dc.typeOf({ id: t.id, title: t.title, role: t.role }).titleType;
      r = rc.reclassify({ task: t, from, to: u.to || 'auto', by: d.by, why: why || `revert of ${rec.id}: ${rec.why || rec.action}`.slice(0, 300), permission: d.via !== 'person' ? d.permission || '' : '', env });
    } else r = rc.setVisual({ task: t, to: u.to || 'auto', by: d.by, why: why || `revert of ${rec.id}: ${rec.why || rec.action}`.slice(0, 300), permission: d.via !== 'person' ? d.permission || '' : '', env });
    return { ok: r.ok, text: r.message };
  }
  if (u.kind === 'rehold-lane') {
    const tr = await import('./train.mjs');
    const r = tr.unreleaseLane(root, task, { head: u.head || null, why: `revert of ${rec.id} by ${by}` });
    if (r.ok) return { ok: true, text: r.message };
    if (!r.landed) return { ok: false, text: r.message };
    const tm = await import('./task.mjs');
    let filed = null;
    try { filed = tm.addTask({ title: `Revert ${task}: its train release (${rec.id}, autonomous) was reverted by ${by} after it landed${why ? `: ${why}` : ''}`.slice(0, 240), role: 'builder', priority: 'P1', agent: by, meta: { revertOf: rec.id, revertTask: task } }); } catch (e) { return { ok: false, text: `${r.message}; filing a revert task failed (${e.message})` }; }
    return { ok: true, text: `${task} already landed, so it can't be held again: filed ${filed?.id || 'a revert task'} to revert it` };
  }
  if (u.kind === 'quarantine-release' || u.kind === 'quarantine-confirm') {
    const fl = await import('./flakes.mjs');
    const r = u.kind === 'quarantine-release' ? await fl.releaseQuarantine(root, u.test, { by: d.by, permission: d.via !== 'person' ? d.permission || '' : '', why: why || `revert of ${rec.id}`, env }) : { ok: false, message: `put ${u.test} back on the list by hand (${u.text || 'npm run flakes'})` };
    return { ok: r.ok, text: r.message };
  }
  if (u.kind === 'asset-review-reopen') {
    const ar = await import('./asset-review.mjs');
    const r = ar.reopenReview ? ar.reopenReview(root, u.asset, { by, why: why || `revert of ${rec.id}` }) : { ok: false, message: 'this harness can\'t reopen a review' };
    return { ok: r.ok, text: r.message };
  }
  if (u.kind === 'train-auto') {
    const td = await import('./train-daemon.mjs');
    const r = await td.setTrainAuto(root, { on: Boolean(u.on), by: d.by, why: why || `revert of ${rec.id}`, permission: d.via !== 'person' ? d.permission || '' : '', env });
    return { ok: r.ok, text: r.message };
  }
  return { ok: false, text: rec.undo?.text ? `undo it by hand: ${rec.undo.text}` : 'this decision has no undo' };
}

/** revert: run the undo, then record the review. Returns { ok, message }. */
export async function revertDecision(id, { by, permission = '', why = '', env = process.env, root = mainRoot() } = {}) {
  const rec = find(root, id);
  if (!rec) return { ok: false, message: `No decision ${id} in ${DECISIONS_REL}.` };
  if (rec.review?.verdict === 'reverted') return { ok: true, message: `${rec.id} was already reverted by ${rec.review.by} (${String(rec.review.at).slice(0, 16)}).` };
  const w = await reviewer({ by, permission, env, rec });
  if (!w.ok) return { ok: false, message: w.why };
  if (!rec.undo || !rec.undo.kind || rec.undo.kind === 'text') return { ok: false, message: `${rec.id} (${rec.action}) has no undo the harness can run${rec.undo?.text ? `: ${rec.undo.text}` : ''}. Undo it by hand, then record it: npm run decisions -- edit ${rec.id} --note "what you did" --by <you>.` };
  let r;
  try { r = await quietly(() => runUndo(rec, { d: w.d, why, env, root })); } catch (e) { r = { ok: false, text: e.message }; }
  if (!r.ok) return { ok: false, message: `Not reverted: ${r.text}. Nothing recorded.` };
  writeReview(root, rec, { verdict: 'reverted', d: w.d, note: why, result: r.text });
  return { ok: true, message: `Reverted ${rec.id} (${rec.action}${rec.subject ? ` ${rec.subject}` : ''} by ${rec.by}): ${r.text}.` };
}

// ---- measuring --------------------------------------------------------------------------------------------------

/**
 * How long a person took to answer each kind of question, from events: [ask types, answer types, key]. An answer whose
 * time matches an autonomous decision on the same subject (within 60 s) isn't a person's wait.
 */
export const WAITS = {
  'train-release': { ask: ['task.train.held'], answer: ['task.train.released'], key: (e) => e.task },
  yes: { ask: ['task.added'], answer: ['task.dev_yes'], key: (e) => e.task, askOk: (e) => e.meta?.origin === 'agent-proposed' },
  'asset-review': { ask: ['asset.review_requested'], answer: ['asset.review'], key: (e) => e.meta?.asset },
  quarantine: { ask: ['test.quarantine_proposed'], answer: ['test.quarantined'], key: (e) => e.meta?.test, answerOk: (e) => e.agent !== 'harness' },
};
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const minWaits = (env = process.env) => (Number(env.STUDIO_DECISION_MIN_N) >= 1 ? Math.round(Number(env.STUDIO_DECISION_MIN_N)) : 10);

/** Person waits per action over the window: { action: [ms] }, and each autonomous decision's own wait. */
export function waitsFromEvents(events, autonomous = [], { now = Date.now(), days = 14 } = {}) {
  const from = now - days * DAY;
  const out = {};
  const own = new Map();
  for (const [action, w] of Object.entries(WAITS)) {
    const asks = new Map();
    out[action] = [];
    const auto = autonomous.filter((d) => d.action === action);
    for (const e of events) {
      const t = Date.parse(e.ts) || 0;
      const k = w.key(e);
      if (!k) continue;
      if (w.ask.includes(e.type) && (!w.askOk || w.askOk(e))) { if (!asks.has(k)) asks.set(k, t); continue; }
      if (!w.answer.includes(e.type) || (w.answerOk && !w.answerOk(e))) continue;
      const a = asks.get(k);
      if (a === undefined) continue;
      asks.delete(k);
      const byAuto = auto.find((d) => String(d.subject) === String(k) && Math.abs((Date.parse(d.at) || 0) - t) < 60000);
      if (byAuto) { own.set(byAuto.id, t - a); continue; }
      if (t >= from) out[action].push(t - a);
    }
  }
  return { person: out, own };
}

/** The measures: per day counts, approved vs reverted, revert rate, time saved per action. */
export function autonomyStats({ root = mainRoot(), events = null, now = Date.now(), days = 14, env = process.env } = {}) {
  const all = decisionsWithState(root);
  const from = now - days * DAY;
  const auto = all.filter((d) => d.as === 'autonomous');
  const inWin = auto.filter((d) => (Date.parse(d.at) || 0) >= from);
  const perDay = {};
  for (const d of inWin) { const k = String(d.at).slice(0, 10); perDay[k] = (perDay[k] || 0) + 1; }
  const approved = inWin.filter((d) => d.review?.verdict === 'approved').length;
  const reverted = inWin.filter((d) => d.review?.verdict === 'reverted').length;
  const edited = inWin.filter((d) => d.review?.verdict === 'edited').length;
  const reviewed = approved + reverted + edited;
  const ev = events || readRecentEvents(50000);
  const { person, own } = waitsFromEvents(ev, auto, { now, days });
  const minN = minWaits(env);
  const saved = {};
  for (const action of [...new Set(inWin.map((d) => d.action))]) {
    const waits = person[action] || [];
    const mine = inWin.filter((d) => d.action === action);
    if (!WAITS[action] || waits.length < minN) { saved[action] = { decisions: mine.length, enough: false, n: waits.length, text: `not enough data (n=${waits.length}${WAITS[action] ? '' : ', no wait is measured for this action'})` }; continue; }
    const med = median(waits);
    const savedMs = mine.reduce((s, d) => s + Math.max(0, med - (own.get(d.id) ?? 0)), 0);
    saved[action] = { decisions: mine.length, enough: true, n: waits.length, medianWaitH: Math.round((med / H) * 10) / 10, savedH: Math.round((savedMs / H) * 10) / 10, text: `${Math.round((savedMs / H) * 10) / 10} h saved (median owner wait ${Math.round((med / H) * 10) / 10} h over ${waits.length})` };
  }
  return { days, total: inWin.length, perDay, approved, reverted, edited, pending: inWin.length - reviewed, revertRate: reviewed ? Math.round((reverted / reviewed) * 1000) / 1000 : null, saved, last24h: inWin.filter((d) => (Date.parse(d.at) || 0) >= now - DAY).length };
}

/** The digest's line ('' when autonomous mode never ran and is off). */
export async function autonomyDigestLine({ root = mainRoot(), events = null, now = Date.now(), env = process.env } = {}) {
  const s = await reviewSummary({ root, now });
  const st = autonomyStats({ root, events, now, env });
  if (s.mode === 'off' && !st.total && !s.pending) return '';
  const pct = st.revertRate === null ? 'no review yet' : `revert rate ${Math.round(st.revertRate * 100)}%`;
  const saved = Object.entries(st.saved).map(([a, v]) => `${a} ${v.enough ? `${v.savedH} h` : 'not enough data'}`).join(', ');
  return `Autonomous mode ${s.mode}: ${st.last24h} decision(s) in 24 h, ${st.total} in ${st.days} days (approved ${st.approved}, reverted ${st.reverted}, ${pct}); ${s.pending} to review${s.oldest ? `, oldest ${s.oldest.ageH} h (${s.oldest.id} ${s.oldest.action} ${s.oldest.subject || ''})`.replace(/ \)$/, ')') : ''}${saved ? `; time saved: ${saved}` : ''} (npm run decisions -- review).`;
}

/** Digest "Needs you" items: autonomous decisions past reviewWithinH. */
export async function overdueNeeds({ root = mainRoot(), now = Date.now() } = {}) {
  const s = await reviewSummary({ root, now });
  if (!s.overdue) return [];
  return [{ kind: 'review', line: `${s.overdue} autonomous decision${s.overdue === 1 ? '' : 's'} waited more than ${s.reviewWithinH} h for your review (oldest ${s.oldest.id}: ${s.oldest.action} ${s.oldest.subject || ''}); work went on: npm run decisions -- review`.replace(/  +/g, ' ') }];
}
