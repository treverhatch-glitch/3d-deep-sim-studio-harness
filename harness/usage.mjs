#!/usr/bin/env node
/**
 * harness/usage.mjs — 2.67.0: work done outside the harness counts on the scorecard and the budget.
 *
 * An orchestrator outside the harness (the crew's Claude Code session and its subagents) did the integration,
 * rulings, refreshes and research, and none of its tokens showed: the scorecard and the budget only read the sessions
 * the harness launched (agent.session.end). Now:
 *
 *   npm run usage -- add --agent <name> --tokens-in N --tokens-out N [--cache-read N] [--cache-write N]
 *                        [--cost-usd X] [--task T-1] [--model m] [--tool t] --why "what the work was"
 *   npm run usage -- import <file or folder> [...] [--agent <name>] [--tool claude] [--dry-run]
 *
 * `add` appends one agent.session.end event marked meta.outside: true, which the scorecard (harness/autonomy.mjs),
 * the budget meter and the ledger read like a launched session's (cache writes go into tokensIn, as the launcher
 * records them). `import` reads Claude Code session transcripts (.jsonl; a folder is walked for them, subagent files
 * included, with no shell glob) and records the usage of the assistant messages per session (a subagent file is its
 * own session: the session id plus its agent id) and model, once: a key (session, model) already imported with the
 * same last message id is skipped; one that grew since is recorded for the difference only. Only the usage numbers,
 * ids, model names and timestamps are read: no message text is kept or printed.
 *
 * Who: anyone outside a launched worker session (a launched builder, qa, ... session is already counted by its
 * launcher, so a second record would count it twice).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitEvent, readRecentEvents } from './event.mjs';

const int = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Math.max(0, Math.round(Number(x))));
const line1 = (s, n = 60) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const DECIDER = /^(producer|director)$/i;

/** Why this caller may not record outside usage, or ''. */
export function usageRefusal(env = process.env) {
  const role = String(env.STUDIO_ROLE || '').trim();
  if (role && !DECIDER.test(role)) return `Refused: a launched ${role} session is already counted by its launcher (agent.session.end); recording it here would count it twice.`;
  return '';
}

/**
 * Record one piece of outside work. Returns { ok, event } or { ok: false, why }.
 * tokensIn is plain input; cacheWrite is added to it (as agent.mjs records a session) and kept in meta.cacheWrite.
 */
export function addUsage({ agent, tokensIn, tokensOut, cacheRead = 0, cacheWrite = 0, cacheWrite5m = null, cacheWrite1h = null, costUsd = null, task = null, model = null, tool = null, why = '', ts = null, extraMeta = {}, env = process.env } = {}) {
  const who = line1(agent);
  if (!who) return { ok: false, why: 'Say whose work it was: --agent <name>.' };
  const refusal = usageRefusal(env);
  if (refusal) return { ok: false, why: refusal };
  const reason = line1(why, 300);
  if (reason.length < 3) return { ok: false, why: 'Say what the work was: --why "…" (3+ characters).' };
  const nums = { tokensIn: int(tokensIn) ?? 0, tokensOut: int(tokensOut) ?? 0, cacheRead: int(cacheRead) ?? 0, cacheWrite: int(cacheWrite) ?? 0 };
  for (const [k, v] of Object.entries({ tokensIn, tokensOut, cacheRead, cacheWrite })) if (v !== null && v !== undefined && v !== '' && int(v) === null) return { ok: false, why: `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a number (got "${line1(v, 30)}").` };
  const cost = costUsd === null || costUsd === undefined || costUsd === '' ? null : Number(costUsd);
  if (cost !== null && !(Number.isFinite(cost) && cost >= 0)) return { ok: false, why: `--cost-usd must be a number of dollars (got "${line1(costUsd, 30)}").` };
  if (!(nums.tokensIn + nums.tokensOut + nums.cacheRead + nums.cacheWrite) && !cost) return { ok: false, why: 'Nothing to record: give --tokens-in / --tokens-out (and the cache counts) or --cost-usd.' };
  const t = task ? line1(task, 20) : null;
  if (t && !/^[A-Z][A-Z0-9]*-\d+$/.test(t)) return { ok: false, why: `--task must be a task id like T-12 (got "${t}").` };
  const recordedBy = line1(env.STUDIO_LOCK_OWNER || '') || null;
  const event = emitEvent({
    type: 'agent.session.end', agent: who, model: line1(model, 80) || 'unknown', task: t, status: 'ok', ...(ts ? { ts } : {}),
    tokensIn: nums.tokensIn + nums.cacheWrite, tokensOut: nums.tokensOut,
    msg: `${who}: outside work recorded (${reason})`.slice(0, 400),
    meta: { outside: true, role: 'outside', tool: line1(tool, 40) || 'outside', cacheRead: nums.cacheRead, cacheWrite: nums.cacheWrite, ...(int(cacheWrite5m) !== null ? { cacheWrite5m: int(cacheWrite5m) } : {}), ...(int(cacheWrite1h) !== null ? { cacheWrite1h: int(cacheWrite1h) } : {}), costUsd: cost, why: reason, ...(recordedBy && recordedBy !== who ? { recordedBy } : {}), recordedAt: new Date().toISOString(), ...extraMeta },
  });
  return { ok: true, event };
}

