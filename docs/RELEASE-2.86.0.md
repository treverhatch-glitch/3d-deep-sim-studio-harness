# 2.86.0: the engine train (`docs/RELEASE-2.86.0.md`)

The owner's order of 2026-11-14: keep making the harness more effective, take out unused and duplicate code, and work
through the overseer's list. Built on 2.85.0. Only this page and the one for 2.85.0 are kept; older release notes are
in git history.

## What the records said

A crew's first 19.5 hours on 2.85, from its event log (`npm run score`):

| Measure | 2.84 (16.3 h) | 2.85 (19.5 h) |
| --- | --- | --- |
| Scorecard targets met | 3 of 15 | 4 of 15 |
| Tasks landed with no overseer step | 0% of 26 | 25% of 24 |
| Hand-backs with a harness or machine cause | 59.5% | 34% |
| Engine land runs that passed | 46.2% | 35% (20 runs) |
| Engine queue wait, p90 | | 12.7 h |
| Cost per landed task | $7.57 | $10.20 |

Four findings, each read from the log and the studio's files, not from anyone's account:

- **The supervisor never ran 2.85.** Its process had started the day before the upgrade and was not restarted, so
  its in-process passes ran 2.84 code for the whole window. 32 of 91 hand-backs were the false "claim ran out"
  hand-backs 2.85 had removed (every one a task waiting in the engine queue; not one `task.claim.released` event), and
  the web train's off switch from six days earlier never lapsed. Nothing in the harness said so.
- **One flaky test owned the engine train.** A Play Mode test the studio lists as flaky fails about half the time.
  It cost two one-branch trains their branch, and one 6-branch train 6.5 hours of narrowing that ended by handing
  back the branch that was the fix for that test. One of the narrowing steps became the daily full run (2.6 h).
- **The rules check ran everything, twice, every train.** 40 minutes before any land run started, even for one
  branch. The studio's 38 hand-written map entries had never matched a path: `focusFilters` refused any entry whose
  pattern grouped its prefixes, `^(a/|b/)`, although the filter used no group. And the target was run again every
  train because the kept result was keyed by inputs that change with every port.
- **Sessions ended for the harness's reasons and the task paid.** 35 hand-offs came from the 2.85 refresh rule (60%
  of the window) in sessions that start at 65 to 70% full; three of those in two hours parked brand-new tasks.

## What was built

| | What | Where | Checks |
| --- | --- | --- | --- |
| New code takes effect | A running supervisor records the code it runs (version, HEAD, the `harness/` tree) and compares each pass; on a change: one `harness.code_changed` event, then at a quiet point it starts its successor with the same options and ends (never two at once; its state is handed over; running sessions and trains are not touched). Under launchd or a systemd unit it exits for the service to restart it. In a terminal, or with `STUDIO_SUPERVISOR_SELF_RESTART=off`, it warns once. The watcher says so and keeps running. | `harness/code-stamp.mjs`, `supervisor.mjs`, `watch.mjs`, `health.mjs`, `digest.mjs` | `qa/selftest-286a.mjs` |
| The upgrade and the board | `upgrade --merge` holds the board and holds locks while it commits the board snapshot (through the hooks), checks, merges and commits; it ends by naming every long-running process still on old code and what will happen to it (`upgrade.old_code`). `npm run harness-health` and `studio:status` show "runs X, installed Y". | `harness/upgrade-guard.mjs`; docs/RELEASE.md, docs/RUN-UNATTENDED.md | 286a |
| A red on a listed flaky test | `engines.<x>.flakyRetries` (2): the failing tests are run again by name that many times; a pass lands the batch. Still red: the same tests run on the target alone (a probe, which lands nothing). Red there: the target is red, nobody is handed back, the lanes stay queued and are not counted, one `engine.red_on_target` pages for a fix. Green there: the search for the branch goes on. | `harness/unity-train.mjs`; docs/NATIVE-ENGINE.md | `qa/selftest-286b.mjs` |
| Narrowing by test name | When the red names its tests and the land script honours `STUDIO_LAND_PROBE`, every narrowing step and the confirm run run only those tests on that step's merged tree (minutes, not a land run) and land nothing; the survivors then land on one complete run. `nextStep` is the one pure plan; `npm run engine -- bisect-plan` prints it. A run that must land nothing and moves the target stops the train (`probe_moved_target`) and turns by-name steps off for that engine. | `unity-train.mjs`, `engine.mjs` | 286b |
| The daily full run | Its own run on the target alone, never with a branch and never a retry, narrowing or confirm step: when due with an empty queue, or first in a train once overdue (`fullLandMaxHours`, default twice `fullLandHours`). Its red goes to the 2.85 baseline. | `unity-train.mjs`, `line-producer.mjs` | 286b; 285a, 283b, 284h rewritten for the new rule |
| Batches | `engines.<x>.batchAlone`: path patterns whose branches land alone. A flake record per test (`engine -- status` says "red in 9 of 20 land runs"). An optional `knownRedHours` contract (off by default) for a script that can leave a probe-proven flaky test out of its verdict. | `engine-train-control.mjs`, `unity-train.mjs` | 286b |
| The rules map | A pattern that groups its prefixes matches again (only groups the filter uses are checked). `rules.focus.auto`: one description of the layout, one entry per system derived from the tree being checked, so a system a batch adds is covered. Hand-written entries win. | `harness/engine-rules.mjs` | `qa/selftest-286c.mjs` |
| Results kept per part | A part's green result is kept under what that part reads (its own paths, `rules.focus.shared`, the command, its inputs) and reused for the target's calibration, the batch and every narrowing step. A part that is new in the batch is not run on the target. A red batch narrows with the red part only. `npm run engine -- rules-plan` prints what would run and runs nothing. | `engine-rules.mjs`, `engine.mjs` | 286c |
| The refresh rule | Measured from the session's context at its first work: hand off at start + `STUDIO_REFRESH_HANDOFF_PCT` of the room left; never for context before any work, short of `STUDIO_REFRESH_SAFETY_PCT` of the window. `agent.refresh.decided` carries the start, the threshold and the reading. | `harness/session-cap.mjs`, `agent.mjs`; docs/SESSIONS.md | `qa/selftest-286d.mjs` |
| What counts against a task | One reading (`handback-kind.mjs`) for the watchdog's park, the task budget, both breakers and the score: a refresh, a refresh with no work, a launch failure (died before its first turn, or on a permission prompt), a `task done` refused by the hooks gate for commits not the task's own, and a start refused for a lane copy are harness causes and count against nothing. A repeated foreign refusal is still bounded by the same-refusal hold. | `handback-kind.mjs`, `task-budget.mjs`, `breaker.mjs`, `crew-watch.mjs`, `score.mjs` | 286d |
| Claims and lane copies | A claim is released when its session ends, whatever the reason. A refresh's successor works on in its predecessor's lane copy once that process is confirmed gone. Two permission-prompt exits hold that task, not the studio. | `agent.mjs`, `lock.mjs`, `busy.mjs`, `supervisor.mjs` | 286d |
| Main-checkout access | `STUDIO_LANE_ADD_MAIN_DIR` (off): the tool's extra-directory flag for a lane session. It opens read and edit of the main checkout without a prompt; the commit and config hooks still apply. The studio's choice. | `agent.mjs`; docs/SESSIONS.md | 286d |
| Sparse engine worktrees | `engines.<x>.sparse`: `{ roles, paths }`. A listed role's worktree holds only those folders and the top-level files; merges of the target work, a conflict outside the folders says how to widen (`engine -- lane <ID> --full`). The land run's gate worktree stays full. | `harness/engine-worktree.mjs`, `engine-tracks.mjs` | `qa/selftest-286f.mjs` |
| Worktrees and disk | One rule for "safe to remove" (landed, done or cancelled; never in progress, queued, or holding uncommitted or unpushed work), applied every 30 minutes, not only after a landing. `STUDIO_DISK_WARN_GB` (60): one `machine.disk_low` a day naming the biggest users, on both volumes. Under the disk budget (`STUDIO_DISK_MIN_FREE_GB`) the supervisor starts no new worktree or lane copy. `engine -- lanes` lists them. | `engine-clean.mjs`, `machine.mjs`, `supervisor.mjs` | 286f |
| Smaller fixes | A merge of the target re-queues a conflict hand-back, and every "nothing changed" refusal names `--again`. The same force approval answers `--force --train`. The engine task file is written with retries. A promoted proposal's holds follow it to its task id. A model pool's own `"anyModel": true` lets it run on another vendor's tool. | `unity-train.mjs`, `task.mjs`, `engine-tracks.mjs`, `proposed.mjs`, `model-tool.mjs`, `agent.mjs` | `qa/selftest-286e.mjs` |
| Unused code | `npm run check:unused` (`scripts/unused-exports.mjs`): every export classed as used, test-only, internal or dead by reading every text file of the checkout. 17 dead exports removed, one exact duplicate folded; the count left (2) is pinned by a test. | `scripts/unused-exports.mjs` | `qa/selftest-286g.mjs` |

