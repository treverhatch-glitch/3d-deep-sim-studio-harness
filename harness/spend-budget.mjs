/**
 * harness/spend-budget.mjs — 2.79.1 (a): spend per API key or tool, always measured; a budget only where someone set one.
 *
 * The owner's words (2026-11-06): "As far as the vertex budget you shouldn't cap that but allow for setting to be placed for
 * API keys to be budgeted and monitored and cut so it doesn't over charge. So allow Patch to set and change budget
 * allocations upon my orders (or orders of the user of the harness)". So:
 *   - Spend is measured for every tool and key, with or without a budget: the dollars each session reported or was priced at
 *     (agent.session.end meta.costUsd; the session record names the key names it got, meta.keys), and Vertex's live usage
 *     log (.studio/vertex-usage.jsonl, harness/vertex.mjs) for sessions on the Vertex proxy. `npm run budget` shows it.
 *   - A budget is per name: a tool (vertex, claude, a tool from studio/tools.json) or a key name (VERTEX_API_KEY,
 *     ANTHROPIC_API_KEY_LANE …). There is none by default. It lives in .studio/spend-budgets.json with its history (who,
 *     when, old -> new, why: the order it carries out).
 *       npm run budget -- set <name> <usd> --by <who> --why "<the owner's order>" [--since all|now|<ISO>]
 *       npm run budget -- clear <name> --by <who> --why "…"         (no budget: measured only)
 *       npm run budget -- resume <name> --by <who> --why "…"        (after a cut: counting starts again from now)
 *   - At 75% of a budget: one page to the orchestrator and one Studio Status line. At 100%: new sessions on that tool or key
 *     are refused with one clear line (agent.mjs launchStop through budget.mjs budgetStopFor; budget.mjs pickTool gives the
 *     supervisor the next tool), and it is said once; running sessions finish. It stays cut until someone allowed raises
 *     the budget or resumes it.
 *   - Who may set, change, clear or resume one: the owner, the orchestrator or the owner's proxy, an outside signer — each on
 *     the owner's order, which --why records; a Producer or Director session only with the owner's switch
 *     STUDIO_PRODUCER_APPROVES=protected; never a worker, a launched worker session or a lane copy. Not an owner-only act.
 * Names and dollars only: no key value is read or printed here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { agentEnv, keymapFor } from './agent-env.mjs';
import { readUsage } from './vertex.mjs';
import { queueNotice } from './comm-notice.mjs';

export const BUDGETS_REL = '.studio/spend-budgets.json';
export const PAGE_AT = 0.75;
const NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const file = () => path.join(STUDIO_STATE_DIR, 'spend-budgets.json');
const usd2 = (x) => `$${(Math.round((Number(x) || 0) * 100) / 100).toFixed(2)}`;
const keyOf = (n) => String(n || '').trim();
const isKeyName = (n) => /^[A-Z][A-Z0-9_]*$/.test(n);
const sameName = (a, b) => (isKeyName(a) || isKeyName(b) ? a === b : a.toLowerCase() === b.toLowerCase());

export function readBudgets() {
  try { const j = JSON.parse(fs.readFileSync(file(), 'utf8')); return { budgets: j.budgets && typeof j.budgets === 'object' ? j.budgets : {}, history: Array.isArray(j.history) ? j.history : [] }; } catch { return { budgets: {}, history: [] }; }
}
function writeBudgets(b) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ note: 'Spend budgets per tool or key name (harness/spend-budget.mjs; npm run budget -- set|clear|resume). No budget: measured only.', budgets: b.budgets, history: b.history.slice(-500) }, null, 2)}\n`);
  fs.renameSync(tmp, file());
}
const budgetOf = (b, name) => { const k = Object.keys(b.budgets).find((x) => sameName(x, keyOf(name))); return k ? { key: k, ...b.budgets[k] } : null; };

/** The key names a session on this tool bills (never values): its tool's keys as mapped (sources, not targets), the proxy's key. */
export function sessionKeyNames({ tool, role = null, agent = null, keys = null, proxy = null, env = process.env } = {}) {
  const e = agentEnv({ tool, role, agent, env, keys });
  const map = new Map(keymapFor({ role, agent, env }).pairs.map((p) => [p.target, p.source]));
  const out = new Set();
  for (const k of Object.keys(e)) if (/(?:_API_KEY|_TOKEN)(?:_[A-Z0-9]+)*$/.test(k) && !/^(STUDIO_|HUB_|AGENT_|NODE_|npm_|PLAYWRIGHT_)/.test(k) && String(e[k] || '').trim()) out.add(map.get(k) || k);
  if (tool === 'vertex' || proxy === 'vertex') out.add('VERTEX_API_KEY');
  // A session tag is not a key (aider's OPENAI_API_KEY=session-… for a proxied session).
  for (const k of [...out]) if (/^session-/.test(String(e[k] || ''))) out.delete(k);
  return [...out].sort();
}

