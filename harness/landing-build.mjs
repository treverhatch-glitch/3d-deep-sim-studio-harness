#!/usr/bin/env node
/**
 * harness/landing-build.mjs — a playable build and a short clip after each landing. After a merge train lands, ONE
 * low-priority `build-clip` job saves landed main as a playable build (harness/builds.mjs snapshotBuild, what
 * `npm run play` serves), records a clip (qa/clip.mjs), and emits build.snapshot and clip.recorded.
 *   node harness/landing-build.mjs run      the worker (started by the train; runs the queued job, then exits)
 *   node harness/landing-build.mjs status   what is queued or running, and the latest build and clip
 * It never blocks the train: it writes one file and starts a detached worker. At most one job is queued
 * (.studio/landing-build/pending.json); a newer landing replaces it. Takes machine:heavy as kind build-clip. An adopted
 * game is built from its "tester" { build, dist }. Skipped when the game has no browser build, and with
 * STUDIO_LANDING_BUILD=off. Settings: STUDIO_BROWSER_GPU, STUDIO_LANDING_CLIP_SECONDS (15), STUDIO_LANDING_CLIP_CMD,
 * STUDIO_LANDING_CLIP_TIMEOUT_MIN.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson } from './fsafe.mjs';
import { isOffRaw as off, numBlankDefault as num } from './helpers.mjs';

export const lbDir = (root) => path.join(root, '.studio', 'landing-build');
const pendingFile = (root) => path.join(lbDir(root), 'pending.json');
const workerFile = (root) => path.join(lbDir(root), 'worker.json');
export const landingBuildOff = (env = process.env) => off(env.STUDIO_LANDING_BUILD);

/** The game's browser build: { ok, why, name }. ok false: nothing to build (no browser build, template, no game). */
export async function gameBrowserBuild(root, { env = process.env } = {}) {
  try {
    // 2.80 (d, N3): a studio that adopted a game of its own builds what the game declares (studio/game.json "tester", the
    // config the tester reads), not the template cartridge's page; no declared build is said so.
    const sg = env.STUDIO_CARTRIDGE ? null : (await import('./tester-config.mjs')).studioGameSync(root);
    if (sg) {
      const t = (await import('./tester-config.mjs')).gameTesterConfig(root);
      if (!t?.dist) return { ok: false, why: `${sg.name} declares no build to snapshot (studio/game.json "tester": { "build", "dist" })`, name: sg.name };
      return { ok: true, why: '', name: sg.name, cart: { name: sg.name, browser: { dist: t.dist, build: t.build, distPage: t.page } } };
    }
    const c = await import('./cartridge.mjs');
    const name = env.STUDIO_CARTRIDGE || c.defaultCartridgeName();
    if (!name) return { ok: false, why: 'no game cartridge' };
    if (c.isTemplateCartridge(name)) return { ok: false, why: `the game is the template cartridge (${name})`, name };
    const cart = await c.loadCartridge(name);
    const b = cart.browser || {};
    if (!b.page && !b.dist) return { ok: false, why: `cartridges/${name}/qa.mjs declares no browser build (browser.page or browser.dist)`, name };
    return { ok: true, why: '', name, cart };
  } catch (e) { return { ok: false, why: `the game's cartridge didn't load (${String(e.message || e).split('\n')[0].slice(0, 160)})` }; }
}

async function workerAlive(root) {
  const w = readJson(workerFile(root));
  if (!w?.pid) return null;
  try { const { pidAlive } = await import('./proc-identity.mjs'); return pidAlive(w.pid, w.identity) ? w : null; } catch { return null; }
}