/** The .jsonl files under the given paths (a folder is walked; no shell glob, so the same on Windows). */
export function transcriptFiles(paths) {
  const out = [];
  const walk = (p, depth) => {
    let st; try { st = fs.statSync(p); } catch { return; }
    if (st.isFile()) { if (/\.jsonl$/i.test(p)) out.push(p); return; }
    if (!st.isDirectory() || depth > 6) return;
    let names = []; try { names = fs.readdirSync(p).sort(); } catch { return; }
    for (const n of names) walk(path.join(p, n), depth + 1);
  };
  for (const p of paths) walk(path.resolve(String(p)), 0);
  return [...new Set(out)];
}

/**
 * Usage per (session, model) in Claude Code transcripts: [{ key, session, agentId, model, messages, lastId, lastTs,
 * input, output, cacheRead, cacheWrite, cacheWrite5m, cacheWrite1h, file }]. Claude Code writes one line per content
 * block, each repeating its message's usage, so a message id counts once (its last line). Only "assistant" lines with
 * message.usage are read; nothing else in the file is looked at.
 */
export function parseTranscripts(files) {
  const groups = new Map();
  let lines = 0; let bad = 0;
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const msgs = new Map(); // message id -> { session, agentId, model, usage, ts }
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      lines += 1;
      let o; try { o = JSON.parse(raw); } catch { bad += 1; continue; }
      if (o?.type !== 'assistant' || !o.message || typeof o.message.usage !== 'object' || !o.message.usage) continue;
      const id = String(o.message.id || o.requestId || o.uuid || '');
      if (!id) continue;
      const session = String(o.sessionId || path.basename(file, '.jsonl'));
      const agentId = o.isSidechain && o.agentId ? String(o.agentId) : '';
      msgs.set(`${session}|${agentId}|${id}`, { id, session, agentId, model: String(o.message.model || 'unknown'), usage: o.message.usage, ts: Date.parse(o.timestamp) || 0 });
    }
    for (const m of msgs.values()) {
      if (m.model === '<synthetic>') continue;
      const key = `${m.session}${m.agentId ? `/${m.agentId}` : ''}|${m.model}`;
      const g = groups.get(key) || { key, session: m.session, agentId: m.agentId || null, model: m.model, messages: 0, lastId: null, lastTs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, file: path.basename(file) };
      const u = m.usage;
      const cw = int(u.cache_creation_input_tokens) ?? 0;
      g.messages += 1;
      g.input += int(u.input_tokens) ?? 0;
      g.output += int(u.output_tokens) ?? 0;
      g.cacheRead += int(u.cache_read_input_tokens) ?? 0;
      g.cacheWrite += cw;
      g.cacheWrite5m += int(u.cache_creation?.ephemeral_5m_input_tokens) ?? 0;
      g.cacheWrite1h += int(u.cache_creation?.ephemeral_1h_input_tokens) ?? 0;
      if (m.ts >= g.lastTs) { g.lastTs = m.ts; g.lastId = m.id; }
      groups.set(key, g);
    }
  }
  return { groups: [...groups.values()].sort((a, b) => a.lastTs - b.lastTs || a.key.localeCompare(b.key)), lines, bad };
}

