#!/usr/bin/env node
/**
 * scripts/check-top-level-await.mjs — 2.84: find the import cycle that ends a command with exit 13.
 *
 * The hazard, exactly: module M is run as the entry. At its top level it awaits a DYNAMIC import of X
 * (`await import('./x.mjs')`, also inside a top-level `if` or `try`, or one level down: a top-level `await helper()`
 * where `helper` in the same file holds the `import('./x.mjs')`). X's STATIC import closure (`import ... from`,
 * `export ... from`, `import './y.mjs'`; not dynamic imports) contains M. M is still evaluating, waiting on that
 * await, so X can never finish and Node ends the process with exit code 13 ("unsettled top-level await"). It shipped
 * twice: harness/engine-rules.mjs (2.82) and harness/budget.mjs (2.83). The fix is to wrap the command-line part in an
 * async function, so M finishes evaluating first.
 *
 * The repo has no JavaScript parser among its declared dependencies, so a small scanner does the work: it skips
 * comments, strings, template literals and regex literals, tracks every brace and whether it opens a function (a
 * function, an arrow, a method, a class body), and records each `await` and each `import(...)` seen while no function
 * body is open. An `if (...) { await ... }` block at module level IS top level.
 *
 * Usage: node scripts/check-top-level-await.mjs [--json] [--all] [--root <dir>]
 *   --all   also list (information only, exit 0) every module with a top-level await that another module imports
 *           statically: no cycle today, but a future static import can close one
 *   --root  scan <dir>/harness and <dir>/scripts instead of this repo (the self-test uses it)
 * Exit 0 clean, 1 when an offender is found.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const BLOCK_HEADS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
const NOT_METHOD_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const isIdent = (c) => /[A-Za-z0-9_$\u0080-￿]/.test(c);

/** Scan one module's source. Returns { awaits, imports (static), dynamicImports, awaitCalls }. */
export function scanModule(srcRaw) {
  const src = String(srcRaw).replace(/\r\n?/g, '\n');
  const awaits = [];
  const imports = [];
  const braces = []; // { k: 'fn' | 'blk' | 'tpl', name }
  const parens = []; // { k: 'fn' | 'blk', name } : what a `{` after the matching `)` opens
  const dynamicImports = []; // { spec, line, awaited, fn } : fn is the outermost function holding it, or null
  const awaitCalls = []; // { name, line } : `await name(` at top level
  let awaitInStmt = false; // a top-level await was seen earlier in this top-level statement
  let declName = null; // `const NAME =` just seen: names an arrow function that follows
  const hist = []; // last few significant tokens, newest last
  let line = 1;
  let i = 0;
  let closeClass = { k: 'blk' };
  let pendingClass = null; // paren depth at which a class body is expected
  const n = src.length;
  const push = (t) => { hist.push(t); if (hist.length > 4) hist.shift(); };
  const last = (k = 1) => hist[hist.length - k];
  const fnDepth = () => braces.filter((b) => b.k === 'fn').length;
  let strLine = 1;
  const addString = (text) => {
    const p = last(); const p2 = last(2);
    if (p === 'from' || p === 'import') imports.push(text);
    else if (p === '(' && p2 === 'import') {
      const outer = braces.find((b) => b.k === 'fn');
      dynamicImports.push({ spec: text, line: strLine, awaited: fnDepth() === 0 && awaitInStmt, fn: outer ? outer.name || '' : null });
    }
  };
  const readString = (q) => {
    let s = '';
    i++;
    while (i < n && src[i] !== q && src[i] !== '\n') {
      if (src[i] === '\\') { if (src[i + 1] === '\n') line++; s += src[i + 1] ?? ''; i += 2; continue; }
      s += src[i++];
    }
    if (src[i] === q) i++;
    return s;
  };
  // Reads template text from i (just after a backtick or a closing `}` of a substitution) up to the closing backtick
  // or the next `${` (which pushes a 'tpl' brace and hands control back to the main loop).
  const readTemplate = () => {
    while (i < n) {
      const c = src[i];
      if (c === '\\') { if (src[i + 1] === '\n') line++; i += 2; continue; }
      if (c === '`') { i++; push('`str'); return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; braces.push({ k: 'tpl' }); push('${'); return; }
      if (c === '\n') line++;
      i++;
    }
  };
  const regexAllowed = () => {
    const p = last();
    if (p === undefined) return true;
    if (p === ')' || p === ']' || p === '`str' || p === 'str' || p === 'num') return false;
    if (p === '}') return true;
    if (isIdent(p[0])) return KEYWORDS_BEFORE_REGEX.has(p);
    return true;
  };
  const readRegex = () => {
    i++;
    let inClass = false;
    while (i < n && src[i] !== '\n') {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '[') inClass = true; else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { i++; break; }
      i++;
    }
    while (i < n && isIdent(src[i])) i++; // flags
    push('re');
  };
  if (src.startsWith('#!')) while (i < n && src[i] !== '\n') i++;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'") { strLine = line; const s = readString(c); addString(s); push('str'); continue; }
    if (c === '`') { i++; readTemplate(); continue; }
    if (c === '/') {
      if (regexAllowed()) { readRegex(); continue; }
      i++; push('/'); continue;
    }
    if (isIdent(c)) {
      let j = i; while (j < n && isIdent(src[j])) j++;
      const w = src.slice(i, j);
      const startLine = line;
      if (/^[0-9]/.test(w)) push('num');
      else {
        if (w === 'await' && last() !== '.' && last() !== '?.' && fnDepth() === 0) {
          awaits.push({ line: startLine, forAwait: last() === 'for' });
          awaitInStmt = true;
        }
        if (w === 'class') pendingClass = parens.length;
        if (last() === '=' && last(2) && isIdent(last(2)[0]) && ['const', 'let', 'var'].includes(last(3))) declName = last(2);
        push(w);
      }
      i = j; continue;
    }
    if (c === '=' && src[i + 1] === '>') { i += 2; push('=>'); continue; }
    if (c === '?' && src[i + 1] === '.' && !/[0-9]/.test(src[i + 2] || '')) { i += 2; push('?.'); continue; }
    if (c === '(') {
      const p = last(); const p2 = last(2);
      let cls = 'blk'; let name = null;
      if (fnDepth() === 0 && p2 === 'await' && p && isIdent(p[0]) && !NOT_METHOD_NAMES.has(p)) awaitCalls.push({ name: p, line });
      if (BLOCK_HEADS.has(p) || (p === 'await' && p2 === 'for')) cls = 'blk';
      else if (p === 'function' || p2 === 'function' || (p === '*' && p2 === 'function')) { cls = 'fn'; if (p !== 'function' && p !== '*' && p && isIdent(p[0])) name = p; }
      else if (p && ((isIdent(p[0]) && !NOT_METHOD_NAMES.has(p)) || p === ']' || p === 'str')) { cls = 'fn'; if (isIdent(p[0])) name = p; }
      else if (p === 'async' || p === '=') name = declName; // an arrow: `const NAME = async (...) =>`
      parens.push({ k: cls, name }); push('('); i++; continue;
    }
    if (c === ')') { closeClass = parens.pop() || { k: 'blk' }; push(')'); i++; continue; }
    if (c === '{') {
      let cls = { k: 'blk' };
      if (pendingClass !== null && pendingClass === parens.length) { cls = { k: 'fn', name: '' }; pendingClass = null; }
      else if (last() === '=>') cls = { k: 'fn', name: closeClass.k === 'fn' || closeClass.name ? closeClass.name : declName };
      else if (last() === ')') cls = closeClass.k === 'fn' ? { k: 'fn', name: closeClass.name } : { k: 'blk' };
      if (cls.k === 'fn' && !cls.name && last() === '=>' && last(2) !== ')') cls.name = declName; // `const f = x => {`
      braces.push(cls); push('{'); i++; continue;
    }
    if (c === '}') {
      const top = braces.pop();
      i++;
      if (top && top.k === 'tpl') { readTemplate(); continue; }
      if (braces.length === 0) { awaitInStmt = false; declName = null; }
      push('}'); continue;
    }
    if (c === ';' && braces.length === 0) { awaitInStmt = false; declName = null; }
    i++; push(c);
  }
  return { awaits, imports, dynamicImports, awaitCalls };
}

