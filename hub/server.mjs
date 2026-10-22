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
import { acceptModelWarning } from '../harness/model-tiers.mjs';
import { recordCheck, endForRefresh } from '../harness/session-cap.mjs';
import { startTask, completeTask, addTask, pauseTask, reopenTask, NEXT_FILE, readStop, setStop, clearStop } from '../harness/task.mjs';
import { loadDotEnv, markCooldown } from '../harness/route.mjs';
import { buildPreparedBrief } from '../harness/prepare-brief.mjs';
import { buildHudState, buildAgentDetail, setDivision, listDivisions } from '../harness/hud.mjs';
import { acceptCause } from '../harness/causes.mjs';
import { serveBuildFile, buildPagePath } from '../harness/builds.mjs';
import { watchPass } from '../harness/watch.mjs';
import { retroIfDue } from '../harness/retro.mjs';
import { dailyPingIfDue, driftReport } from '../harness/director.mjs';
import { learnIfDue } from '../harness/learn.mjs';
import { runReportIfDue } from '../harness/run-report.mjs';
import { setMode, setBoost, describeMode } from '../harness/mode.mjs';
import { startAgent, stopAgentNamed, stopAllAgents, pauseAgent, sessions as agentSessions, wake } from '../harness/agent.mjs';
import { readDesigns, readArtRefs, approve as approveDesign, changes as changeDesign, feedback as artFeedback, addArtReference, IMAGE as ART_IMAGE, MODEL as ART_MODEL } from '../harness/art.mjs';
import { answer as answerAsk, reverse as reverseAsk, runAskAction } from '../harness/ask.mjs';
import { readRefs } from '../harness/refs.mjs';
import { readExperiments } from '../harness/experiment.mjs';
import { readBriefs, chatTurn, confirmBrief, dropBrief } from '../harness/liaison.mjs';
import { readBible, writeBible, checkBible, catalog, readIdeas, signBible, suggestedLayers, latestReview, pendingFollowups, answerFollowup } from '../harness/bible.mjs';
import { runIntake } from '../harness/intake.mjs';
import { readConsent, setConsent, markShown, describeConsent, QUESTION as DATA_QUESTION, DETAIL as DATA_DETAIL } from '../harness/data-consent.mjs';
import { addIdea, routeIdea } from '../harness/ideas.mjs';

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

// Names people use on War Room buttons: the HUD seats them in the Producer's office, not with the agents.
function noteHuman(name) {
  const file = path.join(STUDIO_STATE_DIR, 'humans.json');
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // first one
  }
  const n = String(name || '').slice(0, 40);
  if (n && !list.includes(n)) {
    fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify([...list, n]) + '\n');
  }
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

