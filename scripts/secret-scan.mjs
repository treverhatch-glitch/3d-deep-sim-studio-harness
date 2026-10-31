#!/usr/bin/env node
/**
 * scripts/secret-scan.mjs [root] [--staged | --since <ref> | --no-history] — fail if a key-shaped string would be
 * published.
 *
 *   (no flag)       what git would publish: tracked files plus untracked files that are not ignored, AND every
 *                   commit not on the base branch yet (the `secrets` gate in verify). A key committed and then
 *                   cleaned from the file is still in a commit; PU-33 (P-046): the gate reads those commits too.
 *   --staged        what is staged, read from the index (the pre-commit hook), not the file on disk: a token
 *                   staged and then cleaned only in the file is what the commit would hold.
 *   --since <ref>   only the commits in <ref>..HEAD: the lines each one adds and its message.
 *   --no-history    only the files (the scan before 2.58.0).
 *
 * The base for the commits: origin/$GITHUB_BASE_REF (CI), origin/HEAD, origin/main, origin/master, then the
 * studio's branch (a lane's main checkout), main or master when HEAD is on another branch; the commits since the
 * merge-base with the first one found. With none, the last 50 commits. Outside git it scans the folder. Your own
 * .env (ignored) never trips it, so private clones stay green.
 *
 * Text files in UTF-8, UTF-8 with a BOM, or UTF-16 LE/BE with a BOM (Windows PowerShell 5's `>`) are read;
 * other files with a NUL byte are binary and skipped. What counts as a secret lives in harness/secrets.mjs,
 * shared with scrub(). Pure Node plus git, so it runs the same on Windows, macOS and Linux. Values are never
 * printed: a hit is reported as file:line, the kind (for example discord-bot-token) and the sha256 of the value,
 * with the commit's short id for one in history.
 *
 * A true false alarm (not a key) can be allowed by the owner only: an entry in studio/secrets-allow.json (protected,
 * so it needs the owner's signed approval) with path, kind, fingerprint (that sha256) and optionally the commit
 * ("*": the files). It is then listed as "allowed (reason)" and doesn't fail. A real key is rotated, never allowed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { findSecrets } from '../harness/secrets.mjs';

const args = process.argv.slice(2);
let STAGED = false;
let NO_HISTORY = false;
let SINCE = null;
const rest = [];
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--staged') STAGED = true;
  else if (a === '--no-history') NO_HISTORY = true;
  else if (a === '--since' || a.startsWith('--since=')) {
    SINCE = a === '--since' ? args[(i += 1)] : a.slice(8);
    if (!SINCE) bad('--since needs a ref (a branch, tag or commit)');
  } else if (a.startsWith('-')) bad(`unknown option ${a}`);
  else rest.push(a);
}
function bad(msg) {
  console.error(`[secrets] ${msg}\n  usage: node scripts/secret-scan.mjs [root] [--staged | --since <ref> | --no-history]`);
  process.exit(2);
}
const ROOT = path.resolve(rest[0] || '.');
const FALLBACK_COMMITS = 50;
const BLOB_CAP = 4 * 1024 * 1024; // history: a file git calls binary is read back only up to this size

const git = (a, opts = {}) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, ...opts });

// Where ROOT sits in git: inGit, the path from the repo's top to ROOT ('' at the top, 'sub/dir/' below it), the top.
const where = git(['rev-parse', '--is-inside-work-tree', '--show-prefix', '--show-toplevel']);
const whereLines = String(where.stdout || '').split('\n');
const IN_GIT = where.status === 0 && whereLines[0] === 'true';
const PREFIX = IN_GIT ? whereLines[1] || '' : '';
const TOP = IN_GIT && whereLines[2] ? whereLines[2] : ROOT;

// PU-33: skips are tied to their real place from the repo's top (before 2.58.0 any secrets.mjs or *.lock
// anywhere was skipped). harness/secrets.mjs spells out the shapes; the root lockfile is npm's hashes.
const SKIP_FILES = new Set(['harness/secrets.mjs', 'package-lock.json']);
const SKIP_DIRS = ['.studio/locks/'];
const skipped = (repoRel) => SKIP_FILES.has(repoRel) || SKIP_DIRS.some((d) => repoRel.startsWith(d));

/** A file's bytes as text, or null when binary. A BOM says UTF-8 or UTF-16 (LE/BE); no BOM and a NUL is binary. */
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

const sha256 = (v) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

/**
 * The secrets in `text`: [{ line, kind, fp }], one per kind and value on a line. `fp` is the sha256 of the matched
 * value (printed, so the owner can allow a false alarm by it; the value never is). `lineOf` maps an index to the
 * line to report.
 */
