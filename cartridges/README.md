# Cartridges: one folder per game sim

A cartridge is your game's pure simulation. The harness never imports your renderer; every tool
(playtest, replay, goldens, closed loop, balance, fun, soak, purity) loads a cartridge through
`harness/cartridge.mjs`, so the same commands work for any game.

```bash
npm run new-game my-game          # copies _template, plays it, writes two real golden files
npm run playtest -- --cartridge my-game
node harness/replay.mjs --cartridge my-game --seed 7 --tick 300
```

Pick the cartridge with `--cartridge <name>`, the `STUDIO_CARTRIDGE` env var, or `studio/game.json`
(`npm run new-game <name>` writes it, so your game becomes the default for every tool; it is never
frozen in a test run). `"cartridge"` in `studio/gates.json` is only the template's fallback. Every
gate run prints which game it tested. Folders starting with `_` are templates, not games.

## The contract

`cartridges/<name>/index.mjs`

| Export | Required | What it does |
| --- | --- | --- |
| `createInitialState(seed, tuning?)` | yes | Plain JSON state. Keep the seeded RNG state inside it. `tuning` overrides `TUNING`. |
| `step(state, actions)` | yes | Advance one fixed tick and return a new state. `actions` is an array or `null`. |
| `invariants(state)` | no | `[{ id, severity: 'P0'\|'P1'\|'P2', summary }]`. The harness adds a NaN/Infinity check for free. |
| `outcome(state)` | no | `'won'`, `'lost'` or `null`. Defaults to `state.won` / `state.lost`. |
| `TUNING` | no | Every balance number in one frozen table. `scripts/balance-sweep.mjs` sweeps it. |
| `actions(state, rand)` | no | 2.66.0: one random player action (or an array, or `null`) for `npm run fuzz`, from the seeded `rand` passed in (`rand()`, `rand.int(n)`, `rand.pick(list)`). May live in `qa.mjs` instead (that one wins). |
| `actionTypes` | no | Without `actions()`: `['hire', { type: 'spawn', kind: ['a', 'b'], x: { min: 0, max: 9 } }]`; arrays are choices (`null` leaves the field out), `{ min, max }` an integer range. |
| `hashState(state)` | no | The display hash; defaults to FNV-1a 64 in `harness/hash.mjs`. Goldens and regressions are verified with the harness's own SHA-256 of the state, whatever this returns (`docs/HASH.md`). |

`cartridges/<name>/qa.mjs` (optional, but `start-to-win` is required by the vertical-slice gate)

```js
export const scenarios = {
  'start-to-win': { seed: 1, maxTicks: 400, policy: (state, tick) => action | [actions] | null, expect: 'won' },
  idle: { seed: 1, maxTicks: 400, expect: 'lost' }, // proves choices matter (fun check)
};
// export function createAdapter() { ... }  // only for a custom or browser-backed adapter
```

Policies are pure functions of `(state, tick)`; they run inside replays and goldens.

## Fuzz (`npm run fuzz`, qa/fuzz.mjs, 2.66.0, advisory)

Seeded random play for every game cartridge: `STUDIO_FUZZ_SEEDS` runs (20) of `STUDIO_FUZZ_TICKS` ticks (500), each
tick asking `actions()` (or the `actionTypes` generator) for an action with chance `rate` (0.25). A cartridge with
neither is skipped with a note. Checked: `invariants()` and a throwing `step()` every tick; every `saveEvery` (50)
ticks a save/load round trip (the state through JSON must step to the same SHA-256 as the live one); determinism (the
recorded run played again ends on the same SHA-256; one state stepped twice agrees). A failure is shrunk (ddmin) to the
fewest actions that still fail the same way and written to `.studio/fuzz/findings/<id>.json` in the regression format
(cartridge, seed, tick, actions: copy it into `qa/regressions/` when you fix it); the id hashes the cartridge, the
check and the shrunk actions' types, so reruns update the same file. `npm run fuzz -- --replay <file>` replays one.

Filing is hands-off with a shadow week (`studio/fuzz.json`): `"mode": "suggest"` (default) writes new findings to
`.studio/fuzz/suggestions.md` and a `fuzz.finding` event the daily digest lists; `"mode": "file"`, or any run after
`"autoFileAfter"` (the first run sets it to first run + 7 days; `null` never), files one `Fix fuzz finding <id>` bug
task per new id through the board, never twice. `npm run fuzz -- file <id> --by <you>` files a suggestion now.
`studio/fuzz.ignore.json` (`[{ "id": "F-…", "why": "…" }]`) lists intended behaviour; an entry with no why is not
honoured. A lane that changes it (directly or by a config proposal) is tier C, held until a game dev releases it or
an outside agent records their permission (harness/tiers.mjs "silencer"), so a worker can't silence a finding.

Not a gate yet. To join the soak tier later, the owner adds to `studio/gates.json`
`{ "id": "fuzz", "cartridge": true, "command": "node qa/fuzz.mjs --check --seeds 5 --ticks 300", "required": false }`
(`--check` writes nothing and exits 1 on any finding not ignored), then makes it required once a few weeks of runs
stay clean.

## Rules the gates enforce

- No DOM, Three.js/React/other renderers, `Math.random`, `Date`, `performance`, timers, `eval` or
  `globalThis` inside a cartridge. `scripts/check-sim-purity.mjs` scans the source **and** plays every
  cartridge with those globals trapped, so aliases like `const r = Math.random` are caught too.
- Engine-dependent maths (`Math.sin`, `atan2`, `hypot`, `pow`, `exp`, `log`, `**` and the rest) is reported by the
  same check: a warning by default, a failure when `cartridge.json` says `"detMath": "required"` (new games start
  that way). Use a `detMath` module instead (docs/3D-DEEP-SIM.md, "Deterministic math").
- Every game cartridge has golden files in `qa/golden/` and a `start-to-win` scenario that wins.
- `cartridge.json` can set `"tickBudgetMs"`: the cartridge's own tick budget for `scripts/check-tick-budget.mjs`
  (otherwise `TICK_BUDGET_MS_PER_TICK`, else 1 ms). A cartridge that drives a real game's sim takes a few ms a tick.
- A studio game with its own checks (`game/<name>/studio.gates.json`) can still have real cartridges beside it, for
  example a replay cartridge over the game's sim: those get the gates that check every cartridge (purity, isolation,
  golden, golden-py, regressions, vertical-slice, soak, tick-budget). Never name such a cartridge after the studio
  game: a cartridge with the game's own name switches the game's own checks off.
- Changing sim behaviour changes hashes: run `npm run golden -- --update` and commit the new hashes
  in the same commit as the change.

`example-sim/` is the reference cartridge (a small economy with a real `TUNING` table).
`_template/` is the smallest cartridge that passes every gate.
