#!/usr/bin/env node
/**
 * scripts/check-sim-isolation.mjs [root] — presentation code must not leak into the sim layer.
 * Fails on: rendering/UI imports, DOM access, Math.random, and on zero sim files found.
 * No line-based exemptions: a comment or the word "playtest" on a line does not excuse it.
 * Pure Node, so it runs the same on Windows, macOS and Linux.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || '.');
const SIM_PATHS = ['src/sim', 'src/game/sim', 'src/game/pathfinding', 'src/game/economy', 'cartridges'];
const EXT = /\.(ts|tsx|mts|js|mjs|cjs|jsx)$/;
const FORBIDDEN = [
  /(from|import\(|require\()\s*['"](three|react|react-dom|@react-three\/[^'"]*|pixi\.js|phaser)(\/[^'"]*)?['"]/,
  /\bdocument\./,
  /\bwindow\./,
  /Math\.random/,
];
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (EXT.test(e.name)) out.push(full);
  }
  return out;
}

let failed = false;
let dirs = 0;
let files = 0;
for (const rel of SIM_PATHS) {
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
  dirs += 1;
  const list = walk(dir, []);
  files += list.length;
  const hits = [];
  for (const file of list) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!COMMENT_LINE.test(line) && FORBIDDEN.some((re) => re.test(line))) hits.push(`${path.relative(ROOT, file).split(path.sep).join('/')}:${i + 1}:${line.trim()}`);
    });
  }
  if (hits.length) {
    console.log(`[isolation] FAIL forbidden pattern in ${rel}:`);
    console.log(hits.join('\n'));
    failed = true;
  }
}
if (files === 0) {
  console.log(`[isolation] FAIL 0 simulation files found under ${SIM_PATHS.join(' ')}`);
  failed = true;
}
if (failed) {
  console.log('[isolation] FAILED');
  process.exit(1);
}
console.log(`[isolation] PASS — ${files} file(s) in ${dirs} folder(s)`);
