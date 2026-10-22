#!/usr/bin/env node
/**
 * harness/ledger.mjs — token ledger across all providers and sources.
 *
 *   npm run ledger -- [--since 24h] [--by task|agent|role|model|provider] [--json]
 *
 * Sources:
 * - agent.session.end events (measured)
 * - route.success events (measured, or estimated for free providers)
 * - qa.vision events (the F15 vision check, measured)
 * - proxy logs in studio/ledger/*.jsonl or from STUDIO_LEDGER_LOGS (measured), e.g. a Gemini proxy's call log
 *
 * Tokens only: no prices. Free models that report no usage are estimated (4 characters per token) and
 * flagged "est." everywhere. Compare tokens within one model family; each counts text differently.
 *
 * This is a complete picture of token use; `npm run tokens` shows only launched sessions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRecentEvents, REPO_ROOT } from './event.mjs';
import { sinceMs } from './tokens.mjs';
import { dailyCap, weightedTokens, cacheReadWeight } from './budget.mjs';

const FREE_PROVIDERS = /nvidia|nim|free|openrouter-free/i;
const MODEL_TO_PROVIDER = {
  gemini: 'google',
  claude: 'anthropic',
  gpt: 'openai',
  'command-r': 'cohere',
  grok: 'xai',
};

const providerFromModel = (model) => {
  if (!model) return 'unknown';
  const prefix = model.split(/[/:-]/)[0].toLowerCase();
  return MODEL_TO_PROVIDER[prefix] || prefix;
};

const percentile = (arr, p) => {
  if (!arr?.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
};

/** Name the model(s) behind a set of rows: one model by name, or "mixed: a 60%, b 40%" by token share. */
export function modelMix(rows) {
  const by = new Map();
  let total = 0;
  for (const r of rows || []) {
    const n = (Number(r.tokensIn) || 0) + (Number(r.tokensOut) || 0);
    const key = `${!r.model || /^unknown( model)?$/i.test(r.model) ? 'model not recorded' : r.model}${r.estimated ? ' est.' : ''}`;
    by.set(key, (by.get(key) || 0) + n);
    total += n;
  }
  if (!by.size) return '';
  const list = [...by.entries()].sort((a, b) => b[1] - a[1]);
  if (list.length === 1) return list[0][0];
  const pct = (n) => `${total ? Math.round((n / total) * 100) : 0}%`;
  const top = list.slice(0, 3).map(([m, n]) => `${m} ${pct(n)}`);
  const rest = list.slice(3).reduce((x, [, n]) => x + n, 0);
  return `mixed: ${top.join(', ')}${list.length > 3 ? `, others ${pct(rest)}` : ''}`;
}

