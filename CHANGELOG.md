# Changelog (`CHANGELOG.md`)

All notable upgrades to the **3D Deep Simulation & AI Game Studio Harness** are documented in this file.

---

## [2.94.0] — 2026-11-18
The next batch is checked while the current one lands (the owner's three answers of 2026-11-18). An engine train was
one rules check, then one land run, with the next batch's lanes waiting unchecked through both.
Details: docs/RELEASE-2.94.0.md.
- **`rules.ahead` (off by default):** while a green batch's land run runs, the next batch's rules check runs beside
  it, when free memory allows. Landed unchanged, the next train finds the result and goes to its land run; otherwise
  the check ahead is ended with its process tree and nothing of it is kept. A red ahead hands nobody back.
- **"Landed" on the scorecards is work that went through a train.** Tasks closed with no landing have their own count.
- **Removed:** the old status snapshot and the role loader (`harness/status.mjs`, `harness/agents.mjs`, `npm run
  agents`). `npm run status` now prints the brief that `npm run status -- --brief` printed.
- **Size:** harness code is 229 lines smaller than 2.93 with the new check in it.

## [2.93.0] — 2026-11-18
One rules check per train, and no run of the harness's own in a land run's way (the owner's order: do the overseer's
list, clean up old code and duplicate lines). On 2.92 a live studio's trains landed what they carried, but the median
train took 209 minutes, nearly all of it tests that passed, run twice. Details: docs/RELEASE-2.93.0.md.
- **The rules check runs the batch first.** Green ends the check; the target is asked only after a red, and a kept
  result answers when there is one. A landed tree keeps its green (`rules.landGate`), so the next train starts with it.
- **A rules run started outside the train waits like a verify** and never turns full because hours are due, so it no
  longer takes the memory a land run needs.
- **Any agent can port for the engine:** `--pool api --role <role>` makes that role's lane under the next free pool
  name; an engine pass on agy gets allow-rules for its worktree; a refused or crashed start leaves a record.
- **Held, slice and duplicate:** `task after` keeps a queued branch out of a train; `train slice` marks a queued
  branch as a slice; `task duplicate <ID> --of <T-x>` closes a repeat; a `preQueue` entry can match by task title.
- **A command past its time limit is ended with everything it started** (P-360), each train records where its minutes
  went, and a session refused its tools by the tool's own permission check is not blamed on the task.
- **Removed:** the "floors" way to split work, the overnight summary, and 12 copied functions. Harness code is 6 lines
  smaller than 2.92 with all of the above in it; scripts are 19 lines smaller.

## [2.92.0] — 2026-11-17
Bad news at the queue door, not hours later (the owner's order: upgrade, and take lines away where that is right).
A live studio's trains handed back half their branches for clashes found only when the train started.
Details: the 2.92.0 release notes, in git history.
- **The compile search runs when a branch is queued**, against the target and the branches queued ahead. A clash is
  told to the porter at once; the branch is queued and trains keep the two apart.
- **The check before queueing judges the branch merged with the target**, and runs again when the target moved.
- **A land run red on a compiler error hands back the branch that changed that file** (`engines.<x>.logs`).
- **A target red by itself files one fix task**, once per distinct red.
- **One more self-test check waits for the thing itself**, not a fixed window (P-346).
- **Size:** harness code is 181 lines larger, scripts unchanged. No dead file was found to remove; a planned tool was not built because the
  self-test already has it.

## [2.91.0] — 2026-11-17
No full run ahead of a waiting batch (the owner's order: the next version, from a live studio's first day on 2.90).
A train of four small green branches took seven hours: two full rules runs and a daily full land run went ahead of
it, and the land script's record commit then cost the batch its "rules are green". Details: the 2.91.0 release notes, in git history.
- **Full runs leave the train's path.** With lanes waiting, the batch goes first. A due full run (rules or land) waits
  for an empty queue; an overdue one runs at the end of the train. `rules.focus.fullEveryMaxHours` (twice the hours).
- **A rules pass survives a record commit:** `rules.ignore` names what the rule tests never read; a target that moved
  only there (or only outside `rules.paths`) is still the checked target, for the kept result and for the land run.
- **The idle stop counts work queued for a train and landings as finished**; each resume command says when the
  other stop is still set.
- **A read of a file the task names is progress** for the stall rule, for at most `STUDIO_STALL_READ_MAX_MIN`.
- **Three timing checks no longer depend on the machine's load** (a hand-shake where a clock was compared); what
  each proves is unchanged.
- **Release rule:** a branch a studio may have merged goes into main with a merge commit, not a squash.

## Earlier releases (one line each; the full text is in git history: git log -p -- CHANGELOG.md)

- **2.90.0** (2026-11-16): The overseer's list. The rules check's time limit follows the suite; a compile error is searched with the compile command; `preQueue`, `blame`, `rules.first`; two land runs at once; slices.
- **2.89.0** (2026-11-16): Which functions a studio runs. Each harness command records the functions it called (`.studio/usage/functions/<version>.tsv`); `npm run commands-run -- --functions` shows what ran and what did not.
- **2.88.0** (2026-11-16): One reading of "landed" for every count (web train, engine train, both, closes), and one module of small helpers.
- **2.87.0** (2026-11-16): Shorter, same behaviour. One length rule for comments (9,431 lines to 5,151), one test kit for 244 test files, finished notes removed.
- **2.86.1** (2026-11-16): a run of the engine target alone that moved the target is judged by its result (a daily full run had been thrown away).
- **2.86.0** (2026-11-14): The engine train. New code takes effect (the supervisor restarts itself), engine batches by class, steps by test name, sparse porter lanes, the disk stop.
- **2.85.0** (2026-11-13): Hands off. A task waiting in a train queue is never handed back; the web train starts by itself; engine lanes land in batches with blame by evidence; the overseer's list.
- **2.84.0** (2026-11-12): Less waste. The documents an agent or a maintainer reads went from 1,672 KB to 958 KB; older log entries one line each; a record of which commands a studio runs (`npm run commands-run`).
- **2.83.0** (2026-11-11): Flow. A session is accounted where its work is; the engine train blames by evidence and a branch can land alone; the rules check runs the lanes' systems; plan passes that changed nothing are skipped.
- **2.82.0** (2026-11-10): measured, then cut: the scorecard read against a crew's log, engine land runs batched, the rules check before the land run, duplicate helpers folded.
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
