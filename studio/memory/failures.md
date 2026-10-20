# Distilled Failure & Fix Memory (`studio/memory/failures.md`)

> **Rule (Hermes Agent Pattern)**: Keep raw logs in `.studio/events.jsonl` and `qa/reports/` (append-only). After ANY bug is fixed and verified, append a concise 4-bullet distilled note below. Future tasks and `node harness/prepare-brief.mjs` read **only** these distilled notes—never raw log dumps.

---

## Template for New Entries

```markdown
### [YYYY-MM-DD] <Task/Bug ID> — <Short Title>
- **What broke**: <1 sentence describing the symptom / failing invariant>
- **Root cause**: <1 sentence identifying the exact cause>
- **The fix that worked**: <1 sentence describing the minimal code/config change>
- **How to avoid it next time**: <1 actionable rule for future agents>
```

---

## Recorded Distilled Notes

### [2026-10-19] BUG-SEED-001 — Non-Deterministic Replay Drift at Tick 120
- **What broke**: Re-running `{ "seed": 42069, "tick": 120 }` produced two different FNV-1a state hashes across runs.
- **Root cause**: A helper called `Math.random()` and `Date.now()` instead of advancing `state.rngState` inside the fixed-step `step(state, action)` function.
- **The fix that worked**: Replaced `Math.random()` with the seeded Mulberry32 PRNG stored in `state.rngState` and enforced `node scripts/check-sim-isolation.mjs` prior to commit.
- **How to avoid it next time**: Implement the deterministic seed + tick system as the very first system in any new game cartridge, and never use `Math.random()` or wall-clock time in `src/sim/` or `cartridges/`.

### [2026-10-19] BUG-BLENDER-002 — Blind 3D Asset Scale & Origin Mismatch in Three.js
- **What broke**: Exported `.glb` vehicle prop floated `0.5m` above the ground plane and exceeded the instanced draw-call budget.
- **Root cause**: The agent generated the mesh without applying scale transforms (`export_apply=True`) or inspecting scene bounds.
- **The fix that worked**: Used `tools/blender/generate_glb.py` with `export_apply=True, export_yup=True` and connected `mlolson/blender-orchestrator` (`docs/BLENDER-ORCHESTRATOR.md`) so the agent can both see viewport bounds and act in Blender before exporting.
- **How to avoid it next time**: Always run headless `bpy` exports with `export_apply=True` or verify object transforms via `blender-orchestrator` MCP before mounting `.glb` files in Three.js.
