#!/usr/bin/env node
/**
 * scripts/check-names.mjs — 2.86: no name that is used and defined nowhere.
 *
 * A name read in a branch that few runs take (a hand-back text, an error path) and declared in another block, or
 * removed by a refactor, is a ReferenceError that waits for that branch. One shipped to a pull request in 2.86: the
 * engine train's "bisect stopped at its cap" hand-back named a variable declared in a block it could not see, and the
 * train would have ended there with a crash. No self-test of the new code took that branch; an older one did.
 *
 * The TypeScript compiler (already a dependency: the map and the size check parse with it) reads every JavaScript
 * file of harness/, scripts/, qa/ and the hooks as JavaScript and reports only three findings: a name it cannot find
 * (2304), a name it cannot find with a near miss (2552) and a shorthand property with no value in scope (18004).
 * Types are not checked: nothing else it says is shown.
 *
 * Usage: node scripts/check-names.mjs [--json] [--root <dir>] [<file> ...]
 *   --root  check <dir> instead of this repo (the self-test uses it)
 * Exit 0 clean, 1 when a name is not defined, 2 when the compiler is not installed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CODES = new Set([2304, 2552, 18004]);
const DIRS = ['harness', 'scripts', 'qa', 'tools', '.claude/hooks'];
const SKIP = /(^|[\\/])(node_modules|fixtures|\.lanes|\.studio)([\\/]|$)/;

/** Every .mjs/.js/.cjs file under the checked folders of root (not node_modules, fixtures or state folders). */
function nameCheckFiles(root) {
  const out = [];
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      if (SKIP.test(f)) continue;
      if (e.isDirectory()) walk(f);
      else if (/\.(mjs|cjs|js)$/.test(e.name)) out.push(f);
    }
  };
  for (const d of DIRS) walk(path.join(root, d));
  return out.sort();
}

/** [{ file, line, col, code, text }] for the files given: names used and defined nowhere. */
async function undefinedNames(files, { root = process.cwd() } = {}) {
  const ts = (await import('typescript')).default;
  const program = ts.createProgram(files, { allowJs: true, checkJs: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true });
  const want = new Set(files.map((f) => path.resolve(f)));
  const found = [];
  for (const sf of program.getSourceFiles()) {
    if (!want.has(path.resolve(sf.fileName))) continue;
    for (const d of program.getSemanticDiagnostics(sf)) {
      if (!CODES.has(d.code) || !d.file) continue;
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start || 0);
      found.push({ file: path.relative(root, d.file.fileName).split(path.sep).join('/'), line: line + 1, col: character + 1, code: d.code, text: ts.flattenDiagnosticMessageText(d.messageText, ' ') });
    }
  }
  return found;
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const ri = args.indexOf('--root');
  const root = path.resolve(ri >= 0 ? args[ri + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const named = args.filter((a, i) => !a.startsWith('--') && !(ri >= 0 && i === ri + 1));
  const files = named.length ? named.map((f) => path.resolve(f)) : nameCheckFiles(root);
  let found;
  try { found = await undefinedNames(files, { root }); } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') { console.error('[check-names] typescript is not installed (npm ci); nothing was checked.'); process.exit(2); }
    throw e;
  }
  if (json) console.log(JSON.stringify({ files: files.length, found }));
  else if (found.length) { for (const f of found) console.error(`${f.file}:${f.line}:${f.col} ${f.text}`); console.error(`[check-names] ${found.length} name(s) used and defined nowhere, in ${files.length} file(s).`); }
  else console.log(`[check-names] ok: ${files.length} file(s), every name is defined.`);
  process.exit(found.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
