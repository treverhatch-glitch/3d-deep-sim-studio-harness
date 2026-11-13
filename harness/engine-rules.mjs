/**
 * harness/engine-rules.mjs — the engine's rules check, run before the long land run.
 *
 * A game's rules in plain code (Unity: a C# assembly with no engine types, `dotnet test`) can be judged without the
 * editor. This runs that cheap check first, on the batch as it would land, and bisects a red batch with it.
 *
 *   studio/game.json (the owner's, protected):
 *     "engines": { "<x>": { "rules": "<command>" } }                      one command, run at the top of a checkout
 *     "engines": { "<x>": { "rules": { "test": "<command>", "inputs": ["<folder>", ...], "timeoutMin": 30 } } }
 *   Default for unity when "rules" is absent: `dotnet test tools/SimTests` when the target branch has that folder.
 *   "rules": false, or STUDIO_ENGINE_RULES=off: no rules check. "inputs": git-ignored files or folders the tests read,
 *   copied into the throwaway checkout. Also "env", "lfs" (true: smudge large files), "paths" (a sparse checkout, and
 *   the kept result's key), "focus" (only the tests of the systems a batch changed, a full run every fullEveryHours),
 *   "share" (shareInputs), "maxLanes", "play.focus". docs/NATIVE-ENGINE.md has the shapes.
 *
 * A batch is judged only after the target itself passed in the same kind of checkout (the calibration); a red target
 * (a missing input or SDK) blames nobody and is skipped with the reason. Results are kept per tree, command and inputs
 * (.studio/engine/<x>-rules.json); the inputs' content is part of the key (inputsPrint).
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

/** Default rules command per engine, used when the target branch has the files it needs. */
const DEFAULTS = { unity: { has: 'tools/SimTests', test: 'dotnet test tools/SimTests' } };

/** Repo-relative paths from the owner's list: forward slashes, none absolute or outside. */
const relList = (list) => (Array.isArray(list) ? list : []).map((x) => String(x || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')).filter((x) => x && !x.startsWith('/') && !/(^|\/)\.\.(\/|$)/.test(x) && !/^[A-Za-z]:/.test(x));

/** The rules check of engine <x>: { command, inputs, timeoutMin, source, env, lfs, paths, focus, share, maxLanes } or null. repo/ref: the engine repo and branch that decide the default. */
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
      ignore: ignoreList(f.ignore),
      split: f.split === true,
    } : null;
  const maxLanes = Math.max(0, Math.floor(num(o.maxLanes, 0)));
  const extra = { env: vars, lfs: o.lfs === true, paths: relList(o.paths), focus: focus?.map.length ? focus : null, share: (Array.isArray(o.share) ? o.share : []).map((x) => String(x ?? '').trim()).filter(Boolean), maxLanes };
  const test = typeof r === 'string' ? r.trim() : typeof o.test === 'string' ? o.test.trim() : '';
  if (test) return { command: withSdk(test), inputs, timeoutMin, source: `studio/game.json engines.${engine}.rules`, ...extra };
  const d = DEFAULTS[engine];
  if (!d || !repo || !ref) return null;
  if (git(repo, 'cat-file', '-e', `${ref}:${d.has}`).status !== 0) return null;
  return { command: withSdk(d.test), inputs, timeoutMin, source: `the ${engine} default (${ref} has ${d.has})`, ...extra };
}

/** The files of one input merged over the folders it is copied from (the first folder with a file wins). { found, files: [[name, abs]] } sorted by name. */
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

