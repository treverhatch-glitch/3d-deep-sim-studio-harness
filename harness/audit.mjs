/**
 * harness/audit.mjs — 2.73.0 (e): audit sampling. A fixed share of hands-free landings and autonomous decisions is
 * picked for an after-the-fact review by someone who didn't do the work. It never blocks work: an audit item waits on
 * the review list (npm run decisions -- review) and in the digest; a failed audit counts as a Redo in the autonomy
 * scorecard's redo rate and so in the L3 bar (harness/autonomy.mjs).
 *
 * The share: studio/policy.json "audit": { "rate": 0.1 } (a policy that counts: harness/policy-rules.mjs); with no rate
 * on file, 0.1 while autonomous mode is on, else 0 (no audits).
 * The draw is seeded, never random: sha256("studio-audit|<seed>") read as a fraction below the rate. The seed is the
 * decision's id for an autonomous decision, and the task id for a landing (landing events carry no commit id, and the
 * task id stays the same when the work is retried, so a retry can't draw again). The same log always picks the same
 * items, and anyone can check a pick: npm run decisions -- audit-draw <seed>.
 *
 * An audit's verdict: `npm run decisions -- audit <AU-id> pass|fail --by <name> [--note "…"] [--permission "…"]`: a
 * person, or an agent on a person's direct permission (harness/decider.mjs), and never one who worked on it (the
 * agents that claimed, ran sessions on or landed the task; the agent that took the decision). An audited autonomous
 * decision is also judged by its review: approved = pass, reverted or edited = fail. Each verdict is one `audit` record
 * in .studio/decisions.jsonl and one `audit.verdict` event (meta.of, meta.verdict) the scorecard reads.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { emitEvent, readRecentEvents } from './event.mjs';
import { appendLine } from './fsafe.mjs';
import { mainRoot } from './worktree.mjs';
import { decisionsFile, asOf, decisionsWithState } from './decisions-log.mjs';

export const AUDIT_DEFAULT_RATE = 0.1;
const DAY = 86400000;
const clip = (s, n) => (s === null || s === undefined ? null : String(s).replace(/\s+/g, ' ').trim().slice(0, n));

/** The seeded draw: a number in [0, 1) from the seed alone. */
export function auditDraw(seed) {
  const h = crypto.createHash('sha256').update(`studio-audit|${String(seed)}`).digest('hex');
  return parseInt(h.slice(0, 13), 16) / 2 ** 52;
}
export const auditPicked = (seed, rate) => Number(rate) > 0 && auditDraw(seed) < Number(rate);
export const landingAuditId = (task) => `AU-${task}`;
export const decisionAuditId = (id) => `AU-${id}`;

/** The rate in force: { rate, source, autonomousOn }. policy: a readPolicy() result (else it is read from root). */
export async function auditRate({ root = mainRoot(), policy = null } = {}) {
  let p = policy;
  if (!p) { try { p = (await import('./policy-rules.mjs')).readPolicy({ root }); } catch { p = null; } }
  const on = Boolean(p?.counts && p.effective?.autonomous?.allowed && !p.paused);
  const explicit = p?.counts && p.effective?.audit?.rate !== null && p.effective?.audit?.rate !== undefined ? p.effective.audit.rate : null;
  if (explicit !== null) return { rate: explicit, source: 'studio/policy.json "audit.rate"', autonomousOn: on };
  return on ? { rate: AUDIT_DEFAULT_RATE, source: 'the default while autonomous mode is on', autonomousOn: on } : { rate: 0, source: 'no "audit.rate" in the policy and autonomous mode is off', autonomousOn: on };
}

function readAudits(root) {
  let text = '';
  try { text = fs.readFileSync(decisionsFile(root), 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r?.kind === 'audit' && r.of) out.push(r); } catch { /* skip */ } }
  return out;
}

