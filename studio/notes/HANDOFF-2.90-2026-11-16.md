# Handoff: round 2.90, the overseer's list (`studio/notes/HANDOFF-2.90-2026-11-16.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-16. Release notes: docs/RELEASE-2.90.0.md. Only the
two newest handoffs and release notes are kept; older ones are in git history.

## Where it stands

- 2.86.1, 2.87, 2.88 and 2.89 are merged. 2.90 is on `claude/290`; the owner's word of 16 November is that the
  maintainer merges when the online checks are green.
- A crew runs 2.86.0 and is to take 2.90 in one upgrade.

## How the round was built

Three builds side by side, each in its own checkout from 2.89, then merged (one conflict: the unit registrations):
the engine train (`290b`), tasks and sessions (`290a`), status and guards (`290c`). Each item was first checked
against the code: three were already fixed (stale proposal ids in holds, a refresh counted as a hand-back, the
per-pool model switch) and got a check or nothing.

## Decisions made on judgment

1. **The finding outside the list came first.** The rules check had judged nobody for two days. Its time limit now
   follows the suite, and the silent path writes an event.
2. **A compile search before the rules check, on by default.** It adds one compile per train of two or more. The
   studio that asked already had the command set.
3. **Two land runs: the second gate only tests.** The harness never merges into an engine target; the land script
   does. So the second gate runs search steps as probes, and never the next batch.
4. **Progress is commits on the task's branch.** A session that commits and hands back is not a failure for any
   counter. The task budget still counts its minutes and tokens.
5. **An engine porter's "Port ..." names no phase and no pillar** (the web game is its spec). It stays a build task:
   same type, same done check, the port card in its brief. A builder's task with that word keeps the full gate.
6. **No git config is changed from code** for the pull trap: a warning and the one command.
7. **A game's script stays out of the harness.** The hook's refusal now says where it goes.

## For the next round

- Read the crew's first trains on 2.90: `rules_no_judge` events, the time limit each rules run used, land runs per
  landed lane, hand-backs with cause `compile`.
- Timing checks failed once each on four online runs of this round and passed on re-run (P-346): decide with the
  owner whether a shard may re-run a failed timing check by itself and report it as flaky.
- About 14 December: the record of functions run (2.89), then the cut.
- The scorecard still counts a close as a landing.
