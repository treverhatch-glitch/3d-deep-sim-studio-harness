# Workflow for 3D Games with Deep Simulation

This harness is optimized for games that combine:

- Deep simulation logic (economy, pathfinding, scheduling, multi-agent systems, persistent state)
- High-quality 3D presentation (Three.js / React Three Fiber, lighting, LOD, materials)

Hatchfield Airport Tycoon is the first example.

## Streamlined Agent Workflow

1. **Producer** reads `CURRENT_TASK.md` and `NEXT.md`.
2. For sim work: read `studio/llms.txt` + `studio/rules/sim-isolation.md` + `studio/rules/graphics-sim-boundary.md`. Prefer QMD / symbol lookup.
3. For graphics work: stay in the presentation layer. Do not pull sim internals.
4. Use free-tier models for bulk implementation; stronger models for architecture or hard bugs.
5. Log events so the HUB shows progress with zero tokens.
6. Playtest via debug API first; screenshots second.
7. Update `CURRENT_TASK.md` before ending.

## Blueprints Used

- VibeGame — compact `llms.txt` for the engine/sim API.
- Claude-Code-Game-Studios — file-based governance and path-scoped rules (trimmed).
- UltraGameStudio — failover routing pattern.
- Recursive Game Creator — programmatic (API-driven) playtesting preferred over pure visual.
- Serena — symbol-level edits for large codebases (see `docs/SERENA.md`).

## What to Avoid

- Mixing Three.js into the sim.
- Porting before the sim is feature-complete and playtested.
- Loading entire large files when QMD or symbol lookup will do.
- Asking the Producer for status (use the HUB).

Copy this template into a fresh repo per game and fill in the game-specific sections of `studio/llms.txt`.
