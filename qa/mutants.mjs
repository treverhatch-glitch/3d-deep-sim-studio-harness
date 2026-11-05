#!/usr/bin/env node
/**
 * qa/mutants.mjs — 2.78.0 (PU-57): a mutation score per required gate. Report only; never a gate, always exit 0.
 *
 * A green gate may guard nothing. This plants one small bug at a time in the sim cartridge (on a scratch copy of the
 * repo, never in a lane or in main's files), runs the required cartridge gates on it, and records which gates failed
 * (killed the mutant). A mutant no gate killed marks code that nothing guards.
 *
 *   node qa/mutants.mjs [--cartridge <name>] [--max N] [--seed N] [--gates a,b] [--out file] [--json]
 *   node qa/mutants.mjs --compare <older report> [<newer report>]    print each gate's rate change; runs nothing
 *
 * Settings (docs/BENCH.md, "Mutation score"):
 *   STUDIO_MUTANTS_MAX         mutants to run (default 40, seeded order)
 *   STUDIO_MUTANTS_SEED        seed for the order (default 278)
 *   STUDIO_MUTANTS_GATES       gate ids to run on each mutant (default: the required cartridge gates, without browser-play)
 *   STUDIO_MUTANTS_BUDGET_MIN  stop starting new mutants after this many minutes (default 20)
 *
 * Operators (plain text edits, seeded, deterministic): cmp-flip, loop-bound, drop-call, swap-stmts, rng-freeze,
 * save-skip, ignore-action, swap-const. A mutant that does not parse (node --check) or does not change behaviour
 * (the same digest of the scenarios, the goldens and a fixed fuzz replay) is discarded and not counted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');
const nl = (s) => String(s).replace(/\r\n?/g, '\n');
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

// ---------------------------------------------------------------- seeded order
function mulberry(seed) {
  let a = Number(seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(list, rnd) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------------------------------------------------------------- source scan
/** Same length as src: comments become spaces, string/template/regex contents become '_' (newlines stay). */
export function maskCode(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (a, b, ch) => { for (let k = a; k < b; k++) if (src[k] !== '\n') out[k] = ch; };
  let i = 0;
  let last = '';
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { let j = src.indexOf('\n', i); if (j < 0) j = n; blank(i, j, ' '); i = j; continue; }
    if (c === '/' && d === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; blank(i, j, ' '); i = j; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      blank(i + 1, j, '_'); i = j + 1; last = c; continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== '`') { if (src[j] === '\\') j++; j++; }
      blank(i + 1, j, '_'); i = j + 1; last = c; continue;
    }
    if (c === '/' && (last === '' || /[(,=:[!&|?{};]/.test(last))) {
      let j = i + 1; let cls = false;
      while (j < n && src[j] !== '\n' && (cls || src[j] !== '/')) { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
      blank(i + 1, j, '_'); i = j + 1; last = '/'; continue;
    }
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return out.join('');
}

function matchClose(masked, openIdx) {
  const open = masked[openIdx];
  const close = { '(': ')', '{': '}', '[': ']' }[open];
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    if (masked[i] === open) depth++;
    else if (masked[i] === close && --depth === 0) return i;
  }
  return -1;
}

/** Function bodies: [{ name, start, end }] (offsets of the `{` and its `}`), for function declarations and `name = (…) => {`. */
export function functionBodies(masked) {
  const found = [];
  const add = (name, parenIdx) => {
    const close = matchClose(masked, parenIdx);
    if (close < 0) return;
    const m = /^\s*(?:=>\s*)?\{/.exec(masked.slice(close + 1));
    if (!m) return;
    const bs = close + 1 + m[0].length - 1;
    const be = matchClose(masked, bs);
    if (be > 0) found.push({ name, start: bs, end: be });
  };
  for (const m of masked.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) add(m[1], m.index + m[0].length - 1);
  for (const m of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) add(m[1], m.index + m[0].length - 1);
  return found;
}

const TICK_NAMES = /^(step|tick|update|stepSim|simStep|advance|stepWorld|runTick)$/;
const SAVE_NAMES = /^(save|serialize|serialise|snapshot|toJSON|exportState|saveState|dump)\w*$/i;
const KEYWORDS = /^(if|for|while|switch|return|throw|break|continue|const|let|var|else|case|default|do|try|catch|finally|function|class|await|yield|new|typeof|delete)\b/;
const balanced = (s) => { let p = 0; let b = 0; let c = 0; for (const ch of s) { if (ch === '(') p++; else if (ch === ')') p--; else if (ch === '[') b++; else if (ch === ']') b--; else if (ch === '{') c++; else if (ch === '}') c--; if (p < 0 || b < 0 || c < 0) return false; } return !p && !b && !c; };

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}
const lineOf = (starts, off) => { let lo = 0; let hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; };

/** Every mutation one file offers: [{ operator, start, end, text, desc }] (text replaces src[start,end)). */
export function candidatesFor(src) {
  const masked = maskCode(src);
  const out = [];
  const push = (operator, start, end, text, desc) => { if (src.slice(start, end) !== text) out.push({ operator, start, end, text, desc }); };
  const short = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 60);

  // cmp-flip: < <-> >=, <= <-> >
  for (const m of masked.matchAll(/<=|>=|<|>/g)) {
    const i = m.index; const op = m[0]; const prev = masked[i - 1]; const next = masked[i + op.length];
    if (op === '>' && (prev === '=' || prev === '-' || prev === '>' || next === '>')) continue;
    if (op === '<' && (prev === '<' || next === '<')) continue;
    if (op === '>=' && (prev === '>' || next === '>')) continue;
    const to = { '<': '>=', '>=': '<', '<=': '>', '>': '<=' }[op];
    push('cmp-flip', i, i + op.length, to, `${op} -> ${to} in \`${short(src.slice(Math.max(0, src.lastIndexOf('\n', i) + 1), src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i)))}\``);
  }

  // loop-bound: for (…; i < N; …) -> N - 1
  for (const m of masked.matchAll(/\bfor\s*\(([^;{}]*);([^;]*?)(<=|<)([^;]*);/g)) {
    const bStart = m.index + m[0].length - 1 - m[4].length;
    const end = m.index + m[0].length - 1;
    const bound = src.slice(bStart, end);
    push('loop-bound', bStart, end, ` (${bound.trim()}) - 1`, `for-loop bound \`${short(bound)}\` -> \`(${short(bound)}) - 1\``);
  }

  // statements in the tick function: drop-call, swap-stmts
  const bodies = functionBodies(masked);
  const starts = lineStarts(src);
  for (const fn of bodies.filter((b) => TICK_NAMES.test(b.name))) {
    const first = lineOf(starts, fn.start) + 1;
    const last = lineOf(starts, fn.end) - 1;
    const lines = [];
    for (let ln = first; ln <= last; ln++) {
      const s = starts[ln - 1]; const e = (starts[ln] ?? src.length + 1) - 1;
      const raw = src.slice(s, e); const mk = masked.slice(s, e);
      const lead = raw.length - raw.trimStart().length;
      lines.push({ ln, s, e, raw, mk, lead, mt: mk.trim(), indent: raw.slice(0, lead) });
    }
    for (const L of lines) {
      if (/^[A-Za-z_$][\w$.]*\(.*\);$/.test(L.mt) && !KEYWORDS.test(L.mt) && balanced(L.mt)) {
        push('drop-call', L.s + L.lead, L.e, '/* mutant: call dropped */;', `call statement dropped in ${fn.name}(): \`${short(L.raw)}\``);
      }
    }
    const simple = (L) => L.mt.endsWith(';') && !/^(return|break|continue|throw|if|for|while|else|case|default|\}|\{)/.test(L.mt) && balanced(L.mt) && !L.mt.endsWith('{');
    for (let k = 0; k + 1 < lines.length; k++) {
      const A = lines[k]; const B = lines[k + 1];
      if (!simple(A) || !simple(B) || A.indent !== B.indent || A.raw.trim() === B.raw.trim()) continue;
      const decl = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(A.mt);
      if (decl && new RegExp(`\\b${decl[1].replace(/\$/g, '\\$')}\\b`).test(B.mt)) continue;
      const declB = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(B.mt);
      if (declB && new RegExp(`\\b${declB[1].replace(/\$/g, '\\$')}\\b`).test(A.mt)) continue;
      push('swap-stmts', A.s + A.lead, B.e, `${B.raw.trim()}\n${A.indent}${A.raw.trim()}`, `swapped lines ${A.ln} and ${B.ln} of ${fn.name}()`);
    }
  }

  // rng-freeze: a seeded rng step's result becomes a constant
  for (const m of masked.matchAll(/\b(?:rng|rand|random)\w*\(\s*\)/gi)) push('rng-freeze', m.index, m.index + m[0].length, '0.5', `rng call \`${m[0]}\` -> 0.5`);
  for (const m of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[\w$.]*(?:mulberry|rng|rand)[\w$]*\(/gi)) {
    const v = m[1].replace(/\$/g, '\\$');
    for (const u of masked.matchAll(new RegExp(`\\b${v}\\.value\\b`, 'g'))) push('rng-freeze', u.index, u.index + u[0].length, '0.5', `rng result \`${u[0]}\` frozen to 0.5`);
  }

  // save-skip: one field left out of save/serialise
  for (const fn of bodies.filter((b) => SAVE_NAMES.test(b.name))) {
    const first = lineOf(starts, fn.start); const last = lineOf(starts, fn.end);
    for (let ln = first + 1; ln < last; ln++) {
      const s = starts[ln - 1]; const e = (starts[ln] ?? src.length + 1) - 1;
      const mt = masked.slice(s, e).trim();
      if (/^[A-Za-z_$][\w$]*(\s*:\s*.+)?,$/.test(mt) && balanced(mt)) push('save-skip', s, e, '', `field left out of ${fn.name}(): \`${short(src.slice(s, e))}\``);
    }
  }

  // ignore-action: an action type is never recognised
  for (const m of masked.matchAll(/(?:\.type\s*={2,3}\s*|\bcase\s+)(['"])(_+)\1/g)) {
    const qAt = m.index + m[0].length - m[2].length - 2;
    const lit = src.slice(qAt + 1, qAt + 1 + m[2].length);
    push('ignore-action', qAt + 1, qAt + 1 + m[2].length, `${lit}~ignored`, `action '${lit}' is ignored`);
  }

  // swap-const: two adjacent numeric constants, or two ids in one list, trade places
  const numLine = /^(\s*[\w$]+\s*:\s*)(-?\d[\d_.]*)(\s*,.*)$/;
  for (let ln = 1; ln < starts.length; ln++) {
    const a = src.slice(starts[ln - 1], starts[ln] - 1); const b = src.slice(starts[ln], (starts[ln + 1] ?? src.length + 1) - 1);
    const ma = numLine.exec(a); const mb = numLine.exec(b);
    if (ma && mb && ma[2] !== mb[2] && /^\s*[\w$]+\s*:/.test(b) && !/^\s*$/.test(masked.slice(starts[ln - 1], starts[ln] - 1))) {
      const as = starts[ln - 1] + ma[1].length; const bs = starts[ln] + mb[1].length;
      push('swap-const', as, bs + mb[2].length, `${mb[2]}${src.slice(as + ma[2].length, bs)}${ma[2]}`, `constants on lines ${ln} and ${ln + 1} swapped (${ma[2]} <-> ${mb[2]})`);
    }
  }
  for (const m of masked.matchAll(/(['"])(_+)\1(\s*,\s*)(['"])(_+)\4/g)) {
    const a0 = m.index; const aEnd = a0 + m[2].length + 2; const bStart = m.index + m[0].length - m[5].length - 2; const bEnd = m.index + m[0].length;
    const A = src.slice(a0, aEnd); const B = src.slice(bStart, bEnd);
    if (A !== B) push('swap-const', a0, bEnd, `${B}${src.slice(aEnd, bStart)}${A}`, `ids ${A} and ${B} swapped`);
  }
  return out;
}

export const applyCandidate = (src, c) => src.slice(0, c.start) + c.text + src.slice(c.end);
export const OPERATORS = ['cmp-flip', 'loop-bound', 'drop-call', 'swap-stmts', 'rng-freeze', 'save-skip', 'ignore-action', 'swap-const'];

// ---------------------------------------------------------------- scratch copy and digest
function scratchCopy(root, scratchRoot) {
  fs.mkdirSync(scratchRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratchRoot, 'mutants-'));
  fs.cpSync(root, dir, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|\.studio|node_modules)$/.test(src) && !/[\\/]qa[\\/]reports$/.test(src) });
  const nm = path.join(root, 'node_modules');
  if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(dir, 'node_modules'), 'junction'); } catch { /* the gates run without it */ } }
  const g = (...a) => sh('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'm', GIT_AUTHOR_EMAIL: 'm@example.invalid', GIT_COMMITTER_NAME: 'm', GIT_COMMITTER_EMAIL: 'm@example.invalid' } });
  g('init', '-q', '-b', 'main'); g('config', 'core.autocrlf', 'false'); g('config', 'core.eol', 'lf'); g('add', '-A'); g('commit', '-qm', 'scratch', '--no-verify');
  return dir;
}

const DIGEST_SCRIPT = (cartUrl) => `import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { loadCartridge, replay, runScenario } from ${JSON.stringify(cartUrl)};
const name = process.argv[2];
const out = [];
const rec = (k, f) => { try { out.push([k, f()]); } catch (e) { out.push([k, 'threw: ' + String(e && e.message || e)]); } };
let cart;
try { cart = await loadCartridge(name); } catch (e) { console.log(JSON.stringify({ digest: 'load-failed: ' + String(e && e.message || e).slice(0, 200) })); process.exit(0); }
for (const n of Object.keys(cart.scenarios).sort()) rec('scenario:' + n, () => { const r = runScenario(cart, n); return [r.sha256, r.outcome, r.ticksRun, r.failingTick]; });
const gd = path.join('qa', 'golden');
for (const f of fs.existsSync(gd) ? fs.readdirSync(gd).filter((x) => x.endsWith('.json')).sort() : []) {
  const spec = JSON.parse(fs.readFileSync(path.join(gd, f), 'utf8'));
  if (spec.cartridge && spec.cartridge !== name) continue;
  rec('golden:' + f, () => { const r = spec.scenario ? runScenario(cart, spec.scenario, { seed: spec.seed, tuning: spec.tuning }) : replay(cart, { seed: spec.seed, tick: spec.tick, actions: spec.actions || [], tuning: spec.tuning }); return [r.sha256, r.outcome, r.ticksRun, r.failingTick]; });
}
const mk = (seed) => { let a = seed >>> 0; const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; r.int = (n) => Math.floor(r() * n); r.pick = (l) => l[Math.floor(r() * l.length)]; return r; };
if (cart.actions) for (const seed of [1, 7]) rec('fuzz:' + seed, () => {
  const rand = mk(seed); let s = cart.init(seed); const trail = [];
  for (let t = 1; t <= 250; t++) { const a = cart.actions(s, rand); s = cart.step(s, a ? [a] : null); if (t % 50 === 0) trail.push(cart.sha256(s)); }
  return trail;
});
console.log(JSON.stringify({ digest: crypto.createHash('sha256').update(JSON.stringify(out)).digest('hex') }));
`;

function digestOf(dir, cartridge) {
  const r = sh(process.execPath, [path.join(dir, '.mutants-digest.mjs'), cartridge], { cwd: dir, timeout: 30000 });
  if (r.error || r.status === null) return 'timeout';
  const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  try { return JSON.parse(line).digest; } catch { return `crash: ${String(r.stderr || '').slice(-200)}`; }
}

const GATE_ROW = /^\s*(PASS|FAIL|WARN|SKIP\w*)\s+([\w:-]+)/;
function runGates(dir, ids, cartridge, timeoutMs) {
  const env = { ...process.env, STUDIO_VERIFY_DETACH: 'off', STUDIO_CARTRIDGE: cartridge, STUDIO_REFILL_WAKE: 'off', STUDIO_HOOKS_CHECK: 'off' };
  for (const k of ['NODE_OPTIONS', 'npm_config_node_options', 'STUDIO_VERIFY_RUN', 'STUDIO_GATE_CHANGED', 'STUDIO_GATE_PATHS', 'STUDIO_GAME']) delete env[k];
  const r = sh(process.execPath, ['scripts/run-gates.mjs', '--only', ids.join(','), '--no-cache'], { cwd: dir, env, timeout: timeoutMs });
  if (r.error || r.status === null) return { timeout: true, rows: {} };
  const text = nl(`${r.stdout || ''}\n${r.stderr || ''}`);
  const rows = {};
  const at = text.lastIndexOf('[gates] summary');
  for (const l of (at >= 0 ? text.slice(at) : '').split('\n')) { const m = GATE_ROW.exec(l); if (m) rows[m[2]] = m[1]; }
  return { timeout: false, rows };
}

// ---------------------------------------------------------------- the run
const rate = (killed, ran) => (ran ? Math.round((killed / ran) * 1000) / 1000 : null);
const pct = (r) => (r === null || r === undefined ? 'n/a' : `${(r * 100).toFixed(1)}%`);

function cartridgeFiles(dir, cartridge) {
  const base = path.join(dir, 'cartridges', cartridge);
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.mjs$/.test(e.name) && e.name !== 'qa.mjs' && !/\.(test|spec)\./.test(e.name)) files.push(p);
    }
  };
  if (fs.existsSync(base)) walk(base);
  return files.sort().map((p) => path.relative(dir, p).split(path.sep).join('/'));
}

