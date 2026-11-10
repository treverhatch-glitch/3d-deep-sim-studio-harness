/**
 * harness/engine-rules.mjs — 2.82: the engine's rules check, run before the long land run.
 *
 * A game's rules that live in plain code (for Unity: a C# assembly with no engine types, tested with `dotnet test`) can
 * be judged without the editor. In the crew's first 64 land runs, 24 of the 45 failures were in exactly those tests, and
 * each one was found by a full land run and then bisected with more full land runs. This module runs the cheap check
 * first, on the batch as it would land, and bisects a red batch with the cheap check instead of the land command.
 *
 *   studio/game.json (the owner's, protected):
 *     "engines": { "<x>": { "rules": "<command>" } }                      one command, run at the top of a checkout
 *     "engines": { "<x>": { "rules": { "test": "<command>", "inputs": ["<folder>", ...], "timeoutMin": 30 } } }
 *   Default for unity when "rules" is absent: `dotnet test tools/SimTests` when the target branch has that folder.
 *   "rules": false, or STUDIO_ENGINE_RULES=off: no rules check.
 *   "inputs": git-ignored files or folders the tests read, copied from the engine's folder into the throwaway checkout.
 *
 * It judges a batch only after it has passed on the target itself in the same kind of checkout (the calibration): a
 * check that is red on the landed target (a missing input, a missing SDK) blames nobody and is skipped with the reason.
 * Results are kept per tree, command and inputs (.studio/engine/<x>-rules.json), so a tree is run once. The inputs are
 * not in the tree, so their content is part of the key (inputsPrint): a kept result never answers for other inputs.
 *
 *   node harness/engine-rules.mjs [--engine unity] [--ref <branch|commit>] [--json]     run it on one commit
 *   node harness/engine-rules.mjs show [--engine unity]                                 the command and where it comes from
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitEvent } from './event.mjs';
import { mainRoot } from './worktree.mjs';
import { engineTarget, ENGINE_NAME_RE } from './engine-tracks.mjs';
import { failingTests } from './unity-gate.mjs';
import { readJson, writeAtomic } from './fsafe.mjs';

const off = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());
const num = (v, d) => (Number.isFinite(Number(v)) && String(v ?? '').trim() !== '' ? Number(v) : d);
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
const short = (sha) => String(sha || '').slice(0, 10);
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

export const rulesFile = (root, engine) => path.join(root, '.studio', 'engine', `${engine}-rules.json`);

/** The default rules command of an engine whose target branch has the files it needs, or null. */
const DEFAULTS = { unity: { has: 'tools/SimTests', test: 'dotnet test tools/SimTests' } };

/**
 * The rules check of engine <x>: { command, inputs, timeoutMin, source } or null (none configured, none by default, or
 * switched off). repo and ref: the engine repo and the branch whose tree decides the default.
 */
export function rulesConfig(engine, { root = mainRoot(), env = process.env, repo = null, ref = null } = {}) {
  if (!ENGINE_NAME_RE.test(String(engine || '')) || off(env.STUDIO_ENGINE_RULES)) return null;
  const cfg = engineTarget(engine, { root })?.cfg || {};
  const r = cfg.rules;
  if (r === false) return null;
  const dotnet = String(env.STUDIO_DOTNET || '').trim();
  const withSdk = (cmd) => (dotnet && /^dotnet\s/.test(cmd) ? `${/\s/.test(dotnet) ? `"${dotnet}"` : dotnet}${cmd.slice(6)}` : cmd);
  const timeoutMin = Math.max(1, num(env.STUDIO_ENGINE_RULES_TIMEOUT_MIN, num(r && typeof r === 'object' ? r.timeoutMin : null, 30)));
  const inputs = (r && typeof r === 'object' && Array.isArray(r.inputs) ? r.inputs : []).map((x) => String(x || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')).filter((x) => x && !x.startsWith('/') && !/(^|\/)\.\.(\/|$)/.test(x) && !/^[A-Za-z]:/.test(x));
  const test = typeof r === 'string' ? r.trim() : r && typeof r === 'object' && typeof r.test === 'string' ? r.test.trim() : '';
  if (test) return { command: withSdk(test), inputs, timeoutMin, source: `studio/game.json engines.${engine}.rules` };
  const d = DEFAULTS[engine];
  if (!d || !repo || !ref) return null;
  if (git(repo, 'cat-file', '-e', `${ref}:${d.has}`).status !== 0) return null;
  return { command: withSdk(d.test), inputs, timeoutMin, source: `the ${engine} default (${ref} has ${d.has})` };
}

/**
 * A fingerprint of the git-ignored inputs as they lie in the folders they are copied from ('' with no inputs). They are
 * not in the commit's tree, so a kept result is only valid for the same inputs, and so is STUDIO_RULES_GREEN.
 */
export function inputsPrint(cfg, from = []) {
  if (!cfg?.inputs?.length) return '';
  const h = crypto.createHash('sha1');
  const walk = (p, name) => {
    let st; try { st = fs.statSync(p); } catch { h.update(`${name}\0gone\n`); return; }
    if (st.isDirectory()) { for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e), `${name}/${e}`); return; }
    h.update(`${name}\0${st.size}\0`);
    // Content for anything of ordinary size; a very large file is told apart by its size and time.
    if (st.size <= 64 * 1024 * 1024) { try { h.update(fs.readFileSync(p)); } catch { h.update('unreadable'); } } else h.update(String(Math.floor(st.mtimeMs)));
  };
  for (const rel of cfg.inputs) {
    const src = from.map((f) => path.join(f, rel)).find((p) => fs.existsSync(p));
    if (src) walk(src, rel); else h.update(`${rel}\0missing\n`);
  }
  return h.digest('hex').slice(0, 12);
}

