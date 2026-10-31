#!/usr/bin/env node
/**
 * scripts/secret-scan.mjs [root] [--staged] — fail if a key-shaped string would be committed.
 *
 * In a git checkout it scans exactly what git would publish: tracked files plus untracked files
 * that are not ignored. Your own .env (ignored) never trips it, so private clones stay green.
 * --staged scans only staged files (used by the pre-commit hook). Outside git it scans the folder.
 * Pure Node, so it runs the same on Windows, macOS and Linux. Values are never printed: a hit is
 * reported as file:line and the kind of secret (for example discord-bot-token).
 *
 * What it looks for (the list is in harness/secrets.mjs, shared with scrub()):
 *   - the provider key shapes (OpenAI, Anthropic, xAI, GitHub, AWS key ids, ...);
 *   - PU-18 (P-040): Discord bot tokens and webhook URLs, Slack webhooks and app/refresh tokens,
 *     Telegram bot tokens, AWS secret access keys and session tokens next to their names;
 *   - a long random-looking value given to a name ending in TOKEN, SECRET, SECRET_KEY, API_KEY, APIKEY,
 *     PRIVATE_KEY, PASSWORD or WEBHOOK(_URL), in env, JSON, YAML, TOML, INI, Dockerfiles or code. Placeholders (empty, <...>, ${...},
 *     $VAR, process.env.X, your-token-here, changeme, xxx, ***, REDACTED, example/dummy/fake/test values,
 *     one character repeated) and word-built values never count;
 *   - any of the token shapes above hidden in base64: a whole quoted or assigned value of 40-400
 *     base64 characters is decoded and scanned again. Longer runs (images, fonts) and data: URIs are not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const STAGED = args.includes('--staged');
const ROOT = path.resolve(args.find((a) => !a.startsWith('--')) || '.');

import { findSecrets } from '../harness/secrets.mjs';

// Where ROOT sits in git: the path from the repo's top to ROOT ('' at the top, 'sub/dir/' below it).
const where = spawnSync('git', ['rev-parse', '--is-inside-work-tree', '--show-prefix'], { cwd: ROOT, encoding: 'utf8' });
const whereLines = String(where.stdout || '').split('\n');
const PREFIX = where.status === 0 && whereLines[0] === 'true' ? whereLines[1] || '' : '';

// PU-33: skips are tied to their real place from the repo's top (before 2.58.0 any secrets.mjs or *.lock
// anywhere was skipped). harness/secrets.mjs spells out the shapes; the root lockfile is npm's hashes.
const SKIP_FILES = new Set(['harness/secrets.mjs', 'package-lock.json']);
const SKIP_DIRS = ['.studio/locks/'];
const skipped = (repoRel) => SKIP_FILES.has(repoRel) || SKIP_DIRS.some((d) => repoRel.startsWith(d));

function listFiles() {
  const git = (a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (git(['rev-parse', '--is-inside-work-tree']).stdout?.trim() === 'true') {
    const r = STAGED ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']) : git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    return r.stdout.split('\0').filter(Boolean);
  }
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.lanes') continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk('');
  return out;
}

/**
 * PU-33: a file's bytes as text, or null when binary. A BOM says UTF-8 or UTF-16 LE/BE (Windows PowerShell 5's `>`
 * writes UTF-16LE with a BOM; before 2.58.0 its NUL bytes made it "binary"); no BOM and a NUL is binary.
 */
function decodeText(buf) {
  let text;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) text = buf.toString('utf8', 3);
  else if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString('utf16le', 2, 2 + ((buf.length - 2) & ~1));
  else if (buf[0] === 0xfe && buf[1] === 0xff) {
    const b = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    text = b.swap16().toString('utf16le');
  } else return buf.subarray(0, 8000).includes(0) ? null : buf.toString('utf8');
  return text.slice(0, 8000).includes('\0') ? null : text;
}

/** Secrets in `text` grouped by line: Map(line → Set(kind)). The list lives in harness/secrets.mjs (PU-33: shared with scrub()). */
function scanText(text, rel) {
  const byLine = new Map();
  let newlines = null;
  const lineOf = (i) => {
    if (!newlines) {
      newlines = [];
      for (let j = text.indexOf('\n'); j >= 0; j = text.indexOf('\n', j + 1)) newlines.push(j);
    }
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  for (const f of findSecrets(text, { path: rel })) {
    const line = lineOf(f.index);
    if (!byLine.has(line)) byLine.set(line, new Set());
    byLine.get(line).add(f.kind);
  }
  // A line whose token has a known shape reports that shape, not also "named-secret".
  for (const kinds of byLine.values()) {
    if ([...kinds].some((k) => !k.startsWith('named-secret'))) for (const k of kinds) if (k.startsWith('named-secret')) kinds.delete(k);
  }
  return byLine;
}

let count = 0;
const hits = [];
for (const rel of listFiles()) {
  const full = path.join(ROOT, rel);
  // --staged lists paths from the repo's top; the folder scan lists them from ROOT.
  if (skipped(STAGED ? rel : PREFIX + rel) || !fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
  const text = decodeText(fs.readFileSync(full));
  count += 1;
  if (text === null) continue; // binary
  for (const [line, kinds] of scanText(text, rel)) hits.push({ rel, line, kinds: [...kinds].sort().join(', ') });
}
if (hits.length) {
  hits.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.line - b.line));
  console.log('[secrets] FAIL key-shaped string(s) found (values hidden):');
  console.log(hits.map((h) => `  ${h.rel}:${h.line}  ${h.kinds}`).join('\n'));
  console.log('[secrets] Move real keys to .env (gitignored). If one was ever committed, rotate it.');
  process.exit(1);
}
console.log(`[secrets] PASS — ${count} file(s) scanned`);
