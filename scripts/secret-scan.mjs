#!/usr/bin/env node
/**
 * scripts/secret-scan.mjs [root] [--staged] — fail if a key-shaped string would be committed.
 *
 * In a git checkout it scans exactly what git would publish: tracked files plus untracked files
 * that are not ignored. Your own .env (ignored) never trips it, so private clones stay green.
 * --staged scans what is staged, read from the index (the pre-commit hook), not the file on disk: a token staged
 * and then cleaned only in the file is what the commit would hold (PU-33, P-046). Outside git it scans the folder.
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

const git = (a, opts = {}) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, ...opts });

// Where ROOT sits in git: inGit, and the path from the repo's top to ROOT ('' at the top, 'sub/dir/' below it).
const where = git(['rev-parse', '--is-inside-work-tree', '--show-prefix']);
const whereLines = String(where.stdout || '').split('\n');
const IN_GIT = where.status === 0 && whereLines[0] === 'true';
const PREFIX = IN_GIT ? whereLines[1] || '' : '';

// PU-33: skips are tied to their real place from the repo's top (before 2.58.0 any secrets.mjs or *.lock
// anywhere was skipped). harness/secrets.mjs spells out the shapes; the root lockfile is npm's hashes.
const SKIP_FILES = new Set(['harness/secrets.mjs', 'package-lock.json']);
const SKIP_DIRS = ['.studio/locks/'];
const skipped = (repoRel) => SKIP_FILES.has(repoRel) || SKIP_DIRS.some((d) => repoRel.startsWith(d));

function listFiles() {
  if (IN_GIT) return git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).stdout.split('\0').filter(Boolean);
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

/** Read blobs from git: Map(oid → Buffer), one cat-file call. */
function readBlobs(oids) {
  const out = new Map();
  const uniq = [...new Set(oids)];
  if (!uniq.length) return out;
  const r = spawnSync('git', ['cat-file', '--batch'], { cwd: ROOT, input: `${uniq.join('\n')}\n`, maxBuffer: 2 ** 31 - 1 });
  if (r.error || r.status !== 0) throw new Error(`git cat-file failed: ${String(r.error?.message || r.stderr || '').trim().slice(0, 200)}`);
  const buf = r.stdout;
  for (let at = 0; at < buf.length; ) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(buf.toString('latin1', at, nl));
    if (!m) { at = nl + 1; continue; } // "<oid> missing"
    const size = Number(m[3]);
    out.set(m[1], buf.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return out;
}

function blobSizes(oids) {
  const out = new Map();
  const uniq = [...new Set(oids)];
  if (!uniq.length) return out;
  const r = git(['cat-file', '--batch-check'], { input: `${uniq.join('\n')}\n` });
  for (const line of String(r.stdout || '').split('\n')) {
    const m = /^([0-9a-f]+) \w+ (\d+)$/.exec(line);
    if (m) out.set(m[1], Number(m[2]));
  }
  return out;
}

/** fn(item, bytes) for each { oid } item up to maxSize bytes, read in batches of about 64 MB (one big asset at a time). */
function eachBlob(items, fn, maxSize = Infinity) {
  const sizes = blobSizes(items.map((x) => x.oid));
  const list = items.filter((x) => sizes.has(x.oid) && sizes.get(x.oid) <= maxSize);
  for (let i = 0; i < list.length; ) {
    const batch = [];
    let total = 0;
    while (i < list.length && (!batch.length || total + sizes.get(list[i].oid) <= 64 * 1024 * 1024)) {
      total += sizes.get(list[i].oid);
      batch.push(list[i]);
      i += 1;
    }
    const blobs = readBlobs(batch.map((x) => x.oid));
    for (const x of batch) fn(x, blobs.get(x.oid));
  }
}

const hits = [];
const record = (rel, text) => {
  for (const [line, kinds] of scanText(text, rel)) hits.push({ rel, line, kinds: [...kinds].sort().join(', ') });
};

function scanWorkingTree() {
  let count = 0;
  for (const rel of listFiles()) {
    const full = path.join(ROOT, rel);
    if (skipped(PREFIX + rel) || !fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    const text = decodeText(fs.readFileSync(full));
    count += 1;
    if (text !== null) record(rel, text);
  }
  return count;
}

/** PU-33 (P-046): the staged blobs, read from the index (`git diff --cached`; GIT_INDEX_FILE is honoured). */
function scanStaged() {
  const r = git(['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames', '--diff-filter=ACMT']);
  if (r.status !== 0) throw new Error(`git diff --cached failed: ${String(r.stderr || '').trim().slice(0, 200)}`);
  const parts = r.stdout.split('\0');
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:\d+ (\d+) [0-9a-f]+ ([0-9a-f]+) /.exec(parts[i]);
    if (!m || !/^100(644|755)$/.test(m[1]) || skipped(parts[i + 1])) continue; // regular files only
    files.push({ rel: parts[i + 1], oid: m[2] });
  }
  eachBlob(files, (f, buf) => {
    const text = buf ? decodeText(buf) : null;
    if (text !== null) record(f.rel, text);
  });
  return files.length;
}

let count = 0;
try {
  count = STAGED && IN_GIT ? scanStaged() : scanWorkingTree();
} catch (err) {
  // Fail closed: a scan that couldn't read what it should is not a pass.
  console.log(`[secrets] FAIL couldn't finish the scan: ${err.message}`);
  process.exit(1);
}
if (hits.length) {
  hits.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.line - b.line));
  console.log('[secrets] FAIL key-shaped string(s) found (values hidden):');
  console.log(hits.map((h) => `  ${h.rel}:${h.line}  ${h.kinds}`).join('\n'));
  console.log('[secrets] Move real keys to .env (gitignored). If one was ever committed, rotate it.');
  process.exit(1);
}
console.log(`[secrets] PASS — ${count} file(s) scanned`);