const cmdKey = (c) => crypto.createHash('sha1').update(`${c.command}\n${c.inputs.join('\n')}`).digest('hex').slice(0, 12);
const readCache = (root, engine) => { const j = readJson(rulesFile(root, engine), null); return j && typeof j === 'object' && j.trees && typeof j.trees === 'object' ? j : { trees: {}, runs: [] }; };
function keep(root, engine, key, rec) {
  try {
    const j = readCache(root, engine);
    j.trees[key] = rec;
    const keys = Object.keys(j.trees);
    for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete j.trees[k];
    j.runs = [...(Array.isArray(j.runs) ? j.runs : []), { at: rec.at, status: rec.status, ms: rec.ms }].slice(-40);
    fs.mkdirSync(path.dirname(rulesFile(root, engine)), { recursive: true });
    writeAtomic(rulesFile(root, engine), `${JSON.stringify(j, null, 2)}\n`);
  } catch { /* the cache is a saving, never a requirement */ }
}

/** The median minutes of the last recorded rules runs that ran to the end, or null. */
export function rulesMinutes(root, engine) {
  const runs = (readCache(root, engine).runs || []).filter((r) => ['pass', 'red'].includes(r.status) && r.ms > 0).slice(-12).map((r) => r.ms).sort((a, b) => a - b);
  return runs.length ? Math.round(runs[Math.floor(runs.length / 2)] / 6000) / 10 : null;
}

/**
 * Run the rules check on one commit of the engine repo, in a throwaway checkout (never the land script's worktree, never
 * a lane). { status: 'pass' | 'red' | 'error', why, ms, failures?, tail?, cached? }. 'error': it could not be run or timed
 * out (nobody is blamed). opts: repo, sha, cfg (rulesConfig), from (folders the inputs are copied from), root, id, env, log,
 * useCache (default true).
 */
