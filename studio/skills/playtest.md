# Skill: playtest (and fun check)

**When.** Running the game to find out what happens: stage 1 trajectories, stage 2 browser checks,
or a fun pass.

**Steps.**
1. Pick the seed and length up front: `node qa/playtest.mjs --stage 1 --seed 1337 --ticks 300`.
2. Read the report in `qa/reports/`. A failure has a seed and a failing tick; that is a bug for
   someone else (`node harness/task.mjs add "<what broke>" --type bug`).
3. For a fun pass: `npm run fun` (writes `studio/fun/latest.md`).

**Done means.** A playtest report in `qa/reports/`, written after the task started, on the current
build: seed, ticks run, final hash, and the failing tick if it failed. For a fun task: a fun report
newer than the last game change.

**Never.** Fix code during a playtest. Report a failure without its seed and tick.
