/**
 * harness/reachability.mjs — 2.38.0: built but not wired. Is a code file reachable from the game?
 *
 * The research pack's Hatchfield audit (Oct 15) found about 43 systems that were built and unit-tested but
 * never connected: "nothing in the game imports it, only tests, scripts/*.html demos". Their tasks closed as
 * done because their own tests passed. This walks the game the way it runs, from its entry points, and says
 * which of a task's code files nothing reaches.
 *
 * Entry points:
 *   web     every index.html under web/ and game/ (its <script src> and inline module imports), every
 *           cartridges/<name>/index.mjs, package.json "main", and any "entries" a game's studio.gates.json lists;
 *   Godot   each project.godot's main scene and autoloads, then every res:// path a reached file names, and
 *           any script whose class_name a reached script uses.
 * Tests, test helpers, tools, demos and the harness itself are never entry points and never flagged.
 *
 * STUDIO_REACHABILITY: "warn" (default: the done-check prints a note), "fail" (an unreached file of a build
 * task fails the done-check: opt in), "off".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './event.mjs';

const JS = /\.(m?js|cjs|jsx|ts|tsx|mts)$/;
const GD = /\.gd$/;
const RES = /\.(gd|tscn|tres|gdshader|godot)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.studio', '.lanes', '.godot', 'dist', 'build', 'addons']);
// Never entry points, never flagged: tests, helpers, tools, demos, the harness's own folders.
export const NOT_GAME = /(^|\/)(tests?|__tests__|spec|specs|tools|scripts|qa|harness|hub|docs|fixtures|demos?)\//i;
export const TESTISH = /(\.|_|-)(test|spec|e2e)\.[a-z]+$|(^|\/)test_[^/]*\.gd$|(^|\/)qa\.mjs$/i;

export function reachMode(env = process.env) {
  const v = String(env.STUDIO_REACHABILITY || 'warn').toLowerCase();
  return ['fail', 'off'].includes(v) ? v : 'warn';
}

const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

function walk(dir, out = []) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); } else out.push(path.join(dir, e.name));
  }
  return out;
}

/** The import specifiers in a JS/TS source (static, re-export, dynamic with a literal, require, new URL). */
export function specifiers(text) {
  const out = new Set();
  const src = String(text || '');
  for (const re of [/\bimport\s+(?:[^'"`;]*?\sfrom\s*)?['"]([^'"]+)['"]/g, /\bexport\s+[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g, /new\s+Worker\(\s*['"]([^'"]+)['"]/g]) {
    for (const m of src.matchAll(re)) out.add(m[1]);
  }
  return [...out];
}

/** <script src> and inline module imports in an HTML page. */
export function htmlEntries(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/<script\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"]/gi)) out.add(m[1]);
  for (const m of String(text || '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) for (const s of specifiers(m[1])) out.add(s);
  return [...out];
}

/** tsconfig/jsconfig "paths" aliases (like "@/*": ["src/*"]) for the nearest config above a file. */
const aliasCache = new Map();
function aliasesFor(file) {
  let d = path.dirname(file);
  for (let i = 0; i < 12; i++) {
    if (aliasCache.has(d)) return aliasCache.get(d);
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const f = path.join(d, name);
      if (!fs.existsSync(f)) continue;
      let j = {};
      try { j = JSON.parse(read(f).replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1')); } catch {}
      const co = j.compilerOptions || {};
      const base = path.resolve(d, co.baseUrl || '.');
      const list = Object.entries(co.paths || {}).map(([k, v]) => [k.replace(/\*$/, ''), (Array.isArray(v) ? v : [v]).map((t) => path.resolve(base, String(t).replace(/\*$/, '')))]);
      aliasCache.set(d, list);
      return list;
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return [];
}

function resolveJs(from, spec, root) {
  if (!/^[./]/.test(spec)) {
    // An alias from tsconfig "paths" ("@/sim/x" -> src/sim/x), else a package.
    for (const [prefix, targets] of aliasesFor(from)) {
      if (!prefix || !spec.startsWith(prefix)) continue;
      for (const t of targets) {
        const hit = fileFor(path.join(t, spec.slice(prefix.length)));
        if (hit) return hit;
      }
    }
    return null;
  }
  const clean = spec.split(/[?#]/)[0];
  // "/x" is from the page's own folder (a site root), "./x" from the importing file.
  return fileFor(clean.startsWith('/') ? path.join(root, clean) : path.resolve(path.dirname(from), clean));
}

/** The file a module path means: as given, with an extension, or a folder's index. */
function fileFor(base) {
  const tries = [base, ...['.mjs', '.js', '.ts', '.tsx', '.jsx', '.cjs', '.mts'].map((x) => base + x), ...['index.mjs', 'index.js', 'index.ts', 'index.tsx'].map((x) => path.join(base, x))];
  // TypeScript's "./x.js" that means ./x.ts
  if (/\.js$/.test(base)) tries.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
  return tries.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
}

/** Every JS/TS file reachable from the web entry points: Set of repo-relative paths. */
export function webReach(root = REPO_ROOT, extra = []) {
  const queue = [];
  const seen = new Set();
  // Each file keeps the folder "/x" means for it: its page's folder (a Vite or static site root).
  const push = (f, site = root) => { if (f && !seen.has(f)) { seen.add(f); queue.push([f, site]); } };
  const all = ['web', 'game', 'cartridges'].flatMap((d) => walk(path.join(root, d)));
  for (const f of all.filter((f) => /(^|[\\/])index\.html$/.test(f) && !NOT_GAME.test(rel(root, f)))) {
    for (const s of htmlEntries(read(f))) push(resolveJs(f, s, path.dirname(f)), path.dirname(f));
  }
  for (const f of all.filter((f) => /cartridges[\\/][^\\/]+[\\/]index\.mjs$/.test(f) && !/[\\/]_template[\\/]/.test(f))) push(f, path.dirname(f));
  for (const m of all.filter((f) => /studio\.gates\.json$/.test(f))) {
    let j = {};
    try { j = JSON.parse(read(m)); } catch {}
    for (const e of Array.isArray(j.entries) ? j.entries : []) push(resolveJs(m, `./${String(e).replace(/^\.\//, '')}`, path.dirname(m)), path.dirname(m));
  }
  try { const pkg = JSON.parse(read(path.join(root, 'package.json'))); if (pkg.main) push(resolveJs(path.join(root, 'package.json'), `./${pkg.main}`, root)); } catch {}
  for (const e of extra) push(path.resolve(root, e));
  while (queue.length) {
    const [f, site] = queue.shift();
    if (!JS.test(f)) continue;
    for (const s of specifiers(read(f))) push(resolveJs(f, s, site), site);
  }
  return new Set([...seen].map((f) => rel(root, f)));
}

/** Every Godot resource reachable from each project's main scene and autoloads: Set of repo-relative paths. */
export function godotReach(root = REPO_ROOT) {
  const out = new Set();
  const projects = ['engine', 'game', 'godot'].flatMap((d) => walk(path.join(root, d))).filter((f) => path.basename(f) === 'project.godot');
  for (const proj of projects) {
    const dir = path.dirname(proj);
    const files = walk(dir).filter((f) => RES.test(f));
    const classes = new Map();
    for (const f of files.filter((x) => GD.test(x))) {
      const m = read(f).match(/^\s*class_name\s+(\w+)/m);
      if (m) classes.set(m[1], f);
    }
    const seen = new Set([proj]);
    const queue = [proj];
    const fromRes = (p) => path.join(dir, p.replace(/^res:\/\//, ''));
    while (queue.length) {
      const f = queue.shift();
      const text = read(f);
      const next = [...text.matchAll(/res:\/\/[^\s"')\]]+/g)].map((m) => fromRes(m[0]));
      if (GD.test(f)) for (const [name, file] of classes) if (file !== f && new RegExp(`\\b${name}\\b`).test(text)) next.push(file);
      for (const n of next) if (!seen.has(n) && fs.existsSync(n)) { seen.add(n); queue.push(n); }
    }
    for (const f of seen) out.add(rel(root, f));
  }
  return out;
}

/** Which of `files` (repo-relative) are game code that nothing in the game reaches. */
export function unreached(files, { root = REPO_ROOT } = {}) {
  const code = files.filter((f) => (JS.test(f) || GD.test(f)) && /^(web|game|cartridges|engine|godot)\//.test(f) && !NOT_GAME.test(f) && !TESTISH.test(f) && !/(^|\/)_template\//.test(f) && fs.existsSync(path.join(root, f)));
  if (!code.length) return [];
  const web = code.some((f) => JS.test(f)) ? webReach(root) : new Set();
  const gd = code.some((f) => GD.test(f)) ? godotReach(root) : new Set();
  return code.filter((f) => !(JS.test(f) ? web : gd).has(f));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.log(`web: ${webReach().size} file(s) reachable; Godot: ${godotReach().size} resource(s) reachable`);
    process.exit(0);
  }
  const u = unreached(files);
  for (const f of u) console.log(`[reach] not reached from the game: ${f}`);
  console.log(u.length ? `[reach] ${u.length} of ${files.length} file(s) are built but not wired` : `[reach] every game code file given is reached from the game`);
  process.exit(u.length ? 1 : 0);
}
