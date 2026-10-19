#!/usr/bin/env node
/**
 * hub/server.mjs — Zero-Token Passive Workflow UI HUB Server
 *
 * Serves the 4-Quadrant React Flow Mission Control War Room (`hub/WarRoom.tsx`
 * / `hub/dist/index.html` or standalone `hub/index.html`) and streams:
 *   - `.studio/events.jsonl` (`/events`, `/api/state`, `/api/stream`)
 *   - `.studio/usage.json` (`/usage`, `/api/usage`)
 *   - `studio/NEXT.md` (`/api/task`)
 *   - Latest QA screenshot (`/api/latest-screenshot`)
 *
 * Uses 0% LLM tokens. Safe to leave open on a second monitor for YouTube
 * devlogs or access remotely from a phone via Tailscale / Cloudflare Tunnel.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStudioSnapshot, readSubscriptionUsage, USAGE_FILE } from '../harness/status.mjs';
import { emitEvent, getEventPaths, REPO_ROOT } from '../harness/event.mjs';
import { startTask, completeTask, addTask, NEXT_FILE } from '../harness/task.mjs';
import { loadDotEnv } from '../harness/route.mjs';

loadDotEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.HUB_PORT || 3847);
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

for (const watchTarget of [eventsFile, NEXT_FILE, USAGE_FILE]) {
  try {
    if (fs.existsSync(watchTarget)) {
      fs.watch(watchTarget, { persistent: false }, () => broadcastSnapshot());
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

    if ((url.pathname === '/usage' || url.pathname === '/api/usage') && req.method === 'GET') {
      return sendJson(res, 200, readSubscriptionUsage());
    }

    if (url.pathname === '/events' && req.method === 'GET') {
      const raw = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '';
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(raw);
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
      const builtHtml = path.join(__dirname, 'dist', 'index.html');
      const fallbackHtml = path.join(__dirname, 'index.html');
      const targetHtml = fs.existsSync(builtHtml) ? builtHtml : fallbackHtml;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(targetHtml, 'utf8'));
    }

    sendJson(res, 404, { error: 'Not found', path: url.pathname });
  });
}

export function startHubCli() {
  const server = createHubServer();
  server.listen(PORT, HOST, () => {
    console.log('====================================================================');
    console.log(' 3D DEEP-SIM WORKFLOW UI HUB — ZERO-TOKEN MISSION CONTROL HQ');
    console.log('====================================================================');
    console.log(` Desktop War Room (4-Quadrant) : http://localhost:${PORT}`);
    console.log(` Mobile Command Feed           : http://localhost:${PORT}/?view=mobile`);
    console.log(` Events Ledger                 : ${path.relative(REPO_ROOT, eventsFile)}`);
    console.log(` Subscription Usage File       : ${path.relative(REPO_ROOT, USAGE_FILE)}`);
    console.log(` LLM Token Cost                : 0% (Passive local SSE stream)`);
    console.log('====================================================================');
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  startHubCli();
}