function defaultGates(root) {
  const fromEnv = String(process.env.STUDIO_MUTANTS_GATES || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'gates.json'), 'utf8'));
    return (cfg.gates || []).filter((g) => g.cartridge && g.required !== false && !g.trainOnly && !g.deep && g.id !== 'browser-play').map((g) => g.id);
  } catch { return []; }
}

/**
 * Run the mutation pass. Options: root, cartridge, max, seed, gates, scratchRoot, budgetMin, log(fn),
 * prepare(scratchDir) (change the scratch copy before the baseline; tests weaken a gate here),
 * extraCandidates ([{ file, start, end, text, operator, desc }] added to the pool; tests plant a broken one).
 * Returns the report object (not written).
 */
export async function runMutants(opts = {}) {
  const t0 = Date.now();
  const root = opts.root || DEFAULT_ROOT;
  const log = opts.log || (() => {});
  const num = (v, d) => { const n = Number(v); return v === undefined || v === null || String(v).trim() === '' || !Number.isFinite(n) ? d : n; };
  const max = num(opts.max, num(process.env.STUDIO_MUTANTS_MAX, 40));
  const seed = num(opts.seed, num(process.env.STUDIO_MUTANTS_SEED, 278));
  const budgetMs = num(opts.budgetMin, num(process.env.STUDIO_MUTANTS_BUDGET_MIN, 20)) * 60000;
  const { defaultCartridgeName } = await import(pathToFileURL(path.join(root, 'harness', 'cartridge.mjs')).href);
  const cartridge = opts.cartridge || defaultCartridgeName() || 'example-sim';
  const wanted = opts.gates?.length ? opts.gates : defaultGates(root);
  const scratch = scratchCopy(root, opts.scratchRoot || os.tmpdir());
  const report = { tool: 'qa/mutants.mjs', version: 1, at: new Date().toISOString(), cartridge, seed, max, gates: [], baseline: {}, baselineSkipped: [], mutants: [], discarded: { parse: [], equivalent: 0 }, gateRates: {}, survivors: [], stoppedForBudget: false, ms: 0 };
  try {
    fs.writeFileSync(path.join(scratch, '.mutants-digest.mjs'), DIGEST_SCRIPT(pathToFileURL(path.join(scratch, 'harness', 'cartridge.mjs')).href));
    if (typeof opts.prepare === 'function') opts.prepare(scratch);
    if (!wanted.length) { report.note = 'no gates to run'; return report; }
    const base = runGates(scratch, wanted, cartridge, 300000);
    report.baseline = base.rows;
    report.gates = wanted.filter((g) => base.rows[g] === 'PASS');
    report.baselineSkipped = wanted.filter((g) => base.rows[g] !== 'PASS');
    log(`[mutants] baseline: ${report.gates.length}/${wanted.length} gates pass on the unmutated ${cartridge}${report.baselineSkipped.length ? ` (left out: ${report.baselineSkipped.join(', ')})` : ''}`);
    if (!report.gates.length) { report.note = 'no gate passes on the unmutated cartridge, so nothing can be measured'; return report; }
    const baseDigest = digestOf(scratch, cartridge);

    // The pool, one operator at a time in seeded order, then dealt round-robin so no operator crowds the rest out.
    const rnd = mulberry(seed);
    const originals = new Map();
    const byOp = new Map(OPERATORS.map((o) => [o, []]));
    for (const file of cartridgeFiles(scratch, cartridge)) {
      const src = nl(fs.readFileSync(path.join(scratch, file), 'utf8'));
      originals.set(file, src);
      const starts = lineStarts(src);
      for (const c of candidatesFor(src)) byOp.get(c.operator).push({ ...c, file, line: lineOf(starts, c.start) });
    }
    const extras = [];
    for (const x of opts.extraCandidates || []) {
      const src = originals.get(x.file) ?? nl(fs.readFileSync(path.join(scratch, x.file), 'utf8'));
      originals.set(x.file, src);
      extras.push({ line: lineOf(lineStarts(src), x.start || 0), ...x });
    }
    const queues = [...byOp.values()].map((l) => shuffled(l, rnd));
    const order = [...extras];
    for (let i = 0; queues.some((q) => i < q.length); i++) for (const q of queues) if (i < q.length) order.push(q[i]);
    report.candidates = order.length;

    for (const c of order) {
      if (report.mutants.length >= max) break;
      if (Date.now() - t0 > budgetMs) { report.stoppedForBudget = true; break; }
      const abs = path.join(scratch, c.file);
      const mutated = applyCandidate(originals.get(c.file), c);
      try {
        fs.writeFileSync(abs, mutated);
        const chk = sh(process.execPath, ['--check', abs], { cwd: scratch });
        if (chk.status !== 0) { report.discarded.parse.push({ file: c.file, line: c.line, operator: c.operator, desc: c.desc }); continue; }
        if (digestOf(scratch, cartridge) === baseDigest) { report.discarded.equivalent++; continue; }
        const res = runGates(scratch, report.gates, cartridge, 180000);
        const ranOn = report.gates.filter((g) => res.rows[g] === 'PASS' || res.rows[g] === 'FAIL');
        const killedBy = ranOn.filter((g) => res.rows[g] === 'FAIL');
        report.mutants.push({ id: report.mutants.length + 1, file: c.file, line: c.line, operator: c.operator, desc: c.desc, ranOn, killedBy, ...(res.timeout ? { timeout: true } : {}) });
        log(`[mutants] ${report.mutants.length}/${max} ${c.file}:${c.line} ${c.operator}: ${killedBy.length ? `killed by ${killedBy.join(', ')}` : res.timeout ? 'TIMEOUT' : 'SURVIVED'}`);
      } finally {
        fs.writeFileSync(abs, originals.get(c.file));
      }
    }
  } finally {
    if (!process.env.KEEP_MUTANTS_DIR) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* temp */ } } else report.scratch = scratch;
  }
  // A timed-out run says nothing about which gate would have failed: it is left out of the rates and the survivors.
  const counted = report.mutants.filter((m) => !m.timeout);
  for (const g of report.gates) {
    const ran = counted.filter((m) => m.ranOn.includes(g));
    const killed = ran.filter((m) => m.killedBy.includes(g));
    report.gateRates[g] = { ran: ran.length, killed: killed.length, rate: rate(killed.length, ran.length) };
  }
  report.survivors = counted.filter((m) => !m.killedBy.length).map((m) => ({ file: m.file, line: m.line, operator: m.operator, desc: m.desc }));
  report.killedByAny = counted.filter((m) => m.killedBy.length).length;
  report.ms = Date.now() - t0;
  return report;
}

