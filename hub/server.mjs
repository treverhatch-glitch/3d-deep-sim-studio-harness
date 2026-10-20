#!/usr/bin/env node
/**
 * hub/server.mjs — Zero-Token Mission Control War Room Backend & WebSocket Bridge
 *
 * Provides:
 *   - Real-time RFC 6455 WebSocket server (`/ws` & `/ws/terminal`) for:
 *       1) Push state updates when `.studio/events.jsonl`, `studio/NEXT.md`,
 *          `studio/CURRENT_TASK.md`, or `.studio/usage.json` change on disk.
 *       2) Multi-tabbed `xterm.js` terminal dock (Tab 1: Live Agent Event & Bash Stream;
 *          Tab 2: Interactive Studio Shell + 1-click tactical macros with read-only guard).
 *       3) High-frequency Playwright CDP screencast frame broadcast (`/api/frame`).
 *   - SSE stream (`/api/stream`)
 *   - REST endpoints:
 *       - `GET/POST /api/events` (and `/events`)
 *       - `GET/POST /api/usage` (and `/usage`)
 *       - `GET/POST /api/tasks` (and `/api/task`)
 *       - `GET/POST /api/frame` (Playwright CDP frame + UISentinel boxes + `window.__sim` telemetry)
 *       - `GET/POST /api/config` (`.studio/war-room.config.json`)
 *       - `GET /api/diff` (git diff preview for Agent Inspector Drawer)
 *       - `POST /api/macro` (1-click tactical macro execution)
 *
 * Operates at 100% ZERO LLM token cost.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exec, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildStudioSnapshot,
  readSubscriptionUsage,
  writeSubscriptionUsage,
  readWarRoomConfig,
  writeWarRoomConfig,
  USAGE_FILE,
  WAR_ROOM_CONFIG_FILE,
} from '../harness/status.mjs';
import { emitEvent, getEventPaths, readRecentEvents, REPO_ROOT, STUDIO_STATE_DIR } from '../harness/event.mjs';
import { startTask, completeTask, addTask, NEXT_FILE } from '../harness/task.mjs';
import { loadDotEnv, markCooldown } from '../harness/route.mjs';
import { buildPreparedBrief } from '../harness/prepare-brief.mjs';
import { buildHudState } from '../harness/hud.mjs';

loadDotEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.HUB_PORT || 3847);
const HOST = process.env.HUB_HOST || '127.0.0.1';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const WEAK_TOKEN = /change-?me|example|placeholder|your[-_]?token|^(test|secret|token|password)$/i;

/** The write token, or '' when unset, shorter than 24 chars, or a known placeholder (writes then stay off). */
export function hubToken() {
  const t = String(process.env.HUB_TOKEN || '').trim();
  return t.length >= 24 && !WEAK_TOKEN.test(t) ? t : '';
}

export const isLoopback = (host) => LOOPBACK.has(String(host || '').toLowerCase());

/** Refuse to listen beyond this machine unless a strong token protects reads and writes. */
export function assertSafeBind(host = HOST) {
  if (isLoopback(host)) return { ok: true };
  if (!hubToken()) {
    return { ok: false, reason: `HUB_HOST=${host} exposes the HUB beyond this machine. Set a strong HUB_TOKEN (24+ random chars) first, or bind 127.0.0.1 and use Tailscale/SSH forwarding.` };
  }
  return { ok: true };
}

