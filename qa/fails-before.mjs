#!/usr/bin/env node
/**
 * qa/fails-before.mjs — does a regression fail on the code before the fix? If it doesn't, it doesn't
 * guard anything.
 *
 *   node qa/fails-before.mjs <regression.json> <commit>    replay it at <commit> (usually the fix's parent)
 *
 * Checks out <commit> into a temporary git worktree (your checkout is untouched), replays the
 * regression with that commit's cartridge, and hashes the end state with today's SHA-256. The
 * regression "fails before" when the old code breaks an invariant, throws, or ends in a different
 * state than the pinned sha256. Results are cached by regression and commit (.studio/cache/).
 *
 * 2.58.4: a run that never got to play the old code proves nothing, so it is an error (known: false), never a pass,
 * and never cached: the cartridge couldn't be loaded at that commit (not there yet, its build failed, a dependency
 * such as node_modules is missing in the worktree), or the run timed out, was killed or printed no result. Before,
 * every one of those counted as "the old code throws" and a regression that guards nothing passed the check.
 * STUDIO_FAILS_BEFORE_TIMEOUT_MS sets the time limit (default 120000).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.studio', 'cache', 'fails-before.json');
const git = (args, cwd = ROOT) => spawnSync('git', args, { cwd, encoding: 'utf8' });

export function failsBefore(regressionFile, commit) {
  const spec = JSON.parse(fs.readFileSync(regressionFile, 'utf8'));
  const resolved = git(['rev-parse', '--verify', `${commit}^{commit}`]).stdout.trim();
  if (!resolved) return { ok: false, known: false, why: `no commit ${commit}` };
  const key = crypto.createHash('sha256').update(`${resolved}|${JSON.stringify(spec)}`).digest('hex');
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } catch {
    cache = {};
  }
  if (cache[key]) return cache[key];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fails-before-'));
  let result;
  try {
    const add = git(['worktree', 'add', '--detach', '--force', tmp, resolved]);
    if (add.status !== 0) return { ok: false, known: false, why: `couldn't check out ${resolved.slice(0, 7)}: ${add.stderr.trim()}` };
    const probe = path.join(tmp, '.fails-before-probe.mjs');
    fs.writeFileSync(probe, `
import fs from 'node:fs';
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { loadCartridge, replay } = await import(${JSON.stringify(pathToFileURL(path.join(tmp, 'harness', 'cartridge.mjs')).href)});
const { sha256 } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'harness', 'hash.mjs')).href)});
let out;
let cart = null;
try {
  cart = await loadCartridge(spec.cartridge || undefined);
} catch (err) {
  out = { loadFailed: String(err && err.message || err) };
}
if (cart) {
  try {
    const r = replay(cart, { seed: spec.seed, tick: spec.tick, actions: spec.actions || [], tuning: spec.tuning });
    out = { findings: r.findings.map((f) => f.id), failingTick: r.failingTick, sha256: sha256(r.state) };
  } catch (err) {
    out = { threw: String(err && err.message || err) };
  }
}
console.log('FAILS_BEFORE_RESULT ' + JSON.stringify(out));
`);
    const specFile = path.join(tmp, '.fails-before-spec.json');
    fs.writeFileSync(specFile, JSON.stringify(spec));
    const limit = Number(process.env.STUDIO_FAILS_BEFORE_TIMEOUT_MS || 120000);
    const run = spawnSync(process.execPath, [probe, specFile], { cwd: tmp, encoding: 'utf8', timeout: limit, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, AGENT_EVENTS_FILE: path.join(tmp, '.events.jsonl') } });
    const line = String(run.stdout || '').split('\n').reverse().find((l) => l.startsWith('FAILS_BEFORE_RESULT '));
    let before = null;
    try { before = line ? JSON.parse(line.slice('FAILS_BEFORE_RESULT '.length)) : null; } catch { before = null; }
    const short = (t) => String(t || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
    // Never played the old code: an error, not a pass (and not cached, so a fixed setup is checked again).
    const unplayed = run.error?.code === 'ETIMEDOUT' || run.signal
      ? `the run at ${resolved.slice(0, 7)} timed out or was killed after ${Math.round(limit / 1000)} s (STUDIO_FAILS_BEFORE_TIMEOUT_MS)`
      : !before
        ? `the run at ${resolved.slice(0, 7)} printed no result (exit ${run.status}): ${short(run.stderr) || 'no output'}`
        : before.loadFailed
          ? `the cartridge couldn't be loaded at ${resolved.slice(0, 7)} (${short(before.loadFailed)})`
          : null;
    if (unplayed) return { ok: false, known: false, commit: resolved.slice(0, 7), why: `${unplayed}; that proves nothing about the bug, so it doesn't count as failing before the fix. Land the cartridge (and anything its build needs) before the fix that relies on it` };
    const failed = Boolean(before.threw) || (before.findings || []).length > 0 || before.sha256 !== spec.sha256;
    result = {
      ok: failed,
      known: true,
      commit: resolved.slice(0, 7),
      why: failed
        ? before.threw
          ? `the old code throws (${before.threw})`
          : before.findings?.length
            ? `the old code breaks ${before.findings.join(', ')} at tick ${before.failingTick}`
            : 'the old code ends in a different state'
        : `the regression passes on ${resolved.slice(0, 7)} too, so it doesn't catch the bug`,
    };
  } finally {
    git(['worktree', 'remove', '--force', tmp]);
    fs.rmSync(tmp, { recursive: true, force: true });
    git(['worktree', 'prune']);
  }
  if (!result) return { ok: false, known: false, why: 'no result' };
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  cache[key] = result;
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [file, commit] = process.argv.slice(2);
  if (!file || !commit) {
    console.error('Usage: node qa/fails-before.mjs <regression.json> <commit>');
    process.exit(1);
  }
  const r = failsBefore(path.resolve(file), commit);
  console.log(r.ok ? `[fails-before] PASS ${path.basename(file)} fails at ${r.commit}: ${r.why}` : `[fails-before] FAIL ${path.basename(file)}: ${r.why}`);
  process.exit(r.ok ? 0 : 1);
}