/** Start the worker detached at below-normal priority (it outlives the train's process). Returns its pid or null. */
export function spawnWorker(root, { env = process.env } = {}) {
  const own = path.join(root, 'harness', 'landing-build.mjs');
  const script = fs.existsSync(own) ? own : fileURLToPath(import.meta.url);
  fs.mkdirSync(lbDir(root), { recursive: true });
  const out = fs.openSync(path.join(lbDir(root), 'worker.log'), 'a');
  const c = spawn(process.execPath, [script, 'run'], { cwd: root, detached: true, stdio: ['ignore', out, out], windowsHide: true, env: { ...env, STUDIO_GATE_PRIORITY: '', STUDIO_HEAVY_HELD: '' } });
  try { fs.closeSync(out); } catch {}
  try { os.setPriority(c.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  c.on('error', () => {});
  c.unref();
  return c.pid || null;
}

/**
 * Queue the playable build + clip for a landing: { queued, replaced?, worker?, skipped?, why, line }. Never throws.
 * opts.spawn replaces the worker start (tests).
 */
export async function queueLandingBuild({ root, train = null, tasks = [], head = null, env = process.env, log = () => {}, spawn: start = spawnWorker } = {}) {
  try {
    if (landingBuildOff(env)) return { queued: false, skipped: true, why: 'STUDIO_LANDING_BUILD=off', line: '' };
    // 2.82: a native-engine studio's playable build is the engine's (npm run engine:build), never the web build.
    { const ne = (await import('./native.mjs')).nativeEngine(root, env); if (ne) return { queued: false, skipped: true, why: `native ${ne}: the playable build is the engine's`, line: '' }; }
    const g = await gameBrowserBuild(root, { env });
    if (!g.ok) { const line = `playable build + clip skipped: ${g.why}`; log(line); return { queued: false, skipped: true, why: g.why, line }; }
    fs.mkdirSync(lbDir(root), { recursive: true });
    const prev = readJson(pendingFile(root));
    const all = [...new Set([...(prev?.tasks || []), ...tasks.map(String)])];
    const job = { train, trains: [...new Set([...(prev?.trains || (prev?.train ? [prev.train] : [])), train].filter(Boolean))], tasks: all, head, at: new Date().toISOString() };
    fs.writeFileSync(pendingFile(root), `${JSON.stringify(job, null, 2)}\n`);
    const running = await workerAlive(root);
    let pid = running?.pid || null;
    if (!running) pid = start(root, { env });
    const line = `playable build + clip queued for ${all.join(', ') || 'the landing'} (low priority, never holds the train${prev ? `; replaced the queued one for ${(prev.tasks || []).join(', ') || prev.train}` : ''}${running ? `; after the one running (pid ${running.pid})` : ''}; STUDIO_LANDING_BUILD=off turns it off)`;
    log(line);
    return { queued: true, replaced: Boolean(prev), worker: pid, why: '', line, tasks: all };
  } catch (e) {
    const line = `playable build + clip not queued: ${String(e.message || e).slice(0, 160)}`;
    try { log(line); } catch {}
    return { queued: false, why: line, line };
  }
}

/** Take the worker role (one at a time): true when this process holds it. */
async function takeWorker(root) {
  fs.mkdirSync(lbDir(root), { recursive: true });
  let identity = null;
  try { identity = (await import('./proc-identity.mjs')).selfIdentity(); } catch {}
  const rec = JSON.stringify({ pid: process.pid, identity, at: new Date().toISOString() });
  try { fs.writeFileSync(workerFile(root), rec, { flag: 'wx' }); return true; } catch (e) { if (e.code !== 'EEXIST') return false; }
  if (await workerAlive(root)) return false;
  try { fs.rmSync(workerFile(root), { force: true }); fs.writeFileSync(workerFile(root), rec, { flag: 'wx' }); return true; } catch { return false; }
}
const dropWorker = (root) => { try { if (readJson(workerFile(root))?.pid === process.pid) fs.rmSync(workerFile(root), { force: true }); } catch {} };

/** Take the queued job (atomically: renamed to running.json). null when none. */
function takeJob(root) {
  const run = path.join(lbDir(root), 'running.json');
  try { fs.renameSync(pendingFile(root), run); } catch { return null; }
  const j = readJson(run);
  return j || null;
}

/** The clip command: STUDIO_LANDING_CLIP_CMD or node qa/clip.mjs, with {seconds} and {name}. */
export function clipCommand(env, { seconds, name }) {
  const t = env.STUDIO_LANDING_CLIP_CMD;
  if (t && String(t).trim()) return String(t).replace(/\{seconds\}/g, String(seconds)).replace(/\{name\}/g, name);
  return `"${process.execPath}" qa/clip.mjs --seconds ${seconds} --name ${name}`;
}

/**
 * Run one queued job under machine:heavy (kind build-clip): snapshot, then clip; one event each. Returns
 * { ran, build, clip, busy? }. deps: { acquire, snapshot, emit } for tests.
 */
export async function runLandingJob(root, job, { env = process.env, log = (m) => console.error(m), deps = {} } = {}) {
  const ev = deps.emit || (await import('./event.mjs')).emitEvent;
  const meta = { train: job.train || null, trains: job.trains || [], tasks: job.tasks || [] };
  const who = `${(job.tasks || []).join(', ') || job.train || 'a landing'}`;
  const g = await gameBrowserBuild(root, { env });
  if (!g.ok) { log(`[landing-build] skipped: ${g.why}`); return { ran: false, why: g.why }; }
  let lk = null;
  try {
    const acquire = deps.acquire || (await import('./heavy.mjs')).acquireHeavy;
    lk = acquire(root, `landing build + clip (${who})`, { kind: 'build-clip', log: (m) => log(m), env: { ...env, STUDIO_GATE_PRIORITY: '' } });
  } catch (e) {
    if (e.code !== 'HEAVY_BUSY') throw e;
    ev({ type: 'build.snapshot', agent: 'landing-build', status: 'warn', msg: `No playable build for ${who}: machine:heavy stayed busy (${String(e.message).replace(/^\[heavy\]\s*/, '').slice(0, 160)}); the next landing tries again`, meta: { ...meta, ok: false, busy: true } });
    return { ran: false, busy: true };
  }
  const out = { ran: true, build: null, clip: null };
  try {
    let s;
    try { s = deps.snapshot ? await deps.snapshot(g.cart) : (await import('./builds.mjs')).snapshotBuild(g.cart, {}); } catch (e) { s = { ok: false, message: String(e.message || e) }; }
    out.build = s;
    const id = s?.build?.id || null;
    ev({ type: 'build.snapshot', agent: 'landing-build', status: s?.ok ? 'ok' : 'warn', msg: s?.ok ? `Playable build ${id}${s.unchanged ? ' (unchanged since the last one)' : ''} after landing ${who}: npm run play` : `No playable build after landing ${who}: ${String(s?.message || 'snapshot failed').slice(0, 200)}`, meta: { ...meta, ok: Boolean(s?.ok), build: id, unchanged: Boolean(s?.unchanged), head: job.head || s?.build?.sha || null } });
    log(`[landing-build] build: ${s?.ok ? id : `failed (${s?.message || '?'})`}`);
    const seconds = Math.max(1, num(env.STUDIO_LANDING_CLIP_SECONDS, 15));
    const name = `landing-${String(job.train || 'train').replace(/[^\w-]+/g, '-').slice(0, 40)}`;
    const cmd = clipCommand(env, { seconds, name });
    const r = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', timeout: Math.max(1, num(env.STUDIO_LANDING_CLIP_TIMEOUT_MIN, 10)) * 60000, env: { ...process.env, ...env, STUDIO_HEAVY_HELD: process.env.STUDIO_HEAVY_HELD || env.STUDIO_HEAVY_HELD || '1' }, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    const text = `${r.stdout || ''}${r.stderr || ''}`;
    const file = (text.match(/Saved (\S+?\.(?:mp4|webm|jpg|png|gif))/) || [])[1] || null;
    const ok = r.status === 0 && Boolean(file);
    out.clip = { ok, file, code: r.status, tail: text.trim().split('\n').slice(-3).join(' | ').slice(0, 300) };
    ev({ type: 'clip.recorded', agent: 'landing-build', status: ok ? 'ok' : 'warn', msg: ok ? `Clip of the landed build (${who}): ${file}` : `No clip after landing ${who}: ${r.error ? r.error.code || r.error.message : `exit ${r.status}`}${out.clip.tail ? ` (${out.clip.tail})` : ''}`, meta: { ...meta, ok, file, build: id } });
    log(`[landing-build] clip: ${ok ? file : `none (${out.clip.tail || r.status})`}`);
  } finally {
    try { lk?.release?.(); } catch {}
  }
  return out;
}

/** The worker: runs queued jobs until none is left, one at a time; another live worker means this one exits. */
export async function runLandingWorker({ root = process.cwd(), env = process.env, log = (m) => console.error(m), deps = {} } = {}) {
  try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  const done = [];
  for (let round = 0; round < 20; round += 1) {
    if (!(await takeWorker(root))) return { done, other: true };
    let job;
    while ((job = takeJob(root))) {
      try { done.push(await runLandingJob(root, job, { env, log, deps })); } catch (e) { log(`[landing-build] failed: ${String(e.message || e).slice(0, 200)}`); }
      try { fs.rmSync(path.join(lbDir(root), 'running.json'), { force: true }); } catch {}
    }
    dropWorker(root);
    // A landing queued between the last look and letting go: take it too (else it would wait for the next landing).
    if (!fs.existsSync(pendingFile(root))) break;
  }
  return { done };
}

/** The latest landing build and clip in the events: { build, clip } (each the event, or null). */
export function latestLanding(events = [], { since = 0 } = {}) {
  let build = null;
  let clip = null;
  for (const e of events) {
    if ((Date.parse(e.ts) || 0) < since) continue;
    if (e.type === 'build.snapshot' && e.meta?.ok) build = e;
    if (e.type === 'clip.recorded' && e.meta?.ok) clip = e;
  }
  return { build, clip };
}
/** One short line (status --brief, the digest), or ''. */
export function landingLine(events = [], { since = 0, max = 3 } = {}) {
  const { build, clip } = latestLanding(events, { since });
  if (!build && !clip) return '';
  const tasks = (build || clip).meta?.tasks || [];
  const t = tasks.length ? ` (${tasks.slice(0, max).join(', ')}${tasks.length > max ? ` +${tasks.length - max}` : ''})` : '';
  return `Playable build ${build?.meta?.build || 'none'}${t}${clip?.meta?.file ? `; clip ${path.basename(clip.meta.file)}` : ''}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const cmd = process.argv[2];
  const root = process.cwd();
  if (cmd === 'run') {
    await runLandingWorker({ root });
    process.exit(0);
  }
  if (cmd === 'status' || !cmd) {
    const { readRecentEvents } = await import('./event.mjs');
    const p = readJson(pendingFile(root));
    const w = await workerAlive(root);
    const running = readJson(path.join(lbDir(root), 'running.json'));
    console.log([
      `Queued: ${p ? `${(p.tasks || []).join(', ') || p.train} (${p.at})` : 'none'}`,
      `Running: ${w && running ? `${(running.tasks || []).join(', ') || running.train} (pid ${w.pid})` : 'none'}`,
      `Latest: ${landingLine(readRecentEvents(20000)) || 'no landing build yet'}`,
      landingBuildOff() ? 'STUDIO_LANDING_BUILD=off: no build is queued after a landing.' : '',
    ].filter(Boolean).join('\n'));
    process.exit(0);
  }
  console.log('Usage: node harness/landing-build.mjs run | status');
  process.exit(2);
}
