#!/usr/bin/env node
/**
 * scripts/unused-exports.mjs — 2.86: a read-only report of exports and modules that nothing uses, and of exact duplicates.
 *
 *   node scripts/unused-exports.mjs                    counts by class
 *   node scripts/unused-exports.mjs --list DEAD        one line per item: file:line name (size in lines); also USED, TEST-ONLY,
 *                                                      INTERNAL, UNREACHED
 *   node scripts/unused-exports.mjs --json             everything as JSON
 *   node scripts/unused-exports.mjs --duplicates       functions of 6+ lines with identical bodies in 2+ harness files, and
 *                                                      whether one can be imported from the other without an import cycle
 *   node scripts/unused-exports.mjs --root <dir>       scan <dir> instead of this repo (the self-test uses it)
 *
 * 2.86: a plain search overstated what could be cut twice (56 "dead" settings were 2), so this tool is conservative on
 * purpose: every identifier token of every other code file, comments, strings and docs included, counts as a use. It
 * is a way to find CANDIDATES; nothing is removed on its word alone (each removal is then proved by the checks and units).
 *
 * Classes of an export in harness/ or scripts/:
 *   USED       its name is written in another file that is not under qa/ (code, package.json, a doc, a role page)
 *   TEST-ONLY  its name is written only under qa/
 *   INTERNAL   written nowhere else, but used inside its own file besides its definition (a module's own command-line part
 *              is such a use)
 *   DEAD       written nowhere else and not used in its own file
 * UNREACHED MODULE: a harness/ module whose file name ("x.mjs") no other file writes (no import, no dynamic import, no
 * package.json script, no doc, no hook). testOnly is true when only qa/ names it.
 * Exit 0 always (a report).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', '.git', '.lanes', '.studio', '.worktrees']);
const MIN_DUP_LINES = 6;

const fwd = (p) => p.split(path.sep).join('/');

function walk(root, rel, accept, out) {
  let ents;
  try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (SKIP_DIRS.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, r, accept, out);
    else if (accept(r)) out.push(r);
  }
  return out;
}

/**
 * Every file the rule counts as a possible user, as repo-relative forward-slash paths: every file of the checkout that
 * is not media or a binary by its extension and is under 2 MB, whatever its extension or none (2.86: the commit-msg
 * hook, a shell script with no extension, imports a function nothing else names; a list by extension called it dead).
 */
const NOT_TEXT = /\.(?:png|jpe?g|gif|webp|bmp|ico|icns|svgz|glb|gltf|bin|fbx|blend|woff2?|ttf|otf|eot|mp3|wav|ogg|flac|mp4|webm|mov|zip|gz|tgz|7z|pdf|wasm|dll|exe|so|dylib|pck|uid|lock)$/i;
export function listFiles(root) {
  const out = walk(root, '', (r) => {
    if (NOT_TEXT.test(r)) return false;
    try { return fs.statSync(path.join(root, r)).size <= 2 * 1024 * 1024; } catch { return false; }
  }, []);
  return out.sort();
}

/**
 * A copy of the source with the same length and the same line breaks in which comments (and, with `strings`, the
 * insides of strings, templates and regex literals) are blanked, so a brace or an `export` found in it is real code.
 */
export function mask(src, strings) {
  const n = src.length;
  const out = src.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  const frames = [{ k: 'code', d: 0 }];
  const REGEX_AFTER = '(,=:[!&|?{};+-*%<>~^';
  const KW = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
  let prev = '';
  let word = '';
  let i = 0;
  while (i < n) {
    const f = frames[frames.length - 1];
    const c = src[i];
    if (f.k === 'tpl') {
      if (c === '\\') { if (strings) blank(i, Math.min(i + 2, n)); i += 2; continue; }
      if (c === '`') { frames.pop(); prev = '"'; i++; continue; }
      if (c === '$' && src[i + 1] === '{') { frames.push({ k: 'code', d: 0 }); prev = '{'; i += 2; continue; }
      if (strings) blank(i, i + 1);
      i++;
      continue;
    }
    const d = src[i + 1];
    if (c === '/' && d === '/') { let j = src.indexOf('\n', i); if (j < 0) j = n; blank(i, j); i = j; continue; }
    if (c === '/' && d === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; blank(i, j); i = j; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      j = Math.min(j + 1, n);
      if (strings) blank(i + 1, j - 1);
      i = j; prev = '"'; word = '';
      continue;
    }
    if (c === '`') { frames.push({ k: 'tpl' }); i++; continue; }
    if (c === '/' && (prev === '' || REGEX_AFTER.includes(prev) || KW.has(word))) {
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break;
        j++;
      }
      if (src[j] === '/') { if (strings) blank(i + 1, j); i = j + 1; prev = '"'; word = ''; continue; }
    }
    if (c === '{') f.d++;
    else if (c === '}') { if (f.d === 0 && frames.length > 1) { frames.pop(); i++; prev = '"'; continue; } f.d--; }
    if (/[A-Za-z0-9_$]/.test(c)) { let j = i; while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++; word = src.slice(i, j); prev = 'a'; i = j; continue; }
    if (!/\s/.test(c)) { prev = c; word = ''; }
    i++;
  }
  return out.join('');
}

