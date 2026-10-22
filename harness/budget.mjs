#!/usr/bin/env node
/**
 * harness/budget.mjs — how much of each tool's plan the studio has used, against a target.
 *
 *   npm run budget                                   per tool: used this week, target by now, what to do
 *   npm run budget -- set claude --weekly 40000000 --reset thursday [--hour 9] [--target 100%]
 *   npm run budget -- order claude,codex,agy         which tool takes over when one runs out
 *   npm run budget -- probe [tool]                   ask the tool with one tiny call; clears a wrong mark
 *   npm run budget -- clear <tool>                   drop a tool's quota mark by hand
 *
 * "Use the plan we pay for": a target like 100% of the week's tokens by the reset. Usage is what the
 * launcher's agents reported at the end of each session (agent.session.end), per tool, since the
 * tool's weekly reset. Plans don't publish token counts, so --weekly is the owner's own estimate (a
 * week's tokens on that plan); without it the studio shows tokens used and can't pace.
 *
 * The supervisor (npm run studio:start) reads this: under target it may start up to two extra lanes;
 * over target it starts nothing new; a tool that hit its limit (usage limit, 429) is skipped until
 * its reset, and its lanes move to the next tool in `order`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents } from './event.mjs';

export const BUDGET_FILE = path.join(REPO_ROOT, 'studio', 'budget.json');
export const QUOTA_FILE = path.join(STUDIO_STATE_DIR, 'tool-quota.json');
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
export const readBudget = () => readJson(BUDGET_FILE, { order: ['claude', 'codex', 'agy'], tools: {} });
const saveBudget = (b) => {
  fs.mkdirSync(path.dirname(BUDGET_FILE), { recursive: true });
  fs.writeFileSync(BUDGET_FILE, `${JSON.stringify(b, null, 2)}\n`);
};

/** When this tool's current week started (its last weekly reset). */
export function weekStart(cfg = {}, now = Date.now()) {
  const day = DAYS.indexOf(String(cfg.resetDay || 'monday').toLowerCase());
  const d = new Date(now);
  d.setHours(Number(cfg.resetHour ?? 0), 0, 0, 0);
  const back = (d.getDay() - (day < 0 ? 1 : day) + 7) % 7;
  d.setDate(d.getDate() - back);
  if (d.getTime() > now) d.setDate(d.getDate() - 7);
  return d.getTime();
}

/**
 * Cache reads count (2.29.2). Test #4's overnight run: 97% of all tokens were cache reads, and a meter
 * that saw only input + output read 4.66M against 100M+ real, so --budget could never trip. They are
 * cheaper than fresh input, so they count at a weight: STUDIO_CACHE_READ_WEIGHT, or cacheReadWeight in
 * studio/budget.json, default 0.1. Cache writes are already in tokensIn.
 */
export function cacheReadWeight() {
  const v = process.env.STUDIO_CACHE_READ_WEIGHT ?? readBudget().cacheReadWeight;
  return v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? 0.1 : Math.max(0, Number(v));
}
/** One event's tokens for the meters: input (with cache writes) + output + weighted cache reads. */
export function weightedTokens(e, w = cacheReadWeight()) {
  return (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0) + (Number(e.meta?.cacheRead ?? e.cacheRead) || 0) * w;
}
/**
 * The daily token cap (weighted tokens since midnight UTC). 2.29.2: it had no default (0 = no cap), so
 * nothing stopped a runaway night. Default 50,000,000, about 1.4x a 10-hour, 104-session overnight
 * test run measured this way; STUDIO_DAILY_TOKEN_CAP sets it, and off or 0 turns it off.
 */
export const DEFAULT_DAILY_TOKEN_CAP = 50000000;
export function dailyCap(env = process.env) {
  const v = env.STUDIO_DAILY_TOKEN_CAP;
  if (v === undefined || v === '') return DEFAULT_DAILY_TOKEN_CAP;
  if (/^(off|no|false|none)$/i.test(String(v))) return 0;
  return Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : DEFAULT_DAILY_TOKEN_CAP;
}

