/**
 * harness/det-math.mjs — 2.58.2 (PU-22): engine-dependent Math calls in sim code.
 *
 * Math.sin, cos, tan, asin, acos, atan, atan2, the hyperbolics, exp, expm1, log, log1p, log2, log10, pow,
 * hypot and cbrt (and the ** operator, which is pow) are only approximately specified: Node, a browser,
 * Jint on .NET and a C# port can give different last bits for the same input, so a replay that matches in
 * one engine can drift in another. Math.sqrt, + - * /, floor, ceil, round, trunc, abs, min, max, sign,
 * fround and imul are exact and fine. A sim that must replay the same everywhere calls a detMath module
 * (written to give the same bits in every engine) instead.
 *
 * This module finds those calls in sim code. scripts/check-sim-purity.mjs runs it (statically, on every
 * cartridge and on the studio game's sim paths) and scripts/sim-runtime-probe.mjs traps the same functions
 * while a cartridge plays, which catches what a static scan can't see.
 *
 * Per game, a mode: "off", "warn" (print, never fail: the default, so no existing game turns red) or
 * "required" (fail the purity gate). `npm run new-game` writes "required".
 *   cartridges/<name>/cartridge.json   "detMath": "required"   or   { "mode": "required", "allow": ["lib/trig.mjs"] }
 *   game/<name>/studio.gates.json      "detMath": { "mode": "warn", "paths": ["src/sim"], "allow": ["src/sim/fastTrig.ts"] }
 *   studio/gates.json                  "detMath" for src/sim/ (when a studio keeps its sim there)
 * The detMath module itself may use Math: any file named detMath / det-math / det_math (any extension), any
 * file under a folder with that name, and every path in "allow".
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './event.mjs';

export const INEXACT = Object.freeze(['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'exp', 'expm1', 'log', 'log1p', 'log2', 'log10', 'pow', 'hypot', 'cbrt']);
const INEXACT_SET = new Set(INEXACT);
export const MODES = Object.freeze(['off', 'warn', 'required']);
export const SUGGESTION = "use the game's detMath module (sin, cos, atan2, hypot, …) written to give the same bits in every engine";
const CODE_EXT = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
const DET_NAME = /^det[-_]?math$/i;
const ID = '[A-Za-z_$][\\w$]*';
const esc = (s) => s.replace(/[$]/g, '\\$');

/** A mode from a config value: "off" | "warn" | "required" (anything else is "warn", with `bad` set). */
export function normMode(v, fallback = 'warn') {
  if (v === undefined || v === null || v === '') return { mode: fallback, bad: null };
  const s = String(v).toLowerCase();
  if (s === 'error' || s === 'fail' || s === 'on') return { mode: 'required', bad: null };
  return MODES.includes(s) ? { mode: s, bad: null } : { mode: 'warn', bad: String(v) };
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const toPosix = (p) => String(p).replace(/\\/g, '/');
const relOf = (root, f) => toPosix(path.relative(root, f));

/** A config path: repo-relative when it exists from the repo root, else relative to the game's folder. */
function resolvePath(root, base, p) {
  const s = toPosix(p).replace(/\/+$/, '').replace(/\/\*\*$/, '');
  const fromRoot = path.join(root, s);
  if (base && !fs.existsSync(fromRoot)) return path.join(root, base, s);
  return fromRoot;
}

function scopeFrom(raw, { root, label, base, defaultPaths, source }) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { mode: raw };
  const { mode, bad } = normMode(o.mode);
  const paths = Array.isArray(o.paths) && o.paths.length ? o.paths.map((p) => resolvePath(root, base, p)) : defaultPaths.map((p) => path.join(root, p));
  const allow = Array.isArray(o.allow) ? o.allow.map((p) => resolvePath(root, base, p)) : [];
  return { label, base, mode, bad, paths, allow, source: raw === undefined || raw === null ? 'default' : source };
}

