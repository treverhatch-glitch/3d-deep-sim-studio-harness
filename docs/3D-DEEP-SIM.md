# Generalized 3D Deep-Simulation Architecture & Late-Game Porting Guide (`docs/3D-DEEP-SIM.md`)

This guide defines the engineering standards that let a solo creator or AI studio scale a 3D simulation to **100,000+ lines of TypeScript** on the web first, and then package or port cleanly once gameplay mechanics are 100% feature-complete.

---

## 1. Pure-TypeScript Deterministic Simulation (`src/sim/` & `studio/rules/sim-purity.md`)

Why web + TypeScript first? As demonstrated across the 17-repo benchmark audit, AI agents produce their highest-accuracy code and fastest test cycles on strict TypeScript when simulation logic is isolated from the 3D engine:

1. **Zero DOM / Three.js Imports in `sim/`**:
   - Enforced automatically by `node scripts/check-sim-purity.mjs`.
   - `sim/` never touches `window`, `document`, `localStorage`, or `three`.
2. **Fixed-Timestep Tick Clock**:
   - Never advance simulation state by variable `requestAnimationFrame` delta time (`dt`).
   - Run discrete integer ticks (e.g. `stepMs = 50` for 20 Hz). Frame-rate drops or background tabs cannot corrupt physics, fuel burn, or turnaround schedules.
3. **Seeded PRNG Stored in `SimState`**:
   - Store a 4-uint32 `sfc32` state tuple (`rng: [a, b, c, d]`) directly inside `SimState`.
   - `Math.random()` is banned. Every trajectory is 100% reproducible from `{ seed, actions }`.
4. **100% Plain-JSON State (`JSON.stringify` / `JSON.parse`)**:
   - Entities are plain objects referenced by integer `id` (never class instances, `Map`, `Set`, or object pointers).
   - Saves never lose in-flight tasks or vehicles, and canonical state hashes (`hashCanonicalState` in `qa/sim.adapter.mjs`) verify cross-engine ports bit-for-bit.

---

## 2. Three.js WebGL / WebGPU Graphics Pipeline (`studio/rules/renderer-budget.md`)

- **`THREE.InstancedMesh` for High-Count Entities**:
  Batch any entity type with $>16$ instances into a single `InstancedMesh` updated via a shared `THREE.Object3D` dummy matrix helper each frame.
- **PBR Material Palette**:
  Share a compact palette of `MeshStandardMaterial` instances (roughness/metalness) across low-poly `.glb` meshes rather than allocating unique textures per object.
- **Interpolated Visual Transforms**:
  Render positions at `lerp(prevTickPos, currTickPos, clockAlpha)` so a 20 Hz deterministic simulation renders smoothly at 60–144 Hz.

---

## 3. Headless Blender (`bpy`) AI Asset Automation (`tools/blender/generate_glb.py`)

Instead of manually modeling placeholder or low-poly production props, agents generate Python scripts using Blender's `bpy` API (or `mlolson/blender-orchestrator`) and export `.glb` assets headlessly:

```bash
blender -b --factory-startup -P tools/blender/generate_glb.py -- \
  --preset hangar --out public/assets/hangar.glb
```

---

## 4. Late-Game Porting Bridges (When & How to Port)

> **Golden Timing Rule**: Do **NOT** port mid-development while simulation loops, economy tuning, and choreography rules are still changing. Finish and playtest 100% of simulation mechanics in TypeScript first.

### Path A: Steam / Desktop Release via **Tauri v2** (Fastest — Zero Rewrite)
Keep your battle-tested TypeScript simulation and Three.js renderer intact and wrap them in a tiny Rust binary (~5–10 MB installer vs 150+ MB Electron):
```bash
npm install -D @tauri-apps/cli@latest
npx tauri init
npx tauri build
```
- Use `@tauri-apps/plugin-fs` for native save files and `steamworks-rs` in `src-tauri/` for Steam achievements, Workshop, and cloud saves.

### Path B: Native **Godot 4** Port (`johnfn/ts2gd` + `godot-mcp`)
Because `sim/` contains only pure TypeScript and plain JSON arrays/objects:
1. Use **`johnfn/ts2gd`** to mechanically translate TypeScript simulation modules into GDScript as a starting baseline, then adapt hot pathfinding/heap loops to typed GDScript 2.0 or GDExtension.
2. Wire **`godot-mcp`** (`Coding-Solo/godot-mcp`) so your coding agent can inspect the Godot scene tree, bind `InstancedMesh` equivalents (`MultiMeshInstance3D`), and verify that GDScript state hashes match `qa/sim.adapter.mjs` golden vectors.

### Path C: Native **Unity / .NET** Port (`nickna/SharpTS`)
1. Use **`nickna/SharpTS`** (TypeScript interpreter/transpiler for .NET) to run or translate pure-TS simulation modules into C# structs/classes.
2. Bind `SimState` arrays to Unity `Graphics.DrawMeshInstanced` / Entities, verifying parity against the TypeScript state hash (SHA-256 of the canonical state) after every tick.
