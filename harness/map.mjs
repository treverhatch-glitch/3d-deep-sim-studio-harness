#!/usr/bin/env node
/**
 * harness/map.mjs — a map of the repo, so an agent reads one short page instead of opening twenty files.
 *
 *   npm run map              write .studio/MAP.md and .studio/MAP.json (a script: no model, no tokens)
 *   npm run map -- --check   exit 1 when the map is older than the code it describes
 *
 * For each code file: what it is (the first line of its header comment), its size, what it exports,
 * and which lane and agent hold it right now. Agents are told to read the map before searching.
 * Jed's run: Claude sessions read about 37.6M cached tokens and wrote about 0.24M, so the cost is
 * re-reading context, not writing code. The launcher refreshes the map before an agent starts, when
 * code changed; it is studio state (.studio/), never committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR } from './event.mjs';

export const MAP_MD = path.join(STUDIO_STATE_DIR, 'MAP.md');
export const MAP_JSON = path.join(STUDIO_STATE_DIR, 'MAP.json');
const CODE = /\.(mjs|js|cjs|ts|tsx|jsx|py|gd|cs|gdshader|html|css)$/i;
const SKIP_DIR = new Set(['node_modules', '.git', '.studio', 'dist', 'build', '__pycache__', 'reports', 'golden', 'regressions', 'fixtures', '.godot', 'export', 'assets']);
// Where code lives: the harness, and the game (cartridges/, game/, web/, engine/).
const ROOTS = ['harness', 'hub', 'qa', 'scripts', 'tools', 'cartridges', 'game', 'web', 'engine', 'src'];

function walk(rel, out) {
  const full = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(full)) return;
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name) && !e.name.startsWith('.')) walk(r, out);
    } else if (CODE.test(e.name)) out.push(r);
  }
}

/** The first sentence of a file's header comment: what it is, in the author's words. */
export function purposeOf(text) {
  const head = text.slice(0, 2500);
  const block = head.match(/\/\*\*?([\s\S]*?)\*\//);
  const lines = (block ? block[1] : head.match(/^(?:\s*(?:\/\/|#)[^\n]*\n)+/)?.[0] || '').split('\n').map((l) => l.replace(/^\s*(\*|\/\/|#)\s?/, '').trim()).filter((l) => l && !/^!|^eslint|^@/.test(l));
  const first = lines.join(' ').replace(/^[\w./-]+\.(m?js|py|gd|ts)\s*[—–-]\s*/, '');
  return (first.split(/(?<=[.!?])\s/)[0] || '').slice(0, 160);
}
export function exportsOf(text) {
  const names = [...text.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const listed = [...text.matchAll(/^export\s*\{([^}]+)\}/gm)].flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  return [...new Set([...names, ...listed])];
}

export function buildMap() {
  const files = [];
  for (const r of ROOTS) walk(r, files);
  let holds = {};
  try {
    holds = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'studio', 'task-holds.json'), 'utf8')).tasks || {};
  } catch {
    // no holds
  }
  const lanes = [...new Set(Object.values(holds).map((h) => h.lane).filter(Boolean))];
  let locks = [];
  try {
    const dir = path.join(STUDIO_STATE_DIR, 'locks');
    locks = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter((l) => String(l.key).startsWith('path:'));
  } catch {
    // no locks
  }
  const rows = files.sort().map((f) => {
    const text = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
    const lane = lanes.filter((l) => f === l || f.startsWith(`${l}/`)).sort((a, b) => b.length - a.length)[0] || null;
    const held = locks.find((l) => f === l.key.slice(5) || f.startsWith(`${l.key.slice(5)}/`));
    return { file: f, lines: text.split('\n').length, purpose: purposeOf(text), exports: /\.(m?js|ts)$/.test(f) ? exportsOf(text).slice(0, 12) : [], lane, heldBy: held?.owner || null };
  });
  return { at: new Date().toISOString(), files: rows };
}

export function writeMap() {
  const m = buildMap();
  fs.mkdirSync(path.dirname(MAP_JSON), { recursive: true });
  fs.writeFileSync(MAP_JSON, `${JSON.stringify(m, null, 2)}\n`);
  const groups = new Map();
  for (const r of m.files) {
    const top = r.file.split('/').slice(0, /^(cartridges|game|web|engine)\//.test(r.file) ? 2 : 1).join('/');
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push(r);
  }
  const L = ['# Repo map (`.studio/MAP.md`)', '', `> Made by \`npm run map\` at ${m.at.slice(0, 16).replace('T', ' ')} UTC. Read this before searching or opening files; the launcher refreshes it when code changes. Files over 300 lines are marked: split them before two people need them.`, ''];
  for (const [top, rows] of groups) {
    L.push(`## ${top}/`, '');
    for (const r of rows) L.push(`- \`${r.file}\` (${r.lines} lines${r.lines > 300 ? ', **big**' : ''}${r.lane ? `, lane ${r.lane}` : ''}${r.heldBy ? `, held by ${r.heldBy}` : ''})${r.purpose ? `: ${r.purpose}` : ''}${r.exports.length ? ` Exports: ${r.exports.join(', ')}.` : ''}`);
    L.push('');
  }
  fs.writeFileSync(MAP_MD, `${L.join('\n')}\n`);
  return { files: m.files.length, at: m.at };
}

/** Is the map older than any code file? */
export function mapStale() {
  if (!fs.existsSync(MAP_JSON)) return true;
  const at = fs.statSync(MAP_JSON).mtimeMs;
  const files = [];
  for (const r of ROOTS) walk(r, files);
  return files.some((f) => fs.statSync(path.join(REPO_ROOT, f)).mtimeMs > at + 1000);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--check')) {
    const stale = mapStale();
    console.log(stale ? 'The map is older than the code: npm run map' : 'The map is up to date.');
    process.exit(stale ? 1 : 0);
  }
  const r = writeMap();
  console.log(`Wrote .studio/MAP.md and .studio/MAP.json (${r.files} files).`);
}