/** A fingerprint of the git-ignored inputs ('' with none), over inputFiles' merged view. They are not in the tree, so a kept result and STUDIO_RULES_GREEN are valid only for the same inputs. */
export function inputsPrint(cfg, from = []) {
  if (!cfg?.inputs?.length) return '';
  const h = crypto.createHash('sha1');
  for (const rel of cfg.inputs) {
    const { found, files } = inputFiles(rel, from);
    if (!found) { h.update(`${rel}\0missing\n`); continue; }
    for (const [name, p] of files) {
      let st; try { st = fs.statSync(p); } catch { h.update(`${name}\0gone\n`); continue; }
      h.update(`${name}\0${st.size}\0`);
      // Content for ordinary sizes; a very large file by size and time.
      if (st.size <= 64 * 1024 * 1024) { try { h.update(fs.readFileSync(p)); } catch { h.update('unreadable'); } } else h.update(String(Math.floor(st.mtimeMs)));
    }
  }
  return h.digest('hex').slice(0, 12);
}

/** Copy the merged inputs into a checkout; an existing file is never overwritten. */
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

/** Copy a lane's new shared input files (cfg.share) to <to>: missing files only; an absolute or `..` entry is refused. { copied, skipped: n, refused } */
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
 * The throwaway checkout's git environment and steps. Large files are not smudged unless rules.lfs is true. With
 * rules.paths: `worktree add --no-checkout`, patterns written to the worktree's own info/sparse-checkout, core.sparseCheckout
 * on the command line (`git sparse-checkout set` would change the engine repo's shared config: a lasting change to the owner's repo).
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

/** Make the checkout; a failed sparse one falls back to full. { ok, sparse, why } */
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

/** Repo paths that differ between two commits (renames as delete + add), or null. */
export function changedPaths(repo, a, b) {
  const r = git(repo, '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z', a, b, '--');
  if (r.status !== 0) return null;
  return String(r.stdout || '').split('\0').filter(Boolean);
}

/**
 * What a batch runs. changed: the batch's changed repo paths (null: unknown); full: a full run is forced.
 * { mode: 'focus' | 'full', filter, command, changed, why, unchanged? }. Focus only when every changed path (under
 * rules.paths, when set) matches a rules.focus.map entry (focusFilters). Nothing under paths changed: the full command
 * with `unchanged` (the target's kept result answers).
 */
export function rulesSelection({ changed = [], cfg, full = false, fullWhy = '' } = {}) {
  const paths = cfg?.paths || [];
  const under = (p) => !paths.length || paths.some((x) => p === x || p.startsWith(`${x}/`));
  const ch0 = changed == null ? null : [...new Set(changed.map((p) => String(p || '').replace(/\\/g, '/')).filter(Boolean))].filter(under);
  // rules.focus.ignore paths (Play Mode, UI files) cannot affect the tests: left out before the "does every path map?" test.
  const ig = cfg?.focus && ch0 ? ignoreSplit(ch0, cfg.focus.ignore) : { kept: ch0, ignored: [], bad: [] };
  const ch = ig.kept;
  const more = { ...(ig.ignored.length ? { ignored: ig.ignored } : {}), ...(ig.bad.length ? { ignoreBad: ig.bad } : {}) };
  const fullSel = (why, extra = {}) => ({ mode: 'full', filter: '', command: cfg.command, changed: ch || [], why, ...more, ...extra });
  if (ch && paths.length && !ch0.length) return fullSel('nothing under rules.paths changed: the target\'s kept result answers', { unchanged: true });
  if (!cfg?.focus) return fullSel('no rules.focus');
  // Only ignored paths changed: the smoke filter alone, else the target's kept result.
  if (ch && ch0.length && !ch.length) {
    if (!cfg.focus.smoke) return fullSel(`every changed path matches rules.focus.ignore (${ig.ignored.length}): the target's kept result answers`, { unchanged: true });
    if (!full) return { mode: 'focus', filter: cfg.focus.smoke, command: cfg.focus.test.split('{filter}').join(cfg.focus.smoke), changed: ch, why: `every changed path matches rules.focus.ignore (${ig.ignored.length}): the smoke filter alone`, ...more, ...splitParts(cfg, [cfg.focus.smoke]) };
  }
  if (full) return fullSel(fullWhy || 'a full run was asked for');
  if (!ch) return fullSel('the batch\'s changed paths are not known');
  if (!ch.length) return fullSel('the batch changes no path');
  const ff = focusFilters({ changed: ch, map: cfg.focus.map, smoke: cfg.focus.smoke, join: cfg.focus.join });
  if (!ff.ok) return fullSel(`${ff.unmatched} matches no rules.focus.map entry`);
  return { mode: 'focus', filter: ff.filter, command: cfg.focus.test.split('{filter}').join(ff.filter), changed: ch, why: `${ch.length} changed path(s), all mapped by rules.focus${ig.ignored.length ? ` (${ig.ignored.length} more left out by rules.focus.ignore)` : ''}`, ...more, ...splitParts(cfg, ff.filters) };
}

