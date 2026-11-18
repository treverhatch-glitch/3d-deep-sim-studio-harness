#!/usr/bin/env node
/**
 * scripts/check-comments.mjs — the length rule for comments in harness/, scripts/ and qa/ (npm run check:comments).
 * A file's header comment is at most 12 lines and any other comment at most 6, counting every line of it. A comment
 * says what the code does, how to run it and what would otherwise go wrong; how a subsystem works is in docs/, and
 * what changed when is in CHANGELOG.md and git. A run of `//` lines that each stand alone counts as one comment.
 *
 * Usage: node scripts/check-comments.mjs [--json] [--root <dir>] [<file> ...]
 * Exit 0 within the rule, 1 when a comment is over it (each is named with file, line and its length), 2 when the
 * TypeScript parser is not installed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADER_LINES = 12;
const COMMENT_LINES = 6;
const DIRS = ['harness', 'scripts', 'qa'];
const SKIP = /(^|[\\/])(node_modules|fixtures)([\\/]|$)/;

/** The .mjs/.cjs/.js files under the folders `dirs` of root, skipping paths that match `skip`. Sorted. */
export function jsFilesUnder(root, dirs, skip) {
  const out = [];
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      if (skip.test(f)) continue;
      if (e.isDirectory()) walk(f);
      else if (/\.(mjs|cjs|js)$/.test(e.name)) out.push(f);
    }
  };
  for (const d of dirs) walk(path.join(root, d));
  return out.sort();
}

function codeFiles(root) {
  return jsFilesUnder(root, DIRS, SKIP);
}

/** The comments of one file that stand on their own lines: [{ line, lines, header }]. */
function commentBlocks(ts, text, file) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const seen = new Map();
  const visit = (n) => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    for (const r of [...(ts.getLeadingCommentRanges(text, n.getFullStart()) || []), ...(ts.getTrailingCommentRanges(text, n.getEnd()) || [])]) if (!seen.has(r.pos)) seen.set(r.pos, r);
    if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const ranges = [...seen.values()].sort((a, b) => a.pos - b.pos);
  const lineStart = (p) => text.lastIndexOf('\n', p - 1) + 1;
  const lineEnd = (p) => { const i = text.indexOf('\n', p); return i < 0 ? text.length : i; };
  const alone = (r) => text.slice(lineStart(r.pos), r.pos).trim() === '' && text.slice(r.end, lineEnd(r.end)).trim() === '';
  const firstCode = sf.statements.length ? sf.statements[0].getStart(sf) : text.length;
  const blocks = [];
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (!alone(r)) continue;
    let end = r.end;
    if (r.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
      // A run of // lines: the next one starts on the very next line.
      while (i + 1 < ranges.length && ranges[i + 1].kind === ts.SyntaxKind.SingleLineCommentTrivia && alone(ranges[i + 1]) && /^\r?\n[ \t]*$/.test(text.slice(end, ranges[i + 1].pos))) end = ranges[++i].end;
    }
    const start = lineStart(r.pos);
    const header = blocks.length === 0 && end <= firstCode && text.slice(0, start).replace(/^#!.*\n/, '').trim() === '' && /^\s*\/\*\*/.test(text.slice(start, end));
    blocks.push({ line: sf.getLineAndCharacterOfPosition(start).line + 1, lines: text.slice(start, end).split('\n').length, header });
  }
  return blocks;
}

async function main() {
  const args = process.argv.slice(2);
  const ri = args.indexOf('--root');
  const root = path.resolve(ri >= 0 ? args[ri + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const named = args.filter((a, i) => !a.startsWith('--') && !(ri >= 0 && i === ri + 1));
  let ts;
  try { ts = (await import('typescript')).default; } catch { console.error('[check-comments] typescript is not installed (npm ci); nothing was checked.'); process.exit(2); }
  const files = named.length ? named.map((f) => path.resolve(f)) : codeFiles(root);
  const over = [];
  let comments = 0, lines = 0;
  for (const f of files) {
    for (const b of commentBlocks(ts, fs.readFileSync(f, 'utf8'), f)) {
      comments++; lines += b.lines;
      const cap = b.header ? HEADER_LINES : COMMENT_LINES;
      if (b.lines > cap) over.push({ file: path.relative(root, f).split(path.sep).join('/'), line: b.line, lines: b.lines, cap, header: b.header });
    }
  }
  if (args.includes('--json')) console.log(JSON.stringify({ files: files.length, comments, lines, over }));
  else if (over.length) {
    for (const o of over) console.error(`${o.file}:${o.line} ${o.header ? 'the file header' : 'a comment'} is ${o.lines} lines; the rule is ${o.cap}`);
    console.error(`[check-comments] ${over.length} comment(s) over the rule. Say what the code does and why; how it works goes in docs/, what changed goes in CHANGELOG.md.`);
  } else console.log(`[check-comments] ok: ${files.length} file(s), ${comments} comment(s), ${lines} line(s), none over ${HEADER_LINES} (header) or ${COMMENT_LINES}.`);
  process.exit(over.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
