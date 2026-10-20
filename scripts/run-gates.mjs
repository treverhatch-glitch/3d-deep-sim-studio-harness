#!/usr/bin/env node
/**
 * scripts/run-gates.mjs — run every gate in studio/gates.json and report.
 *   node scripts/run-gates.mjs [--required-only] [--only id,id]
 * Exit 1 when a required gate fails. Optional gates are reported as WARN and never fail the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'gates.json'), 'utf8'));
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null;
const gates = (cfg.gates || []).filter((g) => (!only || only.has(g.id)) && !(argv.includes('--required-only') && g.required === false));

const { activeCartridge } = await import('../harness/cartridge.mjs');
const active = activeCartridge();
console.log(`[gates] testing the game "${active.name || 'none'}"${active.from ? ` (from ${active.from})` : ''}; goldens and regressions cover every cartridge`);
const rows = [];
for (const gate of gates) {
  const start = Date.now();
  const res = spawnSync(gate.command, { cwd: root, shell: true, stdio: 'inherit' });
  const ok = res.status === 0;
  const required = gate.required !== false;
  rows.push({ id: gate.id, ok, required, ms: Date.now() - start, cartridge: active.name });
  console.log(`[gates] ${ok ? 'PASS' : required ? 'FAIL' : 'WARN'} ${gate.id}`);
}

console.log('\n[gates] summary');
for (const r of rows) console.log(`  ${r.ok ? 'PASS' : r.required ? 'FAIL' : 'WARN'}  ${r.id.padEnd(16)} ${String(r.ms).padStart(6)} ms${r.required ? '' : '  (optional)'}`);
// The War Room's gate board reads this file; it is runtime state (gitignored under .studio/).
try {
  fs.mkdirSync(path.join(root, '.studio'), { recursive: true });
  fs.writeFileSync(path.join(root, '.studio', 'gates-last.json'), JSON.stringify({ at: new Date().toISOString(), partial: Boolean(only), cartridge: active.name, rows }, null, 2));
} catch {
  // read-only checkout: the board just shows "not run"
}
const failed = rows.filter((r) => !r.ok && r.required);
if (failed.length) {
  console.error(`[gates] ${failed.length} required gate(s) failed: ${failed.map((r) => r.id).join(', ')}`);
  process.exit(1);
}
console.log(`[gates] ${rows.filter((r) => r.ok).length}/${rows.length} passed, all required gates green`);
