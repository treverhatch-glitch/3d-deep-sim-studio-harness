#!/usr/bin/env node
/**
 * scripts/run-gates.mjs — run every gate in studio/gates.json and report.
 *   node scripts/run-gates.mjs [--required-only] [--only id,id] [--deep] [--full]
 * Exit 1 when a required gate fails. Optional gates are reported as WARN and never fail the run.
 *
 * Everyday verify skips the gates that test the harness itself (marked "deep": selftest, hub-smoke,
 * hud by default). They don't change when only the game changes, and the self-test alone took over
 * 10 minutes on a live studio. --deep (or STUDIO_VERIFY_DEEP=1) runs them; npm run release and CI do.
 * In Lite scope (npm run mode -- scope lite) everyday verify runs only the gates marked "lite";
 * --full runs everything a Full studio would.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'gates.json'), 'utf8'));
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null;
const deep = argv.includes('--deep') || process.env.STUDIO_VERIFY_DEEP === '1';
// Older studios' gates.json has no "deep" or "lite" marks (it is kept on update): fall back to these.
const all = cfg.gates || [];
const DEEP = all.some((g) => 'deep' in g) ? new Set(all.filter((g) => g.deep).map((g) => g.id)) : new Set(['selftest', 'hub-smoke', 'hud']);
const LITE = all.some((g) => 'lite' in g) ? new Set(all.filter((g) => g.lite).map((g) => g.id)) : new Set(['purity', 'isolation', 'golden', 'regressions', 'playtest', 'secrets']);
const { readMode, scopeOf } = await import('../harness/mode.mjs');
const scope = argv.includes('--full') || deep ? 'full' : scopeOf(readMode());
const skipped = [];
const gates = all.filter((g) => {
  if (only) return only.has(g.id);
  if (argv.includes('--required-only') && g.required === false) return false;
  if (!deep && DEEP.has(g.id)) return skipped.push(`${g.id} (deep)`), false;
  if (scope === 'lite' && !LITE.has(g.id)) return skipped.push(g.id), false;
  return true;
});

const { activeCartridge } = await import('../harness/cartridge.mjs');
const active = activeCartridge();
console.log(`[gates] testing the game "${active.name || 'none'}"${active.from ? ` (from ${active.from})` : ''}; goldens and regressions cover every cartridge`);
if (skipped.length) console.log(`[gates] ${scope === 'lite' ? 'Lite scope: ' : ''}skipped ${skipped.join(', ')}${skipped.some((x) => x.endsWith('(deep)')) ? '; --deep runs the harness self-checks' : ''}${scope === 'lite' ? '; --full runs every gate' : ''}`);
const rows = [];
for (const gate of gates) {
  const start = Date.now();
  const res = spawnSync(gate.command, { cwd: root, shell: true, stdio: 'inherit' });
  const ok = res.status === 0;
  const required = gate.required !== false;
  rows.push({ id: gate.id, ok, required, ms: Date.now() - start, cartridge: active.name });
  console.log(`[gates] ${ok ? 'PASS' : required ? 'FAIL' : 'WARN'} ${gate.id}`);
}

// 2.30c (G3): failing first, in plain words; "not run" apart from "pass".
{
  const { gateWords } = await import('../harness/gate-words.mjs');
  console.log('\n[gates] in plain words');
  for (const l of gateWords({ rows, skipped, partial: Boolean(only) }, all).lines) console.log(`  ${l}`);
}
console.log('\n[gates] summary');
for (const r of rows) console.log(`  ${r.ok ? 'PASS' : r.required ? 'FAIL' : 'WARN'}  ${r.id.padEnd(16)} ${String(r.ms).padStart(6)} ms${r.required ? '' : '  (optional)'}`);
// The War Room's gate board reads this file; it is runtime state (gitignored under .studio/).
try {
  fs.mkdirSync(path.join(root, '.studio'), { recursive: true });
  const rec = JSON.stringify({ at: new Date().toISOString(), partial: Boolean(only), scope, deep, skipped, cartridge: active.name, rows }, null, 2);
  // Each agent's own runs are kept apart too (2.29): in its own copy it tests its own work, and its
  // done-check reads its own record. The studio-wide record is the main checkout's.
  const owner = process.env.STUDIO_LOCK_OWNER;
  const inCopy = Boolean(process.env.STUDIO_MAIN_ROOT) && path.resolve(process.env.STUDIO_MAIN_ROOT) !== root;
  if (!inCopy) fs.writeFileSync(path.join(root, '.studio', 'gates-last.json'), rec);
  // A full run is kept apart, so one agent's --only run never wipes the full verify another agent's
  // done-check needs (test #2).
  if (!only && !inCopy) fs.writeFileSync(path.join(root, '.studio', 'gates-last-full.json'), rec);
  if (owner && /^[\w.-]+$/.test(owner)) {
    fs.mkdirSync(path.join(root, '.studio', 'gates'), { recursive: true });
    fs.writeFileSync(path.join(root, '.studio', 'gates', `${owner}.json`), rec);
    if (!only) fs.writeFileSync(path.join(root, '.studio', 'gates', `${owner}-full.json`), rec);
  }
} catch {
  // read-only checkout: the board just shows "not run"
}
const failed = rows.filter((r) => !r.ok && r.required);
if (failed.length) {
  console.error(`[gates] ${failed.length} required gate(s) failed: ${failed.map((r) => r.id).join(', ')}`);
  process.exit(1);
}
console.log(`[gates] ${rows.filter((r) => r.ok).length}/${rows.length} passed, all required gates green`);
