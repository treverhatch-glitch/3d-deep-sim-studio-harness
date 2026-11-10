# 2.80.0: the trim (`docs/RELEASE-2.80.0.md`)

The owner's order of 2026-11-10: keep 2.79.2, make it leaner, cut the War Room and what hangs off it, push the harness
toward running itself, keep everything that measures. Plan: HARNESS_TRIM_BRIEF_2026-11-10 (Patch's field notes, the
Fable R1/R2 reports, Grok Bot's trial), the crew's 7-day usage audit (`studio/notes/USAGE-AUDIT-2.80.md` on the crew's PC).
Every item names its source. Untested on the crew's Windows PC unless it says otherwise.

## 1. Cut

| What | Source | Why it was safe |
|---|---|---|
| The War Room and the hub server: `hub/server.mjs` (75 routes), `hub/v3/index.html` (the page), `hub/pair.mjs` (phone pairing), `harness/war-room.mjs`, `hud.mjs`, `planning-room.mjs`, `phone.mjs`, `away.mjs`, `hub-keeper.mjs`, `meeting.mjs`, `qa/hud-check.mjs`, `qa/hub-smoke.mjs`, `qa/wait-for.mjs`, `scripts/seed-demo-events`, the gates `hud` and `hub-smoke`, the CI War Room step (the job is now `browser-checks`), `docs/WAR-ROOM-V3.md`, `docs/VISUAL_HUB.md`, the npm scripts `hub`, `hud:check`, `hub:smoke`, `phone`, `away`, `meeting`, `seed:events` | the owner's order; brief #2, #3; Fable C4, C5 | the usage audit: nobody opened the pages in 7 days, 0 events from any panel, the `hud` gate never ran; the owner and the orchestrator read the studio through Studio Status, Discord and the CLI |
| The React War Room leftovers (`hub/*.tsx`, `hub/index.html`, `hub/server.js`, its package and build), `docs/WAR-ROOM.md`, the `war-room-build` CI job | brief #1, Fable C1 | replaced by the v3 page in 2.74; nothing loaded them |
| Trajectory export (`harness/trajectories.mjs`, `npm run trajectories`) | brief #6, Fable C1 | never run by the crew; the data-sharing consent record (`harness/data-consent.mjs`) stays |
| The logic library (`harness/logic-library.mjs`, `studio/logic-library/`, `npm run logic`, the `logic-library` delegable action) | brief #7, Fable C2 | 0 events in the audit; no role, kickoff or skill named it |
| The mutation report (`qa/mutants.mjs`, `npm run mutants`) and the replay bench (`harness/bench.mjs`, `npm run bench`, `docs/BENCH.md`) | brief #7, Fable C3/C8 | never run by the crew; the change records' bench field went with it |
| `budget.stop` alert kind; `scripts/daily-summary`, `start-agent-display`, `snapshot-state` (`.mjs` and `.sh`), `qa/cartridge-adapter.mjs`; npm scripts `daily:summary`, `display:start`, `hub:build` | brief #4, #6, #9 | no caller |
| The threads shadow mode (`thread.would_route`, `trigger.would_drop`, `thread -- shadow-report`) | brief #20, Fable §6c | live routing proved itself; `STUDIO_THREADS=shadow` now means off |

Tests of removed things went with them (listed in section 6). No test of code that stays was weakened.

## 2. The hub's timed jobs run in the supervisor (the owner's precondition for the cut)

`harness/studio-passes.mjs`, called from the supervisor's loop: the watch pass, retro, learn, the run report and the
Director's daily ping every `STUDIO_WATCH_INTERVAL` s (300; 0 = off), the watchdog every `STUDIO_GAMEDEV_INTERVAL` s (180;
0 = off). Each pass has its own try/catch (in the hub one throwing pass skipped the rest); each group is one bounded
supervisor step; the first run is one interval after the supervisor starts; never in a dry run. The Director's flow pass
was already in the supervisor's loop, so `STUDIO_FLOW_INTERVAL` is gone. `agent.wake` from a timed pass is now logged as
`supervisor`.

## 3. Fixes (each from a numbered finding)

| # | Fix |
|---|---|
| N1 (P0) | A stale `.studio/machine.json` (supervisor off > 15 min) no longer means "no scan, 2 test workers": the job claim takes a fresh scan and stores it. The crew's 35-minute false-red train was this. |
| Patch #24 / R3-14 | A path or task lock whose owner's launched session has ended is taken over by the next claimer (`lock.taken_over`); a person's or the orchestrator's lock never is. `lock release <key> --owner X` now acts for X for a person, a Producer/Director session or an outside agent named in `STUDIO_OUTSIDE_SIGNERS`; anyone else is refused with that rule (it was silently ignored). |
| Patch #14 / R3-7 | A manual wind-down starts nothing, paid API-pool and Vertex builders included. A usage wind-down ends when `STUDIO_USAGE_WINDDOWN_PCT` is unset (the setting is read every pass). An agent's `studio:winddown -- --now` must carry `--until <time>` and ends by itself. |
| Patch #25 | After a train finds main itself red, the train daemon waits while main's head and the queued lanes are the same (one `task.train.auto_waiting`); a moved main, a newly queued or changed lane, or `npm run task -- train` starts one. |
| Patch #18 | `STUDIO_BUILDER_ORDER` (e.g. `api,vertex,plan`): the order the supervisor fills a builder slot. Unset: as before. |
| Patch A2 | A builder on an aider-run tool (vertex, nim, aider, an owner aider tool) with no task is refused before anything is spent. |
| Patch A1, 13 | The launcher's claim step for aider waits 480 s (`STUDIO_AIDER_CLAIM_TIMEOUT_MS`), says "timed out" when it does, and hands back a claim that was recorded before the step failed. `dotnet` is on the allowlist. (The crew's local patches.) |
| Patch A10 | `ask -- show <id>` and `ask -- help` are read-only; one bare word prints the usage instead of filing an ask. |
| Patch A7 | A dry-run train writes no build status, so nothing reports it as died. |
| Patch #28 | A Unity run that wrote no results file (the editor died) is NOT RUN (retry or wait), not the lane's failure. A compile error, our own timeout and failed tests stay FAIL. |
| N3 / R3-2 | The landing build of a studio with its own game builds what `studio/game.json` `"tester"` declares, or says the game declares no build; no more "the game is the template cartridge". |
| N4 / N13 | A quarantined test file that a lane itself changes runs in that lane. |
| N6 / R3-8 | `task done --no-op "<reason>"` closes a chore (it skipped nothing before, so only `--force` worked). |
| N11 / R3-13 | `studio/game.json` saved with a byte-order mark is read; a game file that can't be parsed is said in one loud line instead of silently running the template. |
| N12 / R3-5 | `qa/test-golden.py` skips `"kind": "test"` regressions like the Node check (preflight said NOT READY). |
| N14 | `task done` says it is replaying regressions before the slow step. |
| R3-6 | The self-test's template tree no longer reads the adopted game's files into memory (a 1.1 GB game overran the buffer). |
| Fable C15 | `godot-unit` prints "N/A: no Godot project in this studio" and passes before it looks for a Godot binary. |