export function summaryLines(report) {
  const L = [];
  const counted = report.mutants.filter((m) => !m.timeout);
  L.push(`Mutation score for ${report.cartridge} (seed ${report.seed}): ${counted.length} mutants run, ${report.killedByAny ?? 0} killed by at least one gate, ${report.survivors.length} survived`);
  L.push(`  discarded: ${report.discarded.parse.length} did not parse, ${report.discarded.equivalent} did not change behaviour${report.stoppedForBudget ? '; stopped early: time budget used' : ''}`);
  if (report.note) L.push(`  note: ${report.note}`);
  if (report.baselineSkipped?.length) L.push(`  not measured (red or not run on the unmutated cartridge): ${report.baselineSkipped.join(', ')}`);
  L.push('Kill rate per gate (killed / mutants it ran on):');
  for (const [g, r] of Object.entries(report.gateRates)) L.push(`  ${g.padEnd(16)} ${String(r.killed).padStart(3)} / ${String(r.ran).padEnd(3)} ${pct(r.rate)}`);
  if (report.survivors.length) {
    L.push('Mutants no gate killed (code nothing guards):');
    for (const s of report.survivors) L.push(`  ${s.file}:${s.line}  ${s.operator}  ${s.desc}`);
  } else if (counted.length) L.push('Every mutant was killed by at least one gate.');
  L.push(`Run time: ${Math.round(report.ms / 1000)} s`);
  return L;
}

