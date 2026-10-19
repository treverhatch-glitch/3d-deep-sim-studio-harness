---
scope: ["src/sim/**", "cartridges/**/sim/**"]
enforcedBy: scripts/check-sim-purity.mjs
---

# Path-Scoped Rule: Simulation Purity & Determinism (`studio/rules/sim-purity.md`)

All code inside `src/sim/**` (or `cartridges/*/sim/**`) is governed by four strict invariants verified by `node scripts/check-sim-purity.mjs`:

## 1. Zero Browser, DOM, or Renderer Imports
- **Forbidden**: `three`, `@react-three/*`, `window`, `document`, `localStorage`, `sessionStorage`, `requestAnimationFrame`, `AudioContext`, WebGL contexts.
- **Why**: The simulation must run headlessly in Node.js at 10,000+ ticks/sec for Stage-1 QA trajectories (`qa/playtest.mjs`) and transpile cleanly to GDScript (`ts2gd`) or C# (`SharpTS`).

## 2. Fixed-Timestep Integer Tick Clock Only
- **Forbidden**: Multiplying speeds or production rates by variable render frame delta (`dt`).
- **Required**: Advance the world solely in discrete integer ticks (`tick += 1`, e.g., 20 ticks/sec = 50ms per tick). The renderer interpolates visual transforms between ticks using `alpha = accumulator / stepMs`.

## 3. Seeded, Serializable RNG Inside `SimState`
- **Forbidden**: `Math.random()`, `Date.now()`, `performance.now()`, `crypto.randomUUID()`.
- **Required**: Store the PRNG state (`sfc32` 4-tuple `[a, b, c, d]`) directly inside `SimState.rng`. Given the same initial seed and `[tick, action]` log, two runs must produce the exact same 32-bit FNV-1a state hash.

## 4. Plain JSON State Only (Zero Lost Entities on Save/Load)
- **Forbidden**: Class instances (`new MyEntity()`), `Map`, `Set`, `Date`, functions, or object reference pointers inside `SimState`.
- **Required**: Plain JSON objects, arrays, numbers, strings, and booleans (`id` integer references instead of object pointers). `JSON.parse(JSON.stringify(state))` must be a lossless identity operation.