## 4. Less noise

`hotspot.overlap` is one event per file and set of lanes (was one per pass: 6,525 in the crew's week); `watch.report` is
written when its words change, at most hourly otherwise (2,179); the two shadow types are gone. Not replayed against the
week's log (no export here): untested as a number.

`check-docs` no longer reads dated records (`studio/logs/`, `docs/RELEASE-*`): they name the commands of their day.

## 5. New (each needed by a finding)

- `STUDIO_BUILDER_ORDER` (Patch #18: asked twice by the owner; the orchestrator hand-started paid builders every tick).
- `STUDIO_AIDER_CLAIM_TIMEOUT_MS` (the crew's local patch, made a setting instead of a constant).
- `studio:winddown -- --now --until <time>` (Patch #14).
- `ask -- show <id>` (Patch A10).
- Events `lock.taken_over`, `lock.released_for` (Patch #24: a takeover must be visible).

No other feature was added.

## 6. Tests

New, each with checks that fail on 2.79.2: `qa/selftest-280a.mjs` (3), `280b.mjs` (5), `280c.mjs` (9), `280d.mjs` (9),
`280f.mjs` (5).

Removed with the code they tested: `qa/selftest-262g.mjs` (bench), `278e.mjs` (mutation report), `274w.mjs`, `275h.mjs`,
`2582j.mjs` (hub and War Room), the hub-smoke sabotage, the logic half of `272d`, the bench half of `278f`, the P-031 React
check in `255`, the trajectory checks of the data-consent unit, the threads shadow checks in `264l` / `265r`, and the
War Room panel checks inside `230j`, `230o`, `239`, `245`, `258d`, `2601n`, `264k`, `265t`, `2731b`, `276j`, `2771c`,
`277w`, `2781g`, `pu16`, `pu17`. Changed because the behaviour changed on purpose: `268n` case 4 (a 3-hour-old machine
scan now means "scan again", so the case switches the scan off), `2601m` B-35 (the free-memory floor is the no-scan
path, so it switches the scan off too), the allowlist's entry count (15 to 16; `2585r`: 32 rules for the other agent
tool, 8 extras), `279a`'s sample
setting, the boot and new-studio checks (no hub; `STUDIO_PLAY_PORT`).

Coverage of kept code that was lost: `threads.postInbound` for `source: 'hub'` (nothing posts as `hub` now; Discord
routing is still tested).

Run before the merge: the targeted shards of every part (about 120 shard runs, all green) and the full self-test on
GitHub (Linux, Node 22 and 24, 4 shards each; Windows, 4 shards).

## 7. Size

| | 2.79.2 | 2.80.0 |
|---|---|---|
| Tracked lines | 175,491 | 157,794 |
| Code lines (mjs, js, ts, html, py) | 149,683 | 133,731 |
| Tracked files | 943 | 897 |
| `harness/` modules | 319 | 310 |
| `hub/` | 16 files, 10,592 lines | gone |
| npm scripts | 179 | 165 |
| `STUDIO_*` settings | 729 | 712 |
| Literal event types | 477 | 438 |
| Gates | 37 | 35 |
| CI jobs | 17 | 16 |

`git diff --shortstat` against 2.79.2: 211 files, +2,013 / −19,710 lines (net −17,697).

## 8. Kept on purpose

- Everything that measures or learns: telemetry, metrics, `tokens`, the token ledger and token norms (never run by the
  crew, but they are measurement), learn, retro, the run report, change records, health, the watcher and watchdog, spend
  budgets, the communicator and digest.
- The brief's keeps: Unity and remote workers, `sign.mjs`, floors and overnight, threads, contracts, the Harness trailer.
- `harness/causes.mjs` (the learning edge reads it), `alerts.mjs` (the watcher), `restart.mjs` (`studio:restart`),
  `scripts/append-event.mjs` (skills tell agents to use it), `.studio/war-room.config.json` (`status.mjs` reads it; the
  name is history).

## 9. Not in this release (next pass, in this order)

1. The liaison role (brief #8, approved; 35 files name it) and the Dev Hacker flow (`experiment.mjs`, `tricks.mjs`, the
   role, the commit-msg hook's experiment lines): role retirements as one unit, because the hook change means a hook
   re-stamp on every studio.
2. The asset and art pipeline (about 3,300 lines, 0 events), wired into `task.mjs`.
3. One process-alive helper and one `.env` parser instead of 17 and 21 copies (brief #5; several of the week's bugs were
   "two readers disagree"); one reader for `studio/game.json` (about 30 copies).
4. The protected check's base in a studio with no `origin` (N2): a marker ref that only a green check in the main
   checkout advances. Designed, not built: it is the security core.
5. Old `=off` switches nobody sets, pre-2.70 release-tag comments, unused npm aliases, never-launched roles.
6. Trial findings not done: N5/N7 (task next for outside builders, lane hint), N9 (green fixes in dead lanes), N10
   (Windows load numbers), R3-15 (self-test hermetic on Windows), Patch A9, #13, #16, #17, #19, #20, #26.
7. Splitting `train.mjs`, `task.mjs`, `agent.mjs`: not during the game week (the brief's rule 4).

## Untested

- Everything on the crew's Windows PC: the inline machine scan (PowerShell), the supervisor's timed passes in a
  multi-hour run, `studio:boot` with a start script that still passes `--no-hub`.
- `STUDIO_BUILDER_ORDER` and the manual wind-down in a live supervisor pass (their functions and the source are tested).
- A real Unity editor dying with no results file (#28); a real 1.1 GB game in the self-test's template (R3-6).
- The event drop of section 4 as a number.
- The lock takeover through an overlapping folder lock.

## Upgrade note for Patch

Do it at a quiet moment: no train running, tell the crew first.

1. Local patches: `git checkout -- harness/aider-protocol.mjs harness/allowlist.mjs` (both are in 2.80: the claim waits
   480 s, `dotnet` is allowed). The full-path Blender line is not: put Blender on PATH (`blender *` is allowed) or keep
   that one line. `scripts/landing-score.mjs` is your own file; the harness doesn't have it.
2. A person runs `npm run upgrade -- --merge origin/main --by hatch --permission "Hatch: take 2.80.0"`, then
   `node harness/hook-stamp.mjs check`, `npm ci`, `npm run upgrade -- --smoke`, and restarts the supervisor once.
   The merge changes protected files (`studio/gates.json`: `hud` and `hub-smoke` removed; `.github/workflows/ci.yml`;
   `qa/selftest*.mjs`, `qa/test-golden.py`; `harness/cartridge.mjs`, `harness/game-gates.mjs`): sign them as for every
   upgrade. If your own `studio/gates.json` still lists `hub-smoke` after the merge, verify fails until it is synced.
3. There is no War Room and no hub: stop the hub process, remove `npm run hub` from any start script (`--hub` /
   `--no-hub` on `studio:boot` and `studio:start` are accepted and ignored). `HUB_PORT`, `HUB_TOKEN`, `HUB_HOST` and
   `HUB_ALLOWED_HOSTS` in `.env` are no longer read; `npm run studio:reload-env` lists the removed `STUDIO_*` names
   (`STUDIO_HUB_*`, `STUDIO_PHONE_SECURE_COOKIE`, `STUDIO_AWAY_*`, `STUDIO_FLOOR_IDLE_MIN`, `STUDIO_PLANNING_ROOM`,
   `STUDIO_FLOW_INTERVAL`). `STUDIO_WATCH_INTERVAL` and `STUDIO_GAMEDEV_INTERVAL` are now the supervisor's.
4. What shows the studio now: `npm run studio:status`, `npm run task -- board`, `npm run tokens`, `npm run budget`,
   `npm run learn`, the Studio Status posts.
5. `lock release <key> --owner <agent>` works for you only if your name is in `STUDIO_OUTSIDE_SIGNERS`. A wind-down you
   start needs `--until <time>`. Builder order, on the owner's order: `STUDIO_BUILDER_ORDER=api,vertex,plan` in `.env`.
6. If your studio's branch protection on GitHub names the `war-room-browser` job, switch it to `browser-checks`.
