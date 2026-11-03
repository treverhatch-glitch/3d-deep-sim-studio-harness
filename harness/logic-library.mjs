#!/usr/bin/env node
/**
 * harness/logic-library.mjs — 2.72.0 (d): the studio's gameplay logic library. Code a game already landed (a path
 * finder, a queue, a step function) is found before an agent writes it again, the way `npm run asset -- need` finds an
 * asset (harness/asset-need.mjs, 2.67.1) before one is made.
 *
 *   npm run logic -- need "<what>" [--stack ts|cs|gd] [--research [--role reference-scout]] [--by <you>]
 *       looks in the library (studio/logic-library/library.json; INDEX.md is its readable copy) and prints at most
 *       ~15 lines: the matching confirmed modules (name, what it does, interface, stack, assumptions, the game and
 *       harness version it landed in, its tests and golden), the same stack first. Nothing: "not in the library:
 *       search open source next (a research task, 2.71), else write it"; --research files that research task (once).
 *   npm run logic -- add <path> --name <name> --task <T-ID> --does "<what it does>" --by <you>
 *       [--interface "<signature>"] [--stack ts|cs|gd] [--assumptions "…"] [--tests a,b] [--golden <file>]
 *       [--spec <file>] [--game <name>] [--source <url> --licence <id> [--author <name>]]
 *       proposes a module AFTER it landed: every file must be on the studio's branch as it is on disk, and the task
 *       must be done (only code that passed the gates). It needs a language-neutral test spec (JSON cases, beside the
 *       code as spec.json or --spec), copied with the code into studio/logic-library/modules/<name>/; a JS/TS module's
 *       spec must pass on it. Code from outside (--source): MIT, BSD, Apache-2.0, ISC get a credit line written for
 *       them; GPL, AGPL, LGPL are held until the owner says yes (tier C: licence-yes); no licence, or one not on the
 *       list, is refused.
 *   npm run logic -- confirm <name> --by <name> [--permission "<a person's words>"]
 *       a game dev, an outside agent or a person confirms a proposal (harness/decider.mjs rules; the owner can delegate
 *       `logic-library`); never its author, never a worker. Recorded in the decision log. Only confirmed modules whose
 *       files still match their checksums are offered by `need`.
 *   npm run logic -- licence-yes <name> --by <person> --permission "<their words>"   the owner's yes for a copyleft module
 *   npm run logic -- use <name> --game <name> [--by <you>]     a game uses it (keeps it from going stale)
 *   npm run logic -- list [--json]      every module; one unused by any game for STUDIO_LOGIC_STALE_DAYS (90) is flagged
 *   npm run logic -- check <name> [--impl <file>]   run the module's spec on it, or on a port (a JS/TS file)
 *   npm run logic -- index              rewrite INDEX.md from library.json
 *
 * The library ships empty except one made-up example module (example-step-toward). Never fetches anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT, emitEvent, actor } from './event.mjs';

export const LIB_REL = 'studio/logic-library';
export const STACKS = ['ts', 'cs', 'gd'];
const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'with', 'and', 'in', 'on', 'to', 'by', 'from', 'that', 'is', 'it', 'code', 'logic', 'module', 'function', 'system']);
const MAX_NEED_LINES = 15;

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, j) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(j, null, 2)}\n`); };
const posix = (p) => String(p).split(path.sep).join('/');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// A module file's checksum ignores line endings (2.73.0): a Windows checkout with core.autocrlf turns the spec's LF into
// CRLF, and the example module read as "changed since it was confirmed". Binary files (a NUL byte) are hashed as they are.
const fileSha = (file) => { const b = fs.readFileSync(file); return sha(b.includes(0) ? b : Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')); };
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const gitBuf = (cwd, ...args) => spawnSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
const safeName = (s) => /^[a-z0-9][a-z0-9-]{1,60}$/.test(String(s || ''));

async function mainRootOf() {
  try { return (await import('./worktree.mjs')).mainRoot(); } catch { return REPO_ROOT; }
}
export const libDir = (root) => path.join(root, ...LIB_REL.split('/'));
const libFile = (root) => path.join(libDir(root), 'library.json');

/** library.json: { note, bar, modules: [...] }. */
export function readLibrary(root) {
  const j = readJson(libFile(root), null);
  return { bar: 0.5, ...(j && typeof j === 'object' ? j : {}), modules: Array.isArray(j?.modules) ? j.modules : [] };
}
export function writeLibrary(root, lib) {
  writeJson(libFile(root), lib);
  fs.writeFileSync(path.join(libDir(root), 'INDEX.md'), indexText(lib));
}

