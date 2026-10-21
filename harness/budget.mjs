#!/usr/bin/env node
/**
 * harness/budget.mjs — how much of each tool's plan the studio has used, against a target.
 *
 *   npm run budget                                   per tool: used this week, target by now, what to do
 *   npm run budget -- set claude --weekly 40000000 --reset thursday [--hour 9] [--target 100%]
 *   npm run budget -- order claude,codex,agy         which tool takes over when one runs out
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

/** Tokens the launcher's agents reported for a tool since a time. */
export function usedSince(tool, since, events = readRecentEvents(50000)) {
  return events.filter((e) => e.type === 'agent.session.end' && (e.meta?.tool || 'unknown') === tool && Date.parse(e.ts) >= since).reduce((n, e) => n + (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0), 0);
}

/** A tool that hit its limit, and when it resets ("resets 06:12", "try again at 3pm"); 1 h if unknown. */
export function markExhausted(tool, text = '', now = Date.now()) {
  const q = readJson(QUOTA_FILE, {});
  const m = String(text).match(/(?:resets?|try again)(?: at| after)?\s*(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i);
  let until = now + 3600000;
  if (m) {
    const d = new Date(now);
    let h = Number(m[1]) % 24;
    if (m[3] && /pm/i.test(m[3]) && h < 12) h += 12;
    if (m[3] && /am/i.test(m[3]) && h === 12) h = 0;
    d.setHours(h, Number(m[2] || 0), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    until = d.getTime();
  }
  q[tool] = { until: new Date(until).toISOString(), why: String(text).slice(0, 160), at: new Date(now).toISOString() };
  fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true });
  fs.writeFileSync(QUOTA_FILE, `${JSON.stringify(q, null, 2)}\n`);
  return q[tool];
}
export const exhaustedUntil = (tool, now = Date.now()) => {
  const q = readJson(QUOTA_FILE, {})[tool];
  return q && Date.parse(q.until) > now ? q.until : null;
};
/** The first tool in the order that isn't out of quota, starting from the preferred one. */
export function pickTool(preferred, now = Date.now()) {
  const order = [...new Set([preferred, ...(readBudget().order || [])].filter(Boolean))];
  return order.find((t) => !exhaustedUntil(t, now)) || null;
}

/** Per tool: used, the week's tokens if known, the target by now, and a verdict. */
export function budgetStatus(now = Date.now(), events = readRecentEvents(50000)) {
  const b = readBudget();
  const seen = new Set(events.filter((e) => e.type === 'agent.session.end' && e.meta?.tool).map((e) => e.meta.tool));
  const tools = [...new Set([...Object.keys(b.tools || {}), ...seen])];
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
    return { tool, used, weekly, pct, targetPct, verdict, exhaustedUntil: out, resets: new Date(start + 7 * 86400000).toISOString(), text: `${tool}: ${used.toLocaleString()} tokens this week${weekly ? ` (${Math.round(pct * 100)}% of ${weekly.toLocaleString()}; target ${Math.round(targetPct * 100)}% by now: ${verdict === 'under' ? 'under, start more lanes' : verdict === 'over' ? 'over, slow down' : 'on track'})` : ' (set --weekly to pace)'}${out ? `; out of quota until ${out.slice(11, 16)}` : ''}` };
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
  const st = budgetStatus();
  console.log(st.length ? st.map((s) => s.text).join('\n') : 'No tool has reported usage yet. Agents started with npm run agent or npm run studio:start report it.');
  console.log(`Order when a tool runs out: ${(readBudget().order || []).join(' → ')}`);
}
