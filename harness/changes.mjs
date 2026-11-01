#!/usr/bin/env node
/**
 * harness/changes.mjs — 2.61.0: change records, the learning edge's measurement. A script: no model, no tokens.
 *
 *   npm run learn -- change add --kind harness|skill|pitfall|rule --target <file or line> --signature <sig> [--signature …]
 *                               --expect "<what should drop>" --risk "<what could go wrong>" --revert "<command>"
 *                               [--commit <sha>] [--title "…"] [--by <name>]
 *   npm run learn -- change list
 *   npm run learn -- change eval        evaluate the records that are due now (the HUB does it daily)
 *
 * Every change to the harness, a skill (studio/skills/), a pitfall (studio/PITFALLS.md) or a rule carries a small record,
 * studio/changes/C-<n>.json (committed): which failure signatures it should reduce (the signatures `npm run learn` shows
 * under "Keeps happening", e.g. sig-3fa9c2d1, or "task.not_done: <message>"), the expected effect, the risk and the
 * revert command. After STUDIO_CHANGE_EVAL_TASKS finished tasks (default 20) or STUDIO_CHANGE_EVAL_DAYS days (default
 * 7), the signature rate per task type is compared before and after the change. A type counts only with at least
 * STUDIO_CHANGE_MIN_SAMPLE finished tasks on each side (default 5); with none, the answer is "not enough data" and the
 * record keeps watching. A rise of STUDIO_CHANGE_MARGIN (default 0.1, ten points) in any type is "regressed", a drop
 * as large in some type is "kept", anything else "no effect".
 *
 * "regressed" files one question for the owner (harness/ask.mjs, no deadline, never on a timer): revert or keep.
 * Nothing here reverts anything: the record holds the command, a person decides. The proposer never grades: the verdict
 * is this script's arithmetic on the event log, not an agent's opinion.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPO_ROOT, actor, emitEvent, readRecentEvents } from './event.mjs';
import { ask } from './ask.mjs';

export const CHANGES_DIR = path.join(REPO_ROOT, 'studio', 'changes');
const LADDER_FILE = path.join(CHANGES_DIR, 'ladder.json');
export const CHANGE_KINDS = ['harness', 'skill', 'pitfall', 'rule'];

/** The failure events whose shapes the studio counts ("the same failure on two or more days"). */
export const FAILURE_TYPES = /^(closedloop\.(retry|escalate)|task\.not_done|task\.forced|task\.reopened|route\.exhausted|watch\.alert|task\.refused)$/;

/** A text's shape without the parts that change every time (ids, numbers, hashes, names in quotes), uncut. */
export function shape(msg) {
  return String(msg || '')
    .toLowerCase()
    .replace(/\b[0-9a-f]{12,}\b/g, '#')
    .replace(/\b(t|bug|reg|i|x)-[\w-]+/g, '#')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/"[^"]*"|`[^`]*`/g, '"…"')
    .replace(/\s+/g, ' ')
    .trim();
}
/** A failure's shape: the first 140 characters of it. */
export const signature = (msg) => shape(msg).slice(0, 140);
/** "<event type>: <signature>", the key `npm run learn` groups failures by. */
export const signatureKey = (e) => `${e.type}: ${signature(e.msg)}`;
/** A short, stable id for a signature key: what lessons, change records and ladder tasks name. */
export const signatureId = (key) => `sig-${crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 8)}`;

const num = (v, d) => (Number.isFinite(Number(v)) && String(v ?? '').trim() !== '' ? Number(v) : d);
export function evalConfig(env = process.env) {
  return {
    tasks: num(env.STUDIO_CHANGE_EVAL_TASKS, 20),
    days: num(env.STUDIO_CHANGE_EVAL_DAYS, 7),
    minSample: num(env.STUDIO_CHANGE_MIN_SAMPLE, 5),
    margin: num(env.STUDIO_CHANGE_MARGIN, 0.1),
  };
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);
};
const fileOf = (id) => path.join(CHANGES_DIR, `${id}.json`);

export function readChanges() {
  if (!fs.existsSync(CHANGES_DIR)) return [];
  return fs.readdirSync(CHANGES_DIR).filter((f) => /^C-\d+\.json$/.test(f)).sort((a, b) => Number(a.slice(2, -5)) - Number(b.slice(2, -5))).map((f) => readJson(path.join(CHANGES_DIR, f))).filter(Boolean);
}

/**
 * One signature as given on the command line: a signature id (sig-xxxxxxxx), "<event type>: <message>" (normalized the
 * way learn groups them), or a bare message (matches that shape under any failure type).
 */
export function parseSignature(s) {
  const t = String(s || '').trim();
  if (/^sig-[0-9a-f]{8}$/i.test(t)) return { id: t.toLowerCase() };
  const m = t.match(/^([a-z]+(?:\.[a-z_]+)+):\s*(.+)$/i);
  if (m && FAILURE_TYPES.test(m[1])) {
    const key = `${m[1]}: ${signature(m[2])}`;
    return { id: signatureId(key), key };
  }
  const text = signature(t);
  return text.length >= 8 ? { text } : null;
}

