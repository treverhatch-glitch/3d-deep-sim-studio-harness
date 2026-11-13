# Changelog (`CHANGELOG.md`)

All notable upgrades to the **3D Deep Simulation & AI Game Studio Harness** are documented in this file.

---

## [2.85.0] — 2026-11-13
Hands off (the owner's order: fix the overseer's list, make it better, clean up, start on the plan). A crew's first
16.3 hours on 2.84 measured 46.2% of engine land runs passing (34.8% on 2.83) and a 32.9-minute passing run (51.1),
and 0 of 26 landed tasks without an overseer step: 59.5% of hand-backs had a harness or machine cause. 106 files,
+5,813 / −1,401 lines against 2.84.0; tracked lines 164,719 to 169,131. Details: docs/RELEASE-2.85.0.md.
- **False hand-backs:** a task whose branch waits in a train queue is never handed back (30 of 73 hand-backs in the
  crew's log were that); one reading of hand-backs for the watchdog, the crew breaker and the score
  (`harness/handback-kind.mjs`); the same `task done` refusal twice holds the task until the check stops giving it; a
  ready engine hand-back queues itself (`STUDIO_ENGINE_AUTO_QUEUE`).
- **The trailer check** reads the task's own commits wherever `task done` runs; the commit-msg hook puts a
  `Golden-Reason:` line in the trailer block.
- **The owner-only list** is deleting data, keys, publishing, tool definitions and turning beta off; an ask is read
  for meaning in one case only (code removed in a lane is not deleted data).
- **Every ask resolves:** `STUDIO_ASK_TIMEOUT_H` (4) decides by the default, `STUDIO_ASK_STALE_H` (8) escalates once;
  an owner-only ask is never timed. "Continue or hand off" is decided by rule (`STUDIO_REFRESH_DECIDE`).
- **Engine land runs:** the daily full run is announced and kept out of the compile check; a full run red only on
  tests no branch is tied to lands the branches and records a baseline; a failing test's suspect is tried first; an
  unchanged red is not queued again (`--again`); Play Mode filters per panel, `npm run engine -- play-plan`; the rules
  split is memory-aware (`harness/rules-parts.mjs`).
- **The web train's switch:** an agent's `train auto off` lapses (`STUDIO_TRAIN_AUTO_OFF_HOURS`, 4); the daemon says
  why it waits. A running engine train counts as work. Review answers give the verdict first. A lane copy's board
  write is not a hand edit. The hooks gate names the upgrade command after a plain merge.
- **The vision card** (`harness/vision-card.mjs`): every player-facing brief carries the signed Bible's lines for the
  task (the pillar, up to six "never" lines, the feel line, the phase goal). **Vision fixes** (`task add
  --vision-fix`) start and land first.
- **Gaps closed:** a milestone criterion is met with evidence; a `Golden-Reason` is 20+ characters and names a task
  (`STUDIO_GOLDEN_REASON`); a rules change with no test is noted and counted (`STUDIO_RULES_TEST=require` refuses);
  the browser check plays the studio's own game, never the sample; a hand-back note's file claims are checked.
- **Cut:** two settings nothing read; `check-docs` now fails on a documented or tested setting with no production
  reader. The plan's larger cuts did not survive a proper check (docs/RELEASE-2.85.0.md). Comments shortened in 30
  files, code tokens proven unchanged.
- **Not measured:** nothing here has run on a live studio or a real editor yet.

## [2.84.0] — 2026-11-12
Less waste (the owner's order: keep what moves the studio forward, cut what costs tokens). The documents an agent or
a maintainer reads went from 1,672 KB to 958 KB and code comments from 1,557 KB to 1,439 KB; tracked lines stayed level
(164,633 → 164,630) because the second pass added as much as the cuts removed.
Details: docs/RELEASE-2.84.0.md.
- **Planning wakes that change nothing** (`harness/wake-gate.mjs`): after a regular cycle or a queue-depth session that
  changed nothing on the board, that role's next one waits twice as long, up to `STUDIO_CYCLE_QUIET_MAX_H` (12) and
  `STUDIO_WAKE_SAME_MAX_H` (6); a person's answer, an owner order or a phase change ends the wait. On a crew's 26-hour
  log: 66 of 113 planning wakes skipped, about $43 of $70. `meta.outcome.boardEvents` on a planning session's end; two
  scorecard lines. A session is not started on a task whose `task start` would be refused (`agent.start.refused`).
- **The same-family review switch** (`npm run review -- same-family on|off|auto`, `studio/review.json`): the owner or
  the overseer decides whether a review by the implementer's own model family counts. Which families a studio has is
  read from the main checkout's files, never from a session's environment.
- **The overseer's sheet** (`npm run overseer -- sheet`): everything waiting on a person or the overseer, with the
  reason and the command for each. Reads only.
- **A real Unity editor in the online checks** (`scripts/unity-real.mjs`, job `engine-unity-real`): the Edit Mode
  arguments the harness plans, a failing test's name and a compile error's file, checked against a real editor's
  output. The test runner is pinned to v4.3.2. UNTESTED until the repository's Unity sign-in secrets work.
- **A batch window for the engine train** (`engines.<x>.batchMin`, `batchWaitMin`; default off): the automatic start
  waits a few minutes for more queued branches while sessions are still working on that engine's tasks.
- **Play Mode focus** (`engines.<x>.play.focus`): the land command is told which Play Mode tests a batch needs
  (`STUDIO_PLAY_MODE`, `STUDIO_PLAY_FILTER`, `STUDIO_UNITY_PLAYMODE_ARGS`); a full run once a day. UNVERIFIED on a
  real editor.
- **A check for commands that end before they run** (`npm run check:tla`, in the release gate): a module that awaits,
  at top level, an import that reaches back to itself exits 13. Four more found and fixed (`ask`, `engine-tracks`,
  `session-cap`, `waves`); `engine-tracks.mjs backfill` had been ending that way.
- **From a studio's first hours on 2.83:** `npm run engine -- merge <ID> [--continue|--abort]` merges the engine target
  into a task's worktree and leaves a conflict for the session to resolve (a session may not run `git merge`; three
  tasks burned three sessions each); the same conflict twice parks the task once. A file git reports as modified
  whose bytes equal the committed version is not "uncommitted work". `rules.focus.ignore` and `play.focus.ignore`:
  paths that cannot affect the tests do not force the full run.
- **Drift check:** files already changed in the main checkout when a session started are not counted as the session's.
- **The Windows self-test in 8 shards** (was 4): about half the wait for every release.
- **Which commands a studio runs** (`npm run commands-run`): an empty marker per command and month, so a feature is
  cut on evidence.
- **Second pass, from a crew's first day on 2.83** (4 of 15 scorecard targets; engine land runs passed 34.8%; 22% of
  landed tasks without an overseer step) **and the overseer's list:**
  - *Land runs:* failing tests and compiler errors are read from the results files a land run writes
    (`engines.<x>.results`); a red stage is retried with only the tests that failed, and known-flaky names
    (`flakyTests`) before anyone is blamed; `play.focus.skip`; `compileFirst`; a run the OS killed is retried, never
    blamed; `rules.focus.split` and `rules.maxLanes` for the rules check's memory.
  - *Train control:* `task train --engine <x> --only <ids> | --tag <name>`, `task tag`, `batchMax`, `batchGroup`,
    `task train cancel --engine <x>`, `task train auto off|on --engine <x>`, `npm run studio:boot -- install`.
  - *Gates by track* (`harness/gate-tracks.mjs`, on by default, `STUDIO_GATES_BY_TRACK=off`): a docs-only or
    engine-only change no longer runs the web game's gates; the safety gates run on every change.
  - *The reviewer:* the tool follows the planned model, a mismatch is refused before a process starts, a reviewer's
    launch crash no longer halts the supervisor; `npm run review -- ask <ID> --model <id>` (the harness asks, records
    and closes the review task).
  - *Supervisor and crew:* a skipped task says why; a refusal about the crew is not counted against the task; the crew
    breaker counts queued and ready work; the planning stall limit follows the model; `task start --dry-run`;
    `studio:reload-env` names the settings it no longer reads.
  - *Who decides:* the overseer and the signers were refused the engine merge and unparks, and their own decisions did
    not end the planning back-off: fixed, with a table in docs/OVERSEER.md. **Beta powers, the owner's decision:** in
    beta mode a beta-mode agent and an outside signer release tier-C lanes, force a done (with the train too), approve
    protected files including their own change (marked `self`), resume a crew and control an engine train; each use
    is a `beta.use` event and a digest line; the owner-only list, launched sessions and workers are unchanged; an
    upgrade keeps `studio/beta.json`.
  - *A harness-owned editor* (`npm run editor`, `harness/editor-service.mjs`, a C# service in the Unity template):
    warm land runs and a compile-and-capture queue for sessions. Off by default. UNTESTED on a real editor.
  - *Cut:* remote workers and the remote verify, the harness scout, signed results (14 settings); five more pages
    shortened; code comments in the largest modules cut with a proof that no code token changed.
- **Cut:** eleven old release notes, three old handoff notes, the 2.79 audit write-up; the changelog, the problems log
  and the proposals log keep their newest entries in full and one line for each older one; README 18 KB → 4 KB;
  docs/SECURITY.md 46 KB → 17 KB with every rule kept. One pattern for a board line (`harness/board-line.mjs`).

## [2.83.0] — 2026-11-11
Flow (the owner's "next harness upgrade", with the overseer's notes from 26 hours on 2.82). 2.82 fixed the engine's
land run (65% of runs passed against 18%; 30 land minutes per landed lane against 290) and the records then showed
where the time went instead: sessions scored "no work" in the wrong repository (89 session ends, 25 parks), a plan
that reported itself blocked 166 times for two causes, a rules check that ran everything every time (514 minutes),
and a train that blamed by elimination. 72 files, +4,078 / −823 lines (net +3,255) against 2.82.0. Details: docs/RELEASE-2.83.0.md.
- **A session is accounted where its work is** (`harness/engine-tracks.mjs` `engineWork`, `harness/agent.mjs`): an
  engine task's commits and unsaved files are counted in its engine worktree; a task in the engine train is "queued",
  not "no work"; the crew breaker counts queued work.
- **The engine train** (`harness/unity-train.mjs`): a branch that lands alone (`task alone <ID> on`, `task done
  --train --alone`); one more run before blame when a load-sensitive stage is red; blame by evidence (the failing
  test's class, or the file a compiler error names, in the lanes' changes); a lane found by elimination is run by itself first; a handed-back lane leaves
  the train at once; a full land run once a day (`STUDIO_LAND_FULL=1`); `engines.unity.editModeArgs`; a warning when
  the land command runs another copy of its script; a task whose engine half has not landed stays open.
- **A cheaper rules check** (`harness/engine-rules.mjs`): `rules.env`, `rules.paths` (sparse checkout, no LFS
  download), `rules.focus` (only the touched systems' tests plus a smoke set; the full command every
  `fullEveryHours`), inputs merged from every lane in the batch, `rules.share`. `npm run engine -- rules` no longer
  hangs (it exited 13 on 2.82), and the porter's check never runs in the studio repo.
- **The planner** (`harness/line-producer.mjs`): a dangling `--after` asks once; `line.chain_gate` when one task gates
  3 or more builder tasks for an hour; the builders-low alert leads with the reason; the Producer is not woken again
  for the same blocker within an hour.
- **Models and slots**: `routeRoles` in `studio/models.json` (pool routes apply to builders and porters only); a
  refresh, stop or usage limit is not a route failure; planning sessions don't take builder slots; no engine tasks on
  Vertex; `npm run mode -- boost on --builders-only`.
- **The board**: `task after <ID> --remove|--set|--clear`; unknown `--after` ids refused; `task train dequeue <ID>`;
  an unknown `task train <word>` starts nothing; train status shows the running batch and the queue; `task track <ID>
  web`; in a native studio a task that names web code goes to the web track.
- **Watching**: no "stalled" for a lane in a train; the same unchanged-shots review is retried once a day; a review
  falls back to the same model family when no other is available (and says so); the idle stop and claim minutes skip
  downtime; a dead session's claim is handed back after 30 minutes.
- **The owner-only list** (`harness/owner-acts.mjs`): code removed in a lane is not deleted data; anything that
  names data stays the owner's.
- **Cleanup**: landed engine worktrees are removed; `engines.<x>.builds` keeps the newest builds
  (`harness/engine-clean.mjs`); `lanes prune` covers engine lanes.
- **Scorecard**: the CPU measure reads the hourly summaries; `engines.<x>.progress` prints a progress line;
  `studio/allowlist.json` adds a studio's own commands.
- **Cut**: `harness/token-norms.mjs` and `harness/ledger.mjs` (382 lines; nothing imported them, no run on record)
  with their two npm scripts and their checks.

## [2.82.0] — 2026-11-10
Native engine (the owner's "Round 2.82"). The crew's 64 Unity land runs passed 18 times; a passing run took 92 minutes,
53 of them re-running in Edit Mode the rule tests .NET had just run, and 24 of the 45 failures were in tests that need
no editor. 27 files, +1,951 / −58 lines (net +1,893) against 2.81.0. Details: docs/NATIVE-ENGINE.md (the release notes of 2.82.0 are in git history).
- **Native-engine mode** (`harness/native.mjs`, `npm run engine -- native`): a studio whose game is the engine build
  builds a feature once. Builder tasks go on the engine track; the web tester schedule, the web landing build, engine
  twins and the port queue are off; the planning kickoffs say so. `"native": "<engine>"` in `studio/game.json`.
- **The rules check before the land run** (`harness/engine-rules.mjs`, `npm run engine -- rules`): the cheap rules
  tests run on the batch first; the lane that breaks them is handed back (cause `rules`) without a land run; a check
  that is red on the target judges nobody. Unity default: `dotnet test tools/SimTests`.
- **Land stages** (`STUDIO_LAND_RESULT`) on the `engine.land` event; **Edit Mode once** (`STUDIO_UNITY_EDITMODE_ARGS`,
  `node harness/unity.mjs editmode-plan`); `STUDIO_RULES_GREEN` for a land script.
- **Scorecard:** the engine flow (land-run minutes per landed lane, red and refused shares, stages, the rules check's
  catches) and the design link (done work that traces to a pillar, a layer, an idea or the owner's ask). Baseline:
  `studio/scores/2026-11-08-engine-baseline.json`.
- **Folded:** the porter's quick check falls back to the owner's `rules` command; one role file for engine work in a
  native studio.
- **Fixed (from 2.81.0's Windows checks):** the attempt ledger's path comparison on Windows.
- **Fixed before release (P-299):** a kept rules result is valid for its git-ignored inputs too (`inputsPrint`), and
  the land run is not told the rules are green when those inputs changed after the check.
- **Fixed before release (P-300):** `npm run engine -- check` with the owner's `rules` command and no `quickCheck` is
  the rules check on the lane's commit as it would land (throwaway checkout, inputs copied in, the target first), not
  the bare command in the lane's folder. `task done` still runs an engine check only when `quickCheck` is set.
- **A note, nothing built:** studio/notes/TRAIN-SPLIT-2026-11.md answers whether the Unity train should be split into
  stages, from the crew's 65 land runs.

## Earlier releases (one line each; the full text is in git history: git log -p -- CHANGELOG.md)

- **2.81.0** (2026-11-10): grade, measure, cut again: the round scorecard (`npm run score`), the outside overseer's role, a faster self-test, duplicate helpers folded.
- **2.80.0** (2026-11-10): the trim: the hub and other unused parts cut, tracked lines 175,491 to 157,794, the timed passes moved into the supervisor.
- **2.79.2** (2026-11-07): Fixes Vertex builders that ended "no work" after huge requests, and the STUDIO_VERTEX_SHARE=0 off switch that did not stop them.
- **2.79.1** (2026-11-06): The crew's request after a good day on 2.79.0: Vertex as a builder tool, owner-set spend budgets, an engine push mode, and fat cut.
- **2.79.0** (2026-11-06): The crew's request after 2.78.2: a game tester that plays the game, the 2.78.2 bugs, the orchestrator signing for the owner, and less fat.
- **2.78.2** (2026-11-06): The crew's train-speed request from the first run on 2.78.1 (items 1 to 18) and the owner's decision on who may approve what.
- **2.78.1** (2026-11-05): The crew's patch request from the first day on 2.78, the War Room's Planning Room page, and a long-run preflight.
- **2.78.0** (2026-11-05): Builders that get more tasks right: research items PU-54 to PU-63 (all but PU-61) and the crew's B-105, with no new approval step.
- **2.77.3** (2026-11-05): The crew's patch request from the 48-hour run on 2.77.1 (B-99, B-104 to B-115, M1 to M7).
- **2.77.2** (2026-11-05): A hotfix for the crew's first hours on 2.77.1 (B-104 to B-107); the rest of that list went into 2.78.
- **2.77.1** (2026-11-05): Fixes for the crew's live-run blockers on 2.77.0 (their list of 2026-11-04, B-92 to B-103).
- **2.77.0** (2026-11-04): "Patch #2": everything on the crew's 2026-11-04 list that 2.76 did not finish, including Gemini as a first-class builder.
- **2.76.1** (2026-11-04): A lane landed under a trust note now closes its task; the train had closed it with a record the close refuses (B-85 follow-up).
- **2.76.0** (2026-11-04): The beta release: owner permissions for the orchestrator in beta mode, a Line Producer, a Discord Communicator, headless Gemini builders, bugs B-80 to B-95 fixed.
- **2.75.0** (2026-11-03): Three releases at once for the crew's restart: the rest of the emergency list (2.73.2), the War Room refresh (2.74.0) and its new look.
- **2.73.1** (2026-11-03): An emergency patch for the crew's first hours on 2.73.0 (the owner's request list from the crew's orchestrator, B-51 and B-59 to B-69).
- **2.73.0** (2026-11-03): "Autonomy, safely": a measured, reversible way to hand more to the overseer, and the last red-team holes the outside review left open.
- **2.72.0** (2026-11-03): "Better reds, better games": a red says where and why, flaky timeouts stop costing a round, engine gates prove they ran.
- **2.71.1** (2026-11-03): "Close the gate holes": red-team holes from an outside review that an agent could fall into by accident or on purpose.
- **2.71.0** (2026-11-03): "The owner layer": one log of owner and game-dev decisions, a studio policy file, an opt-in autonomous mode, and the overseer's paperwork as commands.
- **2.70.0** (2026-11-02): "Use the idle hardware": GPU work beside CPU work, faster Unity runs, a check on asset previews, and lanes that fit the disk.
- **2.69.0** (2026-11-02): "Less repeated work": the merge train stops re-running what it already knows, runs on its own, and tells a flaky test from a broken one.
- **2.68.0** (2026-11-02): "Fit the machine": the harness measures the computer it runs on and sizes its work to it.
- **2.67.2** (2026-11-02): Stop the false alarms: the crew's B-50 (a busy verify is never red) and two day-two findings.
- **2.67.1** (2026-11-02): The crew's Blender and Unity notes and the owner's one asset flow, with an asset track and gate.
- **2.67.0** (2026-11-02): The crew's day-one hitlist from running 2.65 (P-161 to P-166), starting with chain tails for stacked trains.
- **2.66.0** (2026-11-02): "Measure and find": changes from the 2026-11-02 research pass, starting with a Tokens block in `npm run autonomy`.
- **2.65.3** (2026-11-02): Fixes the crew's B-43 (a red merge train took over an hour to find the lane that broke it) and B-44.
- **2.65.2** (2026-11-02): Measurement fixes from the 2026-11-02 research pass, and the first bug a fuzz run found.
- **2.65.1** (2026-11-02): The crew's 2.65.1 hitlist: the parts that 2.64.0 and 2.65.0 did not already cover.
- **2.65.0** (2026-11-02): Hands off by default: the harness decides routine questions from evidence and logs why; people are needed only for safety gates and Bible changes.
- **2.64.0** (2026-11-01): Everything built for 2.60.1 to 2.64 in one release, so a studio upgrades once: bugs B-17 to B-41, the learning edge, sealed bench, risk-tiered landing.
- **2.60.0** (2026-11-01): The crew's round-2.60 brief: pins, shared lines, an upgrade path and heavy-lock trees, shaped by merge-queue practice.
- **2.59.1** (2026-11-01): The owner's permission rule: agents may act on a person's direct permission (P-112).
- **2.59.0** (2026-11-01): The crew's final brief of 2026-11-01 (items 1 to 16) and one gap found in the crew's logs.
- **2.58.5** (2026-11-01): Fixes from a crew report of 2026-11-01 (H-1 to H-11), starting with the hooks gate crashing on big ranges.
- **2.58.4** (2026-11-01): Three gaps found while building a game's first real replay cartridge (P-081 to P-083).
- **2.58.3** (2026-11-01): Fixes from a read-only dive into the crew's studio logs (P-069 to P-080), starting with a person's stop no longer counting as a crash.
- **2.58.2** (2026-11-01): The flaky HUD check, a gate against dodged checks, and deterministic maths in the purity gate.
- **2.58.1** (2026-11-01): The crew's Windows launch bug (agents now start with their arguments intact) and headless permissions for the agy tool.
- **2.58.0** (2026-11-01): The round-2 break-test fixes and the crew's report, batched in six parts under the owner's batching rule.
- **2.57.1** (2026-11-01): What was ready after 2.57.0, batched, starting with `agent stop` no longer killing a program that reused a stale session's process number.
- **2.57.0** (2026-11-01): Three fixes from the 2026-10-31 break tests, batched into one release; the safe agent stop (PU-17) was pulled before merge for rework.
- **2.56.1** (2026-11-01): PU-20 from the 2026-10-31 break tests: the protected-files check also sees uncommitted and already-pushed edits.
- **2.56.0** (2026-10-31): PU-15, approved by the owner: a general visual-effect skill (spec, stepped capture, frame checks, review) as `npm run vfx`.
- **2.55.0** (2026-10-31): Fixes from the crew's own logs (P-028, P-030, P-031, P-032), starting with a stale session record taking a fresh claim away.
- **2.54.0** (2026-10-31): Fixes from the first crew run on a real game (P-022 to P-027) and the first three planned updates from the research.
- **2.53.0** (2026-10-31): The public guard learns a repo's own private markers, so one game's private rules never reach a public repo.
- **2.52.0** (2026-10-31): U-003 from the studio logs: the 2.41 "two greens" self-test no longer depends on timing.
- **2.51.0** (2026-10-31): U-005 from the studio logs: `npm run public-guard` installs and checks a guard on a public game repo.
- **2.50.0** (2026-10-31): U-006 from the studio logs: parity for a Vite game, with seeds passed to both sides' commands.
- **2.49.0** (2026-10-31): U-004 from the studio logs: `npm run logs`, the studio logs' two-minute read.
- **2.48.0** (2026-10-31): The Unity track's default is a Windows game (HDRP at max quality, played as an .exe); the web version stays the browser game.
- **2.47.0** (2026-10-31): Owner-approved upgrades U-001 and U-002 for a game with an adopted web version and a Unity port in its own repo.
- **2.46.0** (2026-10-31): Unity support, which the engine track named but had no starter project, result reading, version check, controls test or CI for.
- **2.45.0** (2026-10-31): Real key presses on an adopted web game, each checked against the Game Bible, proven on a private copy of a real game.
- **2.44.0** (2026-10-31): What a long build on an adopted game needs: studio copy and game repo kept in step, workable verify times, fewer blocking flaky checks.
- **2.43.0** (2026-10-31): Bring a game that already exists under the studio: `npm run onboard -- --adopt` copies its files and declares its own checks.
- **2.42.0** (2026-10-31): The Godot pieces that must be the same version (binary, project, export templates) are checked together.
- **2.41.0** (2026-10-31): A new browser regression must pass twice before it is protected (opt-in `STUDIO_TWO_GREENS=on`).
- **2.40.0** (2026-10-31): A quieter watchdog log (opt-in `STUDIO_WATCHDOG_QUIET_MIN`) and the new signals in the health report.
- **2.39.0** (2026-10-31): The Game Bible says what each control must change, so a weak `expect: () => true` cannot pass a button that does nothing.
- **2.38.0** (2026-10-31): Built but not wired: a reachability check (`npm run reach`) for systems that tests cover but nothing in the game uses.
- **2.37.0** (2026-10-31): After work lands, every check runs on the whole game, not only the files a task touched (opt-in `STUDIO_WHOLE_GAME=on`).
- **2.36.0** (2026-10-31): A check that exits 0 but ran no tests is not a pass (the silent-green guard).
- **2.35.0** (2026-10-31): A task stopped by its budget climbs a rescue ladder instead of waiting for a person, and no step on it can gridlock the studio.
- **2.34.0** (2026-10-31): The harness's own numbers, every night: `npm run harness-health` reports refusals per landing, hand-backs and similar measures.
- **2.33.0** (2026-10-31): One door to the studio's branch, agents see only their own keys, and fixes for builders' false refusals.
- **2.32.0** (2026-10-31): Nothing a player can do goes unchecked: the Game Bible owns the controls list, a controls gate checks it, and agents cannot edit the checks.
- **2.31.0** (2026-10-31): Tracks really check in parallel, and no task can burn a day: a budget per task across every session.
- **2.30.0-q** (2026-10-24): The rest of the merge audit: landing no longer depends on the main checkout's index.
- **2.30.0-p** (2026-10-24): Tracks land on their own: path-scoped gates, so an engine-only task skips browser gates.
- **2.30.0-o** (2026-10-24): The studio supervises itself: a stall check and a wall-clock cap per session, from a study of another tool and an overnight run.
- **2.30.0-n** (2026-10-23): The gates check the game the studio is building, not the bundled example.
- **2.30.0-m** (2026-10-23): A build task has to change code: `task done` refuses it when no code changed, unless closed with `--no-op`.
- **2.30.0-l** (2026-10-23): Two fixes from the 2.30k run, starting with one builder per task.
- **2.30.0-k** (2026-10-23): Builders lock only the files a task touches, so builders on different files run side by side.
- **2.30.0-j** (2026-10-23): Fixes from driving a real game from the War Room; no new features.
- **2.30.0-i** (2026-10-23): Two fixes from real game builds plus NIM limits; no new features.
- **2.30.0-h** (2026-10-23): The cheap false-green stoppers first, then the Director keeps builders fed from clean work only, and model limits.
- **2.30.0-g** (2026-10-23): Token savers: every session of a role starts with the same bytes, long output is trimmed, know-how loads on demand, plus a Godot unit gate.
- **2.30.0-f** (2026-10-23): Parallel floors: a later phase can start its pipeline while the one before it is in art or polish, and game content becomes data.
- **2.30.0-e** (2026-10-23): Art the game can use, one token ledger across every provider, faster checks while working, and a rehearsal with no model.
- **2.30.0-d** (2026-10-23): The steering batch: forced work waits for a second opinion, big tasks split themselves, and the dev can step away and review every call later.
- **2.30.0-c** (2026-10-23): The quick wins: agents read less at the start, a task that keeps failing stops costing sessions, and a release ships with one command.
- **2.30.0-b** (2026-10-22): The hard batch: gameplay checked with real keys and clicks, a sim feature counts once the build shows it, free art comes with its licence.
- **2.30.0-a** (2026-10-22): The moderate batch: the dev's words drive the queue, the dev can overrule a gate, and the War Room says what waits on whom.
- **2.29.2** (2026-10-22): Stop the waste, finished: the turn budget for one-task sessions and the shorter start that did not ship in 2.29, plus quick wins.
- **2.29.1** (2026-10-22): Fixes 2.29.0's red CI (map find, the function-size check and the size ratchet failed on Linux and Windows).
- **2.29.0** (2026-10-22): Stop the waste: one working copy per lane, and the top open items from the third test run.
- **2.28.0** (2026-10-22): Fixes from two model reviews, the third test run on 2.27.2 and the notes its agents left, including Windows setup from PowerShell.
- **2.27.2** (2026-10-21): Fixes from the owner's notes on the War Room and the engine track; the Arcade now plays bundled builds.
- **2.27.1** (2026-10-21): `npm run task -- stop` now stops the running agents, and Stop all and Pause save each agent's uncommitted work as a patch.
- **2.27.0** (2026-10-21): The engine track: a Godot (or Unity, Unreal) version of a web-proven game, run as its own team and linked only by a parity test.
- **2.26.0** (2026-10-21): Fixes from the second test run and token numbers from the first, starting with one launcher instead of two.
- **2.25.0** (2026-10-21): Make "good" a gate, not a guess: a person's verdict closes a phase, and every game gets an identity.
- **2.24.1** (2026-10-21): A self-test fix: the stopped-agent cooldown test waits for the hand-back; no harness behaviour changed.
- **2.24.0** (2026-10-21): Fixes from the first test run's priority lists and a second game run: what stalled a real run or let a broken game look green.
- **2.23.0** (2026-10-21): Hiring: agents are hired into departments from the CLI or the War Room, and a new role, the dev hacker.
- **2.22.2** (2026-10-21): The browser check plays bundled games: `browser.dist` serves the build folder instead of a dev server.
- **2.22.1** (2026-10-21): "Needs you" no longer shows golden-change cards for a fresh clone's history, and the "studio is idle" alarm waits for first activity.
- **2.22.0** (2026-10-21): The studio keeps itself running: the supervisor (`npm run studio:start`) starts a fresh agent per task and stops at set limits.
- **2.21.0** (2026-10-21): The Arcade (play the last good build in the War Room) and saved playable builds.
- **2.20.0** (2026-10-21): The Asset studio: every asset the art department makes, with feedback per card and rounds without waiting.
- **2.19.0** (2026-10-21): Forced work grouped by cause (`npm run causes`), from the art agent's notes and the owner's notes on the Studio view.
- **2.18.0** (2026-10-21): The browser play gate (`npm run play:browser`): plays the game start to win in Chromium with real key presses and clicks.
- **2.17.0** (2026-10-21): The art department from day one, and War Room actions that reach agents.
- **2.16.0** (2026-10-21): Pace, from precise and slow to extreme speed, sets how many agents run at once, plus a MAX SPEED lever.
- **2.15.0** (2026-10-21): Fixes from the first real game run, each reproduced first and covered by a self-test.
- **2.14.2** (2026-10-21): Preflight reported router keys that were not set: an empty `KEY=` line in `.env` borrowed the next line's value.
- **2.14.1** (2026-10-21): `npm run review`: a model from another company reviews a task's tagged commits and writes a verdict.
- **2.14.0** (2026-10-20): `npm run preflight` (checks a clone is ready for a test run) and Stop all agents (`npm run task -- stop | resume`).
- **2.13.1** (2026-10-20): `npm run hud:check` (optional gate `hud`), which opens the War Room in Chromium and uses it like a person, plus fixes.
- **2.13.0** (2026-10-20): Node and Python now hash every state alike, and determinism checks compare SHA-256, not the display hash.
- **2.12.0** (2026-10-20): A bug's regression must fail before the fix, and `system` tasks (a spec, scenario, goldens, playtest and cross-family approval).
- **2.11.0** (2026-10-20): Agent identity ("Who you are" in role cards) and player personas read by `npm run fun`.
- **2.10.0** (2026-10-20): Two-tier hashing: goldens and regressions pin SHA-256 of the canonical state; the display hash is FNV-1a 64-bit.
- **2.9.0** (2026-10-20): The Liaison, the agent the game dev talks to, and labels on the Idea Board.
- **2.8.0** (2026-10-20): The Game Bible as structured data, and Intake (about 19 questions, play length first).
- **2.7.0** (2026-10-20): "Cheap prepare, strong act" is real (`npm run brief -- <ID> --model`), and a Windows CI job.
- **2.6.0** (2026-10-20): An agent drawer in the War Room, and content-based done-checks.
- **2.5.0** (2026-10-20): Focus briefs (one page an agent reads instead of the repo) and kickoff prompts.
- **2.4.0** (2026-10-20): A model scorecard (`npm run scorecard`) and self-improving retros (`npm run retro`).
- **2.3.0** (2026-10-20): Done-checks by task type, and `--force` pings the Producer.
- **2.2.1** (2026-10-20): A dependency and tooling refresh: Node 22 and 24 supported, newer GitHub Actions, Python 3.13 in CI.
- **2.2.0** (2026-10-20): Fixes for a bypassable purity gate and over-wide isolation gate exemptions.
- **2.1.0** (2026-10-20): One-command setup (`npm run setup`) and prepare-then-escalate briefs.
- **2.0.0** (2026-10-19): A 7-module Mission Control War Room in `hub/`.
- **1.0.0** (2026-10-19): The initial public release of the generalized studio harness.
