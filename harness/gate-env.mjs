/**
 * harness/gate-env.mjs — 2.71.1 (B): the environment the gates run in, and two things about the checkout they judge.
 *
 * A red team showed a verify could be turned green from outside the code it judges (verifier report, 2026-11-03):
 *   - S03/T06: NODE_OPTIONS (or npm's node-options) preloading a script into every node process a gate starts, so a
 *     failing check exits 0;
 *   - G10/G16/T01: `git replace` (or .git/info/grafts) swapping the base branch's commit or studio/protected.json for
 *     another one, in the git folder every lane copy shares; the GIT_* variables that point git at another repository,
 *     index or object store do the same per process;
 *   - S04: node_modules that no longer match package-lock.json (a stale install, or a test runner swapped for a script
 *     that prints "passed").
 * So:
 *   gateEnv(env)       the env without code-loading NODE_OPTIONS (harmless memory and warning flags are kept, named in
 *                      SAFE_NODE_OPTIONS) and npm_config_node_options, and with gitEnv's changes: what run-gates and
 *                      game-gates give every child, and what the harness's own launchers (task done, the train, the
 *                      launcher's verify, the whole-game check) start a verify with.
 *   gitEnv(env)        GIT_NO_REPLACE_OBJECTS=1 and no GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
 *                      GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_COMMON_DIR, GIT_NAMESPACE, GIT_GRAFT_FILE,
 *                      GIT_REPLACE_REF_BASE, GIT_SHALLOW_FILE or GIT_CONFIG* (git finds the repository from the folder).
 *   applyGateEnv()     the same, in place, for the process that runs the gates (so every git call it and its children
 *                      make is covered, whichever helper makes it). Returns what it dropped (names, never values).
 *   gitRedirects(dir)  { replace: [refs], grafts: [files] }: replace refs or a grafts file in the checkout's git folder.
 *                      The protected gate fails on either (harness/approve.mjs checkProtected).
 *   nodeModulesDrift(dir)  why node_modules doesn't match package-lock.json there, or null: versions that differ,
 *                      packages missing or extra, and (POSIX) a node_modules/.bin entry that isn't npm's link.
 * Not covered: a person who starts `NODE_OPTIONS=... npm run verify` by hand preloads code into run-gates itself
 * before any of this runs; the gates' children still run clean and the record says so (nodeOptionsPreload).
 * Never imports another harness module: run-gates, game-gates, approve.mjs and the launchers import it freely.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJson } from './fsafe.mjs';

/** NODE_OPTIONS flags a gate's children keep: memory, warning, certificate-store and DNS settings that load no code. */
export const SAFE_NODE_OPTIONS = /^--(?:max[-_]old[-_]space[-_]size|max[-_]semi[-_]space[-_]size)=\d+$|^--(?:no-warnings|no-deprecation|enable-source-maps|experimental-vm-modules|use-openssl-ca|use-bundled-ca|use-system-ca)$|^--dns-result-order=(?:ipv4first|ipv6first|verbatim)$/;
/** The GIT_* variables that point git somewhere other than the checkout it runs in (or rewrite what it reads). */
export const GIT_REDIRECT = /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|GRAFT_FILE|REPLACE_REF_BASE|SHALLOW_FILE|CONFIG|CONFIG_[A-Z0-9_]+)$/;

/** NODE_OPTIONS split the way node reads it (double quotes group, a backslash escapes in them). */
export function splitNodeOptions(s) {
  const out = [];
  let cur = '';
  let q = false;
  let any = false;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q && c === '\\' && i + 1 < str.length) { cur += str[++i]; continue; }
    if (c === '"') { q = !q; any = true; continue; }
    if (!q && /\s/.test(c)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}

/** { env, dropped: [names] }: env (a copy) with gitEnv's changes and only SAFE_NODE_OPTIONS left in NODE_OPTIONS. */
export function scrubGateEnv(env = process.env) {
  const out = { ...env };
  const dropped = [];
  if (out.NODE_OPTIONS !== undefined) {
    const tokens = splitNodeOptions(out.NODE_OPTIONS);
    const keep = tokens.filter((t) => SAFE_NODE_OPTIONS.test(t));
    const gone = tokens.filter((t) => !SAFE_NODE_OPTIONS.test(t));
    if (gone.length) dropped.push(`NODE_OPTIONS (${[...new Set(gone.map((t) => (t.startsWith('-') ? t.split('=')[0] : 'a value')))].join(' ')})`);
    if (keep.length) out.NODE_OPTIONS = keep.join(' ');
    else delete out.NODE_OPTIONS;
  }
  for (const k of Object.keys(out)) if (/^npm_config_node_options$/i.test(k)) { delete out[k]; dropped.push(k); }
  for (const k of Object.keys(out)) if (GIT_REDIRECT.test(k)) { delete out[k]; const name = /^GIT_CONFIG_/.test(k) ? 'GIT_CONFIG_*' : k; if (!dropped.includes(name)) dropped.push(name); }
  out.GIT_NO_REPLACE_OBJECTS = '1';
  return { env: out, dropped };
}

/** The env a gate's child (or a verify a launcher starts) gets. */
export const gateEnv = (env = process.env) => scrubGateEnv(env).env;

/** The env for one git call that judges the checkout: no redirects, no replace refs. */
export function gitEnv(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (GIT_REDIRECT.test(k)) delete out[k];
  out.GIT_NO_REPLACE_OBJECTS = '1';
  return out;
}

