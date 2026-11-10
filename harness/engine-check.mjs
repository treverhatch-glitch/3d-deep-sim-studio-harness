#!/usr/bin/env node
/**
 * harness/engine-check.mjs — 2.79 (e): the engine porter's own quick check.
 *
 *   npm run engine -- check [--engine unity] [--task <ID>] [--dir <folder>]
 *
 * Runs the engine config's "quickCheck" command (studio/game.json engines.<x>.quickCheck: e.g. a compile of the sim and
 * test assemblies without the editor) in the porter's lane copy (--dir, else .lanes/engine/<task>, else the current
 * folder), so a compile error shows up in the porter's session instead of at land time. One runs at a time per engine
 * on the machine (the lock .studio/locks/engine-check-<engine>.lock, named "engine-check:<engine>" inside); a second one
 * waits with a status line, up to STUDIO_ENGINE_CHECK_WAIT_MIN (20) minutes. `task done` runs it for an engine-porter
 * task when quickCheck is configured, and refuses on red.
 * Exit: 0 pass (or nothing configured: skipped), 1 red, 3 busy (the wait ran out).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mainRoot } from './worktree.mjs';
import { selfIdentity, pidAlive } from './proc-identity.mjs';
import { engineTarget, engineTask } from './engine-tracks.mjs';
import { readJson } from './fsafe.mjs';

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

export const checkLockFile = (root, engine) => path.join(root, '.studio', 'locks', `engine-check-${engine}.lock`);

/**
 * Hold the machine-wide lock "engine-check:<engine>" while fn runs. A holder that is gone (or older than
 * STUDIO_ENGINE_CHECK_STALE_MIN, 120) is taken over. { busy: holder } when the wait ran out.
 */
export function withEngineCheckLock(root, engine, fn, { waitMs = 20 * 60000, poll = 1000, log = () => {}, env = process.env } = {}) {
  const f = checkLockFile(root, engine);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const stale = num(env.STUDIO_ENGINE_CHECK_STALE_MIN, 120) * 60000;
  const deadline = Date.now() + waitMs;
  const t0 = Date.now();
  let told = 0;
  const rec = { name: `engine-check:${engine}`, pid: process.pid, identity: selfIdentity(), at: Date.now(), by: env.STUDIO_LOCK_OWNER || null };
  for (;;) {
    try { fs.writeFileSync(f, JSON.stringify(rec), { flag: 'wx' }); break; } catch (err) {
      if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      const h = readJson(f);
      if (!h) { try { if (Date.now() - fs.statSync(f).mtimeMs > 5000) fs.rmSync(f, { force: true }); } catch {} }
      else if (!h.pid || !pidAlive(h.pid, h.identity) || Date.now() - Number(h.at || 0) > stale) { try { fs.rmSync(f, { force: true }); } catch {} continue; }
      if (Date.now() >= deadline) return { busy: h || { why: 'unreadable lock' } };
      if (!told || Date.now() - told > 60000) { log(`[engine-check] waiting for ${h?.by || 'another porter'}'s ${engine} check (pid ${h?.pid || '?'}, running ${Math.round((Date.now() - Number(h?.at || Date.now())) / 1000)} s); one runs at a time; waited ${Math.round((Date.now() - t0) / 1000)} s of ${Math.round(waitMs / 1000)} s (STUDIO_ENGINE_CHECK_WAIT_MIN)`); told = Date.now(); }
      sleep(poll);
    }
  }
  try { return { value: fn() }; } finally { try { if (readJson(f)?.pid === process.pid) fs.rmSync(f, { force: true }); } catch {} }
}

/**
 * Run engine <x>'s quickCheck. { status: 'pass'|'red'|'skipped'|'busy'|'error', why, tail?, ms? }.
 * opts: root (the main studio), task, dir (where to run it), env, log.
 */
export function runEngineQuickCheck({ engine = 'unity', root = mainRoot(), task = null, dir = null, env = process.env, log = () => {} } = {}) {
  const t = engineTarget(engine, { root });
  const cmd = typeof t?.cfg?.quickCheck === 'string' ? t.cfg.quickCheck.trim() : '';
  if (!cmd) return { status: 'skipped', why: `no quickCheck is configured for ${engine} (studio/game.json "engines": { "${engine}": { "quickCheck": "<command>" } })` };
  let cwd = dir ? path.resolve(dir) : task ? path.join(root, '.lanes', 'engine', String(task)) : process.cwd();
  if (!fs.existsSync(cwd)) cwd = process.cwd();
  const waitMin = num(env.STUDIO_ENGINE_CHECK_WAIT_MIN, 20);
  const got = withEngineCheckLock(root, engine, () => {
    const t0 = Date.now();
    log(`[engine-check] ${engine}: ${cmd} (in ${cwd})`);
    const r = spawnSync(cmd, { shell: true, cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: num(t.cfg.quickCheckTimeoutMin, 30) * 60000, env: { ...env, STUDIO_ENGINE: engine, STUDIO_ENGINE_LANE_DIR: cwd } });
    return { r, ms: Date.now() - t0 };
  }, { waitMs: waitMin * 60000, log, env });
  if (got.busy) return { status: 'busy', why: `another ${engine} check held the machine's check lock (${got.busy.by || '?'}, pid ${got.busy.pid || '?'}) for the whole ${waitMin} min wait (STUDIO_ENGINE_CHECK_WAIT_MIN): run it again later` };
  const { r, ms } = got.value;
  const text = `${r.stdout || ''}${r.stderr || ''}`.replace(/\r\n?/g, '\n').trimEnd();
  const tail = text.split('\n').slice(-12).join('\n');
  if (r.error) return { status: r.error.code === 'ETIMEDOUT' ? 'red' : 'error', why: r.error.code === 'ETIMEDOUT' ? `the ${engine} quick check timed out (engines.${engine}.quickCheckTimeoutMin)` : `the ${engine} quick check could not run: ${r.error.code || r.error.message}`, tail, ms };
  if (r.status === 0) return { status: 'pass', why: `the ${engine} quick check passed (${Math.round(ms / 1000)} s)`, ms };
  return { status: 'red', why: `the ${engine} quick check failed (exit ${r.status ?? r.signal ?? '?'})`, tail, ms };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const root = mainRoot();
  const task = flag('task');
  let engine = flag('engine');
  if (!engine && task) { try { engine = engineTask(task, { root })?.engine || null; } catch {} }
  const res = runEngineQuickCheck({ engine: engine || 'unity', root, task, dir: flag('dir'), log: (m) => console.error(m) });
  if (argv.includes('--json')) console.log(JSON.stringify(res));
  else {
    console.log(`[engine-check] ${res.status === 'skipped' ? 'SKIP' : res.status.toUpperCase()} ${engine || 'unity'}: ${res.why}`);
    if (res.tail) console.log(`[engine-check] its last lines:\n${res.tail}`);
  }
  process.exit(res.status === 'pass' || res.status === 'skipped' ? 0 : res.status === 'busy' ? 3 : 1);
}