/** Tokens the launcher's agents reported for a tool since a time (cache reads weighted). */
export function usedSince(tool, since, events = readRecentEvents(50000)) {
  const w = cacheReadWeight();
  return Math.round(events.filter((e) => e.type === 'agent.session.end' && (e.meta?.tool || 'unknown') === tool && Date.parse(e.ts) >= since).reduce((n, e) => n + weightedTokens(e, w), 0));
}
/** Raw cache reads and the models behind them, for a tool since a time (counts are only comparable within a model). */
export function cacheSince(tool, since, events = readRecentEvents(50000)) {
  const ends = events.filter((e) => e.type === 'agent.session.end' && (e.meta?.tool || 'unknown') === tool && Date.parse(e.ts) >= since);
  return { cacheRead: ends.reduce((n, e) => n + (Number(e.meta?.cacheRead) || 0), 0), models: [...new Set(ends.map((e) => e.model).filter((m) => m && m !== 'unknown'))] };
}

/**
 * When a provider's limit resets, from its own words: "Resets in 80h54m54s", "resets in 3 days",
 * "try again in 45 minutes", "resets 06:12", "try again at 3pm", or an ISO time. Null when it doesn't say.
 * Test #2: agy's "Resets in 80h54m" (three days) was read as one hour.
 */
export function parseReset(text = '', now = Date.now()) {
  const t = String(text);
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/);
  if (iso && /reset|until|try again|available/i.test(t) && Date.parse(iso[1]) > now) return Date.parse(iso[1]);
  const rel = t.match(/(?:resets?|try again|retry|available)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])[\s,]*(?:and\s+)?)+)/i);
  if (rel) {
    const unit = { d: 86400000, h: 3600000, m: 60000, s: 1000 };
    let ms = 0;
    for (const m of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) ms += Number(m[1]) * unit[m[2].toLowerCase()];
    if (ms > 0) return now + ms;
  }
  const m = t.match(/(?:resets?|try again)(?: at| after)?\s*(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\b/i);
  if (m && (m[2] || m[3])) {
    const d = new Date(now);
    let h = Number(m[1]) % 24;
    if (m[3] && /pm/i.test(m[3]) && h < 12) h += 12;
    if (m[3] && /am/i.test(m[3]) && h === 12) h = 0;
    d.setHours(h, Number(m[2] || 0), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

let VERSION = null;
const harnessVersion = () => {
  if (VERSION) return VERSION;
  try {
    VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    VERSION = 'unknown';
  }
  return VERSION;
};

/**
 * A tool that hit its limit, and when it resets (1 h if the provider didn't say). The provider's own
 * line is kept word for word, so whoever reads "out of quota" sees what the provider actually said.
 */
export function markExhausted(tool, text = '', now = Date.now()) {
  const q = readJson(QUOTA_FILE, {});
  const at = parseReset(text, now);
  const until = at || now + 3600000;
  q[tool] = { until: new Date(until).toISOString(), why: String(text).slice(0, 160), line: String(text).replace(/\s+/g, ' ').trim().slice(0, 240), resetKnown: Boolean(at), at: new Date(now).toISOString(), version: harnessVersion() };
  fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true });
  fs.writeFileSync(QUOTA_FILE, `${JSON.stringify(q, null, 2)}\n`);
  return q[tool];
}
export function clearQuota(tool) {
  const q = readJson(QUOTA_FILE, {});
  if (!q[tool]) return false;
  delete q[tool];
  fs.writeFileSync(QUOTA_FILE, `${JSON.stringify(q, null, 2)}\n`);
  return true;
}
/** The tool a provider error names, if it names one (an error printed by another program in this session). */
export function toolNamed(line = '') {
  const l = String(line);
  if (/AGY_ERROR|antigravity|\bagy\b|gemini/i.test(l)) return 'agy';
  if (/\bcodex\b|chatgpt|openai/i.test(l)) return 'codex';
  if (/\bclaude\b|anthropic/i.test(l)) return 'claude';
  if (/\bgrok\b|x\.ai\b/i.test(l)) return 'grok';
  if (/\bcursor\b/i.test(l)) return 'cursor';
  return null;
}
/**
 * Drop marks we can't trust: written by a harness before 2.26 (they read any "quota" text), expired, or
 * naming another tool's error. Returns what was dropped and what stands.
 */
export function cleanQuotaMarks(now = Date.now()) {
  const q = readJson(QUOTA_FILE, {});
  const dropped = [];
  const kept = [];
  for (const [tool, m] of Object.entries(q)) {
    const other = toolNamed(m.line || m.why);
    const why = Date.parse(m.until) <= now ? 'it had expired' : !m.version ? `it was written by a harness before 2.26 (said: "${String(m.why || '').slice(0, 80)}")` : other && other !== tool ? `the error it quoted was ${other}'s, not ${tool}'s` : null;
    if (why) {
      delete q[tool];
      dropped.push({ tool, why });
    } else kept.push({ tool, until: m.until, line: m.line || m.why || '' });
  }
  if (dropped.length) {
    fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true });
    fs.writeFileSync(QUOTA_FILE, `${JSON.stringify(q, null, 2)}\n`);
  }
  return { dropped, kept };
}
/**
 * Ask the tool itself before believing an old mark: one tiny call ("reply OK"). It answers: the mark is
 * cleared. STUDIO_QUOTA_PROBE=off turns it off; STUDIO_<TOOL>_PROBE_CMD replaces the call.
 */