## The overseer's list, item by item

Must fix: 1 (narrowing) and 2 (the full run): built, see "A red on a listed flaky test", "Narrowing by test name" and
"The daily full run". 3 (the rules check): built; its cause was a matching bug, not memory. 4 (the web train's
auto-start): already fixed in 2.85; the supervisor never ran it. 5 (disk): built.

Should fix: 6 the upgrade commits the board itself. 7 the refresh rule. 8 harness-caused ends are not counted. 9 the
permission prompt: classified, held per task, and an off-by-default setting; not on by default. 10 re-queue after a
conflict, and the force approval. 11 claims of ended sessions. 12 the pool flag. 13 the file rename. 14 proposal ids in
holds.

Not built, on purpose: a way for a beta agent to exempt a commit from the hooks check. The commit that needed it was
made with `--no-verify` during an upgrade; the upgrade now commits the board properly, and the audit has no new door.

## What the dead-code tool found

3,713 exports. 20 were named nowhere else. The first list of files, chosen by extension, missed the commit-msg hook (a
shell script with no extension), which imports one of the 20; removing it would have broken every commit. The tool now
reads every text file. 17 are removed, 2 stay (one is the only reader of a documented setting, one sits in a
protected file), and the test fails if the count rises. 400 more are named only by tests; 14 of those are used by
nothing else at all. The code is not carrying dead weight by reference; its size is in features that are wired in.

## Not tested, and not built

- Nothing here has run on a real engine editor or a live studio. The replays of the two field trains are plans
  computed from recorded outcomes, with estimated minutes for by-name steps.
- By-name narrowing needs the studio's land script to honour `STUDIO_LAND_PROBE`; until it shows that, every step is
  a complete land run as before.
- The supervisor's restart under launchd, systemd and a detached start was tested with stand-ins, not end to end.
- A supervisor older than 2.86 carries no stamp: the first upgrade to 2.86 reports it as "too old to tell" and gives
  the restart command.
- The refresh successor's lane-copy takeover was not reproduced on Windows; it is a reading of the log.
- Not built: tasks stacked on a parent that waits in an engine queue; a read-only grant of the main checkout to lane
  sessions (the tool's help text shows no such flag); the judge before landing of the plan.

## Upgrading

`npm run upgrade -- --merge <ref> --by <who>`. It commits the board itself. Read its last lines: they name what
still runs old code. A studio whose supervisor predates 2.86 restarts it by hand once, this time.
