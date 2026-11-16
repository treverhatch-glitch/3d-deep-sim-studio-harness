# 2.91.0: no full run ahead of a waiting batch (`docs/RELEASE-2.91.0.md`)

The owner's order of 2026-11-17: build the next version from what a live studio's first day on 2.90 showed. Built on
2.90.0. Only this page and the one for 2.90.0 are kept; older release notes are in git history.

## What the records said

2.90's new steps worked on a real engine: the compile search put two clashing branches out in one minute, and the
test run first named a stale-pin branch in minutes. Then a train of four small green branches took about seven hours.
Its log shows where the time went, and almost none of it was finding or fixing a red:

| Step | Time | Why |
| --- | --- | --- |
| Full rules suite on the target, then on the batch | about 100 min | the full run every `fullEveryHours` came due inside the train |
| Daily full land run on the target alone | about 140 min | overdue (`fullLandMaxHours`), so it went ahead of the batch |
| The land script's own copy of the rules tests | 47 min | the land script's record commit of that full run moved the target, so the batch was no longer on the commit the rules check had passed and was not told the rules were green |

The same day the idle stop halted the studio while 21 finished tasks waited on that train, a person cleared one of
the two stops and nothing said the other was still set, and a porter reading its task's plan was ended as stalled.

## What changed: the engine train

| | What | Proof |
| --- | --- | --- |
| Full land run | With lanes waiting, the batch's rounds always go first. Due: it waits for an empty queue. Overdue: it runs at the end of the train, after the rounds, on the target as it is then. `task.train.<x>.full_land` says when it runs or what it waits for. | `291a`; four older units now assert the new order |
| Full rules run | The full run every `rules.focus.fullEveryHours` is owed, never the batch's check: the train's check runs as if it were not due. The owed run is the full test on the target alone, when the queue is empty or, older than `rules.focus.fullEveryMaxHours` (default twice the hours), at the end of a train. A red or a timeout blames no lane, shows in `train status` and `task.train.<x>.rules_full`, and is not run again until the target changes where the tests read. `--full` and `STUDIO_ENGINE_RULES_FULL=1` still force a full check. | `291a` |
| A rules pass survives a record commit | `rules.ignore`: folders or files the rule tests never read (where a land script commits its run records, docs). A target that moved only there, or only outside `rules.paths`, is still the checked target: the kept result answers and the land run is still told `STUDIO_RULES_GREEN=1`. One log line names the two tips. Without either setting, any move loses it, as before. | `291a` |

The seven-hour train again, on these rules: the rules check is the focused one, the batch's land run starts next and
is told the rules are green, and the two full runs come after it has landed.

## What changed: the studio around the train

| | What | Proof |
| --- | --- | --- |
| Idle stop | "No task finished" now means no task done, no landing and no lane queued for a train (web or engine) in the window. | `291b` |
| Two stops | `task resume` says when the supervisor's stop or halt is still set; `studio:start` and `studio:resume` say when the studio stop is. Words only: no command clears a stop it did not clear before. | `291b` |
| Stall rule | A read of a file the task names (lane, paths, holds, title, scope; `Read`, `Grep`, `Glob` in the session log) counts as progress, for at most `STUDIO_STALL_READ_MAX_MIN` (default twice the stall limit; 0 off) since the last write. Within that bound it also restarts the read-burn window. | `291c` |

## What changed: the harness's own checks

TIMING

## Not built, and why

- **Marking slices queued before an upgrade.** A one-time effect of moving to 2.90; the units were re-filed.
- **The next batch's rules check while a land run runs.** Possible now that results are kept by what the tests read,
  but it adds load beside a running editor. After a week of trains on 2.91.
- **Four more timing checks** (the supervisor's own time window): they need the product's clock, not a hand-shake.

## Limits, said plainly

- Nothing here ran on a real engine from the harness's side; the train rules ran against stand-in land scripts.
- The read rule covers session logs in Claude Code's format. Other tools' logs count no reads and behave as before.
- An owed full rules run that times out, and a cancel during an end-of-train full run, have no check of their own.
- With no full pass on record, a studio's first train ends with one full rules run on the target.

## For a studio taking it

`npm run upgrade -- --merge origin/main`. 2.90 was merged with a merge commit, so a studio that took the 2.90 branch
early gets no conflicts. To keep a rules pass across the land script's record commits, set `rules.ignore` to the
folder those commits write to. Name a long source file by its path in the task (the 2.90 range form does it) so
reads of it count.
