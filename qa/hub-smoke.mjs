#!/usr/bin/env node
/**
 * qa/hub-smoke.mjs — start the real HUB and prove its security rules hold.
 *
 * Loopback bind: writes need the token header, the WebSocket needs the token and a same-origin page,
 * a foreign Host header is refused (DNS rebinding), placeholder tokens never authorize.
 * Remote bind: refused without a strong token; with one, reads need the token too.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-smoke-'));
const strong = crypto.randomBytes(24).toString('hex');
let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`[hub-smoke] ${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` ${detail}`}`);
  if (!ok) failed += 1;
};

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function startHub(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'hub', 'server.mjs')], {
    cwd: root,
    env: { ...process.env, HUB_PORT: String(port), AGENT_EVENTS_FILE: path.join(tmp, `events-${port}.jsonl`), HUB_ALLOWED_HOSTS: '', STUDIO_WATCH_INTERVAL: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  for (let i = 0; i < 50; i++) {
    const up = await request(port, { path: '/health', headers: { 'x-hub-token': env.HUB_TOKEN || '' } }).catch(() => null);
    if (up) return { port, child, output: () => output, exited };
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { port, child, output: () => output, exited, down: true };
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function upgrade(port, { query = '', headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: `/ws${query}`,
      headers: { host: `127.0.0.1:${port}`, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), ...headers },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('response', (res) => resolve(res.statusCode));
    req.on('error', () => resolve(0));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(0);
    });
    req.end();
  });
}

const json = JSON.stringify({ type: 'hub.smoke', msg: 'smoke' });
const post = { 'content-type': 'application/json' };

// 1. Loopback with a strong token
const a = await startHub({ HUB_HOST: '127.0.0.1', HUB_TOKEN: strong });
if (a.down) {
  check('hub starts on 127.0.0.1', false, a.output());
} else {
  check('read on loopback without token', (await request(a.port, { path: '/api/state' })) === 200);
  check('write without token is refused', (await request(a.port, { method: 'POST', path: '/api/events', headers: post, body: json })) === 401);
  check('write with token header is accepted', (await request(a.port, { method: 'POST', path: '/api/events', headers: { ...post, 'x-hub-token': strong }, body: json })) === 201);
  check('write with token only in query is refused', (await request(a.port, { method: 'POST', path: `/api/events?token=${strong}`, headers: post, body: json })) === 401);
  check('foreign Host header is refused (DNS rebinding)', (await request(a.port, { path: '/api/state', headers: { host: 'evil.example.com' } })) === 403);
  check('GET /api/brief does not write', (await request(a.port, { path: '/api/brief' })) === 404);
  check('websocket without token is refused', (await upgrade(a.port)) === 401);
  check('websocket with token is accepted', (await upgrade(a.port, { query: `?token=${strong}` })) === 101);
  check('websocket from a foreign origin is refused', (await upgrade(a.port, { query: `?token=${strong}`, headers: { origin: 'https://evil.example.com' } })) === 403);
  a.child.kill();
}

// 2. Placeholder token never authorizes
const b = await startHub({ HUB_HOST: '127.0.0.1', HUB_TOKEN: 'change-me-local-only' });
check('placeholder token cannot write', (await request(b.port, { method: 'POST', path: '/api/events', headers: { ...post, 'x-hub-token': 'change-me-local-only' }, body: json })) === 401);
b.child.kill();

// 3. Remote bind without a strong token is refused at startup
const c = await startHub({ HUB_HOST: '0.0.0.0', HUB_TOKEN: '' });
const code = await Promise.race([c.exited, new Promise((r) => setTimeout(() => r('still running'), 3000))]);
check('0.0.0.0 without a strong token refuses to start', code !== 'still running' && code !== 0 && /REFUSED/.test(c.output()), `exit=${code}`);
if (code === 'still running') c.child.kill();

// 4. Remote bind with a strong token: reads need it too
const d = await startHub({ HUB_HOST: '0.0.0.0', HUB_TOKEN: strong });
if (!d.down) {
  check('remote bind: read without token is refused', (await request(d.port, { path: '/api/state' })) === 401);
  check('remote bind: read with token is accepted', (await request(d.port, { path: `/api/state?token=${strong}` })) === 200);
  d.child.kill();
} else {
  check('hub starts on 0.0.0.0 with a strong token', false, d.output());
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) process.exit(1);
console.log('[hub-smoke] ok');
