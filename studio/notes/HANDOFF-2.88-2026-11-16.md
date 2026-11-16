# Handoff: round 2.88, one reading of "landed" (`studio/notes/HANDOFF-2.88-2026-11-16.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-16. Release notes: docs/RELEASE-2.88.0.md. Only the
two newest handoffs and release notes are kept; older ones are in git history.

## Where it stands

- 2.88 is on `claude/288-h`, built on `claude/287`. Neither is merged: the owner says when. 2.87 goes first.
- 2.86.1 (one engine-train fix, P-339) is on `claude/2861`, not merged. It was branched from 2.86.0, so whichever of
  it and 2.87 lands second merges main first (CHANGELOG.md, PROBLEMS.md and the version will conflict).
- A crew runs 2.86.0 since 14 November.

## How the round was built

- **Helpers.** A codemod on the TypeScript parser replaced a definition only when its body equalled the shared one,
  or equalled it but for one captured `const` (then a factory: `flagOf(argv)`). 21 files whose header says they
  import no harness file, and 15 files with no import at all, were left alone.
- **Landings.** Every reader of `lane.merged`, `task.train.landed`, `task.train.<engine>.landed`, `task.done` and
  `task.forced` was read for what it is for, then given a named measure. Six changed their result, each with a check
  that fails on 2.87; the rest kept theirs.

## Decisions made on judgment

1. **A studio with no lanes counts closes.** A task closed in the main checkout moves main and writes no landing
   record (the 2.58.3 done-check case). The changed reports fall back to closes when a log has no landing record at
   all, decided on the whole log read, not on a quiet window of it.
2. **The scorecard's reading was left alone.** `harness/autonomy.mjs` counts a close or a forced close as a landing
   and four measures read it. Changing it mid-series would break the comparison of rounds. It is the owner's choice.
3. **The upgrade comparison was left alone** for the same reason: old snapshots use the wide reading. Narrowing it
   needs a version field in the snapshot first.
4. **`harness/upgrade-baseline.mjs` keeps its own copy** of the reading, because it must import no harness file. A
   check holds the copy to the module.
5. **The release is larger, and says so.** One-line helpers save almost nothing (P-341); the landing fix adds a module
   and tests. The gain is that a report cannot disagree with its neighbour.

## For the next round

- If the owner wants the scorecard narrowed: print both readings for one round, then switch.
- The map's remaining small merges: the two code stamps, briefs and planning helpers, release history repeated in
  guides. Then its third step (the approval code and the protected gates), which the owner has allowed.
- A timing check failed once online on 2.86.1's first run ("task lane gives each builder its own folder", a 5 second
  window on a slow machine) and passed on the re-run. If it recurs, widen its window by `SLOW`, not by a constant.