export function matchesSignature(e, sigs) {
  if (!FAILURE_TYPES.test(e?.type || '') || !e.msg) return false;
  const key = signatureKey(e);
  const id = signatureId(key);
  const sig = signature(e.msg);
  return sigs.some((s) => (s.id && s.id === id) || (s.key && s.key === key) || (s.text && sig.includes(s.text)));
}

export function addChange({ kind, target, signatures = [], expect, risk, revert, commit = null, title = null, by = actor(), at = new Date().toISOString() } = {}) {
  if (!CHANGE_KINDS.includes(kind)) return { ok: false, message: `--kind is one of: ${CHANGE_KINDS.join(', ')} (what was changed).` };
  if (!String(target || '').trim()) return { ok: false, message: 'Say what changed: --target <file, skill or pitfall line>.' };
  const sigs = (Array.isArray(signatures) ? signatures : [signatures]).map(parseSignature).filter(Boolean);
  if (!sigs.length) return { ok: false, message: 'Name the failure it should reduce: --signature <sig-xxxxxxxx from npm run learn, or "<event type>: <message>">. A change with no failure to reduce can\'t be measured.' };
  if (!String(expect || '').trim()) return { ok: false, message: 'Say the expected effect: --expect "<which failure drops, for which tasks>".' };
  if (!String(risk || '').trim()) return { ok: false, message: 'Say the risk: --risk "<what could get worse>".' };
  const rev = String(revert || '').trim() || (commit ? `git revert --no-edit ${commit}` : '');
  if (!rev) return { ok: false, message: 'Give the revert command: --revert "<command>" (or --commit <sha> for git revert).' };
  const n = readChanges().reduce((m, c) => Math.max(m, Number(String(c.id).slice(2)) || 0), 0) + 1;
  const rec = {
    id: `C-${String(n).padStart(3, '0')}`,
    title: String(title || `${kind}: ${target}`).slice(0, 200),
    kind,
    target: String(target).slice(0, 300),
    signatures: sigs,
    expect: String(expect).slice(0, 500),
    risk: String(risk).slice(0, 500),
    revert: rev.slice(0, 300),
    commit: commit || null,
    by,
    at,
    status: 'watching',
  };
  writeJson(fileOf(rec.id), rec);
  emitEvent({ type: 'change.added', agent: by, msg: `${rec.id} ${rec.title}: should reduce ${sigs.map((s) => s.id || s.text).join(', ')}`, meta: { change: rec.id, kind } });
  return { ok: true, change: rec };
}

/** The type of a task as the board says (injected by learn.mjs), else what its task.added event carried. */
function fallbackTypes(events) {
  const m = new Map();
  for (const e of events) if (e.type === 'task.added' && e.task && e.meta?.type) m.set(e.task, e.meta.type);
  return (id) => m.get(id) || 'unknown';
}

/**
 * Before and after for one record. Tasks are counted by when they finished (task.done or task.forced); a task "hit" the
 * signature when a matching failure event for it falls on the same side of the change. Before: the tasks finished in the
 * D days before the change, or the last N before it when that is more.
 */
export function evaluateChange(c, { events = readRecentEvents(0), now = Date.now(), typeOf = null, cfg = evalConfig() } = {}) {
  const at = Date.parse(c.at) || 0;
  const tOf = typeOf || fallbackTypes(events);
  const finished = new Map();
  for (const e of events) if ((e.type === 'task.done' || e.type === 'task.forced') && e.task) finished.set(e.task, Date.parse(e.ts) || 0);
  const all = [...finished.entries()].sort((a, b) => a[1] - b[1]);
  const after = all.filter(([, t]) => t >= at);
  const beforeAll = all.filter(([, t]) => t < at);
  const recent = beforeAll.filter(([, t]) => t >= at - cfg.days * 86400000);
  const before = recent.length >= cfg.tasks ? recent : beforeAll.slice(-Math.max(cfg.tasks, recent.length));
  const days = (now - at) / 86400000;
  const due = after.length >= cfg.tasks || days >= cfg.days;
  if (!due) return { verdict: 'not due', afterTasks: after.length, days: Math.round(days * 10) / 10, byType: [] };
  const hitsBefore = new Set();
  const hitsAfter = new Set();
  for (const e of events) {
    if (!e.task || !matchesSignature(e, c.signatures || [])) continue;
    ((Date.parse(e.ts) || 0) >= at ? hitsAfter : hitsBefore).add(e.task);
  }
  const side = (list, hits) => {
    const m = new Map();
    for (const [id] of list) {
      const type = tOf(id);
      const s = m.get(type) || { tasks: 0, hit: 0 };
      s.tasks += 1;
      if (hits.has(id)) s.hit += 1;
      m.set(type, s);
    }
    return m;
  };
  const b = side(before, hitsBefore);
  const a = side(after, hitsAfter);
  const rate = (s) => (s && s.tasks ? Math.round((s.hit / s.tasks) * 1000) / 1000 : null);
  const byType = [...new Set([...b.keys(), ...a.keys()])].sort().map((type) => {
    const bs = b.get(type) || { tasks: 0, hit: 0 };
    const as = a.get(type) || { tasks: 0, hit: 0 };
    const eligible = bs.tasks >= cfg.minSample && as.tasks >= cfg.minSample;
    return { type, before: { ...bs, rate: rate(bs) }, after: { ...as, rate: rate(as) }, eligible, delta: eligible ? Math.round((rate(as) - rate(bs)) * 1000) / 1000 : null };
  });
  const ok = byType.filter((t) => t.eligible);
  const out = { afterTasks: after.length, beforeTasks: before.length, days: Math.round(days * 10) / 10, byType, minSample: cfg.minSample, margin: cfg.margin };
  if (!ok.length) return { ...out, verdict: 'not enough data' };
  const worse = ok.filter((t) => t.delta >= cfg.margin - 1e-9).sort((x, y) => y.delta - x.delta);
  const better = ok.filter((t) => t.delta <= -cfg.margin + 1e-9);
  if (worse.length) return { ...out, verdict: 'regressed', worst: worse[0] };
  if (better.length) return { ...out, verdict: 'kept' };
  return { ...out, verdict: 'no effect' };
}

