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

## Asset scout (2.30b)
`npm run scout -- find "crate"` lists CC0 hits from Poly Haven and ambientCG and filtered links for Kenney, OpenGameArt and Sketchfab. `npm run scout -- pull <url|file> --licence CC0|CC-BY-4.0 --author "<who>" --source <page> --title "<name>"` records it in assets/scouted/ and CREDITS.md. Only CC0 and CC-BY ship; SA, NC, ND or unknown licences go to the reference library (`npm run asset -- add <file> --use reference`). `npm run scout -- credits` rewrites CREDITS.md; the assets gate fails when it is stale.
