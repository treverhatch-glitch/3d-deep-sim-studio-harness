# Skill: bug

**When.** A task titled `Bug…` or `Fix…`, including the `Fix BUG-…` tasks the closed loop queues.

**Steps.**
1. **Triage.** Read the report and say how bad it is: P0 (crash, lost save, broken determinism),
   P1 (a rule broken, a phase blocked), P2 (wrong but playable). Which phase and persona does it hurt?
2. **Reproduce.** `node harness/replay.mjs --seed <seed> --tick <tick>` or
   `--trace .studio/last-seed-failure.json`. It must fail before you touch code. No seed and tick:
   find one first (`npm run playtest:stage1` across seeds) or hand it back.
3. **Find where it started** when it used to work: `git bisect start <bad> <good>`, then
   `git bisect run node harness/replay.mjs --trace .studio/last-seed-failure.json --quiet`. The first
   bad commit's `Studio-Task` trailer names the task that caused it; file that as `--caused-by`.
4. **Smallest fix.** Use the builder loop (`builder.md`): edit, narrow check, stop after 3 tries.
   Fix the code, never the golden.
5. **Pin it.** Save the replay as `qa/regressions/<bug-id>.json` (`"fixed": true`) and pin its SHA-256:
   `node qa/check-regressions.mjs --update`.
6. **Commit the fix** with `STUDIO_LOCK_OWNER` set, so the hook tags it with this task. The done-check
   replays your regression on the commit before the fix; it must fail there, or it guards nothing
   (`node qa/fails-before.mjs qa/regressions/<bug-id>.json <fix>^` to see it yourself).
7. **Lesson.** Four bullets in `studio/memory/failures.md` (what broke, why, the fix, how to spot it
   next time), plus `- **Role**: <role>` if one role should learn it. `bash scripts/distill-bug.sh`
   starts it.
8. **Verify and hand off.** Run the full `npm run verify`. In the done note, say what the next agent
   should watch for.

**Done means.** A regression with seed, tick and a pinned SHA-256 that fails on the code before the
fix, the fix committed with the task's tag, a lesson whose heading names the task or bug, and a full
verify after your last change.

**Never.** Close a bug with no seed and tick that reproduce it. Delete or re-pin a regression to make
the gate pass. Commit the fix with `--no-verify` (it loses the tag the check needs).
