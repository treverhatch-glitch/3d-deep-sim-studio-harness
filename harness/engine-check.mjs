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
 * 2.82: with no quickCheck but the owner's own "rules" command (engines.<x>.rules), `npm run engine -- check` is the rules
 * check itself (harness/engine-rules.mjs) on the lane's committed work as it would land on the target: in a throwaway
 * checkout with the rules' git-ignored inputs copied in, never in the lane's folder (the inputs are not there), and only
 * after the same check passed on the target (a check that is red on the target judges no lane). `task done` runs a check
 * only when quickCheck is set: a studio sets it to a compile and leaves the tests to the train's check of the batch.
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
import { rulesConfig, runRulesAt } from './engine-rules.mjs';
import { unityTrainSettings, chainOnTarget } from './unity-train.mjs';

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
  // 2.82: one cheap-check setting serves both: with no quickCheck, the owner's own rules command (engines.<x>.rules, never
  // the default) is the porter's check too. The train's rules check runs it again on the batch (harness/engine-rules.mjs).
  const own = t?.cfg?.rules;
  const rulesCmd = typeof own === 'string' ? own.trim() : own && typeof own === 'object' && typeof own.test === 'string' ? own.test.trim() : '';
  const quick = typeof t?.cfg?.quickCheck === 'string' && t.cfg.quickCheck.trim() ? t.cfg.quickCheck.trim() : '';
  const cmd = quick || rulesCmd;
  if (!cmd) return { status: 'skipped', why: `no quickCheck is configured for ${engine} (studio/game.json "engines": { "${engine}": { "quickCheck": "<command>" } }, or "rules": the same command the train checks a batch with)` };
  let cwd = dir ? path.resolve(dir) : task ? path.join(root, '.lanes', 'engine', String(task)) : process.cwd();
  if (!fs.existsSync(cwd)) cwd = process.cwd();
  const waitMin = num(env.STUDIO_ENGINE_CHECK_WAIT_MIN, 20);
  if (!quick) {
    const got = withEngineCheckLock(root, engine, () => rulesAsQuickCheck({ engine, root, cwd, task, env, log }), { waitMs: waitMin * 60000, log, env });
    if (got.busy) return { status: 'busy', why: `another ${engine} check held the machine's check lock (${got.busy.by || '?'}, pid ${got.busy.pid || '?'}) for the whole ${waitMin} min wait (STUDIO_ENGINE_CHECK_WAIT_MIN): run it again later` };
    return got.value;
  }
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

/**
 * The owner's rules command as the porter's check: the rules check (engine-rules.mjs) on the lane's HEAD as it would land
 * on the target. 'skipped' whenever it could not judge the lane (not the engine repo, a conflict, a target that is red
 * itself, a check that could not run): the train's check of the batch decides then, as it does anyway.
 */
function rulesAsQuickCheck({ engine, root, cwd, task, env, log }) {
  const g = (dir, ...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true }); return r.status === 0 ? String(r.stdout || '').trim() : ''; };
  const skip = (why) => ({ status: 'skipped', why: `the ${engine} rules check judged nothing here: ${why}; the train checks the batch before the land run` });
  let s; try { s = unityTrainSettings(root, engine); } catch (e) { return skip(e.message); }
  if (!s || s.error) return skip(s?.message || 'no engine repo');
  const cfg = rulesConfig(engine, { root, env, repo: s.repo, ref: s.target });
  if (!cfg) return skip('the rules check is off');
  const head = g(cwd, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}');
  if (!head || !g(s.repo, 'rev-parse', '--verify', '--quiet', `${head}^{commit}`)) return skip(`${cwd} is not a checkout of the ${engine} repo`);
  const tip = g(s.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${s.target}^{commit}`);
  if (!tip) return skip(`the ${engine} repo has no ${s.target}`);
  const from = [...new Set([s.folder, s.cfg.gateWorktree ? path.resolve(root, s.cfg.gateWorktree) : null, s.cfg.cwd ? path.resolve(root, s.cfg.cwd) : null, s.repo].filter(Boolean))];
  const id = `check-${task || 'lane'}`;
  const base = runRulesAt({ engine, repo: s.repo, sha: tip, cfg, from, root, id, env, log });
  if (base.status !== 'pass') return skip(`it is ${base.status === 'red' ? 'red' : 'not runnable'} on ${s.target} itself (${base.why}${base.failures?.length ? `: ${base.failures.slice(0, 3).join(', ')}` : ''}), so it judges no lane`);
  const c = chainOnTarget(s.repo, tip, [{ task: task || 'lane', branch: g(cwd, 'rev-parse', '--abbrev-ref', 'HEAD') || head.slice(0, 10), head }], id, engine);
  if (c.error || !c.head || !c.included?.length) return skip(c.error || (c.already?.length ? `this work is already in ${s.target}` : `the lane does not merge onto ${s.target} cleanly (merge ${s.target} into it first)`));
  const dirty = g(cwd, 'status', '--porcelain', '--untracked-files=no') ? ' (uncommitted changes in the lane are not part of it)' : '';
  const r = runRulesAt({ engine, repo: s.repo, sha: c.head, cfg, from, root, id, env, log });
  if (r.status === 'pass') return { status: 'pass', why: `the ${engine} rules check passed on this lane's commit as it would land on ${s.target}${r.cached ? ' (kept result)' : ` (${Math.round((r.ms || 0) / 1000)} s)`}${dirty}`, ms: r.ms || 0 };
  if (r.status !== 'red') return skip(r.why);
  return { status: 'red', why: `the ${engine} rules check (${cfg.command}) is red with this lane's commit on ${s.target}, and green on ${s.target} without it${r.failures?.length ? `. Failing: ${r.failures.slice(0, 8).join(', ')}` : ''}${dirty}`, tail: r.tail || '', ms: r.ms || 0 };
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