/** With rules.focus.split, a focused selection runs one command per filter group in sequence (one process holds one system's data). { parts: [{ filter, command }] } or {}. */
function splitParts(cfg, filters = []) {
  if (!cfg?.focus?.split) return {};
  const parts = [...new Set(filters.filter(Boolean))].map((f) => ({ filter: f, command: cfg.focus.test.split('{filter}').join(f) }));
  return parts.length > 1 ? { parts } : {};
}

/** rules.focus.ignore / play.focus.ignore: a list of regex strings; an invalid one is skipped where used (ignoreSplit names it). */
export function ignoreList(v) {
  return (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
}

/** Split changed paths by an ignore list: { kept, ignored, bad (patterns that are not a valid regex) }. */
export function ignoreSplit(changed = [], ignore = []) {
  const res = [];
  const bad = [];
  for (const p of ignore || []) { try { res.push(new RegExp(p)); } catch { bad.push(p); } }
  if (!res.length) return { kept: changed.slice(), ignored: [], bad };
  const kept = [];
  const ignored = [];
  for (const p of changed) (res.some((re) => re.test(p)) ? ignored : kept).push(p);
  return { kept, ignored, bad };
}

/**
 * The focus mapping shared by the rules check and the Play Mode stage. map: [{ match: <regex>, filter }]. Every path must
 * match an entry; the filter has $1..$9 replaced by the regex groups (a group with anything but letters, digits, . _ -
 * makes that entry not match: the filter goes onto a command line). { ok: true, filters, filter } (unique, then smoke,
 * joined) or { ok: false, unmatched: <first unmapped path> }.
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

/** engines.<x>.play.focus = { map, smoke, join (";": the Unity Test Framework's separator), ignore, skip }, or null (not set or unusable). */
export function playFocusConfig(cfg = {}) {
  const f = cfg?.play && typeof cfg.play === 'object' ? cfg.play.focus : null;
  if (!f || typeof f !== 'object') return null;
  const map = (Array.isArray(f.map) ? f.map : []).filter((m) => m && typeof m.match === 'string' && typeof m.filter === 'string').map((m) => ({ match: m.match, filter: m.filter }));
  // play.focus.skip: paths that need no Play Mode run; a config with only skip is usable.
  const skip = ignoreList(f.skip);
  if (!map.length && !skip.length) return null;
  return { map, smoke: typeof f.smoke === 'string' ? f.smoke.trim() : '', join: typeof f.join === 'string' && f.join ? f.join : ';', ignore: ignoreList(f.ignore), skip };
}

/** 2.85: the paths no map entry takes (focusFilters stops at the first), in order. */
export function unmappedPaths(changed = [], map = []) {
  return changed.filter((p) => !focusFilters({ changed: [p], map }).ok);
}

/** The characters a Play Mode filter may hold (it reaches a command line); anything else runs the stage in full. */
export const PLAY_FILTER_SAFE = /^[A-Za-z0-9_.;|~=!()* -]+$/;

/**
 * What the land's Play Mode stage is told (a hint the land script may use; focus is weaker than full). changed: repo
 * paths (null: unknown); full: a full land run. { mode: 'focus' | 'skip' | 'full', filter, why, refused? }. Focus only
 * when every changed path matches a play.focus.map entry and the filter is PLAY_FILTER_SAFE.
 */
export function playSelection({ changed = [], cfg = {}, full = false, fullWhy = '' } = {}) {
  const pf = playFocusConfig(cfg);
  const fullSel = (why, extra = {}) => ({ mode: 'full', filter: '', why, ...extra });
  if (!pf) return fullSel('no play.focus');
  // A full land run never skips, so this stays before play.focus.skip.
  if (full) return fullSel(fullWhy || 'a full land run');
  if (!changed) return fullSel('the batch\'s changed paths are not known');
  const ch0 = [...new Set(changed.map((p) => String(p || '').replace(/\\/g, '/')).filter(Boolean))];
  if (!ch0.length) return fullSel('the batch changes no path');
  // play.focus.ignore, as rules.focus.ignore: only ignored paths changed gives the smoke filter alone, else the full stage.
  const ig = ignoreSplit(ch0, pf.ignore);
  const ch = ig.kept;
  const bad = ig.bad.length ? { ignoreBad: ig.bad } : {};
  if (!ch.length) {
    if (pf.smoke && PLAY_FILTER_SAFE.test(pf.smoke)) return { mode: 'focus', filter: pf.smoke, why: `every changed path matches play.focus.ignore (${ig.ignored.length}): the smoke filter alone`, ignored: ig.ignored, ...bad };
    return fullSel(`every changed path matches play.focus.ignore (${ig.ignored.length}) and there is no smoke filter`, { ignored: ig.ignored, ...bad });
  }
  // Every path left matches play.focus.skip (rules code covered by .NET tests): no Play Mode run; the daily full land run is the backstop.
  if (pf.skip.length) {
    const sk = ignoreSplit(ch, pf.skip);
    for (const b of sk.bad) if (!bad.ignoreBad) bad.ignoreBad = [b]; else if (!bad.ignoreBad.includes(b)) bad.ignoreBad.push(b);
    if (!sk.kept.length && sk.ignored.length) return { mode: 'skip', filter: '', why: `every changed path (${sk.ignored.length}) matches play.focus.skip: no Play Mode run`, ...bad };
  }
  const ff = focusFilters({ changed: ch, map: pf.map, smoke: pf.smoke, join: pf.join });
  if (!ff.ok) {
    // 2.85: name every path no map entry takes (up to 5), so a studio can see what to add to its map; a path that matches
    // play.focus.skip still sends a mixed batch to the full stage (2.84's rule, kept), and is named as such.
    const um = unmappedPaths(ch, pf.map);
    const sk = pf.skip.length ? new Set(ignoreSplit(um, pf.skip).ignored) : new Set();
    const shown = um.slice(0, 5).map((p) => (sk.has(p) ? `${p} (play.focus.skip, in a batch with other paths)` : p));
    return fullSel(`${um.length} changed path(s) match no play.focus.map entry: ${shown.join(', ')}${um.length > 5 ? ', ...' : ''}${pf.map.length ? '' : ' (play.focus has no map)'}`, { unmatched: um.slice(0, 5), unmatchedCount: um.length, ...bad });
  }
  if (!ff.filter) return fullSel('the filter is empty', bad);
  if (!PLAY_FILTER_SAFE.test(ff.filter)) return fullSel(`refused the filter "${ff.filter.slice(0, 120)}": only letters, digits, space and _ . ; | ~ = ! ( ) * - may reach the land command`, { refused: true, ...bad });
  return { mode: 'focus', filter: ff.filter, why: `${ch.length} changed path(s), all mapped by play.focus${ig.ignored.length ? ` (${ig.ignored.length} more left out by play.focus.ignore)` : ''}`, ...bad };
}

/** Is a full run due (fullEveryHours, STUDIO_ENGINE_RULES_FULL, --full)? '' or why. */
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

/** Median minutes of the last recorded runs that ran to the end, or null. */
export function rulesMinutes(root, engine) {
  const runs = (readCache(root, engine).runs || []).filter((r) => ['pass', 'red'].includes(r.status) && r.ms > 0).slice(-12).map((r) => r.ms).sort((a, b) => a - b);
  return runs.length ? Math.round(runs[Math.floor(runs.length / 2)] / 6000) / 10 : null;
}

/** The key a result is kept under: tree (or rules.paths ids), command, inputs, selection. */
export function rulesKey({ repo, sha, cfg, sel = null, print = '' }) {
  const s = sel || { mode: 'full', filter: '', command: cfg.command };
  let base;
  if (cfg.paths?.length) base = `paths:${sha1(cfg.paths.map((p) => `${p}\0${out(git(repo, 'rev-parse', '--verify', '--quiet', `${sha}:${p}`)) || 'none'}`).join('\n'))}`;
  else base = out(git(repo, 'rev-parse', '--verify', '--quiet', `${sha}^{tree}`));
  return `${base}|${cmdKey({ ...cfg, command: s.command })}${print ? `|${print}` : ''}${s.mode === 'focus' ? `|focus:${sha1(s.filter)}` : ''}`;
}

/**
 * Run the rules check on one commit in a throwaway checkout (never the land script's worktree or a lane).
 * { status: 'pass' | 'red' | 'error', why, ms, failures?, tail?, cached?, mode }; 'error' (could not run, or timed out)
 * blames nobody. from / extraFrom: input source folders; sel: default the full command.
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
    const runEnv = { ...env, ...(cfg.env || {}), STUDIO_ENGINE: engine, STUDIO_RULES_COMMIT: sha, STUDIO_RULES_DIR: dir, STUDIO_ENGINE_REPO: repo, STUDIO_RULES_MODE: s.mode };
    // rules.focus.split: one command per group, in sequence; red on the first red. The time limit covers the sequence.
    if (Array.isArray(s.parts) && s.parts.length > 1) {
      const groups = [];
      for (const part of s.parts) {
        const left = cfg.timeoutMin * 60000 - (Date.now() - t0);
        if (left <= 0) return { status: 'error', why: `the rules check timed out after ${cfg.timeoutMin} min (engines.${engine}.rules.timeoutMin), split: ${groups.length} of ${s.parts.length} group(s) done`, ms: Date.now() - t0, mode: s.mode, groups };
        log(`[engine-rules] ${engine}: ${part.command} on ${short(sha)} (focus, group ${groups.length + 1} of ${s.parts.length})${co.sparse ? ' (sparse checkout)' : ''}`);
        const g0 = Date.now();
        const rp = spawnSync(part.command, { shell: true, cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: left, env: runEnv });
        const gs = { filter: part.filter, seconds: Math.round((Date.now() - g0) / 1000), status: rp.error ? 'error' : rp.status === 0 ? 'pass' : 'red' };
        groups.push(gs);
        const text = `${rp.stdout || ''}${rp.stderr || ''}`.replace(/\r\n?/g, '\n').trimEnd();
        if (rp.error) return { status: 'error', why: rp.error.code === 'ETIMEDOUT' ? `the rules check timed out after ${cfg.timeoutMin} min (engines.${engine}.rules.timeoutMin), in group ${part.filter}` : `the rules check could not run: ${rp.error.code || rp.error.message}`, ms: Date.now() - t0, mode: s.mode, groups };
        if (rp.status !== 0) {
          const ms = Date.now() - t0;
          const rec = { status: 'red', why: `the rules check failed (exit ${rp.status ?? rp.signal ?? '?'}, focus, group ${part.filter})`, ms, at: new Date().toISOString(), mode: s.mode, groups, failures: failingTests(text).slice(0, 40), tail: text.split('\n').slice(-12).join('\n') };
          keep(root, engine, key, rec);
          return rec;
        }
      }
      const ms = Date.now() - t0;
      const rec = { status: 'pass', why: `the rules check passed (${Math.round(ms / 1000)} s, focus, ${groups.length} groups)`, ms, at: new Date().toISOString(), mode: s.mode, groups };
      keep(root, engine, key, rec);
      return rec;
    }
    log(`[engine-rules] ${engine}: ${s.command} on ${short(sha)}${s.mode === 'focus' ? ' (focus)' : ''}${co.sparse ? ' (sparse checkout)' : ''}`);
    const r = spawnSync(s.command, { shell: true, cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: cfg.timeoutMin * 60000, env: runEnv });
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
 * { head } | { error } builds the commit the batch would land as (unity-train.mjs chainOnTarget). Returns { ran,
 * skipped?, why, kept, dropped: [{ lane, why, failures }], runs, ms, green? (the commit the kept lanes passed as), inputs, mode, filter }.
 * A red batch is bisected by prefixes: the first red prefix names its last lane, which is dropped.
 * STUDIO_ENGINE_RULES_MAX_RUNS (12) bounds the runs: past it the lanes left go to the land run unjudged.
 */
export function rulesGate({ engine = 'unity', repo, tip, lanes, chain, cfg, from = [], extraFrom = [], full = false, useCache = true, root = mainRoot(), id = 'rules', env = process.env, log = () => {}, run = runRulesAt, slice = null } = {}) {
  const src = [...from, ...extraFrom];
  const res = { ran: false, kept: lanes.slice(), dropped: [], runs: 0, ms: 0, why: '', inputs: inputsPrint(cfg, src), mode: 'full', filter: '' };
  if (!cfg) return { ...res, skipped: true, why: 'no rules check is configured' };
  if (!lanes.length) return { ...res, skipped: true, why: 'no lane to check' };
  // rules.maxLanes (0: off): a bigger batch is checked in slices on the same target, a red slice narrowed within itself.
  // Never "green" for the land run (no STUDIO_RULES_GREEN): the batch was not checked as one tree.
  if (!slice && cfg.maxLanes > 0 && lanes.length > cfg.maxLanes) {
    const n = Math.ceil(lanes.length / cfg.maxLanes);
    const all = { ...res, ran: false, kept: [], sliced: n, slices: [] };
    for (let i = 0; i < n; i += 1) {
      const part = lanes.slice(i * cfg.maxLanes, (i + 1) * cfg.maxLanes);
      log(`[engine-rules] ${engine}: slice ${i + 1} of ${n} (rules.maxLanes ${cfg.maxLanes}): ${part.map((l) => l.task).join(', ')}`);
      const r = rulesGate({ engine, repo, tip, lanes: part, chain, cfg, from, extraFrom, full, useCache, root, id: `${id}-s${i + 1}`, env, log, run, slice: { i: i + 1, n } });
      all.ran = all.ran || r.ran;
      all.runs += r.runs; all.ms += r.ms;
      all.kept.push(...r.kept); all.dropped.push(...r.dropped);
      all.slices.push({ lanes: part.map((l) => l.task), why: r.why, ...(r.skipped ? { skipped: true } : {}), ...(r.groups ? { groups: r.groups } : {}) });
      if (i === 0) { all.mode = r.mode; all.filter = r.filter; }
      else if (r.mode !== all.mode) all.mode = 'mixed';
    }
    if (!all.ran) all.skipped = true;
    all.why = `${n} slices of at most ${cfg.maxLanes} lanes (rules.maxLanes): ${all.dropped.length} lane(s) refused, ${all.kept.length} go to the land run (a sliced check does not tell the land run the rules are green)`;
    return all;
  }
  const maxRuns = Math.max(2, Math.floor(num(env.STUDIO_ENGINE_RULES_MAX_RUNS, 12)));
  let first = chain(tip, lanes);
  const due = fullDue(root, engine, cfg, { env, full });
  const sel = rulesSelection({ changed: first && !first.error && first.head ? changedPaths(repo, tip, first.head) : null, cfg, full: Boolean(due), fullWhy: due });
  res.mode = sel.mode;
  res.filter = sel.filter.slice(0, 300);
  if (cfg.focus || sel.unchanged) log(`[engine-rules] ${engine}: ${sel.mode} run: ${sel.why}${sel.filter ? ` (${res.filter})` : ''}`);
  for (const b of sel.ignoreBad || []) log(`[engine-rules] ${engine}: rules.focus.ignore pattern ${JSON.stringify(b).slice(0, 120)} is not a valid regex; skipped`);
  // rules.focus.split: seconds of each group over this batch's uncached runs.
  const groupSecs = new Map();
  const at = (sha) => {
    const r = run({ engine, repo, sha, cfg, from, extraFrom, sel, root, id, env, log, useCache });
    if (!r.cached) { res.runs += 1; res.ms += r.ms || 0; for (const gr of Array.isArray(r.groups) ? r.groups : []) groupSecs.set(gr.filter, (groupSecs.get(gr.filter) || 0) + (gr.seconds || 0)); }
    return r;
  };
  // The calibration: the target must be green with the same command.
  const base = at(tip);
  if (base.status !== 'pass') {
    return { ...res, skipped: true, calibration: base.status, why: `the rules check is ${base.status === 'red' ? 'red' : 'not runnable'} on the target itself (${base.why}${base.failures?.length ? `: ${base.failures.slice(0, 3).join(', ')}` : ''}), so it judges no lane: fix the target, or name the inputs its tests read in studio/game.json engines.${engine}.rules.inputs` };
  }
  // A full pass on the target is the backstop for focused runs (fullEveryHours).
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
    // The smallest red prefix: its last lane turns the batch red.
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
  if (groupSecs.size) res.groups = [...groupSecs.entries()].map(([filter, seconds]) => ({ filter, seconds }));
  if (!res.why) res.why = res.dropped.length ? `${res.dropped.length} lane(s) refused by the rules check, ${set.length} go to the land run` : `the rules check is green for ${set.map((l) => l.task).join(', ')}`;
  if (sel.mode === 'focus') res.why += ` (focus: ${res.filter})`;
  try { emitEvent({ type: 'engine.rules', agent: env.STUDIO_LOCK_OWNER || 'gates', track: `engine:${engine}`, status: res.dropped.length ? 'warn' : 'ok', msg: `${engine} rules check: ${res.why}`.slice(0, 400), meta: { engine, runs: res.runs, ms: res.ms, kept: set.map((l) => l.task), dropped: res.dropped.map((d) => d.lane.task), green: Boolean(res.green), mode: res.mode, filter: res.filter, ...(res.groups ? { groups: res.groups } : {}), ...(slice ? { slice: `${slice.i}/${slice.n}` } : {}) } }); } catch { /* the check's result stands without its event */ }
  return res;
}

/** The command line. Not top-level await: unity-train.mjs imports this module, so that left evaluation unsettled (node exit 13). */
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
    if (cfg.focus) console.log(`[engine-rules] ignore: ${cfg.focus.ignore.length ? cfg.focus.ignore.map((p) => { try { new RegExp(p); return p; } catch { return `${p} (not a valid regex: skipped)`; } }).join(', ') : 'none'}`);
    return 0;
  }
  const sha = out(git(s.repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`));
  if (!sha) { console.error(`[engine-rules] ${ref} is not a branch or commit of the ${engine} repo (${s.repo})`); return 1; }
  const tip = out(git(s.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${s.target}^{commit}`));
  const due = fullDue(root, engine, cfg, { full: argv.includes('--full') });
  const sel = rulesSelection({ changed: tip ? changedPaths(s.repo, tip, sha) : null, cfg, full: Boolean(due), fullWhy: due });
  for (const b of sel.ignoreBad || []) console.error(`[engine-rules] ${engine}: rules.focus.ignore pattern ${JSON.stringify(b).slice(0, 120)} is not a valid regex; skipped`);
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
