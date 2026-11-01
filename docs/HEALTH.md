# Healthy Game Checklist

A game in this harness is considered healthy when:

- A deterministic seed + tick system exists and is used
- `scripts/check-sim-isolation.mjs` passes
- At least one playtest report exists (using `studio/templates/playtest-report.md`)
- No open P0 bugs
- Core loop is playable from a fresh seed

## First playable (early game done)

Early game is done when all of the following are true:

- [ ] Seed + tick system works and failures can be recorded with `studio/templates/seed-failure.json`
- [ ] Core loop can be completed from a fresh seed
- [ ] Isolation check passes
- [ ] At least one playtest report is filed
- [ ] No open P0 bugs
- [ ] Planning docs (GAME-LAYERS / GAME-LOOPS or vertical-slice template) have been filled for this stage

Agents should not call early game complete until this list is satisfied.

See also `studio/templates/vertical-slice.md` and `studio/templates/polish-checklist.md`.

## Session health: drift Checks (2.64.0)

Besides the stall check (no progress, read burn, wall clock: the session is ended), every running session gets
three drift checks that only raise a Check to the Producer, once per session each: the same gate failing the same
way 3 times, verify runs with no new diff in between, and edits outside the task's lane and claims. Nothing is
stopped. `npm run watchdog -- drift` lists them; `docs/AUTONOMY.md` has the details, and `npm run autonomy` shows
how much the studio needed a person this week.
