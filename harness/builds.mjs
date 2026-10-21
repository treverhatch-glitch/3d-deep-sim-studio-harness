#!/usr/bin/env node
/**
 * harness/builds.mjs — the last good build of the game, saved so anyone can play it while agents work.
 *
 *   npm run play [-- --port 4610] [--lan] [--build <id>]   serve the last build that passed the browser check
 *   npm run play -- list                                     the saved builds, newest first
 *   npm run play -- snapshot                                 save the current build now (after a pass)
 *
 * A dev server shows agents' half-finished edits. Instead, every time the browser play gate passes
 * (`npm run play:browser`), the build it played is copied to .studio/builds/<id>/ with what it did
 * (outcome, tick, commit). `npm run play` serves the newest one on a fixed port; --lan opens it to
 * phones on the same Wi-Fi. The War Room's Arcade view plays it in the page. The last 6 are kept.
 *
 * What a build is comes from the cartridge's `browser` contract (qa.mjs):
 *   { page: 'web/<game>/index.html' }                     the page's folder, cartridges/<game>/, assets/approved/
 *   { dist: 'game/<game>/dist', build: 'npm run build' }  a bundled game: run the build, copy dist/
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';

export const BUILDS_DIR = path.join(STUDIO_STATE_DIR, 'builds');
const KEEP = 6;
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2' };

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
export function listBuilds() {
  if (!fs.existsSync(BUILDS_DIR)) return [];
  return fs.readdirSync(BUILDS_DIR).map((id) => readJson(path.join(BUILDS_DIR, id, 'build.json'))).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at));
}
export const latestBuild = () => listBuilds()[0] || null;

function copyTree(src, dest, files) {
  if (!fs.existsSync(src)) return;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(s, d, files);
    else {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      files.push(d);
    }
  }
}
const hashFiles = (files, base) => {
  const h = crypto.createHash('sha256');
  for (const f of files.slice().sort()) h.update(path.relative(base, f)).update(fs.readFileSync(f));
  return h.digest('hex').slice(0, 12);
};

/** Save the build the browser gate just played. Skips when nothing changed since the last saved one. */
export function snapshotBuild(cart, report = {}) {
  const b = cart.browser || {};
  const sha = (spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout || '').trim() || null;
  const dirty = Boolean((spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout || '').trim());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'));
  const files = [];
  let page;
  if (b.dist) {
    if (b.build) spawnSync(b.build, { cwd: REPO_ROOT, shell: true, stdio: 'ignore' });
    copyTree(path.join(REPO_ROOT, b.dist), tmp, files);
    page = b.distPage || 'index.html';
  } else if (b.page) {
    for (const part of [path.dirname(b.page), `cartridges/${cart.name}`, 'assets/approved', 'public']) copyTree(path.join(REPO_ROOT, part), path.join(tmp, part), files);
    page = b.page;
  } else {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: false, message: `cartridges/${cart.name}/qa.mjs has no browser build to save (browser.page or browser.dist)` };
  }
  if (!files.length) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: false, message: 'Nothing to save: the build folder is empty.' };
  }
  const content = hashFiles(files, tmp);
  const last = latestBuild();
  if (last && last.content === content) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: true, build: last, unchanged: true };
  }
  const id = `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${sha || content.slice(0, 7)}`;
  const dest = path.join(BUILDS_DIR, id);
  fs.mkdirSync(BUILDS_DIR, { recursive: true });
  fs.cpSync(tmp, dest, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  const build = { id, at: new Date().toISOString(), sha, dirty, content, cartridge: cart.name, page, query: b.playQuery || '', outcome: report.outcome || null, ticks: report.ticks ?? null, files: files.length };
  fs.writeFileSync(path.join(dest, 'build.json'), `${JSON.stringify(build, null, 2)}\n`);
  for (const old of listBuilds().slice(KEEP)) fs.rmSync(path.join(BUILDS_DIR, old.id), { recursive: true, force: true });
  emitEvent({ type: 'build.saved', agent: process.env.STUDIO_LOCK_OWNER || 'qa', msg: `Playable build ${id}${sha ? ` (${sha}${dirty ? ' + uncommitted work' : ''})` : ''}: ${build.outcome || 'played'}${build.ticks != null ? ` at tick ${build.ticks}` : ''}` });
  return { ok: true, build };
}

/** Serve one saved build's files (also used by the HUB under /play/<id>/). Returns false when not found. */
export function serveBuildFile(id, rel, res) {
  const b = id === 'latest' ? latestBuild() : listBuilds().find((x) => x.id === id);
  if (!b) return false;
  const root = path.join(BUILDS_DIR, b.id);
  const file = path.resolve(root, decodeURIComponent(rel || b.page).replace(/^\/+/, ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  // The War Room plays builds in a sandboxed frame (no access to the War Room's token), whose module
  // scripts load cross-origin, so the files allow any origin. They are the game's own public files.
  res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(fs.readFileSync(file));
  return true;
}

const lanAddress = () => Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address || null;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  if (argv[0] === 'list') {
    const all = listBuilds();
    console.log(all.length ? all.map((b) => `${b.id}  ${b.at.slice(0, 16).replace('T', ' ')}  ${b.outcome || ''}${b.ticks != null ? ` at tick ${b.ticks}` : ''}${b.dirty ? '  (had uncommitted work)' : ''}`).join('\n') : 'No saved builds yet: one is saved each time npm run play:browser passes.');
    process.exit(0);
  }
  if (argv[0] === 'snapshot') {
    const { loadCartridge, cartridgeFromArgv } = await import('./cartridge.mjs');
    const r = snapshotBuild(await loadCartridge(cartridgeFromArgv(argv)));
    console.log(r.ok ? `${r.unchanged ? 'Unchanged since' : 'Saved'} ${r.build.id}` : r.message);
    process.exit(r.ok ? 0 : 1);
  }
  const want = flag('build') || 'latest';
  const b = want === 'latest' ? latestBuild() : listBuilds().find((x) => x.id === want);
  if (!b) {
    console.error('No playable build yet. One is saved each time the browser check passes: npm run play:browser');
    process.exit(1);
  }
  const port = Number(flag('port') || process.env.STUDIO_PLAY_PORT || 4610);
  const host = argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1';
  const srv = http.createServer((req, res) => {
    const rel = new URL(req.url, 'http://x').pathname.replace(/^\/+/, '');
    if (!serveBuildFile(b.id, rel || b.page, res)) {
      res.writeHead(rel ? 404 : 302, rel ? {} : { location: `/${b.page}${b.query ? `?${b.query}` : ''}` });
      res.end();
    }
  });
  srv.listen(port, host, () => {
    const lan = host === '0.0.0.0' ? lanAddress() : null;
    console.log(`Playing build ${b.id} (${b.outcome || 'played'}${b.ticks != null ? ` at tick ${b.ticks}` : ''}${b.sha ? `, commit ${b.sha}` : ''})`);
    console.log(`  On this computer: http://127.0.0.1:${port}/`);
    if (lan) console.log(`  On a phone on the same Wi-Fi: http://${lan}:${port}/`);
    else console.log('  For phones on the same Wi-Fi: npm run play -- --lan');
    console.log('Ctrl+C stops it. Older builds: npm run play -- list, then --build <id>.');
  });
}
