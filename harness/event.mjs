#!/usr/bin/env node
/**
 * harness/event.mjs — Zero-Token Passive Event Logger
 *
 * Appends structured single-line JSON events to:
 *   1. `.studio/events.jsonl` (repo-local run ledger for the HUB & status script)
 *   2. `/tmp/agent-events.jsonl` (or OS temp dir mirror for external watchers)
 *
 * Costs 0% LLM tokens. The Workflow UI HUB (`hub/server.mjs`) tails this file
 * over SSE/WebSocket so humans can watch live agent activity on desktop or
 * mobile without interrupting running agents.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const STUDIO_STATE_DIR = path.join(REPO_ROOT, '.studio');
export const DEFAULT_EVENTS_FILE = path.join(STUDIO_STATE_DIR, 'events.jsonl');

export function getEventPaths() {
  const primary = process.env.AGENT_EVENTS_FILE
    ? path.resolve(REPO_ROOT, process.env.AGENT_EVENTS_FILE)
    : DEFAULT_EVENTS_FILE;

  // Mirror only when explicitly requested. Do not share /tmp across clones.
  const mirrors = [];
  if (process.env.AGENT_EVENTS_MIRROR) {
    mirrors.push(path.resolve(process.env.AGENT_EVENTS_MIRROR));
  }
  return { primary, mirrors };
}

/**
 * Append a structured event to `.studio/events.jsonl` and temp mirror(s).
 * @param {object} partial
 * @returns {object} The normalized event record written to disk.
 */
export function emitEvent(partial = {}) {
  const now = new Date().toISOString();
  const durationMs =
    partial.durationMs != null
      ? Number(partial.durationMs)
      : partial.latencyMs != null
      ? Number(partial.latencyMs)
      : null;
  const startedAt =
    partial.startedAt ||
    (durationMs != null ? new Date(Date.now() - durationMs).toISOString() : now);
  const event = {
    id: partial.id || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ts: partial.ts || now,
    startedAt,
    durationMs,
    type: partial.type || 'agent.info',
    agent: partial.agent || process.env.STUDIO_AGENT_ROLE || 'producer',
    provider: partial.provider || null,
    model: partial.model || process.env.STUDIO_AGENT_MODEL || null,
    task: partial.task || null,
    to: partial.to || null,
    target: partial.target || partial.file || null,
    status: partial.status || 'ok',
    tokensIn: Number(partial.tokensIn || 0),
    tokensOut: Number(partial.tokensOut || 0),
    tokensSaved: Number(partial.tokensSaved || 0),
    latencyMs: durationMs,
    msg: partial.msg || '',
    meta: partial.meta || {},
  };

  const line = JSON.stringify(event) + '\n';
  const { primary, mirrors } = getEventPaths();

  fs.mkdirSync(path.dirname(primary), { recursive: true });
  fs.appendFileSync(primary, line, 'utf8');

  for (const mirror of mirrors) {
    try {
      const dir = path.dirname(mirror);
      if (fs.existsSync(dir)) {
        fs.appendFileSync(mirror, line, 'utf8');
      }
    } catch {
      // Non-fatal if /tmp does not exist on raw Windows without Git Bash
    }
  }

  return event;
}

/**
 * Read the last `limit` events from `.studio/events.jsonl`.
 */
export function readRecentEvents(limit = 100) {
  const { primary } = getEventPaths();
  if (!fs.existsSync(primary)) return [];
  const raw = fs.readFileSync(primary, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const slice = limit > 0 ? lines.slice(-limit) : lines;
  const out = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip malformed line
    }
  }
  return out;
}

function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

// CLI execution: `node harness/event.mjs --type task.start --agent builder --task T-001 --msg "Working"`
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.tail || args.list) {
    const count = Number(args.tail || args.list) || 20;
    const events = readRecentEvents(count);
    for (const e of events) {
      console.log(`[${e.ts}] (${e.agent}) ${e.type}: ${e.msg}${e.task ? ` [${e.task}]` : ''}`);
    }
    process.exit(0);
  }

  let meta = {};
  if (typeof args.meta === 'string') {
    try {
      meta = JSON.parse(args.meta);
    } catch {
      meta = { raw: args.meta };
    }
  }

  const evt = emitEvent({
    type: args.type || 'cli.event',
    agent: args.agent || 'producer',
    provider: args.provider || null,
    model: args.model || null,
    task: args.task || null,
    to: args.to || null,
    target: args.target || args.file || null,
    status: args.status || 'ok',
    tokensIn: args['tokens-in'] || 0,
    tokensOut: args['tokens-out'] || 0,
    tokensSaved: args['tokens-saved'] || args.saved || 0,
    durationMs:
      args.duration != null
        ? Number(args.duration)
        : args['latency-ms'] != null
        ? Number(args['latency-ms'])
        : null,
    msg: args.msg || args.message || 'Event recorded',
    meta,
  });

  if (!args.quiet) {
    console.log(JSON.stringify(evt));
  }
}
