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
 *   "share" (shareInputs), "maxLanes", "play.focus". 2.86: "focus.auto" (one map entry per system folder, derived from
 *   the tree), "focus.shared" (paths every part reads), and with either, results kept per part (partKey).
 *   docs/NATIVE-ENGINE.md has the shapes.
 *
 * A batch is judged only after the target itself passed in the same kind of checkout (the calibration); a red target
 * (a missing input or SDK) blames nobody and is skipped with the reason. Results are kept per tree, command and inputs
 * (.studio/engine/<x>-rules.json); the inputs' content is part of the key (inputsPrint).
 *
 *   node harness/engine-rules.mjs [--engine unity] [--ref <branch|commit>] [--full] [--fresh] [--json]   run it on one commit
 *   node harness/engine-rules.mjs show [--engine unity]                                 the command and where it comes from
 *   node harness/engine-rules.mjs plan --branch <b> [--branch <c>] [--json]              2.86: what a batch's check would run (runs nothing)
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
import { splitPlan } from './rules-parts.mjs';
import { peakFromHistory, readUsedHistory } from './engine-ram.mjs';

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

/** 2.86: a repo-relative path or template: no absolute path, no drive, no `..`. */
const relOk = (s) => Boolean(s) && !s.startsWith('/') && !/^[A-Za-z]:/.test(s) && !s.split('/').includes('..');
/** 2.86: the characters a system's name may hold to reach a filter (the filter goes onto a command line, as focusFilters' groups). */
const NAME_SAFE = /^[A-Za-z0-9._-]+$/;

/**
 * 2.86: rules.focus.auto = { root, paths, filter, filters?, inputs? }, checked. root: a folder whose child folders are the
 * rule systems; paths: templates with {name} (a changed path is the system's when it starts with one, letter case aside);
 * filter: the test filter with {name}; filters: { <name>: <filter> } for a system whose tests are named otherwise;
 * inputs: templates with {name} under rules.inputs (a part's key then holds only its own input files and the unattributed
 * ones). { auto, errors: [plain sentence] }; auto null when absent or bad.
 */
export function autoConfig(a) {
  if (a === undefined || a === null) return { auto: null, errors: [] };
  const bad = (why) => ({ auto: null, errors: [`rules.focus.auto is not usable: ${why}; it is left out (the shape: { "root": "<folder whose child folders are the systems>", "paths": ["<folder>/{name}/", ...], "filter": "<filter with {name}>" })`] });
  if (typeof a !== 'object' || Array.isArray(a)) return bad('it is not an object');
  const norm = (s) => String(s).trim().replace(/\\/g, '/');
  if (typeof a.root !== 'string' || !norm(a.root).replace(/\/+$/, '')) return bad('"root" is missing (a folder in the repo whose child folders are the rule systems)');
  const root = norm(a.root).replace(/\/+$/, '');
  if (!relOk(root)) return bad(`"root" ${JSON.stringify(a.root)} is not a folder inside the repo (no absolute path, no ..)`);
  if (!Array.isArray(a.paths) || !a.paths.length) return bad('"paths" must be a non-empty list of path templates, each with {name}');
  const paths = [];
  for (const p of a.paths) {
    if (typeof p !== 'string' || !p.includes('{name}')) return bad(`the path template ${JSON.stringify(p)} has no {name}`);
    if (!relOk(norm(p))) return bad(`the path template ${JSON.stringify(p)} is not inside the repo (no absolute path, no ..)`);
    paths.push(norm(p));
  }
  if (typeof a.filter !== 'string' || !a.filter.includes('{name}')) return bad('"filter" must be a string with {name} in it (for example "Category={name}")');
  const filters = {};
  if (a.filters !== undefined) {
    if (!a.filters || typeof a.filters !== 'object' || Array.isArray(a.filters)) return bad('"filters" must be an object { "<system>": "<filter>" }');
    for (const [k, v] of Object.entries(a.filters)) {
      if (typeof v !== 'string' || !v.trim()) return bad(`"filters" of ${JSON.stringify(k)} is not a filter string`);
      filters[k.toLowerCase()] = v.trim();
    }
  }
  const inputs = [];
  if (a.inputs !== undefined) {
    if (!Array.isArray(a.inputs)) return bad('"inputs" must be a list of templates with {name}');
    for (const p of a.inputs) {
      if (typeof p !== 'string' || !p.includes('{name}') || !relOk(norm(p))) return bad(`the input template ${JSON.stringify(p)} has no {name} or is not inside the repo`);
      inputs.push(norm(p));
    }
  }
  return { auto: { root, paths, filter: a.filter.trim(), filters, inputs }, errors: [] };
}

/** 2.86: rules.focus.shared, checked: { shared: [repo paths], errors }. */
function sharedList(v) {
  if (v === undefined || v === null) return { shared: [], errors: [] };
  if (!Array.isArray(v)) return { shared: [], errors: ['rules.focus.shared is not usable: it must be a list of folders or files inside the repo; it is left out'] };
  const ok = relList(v);
  const bad = v.filter((x) => typeof x !== 'string' || !ok.includes(String(x).trim().replace(/\\/g, '/').replace(/\/+$/, '')));
  return { shared: ok, errors: bad.length ? [`rules.focus.shared: ${bad.map((x) => JSON.stringify(x)).join(', ')} left out (an entry is a folder or file inside the repo: no absolute path, no ..)`] : [] };
}

const underPath = (p, x) => p === x || p.startsWith(`${x}/`);

/**
 * 2.86: the systems rules.focus.auto finds: the child folders of auto.root in each commit (the target and the batch, so a
 * system the batch adds is one), letter case aside (the batch's spelling first). A folder under rules.focus.shared is not a
 * system; a name a filter cannot carry is left out and listed. { names, skipped }.
 */
export function autoSystems({ repo, shas = [], auto, shared = [] } = {}) {
  const seen = new Map();
  const skipped = [];
  if (!auto || !repo) return { names: [], skipped };
  for (const sha of shas.filter(Boolean)) {
    const r = git(repo, '-c', 'core.quotePath=false', 'ls-tree', '-d', '--name-only', '-z', sha, '--', `${auto.root}/`);
    if (r.status !== 0) continue;
    for (const full of String(r.stdout || '').split('\0').filter(Boolean)) {
      const name = full.slice(auto.root.length + 1);
      if (!name || name.includes('/') || shared.some((x) => underPath(full, x))) continue;
      if (!NAME_SAFE.test(name)) { if (!skipped.includes(name)) skipped.push(name); continue; }
      if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    }
  }
  return { names: [...seen.values()].sort(), skipped };
}