/** The det-math settings of one cartridge (cartridges/<name>/cartridge.json "detMath"). */
export function cartridgeDetMath(name, root = REPO_ROOT) {
  const base = `cartridges/${name}`;
  const raw = readJson(path.join(root, base, 'cartridge.json'))?.detMath;
  return scopeFrom(raw, { root, label: `cartridge ${name}`, base, defaultPaths: [base], source: `${base}/cartridge.json` });
}

/** The det-math settings of a studio game that isn't a cartridge ({ name, root, sim } from harness/game-gates.mjs). */
export function gameDetMath(game, root = REPO_ROOT) {
  if (!game?.root) return null;
  const raw = readJson(path.join(root, game.root, 'studio.gates.json'))?.detMath;
  return scopeFrom(raw, { root, label: `game ${game.name}`, base: game.root, defaultPaths: game.sim ? [game.sim] : [], source: `${game.root}/studio.gates.json` });
}

/** Every place sim code lives, with its mode: each cartridge, src/sim/, and the studio game's sim paths. */
export async function detMathScopes(root = REPO_ROOT, { game } = {}) {
  const scopes = [];
  const cartDir = path.join(root, 'cartridges');
  if (fs.existsSync(cartDir)) {
    for (const d of fs.readdirSync(cartDir, { withFileTypes: true })) if (d.isDirectory()) scopes.push(cartridgeDetMath(d.name, root));
  }
  if (fs.existsSync(path.join(root, 'src', 'sim'))) {
    scopes.push(scopeFrom(readJson(path.join(root, 'studio', 'gates.json'))?.detMath, { root, label: 'src/sim', base: 'src/sim', defaultPaths: ['src/sim'], source: 'studio/gates.json' }));
  }
  let g = game;
  if (g === undefined) {
    try { g = await (await import('./game-gates.mjs')).studioGame(); } catch { g = null; }
  }
  const gs = gameDetMath(g, root);
  if (gs) scopes.push(gs);
  return scopes;
}

/** The detMath module (by name or folder) or a path the scope allows: Math is fine in there. */
export function isAllowedFile(file, scope = null, root = REPO_ROOT) {
  const rel = relOf(root, file);
  const parts = rel.split('/');
  const baseName = parts[parts.length - 1].replace(/\.d(?=\.[a-z]+$)/, '').replace(/\.[a-z]+$/i, '');
  if (DET_NAME.test(baseName) || parts.slice(0, -1).some((p) => DET_NAME.test(p))) return true;
  for (const a of scope?.allow || []) {
    const r = path.resolve(a);
    const f = path.resolve(file);
    if (f === r || f.startsWith(r + path.sep)) return true;
  }
  return false;
}

/**
 * Blank comments (in `code`) and comments plus the insides of strings, templates and regex literals (in
 * `bare`), keeping every offset and line break, so a match in one can be read back in the other.
 */
export function scrub(src) {
  const n = src.length;
  const code = src.split('');
  const bare = src.split('');
  const blank = (arr, a, b) => { for (let k = a; k < b && k < n; k++) if (arr[k] !== '\n' && arr[k] !== '\r') arr[k] = ' '; };
  const KW = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);
  const stack = [];
  let depth = 0;
  let prev = '';
  let i = 0;
  const template = (j) => {
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') { blank(bare, i, j); return j + 1; }
      if (src[j] === '$' && src[j + 1] === '{') { blank(bare, i, j); stack.push(depth); depth += 1; return j + 2; }
      j += 1;
    }
    blank(bare, i, n);
    return n;
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { let e = src.indexOf('\n', i); if (e < 0) e = n; blank(code, i, e); blank(bare, i, e); i = e; continue; }
    if (c === '/' && d === '*') { const e0 = src.indexOf('*/', i + 2); const e = e0 < 0 ? n : e0 + 2; blank(code, i, e); blank(bare, i, e); i = e; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      blank(bare, i + 1, j);
      i = j + 1; prev = 'str'; continue;
    }
    if (c === '`') { i += 1; i = template(i); prev = 'str'; continue; }
    if (c === '}' && stack.length && depth - 1 === stack[stack.length - 1]) { stack.pop(); depth -= 1; i += 1; i = template(i); prev = 'str'; continue; }
    if (c === '/' && (prev === '' || prev === 'kw' || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev))) {
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) break;
        j += 1;
      }
      blank(bare, i + 1, j);
      i = j + 1;
      while (i < n && /[a-z]/i.test(src[i])) i += 1;
      prev = 'str'; continue;
    }
    if (/[A-Za-z_$0-9]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j += 1;
      prev = KW.has(src.slice(i, j)) ? 'kw' : 'id';
      i = j; continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    if (!/\s/.test(c)) prev = c === ')' || c === ']' ? 'id' : c;
    i += 1;
  }
  return { code: code.join(''), bare: bare.join('') };
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

