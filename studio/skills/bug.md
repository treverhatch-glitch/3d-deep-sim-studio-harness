# Skill: bug

**When.** A task titled `Bug…` or `Fix…`, including the `Fix BUG-…` tasks the closed loop queues.

**Steps.**
1. Reproduce it: `node harness/replay.mjs --seed <seed> --tick <tick>` or
   `--trace .studio/last-seed-failure.json`. It must fail before you touch code.
2. Fix with the builder loop (`builder.md`): edit, narrow check, stop after 3 tries.
3. Save the replay as `qa/regressions/<bug-id>.json` (`"fixed": true`) and pin it:
   `node qa/check-regressions.mjs --update`.
4. Write the lesson as four bullets in `studio/memory/failures.md` (what broke, why, the fix, how
   to spot it next time). `bash scripts/distill-bug.sh` starts it for you.
5. Run the full `npm run verify`.

**Done means.** A regression with a pinned hash, a lesson in `failures.md`, and a green verify, all
after the task started.

**Never.** Close a bug with no seed and tick that reproduce it. Delete a regression to make the
gate pass.