/** Was this process itself started with NODE_OPTIONS that load code (--require, --import, --loader, ...)? */
export function preloadedNodeOptions(env = process.env) {
  return splitNodeOptions(env.NODE_OPTIONS || '').filter((t) => !SAFE_NODE_OPTIONS.test(t) && t.startsWith('-')).map((t) => t.split('=')[0]);
}

/**
 * Scrub process.env in place (the gates' own process): every later spawn and every git call inherits it. Returns the
 * names dropped and whether this process was itself started with code-loading NODE_OPTIONS (too late to undo here).
 */
export function applyGateEnv({ env = process.env } = {}) {
  const preload = preloadedNodeOptions(env);
  const { env: clean, dropped } = scrubGateEnv(env);
  for (const k of Object.keys(env)) if (!(k in clean)) delete env[k];
  for (const [k, v] of Object.entries(clean)) if (env[k] !== v) env[k] = v;
  return { dropped, preload };
}

const gitOut = (dir, args) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 ? String(r.stdout || '') : null;
};

/** Replace refs and grafts files in this checkout's git folder (shared by every worktree of it): { replace, grafts }. */
export function gitRedirects(dir) {
  const refs = gitOut(dir, ['for-each-ref', '--format=%(refname)', 'refs/replace/']);
  const replace = refs === null ? [] : refs.split('\n').map((s) => s.trim()).filter(Boolean);
  const grafts = [];
  for (const which of ['--git-common-dir', '--git-dir']) {
    const d = gitOut(dir, ['rev-parse', which]);
    if (!d || !d.trim()) continue;
    const f = path.resolve(dir, d.trim(), 'info', 'grafts');
    try { if (fs.statSync(f).size > 0 && !grafts.includes(f)) grafts.push(f); } catch {}
  }
  return { replace, grafts };
}

/** One line for the protected gate, or '' when the git folder has neither. */
export function gitRedirectsWhy(r) {
  if (!r || (!r.replace.length && !r.grafts.length)) return '';
  const parts = [];
  if (r.replace.length) parts.push(`${r.replace.length} replace ref(s) (${r.replace.slice(0, 3).join(', ')}${r.replace.length > 3 ? ', ...' : ''})`);
  if (r.grafts.length) parts.push(`a grafts file (${r.grafts.map((f) => f.split(path.sep).join('/')).join(', ')})`);
  return `this checkout's git folder has ${parts.join(' and ')}: git would show other commits or files than the ones committed, in every lane copy of it`;
}


/**
 * Why node_modules in `dir` doesn't match its package-lock.json, or null (no package-lock.json, no node_modules, or
 * they match). Cheap: two JSON reads and one folder listing. Packages package-lock.json marks optional, dev or peer may
 * be missing (an install for another OS, --omit=dev); a version that differs, an extra package or a missing required
 * one may not. On POSIX every node_modules/.bin entry npm makes is a link; a plain file there is a hand-made shim.
 */
export function nodeModulesDrift(dir, { platform = process.platform } = {}) {
  const lock = readJson(path.join(dir, 'package-lock.json'));
  const nm = path.join(dir, 'node_modules');
  if (!lock?.packages || !fs.existsSync(nm)) return null;
  const hidden = readJson(path.join(nm, '.package-lock.json'));
  if (!hidden?.packages) return 'node_modules has no .package-lock.json (not installed by npm from this lockfile, or by hand)';
  const want = lock.packages;
  const have = hidden.packages;
  const differ = [];
  const missing = [];
  const extra = [];
  for (const [k, v] of Object.entries(want)) {
    if (!k.startsWith('node_modules/')) continue;
    if (!have[k]) { if (!v.optional && !v.dev && !v.devOptional && !v.peer) missing.push(k.slice(13)); continue; }
    if (v.version && have[k].version && v.version !== have[k].version) differ.push(`${k.slice(13)} ${have[k].version} (lockfile ${v.version})`);
  }
  for (const k of Object.keys(have)) if (k.startsWith('node_modules/') && !want[k]) extra.push(k.slice(13));
  const shims = [];
  if (platform !== 'win32') {
    try {
      for (const d of fs.readdirSync(path.join(nm, '.bin'), { withFileTypes: true })) if (!d.isSymbolicLink()) shims.push(d.name);
    } catch {}
  }
  const why = [];
  const few = (a) => `${a.slice(0, 3).join(', ')}${a.length > 3 ? ` and ${a.length - 3} more` : ''}`;
  if (differ.length) why.push(`${differ.length} package version(s) differ: ${few(differ)}`);
  if (missing.length) why.push(`${missing.length} package(s) missing: ${few(missing)}`);
  if (extra.length) why.push(`${extra.length} package(s) not in the lockfile: ${few(extra)}`);
  if (shims.length) why.push(`node_modules/.bin has ${shims.length} plain file(s) where npm makes links: ${few(shims)}`);
  return why.length ? why.join('; ') : null;
}

/**
 * `git status --porcelain=v1 -z` output as [{ xy, file }] (names never quoted; a rename's or copy's old name, which -z
 * gives as the next entry, is skipped).
 */
export function porcelainZ(text) {
  const parts = String(text || '').split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    if (e[0] === 'R' || e[0] === 'C') i++;
    out.push({ xy: e.slice(0, 2), file: e.slice(3) });
  }
  return out;
}
