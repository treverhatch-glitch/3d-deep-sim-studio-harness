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
import { appendLine } from './fsafe.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const STUDIO_STATE_DIR = path.join(REPO_ROOT, '.studio');

// Studio settings from .env (STUDIO_*, HUB_*, AGENT_*, PLAYTEST_*), so every command sees the same
// backup folder, Producer name and caps, not only the HUB. Keys are read only by the router.
// A value already in the environment wins.
(function loadStudioSettings() {
  let text = '';
  try {
    text = fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  // The last non-empty line for a name wins, so a value added at the bottom beats the example's empty one.
  const found = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*((?:STUDIO|HUB|AGENT|PLAYTEST)_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const v = m[2].replace(/^['"]|['"]$/g, '');
    if (v !== '' || !(m[1] in found)) found[m[1]] = v;
  }
  for (const [k, v] of Object.entries(found)) if (process.env[k] === undefined) process.env[k] = v;
})();
/**
 * Who is acting, for attribution: an explicit name, then STUDIO_AGENT, then STUDIO_LOCK_OWNER (set by
 * the launcher and kickoff), then the Producer's name. An agent's notes and tasks are its own, never
 * credited to the Producer because STUDIO_PRODUCER_NAME happens to be set in .env.
 */
export const actor = (explicit = null) => explicit || process.env.STUDIO_AGENT || process.env.STUDIO_LOCK_OWNER || process.env.STUDIO_PRODUCER_NAME || 'producer';

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
// This studio's game ID (cartridges/<game>/cartridge.json), read once; harness/game-id.mjs makes it.
let gameIdCache;
let gameIdAt = 0;
function studioGameId() {
  // Re-read once a minute: a long-running hub sees a game made after it started.
  if (gameIdCache !== undefined && Date.now() - gameIdAt < 60000) return gameIdCache;
  gameIdAt = Date.now();
  gameIdCache = null;
  try {
    const g = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'studio', 'game.json'), 'utf8')).cartridge;
    if (g) gameIdCache = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'cartridges', g, 'cartridge.json'), 'utf8')).id || null;
  } catch {
    // no game yet, or one made before 2.25
  }
  return gameIdCache;
}

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
    ...(studioGameId() ? { gameId: studioGameId() } : {}),
    ...(partial.track || process.env.STUDIO_TRACK ? { track: partial.track || process.env.STUDIO_TRACK } : {}),
  };

  const line = JSON.stringify(event) + '\n';
  const { primary, mirrors } = getEventPaths();

  fs.mkdirSync(path.dirname(primary), { recursive: true });
  // Rotate before the log gets heavy (STUDIO_EVENTS_MAX_MB, default 25). Readers go on into the rolled files when the
  // new one is short (readRecentEvents). Two writers rolling in the same millisecond: the second one leaves the
  // first one's rolled file alone instead of replacing it with the new, nearly empty log.
  try {
    const maxBytes = Number(process.env.STUDIO_EVENTS_MAX_MB || 25) * 1024 * 1024;
    if (fs.statSync(primary).size > maxBytes) {
      const rolled = primary.replace(/\.jsonl$/, `-${now.replace(/[:.]/g, '-')}.jsonl`);
      if (!fs.existsSync(rolled)) fs.renameSync(primary, rolled);
    }
  } catch {
    // no log yet
  }
  // 2.57.0 (PU-16, P-041): a torn last line (a writer killed mid-line) is closed with a newline first, so it can't
  // glue onto this event and make both unreadable (a task.start was lost that way and metrics saw 0 attempts).
  appendLine(primary, line);

  for (const mirror of mirrors) {
    try {
      const dir = path.dirname(mirror);
      if (fs.existsSync(dir)) {
        appendLine(mirror, line);
      }
    } catch {
      // Non-fatal if /tmp does not exist on raw Windows without Git Bash
    }
  }

  return event;
}

/**
 * The files the log rolled over into (`events-<time>.jsonl` beside it), newest first. The time in the name is
 * fixed-width, so name order is time order.
 */
export function rolledEventFiles(primary = getEventPaths().primary) {
  if (!/\.jsonl$/.test(primary)) return [];
  const dir = path.dirname(primary);
  const base = path.basename(primary, '.jsonl').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${base}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\.jsonl$`);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => re.test(n));
  } catch {
    return [];
  }
  return names.sort().reverse().map((n) => path.join(dir, n));
}

/**
 * The last `need` non-empty lines of a file (all of them when `need` <= 0), oldest first. Reads backwards in
 * growing chunks, so a few recent lines of a 25 MB file cost a few hundred KB, and stops after `maxBytes`.
 * Lines are cut on the newline byte before decoding, so a character split across chunks can't be garbled.
 */
function tailLines(file, need, maxBytes = Infinity) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const chunks = [];
    let pos = size;
    let newlines = 0;
    let step = 256 * 1024;
    const lines = () => {
      const buf = Buffer.concat(chunks);
      const nl = buf.indexOf(10);
      const from = pos === 0 ? 0 : nl === -1 ? buf.length : nl + 1; // the first line may be cut: drop it unless at the start
      return buf.toString('utf8', from).split('\n').filter((l) => l.trim().length > 0);
    };
    while (pos > 0 && size - pos < maxBytes) {
      const len = Math.min(step, pos, maxBytes - (size - pos));
      const buf = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, pos - len + got);
        if (n <= 0) break;
        got += n;
      }
      if (got < len) break; // the file shrank under us: keep what was read
      pos -= len;
      chunks.unshift(buf);
      for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) newlines++;
      if (need > 0 && newlines > need) {
        const got2 = lines();
        if (got2.length >= need) return got2.slice(-need);
      }
      step = Math.min(step * 2, 16 * 1024 * 1024);
    }
    const all = lines();
    return need > 0 ? all.slice(-need) : all;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read the last `limit` events from `.studio/events.jsonl` (`limit` <= 0: the whole current file).
 *
 * 2.58.0 (PU-41, P-058): when the log has rolled over (STUDIO_EVENTS_MAX_MB), the current file can hold only a few
 * events, and `task show`, the start commit for "no code changed", a task's lane and the watcher's "last heard"
 * lost everything before the roll-over. A reader asking for N events now goes on into the rolled files, newest
 * first and read from the end, until it has N; it reads at most twice STUDIO_EVENTS_MAX_MB of them, so asking for a
 * huge N can't pull the whole history into memory. Appends are unchanged (no copying at roll-over).
 */
export function readRecentEvents(limit = 100) {
  const { primary } = getEventPaths();
  const want = Number(limit) > 0 ? Number(limit) : 0;
  let slice = tailLines(primary, want);
  if (want && slice.length < want) {
    let budget = 2 * Number(process.env.STUDIO_EVENTS_MAX_MB || 25) * 1024 * 1024;
    for (const f of rolledEventFiles(primary)) {
      if (slice.length >= want || !(budget > 0)) break;
      let size = 0;
      try {
        size = fs.statSync(f).size;
      } catch {
        continue;
      }
      slice = tailLines(f, want - slice.length, budget).concat(slice);
      budget -= size;
    }
  }
  const out = [];
  for (const line of slice) {
    try {
      const e = JSON.parse(line);
      // A torn line can still parse as a bare number or string: only event objects count.
      if (e && typeof e === 'object' && !Array.isArray(e)) out.push(e);
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