const lineOf = (text, idx) => { let n = 1; for (let k = text.indexOf('\n'); k >= 0 && k < idx; k = text.indexOf('\n', k + 1)) n++; return n; };

/** Index just past the bracket that closes the one at `open` (in a masked text), or -1. */
function closeOf(m, open) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const stack = [];
  for (let i = open; i < m.length; i++) {
    const c = m[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === '}' || c === ')' || c === ']') { if (stack.pop() !== c) return -1; if (!stack.length) return i + 1; }
  }
  return -1;
}

/** End index of a top-level statement that starts at `start` (masked text): its closing `;`, or the end of its last line. */
function statementEnd(m, start) {
  let depth = 0;
  for (let i = start; i < m.length; i++) {
    const c = m[i];
    if ('{(['.includes(c)) depth++;
    else if ('})]'.includes(c)) depth--;
    else if (c === ';' && depth === 0) return i + 1;
    else if (c === '\n' && depth === 0) {
      const rest = m.slice(i + 1).match(/^\s*(\S)/);
      if (!rest || !'.?:+-*/%&|=<>,'.includes(rest[1])) return i;
    }
  }
  return m.length;
}

/** Every export of one module: { name, local, line, kind, size, listed }. Re-exports (`export ... from`) are not definitions and are skipped. */
export function findExports(src) {
  const text = String(src).replace(/\r\n?/g, '\n');
  const m = mask(text, true);
  const items = [];
  const push = (name, local, idx, kind, listed, end) => {
    const line = lineOf(text, idx);
    items.push({ name, local, line, kind, listed, size: end == null ? 1 : lineOf(text, Math.max(idx, end - 1)) - line + 1 });
  };
  let r = /^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm;
  for (let x = r.exec(m); x; x = r.exec(m)) {
    const open = m.indexOf('(', x.index + x[0].length - 1);
    const pClose = closeOf(m, open);
    const bOpen = pClose < 0 ? -1 : m.indexOf('{', pClose);
    const end = bOpen < 0 ? -1 : closeOf(m, bOpen);
    push(x[1], x[1], x.index, 'function', false, end < 0 ? null : end);
  }
  r = /^export\s+(const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (let x = r.exec(m); x; x = r.exec(m)) {
    let end;
    if (x[1] === 'class') { const b = m.indexOf('{', x.index); end = b < 0 ? null : closeOf(m, b); if (end < 0) end = null; } else end = statementEnd(m, x.index);
    push(x[2], x[2], x.index, x[1], false, end);
  }
  r = /^export\s*\{([^}]*)\}\s*(from\b)?/gm;
  for (let x = r.exec(m); x; x = r.exec(m)) {
    if (x[2]) continue;
    for (const part of x[1].split(',')) {
      const mm = part.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (mm && (mm[2] || mm[1]) !== 'default') push(mm[2] || mm[1], mm[1], x.index, 'list', true, null);
    }
  }
  return items.sort((a, b) => a.line - b.line);
}

const TOKEN = /[A-Za-z_$][\w$]*/g;
const tokensOf = (text) => new Set(text.match(TOKEN) || []);
const countOf = (text, name) => { let n = 0; for (const t of text.match(TOKEN) || []) if (t === name) n++; return n; };
const MJS_NAME = /[\w.-]+\.(?:mjs|js|cjs)\b/g;