/** Engine-dependent Math in one source text: { uses: [{ index, line, fn, how }], destructured, imports, ... }. */
export function analyseSource(src) {
  const { code, bare } = scrub(src);
  const lineAt = lineIndex(src);
  const uses = [];
  const add = (index, fn, how) => uses.push({ index, line: lineAt(index), fn, how });
  const names = new Set(['Math']);
  const destructured = new Map(); // local binding -> fn
  const seenDestructure = new Set();
  // Aliases of Math itself (`const M = Math`) and rest bindings (`const { ...m } = Math`), to a fixed point.
  for (let round = 0; round < 4; round++) {
    const before = names.size;
    const alt = [...names].map(esc).join('|');
    for (const m of bare.matchAll(new RegExp(`(?<![\\w$.])(${ID})\\s*=(?![=>])\\s*(?:${alt})\\b(?!\\s*(?:\\?\\.|\\.|\\[|\\())`, 'g'))) names.add(m[1]);
    for (const m of bare.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*=(?![=>])\\s*(?:${alt})\\b(?!\\s*(?:\\?\\.|\\.|\\[|\\())`, 'g'))) {
      const innerStart = m.index + 1;
      const inner = code.slice(innerStart, innerStart + m[1].length);
      let off = 0;
      for (const part of inner.split(',')) {
        const at = innerStart + off + (part.length - part.trimStart().length);
        off += part.length + 1;
        const p = part.trim();
        if (!p) continue;
        if (p.startsWith('...')) { names.add(p.slice(3).trim()); continue; }
        const key = p.split(/[:=]/)[0].trim().replace(/^['"`]|['"`]$/g, '');
        const local = p.includes(':') ? p.split(':')[1].split('=')[0].trim() : key;
        if (seenDestructure.has(at)) continue;
        seenDestructure.add(at);
        if (key.startsWith('[')) add(at, '?', 'dynamic');
        else if (INEXACT_SET.has(key)) { add(at, key, 'destructure'); destructured.set(local, key); }
      }
    }
    if (names.size === before) break;
  }
  const alt = [...names].map(esc).join('|');
  for (const m of bare.matchAll(new RegExp(`(?<![\\w$.])(?:${alt})\\s*(?:\\?\\.|\\.)\\s*(${ID})(\\s*(?:\\?\\.)?\\s*\\()?`, 'g'))) {
    if (INEXACT_SET.has(m[1])) add(m.index, m[1], m[2] ? 'call' : 'reference');
  }
  for (const m of bare.matchAll(new RegExp(`(?<![\\w$.])(?:${alt})\\s*(?:\\?\\.)?\\s*\\[\\s*`, 'g'))) {
    const at = m.index + m[0].length;
    const q = code[at];
    if (q === '"' || q === "'" || q === '`') {
      const end = code.indexOf(q, at + 1);
      const key = end < 0 ? '' : code.slice(at + 1, end);
      if (q === '`' && key.includes('${')) add(m.index, '?', 'dynamic');
      else if (INEXACT_SET.has(key)) add(m.index, key, 'bracket');
    } else add(m.index, '?', 'dynamic');
  }
  for (const m of bare.matchAll(new RegExp(`(?:\\bReflect\\s*\\.\\s*(?:get|apply|getOwnPropertyDescriptor|ownKeys)|\\bObject\\s*\\.\\s*(?:entries|values|getOwnPropertyDescriptors?|assign))\\s*\\(\\s*(?:[^()]*?,\\s*)?(?:${alt})\\s*[,)]|\\.\\.\\.\\s*(?:${alt})\\b(?!\\s*(?:\\?\\.|\\.|\\[))|\\bwith\\s*\\(\\s*(?:${alt})\\s*\\)`, 'g'))) add(m.index, '?', 'dynamic');
  // The ** operator is Math.pow. Two integer literals with an exactly representable result are fine.
  for (const m of bare.matchAll(/\*\*=?/g)) {
    const left = /(?<![\w$.])(\d+)\s*$/.exec(bare.slice(Math.max(0, m.index - 24), m.index));
    const right = /^\s*(\d+)(?![\w.$])/.exec(bare.slice(m.index + m[0].length, m.index + m[0].length + 24));
    if (m[0] === '**' && left && right) {
      try { if (BigInt(left[1]) ** BigInt(right[1]) <= 2n ** 53n) continue; } catch { /* too large: flag it */ }
    }
    add(m.index, '**', 'operator');
  }
  // Imports, to follow wrappers that forward to Math.
  const imports = [];
  const pushImport = (index, spec, imported, kind) => { if (/^\.{1,2}(\/|$)|^\//.test(spec)) imports.push({ index, line: lineAt(index), spec, names: imported, kind }); };
  for (const m of code.matchAll(/(?<![\w$.])import\s+(type\s+)?([\w$*{}\s,]+?)\s+from\s*(['"])([^'"\n]+)\3/g)) {
    if (m[1] || bare[m.index] !== 'i') continue;
    pushImport(m.index, m[4], clauseNames(m[2]), 'import');
  }
  for (const m of code.matchAll(/(?<![\w$.])export\s+(type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\3/g)) {
    if (m[1] || bare[m.index] !== 'e') continue;
    pushImport(m.index, m[4], m[2].startsWith('*') ? ['*'] : clauseNames(m[2]), 'reexport');
    if (imports.length && imports[imports.length - 1].index === m.index) imports[imports.length - 1].pairs = m[2].startsWith('*') ? [] : clausePairs(m[2]);
  }
  for (const m of code.matchAll(/(?<![\w$.])(?:require|import)\s*\(\s*(['"])([^'"\n]+)\1/g)) {
    if (!/[ri]/.test(bare[m.index])) continue;
    pushImport(m.index, m[2], ['*'], 'dynamic');
  }
  return { uses, destructured, imports, code, bare, lineAt };
}

/** The exported names an import clause takes: `a, { b as c, type d }` -> ['default', 'b']; `* as ns` -> ['*']. */
function clauseNames(clause) {
  const out = [];
  const c = clause.trim();
  const braces = /\{([^}]*)\}/.exec(c);
  const rest = c.replace(/\{[^}]*\}/, '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const r of rest) out.push(r.startsWith('*') ? '*' : 'default');
  if (braces) {
    for (const part of braces[1].split(',')) {
      const p = part.trim().replace(/^type\s+/, '');
      if (!p) continue;
      out.push(p.split(/\s+as\s+/)[0].trim().replace(/^['"]|['"]$/g, ''));
    }
  }
  return out.length ? out : ['*'];
}

/** `{ a as b, c }` -> [['a', 'b'], ['c', 'c']]: the source name and the name it is exported as. */
function clausePairs(clause) {
  const braces = /\{([^}]*)\}/.exec(clause);
  if (!braces) return [];
  return braces[1].split(',').map((p) => p.trim().replace(/^type\s+/, '')).filter(Boolean).map((p) => {
    const [src, as] = p.split(/\s+as\s+/).map((x) => x.trim());
    return [src, as || src];
  });
}

function resolveImport(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands = [base, ...['.ts', '.mts', '.tsx', '.mjs', '.js', '.cjs', '.jsx'].map((e) => base + e)];
  if (/\.(m|c)?js$/.test(base)) cands.push(base.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts'), base.replace(/\.js$/, '.tsx'));
  cands.push(...['index.ts', 'index.mjs', 'index.js', 'index.tsx'].map((f) => path.join(base, f)));
  return cands.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
}

/** Where a declaration of `name` starts and ends in `bare` (a function, class or const/let/var statement). */
function declSpan(bare, name) {
  const re = new RegExp(`(?<![\\w$.])(?:(?:async\\s+)?function\\s*\\*?\\s*${esc(name)}\\s*[(<]|class\\s+${esc(name)}\\b|(?:const|let|var)\\s+${esc(name)}\\b)`);
  const m = re.exec(bare);
  if (!m) return null;
  return { start: m.index, end: statementEnd(bare, m.index, /^(?:async\s+)?function|^class/.test(m[0])) };
}

function statementEnd(bare, start, block) {
  let depth = 0;
  let opened = false;
  const limit = Math.min(bare.length, start + 50000);
  for (let i = start; i < limit; i++) {
    const c = bare[i];
    if (c === '(' || c === '[' || c === '{') { depth += 1; if (c === '{') opened = true; }
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth <= 0 && block && opened && c === '}') return i + 1;
      if (depth < 0) return i;
    } else if (depth === 0 && !block) {
      if (c === ';') return i + 1;
      if (c === '\n') {
        const before = bare.slice(start, i).trimEnd();
        const after = bare.slice(i + 1).trimStart();
        if (!/(=>|[=,(+\-*/%&|^<>?:])$/.test(before) && !/^[.?:+\-*/%&|^<>=,)]/.test(after)) return i;
      }
    }
  }
  return limit;
}

/** Engine-dependent Math that the named exports of `file` reach: [{ name, fn, at }] (empty when they don't). */
function forwarders(file, names, ctx, depth = 0) {
  const key = `${file}|${names.join(',')}`;
  if (ctx.fwd.has(key)) return ctx.fwd.get(key);
  ctx.fwd.set(key, []);
  if (depth > 6 || isAllowedFile(file, ctx.scope, ctx.root) || ctx.inScope.has(file)) return [];
  const a = ctx.analyse(file);
  if (!a) return [];
  const rel = relOf(ctx.root, file);
  const out = [];
  const usesIn = (s, e) => a.uses.filter((u) => u.index >= s && u.index < e);
  const reexports = a.imports.filter((i) => i.kind === 'reexport');
  for (const name of names) {
    if (name === '*') {
      for (const u of a.uses) out.push({ name: '*', fn: u.fn, at: `${rel}:${u.line}` });
      for (const r of reexports) {
        const target = resolveImport(file, r.spec);
        if (target) out.push(...forwarders(target, r.names, ctx, depth + 1));
      }
      continue;
    }
    // `export { local as name }` without a source maps the name to a local binding.
    let local = name;
    for (const m of a.bare.matchAll(/(?<![\w$.])export\s*\{([^}]*)\}(?!\s*from)/g)) {
      for (const part of m[1].split(',')) {
        const [l, x] = part.trim().split(/\s+as\s+/);
        if ((x || l)?.trim() === name) local = l.trim();
      }
    }
    // Re-exported from another module.
    let followed = false;
    for (const r of reexports) {
      const star = r.names.includes('*');
      const pair = star ? null : (r.pairs || []).find(([, as]) => as === name);
      if (!star && !pair) continue;
      const target = resolveImport(file, r.spec);
      if (!target) continue;
      const got = forwarders(target, [star ? name : pair[0]], ctx, depth + 1).map((g) => ({ ...g, name }));
      if (got.length || !star) followed = true;
      out.push(...got);
    }
    if (followed) continue;
    if (a.destructured.has(local)) {
      const u = a.uses.find((x) => x.how === 'destructure' && x.fn === a.destructured.get(local));
      out.push({ name, fn: a.destructured.get(local), at: `${rel}:${u?.line || '?'}` });
      continue;
    }
    let span = null;
    if (name === 'default') {
      const m = /(?<![\w$.])export\s+default\s+/.exec(a.bare);
      if (m) span = { start: m.index, end: statementEnd(a.bare, m.index + m[0].length, /^(?:async\s+)?(?:function|class)\b/.test(a.bare.slice(m.index + m[0].length))) };
    } else span = declSpan(a.bare, local);
    if (!span) {
      // Unknown shape (a namespace object, a generated export): count every use in the file.
      for (const u of a.uses) out.push({ name, fn: u.fn, at: `${rel}:${u.line}` });
      continue;
    }
    for (const u of usesIn(span.start, span.end)) out.push({ name, fn: u.fn, at: `${rel}:${u.line}` });
    const body = a.bare.slice(span.start, span.end);
    for (const [l, fn] of a.destructured) {
      if (new RegExp(`(?<![\\w$.])${esc(l)}\\s*\\(`).test(body)) out.push({ name, fn, at: `${rel}:${a.uses.find((x) => x.how === 'destructure' && x.fn === fn)?.line || '?'}` });
    }
  }
  ctx.fwd.set(key, out);
  return out;
}

function collect(target, out = []) {
  let st;
  try { st = fs.statSync(target); } catch { return out; }
  if (st.isFile()) {
    if (CODE_EXT.test(target)) out.push(target);
    return out;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') collect(full, out);
    } else if (CODE_EXT.test(entry.name) && !/\.(test|spec)\.[a-z]+$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

const HOW = {
  call: (f) => `Math.${f}() is engine-dependent`,
  reference: (f) => `Math.${f} (taken as a value) is engine-dependent`,
  bracket: (f) => `Math['${f}'] is engine-dependent`,
  destructure: (f) => `{ ${f} } taken from Math is engine-dependent`,
  dynamic: () => 'dynamic access to Math can reach sin, cos and the other engine-dependent functions',
  operator: () => 'the ** operator is Math.pow, which is engine-dependent (multiply out small integer powers)',
};

/**
 * Scan one scope: { files, findings: [{ file, line, fn, how, message }] }. Files that are the detMath module
 * (or allowed) are skipped; relative imports are followed to catch wrappers that forward to Math.
 */
export function scanScope(scope, { root = REPO_ROOT, cache = new Map() } = {}) {
  const analyse = (f) => {
    if (!cache.has(f)) { try { cache.set(f, analyseSource(fs.readFileSync(f, 'utf8'))); } catch { cache.set(f, null); } }
    return cache.get(f);
  };
  const all = [...new Set(scope.paths.flatMap((p) => collect(p)))];
  const files = all.filter((f) => !isAllowedFile(f, scope, root));
  const ctx = { root, scope, analyse, fwd: new Map(), inScope: new Set(all) };
  const findings = [];
  for (const file of files) {
    const a = analyse(file);
    if (!a) continue;
    const rel = relOf(root, file);
    for (const u of a.uses) findings.push({ file: rel, line: u.line, fn: u.fn, how: u.how, message: `${HOW[u.how](u.fn)}: ${SUGGESTION}` });
    for (const imp of a.imports) {
      const target = resolveImport(file, imp.spec);
      if (!target || ctx.inScope.has(target) || isAllowedFile(target, scope, root)) continue;
      const got = forwarders(target, imp.names, ctx);
      if (!got.length) continue;
      const fns = [...new Set(got.map((g) => g.fn))];
      const first = got[0];
      const what = first.name === '*' ? `${relOf(root, target)}` : `${[...new Set(got.map((g) => g.name))].join(', ')} from ${relOf(root, target)}`;
      findings.push({ file: rel, line: imp.line, fn: fns.join(', '), how: 'import', message: `imports ${what}, which ${first.fn === '?' ? 'reaches Math dynamically' : first.fn === '**' ? 'uses the ** operator' : `calls Math.${fns.filter((f) => f !== '?' && f !== '**').join('/Math.') || first.fn}`} (${first.at}): ${SUGGESTION}` });
    }
  }
  findings.sort((x, y) => (x.file === y.file ? x.line - y.line : x.file < y.file ? -1 : 1));
  return { files: files.length, findings };
}

/** One printed line per finding. */
export const formatFinding = (f) => `${f.file}:${f.line} [DET_MATH] ${f.message}`;
