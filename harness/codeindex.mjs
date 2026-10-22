/**
 * harness/codeindex.mjs — functions and top-level names in a code file, with their line ranges (2.29).
 *
 * A real parse (the TypeScript compiler reads JavaScript too), used by `npm run map -- find <name>` (one
 * call answers "where is X and what does it take") and by the function-size check. Jed's sandbox test:
 * a map read first, then line ranges, cost 27% more than reading the file, because it added turns; a
 * lookup that answers in one call is the part worth having. GDScript files get a simpler line scan.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createRequire } from 'node:module';

// Loaded synchronously (the done-check is synchronous); the harness lists typescript as a dev dependency.
let ts = null;
function compiler() {
  if (ts === null) {
    try {
      ts = createRequire(import.meta.url)('typescript');
    } catch {
      ts = false;
    }
  }
  return ts;
}

const JS = /\.(m?js|cjs|jsx|tsx?)$/i;

/** GDScript: `func name(args)` until the next top-level `func`, `class` or end of file. */
function indexGd(text) {
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  lines.forEach((l, i) => {
    const m = l.match(/^(?:static\s+)?func\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/);
    if (m || /^(class|class_name)\b/.test(l)) {
      if (cur) out.push({ ...cur, end: lastCode(lines, cur.start - 1, i - 1) + 1 });
      cur = m ? { kind: 'function', name: m[1], params: m[2].trim(), start: i + 1 } : null;
    }
  });
  if (cur) out.push({ ...cur, end: lastCode(lines, cur.start - 1, lines.length - 1) + 1 });
  return out.map((f) => ({ ...f, lines: f.end - f.start + 1 }));
}
const lastCode = (lines, from, to) => {
  for (let i = to; i > from; i -= 1) if (lines[i].trim()) return i;
  return from;
};

/** { functions: [{ name, kind, params, start, end, lines }], names: [{ name, kind, start, keys? }] } */
export function indexFile(file, text = fs.readFileSync(file, 'utf8')) {
  if (/\.gd$/i.test(file)) return { functions: indexGd(text), names: [] };
  if (!JS.test(file)) return { functions: [], names: [] };
  const t = compiler();
  if (!t) return { functions: [], names: [], parser: 'missing' };
  const sf = t.createSourceFile(file, text, t.ScriptTarget.Latest, true, /x$/i.test(file) ? t.ScriptKind.TSX : /ts$/i.test(file) ? t.ScriptKind.TS : t.ScriptKind.JS);
  const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const functions = [];
  const names = [];
  const params = (fn) => (fn.parameters || []).map((p) => p.name.getText(sf)).join(', ');
  const nameOf = (node) => {
    if (node.name && t.isIdentifier(node.name)) return node.name.text;
    if (node.name) return node.name.getText(sf);
    const p = node.parent;
    if (p && t.isVariableDeclaration(p) && t.isIdentifier(p.name)) return p.name.text;
    if (p && (t.isPropertyAssignment(p) || t.isPropertyDeclaration(p))) return p.name.getText(sf);
    if (p && t.isBinaryExpression(p)) return p.left.getText(sf).slice(0, 40);
    return null;
  };
  const visit = (node) => {
    if (t.isFunctionDeclaration(node) || t.isMethodDeclaration(node) || t.isFunctionExpression(node) || t.isArrowFunction(node) || t.isGetAccessor(node) || t.isSetAccessor(node) || t.isConstructorDeclaration(node)) {
      const start = line(node.getStart(sf));
      const end = line(node.getEnd());
      const name = t.isConstructorDeclaration(node) ? 'constructor' : nameOf(node);
      // Small anonymous callbacks are noise in a lookup; long ones still count for the size check.
      if (name || end - start + 1 > 20) functions.push({ kind: 'function', name: name || `(anonymous, line ${start})`, params: params(node), start, end, lines: end - start + 1 });
    }
    if (t.isClassDeclaration(node) && node.name) names.push({ kind: 'class', name: node.name.text, start: line(node.getStart(sf)), end: line(node.getEnd()) });
    t.forEachChild(node, visit);
  };
  visit(sf);
  // Top-level names, with the keys of object literals (TUNING tables and the like).
  for (const st of sf.statements) {
    if (!t.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!t.isIdentifier(d.name)) continue;
      let init = d.initializer;
      while (init && (t.isAsExpression?.(init) || t.isParenthesizedExpression(init) || (t.isCallExpression(init) && /freeze$/.test(init.expression.getText(sf))))) init = t.isCallExpression(init) ? init.arguments[0] : init.expression;
      const keys = init && t.isObjectLiteralExpression(init) ? init.properties.filter((p) => p.name).map((p) => ({ name: p.name.getText(sf), line: line(p.getStart(sf)) })) : null;
      names.push({ kind: 'const', name: d.name.text, start: line(d.getStart(sf)), end: line(d.getEnd()), ...(keys ? { keys } : {}) });
    }
  }
  return { functions, names };
}

/** Code files under the given roots (relative to `root`). */
export function codeFiles(root, roots, skip = new Set(['node_modules', '.git', '.studio', '.lanes', 'dist', 'build', 'export', '.godot', '__pycache__'])) {
  const out = [];
  const walk = (rel) => {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) return;
    for (const e of fs.readdirSync(full, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!skip.has(e.name) && !e.name.startsWith('.')) walk(r);
      } else if ((JS.test(e.name) || /\.gd$/i.test(e.name)) && !/\.min\./.test(e.name)) out.push(r);
    }
  };
  for (const r of roots) walk(r);
  return out;
}
