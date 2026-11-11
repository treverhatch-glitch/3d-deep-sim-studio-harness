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
 *   2.83: also "env" (variables for the command), "lfs" (true: smudge large files in the checkout; default skipped),
 *   "paths" (the repo folders the tests compile or read: a sparse checkout, and the kept result's key), "focus" (run only
 *   the tests of the systems a batch changed, with a full run every fullEveryHours) and "share" (folders of
 *   content-addressed inputs a lane adds, copied by shareInputs). docs/NATIVE-ENGINE.md has the shapes.
 *
 * It judges a batch only after it has passed on the target itself in the same kind of checkout (the calibration): a
 * check that is red on the landed target (a missing input, a missing SDK) blames nobody and is skipped with the reason.
 * Results are kept per tree, command and inputs (.studio/engine/<x>-rules.json), so a tree is run once. The inputs are
 * not in the tree, so their content is part of the key (inputsPrint): a kept result never answers for other inputs.
 *
 *   node harness/engine-rules.mjs [--engine unity] [--ref <branch|commit>] [--full] [--fresh] [--json]   run it on one commit
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
const on = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const num = (v, d) => (Number.isFinite(Number(v)) && String(v ?? '').trim() !== '' ? Number(v) : d);
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
const short = (sha) => String(sha || '').slice(0, 10);
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
const lastLine = (r) => String(r.stderr || r.error?.message || '').trim().split('\n').pop();

export const rulesFile = (root, engine) => path.join(root, '.studio', 'engine', `${engine}-rules.json`);

/** The default rules command of an engine whose target branch has the files it needs, or null. */
const DEFAULTS = { unity: { has: 'tools/SimTests', test: 'dotnet test tools/SimTests' } };

