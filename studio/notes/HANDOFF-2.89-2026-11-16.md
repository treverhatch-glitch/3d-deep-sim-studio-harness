# Handoff: round 2.89, which functions a studio runs (`studio/notes/HANDOFF-2.89-2026-11-16.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-16. Release notes: docs/RELEASE-2.89.0.md. Only the
two newest handoffs and release notes are kept; older ones are in git history.

## Where it stands

- 2.86.1 is merged. 2.87, 2.88 and 2.89 are on branches stacked in that order (`claude/287`, `claude/288-h`,
  `claude/289`); the owner's word of 16 November is that the maintainer merges each when its online checks are green.
- A crew runs 2.86.0 since 14 November and is to upgrade the same evening.
- The consolidation map's remaining merges are dropped by the owner's word: the lines they save do not pay for
  their risk (2.88 came out 90 lines larger). Cutting goes by evidence of use from here on.

## Decisions made on judgment

1. **Function level, not line level.** V8 can also report blocks. Function level is cheap, its record is small (one
   row per function, a few hundred KB at most), and "this function never ran in a month" is a statement a person can
   check by reading the function.
2. **In the process, not `NODE_V8_COVERAGE`.** That variable is inherited by every Node process an agent starts, the
   game's tests and builds included: slower game checks and a file per process. The record starts inside harness
   commands only (`harness/event.mjs`).
3. **On by default.** A record nobody turns on answers nothing. The cost is about 25 ms per command; the off switch is
   one setting. The self-test runs with it off so thousands of test commands do not pay.
4. **Append, never rewrite.** Two commands ending at once each append their new rows; a row written twice is read
   once. No lock.

## For the next round

- Part two of this upgrade round is the overseer's list (the owner's word); it was not in hand when this was written.
- About 14 December: read a crew's record (`npm run commands-run -- --functions --all`) with its command markers
  (`npm run commands-run`), list what never ran, and propose the cut with each item's reason.
- The scorecard still counts a close as a landing (docs/RELEASE-2.88.0.md): the owner has not decided.
- Lessons of this round's online runs are P-343 and P-344.