function findingsIn(text, rel, lineOf) {
  const lines = new Map();
  for (const f of findSecrets(text, { path: rel })) {
    const line = lineOf(f.index);
    const fp = sha256(text.slice(f.index, f.index + f.length));
    if (!lines.has(line)) lines.set(line, new Map());
    lines.get(line).set(`${f.kind}\0${fp}`, { line, kind: f.kind, fp });
  }
  const out = [];
  for (const found of lines.values()) {
    const list = [...found.values()].sort((x, y) => (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0));
    // A line whose token has a known shape reports that shape, not also "named-secret".
    const shaped = list.some((x) => !x.kind.startsWith('named-secret'));
    for (const x of list) if (!(shaped && x.kind.startsWith('named-secret'))) out.push(x);
  }
  return out;
}

/** index → 1-based line number in `text` (a binary search over its newlines, built on first use). */
function lineIndex(text) {
  let nl = null;
  return (i) => {
    if (!nl) {
      nl = [];
      for (let j = text.indexOf('\n'); j >= 0; j = text.indexOf('\n', j + 1)) nl.push(j);
    }
    let lo = 0;
    let hi = nl.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nl[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}

// { sha? (full; none for the files or the index), rel (as shown), at (from the repo's top, for the allowlist), line, kind, fp }
const hits = [];
const record = (rel, found, sha, at = rel) => {
  for (const f of found) hits.push({ sha, rel, at, ...f });
};
const scanText = (text, rel, sha, at = rel) => record(rel, findingsIn(text, rel, lineIndex(text)), sha, at);

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

// --- The files: the working tree (or, with --staged, the index) ---------------------------------------------
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

function scanWorkingTree() {
  let count = 0;
  const head = Buffer.alloc(8000);
  for (const rel of listFiles()) {
    if (skipped(PREFIX + rel)) continue;
    const full = path.join(ROOT, rel);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    count += 1;
    // A big file is judged by its first 8000 bytes first, so images and videos are never read whole.
    if (st.size > 64 * 1024) {
      let n = 0;
      const fd = fs.openSync(full, 'r');
      try { n = fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
      if (decodeText(head.subarray(0, n)) === null) { cleanFiles.add(rel); continue; }
    }
    const text = decodeText(fs.readFileSync(full));
    const before = hits.length;
    if (text !== null) scanText(text, rel, undefined, PREFIX + rel);
    if (hits.length === before) cleanFiles.add(rel);
  }
  return count;
}
const cleanFiles = new Set(); // working-tree files scanned with nothing found

/**
 * `path\0blob` of every file the working-tree scan found clean and that is unchanged against the index: a commit
 * whose version of that path is this very blob adds only lines the scan has just read, so history skips it
 * (on a repo with no base branch, its first commit is the whole tree again). A file with a hit is never skipped,
 * so its commits are still named.
 */
function coveredBlobs() {
  const out = new Set();
  if (!cleanFiles.size) return out;
  const changed = new Set(git(['diff', '--name-only', '-z', '--no-renames']).stdout.split('\0'));
  const parts = git(['ls-files', '-s', '-z']).stdout.split('\0');
  for (const e of parts) {
    const m = /^\d+ ([0-9a-f]+) 0\t(.*)$/s.exec(e);
    if (m && cleanFiles.has(m[2]) && !changed.has(m[2])) out.add(`${m[2]}\0${m[1]}`);
  }
  return out;
}
let covered = new Set();

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
    if (text !== null) scanText(text, f.rel);
  });
  return files.length;
}

