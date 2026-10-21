# Rule: lanes, so several agents can build at once

Parallel work is capped by file layout. One 900-line renderer file means one renderer agent.

- Split the renderer early, as a structural task in Phase 1: camera and input, HUD, one module per
  floor or world, lighting and post-processing, enemies and guests. Keep each module under ~300 lines
  (`node scripts/check-module-size.mjs` lists the ones over).
- Give each task a lane, the narrowest folder it edits: `npm run task -- add "…" --lane game/<game>/src/floors`.
- `npm run studio:start -- --lanes auto` starts one agent per lane, each holding its folder, so no two
  agents edit the same files. Work outside a lane goes back to the Producer as a task.
- The sim (cartridges/<game>/) is its own lane; renderer lanes never edit it.
