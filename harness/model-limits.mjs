#!/usr/bin/env node
/**
 * harness/model-limits.mjs — what each model can take, for the Director to know (2.30h, item 4).
 *
 *   npm run models:limits [-- --json]
 *
 * Awareness, never a lock: nothing here blocks or skips a model. Each model's context size and rate
 * limits (requests per minute and per day, tokens per minute) come from a built-in table of published
 * free-tier figures, overridden or extended by studio/model-limits.json:
 *   { "models": { "<model name or /regex/>": { "context": 1048576, "rpm": 5, "rpd": 100, "tpm": 250000, "note": "…" } } }
 * The Director's brief and the War Room show the table with what the last 24 h used and any limit
 * trouble (429s, quota errors, reasoning-only replies, a day's requests near the cap), so the Director
 * decides routing: which model gets a long task, which family takes over. The figures change; when a
 * provider publishes new ones, edit studio/model-limits.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, readRecentEvents } from './event.mjs';
import { modelFamily } from './families.mjs';

const FILE = path.join(REPO_ROOT, 'studio', 'model-limits.json');
// Approximate published figures (free tiers where a model has one); providers change them, so check and
// correct them in studio/model-limits.json. Context in tokens.
export const BUILT_IN = [
  [/gemini-3(\.\d)?-pro/i, { context: 1048576, rpm: 25, rpd: 250, tpm: 2000000, note: 'paid preview; strong logic, check its edit formatting' }],
  [/gemini-3(\.\d)?-flash/i, { context: 1048576, rpm: 1000, rpd: 10000, tpm: 1000000, note: 'quick, simple calls' }],
  [/gemini-2\.5-pro/i, { context: 1048576, rpm: 5, rpd: 100, tpm: 250000 }],
  [/gemini-2\.5-flash/i, { context: 1048576, rpm: 10, rpd: 250, tpm: 250000 }],
  // Claude/Opus get a context ceiling like every other model (the reviewer's ask); the 1M beta when the id says so.
  [/(opus|sonnet).*(\[1m\]|-1m\b|1m-context)/i, { context: 1000000, note: 'long-context beta; plan limits (5-hour and weekly windows), see npm run budget' }],
  [/claude.*(opus|sonnet)|^(opus|sonnet)/i, { context: 200000, note: 'plan limits (5-hour and weekly windows), see npm run budget' }],
  [/claude.*haiku|^haiku/i, { context: 200000 }],
  [/gpt-5|codex/i, { context: 400000, note: 'plan limits, see npm run budget' }],
  [/grok-4/i, { context: 256000 }],
  [/nemotron-ultra|nemotron-super|nvidia\//i, { context: 128000, rpm: 40, note: 'NIM free tier; long replies can be all reasoning' }],
  [/glm/i, { context: 128000, rpm: 40, note: 'NIM free tier; 0 for 4 as a reviewer (reasoning-only replies)' }],
  [/groq|llama-3\.3-70b/i, { context: 131072, rpm: 30, rpd: 1000, tpm: 12000, note: 'small token-per-minute budget: short tasks only' }],
  [/openrouter|:free/i, { context: 32000, rpm: 20, rpd: 50, note: 'free models: 50 requests a day without credit' }],
];

export function readOverrides() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')).models || {};
  } catch {
    return {};
  }
}

/** The limits on record for a model ({} when nothing is known). The studio's file wins over the table. */
export function limitsFor(model, overrides = readOverrides()) {
  const m = String(model || '');
  for (const [k, v] of Object.entries(overrides)) {
    const re = /^\/.*\/[a-z]*$/.test(k) ? new RegExp(k.slice(1, k.lastIndexOf('/')), k.slice(k.lastIndexOf('/') + 1)) : null;
    if (re ? re.test(m) : k === m) return { ...v, source: 'studio/model-limits.json' };
  }
  for (const [re, v] of BUILT_IN) if (re.test(m)) return { ...v, source: 'built-in' };
  return {};
}

