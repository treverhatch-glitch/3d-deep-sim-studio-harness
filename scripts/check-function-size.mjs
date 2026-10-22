#!/usr/bin/env node
/**
 * scripts/check-function-size.mjs — game functions and files too big to work on cheaply (2.29).
 *
 *   node scripts/check-function-size.mjs [--json]
 *
 * Limits (env): a function over STUDIO_FN_MAX_LINES (80), or a file over STUDIO_FILE_MAX_LINES (400) or
 * STUDIO_FILE_MAX_KB (30). Jed's sandbox test: adding one feature inside Next Floor's 213-line step()
 * cost twice a one-line change, and some of the game's lines run past 200 characters, so bytes count too.
 * Optional gate: it lists what to split. The done-check is the ratchet: a task can't finish if it made an
 * over-limit function or file bigger, or made a new one (harness/done-check.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexFile, codeFiles } from '../harness/codeindex.mjs';

export const LIMITS = () => ({ fn: Number(process.env.STUDIO_FN_MAX_LINES) || 80, lines: Number(process.env.STUDIO_FILE_MAX_LINES) || 400, kb: Number(process.env.STUDIO_FILE_MAX_KB) || 30 });
export const GAME_ROOTS = ['cartridges', 'game', 'web', 'src', 'engine'];
// The templates ship with the harness; they aren't the game's to split.
const isTemplate = (f) => /^(cartridges\/(_template|example-sim)|engine\/_godot)\//.test(f);

/** What's over the limits in one file's text: [{ kind: 'function'|'file', name, size, limit, unit, start? }]. */
export function overLimits(file, text, limits = LIMITS()) {
  const out = [];
  const lines = text.split('\n').length;
  const kb = Buffer.byteLength(text) / 1024;
  if (lines > limits.lines) out.push({ kind: 'file', name: file, size: lines, limit: limits.lines, unit: 'lines' });
  else if (kb > limits.kb) out.push({ kind: 'file', name: file, size: Math.round(kb), limit: limits.kb, unit: 'KB' });
  const seen = new Set();
  for (const f of indexFile(file, text).functions) if (f.lines > limits.fn && !seen.has(`${f.name}@${f.start}`) && seen.add(`${f.name}@${f.start}`)) out.push({ kind: 'function', name: f.name, size: f.lines, limit: limits.fn, unit: 'lines', start: f.start });
  return out;
}

// Not the game's own code: bundled libraries, static files, and the game's helper scripts.
const SKIP = new Set(['node_modules', '.git', '.studio', '.lanes', 'dist', 'build', 'export', '.godot', '__pycache__', 'public', 'vendor', 'vendors', 'third_party', 'tools', 'captures']);
export const isGameCode = (f) => GAME_ROOTS.includes(f.split('/')[0]) && !isTemplate(f) && !f.split('/').some((p) => SKIP.has(p)) && !/\.min\./.test(f);

export function scan(root, limits = LIMITS()) {
  return codeFiles(root, GAME_ROOTS, SKIP).filter((f) => !isTemplate(f)).flatMap((f) => overLimits(f, fs.readFileSync(path.join(root, f), 'utf8'), limits).map((x) => ({ file: f, ...x })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const found = scan(root);
  if (process.argv.includes('--json')) console.log(JSON.stringify(found, null, 2));
  else if (!found.length) console.log(`[function-size] PASS — no game function over ${LIMITS().fn} lines, no file over ${LIMITS().lines} lines or ${LIMITS().kb} KB`);
  else {
    console.log(`[function-size] ${found.length} to split (a task can't finish if it makes one of these bigger):`);
    for (const x of found) console.log(`  ${x.file}${x.start ? `:${x.start}` : ''} ${x.kind === 'function' ? `${x.name}()` : 'the file'}: ${x.size} ${x.unit} (limit ${x.limit})`);
  }
  process.exit(found.length ? 1 : 0);
}