const pct = (r) => (r == null ? '–' : `${Math.round(r * 100)}%`);
export const describeType = (t) => `${t.type}: ${pct(t.before.rate)} of ${t.before.tasks} before, ${pct(t.after.rate)} of ${t.after.tasks} after`;

/**
 * Evaluate every record still watching. A verdict is written into the record (committed with the studio's notes); a
 * "regressed" one files exactly one revert question for the owner. Records with a verdict are never re-graded.
 */
export function evaluateChanges({ events = readRecentEvents(0), now = Date.now(), typeOf = null, cfg = evalConfig(), by = 'learn' } = {}) {
  const results = [];
  for (const c of readChanges()) {
    if (c.status !== 'watching') continue;
    const r = evaluateChange(c, { events, now, typeOf, cfg });
    if (r.verdict === 'not due') continue;
    const verdict = { verdict: r.verdict, at: new Date(now).toISOString(), beforeTasks: r.beforeTasks, afterTasks: r.afterTasks, days: r.days, byType: r.byType };
    const rec = { ...c, lastEval: verdict };
    if (r.verdict !== 'not enough data') {
      rec.status = r.verdict;
      rec.verdict = verdict;
    }
    if (r.verdict === 'regressed' && !c.proposal) {
      const why = `${c.id} (${c.title}) was meant to reduce ${c.signatures.map((s) => s.id || `"${s.text}"`).join(', ')}. After ${r.afterTasks} finished tasks the rate rose for ${describeType(r.worst)}.`;
      const a = ask({ question: `Revert ${c.id}? ${why} Revert with: ${c.revert}`, options: ['revert', 'keep'], why: `Measured by npm run learn (before/after per task type, at least ${cfg.minSample} tasks each side). Expected: ${c.expect}. Risk named: ${c.risk}`, by });
      if (a.ok) rec.proposal = a.ask.id;
      emitEvent({ type: 'change.regressed', agent: by, to: 'human', status: 'warn', msg: `${c.id} regressed: ${describeType(r.worst)}. ${a.ok ? `${a.ask.id} asks the owner to revert or keep` : 'no question filed'} (nothing is reverted by itself)`, meta: { change: c.id, ask: a.ok ? a.ask.id : null } });
    } else if (r.verdict !== 'not enough data') {
      emitEvent({ type: 'change.verdict', agent: by, msg: `${c.id} ${r.verdict}: ${r.byType.filter((t) => t.eligible).map(describeType).join('; ')}`, meta: { change: c.id, verdict: r.verdict } });
    }
    writeJson(fileOf(c.id), rec);
    results.push({ id: c.id, verdict: r.verdict, proposal: rec.proposal || null });
  }
  return results;
}

/** One line per record, for LEARNED.md and the upgrade notes. */
export function changeLine(c) {
  const v = c.verdict || c.lastEval;
  const types = (v?.byType || []).filter((t) => t.eligible).map(describeType).join('; ');
  const state = c.status === 'watching' ? (c.lastEval ? `watching (last check: ${c.lastEval.verdict}, ${c.lastEval.afterTasks} tasks after)` : 'watching') : c.status;
  return `${c.id} [${c.kind}] ${c.title}: ${state}${types ? ` (${types})` : ''}${c.proposal ? `; revert asked in ${c.proposal}` : ''}`;
}

/** The lesson → check ladder's ledger: one task per signature, ever (studio/changes/ladder.json, committed). */
export const readLadder = () => readJson(LADDER_FILE) || {};
export const writeLadder = (l) => writeJson(LADDER_FILE, l);
