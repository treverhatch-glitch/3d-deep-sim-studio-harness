# 2.78.2: trains that land faster (`docs/RELEASE-2.78.2.md`)

The crew's train-speed request from the first run on 2.78.1 (items 1–18, 2026-11-05) and the owner's decision on who
may approve what. In that run, 4 game tasks landed in about 9 h, 6 trains died with their builder, and 3 trains ran
1.5–3.3 h on reds caused by load. Untested on the crew's Windows PC unless it says otherwise.

## Critical

| Item | Status | What changed |
|---|---|---|
| **1** trains die with the builder's command (W-0090) | FIXED | **`task done` queues by default** (`STUDIO_DONE_QUEUE`, `0` = the old inline train): it runs the quick checks, queues the lane and exits "queued"; the task stays in progress until the train lands it. The supervisor's daemon runs the train, or `task done` starts one in the background when there is no supervisor. **Every train started for someone else is detached from its starter** (`STUDIO_TRAIN_DETACH`, `auto` = agent shells), so killing a builder's shell or session can't reach it. The launcher no longer re-verifies a queued task at session end. Untested on Windows: if a Windows job object kills the whole tree, a train may still die (watch item 1 in WATCH). qa/selftest-2782a.mjs. |
| **2** one red costs 1–2 h | FIXED | **Failing files run together:** one low-load run of a check's failing files, then one quiet run of those still failing, labelled per file (`STUDIO_FLAKE_TOGETHER`, on by default; it falls back to per-file runs when the output can't be split by file). **The red chain is capped** at `STUDIO_TRAIN_RED_BUDGET_MIN` (30): past it, the newest lane is handed back with the red's summary, a prefix lands only if a full verify of its exact tree already passed, the rest keep their place (`task.train.red_budget`). **`npm run task -- train cancel [<id>] --by <you> [--why]`**: stops the running train, nothing lands, nobody is handed back, lanes keep their place, the lock is freed (`train auto off` stops new ones). qa/selftest-2782a.mjs, qa/selftest-2782b.mjs. |
| **3** commits to main restart a verified train | FIXED | `studio/producer/**` and `studio/reviews/**` are board paths; a `studio/quarantine.json` change is a board move only when it skips more tests. The docs check no longer reads agent logs and notes (`studio/producer/`, `reviews/`, `handoffs/`, `notes/`). qa/selftest-2782c.mjs. |
| **4** wall-clock and browser tests on a busy PC | FIXED | A **`game:perf`** step: tests listed in `studio/game.json` `"perfTests"` (or `STUDIO_PERF_TESTS`) leave the normal verify and run alone on a quiet machine; never quiet within `STUDIO_PERF_WAIT_MIN` (10): WARN "not run (busy)", never red; a lane verify whose perf didn't run is re-run for perf at the train. A Unity porter session counts as "not quiet". The parallel bisect leaves one heavy slot for builders. qa/selftest-2782b.mjs, qa/selftest-2782f.mjs. |

## High