export function compareLines(older, newer) {
  const L = [`Kill rate per gate: ${older.at?.slice(0, 10) || 'older'} -> ${newer.at?.slice(0, 10) || 'newer'} (${older.cartridge} / ${newer.cartridge})`];
  if (older.cartridge !== newer.cartridge || older.seed !== newer.seed || older.max !== newer.max) L.push('  note: the two runs used a different cartridge, seed or sample size, so a change may be sampling, not the gate');
  const ids = [...new Set([...Object.keys(older.gateRates || {}), ...Object.keys(newer.gateRates || {})])];
  for (const g of ids) {
    const a = older.gateRates?.[g]; const b = newer.gateRates?.[g];
    if (!a) { L.push(`  ${g.padEnd(16)} new: ${pct(b.rate)}`); continue; }
    if (!b) { L.push(`  ${g.padEnd(16)} not measured now (was ${pct(a.rate)})`); continue; }
    const d = a.rate === null || b.rate === null ? null : Math.round((b.rate - a.rate) * 1000) / 10;
    L.push(`  ${g.padEnd(16)} ${pct(a.rate)} -> ${pct(b.rate)}${d === null ? '' : d < 0 ? `  DROPPED ${Math.abs(d)} points` : d > 0 ? `  up ${d} points` : '  same'}`);
  }
  return L;
}

