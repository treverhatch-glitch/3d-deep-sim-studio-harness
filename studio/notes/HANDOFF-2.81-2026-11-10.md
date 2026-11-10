# Handoff: round 2.81 (`studio/notes/HANDOFF-2.81-2026-11-10.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-10, after `HANDOFF-2.80-trim-2026-11-10.md`.
The owner's order: "Round 2.81: grade, upgrade, and cut the harness", with the add-on about the Fable 5.1 reports.

## Where it stands

- Branch `claude/281` = 2.81.0, on top of `claude/280` (2.80.0, pull request #81). Neither is merged: nothing merges to
  main without the owner's OK.
- Nothing was changed on the crew's PC. It was read: the event logs, the usage audit, the Fable reports and patch.
- The verdict and grades: `studio/notes/VERDICT-2.81-2026-11-10.md`. The baseline: `studio/scores/2026-11-08-baseline.json`.

## Decisions made on judgment (change them if the next score says so)

1. **The scorecard reuses `npm run autonomy` and `npm run metrics`** and adds only what they lacked. Its targets are
   in `harness/score.mjs` (`MEASURES`); a target changes only with a line in docs/SCORECARD.md saying why.
2. **The overseer's `can` answers from `delegationFor`**, the function the commands themselves use, plus two lists
   (the owner's own acts, the human-only list in `harness/overseer.mjs`). It adds no new permission; it makes the
   existing ones askable.
3. **`--changed` selects only the tests that name a changed file** by default (`--deep` for one hop through
   importers): the trial's one-hop rule selected 150 of 261 units for `ask.mjs` because `ask.mjs` matched `task.mjs`.
4. **Engine first is the default** for a studio with exactly one engine. `engine-push off` stays off.
5. **`STUDIO_WATCH_INTERVAL=0` no longer stops the watchdog or the learning passes.**
6. **The session prompt no longer carries the refresh numbers.** The launcher's ceiling (80 turns) is the limit; the
   refresh point is still measured and still raises "Check <agent>" asks. If cost per landed task (measure 4) rises
   after the upgrade, this is the first thing to look at.
7. **The attempt ledger runs in `record` mode.** `refuse` waits for its interaction with the loop park, the breaker
   and the usage-limit stop to be designed.
8. **The art pipeline stays** (not clearly unused against the goal).
9. **Fable 5.1's freeze is adopted from here:** a harness change names the scorecard measure it moves.

## Open, most valuable first

1. The owner's OK for pull request #81 (2.80.0) and the one for 2.81.0; then Patch upgrades (both release notes).
2. A week of the crew on 2.81 with the overseer in its written role; `npm run score -- --record 2.81-week1`.
3. The rig: port the trial's `rig.decision` event and engine/verify turn-taking; a Windows process-memory sampler. The
   Line now says when the machine has room the pace doesn't use; whether it may raise the count itself is the owner's call.
4. Engine lands: a porter's quick check before it queues; why 39 of 67 land runs were red (read the land logs).
5. The folds are done (`readJson` and `pidAlive` in `harness/fsafe.mjs`, the `.env` reader in `harness/dotenv.mjs`); 19
   JSON readers of other shapes and `upgrade-preflight.mjs`'s own copies are left.
6. CI: commit a timing file from a `--timing` run and switch the shards to `--balance`.
7. The cut candidates listed in docs/RELEASE-2.81.0.md section 5, and the Fable ideas not adopted (section 8).
8. The same prompt prune for the crew's own `studio/PITFALLS.md` and notes (on the PC, with Patch).

## How to check this round

`node qa/selftest.mjs --only selftest-281a,selftest-281b1,selftest-281b2,selftest-281b3,selftest-281b4,selftest-281c`
runs its own tests in a few minutes; the full self-test is the pull request's checks.
