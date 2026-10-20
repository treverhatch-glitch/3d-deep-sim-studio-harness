# The art department

The art division is on from day one. When intake writes the Game Bible, pre-production queues
**"Art: style sheet and five placeholder assets"** for the `art` role (role card `studio/roles/art.md`,
steps in `studio/skills/art.md`). Art work is allowed before the Bible is signed.

## What the art department does

1. Reads the Bible (pitch, art answer, pillars, voice, never) and the reference studies.
2. Writes a one-page style sheet, `studio/art/STYLE.md` (palette, shapes, lighting, camera, UI tone,
   what it takes from references and what it avoids), with a concept image if it helps.
3. Makes placeholder assets with tools that can be rerun (`tools/blender/generate_glb.py`) or free
   CC0 sources, saved under `assets/placeholder/`.
4. Proposes each one: `npm run art -- propose <file> --kind style|asset|concept --title "…" --task <ID> --by <agent>`.

The task is done when the designs are proposed. Approving them is the game dev's call.

## What the game dev does

The War Room's **Game plan** view shows the designs (images shown), and they appear under
**Needs you** on every view. Per design:

- **Approve.** A style sheet becomes the game's art reference, written into the Game Bible. An asset
  under `assets/` is recorded in the asset ledger with who approved it and the licence and source the
  art department gave, so the assets gate passes.
- **Ask for changes**, in your words. The art department gets a task with them, and its agent starts
  if a tool is set (`STUDIO_ART_TOOL` or `STUDIO_AGENT_TOOL`).

Or from a terminal: `npm run art -- approve D-001 --by <name>`, `npm run art -- changes D-002 "rounder" --by <name>`.
Agents can't approve designs, and files in `references/` can never be proposed for the game.

Asset tools stay outside the repo (`docs/EXTERNAL-TOOLS.md`, `docs/BLENDER-ORCHESTRATOR.md`).
