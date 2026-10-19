#!/usr/bin/env node
/**
 * hub/server.mjs — Zero-Token Passive Workflow UI HUB Server
 *
 * Serves the 4-Quadrant Sci-Fi Mission Control War Room (`hub/WarRoom.tsx` +
 * `hub/index.html`) and streams `.studio/events.jsonl` + `studio/NEXT.md`
 * changes in real time over Server-Sent Events (`/api/stream`) and JSON REST
 * endpoints (`/api/state`, `/api/event`, `/api/task`).
 *
 * Uses 0% LLM tokens. Safe to leave open on a second monitor for YouTube
 * devlogs or access remotely from a phone via Tailscale / Cloudflare Tunnel.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStudioSnapshot } from '../harness/status.mjs';
import { emitEvent, getEventPaths, REPO_ROOT } from '../harness/event.mjs';
import { startTask, completeTask, addTask, NEXT_FILE } from '../harness/task.mjs';
import { loadDotEnv } from '../harness/route.mjs';

loadDotEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.HUB_PORT || 4177);
const HOST = process.env.HUB_HOST || '0.0.0.0';

const sseClients = new Set();

function broadcastSnapshot() {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(buildStudioSnapshot())}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Ensure `.studio/events.jsonl` exists and watch for changes
const { primary: eventsFile } = getEventPaths();
fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
if (!fs.existsSync(eventsFile)) {
  emitEvent({
    type: 'hub.boot',
    agent: 'producer',
    provider: 'vertex-gemini-pro',
    model: 'gemini-2.5-pro',
    tokensSaved: 4200,
    msg: 'Workflow UI HUB initialized (0% LLM token passive telemetry active)',
  });
}

for (const watchTarget of [eventsFile, NEXT_FILE]) {
  try {
    if (fs.existsSync(watchTarget)) {
      fs.watch(watchTarget, { persistent: false }, () => broadcastSnapshot());
    }
  } catch {
    // Polling fallback handled below
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
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
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

export function createHubServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, buildStudioSnapshot());
    }

    if (url.pathname === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${JSON.stringify(buildStudioSnapshot())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (url.pathname === '/api/event' && req.method === 'POST') {
      const body = await readBody(req);
      const evt = emitEvent(body);
      broadcastSnapshot();
      return sendJson(res, 201, { ok: true, event: evt });
    }

    if (url.pathname === '/api/task' && req.method === 'POST') {
      const body = await readBody(req);
      let result = null;
      if (body.action === 'start' && body.id) {
        result = startTask(body.id, body.agent || null);
      } else if (body.action === 'done' && body.id) {
        result = completeTask(body.id, body.note || 'Marked done from Workflow UI HUB');
      } else if (body.action === 'add' && body.title) {
        result = addTask({ title: body.title, role: body.role || 'builder', priority: body.priority || 'P1' });
      }
      broadcastSnapshot();
      return sendJson(res, 200, { ok: Boolean(result), result, snapshot: buildStudioSnapshot() });
    }

    if (url.pathname === '/WarRoom.tsx') {
      const tsxPath = path.join(__dirname, 'WarRoom.tsx');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(tsxPath, 'utf8'));
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const htmlPath = path.join(__dirname, 'index.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(htmlPath, 'utf8'));
    }

    sendJson(res, 404, { error: 'Not found', path: url.pathname });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const server = createHubServer();
  server.listen(PORT, HOST, () => {
    console.log('====================================================================');
    console.log(' 3D DEEP-SIM WORKFLOW UI HUB — ZERO-TOKEN MISSION CONTROL HQ');
    console.log('====================================================================');
    console.log(` Desktop War Room (4-Quadrant) : http://127.0.0.1:${PORT}`);
    console.log(` Mobile Command Feed           : http://127.0.0.1:${PORT}/?view=mobile`);
    console.log(` Events Ledger                 : ${ path.relative(REPO_ROOT, eventsFile) }`);
    console.log(` LLM Token Cost                : 0% (Passive local SSE stream)`);
    console.log('====================================================================');
  });
}