| Item | Status | What changed |
|---|---|---|
| **5** the review check rejects approvals | FIXED | The last `Verdict:` line in a review file decides (`STUDIO_REVIEW_VERDICT_LINE=off` = the old rule); documented in the reviewer role and skill. |
| **6** no cross-family reviewer when Gemini is out | FIXED / PARTLY | Quota stops are kept per `tool:model` for agy (`STUDIO_QUOTA_MODEL_TOOLS`), so a 429 on Argon leaves Flash. `npm run review -- record <ID> --by <name> --family <f> --file <review.md>` records an outside review (grokbot's); the family must differ from the implementer's, workers are refused. No DeepSeek pool: the harness has no DeepSeek provider yet (docs/REVIEWER.md says how to add one). qa/selftest-2782d.mjs. |
| **7, 17** approvals and engine records | FIXED | Every approve kind signs against the base the lane gate and train judge (one function, `judgeBase`), also when origin/main has GitHub PR merges main lacks (A-030). Approvals made in a lane copy log to the main checkout's events, so the Line releases its hold. The main checkout's own enforcement stays as in 2.78.1 unless the owner sets `STUDIO_MAIN_CHECKOUT_ENFORCE=on`. qa/selftest-2782e.mjs. |
| **8** builders retried owner-only steps (~1M tokens) | FIXED | A hand-back or session end that names an owner-only step (the harness's own refusal text for protected files, weakened tests, signatures) parks the task for the owner (rank: orchestrator), pages the orchestrator, and no builder relaunches on it until it is unparked (`STUDIO_OWNER_ONLY_PARK=off`). qa/selftest-2782d.mjs. |
| **9** lane overlap is file-level | FIXED, off by default | **Region lanes:** for a file you opt in (`STUDIO_REGION_FILES` or the manifest's `"regionFiles"`), a lane may name `path#symbol` or `path#L120-L340`, and lanes on non-overlapping regions run side by side and aren't stacked; the train still hands back the later lane on a real conflict. docs/LINE-PRODUCER.md "Region lanes". |

## Medium

| Item | Status | What changed |
|---|---|---|
| **10** the crew breaker never resumes | FIXED | It resumes after `STUDIO_CREW_BREAKER_RESUME_MIN` (30) if its cause cleared, or once per cause; a second trip on the same cause stays paused. |
| **11** a relaunch loses the last builder's commits; `carry` stops on empty picks | FIXED | A new lane copy starts from the task's previous lane branch when it has commits main lacks; `lanes carry` skips commits already on main and lists them. |
| **12** a direction or review task runs the game's suite | FIXED | A direction, review, docs, idea, research or study task whose changed files are all notes, docs or studio records skips the game's checks in `task done` (`STUDIO_DONE_SKIP_GAME_NONCODE=off`). qa/selftest-2782c.mjs. |

## Addendum

| Item | Status | What changed |
|---|---|---|
| **13** quarantine silently a no-op | FIXED | The game check says "skipped" only once the runner's list mode shows the file drops out; otherwise `WARN game:quarantine: quarantine NOT honoured …` and the files count as run. `npm run upgrade -- --preflight` and the new `npm run onboard -- --check` FAIL a test config that doesn't honour it, with the line to add. qa/selftest-2782f.mjs. |
| **14** no `focus` command | FIXED | A test check whose npm script runs vitest or jest gets an inferred focus (`npx vitest run {files}` / `npx jest {files}`; `STUDIO_FOCUS_INFER=off`), so re-checks run only the failing files. Preflight and onboarding FAIL a test check with neither. |
| **15** ms-budget tests in normal suites | FIXED (advisory) | `WARN game:test-timing: <file>:<line> … move it to the perf tests` for a test that asserts an upper bound on elapsed wall-clock time outside the perf list (`STUDIO_TEST_TIMING=off`). |
| **16** main moves cost landings | FIXED | Notes and handoffs were already board files; part of the cause was the Producer log (item 3). Now when main moves after a green verify and every new commit touches only files no check reads, the train merges them onto the verified tree and lands it without re-verifying (`task.train.landed_over_noncode`; any doubt re-verifies; `STUDIO_TRAIN_LAND_OVER_NONCODE=off`). qa/selftest-2782g.mjs. |
| **18** engine records for older tasks | FIXED | `"unity"` reads as `engine:unity` everywhere; `npm run task -- track <ID> engine:<name> --by <you>` (person, orchestrator, Producer) refuses unknown engines; `task done --train` says why it can't queue an engine pass; `upgrade --merge` backfills open engine-porter tasks with the studio's only engine, or lists them. qa/selftest-2782e.mjs, qa/selftest-2782g.mjs. |

## Who may approve what (the owner's decision, 2026-11-05)

| Who | Board decisions (lanes, parks, task types, visual, ordinary config) | Protected decisions (protected files, weakened tests, hooks approvals, `task done --force`, protected config) |
|---|---|---|
| The owner, the outside orchestrator and proxies (Patch, grokbot) | yes | yes |
| Producer and Director sessions | yes | no, unless the owner sets `STUDIO_PRODUCER_APPROVES=protected` (main checkout `.env`) |
| Builders, reviewers and other workers | no | no |

And the gap the 2.79 audit found is closed: a beta approval counts only when committed exactly as written, in the main
checkout, under the current beta session, with no worker as committer or recorder. A dropped or uncommitted approval
file, or one a builder committed, no longer passes the protected check, weakened tests, hooks or `task done --force`.
The orchestrator's committed approvals keep counting; `approve` now says "commit studio/approvals/… now". A Producer's
protected approval committed before 2.78.2 counts until beta mode's session changes. qa/selftest-2782h.mjs.

## Untested

- Everything on Windows. Most important: the train detach (item 1), the stall/cancel kill, the region-lane path checks,
  and the test runner's list mode through `npx` (item 13).
- Real vitest/jest list-mode output (tested with a fake runner).
- agy's real 429 text for per-model quota keys.

## Upgrade note for Patch

A person runs step 2 (the classifier blocks Patch).

1. Remove the local W-0090 patch first: `git checkout -- harness/task.mjs` (2.78.2 carries it, as the default).
2. `npm run upgrade -- --merge origin/main --by hatch --permission "Hatch: take 2.78.2"`, then
   `node harness/hook-stamp.mjs check`. The upgrade backfills engine tracks on open engine-porter tasks and prints them.
3. `npm ci`, `npm run upgrade -- --smoke`, restart the supervisor once (`npm run studio:stop`, `npm run studio:start`).
4. `npm run upgrade -- --preflight` and `npm run onboard -- --check`: fix any `game-tests/quarantine`,
   `game-tests/focus` FAIL they list.
5. `.env`: remove `STUDIO_DONE_QUEUE=1` (now the default). Keep `STUDIO_HEAVY_SLOTS=3` while memory is tight. Try
   `STUDIO_TRAIN_PIPELINE=off` removed after a day if trains are steady.
6. Owner (protected `studio/game.json`): add `"perfTests"` listing the ms-budget test files you quarantined for perf
   (and any `game:test-timing` WARN names) once T-261 lands; then their quarantine entries can go.
7. Beta approvals must now be committed to count. Commit any uncommitted approval files in `studio/approvals/`
   (as opus-1).
8. Optional: region lanes for the big sim file: `STUDIO_REGION_FILES=<its path>` in `.env`, then give its tasks region
   lanes (`--lane <path>#<symbol>`).