/**
 * Spend for one name since `since` (ms): { usd, tokensIn, tokensOut, sessions, requests }. Sessions on the Vertex proxy count
 * from its usage log (live, mid-session too), every other session from its agent.session.end.
 */
export function spendFor(name, { since = 0, events = null, usage = null } = {}) {
  const n = keyOf(name);
  const r = { usd: 0, tokensIn: 0, tokensOut: 0, sessions: 0, requests: 0 };
  for (const e of events || readRecentEvents(100000)) {
    if (e.type !== 'agent.session.end' || (since && (Date.parse(e.ts) || 0) < since)) continue;
    if (e.meta?.usageFrom === 'vertex-proxy') continue;
    const keys = Array.isArray(e.meta?.keys) ? e.meta.keys : [];
    if (!(sameName(String(e.meta?.tool || ''), n) || keys.includes(n))) continue;
    r.sessions += 1; r.usd += Number(e.meta?.costUsd) || 0; r.tokensIn += Number(e.tokensIn) || 0; r.tokensOut += Number(e.tokensOut) || 0;
  }
  const all = n === 'VERTEX_API_KEY' || sameName(n, 'vertex');
  for (const u of usage || []) {
    if (since && (Date.parse(u.ts) || 0) < since) continue;
    if (!(all || sameName(String(u.tool || ''), n))) continue;
    r.requests += 1; r.usd += Number(u.usd) || 0; r.tokensIn += Number(u.in) || 0; r.tokensOut += Number(u.out) || 0;
  }
  r.usd = Math.round(r.usd * 10000) / 10000;
  return r;
}
function usageLines() { try { return readUsage(); } catch { return []; } }

/** Each budget now: [{ name, usd, spent, pct, since, cut, paged }]. */
export function budgetRows({ events = null, usage = null } = {}) {
  const b = readBudgets();
  const ev = events || readRecentEvents(100000);
  const us = usage || usageLines();
  return Object.entries(b.budgets).map(([name, x]) => {
    const since = Date.parse(x.since) || 0;
    const s = spendFor(name, { since, events: ev, usage: us });
    return { name, usd: Number(x.usd) || 0, spent: s.usd, tokensIn: s.tokensIn, tokensOut: s.tokensOut, sessions: s.sessions, requests: s.requests, pct: Number(x.usd) > 0 ? s.usd / Number(x.usd) : 0, since: x.since || null, cut: x.cut || null, paged: x.paged || null };
  });
}

/** The recorded cut for any of these names, as one reason, or '' (cheap: reads the file only). */
export function cutFor(names = []) {
  const b = readBudgets();
  for (const n of names.map(keyOf).filter(Boolean)) {
    const x = budgetOf(b, n);
    if (x?.cut) return `${x.key} reached its spend budget (${usd2(x.cut.spent)} of ${usd2(x.usd)} since ${String(x.since || 'it was set').slice(0, 16)}): new sessions on it are cut until someone allowed raises it (npm run budget -- set ${x.key} <usd> --by <who> --why "<the owner's order>") or resumes it (npm run budget -- resume ${x.key} --by <who> --why "…")`;
  }
  return '';
}

/**
 * The thresholds, once each per budget window: 75% pages the orchestrator and queues a Studio Status line; 100% records the
 * cut and says so the same way. names: only these budgets (the launcher's check); all when null. Returns what it did.
 */
