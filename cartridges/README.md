# Cartridges: one folder per game sim

A cartridge is your game's pure simulation. The harness never imports your renderer; every tool
(playtest, replay, goldens, closed loop, balance, fun, soak, purity) loads a cartridge through
`harness/cartridge.mjs`, so the same commands work for any game.

```bash
npm run new-game my-game          # copies _template, plays it, writes two real golden files
npm run playtest -- --cartridge my-game
node harness/replay.mjs --cartridge my-game --seed 7 --tick 300
```

Pick the cartridge with `--cartridge <name>`, the `STUDIO_CARTRIDGE` env var, or `"cartridge"` in
`studio/gates.json` (the default for every tool). Folders starting with `_` are templates, not games.

## The contract

`cartridges/<name>/index.mjs`

| Export | Required | What it does |
| --- | --- | --- |
| `createInitialState(seed, tuning?)` | yes | Plain JSON state. Keep the seeded RNG state inside it. `tuning` overrides `TUNING`. |
| `step(state, actions)` | yes | Advance one fixed tick and return a new state. `actions` is an array or `null`. |
| `invariants(state)` | no | `[{ id, severity: 'P0'\|'P1'\|'P2', summary }]`. The harness adds a NaN/Infinity check for free. |
| `outcome(state)` | no | `'won'`, `'lost'` or `null`. Defaults to `state.won` / `state.lost`. |
| `TUNING` | no | Every balance number in one frozen table. `scripts/balance-sweep.mjs` sweeps it. |
| `hashState(state)` | no | Defaults to the 64-bit hash in `harness/hash.mjs` (mirrored in `tools/golden.py`). |

`cartridges/<name>/qa.mjs` (optional, but `start-to-win` is required by the vertical-slice gate)

```js
export const scenarios = {
  'start-to-win': { seed: 1, maxTicks: 400, policy: (state, tick) => action | [actions] | null, expect: 'won' },
  idle: { seed: 1, maxTicks: 400, expect: 'lost' }, // proves choices matter (fun check)
};
// export function createAdapter() { ... }  // only for a custom or browser-backed adapter
```

Policies are pure functions of `(state, tick)`; they run inside replays and goldens.

## Rules the gates enforce

- No DOM, Three.js/React/other renderers, `Math.random`, `Date`, `performance`, timers, `eval` or
  `globalThis` inside a cartridge. `scripts/check-sim-purity.mjs` scans the source **and** plays every
  cartridge with those globals trapped, so aliases like `const r = Math.random` are caught too.
- Every game cartridge has golden files in `qa/golden/` and a `start-to-win` scenario that wins.
- Changing sim behaviour changes hashes: run `npm run golden -- --update` and commit the new hashes
  in the same commit as the change.

`example-sim/` is the reference cartridge (a small economy with a real `TUNING` table).
`_template/` is the smallest cartridge that passes every gate.
