# Handoff: round 2.94, the next batch is checked while the current one lands (`studio/notes/HANDOFF-2.94-2026-11-18.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-18. Release notes: docs/RELEASE-2.94.0.md. Only the
two newest handoffs and release notes are kept; older ones are in git history.

## Where it stands

- 2.93 is on `main` (`9821238`, a merge commit). The studio on record still runs 2.92; its overseer has the 2.93 note.
- 2.94 is on `claude/294`; the maintainer merges on green online checks (the owner's standing word), with a merge commit.
- `backup/pre-2.94.0` is `main` before this round.

## How the round was built

The owner answered the three open questions of 2.93 the same afternoon. Three scoped agents, each in its own
checkout: the check ahead (design, `294a`), the removal of the status snapshot and role loader (mechanical), the
scorecard's reading of "landed" (mechanical, `294c`). The maintainer merged the three and wrote the notes.

## What the next session should know

1. **`rules.ahead` is off by default and has never met a real engine.** Read the first studio trains with it on
   before building on it: the `rules_ahead` events, free memory during the land run, `minutes.rules` on the next train.
2. **Its memory number is the weak point.** It reuses `focus.splitGb` (else the measured peak, else 4 GB). If a
   studio's land runs start to die out of memory with it on, the first answer is a larger `splitGb`, not new code.
3. **The batch selection is now one function** (`pickBatch`, `laneStates` in the train) used by the train and the
   check ahead. A change to how a train picks its batch must stay in that one place, or the kept result's key will
   not be the one the next train asks for.
4. **The autonomy badge's "landed" still counts closes** (its bars were tuned on that number). The scorecards do not.
   Changing the badge is a decision about the bars, for the owner.
5. **One more load-dependent check was seen** on main after the 2.93 merge, on Windows: "a ping starts
   STUDIO_DIRECTOR_CMD once" (P-346). It passed on the same tree an hour earlier.
6. **Before a push:** units `235` and `2731c` with the static checks (P-359, P-366).
7. **The second scorecard** (`harness/score.mjs`) stays: it carries the train times since 2.93.
8. **The larger cut by evidence** still waits for a month of function records (from about 14 December).

## Open decisions for the owner

None from this round. The 64 GB of memory the overseer asked about is the owner's purchase to weigh; with it the
check ahead and a land run fit together without a memory check saying no.