function readBody(req, limit = 8e6) {
  return new Promise((resolve) => {
    let data = '';
    req.on('close', () => resolve({}));
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) req.destroy();
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
      snap.telemetry.measured
        ? `Measured by rtk: ${snap.telemetry.estimatedTokensSaved.toLocaleString()} tokens saved (only what rtk itself reported).`
        : 'Not measured: no tool has reported savings. Install rtk (npm run setup:token-savers) to measure them.',
    ].join('\n');
    emitEvent({
      type: 'telemetry.rtk_gain',
      agent: 'reviewer',
      status: 'IDLE',
      msg: snap.telemetry.measured ? `rtk reported ${snap.telemetry.estimatedTokensSaved.toLocaleString()} tokens saved` : 'Token savings: not measured (no tool reported any)',
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
      msg: `[demo] Simulated HTTP 429 on ${failedProvider} (30s cooldown) -> failover to ${backupProvider}`,
      meta: { demo: true },
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
  // The build page the Arcade opened last (for a bundled game's root-relative files, below).
  let lastPlayed = null;
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
      '/api/config', '/api/frame', '/api/macro', '/api/brief', '/api/human/decision', '/api/watch'
    ]);
    // Every write needs the token header (the list above is kept for reference; new endpoints are covered too).
    if (req.method === 'POST' && (writePaths.has(url.pathname) || url.pathname.startsWith('/api/')) && !isWriteAuthorized(req)) {
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

    // Game Bible, intake and the Idea Board: the same data the CLI writes, so a friendlier UI can drive it later.
    if (url.pathname === '/api/bible' && req.method === 'GET') {
      const b = readBible();
      const r = latestReview();
      return sendJson(res, 200, { ok: true, dataConsent: { ...readConsent(), text: describeConsent(), question: DATA_QUESTION, detail: DATA_DETAIL }, bible: b, check: b ? checkBible(b) : null, followups: b ? pendingFollowups(b) : [], suggested: b ? suggestedLayers(b.answers) : [], drift: driftReport(), latestReview: r ? { file: r.file, verdict: r.verdict, phase: r.phase, at: new Date(r.at).toISOString() } : null, ideas: readIdeas(), refs: readRefs().map((r) => ({ id: r.id, game: r.game, feature: r.feature, at: r.at, kept: r.files.length, url: r.url || null })), experiments: readExperiments().map((x) => ({ id: x.id, title: x.title, status: x.status, idea: x.idea })), briefs: readBriefs().slice(-8).map((b) => ({ id: b.id, kind: b.kind, title: b.title, stage: b.stage, by: b.confirmed?.by || b.from })), ...catalog() });
    }
    if (url.pathname === '/api/ideas' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ideas: readIdeas() });
    }
    if (url.pathname === '/api/ideas' && req.method === 'POST') {
      const body = await readBody(req);
      noteHuman(body.by || 'war-room-human');
      const r = addIdea({ title: String(body.title || ''), detail: String(body.detail || ''), by: String(body.by || 'war-room-human').slice(0, 60), source: 'dev-pitched' });
      if (!r.ok) return sendJson(res, 400, r);
      // A pitch from the dev goes straight to R&D, and R&D's agent starts if it can.
      const routed = routeIdea(r.idea.id, 'war-room');
      const w = routed.ok ? wake('rnd', { task: routed.task, why: `pitch ${r.idea.id}` }) : { next: routed.message };
      broadcastSnapshot();
      return sendJson(res, 201, { ...r, task: routed.task || null, started: w.agent || null, next: `${r.idea.id} is on the Idea Board. ${w.next}` });
    }
    if (url.pathname === '/api/intake' && req.method === 'POST') {
      const body = await readBody(req);
      const r = runIntake({ answers: body.answers || {}, layers: body.layers || {} });
      broadcastSnapshot();
      return sendJson(res, 200, { ok: true, check: r.check, queued: r.queued.map((t) => t.id) });
    }
    if (url.pathname === '/api/mode' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      const r = body.mode ? setMode(String(body.mode), by, String(body.why || '').slice(0, 300)) : setBoost(Boolean(body.boost), by, body.hours ? Number(body.hours) : null);
      broadcastSnapshot();
      return sendJson(res, r.ok ? 200 : 400, { ...r, text: r.ok ? describeMode(r.mode) : undefined });
    }
    if (url.pathname === '/api/agents' && req.method === 'POST') {
      const body = await readBody(req);
      noteHuman(String(body.by || 'war-room-human').slice(0, 60));
      if (body.action === 'stop') {
        const st = stopAgentNamed(String(body.agent || ''), String(body.by || 'war-room-human').slice(0, 60));
        if (!st.ok) return sendJson(res, 400, { ok: false, error: st.message });
        return sendJson(res, 200, { ok: true, stopping: st.agent, next: `Stopping ${st.agent}.${st.tasks.length ? ` ${st.tasks.join(', ')} can restart after ${st.until ? st.until.slice(11, 16) : 'now'}.` : ''}` });
      }
      if (body.action === 'pause') {
        const p = pauseAgent(String(body.agent || ''), String(body.note || '').slice(0, 500), String(body.by || 'war-room-human').slice(0, 60));
        broadcastSnapshot();
        return sendJson(res, p.ok ? 200 : 400, p.ok ? { ok: true, next: `${body.agent} paused${p.handed.length ? `; ${p.handed.join(', ')} back in the queue` : ''}.` } : { ok: false, error: p.message });
      }
      // A hire: from the Act form, or "+ Hire" in a Studio room (division given, role from the division).
      const by = String(body.by || 'war-room-human').slice(0, 60);
      const division = body.division ? String(body.division).replace(/[^a-z0-9-]/gi, '').slice(0, 30) : null;
      const div = division ? listDivisions().find((d) => d.id === division) : null;
      if (division && !div) return sendJson(res, 400, { ok: false, error: `No division ${division}` });
      if (div && !div.active) setDivision(division, true, by);
      const role = String(body.role || div?.roles?.[0] || '').replace(/[^a-z0-9-]/gi, '').slice(0, 30);
      const agent = body.agent ? String(body.agent).replace(/[^a-z0-9._-]/gi, '').slice(0, 40) : undefined;
      const r = startAgent({ role, agent, tool: body.tool ? String(body.tool).replace(/[^a-z]/g, '') : undefined, model: body.model ? String(body.model).replace(/[^a-zA-Z0-9._:/-]/g, '').slice(0, 80) : undefined, task: /^T-\d+$/.test(body.task || '') ? body.task : null, next: !body.task, division, by }, { detach: true });
      broadcastSnapshot();
      return sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, agent: r.agent, tool: r.tool, model: r.model, next: `${r.agent} hired${division ? ` into ${div.name}` : ''} (${r.tool}, ${r.model}); it takes the next ${role} task.` } : { ok: false, error: r.message });
    }
    if (url.pathname === '/api/asks' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      const r = body.action === 'reverse' ? await reverseAsk(String(body.id || ''), String(body.answer || ''), by) : answerAsk(String(body.id || ''), String(body.answer || ''), by);
      // A question that carries an action (the Producer asking to hire past its limit) runs it on "yes".
      const act = r.ok && body.action !== 'reverse' ? await runAskAction(r.ask, by) : null;
      if (act) {
        r.task = null;
        if (act.hired) r.ask.hired = act.hired;
        broadcastSnapshot();
        return sendJson(res, 200, { ok: true, ask: r.ask, next: act.next });
      }
      broadcastSnapshot();
      return sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, ask: r.ask, task: r.task || null, next: r.task ? `The Producer has ${r.task} to undo the old decision.` : `${r.ask.id} answered; ${r.ask.by} sees your answer in its next briefing.` } : { ok: false, error: r.message });
    }
    if (url.pathname === '/api/liaison' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      if (body.action === 'confirm' || body.action === 'drop') {
        const id = String(body.id || '');
        if (body.action === 'drop') {
          const d = dropBrief(id, 'the game dev said no in the War Room chat', by);
          return sendJson(res, d.ok ? 200 : 400, d.ok ? { ok: true, next: `${id} dropped; nothing was sent.` } : { ok: false, error: d.message });
        }
        const r = confirmBrief(id, { by, quote: 'yes (War Room chat)' });
        if (!r.ok) return sendJson(res, 400, { ok: false, error: r.message });
        const w = r.routed.rnd ? wake('rnd', { task: r.routed.rnd, why: id }) : wake('producer', { task: r.routed.producer, why: id });
        broadcastSnapshot();
        return sendJson(res, 200, { ok: true, routed: r.routed, started: w.agent || null, next: `${id} sent on${r.routed.idea ? ` as ${r.routed.idea}` : ''}${r.routed.director ? '; the Director checks it fits the game' : ''}. ${w.next}` });
      }
      const r = await chatTurn({ messages: body.messages || [], from: by, pending: /^B-\d+$/.test(body.pending || '') ? body.pending : null });
      return sendJson(res, r.ok ? 200 : 400, r.ok ? r : { ok: false, error: r.message });
    }
    if (url.pathname === '/api/art' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      const id = String(body.id || '');
      const text = String(body.note || body.text || '').slice(0, 1000);
      const r = body.action === 'say' ? await artFeedback(text, by) : body.action === 'changes' ? await changeDesign(id, text, by) : await approveDesign(id, by, text);
      let next = r.next;
      const tasks = [r.task, ...(r.done || []).map((x) => x.task)].filter(Boolean);
      if (r.ok && tasks.length) next = `${next} ${wake('art', { task: tasks[0], why: `feedback from ${by}` }).next}`;
      broadcastSnapshot();
      return sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, design: r.design || null, task: tasks[0] || null, next } : { ok: false, error: r.message });
    }
    if (url.pathname === '/api/art/reference' && req.method === 'POST') {
      const body = await readBody(req, 40e6);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      const name = path.basename(String(body.name || 'reference')).replace(/[^\w.-]+/g, '-').slice(0, 80);
      if (!body.data || !/\.(png|jpe?g|webp|gif|glb|gltf|fbx|obj|mp4|webm|mp3|ogg|wav)$/i.test(name)) return sendJson(res, 400, { ok: false, error: 'Attach an image, a 3D model (glb, gltf, fbx, obj), a clip or a sound.' });
      fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
      const dir = fs.mkdtempSync(path.join(STUDIO_STATE_DIR, 'upload-'));
      const tmp = path.join(dir, name);
      fs.writeFileSync(tmp, Buffer.from(String(body.data).replace(/^data:[^,]*,/, ''), 'base64'));
      const r = await addArtReference({ file: tmp, label: String(body.label || ''), kind: body.kind === 'use' ? 'use' : 'look', by });
      fs.rmSync(dir, { recursive: true, force: true });
      broadcastSnapshot();
      return sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, reference: r.reference, next: r.next } : { ok: false, error: r.message });
    }
    if ((url.pathname === '/api/art/file' || url.pathname === '/api/art/ref') && req.method === 'GET') {
      // Images and 3D models of designs (any round) and of the dev's references; files inside the project only.
      const id = url.searchParams.get('id');
      let relPath = null;
      if (url.pathname === '/api/art/file') {
        const d = readDesigns().find((x) => x.id === id);
        relPath = d ? (url.searchParams.get('thumb') === '1' && d.thumb ? d.thumb : d.file) : null;
      } else relPath = readArtRefs().find((x) => x.id === id)?.file || null;
      const file = relPath ? path.resolve(REPO_ROOT, relPath) : null;
      if (!file || !(ART_IMAGE.test(file) || ART_MODEL.test(file)) || !file.startsWith(REPO_ROOT + path.sep) || !fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: 'no image or model for that' });
      const ext = path.extname(file).slice(1).toLowerCase();
      const type = { svg: 'image/svg+xml', jpg: 'image/jpeg', glb: 'model/gltf-binary', gltf: 'model/gltf+json' }[ext] || `image/${ext}`;
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      return res.end(fs.readFileSync(file));
    }
    // The engine track's build: its web export (engine.json webExport) and its captured frames.
    if ((url.pathname.startsWith('/engine-play/') || url.pathname === '/api/engine-frame') && req.method === 'GET') {
      const { readTrack } = await import('../harness/engine.mjs');
      const t = readTrack();
      const base = url.pathname === '/api/engine-frame' ? (t ? path.join(REPO_ROOT, t.folder, 'captures') : null) : t?.webExport ? path.join(REPO_ROOT, t.webExport) : null;
      const rel = url.pathname === '/api/engine-frame' ? path.basename(String(url.searchParams.get('file') || '')) : decodeURIComponent(url.pathname.slice('/engine-play/'.length)) || 'index.html';
      const file = base ? path.resolve(base, rel) : null;
      if (!file || !file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, 404, { ok: false, error: 'no engine build or frame (npm run engine)' });
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.pck': 'application/octet-stream', '.png': 'image/png', '.json': 'application/json' }[path.extname(file)] || 'application/octet-stream';
      // A Godot web build with threads needs cross-origin isolation.
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' });
      return res.end(fs.readFileSync(file));
    }
    // The Arcade: the last good build (and older ones) served for play while agents keep working.
    if (url.pathname.startsWith('/play/') && req.method === 'GET') {
      const [, , id, ...rest] = url.pathname.split('/');
      // /play/<id>/ (or /play/<id>) goes to the page in its own folder, so its relative files load.
      if (!rest.join('/')) {
        const page = buildPagePath(id);
        if (page) {
          res.writeHead(302, { location: `/play/${id}/${page}` });
          return res.end();
        }
      }
      if (serveBuildFile(id, rest.join('/'), res)) {
        if (/\.html?$/i.test(rest.join('/'))) lastPlayed = { id, at: Date.now() };
        return;
      }
      return sendJson(res, 404, { ok: false, error: 'no such build or file (npm run play -- list)' });
    }
    if (url.pathname === '/api/clip' && req.method === 'GET') {
      const name = path.basename(String(url.searchParams.get('file') || ''));
      const file = path.join(REPO_ROOT, 'qa', 'reports', 'clips', name);
      if (!/\.(mp4|webm|jpg)$/.test(name) || !fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: 'no such clip' });
      res.writeHead(200, { 'content-type': name.endsWith('.jpg') ? 'image/jpeg' : `video/${path.extname(name).slice(1)}`, 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }
    if (url.pathname === '/api/verdict' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      const { addVerdict } = await import('../harness/verdict.mjs');
      const build = String(body.build || '').replace(/[^\w.-]/g, '').slice(0, 40);
      const r = await addVerdict({ by, fun: String(body.fun || ''), build: build && build !== 'latest' ? build : null, note: String(body.note || '').slice(0, 1000), viaWarRoom: true });
      broadcastSnapshot();
      return sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, verdict: r.verdict, next: r.verdict.fun === 'yes' ? `Recorded: build ${r.verdict.build} is fun${r.verdict.phase ? `. Phase ${r.verdict.phase} can close once its exit checklist is ticked and the Director says it's ready` : ''}.` : `Recorded: not fun yet. It's in the Producer's inbox${r.verdict.note ? ' with your note' : ''}.` } : { ok: false, error: r.message });
    }
    if (url.pathname === '/api/playnote' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      const text = String(body.text || '').trim().slice(0, 2000);
      if (!text) return sendJson(res, 400, { ok: false, error: 'Write the note first.' });
      const build = String(body.build || '').replace(/[^\w.-]/g, '').slice(0, 40) || 'no build';
      const notes = path.join(REPO_ROOT, 'studio', 'playtest', 'NOTES.md');
      fs.mkdirSync(path.dirname(notes), { recursive: true });
      if (!fs.existsSync(notes)) fs.writeFileSync(notes, '# Playtest notes\n\n> Written while playing the saved builds in the War Room\'s Arcade. Newest last.\n');
      fs.appendFileSync(notes, `\n- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${by} · build ${build} · ${body.kind || 'note'}: ${text.replace(/\n+/g, ' ')}\n`);
      let next;
      if (body.kind === 'bug') {
        const t = addTask({ title: `Bug: ${text.replace(/\s+/g, ' ')} (seen playing build ${build})`.slice(0, 180), role: 'builder', priority: 'P1', agent: by, meta: { playtest: build } });
        next = t.id ? `${t.id} queued for a builder. ${wake('builder', { task: t.id, why: `a bug ${by} found playing` }).next}` : t.message;
      } else if (body.kind === 'idea') {
        const r = addIdea({ title: text.slice(0, 160), detail: `From playing build ${build}`, by, source: 'dev-pitched' });
        const routed = r.ok ? routeIdea(r.idea.id, 'war-room') : null;
        next = r.ok ? `${r.idea.id} is on the Idea Board. ${routed?.ok ? wake('rnd', { task: routed.task, why: `idea ${r.idea.id}` }).next : ''}` : r.message;
      } else {
        const inbox = path.join(REPO_ROOT, 'studio', 'producer', 'INBOX.md');
        fs.mkdirSync(path.dirname(inbox), { recursive: true });
        if (!fs.existsSync(inbox)) fs.writeFileSync(inbox, '# Producer inbox\n\n> Messages from people in the War Room. The Producer reads new ones in its briefing (`npm run handoff`).\n\n');
        fs.appendFileSync(inbox, `- [${new Date().toISOString().slice(0, 16).replace('T', ' ')}] **${by}** (playing build ${build}): ${text.replace(/\n+/g, ' ')}\n`);
        emitEvent({ type: 'human.message', agent: by, to: 'producer', msg: `Playtest note (build ${build}): ${text.slice(0, 260)}` });
        next = `In the Producer's inbox and studio/playtest/NOTES.md. ${wake('producer', { why: `a playtest note from ${by}` }).next}`;
      }
      broadcastSnapshot();
      return sendJson(res, 200, { ok: true, next });
    }
    if (url.pathname === '/api/golden' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      const sha = String(body.sha || '').replace(/[^0-9a-f]/g, '').slice(0, 40);
      if (!sha) return sendJson(res, 400, { ok: false, error: 'which commit?' });
      const file = path.join(REPO_ROOT, 'studio', 'decisions', 'golden-approvals.json');
      let j = { approved: [] };
      try {
        j = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // first one
      }
      j.approved.push({ sha, by, at: new Date().toISOString() });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
      emitEvent({ type: 'golden.approved', agent: by, to: 'producer', msg: `${by} checked the golden change in ${sha}: looks right` });
      broadcastSnapshot();
      return sendJson(res, 200, { ok: true, next: `Golden change ${sha} marked as checked by ${by}.` });
    }
    // Throw it all away and restart: step 1 hands out a ticket, step 2 (the second warning) spends it.
    if (url.pathname === '/api/restart' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      const { restartTicket, restartStudio } = await import('../harness/restart.mjs');
      if (Number(body.step) === 1) {
        const t = restartTicket(by);
        return sendJson(res, 200, { ok: true, ticket: t.id, plan: t.plan });
      }
      if (Number(body.step) === 2) {
        const r = await restartStudio({ by, ticket: String(body.ticket || '') });
        broadcastSnapshot();
        return sendJson(res, r.ok ? 200 : 400, r.ok ? r : { ok: false, error: r.message });
      }
      return sendJson(res, 400, { ok: false, error: 'step must be 1 or 2' });
    }
    // "Fixed it: try again" on a halted supervisor: it starts agents again on its next pass.
    if (url.pathname === '/api/supervisor' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      if (body.action !== 'resume') return sendJson(res, 400, { ok: false, error: 'action must be resume' });
      fs.mkdirSync(path.join(REPO_ROOT, '.studio'), { recursive: true });
      fs.writeFileSync(path.join(REPO_ROOT, '.studio', 'supervisor-resume'), by);
      emitEvent({ type: 'supervisor.resume_asked', agent: by, to: 'supervisor', msg: `${by} asked the supervisor to try again` });
      broadcastSnapshot();
      return sendJson(res, 200, { ok: true, next: 'The supervisor tries again on its next pass (within a minute).' });
    }
    if (url.pathname === '/api/causes' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      const r = await acceptCause(String(body.cause || ''), { by, why: String(body.why || 'accepted in the War Room').slice(0, 300) });
      broadcastSnapshot();
      return sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, ...r, next: `Accepted for this run: ${r.tasks.length} forced task(s) stay done${r.closed.length ? `, ${r.closed.join(', ')} closed` : ''}. Later tasks forced for the same reason won't ask again; a different reason will.` } : { ok: false, error: r.message });
    }
    if (url.pathname === '/api/divisions' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      const r = setDivision(String(body.id || ''), body.on !== false, by);
      broadcastSnapshot();
      return sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, next: `${r.division.name} is ${r.division.active ? 'on' : 'off'} (studio/divisions.json).` } : { ok: false, error: r.message });
    }
    if (url.pathname === '/api/stop' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      if (body.stop === false) clearStop(by);
      else {
        setStop(by, body.reason);
        stopAllAgents(by, String(body.reason || ''));
      }
      broadcastSnapshot();
      return sendJson(res, 200, { ok: true, stopped: readStop() });
    }
    // 2.29.2: the game dev accepts top-tier models on every role (a warning, never a block).
    if (url.pathname === '/api/model-warning' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      const r = acceptModelWarning(by);
      broadcastSnapshot();
      return sendJson(res, 200, { ok: true, accepted: r.accepted, next: 'Accepted. The warning comes back if the models change.' });
    }
    // 2.29.2: a refresh check from the War Room: let the agent continue, or have it hand off now.
    if (url.pathname === '/api/session-check' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      const agent = String(body.agent || '');
      const r = recordCheck(agent, String(body.decision || ''), { by, note: String(body.note || '').slice(0, 300) });
      if (!r.ok) return sendJson(res, 400, { ok: false, error: r.message });
      const h = body.decision === 'handoff' ? await endForRefresh(agent, by) : null;
      broadcastSnapshot();
      return sendJson(res, 200, { ok: true, next: body.decision === 'handoff' ? (h?.ok ? `${agent} hands off now; a fresh session continues its task.` : `Recorded; ${h?.message || ''}`) : `${agent} continues; next check in 20 turns / 40k tokens.` });
    }
    // 2.30: the dev's one-click answers. Intent card (J2), yes to an agent's mechanic (J2), do it now (J3), watchdog (G1).
    if (url.pathname === '/api/intent-confirm' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      const { confirmEcho } = await import('../harness/intent.mjs');
      const r = confirmEcho(String(body.id || '').replace(/[^\w-]/g, ''), by, { viaWarRoom: true });
      broadcastSnapshot();
      return sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, next: `Confirmed: ${r.echo.asked}` } : { ok: false, error: r.message });
    }
    if (url.pathname === '/api/task-yes' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      const id = String(body.task || '');
      if (!/^[A-Z]+-\d+$/.test(id)) return sendJson(res, 400, { ok: false, error: 'Which task?' });
      const { devSays } = await import('../harness/intent.mjs');
      const { setHold } = await import('../harness/task-hold.mjs');
      const who = devSays(by, { viaWarRoom: true });
      if (!who.ok) return sendJson(res, 400, { ok: false, error: who.message });
      setHold(id, { needsYes: null }, { by, msg: `${by} said yes to ${id} (War Room)` });
      emitEvent({ type: 'task.dev_yes', agent: by, task: id, msg: `${by} said yes to ${id} in the War Room` });
      broadcastSnapshot();
      return sendJson(res, 200, { ok: true, next: `${id} can start.` });
    }
    if (url.pathname === '/api/phase-now' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      const { readBible, openPhaseNow } = await import('../harness/bible.mjs');
      const r = await openPhaseNow(readBible(), Number(body.phase), { by, words: String(body.words || '').slice(0, 300), viaWarRoom: true });
      broadcastSnapshot();
      return sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, risk: r.risk, next: `Phase ${body.phase} is open now.${r.risk.length ? ` Risk logged: ${r.risk.join('; ')}.` : ''}` } : { ok: false, error: r.message });
    }
    if (url.pathname === '/api/watchdog' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      noteHuman(by);
      const { setWatchdog } = await import('../harness/watchdog.mjs');
      const r = setWatchdog(body.on === true, by);
      broadcastSnapshot();
      return sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, next: `Watchdog ${r.watchdog.on ? 'on' : 'off'}.` } : { ok: false, error: r.message });
    }
    if (url.pathname === '/api/data-consent' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      if (body.shown && body.share === undefined) {
        markShown(by);
        return sendJson(res, 200, { ok: true, consent: readConsent(), text: describeConsent() });
      }
      const r = setConsent(body.share !== false, by);
      return sendJson(res, r.ok ? 200 : 400, { ...r, text: describeConsent() });
    }
    if (url.pathname === '/api/followups' && req.method === 'POST') {
      const body = await readBody(req);
      const b = readBible();
      if (!b) return sendJson(res, 400, { ok: false, error: 'No Game Bible yet: run the intake first.' });
      let saved = 0;
      for (const [k, v] of Object.entries(body.answers || {})) if (typeof v === 'string' && v.trim() && answerFollowup(b, k, v.slice(0, 2000), String(body.by || 'war-room-human').slice(0, 60))) saved += 1;
      writeBible(b);
      const left = pendingFollowups(b).length;
      const w = saved ? wake('director', { why: `${saved} new answer(s) in the Bible` }) : { next: '' };
      return sendJson(res, 200, { ok: true, saved, left, started: w.agent || null, next: `${saved} answer(s) saved in the Game Bible${left ? `, ${left} question(s) left` : ''}. ${w.next}`.trim() });
    }
    if (url.pathname === '/api/bible/sign' && req.method === 'POST') {
      const body = await readBody(req);
      const b = readBible();
      if (!b) return sendJson(res, 400, { ok: false, error: 'No Game Bible yet: run the intake first.' });
      const r = signBible(b, String(body.by || '').slice(0, 60));
      broadcastSnapshot();
      return sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { ok: false, error: r.message || 'not ready', missing: r.missing });
    }
    if (url.pathname === '/api/inbox' && req.method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || 'war-room-human').slice(0, 60);
      const msg = String(body.msg || '').trim().slice(0, 2000);
      if (!msg) return sendJson(res, 400, { ok: false, error: 'empty message' });
      noteHuman(by);
      const inbox = path.join(REPO_ROOT, 'studio', 'producer', 'INBOX.md');
      fs.mkdirSync(path.dirname(inbox), { recursive: true });
      if (!fs.existsSync(inbox)) fs.writeFileSync(inbox, '# Producer inbox\n\n> Messages from people in the War Room. The Producer reads new ones in its briefing (`npm run handoff`).\n\n');
      fs.appendFileSync(inbox, `- [${new Date().toISOString().slice(0, 16).replace('T', ' ')}] **${by}**: ${msg.replace(/\n+/g, ' ')}\n`);
      emitEvent({ type: 'human.message', agent: by, to: 'producer', msg: msg.slice(0, 300) });
      const w = wake('producer', { why: `a message from ${by}` });
      broadcastSnapshot();
      return sendJson(res, 201, { ok: true, started: w.agent || null, next: `In the Producer's inbox. ${w.next}` });
    }

    if (url.pathname === '/api/brief' && req.method === 'POST') {
      const briefRes = buildPreparedBrief();
      broadcastSnapshot();
      return sendJson(res, 200, { ok: true, ...briefRes });
    }

    if (url.pathname === '/api/watch' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true, ...watchPass() });
    }

    if (url.pathname === '/api/agent' && req.method === 'GET') {
      const detail = buildAgentDetail(String(url.searchParams.get('name') || ''));
      return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'no such agent' });
    }

    if (url.pathname === '/api/hud' && req.method === 'GET') {
      return sendJson(res, 200, buildHudState());
    }

    // The War Room v3 is the home page. The old React War Room is retired to /legacy for one release.
    if ((url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/v3' || url.pathname === '/v3/') && req.method === 'GET') {
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
      noteHuman(body.agent || 'war-room-human');
      let result = null;
      if (body.action === 'start' && body.id) {
        result = startTask(body.id, body.agent || 'war-room-human');
      } else if (body.action === 'done' && body.id) {
        // A person with the HUB token may close any task; the lock is released either way.
        result = completeTask(body.id, body.note || 'Marked done from the War Room', body.agent || 'war-room-human', { force: true });
      } else if (body.action === 'pause' && body.id) {
        result = pauseTask(body.id, body.agent || 'war-room-human', body.note || 'Handed back from the War Room', { force: true });
      } else if (body.action === 'reopen' && body.id) {
        result = reopenTask(body.id, body.note || 'Reopened from the War Room', body.agent || 'war-room-human');
      } else if (body.action === 'add' && body.title) {
        const types = { bug: 'Bug', study: 'Study', balance: 'Balance', fun: 'Fun', playtest: 'Playtest', review: 'Review', docs: 'Docs', system: 'System' };
        const prefix = types[body.type] && !String(body.title).toLowerCase().startsWith(body.type) ? `${types[body.type]}: ` : '';
        const size = Number(body.size);
        result = addTask({
          title: `${prefix}${String(body.title).slice(0, 200)}`,
          role: body.role || 'builder',
          priority: /^P[0-3]$/.test(body.priority) ? body.priority : 'P1',
          agent: body.agent || 'war-room-human',
          meta: {
            ...(size >= 1 && size <= 5 ? { size } : {}),
            ...(/^T-\d+$/.test(body.causedBy || '') ? { causedBy: body.causedBy } : {}),
            ...([1, 2, 3].includes(Number(body.phase)) ? { phase: Number(body.phase) } : {}),
            ...(/^(pillar|layer):/.test(body.serves || '') ? { serves: String(body.serves).slice(0, 80) } : {}),
            ...(/^I-\d+$/.test(body.idea || '') ? { idea: body.idea } : {}),
            ...(body.prototype ? { prototype: true } : {}),
          },
        });
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
      noteHuman(body.agent || 'war-room-human');
      const kind = body.kind === 'fun' ? 'fun' : 'balance';
      const dir = path.join(REPO_ROOT, 'studio', kind);
      fs.mkdirSync(dir, { recursive: true });
      const name = `${kind === 'fun' ? 'review' : 'decision'}-${new Date().toISOString().slice(0, 10)}.md`;
      const file = path.join(dir, name);
      const text = `# ${kind} decision\n\n${String(body.note || '').slice(0, 2000)}\n\n- by: human\n- at: ${new Date().toISOString()}\n`;
      fs.writeFileSync(file, text);
      return sendJson(res, 200, { ok: true, file: `studio/${kind}/${name}` });
    }

    if (url.pathname === '/legacy' || url.pathname === '/legacy/') {
      const builtHtml = path.join(__dirname, 'dist', 'index.html');
      const fallbackHtml = path.join(__dirname, 'index.html');
      const targetHtml = fs.existsSync(builtHtml) ? builtHtml : fallbackHtml;
      const notice = '<div style="position:fixed;z-index:2147483647;left:0;right:0;top:0;padding:8px 14px;background:#ffd54f;color:#2b1d14;font:14px system-ui">This War Room is retired and will be removed in the next release. The new one is at <a href="/">/</a>.</div>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(targetHtml, 'utf8').replace(/<body([^>]*)>/i, (m) => `${m}${notice}`));
    }

    // A bundled game (vite's default base '/') asks for /assets/index-…js at the root, not under
    // /play/<id>/: those requests come from the build last opened in the Arcade, so serve them from it.
    // Without this a dist build plays in npm run play:browser and shows a black screen in the Arcade.
    if (req.method === 'GET' && lastPlayed && Date.now() - lastPlayed.at < 12 * 3600000 && !url.pathname.startsWith('/api/') && serveBuildFile(lastPlayed.id, url.pathname.slice(1), res)) return;
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
    // The token is printed in the link so a person can open it and use the buttons straight away (it
    // leaves the address bar on load and stays in that tab). It is in .env on this machine anyway.
    console.log(` War Room                      : http://localhost:${PORT}/${hubToken() ? `?token=${hubToken()}  (open this link: the buttons work in that tab)` : ' (read-only: set HUB_TOKEN in .env to use the buttons)'}`);
    console.log(` Studio view                   : http://localhost:${PORT}/?skin=tycoon`);
    console.log(` Retired War Room (one release): http://localhost:${PORT}/legacy`);
    console.log(` WebSocket Terminal & Stream   : ws://localhost:${PORT}/ws`);
    console.log(` Events Ledger                 : ${path.relative(REPO_ROOT, eventsFile)}`);
    console.log(` Subscription Usage File       : ${path.relative(REPO_ROOT, USAGE_FILE)}`);
    console.log(` War Room Config File          : ${path.relative(REPO_ROOT, WAR_ROOM_CONFIG_FILE)}`);
    console.log(` LLM Token Cost                : 0% (Passive local WebSocket + SSE)`);
    console.log(` Watcher                       : ${WATCH_EVERY > 0 ? `every ${WATCH_EVERY}s (STUDIO_WATCH_INTERVAL=0 turns it off)` : 'off'}`);
    console.log('====================================================================');
  });
  // While the HUB is up, the watcher runs on its own: a script pass, no model, no tokens.
  const WATCH_EVERY = Number(process.env.STUDIO_WATCH_INTERVAL ?? 300);
  if (WATCH_EVERY > 0) {
    const pass = () => {
      try {
        const r = watchPass();
        if (r.findings.length) console.log(`[watch] ${r.findings.map((f) => f.msg).join(' | ')}`);
        const retro = retroIfDue();
        if (retro) console.log(`[retro] wrote ${retro.file}: ${retro.suggestions.length} suggestion(s)`);
        const learned = learnIfDue();
        if (learned) console.log(`[learn] rewrote ${learned.file}${learned.backup ? `; backed up to ${learned.backup}` : ''}`);
        const report = runReportIfDue();
        if (report?.ok) console.log(`[run-report] updated ${report.dest}`);
        const dir = dailyPingIfDue();
        if (dir) console.log(`[director] daily ping: ${dir.task}${dir.start?.started ? ' (Director started)' : ''}`);
      } catch (err) {
        console.error(`[watch] ${err.message}`);
      }
    };
    setTimeout(pass, 5000).unref();
    setInterval(pass, WATCH_EVERY * 1000).unref();
  }
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  startHubCli();
}