export function runRulesAt({ engine = 'unity', repo, sha, cfg, from = [], root = mainRoot(), id = 'rules', env = process.env, log = () => {}, useCache = true } = {}) {
  const tree = out(git(repo, 'rev-parse', '--verify', '--quiet', `${sha}^{tree}`));
  if (!tree) return { status: 'error', why: `${short(sha)} is not a commit of the ${engine} repo`, ms: 0 };
  const print = inputsPrint(cfg, from);
  const key = `${tree}|${cmdKey(cfg)}${print ? `|${print}` : ''}`;
  if (useCache) {
    const hit = readCache(root, engine).trees[key];
    if (hit && ['pass', 'red'].includes(hit.status)) return { ...hit, cached: true };
  }
  const dir = path.join(root, '.studio', 'tmp', `rules-${safe(id)}-${short(sha)}`);
  const cleanup = () => { git(repo, 'worktree', 'remove', '--force', dir); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} git(repo, 'worktree', 'prune'); };
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  cleanup();
  const add = git(repo, 'worktree', 'add', '--detach', dir, sha);
  if (add.status !== 0) return { status: 'error', why: `could not check ${short(sha)} out for the rules check: ${String(add.stderr || '').trim().split('\n').pop()}`, ms: 0 };
  const t0 = Date.now();
  try {
    const missing = [];
    for (const rel of cfg.inputs) {
      const dest = path.join(dir, rel);
      if (fs.existsSync(dest)) continue;
      const src = from.map((f) => path.join(f, rel)).find((p) => fs.existsSync(p));
      if (!src) { missing.push(rel); continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
    }
    if (missing.length) log(`[engine-rules] ${engine}: input(s) not found in the engine's folder: ${missing.join(', ')} (engines.${engine}.rules.inputs)`);
    log(`[engine-rules] ${engine}: ${cfg.command} on ${short(sha)}`);
    const r = spawnSync(cfg.command, { shell: true, cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: cfg.timeoutMin * 60000, env: { ...env, STUDIO_ENGINE: engine, STUDIO_RULES_COMMIT: sha, STUDIO_RULES_DIR: dir, STUDIO_ENGINE_REPO: repo } });
    const ms = Date.now() - t0;
    const text = `${r.stdout || ''}${r.stderr || ''}`.replace(/\r\n?/g, '\n').trimEnd();
    if (r.error) return { status: 'error', why: r.error.code === 'ETIMEDOUT' ? `the rules check timed out after ${cfg.timeoutMin} min (engines.${engine}.rules.timeoutMin)` : `the rules check could not run: ${r.error.code || r.error.message}`, ms };
    const rec = r.status === 0
      ? { status: 'pass', why: `the rules check passed (${Math.round(ms / 1000)} s)`, ms, at: new Date().toISOString() }
      : { status: 'red', why: `the rules check failed (exit ${r.status ?? r.signal ?? '?'})`, ms, at: new Date().toISOString(), failures: failingTests(text).slice(0, 40), tail: text.split('\n').slice(-12).join('\n') };
    keep(root, engine, key, rec);
    return rec;
  } finally { cleanup(); }
}

/**
 * The batch check before a land run. lanes: the train's lanes in order ({ task, branch, head }); chain(tip, lanes) ->
 * { head } | { error } builds the commit the batch would land as (unity-train.mjs chainOnTarget). Returns
 * { ran, skipped?, why, kept: [lane], dropped: [{ lane, why, failures }], runs, ms, green?: <commit the kept lanes passed as>,
 * inputs: <inputsPrint when the check began> }.
 * A red batch is narrowed with the same cheap check: the first prefix that is red names its last lane, which is dropped;
 * the rest is checked again. STUDIO_ENGINE_RULES_MAX_RUNS (12) bounds the runs of one batch: past it the lanes left go
 * to the land run unjudged.
 */
