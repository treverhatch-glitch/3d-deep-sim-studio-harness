#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';

const port = 3947;
const child = spawn('node', ['hub/server.mjs'], {
  env: { ...process.env, HUB_PORT: String(port), HUB_HOST: '127.0.0.1', HUB_TOKEN: 'x'.repeat(32) },
  stdio: 'ignore',
});
function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: pathname }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
}
await new Promise((r) => setTimeout(r, 400));
try {
  const health = await get('/health').catch(() => 0);
  const human = await get('/human').catch(() => 0);
  if (![200, 404].includes(health) && human !== 200) {
    console.error(`[hub-smoke] FAIL health=${health} human=${human}`);
    process.exitCode = 1;
  } else {
    console.log(`[hub-smoke] ok health=${health} human=${human}`);
  }
} finally {
  child.kill();
}
if (process.exitCode) process.exit(process.exitCode);
