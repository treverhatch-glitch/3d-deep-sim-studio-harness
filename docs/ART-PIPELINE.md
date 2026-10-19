# Art Pipeline

Lightweight guide. Full art production lives in the game repo, not the harness.

## Flow
1. Reference Scout finds images/videos/open assets and adds them to `studio/references/APPROVALS.md` as `needs-approval`.
2. Human or Producer marks items `approved` or `rejected`.
3. Approved references can be turned into assets via:
   - `tools/blender/generate_glb.py` (procedural primitives)
   - blender-orchestrator MCP for agents that need to see and act in Blender
   - Manual or external tools, then drop the result in the game’s asset folder

## Where assets go
- Harness stays clean. Put final `.glb`, textures, and source `.blend` files in the **game repository** (or a private fork), not in this template.
- Keep a short note in the game repo pointing back to the approved reference.

## Rules
- Do not pull unapproved external assets into the game.
- Simulation code must not import rendering or asset libraries (see sim isolation rules).
