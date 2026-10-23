#!/usr/bin/env node
/**
 * harness/session-report.mjs — 2.30j (H4): sessions started outside the hub (scripts, other launchers)
 * report start/end and token use, so the War Room's ledger, budget and sessions panels see them.
 *   node harness/session-report.mjs start|end --agent A --model M [--role builder] [--tool T] [--task T-1] [--in N] [--out N]
 */
import { emitEvent } from './event.mjs';

const num = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.round(Number(n)) : 0);

export function reportSession({ agent, role = 'builder', tool = 'external', model, task = null, tokensIn, tokensOut, cacheRead, phase }) {
  if (!agent || !model || model === 'unknown') return { ok: false, message: 'Name the agent and the model (--agent, --model).' };
  if (phase !== 'start' && phase !== 'end') return { ok: false, message: 'Phase is start or end.' };
  tokensIn = num(tokensIn); tokensOut = num(tokensOut); cacheRead = num(cacheRead);
  if (phase === 'start') {
    emitEvent({ type: 'agent.session.start', agent, model, task, meta: { role, tool, external: true } });
  } else if (phase === 'end') {
    emitEvent({ type: 'agent.session.end', agent, model, task, tokensIn, tokensOut, meta: { role, tool, cacheRead, external: true } });
  }
  return { ok: true };
}

if (process.argv[1] && process.argv[1].endsWith('session-report.mjs')) {
  const args = process.argv.slice(2);
  const phase = args[0];
  const params = { phase };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--agent') params.agent = args[++i];
    if (args[i] === '--model') params.model = args[++i];
    if (args[i] === '--role') params.role = args[++i];
    if (args[i] === '--tool') params.tool = args[++i];
    if (args[i] === '--task') params.task = args[++i];
    if (args[i] === '--in') params.tokensIn = Number(args[++i]);
    if (args[i] === '--out') params.tokensOut = Number(args[++i]);
  }
  if (!params.agent || !params.model || params.model === 'unknown' || (phase !== 'start' && phase !== 'end')) {
    console.error('Usage: node session-report.mjs start|end --agent A --model M [--role R] [--tool T] [--task T-1] [--in N] [--out N]');
    process.exit(1);
  }
  const r = reportSession(params);
  if (!r.ok) { console.error(r.message); process.exit(1); }
  console.log(`[session-report] ${phase} ${params.agent} (${params.model})`);
}