/** 2.86: the auto system a path belongs to (the longest matching template expansion wins: Sim/PaxNav... is PaxNav, not Pax), or null. */
export function autoNameOf(p, auto, names = []) {
  const pl = String(p).toLowerCase();
  let best = null;
  let len = -1;
  for (const t of auto?.paths || []) for (const n of names) {
    const e = t.split('{name}').join(n).toLowerCase();
    if (e.length > len && pl.startsWith(e)) { best = n; len = e.length; }
  }
  return best;
}
const autoFilterOf = (auto, name) => auto.filters?.[name.toLowerCase()] || auto.filter.split('{name}').join(name);
/** 2.86: is a path under auto's root or a template's fixed start (where a system would be)? */
const underAuto = (p, auto) => { const pl = p.toLowerCase(); return [`${auto.root}/`, ...auto.paths.map((t) => t.split('{name}')[0])].some((x) => x && pl.startsWith(x.toLowerCase())); };

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
  // 2.86: rules.focus.auto (one map entry per system folder, derived from the tree) and rules.focus.shared (paths every
  // part reads). A bad one is named in focusBad and left out; the hand-written map still works without it.
  const au = f && typeof f === 'object' ? autoConfig(f.auto) : { auto: null, errors: [] };
  const sh = f && typeof f === 'object' ? sharedList(f.shared) : { shared: [], errors: [] };
  const focusBad = [...au.errors, ...sh.errors];
  const focus = f && typeof f === 'object' && typeof f.test === 'string' && f.test.includes('{filter}') && (Array.isArray(f.map) || au.auto)
    ? {
      test: withSdk(f.test.trim()),
      map: (Array.isArray(f.map) ? f.map : []).filter((m) => m && typeof m.match === 'string' && typeof m.filter === 'string').map((m) => ({ match: m.match, filter: m.filter })),
      ...(au.auto ? { auto: au.auto } : {}),
      ...(sh.shared.length ? { shared: sh.shared } : {}),
      smoke: typeof f.smoke === 'string' ? f.smoke.trim() : '',
      join: typeof f.join === 'string' && f.join ? f.join : '|',
      fullEveryHours: Math.max(0, num(f.fullEveryHours, 24)),
      ignore: ignoreList(f.ignore),
      split: f.split === true,
      // 2.85: how many split parts run at once (null: 1) and the GB one test process is expected to take (null: 4, or the largest measured peak).
      splitMax: Number(f.splitMax) >= 1 ? Math.floor(Number(f.splitMax)) : null,
      splitGb: Number(f.splitGb) > 0 ? Number(f.splitGb) : null,
    } : null;
  const maxLanes = Math.max(0, Math.floor(num(o.maxLanes, 0)));
  if (f && typeof f === 'object' && f.auto !== undefined && !(typeof f.test === 'string' && f.test.includes('{filter}'))) focusBad.push('rules.focus.auto needs rules.focus.test with {filter} in it');
  const extra = { env: vars, lfs: o.lfs === true, paths: relList(o.paths), focus: focus?.map.length || focus?.auto ? focus : null, ...(focusBad.length ? { focusBad } : {}), share: (Array.isArray(o.share) ? o.share : []).map((x) => String(x ?? '').trim()).filter(Boolean), maxLanes };
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
export function rulesSelection({ changed = [], cfg, full = false, fullWhy = '', autoNames = null } = {}) {
  const paths = cfg?.paths || [];
  const under = (p) => !paths.length || paths.some((x) => p === x || p.startsWith(`${x}/`));
  const ch0 = changed == null ? null : [...new Set(changed.map((p) => String(p || '').replace(/\\/g, '/')).filter(Boolean))].filter(under);
  // rules.focus.ignore paths (Play Mode, UI files) cannot affect the tests: left out before the "does every path map?" test.
  const ig = cfg?.focus && ch0 ? ignoreSplit(ch0, cfg.focus.ignore) : { kept: ch0, ignored: [], bad: [] };
  const ch = ig.kept;
  const more = { ...(ig.ignored.length ? { ignored: ig.ignored } : {}), ...(ig.bad.length ? { ignoreBad: ig.bad } : {}) };
  const fullSel = (why, extra = {}) => ({ mode: 'full', filter: '', command: cfg.command, changed: ch || [], why, ...more, ...extra });
  if (ch && paths.length && !ch0.length) return fullSel('nothing under rules.paths changed: the target\'s kept result answers', { unchanged: true });
  if (!cfg?.focus) return fullSel(`no rules.focus${cfg?.focusBad?.length ? ` (${cfg.focusBad[0]})` : ''}`);
  // Only ignored paths changed: the smoke filter alone, else the target's kept result.
  if (ch && ch0.length && !ch.length) {
    if (!cfg.focus.smoke) return fullSel(`every changed path matches rules.focus.ignore (${ig.ignored.length}): the target's kept result answers`, { unchanged: true });
    if (!full) return { mode: 'focus', filter: cfg.focus.smoke, command: cfg.focus.test.split('{filter}').join(cfg.focus.smoke), changed: ch, why: `every changed path matches rules.focus.ignore (${ig.ignored.length}): the smoke filter alone`, filters: [cfg.focus.smoke], sources: {}, ...more, ...splitParts(cfg, [cfg.focus.smoke]) };
  }
  if (full) return fullSel(fullWhy || 'a full run was asked for');
  if (!ch) return fullSel('the batch\'s changed paths are not known');
  if (!ch.length) return fullSel('the batch changes no path');
  // 2.86: a path every part reads (rules.focus.shared) changed: every part's result could change, so a full run.
  const sharedHit = (cfg.focus.shared || []).length ? ch.filter((p) => cfg.focus.shared.some((x) => underPath(p, x))) : [];
  if (sharedHit.length) return fullSel(`${sharedHit.length} changed path(s) under rules.focus.shared (every part reads them): ${sharedHit.slice(0, 5).join(', ')}${sharedHit.length > 5 ? ', ...' : ''}`);
  const auto = cfg.focus.auto && Array.isArray(autoNames) ? cfg.focus.auto : null;
  const ff = focusFilters({ changed: ch, map: cfg.focus.map, smoke: cfg.focus.smoke, join: cfg.focus.join, auto, names: autoNames || [] });
  // 2.85: the why names up to 5 of the unmapped paths, so a studio can extend rules.focus.map.
  if (!ff.ok) {
    const all = ff.unmatchedAll || [ff.unmatched];
    // 2.86: a batch that changes only paths no map entry and no auto root could take (art, UI) runs in full, the safe answer;
    // without rules.paths the check cannot know its tests never read them, so the why names that one setting.
    const unread = !paths.length && all.length === ch.length && !(auto && ch.some((p) => underAuto(p, auto)));
    const hint = unread ? '; none of the changed paths is under a rules.focus.map entry or a rules.focus.auto root: rules.paths is not set, so the check cannot know its tests never read them (list the folders the rules tests read in rules.paths and such a batch skips the check)' : '';
    const badAuto = cfg.focusBad?.length && !auto ? `; ${cfg.focusBad[0]}` : '';
    return fullSel(`${ff.unmatched} matches no rules.focus.map entry${cfg.focus.auto ? ' or rules.focus.auto system' : ''}${all.length > 1 ? ` (${all.length} unmapped paths: ${all.slice(0, 5).join(', ')}${all.length > 5 ? ', ...' : ''})` : ''}${hint}${badAuto}`, { unmapped: all.slice(0, 5), ...(unread ? { pathsHint: true } : {}) });
  }
  return { mode: 'focus', filter: ff.filter, command: cfg.focus.test.split('{filter}').join(ff.filter), changed: ch, why: `${ch.length} changed path(s), all mapped by rules.focus${ig.ignored.length ? ` (${ig.ignored.length} more left out by rules.focus.ignore)` : ''}`, filters: ff.filters, sources: ff.sources, ...more, ...splitParts(cfg, ff.filters) };
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
 * match an entry; the filter has $1..$9 replaced by the regex groups (a group the filter uses with anything but letters,
 * digits, . _ - makes that entry not match: the filter goes onto a command line). { ok: true, filters, filter } (unique, then smoke,
 * joined) or { ok: false, unmatched: <first unmapped path> }.
 */
export function focusFilters({ changed = [], map = [], smoke = '', join = '|', auto = null, names = [] } = {}) {
  const filters = [];
  const unmatchedAll = [];
  // 2.86: which map entries (by index) and auto systems gave each filter: a part's own paths for its kept result.
  const sources = {};
  const src = (f) => (sources[f] ||= { map: [], names: [] });
  for (const p of changed) {
    let hit = false;
    for (const [mi, m] of map.entries()) {
      const f = mapFilterOf(m, p);
      if (!f) continue;
      hit = true;
      if (!filters.includes(f)) filters.push(f);
      if (!src(f).map.includes(mi)) src(f).map.push(mi);
    }
    // 2.86: a path no hand-written entry takes goes to rules.focus.auto (hand-written entries win).
    if (!hit && auto) {
      const n = autoNameOf(p, auto, names);
      if (n) {
        const f = autoFilterOf(auto, n);
        hit = true;
        if (!filters.includes(f)) filters.push(f);
        if (!src(f).names.includes(n)) src(f).names.push(n);
      }
    }
    if (!hit) unmatchedAll.push(p);
  }
  if (unmatchedAll.length) return { ok: false, unmatched: unmatchedAll[0], unmatchedAll };
  if (smoke && !filters.includes(smoke)) filters.push(smoke);
  return { ok: true, filters, filter: filters.join(join), sources };
}

/** The filter one map entry gives a path ('' when it does not take it): $1..$9 from the regex groups, each group safe for a command line. */
function mapFilterOf(m, p) {
  let re; try { re = new RegExp(m.match); } catch { return ''; }
  const g = re.exec(p);
  if (!g) return '';
  const vals = g.slice(1, 10).map((v) => v ?? '');
  // 2.86: only the groups the filter uses reach the command line. A group used for grouping alone, as in
  // "^(Sim/A/|tools/a/)" with a filter that names no $n, holds slashes and made the entry match nothing before.
  const used = [...m.filter.matchAll(/\$([1-9])/g)].map((x) => Number(x[1]) - 1);
  if (used.some((i) => !/^[A-Za-z0-9._-]*$/.test(vals[i] ?? ''))) return '';
  return m.filter.replace(/\$([1-9])/g, (_, i) => vals[Number(i) - 1] ?? '').trim();
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

// ---- 2.86: results kept per part ----
//
// With rules.focus.auto or rules.focus.shared, a focused check is a list of parts (one per filter: a map entry's, an
// auto system's, the smoke filter). A part's green is kept under what the part reads: the blob ids of its own files
// (the files its map entries or auto system take), the tree ids of rules.focus.shared, the command, and its own input
// files when rules.focus.auto.inputs attributes them (else all inputs). The smoke part reads everything: it is keyed by
// the whole tree (or rules.paths), as a whole run is. Only greens are kept; a red is always run again.

const PART_KEEP = 600;
/** Per-part usage is only on with the 2.86 settings: without them the keys and runs are 2.85's. */
export const perPartOn = (cfg) => Boolean(cfg?.focus && (cfg.focus.auto || cfg.focus.shared?.length));

const treeCache = new Map();
/** Every file of a commit as [path, blob id] (cached for a few commits: one ls-tree per commit per check). */
function treeFiles(repo, sha) {
  const k = `${repo}\0${sha}`;
  if (treeCache.has(k)) return treeCache.get(k);
  const r = spawnSync('git', ['-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', sha], { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
  const files = r.status === 0 ? String(r.stdout || '').split('\0').filter(Boolean).map((l) => { const t = l.indexOf('\t'); return [l.slice(t + 1), l.slice(0, t).split(' ')[2]]; }) : null;
  treeCache.set(k, files);
  if (treeCache.size > 6) treeCache.delete(treeCache.keys().next().value);
  return files;
}

/** The files of a commit by the filter that takes them (hand-written map entries first, then auto), as selection does. Map<filter, [path\0id]>. */
function ownersAt(ctx, sha) {
  if (ctx.owners.has(sha)) return ctx.owners.get(sha);
  const by = new Map();
  const files = treeFiles(ctx.repo, sha);
  const add = (f, line) => { if (!by.has(f)) by.set(f, []); by.get(f).push(line); };
  for (const [p, id] of files || []) {
    let hit = false;
    for (const m of ctx.cfg.focus.map) { const f = mapFilterOf(m, p); if (f) { hit = true; add(f, `${p}\0${id}`); } }
    if (!hit && ctx.auto && underAuto(p, ctx.auto)) { const n = autoNameOf(p, ctx.auto, ctx.names); if (n) add(autoFilterOf(ctx.auto, n), `${p}\0${id}`); }
  }
  const res = files ? by : null;
  ctx.owners.set(sha, res);
  return res;
}

/** The input files' digests, once per check: [{ rel, name, digest }] plus missing inputs as { rel, missing }. */
function inputIndex(cfg, src) {
  const list = [];
  for (const rel of cfg?.inputs || []) {
    const { found, files } = inputFiles(rel, src);
    if (!found) { list.push({ rel, missing: true }); continue; }
    for (const [name, p] of files) {
      const h = crypto.createHash('sha1');
      let st; try { st = fs.statSync(p); } catch { list.push({ rel, name, digest: 'gone' }); continue; }
      h.update(`${st.size}\0`);
      if (st.size <= 64 * 1024 * 1024) { try { h.update(fs.readFileSync(p)); } catch { h.update('unreadable'); } } else h.update(String(Math.floor(st.mtimeMs)));
      list.push({ rel, name, digest: h.digest('hex') });
    }
  }
  return list;
}

/**
 * A check's context for part keys: { repo, cfg, auto, names, owners, inputs }. names: the auto systems (autoSystems).
 */
export function partContext({ repo, cfg, names = [], src = [] } = {}) {
  return { repo, cfg, auto: cfg?.focus?.auto || null, names, owners: new Map(), inputs: inputIndex(cfg, src) };
}

/** The parts of a focused selection: [{ filter, command, smoke, map: [index], names: [system] }]. */
export function selectionParts(sel, cfg) {
  const fs0 = Array.isArray(sel?.filters) && sel.filters.length ? sel.filters : sel?.filter ? [sel.filter] : [];
  return [...new Set(fs0.filter(Boolean))].map((f) => {
    const s = sel.sources?.[f] || { map: [], names: [] };
    return { filter: f, command: cfg.focus.test.split('{filter}').join(f), smoke: f === cfg.focus.smoke /* it reads everything, whatever entry names it */, map: s.map.slice(), names: s.names.slice() };
  });
}

/** { key, exists } of one part at a commit. exists: the part has files there (false: a system the commit does not have yet). */
export function partKey(ctx, sha, part) {
  const { repo, cfg } = ctx;
  let own;
  let exists = true;
  if (part.smoke || (!part.map.length && !part.names.length)) own = `all:${rulesKey({ repo, sha, cfg, sel: { mode: 'full', filter: '', command: '' } }).split('|')[0]}`;
  else {
    const by = ownersAt(ctx, sha);
    if (!by) return { key: null, exists: false };
    const lines = by.get(part.filter) || [];
    exists = lines.length > 0;
    own = `own:${sha1(lines.join('\n'))}`;
  }
  const shared = (cfg.focus.shared || []).map((p) => `${p}\0${out(git(repo, 'rev-parse', '--verify', '--quiet', `${sha}:${p}`)) || 'none'}`).join('\n');
  // Inputs: only the part's own (auto.inputs) and the unattributed, else all of them.
  const tpl = ctx.auto?.inputs || [];
  const attributed = tpl.length && !part.smoke && !part.map.length && part.names.length;
  const ins = ctx.inputs.filter((x) => {
    if (!attributed || x.missing) return true;
    const owner = autoNameOf(x.name, { paths: tpl }, ctx.names);
    return !owner || part.names.some((n) => n.toLowerCase() === owner.toLowerCase());
  }).map((x) => (x.missing ? `${x.rel}\0missing` : `${x.name}\0${x.digest}`));
  return { key: `part:${sha1(part.filter)}|${own}|shared:${sha1(shared)}|${cmdKey({ ...cfg, command: part.command })}|in:${sha1(ins.join('\n'))}`, exists };
}

/** A part's kept green at a key, or null. */
export function keptPart(root, engine, key) {
  const hit = key ? readCache(root, engine).parts?.[key] : null;
  return hit && hit.status === 'pass' ? hit : null;
}
/** The last measured seconds and GB of each part filter: { <filter>: { seconds, gb?, at } }. */
export const partStats = (root, engine) => readCache(root, engine).partStats || {};

/** Keep parts' greens (bounded) and their measurements. list: [{ key, filter, seconds, gb? }]. */
function keepParts(root, engine, list) {
  if (!list.length) return;
  writeCache(root, engine, (j) => {
    j.parts = j.parts && typeof j.parts === 'object' ? j.parts : {};
    j.partStats = j.partStats && typeof j.partStats === 'object' ? j.partStats : {};
    const at = new Date().toISOString();
    for (const x of list) {
      if (x.key) { delete j.parts[x.key]; j.parts[x.key] = { status: 'pass', at, filter: x.filter, ...(Number.isFinite(x.seconds) ? { seconds: x.seconds } : {}) }; }
      if (Number.isFinite(x.seconds)) { const gb0 = j.partStats[x.filter]?.gb; delete j.partStats[x.filter]; j.partStats[x.filter] = { seconds: x.seconds, ...(Number(x.gb) > 0 ? { gb: x.gb } : gb0 ? { gb: gb0 } : {}), at }; }
    }
    const keys = Object.keys(j.parts);
    for (const k of keys.slice(0, Math.max(0, keys.length - PART_KEEP))) delete j.parts[k];
    const fk = Object.keys(j.partStats);
    for (const k of fk.slice(0, Math.max(0, fk.length - 300))) delete j.partStats[k];
  });
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
export function runRulesAt({ engine = 'unity', repo, sha, cfg, from = [], extraFrom = [], sel = null, root = mainRoot(), id = 'rules', env = process.env, log = () => {}, useCache = true, freeGb = null } = {}) {
  const tree = out(git(repo, 'rev-parse', '--verify', '--quiet', `${sha}^{tree}`));
  if (!tree) return { status: 'error', why: `${short(sha)} is not a commit of the ${engine} repo`, ms: 0 };
  const src = [...from, ...extraFrom];
  const s = sel || { mode: 'full', filter: '', command: cfg.command };
  const key = rulesKey({ repo, sha, cfg, sel: s, print: inputsPrint(cfg, src) });
  if (useCache) {
    const hit = readCache(root, engine).trees[key];
    // 2.86: a kept whole pass of these parts is each part's green too.
    if (hit?.status === 'pass' && s.partKeys) keepParts(root, engine, Object.entries(s.partKeys).map(([filter, k]) => ({ key: k, filter })));
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
    // rules.focus.split: one command per group. 2.85: how many run at once is decided by free RAM (harness/rules-parts.mjs): at least
    // one, more only while free RAM - the floor holds another splitGb, never over rules.focus.splitMax (unset: 1, in sequence).
    // Red on the first red (its output kept). The time limit covers the whole.
    if (Array.isArray(s.parts) && s.parts.length > 1) {
      const plan = splitPlan(cfg.focus || {}, { root, engine, env });
      const timedOut = (n, filter) => `the rules check timed out after ${cfg.timeoutMin} min (engines.${engine}.rules.timeoutMin), ${filter ? `in group ${filter}` : `split: ${n} of ${s.parts.length} group(s) done`}`;
      const finish = (groups, texts, splitAtOnce) => {
        const ms = Date.now() - t0;
        // 2.86: each green part is kept under its own key (s.partKeys), also when a later part is red.
        if (s.partKeys) keepParts(root, engine, groups.filter((gr) => gr.status === 'pass' && s.partKeys[gr.filter]).map((gr) => ({ key: s.partKeys[gr.filter], filter: gr.filter, seconds: gr.seconds, ...(gr.gb ? { gb: gr.gb } : {}) })));
        const redAt = groups.findIndex((gr) => gr.status === 'red');
        if (redAt >= 0) {
          const part = s.parts.find((x) => x.filter === groups[redAt].filter) || s.parts[redAt];
          const text = texts[redAt] || '';
          const rec = { status: 'red', why: `the rules check failed (exit ${groups[redAt].code ?? '?'}, focus, group ${part.filter})`, ms, at: new Date().toISOString(), mode: s.mode, groups: groups.map(({ code, ...gr }) => gr), splitAtOnce, part: { filter: part.filter, command: part.command }, failures: failingTests(text).slice(0, 40), tail: text.split('\n').slice(-12).join('\n') };
          keep(root, engine, key, rec);
          return rec;
        }
        const rec = { status: 'pass', why: `the rules check passed (${Math.round(ms / 1000)} s, focus, ${groups.length} groups${splitAtOnce > 1 ? `, up to ${splitAtOnce} at once` : ''})`, ms, at: new Date().toISOString(), mode: s.mode, groups: groups.map(({ code, ...gr }) => gr), splitAtOnce };
        keep(root, engine, key, rec);
        return rec;
      };
      let ran = null;
      if (plan.max > 1) {
        const job = { parts: s.parts, cwd: dir, env: runEnv, timeoutMs: cfg.timeoutMin * 60000, max: plan.max, gb: plan.gb, floorGb: plan.floorGb, ...(typeof freeGb === 'function' && Number.isFinite(Number(freeGb())) ? { freeGb: Number(freeGb()) } : {}) };
        log(`[engine-rules] ${engine}: split of ${s.parts.length} part(s) on ${short(sha)}: ${plan.why}`);
        const w = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'rules-parts.mjs')], { input: JSON.stringify(job), encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: cfg.timeoutMin * 60000 + 30000 });
        try { ran = JSON.parse(String(w.stdout || '').trim().split('\n').pop()); } catch { ran = null; }
        if (!ran) log(`[engine-rules] ${engine}: the parallel runner gave no result (${lastLine(w) || `exit ${w.status}`}); the parts run in sequence`);
        else {
          for (const d of ran.decisions || []) log(`[engine-rules] ${engine}: ${d}`);
          const rs = ran.results.map((r) => r).filter(Boolean);
          const groups = rs.map((r) => ({ filter: r.filter, seconds: r.seconds, status: r.status === 'error' ? 'error' : r.status, code: r.code }));
          const bad = rs.find((r) => r.status === 'error');
          if (bad) return { status: 'error', why: bad.timedOut ? timedOut(rs.filter((r) => r.status === 'pass').length, bad.filter) : `the rules check could not run: ${bad.errorCode || bad.why || '?'}`, ms: Date.now() - t0, mode: s.mode, groups: groups.map(({ code, ...gr }) => gr), splitAtOnce: ran.atOnce };
          return finish(groups, ran.results.map((r) => String(r?.text || '').replace(/\r\n?/g, '\n').trimEnd()), ran.atOnce);
        }
      }
      // One at a time (splitMax 1 or unset, the 2.84 way).
      log(`[engine-rules] ${engine}: split of ${s.parts.length} part(s) on ${short(sha)}: one at a time (${plan.max > 1 ? 'the parallel runner failed' : 'rules.focus.splitMax is not set or 1'})`);
      const groups = [];
      const texts = [];
      for (const part of s.parts) {
        const left = cfg.timeoutMin * 60000 - (Date.now() - t0);
        if (left <= 0) return { status: 'error', why: timedOut(groups.length), ms: Date.now() - t0, mode: s.mode, groups, splitAtOnce: 1 };
        log(`[engine-rules] ${engine}: ${part.command} on ${short(sha)} (focus, group ${groups.length + 1} of ${s.parts.length})${co.sparse ? ' (sparse checkout)' : ''}`);
        const g0 = Date.now();
        const rp = spawnSync(part.command, { shell: true, cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: left, env: runEnv });
        const gs = { filter: part.filter, seconds: Math.round((Date.now() - g0) / 1000), status: rp.error ? 'error' : rp.status === 0 ? 'pass' : 'red', code: rp.status ?? rp.signal };
        // 2.86: one part at a time, so the machine monitor's samples while it ran are its own peak (none: nothing is guessed).
        if (s.partKeys) { const gb = peakFromHistory(readUsedHistory(root), g0, Date.now()); if (gb > 0) gs.gb = gb; }
        groups.push(gs);
        texts.push(`${rp.stdout || ''}${rp.stderr || ''}`.replace(/\r\n?/g, '\n').trimEnd());
        if (rp.error) return { status: 'error', why: rp.error.code === 'ETIMEDOUT' ? timedOut(0, part.filter) : `the rules check could not run: ${rp.error.code || rp.error.message}`, ms: Date.now() - t0, mode: s.mode, groups: groups.map(({ code, ...gr }) => gr), splitAtOnce: 1 };
        if (rp.status !== 0) return finish(groups, texts, 1);
      }
      return finish(groups, texts, 1);
    }
    log(`[engine-rules] ${engine}: ${s.command} on ${short(sha)}${s.mode === 'focus' ? ' (focus)' : ''}${co.sparse ? ' (sparse checkout)' : ''}`);
    const r = spawnSync(s.command, { shell: true, cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: cfg.timeoutMin * 60000, env: runEnv });
    const ms = Date.now() - t0;
    const text = `${r.stdout || ''}${r.stderr || ''}`.replace(/\r\n?/g, '\n').trimEnd();
    if (r.error) return { status: 'error', why: r.error.code === 'ETIMEDOUT' ? `the rules check timed out after ${cfg.timeoutMin} min (engines.${engine}.rules.timeoutMin)` : `the rules check could not run: ${r.error.code || r.error.message}`, ms, mode: s.mode };
    // 2.86: one joined command that passed passed every part in it.
    if (r.status === 0 && s.partKeys) { const ks = Object.entries(s.partKeys); const gb = ks.length === 1 ? peakFromHistory(readUsedHistory(root), t0, Date.now()) : null; keepParts(root, engine, ks.map(([filter, k]) => ({ key: k, filter, ...(ks.length === 1 ? { seconds: Math.round(ms / 1000), ...(gb > 0 ? { gb } : {}) } : {}) }))); }
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
      if (r.splitAtOnce) all.splitAtOnce = Math.max(all.splitAtOnce || 0, r.splitAtOnce);
      if (r.selWhy) all.selWhy = all.selWhy ? `${all.selWhy}; ${r.selWhy}`.slice(0, 400) : r.selWhy;
      all.parts = (all.parts || 0) + (r.parts || 0);
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
  const headOk = first && !first.error && first.head;
  // 2.86: the systems rules.focus.auto finds on the target and in the batch (a system the batch adds is one).
  const sys = cfg.focus?.auto ? autoSystems({ repo, shas: [headOk ? first.head : null, tip], auto: cfg.focus.auto, shared: cfg.focus.shared || [] }) : null;
  for (const b of cfg.focusBad || []) log(`[engine-rules] ${engine}: ${b}`);
  if (sys?.skipped.length) log(`[engine-rules] ${engine}: rules.focus.auto: folder(s) ${sys.skipped.slice(0, 5).join(', ')} under ${cfg.focus.auto.root} are not systems (a name may hold only letters, digits, . _ -)`);
  const sel = rulesSelection({ changed: headOk ? changedPaths(repo, tip, first.head) : null, cfg, full: Boolean(due), fullWhy: due, autoNames: sys ? sys.names : null });
  res.mode = sel.mode;
  res.filter = sel.filter.slice(0, 300);
  res.selWhy = String(sel.why || '').slice(0, 400);
  res.parts = Array.isArray(sel.parts) ? sel.parts.length : 1;
  if (cfg.focus || sel.unchanged) log(`[engine-rules] ${engine}: ${sel.mode} run: ${sel.why}${sel.filter ? ` (${res.filter})` : ''}`);
  for (const b of sel.ignoreBad || []) log(`[engine-rules] ${engine}: rules.focus.ignore pattern ${JSON.stringify(b).slice(0, 120)} is not a valid regex; skipped`);
  // rules.focus.split: seconds of each group over this batch's uncached runs.
  const groupSecs = new Map();
  // 2.86: results kept per part (perPartOn): a part with a kept green at a commit is not run there again.
  const perPart = perPartOn(cfg) && sel.mode === 'focus';
  const ctx = perPart ? partContext({ repo, cfg, names: sys?.names || [], src }) : null;
  const allParts = perPart ? selectionParts(sel, cfg) : [];
  if (perPart) res.parts = allParts.length;
  res.reused = 0;
  const subSel = (ps) => {
    const filter = ps.map((p) => p.filter).join(cfg.focus.join);
    return { ...sel, filter, filters: ps.map((p) => p.filter), command: cfg.focus.test.split('{filter}').join(filter), parts: undefined, ...splitParts(cfg, ps.map((p) => p.filter)) };
  };
  const atParts = (sha, ps, what) => {
    const todo = [];
    const keys = {};
    for (const p of ps) {
      const k = partKey(ctx, sha, p);
      if (useCache && keptPart(root, engine, k.key)) { res.reused += 1; log(`[engine-rules] ${engine}: rules part ${p.filter} pass kept for ${short(sha)} (${what}; a kept green of what this part reads: not run again)`); continue; }
      todo.push(p);
      if (k.key) keys[p.filter] = k.key;
    }
    if (!todo.length) return { status: 'pass', why: `every part has a kept green (${ps.length})`, cached: true, mode: 'focus', allKept: true };
    const r = run({ engine, repo, sha, cfg, from, extraFrom, sel: { ...subSel(todo), partKeys: keys }, root, id, env, log, useCache });
    // One part run alone is named as the red part (a run of several parts names its own red group when split).
    return r.status === 'red' && !r.part && todo.length === 1 ? { ...r, part: { filter: todo[0].filter, command: todo[0].command } } : r;
  };
  const at = (sha, ps = null, what = 'the batch') => {
    const r = perPart ? atParts(sha, ps || allParts, what) : run({ engine, repo, sha, cfg, from, extraFrom, sel, root, id, env, log, useCache });
    if (r.allKept) return r;
    // 2.85: a kept result is said in the log (a restarted train reusing a green tree is not a silent skip).
    if (r.cached) log(`[engine-rules] ${engine}: rules ${r.status} cached for ${short(sha)} (${r.mode || sel.mode}, kept result of this tree: not run again)`);
    if (Number(r.splitAtOnce) > 0) res.splitAtOnce = Math.max(res.splitAtOnce || 0, Number(r.splitAtOnce));
    if (!r.cached) { res.runs += 1; res.ms += r.ms || 0; for (const gr of Array.isArray(r.groups) ? r.groups : []) groupSecs.set(gr.filter, (groupSecs.get(gr.filter) || 0) + (gr.seconds || 0)); }
    return r;
  };
  // The calibration: the target must be green with the same command. 2.86: per part, only the parts the target has
  // (a system the batch adds has no tests on the target to calibrate) and that have no kept green there.
  let base;
  if (perPart) {
    const onTip = allParts.filter((p) => partKey(ctx, tip, p).exists);
    const fresh = allParts.filter((p) => !onTip.includes(p));
    if (fresh.length) log(`[engine-rules] ${engine}: rules part(s) ${fresh.map((p) => p.filter).join(', ')} are new in the batch (the target has none of their files): not run on the target`);
    res.newParts = fresh.length;
    base = onTip.length ? at(tip, onTip, 'the target') : { status: 'pass', why: 'every part is new in the batch: nothing to calibrate', allKept: true };
  } else base = at(tip);
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
    // 2.86: per part, a prefix runs only the red part's filter (the other parts were green on the whole batch).
    const redPart = perPart && r.part?.filter ? allParts.filter((p) => p.filter === r.part.filter) : null;
    while (hi - lo > 1) {
      if (res.runs >= maxRuns) { stuck = true; break; }
      const mid = Math.floor((lo + hi) / 2);
      const part = chain(tip, set.slice(0, mid));
      if (part.error || !part.head) { stuck = true; break; }
      const rm = at(part.head, redPart?.length ? redPart : null, `narrowing ${redPart?.length ? `part ${redPart[0].filter}` : 'the batch'}`);
      if (rm.status === 'pass') lo = mid;
      else if (rm.status === 'red') { hi = mid; bad = rm; } else { stuck = true; break; }
    }
    if (stuck) { res.why = `the rules check is red for ${set.map((l) => l.task).join(' + ')} and could not be narrowed: the land run decides`; break; }
    const culprit = set[hi - 1];
    const before = set.slice(0, hi - 1).map((l) => l.task);
    res.dropped.push({ lane: culprit, failures: bad.failures || [], part: bad.part?.filter || null, why: `the rules check (${bad.part ? `${bad.part.command}, part ${bad.part.filter} of ${res.parts}` : sel.command}${slice ? `, slice ${slice.i} of ${slice.n}` : ''}) is red with ${culprit.branch}${before.length ? ` on top of ${before.join(' + ')}` : ''}; it is green without it${bad.failures?.length ? `. Failing${bad.part ? ` in part ${bad.part.filter}` : ''}: ${bad.failures.slice(0, 8).join(', ')}${bad.failures.length > 8 ? ', ...' : ''}` : bad.part ? `. Part ${bad.part.filter} failed; no test name was read from its output` : ''}${bad.tail ? `\n${bad.tail.split('\n').map((x) => `  ${x}`).join('\n')}` : ''}` });
    set = set.filter((l) => l.task !== culprit.task);
  }
  res.kept = set;
  if (groupSecs.size) res.groups = [...groupSecs.entries()].map(([filter, seconds]) => ({ filter, seconds }));
  if (!res.why) res.why = res.dropped.length ? `${res.dropped.length} lane(s) refused by the rules check, ${set.length} go to the land run` : `the rules check is green for ${set.map((l) => l.task).join(', ')}`;
  if (sel.mode === 'focus') res.why += ` (focus: ${res.filter})`;
  try { emitEvent({ type: 'engine.rules', agent: env.STUDIO_LOCK_OWNER || 'gates', track: `engine:${engine}`, status: res.dropped.length ? 'warn' : 'ok', msg: `${engine} rules check: ${res.why}`.slice(0, 400), meta: { engine, runs: res.runs, ms: res.ms, kept: set.map((l) => l.task), dropped: res.dropped.map((d) => d.lane.task), green: Boolean(res.green), mode: res.mode, why: res.selWhy, parts: res.parts, ...(perPart ? { reused: res.reused, newParts: res.newParts || 0 } : {}), splitAtOnce: res.splitAtOnce || 1, filter: res.filter, ...(res.groups ? { groups: res.groups } : {}), ...(slice ? { slice: `${slice.i}/${slice.n}` } : {}) } }); } catch { /* the check's result stands without its event */ }
  return res;
}

/**
 * 2.86: what the rules check of a batch would do, without running anything (`npm run engine -- rules-plan --branch b
 * [--branch c]`): full or focus and why, the parts, which have a kept green on the target and on the batch, which are new
 * in the batch, and the minutes the recorded runs suggest. The batch is built as the train builds it (commit objects
 * only: no ref moves, no checkout). { engine, target, tip, head, branches, selection, parts, minutes, ... } or { error, message }.
 */
export async function rulesPlan(root, { engine = 'unity', branches = [], env = process.env } = {}) {
  const { unityTrainSettings, chainOnTarget } = await import('./unity-train.mjs');
  const s = unityTrainSettings(root, engine);
  if (s.error) return { error: s.error, message: s.message };
  if (!branches.length) return { error: 'usage', message: 'Which batch? Pass --branch <name> (as many as the batch has).' };
  const cfg = rulesConfig(engine, { root, env, repo: s.repo, ref: s.target });
  if (!cfg) return { error: 'no-rules', message: `No rules check is configured for ${engine} (studio/game.json engines.${engine}.rules).` };
  const tip = out(git(s.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${s.target}^{commit}`));
  if (!tip) return { error: 'no-target', message: `The ${engine} repo has no branch ${s.target}.` };
  const lanes = [];
  for (const b of branches) {
    const head = out(git(s.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}^{commit}`));
    if (!head) return { error: 'no-branch', message: `The ${engine} repo has no branch ${b}.` };
    lanes.push({ task: b, branch: b, head });
  }
  const c = chainOnTarget(s.repo, tip, lanes, 'rules-plan', engine);
  if (c.error || !c.head) return { error: 'chain', message: `The batch could not be built: ${c.error || 'no head'}` };
  const left = [...c.conflictTarget, ...c.deferred].map((l) => `${l.branch} (${l.why})`);
  const due = fullDue(root, engine, cfg, { env });
  const sys = cfg.focus?.auto ? autoSystems({ repo: s.repo, shas: [c.head, tip], auto: cfg.focus.auto, shared: cfg.focus.shared || [] }) : null;
  const sel = rulesSelection({ changed: changedPaths(s.repo, tip, c.head), cfg, full: Boolean(due), fullWhy: due, autoNames: sys ? sys.names : null });
  const from = [...new Set([s.folder, s.cfg.gateWorktree ? path.resolve(root, s.cfg.gateWorktree) : null, s.cfg.cwd ? path.resolve(root, s.cfg.cwd) : null, s.repo].filter(Boolean))];
  const median = rulesMinutes(root, engine);
  const res = { engine, target: s.target, tip, head: c.head, branches: c.included.map((l) => l.branch), left, selection: { mode: sel.mode, filter: sel.filter, why: sel.why, unmapped: sel.unmapped || [], pathsHint: Boolean(sel.pathsHint) }, focusBad: cfg.focusBad || [], perPart: false, parts: [], minutes: null };
  const plan = cfg.focus ? splitPlan(cfg.focus, { root, engine, env }) : null;
  if (sel.mode === 'focus' && perPartOn(cfg)) {
    res.perPart = true;
    const ctx = partContext({ repo: s.repo, cfg, names: sys?.names || [], src: from });
    const stats = partStats(root, engine);
    let secs = 0;
    let unknown = 0;
    for (const p of selectionParts(sel, cfg)) {
      const t = partKey(ctx, tip, p);
      const h = partKey(ctx, c.head, p);
      const st = stats[p.filter] || null;
      const onTarget = !t.exists ? 'new in the batch: not run on the target' : keptPart(root, engine, t.key) ? 'kept green' : 'runs';
      const onBatch = keptPart(root, engine, h.key) ? 'kept green' : 'runs';
      const runs = (onTarget === 'runs' ? 1 : 0) + (onBatch === 'runs' ? 1 : 0);
      if (runs) { if (st?.seconds) secs += runs * st.seconds; else unknown += runs; }
      res.parts.push({ filter: p.filter, target: onTarget, batch: onBatch, ...(st?.seconds ? { seconds: st.seconds } : {}), ...(st?.gb ? { gb: st.gb } : {}), ...(st?.gb && plan && st.gb > plan.gb ? { overGb: plan.gb } : {}) });
    }
    res.minutes = unknown ? null : Math.round(secs / 6) / 10;
    res.unknownRuns = unknown;
  } else {
    // A whole run: the target's kept result (this tree, command, inputs) answers its half.
    const print = inputsPrint(cfg, from);
    const s0 = sel.mode === 'focus' ? sel : null;
    const kTip = readCache(root, engine).trees[rulesKey({ repo: s.repo, sha: tip, cfg, sel: s0, print })];
    const kHead = readCache(root, engine).trees[rulesKey({ repo: s.repo, sha: c.head, cfg, sel: s0, print })];
    const runs = (kTip?.status === 'pass' ? 0 : 1) + (kHead && ['pass', 'red'].includes(kHead.status) ? 0 : 1);
    res.targetKept = kTip?.status === 'pass';
    res.batchKept = Boolean(kHead && ['pass', 'red'].includes(kHead.status));
    res.parts = (Array.isArray(sel.parts) ? sel.parts : [{ filter: sel.filter || '(all)' }]).map((p) => ({ filter: p.filter }));
    res.minutes = median === null ? null : Math.round(runs * median * 10) / 10;
    res.runs = runs;
  }
  res.median = median;
  return res;
}

export function rulesPlanText(r) {
  const sel = r.selection;
  const L = [`Rules check plan for ${r.branches.join(' + ') || 'no branch'} on ${r.target} at ${short(r.tip)}: ${sel.mode}${sel.mode === 'focus' ? ` (${sel.filter.slice(0, 200)})` : ''}`, `  why: ${sel.why}`];
  for (const b of r.focusBad) L.push(`  setting problem: ${b}`);
  if (r.left.length) L.push(`  not in this batch: ${r.left.join('; ')}`);
  if (r.perPart) {
    L.push(`  parts (${r.parts.length}), results kept per part:`);
    for (const p of r.parts) L.push(`    ${p.filter}: target ${p.target}; batch ${p.batch}${p.seconds ? `; last ${Math.round(p.seconds / 6) / 10} min` : ''}${p.gb ? `; peak ${p.gb} GB` : ''}${p.overGb ? ` (over the ${p.overGb} GB a part is planned for: rules.focus.splitGb)` : ''}`);
    L.push(`  expected: ${r.minutes === null ? `unknown (${r.unknownRuns} part run(s) with no recorded time)` : `about ${r.minutes} min`} of rules check before the land run`);
  } else {
    L.push(`  ${r.parts.length > 1 ? `parts (${r.parts.length}): ${r.parts.map((p) => p.filter).join(', ')}` : 'one run per commit'}; target: ${r.targetKept ? 'kept green' : 'runs'}; batch: ${r.batchKept ? 'kept result' : 'runs'}`);
    L.push(`  expected: ${r.minutes === null ? 'unknown (no recorded run yet)' : `about ${r.minutes} min (${r.runs} run(s) at the ${r.median} min median of recorded runs)`}`);
  }
  L.push('  (nothing was run; a red batch adds runs to find the branch)');
  return L.join('\n');
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
  // 2.86: `plan --branch b [--branch c] [--json]`: what the check of that batch would do; runs nothing.
  if (argv[0] === 'plan') {
    const branches = argv.flatMap((a, i) => (a === '--branch' && argv[i + 1] ? [argv[i + 1]] : []));
    const r = await rulesPlan(root, { engine, branches });
    if (argv.includes('--json')) console.log(JSON.stringify(r));
    else console.log(r.error ? r.message : rulesPlanText(r));
    return r.error ? 1 : 0;
  }
  const cfg = rulesConfig(engine, { root, repo: s.repo, ref: s.target });
  if (argv[0] === 'show' || !cfg) {
    if (!cfg) { console.log(`[engine-rules] ${engine}: no rules check (set studio/game.json "engines": { "${engine}": { "rules": "<command>" } }; the owner's file)`); return 0; }
    const vars = Object.keys(cfg.env || {});
    console.log(`[engine-rules] ${engine}: ${cfg.command} (${cfg.source}); inputs: ${cfg.inputs.join(', ') || 'none'}; up to ${cfg.timeoutMin} min; median of recorded runs: ${rulesMinutes(root, engine) ?? 'none yet'} min`);
    // Variable names only: their values may be private.
    console.log(`[engine-rules] env: ${vars.join(', ') || 'none'}; paths: ${cfg.paths.join(', ') || 'the whole tree'}; large files: ${cfg.lfs ? 'checked out' : 'skipped'}; share: ${cfg.share.join(', ') || 'none'}`);
    console.log(`[engine-rules] focus: ${cfg.focus ? `${cfg.focus.test} with ${cfg.focus.map.length} map entr${cfg.focus.map.length === 1 ? 'y' : 'ies'}${cfg.focus.smoke ? `, smoke ${cfg.focus.smoke}` : ''}; a full run every ${cfg.focus.fullEveryHours} h (last full pass: ${readCache(root, engine).lastFullAt || 'none'})` : 'off (every run is the full command)'}`);
    if (cfg.focus?.auto) console.log(`[engine-rules] auto: systems are the folders under ${cfg.focus.auto.root}; paths ${cfg.focus.auto.paths.join(', ')}; filter ${cfg.focus.auto.filter}${Object.keys(cfg.focus.auto.filters).length ? `; ${Object.keys(cfg.focus.auto.filters).length} filter(s) by name` : ''}${cfg.focus.auto.inputs.length ? `; inputs ${cfg.focus.auto.inputs.join(', ')}` : ''}`);
    if (cfg.focus?.shared) console.log(`[engine-rules] shared (every part reads them; a change runs in full): ${cfg.focus.shared.join(', ')}`);
    for (const b of cfg.focusBad || []) console.log(`[engine-rules] ${b}`);
    if (cfg.focus) console.log(`[engine-rules] ignore: ${cfg.focus.ignore.length ? cfg.focus.ignore.map((p) => { try { new RegExp(p); return p; } catch { return `${p} (not a valid regex: skipped)`; } }).join(', ') : 'none'}`);
    return 0;
  }
  const sha = out(git(s.repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`));
  if (!sha) { console.error(`[engine-rules] ${ref} is not a branch or commit of the ${engine} repo (${s.repo})`); return 1; }
  const tip = out(git(s.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${s.target}^{commit}`));
  const due = fullDue(root, engine, cfg, { full: argv.includes('--full') });
  const sys = cfg.focus?.auto ? autoSystems({ repo: s.repo, shas: [sha, tip], auto: cfg.focus.auto, shared: cfg.focus.shared || [] }) : null;
  const sel = rulesSelection({ changed: tip ? changedPaths(s.repo, tip, sha) : null, cfg, full: Boolean(due), fullWhy: due, autoNames: sys ? sys.names : null });
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
