# Engine Support & Translator Guidance

**Rule: Finish the game in the current stack first.** Do not port while core systems, economy, pathfinding, or the gameplay loop are still changing.

## When to Port

Port only after:

- The simulation is feature-complete
- Playtesting and calibration are done
- The core loop is stable and fun
- Headless tests pass

Porting earlier wastes time because complex event loops and custom pathfinding still need manual restructuring.

## Conditions That Make Porting Easier

These should already be true (see `studio/rules/sim-isolation.md`):

- Core sim is pure TypeScript (no DOM or Three.js imports)
- Fixed-timestep tick, not frame-rate based
- Fully serializable state
- Headless sim tests exist

## Targets

| Target | Tooling | Notes |
|--------|---------|-------|
| Steam desktop | **Tauri v2** | Package the existing web build. Highest graphics ceiling with least rewrite if the sim stays pure. |
| **Unity** | Manual port + optional tools | Solid, mature engine with excellent tooling, asset store, and graphics. Best for high-polish 3D or complex rendering. See Unity section below. |
| Godot 4 | **ts2gd** (johnfn/ts2gd) | TypeScript → GDScript transpiler. Speeds mechanical translation. Complex systems still need manual work. |
| .NET / C# | **SharpTS** (nickna/SharpTS) | TypeScript interpreter for .NET. Useful bridge if targeting Unity or other C# engines. |

## Unity Porting Guidance

Unity is a strong choice when you want maximum graphics fidelity, mature tooling, or easy access to the asset store.

**Best approaches (in order of practicality):**

1. **Keep the sim pure and reimplement the thin layer**  
   Leave the core simulation logic in TypeScript as long as possible. Port only the presentation and engine-specific systems into C#. This is the cleanest path if the sim stayed pure.

2. **Use SharpTS as a bridge**  
   Run portions of the TypeScript sim inside .NET via SharpTS while you gradually rewrite hot paths in C#. Good for validating behavior before a full rewrite.

3. **Manual structured port**  
   Translate systems module-by-module (economy, pathfinding, turnaround, etc.) once the TypeScript version is locked and playtested. Use the serializable state format as the contract between the old and new implementations.

4. **Avoid full automated transpilation**  
   There is no high-quality, production-ready TypeScript-to-C# transpiler that handles complex game logic well. Treat any automated translation as a starting point only.

**Recommended Unity sequence:**
- Lock and playtest the TypeScript sim.
- Package a Tauri build first if you need a desktop version quickly.
- When ready for higher graphics, start a Unity project and port systems one at a time, validating against the original sim's serializable state and playtest traces.

## Transpiler Usage

- Use transpilers **after** the TypeScript simulation is 100% feature-complete and playtested.
- They increase success rate on syntax translation.
- They do not remove the need to restructure pathfinding heaps, event loops, or engine-specific rendering.
- Always keep the original TypeScript as the source of truth until the port is proven.

## Recommended Sequence

1. Lock the TypeScript sim and pass playtests.
2. Package with Tauri v2 for a Steam build (fastest path to desktop).
3. Only if needed, explore Unity, Godot via ts2gd, or other engines.
4. Raise graphics quality in the target engine after the port is stable.

## What This Template Does Not Include

- No automated transpiler pipeline yet
- No Tauri, Unity, or Godot project templates
- These can be added later once a specific game is ready to port

Agents should refuse early porting requests and point back to this document and the sim-isolation rule.
