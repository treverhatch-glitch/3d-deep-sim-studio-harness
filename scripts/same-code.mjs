#!/usr/bin/env node
/**
 * scripts/same-code.mjs — 2.84: proof that a change touched comments only.
 *
 *   node scripts/same-code.mjs <base-commit> <file>...     each file's code tokens against that commit's version
 *   node scripts/same-code.mjs --measure <file>...         comment bytes per file, largest first
 *
 * Reads each file with the TypeScript parser (a devDependency), lists every code token (strings, template parts and
 * regexes included; comments and white space left out) and compares the two lists. Exit 0: every file has the same
 * code; exit 1: a file differs (the first differing tokens are printed) or does not parse. Used for the 2.84 comment
 * trim; use it for any change that claims "comments only".
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

/** { toks: [kind:text], com: comment bytes, diag: parse errors } of one source text. */
export function scan(text) {
  const sf = ts.createSourceFile('x.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const toks = [];
  const seen = new Set();
  let com = 0;
  const walk = (n) => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (n.getChildCount(sf) === 0 && n.kind !== ts.SyntaxKind.EndOfFileToken) toks.push(`${n.kind}:${n.getText(sf)}`);
    for (const rs of [ts.getLeadingCommentRanges(text, n.getFullStart()) || [], ts.getTrailingCommentRanges(text, n.getEnd()) || []]) {
      for (const r of rs) if (!seen.has(r.pos)) { seen.add(r.pos); com += r.end - r.pos; }
    }
    n.getChildren(sf).forEach(walk);
  };
  walk(sf);
  return { toks, com, diag: sf.parseDiagnostics.length };
}

/** { same, at, a, b } for two source texts. */
export function sameCode(before, after) {
  const A = scan(before); const B = scan(after);
  let i = 0;
  while (i < A.toks.length && i < B.toks.length && A.toks[i] === B.toks[i]) i += 1;
  const same = i === A.toks.length && i === B.toks.length && B.diag === 0;
  return { same, at: same ? -1 : i, a: A, b: B };
}

function main(argv) {
  if (argv[0] === '--measure') {
    const rows = argv.slice(1).map((f) => { const s = fs.readFileSync(f, 'utf8'); return [scan(s).com, s.length, f]; }).sort((x, y) => y[0] - x[0]);
    const tot = rows.reduce((n, r) => n + r[1], 0); const com = rows.reduce((n, r) => n + r[0], 0);
    console.log(`${rows.length} file(s): ${tot} bytes, ${com} of them comments (${tot ? ((100 * com) / tot).toFixed(1) : 0}%)`);
    for (const r of rows.slice(0, 20)) console.log(`${String(r[0]).padStart(8)} of ${String(r[1]).padStart(8)}  ${r[2]}`);
    return 0;
  }
  const [base, ...files] = argv;
  if (!base || !files.length) { console.error('Usage: node scripts/same-code.mjs <base-commit> <file>... | --measure <file>...'); return 2; }
  let bad = 0;
  for (const f of files) {
    const r = spawnSync('git', ['show', `${base}:${f.split('\\').join('/')}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    if (r.status !== 0) { console.log(`${f}: not in ${base} (${String(r.stderr || '').trim().slice(0, 120)})`); bad += 1; continue; }
    const v = sameCode(r.stdout, fs.readFileSync(f, 'utf8'));
    if (v.same) console.log(`${f}: same code (${v.a.toks.length} tokens); comments ${v.a.com} -> ${v.b.com} bytes`);
    else { bad += 1; console.log(`${f}: DIFFERENT${v.b.diag ? ` (${v.b.diag} parse error(s))` : ''} at token ${v.at}: ${JSON.stringify(v.a.toks.slice(v.at, v.at + 3)).slice(0, 240)} became ${JSON.stringify(v.b.toks.slice(v.at, v.at + 3)).slice(0, 240)}`); }
  }
  return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/same-code.mjs')) process.exit(main(process.argv.slice(2)));