const TROUBLE = /\b429\b|rate.?limit|quota|resource.?exhausted|too many requests|context.?(length|window)|maximum context|reasoning.only/i;
/**
 * Per model, from the event log: calls in the last 24 h and the last minute, the biggest prompt sent,
 * and limit trouble. Flags are words for the Director, never actions.
 */
export function limitWatch({ events = readRecentEvents(20000), now = Date.now(), overrides = readOverrides() } = {}) {
  const day = now - 86400000;
  const by = new Map();
  const get = (model) => {
    if (!by.has(model)) by.set(model, { model, family: modelFamily(model), calls24h: 0, callsLastMin: 0, maxIn: 0, trouble: [], ...{ limits: limitsFor(model, overrides) } });
    return by.get(model);
  };
  for (const e of events) {
    const at = Date.parse(e.ts || '');
    if (!e.model || !(at >= day)) continue;
    if (e.type === 'route.success' || e.type === 'agent.session.end') {
      const r = get(e.model);
      r.calls24h += 1;
      if (now - at < 60000) r.callsLastMin += 1;
      r.maxIn = Math.max(r.maxIn, Number(e.tokensIn) || 0);
    }
    if ((e.type === 'route.failover' || e.type === 'route.reasoning_only' || e.status === 'error') && TROUBLE.test(`${e.type} ${e.msg || ''}`)) get(e.model).trouble.push({ at: e.ts, what: e.type === 'route.reasoning_only' ? 'reasoning-only reply' : String(e.msg || '').slice(0, 120) });
  }
  const rows = [...by.values()].map((r) => {
    const L = r.limits;
    const flags = [];
    if (L.rpd && r.calls24h >= 0.8 * L.rpd) flags.push(`${r.calls24h} of ${L.rpd} requests a day`);
    if (L.rpm && r.callsLastMin >= 0.8 * L.rpm) flags.push(`${r.callsLastMin} of ${L.rpm} requests this minute`);
    if (L.context && r.maxIn >= 0.8 * L.context) flags.push(`a ${r.maxIn.toLocaleString()}-token prompt against a ${L.context.toLocaleString()} context`);
    if (r.trouble.length) flags.push(`${r.trouble.length} limit error(s) or reasoning-only replies in 24 h (last: ${r.trouble.at(-1).what})`);
    return { ...r, flags };
  });
  return rows.sort((a, b) => b.flags.length - a.flags.length || b.calls24h - a.calls24h);
}

const fmt = (n) => (n ? (n >= 1000000 ? `${(n / 1048576).toFixed(n % 1048576 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)) : '?');
export function describeLimits(L) {
  const parts = [L.context ? `context ${fmt(L.context)}` : null, L.rpm ? `${L.rpm}/min` : null, L.rpd ? `${L.rpd}/day` : null, L.tpm ? `${fmt(L.tpm)} tokens/min` : null].filter(Boolean);
  return parts.length ? parts.join(', ') : 'limits not on record';
}

/** Lines for the Director's brief: every model in use, its limits, and the flags. Context, not rules. */
export function limitsBrief(opts) {
  const rows = limitWatch(opts);
  if (!rows.length) return ['- No model calls in the last 24 h.'];
  return [
    '> Awareness, not locks: no model is blocked. You decide routing (a long task to a big-context model, a family switch after limit trouble) and tell the Producer.',
    ...rows.slice(0, 12).map((r) => `- ${r.model} (${r.family}): ${describeLimits(r.limits)}; ${r.calls24h} call(s) in 24 h${r.flags.length ? `. **Watch:** ${r.flags.join('; ')}` : ''}${r.limits.note ? ` (${r.limits.note})` : ''}`),
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = limitWatch();
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log('Model limits (awareness for the Director; nothing is blocked)');
    for (const l of limitsBrief()) console.log(l);
    console.log('\nBuilt-in table:');
    for (const [re, v] of BUILT_IN) console.log(`  ${re.source}: ${describeLimits(v)}${v.note ? ` (${v.note})` : ''}`);
  }
}
