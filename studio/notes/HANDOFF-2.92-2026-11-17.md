# Handoff: round 2.92, bad news at the queue door (`studio/notes/HANDOFF-2.92-2026-11-17.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-17. Release notes: docs/RELEASE-2.92.0.md. Only the
two newest handoffs and release notes are kept; older ones are in git history.

## Where it stands

- 2.91 is on `main` (`14866c0`, a merge commit). The studio on record has not taken it; it runs the 2.90 branch commit.
- 2.92 is on `claude/292`; the maintainer merges on green online checks (the owner's standing word).
- `backup/pre-2.92.0` is `main` before this round.

## How the round was built

The studio's overnight event log was read first, then its overseer's list (two new items, both matching the log).
Scoped agents, each in its own checkout: two read-only searches for code to remove, one design build (the queue
door and the compile blame, `292a`), two mechanical builds (the red-target task `292b`; the timing checks).

## What the next session should know

1. **Read before building.** This round the maintainer briefed a tool the harness already had (`selftest:changed`)
   and nearly removed two scripts written for trimming (`scripts/settings-census.mjs`, `scripts/size-report.mjs`).
   Use them: the size report goes in each release note from now on.
2. **No safe cut was found.** The facts are in the release note's "Size" section. The four unused features listed
   there wait for the owner's yes or no. The month of function records (from about 14 December) is still the plan
   for a larger cut.
3. **The queue door queues a clashing branch on purpose.** A refusal would bounce work that only needs its partner
   to land. `train status` does not yet show a queued branch's clash; worth one line if a studio asks.
4. **`engines.<x>.logs` is off until a studio names its log files.** Without it only the land command's output is
   read for compiler errors.
5. **Two notes sit on the studio's machine for its overseer** (outside this repo): the 2.91 upgrade note with the
   corrected `rules.ignore`, and the four edits that make its land script honour `STUDIO_LAND_PROBE=1`.
6. **Do not remove test scratch folders by pattern** while other builds run (P-353). Agents were told so this round.

7. **One timing fix was withdrawn.** Making "the supervisor starts a fresh agent per task" wait for its condition
   (two supervisor runs in a row) made the next check in the unit, "--lanes auto", fail 2 runs in 8: one lane never
   got its agent. Cause not found; it may be a real race after `supervisor stop`. Worth a look before retrying.

## Open decisions for the owner

- Which of the unused features to remove.
- Should the scorecard's "landed" stop counting a close as a landing?
- May the next batch's rules check run beside a land run?