// ---------- words ----------
const stem = (w) => (w.length > 4 && w.endsWith('ing') ? w.slice(0, -3) : w.length > 3 && w.endsWith('es') && !w.endsWith('ses') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
export const words = (s) => String(s || '').toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
const camelWords = (s) => words(String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2'));

/** How well a module answers a need: 0..1 (share of the need's words the module's text has). */
export function matchScore(what, m) {
  const want = [...new Set(words(what))];
  if (!want.length) return 0;
  const have = new Set([...camelWords(m.name), ...camelWords(m.does), ...camelWords(m.interface), ...camelWords(m.assumptions), ...(m.tags || []).flatMap(camelWords)]);
  return want.filter((w) => have.has(w)).length / want.length;
}

// ---------- licences (2.66 asset rules, for code) ----------
/**
 * The licence rule for code taken from outside: { ok, cls, credit, hold, why }. No source: the studio's own code.
 * MIT / BSD / Apache-2.0 / ISC: allowed with a credit line. GPL / AGPL / LGPL: held for the owner's yes (tier C).
 * No licence: refused (all rights reserved). Anything else: refused until a person adds a rule for it.
 */
export function codeLicence({ source = '', licence = '' } = {}) {
  const src = String(source || '').trim();
  const lic = String(licence || '').trim();
  const u = lic.toUpperCase().replace(/[\s_]+/g, '-');
  if (!src && (!lic || /^(OWN-WORK|OWN|STUDIO)$/.test(u))) return { ok: true, cls: 'own-work', why: 'the studio\'s own code' };
  if (!lic || /^(NONE|NO-LICEN[CS]E|UNKNOWN|N\/A)$/.test(u)) return { ok: false, cls: 'none', why: 'code with no licence can\'t be used (all rights reserved): find another source, or write it' };
  if (/^(A|L)?GPL|^(GNU-)?(AFFERO|LESSER)/.test(u) || /(^|-)(A|L)?GPL(-|$)/.test(u)) return { ok: false, cls: 'copyleft', hold: true, why: `"${lic}" is copyleft: it is used only with the owner's yes (tier C: npm run logic -- licence-yes <name> --by <person> --permission "<their words>")` };
  if (/^MIT(-0)?$/.test(u) || /^(0BSD|BSD-[234]-CLAUSE(-[A-Z]+)?|BSD)$/.test(u) || /^APACHE(-LICEN[CS]E)?(-2(\.0)?)?$/.test(u) || /^ISC$/.test(u)) {
    if (!src) return { ok: false, cls: 'permissive', why: `"${lic}" names a licence from outside: say where the code came from (--source <url>) for its credit line` };
    return { ok: true, cls: 'permissive', credit: true, why: `"${lic}": allowed with a credit line` };
  }
  return { ok: false, cls: 'unknown', why: `"${lic}" isn't on the library's list (MIT, BSD, Apache-2.0, ISC allowed; GPL, AGPL, LGPL with the owner's yes): refused` };
}
export const creditLine = (m) => `${m.name}: code from ${m.source} (${m.licence})${m.author ? `, by ${m.author}` : ''}; keep its licence notice with the code`;

// ---------- spec (language-neutral JSON cases) ----------
/** { ok, why, cases } for a spec: { "function": "<exported name>", "cases": [{ "name", "args": [...], "expect": <json>, "tolerance"? }] }. */
export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') return { ok: false, why: 'the spec isn\'t a JSON object' };
  if (!/^[A-Za-z_$][\w$]*$/.test(String(spec.function || ''))) return { ok: false, why: 'the spec names no "function" (the exported name its cases call)' };
  if (!Array.isArray(spec.cases) || !spec.cases.length) return { ok: false, why: 'the spec has no "cases"' };
  const bad = spec.cases.findIndex((c) => !c || typeof c !== 'object' || !Array.isArray(c.args) || !('expect' in c));
  if (bad >= 0) return { ok: false, why: `case ${bad + 1} needs "args" (an array) and "expect"` };
  return { ok: true, cases: spec.cases.length };
}
const same = (a, b, tol) => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= (tol || 0) || a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i], tol));
  if (a && b && typeof a === 'object' && typeof b === 'object') { const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort(); return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same(a[k], b[k], tol)); }
  return a === b;
};

/** Run a spec on a JS/TS file: { ok, ran, failed: [{ name, got, expect }], why }. TS needs the typescript package. */
export async function runSpec(spec, file) {
  const v = validateSpec(spec);
  if (!v.ok) return { ok: false, ran: 0, failed: [], why: v.why };
  const ext = path.extname(file).toLowerCase();
  let url = pathToFileURL(file).href;
  let tmp = null;
  if (ext === '.ts') {
    let ts = null;
    try { ts = (await import('typescript')).default; } catch { return { ok: false, ran: 0, failed: [], why: 'a .ts module needs the typescript package to run its spec here (npm ci)' }; }
    const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    tmp = path.join(path.dirname(file), `.logic-check-${process.pid}-${Date.now()}.mjs`);
    fs.writeFileSync(tmp, out);
    url = pathToFileURL(tmp).href;
  } else if (!['.mjs', '.js'].includes(ext)) return { ok: false, ran: 0, failed: [], why: `${path.basename(file)}: only a JS or TS file runs here; a ${ext || 'file'} port runs the same spec.json cases with its own test runner` };
  try {
    const mod = await import(`${url}?t=${Date.now()}`);
    const fn = mod[spec.function];
    if (typeof fn !== 'function') return { ok: false, ran: 0, failed: [], why: `${path.basename(file)} exports no function "${spec.function}"` };
    const failed = [];
    for (const c of spec.cases) {
      let got;
      try { got = fn(...structuredClone(c.args)); } catch (e) { got = `threw ${e.message}`; }
      if (!same(got, c.expect, Number(c.tolerance) || 0)) failed.push({ name: c.name || JSON.stringify(c.args), got, expect: c.expect });
    }
    return { ok: !failed.length, ran: spec.cases.length, failed, why: failed.length ? `${failed.length} of ${spec.cases.length} case(s) fail` : '' };
  } catch (e) {
    return { ok: false, ran: 0, failed: [], why: `couldn't load ${path.basename(file)}: ${e.message}` };
  } finally { if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch {} } }
}

