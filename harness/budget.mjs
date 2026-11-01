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
import { spawnAgentSync } from './launch.mjs';

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

// PU-19: wall-clock times in a named time zone, with Intl only (no dependency). An empty zone is this machine's.
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WALL_FMT = new Map();
function wallParts(ms, zone) {
  const k = zone || '';
  if (!WALL_FMT.has(k)) WALL_FMT.set(k, new Intl.DateTimeFormat('en-US', { timeZone: zone || undefined, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' }));
  const p = Object.fromEntries(WALL_FMT.get(k).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month) - 1, d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second), wd: WEEKDAYS.indexOf(String(p.weekday).toLowerCase().slice(0, 3)) };
}
/** The instant a wall-clock time names in a zone; day overflow (the 32nd) rolls on, as Date.UTC does. */
function fromWall(y, mo, d, h, mi, zone) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const offset = (ms) => {
    const w = wallParts(ms, zone);
    return Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
  };
  const first = guess - offset(guess);
  return guess - offset(first); // a second look, in case a DST change lies between the guess and the answer
}
/** An IANA zone in brackets, "(Asia/Bangkok)", that this Node knows; null otherwise. */
function zoneIn(t) {
  const m = String(t).match(/\(\s*((?:[A-Za-z_]+\/)+[A-Za-z0-9_+-]+|UTC|GMT)\s*\)/);
  if (!m) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: m[1] });
    return m[1];
  } catch {
    return null;
  }
}
/** Hours and minutes from "9am", "9:30 pm", "14:00"; null for an impossible time. */
function clock(hs, ms, ap) {
  let h = Number(hs);
  const mi = Number(ms || 0);
  if (ap && (h < 1 || h > 12)) return null;
  if (h > 23 || mi > 59) return null;
  if (ap && /p/i.test(ap) && h < 12) h += 12;
  if (ap && /a/i.test(ap) && h === 12) h = 0;
  return [h, mi];
}

/**
 * When a provider's limit resets, from its own words: "Resets in 80h54m54s", "resets in 3 days",
 * "try again in 45 minutes", "resets 06:12", "try again at 3pm", or an ISO time. Null when it doesn't say.
 * Test #2: agy's "Resets in 80h54m" (three days) was read as one hour.
 * PU-19 (P-042) adds Claude Code's forms: "usage limit reached|1761962400" (the reset in unix seconds, or
 * milliseconds with 13 digits), a weekday ("resets Mon 9am", "resets Tuesday 14:00": the next one after now),
 * a date ("resets Nov 3, 9am", "Nov 3 at 9:00", "3 Nov 9am"; a date more than 45 days off is not believed),
 * and a zone in brackets ("resets 3pm (Asia/Bangkok)") for any clock time. Without a zone a clock time is
 * read in this machine's local time, as before. A reset time already past is no reset time (null).
 * The exact wording of Claude Code's limit lines is not verified against a live run.
 */