export function ledgerMetrics({ events, now, logs }) {
  const rows = [];
  const sessionStarts = new Map();
  const allEvents = events || readRecentEvents(100000);
  for (const e of allEvents) {
    if (e.type === 'agent.session.start') sessionStarts.set(e.agent, e);
  }

  for (const e of allEvents) {
    if (e.type === 'agent.session.end') {
      const start = sessionStarts.get(e.agent);
      if ((e.tokensIn || 0) + (e.tokensOut || 0) > 0) {
        rows.push({
          source: 'session', ts: e.ts, provider: e.meta?.tool || 'unknown', model: e.model || start?.model, agent: e.agent, role: e.meta?.role || start?.meta?.role, task: start?.task || e.task || null,
          tokensIn: Number(e.tokensIn) || 0, tokensOut: Number(e.tokensOut) || 0, cacheRead: Number(e.meta?.cacheRead) || 0, estimated: false,
          turns: e.meta?.turns, startTs: start?.ts,
        });
      }
    } else if (e.type === 'qa.vision' && (e.tokensIn || e.tokensOut)) {
      rows.push({ source: 'vision', ts: e.ts, provider: 'vision', model: e.model, agent: e.agent, role: 'qa', task: e.task || null, tokensIn: Number(e.tokensIn) || 0, tokensOut: Number(e.tokensOut) || 0, cacheRead: 0, estimated: false });
    } else if (e.type === 'route.success') {
      const hasUsage = (e.tokensIn || 0) + (e.tokensOut || 0) > 0;
      const isFree = e.meta?.free || FREE_PROVIDERS.test(e.provider);
      let estimated = false;
      let { tokensIn = 0, tokensOut = 0 } = e;
      if (isFree && !hasUsage && (e.meta?.charsIn || e.meta?.charsOut || e.meta?.chars)) {
        // 4 characters per token is a rough English average. meta.chars (older events) has no split: it goes out.
        tokensIn = Math.ceil(Number(e.meta.charsIn || 0) / 4);
        tokensOut = Math.ceil(Number(e.meta.charsOut || e.meta.chars || 0) / 4);
        estimated = true;
      } else if (!hasUsage) continue;
      rows.push({
        source: 'router', ts: e.ts, provider: e.provider, model: e.model, agent: e.agent, role: e.meta?.role, task: e.task || null,
        tokensIn: Number(tokensIn), tokensOut: Number(tokensOut), cacheRead: 0, estimated,
      });
    }
  }

  for (const line of logs || []) {
    try {
      const log = JSON.parse(line);
      if (!log.model || (!log.tokensIn && !log.tokensOut)) continue;
      rows.push({
        source: 'proxy-log', ts: log.at, provider: providerFromModel(log.model), model: log.model, agent: log.agent, role: log.role, task: log.task || null,
        tokensIn: Number(log.tokensIn) || 0, tokensOut: Number(log.tokensOut) || 0, cacheRead: 0, estimated: false,
      });
    } catch {}
  }

  const sessions = rows.filter((r) => r.source === 'session');
  // A session counts as finishing its task only when task.done for that agent and task falls inside it.
  const finished = (s) => {
    const start = Date.parse(s.startTs);
    const end = Date.parse(s.ts);
    return Boolean(s.task) && allEvents.some((e) => e.type === 'task.done' && e.agent === s.agent && e.task === s.task && Date.parse(e.ts) >= start && Date.parse(e.ts) <= end);
  };
  const done = sessions.filter(finished);
  const tokensPerDoneTask = done.length ? done.reduce((n, s) => n + s.tokensIn + s.tokensOut, 0) / done.length : null;
  const noDonePct = sessions.length ? ((sessions.length - done.length) / sessions.length) * 100 : null;

  const turns = sessions.map((s) => s.turns).filter((t) => t > 0);
  const turns_p50 = percentile(turns, 50);
  const turns_p95 = percentile(turns, 95);

  const cap = dailyCap();
  let budgetPct = null;
  if (cap) {
    const midnight = new Date(now ?? Date.now());
    midnight.setHours(0, 0, 0, 0);
    const w = cacheReadWeight();
    const todaysEvents = allEvents.filter((e) => Date.parse(e.ts) >= midnight.getTime());
    // Same count as the daily cap the launcher enforces (budget.mjs): launched sessions, cache reads weighted.
    const used = todaysEvents.filter((e) => e.type === 'agent.session.end').reduce((sum, e) => sum + weightedTokens(e, w), 0);
    budgetPct = (used / cap) * 100;
  }

  const providers = [...new Set(rows.map((r) => r.provider))].map((p) => ({ provider: p, estimated: rows.some((r) => r.provider === p && r.estimated) }));
  const midnightMs = new Date(now ?? Date.now()).setHours(0, 0, 0, 0);
  const models = {
    tokensPerDoneTask: modelMix(done),
    budget: modelMix(sessions.filter((r) => Date.parse(r.ts) >= midnightMs)),
    all: modelMix(rows),
  };
  return { rows, providers, models, tokensPerDoneTask, noDonePct, turns_p50, turns_p95, budgetPct };
}

export function readProxyLogs() {
  const logs = [];
  const logPaths = (process.env.STUDIO_LEDGER_LOGS || '').split(',').filter(Boolean);
  const ledgerDir = path.join(REPO_ROOT, 'studio', 'ledger');
  if (fs.existsSync(ledgerDir)) {
    for (const f of fs.readdirSync(ledgerDir)) {
      if (f.endsWith('.jsonl')) logPaths.push(path.join(ledgerDir, f));
    }
  }
  for (const p of logPaths) {
    if (fs.existsSync(p)) logs.push(...fs.readFileSync(p, 'utf8').split('\n').filter(Boolean));
  }
  return logs;
}