/** Compute the whole report for the tree at `root`. */
export function analyze(root) {
  const files = listFiles(root);
  const raw = new Map();
  const toks = new Map();
  const names = new Map();
  for (const f of files) {
    let t = '';
    try { t = fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n?/g, '\n'); } catch { /* unreadable: no tokens */ }
    raw.set(f, t);
    toks.set(f, tokensOf(t));
    names.set(f, new Set((t.match(MJS_NAME) || []).map((s) => s.split('/').pop())));
  }
  const inScope = (f) => /^(?:harness|scripts)\/.*\.mjs$/.test(f);
  const exportsOut = [];
  for (const f of files.filter(inScope)) {
    const text = raw.get(f);
    const own = mask(text, false);
    for (const e of findExports(text)) {
      const other = files.filter((g) => g !== f && toks.get(g).has(e.name));
      let cls;
      if (other.some((g) => !g.startsWith('qa/'))) cls = 'USED';
      else if (other.length) cls = 'TEST-ONLY';
      else cls = countOf(own, e.local) > (e.listed ? 2 : 1) ? 'INTERNAL' : 'DEAD';
      exportsOut.push({ file: f, name: e.name, line: e.line, kind: e.kind, size: e.size, class: cls, users: cls === 'TEST-ONLY' ? other : undefined });
    }
  }
  const unreached = [];
  for (const f of files.filter((x) => /^harness\/.*\.mjs$/.test(x))) {
    const b = f.split('/').pop();
    const users = files.filter((g) => g !== f && names.get(g).has(b));
    if (users.some((g) => !g.startsWith('qa/'))) continue;
    unreached.push({ file: f, testOnly: users.length > 0, tests: users, cli: /process\.argv|import\.meta\.url/.test(raw.get(f)), lines: raw.get(f).split('\n').length });
  }
  const counts = { USED: 0, 'TEST-ONLY': 0, INTERNAL: 0, DEAD: 0 };
  for (const e of exportsOut) counts[e.class]++;
  return { counts, unreachedModules: unreached.length, exports: exportsOut, unreached };
}

// ---------------------------------------------------------------- duplicates

