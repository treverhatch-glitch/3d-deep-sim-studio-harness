# Handoff: round 2.91, no full run ahead of a waiting batch (`studio/notes/HANDOFF-2.91-2026-11-17.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-17. Release notes: docs/RELEASE-2.91.0.md. Only the
two newest handoffs and release notes are kept; older ones are in git history.

## Where it stands

- 2.90 is on `main` as a merge commit (`24dfe99`). A crew took the 2.90 branch three hours before the merge and ran
  its first trains on it; its next upgrade is from `main`.
- 2.91 is on `claude/291`. The owner's standing word: the maintainer merges when the online checks are green.
- `backup/pre-2.91.0` is `main` before this round. No backup branch was made from 2.65 to 2.90; `main` was never
  force-pushed, so each of those releases is still a commit on it.

## How the round was built

The crew's logs were read first; they moved the order of the overseer's list. Then scoped agents, each in its own
checkout from `main`, merged one by one (two expected conflicts each time: the unit registrations and the generated
settings page):

- Four read-only searches (the smallest model): where full runs start, how the land run is told green, the idle stop
  and the stops, the stall rule.
- One design build (the largest model): the engine train, `qa/selftest-291a.mjs`.
- Three mechanical builds (the middle model): the idle stop and resume lines (`291b`), the stall rule (`291c`), the
  timing checks.

## What the next session should know

1. **Why the land run lost its green.** Any land script that commits its own records to the target moves it. 2.91
   keeps the green only when the studio says where those records go (`rules.ignore`). Without the setting nothing
   changes; `train status` does not yet say "a setting would have kept this green". Worth adding if a studio misses it.
2. **Focus and the land script.** A focused rules check is a weaker green (`STUDIO_RULES_MODE=focus`); a land script
   may still run its full rules tests. Moving the periodic full run out of the train makes focused checks the norm.
   That trade is the studio's, in its land script.
3. **End of train.** An overdue full land run now delays the next batch, not the current one. With a second gate it
   could run beside the first; not built.
4. **The stall rule reads only one log format** (see the release note's limits).
5. **Merging.** A branch a studio may have merged goes into `main` with a merge commit (docs/RELEASE.md).
6. **Timing checks:** TIMINGHANDOFF

## Open decisions for the owner

- Should the scorecard's "landed" stop counting a close as a landing?
- May the next batch's rules check run beside a land run (more load on the machine, a shorter queue)?