/** Who worked on a task: agents that claimed it, ran a session on it or landed it (lower case). */
export function doersOf(task, events) {
  const out = new Set();
  for (const e of events) {
    if (!e?.agent) continue;
    const on = e.task === task || (e.type === 'task.train.landed' && (e.meta?.lanes || []).map(String).includes(task));
    if (on && /^(task\.(start|done|claimed|train\.landed|paused)|agent\.session\.(start|end)|lane\.merged)$/.test(e.type || '')) out.add(String(e.agent).toLowerCase());
  }
  return [...out];
}

const fromReview = (v) => (v === 'approved' ? 'pass' : v === 'reverted' || v === 'edited' ? 'fail' : null);

/**
 * The audit items: hands-free landings and autonomous decisions in the window that the draw picked, each with its
 * verdict (or null: waiting). { rate, source, items, pending, passed, failed }.
 */
export async function auditItems({ root = mainRoot(), events = null, now = Date.now(), days = 14, policy = null, isPersonName = null } = {}) {
  const r = await auditRate({ root, policy });
  const base = { rate: r.rate, source: r.source, autonomousOn: r.autonomousOn, items: [], pending: 0, passed: 0, failed: 0 };
  if (!(r.rate > 0)) return base;
  const ev = events || readRecentEvents(50000);
  const audits = readAudits(root);
  const last = new Map();
  for (const a of audits) last.set(a.of, a);
  const items = [];
  // Hands-free landings (the autonomy scorecard's own judgement).
  try {
    const au = await import('./autonomy.mjs');
    const card = au.buildAutonomy(ev, { now, days, isPersonName: isPersonName || (await au.personClassifier()), weigh: () => 0 });
    for (const t of card.tasks.filter((x) => x.handsFree)) {
      if (!auditPicked(t.task, r.rate)) continue;
      const id = landingAuditId(t.task);
      const v = last.get(id) || null;
      items.push({ id, kind: 'landing', subject: t.task, task: t.task, at: t.landed, seed: t.task, draw: Math.round(auditDraw(t.task) * 1e4) / 1e4, doers: doersOf(t.task, ev), verdict: v?.verdict || null, by: v?.by || null, note: v?.note || '' });
    }
  } catch { /* no scorecard: landings aren't sampled */ }
  // Autonomous decisions.
  try {
    const from = now - days * DAY;
    for (const d of decisionsWithState(root).filter((x) => x.as === 'autonomous' && (Date.parse(x.at) || 0) >= from && (Date.parse(x.at) || 0) <= now)) {
      if (!auditPicked(d.id, r.rate)) continue;
      const id = decisionAuditId(d.id);
      const v = last.get(id) || null;
      const rv = fromReview(d.review?.verdict);
      items.push({ id, kind: 'decision', subject: d.subject || d.action, decision: d.id, action: d.action, at: d.at, seed: d.id, draw: Math.round(auditDraw(d.id) * 1e4) / 1e4, doers: [String(d.by || '').toLowerCase()].filter(Boolean), verdict: v?.verdict || rv, by: v?.by || (rv ? d.review.by : null), note: v?.note || (rv ? `review: ${d.review.verdict}` : '') });
    }
  } catch { /* no decision log */ }
  items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { ...base, items, pending: items.filter((x) => !x.verdict).length, passed: items.filter((x) => x.verdict === 'pass').length, failed: items.filter((x) => x.verdict === 'fail').length };
}

function writeAudit(root, item, { verdict, d, note = '', via = 'audit' }) {
  const rec = { kind: 'audit', of: item.id, verdict, at: new Date().toISOString(), by: clip(d.by, 60), as: d.as || 'person', note: clip(note, 400) || '', itemKind: item.kind, subject: clip(item.subject, 200), seed: item.seed, via };
  appendLine(decisionsFile(root), JSON.stringify(rec));
  emitEvent({ type: 'audit.verdict', agent: clip(d.recordedBy || d.by, 60), task: item.task || (/^[A-Z]+-\d+$/.test(String(item.subject || '')) ? item.subject : undefined), to: 'producer', msg: `${rec.by} audited ${item.id} (${item.kind} ${item.subject}): ${verdict}${rec.note ? ` — ${rec.note}` : ''}${verdict === 'fail' ? ' (counts as a Redo in the autonomy scorecard)' : ''}`.slice(0, 500), meta: { of: item.id, verdict, kind: item.kind, subject: item.subject, seed: item.seed, by: rec.by, as: rec.as, via } });
  return rec;
}