function formatLedger(data, { since, by = 'provider' }) {
  const from = sinceMs(since);
  const rows = from ? data.rows.filter((r) => Date.parse(r.ts) >= from) : data.rows;

  const groups = {};
  const groupRows = {};
  const measRows = [];
  const estRows = [];
  const totals = { measured: { in: 0, out: 0, cache: 0, n: 0 }, estimated: { in: 0, out: 0, n: 0 } };

  for (const r of rows) {
    const key = by === 'model' && (!r.model || /^unknown( model)?$/i.test(r.model)) ? 'model not recorded' : r[by] || 'unknown';
    (groupRows[key] ||= []).push(r);
    (r.estimated ? estRows : measRows).push(r);
    const g = (groups[key] ||= { measured: { in: 0, out: 0, cache: 0, n: 0 }, estimated: { in: 0, out: 0, n: 0 } });
    const bucket = r.estimated ? g.estimated : g.measured;
    const totalBucket = r.estimated ? totals.estimated : totals.measured;
    bucket.in += r.tokensIn;
    bucket.out += r.tokensOut;
    bucket.cache += r.cacheRead || 0;
    bucket.n += 1;
    totalBucket.in += r.tokensIn;
    totalBucket.out += r.tokensOut;
    totalBucket.cache += r.cacheRead || 0;
    totalBucket.n += 1;
  }

  const M = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
  const L = [`Token ledger (${since === 'all' ? 'whole event log' : `since ${new Date(from).toISOString().slice(0, 16).replace('T', ' ')} UTC`})`];
  L.push('');
  L.push('Metrics:');
  L.push(`  Tokens per finished task: ${data.tokensPerDoneTask ? `${M(data.tokensPerDoneTask)} (${data.models?.tokensPerDoneTask || 'model not recorded'})` : '–'}`);
  L.push(`  No-done sessions: ${data.noDonePct != null ? `${Math.round(data.noDonePct)}%` : '–'}`);
  L.push(`  Session turns p50/p95: ${data.turns_p50 != null ? `${data.turns_p50} / ${data.turns_p95}` : '–'}`);
  L.push(`  Today's budget used: ${data.budgetPct != null ? `${data.budgetPct.toFixed(1)}%${data.models?.budget ? ` (${data.models.budget})` : ''}` : 'cap off'}`);
  L.push('');
  L.push(`Totals:`);
  L.push(`  Measured: ${totals.measured.n} calls, in ${M(totals.measured.in)}, out ${M(totals.measured.out)}, cache ${M(totals.measured.cache)}${measRows.length ? ` (${modelMix(measRows)})` : ''}`);
  if (totals.estimated.n) L.push(`  Estimated: ${totals.estimated.n} calls, in ${M(totals.estimated.in)}, out ${M(totals.estimated.out)} (${modelMix(estRows)})`);
  L.push('');
  L.push(`By ${by}:`);
  const sorted = Object.entries(groups).sort((a, b) => (b[1].measured.in + b[1].measured.out) - (a[1].measured.in + a[1].measured.out));
  for (const [name, g] of sorted) {
    const m = g.measured;
    const e = g.estimated;
    let line = `  ${name.padEnd(24)} ${String(m.n).padStart(4)} calls  in ${M(m.in).padStart(6)}  out ${M(m.out).padStart(6)}  cache ${M(m.cache).padStart(6)}`;
    if (e.n > 0) line += `  (${e.n} est. calls, out ${M(e.out)})`;
    if (by !== 'model') line += `  [${modelMix(groupRows[name])}]`;
    L.push(line);
  }
  if (!rows.length) L.push('  No token usage recorded in this window.');
  const providers = [...new Set(rows.map((r) => r.provider))];
  const estProviders = [...new Set(rows.filter((r) => r.estimated).map((r) => r.provider))];
  if (providers.length) L.push('', `Providers seen: ${providers.map((p) => `${p}${estProviders.includes(p) ? ' (est.)' : ''}`).join(', ')}`);

  return L.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
  const since = opt('since', 'all');
  const by = opt('by', 'provider');
  const events = readRecentEvents(100000);
  const logs = readProxyLogs();
  const data = ledgerMetrics({ events, now: Date.now(), logs });
  const filteredData = { ...data };
  if (since !== 'all') {
    const from = sinceMs(since);
    filteredData.rows = data.rows.filter((r) => Date.parse(r.ts) >= from);
  }
  console.log(argv.includes('--json') ? JSON.stringify(filteredData, null, 2) : formatLedger(data, { since, by }));
}