export function spendPass({ names = null, events = null, usage = null, now = Date.now(), deps = {} } = {}) {
  const b = readBudgets();
  if (!Object.keys(b.budgets).length) return [];
  const want = names ? names.map(keyOf).filter(Boolean) : null;
  if (want && !Object.keys(b.budgets).some((k) => want.some((w) => sameName(w, k)))) return [];
  const ev = events || readRecentEvents(100000);
  const us = usage || usageLines();
  const did = [];
  let changed = false;
  const notice = deps.notice || ((a) => { try { queueNotice({ ...a, kind: 'budget', root: path.dirname(STUDIO_STATE_DIR) }); } catch {} });
  const emit = deps.emit || emitEvent;
  for (const [name, x] of Object.entries(b.budgets)) {
    if (want && !want.some((w) => sameName(w, name))) continue;
    const cap = Number(x.usd) || 0;
    if (!(cap > 0)) continue;
    const s = spendFor(name, { since: Date.parse(x.since) || 0, events: ev, usage: us });
    const pct = s.usd / cap;
    const win = String(x.since || x.setAt || '');
    if (pct >= 1 && !x.cut) {
      x.cut = { at: new Date(now).toISOString(), spent: s.usd };
      changed = true;
      const msg = `${name} reached its spend budget: ${usd2(s.usd)} of ${usd2(cap)}. New sessions on it are cut (running ones finish); the supervisor uses the next tool. Raise it or resume it: npm run budget -- set ${name} <usd> | resume ${name} --by <who> --why "<the owner's order>".`;
      emit({ type: 'budget.cut', agent: 'watchdog', to: 'orchestrator', status: 'blocked', msg, meta: { name, usd: cap, spent: s.usd, since: x.since || null, cc: ['human'] } });
      notice({ key: `budget:${name}:100:${win}`, text: msg });
      did.push({ name, at: 100, msg });
    } else if (pct >= PAGE_AT && !x.cut && x.paged !== win) {
      x.paged = win;
      changed = true;
      const msg = `${name} is at ${Math.round(pct * 100)}% of its spend budget (${usd2(s.usd)} of ${usd2(cap)}); at 100% new sessions on it are cut.`;
      emit({ type: 'budget.warn', agent: 'watchdog', to: 'orchestrator', status: 'warn', msg, meta: { name, usd: cap, spent: s.usd, since: x.since || null, cc: ['human'] } });
      notice({ key: `budget:${name}:75:${win}`, text: msg });
      did.push({ name, at: 75, msg });
    }
  }
  if (changed) writeBudgets(b);
  return did;
}

/**
 * May this shell set, change, clear or resume a budget? { ok, via, why }. The owner, an agent outside the harness (the
 * orchestrator, the owner's proxy, an outside signer) on the owner's order (--why), a Producer/Director session only with
 * STUDIO_PRODUCER_APPROVES=protected; never a worker, a launched worker session or a lane copy.
 */
export async function budgetActor({ by, why, env = process.env, root = REPO_ROOT } = {}) {
  const p = await import('./permission.mjs');
  const who = String(by || '').trim();
  const role = String(env.STUDIO_ROLE || '').trim();
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  if (!who) return { ok: false, why: 'say who: --by <your name>' };
  if (String(why || '').trim().length < 10) return { ok: false, why: 'say whose order this carries out: --why "<the owner\'s order, or the harness user\'s>" (10+ characters)' };
  if (p.WORKER_NAME.test(who) || (owner && p.WORKER_NAME.test(owner))) return { ok: false, why: `${p.WORKER_NAME.test(who) ? who : owner} is a worker agent: workers never set or resume budgets` };
  if (String(env.STUDIO_MAIN_ROOT || '').trim() || /[\\/]\.lanes[\\/][^\\/]+[\\/]?$/.test(REPO_ROOT)) return { ok: false, why: 'not from a lane copy: budgets are set in the main checkout' };
  if (role && !p.DECIDER_ROLES.test(role)) return { ok: false, why: `a launched ${role} session never sets or resumes budgets` };
  if (role && !p.producerApprovesProtected(root)) return { ok: false, why: `a ${role} session sets budgets only with the owner's switch STUDIO_PRODUCER_APPROVES=protected (the studio's .env)` };
  const marker = p.AGENT_SHELL.find((k) => String(env[k] || '').trim());
  return { ok: true, via: role ? role.toLowerCase() : marker || owner ? 'outside agent' : 'person', why: '' };
}

function record(b, entry) { b.history.push({ at: new Date().toISOString(), ...entry }); }
const sinceFrom = (v, now) => { const s = String(v || '').trim().toLowerCase(); if (!s || s === 'now') return new Date(now).toISOString(); if (s === 'all') return null; const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : undefined; };