export function rulesGate({ engine = 'unity', repo, tip, lanes, chain, cfg, from = [], root = mainRoot(), id = 'rules', env = process.env, log = () => {}, run = runRulesAt } = {}) {
  const res = { ran: false, kept: lanes.slice(), dropped: [], runs: 0, ms: 0, why: '', inputs: inputsPrint(cfg, from) };
  if (!cfg) return { ...res, skipped: true, why: 'no rules check is configured' };
  if (!lanes.length) return { ...res, skipped: true, why: 'no lane to check' };
  const maxRuns = Math.max(2, Math.floor(num(env.STUDIO_ENGINE_RULES_MAX_RUNS, 12)));
  const at = (sha) => { const r = run({ engine, repo, sha, cfg, from, root, id, env, log }); if (!r.cached) { res.runs += 1; res.ms += r.ms || 0; } return r; };
  // The calibration: the landed target must be green in the same kind of checkout, or the check judges nobody.
  const base = at(tip);
  if (base.status !== 'pass') {
    return { ...res, skipped: true, calibration: base.status, why: `the rules check is ${base.status === 'red' ? 'red' : 'not runnable'} on the target itself (${base.why}${base.failures?.length ? `: ${base.failures.slice(0, 3).join(', ')}` : ''}), so it judges no lane: fix the target, or name the inputs its tests read in studio/game.json engines.${engine}.rules.inputs` };
  }
  res.ran = true;
  let set = lanes.slice();
  while (set.length) {
    const whole = chain(tip, set);
    if (whole.error || !whole.head) { res.why = `the batch could not be built for the rules check (${whole.error || 'no head'})`; break; }
    const r = at(whole.head);
    if (r.status === 'pass') { res.green = whole.head; break; }
    if (r.status !== 'red') { res.why = `${r.why}: the land run decides`; break; }
    if (res.runs >= maxRuns) { res.why = `the rules check is red and its ${maxRuns} runs are used (STUDIO_ENGINE_RULES_MAX_RUNS): the land run decides for ${set.map((l) => l.task).join(', ')}`; break; }
    // The smallest prefix that is red: its last lane is the one that turns the batch red.
    let lo = 0; // target + the first lo lanes is green
    let hi = set.length; // target + the first hi lanes is red
    let bad = r;
    let stuck = false;
    while (hi - lo > 1) {
      if (res.runs >= maxRuns) { stuck = true; break; }
      const mid = Math.floor((lo + hi) / 2);
      const part = chain(tip, set.slice(0, mid));
      if (part.error || !part.head) { stuck = true; break; }
      const rm = at(part.head);
      if (rm.status === 'pass') lo = mid;
      else if (rm.status === 'red') { hi = mid; bad = rm; } else { stuck = true; break; }
    }
    if (stuck) { res.why = `the rules check is red for ${set.map((l) => l.task).join(' + ')} and could not be narrowed: the land run decides`; break; }
    const culprit = set[hi - 1];
    const before = set.slice(0, hi - 1).map((l) => l.task);
    res.dropped.push({ lane: culprit, failures: bad.failures || [], why: `the rules check (${cfg.command}) is red with ${culprit.branch}${before.length ? ` on top of ${before.join(' + ')}` : ''}; it is green without it${bad.failures?.length ? `. Failing: ${bad.failures.slice(0, 8).join(', ')}${bad.failures.length > 8 ? ', ...' : ''}` : ''}${bad.tail ? `\n${bad.tail.split('\n').map((x) => `  ${x}`).join('\n')}` : ''}` });
    set = set.filter((l) => l.task !== culprit.task);
  }
  res.kept = set;
  if (!res.why) res.why = res.dropped.length ? `${res.dropped.length} lane(s) refused by the rules check, ${set.length} go to the land run` : `the rules check is green for ${set.map((l) => l.task).join(', ')}`;
  try { emitEvent({ type: 'engine.rules', agent: env.STUDIO_LOCK_OWNER || 'gates', track: `engine:${engine}`, status: res.dropped.length ? 'warn' : 'ok', msg: `${engine} rules check: ${res.why}`.slice(0, 400), meta: { engine, runs: res.runs, ms: res.ms, kept: set.map((l) => l.task), dropped: res.dropped.map((d) => d.lane.task), green: Boolean(res.green) } }); } catch { /* the check's result stands without its event */ }
  return res;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const engine = flag('engine') || 'unity';
  const root = mainRoot();
  const { unityTrainSettings } = await import('./unity-train.mjs');
  const s = unityTrainSettings(root, engine);
  if (s.error) { console.error(`[engine-rules] ${s.message}`); process.exit(1); }
  const ref = flag('ref') || s.target;
  const cfg = rulesConfig(engine, { root, repo: s.repo, ref: s.target });
  if (argv[0] === 'show' || !cfg) {
    console.log(cfg ? `[engine-rules] ${engine}: ${cfg.command} (${cfg.source}); inputs: ${cfg.inputs.join(', ') || 'none'}; up to ${cfg.timeoutMin} min; median of recorded runs: ${rulesMinutes(root, engine) ?? 'none yet'} min` : `[engine-rules] ${engine}: no rules check (set studio/game.json "engines": { "${engine}": { "rules": "<command>" } }; the owner's file)`);
    process.exit(0);
  }
  const sha = out(git(s.repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`));
  if (!sha) { console.error(`[engine-rules] ${ref} is not a branch or commit of the ${engine} repo (${s.repo})`); process.exit(1); }
  const res = runRulesAt({ engine, repo: s.repo, sha, cfg, from: [s.folder, s.repo].filter(Boolean), root, id: 'cli', log: (m) => console.error(m), useCache: !argv.includes('--fresh') });
  if (argv.includes('--json')) console.log(JSON.stringify(res));
  else {
    console.log(`[engine-rules] ${res.status.toUpperCase()} ${engine} at ${short(sha)}: ${res.why}${res.cached ? ' (kept result for this tree)' : ''}`);
    if (res.failures?.length) console.log(`[engine-rules] failing: ${res.failures.join(', ')}`);
    if (res.tail) console.log(`[engine-rules] its last lines:\n${res.tail}`);
  }
  process.exit(res.status === 'pass' ? 0 : res.status === 'red' ? 1 : 3);
}
