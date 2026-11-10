# What to watch on 2.78.1 (`docs/WATCH-2.78.1.md`)

For the orchestrator (Patch) during the first long run on 2.78.1. The harness maintainer wrote it from what 2.78.1
changes and what it couldn't test here: the crew's Windows PC, real agy, the crew's own event log. Each new behaviour
below has a setting that turns it off. If one misbehaves, put that one line in `.env` and run
`npm run studio:reload-env`, note the time and the evidence, and carry on. There's no need to roll the whole harness
back.

## Before starting the 48 h clock

1. `npm run upgrade -- --preflight`: the "before a long run" section lists leftover workarounds, ready builder tasks
   with no lane, local harness patches, and runs left from before the upgrade. Clear what it lists, or note why not.
2. `node harness/hook-stamp.mjs check` should be green, release merges included.
3. Scope any builder already running without a lane: `npm run task -- lane <ID> <folders> --by opus-1`.

## Watch, in order of risk

| # | What | Healthy | Warning sign | Off switch |
|---|---|---|---|---|
| 1 | **Gemini stream mode** (new default, never run end to end on real agy) | Gemini builders run full cycles (claim, edits, verify, done or pause); `agent.agy_continue` follow-ups after background commands | `.studio/agy-stream.json` appears (`agent.agy_stream_off`: agy refused the input; builders fall back to one-turn by themselves). Sessions that end right after a turn while their task is open, or sit 30 min and get closed (the turn end wasn't seen). Many nudges in a row with no progress. | `STUDIO_AGY_STREAM=0` (one-turn launch). `STUDIO_AGY_NUDGE_MIN=0` turns off just the nudge. |
| 2 | **More builders at once** (B-123: board lanes, Line Producer lanes, side-by-side laneless builders) | Builders running gets close to the target; the Planning Room's "unscoped" list stays short | Two builders that ran side by side conflict at the train (merge conflicts, overlap re-checks). Lanes the Line Producer set that are clearly too narrow (builders hand back "outside my lane") or too wide (everything waits). | `STUDIO_UNSCOPED_PARALLEL=off` (laneless builders one at a time again). `STUDIO_LINE_LANES=report` (Line Producer only reports unscoped tasks). |
| 3 | **Stacking on shared sim code** (`--after`) | Tasks touching the core sim files queue behind each other; others run | Builders idle because most ready tasks got stacked. The default shared-file list is generic and may not fit the game. | `STUDIO_SHARED_SIM=off`, or set it to the game's real core files (globs). |
| 4 | **Heavy slots and Unity** (the live `.env` slot count, Unity's own slot, give-way) | Game trains verify without waiting behind Unity; Unity lands run between game trains | A Unity land that waits for hours because game trains never stop verifying. `STUDIO_HEAVY_SLOTS` now really applies to every session, so a low value can starve builders. | `STUDIO_ENGINE_SLOTS=off` (Unity shares game slots as in 2.78.0). `STUDIO_HEAVY_SLOTS_LIVE=off`. |
| 5 | **Chain-breaker hold** | A queued chain-breaker's train gets a quiet machine and lands | New builder verifies held up to 60 min while a chain-breaker waits | `STUDIO_LINE_CHAIN_HOLD_MIN=off` |
| 6 | **Trusted load-sensitive landings** (a known load-sensitive test that passes alone at low load lands without the quiet wait) | `task.train.load_sensitive` with "trusted" only for tests that really are timing-flaky | A "trusted" test that then fails on main, or keeps failing in later trains: it may be a real regression | `STUDIO_LOAD_SENSITIVE_TRUST=off` |
| 7 | **Tasks closing by themselves** (`task.train.empty_diff`, `task.train.main_merges_only`, B-114 dependencies counting as landed) | Close-outs and merge-of-main-only lanes close; "waiting on T-…: not merged" goes away for landed work | A task closed whose work isn't actually on main | `STUDIO_TRAIN_EMPTY_DIFF=off`, `STUDIO_TRAIN_CLOSE_MAIN_MERGES=off`, `STUDIO_DEP_LANDED_EVIDENCE=off` |
| 8 | **The orphan reaper** (`gate.orphan_ended`) and the train stall watch (`task.train.stalled`, 2.77.3) | Only truly orphaned gate runs are ended, and only hung trains are stopped | A live verify or a long Unity gate ended (check the event's pid, age and command) | `STUDIO_ORPHAN_GATE_MIN=off`; `STUDIO_TRAIN_STALL_MIN` higher (90 by default) |
| 9 | **Fresh sessions** (reviewers and engine-porters refresh at 70k; a builder red on a new cause restarts fresh) | Refreshes carry the lane, commits, last verify and next command in the hand-off; the new session continues from there | A builder refreshed over and over on a run of different reds without progress | `STUDIO_REFRESH_ON_NEW_RED=off`; `STUDIO_SESSION_CONTEXT_EARLY=120000` |
| 10 | **After an upgrade** (B-122, B-116) | A train from before the upgrade finishes its own lanes and starts nothing (`task.train.chain_stopped`); the daemon takes the queue | A queue that nobody picks up after `chain_stopped` | `STUDIO_TRAIN_HARNESS_GUARD=off` |
| 11 | **Playtest stage 1** | `[playtest] … stepped N ticks of <cartridge>` on every run | `WARN QA-STAGE1-NOT-THE-GAME` on lanes is expected (stage 1 plays the template there); count how often | Warn only by default; `STUDIO_PLAYTEST_GAME_CHECK=off` silences it |

## Quick checks every few hours

- Builders running vs target, and the unscoped list (Planning Room, or `npm run line -- status`).
- The events above: `npm run events -- tail --type <type> --n 20`, or search `.studio/events*.jsonl` for the type.
- `npm run lanes -- orphans`: finished work stuck on a lane; carry it with `npm run lanes -- carry <ID> --by opus-1`.
- Hand-backs per hour, and their reasons (were any caused by the harness rather than the work?).

## Send back after the run (no keys, no .env values)

- Each warning sign you hit: the time, the event lines and the exact error text, as in your bug notes.
- Which off switches you set, and why.
- Landed per hour, peak and average builders, hand-backs and their causes, any train stuck over 30 min.
- For the 2.79 cleanup: the list of `STUDIO_*` names set in `.env`. Names only, never values.
