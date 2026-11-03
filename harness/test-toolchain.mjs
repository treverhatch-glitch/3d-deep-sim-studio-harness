/**
 * harness/test-toolchain.mjs — 2.71.1 (A, H03/H04/S02): each game's test toolchain is protected.
 *
 * A lane could leave every test file alone and still change what the game's checks run: a vitest/vite/jest config that
 * narrows `include` (H03), a setup file the config names that mocks the code under test (H04), an .npmrc whose
 * node-options preloads a module that forces exit code 0 (S02), or the package.json script the check calls. So:
 *   - the config files and .npmrc are on the shipped protected list (TOOLCHAIN_GLOBS, approve.mjs DEFAULT_PROTECTED);
 *   - the setup files a config names (setupFiles, setupFilesAfterEnv, globalSetup, globalTeardown; in a vitest, vite or
 *     jest config, or package.json "jest") at the base are protected too (setupFilesAt);
 *   - in a game's package.json only the test entries are (testKeys): scripts named test / test:* / pretest / posttest,
 *     the scripts the game's manifest commands run (npm run <name>, npm test), and the "jest" key. Adding a dependency
 *     stays a normal change. A change to those keys is listed as "<path>#test-scripts" with the hash of just those keys,
 *     so an owner approval signs exactly them.
 * Node built-ins only (approve.mjs imports it).
 */
import path from 'node:path';
import crypto from 'node:crypto';

export const GAME_ROOTS = ['game', 'web'];
export const TOOLCHAIN_GLOBS = [
  ...GAME_ROOTS.flatMap((r) => [`${r}/**/vitest.config.*`, `${r}/**/vitest.workspace.*`, `${r}/**/vite.config.*`, `${r}/**/jest.config.*`, `${r}/**/.npmrc`]),
  '.npmrc',
];
export const PKG_KEY_SUFFIX = '#test-scripts';
const CONFIG = /(^|\/)((vitest|vite|jest)\.config\.[^/]+|vitest\.workspace\.[^/]+)$/;
const inGame = (f) => GAME_ROOTS.some((r) => f.startsWith(`${r}/`)) && !/(^|\/)node_modules\//.test(f);
const isPkg = (f) => inGame(f) && /(^|\/)package\.json$/.test(f);

/** The setup files a config's text names, repo-relative (resolved from the config's folder; package names skipped). */
export function setupFilesIn(text, rel) {
  const out = new Set();
  const dir = path.posix.dirname(rel.replace(/\\/g, '/'));
  const re = /\b(setupFiles|setupFilesAfterEnv|setupFilesAfterEach|globalSetup|globalTeardown)\b["']?\s*[:=]\s*(\[[^\]]*\]|["'`][^"'`\n]+["'`])/g;
  for (const m of String(text || '').matchAll(re)) {
    for (const s of m[2].matchAll(/["'`]([^"'`\n]+)["'`]/g)) {
      let p = s[1].trim().replace(/^<rootDir>\//, './');
      if (!/^\.{1,2}\//.test(p) && !/\.(c|m)?[jt]sx?$/.test(p)) continue; // a package (jest-extended/all), not a file here
      p = path.posix.normalize(path.posix.join(dir, p));
      if (!p.startsWith('..')) out.add(p);
    }
  }
  return [...out];
}

/** The script names the game's manifests run (npm run x, npm test, pnpm x, yarn x), plus test / test:* / pre / post. */
export function manifestScripts(texts = []) {
  const names = new Set();
  for (const t of texts) {
    let j = null;
    try { j = JSON.parse(t); } catch { continue; }
    for (const g of Array.isArray(j?.gates) ? j.gates : []) {
      const cmd = String(g?.command || '');
      for (const m of cmd.matchAll(/\b(?:npm|pnpm|yarn)\s+(?:run(?:-script)?\s+)?([\w:.-]+)/g)) if (!['ci', 'install', 'i', 'exec', 'x', 'dlx'].includes(m[1])) names.add(m[1] === 't' ? 'test' : m[1]);
    }
  }
  return names;
}

/** The package.json keys the checks depend on, as one canonical value (null: not JSON). */
export function testKeys(text, scripts = new Set()) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const s = j && typeof j.scripts === 'object' && j.scripts ? j.scripts : {};
  const wanted = (k) => /^(pre|post)?test(:.*)?$/.test(k) || scripts.has(k) || [...scripts].some((n) => k === `pre${n}` || k === `post${n}`);
  const picked = Object.keys(s).filter(wanted).sort().map((k) => [k, String(s[k])]);
  return JSON.stringify({ scripts: picked, jest: j?.jest ?? null });
}
const keyHash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

/**
 * The toolchain part of the protected changes, given a reader:
 *   show(rev, file) -> text | null      (git show rev:file)
 *   names(rev) -> [files]               (git ls-tree -r --name-only rev -- game web)
 *   now(file) -> text | null            (the working tree)
 *   base                                the base commit
 *   changed                             files changed since the base (committed or not)
 * Returns { globs: [setup files the base's configs name], keyed: [{ path: '<pkg>#test-scripts', sha256 }] }.
 */
export function toolchainProtected({ show, names, now, base, changed = [] }) {
  const tracked = (names(base) || []).filter(inGame);
  const globs = new Set();
  for (const f of tracked.filter((x) => CONFIG.test(x))) for (const s of setupFilesIn(show(base, f), f)) globs.add(s);
  for (const f of tracked.filter(isPkg)) {
    let j = null;
    try { j = JSON.parse(show(base, f) || ''); } catch {}
    if (j?.jest) for (const s of setupFilesIn(JSON.stringify(j.jest), f)) globs.add(s);
  }
  const scripts = manifestScripts(tracked.filter((f) => /(^|\/)studio\.gates\.json$/.test(f)).map((f) => show(base, f) || ''));
  const keyed = [];
  for (const f of [...new Set(changed)].filter(isPkg)) {
    const before = show(base, f);
    const after = now(f);
    // A new package.json counts only at a game folder's root (a new game's manifest is protected anyway).
    if (before === null && !/^(game|web)\/[^/]+\/package\.json$/.test(f)) continue;
    const kb = before === null ? testKeys('{}', scripts) : testKeys(before, scripts);
    const ka = after === null ? 'deleted' : testKeys(after, scripts);
    if (kb !== ka) keyed.push({ path: `${f}${PKG_KEY_SUFFIX}`, sha256: ka === 'deleted' ? 'deleted' : keyHash(ka) });
  }
  return { globs: [...globs].sort(), keyed };
}