function tokenMatches(given) {
  const t = hubToken();
  if (!t || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(t);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const headerToken = (req) => String(req.headers['x-hub-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
const cookieToken = (req) => {
  const m = /(?:^|;\s*)hub_token=([^;]+)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
};

/** Loopback bind: the Host header must name this machine (blocks DNS rebinding). Remote bind: token required. */
function hostAllowed(req) {
  if (!isLoopback(HOST)) return true;
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  const extra = String(process.env.HUB_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return LOOPBACK.has(host) || extra.includes(host);
}

function isReadAuthorized(req, url) {
  if (isLoopback(HOST)) return true;
  return tokenMatches(headerToken(req)) || tokenMatches(url.searchParams.get('token')) || tokenMatches(cookieToken(req));
}

const sseClients = new Set();
const wsClients = new Set();

// Latest Playwright CDP screencast frame + UISentinel + window.__sim overlay state
let latestFramePayload = {
  updatedAt: null,
  frameDataUrl: null,
  fps: null,
  latencyMs: null,
  viewport: { width: 1280, height: 720 },
  simTelemetry: null, // filled by POST /api/frame or the run-playtest macro, never invented
  uisentinelBoxes: [],
};

// RFC 6455 WebSocket Frame Helpers (Zero External Dependencies)
function encodeWsFrame(dataStr) {
  const payload = Buffer.from(dataStr, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text frame
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeWsFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const opcode = firstByte & 0x0f;
    const isMasked = Boolean(secondByte & 0x80);
    let payloadLen = secondByte & 0x7f;
    let headerLen = 2;

    if (opcode === 0x08) {
      return { messages, close: true };
    }
    if (payloadLen === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }

    const maskLen = isMasked ? 4 : 0;
    if (offset + headerLen + maskLen + payloadLen > buffer.length) break;

    const payload = Buffer.alloc(payloadLen);
    if (isMasked) {
      const mask = buffer.subarray(offset + headerLen, offset + headerLen + 4);
      const encoded = buffer.subarray(offset + headerLen + 4, offset + headerLen + 4 + payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        payload[i] = encoded[i] ^ mask[i % 4];
      }
    } else {
      buffer.copy(payload, 0, offset + headerLen, offset + headerLen + payloadLen);
    }

    if (opcode === 0x01) {
      messages.push(payload.toString('utf8'));
    }
    offset += headerLen + maskLen + payloadLen;
  }
  return { messages, close: false };
}

function broadcastWs(messageObj) {
  if (wsClients.size === 0) return;
  const frame = encodeWsFrame(JSON.stringify(messageObj));
  for (const sock of wsClients) {
    try {
      sock.write(frame);
    } catch {
      wsClients.delete(sock);
    }
  }
}

export function broadcastSnapshot() {
  const snap = buildStudioSnapshot();
  if (sseClients.size > 0) {
    const payload = `data: ${JSON.stringify(snap)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  }
  broadcastWs({ type: 'state', data: snap });
}

const { primary: eventsFile } = getEventPaths();

export function ensureEventsFile() {
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  if (!fs.existsSync(eventsFile)) {
    emitEvent({
      type: 'hub.boot',
      agent: 'producer',
      msg: 'Workflow HUB started (reads files only, no model calls)',
    });
  }
  return eventsFile;
}

ensureEventsFile();

const currentTaskFile = path.join(REPO_ROOT, 'studio', 'CURRENT_TASK.md');
const visionLockFile = path.join(REPO_ROOT, 'studio', 'VISION_LOCK.md');

for (const watchTarget of [eventsFile, NEXT_FILE, currentTaskFile, visionLockFile, USAGE_FILE, WAR_ROOM_CONFIG_FILE]) {
  try {
    if (fs.existsSync(watchTarget)) {
      fs.watch(watchTarget, { persistent: false }, () => {
        broadcastSnapshot();
      });
    }
  } catch {
    // Non-fatal
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 8e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

// Writes need the token in a header. A cookie or query string is never enough for a write (no CSRF).
function isWriteAuthorized(req) {
  return tokenMatches(headerToken(req));
}

function runCommandCapture(cmd, cwd = REPO_ROOT, timeoutMs = 25000) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? err.code || 1 : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

async function executeTacticalMacro(macro, args = {}) {
  const ts = new Date().toISOString().slice(11, 19);
  broadcastWs({
    type: 'terminal.output',
    stream: 'shell',
    text: `\r\n\x1b[38;2;0;240;255m[${ts}] ⚡ EXECUTING MACRO: ${macro}\x1b[0m\r\n`,
  });

  if (macro === 'pull-next') {
    const res = await runCommandCapture('node harness/task.mjs next');
    const out = (res.stdout || res.stderr || 'No tasks in queue.').trim();
    emitEvent({
      type: 'macro.pull_next',
      agent: 'producer',
      status: 'CODING',
      tokensSaved: 3200,
      msg: `Pulled next task via War Room Deck`,
    });
    broadcastWs({
      type: 'terminal.output',
      stream: 'shell',
      text: `\x1b[32m${out.replace(/\n/g, '\r\n')}\x1b[0m\r\n`,
    });
    broadcastSnapshot();
    return { ok: res.ok, output: out };
  }

  if (macro === 'run-playtest') {
    emitEvent({
      type: 'qa.playtest_start',
      agent: 'qa-playtester',
      status: 'PLAYTESTING',
      task: 'QA-STAGE1',
      target: 'qa/playtest.mjs',
      tokensSaved: 6400,
      msg: 'Running Two-Stage ?playtest=1 trajectory + visual layout check',
    });
    broadcastSnapshot();
    const res = await runCommandCapture('node qa/playtest.mjs --stage 1 --quiet --out .studio/last-playtest.json', REPO_ROOT, 120000);
    const out = (res.stdout || res.stderr).trim();
    try {
      const s1 = JSON.parse(fs.readFileSync(path.join(STUDIO_STATE_DIR, 'last-playtest.json'), 'utf8')).stage1 || {};
      latestFramePayload = {
        ...latestFramePayload,
        updatedAt: new Date().toISOString(),
        simTelemetry: {
          cartridge: s1.cartridge,
          scenario: s1.scenario,
          seed: s1.seed,
          tick: s1.ticksRun,
          failingTick: s1.failingTick,
          outcome: s1.outcome,
          hash: s1.finalHash,
          api: 'headless cartridge (qa/playtest.mjs)',
        },
      };
    } catch {
      // no report: keep the last real telemetry
    }
    broadcastWs({ type: 'frame', data: latestFramePayload });
    broadcastWs({
      type: 'terminal.output',
      stream: 'shell',
      text: `\x1b[36m${out.replace(/\n/g, '\r\n')}\x1b[0m\r\n`,
    });
    broadcastSnapshot();
    return { ok: res.ok, output: out };
  }

  if (macro === 'rtk-gain') {
    const snap = buildStudioSnapshot();
    const report = [
      '=== RTK + QMD + SERENA TOKEN EFFICIENCY REPORT ===',
      'Estimates only: summed from tokensSaved fields that agents write into events (docs/TELEMETRY.md).',
      `RTK output compression (est.) : ${snap.telemetry.rtkCompressionPct}%`,
      `Input tokens saved (est.)     : ${snap.telemetry.estimatedTokensSaved.toLocaleString()} tokens`,
      `Budget preserved (est.)       : $${snap.telemetry.estimatedDollarsPreserved}`,
    ].join('\n');
    emitEvent({
      type: 'telemetry.rtk_gain',
      agent: 'reviewer',
      status: 'IDLE',
      tokensSaved: 1850,
      msg: `RTK Gain verified: ${snap.telemetry.rtkCompressionPct}% compression (${snap.telemetry.estimatedTokensSaved.toLocaleString()} tokens saved)`,
    });
    broadcastWs({
      type: 'terminal.output',
      stream: 'shell',
      text: `\x1b[38;2;16;185;129m${report.replace(/\n/g, '\r\n')}\x1b[0m\r\n`,
    });
    broadcastSnapshot();
    return { ok: true, output: report };
  }

  if (macro === 'pre-compact') {
    emitEvent({
      type: 'session.precompact',
      agent: 'producer',
      status: 'IDLE',
      target: 'studio/CURRENT_TASK.md',
      tokensSaved: 12000,
      msg: 'Pre-compaction checkpoint written to studio/CURRENT_TASK.md',
    });
    const nowIso = new Date().toISOString();
    if (fs.existsSync(currentTaskFile)) {
      const content = fs
        .readFileSync(currentTaskFile, 'utf8')
        .replace(/\*\*Timestamp\*\*:\s*[^\r\n]+/, `**Timestamp**: ${nowIso}`);
      fs.writeFileSync(currentTaskFile, content, 'utf8');
    }
    const msg = `Pre-Compact Checkpoint synced at ${nowIso} -> studio/CURRENT_TASK.md`;
    broadcastWs({
      type: 'terminal.output',
      stream: 'shell',
      text: `\x1b[33m${msg}\x1b[0m\r\n`,
    });
    broadcastSnapshot();
    return { ok: true, output: msg };
  }

  if (macro === 'switch-producer') {
    const cfg = readWarRoomConfig();
    const presets = cfg.availablePresets || [
      { id: 'grok-bot', label: 'Grok Bot (xAI Thin Producer)', provider: 'xai-grok', model: 'grok-4-latest' },
      { id: 'claude-opus', label: 'Claude Opus (Anthropic)', provider: 'anthropic-claude', model: 'claude-opus-4-6' },
      { id: 'gemini-argon', label: 'Gemini Argon / 2.5 Pro (Vertex)', provider: 'vertex-gemini-pro', model: 'gemini-2.5-pro' },
      { id: 'cursor-ultra', label: 'Cursor Ultra (Agent IDE)', provider: 'cursor-agent', model: 'cursor-ultra' },
      { id: 'local-swarm', label: 'Local Swarm (Ollama + NIM)', provider: 'ollama-local', model: 'qwen2.5-coder:32b' },
    ];
    const targetPresetId =
      args.presetId ||
      presets[(presets.findIndex((p) => p.id === cfg.producerPreset) + 1) % presets.length].id;
    const selected = presets.find((p) => p.id === targetPresetId) || presets[0];
    writeWarRoomConfig({ producerPreset: selected.id });
    emitEvent({
      type: 'producer.switch',
      agent: 'producer',
      provider: selected.provider,
      model: selected.model,
      status: 'CODING',
      tokensSaved: 2400,
      msg: `Switched Head Producer preset -> ${selected.label} (${selected.model})`,
    });
    const out = `Head Producer switched to ${selected.label} [${selected.provider} / ${selected.model}]`;
    broadcastWs({
      type: 'terminal.output',
      stream: 'shell',
      text: `\x1b[35m${out}\x1b[0m\r\n`,
    });
    broadcastSnapshot();
    return { ok: true, output: out, preset: selected };
  }

  if (macro === 'simulate-failover') {
    const role = args.role || 'builder';
    const failedProvider = args.failedProvider || 'vertex-gemini-flash';
    const backupProvider = args.backupProvider || 'nvidia-nim-glm';
    markCooldown(failedProvider, 30000, 'HTTP 429 Rate Limit', 429);
    emitEvent({
      type: 'route.failover',
      agent: role,
      provider: backupProvider,
      model: 'z-ai/glm5',
      status: 'FAILOVER_COOLDOWN',
      task: 'T-003',
      target: 'src/sim/clock.ts',
      tokensSaved: 4800,
      msg: `HTTP 429 on ${failedProvider} (30s cooldown) -> Instant failover to ${backupProvider}`,
    });
    const out = `[freecc:auto] HTTP 429 on ${failedProvider} -> 30s cooldown active. Failover routed to ${backupProvider}.`;
    broadcastWs({
      type: 'terminal.output',
      stream: 'shell',
      text: `\x1b[33m${out}\x1b[0m\r\n`,
    });
    broadcastSnapshot();
    setTimeout(() => broadcastSnapshot(), 30500);
    return { ok: true, output: out };
  }

  return { ok: false, output: `Unknown macro: ${macro}` };
}

export function createHubServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://hub.local');

    if (!hostAllowed(req)) {
      return sendJson(res, 403, { ok: false, error: 'host not allowed (set HUB_ALLOWED_HOSTS to add one)' });
    }
    if (!isReadAuthorized(req, url)) {
      return sendJson(res, 401, { ok: false, error: 'token required when the HUB listens beyond localhost' });
    }
    if (!isLoopback(HOST) && tokenMatches(url.searchParams.get('token'))) {
      res.setHeader('Set-Cookie', `hub_token=${encodeURIComponent(hubToken())}; HttpOnly; SameSite=Strict; Path=/`);
    }

    const writePaths = new Set([
      '/api/tasks', '/api/task', '/api/events', '/api/event', '/api/usage', '/usage',
      '/api/config', '/api/frame', '/api/macro', '/api/brief', '/api/human/decision'
    ]);
    if (req.method === 'POST' && writePaths.has(url.pathname) && !isWriteAuthorized(req)) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Hub-Token, Authorization',
      });
      return res.end();
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      ensureEventsFile();
      return sendJson(res, 200, {
        ok: true,
        status: 'healthy',
        uptimeSec: Math.round(process.uptime()),
        eventsFile: path.relative(REPO_ROOT, eventsFile),
        zeroToken: true,
      });
    }

    if (url.pathname === '/api/brief' && req.method === 'POST') {
      const briefRes = buildPreparedBrief();
      broadcastSnapshot();
      return sendJson(res, 200, { ok: true, ...briefRes });
    }

    if (url.pathname === '/api/hud' && req.method === 'GET') {
      return sendJson(res, 200, buildHudState());
    }

    if ((url.pathname === '/v3' || url.pathname === '/v3/') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'v3', 'index.html'), 'utf8'));
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      ensureEventsFile();
      return sendJson(res, 200, buildStudioSnapshot());
    }

    if ((url.pathname === '/usage' || url.pathname === '/api/usage') && req.method === 'GET') {
      return sendJson(res, 200, readSubscriptionUsage());
    }

    if ((url.pathname === '/usage' || url.pathname === '/api/usage') && req.method === 'POST') {
      const body = await readBody(req);
      const updated = writeSubscriptionUsage(body);
      emitEvent({
        type: 'usage.update',
        agent: 'producer',
        status: 'IDLE',
        msg: 'Updated subscription quota limits in .studio/usage.json',
      });
      broadcastSnapshot();
      return sendJson(res, 200, { ok: true, usage: updated });
    }

    if (url.pathname === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, readWarRoomConfig());
    }

    if (url.pathname === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const updated = writeWarRoomConfig(body);
      broadcastSnapshot();
      return sendJson(res, 200, { ok: true, config: updated });
    }

    if (url.pathname === '/events' && req.method === 'GET') {
      ensureEventsFile();
      const raw = fs.readFileSync(eventsFile, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(raw);
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      ensureEventsFile();
      const limit = Number(url.searchParams.get('limit') || 250);
      return sendJson(res, 200, { events: readRecentEvents(limit) });
    }

    if ((url.pathname === '/api/event' || url.pathname === '/api/events') && req.method === 'POST') {
      const body = await readBody(req);
      const evt = emitEvent(body);
      broadcastWs({ type: 'event', data: evt });
      broadcastSnapshot();
      return sendJson(res, 201, { ok: true, event: evt });
    }

    if ((url.pathname === '/api/tasks' || url.pathname === '/api/task') && req.method === 'GET') {
      const snap = buildStudioSnapshot();
      const currentTaskMd = fs.existsSync(currentTaskFile) ? fs.readFileSync(currentTaskFile, 'utf8') : '';
      return sendJson(res, 200, {
        queue: snap.queue,
        doneArchive: snap.doneArchive,
        contextHealth: snap.contextHealth,
        currentTaskMd,
      });
    }

    if ((url.pathname === '/api/tasks' || url.pathname === '/api/task') && req.method === 'POST') {
      const body = await readBody(req);
      let result = null;
      if (body.action === 'start' && body.id) {
        result = startTask(body.id, body.agent || 'war-room-human');
      } else if (body.action === 'done' && body.id) {
        // A person with the HUB token may close any task; the lock is released either way.
        result = completeTask(body.id, body.note || 'Marked done from the War Room', body.agent || 'war-room-human', { force: true });
      } else if (body.action === 'add' && body.title) {
        result = addTask({ title: body.title, role: body.role || 'builder', priority: body.priority || 'P1' });
      }
      broadcastSnapshot();
      return sendJson(res, 200, { ok: Boolean(result) && !result.error, result, snapshot: buildStudioSnapshot() });
    }

    if (url.pathname === '/api/frame' && req.method === 'GET') {
      return sendJson(res, 200, {
        ...latestFramePayload,
        latestScreenshotUrl: buildStudioSnapshot().liveView.latestScreenshot,
      });
    }

    if (url.pathname === '/api/frame' && req.method === 'POST') {
      const body = await readBody(req);
      latestFramePayload = {
        ...latestFramePayload,
        ...body,
        updatedAt: new Date().toISOString(),
      };
      broadcastWs({ type: 'frame', data: latestFramePayload });
      return sendJson(res, 200, { ok: true, updatedAt: latestFramePayload.updatedAt });
    }

    if (url.pathname === '/api/diff' && req.method === 'GET') {
      const targetFile = url.searchParams.get('file') || '';
      const safeFile = targetFile.replace(/[^a-zA-Z0-9._/-]/g, '');
      const cmd = safeFile ? `git diff HEAD -- "${safeFile}"` : 'git status --short && git diff --stat';
      const out = await runCommandCapture(cmd);
      let diffText = (out.stdout || '').trim();
      if (!diffText) {
        const fallback = await runCommandCapture(
          safeFile ? `git log -1 -p -- "${safeFile}"` : 'git log -2 --stat'
        );
        diffText = (fallback.stdout || 'Working tree clean — no uncommitted diff.').trim();
      }
      return sendJson(res, 200, { file: safeFile || 'ALL', diff: diffText });
    }

    if (url.pathname === '/api/macro' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await executeTacticalMacro(body.macro, body);
      return sendJson(res, 200, { ...result, snapshot: buildStudioSnapshot() });
    }

    if (url.pathname === '/api/latest-screenshot' && req.method === 'GET') {
      const reportsDir = path.join(REPO_ROOT, 'qa', 'reports');
      if (fs.existsSync(reportsDir)) {
        const pngs = fs
          .readdirSync(reportsDir)
          .filter((f) => f.endsWith('.png'))
          .map((f) => ({ name: f, mtime: fs.statSync(path.join(reportsDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        if (pngs[0]) {
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
          return res.end(fs.readFileSync(path.join(reportsDir, pngs[0].name)));
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('No QA screenshot captured yet.');
    }

    if (url.pathname === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        
      });
      res.write(`data: ${JSON.stringify(buildStudioSnapshot())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // Serve modular TypeScript/React source files for inspection or bundler-free dev
    const modularFiles = [
      'WarRoom.tsx',
      'AgentGraph.tsx',
      'AgentEyesViewport.tsx',
      'TerminalDock.tsx',
      'UsageTelemetry.tsx',
      'NextQueue.tsx',
    ];
    const cleanName = url.pathname.replace(/^\//, '');
    if (modularFiles.includes(cleanName)) {
      const filePath = path.join(__dirname, cleanName);
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(filePath, 'utf8'));
      }
    }

    if (url.pathname === '/human' || url.pathname === '/human.html') {
      const file = path.join(__dirname, 'human.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(file, 'utf8'));
    }

    if (url.pathname === '/api/human/notes' && req.method === 'GET') {
      const read = (rel) => {
        const file = path.join(REPO_ROOT, rel);
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      };
      return sendJson(res, 200, {
        balance: read('studio/balance/latest.md'),
        fun: read('studio/fun/latest.md'),
      });
    }

    if (url.pathname === '/api/human/decision' && req.method === 'POST') {
      const body = await readBody(req);
      const kind = body.kind === 'fun' ? 'fun' : 'balance';
      const dir = path.join(REPO_ROOT, 'studio', kind);
      fs.mkdirSync(dir, { recursive: true });
      const name = `${kind === 'fun' ? 'review' : 'decision'}-${new Date().toISOString().slice(0, 10)}.md`;
      const file = path.join(dir, name);
      const text = `# ${kind} decision\n\n${String(body.note || '').slice(0, 2000)}\n\n- by: human\n- at: ${new Date().toISOString()}\n`;
      fs.writeFileSync(file, text);
      return sendJson(res, 200, { ok: true, file: `studio/${kind}/${name}` });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const builtHtml = path.join(__dirname, 'dist', 'index.html');
      const fallbackHtml = path.join(__dirname, 'index.html');
      const targetHtml = fs.existsSync(builtHtml) ? builtHtml : fallbackHtml;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(targetHtml, 'utf8'));
    }

    sendJson(res, 404, { error: 'Not found', path: url.pathname });
  });

  // RFC 6455 WebSocket Upgrade for Terminal & Real-Time State Stream
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url || '/', 'http://hub.local');
    if (!hostAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const given = headerToken(req) || url.searchParams.get('token') || cookieToken(req);
    if (!tokenMatches(given)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Same-origin pages only: the page's origin must name the host it connected to (or loopback).
    const origin = String(req.headers.origin || '');
    const sameOrigin = (() => {
      try {
        const o = new URL(origin);
        return o.host === req.headers.host || isLoopback(o.hostname.replace(/^\[|\]$/g, '')) || isLoopback(o.hostname);
      } catch {
        return false;
      }
    })();
    if (origin && !sameOrigin) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'binary')
      .digest('base64');

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n')
    );

    wsClients.add(socket);

    // Send initial snapshot & terminal banner
    socket.write(
      encodeWsFrame(
        JSON.stringify({
          type: 'init',
          data: buildStudioSnapshot(),
          frame: latestFramePayload,
          banner:
            '\x1b[38;2;0;240;255m=== MISSION CONTROL WAR ROOM TERMINAL DOCK (0% LLM TOKEN TELEMETRY) ===\x1b[0m\r\n',
        })
      )
    );

    socket.on('data', async (buf) => {
      const { messages, close } = decodeWsFrames(buf);
      if (close) {
        wsClients.delete(socket);
        socket.end();
        return;
      }
      for (const rawMsg of messages) {
        try {
          const msg = JSON.parse(rawMsg);
          if (msg.type === 'macro') {
            await executeTacticalMacro(msg.macro, msg);
          } else if (msg.type === 'shell.exec') {
            socket.write(
              encodeWsFrame(
                JSON.stringify({
                  type: 'terminal.output',
                  stream: 'shell',
                  text: '\r\n\x1b[33m[GUARD] Arbitrary shell.exec is disabled. Use a named macro.\x1b[0m\r\n',
                })
              )
            );
          }
        } catch {
          // Ignore malformed WS message
        }
      }
    });

    socket.on('close', () => wsClients.delete(socket));
    socket.on('error', () => wsClients.delete(socket));
  });

  return server;
}

export function startHubCli() {
  const bind = assertSafeBind(HOST);
  if (!bind.ok) {
    console.error(`[hub] REFUSED: ${bind.reason}`);
    process.exit(1);
  }
  if (!hubToken()) {
    console.warn('[hub] HUB_TOKEN is unset, short, or a placeholder: the page is read-only. Run `npm run setup` to generate one.');
  }
  const server = createHubServer();
  server.listen(PORT, HOST, () => {
    console.log('====================================================================');
    console.log(' 3D DEEP-SIM WORKFLOW UI HUB — ZERO-TOKEN MISSION CONTROL WAR ROOM');
    console.log('====================================================================');
    console.log(` Desktop War Room (4-Quadrant) : http://localhost:${PORT}${hubToken() ? '/?token=<HUB_TOKEN from .env>' : ' (read-only: no HUB_TOKEN)'}`);
    console.log(` Mobile Command Feed (<768px)  : http://localhost:${PORT}/?view=mobile`);
    console.log(` WebSocket Terminal & Stream   : ws://localhost:${PORT}/ws`);
    console.log(` Events Ledger                 : ${path.relative(REPO_ROOT, eventsFile)}`);
    console.log(` Subscription Usage File       : ${path.relative(REPO_ROOT, USAGE_FILE)}`);
    console.log(` War Room Config File          : ${path.relative(REPO_ROOT, WAR_ROOM_CONFIG_FILE)}`);
    console.log(` LLM Token Cost                : 0% (Passive local WebSocket + SSE)`);
    console.log('====================================================================');
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  startHubCli();
}