/** `decisions -- audit <id> pass|fail --by <name>`: { ok, message }. */
export async function recordAudit(id, { verdict, by, permission = '', note = '', env = process.env, root = mainRoot(), events = null, now = Date.now() } = {}) {
  const v = String(verdict || '').toLowerCase();
  if (!['pass', 'fail'].includes(v)) return { ok: false, message: 'Usage: npm run decisions -- audit <AU-id> pass|fail --by <name> [--note "…"] [--permission "…"]' };
  if (v === 'fail' && String(note || '').trim().length < 5) return { ok: false, message: 'Say what was wrong: --note "…" (5+ characters).' };
  const all = await auditItems({ root, events, now, days: 60 });
  const item = all.items.find((x) => x.id === id);
  if (!item) return { ok: false, message: `${id} isn't an audit item (picked at ${Math.round(all.rate * 1000) / 10}%, ${all.source}): npm run decisions -- review lists them.` };
  const who = String(by || '').trim();
  if (!who) return { ok: false, message: 'Say who audits it: --by <name>.' };
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim().toLowerCase();
  const did = [who.toLowerCase(), owner].find((n) => n && item.doers.includes(n));
  if (did) return { ok: false, message: `Refused: ${did} worked on ${item.subject}; an audit is by someone who didn't do the work (a person, or an agent on a person's direct permission).` };
  const { deciderCheck } = await import('./decider.mjs');
  const d = await deciderCheck({ by: who, permission, env, action: 'review', what: 'audit work' });
  if (!d.ok) return { ok: false, message: d.why };
  if (d.autonomous || d.via === 'autonomous') return { ok: false, message: 'Refused: an audit is never taken in autonomous mode.' };
  writeAudit(root, item, { verdict: v, d: { ...d, as: asOf(d) }, note });
  return { ok: true, message: `${item.id} (${item.kind} ${item.subject}) audited by ${d.by}: ${v}${note ? ` (${note})` : ''}.${v === 'fail' ? ` It counts as a Redo in the autonomy scorecard.${item.kind === 'decision' ? ` To undo the decision: npm run decisions -- revert ${item.decision} --by <you>.` : ` To redo the work: npm run task -- add "Redo ${item.task}: …" (or reopen it).`}` : ''}${item.verdict ? ` (It was ${item.verdict} before.)` : ''}` };
}

/** A review of an audited autonomous decision is its audit too (approved = pass, reverted/edited = fail). */
export async function auditFromReview(rec, { verdict, d, note = '', root = mainRoot() } = {}) {
  try {
    const v = fromReview(verdict);
    if (!v) return null;
    const r = await auditRate({ root });
    if (!auditPicked(rec.id, r.rate)) return null;
      return writeAudit(root, { id: decisionAuditId(rec.id), kind: 'decision', subject: rec.subject || rec.action, seed: rec.id, task: /^[A-Z]+-\d+$/.test(String(rec.subject || '')) ? rec.subject : undefined }, { verdict: v, d: { ...d, as: asOf(d) }, note: note || `review: ${verdict}`, via: 'review' });
  } catch { return null; }
}

/** The digest's line ('' with no audits). */
export async function auditDigestLine({ root = mainRoot(), events = null, now = Date.now() } = {}) {
  const a = await auditItems({ root, events, now, days: 7 });
  if (!(a.rate > 0) || !a.items.length) return '';
  const o = a.items.find((x) => !x.verdict);
  return `Audits (${Math.round(a.rate * 1000) / 10}% of hands-free landings and autonomous decisions, 7 days): ${a.items.length} picked, ${a.pending} waiting${o ? ` (oldest ${o.id}: ${o.kind} ${o.subject})` : ''}, ${a.passed} passed, ${a.failed} failed (a failed audit counts as a Redo); by someone who didn't do the work, never blocking it: npm run decisions -- review.`;
}
