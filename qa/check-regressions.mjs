#!/usr/bin/env node
/**
 * qa/check-regressions.mjs — every fixed bug keeps a replay in qa/regressions/ that must still match.
 * A regression with no hash fails: an unpinned regression proves nothing.
 * 2.59.0: a "kind": "test" regression (a seeded game unit test; qa/regressions/README.md) runs with the studio's test
 * runner ("regressionTest" in studio/game.json or the game's studio.gates.json) and must pass; nothing to pin.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCartridgeName, loadCartridge, replay } from '../harness/cartridge.mjs';
import { hash64, isSha256 } from '../harness/hash.mjs';
import { checkRecordingId, gameIdFor } from '../harness/game-id.mjs';
import { regressionKind, runRegressionTest } from './fails-before.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'regressions');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
if (!files.length) {
  console.log('[regressions] none yet');
  process.exit(0);
}
const update = process.argv.includes('--update');
const carts = new Map();
let failed = 0;
for (const file of files) {
  const full = path.join(dir, file);
  const spec = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (regressionKind(spec) === 'test') {
    const t = runRegressionTest(spec);
    if (t.ran && t.passed) console.log(`[regressions] PASS ${file} (test "${spec.test?.name}" in ${spec.test?.file}, seed ${spec.seed})`);
    else if (update) console.log(`[regressions] ${file} is a game test: nothing to pin (${t.why})`);
    else {
      console.error(`[regressions] FAIL ${file}: ${t.ran ? `the test fails: ${t.why}` : t.why}`);
      failed += 1;
    }
    continue;
  }
  const name = spec.cartridge || defaultCartridgeName();
  if (!carts.has(name)) carts.set(name, await loadCartridge(name));
  const result = replay(carts.get(name), { seed: spec.seed, tick: spec.tick, actions: spec.actions || [], tuning: spec.tuning });
  const owner = checkRecordingId(spec, name);
  if (update) {
    spec.cartridge = name;
    if (gameIdFor(name)) spec.gameId = gameIdFor(name);
    spec.hash = result.hash;
    spec.sha256 = result.sha256;
    if (result.hash !== hash64(result.state)) spec.hashKind = 'custom';
    else delete spec.hashKind;
    fs.writeFileSync(full, JSON.stringify(spec, null, 2) + '\n');
    console.log(`[regressions] updated ${file} -> sha256 ${result.sha256.slice(0, 16)}…`);
    continue;
  }
  if (!owner.ok) {
    console.error(`[regressions] FAIL ${file}: ${owner.message}`);
    failed += 1;
  } else if (result.findings.length) {
    console.error(`[regressions] FAIL ${file}: tick ${result.failingTick} ${result.findings[0].id} — ${result.findings[0].summary}`);
    failed += 1;
  } else if (!isSha256(spec.sha256)) {
    console.error(`[regressions] FAIL ${file}: no sha256 pinned. Run: node qa/check-regressions.mjs --update`);
    failed += 1;
  } else if (result.sha256 !== spec.sha256) {
    console.error(`[regressions] FAIL ${file}: sha256 expected ${spec.sha256} got ${result.sha256}`);
    failed += 1;
  } else if (spec.hash !== undefined && spec.hash !== result.hash) {
    console.error(`[regressions] FAIL ${file}: display hash expected ${spec.hash} got ${result.hash} (sha256 matches: the cartridge's display hash changed; regenerate)`);
    failed += 1;
  } else {
    console.log(`[regressions] PASS ${file} (${name}, sha256 ${result.sha256.slice(0, 16)}…)`);
  }
}
if (failed) process.exit(1);
