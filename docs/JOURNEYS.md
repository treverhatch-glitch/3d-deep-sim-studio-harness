# Player journeys (`qa/journey.mjs`, 2.78.0, PU-55)

Agent-built games often compile and pass their checks and still don't play. The controls gate presses every
declared control once, the goldens replay fixed inputs, but nothing plays a whole game from the start to its
goal through public inputs. A journey does, and it sets two traps for a game that only looks finished.

`node qa/journey.mjs [--cartridge <name>]` plays every journey in `studio/journeys/<cartridge>/<id>.json`
(and `studio/journeys/<game>/` for a studio game that is not a cartridge). No journeys: it passes with
`[journey] WARN no journeys yet`.

## The file

```
{ "id": "start-to-win", "seed": 1337,
  "steps": [ { "tick": 1, "action": "spawn", "args": { "kind": "vehicle", "id": "bought-1" } } ],
  "goal": { "path": "won", "op": "eq", "value": true },
  "saveAt": 100, "maxTicks": 320, "note": "what the player does" }
```

- `steps`: at `tick` (1 to `maxTicks`) the sim gets the action `{ type: action, ...args }`.
- `goal`: `path` is a JSON path in the state (`resources.credits`, `entities[0].x`); `op` is `eq`, `gte`, `lte` or
  `truthy`. It is judged on the state after `maxTicks`.
- `action` must be a public control of the cartridge: a type listed in `actionTypes` (its `qa.mjs` or `index.mjs`),
  one that `qa.mjs` `browser.input()` maps to a real key or click, or one named in an `"action"` field of an entry
  in `studio/bible/controls.json`. Anything else is refused (`non-public-action`).

## The four checks

Each run is its own node process, so nothing a module keeps in memory leaks from one run to the next.

1. **Goal.** Play the steps from the seed to `maxTicks`; the goal must hold (`goal-not-met`).
2. **No-input control.** The same seed and ticks with no actions; the goal must not hold, or the goal is reached
   without playing (`no-input`).
3. **Fresh-process reopen.** Play to `saveAt`, save the state the way the cartridge saves it (optional exports
   `saveState(state) -> text` and `loadState(text) -> state` in `index.mjs`; without them, canonical JSON), then in a
   new node process load it and continue to `maxTicks`. The SHA-256 state digest must equal check 1's (`reopen`).
   A field the save drops, or a module-level variable the sim depends on, shows up here.
4. **Tick budget.** The journey's own steps stay inside the budget `scripts/check-tick-budget.mjs` uses
   (`tickBudgetMs` in `cartridges/<name>/cartridge.json`, else `TICK_BUDGET_MS_PER_TICK`, else 1 ms) (`tick-budget`).

Other failure kinds: `bad-journey` (malformed file), `broke` (the sim threw or broke an invariant), `command`.
Every FAIL line is followed by a `Fix:` line. Never loosen a goal or edit a journey to match a broken game; re-record
its steps only when a sim change was intended.

## Games that are not cartridges

A web game with its own tests gives a journey file with only a command:

```
{ "command": "npm --prefix web/my-game run journey" }
```

The command runs from the repo root (env `STUDIO_JOURNEY_ID` is the file name without `.json`), plays one journey
itself and prints one JSON line as its last JSON output, exit code 0:

```
{ "goalMet": true, "noInputGoalMet": false, "digestA": "<state digest of the played run>", "digestReopen": "<digest after save, a new process, load, continue>" }
```

`qa/journey.mjs` judges those four fields the way it judges a cartridge: `goalMet` must be true, `noInputGoalMet`
must be false, and the two digests must be equal non-empty text. Any other shape or a non-zero exit is `command`.

## Gate

The `journey` gate (`node qa/journey.mjs`) is in `studio/gates.json`; its Fix line is in `harness/gate-fix.mjs`.
Self-test: `qa/selftest-278d.mjs` (mutants of the example cartridge).