export function probeTool(tool, { timeoutMs = 90000 } = {}) {
  const custom = process.env[`STUDIO_${String(tool).toUpperCase()}_PROBE_CMD`];
  const argv = custom ? null : { claude: ['claude', '-p', 'Reply with the word OK.', '--output-format', 'json', '--max-turns', '1'], codex: ['codex', 'exec', '--json', ...(process.env.STUDIO_AGENT_MODEL ? ['-m', process.env.STUDIO_AGENT_MODEL] : []), 'Reply with the word OK.'], agy: ['agy', '-p', 'Reply with the word OK.', '--print-timeout', '60s'] }[tool];
  if (!custom && !argv) return { ok: null, why: `no probe for ${tool}` };
  const r = custom ? spawnSync(custom, { shell: true, encoding: 'utf8', timeout: timeoutMs, cwd: REPO_ROOT }) : spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: timeoutMs, cwd: REPO_ROOT, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const limited = /usage limit|rate limit|\b429\b|quota|too many requests|credit balance/i.test(out) && r.status !== 0;
  const ok = r.status === 0 && !/"is_error"\s*:\s*true/.test(out);
  if (ok) clearQuota(tool);
  else if (limited) markExhausted(tool, out.split('\n').reverse().find((l) => /reset|limit|429|quota/i.test(l)) || out.slice(-200));
  return { ok, limited, code: r.status, why: ok ? `${tool} answered; its quota mark is cleared` : limited ? `${tool} is really out: ${out.trim().split('\n').pop().slice(0, 160)}` : `${tool} didn't answer (exit ${r.status ?? 'timeout'})` };
}
export const exhaustedUntil = (tool, now = Date.now()) => {
  const q = readJson(QUOTA_FILE, {})[tool];
  return q && Date.parse(q.until) > now ? q.until : null;
};
export const quotaMark = (tool) => readJson(QUOTA_FILE, {})[tool] || null;
/** The first tool in the order that isn't out of quota, starting from the preferred one. */
export function pickTool(preferred, now = Date.now()) {
  const order = [...new Set([preferred, ...(readBudget().order || [])].filter(Boolean))];
  return order.find((t) => !exhaustedUntil(t, now)) || null;
}

