#!/usr/bin/env node
/**
 * harness/tokens.mjs — measured token use, from the agent.session.end events the launcher writes.
 *
 *   npm run tokens [-- --since 5h|24h|today|all] [--by agent|role|model|tool] [--json]
 *
 * Every number here is what a tool reported at the end of a session (Claude's result usage, Codex's
 * turn totals, or a plain usage line). Nothing is estimated. Two things are not counted, and the output
 * says so: sessions whose tool reported no usage (listed by tool), and work outside the launcher, such as
 * a person's own chat or IDE sessions.
 */
import { pathToFileURL } from 'node:url';
import { readRecentEvents } from './event.mjs';

const WINDOWS = { '5h': 5 * 3600e3, '24h': 24 * 3600e3 };

export function sinceMs(since = 'all', now = Date.now()) {
  if (since === 'all') return 0;
  if (since === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const m = String(since).match(/^(\d+(?:\.\d+)?)(m|h|d)$/);
  if (m) return now - Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
  return now - (WINDOWS[since] || 0);
}

const blank = () => ({ sessions: 0, measured: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, costUsd: 0, turns: 0, withTurns: 0, tasksDone: 0 });

/** Totals and groups for the sessions that ended since `since`. */
export function tokenTotals({ since = 'all', events = null, now = Date.now() } = {}) {
  const from = sinceMs(since, now);
  const all = events || readRecentEvents(100000);
  const ev = from ? all.filter((e) => Date.parse(e.ts) >= from) : all;
  const starts = new Map();
  for (const e of all) if (e.type === 'agent.session.start') starts.set(e.agent, e);
  const groups = { agent: {}, role: {}, model: {}, tool: {} };
  const total = blank();
  const untracked = {};
  const add = (g, e, measured) => {
    g.sessions += 1;
    if (!measured) return;
    g.measured += 1;
    g.tokensIn += Number(e.tokensIn) || 0;
    g.tokensOut += Number(e.tokensOut) || 0;
    g.cacheRead += Number(e.meta?.cacheRead) || 0;
    g.costUsd += Number(e.meta?.costUsd) || 0;
    if (Number(e.meta?.turns) > 0) {
      g.turns += Number(e.meta.turns);
      g.withTurns += 1;
    }
  };
  const roleOf = new Map();
  for (const e of ev) {
    if (e.type !== 'agent.session.end') continue;
    const st = starts.get(e.agent);
    const role = e.meta?.role || st?.meta?.role || 'unknown';
    const tool = e.meta?.tool || st?.meta?.tool || 'unknown';
    const model = e.model || st?.model || `${tool} (default model)`;
    roleOf.set(e.agent, role);
    const measured = (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0) + (Number(e.meta?.cacheRead) || 0) > 0;
    if (!measured) untracked[tool] = (untracked[tool] || 0) + 1;
    add(total, e, measured);
    for (const [k, key] of [['agent', e.agent], ['role', role], ['model', model], ['tool', tool]]) add((groups[k][key] ||= blank()), e, measured);
  }
  for (const e of ev) {
    if (e.type !== 'task.done') continue;
    total.tasksDone += 1;
    if (groups.agent[e.agent]) groups.agent[e.agent].tasksDone += 1;
    const r = roleOf.get(e.agent);
    if (r && groups.role[r]) groups.role[r].tasksDone += 1;
  }
  const list = (k) => Object.entries(groups[k]).map(([name, g]) => ({ name, ...g })).sort((a, b) => b.cacheRead + b.tokensIn - (a.cacheRead + a.tokensIn));
  return {
    since,
    from: from ? new Date(from).toISOString() : null,
    total,
    byAgent: list('agent'),
    byRole: list('role'),
    byModel: list('model'),
    byTool: list('tool'),
    untracked,
    notCounted: 'Work outside the launcher (your own chat, IDE or terminal sessions) is not counted.',
  };
}

const M = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

export function formatTotals(t, by = 'role') {
  const rows = { agent: t.byAgent, role: t.byRole, model: t.byModel, tool: t.byTool }[by] || t.byRole;
  const L = [`Tokens, measured (${t.since === 'all' ? 'whole event log' : `since ${t.from.slice(0, 16).replace('T', ' ')} UTC`})`];
  L.push(`  ${t.total.sessions} sessions ended, ${t.total.measured} reported usage. In ${M(t.total.tokensIn)}, out ${M(t.total.tokensOut)}, cache reads ${M(t.total.cacheRead)}${t.total.costUsd ? `, $${t.total.costUsd.toFixed(2)} at API prices as the tool reported it (a subscription isn't billed this)` : ''}.`);
  if (t.total.measured) L.push(`  Cache reads per measured session: ${M(t.total.cacheRead / t.total.measured)}. Per task done: ${t.total.tasksDone ? M(t.total.cacheRead / t.total.tasksDone) : 'no task done'}.${t.total.withTurns ? ` Turns per session: ${Math.round(t.total.turns / t.total.withTurns)}${t.total.tasksDone ? `, per task done: ${Math.round(t.total.turns / t.total.tasksDone)}` : ''}.` : ''}`);
  L.push('', `  By ${by}:`);
  for (const r of rows) L.push(`  ${r.name.padEnd(24)} ${String(r.sessions).padStart(3)} sessions  in ${M(r.tokensIn).padStart(6)}  out ${M(r.tokensOut).padStart(6)}  cache reads ${M(r.cacheRead).padStart(6)}${r.measured ? `  (${M(r.cacheRead / r.measured)}/session)` : ''}${r.withTurns ? `  ${Math.round(r.turns / r.withTurns)} turns/session` : ''}${r.measured < r.sessions ? `  ${r.sessions - r.measured} not measured` : ''}`);
  if (!rows.length) L.push('  No session has ended in this window.');
  const un = Object.entries(t.untracked);
  L.push('', un.length ? `  Not measured: ${un.map(([tool, n]) => `${n} ${tool} session${n === 1 ? '' : 's'}`).join(', ')} (the tool reported no usage).` : '  Every session in this window reported its usage.');
  L.push(`  ${t.notCounted}`);
  return L.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
  const t = tokenTotals({ since: opt('since', 'all') });
  console.log(argv.includes('--json') ? JSON.stringify(t, null, 2) : formatTotals(t, opt('by', 'role')));
}
