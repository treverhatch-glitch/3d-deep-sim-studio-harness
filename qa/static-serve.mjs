/**
 * qa/static-serve.mjs — 2.79 (t): one small static file server for the QA tools.
 *
 * `npm run shot` (qa/clip.mjs) serves the repo's web/, cartridges/, assets/ and public/ folders; the game tester's driver
 * (qa/tester-drive.mjs) serves a built game's dist folder. Both use this, so a bundled game's build is served the same way
 * as the template's page: a file under `root` (and matching `allow`, when given), a folder's index.html, 404 otherwise,
 * never a path outside `root`.
 *
 *   const s = await serveStatic({ root, allow: /^(web|public)\// });   // { server, port, url, close() }
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const TYPES = {
  '.html': 'text/html', '.htm': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.cjs': 'text/javascript', '.json': 'application/json', '.map': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.wasm': 'application/wasm', '.ktx2': 'image/ktx2',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain',
};

/** The file a request path names under root (a folder: its index.html), or null when it is outside root, not allowed or missing. */
export function resolveRequest(root, urlPath, { allow = null, index = 'index.html' } = {}) {
  let rel;
  try { rel = decodeURIComponent(new URL(urlPath, 'http://x').pathname).replace(/^\/+/, ''); } catch { return null; }
  if (allow && !allow.test(rel)) return null;
  const base = path.resolve(root);
  let file = path.resolve(base, rel);
  if (file !== base && !file.startsWith(base + path.sep)) return null;
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, index); } catch { return null; }
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

/** An http.Server (not listening yet) that serves root. */
export function staticServer({ root, allow = null, index = 'index.html' } = {}) {
  return http.createServer((req, res) => {
    const file = resolveRequest(root, req.url || '/', { allow, index });
    if (!file) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}

/** Serve root on 127.0.0.1 (port 0: any free one): { server, port, url, close }. */
export async function serveStatic({ root, allow = null, index = 'index.html', port = 0, host = '127.0.0.1' } = {}) {
  const server = staticServer({ root, allow, index });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const p = server.address().port;
  return { server, port: p, url: `http://${host}:${p}/`, close: () => new Promise((r) => server.close(() => r())) };
}