// ---------- state of a module ----------
export const staleDays = (env = process.env) => {
  const raw = String(env.STUDIO_LOGIC_STALE_DAYS ?? '').trim();
  if (/^(off|0|false|no)$/i.test(raw)) return null;
  return Number(raw) >= 1 ? Number(raw) : 90;
};
const lastUsedMs = (m) => Math.max(Date.parse(m.landedAt || m.addedAt || '') || 0, ...(m.uses || []).map((u) => Date.parse(u.at) || 0));
/** Files changed since the module's checksums were recorded (relative to the library folder). */
export function changedFiles(root, m) {
  return Object.entries(m.hashes || {}).filter(([rel, h]) => { try { return fileSha(path.join(libDir(root), ...rel.split('/'))) !== h; } catch { return true; } }).map(([rel]) => rel);
}
/** { usable, label, stale } for a module. Usable: confirmed by someone other than its author, files unchanged. */
export function moduleState(root, m, { now = Date.now(), env = process.env } = {}) {
  const days = staleDays(env);
  const stale = !m.example && days !== null && now - lastUsedMs(m) > days * 86400000;
  if (m.status === 'licence-hold') return { usable: false, stale, label: 'held: copyleft licence, waiting for the owner\'s yes' };
  if (m.status !== 'confirmed') return { usable: false, stale, label: 'proposed: waiting for a game dev, an outside agent or a person to confirm' };
  if (!m.example && (!m.confirmedBy || String(m.confirmedBy).toLowerCase() === String(m.by || '').toLowerCase())) return { usable: false, stale, label: 'not confirmed by anyone but its author' };
  const ch = changedFiles(root, m);
  if (ch.length) return { usable: false, stale, label: `changed since it was confirmed (${ch.slice(0, 3).join(', ')}): confirm it again` };
  return { usable: true, stale, label: m.example ? 'confirmed (example)' : `confirmed by ${m.confirmedBy}` };
}

const testsText = (m) => {
  const spec = m.specCases ? `spec ${m.specCases} case(s)` : 'spec';
  return `tests: ${[spec, ...(m.tests || [])].join(', ')}; golden: ${m.golden || 'none'}`;
};
export function moduleLine(m) {
  return `${m.name} [${m.stack}] — ${clip(m.does, 90)}`;
}
export function moduleDetail(m) {
  return `${clip(m.interface, 70)} · assumes ${clip(m.assumptions || 'nothing stated', 50)} · ${m.game || '?'} @ harness ${m.harness || '?'} · ${testsText(m)}${m.credit ? ' · credited' : ''}`;
}

export function indexText(lib) {
  const L = ['# Gameplay logic library (`studio/logic-library/INDEX.md`)', '',
    'Code a game here already landed, for the next game or the next task to reuse. Written by `npm run logic -- index`',
    '(add and confirm rewrite it) from `library.json`; one line per module: name, stack, what it does, interface,',
    'assumptions, the game and harness version it landed in, its tests and golden. Before writing gameplay logic:',
    '`npm run logic -- need "<what>"`. Each module keeps its code and a language-neutral `spec.json` under `modules/<name>/`.', ''];
  if (!lib.modules.length) L.push('_(empty)_');
  for (const m of lib.modules) L.push(`- **${m.name}** [${m.stack}] ${clip(m.does, 120)} · \`${clip(m.interface, 100)}\` · assumes ${clip(m.assumptions || 'nothing stated', 80)} · ${m.game || '?'} @ ${m.harness || '?'} · ${testsText(m)} · ${m.status}${m.example ? ' (example)' : ''}${m.credit ? ` · credit: ${clip(m.credit, 160)}` : ''}`);
  return `${L.join('\n')}\n`;
}