/** Static and dynamic imports of one module, resolved to repo-relative files that exist in `known`. */
export function importsOf(file, text, known) {
  const m = mask(String(text).replace(/\r\n?/g, '\n'), false);
  const out = new Set();
  const specs = [];
  for (const rx of [/\b(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (let x = rx.exec(m); x; x = rx.exec(m)) specs.push(x[1]);
  }
  for (const s of specs) {
    if (!s.startsWith('.')) continue;
    const t = path.posix.normalize(path.posix.join(path.posix.dirname(file), s));
    if (known.has(t)) out.add(t);
  }
  return out;
}

export function reach(graph, start) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const x = stack.pop();
    for (const y of graph.get(x) || []) if (!seen.has(y)) { seen.add(y); stack.push(y); }
  }
  return seen;
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new', 'await', 'async', 'throw', 'of', 'in']);

/** Functions of MIN_DUP_LINES+ lines defined at the top level of a module: { name, line, lines, exported, fp, calls }. */
export function findFunctions(src) {
  const text = String(src).replace(/\r\n?/g, '\n');
  const m = mask(text, true);
  const c = mask(text, false);
  const out = [];
  const add = (name, idx, exported, bodyStart, end) => {
    if (end < 0) return;
    const line = lineOf(text, idx);
    const lines = lineOf(text, end - 1) - line + 1;
    if (lines < MIN_DUP_LINES) return;
    const fp = c.slice(bodyStart, end).replace(/\s+/g, ' ').trim();
    const calls = [...new Set((m.slice(bodyStart, end).match(/(?<![.\w$])[A-Za-z_$][\w$]*(?=\s*\()/g) || []).filter((k) => !KEYWORDS.has(k)))].sort();
    out.push({ name, line, lines, exported, fp, calls });
  };
  let r = /^(export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm;
  for (let x = r.exec(m); x; x = r.exec(m)) {
    const open = x.index + x[0].length - 1;
    const pClose = closeOf(m, open);
    const bOpen = pClose < 0 ? -1 : m.indexOf('{', pClose);
    add(x[2], x.index, Boolean(x[1]), open, bOpen < 0 ? -1 : closeOf(m, bOpen));
  }
  r = /^(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/gm;
  for (let x = r.exec(m); x; x = r.exec(m)) {
    const bOpen = x.index + x[0].length - 1;
    add(x[2], x.index, Boolean(x[1]), x.index + x[0].indexOf('=') + 1, closeOf(m, bOpen));
  }
  return out;
}

/** Groups of identical functions in 2+ harness files, each with the folds that would not make an import cycle. */
export function duplicates(root) {
  const files = listFiles(root);
  const known = new Set(files);
  const graph = new Map();
  const byFp = new Map();
  for (const f of files.filter((x) => /^(?:harness|scripts)\/.*\.mjs$/.test(x))) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    graph.set(f, importsOf(f, text, known));
    if (!f.startsWith('harness/')) continue;
    for (const fn of findFunctions(text)) {
      const k = fn.fp;
      if (!byFp.has(k)) byFp.set(k, []);
      byFp.get(k).push({ file: f, ...fn });
    }
  }
  const groups = [];
  for (const defs of byFp.values()) {
    if (new Set(defs.map((d) => d.file)).size < 2) continue;
    let best = null;
    for (const keep of defs) {
      const fold = [];
      const refused = [];
      const r = reach(graph, keep.file);
      for (const d of defs) {
        if (d.file === keep.file) continue;
        if (d.name !== keep.name) refused.push({ file: d.file, reason: `different name (${d.name} vs ${keep.name})` });
        else if (r.has(d.file)) refused.push({ file: d.file, reason: `import cycle: ${keep.file} already imports ${d.file}, directly or through others` });
        else fold.push(d.file);
      }
      if (!best || fold.length > best.fold.length) best = { keep: keep.file, name: keep.name, keepExported: keep.exported, fold, refused };
    }
    groups.push({ name: defs[0].name, lines: defs[0].lines, calls: defs[0].calls, defs: defs.map((d) => ({ file: d.file, line: d.line, name: d.name, exported: d.exported })), ...best });
  }
  return groups.sort((a, b) => b.lines * b.defs.length - a.lines * a.defs.length);
}

// ---------------------------------------------------------------- command line

function main(argv) {
  const t0 = Date.now();
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const root = path.resolve(opt('--root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (argv.includes('--duplicates')) {
    const groups = duplicates(root);
    if (argv.includes('--json')) { console.log(JSON.stringify({ groups }, null, 2)); return; }
    for (const g of groups) {
      console.log(`${g.name} (${g.lines} lines) in ${g.defs.length} files; keep ${g.keep}${g.keepExported ? '' : ' (needs export)'}`);
      for (const d of g.defs) console.log(`  ${d.file}:${d.line}${d.name === g.name ? '' : ` as ${d.name}`}`);
      if (g.fold.length) console.log(`  can import from the kept one: ${g.fold.join(', ')}`);
      for (const x of g.refused) console.log(`  refused ${x.file}: ${x.reason}`);
      console.log(`  calls: ${g.calls.join(', ') || '(none)'}`);
    }
    console.log(`${groups.length} group(s), ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }
  const rep = analyze(root);
  rep.seconds = (Date.now() - t0) / 1000;
  if (argv.includes('--json')) { console.log(JSON.stringify(rep, null, 2)); return; }
  const list = opt('--list');
  if (list) {
    if (list.toUpperCase() === 'UNREACHED') {
      for (const u of rep.unreached) console.log(`${u.file} (${u.lines} lines${u.cli ? ', has a command line' : ''}${u.testOnly ? `, named only by ${u.tests.join(', ')}` : ''})`);
      return;
    }
    const items = rep.exports.filter((e) => e.class === list.toUpperCase()).sort((a, b) => b.size - a.size || a.file.localeCompare(b.file));
    for (const e of items) console.log(`${e.file}:${e.line} ${e.name} (${e.kind}, ${e.size} lines)${e.users ? ` <- ${e.users.join(', ')}` : ''}`);
    return;
  }
  for (const [k, v] of Object.entries(rep.counts)) console.log(`${k.padEnd(10)} ${v}`);
  console.log(`UNREACHED MODULES ${rep.unreachedModules}`);
  console.log(`${rep.seconds.toFixed(1)}s`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
