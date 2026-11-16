// Small helpers that several harness and scripts files used to define identically, kept once.
// Rule for adding one:
//  - only a body that 3 or more files define the same way (whitespace, comments and own names aside);
//  - node: built-ins only, never an import from another harness file (a leaf: it cannot make a cycle);
//  - a helper that read one local constant of its file is a factory taking it (flagOf(argv));
//  - a variant that differs in any token is its own export, never an option on an existing one.
//  - a file that must load alone keeps its own copy (hooks-upgrade-hint, upgrade-baseline, upgrade-preflight).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Factory over a. Local names it replaced: flag, opt, preOpt.
export const argAfterOf = (a) => (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : null);

// Bytes under a folder, not following links; stops counting after maxEntries entries.
export function bytesUnder(p, maxEntries) {
  let n = 0; let seen = 0;
  const walk = (q) => {
    if (seen++ > maxEntries) return;
    let st; try { st = fs.lstatSync(q); } catch { return; }
    if (st.isSymbolicLink() || !st.isDirectory()) { n += st.size || 0; return; }
    let names = []; try { names = fs.readdirSync(q); } catch { return; }
    for (const x of names) walk(path.join(q, x));
  };
  walk(p);
  return n;
}

// Local names it replaced: item.
export const checkItem = (id, status, detail, fix = '') => ({ id, status, detail, ...(fix ? { fix } : {}) });

// Local names it replaced: cleanEnv.
export const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(k)) delete e[k]; return e; };

// Local names it replaced: done, out.
export const doneExit = (r, line) => {
  if (!r.ok) {
    console.error(r.message);
    process.exit(1);
  }
  console.log(line(r));
  process.exit(0);
};

// Local names it replaced: esc, escRe, reEsc.
export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Local names it replaced: fail.
export const failExit = (m) => { console.error(m); process.exit(1); };

// Factory over argv. Local names it replaced: fl, flag, opt.
export const flagOf = (argv) => (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);

// Factory over argv. Local names it replaced: flag, opt.
export const flagValueOf = (argv) => (k) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

// Local names it replaced: fold, norm.
export const foldCase = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// Factory over real. Local names it replaced: fold, n.
export const foldRealOf = (real) => (p) => (process.platform === 'win32' ? real(p).toLowerCase() : real(p));

// Local names it replaced: git.
export const gitCwdMax64 = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });

// Factory over dir. Local names it replaced: g, git.
export const gitInDirOf = (dir) => (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true });

// Factory over root. Local names it replaced: g, git.
export const gitInRootOf = (root) => (...a) => spawnSync('git', a, { windowsHide: true, cwd: root, encoding: 'utf8' });

// Local names it replaced: git.
export const gitMax64 = (cwd, ...args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// Local names it replaced: hhmm, hm.
export const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);

// Local names it replaced: isOff, off, offWord.
export const isOff = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());

// Local names it replaced: falsy, off.
export const isOffRaw = (v) => /^(off|0|false|no)$/i.test(String(v || ''));

// Local names it replaced: isSha.
export const isSha40 = (s) => /^[0-9a-f]{40}$/.test(String(s || ''));

// Factory over AGENTS_DIR. Local names it replaced: attachFile, file, fileOf, flagFile, needFile, sessionFile, stateFile.
export const jsonFileOf = (AGENTS_DIR) => (agent) => path.join(AGENTS_DIR, `${agent}.json`);

// Local names it replaced: mtime, stamp.
export const mtimeMs = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

// Local names it replaced: norm.
export const normRel = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

// Local names it replaced: now.
export const nowIso = () => new Date().toISOString();

// Local names it replaced: num.
export const numBlankDefault = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

// Local names it replaced: num.
export const numFiniteFirst = (v, d) => (Number.isFinite(Number(v)) && String(v ?? '').trim() !== '' ? Number(v) : d);

// Local names it replaced: num.
export const numSplit = (v, d) => { const s = String(v ?? '').trim(); const n = Number(s); return s !== '' && Number.isFinite(n) ? n : d; };

// Local names it replaced: num, numOr.
export const numTrimDefault = (v, d) => (v === undefined || v === null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? d : Number(v));

// Factory over ev. Local names it replaced: T, count.
export const ofTypeIn = (ev) => (type) => ev.filter((e) => e.type === type);

// Factory over argv. Local names it replaced: opt.
export const optValueOf = (argv) => (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : null; };

// Local names it replaced: p, pad.
export const pad2 = (x) => String(x).padStart(2, '0');

// Local names it replaced: fwd, posix.
export const posixOf = (p) => p.split(path.sep).join('/');

// Factory over byTask. Local names it replaced: add, hold, push.
export const pushToOf = (byTask) => (t, e) => { if (!byTask.has(t)) byTask.set(t, []); byTask.get(t).push(e); };

// Local names it replaced: q.
export const quoteArg = (s) => (/[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s);

// Local names it replaced: read, readJson.
export const readJsonOr = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};

// Local names it replaced: rd, read, readJ, readJson, readJsonFile, readJsonQuiet.
export const readJsonOrNull = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

// Factory over read. Local names it replaced: json, readAsmdef, readJson.
export const readJsonVia = (read) => (rel) => {
  try {
    return JSON.parse(read(rel));
  } catch {
    return null;
  }
};

// Local names it replaced: read.
export const readTextOrEmpty = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// Local names it replaced: read, readText.
export const readTextOrNull = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

// Local names it replaced: real, realOrResolved.
export const realOrResolved = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

// Local names it replaced: rel.
export const relPosix = (root, f) => path.relative(root, f).split(path.sep).join('/');

// Local names it replaced: key, roleKey.
export const roleKey = (role) => String(role || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');

// Local names it replaced: sha, sha256.
export const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Local names it replaced: short.
export const short8 = (h) => String(h || '').slice(0, 8);

// Local names it replaced: short.
export const shortIso16 = (iso) => String(iso || '').slice(0, 16).replace('T', ' ');

// Local names it replaced: fwd, slash.
export const slashPath = (p) => String(p || '').split(path.sep).join('/');

// Local names it replaced: sleep, sleepMs, sleepSync.
export const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Local names it replaced: sleep.
export const sleepSyncClamped = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));

// Local names it replaced: gitOut, ok1, out, out1.
export const stdoutOf = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');

// Local names it replaced: strs.
export const strList = (a) => (Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean) : []);

// Local names it replaced: toPosix.
export const toPosix = (p) => String(p).replace(/\\/g, '/');

// Local names it replaced: at, ts.
export const tsMs = (e) => Date.parse(e?.ts) || 0;

// Local names it replaced: write, writeJson.
export const writeJsonPretty = (f, j) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(j, null, 2)}\n`); };

// Local names it replaced: writeJson.
export const writeJsonTmp = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`); fs.renameSync(tmp, f); };
