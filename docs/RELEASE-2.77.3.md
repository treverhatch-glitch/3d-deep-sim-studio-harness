# 2.77.3: the crew's 48-hour run on 2.77.1 (`docs/RELEASE-2.77.3.md`)

The crew's patch request of 2026-11-05 (B-99, B-104 to B-115, M1–M7), checked item by item against 2.77.2 and 2.78.0.
2.77.3 includes 2.77.2. Untested on the crew's Windows PC unless it says otherwise.

## Item by item

| Item | Status | What changed |
|---|---|---|
| B-104 hooks gate vs release commits | FIXED (2.77.2) | Take 2.77.2 or later with the upgrade below; then `node harness/hook-stamp.mjs check` on main should be green. |
| B-106 false "train died silently" | FIXED (2.77.2) | A train with a fresh heartbeat is alive. |
| B-107 / M3 an empty dead lane blocks launches; a launcher verify of an empty lane | FIXED (2.77.2) | An empty lane gets no launcher verify and an exited session holds nothing. |
| B-105 lane refresh after an upgrade | FIXED (2.78.0) | Not in 2.77.3: it needs 2.78's lane code. Until then, rebuild lanes by hand as before. |
| M7 (2.78 PU-56) load-sensitive tests | PARTLY | 2.77.3 adds the `port-collision` verdict (C2a below), the real cause the crew found. Holding other verifies during the "alone" re-run (C2c) is in 2.78. |
| **C1 / B-99** agy builders exit mid-task | PARTLY: ready, OFF | Stream mode: `--input-format stream-json --output-format stream-json`, stdin kept open, and at each turn end while the session's task is still in progress a follow-up ("check your background command in the foreground, then go on to `task done` or `task pause`"), at most `STUDIO_AGY_CONTINUE_MAX` (8) times after `STUDIO_AGY_CONTINUE_WAIT_SEC` (15). Safety closes: no output for `STUDIO_AGY_STREAM_IDLE_SEC` (1800) with no tool call pending, or no stream-json at all in `STUDIO_AGY_STREAM_FIRST_SEC` (180). **Off by default (`STUDIO_AGY_STREAM=1` turns it on)** because it has never run against real agy: the input message shape and the turn-end event are taken from the help text. The hand test is in docs/AGENT-TOOLS.md and the upgrade note. Reviewers, Producers and the Director keep the one-turn launch. qa/selftest-2773c.mjs. |
| **C2a / B-108** port collisions called flakes | FIXED | A `port-collision` verdict (EADDRINUSE, "address already in use", "Port N is already in use", Playwright's "is already used") names the port and says to give the test a free port. It never counts as real and is never quarantined; a train red only on collisions hands nobody back. qa/selftest-2773b.mjs. |
| C2b fixed test ports in the template | FIXED | The game gate WARNs (advisory, `game:test-ports`) on e2e tests and configs with a literal port plus strictPort or reuseExistingServer; `node harness/test-ports.mjs` lists them. New rule `studio/rules/test-ports.md`, docs/ONBOARDING-A-GAME.md. The template and example had no fixed ports. |
| C2c the "alone" re-run isn't alone | → 2.78 | Goes with PU-56's quiet re-run. |
| **C3 / B-111** beta owner records accepted, then ignored | FIXED | Two causes: in beta mode with an owner key, `task type` / `task visual` refused the orchestrator outright; and a main checkout whose origin/main was behind the key commit wrote an unsigned record ("recorded") that the train, reading the local main, ignored. Now the writers and every reader use one owner key and one predicate. A beta stand-in's type, visual or config-proposal decision is a beta approval that counts while beta mode is on, only as committed and never from a worker's commit, logged as beta. Outside beta mode with a key, an unsigned record is refused up front (exit 1, says how to get the signature), and each command reads its record back before saying it was recorded. Test files (`*.test.*`, `*.e2e.*`, `tests/`, `e2e/`) are never render files. Closed on the way: a dropped or worker-committed beta-format approval used to count. qa/selftest-2773a.mjs. |
| **H1 / B-109** the stall burn ratio counts cache reads | FIXED | The read-burn ratio counts uncached input plus cache creation only, and gives no verdict in the first `STUDIO_STALL_GRACE_MIN` (15) minutes. `STUDIO_STALL_RATIO=0` is still "off". qa/selftest-2773e.mjs. |
| **H2 / B-112** a train hangs after a "real" verdict | FIXED | Cause: after a real label the triage went on running the other failing files alone (up to 5 × 2 runs), each blocking the train, waiting up to 60 min for a heavy slot without updating the status, and labelled "real" when refused as busy. Now the triage stops at the first real label; each alone-run shows in the status and waits at most `STUDIO_FLAKE_WAIT_MIN` (10); a busy run is "not run". Backstop: a train whose status hasn't moved for `STUDIO_TRAIN_STALL_MIN` (90) gets its child processes stopped and ends the attempt (lanes kept in the queue, lock released, `task.train.stalled`); after `STUDIO_TRAIN_STALL_GRACE_S` (300) more the train process itself. qa/selftest-2773b.mjs. |
| **H3 / B-113** a task without a lane blocks every launch | PARTLY | `task add` of a builder task with no lane that can't be inferred WARNs by default; `STUDIO_REQUIRE_LANE=on` refuses. `--lane all` (or `.`) means the whole game on purpose. `task lane <ID> <folder> …` takes several folders. The supervisor's refusal names the lane-less task and the `task lane` command. The default is warn because refusing broke existing studios' task adds. 2.78 PU-60's `--scope` doesn't change the supervisor's claim. qa/selftest-2773d.mjs. |
| **H4 / B-114** stale dependency after a rescue landing | FIXED | A dependency the board closed as done (task done, a train landing or a lane merge) counts as landed, whatever an old lane branch's hashes say. A forced done or a reopen doesn't. qa/selftest-2773d.mjs. |
| **H5** the Producer undoes the orchestrator's parks | FIXED | A park records its rank: owner > orchestrator > Producer/Director > worker. Unparking (by hand, by the supervisor or by a rescue retry) needs the same rank or higher; a lower rank is refused with who parked it and why. `task park <ID> --until "<text>"` keeps a note shown in the refusal. Parks made before 2.77.3 have no rank and can be undone as before. qa/selftest-2773d.mjs. |
| **H6** allow rules for owner-proxy commands | FIXED | `delegate -- claude-settings --owner` now writes narrow rules for `node harness/hook-stamp.mjs grandfather …` and `npm run hooks -- restamp` (npm and npm.cmd); `approve -- hooks` and `approve -- force` were already there. Broad rules are still refused. Re-run `npm run delegate -- claude-settings --owner --dir <Patch's folder> --write` once. qa/selftest-2773e.mjs. |
| **M1 / B-115** a builder's stop cooldown refused a reviewer; local time | FIXED | The cooldown applies to the stopped role only; times read "07:24 UTC". qa/selftest-2773d.mjs. |
| **M2** `task add` names one missing flag at a time | FIXED | All missing flags at once, each with its allowed values. qa/selftest-2773d.mjs. |
| **M4** a reviewer ran a full verify and held a reviews lock | FIXED | `npm run verify` and the gates refuse a reviewer session; the role and review skill no longer tell it to verify. A reviewer claims its own review file, not `studio/reviews`; at commit another owner's lock in `studio/reviews` is a warning, not a refusal (`STUDIO_LOCK_NOTE_DIRS`, `off` = the old refusal). qa/selftest-2773c.mjs. |
| **M5** reload-env "hasn't answered in 15 s" | FIXED | It waits one supervisor pass plus 10 s, then says "Queued: the supervisor reloads on its next pass" (exit 0). A stopped supervisor: exit 0, the settings apply when it starts. qa/selftest-2773e.mjs. |
| **M6** builder verifies starve the train | FIXED | A train waiting for room gets the next freed heavy slot; builders wait at most `STUDIO_TRAIN_SLOT_PRIORITY_MIN` (15), then the priority lapses as long. qa/selftest-2773b.mjs. |
| **M7** playtest:stage1 passed in 32 ms | PARTLY | A stage 1 that stepped 0 ticks now fails (`QA-STAGE1-RAN-NOTHING`). A 200-tick run of a small sim can be that fast, so the 32 ms run may have been real; rerun it after the upgrade and see whether it reports its ticks. qa/selftest-2773e.mjs. |

## Untested

- C1 stream mode against real agy (off until the hand test).
- Everything on Windows: the stall watch's process kill (`taskkill /T /F`), npm.cmd for the new allow rules, the fake-agy shim.
- A full `task done --train` run for C3 (the checks use done-check, which the train reads).

## Upgrade note for Patch

1. `npm run upgrade -- --merge origin/main --by hatch --permission "Hatch: take 2.77.3"`, then
   `node harness/hook-stamp.mjs check` (green; if it lists 2.77.1's commits: `grandfather --ref origin/main`).
2. `npm ci`, `npm run upgrade -- --smoke`, restart the supervisor once (`npm run studio:stop`, `npm run studio:start`).
3. `npm run delegate -- claude-settings --owner --dir <your folder> --write` for the H6 rules.
4. The four parked tasks (T-207, T-209, T-210, T-220): redo `task type` / `task visual` once in beta mode and commit;
   they then count. Lanes released before the upgrade for a protected config proposal need `train release` again.
5. Remove the workarounds:
   - `STUDIO_STALL_RATIO=0` in .env: remove (H1).
   - `STUDIO_HEAVY_SLOTS=3` in .env: remove once the game's free-port helper (T-235) is on main; the train now gets
     slot priority (M6) and collisions are named (C2a).
   - studio/models.json Flash last, and the GEMINI.md foreground rule: keep until the agy hand test passes. Hand test
     (docs/AGENT-TOOLS.md): `agy --input-format stream-json --output-format stream-json --print-timeout 0 --mode
     accept-edits --model <gemini model>`, then paste one line
     `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Say hello, then run node --version in the foreground."}]}}`.
     It works if agy answers, prints a `{"type":"result",…}` (or other turn-end) line and waits; a second line starts a
     second turn. Then `STUDIO_AGY_STREAM=1` in .env and move Flash back first. If agy refuses the flags or ends turns
     with another line, send that output.
6. Optional: `STUDIO_REQUIRE_LANE=on` makes lane-less builder tasks a refusal (H3).