/** What earlier imports recorded per key: { key: { lastId, input, output, cacheRead, cacheWrite, cacheWrite5m, cacheWrite1h } }. */
export function importedSoFar(events) {
  const seen = {};
  for (const e of events) {
    const k = e?.type === 'agent.session.end' && e.meta?.outside ? e.meta?.importKey : null;
    if (!k) continue;
    const s = seen[k] || (seen[k] = { lastId: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    const cw = Number(e.meta.cacheWrite) || 0;
    s.input += Math.max(0, (Number(e.tokensIn) || 0) - cw); s.output += Number(e.tokensOut) || 0; s.cacheRead += Number(e.meta.cacheRead) || 0; s.cacheWrite += cw;
    s.cacheWrite5m += Number(e.meta.cacheWrite5m) || 0; s.cacheWrite1h += Number(e.meta.cacheWrite1h) || 0;
    s.lastId = e.meta.lastMessageId || s.lastId;
  }
  return seen;
}

/**
 * Import transcripts. Returns { ok, files, sessions, recorded: [{ key, model, tokens }], skipped, why? }.
 * events: the log to dedupe against (default: the last 200k events).
 */
export function importUsage(paths, { agent = null, tool = 'claude', dryRun = false, events = null, env = process.env } = {}) {
  const refusal = usageRefusal(env);
  if (refusal) return { ok: false, why: refusal };
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) return { ok: false, why: 'Usage: npm run usage -- import <a Claude Code session .jsonl, or the folder holding them> [--agent <name>]' };
  const files = transcriptFiles(list);
  if (!files.length) return { ok: false, why: `No .jsonl transcript found at ${list.join(', ')}.` };
  const { groups, lines, bad } = parseTranscripts(files);
  const seen = importedSoFar(events || readRecentEvents(200000));
  const who = line1(agent || env.STUDIO_LOCK_OWNER || 'outside-agent');
  const recorded = []; let skipped = 0;
  for (const g of groups) {
    const prev = seen[g.key];
    if (prev && prev.lastId === g.lastId) { skipped += 1; continue; }
    const d = (k) => Math.max(0, g[k] - (prev ? prev[k] : 0));
    const delta = { input: d('input'), output: d('output'), cacheRead: d('cacheRead'), cacheWrite: d('cacheWrite'), cacheWrite5m: d('cacheWrite5m'), cacheWrite1h: d('cacheWrite1h') };
    if (!(delta.input + delta.output + delta.cacheRead + delta.cacheWrite)) { skipped += 1; continue; }
    const tokens = delta.input + delta.output + delta.cacheWrite;
    recorded.push({ key: g.key, model: g.model, messages: g.messages, tokens, cacheRead: delta.cacheRead, subagent: Boolean(g.agentId), at: g.lastTs ? new Date(g.lastTs).toISOString() : null });
    if (dryRun) continue;
    const r = addUsage({ agent: who, tokensIn: delta.input, tokensOut: delta.output, cacheRead: delta.cacheRead, cacheWrite: delta.cacheWrite, cacheWrite5m: g.cacheWrite5m || g.cacheWrite1h ? delta.cacheWrite5m : null, cacheWrite1h: g.cacheWrite5m || g.cacheWrite1h ? delta.cacheWrite1h : null, model: g.model, tool, why: `imported ${g.agentId ? 'subagent ' : ''}session ${g.session.slice(0, 8)}${g.agentId ? `/${g.agentId.slice(0, 8)}` : ''} (${g.messages} message(s)${prev ? ', growth since the last import' : ''})`, ts: g.lastTs ? new Date(g.lastTs).toISOString() : null, extraMeta: { importKey: g.key, lastMessageId: g.lastId, session: g.session, ...(g.agentId ? { subagent: g.agentId } : {}), via: 'usage import' }, env });
    if (!r.ok) return { ok: false, why: r.why };
  }
  return { ok: true, files: files.length, lines, bad, sessions: groups.length, recorded, skipped, dryRun: Boolean(dryRun) };
}

const tk = (x) => (x >= 1e6 ? `${Math.round(x / 1e5) / 10}M` : x >= 1e3 ? `${Math.round(x / 100) / 10}k` : String(x));

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const VALUED = new Set(['agent', 'tokens-in', 'tokens-out', 'cache-read', 'cache-write', 'cost-usd', 'task', 'model', 'tool', 'why']);
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); if (VALUED.has(k)) flags[k] = argv[++i]; else flags[k] = true; } else pos.push(a);
  }
  const help = 'Usage:\n  npm run usage -- add --agent <name> --tokens-in N --tokens-out N [--cache-read N --cache-write N] [--cost-usd X] [--task T-1] [--model m] [--tool t] --why "…"\n  npm run usage -- import <session .jsonl or folder> [...] [--agent <name>] [--tool claude] [--dry-run]\nOutside work is recorded as a session (meta.outside) the scorecard and the budget count; docs/AUTONOMY.md.';
  if (!pos.length || flags.help || flags.h) { console.log(help); process.exit(pos.length || flags.help || flags.h ? 0 : 1); }
  if (pos[0] === 'add') {
    const r = addUsage({ agent: flags.agent, tokensIn: flags['tokens-in'], tokensOut: flags['tokens-out'], cacheRead: flags['cache-read'], cacheWrite: flags['cache-write'], costUsd: flags['cost-usd'], task: flags.task, model: flags.model, tool: flags.tool, why: flags.why });
    if (!r.ok) { console.error(r.why); process.exit(1); }
    const e = r.event;
    console.log(`[usage] recorded outside work for ${e.agent}: ${tk(e.tokensIn)} in (incl. cache writes), ${tk(e.tokensOut)} out, ${tk(e.meta.cacheRead)} cache reads${e.meta.costUsd !== null ? `, $${e.meta.costUsd}` : ''}${e.task ? ` on ${e.task}` : ''}. The scorecard and the budget count it (npm run autonomy).`);
    process.exit(0);
  }
  if (pos[0] === 'import') {
    const r = importUsage(pos.slice(1), { agent: flags.agent || null, tool: flags.tool || 'claude', dryRun: Boolean(flags['dry-run']) });
    if (!r.ok) { console.error(r.why); process.exit(1); }
    const sum = r.recorded.reduce((s, x) => s + x.tokens, 0);
    console.log(`[usage] ${r.dryRun ? 'would record' : 'recorded'} ${r.recorded.length} session(s) (${r.recorded.filter((x) => x.subagent).length} subagent), ${tk(sum)} tokens plus ${tk(r.recorded.reduce((s, x) => s + x.cacheRead, 0))} cache reads, from ${r.files} file(s); ${r.skipped} already imported${r.bad ? `; ${r.bad} unreadable line(s) skipped` : ''}.`);
    for (const x of r.recorded.slice(0, 20)) console.log(`  ${x.key.split('|')[0].slice(0, 26)} ${x.model}: ${tk(x.tokens)} tokens, ${tk(x.cacheRead)} cache reads (${x.messages} message(s))`);
    if (r.recorded.length > 20) console.log(`  … and ${r.recorded.length - 20} more`);
    process.exit(0);
  }
  console.error(help);
  process.exit(1);
}