/** Repo-relative paths from the owner's list: forward slashes, no trailing slash, nothing absolute or outside. */
const relList = (list) => (Array.isArray(list) ? list : []).map((x) => String(x || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')).filter((x) => x && !x.startsWith('/') && !/(^|\/)\.\.(\/|$)/.test(x) && !/^[A-Za-z]:/.test(x));

/**
 * The rules check of engine <x>: { command, inputs, timeoutMin, source, env, lfs, paths, focus, share } or null (none
 * configured, none by default, or switched off). repo and ref: the engine repo and the branch whose tree decides the default.
 */
export function rulesConfig(engine, { root = mainRoot(), env = process.env, repo = null, ref = null } = {}) {
  if (!ENGINE_NAME_RE.test(String(engine || '')) || off(env.STUDIO_ENGINE_RULES)) return null;
  const cfg = engineTarget(engine, { root })?.cfg || {};
  const r = cfg.rules;
  if (r === false) return null;
  const o = r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  const dotnet = String(env.STUDIO_DOTNET || '').trim();
  const withSdk = (cmd) => (dotnet && /^dotnet\s/.test(cmd) ? `${/\s/.test(dotnet) ? `"${dotnet}"` : dotnet}${cmd.slice(6)}` : cmd);
  const timeoutMin = Math.max(1, num(env.STUDIO_ENGINE_RULES_TIMEOUT_MIN, num(o.timeoutMin, 30)));
  const inputs = relList(o.inputs);
  // 2.83: the command's own variables (strings only), the sparse paths, LFS, focused runs and shared input folders.
  const vars = o.env && typeof o.env === 'object' && !Array.isArray(o.env)
    ? Object.fromEntries(Object.entries(o.env).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string')) : {};
  const f = o.focus;
  const focus = f && typeof f === 'object' && typeof f.test === 'string' && f.test.includes('{filter}') && Array.isArray(f.map)
    ? {
      test: withSdk(f.test.trim()),
      map: f.map.filter((m) => m && typeof m.match === 'string' && typeof m.filter === 'string').map((m) => ({ match: m.match, filter: m.filter })),
      smoke: typeof f.smoke === 'string' ? f.smoke.trim() : '',
      join: typeof f.join === 'string' && f.join ? f.join : '|',
      fullEveryHours: Math.max(0, num(f.fullEveryHours, 24)),
    } : null;
  const extra = { env: vars, lfs: o.lfs === true, paths: relList(o.paths), focus: focus?.map.length ? focus : null, share: (Array.isArray(o.share) ? o.share : []).map((x) => String(x ?? '').trim()).filter(Boolean) };
  const test = typeof r === 'string' ? r.trim() : typeof o.test === 'string' ? o.test.trim() : '';
  if (test) return { command: withSdk(test), inputs, timeoutMin, source: `studio/game.json engines.${engine}.rules`, ...extra };
  const d = DEFAULTS[engine];
  if (!d || !repo || !ref) return null;
  if (git(repo, 'cat-file', '-e', `${ref}:${d.has}`).status !== 0) return null;
  return { command: withSdk(d.test), inputs, timeoutMin, source: `the ${engine} default (${ref} has ${d.has})`, ...extra };
}

/**
 * 2.83: the files of one input as the tests see them, merged over the folders it is copied from: each folder in order,
 * the first folder that has a file wins it. { found, files: [[name, abs]] } sorted by name (forward slashes).
 */
export function inputFiles(rel, from = []) {
  const files = new Map();
  let found = false;
  const walk = (p, name) => {
    let st; try { st = fs.lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) { try { st = fs.statSync(p); } catch { return; } }
    if (st.isDirectory()) { for (const e of fs.readdirSync(p)) walk(path.join(p, e), `${name}/${e}`); return; }
    if (!files.has(name)) files.set(name, p);
  };
  for (const f of from) {
    const src = path.join(f, ...rel.split('/'));
    if (!fs.existsSync(src)) continue;
    found = true;
    walk(src, rel);
  }
  return { found, files: [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) };
}

/**
 * A fingerprint of the git-ignored inputs as the tests see them ('' with no inputs): 2.83, the merged view over every
 * folder they are copied from (inputFiles), so a file only a later folder has is part of it. They are not in the
 * commit's tree, so a kept result is only valid for the same inputs, and so is STUDIO_RULES_GREEN.
 */
export function inputsPrint(cfg, from = []) {
  if (!cfg?.inputs?.length) return '';
  const h = crypto.createHash('sha1');
  for (const rel of cfg.inputs) {
    const { found, files } = inputFiles(rel, from);
    if (!found) { h.update(`${rel}\0missing\n`); continue; }
    for (const [name, p] of files) {
      let st; try { st = fs.statSync(p); } catch { h.update(`${name}\0gone\n`); continue; }
      h.update(`${name}\0${st.size}\0`);
      // Content for anything of ordinary size; a very large file is told apart by its size and time.
      if (st.size <= 64 * 1024 * 1024) { try { h.update(fs.readFileSync(p)); } catch { h.update('unreadable'); } } else h.update(String(Math.floor(st.mtimeMs)));
    }
  }
  return h.digest('hex').slice(0, 12);
}

/** Copy the merged inputs into a checkout: a file already there (tracked, or from an earlier folder) is never overwritten. */
function copyInputs(cfg, from, dir) {
  const missing = [];
  for (const rel of cfg.inputs || []) {
    const { found, files } = inputFiles(rel, from);
    if (!found) { missing.push(rel); continue; }
    for (const [name, src] of files) {
      const dest = path.join(dir, ...name.split('/'));
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
  return missing;
}

/**
 * 2.83: copy a lane's newly added shared input files (cfg.share: repo-relative folders of content-addressed files) into
 * another folder. Only files missing under <to> are copied: never an overwrite, never a delete. An entry that is absolute
 * or reaches outside with `..` is refused. { copied: [relative paths], skipped: n, refused: [entries] }.
 */
export function shareInputs({ cfg, laneDir, to, log = () => {} } = {}) {
  const res = { copied: [], skipped: 0, refused: [] };
  if (!laneDir || !to) return res;
  for (const raw of Array.isArray(cfg?.share) ? cfg.share : []) {
    const e = String(raw ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!e || e.startsWith('/') || /^[A-Za-z]:/.test(e) || path.isAbsolute(e) || e.split('/').includes('..')) {
      res.refused.push(String(raw));
      log(`[engine-rules] share: refused "${raw}" (a share entry is a folder inside the repo: no absolute path, no ..)`);
      continue;
    }
    const walk = (p, rel) => {
      let st; try { st = fs.lstatSync(p); } catch { return; }
      if (st.isSymbolicLink()) return; // a link could point anywhere: shared inputs are plain files
      if (st.isDirectory()) { for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n), `${rel}/${n}`); return; }
      if (!st.isFile()) return;
      const dest = path.join(to, ...rel.split('/'));
      if (fs.existsSync(dest)) { res.skipped += 1; return; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(p, dest, fs.constants.COPYFILE_EXCL);
      res.copied.push(rel);
    };
    walk(path.join(laneDir, ...e.split('/')), e);
  }
  if (res.copied.length) log(`[engine-rules] share: copied ${res.copied.length} file(s) to ${String(to).split(path.sep).join('/')}`);
  return res;
}

/**
 * 2.83: the throwaway checkout's git environment and steps. Large files are not smudged unless rules.lfs is true (a
 * crew's checkout was 3.2 GB each time; rule tests do not read art). With rules.paths only those paths are checked out:
 * `worktree add --no-checkout`, then the patterns are written to the worktree's own info/sparse-checkout and checked out
 * with core.sparseCheckout given on the command line. (`git sparse-checkout set` in a linked worktree turns on
 * extensions.worktreeConfig in the engine repo's shared config: a lasting change to the owner's repo this avoids.)
 */
export function checkoutPlan({ dir, sha, cfg = {}, env = process.env } = {}) {
  const gitEnv = { ...env };
  if (cfg?.lfs !== true) gitEnv.GIT_LFS_SKIP_SMUDGE = '1';
  const paths = Array.isArray(cfg?.paths) ? cfg.paths : [];
  return {
    env: gitEnv,
    sparse: paths.length > 0,
    add: paths.length ? ['worktree', 'add', '--no-checkout', '--detach', dir, sha] : ['worktree', 'add', '--detach', dir, sha],
    patterns: paths.map((p) => `/${p}`),
    checkout: ['-c', 'core.sparseCheckout=true', '-c', 'core.sparseCheckoutCone=false', 'checkout', '-q', '--detach', sha],
    full: ['worktree', 'add', '--detach', dir, sha],
  };
}

/** Remove a throwaway checkout of the engine repo. */
export function removeCheckout(repo, dir) {
  git(repo, 'worktree', 'remove', '--force', dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  git(repo, 'worktree', 'prune');
}

/** Make the throwaway checkout (checkoutPlan); a sparse checkout that fails falls back to a full one. { ok, sparse, why } */
export function rulesCheckout({ repo, sha, dir, cfg = {}, env = process.env, log = () => {}, engine = 'unity' } = {}) {
  const p = checkoutPlan({ dir, sha, cfg, env });
  const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: p.env, maxBuffer: 32 * 1024 * 1024 });
  if (p.sparse) {
    let why = '';
    const a = g(repo, p.add);
    if (a.status !== 0) why = lastLine(a);
    else {
      const gd = out(g(dir, ['rev-parse', '--absolute-git-dir']));
      if (!gd) why = 'its git folder was not found';
      else {
        try { fs.mkdirSync(path.join(gd, 'info'), { recursive: true }); fs.writeFileSync(path.join(gd, 'info', 'sparse-checkout'), `${p.patterns.join('\n')}\n`); } catch (e) { why = e.message; }
        if (!why) { const c = g(dir, p.checkout); if (c.status !== 0) why = lastLine(c); }
      }
    }
    if (!why) return { ok: true, sparse: true };
    log(`[engine-rules] ${engine}: the sparse checkout of rules.paths failed (${why}); a full checkout instead`);
    removeCheckout(repo, dir);
  }
  const a = g(repo, p.full);
  return a.status === 0 ? { ok: true, sparse: false } : { ok: false, why: lastLine(a) };
}

/** The repo paths that differ between two commits (renames as a delete and an add), or null when git can't tell. */
export function changedPaths(repo, a, b) {
  const r = git(repo, '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z', a, b, '--');
  if (r.status !== 0) return null;
  return String(r.stdout || '').split('\0').filter(Boolean);
}

/**
 * 2.83: what a batch runs. changed: the batch's changed repo paths (null: not known); full: a full run is forced.
 * { mode: 'focus' | 'full', filter, command, changed, why, unchanged? }. Focus only when there is a changed path and every
 * one (under rules.paths, when set) matches a rules.focus.map entry: the unique filters of the matching entries in order,
 * then smoke, joined. A regex group may only bring letters, digits, . _ and - into the command; anything else makes that
 * path unmapped (the filter goes into a shell command). With paths set and nothing under them changed: the full command,
 * and `unchanged`: the batch's rule inputs are the target's, so the target's kept result answers.
 */
export function rulesSelection({ changed = [], cfg, full = false, fullWhy = '' } = {}) {
  const paths = cfg?.paths || [];
  const under = (p) => !paths.length || paths.some((x) => p === x || p.startsWith(`${x}/`));
  const ch = changed == null ? null : [...new Set(changed.map((p) => String(p || '').replace(/\\/g, '/')).filter(Boolean))].filter(under);
  const fullSel = (why, extra = {}) => ({ mode: 'full', filter: '', command: cfg.command, changed: ch || [], why, ...extra });
  if (ch && paths.length && !ch.length) return fullSel('nothing under rules.paths changed: the target\'s kept result answers', { unchanged: true });
  if (!cfg?.focus) return fullSel('no rules.focus');
  if (full) return fullSel(fullWhy || 'a full run was asked for');
  if (!ch) return fullSel('the batch\'s changed paths are not known');
  if (!ch.length) return fullSel('the batch changes no path');
  const ff = focusFilters({ changed: ch, map: cfg.focus.map, smoke: cfg.focus.smoke, join: cfg.focus.join });
  if (!ff.ok) return fullSel(`${ff.unmatched} matches no rules.focus.map entry`);
  return { mode: 'focus', filter: ff.filter, command: cfg.focus.test.split('{filter}').join(ff.filter), changed: ch, why: `${ch.length} changed path(s), all mapped by rules.focus` };
}

/**
 * 2.84: the focus mapping shared by the rules check and the land's Play Mode stage. changed: repo paths; map:
 * [{ match: <regex>, filter }]. Every path must match at least one entry; each matching entry gives its filter with
 * $1..$9 replaced by the regex groups (a group with anything but letters, digits, . _ and - makes that entry not match:
 * the filter goes onto a command line). { ok: true, filters, filter } (the unique filters in order, then smoke, joined)
 * or { ok: false, unmatched: <the first path no entry maps> }.
 */
export function focusFilters({ changed = [], map = [], smoke = '', join = '|' } = {}) {
  const filters = [];
  for (const p of changed) {
    let hit = false;
    for (const m of map) {
      let re; try { re = new RegExp(m.match); } catch { continue; }
      const g = re.exec(p);
      if (!g) continue;
      const vals = g.slice(1, 10).map((v) => v ?? '');
      if (vals.some((v) => !/^[A-Za-z0-9._-]*$/.test(v))) continue;
      const f = m.filter.replace(/\$([1-9])/g, (_, i) => vals[Number(i) - 1] ?? '').trim();
      if (!f) continue;
      hit = true;
      if (!filters.includes(f)) filters.push(f);
    }
    if (!hit) return { ok: false, unmatched: p };
  }
  if (smoke && !filters.includes(smoke)) filters.push(smoke);
  return { ok: true, filters, filter: filters.join(join) };
}

/**
 * 2.84: engines.<x>.play.focus = { map: [{ match, filter }], smoke, join } (join ";" when not given: the Unity Test
 * Framework's separator), or null (not set, or no usable map entry).
 */
export function playFocusConfig(cfg = {}) {
  const f = cfg?.play && typeof cfg.play === 'object' ? cfg.play.focus : null;
  if (!f || typeof f !== 'object' || !Array.isArray(f.map)) return null;
  const map = f.map.filter((m) => m && typeof m.match === 'string' && typeof m.filter === 'string').map((m) => ({ match: m.match, filter: m.filter }));
  if (!map.length) return null;
  return { map, smoke: typeof f.smoke === 'string' ? f.smoke.trim() : '', join: typeof f.join === 'string' && f.join ? f.join : ';' };
}

/** 2.84: the characters a Play Mode filter may hold; anything else and the play stage runs in full (it reaches a command line). */
export const PLAY_FILTER_SAFE = /^[A-Za-z0-9_.;|~=!()* -]+$/;

/**
 * 2.84: what the land's Play Mode stage is told. changed: the batch's changed repo paths (null: not known); cfg: the
 * engine's config (engines.<x>); full: a full land run (fullLandDue). { mode: 'focus' | 'full', filter, why, refused? }.
 * Focus only when every changed path matches a play.focus.map entry and the joined filter holds only PLAY_FILTER_SAFE
 * characters. A hint the land script may use: a focused Play Mode run is a weaker check than a full one.
 */
export function playSelection({ changed = [], cfg = {}, full = false, fullWhy = '' } = {}) {
  const pf = playFocusConfig(cfg);
  const fullSel = (why, extra = {}) => ({ mode: 'full', filter: '', why, ...extra });
  if (!pf) return fullSel('no play.focus');
  if (full) return fullSel(fullWhy || 'a full land run');
  if (!changed) return fullSel('the batch\'s changed paths are not known');
  const ch = [...new Set(changed.map((p) => String(p || '').replace(/\\/g, '/')).filter(Boolean))];
  if (!ch.length) return fullSel('the batch changes no path');
  const ff = focusFilters({ changed: ch, map: pf.map, smoke: pf.smoke, join: pf.join });
  if (!ff.ok) return fullSel(`${ff.unmatched} matches no play.focus.map entry`);
  if (!ff.filter) return fullSel('the filter is empty');
  if (!PLAY_FILTER_SAFE.test(ff.filter)) return fullSel(`refused the filter "${ff.filter.slice(0, 120)}": only letters, digits, space and _ . ; | ~ = ! ( ) * - may reach the land command`, { refused: true });
  return { mode: 'focus', filter: ff.filter, why: `${ch.length} changed path(s), all mapped by play.focus` };
}

/** 2.83: is a full run due (rules.focus.fullEveryHours since the last full pass, STUDIO_ENGINE_RULES_FULL, --full)? '' or why. */
export function fullDue(root, engine, cfg, { env = process.env, full = false } = {}) {
  if (!cfg?.focus) return '';
  if (full) return 'a full run was asked for (--full)';
  if (on(env.STUDIO_ENGINE_RULES_FULL)) return 'a full run was asked for (STUDIO_ENGINE_RULES_FULL)';
  const at = Date.parse(readCache(root, engine).lastFullAt || '');
  if (!Number.isFinite(at)) return 'no full pass is recorded yet';
  const h = cfg.focus.fullEveryHours;
  return Date.now() - at >= h * 3600000 ? `the last full pass is older than ${h} h (rules.focus.fullEveryHours)` : '';
}

const cmdKey = (c) => {
  const vars = Object.keys(c.env || {}).sort().map((k) => `${k}=${c.env[k]}`);
  return sha1(`${c.command}\n${c.inputs.join('\n')}${vars.length ? `\nenv:${vars.join('\n')}` : ''}${c.paths?.length ? `\npaths:${c.paths.join('\n')}` : ''}${c.lfs ? '\nlfs' : ''}`);
};
const readCache = (root, engine) => { const j = readJson(rulesFile(root, engine), null); return j && typeof j === 'object' && j.trees && typeof j.trees === 'object' ? j : { trees: {}, runs: [] }; };
function writeCache(root, engine, fn) {
  try {
    const j = readCache(root, engine);
    fn(j);
    fs.mkdirSync(path.dirname(rulesFile(root, engine)), { recursive: true });
    writeAtomic(rulesFile(root, engine), `${JSON.stringify(j, null, 2)}\n`);
  } catch { /* the cache is a saving, never a requirement */ }
}
function keep(root, engine, key, rec) {
  writeCache(root, engine, (j) => {
    j.trees[key] = rec;
    const keys = Object.keys(j.trees);
    for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete j.trees[k];
    j.runs = [...(Array.isArray(j.runs) ? j.runs : []), { at: rec.at, status: rec.status, ms: rec.ms, mode: rec.mode }].slice(-40);
  });
}

/** The median minutes of the last recorded rules runs that ran to the end, or null. */
export function rulesMinutes(root, engine) {
  const runs = (readCache(root, engine).runs || []).filter((r) => ['pass', 'red'].includes(r.status) && r.ms > 0).slice(-12).map((r) => r.ms).sort((a, b) => a - b);
  return runs.length ? Math.round(runs[Math.floor(runs.length / 2)] / 6000) / 10 : null;
}

/** 2.83: the key a result is kept under: the tree (or, with rules.paths, those paths' ids), command, inputs, selection. */
export function rulesKey({ repo, sha, cfg, sel = null, print = '' }) {
  const s = sel || { mode: 'full', filter: '', command: cfg.command };
  let base;
  if (cfg.paths?.length) base = `paths:${sha1(cfg.paths.map((p) => `${p}\0${out(git(repo, 'rev-parse', '--verify', '--quiet', `${sha}:${p}`)) || 'none'}`).join('\n'))}`;
  else base = out(git(repo, 'rev-parse', '--verify', '--quiet', `${sha}^{tree}`));
  return `${base}|${cmdKey({ ...cfg, command: s.command })}${print ? `|${print}` : ''}${s.mode === 'focus' ? `|focus:${sha1(s.filter)}` : ''}`;
}

/**
 * Run the rules check on one commit of the engine repo, in a throwaway checkout (never the land script's worktree, never
 * a lane). { status: 'pass' | 'red' | 'error', why, ms, failures?, tail?, cached?, mode }. 'error': it could not be run or
 * timed out (nobody is blamed). opts: repo, sha, cfg (rulesConfig), from (folders the inputs are copied from), extraFrom
 * (2.83: more folders after those), sel (rulesSelection; default the full command), root, id, env, log, useCache (true).
 */
export function runRulesAt({ engine = 'unity', repo, sha, cfg, from = [], extraFrom = [], sel = null, root = mainRoot(), id = 'rules', env = process.env, log = () => {}, useCache = true } = {}) {
  const tree = out(git(repo, 'rev-parse', '--verify', '--quiet', `${sha}^{tree}`));
  if (!tree) return { status: 'error', why: `${short(sha)} is not a commit of the ${engine} repo`, ms: 0 };
  const src = [...from, ...extraFrom];
  const s = sel || { mode: 'full', filter: '', command: cfg.command };
  const key = rulesKey({ repo, sha, cfg, sel: s, print: inputsPrint(cfg, src) });
  if (useCache) {
    const hit = readCache(root, engine).trees[key];
    if (hit && ['pass', 'red'].includes(hit.status)) return { ...hit, cached: true };
  }
  const dir = path.join(root, '.studio', 'tmp', `rules-${safe(id)}-${short(sha)}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  removeCheckout(repo, dir);
  const co = rulesCheckout({ repo, sha, dir, cfg, env, log, engine });
  if (!co.ok) return { status: 'error', why: `could not check ${short(sha)} out for the rules check: ${co.why}`, ms: 0 };
  const t0 = Date.now();
  try {
    const missing = copyInputs(cfg, src, dir);
    if (missing.length) log(`[engine-rules] ${engine}: input(s) not found in the engine's folder: ${missing.join(', ')} (engines.${engine}.rules.inputs)`);
    log(`[engine-rules] ${engine}: ${s.command} on ${short(sha)}${s.mode === 'focus' ? ' (focus)' : ''}${co.sparse ? ' (sparse checkout)' : ''}`);
    const r = spawnSync(s.command, { shell: true, cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: cfg.timeoutMin * 60000, env: { ...env, ...(cfg.env || {}), STUDIO_ENGINE: engine, STUDIO_RULES_COMMIT: sha, STUDIO_RULES_DIR: dir, STUDIO_ENGINE_REPO: repo, STUDIO_RULES_MODE: s.mode } });
    const ms = Date.now() - t0;
    const text = `${r.stdout || ''}${r.stderr || ''}`.replace(/\r\n?/g, '\n').trimEnd();
    if (r.error) return { status: 'error', why: r.error.code === 'ETIMEDOUT' ? `the rules check timed out after ${cfg.timeoutMin} min (engines.${engine}.rules.timeoutMin)` : `the rules check could not run: ${r.error.code || r.error.message}`, ms, mode: s.mode };
    const rec = r.status === 0
      ? { status: 'pass', why: `the rules check passed (${Math.round(ms / 1000)} s${s.mode === 'focus' ? ', focus' : ''})`, ms, at: new Date().toISOString(), mode: s.mode }
      : { status: 'red', why: `the rules check failed (exit ${r.status ?? r.signal ?? '?'}${s.mode === 'focus' ? ', focus' : ''})`, ms, at: new Date().toISOString(), mode: s.mode, failures: failingTests(text).slice(0, 40), tail: text.split('\n').slice(-12).join('\n') };
    keep(root, engine, key, rec);
    return rec;
  } finally { removeCheckout(repo, dir); }
}

/**
 * The batch check before a land run. lanes: the train's lanes in order ({ task, branch, head }); chain(tip, lanes) ->
 * { head } | { error } builds the commit the batch would land as (unity-train.mjs chainOnTarget). Returns
 * { ran, skipped?, why, kept: [lane], dropped: [{ lane, why, failures }], runs, ms, green?: <commit the kept lanes passed as>,
 * inputs: <inputsPrint when the check began>, mode, filter }.
 * A red batch is narrowed with the same cheap check: the first prefix that is red names its last lane, which is dropped;
 * the rest is checked again. STUDIO_ENGINE_RULES_MAX_RUNS (12) bounds the runs of one batch: past it the lanes left go
 * to the land run unjudged.
 * 2.83: the batch's selection (rulesSelection on the paths it changes against the target) is decided once, and the
 * calibration and every narrowing prefix use that same command. extraFrom: more input folders (the lanes' own), full:
 * force a full run, useCache: false ignores kept results.
 */
export function rulesGate({ engine = 'unity', repo, tip, lanes, chain, cfg, from = [], extraFrom = [], full = false, useCache = true, root = mainRoot(), id = 'rules', env = process.env, log = () => {}, run = runRulesAt } = {}) {
  const src = [...from, ...extraFrom];
  const res = { ran: false, kept: lanes.slice(), dropped: [], runs: 0, ms: 0, why: '', inputs: inputsPrint(cfg, src), mode: 'full', filter: '' };
  if (!cfg) return { ...res, skipped: true, why: 'no rules check is configured' };
  if (!lanes.length) return { ...res, skipped: true, why: 'no lane to check' };
  const maxRuns = Math.max(2, Math.floor(num(env.STUDIO_ENGINE_RULES_MAX_RUNS, 12)));
  // 2.83: the batch as it would land, and what it runs: focused on the systems it changes, or the full command.
  let first = chain(tip, lanes);
  const due = fullDue(root, engine, cfg, { env, full });
  const sel = rulesSelection({ changed: first && !first.error && first.head ? changedPaths(repo, tip, first.head) : null, cfg, full: Boolean(due), fullWhy: due });
  res.mode = sel.mode;
  res.filter = sel.filter.slice(0, 300);
  if (cfg.focus || sel.unchanged) log(`[engine-rules] ${engine}: ${sel.mode} run: ${sel.why}${sel.filter ? ` (${res.filter})` : ''}`);
  const at = (sha) => { const r = run({ engine, repo, sha, cfg, from, extraFrom, sel, root, id, env, log, useCache }); if (!r.cached) { res.runs += 1; res.ms += r.ms || 0; } return r; };
  // The calibration: the landed target must be green in the same kind of checkout (2.83: the same command), or the check judges nobody.
  const base = at(tip);
  if (base.status !== 'pass') {
    return { ...res, skipped: true, calibration: base.status, why: `the rules check is ${base.status === 'red' ? 'red' : 'not runnable'} on the target itself (${base.why}${base.failures?.length ? `: ${base.failures.slice(0, 3).join(', ')}` : ''}), so it judges no lane: fix the target, or name the inputs its tests read in studio/game.json engines.${engine}.rules.inputs` };
  }
  // 2.83: a full pass on the target is the backstop a focused run leans on (rules.focus.fullEveryHours).
  if (sel.mode === 'full' && cfg.focus) writeCache(root, engine, (j) => { j.lastFullAt = new Date().toISOString(); });
  res.ran = true;
  let set = lanes.slice();
  while (set.length) {
    const whole = first || chain(tip, set);
    first = null;
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
    res.dropped.push({ lane: culprit, failures: bad.failures || [], why: `the rules check (${sel.command}) is red with ${culprit.branch}${before.length ? ` on top of ${before.join(' + ')}` : ''}; it is green without it${bad.failures?.length ? `. Failing: ${bad.failures.slice(0, 8).join(', ')}${bad.failures.length > 8 ? ', ...' : ''}` : ''}${bad.tail ? `\n${bad.tail.split('\n').map((x) => `  ${x}`).join('\n')}` : ''}` });
    set = set.filter((l) => l.task !== culprit.task);
  }
  res.kept = set;
  if (!res.why) res.why = res.dropped.length ? `${res.dropped.length} lane(s) refused by the rules check, ${set.length} go to the land run` : `the rules check is green for ${set.map((l) => l.task).join(', ')}`;
  if (sel.mode === 'focus') res.why += ` (focus: ${res.filter})`;
  try { emitEvent({ type: 'engine.rules', agent: env.STUDIO_LOCK_OWNER || 'gates', track: `engine:${engine}`, status: res.dropped.length ? 'warn' : 'ok', msg: `${engine} rules check: ${res.why}`.slice(0, 400), meta: { engine, runs: res.runs, ms: res.ms, kept: set.map((l) => l.task), dropped: res.dropped.map((d) => d.lane.task), green: Boolean(res.green), mode: res.mode, filter: res.filter } }); } catch { /* the check's result stands without its event */ }
  return res;
}

/**
 * The command line. 2.83: an async function, not top-level await: unity-train.mjs imports this module, so awaiting its
 * import at the top level left this module's evaluation unsettled and node exited 13 (B-124).
 */
async function cli(argv) {
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const engine = flag('engine') || 'unity';
  const root = mainRoot();
  const { unityTrainSettings } = await import('./unity-train.mjs');
  const s = unityTrainSettings(root, engine);
  if (s.error) { console.error(`[engine-rules] ${s.message}`); return 1; }
  const ref = flag('ref') || s.target;
  const cfg = rulesConfig(engine, { root, repo: s.repo, ref: s.target });
  if (argv[0] === 'show' || !cfg) {
    if (!cfg) { console.log(`[engine-rules] ${engine}: no rules check (set studio/game.json "engines": { "${engine}": { "rules": "<command>" } }; the owner's file)`); return 0; }
    const vars = Object.keys(cfg.env || {});
    console.log(`[engine-rules] ${engine}: ${cfg.command} (${cfg.source}); inputs: ${cfg.inputs.join(', ') || 'none'}; up to ${cfg.timeoutMin} min; median of recorded runs: ${rulesMinutes(root, engine) ?? 'none yet'} min`);
    // Variable names only: their values may be private.
    console.log(`[engine-rules] env: ${vars.join(', ') || 'none'}; paths: ${cfg.paths.join(', ') || 'the whole tree'}; large files: ${cfg.lfs ? 'checked out' : 'skipped'}; share: ${cfg.share.join(', ') || 'none'}`);
    console.log(`[engine-rules] focus: ${cfg.focus ? `${cfg.focus.test} with ${cfg.focus.map.length} map entr${cfg.focus.map.length === 1 ? 'y' : 'ies'}${cfg.focus.smoke ? `, smoke ${cfg.focus.smoke}` : ''}; a full run every ${cfg.focus.fullEveryHours} h (last full pass: ${readCache(root, engine).lastFullAt || 'none'})` : 'off (every run is the full command)'}`);
    return 0;
  }
  const sha = out(git(s.repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`));
  if (!sha) { console.error(`[engine-rules] ${ref} is not a branch or commit of the ${engine} repo (${s.repo})`); return 1; }
  const tip = out(git(s.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${s.target}^{commit}`));
  const due = fullDue(root, engine, cfg, { full: argv.includes('--full') });
  const sel = rulesSelection({ changed: tip ? changedPaths(s.repo, tip, sha) : null, cfg, full: Boolean(due), fullWhy: due });
  const res = runRulesAt({ engine, repo: s.repo, sha, cfg, sel, from: [s.folder, s.repo].filter(Boolean), root, id: 'cli', log: (m) => console.error(m), useCache: !argv.includes('--fresh') });
  if (argv.includes('--json')) console.log(JSON.stringify({ ...res, mode: sel.mode, filter: sel.filter.slice(0, 300) }));
  else {
    console.log(`[engine-rules] ${res.status.toUpperCase()} ${engine} at ${short(sha)} (${sel.mode}${sel.filter ? `: ${sel.filter.slice(0, 300)}` : ''}): ${res.why}${res.cached ? ' (kept result for this tree)' : ''}`);
    if (res.failures?.length) console.log(`[engine-rules] failing: ${res.failures.join(', ')}`);
    if (res.tail) console.log(`[engine-rules] its last lines:\n${res.tail}`);
  }
  return res.status === 'pass' ? 0 : res.status === 'red' ? 1 : 3;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  cli(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`[engine-rules] ${e?.stack || e}`); process.exit(1); });
}