// ---------- need ----------
export async function need(what, { stack = null, research = false, role = 'reference-scout', by = actor(), root = null, env = process.env, now = Date.now() } = {}) {
  root = root || await mainRootOf();
  const w = String(what || '').trim();
  if (!w) return { ok: false, lines: ['Say what you need: npm run logic -- need "<what>" [--stack ts|cs|gd]'] };
  if (stack && !STACKS.includes(stack)) return { ok: false, lines: [`--stack is one of ${STACKS.join(', ')}`] };
  const lib = readLibrary(root);
  const bar = Number(lib.bar) > 0 ? Number(lib.bar) : 0.5;
  const scored = lib.modules.map((m) => ({ m, score: matchScore(w, m), st: moduleState(root, m, { now, env }) })).filter((x) => x.score >= bar);
  const usable = scored.filter((x) => x.st.usable).sort((a, b) => (stack ? Number(b.m.stack === stack) - Number(a.m.stack === stack) : 0) || b.score - a.score || a.m.name.localeCompare(b.m.name));
  const waiting = scored.filter((x) => !x.st.usable);
  const lines = [`[logic] need "${clip(w, 80)}"${stack ? ` (stack ${stack})` : ''}: ${lib.modules.length} module(s) in ${LIB_REL}/`];
  const key = `${[...new Set(words(w))].sort().join(' ')}|${stack || ''}`;
  if (usable.length) {
    const same = usable.filter((x) => !stack || x.m.stack === stack);
    const other = usable.filter((x) => stack && x.m.stack !== stack);
    for (const x of same.slice(0, 4)) lines.push(`  ${moduleLine(x.m)}${x.st.stale ? ' (stale: unused)' : ''}`, `      ${moduleDetail(x.m)}`);
    for (const x of other.slice(0, 2)) lines.push(`  port from ${x.m.stack}: ${moduleLine(x.m)} (its spec.json checks the port)`);
    const first = (same[0] || other[0]).m;
    lines.push(`Reuse: copy ${LIB_REL}/modules/${first.name}/ into your game, then npm run logic -- use ${first.name} --game <game>`);
    if (waiting.length) lines.push(`(${waiting.length} more match but aren't usable yet: npm run logic -- list)`);
    emitEvent({ type: 'logic.need', agent: by, msg: `logic need "${clip(w, 120)}": in the library (${usable.map((x) => x.m.name).slice(0, 3).join(', ')})`, meta: { what: w, stack, found: usable.map((x) => x.m.name) } });
    return { ok: true, found: usable.map((x) => x.m.name), lines: lines.slice(0, MAX_NEED_LINES) };
  }
  lines.push('not in the library: search open source next (a research task, 2.71), else write it.');
  if (waiting.length) lines.push(`  (${waiting.map((x) => `${x.m.name}: ${x.st.label}`).slice(0, 2).join('; ')})`);
  lines.push('  Outside code: MIT, BSD, Apache-2.0, ISC with a credit line; GPL, AGPL, LGPL only with the owner\'s yes; no licence: refused.');
  let task = null;
  if (research) {
    const title = clip(`Research: open-source code for "${w}"${stack ? ` (${stack})` : ''} before writing it [logic need: ${key}]`, 200);
    try {
      const { addTask, parseNextQueue } = await import('./task.mjs');
      const board = parseNextQueue();
      const open = [...board.inProgress, ...board.backlog].find((t) => String(t.title).includes(`[logic need: ${key}]`));
      task = open ? { id: open.id, duplicate: true } : addTask({ title, role, priority: 'P2', agent: by, meta: { why: `logic need "${clip(w, 100)}": nothing in the library` } });
    } catch (e) { task = { error: e.message }; }
    if (task?.id) lines.push(`  research task ${task.id}${task.duplicate ? ' (already open)' : task.proposed ? ' (proposed)' : ' filed'}: write up the candidates with their links and licences, then add what lands.`);
    else lines.push(`  the research task was not filed: ${task?.error || task?.message || 'unknown'}`);
  } else lines.push(`  File it: npm run logic -- need "${clip(w, 60)}"${stack ? ` --stack ${stack}` : ''} --research`);
  emitEvent({ type: 'logic.need', agent: by, msg: `logic need "${clip(w, 120)}": not in the library${task?.id ? `; research task ${task.id}` : ''}`, meta: { what: w, stack, found: [], research: task?.id || null } });
  return { ok: true, found: [], task, lines: lines.slice(0, MAX_NEED_LINES) };
}

// ---------- add ----------
const stackOf = (files) => {
  const exts = new Set(files.map((f) => path.extname(f).toLowerCase()));
  if (exts.has('.cs')) return 'cs';
  if (exts.has('.gd')) return 'gd';
  if (['.ts', '.mjs', '.js', '.tsx'].some((e) => exts.has(e))) return 'ts';
  return null;
};
const CODE_EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.cs', '.gd']);
function listFiles(abs) {
  const st = fs.statSync(abs);
  if (st.isFile()) return [abs];
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist'].includes(e.name)) continue;
    const full = path.join(abs, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}
function signatureOf(file) {
  let src = '';
  try { src = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  const js = src.match(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*([^{\n]+))?/);
  if (js) return clip(`${js[1]}(${js[2].replace(/\s+/g, ' ').trim()})${js[3] ? `: ${js[3].trim()}` : ''}`, 160);
  const other = src.match(/public\s+static\s+([\w<>[\],\s]+?)\s+(\w+)\s*\(([^)]*)\)/) || src.match(/^func\s+(\w+)\s*\(([^)]*)\)\s*(->\s*\w+)?/m);
  return other ? clip(other[0].replace(/\s+/g, ' ').trim(), 160) : '';
}