export function parseReset(text = '', now = Date.now()) {
  const t = String(text);
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/);
  if (iso && /reset|until|try again|available/i.test(t) && Date.parse(iso[1]) > now) return Date.parse(iso[1]);
  const epoch = t.match(/\blimit\b[^|\n]{0,40}\|\s*(\d{13}|\d{10})(?!\d)/i);
  if (epoch) {
    const at = epoch[1].length === 13 ? Number(epoch[1]) : Number(epoch[1]) * 1000;
    return at > now ? at : null;
  }
  const rel = t.match(/(?:resets?|try again|retry|available)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])[\s,]*(?:and\s+)?)+)/i);
  if (rel) {
    const unit = { d: 86400000, h: 3600000, m: 60000, s: 1000 };
    let ms = 0;
    for (const m of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) ms += Number(m[1]) * unit[m[2].toLowerCase()];
    if (ms > 0) return now + ms;
  }
  const zone = zoneIn(t);
  const w = wallParts(now, zone);
  const KEY = String.raw`(?:resets?|try again|available(?: again)?)(?:\s+(?:on|at))?\s+`;
  const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?`;
  const WD = String.raw`(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?`;
  const MON = String.raw`(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`;
  const wd = t.match(new RegExp(`${KEY}${WD},?\\s+(?:at\\s+)?${TIME}(?![\\w:])`, 'i'));
  if (wd && (wd[3] || wd[4])) {
    const hm = clock(wd[2], wd[3], wd[4]);
    if (hm) {
      const ahead = (WEEKDAYS.indexOf(wd[1].toLowerCase()) - w.wd + 7) % 7;
      let at = fromWall(w.y, w.mo, w.d + ahead, hm[0], hm[1], zone);
      if (at <= now) at = fromWall(w.y, w.mo, w.d + ahead + 7, hm[0], hm[1], zone);
      return at;
    }
  }
  const md = t.match(new RegExp(`${KEY}${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(?:at\\s+)?${TIME}(?![\\w:]))?`, 'i'));
  const dm = md ? null : t.match(new RegExp(`${KEY}(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}(?![a-z])(?:,?\\s+(?:at\\s+)?${TIME}(?![\\w:]))?`, 'i'));
  if (md || dm) {
    const [mon, day, hs, ms, ap] = md ? [md[1], md[2], md[3], md[4], md[5]] : [dm[2], dm[1], dm[3], dm[4], dm[5]];
    const hm = hs ? clock(hs, ms, ap) : [0, 0];
    const mo = MONTHS.indexOf(mon.toLowerCase());
    if (hm && Number(day) >= 1 && Number(day) <= 31) {
      for (const y of [w.y, w.y + 1]) {
        const at = fromWall(y, mo, Number(day), hm[0], hm[1], zone);
        if (at > now) return at - now <= 45 * 86400000 ? at : null;
      }
    }
  }
  const m = t.match(/(?:resets?|try again)(?: at| after)?\s*(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\b/i);
  if (m && (m[2] || m[3])) {
    const hm = clock(m[1], m[2], m[3]) || [Number(m[1]) % 24, Number(m[2] || 0)];
    let at = fromWall(w.y, w.mo, w.d, hm[0], hm[1], zone);
    if (at <= now) at = fromWall(w.y, w.mo, w.d + 1, hm[0], hm[1], zone);
    return at;
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
// Only a real limit message from a provider (shared with the launcher, the probe and the reviewer).
// PU-19 (P-042): Claude Code's window limits, "5-hour limit reached ∙ resets 3pm", "Weekly limit reached",
// "Opus weekly limit reached", "session limit reached", "You've reached your weekly limit", and any
// "… limit reached" followed by a reset time or "|<unix time>". A usage-window word (5-hour, session, daily,
// weekly, monthly, usage, plan, Opus, Sonnet, model) or a reset time is required, so "recursion limit reached"
// or "file size limit reached" in a stack trace is not a usage limit. These wordings are taken from what
// users report; they are not verified against a live Claude Code run.
const LIMIT_WINDOW = String.raw`(?:(?:\d+|five)[- ]?hours?|hourly|hours?|session|daily|weekly|monthly|usage|plan|opus|sonnet|model)`;
const LIMIT_RESET = String.raw`resets?\s+(?:(?:in|at|on)\s+)?(?:\d|(?:sun|mon|tue|wed|thu|fri|sat|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|today|tomorrow)`;
const WINDOW_LIMIT = String.raw`\b${LIMIT_WINDOW}(?:[ -](?:${LIMIT_WINDOW}|\d+(?:\.\d+)?))*[ -]limit (?:reached|exceeded|hit)\b|(?:hit|reached) (?:your|the) (?:(?:${LIMIT_WINDOW}|rate|\d+(?:\.\d+)?)[ -])*limit\b|\blimit (?:reached|exceeded|hit)(?:\|\d{10,13}\b|\b[^\w\n]{0,6}(?:(?:it|and|which|will) )?${LIMIT_RESET})`;
const PROVIDER_LIMIT = /usage limit (?:reached|exceeded|hit)|(?:hit|reached) (?:your|the) (?:usage |rate )?limit|\b429\b|too many requests|rate[ _-]?limit(?:ed| exceeded| reached| error)|quota (?:exceeded|exhausted)|insufficient[_ ]quota|credit balance is too low|insufficient[_ ]credits?|out of (?:credits|quota)|credits? (?:refused|exhausted|depleted)|payment required|\b402\b|spend(?:ing)? (?:limit|cap|guard) (?:reached|exceeded|hit)|budget (?:exceeded|exhausted)|token (?:cap|limit|budget) (?:reached|exceeded|hit)/i;
export const QUOTA_ERROR = new RegExp(`${PROVIDER_LIMIT.source}|${WINDOW_LIMIT}`, 'i');
/**
 * PU-19: the hand-back note of a session that stopped at its usage limit. It is not a failure: the circuit
 * breaker (its "usage limit" words), the loop park, the model escalation and the supervisor's halt skip it.
 */
export const LIMIT_STOP = /\bstopped at its usage limit\b/i;
/** The provider's limit line in a failed command's stderr (or stdout when it printed nothing else), or null. */
export function limitLine(stderr = '', stdout = '', code = 1) {
  if (code === 0) return null;
  const lines = `${stderr || ''}`.trim() ? String(stderr).split('\n') : String(stdout || '').split('\n').slice(-5);
  return lines.reverse().find((l) => QUOTA_ERROR.test(l) && !/"type"\s*:\s*"(?:user|assistant|system|stream_event)"/.test(l)) || null;
}
export function markExhausted(tool, text = '', now = Date.now()) {
  const q = readJson(QUOTA_FILE, {});
  const at = parseReset(text, now);
  const until = at || now + 3600000;
  // 2.30 (J12): a stop shows the numbers it used: tokens counted in the last 5 h and this week, by model.
  let used = null;
  try {
    const ev = readRecentEvents(20000);
    const c = cacheSince(tool, now - 5 * 3600000, ev);
    used = { last5h: usedSince(tool, now - 5 * 3600000, ev), models: c.models };
  } catch {}
  q[tool] = { until: new Date(until).toISOString(), why: String(text).slice(0, 160), line: String(text).replace(/\s+/g, ' ').trim().slice(0, 240), resetKnown: Boolean(at), at: new Date(now).toISOString(), version: harnessVersion(), ...(used ? { used } : {}) };
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
  if (/\bhermes\b/i.test(l)) return 'hermes';
  if (/\bgrokbot\b/i.test(l)) return 'grokbot';
  if (/AGY_ERROR|antigravity|\bagy\b/i.test(l)) return 'agy';
  if (/gemini/i.test(l)) return (readBudget().order || []).includes('gemini') ? 'gemini' : 'agy';
  // 2.58.3 (M4): a NIM session (aider on NVIDIA's OpenAI-compatible endpoint) is nim's, not codex's.
  if (/integrate\.api\.nvidia|\bnvidia\b|\bnim\b/i.test(l)) return 'nim';
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
  // P-066: no shell for the tool (harness/launch.mjs); on Windows "Reply with the word OK." reached claude word by word.
  const r = custom ? spawnSync(custom, { shell: true, encoding: 'utf8', timeout: timeoutMs, cwd: REPO_ROOT }) : spawnAgentSync(argv, { encoding: 'utf8', timeout: timeoutMs, cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  // 2.30 (J12): the provider's own limit message only; a word like "quota" anywhere in the answer isn't one.
  const said = limitLine(r.stderr, r.stdout, r.status);
  const limited = Boolean(said);
  const ok = r.status === 0 && !/"is_error"\s*:\s*true/.test(out);
  if (ok) clearQuota(tool);
  else if (limited) markExhausted(tool, said);
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
  // 2.30o: an entry may be tool or tool:model; it is out when either it or its tool is marked.
  return order.find((t) => !exhaustedUntil(t, now) && !(t.includes(':') && exhaustedUntil(t.split(':')[0], now))) || null;
}

/**
 * 2.58.0 (PU-40, P-051): the key a usage limit on a custom command (STUDIO_<ROLE>_CMD, STUDIO_AGENT_CMD) is saved
 * under: `custom:<program>`, the program's base name without its extension, lower case. For an interpreter
 * (node, python, bash, cmd /c, powershell -File, npx …) the script it runs names it. Quotes, Windows paths and
 * leading NAME=value settings are handled. Saved as plain `custom` (2.57.0), no launch check could match it, so
 * the next launch hit the same limit at once; per program, two different custom commands don't hold each other.
 * Null for an empty command.
 */
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'py', 'bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell', 'cmd', 'npx', 'pnpx', 'bunx', 'env', 'call', 'start', 'exec', 'uv', 'uvx', 'ruby', 'perl']);
export function customKey(cmd = '') {
  const words = (String(cmd).match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^["']|["']$/g, ''));
  const base = (w) => String(w).split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh|mjs|cjs|js|ts|py|rb|pl)$/i, '').replace(/^\.+/, '');
  const setting = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
  // A flag: -x, --x, or cmd.exe's /c (a word starting with / is a path when it has another / or a dot).
  const flag = (w) => /^-/.test(w) || /^\/[^/\\.]*$/.test(w);
  let i = 0;
  while (i < words.length && setting(words[i])) i++;
  let prog = words[i] ? base(words[i]) : '';
  // An interpreter runs the program: skip its flags to the script it runs. -c/-e/--eval/-Command run inline code
  // (no script: the interpreter names it); -m and -File name the module or script next.
  for (let hops = 0; INTERPRETERS.has(prog) && hops < 3; hops++) {
    let j = i + 1;
    let inline = false;
    while (j < words.length && (flag(words[j]) || setting(words[j]))) {
      const w = words[j];
      if (/^(-c|-e|--eval|-Command)$/i.test(w)) { inline = true; break; }
      j++;
      if (/^(-m|-File)$/i.test(w)) break; // the module or the script is the next word
    }
    if (inline || j >= words.length || /^\{/.test(words[j])) break;
    i = j;
    prog = base(words[i]);
  }
  prog = prog.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return prog ? `custom:${prog}` : null;
}

/**
 * 2.30q (#7): is this launch stopped by a budget mark? In the Marina run gemini was marked out by its spend
 * guard at 20:27 UTC, yet 69 Gemini sessions started afterwards: they ran as tool "custom" (the role's
 * STUDIO_<ROLE>_CMD wraps gemini), so the mark on "gemini" never matched, and with every tool marked out
 * pickTool() returned null and startAgent kept the original tool. A launch is stopped when any active mark
 * (quota or spend guard) names its tool, its tool:model, its model's family (gemini-3.1-pro-preview ->
 * gemini) or a word of its launch command, or a .studio/credit.json meter for one of those is at its guard.
 * Returns { stopped, by, until, why } (stopped false when nothing applies).
 */
export function budgetStopFor({ tool = '', model = '', cmd = '' } = {}, now = Date.now(), env = process.env) {
  if (/^(off|0|false|no)$/i.test(env.STUDIO_BUDGET_STOP || '')) return { stopped: false };
  const names = new Set();
  const add = (x) => { const v = String(x || '').toLowerCase().trim(); if (v && v !== 'unknown' && v !== 'custom') names.add(v); };
  add(tool); add(model); if (tool && model) add(`${tool}:${model}`);
  const fam = String(model || '').toLowerCase().match(/^[a-z]+/); if (fam) add(fam[0]);
  // PU-40 (P-051): a launch through a command honours a usage limit saved for that program (custom:<program>).
  const ck = cmd ? customKey(cmd) : null; if (ck) add(ck);
  const words = String(cmd || '').toLowerCase().split(/[^a-z0-9.:_-]+/).filter(Boolean);
  const hit = (key) => {
    const k = String(key).toLowerCase();
    if (k.includes(':')) return names.has(k);
    return names.has(k) || words.some((w) => w === k || w.startsWith(`${k}-`) || w.endsWith(`/${k}`));
  };
  const q = readJson(QUOTA_FILE, {});
  for (const [key, m] of Object.entries(q)) {
    if (!m || !(Date.parse(m.until) > now)) continue;
    if (hit(key)) return { stopped: true, by: key, until: m.until, why: `${key} is marked out until ${m.until}: ${String(m.why || m.line || '').slice(0, 120)}` };
  }
  const at = Number(env.STUDIO_SPEND_GUARD_AT ?? 0.95);
  const credit = readJson(path.join(STUDIO_STATE_DIR, 'credit.json'), {});
  for (const [key, c] of Object.entries(credit)) {
    if (!(Number(c?.guard) > 0) || Number(c.used) / Number(c.guard) < at) continue;
    if (hit(key)) return { stopped: true, by: key, until: null, why: `${key} is at ${Math.round((Number(c.used) / Number(c.guard)) * 100)}% of its credit guard` };
  }
  return { stopped: false };
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
    return { tool, used, recent, weekly, pct, targetPct, verdict, cacheRead: cache.cacheRead, cacheWeight: w, models: cache.models, exhaustedUntil: out, quotaLine: mark?.line || mark?.why || null, resets: new Date(start + 7 * 86400000).toISOString(), text: `${tool}${cache.models.length ? ` (${cache.models.join(', ')})` : ''}: ${recent.toLocaleString()} tokens in the last 5 h, ${used.toLocaleString()} this week, cache reads counted at ${w}x (${cache.cacheRead.toLocaleString()} read)${weekly ? ` (${Math.round(pct * 100)}% of ${weekly.toLocaleString()}; target ${Math.round(targetPct * 100)}% by now: ${verdict === 'under' ? 'under, start more lanes' : verdict === 'over' ? 'over, slow down' : 'on track'})` : ' (set --weekly to pace)'}${out ? `; out of quota until ${when}${mark?.used ? ` (it stopped at ${mark.used.last5h.toLocaleString()} counted tokens in the last 5 h${mark.used.models?.length ? `, ${mark.used.models.join(', ')}` : ''})` : ''}${mark?.resetKnown === false ? ' (the provider gave no reset time; 1 h assumed)' : ''}. The provider said: "${(mark?.line || mark?.why || '').slice(0, 160)}". Wrong? npm run budget -- probe ${tool}` : ''}` };
  });
}

// ---- ccusage (2.30, opt-in plugin): Claude Code's own usage log, copied beside the harness's count ----
export const CCUSAGE_FILE = path.join(STUDIO_STATE_DIR, 'ccusage.json');
export const readCcusage = () => readJson(CCUSAGE_FILE, null);
/** Run ccusage (only when its plugin is on) and keep its daily totals: tokens per day and model, cache reads apart. */
export function importCcusage({ run = spawnSync, now = Date.now() } = {}) {
  let plugin = null;
  try {
    plugin = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'studio', 'plugins.json'), 'utf8')).plugins.find((p) => p.id === 'ccusage');
  } catch {}
  if (!plugin?.enabled) return { ok: false, message: 'The ccusage plugin is off. Turn it on first: node harness/plugins.mjs enable ccusage' };
  const custom = process.env.STUDIO_CCUSAGE_CMD;
  const r = custom ? run(custom, { shell: true, encoding: 'utf8', timeout: 120000, cwd: REPO_ROOT }) : run(plugin.ledger.command, plugin.ledger.args, { encoding: 'utf8', timeout: 120000, cwd: REPO_ROOT, shell: process.platform === 'win32' });
  let data;
  try {
    data = JSON.parse(String(r.stdout || '').slice(String(r.stdout || '').indexOf('{')));
  } catch {
    return { ok: false, message: `ccusage gave no JSON (exit ${r.status ?? 'timeout'}).` };
  }
  const days = (data.daily || []).map((d) => ({ date: d.date, input: d.inputTokens || 0, output: d.outputTokens || 0, cacheRead: d.cacheReadTokens || 0, cacheWrite: d.cacheCreationTokens || 0, total: d.totalTokens || 0, models: d.modelsUsed || (d.modelBreakdowns || []).map((m) => m.modelName).filter(Boolean) }));
  const out = { at: new Date(now).toISOString(), source: 'ccusage', days: days.slice(-14) };
  fs.mkdirSync(path.dirname(CCUSAGE_FILE), { recursive: true });
  fs.writeFileSync(CCUSAGE_FILE, `${JSON.stringify(out, null, 2)}\n`);
  return { ok: true, ledger: out };
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
  if (argv[0] === 'ccusage') {
    const r = importCcusage();
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    const d = r.ledger.days.at(-1);
    console.log(d ? `ccusage, ${d.date}: ${d.total.toLocaleString()} tokens (in ${d.input.toLocaleString()}, out ${d.output.toLocaleString()}, cache reads ${d.cacheRead.toLocaleString()}, cache writes ${d.cacheWrite.toLocaleString()}; ${d.models.join(', ') || 'model not named'}). Kept in .studio/ccusage.json beside the harness's own count.` : 'ccusage has no days yet.');
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
