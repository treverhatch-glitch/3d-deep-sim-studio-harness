# Studio Task Queue (`studio/NEXT.md`)

> Managed by `node harness/task.mjs`. One line per task so agents and the Zero-Token HUB can parse it without context bloat.

## IN_PROGRESS
- [>] **T-001** [P0] (`producer`) — Verify studio harness (`node harness/status.mjs`, `node harness/route.mjs`, `node qa/playtest.mjs`)

## BACKLOG
- [ ] **T-002** [P1] (`designer-calibrator`) — Define cartridge tuning table and deterministic balance invariants in `studio/llms.txt`
- [ ] **T-003** [P1] (`builder`) — Mount pure-TypeScript 3D simulation cartridge under `cartridges/` and expose `window.__sim` for `?playtest=1`
- [ ] **T-004** [P1] (`qa-playtester`) — Run Stage 1 programmatic trajectories and Stage 2 Playwright visual/layout checks (`node qa/playtest.mjs`)
- [ ] **T-005** [P2] (`reviewer`) — Audit simulation purity (`node scripts/check-sim-purity.mjs`) and sign off on ADR compliance

## DONE
- [x] **T-000** [P0] (`producer`) — Scaffold generalized 3D Deep-Sim AI Studio Harness template