function listModules(root) {
  const out = [];
  for (const d of ['harness', 'scripts']) {
    const abs = path.join(root, d);
    let names = [];
    try { names = fs.readdirSync(abs); } catch { continue; }
    for (const f of names.sort()) if (f.endsWith('.mjs')) out.push(`${d}/${f}`);
  }
  return out;
}

export function checkTopLevelAwait(root) {
  const files = listModules(root);
  const set = new Set(files);
  const info = new Map();
  const staticOut = new Map(files.map((f) => [f, []])); // f -> modules f imports statically
  const importedBy = new Map(files.map((f) => [f, []]));
  const resolve = (f, spec) => {
    if (!spec.startsWith('.')) return null;
    const t = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
    return set.has(t) ? t : null;
  };
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    const r = scanModule(src);
    info.set(f, { ...r, runnable: /process\.argv\[1\]/.test(src) });
    for (const spec of r.imports) {
      const t = resolve(f, spec);
      if (t && t !== f && !staticOut.get(f).includes(t)) { staticOut.get(f).push(t); importedBy.get(t).push(f); }
    }
  }
  // The shortest static chain from `from` to `target`, as a list of modules, or null.
  const chain = (from, target) => {
    if (from === target) return [from];
    const prev = new Map([[from, null]]); const q = [from];
    while (q.length) {
      const cur = q.shift();
      for (const nx of staticOut.get(cur)) {
        if (prev.has(nx)) continue;
        prev.set(nx, cur);
        if (nx === target) { const out = [nx]; let c = cur; while (c) { out.unshift(c); c = prev.get(c); } return out; }
        q.push(nx);
      }
    }
    return null;
  };
  const offenders = []; const informational = [];
  let both = 0;
  for (const m of files) {
    const { awaits, dynamicImports, awaitCalls, runnable } = info.get(m);
    if (importedBy.get(m).length && runnable) both++;
    if (awaits.length && importedBy.get(m).length) informational.push({ file: m, line: awaits[0].line, importedBy: importedBy.get(m).slice().sort()[0] });
    const hazards = []; // { x, line }
    for (const d of dynamicImports) if (d.awaited) hazards.push({ x: resolve(m, d.spec), spec: d.spec, line: d.line });
    for (const c of awaitCalls) for (const d of dynamicImports) if (d.fn === c.name) hazards.push({ x: resolve(m, d.spec), spec: d.spec, line: c.line });
    const seen = new Set();
    for (const h of hazards) {
      if (!h.x) continue;
      const key = `${h.x}:${h.line}`; if (seen.has(key)) continue; seen.add(key);
      const ch = chain(h.x, m);
      if (ch) offenders.push({ file: m, line: h.line, imports: h.x, chain: ch });
    }
  }
  return { checked: files.length, both, offenders, informational };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const ri = args.indexOf('--root');
  const root = ri >= 0 ? path.resolve(args[ri + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const res = checkTopLevelAwait(root);
  const all = args.includes('--all');
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ok: res.offenders.length === 0, ...res, informational: all ? res.informational : undefined }, null, 2));
  } else {
    const base = (f) => path.posix.basename(f, '.mjs');
    for (const o of res.offenders) console.log(`${o.file}:${o.line} awaits import('./${path.posix.basename(o.imports)}') at top level, and ${path.posix.basename(o.imports)} reaches ${path.posix.basename(o.file)} through static imports (${o.chain.map(base).join(' \u2192 ')}): run as a command this exits 13`);
    if (all) for (const o of res.informational) console.log(`${o.file}:${o.line} top-level await in a module that ${o.importedBy} imports (latent; informational)`);
    if (res.offenders.length === 0) console.log(`PASS — ${res.checked} modules checked, ${res.both} both imported and runnable`);
    else console.log(`FAIL — ${res.offenders.length} import cycle(s) through a top-level await; wrap the command-line part in an async function (see docs/RELEASE.md)`);
  }
  process.exitCode = res.offenders.length ? 1 : 0; // not process.exit: a piped --json must flush
}
