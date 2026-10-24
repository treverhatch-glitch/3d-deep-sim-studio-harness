#!/usr/bin/env node
/**
 * harness/prompt-layout.mjs — prompt structure and stability measurement.
 *
 * A prompt has a stable prefix (the role, rules, etc.) and a volatile part (the session's
 * specific task). The prefix is hashed to track how often it changes; a stable prefix
 * improves LLM caching and performance.
 *
 *   node harness/prompt-layout.mjs stability [--json]   how often each role's prefix changed (2.30g)
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { STUDIO_STATE_DIR, emitEvent } from './event.mjs';

const LEDGER_FILE = path.join(STUDIO_STATE_DIR, 'prefix-ledger.jsonl');
/** Roles whose prefix is reused across sessions far apart: they ask for the 1-hour cache. */
export const LONG_CACHE_ROLES = new Set(['director', 'producer']);
export const STABLE_MARKER = '<!-- stable-prefix-end -->';

/** Lays out a prompt with a stable prefix and a volatile session-specific part. */
export function layoutPrompt({ stable, volatile }) {
  return `${stable}\n${STABLE_MARKER}\n\n## This session\n\n${volatile}`;
}

/** Replaces session-specific names with placeholders to make the prefix byte-identical. */
export function stablize(text, { agent, model }) {
  let stableText = text;
  if (agent && agent !== 'unknown') stableText = stableText.replaceAll(agent, '$STUDIO_LOCK_OWNER');
  if (model && model !== 'unknown') stableText = stableText.replaceAll(model, '$STUDIO_AGENT_MODEL');
  return stableText;
}

/**
 * 2.30q (#8): anything session-specific in the stable prefix breaks the prompt cache for every later session of
 * the role. Returns what leaked: the agent's name, its model, a task id, a clock time or date.
 */
export function volatileLeaks(stable, { agent, model, task } = {}) {
  const out = [];
  const t = String(stable || '');
  if (agent && agent !== 'unknown' && t.includes(agent)) out.push(`agent name ${agent}`);
  if (model && model !== 'unknown' && t.includes(model)) out.push(`model ${model}`);
  if (task && t.includes(task)) out.push(`task ${task}`);
  if (/\b20\d\d-\d\d-\d\dT\d\d:\d\d/.test(t)) out.push('a timestamp');
  return out;
}

/** Returns a short hash of the prompt's stable prefix. */
export function prefixHash(prompt) {
  const stableEnd = prompt.indexOf(STABLE_MARKER);
  const prefix = stableEnd === -1 ? prompt : prompt.slice(0, stableEnd);
  return createHash('sha256').update(prefix).digest('hex').slice(0, 16);
}

/** Records a prompt's prefix hash in a ledger and reports if it changed for its role. */
export function recordPrefix({ role, agent, prompt }) {
  const stableEnd = prompt.indexOf(STABLE_MARKER);
  const prefix = stableEnd === -1 ? prompt : prompt.slice(0, stableEnd);
  const hash = prefixHash(prompt);
  const bytes = Buffer.byteLength(prefix, 'utf8');
  const entry = { at: new Date().toISOString(), role, agent, hash, bytes };

  fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  fs.appendFileSync(LEDGER_FILE, `${JSON.stringify(entry)}\n`);

  const lines = fs.existsSync(LEDGER_FILE) ? fs.readFileSync(LEDGER_FILE, 'utf8').trim().split('\n') : [];
  const previousEntries = lines.map(l => JSON.parse(l)).filter(e => e.role === role);
  const previous = previousEntries.length > 1 ? previousEntries[previousEntries.length - 2] : null;
  const changed = !!previous && previous.hash !== hash;

  if (changed) {
    const msg = `Prompt prefix for role '${role}' changed from ${previous.hash.slice(0, 7)}... to ${hash.slice(0, 7)}...`;
    emitEvent({ type: 'prompt.prefix.changed', agent, msg, meta: { role, hash, previous: previous.hash } });
  }

  return { hash, changed, previous: previous?.hash || null };
}

/** Calculates prefix stability statistics from the ledger. */
export function prefixStability({ since = null, entries = null } = {}) {
  const lines = entries || (fs.existsSync(LEDGER_FILE) ? fs.readFileSync(LEDGER_FILE, 'utf8').trim().split('\n') : []);
  const sinceTs = since ? Date.parse(since) : 0;
  const roles = {};
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (sinceTs && Date.parse(e.at) < sinceTs) continue;
      roles[e.role] ||= { sessions: 0, hashes: new Set(), changes: 0, lastHash: null };
      const r = roles[e.role];
      r.sessions += 1;
      r.hashes.add(e.hash);
      if (r.lastHash !== null && r.lastHash !== e.hash) r.changes += 1;
      r.lastHash = e.hash;
    } catch {}
  }
  return Object.fromEntries(Object.entries(roles).map(([role, r]) => [role, {
    sessions: r.sessions,
    distinctHashes: r.hashes.size,
    changes: r.changes,
    stableRate: r.sessions > 1 ? 1 - r.changes / (r.sessions - 1) : 1,
  }]));
}

/** Calculates cache usage statistics from a Claude stream-json log. */
export function cacheStats(log) {
  const stats = { cacheRead: 0, cacheWrite: 0, input: 0 };
  let resultUsage = null;
  for (const l of String(log || '').split(/\r?\n/)) {
    if (!l.startsWith('{')) continue;
    try {
      const o = JSON.parse(l);
      if (o.type === 'assistant' && o.message?.usage) {
        const u = o.message.usage;
        stats.cacheRead += u.cache_read_input_tokens || 0;
        stats.cacheWrite += u.cache_creation_input_tokens || 0;
        stats.input += u.input_tokens || 0;
      } else if (o.type === 'result' && o.usage) {
        resultUsage = o.usage;
      }
    } catch {}
  }
  const u = resultUsage || stats;
  const read = u.cache_read_input_tokens || u.cacheRead || 0;
  const write = u.cache_creation_input_tokens || u.cacheWrite || 0;
  const input = u.input_tokens || u.input || 0;
  const total = read + write + input;
  return { cacheRead: read, cacheWrite: write, input, hitRate: total > 0 ? read / total : 0 };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'stability') {
    const stability = prefixStability();
    if (argv.includes('--json')) {
      console.log(JSON.stringify(stability, null, 2));
    } else {
      console.log('Prompt Prefix Stability per Role');
      console.log('Role'.padEnd(20) + 'Sessions'.padStart(10) + 'Hashes'.padStart(10) + 'Changes'.padStart(10) + 'Stability'.padStart(12));
      for (const [role, stats] of Object.entries(stability)) {
        console.log(
          role.padEnd(20) +
          String(stats.sessions).padStart(10) +
          String(stats.distinctHashes).padStart(10) +
          String(stats.changes).padStart(10) +
          (stats.stableRate * 100).toFixed(1).padStart(10) + '%'
        );
      }
    }
  }
}
