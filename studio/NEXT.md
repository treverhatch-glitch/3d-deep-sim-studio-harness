# Studio Task Queue (`studio/NEXT.md`)

> Managed by `node harness/task.mjs`. One line per task so agents and the Zero-Token HUB can parse it without context bloat.

## IN_PROGRESS
_No task currently in progress. Run `node harness/task.mjs next`._

## BACKLOG
- [ ] **T-001** [P0] (`producer`) — Run `npm run handoff`, then onboard your game (`npm run onboard`) or keep the example cartridge and rewrite `studio/PLAN.md` for it
- [ ] **T-002** [P1] (`designer-calibrator`) — Balance: sweep spawnCost on example-sim (`npm run balance`) and pick a number with a person
- [ ] **T-003** [P1] (`builder`) — Add one player action to example-sim, regenerate its golden in the same commit, and get `npm run verify` green
- [ ] **T-004** [P1] (`qa-playtester`) — Playtest: first seeded run of example-sim (`npm run playtest:stage1`) and read the report
- [ ] **T-005** [P2] (`reviewer`) — Review: read the last merge and write a note in `studio/reviews/`

## DONE
_1 finished task is in `studio/DONE.md` (newest first). This file keeps only open work._
