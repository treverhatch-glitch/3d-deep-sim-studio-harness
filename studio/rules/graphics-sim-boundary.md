# Rule: Graphics / Simulation Boundary

**Applies to all 3D deep-simulation games using this harness.**

## Separation

- **Simulation** (`src/game/sim*`, pathfinding, economy, rules): pure TypeScript. No Three.js, no React, no DOM.
- **Presentation** (`src/render*`, `src/three*`, scene, materials, cameras): may use Three.js / React Three Fiber freely.
- Data flows one way: sim produces serializable state → renderer consumes it.

## Why

Deep simulations (pathfinding heaps, multi-agent turnarounds, economy ticks, 50+ entity classes) stay testable and portable. Graphics can be pushed hard (lighting, LOD, post-processing) without contaminating the logic.

## Agent guidance

- When adding a new system, decide first: is this sim or presentation?
- Never let a renderer import reach into sim internals except through the public state snapshot.
- Prefer updating `studio/llms.txt` when the sim’s public surface changes.