// --- History: the commits not on the base branch yet ---------------------------------------------------------
function resolveRange() {
  if (SINCE) {
    const ok = git(['rev-parse', '--verify', '-q', `${SINCE}^{commit}`]);
    if (ok.status !== 0) bad(`--since: no commit named ${SINCE}`);
    return { spec: [`${SINCE}..HEAD`], label: `since ${SINCE}`, base: SINCE };
  }
  if (git(['rev-parse', '--verify', '-q', 'HEAD^{commit}']).status !== 0) return null; // no commit yet
  const current = git(['symbolic-ref', '-q', '--short', 'HEAD']).stdout.trim();
  const tries = [];
  if (process.env.GITHUB_BASE_REF) tries.push(`refs/remotes/origin/${process.env.GITHUB_BASE_REF}`);
  tries.push('refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master');
  const local = [];
  if (process.env.STUDIO_MAIN_ROOT) {
    const b = spawnSync('git', ['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: process.env.STUDIO_MAIN_ROOT, encoding: 'utf8' }).stdout?.trim();
    if (b) local.push(`refs/heads/${b}`);
  }
  local.push('refs/heads/main', 'refs/heads/master');
  for (const ref of local) if (ref !== `refs/heads/${current}` && !tries.includes(ref)) tries.push(ref);
  const have = new Set(git(['for-each-ref', '--format=%(refname)', ...tries]).stdout.split('\n').filter(Boolean));
  for (const ref of tries.filter((t) => have.has(t))) {
    const mb = git(['merge-base', 'HEAD', ref]).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(mb)) continue;
    const name = ref.replace(/^refs\/(remotes|heads)\//, '');
    return { spec: [`${mb}..HEAD`], label: `since ${name} (${mb.slice(0, 7)})`, base: mb.slice(0, 7) };
  }
  return { spec: ['-n', String(FALLBACK_COMMITS), 'HEAD'], label: `in the last ${FALLBACK_COMMITS} (no base branch found)`, base: `HEAD~${FALLBACK_COMMITS}`, fallback: true };
}

/** A path as git prints it: plain, or C-quoted ("a\tb", octal bytes) when it holds special characters. */
function unquote(p) {
  if (!p.startsWith('"')) return p;
  const bytes = [];
  for (let i = 1; i < p.length; i += 1) {
    const c = p[i];
    if (c === '"') break;
    if (c !== '\\') { bytes.push(...Buffer.from(c)); continue; }
    const n = p[(i += 1)];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(p.slice(i, i + 3), 8)); i += 2; }
    else bytes.push({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 }[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}
// "a/P b/P" (no renames, so both sides are the same path) or two quoted halves.
function headerPath(s) {
  if (s.startsWith('"')) {
    const second = s.lastIndexOf(' "');
    return unquote(second > 0 ? s.slice(second + 1) : s).replace(/^b\//, '');
  }
  return s.slice(2, 2 + (s.length - 5) / 2);
}

// Files that are never text. History leaves them out of the diff (git would unpack every image and video just to
// call it binary: seconds on an art-heavy game) and never reads them back.
const BINARY_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'icns', 'tif', 'tiff', 'psd', 'kra', 'xcf', 'exr', 'hdr',
  'ktx', 'ktx2', 'dds', 'basis', 'tga', 'glb', 'fbx', 'blend', 'bin', 'wasm', 'zip', 'gz', 'tgz', '7z', 'rar', 'xz', 'bz2', 'zst', 'jar',
  'apk', 'aab', 'ipa', 'exe', 'dll', 'so', 'dylib', 'pdb', 'mp3', 'ogg', 'oga', 'opus', 'wav', 'flac', 'm4a', 'aac', 'mp4', 'm4v', 'mov',
  'webm', 'mkv', 'avi', 'ttf', 'otf', 'woff', 'woff2', 'eot', 'pdf', 'sqlite', 'pck', 'uasset', 'umap', 'unitypackage'];
const BINARY_EXT = new RegExp(`\\.(?:${BINARY_EXTS.join('|')})$`, 'i');
const NOT_BINARY = ['.', ...BINARY_EXTS.map((e) => `:(exclude,icase)*.${e}`)];

/**
 * PU-33 (P-046): every commit in the range: its message, and the lines it adds (a merge: the lines in no parent,
 * `--cc`). A file git shows as binary (UTF-16, or marked `-diff`/`binary` in .gitattributes) is read back from
 * the commit and scanned whole when it is text. Returns the number of commits read.
 */
function scanHistory(range) {
  const logOf = (a, input) => {
    const r = git(['-c', 'core.quotePath=false', 'log', '--no-color', '--no-show-signature', ...a], input === undefined ? {} : { input });
    if (r.error || r.status !== 0) throw new Error(`git log ${range.spec.join(' ')} failed: ${String(r.error?.message || r.stderr || '').trim().slice(0, 200)}`);
    return r.stdout;
  };
  const HEAD = /(?:^|\n)\x01([0-9a-f]{40,64})\x02([\s\S]*?)\x03/g;
  const split = (out, fn) => {
    let last = null;
    for (let m; (m = HEAD.exec(out)); ) {
      if (last) fn(last, m.index);
      last = { sha: m[1], msg: m[2], start: HEAD.lastIndex };
    }
    if (last) fn(last, out.length);
  };
  // The commits in the range, and every one's message.
  const shas = [];
  split(logOf(['--format=%x01%H%x02%B%x03', ...range.spec, '--']), (c) => {
    shas.push(c.sha);
    scanText(c.msg, '(commit message)', c.sha);
  });
  if (!shas.length) return 0;
  // Exactly those commits' patches (fed on stdin, no walk: a path-limited walk would simplify away a side branch
  // that added and removed a key), without the binary types.
  const out = logOf(['--stdin', '--no-walk=unsorted', '--no-ext-diff', '--no-textconv', '-p', '--cc', '-U0', '--full-index', '--no-renames',
    '--src-prefix=a/', '--dst-prefix=b/', '--format=%x01%H%x02%x03', '--', ...NOT_BINARY], `${shas.join('\n')}\n`);
  const binaries = [];
  split(out, (c, end) => scanDiff(out, c.start, end, c.sha, binaries));
  const seen = new Set();
  const wanted = binaries.filter((b) => !BINARY_EXT.test(b.rel) && !seen.has(b.oid) && seen.add(b.oid));
  eachBlob(wanted, (b, buf) => {
    const text = buf ? decodeText(buf) : null;
    if (text !== null) scanText(text, b.rel, b.sha);
  }, BLOB_CAP);
  return shas.length;
}

/** One commit's patch, out[start, end): scan each file's added lines; files shown as binary go to `binaries`. */
function scanDiff(out, start, end, sha, binaries) {
  let file = null;
  let width = 1; // parents shown in the hunk prefix: 1, or 2+ for a merge's combined diff
  let inHunk = false;
  let line = 0;
  const flush = () => {
    if (file && file.lines.length && !skipped(file.rel) && !covered.has(`${file.rel}\0${file.oid}`)) {
      const text = file.lines.join('\n');
      const pos = lineIndex(text);
      record(file.rel, findingsIn(text, file.rel, (i) => file.nums[pos(i) - 1]), sha);
    }
    file = null;
  };
  for (let at = start; at < end; ) {
    let nl = out.indexOf('\n', at);
    if (nl < 0 || nl > end) nl = end;
    const L = out.slice(at, nl);
    at = nl + 1;
    if (L.startsWith('diff ')) {
      flush();
      inHunk = false;
      if (L.startsWith('diff --git ')) { file = { rel: headerPath(L.slice(11)), oid: '', lines: [], nums: [] }; width = 1; }
      else if (L.startsWith('diff --cc ') || L.startsWith('diff --combined ')) file = { rel: unquote(L.slice(L.indexOf(' ', 5) + 1)), oid: '', lines: [], nums: [] };
      continue;
    }
    if (!file) continue;
    if (L.startsWith('@')) {
      const m = /^(@+) (?:-\d+(?:,\d+)? )+\+(\d+)(?:,\d+)? \1/.exec(L);
      if (m) { width = m[1].length - 1; line = Number(m[2]); inHunk = true; }
      continue;
    }
    if (!inHunk) {
      if (L.startsWith('index ')) file.oid = (/\.\.([0-9a-f]+)/.exec(L) || [])[1] || '';
      else if (L.startsWith('+++ ') && L !== '+++ /dev/null') file.rel = unquote(L.slice(4).replace(/\t$/, '')).replace(/^b\//, '');
      else if (L.startsWith('Binary files ') && file.oid && !/^0+$/.test(file.oid) && !skipped(file.rel) && !covered.has(`${file.rel}\0${file.oid}`)) binaries.push({ sha, rel: file.rel, oid: file.oid });
      continue;
    }
    if (L[0] === '\\') continue; // "\ No newline at end of file"
    const pre = L.slice(0, width);
    if (pre.includes('-')) continue; // a line the commit removed
    if (!pre.includes(' ')) { file.lines.push(line === 1 ? L.slice(width).replace(/^\uFEFF/, '') : L.slice(width)); file.nums.push(line); }
    line += 1;
  }
  flush();
}

// --- The owner's allowlist: false alarms, one finding each, by fingerprint -----------------------------------
// studio/secrets-allow.json is protected (studio/protected.json): an entry lands only with the owner's signed
// approval, so an agent can't allow its own secret. A real key is rotated, never allowed.
const ALLOW_REL = 'studio/secrets-allow.json';
function loadAllow() {
  const file = path.join(TOP, ALLOW_REL);
  if (!fs.existsSync(file)) return [];
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw new Error(`${ALLOW_REL} is not valid JSON (${err.message})`); }
  const list = Array.isArray(data) ? data : Array.isArray(data?.allow) ? data.allow : null;
  if (!list) throw new Error(`${ALLOW_REL} needs an "allow" list`);
  const out = [];
  list.forEach((e, i) => {
    const commit = e?.commit === undefined || e?.commit === null || e?.commit === '' ? null : String(e.commit).toLowerCase();
    const ok = e && typeof e.path === 'string' && typeof e.kind === 'string' && /^[0-9a-f]{64}$/i.test(String(e.fingerprint || ''))
      && String(e.reason || '').trim() && String(e.by || '').trim() && (commit === null || commit === '*' || /^[0-9a-f]{7,64}$/.test(commit));
    if (ok) out.push({ commit, path: e.path, kind: e.kind, fp: e.fingerprint.toLowerCase(), reason: String(e.reason).trim() });
    else console.log(`[secrets] note: ${ALLOW_REL} entry ${i + 1} allows nothing: it needs path, kind, fingerprint (sha256 hex), reason and by; commit is a sha or "*"`);
  });
  return out;
}
// Path, kind and fingerprint must match, and the commit when the entry names one ("*": the files, not history).
const allowedBy = (allow, h) => allow.find((e) => e.path === h.at && e.kind === h.kind && e.fp === h.fp
  && (e.commit === null || (e.commit === '*' ? !h.sha : Boolean(h.sha) && h.sha.startsWith(e.commit))));

// --- Run ------------------------------------------------------------------------------------------------------
let fileCount = 0;
let commitCount = 0;
let range = null;
let allow = [];
try {
  allow = loadAllow();
  if (STAGED) fileCount = IN_GIT ? scanStaged() : scanWorkingTree();
  else {
    if (!SINCE) fileCount = scanWorkingTree();
    if (SINCE && !IN_GIT) bad('--since needs a git checkout');
    if (IN_GIT && !NO_HISTORY && (SINCE || PREFIX === '')) {
      range = resolveRange();
      if (range) {
        if (!SINCE) covered = coveredBlobs();
        commitCount = scanHistory(range);
      }
    }
  }
} catch (err) {
  // Fail closed: a scan that couldn't read what it should is not a pass.
  console.log(`[secrets] FAIL couldn't finish the scan: ${err.message}`);
  process.exit(1);
}
const show = (h) => `  ${h.sha ? `${h.sha.slice(0, 7)} ` : ''}${h.rel}:${h.line}  ${h.kind}  sha256:${h.fp}`;
for (const h of hits) h.allowed = allowedBy(allow, h);
const failing = hits.filter((h) => !h.allowed);
const allowed = hits.filter((h) => h.allowed);
const listAllowed = () => {
  if (!allowed.length) return;
  console.log(`[secrets] ${allowed.length} finding(s) allowed by ${ALLOW_REL} (owner-approved false alarms):`);
  console.log(allowed.map((h) => `${show(h)}  allowed (${h.allowed.reason})`).join('\n'));
};
if (failing.length) {
  const inHistory = failing.filter((h) => h.sha);
  const order = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.line - b.line);
  console.log('[secrets] FAIL key-shaped string(s) found (values hidden; sha256 of each value shown):');
  const files = failing.filter((h) => !h.sha).sort(order);
  if (files.length) console.log(files.map(show).join('\n'));
  if (inHistory.length) {
    console.log(`  in commits ${range.label}:`);
    console.log(inHistory.map(show).join('\n'));
  }
  listAllowed();
  console.log('[secrets] Move real keys to .env (gitignored). If one was ever committed, rotate it.');
  if (inHistory.length) {
    console.log('[secrets] A key in a commit stays there after the file is cleaned. Rotate it, then take it out of the commit before');
    const base = range.fallback && commitCount < FALLBACK_COMMITS ? '--root' : range.base;
    console.log(`  pushing: git commit --amend for the last commit, git rebase -i ${base} for older ones.`);
  }
  const h = failing[0];
  const example = { commit: h.sha ? h.sha.slice(0, 7) : '*', path: h.at, line: h.line, kind: h.kind, fingerprint: h.fp, reason: 'why this is not a key', by: 'owner' };
  console.log(`[secrets] Only a false alarm (not a key) may be allowed, by the owner: add an entry to ${ALLOW_REL} and sign it (npm run approve -- protected), e.g. ${JSON.stringify(example)}`);
  process.exit(1);
}
listAllowed();
const what = [];
if (!SINCE) what.push(`${fileCount} file(s)${STAGED && IN_GIT ? ' staged' : ''}`);
if (range) what.push(`${commitCount} commit(s) ${range.label}`);
console.log(`[secrets] PASS — ${what.join(', ')} scanned${allowed.length ? `; ${allowed.length} allowed false alarm(s)` : ''}`);
