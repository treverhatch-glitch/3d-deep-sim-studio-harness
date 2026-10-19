# Rule: Simulation Isolation

**Applies to:** `src/game/sim*`, `src/game/pathfinding*`, `src/game/economy*`

The core simulation must remain pure TypeScript.

- Do **not** import Three.js, React, or any DOM APIs.
- Do **not** depend on frame-rate. Use fixed timestep only.
- State must be fully serializable (no class instances that cannot be JSON.stringified).
- Headless tests must be able to run the sim without a renderer.

Violations break future Tauri / Godot ports and make playtesting harder.
