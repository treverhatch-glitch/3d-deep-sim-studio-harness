# Rule: Simulation Isolation (`studio/rules/sim-isolation.md`)

**Applies to:** `src/sim*`, `src/game/sim*`, `src/game/pathfinding*`, `src/game/economy*`, `cartridges/*/sim*`

The core simulation must remain 100% pure TypeScript:

- Do **not** import Three.js, React, or any DOM APIs (`window`, `document`, `localStorage`, `requestAnimationFrame`).
- Do **not** depend on frame-rate (`dt`). Use a fixed-timestep integer tick clock only.
- Do **not** call `Math.random()` or `Date.now()`. Use the seeded RNG stored inside `SimState`.
- State must be fully serializable (plain JSON objects/arrays/primitives; no class instances, `Map`, or `Set` that break `JSON.stringify`).
- Headless tests (`node qa/playtest.mjs`) must be able to run the simulation without a browser or renderer.

Violations break future Tauri v2, Godot 4 (`ts2gd`), and Unity (`SharpTS`) ports and make programmatic playtesting impossible. Enforced by `./scripts/check-sim-isolation.sh` and `node scripts/check-sim-purity.mjs`.
