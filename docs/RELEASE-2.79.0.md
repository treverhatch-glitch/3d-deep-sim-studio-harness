# 2.79.0: a real game tester, the 2.78.2 bugs, the orchestrator signs for the owner, less fat (`docs/RELEASE-2.79.0.md`)

The crew's request of 2026-11-06 (Patch, at the owner's request) after ~8 h on 2.78.2: 39 tasks landed, trains 10–13 min,
mostly green first time, while the game itself was broken in its first five minutes. Untested on the crew's Windows PC
unless it says otherwise. Each item has a selftest that fails on 2.78.2 (`qa/selftest-279*.mjs`).

## 1. A game tester that plays the game (critical)

The roles were there (`qa-playtester`, `playtester`, `fun-tester`, the personas) but nothing launched them, and the per-task
"stage 1 playtest" played the template cartridge, not the game.

| What | Status | How |
|---|---|---|
| Plays the real build | DONE | `qa-playtester` is the game tester: an agent session started by the launcher in a lane copy. It builds the game (`studio/game.json` `"tester"`: build, dist, modes, styles, goals, areas; docs/TESTER.md), serves the build and drives it in Chromium through `qa/tester-drive.mjs` (click by test id or text, keys, drag, screenshots, console errors, game state). Every action is logged; `replay <log> --to <step>` reproduces a bug. |
| Varies the play | DONE | Each run picks a start mode, play style and goal from a seeded RNG, recorded in the run; `npm run tester -- now --seed N` repeats one. |
| New and old, and the Bible | DONE | The brief lists what landed since the last run, one rotating regression area, and every Game Bible feature, each reported as working / broken / missing / not reached. Every 3rd run (`STUDIO_TESTER_COMPARE_EVERY`) it also compares with the genre references. |
| Reports with evidence | DONE | `qa/reports/tester/<date>-r<n>/`: report, `summary.json`, screenshots, action log. Bugs become P1 tasks (deduplicated) with repro steps, images in `studio/proof/<task>/` and the replay command. One inbox line to the Producer, the Director and the orchestrator, one Studio Status line. |
| Schedule (the owner's change) | DONE | The Line Producer starts a run only when **24 h** (`STUDIO_TESTER_EVERY_HOURS`) **and 10 game landings** (`STUDIO_TESTER_MIN_LANDINGS`) have passed since the last one, plus `npm run tester -- now`. `STUDIO_TESTER=off` stops the schedule. |
| Never stops production (the owner's change) | DONE | No heavy, train or gate slot; it waits while the machine is starved or the train runs; its verdicts hold nothing (no hold, no gate, no blocked slice). |
| Two model families | DONE | `STUDIO_TESTER_TOOLS=claude,agy` alternates runs. Not changed: agy's permission flags (see Untested). |
| Wire-it tasks | DONE | A landed module nothing in the game imports gets one "Wire <module> into the game" task (P2). |
| Stage-1 template playtest | DONE | In a studio whose game has its own build or checks it is replaced by the tester ("replaced by the game tester"); template studios keep it. |

## 2. The 2.78.2 bugs

| # | Bug | Status | Fix |
|---|---|---|---|
| 1 | Queued lanes lose their copy at session end (regression) | FIXED | A copy whose task is queued (game or engine queue) is kept at session end (`lane.kept`); a process outliving its copy writes to the main studio's events; a lane folder with no `.git` is moved to `.studio/lane-leftovers/` and made again (Patch's local patch, folded in); infra hand-backs (`meta.handBackCause: infra`) don't count toward `STUDIO_TRAIN_MAX_HANDBACKS`. |
| 2 | Hand-started builders die with the shell | FIXED | `npm run agent -- start` detaches by default; `--attach` keeps it in the shell. |
| 3 | `train auto off` ignored | FIXED | One reader (`trainAuto`); the queued `task done` kick and the speculative train now honour it. A person's `task train` still runs; engine trains are separate. Which path started the 23:46 train wasn't reproduced; the kick is the likely one. |
| 4 | Train died on EPERM renaming `queue.json` | FIXED | Every train/queue state write goes through `fsafe.writeAtomic` (Windows retries). |
| 5 | Engine lands share one rules bundle | FIXED (harness side) | An engine's `"preLand"` command runs per lane before the long land and refuses with its own message (e.g. a pin check); the bisect stops at the batch's failure signature, at most `STUDIO_ENGINE_BISECT_MAX` (3) runs. The land script itself is the game's. |
| 6 | Porters can't compile before land | FIXED | `npm run engine -- check` runs the engine's `"quickCheck"` under a one-at-a-time lock; `task done` runs it for engine-porter tasks. |
| 7 | Janitor misses idle copies | FIXED | Idle copies (no session, queue, claim, changes or unlanded commits) lose their worktree after `STUDIO_LANE_IDLE_HOURS` (12); `npm run lanes -- prune --idle <h> [--dry-run]`. |
| 8 | `npm run lanes` slow | FIXED | The default list reads git metadata without a git process per copy; `--full` for ahead/behind and dirty. |
| 9 | "protected" in a passing note re-held a task | FIXED | Routing reads `meta.ownerStep`, set by the harness's own refusal; the word list is gone. |
| 10 | Approvals in a lane copy logged there | already fixed in 2.78.2 | regression check added |
| 11 | `review <ID>` from main: "no commits tagged" | FIXED | It finds the task's lane branch. |
| 12 | Divergence report never builds | FIXED | The reference builds under `.studio/tmp/` in the repo. |
| 13 | Director/review done ran the game suite | FIXED | The 2.78.2 rule also covers director and reviewer tasks with no type. |
| 14 | Quarantine "skipped" when nothing was | already fixed in 2.78.2 | regression check added |
| 15 | Asks repost every 20 min | FIXED | One post per task and subject; an ask closes itself (`ask.closed`) when its task moves on; open asks repeat only in the daily digest (`STUDIO_ASK_DIGEST_HOURS`, 24). |
| — | PID reuse (a reused PID read as a live record) | FIXED | Done-running markers and gate-run records keep the writer's start identity (`proc-identity.liveAs`). |

## 3. The orchestrator signs for the owner (beta mode)

| Who | Board decisions | Protected decisions | Asks | Release B/C holds | Second signer on goldens | Owner's own acts |
|---|---|---|---|---|---|---|
| Owner | yes | yes | all | yes | yes (not own lane) | yes |
| Orchestrator / proxy | yes | yes | all but owner-only | yes | yes, also when its only commits are merges of main | no |
| Outside signer (`STUDIO_OUTSIDE_SIGNERS` in the main checkout's `.env`) | yes | yes | all but owner-only | yes | yes | no |
| Producer / Director | yes | only with `STUDIO_PRODUCER_APPROVES=protected` | board asks | yes | yes (not own lane) | no |
| Workers (builder, reviewer, tester…) | no | no | none | no | no | no |

The owner's own acts (`harness/owner-acts.mjs`): real money, deleting data, keys and credentials, publishing outside the
PC, turning beta mode off. A release now survives a re-queue at the same head and the train's catch-up merge of main (it
is keyed on the lane's own content); a lane commit touching a released file still voids it. Merges of main are nobody's
authorship.

## 4. Engine work

Items 2.5 and 2.6 above; engine trains get their own slot (`STUDIO_ENGINE_SLOTS`) and start whenever it is free, without
`train auto off` (`STUDIO_ENGINE_WINDOW=quiet` keeps the old quiet window); a green engine land with `"shots"` saves
before/after screenshots to `studio/proof/<task>/` and `qa/reports/engine-compare/<task>.html` and posts a status line.
Engine records (backfill, "why it didn't queue") were done in 2.78.2.

## 5. Less fat

| Item | What changed |
|---|---|
| Settings | SETTINGS_LINE |
| Gates | `npm run gates -- stats [--days 7]`: runs, reds, last red, average time per gate (also in `harness-health --morning`). Over the crew's 690 verifies: game 314 reds, hooks 39, regressions 26, protected 23, godot-unit 5, secrets 5, golden 4, docs 4, purity 1; never red: isolation, playtest, weakened-tests, content-schema, holdout, journey. Only the template playtest is replaced (by the tester); the never-red anti-cheat gates (weakened-tests, holdout) stay: a gate that catches nothing because nobody tries is still doing its job. 37 gates before and after. |
| Stage-1 playtest | replaced by the tester in game studios (section 1) |
| Sign-off loops | section 3 |
| Duplicate verifies | the train already reuses a green verify of the same tree (2.69); unchanged |
| Reminder spam | item 2.15 |
| Telemetry | `gate.timeout_scaled`, `machine.sample`, `prompt.prefix.volatile` become hourly `<type>.summary` events (`STUDIO_TELEMETRY=full` for every event). The other noisy types have per-event readers and were kept. |
| Producer/Director log commits | not moved: since 2.78.2 they are board paths that neither restart a train nor block a landing |
| Owner-only relaunches | checked: a second session end naming the same owner-only step neither pages nor relaunches |
| Heavy slots | the default is RAM-aware (about one per 10 GB, at most cores/4): a 32 GB PC gets 3 with nothing set |
| API-key builders | `STUDIO_API_POOL=builder-api2,…` (names with a `STUDIO_KEYMAP_AGENT_<NAME>` entry): when every plan tool is over its weekly target or usage wind-down is on, only pool builders start; `npm run agent -- start --pool api` by hand |
| `studio:reload-env` | prints the `STUDIO_*` names the `.env` sets (names only) and flags unknown ones |

## Untested

- Everything on Windows: the lane-copy keep/recreate path with a junction `.studio`, EPERM retries on NTFS, the start-time
  query behind PID reuse, the detached tester driver, `npm.cmd`.
- A real tester session (Claude or agy) playing a real build end to end, and how well the model reads its screenshots. An
  agy tester uses the launcher's builder flags; if agy stops on a permission prompt, the owner decides whether to widen it.
- A real engine run (preLand, quickCheck, shots, the signature bisect): tested with stand-in commands.
- The 20-minute ask repost was inferred from the event counts, not reproduced.
- Owner-only asks are matched by wording and lean strict: an ask mentioning paying, publishing or deleting goes to the
  owner even when harmless.

## Upgrade note for Patch

1. Remove the local patches first: `git checkout -- harness/train.mjs` (2.79 carries the lane-folder fix).
2. A person runs: `npm run upgrade -- --merge origin/main --by hatch --permission "Hatch: take 2.79.0"`, then
   `node harness/hook-stamp.mjs check`, `npm ci`, `npm run upgrade -- --smoke`, and restart the supervisor once.
3. `npm run studio:reload-env`: check the names it lists; drop any it flags unknown.
4. `.env`: `STUDIO_HEAVY_SLOTS=3` can go (3 is now the default on a 32 GB PC). To let grokbot sign as itself:
   `STUDIO_OUTSIDE_SIGNERS=grokbot`. To bill the API builders when the plan runs low: `STUDIO_API_POOL=builder-api2,builder-api3,builder-api4,builder-api5`
   (their keymap entries stay as they are).
5. Owner (protected `studio/game.json`): add a `"tester"` object pointing at the game's build (docs/TESTER.md) so the tester
   plays the real build, not the cartridge fallback; for the engine, `"preLand"` (the pin check), `"quickCheck"` and
   `"shots"` in its engine config (docs/ENGINE-TRACKS.md).
6. First tester run on demand: `npm run tester -- now`, then `npm run tester -- status`.
