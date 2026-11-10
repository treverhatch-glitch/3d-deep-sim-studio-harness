# Handoff: the 2.80 trim, first pass (`studio/notes/HANDOFF-2.80-trim-2026-11-10.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-10 for whoever continues on Opus 5.5.
Plan document: HARNESS_TRIM_BRIEF_2026-11-10 (the owner's). Reference only: FABLE_REPORTS_R1_R2. Evidence: the crew's
`studio/notes/USAGE-AUDIT-2.80.md` and `HANDOFF-2.80-field-notes-2026-11-07.md` (on the crew's PC, read-only for us).

## 1. Where it stands

- Branch `claude/280` = 2.80.0, built from main `3b5efe9` (2.79.2). See its pull request for the online checks.
- `git diff --shortstat 3b5efe9`: 211 files, +2,013 / −19,710 lines (net −17,697). Target was at least −15,000 net.
- Nothing was changed on the crew's PC. Patch still runs 2.79.2 with 3 local patches; the upgrade note is in
  `docs/RELEASE-2.80.0.md`.

| | 2.79.2 | 2.80.0 |
|---|---|---|
| Tracked lines | 175,491 | 157,794 |
| Code lines | 149,683 | 133,731 |
| `harness/` modules | 319 | 310 |
| npm scripts | 179 | 165 |
| Settings | 729 | 712 |
| Event types | 477 | 438 |
| Gates | 37 | 35 |

## 2. The brief's table: what was done with each row

| Row | Item | Decision | Where |
|---|---|---|---|
| 1 | React War Room leftovers | taken | part a |
| 2, 3 | War Room v3, hub server, phone/away | taken, whole `hub/` (the owner's order) | parts b1 (timers into the supervisor first), b2 |
| 4 | qa adapters, dead exports | part: `qa/cartridge-adapter.mjs`; the other adapter and the 5 exports not looked for | part a |
| 5 | one `pidAlive` / `readGltf`; fixture names out of settings | **not done** (a refactor across 17 files; next pass) | — |
| 6 | trajectories, meeting, experiment, `budget.stop` | taken except `experiment.mjs` (the commit-msg hook reads experiment tags: a hook change re-stamps every studio) | parts a, b2 |
| 7 | logic library, mutants, bench | taken | part a |
| 8 | liaison role | **not done**: the War Room chat half is gone, the role and its CLI remain (35 files name it) | b2 |
| 9 | npm aliases of cut modules | taken (179 → 165) | a, b2 |
| 10–19 | P2 (rehearsal move, ideas, 0-event features, old switches, time families, release-tag comments, PNG codec, size budget, CI guards) | not started | — |
| 20 | telemetry noise, shadow emitters | taken | part d |
| 21 | keeps (sign, floors/overnight, threads/contracts/remote, trailer) | kept | — |
| 22 | C15 godot-unit N/A | taken; C11 non-required gates skipped (the brief's call) | part d |
| 23 | launch preflight (Patch #2) | adapted: a builder on aider with no task is refused at start (A2), not Fable's code | part d |
| 24–26 | Fable R2 ports (gone-check, verify-cause, attempt ledger) | not done: the Fable trial folder isn't reachable from here and none blocks the crew | — |
| 27 | Patch's 3 local patches | 2 folded in (claim timeout, `dotnet`); `landing-score.mjs` isn't a harness file; the Blender path stays his | part a |
| 28–30, 32 | #25, #24, #18, #14 | taken | part c |
| 31 | #28 Unity no-TRX | taken | part f |
| 33, 34 | A7, A10 | taken; A9, #17, #19 not done | part d |
| 35 | #13, #20, #16, #26 | not done (each needs a judgment call with Patch) | — |
| 39, 40, 49 | N1, N3, N11 | taken | parts c, d |
| 41, 43, 44, 45, 51 | N4/N13, N12, R3-6, N6, N14 | taken | part f |
| 42 | N2 no-origin base | designed only (see 4) | — |
| 46–48, 50 | N9, N5/N7, N10, R3-15 | not done | — |

## 3. Decisions made on judgment (change them if they prove wrong)

1. **The whole hub went, not only its pages.** After the timers moved, the server had no job. `--hub` / `--no-hub` are
   accepted and ignored so no start script breaks.
2. **The hub's flow timer was not replaced**: the supervisor already runs the flow pass every loop, and the hub's
   extra (`fill: true`) returns at once when a supervisor is alive.
3. **Timed passes first run one interval after the supervisor starts** (the hub ran the watch pass 5 s after it
   started). Short-lived supervisors, and every selftest one, never run them. After a supervisor restart the first
   watch pass is 300 s away.
4. **#25, changed from the first build:** the wait is for the same lanes on the same main. The first version waited
   until main moved or fix-first recognised a fix lane, which could have held a fix it didn't recognise.
5. **#24 `lock release --owner`, narrower than the brief:** a person, a Producer/Director session, or an agent in
   `STUDIO_OUTSIDE_SIGNERS`. "Any shell the harness didn't launch" broke security test 2711b K01 (bob releasing
   alice's lock by naming her), which stays. The owner's proxy is not on the list unless it is also an outside signer.
6. **Kept though never run:** the token ledger and token norms (they measure; the owner's rule), `causes.mjs`
   (learning-edge reads it).
7. **`check-docs` skips dated records** (`studio/logs/`, `docs/RELEASE-*`). Otherwise every cut means rewriting history.
   Side effect: a commit that only touches `studio/logs/` is now "read by no check" for the train.
8. **`threads` "shadow" means off.** `studio/triggers.json` still says `"mode": "shadow"`; a studio that wants routing
   sets `STUDIO_THREADS=on` (the crew does).
9. **Protected files in the harness's own repo** (`qa/selftest*.mjs`, CI, `studio/gates.json`, `harness/cartridge.mjs`,
   `game-gates.mjs`, `qa/test-golden.py`) were edited as in every release: the repo has no owner key, so the protected
   check is not enforced here. A studio signs for them when it upgrades. Workers on cheaper models refuse these edits
   unless the brief says this in so many words.

## 4. Open items, most valuable first

1. **Upgrade the crew** at a quiet moment (Patch does it; the note is in the release doc). Watch the first hour for:
   the watch pass and watchdog lines in `.studio/logs/supervisor.log`, `lock.taken_over` events, a machine scan taken
   at a job claim on Windows.
2. **Role retirements as one unit**: liaison (approved), the Dev Hacker flow (`experiment.mjs`, `tricks.mjs`, role,
   skill, hook lines), the other never-launched roles. One PR, one hook re-stamp.
3. **One owner per decision** (brief #5): `proc-identity.mjs` for "is it alive", one `.env` parser, one reader for
   `studio/game.json` (`readGameFile` in `harness/cartridge.mjs` is the start: about 30 modules still parse it alone,
   so a byte-order mark still breaks those).
4. **N2**: in a studio with no `origin`, the protected check judges every commit since the owner-key commit. Design:
   a ref `refs/studio/protected-ok` that only a green protected check run in the main checkout advances, to the HEAD
   it just judged; the base is that ref when it is an ancestor of HEAD, else as today. A lane or CI never reads or
   writes it. Not built: it is `harness/approve.mjs`.
5. **The asset and art pipeline** (about 3,300 lines, 0 events): `asset-review` is imported by task, tiers,
   delegation, digest, brief-status and decisions-log; `asset-gate` by task and gate-fix. Unwire before deleting.
6. **Mechanical leftovers of the hub cut**: `hub/**` patterns in `tiers.mjs`, `lane-sparse.mjs`, `remote-workers.mjs`,
   `preflight.mjs`, `agent.mjs`'s frozen-lane regex and the scan lists of `settings-map` / `size-report` / `check-docs`;
   the `'war-room-human'` defaults in `task.mjs`, `agent.mjs`, `divisions.mjs`, `model-tiers.mjs`; the `hub` source in
   `threads.mjs` and `studio/triggers.json`; `verdict.mjs`'s `viaWarRoom`; `away.summary_ready` in `ALERT_KINDS`;
   War Room wording in `ROADMAP`, `PLAN`, `BLUEPRINT`, `MEMORY`, `DISCORD-CREW`, `WORK-ORGANIZATION` (~591).
   `gate-progress.mjs` writes gate times that nothing reads now.
7. **`node scripts/settings-map.mjs --prune-baseline`** would drop 25 more names from `docs/settings-baseline.json`:
   it writes the file, so review its diff.
8. Rows 10–19 and the rest of the trial list (section 2).

## 5. Risks

- Nothing here ran on Windows except GitHub's Windows shards. See "Untested" in the release doc.
- `STUDIO_BUILDER_ORDER` changes which builder kind starts: tested as functions and by source, not in a live pass.
- A studio whose own `studio/gates.json` keeps `hub-smoke` after the upgrade fails verify until synced.
- `selftest-2731c` ("detached spawns ≥ 10") has less margin with the hub's spawns gone.
- Known Windows timing flakes on CI (re-run, don't "fix"): 269q "room for 3 re-checks", "an agent that finishes ends
  cleanly", the supervisor "lanes auto" unit, the 230q drain wait, 277p "moved".

## 6. How this pass worked (keep doing it)

- Measure first, with a script, before and after every part: files, lines, npm scripts, settings
  (`node scripts/settings-census.mjs`), event types, gates, CI jobs (`node scripts/size-report.mjs`).
- One part per worktree and branch, off the same base; each worker gets a written brief (rules, exact items with their
  source numbers, what never to touch, how to test); cheaper models for reading and mechanical edits, the design model
  for cross-cutting cuts; every diff read by the best model before it merges.
- A worker's "nothing reads this" is re-checked with `git grep` before `git rm`. After each part: every relative import
  resolves, every npm script, gate and CI target exists, `node --check` on every `.mjs`, `node scripts/settings-map.mjs`,
  `node scripts/check-docs.mjs`, `node harness/gate-fix.mjs --check`.
- Tests: one shard at a time (`node qa/selftest.mjs --list-shards 1000`, then `--shard N/1000`), only the shards of
  touched files; the full run is GitHub's. A new check says in its name what fails on the previous release, and is
  proven there in a throwaway worktree.
- Rules that held: delete, don't rewrite; never soften a test of code that stays; nothing game-specific; no change on
  the crew's PC; no merge on local checks only.