/** Per tool: used, the week's tokens if known, the target by now, and a verdict. */
export function budgetStatus(now = Date.now(), events = readRecentEvents(50000)) {
  const b = readBudget();
  const seen = new Set(events.filter((e) => e.type === 'agent.session.end' && e.meta?.tool).map((e) => e.meta.tool));
  const tools = [...new Set([...Object.keys(b.tools || {}), ...seen, ...Object.keys(readJson(QUOTA_FILE, {}))])];
  return tools.map((tool) => {
    const cfg = (b.tools || {})[tool] || {};
    const start = weekStart(cfg, now);
    const used = usedSince(tool, start, events);
    const weekly = Number(cfg.weeklyTokens) || null;
    const elapsed = Math.min(1, (now - start) / (7 * 86400000));
    const target = Math.min(1, Number(cfg.target ?? 1));
    const pct = weekly ? used / weekly : null;
    const targetPct = target * elapsed;
    const verdict = !weekly ? 'unknown' : pct < targetPct - 0.1 ? 'under' : pct > targetPct + 0.1 ? 'over' : 'on';
    const out = exhaustedUntil(tool, now);
    const mark = out ? quotaMark(tool) : null;
    // The short window (Claude's is 5 hours) apart from the week: a stop is usually the short one.
    const recent = usedSince(tool, now - 5 * 3600000, events);
    const cache = cacheSince(tool, start, events);
    const w = cacheReadWeight();
    const when = out ? (Date.parse(out) - now > 20 * 3600000 ? `${out.slice(5, 10)} ${out.slice(11, 16)} UTC` : `${out.slice(11, 16)} UTC`) : '';
    return { tool, used, recent, weekly, pct, targetPct, verdict, cacheRead: cache.cacheRead, cacheWeight: w, models: cache.models, exhaustedUntil: out, quotaLine: mark?.line || mark?.why || null, resets: new Date(start + 7 * 86400000).toISOString(), text: `${tool}${cache.models.length ? ` (${cache.models.join(', ')})` : ''}: ${recent.toLocaleString()} tokens in the last 5 h, ${used.toLocaleString()} this week, cache reads counted at ${w}x (${cache.cacheRead.toLocaleString()} read)${weekly ? ` (${Math.round(pct * 100)}% of ${weekly.toLocaleString()}; target ${Math.round(targetPct * 100)}% by now: ${verdict === 'under' ? 'under, start more lanes' : verdict === 'over' ? 'over, slow down' : 'on track'})` : ' (set --weekly to pace)'}${out ? `; out of quota until ${when}${mark?.resetKnown === false ? ' (the provider gave no reset time; 1 h assumed)' : ''}. The provider said: "${(mark?.line || mark?.why || '').slice(0, 160)}". Wrong? npm run budget -- probe ${tool}` : ''}` };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  if (argv[0] === 'set') {
    const b = readBudget();
    const t = argv[1];
    if (!t) {
      console.error('npm run budget -- set <tool> --weekly <tokens> --reset <day> [--hour 9] [--target 100%]');
      process.exit(1);
    }
    b.tools = b.tools || {};
    b.tools[t] = { ...(b.tools[t] || {}), ...(flag('weekly') ? { weeklyTokens: Number(flag('weekly')) } : {}), ...(flag('reset') ? { resetDay: flag('reset').toLowerCase() } : {}), ...(flag('hour') ? { resetHour: Number(flag('hour')) } : {}), ...(flag('target') ? { target: Number(String(flag('target')).replace('%', '')) / (String(flag('target')).includes('%') ? 100 : 1) } : {}) };
    saveBudget(b);
  } else if (argv[0] === 'order') {
    const b = readBudget();
    b.order = String(argv[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
    saveBudget(b);
  }
  if (argv[0] === 'probe') {
    const tools = argv[1] ? [argv[1]] : Object.keys(readJson(QUOTA_FILE, {}));
    if (!tools.length) console.log('No tool is marked out of quota.');
    for (const t of tools) console.log(probeTool(t).why);
    process.exit(0);
  }
  if (argv[0] === 'clear') {
    console.log(clearQuota(argv[1]) ? `Cleared ${argv[1]}'s quota mark.` : `${argv[1] || '(no tool)'} has no quota mark.`);
    process.exit(0);
  }
  const st = budgetStatus();
  const cap = dailyCap();
  console.log(cap ? `Daily cap: ${cap.toLocaleString()} tokens (input + output + cache reads at ${cacheReadWeight()}x); STUDIO_DAILY_TOKEN_CAP changes it, off turns it off.` : 'Daily cap: off (STUDIO_DAILY_TOKEN_CAP=off).');
  console.log(st.length ? st.map((s) => s.text).join('\n') : 'No tool has reported usage yet. Agents started with npm run agent or npm run studio:start report it.');
  console.log(`Order when a tool runs out: ${(readBudget().order || []).join(' → ')}`);
}