// ---------------------------------------------------------------- CLI
function outFile(root, explicit) {
  if (explicit) return path.resolve(explicit);
  const dir = path.join(root, 'qa', 'reports');
  const day = new Date().toISOString().slice(0, 10);
  let f = path.join(dir, `mutants-${day}.json`);
  for (let i = 2; fs.existsSync(f); i++) f = path.join(dir, `mutants-${day}-${i}.json`);
  return f;
}

async function main(argv) {
  const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  if (argv.includes('--compare')) {
    const i = argv.indexOf('--compare');
    const olderPath = argv[i + 1];
    let newerPath = argv[i + 2] && !argv[i + 2].startsWith('--') ? argv[i + 2] : null;
    if (!olderPath || !fs.existsSync(olderPath)) { console.error('usage: node qa/mutants.mjs --compare <older report> [<newer report>]'); return 2; }
    if (!newerPath) {
      const dir = path.join(DEFAULT_ROOT, 'qa', 'reports');
      const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^mutants-.*\.json$/.test(f)).map((f) => path.join(dir, f)).filter((f) => path.resolve(f) !== path.resolve(olderPath)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs) : [];
      newerPath = all.pop();
    }
    if (!newerPath) { console.error('no newer mutants report to compare with; pass one'); return 2; }
    for (const l of compareLines(JSON.parse(fs.readFileSync(olderPath, 'utf8')), JSON.parse(fs.readFileSync(newerPath, 'utf8')))) console.log(l);
    return 0;
  }
  const report = await runMutants({
    cartridge: arg('--cartridge'),
    max: arg('--max'),
    seed: arg('--seed'),
    gates: arg('--gates') ? arg('--gates').split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    log: (l) => console.error(l),
  });
  const file = outFile(DEFAULT_ROOT, arg('--out'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  if (argv.includes('--json')) console.log(JSON.stringify(report));
  else for (const l of summaryLines(report)) console.log(l);
  console.log(`Report: ${path.relative(DEFAULT_ROOT, file).split(path.sep).join('/')} (report only: this never fails a run)`);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`[mutants] ${e.stack || e}`); process.exit(0); });
}
