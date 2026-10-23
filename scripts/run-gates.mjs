#!/usr/bin/env node
/**
 * scripts/run-gates.mjs — run every gate in studio/gates.json and report.
 *   node scripts/run-gates.mjs [--required-only] [--only id,id] [--deep] [--full] [--tier fast|merge] [--no-cache]
 * Exit 1 when a required gate fails. Optional gates are reported as WARN and never fail the run.
 *
 * --tier fast (in-session): runs only the `lite` gates; a gate whose command and input files are unchanged
 *   since its last pass is skipped (cache keyed by content hash). A fast run never counts as a full verify.
 * --tier merge: runs a full, deep verify and never reads from cache (same as --full --deep).
 * --deep (or STUDIO_VERIFY_DEEP=1) runs harness self-checks; npm run release and CI do.
 * --full runs every gate a Full studio would.
 * Everyday verify (no tier) skips the deep gates, as before, and never reads the cache.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { get, set, del, getKey } from '../harness/gate-cache.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'gates.json'), 'utf8'));
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null;
const tier = argv.includes('--tier') ? argv[argv.indexOf('--tier') + 1] : null;
const isMergeTier = tier === 'merge';
const isFastTier = tier === 'fast';
const deep = argv.includes('--deep') || process.env.STUDIO_VERIFY_DEEP === '1' || isMergeTier;
const useCache = !(argv.includes('--no-cache') || process.env.STUDIO_GATE_CACHE === '0');

const all = cfg.gates || [];
const DEEP = all.some((g) => 'deep' in g) ? new Set(all.filter((g) => g.deep).map((g) => g.id)) : new Set(['selftest', 'hub-smoke', 'hud']);
const LITE = all.some((g) => 'lite' in g) ? new Set(all.filter((g) => g.lite).map((g) => g.id)) : new Set(['purity', 'isolation', 'golden', 'regressions', 'playtest', 'secrets']);
const { readMode, scopeOf } = await import('../harness/mode.mjs');
const scope = argv.includes('--full') || deep ? 'full' : scopeOf(readMode());
const skipped = [];
const gates = all.filter((g) => {
  if (only) return only.has(g.id);
  if (argv.includes('--required-only') && g.required === false) return false;
  if (isFastTier && !LITE.has(g.id)) return false;
  if (!deep && DEEP.has(g.id)) return skipped.push(`${g.id} (deep)`), false;
  if (scope === 'lite' && !LITE.has(g.id) && !isFastTier) return skipped.push(g.id), false;
  return true;
});

const { activeCartridge } = await import('../harness/cartridge.mjs');
const active = activeCartridge();
console.log(`[gates] testing the game "${active.name || 'none'}"${active.from ? ` (from ${active.from})` : ''}; goldens and regressions cover every cartridge`);
if (skipped.length) console.log(`[gates] ${scope === 'lite' ? 'Lite scope: ' : ''}skipped ${skipped.join(', ')}${skipped.some((x) => x.endsWith('(deep)')) ? '; --deep runs the harness self-checks' : ''}${scope === 'lite' ? '; --full runs every gate' : ''}`);
const rows = [];
let cachedCount = 0;
for (const gate of gates) {
  const cacheable = gate.cache !== false && (gate.lite || gate.cache === true);
  let key;
  // Only the in-session fast tier reads the cache; everyday verify, --deep and the merge tier always run.
  // 2.30h (#6): a gate with cacheDeep (the HUD check) also reuses its last pass in a --deep run; the merge tier still always runs it.
  if (useCache && cacheable && (isFastTier || (gate.cacheDeep && !isMergeTier))) {
    key = getKey(gate);
    const cached = get(gate, key);
    if (cached) {
      rows.push({ id: gate.id, ok: true, required: gate.required !== false, ms: cached.ms || 0, cached: true, cartridge: active.name });
      console.log(`[gates] PASS ${gate.id} (cached ${key.slice(0, 8)}: command and files unchanged since its last pass)`);
      cachedCount++;
      continue;
    }
  }

  const start = Date.now();
  const res = spawnSync(gate.command, { cwd: root, shell: true, stdio: 'inherit' });
  const ms = Date.now() - start;
  const ok = res.status === 0;
  const required = gate.required !== false;
  rows.push({ id: gate.id, ok, required, ms, cached: false, cartridge: active.name });
  console.log(`[gates] ${ok ? 'PASS' : required ? 'FAIL' : 'WARN'} ${gate.id}`);

  if (cacheable && !isMergeTier) {
    if (ok) set(gate, ms);
    else del(gate);
  }
}

// 2.30c (G3): failing first, in plain words; "not run" apart from "pass".
{
  const { gateWords } = await import('../harness/gate-words.mjs');
  console.log('\n[gates] in plain words');
  for (const l of gateWords({ rows, skipped, partial: Boolean(only) }, all).lines) console.log(`  ${l}`);
}
console.log('\n[gates] summary');
for (const r of rows) console.log(`  ${r.ok ? 'PASS' : r.required ? 'FAIL' : 'WARN'}  ${r.id.padEnd(16)} ${String(r.ms).padStart(6)} ms${r.cached ? ' (cached)' : ''}${r.required ? '' : '  (optional)'}`);
// The War Room's gate board reads this file; it is runtime state (gitignored under .studio/).
try {
  fs.mkdirSync(path.join(root, '.studio'), { recursive: true });
  const rec = JSON.stringify({ at: new Date().toISOString(), partial: Boolean(only) || isFastTier, scope, deep, tier, cachedCount, skipped, cartridge: active.name, rows }, null, 2);
  // Each agent's own runs are kept apart too (2.29): in its own copy it tests its own work, and its
  // done-check reads its own record. The studio-wide record is the main checkout's.
  const owner = process.env.STUDIO_LOCK_OWNER;
  const inCopy = Boolean(process.env.STUDIO_MAIN_ROOT) && path.resolve(process.env.STUDIO_MAIN_ROOT) !== root;
  if (!inCopy) fs.writeFileSync(path.join(root, '.studio', 'gates-last.json'), rec);
  // A full run is kept apart, so one agent's --only run never wipes the full verify another agent's
  // done-check needs (test #2).
  if (!only && !isFastTier && !inCopy) fs.writeFileSync(path.join(root, '.studio', 'gates-last-full.json'), rec);
  if (owner && /^[\w.-]+$/.test(owner)) {
    fs.mkdirSync(path.join(root, '.studio', 'gates'), { recursive: true });
    fs.writeFileSync(path.join(root, '.studio', 'gates', `${owner}.json`), rec);
    if (!only && !isFastTier) fs.writeFileSync(path.join(root, '.studio', 'gates', `${owner}-full.json`), rec);
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
