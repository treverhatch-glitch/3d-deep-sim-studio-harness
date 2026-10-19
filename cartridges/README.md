# Game Simulation Cartridges (`cartridges/`)

This folder holds plug-in simulation modules ("cartridges") so the studio harness stays 100% game-agnostic while giving you a working reference simulation out of the box.

## Mandatory Rule: Implement the Deterministic Seed System First

Every new game cartridge **MUST** implement a deterministic seed + fixed-tick system (`{ seed, tick, rngState }`) as **one of the very first systems coded**:
- Enables exact bug replay (`node harness/replay.mjs --seed 42069 --tick 120`).
- Allows agents to scroll back to the exact failing tick without guessing or clicking around blindly.
- Exposes `window.__hatch` and `window.__sim` when the game runs with `?playtest=1`.

## Included Starter Cartridge
- [`cartridges/example-sim/index.mjs`](example-sim/index.mjs) — Pure JavaScript/TypeScript deterministic simulation cartridge with Mulberry32 seeded PRNG, fixed-tick `step(state, action)`, `replayToTick({ seed, tick, actions })`, FNV-1a state hashing, and `mountPlaytestApi(window)` for `?playtest=1`.
