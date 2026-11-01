/**
 * qa/selftest-2584b.mjs — 2.58.4: a studio game with its own checks and a real cartridge beside it (a replay
 * cartridge driving the game's sim) keeps the cartridge gates that check every cartridge; a cartridge sets its own
 * tick budget.
 *
 * Found while building a game's replay cartridge: with the studio game owning its checks, `npm run verify` (even
 * --all) skipped purity, golden, regressions, soak and the rest, so the new cartridge had no gate at all. And the tick
 * budget was one global number (1 ms), which a real game's sim at a few ms a tick can't meet.
 */
import fs from 'node:fs';
import path from 'node:path';

export async function selftest2584B({ dir, run, report }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const env = { STUDIO_LOCK_OWNER: 'builder-b1', STUDIO_GAME: 'zz-owner' };
  w('web/zz-owner/index.html', '<!doctype html>\n');
  w('web/zz-owner/studio.gates.json', JSON.stringify({ gates: [{ id: 'unit', command: 'node -e "process.exit(0)"' }] }));

  const before = run(dir, 'node scripts/run-gates.mjs --tier fast --no-cache', env);
  report('2.58.4: a studio game with its own checks and only the template cartridge still skips every cartridge gate',
    /the cartridge gates are skipped/.test(out(before)) && /golden \(cartridge; zz-owner runs its own\)/.test(out(before)) && !/\[gates\] (PASS|FAIL) golden\b/.test(out(before)), out(before).slice(-2500));

  fs.cpSync(path.join(dir, 'cartridges', '_template'), path.join(dir, 'cartridges', 'zzcart'), { recursive: true });
  const after = run(dir, 'node scripts/run-gates.mjs --tier fast --no-cache', env);
  report('2.58.4: with a real cartridge beside it, the cartridge gates that check every cartridge run (purity, isolation, golden, regressions); playtest, which tests the default cartridge, stays skipped',
    /its cartridge \(zzcart\) gets the cartridge gates/.test(out(after)) && /\[gates\] (PASS|FAIL) purity\b/.test(out(after)) && /\[gates\] (PASS|FAIL) golden\b/.test(out(after)) && /\[gates\] (PASS|FAIL) regressions\b/.test(out(after))
      && /playtest \(cartridge; zz-owner runs its own\)/.test(out(after)) && !/\[gates\] (PASS|FAIL) playtest\b/.test(out(after)), out(after).slice(-3000));

  // A slow cartridge: about the same work every tick, far over 1 ms.
  w('cartridges/zzslow/index.mjs', `export function createInitialState() { return { tick: 0, n: 0 }; }
export function step(s) { let n = s.n; for (let i = 0; i < 3e6; i++) n = (n * 31 + i) % 1000003; return { tick: s.tick + 1, n }; }
`);
  const slow = run(dir, 'node scripts/check-tick-budget.mjs');
  w('cartridges/zzslow/cartridge.json', JSON.stringify({ tickBudgetMs: 5000 }));
  const own = run(dir, 'node scripts/check-tick-budget.mjs');
  report('2.58.4: a cartridge\'s own "tickBudgetMs" in cartridge.json is its budget (named in the output); without it the 1 ms default holds and the same cartridge fails',
    slow.status !== 0 && /FAIL zzslow: [\d.]+ ms\/tick > 1 ms\/tick \(budget from default\)/.test(out(slow))
      && /PASS zzslow: [\d.]+ ms\/tick \(budget 5000, from cartridges\/zzslow\/cartridge\.json\)/.test(out(own)) && /PASS example-sim: .*from default/.test(out(own)), `${out(slow)}\n${out(own)}`);
}
