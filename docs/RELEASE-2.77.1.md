# 2.77.1: the crew's live-run blockers (`docs/RELEASE-2.77.1.md`)

This patch is for the crew's list of 2026-11-04 ("PROMPT FOR HARNESS CLAUDE 2.77.1", with the evidence in the studio's
`studio/notes/opus-bot-harness-bugs-LIVE.md`, B-92 to B-103). Each item gets one of three statuses:

- **FIXED (commit):** the fix ships here, with the test that proves it.
- **FIXED earlier:** the evidence predates the 2.77 install on the crew's PC (14:58 UTC), and the crew's own 2.77 events
  show no repeat.
- **PARTLY / NOT FIXED:** what is left, and why.

"The crew's 2.77 events" means `.studio/events.jsonl` on studio-hatchfield from 14:58 to 18:49 UTC, 1,979 events,
read-only.

## Critical

| Item | Status | What and how it was proven |
|---|---|---|
| C1 / B-102: the supervisor exits after its first pass | FIXED (2.77.1) | Cause: `main()` ran as a top-level await. A pass imports `supervisor.mjs` back (the Communicator's needs-a-person list, self-triage, the digest), and that import waits for the module to finish loading, which in turn waits for the pass. Each pass run alone settled, so it looked like supervise() hung. Reproduced on 2.77.0 with the Communicator's webhook set: exit 13, "unsettled top-level await", nothing saved. Fix: the CLI runs in an async function; the loop is set before the first pass; passes never overlap; every step is bounded (`STUDIO_SUPERVISOR_STEP_SEC`, 300; a `supervisor.step_timeout` event); a stuck pass is reported (`supervisor.pass_stuck`); `.studio/supervisor.json` counts `passes`. qa/selftest-2771.mjs runs it for several passes, on Windows too. |
| C2 / B-99: agy builders die on "command permission auto-denied" | PARTLY | Fixed: an agy session that exits 0 on a headless denial or while idle with a background task now counts as a failed run. `--fallback` starts the next model, and the hand-back says which of the two it was. GEMINI.md (written into every agy lane) now says to run every command in the foreground and gives one test form: `npm --prefix <game folder> run test -- <test file>`. Not fixed: agy prints no text for the refused command (the crew's logs hold only the jetski line), so the harness can't log it. Untested against a real agy: the logs and the rule text are tested, the fallback path is the same code as the quota fallback. |
| C3 / B-103: beta approvals not honoured for config proposals | FIXED (2.77.1) | The config-proposal path accepted only the owner key's signature. It now accepts beta-mode and owner-proxy approvals the same way every other gate does. The decision line names which kind of approval was used. qa/selftest-2771.mjs. |
| C4 / B-100: the 2.77 merge brings unstamped commits | FIXED (2.77.1) | `upgrade --merge` now lists the update's own commits (made on GitHub, without this studio's hooks) in the hooks gate's grandfather list. The range starts from the hooks gate's own base, so merging 2.77.1 also covers 2.77.0's commits already on main. `approve -- hooks` has been in the rules `delegate -- claude-settings --owner --write` writes since 2.77.0; after this merge it isn't needed for these commits. qa/selftest-2771.mjs. |

## High

| Item | Status | |
|---|---|---|
| H1 / B-98: `train leave` doesn't stop the running train's checks | FIXED (2.77.1) | `leave` writes a cancel marker. The running train (or the speculative one behind it) stops before its next verify or re-check and ends like a train that lands nothing: lanes kept, the other lanes left queued, no hand-back, a `task.train.cancelled` event. Left: the check already running finishes first (a kill mid-step needs async spawns). qa/selftest-2771a.mjs. |
| H2 / B-83 repeat: new sessions killed by the stall check | FIXED earlier (2.76.0) | The evidence (14:22 and 14:41 UTC) is from 2.75. The real director-1 log, replayed: 2.75 reads "3,023,656 tokens" for a session that has just started, and 2.76/2.77 read 0. The crew's 2.77 events show 0 stall kills. |
| H3 / B-92 + B-97: drift off `--task`; builders refusing valid approvals | FIXED (2.77.0 + 2.77.1) | Pinning is from 2.77.0: the crew's 2.77 events show no session starting another task. New: AGENTS.md and AGENTS.lite.md say that an approval the protected check passes is the owner's, whoever recorded it (key, proxy or beta), and that builders never hand a task back over who signed one. |
| H4 / B-91 + B-96: mixed lanes; chaining from the wrong lane | FIXED earlier (2.76.0, 2.77.0) | Mixed lanes are refused (2.76.0 at the train, 2.77.0 at the launcher). A new copy carries the branch with the approved contents (2.77.0, B-96). The crew's 2.77 events show no mixed lane. |
| H5: a reused name with a leftover `.lanes/<name>` idles for an hour | FIXED (2.77.1) | The launch is refused at once: `agent.start_refused`, the folder named, and what to do (another name, or `git worktree remove --force .lanes/<name>` / `npm run janitor -- --lanes`). Nothing starts and nothing is claimed. qa/selftest-2771b.mjs. |
| H6 / B-93: approval hashes depend on line endings | FIXED earlier (2.76.0) | Approvals hash text with LF endings on both sides. The crew's 2.77 events show no "approval exists, but for different contents". |
| H7: approvals committed on a lane are invisible to the train | By design, now said | The train and the gates read approvals from the studio's main branch (a lane copy's `studio/` is main's). `approve -- protected` now says so when it writes one: commit it on main. |
| H8: an outside agent can't make a proper lane copy | FIXED earlier (2.77.0) | `npm run lane -- create <T-ID> [--from <branch>]` (P9.4). |

## Medium and low

| Item | Status | |
|---|---|---|
| M1 / B-101: misleading machine tile | see below | |
| M2: `upgrade --smoke` train step lacks `--phase` | FIXED (2.77.1) | The smoke's made-up task is `--phase 1 --prototype`. qa/selftest-2771b.mjs. |
| M3 / B-94: no first-divergence report for golden moves | NOT FIXED | It's a feature (state hashes every N ticks, PU-09), not a patch. Still planned. |
| M4: libuv assertion when `comm -- test` exits on Windows | see below | |
| M5: `studio:boot` didn't start the supervisor after it was killed | see below | |
| M6: the game gate's dynamic timeout | No change | Fixed by T-181 landing, as the note says. |

## Also in 2.77.1 (from the dev plan)

- **PU-44:** a session's permission denials are read from its own part of the agent log. Before, the agent log, which is
  appended to across sessions under one name, was read whole at every session end, so 182 of the crew's 248 denial
  records were copies.
- **PU-45:** harness messages give one command per call. Before, task done's uncommitted-work refusal suggested
  `git add <files> && git commit`, which agent shells refuse.

## Upgrade note for Patch

1. Merge it: `npm run upgrade -- --merge <harness-remote>/main --by hatch --permission "Hatch: take 2.77.1"`. The merge
   now lists 2.77.0's and 2.77.1's own commits for the hooks gate; check that `node harness/hook-stamp.mjs check` on main
   is green. Then `npm ci` and `npm run upgrade -- --smoke`.
2. Restart the supervisor once with the new code (`npm run studio:stop`, then `npm run studio:start`). After 3 minutes
   `.studio/supervisor.json` should show `passes` of 3 or more and a fresh `lastLoop`, and the Communicator should post
   again.
3. Remove the workarounds:
   - `scratchpad/supervisor-loop.cmd` and its window "Studio supervisor loop";
   - `scratchpad/after-pass.mjs` and `after-pass-loop.cmd` (window "Studio after-pass loop"), since the Communicator,
     machine scan, workaround pass and train daemon run in every pass again;
   - the "run every shell command in the FOREGROUND" line in `~/.gemini/GEMINI.md`: the launcher now writes it into each
     agy lane. Keeping it does no harm;
   - hand-starting builders: let the supervisor start them from the Line Producer's order.
   - Keep `STUDIO_RUN_T0`.
   - Close the harness tasks these fixes cover (W-0081 to W-0093's): `npm run workaround -- tasks` lists them, then
     `npm run workaround -- close <id> --by opus-1 --note "fixed in 2.77.1"` for each.
4. Retry T-197's config: `npm run task -- train config T-197 --by opus-1`. The beta approval already on main now counts.
5. Confirm the Unity path end to end: T-214 (pass 13) and T-215 (pass 14) through the engine train. Not run here: there
   is no Unity editor in this environment.
6. If an agy session still ends on a denial, its hand-back now says so, and the fallback model takes the task. Send me
   the session's log and the command Gemini was about to run (its last lines), so the allow rule can be added.