/** set (new or changed), clear, resume. { ok, text } — the CLI's lines. */
export async function budgetCommand(cmd, { name, usd = null, by, why, since = null, env = process.env, now = Date.now() } = {}) {
  const n = keyOf(name);
  if (!NAME.test(n)) return { ok: false, text: `Usage: npm run budget -- ${cmd} <tool or key name>${cmd === 'set' ? ' <usd>' : ''} --by <who> --why "<the owner's order>"` };
  const a = await budgetActor({ by, why, env });
  if (!a.ok) return { ok: false, text: `Refused: ${a.why}.` };
  const b = readBudgets();
  const cur = budgetOf(b, n);
  const base = { name: cur?.key || n, by: String(by).slice(0, 60), via: a.via, why: String(why).slice(0, 300) };
  if (cmd === 'set') {
    const v = Number(String(usd ?? '').replace(/^\$/, ''));
    if (!(Number.isFinite(v) && v > 0)) return { ok: false, text: 'Give the budget in dollars: npm run budget -- set <name> 200 --by <who> --why "…"' };
    const s = since !== null ? sinceFrom(since, now) : cur ? cur.since ?? null : new Date(now).toISOString();
    if (s === undefined) return { ok: false, text: '--since takes all, now or an ISO time' };
    const key = cur?.key || n;
    b.budgets[key] = { ...(cur ? b.budgets[key] : {}), usd: v, since: s, setAt: new Date(now).toISOString(), setBy: base.by, why: base.why, cut: null };
    record(b, { ...base, action: cur ? 'change' : 'set', from: cur ? Number(cur.usd) : null, to: v, since: s });
    writeBudgets(b);
    const spent = spendFor(key, { since: Date.parse(s) || 0, usage: usageLines() }).usd;
    emitEvent({ type: 'budget.set', agent: base.by, to: 'human', msg: `${base.by} ${cur ? `changed ${key}'s spend budget ${usd2(cur.usd)} -> ${usd2(v)}` : `set a ${usd2(v)} spend budget on ${key}`} (${a.via}): ${base.why}`.slice(0, 500), meta: { name: key, from: cur ? Number(cur.usd) : null, to: v, since: s, via: a.via } });
    spendPass({ names: [key] });
    return { ok: true, text: `${key}: spend budget ${usd2(v)}${cur ? ` (was ${usd2(cur.usd)})` : ''}, counted ${s ? `since ${s.slice(0, 16)}` : 'over all time'}: ${usd2(spent)} spent so far. Pages at 75%, cuts new sessions at 100%.` };
  }
  if (!cur) return { ok: false, text: `${n} has no spend budget (npm run budget lists them).` };
  if (cmd === 'clear') {
    delete b.budgets[cur.key];
    record(b, { ...base, action: 'clear', from: Number(cur.usd), to: null });
    writeBudgets(b);
    emitEvent({ type: 'budget.set', agent: base.by, to: 'human', msg: `${base.by} cleared ${cur.key}'s spend budget (${usd2(cur.usd)}; ${a.via}): ${base.why}`.slice(0, 500), meta: { name: cur.key, from: Number(cur.usd), to: null, via: a.via } });
    return { ok: true, text: `${cur.key}: no spend budget now (measured only).` };
  }
  if (cmd === 'resume') {
    const s = new Date(now).toISOString();
    b.budgets[cur.key] = { ...b.budgets[cur.key], since: s, cut: null, paged: null, resumedAt: s, resumedBy: base.by };
    record(b, { ...base, action: 'resume', from: cur.cut ? cur.cut.spent : null, to: Number(cur.usd), since: s });
    writeBudgets(b);
    emitEvent({ type: 'budget.set', agent: base.by, to: 'human', msg: `${base.by} resumed ${cur.key} (${usd2(cur.usd)} counted again from now; ${a.via}): ${base.why}`.slice(0, 500), meta: { name: cur.key, resumed: true, via: a.via } });
    return { ok: true, text: `${cur.key}: resumed; its ${usd2(cur.usd)} budget counts again from ${s.slice(0, 16)}.` };
  }
  return { ok: false, text: `Unknown budget command ${cmd}` };
}

/** The lines `npm run budget` adds: spend per tool and key (always), and each budget. */
export function spendLines({ events = null } = {}) {
  const ev = events || readRecentEvents(100000);
  const us = usageLines();
  const L = [];
  const v = spendFor('vertex', { usage: us, events: ev });
  if (us.length) L.push(`Vertex (all time, from .studio/vertex-usage.jsonl): ${usd2(v.usd)} over ${v.requests} request(s), ${v.tokensIn.toLocaleString()} in / ${v.tokensOut.toLocaleString()} out tokens.`);
  const tools = new Map();
  for (const e of ev) if (e.type === 'agent.session.end' && Number(e.meta?.costUsd) > 0 && e.meta?.usageFrom !== 'vertex-proxy') { const t = String(e.meta?.tool || '?'); tools.set(t, (tools.get(t) || 0) + Number(e.meta.costUsd)); }
  if (tools.size) L.push(`Dollars at API prices by tool (reported or estimated per session; a plan isn't billed this): ${[...tools].map(([t, d]) => `${t} ${usd2(d)}`).join(', ')}.`);
  const rows = budgetRows({ events: ev, usage: us });
  if (!rows.length) L.push('Spend budgets: none (spend is measured only). Set one: npm run budget -- set <tool or key name> <usd> --by <who> --why "<the owner\'s order>".');
  for (const r of rows) L.push(`Spend budget ${r.name}: ${usd2(r.spent)} of ${usd2(r.usd)} (${Math.round(r.pct * 100)}%) ${r.since ? `since ${r.since.slice(0, 16)}` : 'all time'}${r.cut ? `; CUT at ${r.cut.at.slice(0, 16)}: new sessions refused until raised or resumed` : r.pct >= PAGE_AT ? '; past 75%' : ''}.`);
  return L;
}
