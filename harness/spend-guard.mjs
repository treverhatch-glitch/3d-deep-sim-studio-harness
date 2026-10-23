#!/usr/bin/env node
/**
 * harness/spend-guard.mjs — 2.30o: a spend guard hands over to the next tool exactly like a quota error.
 *
 * The takeover already existed (studio/budget.json `order`, quota marks in .studio/tool-quota.json), but only
 * a CLI's own quota error set a mark. In the Marina run a pooled credit stop was enforced outside the
 * harness, so builders simply stopped. Now any tool in the order can carry a guard:
 *   STUDIO_SPEND_GUARD_TOKENS_<TOOL>=n         tokens this budget week (the launcher's own counts)
 *   .studio/credit.json { "<tool>": { "used": n, "guard": n } }   any meter's numbers (its own units)
 * At STUDIO_SPEND_GUARD_AT (0.95) of a guard the tool gets a quota mark (until its weekly reset, or
 * STUDIO_SPEND_GUARD_HOURS, 24), so pickTool() moves the next session to the next tool in the order, and a
 * tool.takeover event goes to the War Room and the human. Tools such as hermes, gemini or grokbot join the
 * order with a launch command: STUDIO_TOOL_<TOOL>_CMD (with {kickoff}, {agent}, {model}, {role}, {task}).
 *
 *   node harness/spend-guard.mjs [status|pass]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { readBudget, markExhausted, quotaMark, pickTool, usedSince, weekStart } from './budget.mjs';

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const key = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
export const toolCmd = (tool, env = process.env) => env[`STUDIO_TOOL_${key(tool)}_CMD`] || null;

/** Share of each tool's guard used (null when nothing guards it). */
export function guardShare(tool, { env = process.env, now = Date.now(), events } = {}) {
  const c = read(path.join(STUDIO_STATE_DIR, 'credit.json'), {})[tool];
  const shares = [];
  if (c && Number(c.guard) > 0) shares.push({ share: Number(c.used) / Number(c.guard), by: 'credit meter' });
  const cap = Number(env[`STUDIO_SPEND_GUARD_TOKENS_${key(tool)}`] || 0);
  if (cap > 0) {
    const cfg = readBudget().tools?.[tool] || {};
    shares.push({ share: usedSince(tool, weekStart(cfg, now), events || readRecentEvents(50000)) / cap, by: 'token guard' });
  }
  return shares.sort((a, b) => b.share - a.share)[0] || null;
}

/** Mark every guarded tool at its guard; returns the takeovers made. */
export function spendGuardPass({ env = process.env, now = Date.now(), events } = {}) {
  const at = Number(env.STUDIO_SPEND_GUARD_AT ?? 0.95);
  const order = [...new Set(readBudget().order || [])];
  const extra = Object.keys(read(path.join(STUDIO_STATE_DIR, 'credit.json'), {}));
  const out = [];
  for (const tool of [...new Set([...order, ...extra])]) {
    const g = guardShare(tool, { env, now, events });
    if (!g || g.share < at) continue;
    const mark = quotaMark(tool);
    if (mark && Date.parse(mark.until) > now) continue;
    const hours = Number(env.STUDIO_SPEND_GUARD_HOURS ?? 24);
    markExhausted(tool, `spend guard: ${tool} at ${Math.round(g.share * 100)}% of its ${g.by} (resets in ${hours} h)`, now);
    // a guard is not a provider limit: hold it for the configured hours, not the 1 h default
    const q = read(path.join(STUDIO_STATE_DIR, 'tool-quota.json'), {});
    if (q[tool]) { q[tool].until = new Date(now + hours * 3600000).toISOString(); q[tool].guard = true; fs.writeFileSync(path.join(STUDIO_STATE_DIR, 'tool-quota.json'), `${JSON.stringify(q, null, 2)}\n`); }
    const next = pickTool(tool, now);
    const msg = `${tool} reached ${Math.round(g.share * 100)}% of its ${g.by}: ${next ? `${next} takes over new sessions` : 'no tool left in the order (npm run budget -- order ...)'}`;
    emitEvent({ type: 'tool.takeover', agent: 'watchdog', to: 'human', status: next ? 'warn' : 'blocked', msg, meta: { from: tool, to: next, by: g.by } });
    out.push({ from: tool, to: next, msg });
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv[2] === 'pass') { const r = spendGuardPass(); console.log(r.length ? r.map((x) => x.msg).join('\n') : 'No tool at its guard.'); }
  else for (const t of readBudget().order || []) { const g = guardShare(t); console.log(`${t}: ${g ? `${Math.round(g.share * 100)}% of its ${g.by}` : 'no guard'}${quotaMark(t) ? ` (marked out until ${quotaMark(t).until})` : ''}${toolCmd(t) ? ' [launch command set]' : ''}`); }
}
