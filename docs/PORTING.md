# Engine Support & Translator Guidance (`docs/PORTING.md`)

**Rule: Finish the game in the current TypeScript stack first.** Do not port while core simulation systems, economy tuning, pathfinding, or choreography loops are still changing.

## When to Port

Port only after:
- The simulation is 100% feature-complete in pure TypeScript (`src/sim/`)
- Stage-1 programmatic (`?playtest=1` / `qa/sim.adapter.mjs`) and Stage-2 visual playtesting are green
- `./scripts/check-sim-isolation.sh` and `node scripts/check-sim-purity.mjs` pass with 0 violations

## Targets & Transpiler Bridges

| Target | Tooling | Notes |
|--------|---------|-------|
| **Steam Desktop** | **Tauri v2** (`@tauri-apps/cli`) | Wraps the existing TypeScript + Three.js web build into a ~10 MB native binary with `steamworks-rs`. Fastest path to Steam with zero simulation rewrite. |
| **Godot 4** | **ts2gd** (`johnfn/ts2gd`) + **godot-mcp** (`Coding-Solo/godot-mcp`) | TypeScript → GDScript transpiler for mechanical syntax translation, paired with `godot-mcp` for scene tree orchestration. Verify parity against `qa/sim.adapter.mjs` FNV-1a state hashes. |
| **Unity / .NET** | **SharpTS** (`nickna/SharpTS`) | TypeScript interpreter/bridge for .NET & C#. Lets you validate pure-TS simulation modules inside C# before rewriting hot pathfinding heaps natively. |

See [`docs/3D-DEEP-SIM.md`](./3D-DEEP-SIM.md) for detailed porting sequences.
