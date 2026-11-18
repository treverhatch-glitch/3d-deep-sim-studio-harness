# Handoff: round 2.93, one rules check per train (`studio/notes/HANDOFF-2.93-2026-11-18.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-18. Release notes: docs/RELEASE-2.93.0.md. Only the
two newest handoffs and release notes are kept; older ones are in git history.

## Where it stands

- 2.92 is on `main` (`4d78f85`, a merge commit). The studio on record runs it since 2026-11-17.
- 2.93 is on `claude/293`; the maintainer merges on green online checks (the owner's standing word), with a merge commit.
- `backup/pre-2.93.0` is `main` before this round.

## How the round was built

The studio's event log and train logs were read first, then its overseer's list of nine. Five scoped agents, each in
its own checkout: the rules check order and its kept results (design, `293a`); the API pool and agy launch (design,
`293b`); queue holds, slices, duplicates and title checks (mechanical, `293c`); removals and copied functions
(mechanical); the tree kill, train times and the tool-permission kind (mechanical, `293e`). The maintainer merged the
five, removed the last use of floors in the task gate, folded the problems log and wrote the notes.

## What the next session should know

1. **Read the first trains on 2.93 before anything else.** `train status` and `npm run score` now say where a
   train's minutes went (`minutes { total, compile, rules, wait, land }`). The target for the studio on record: a
   green batch of six in under 90 minutes. If the rules part is still over 30 minutes, the suite itself is the cost
   and the answer is in the studio's focus map, not in the harness.
2. **The batch-first order changed what many checks assert.** A future change to `rulesGate` should start from
   `293a` and the list in the release note, not from the older units' names.
3. **Nothing of agy's rule format was run on real agy.** One session's record on a studio decides; the templates are
   a setting (`STUDIO_AGY_REACH_RULES`).
4. **The pool start's 30-second death has no known cause.** If it happens again the ended record now has a
   `refusal` line; read that first.
5. **Two unused features are still in:** the old status snapshot with its role loader, and the second scorecard.
   This round added the train times to the scorecard, so removing it now would lose those lines.
6. **A cleanup removed a folder other checkouts linked to** (P-365). Before removing a checkout, look for links into it.
7. **The larger cut by evidence** still waits for a month of function records (from about 14 December).

## Open decisions for the owner

- Remove the old status snapshot and its role loader (about 480 lines)?
- Should the scorecard's "landed" stop counting a close as a landing?
- May the next batch's rules check run beside a land run? (With 2.93 a rules run outside the train waits; inside a
  train the check and the land run are still one after the other.)
