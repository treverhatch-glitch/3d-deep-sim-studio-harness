# Rule: Graphics / Simulation Boundary (`studio/rules/graphics-sim-boundary.md`)

**Applies to all 3D deep-simulation games using this harness.**

## 1. Strict Separation

- **Simulation** (`src/sim*`, `src/game/sim*`, pathfinding, economy, turnaround choreography, rules): pure TypeScript. **No Three.js, no React, no DOM.**
- **Presentation** (`src/render*`, `src/three*`, scene, materials, `InstancedMesh`, cameras, Blender `.glb` loaders): may use Three.js / React Three Fiber freely.
- **One-Way Data Flow**: Simulation produces a plain JSON serializable state snapshot → Renderer consumes it (plus interpolation `alpha`) and dispatches serializable `Action` payloads back to the sim.

## 2. Why This Boundary Is Non-Negotiable

Deep simulations (pathfinding heaps, multi-agent turnarounds, economy ticks, 50+ entity classes) stay headless-testable in milliseconds and portable to Tauri v2, Godot 4 (`ts2gd`), or Unity (`SharpTS`). Graphics can be pushed hard (PBR lighting, `InstancedMesh`, LOD, post-processing, headless Blender `.glb` assets) without contaminating deterministic logic.

## 3. Agent Guidance

- When adding a new system, decide first: **is this simulation or presentation?**
- Never let a renderer import reach into simulation internals except through the public state snapshot and `dispatch(action)`.
- Always update `studio/llms.txt` when the simulation's public API or tuning table changes.
- Verify compliance with `node scripts/check-sim-isolation.mjs` and `node scripts/check-sim-purity.mjs`.
