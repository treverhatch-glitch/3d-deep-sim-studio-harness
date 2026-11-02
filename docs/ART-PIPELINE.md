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

## One asset flow (2.67.1)
`npm run asset -- need "<what>" --for unity|web --budget <tris> [--size <m>] [--style <ref image or words>] [--tags a,b]`
asks for an asset once; the harness looks in order and stops at the first answer. Each step logs what it found and why
it moved on in the need record (`.studio/assets/needs/<id>.json`); `npm run asset -- needs` lists open needs and
`npm run asset -- needs <id>` shows one need's trail and brief. Code: `harness/asset-need.mjs`.

1. **Library first**: the studio's own ledger (`studio/assets/manifest.json`), then every source in `studio/assets.json`
   `"libraries"`: `{ "id", "type": "manifest", "path": "<other studio>/studio/assets/manifest.json" }` or
   `{ "id", "type": "folder", "dir": "<shared folder>" }`. A folder is searched through its cached index, made by
   `npm run asset -- library refresh <dir>`: sha256 per file, metadata from a `manifest.json`/`index.json`/
   `catalog*.jsonl` there, append-only (a file that went away is kept, marked missing). On Drive for desktop, keep the
   folder available offline: hashing a streamed file downloads it. Matching: words and `--tags`, kind, triangles
   (budget), size with `--exact-size`, the licence policy, and duplicates by content hash. The bar is `"bar"` (0-10,
   default 6). An optional `"scorer"` command (`{file}`, `{style}`, `{what}`; prints a number) adds a style score that
   only ranks hits, never decides.
2. **Reuse first**: the same need again (same words, target and budget) answers `already in library: <id>`.
3. **Internet**: `scout find` (Poly Haven, ambientCG; their multi-file downloads are pulled by hand), offer lists in
   `"scout": { "lists": ["<file>.json"] }` (`{ offers: [{ title, tags, licence, author, file | url, page, tris }] }`),
   and Sketchfab only when `STUDIO_SKETCHFAB_KEY` (or the name in `"scout": { "sketchfabKeyEnv" }`) is set; the key is
   never printed. `"scout": { "web": false }` keeps it offline. Only CC0 and CC-BY are pulled (the scout's rule). An
   offer whose bytes are already in a library is "already in library", not pulled again.
4. **Pull + profile**: the existing pull (ledger + CREDITS.md), then the target profile into `assets/adapted/<target>/<name>/`:
   scale to `--size` (largest side, metres) and pivot at the bottom centre, written as a root node in the glTF JSON;
   for Unity also a box collider and a prefab stub (`<name>.prefab.json`: model, LODs, collider, licence row). Every
   output gets a ledger row derived from the pulled asset. Steps that need Blender or Unity are commands in
   `studio/assets.json` `"commands"` (or `studio/game.json` `"assets"`), run under machine:heavy and skipped with a note
   when the program isn't installed: `convert` (`{in}` FBX/OBJ/.blend, `{out}` .glb), `lod` (`{in}`, `{out}`, `{ratio}`,
   `{level}`; LOD1 and LOD2 at `"lodRatios"`, default 0.5 and 0.25), `maskmap` (HDRP mask map: `{in}` the glTF, `{dir}`
   its folder, `{out}` `<name>_MaskMap.png` with R metallic, G AO, B detail mask, A smoothness).
5. **Else make**: one task for `"makeRole"` (default `asset-3d`) with the brief (what, size, budget, style, licence),
   once per need; `"briefTemplate"` (a file with `{what}`, `{for}`, `{budget}`, `{size}`, `{style}`, `{tags}`,
   `{licence}`, `{need}`) replaces the built-in brief. An agent's add goes on the proposed list as usual.

Library licence policy: commercial-use licences (own work, CC0, MIT, …) ship; CC-BY ships with a credit (needs an
author); NC and ND are skipped; share-alike waits for a game dev; AI-made is flagged; unknown is skipped.
`"licences": { "allow": [], "block": [], "ask": [] }` (regexes) adds rules.