/** Is every file on the studio's branch as it is on disk? { ok, base, why }. */
export function landedCheck(root, rels, base) {
  if (git(root, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`).status !== 0) return { ok: false, why: `no branch "${base}" here to check that the code landed` };
  for (const rel of rels) {
    const blob = gitBuf(root, 'show', `${base}:${rel}`);
    if (blob.status !== 0) return { ok: false, why: `${rel} isn't on ${base}: only code that landed (passed the gates) goes in the library` };
    let disk;
    try { disk = fs.readFileSync(path.join(root, ...rel.split('/'))); } catch { return { ok: false, why: `${rel} can't be read` }; }
    const norm = (b) => Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'));
    if (!norm(blob.stdout).equals(norm(disk))) return { ok: false, why: `${rel} differs from ${base}: land the change first (only landed code goes in the library)` };
  }
  return { ok: true, base };
}

export async function addModule(target, o = {}) {
  const root = o.root || await mainRootOf();
  const env = o.env || process.env;
  const name = String(o.name || '').trim();
  const by = String(o.by || '').trim();
  if (!safeName(name)) return { ok: false, why: '--name <name>: lowercase letters, digits and dashes (e.g. grid-path)' };
  if (!by) return { ok: false, why: 'say who proposes it: --by <you>' };
  if (!String(o.does || '').trim()) return { ok: false, why: 'say what it does: --does "<one line>"' };
  const taskId = String(o.task || '').trim();
  if (!/^[A-Z]+-\d+$/.test(taskId)) return { ok: false, why: 'name the task it landed with: --task <T-ID> (only code that landed goes in the library)' };
  if (o.stack && !STACKS.includes(o.stack)) return { ok: false, why: `--stack is one of ${STACKS.join(', ')}` };
  const lib = readLibrary(root);
  if (lib.modules.some((m) => m.name === name)) return { ok: false, why: `the library already has "${name}" (npm run logic -- list)` };
  const abs = path.resolve(root, String(target || ''));
  if (!target || !fs.existsSync(abs)) return { ok: false, why: `${target || '<path>'} doesn't exist` };
  const relRoot = posix(path.relative(root, abs));
  if (relRoot.startsWith('..') || path.isAbsolute(relRoot)) return { ok: false, why: `${target} is outside this studio` };
  if (relRoot === LIB_REL || relRoot.startsWith(`${LIB_REL}/`)) return { ok: false, why: `${target} is already in the library folder` };
  const all = listFiles(abs);
  const isDir = fs.statSync(abs).isDirectory();
  const specAbs = o.spec ? path.resolve(root, o.spec) : [path.join(isDir ? abs : path.dirname(abs), 'spec.json'), ...(isDir ? [] : [abs.replace(/\.[^./\\]+$/, '.spec.json')])].find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  const code = all.filter((f) => CODE_EXT.has(path.extname(f).toLowerCase()) && !/\.(test|spec)\.[a-z]+$/i.test(f));
  if (!code.length) return { ok: false, why: `${target} has no code file (.ts, .mjs, .js, .cs, .gd)` };
  if (!specAbs || !fs.existsSync(specAbs)) return { ok: false, why: 'it needs a language-neutral test spec: spec.json beside the code (or --spec <file>): { "function": "<name>", "cases": [{ "name", "args": [...], "expect": … }] }' };
  const spec = readJson(specAbs, null);
  const sv = validateSpec(spec);
  if (!sv.ok) return { ok: false, why: `${posix(path.relative(root, specAbs))}: ${sv.why}` };
  const stack = o.stack || stackOf(code);
  if (!stack) return { ok: false, why: 'say its stack: --stack ts|cs|gd' };
  const lic = codeLicence({ source: o.source, licence: o.licence });
  if (!lic.ok && !lic.hold) return { ok: false, why: `licence: ${lic.why}` };
  const tests = String(o.tests || '').split(',').map((s) => s.trim()).filter(Boolean).map((t) => posix(path.relative(root, path.resolve(root, t))));
  const golden = o.golden ? posix(path.relative(root, path.resolve(root, o.golden))) : null;
  const rels = [...new Set([...code, specAbs].map((f) => posix(path.relative(root, f))))];
  const proofRels = [...rels, ...tests, ...(golden ? [golden] : [])];
  // Only code that passed the gates: on the studio's branch, and its task done.
  let base = String(o.base || '').trim();
  if (!base) { try { base = (await import('./worktree.mjs')).mainBranch(root) || 'main'; } catch { base = 'main'; } }
  const landed = landedCheck(root, proofRels, base);
  if (!landed.ok) return { ok: false, why: landed.why };
  let done = false;
  try { done = (await import('./task.mjs')).parseNextQueue().done.some((t) => t.id === taskId); } catch {}
  if (!done) return { ok: false, why: `task ${taskId} isn't done: a module goes in the library after its task is done (its checks passed)` };
  if (stack === 'ts') {
    const main = code.find((f) => /\.(mjs|js|ts)$/.test(f) && !/\.d\.ts$/.test(f));
    const r = await runSpec(spec, main);
    if (!r.ok) return { ok: false, why: `its spec fails on ${posix(path.relative(root, main))}: ${r.why}${r.failed?.length ? ` (${r.failed.slice(0, 2).map((f) => `${f.name}: got ${JSON.stringify(f.got)}, expected ${JSON.stringify(f.expect)}`).join('; ')})` : ''}` };
  }
  // Copy the code and its spec into the library.
  const destRel = `modules/${name}`;
  const dest = path.join(libDir(root), 'modules', name);
  const baseDir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  const files = [];
  const hashes = {};
  fs.mkdirSync(dest, { recursive: true });
  for (const f of code) {
    const inside = posix(path.relative(baseDir, f));
    const rel = `${destRel}/${inside.startsWith('..') ? path.basename(f) : inside}`;
    const out = path.join(libDir(root), ...rel.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(f, out);
    files.push(rel);
    hashes[rel] = fileSha(out);
  }
  const specRel = `${destRel}/spec.json`;
  fs.copyFileSync(specAbs, path.join(dest, 'spec.json'));
  hashes[specRel] = fileSha(path.join(dest, 'spec.json'));
  let game = String(o.game || '').trim();
  if (!game) game = readJson(path.join(root, 'studio', 'game.json'), {})?.game || 'unknown';
  const harness = readJson(path.join(root, 'package.json'), {})?.version || '?';
  const landedAt = String(git(root, 'log', '-1', '--format=%cI', base, '--', ...rels).stdout || '').trim() || new Date().toISOString();
  const m = {
    name, does: clip(o.does, 300), interface: clip(o.interface || signatureOf(code[0]) || '(see the code)', 200), stack,
    assumptions: clip(o.assumptions || '', 300), tags: String(o.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
    game, harness, task: taskId, from: relRoot, base, landedAt, tests, golden, files, spec: specRel, specCases: spec.cases.length,
    licence: o.source || o.licence ? String(o.licence || '').trim() : 'own-work', source: String(o.source || '').trim() || null, author: String(o.author || '').trim() || null,
    status: lic.hold ? 'licence-hold' : 'proposed', by, addedAt: new Date().toISOString(), uses: [], hashes,
  };
  if (lic.credit) m.credit = creditLine(m);
  lib.modules.push(m);
  writeLibrary(root, lib);
  emitEvent({ type: 'logic.add', agent: by, task: taskId, to: 'producer', msg: `${by} proposed ${name} for the logic library (${stack}, from ${relRoot}${lic.hold ? `; held: ${m.licence} needs the owner's yes` : ''})`, meta: { name, stack, from: relRoot, licence: m.licence, status: m.status } });
  void env;
  return { ok: true, module: m, why: lic.hold ? lic.why : `proposed: a game dev, an outside agent or a person confirms it (npm run logic -- confirm ${name} --by <name>); never its author` };
}

// ---------- confirm / licence-yes / use ----------
export async function confirmModule(name, { by = '', permission = '', env = process.env, root = null } = {}) {
  root = root || await mainRootOf();
  const lib = readLibrary(root);
  const m = lib.modules.find((x) => x.name === name);
  if (!m) return { ok: false, why: `no module "${name}" (npm run logic -- list)` };
  if (m.status === 'licence-hold') return { ok: false, why: `${name} is held: its ${m.licence} licence needs the owner's yes first (npm run logic -- licence-yes ${name} --by <person> --permission "<their words>")` };
  const who = String(by || '').trim();
  const lower = (s) => String(s || '').trim().toLowerCase();
  const self = [who, env.STUDIO_LOCK_OWNER, env.STUDIO_AGENT].find((n) => n && lower(n) === lower(m.by));
  if (self) return { ok: false, why: `${m.by} proposed ${name}: its author can't confirm it (a game dev, an outside agent or a person can)` };
  const { deciderCheck } = await import('./decider.mjs');
  const d = await deciderCheck({ by: who, permission, action: 'logic-library', env, what: 'confirm a library module' });
  if (!d.ok) return { ok: false, why: d.why };
  const ch = Object.keys(m.hashes || {}).length ? changedFiles(root, m) : [];
  const hashes = {};
  for (const rel of [...(m.files || []), m.spec].filter(Boolean)) { try { hashes[rel] = fileSha(path.join(libDir(root), ...rel.split('/'))); } catch {} }
  m.status = 'confirmed';
  m.confirmedBy = d.by;
  m.confirmedAt = new Date().toISOString();
  m.confirmedAs = d.via;
  m.hashes = hashes;
  writeLibrary(root, lib);
  if (m.credit) {
    const cf = path.join(libDir(root), 'CREDITS.md');
    const prev = fs.existsSync(cf) ? fs.readFileSync(cf, 'utf8') : '# Logic library credits (`studio/logic-library/CREDITS.md`)\n\nCode taken from outside, with its licence. Written by `npm run logic -- confirm`.\n\n';
    if (!prev.includes(m.credit)) fs.writeFileSync(cf, `${prev}- ${m.credit}\n`);
  }
  try { const dm = await import('./decisions-log.mjs'); dm.logDecision({ action: 'logic-library', subject: name, by: d.by, as: dm.asCaller(d, env), why: `confirmed ${name} for the logic library (proposed by ${m.by}, task ${m.task || '?'})`, evidence: `${m.stack}, ${m.files?.length || 0} file(s), spec ${m.specCases || '?'} case(s)${ch.length ? `, re-confirmed after ${ch.length} change(s)` : ''}`, undo: { kind: 'logic-unconfirm', name, text: `the module goes back to proposed (edit studio/logic-library/library.json "status")` }, root }); } catch {}
  emitEvent({ type: 'logic.confirm', agent: d.recordedBy || d.by, to: 'producer', msg: `${d.by} confirmed ${name} for the logic library (${d.via})`, meta: { name, by: d.by, via: d.via } });
  return { ok: true, why: `${name} is in the library (confirmed by ${d.by}, ${d.via})` };
}

export async function licenceYes(name, { by = '', permission = '', env = process.env, root = null } = {}) {
  root = root || await mainRootOf();
  const lib = readLibrary(root);
  const m = lib.modules.find((x) => x.name === name);
  if (!m) return { ok: false, why: `no module "${name}"` };
  if (m.status !== 'licence-hold') return { ok: false, why: `${name} isn't held for a licence` };
  const who = String(by || '').trim();
  if (!who) return { ok: false, why: 'say whose yes it is: --by <person>' };
  if ([who, env.STUDIO_LOCK_OWNER, env.STUDIO_AGENT].some((n) => n && String(n).toLowerCase() === String(m.by).toLowerCase())) return { ok: false, why: `${m.by} proposed ${name}: its author can't record the yes` };
  const { agentOnPermission } = await import('./permission.mjs');
  const { agentLikeName } = await import('./agent-env.mjs');
  if (agentLikeName(who)) return { ok: false, why: `"${who}" is an agent's name: --by names the person (the owner) saying yes` };
  const p = agentOnPermission({ permission, env });
  if (!p.ok) return { ok: false, why: p.why };
  m.status = 'proposed';
  m.licenceYes = { by: who, recordedBy: p.recordedBy, via: p.via, permission: String(permission).trim().slice(0, 300), at: new Date().toISOString(), tier: 'C' };
  m.credit = creditLine(m);
  writeLibrary(root, lib);
  try { const dm = await import('./decisions-log.mjs'); dm.logDecision({ action: 'logic-licence', subject: name, by: who, as: dm.asOf({ via: p.via, permission }), why: `yes to ${m.licence} code in the logic library (${m.source}); tier C`, evidence: String(permission).slice(0, 200), undo: { kind: 'logic-licence-hold', name, text: 'the module is held again (edit studio/logic-library/library.json "status": "licence-hold")' }, root }); } catch {}
  emitEvent({ type: 'logic.licence_yes', agent: p.recordedBy, to: 'producer', msg: `${who} said yes to ${m.licence} code in ${name} (recorded by ${p.recordedBy})`, meta: { name, by: who, via: p.via, tier: 'C' } });
  return { ok: true, why: `${name}: ${who}'s yes recorded (tier C); it still needs a confirm (npm run logic -- confirm ${name} --by <name>)` };
}

export async function useModule(name, { game = '', by = actor(), root = null, now = Date.now() } = {}) {
  root = root || await mainRootOf();
  const lib = readLibrary(root);
  const m = lib.modules.find((x) => x.name === name);
  if (!m) return { ok: false, why: `no module "${name}"` };
  const g = String(game || '').trim() || readJson(path.join(root, 'studio', 'game.json'), {})?.game || '';
  if (!g) return { ok: false, why: 'say which game uses it: --game <name>' };
  m.uses = [...(m.uses || []).filter((u) => u.game !== g), { game: g, at: new Date(now).toISOString(), by }];
  writeLibrary(root, lib);
  emitEvent({ type: 'logic.use', agent: by, msg: `${g} uses ${name} from the logic library`, meta: { name, game: g } });
  return { ok: true, why: `${g} uses ${name}` };
}

export async function listText({ root = null, env = process.env, now = Date.now(), json = false } = {}) {
  root = root || await mainRootOf();
  const lib = readLibrary(root);
  const rows = lib.modules.map((m) => ({ m, st: moduleState(root, m, { now, env }) }));
  if (json) return JSON.stringify(rows.map(({ m, st }) => ({ name: m.name, stack: m.stack, status: m.status, usable: st.usable, stale: st.stale, label: st.label, game: m.game, uses: (m.uses || []).length })), null, 2);
  const days = staleDays(env);
  const L = [`[logic] ${lib.modules.length} module(s) in ${LIB_REL}/${days ? ` (stale: no game used it for ${days} days, STUDIO_LOGIC_STALE_DAYS)` : ''}`];
  for (const { m, st } of rows) L.push(`  ${moduleLine(m)}`, `      ${st.label}${st.stale ? ` · STALE: no game used it for ${days}+ days (npm run logic -- use ${m.name} --game <game>, or retire it)` : ''} · uses: ${(m.uses || []).map((u) => u.game).join(', ') || 'none'}`);
  return L.join('\n');
}

export async function checkModule(name, { impl = null, root = null } = {}) {
  root = root || await mainRootOf();
  const lib = readLibrary(root);
  const m = lib.modules.find((x) => x.name === name);
  if (!m) return { ok: false, why: `no module "${name}"` };
  const spec = readJson(path.join(libDir(root), ...String(m.spec || '').split('/')), null);
  const file = impl ? path.resolve(process.cwd(), impl) : path.join(libDir(root), ...String((m.files || []).find((f) => /\.(mjs|js|ts)$/.test(f)) || m.files?.[0] || '').split('/'));
  const r = await runSpec(spec, file);
  return { ...r, why: r.ok ? `${name}: ${r.ran} case(s) pass on ${posix(path.relative(root, file)) || file}` : `${name}: ${r.why}${r.failed.length ? `\n${r.failed.slice(0, 5).map((f) => `  FAIL ${f.name}: got ${JSON.stringify(f.got)}, expected ${JSON.stringify(f.expect)}`).join('\n')}` : ''}` };
}

// ---------- CLI ----------
function flagsOf(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) flags[k] = true;
      else { flags[k] = v; i++; }
    } else pos.push(a);
  }
  return { flags, pos };
}
const str = (v) => (typeof v === 'string' ? v : '');
const USAGE = `npm run logic -- need "<what>" [--stack ts|cs|gd] [--research]
npm run logic -- add <path> --name <name> --task <T-ID> --does "<what it does>" --by <you> [--interface "…"] [--stack ts|cs|gd] [--assumptions "…"] [--tests a,b] [--golden <file>] [--spec <file>] [--source <url> --licence <id> --author <name>]
npm run logic -- confirm <name> --by <name> [--permission "<a person's words>"]
npm run logic -- licence-yes <name> --by <person> --permission "<their words>"
npm run logic -- use <name> --game <game>
npm run logic -- list [--json] | check <name> [--impl <file>] | index`;

export async function cli(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const { flags, pos } = flagsOf(rest);
  const say = (r) => { (r.ok ? console.log : console.error)(r.why); return r.ok ? 0 : 1; };
  if (!cmd || cmd === '--help' || cmd === 'help' || flags.help) { console.log(USAGE); return 0; }
  if (cmd === 'need') {
    const r = await need(pos.join(' '), { stack: str(flags.stack) || null, research: Boolean(flags.research), role: str(flags.role) || 'reference-scout', by: str(flags.by) || actor() });
    (r.ok ? console.log : console.error)(r.lines.join('\n'));
    return r.ok ? 0 : 1;
  }
  if (cmd === 'add') return say(await addModule(pos[0], { name: str(flags.name), task: str(flags.task), does: str(flags.does), by: str(flags.by), interface: str(flags.interface), stack: str(flags.stack) || null, assumptions: str(flags.assumptions), tests: str(flags.tests), golden: str(flags.golden) || null, spec: str(flags.spec) || null, game: str(flags.game), source: str(flags.source), licence: str(flags.licence), author: str(flags.author), tags: str(flags.tags), base: str(flags.base) }));
  if (cmd === 'confirm') return say(await confirmModule(pos[0], { by: str(flags.by), permission: str(flags.permission) }));
  if (cmd === 'licence-yes' || cmd === 'license-yes') return say(await licenceYes(pos[0], { by: str(flags.by), permission: str(flags.permission) }));
  if (cmd === 'use') return say(await useModule(pos[0], { game: str(flags.game), by: str(flags.by) || actor() }));
  if (cmd === 'list') { console.log(await listText({ json: Boolean(flags.json) })); return 0; }
  if (cmd === 'check') return say(await checkModule(pos[0], { impl: str(flags.impl) || null }));
  if (cmd === 'index') { const root = await mainRootOf(); writeLibrary(root, readLibrary(root)); console.log(`wrote ${LIB_REL}/INDEX.md`); return 0; }
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) process.exit(await cli());
