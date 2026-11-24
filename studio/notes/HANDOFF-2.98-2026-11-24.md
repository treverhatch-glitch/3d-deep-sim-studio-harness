# Handoff: round 2.98, keep the line full and stop losing hours (`studio/notes/HANDOFF-2.98-2026-11-24.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-24. Release notes: docs/RELEASE-2.98.0.md. Only the
two newest handoffs and release notes are kept; older ones are in git history.

## Where it stands

- 2.97 is on `main` (`225f4fd`) and has run in the studio on record since 21 November.
- 2.98 is on `claude/298`; the maintainer merges it on green online checks, with a merge commit. `backup/pre-2.98.0`.

## How the round was built

The overseer's brief (17 items) came through the owner with a standing order: this is the maintainer's code base to
keep; keep it organised and take out what is no longer needed, is a duplicate, or is replaced. The maintainer read the
studio's records read-only first. Two items are the studio's own and were left there: a flaky play test of the game,
and a progress script that lives in the studio's repository, not in the harness. The overseer's uncommitted local
patch (inputs no pin uses) was built in its general form as `rules.pins`.
Eight scoped agents, each in its own checkout, then a ninth for the clean-up pass after the merge: the full land run
(design, `298a`); the queue (design, `298b`); build once (design, `298c`); peaks, times and pins (mechanical, `298d`);
checklists and split (design, `298e`); quota marks, agy and the pool (design, `298f`); disk (mechanical, `298g`);
session records (mechanical, `298h`).

## What was removed, counted

- By the parts: the whole-machine memory learning and the `rules.peak` reader (226 lines out, 150 in, over eight
  files), 49 lines of the old full-run retry path, 48 lines of duplicated closing code in `task.mjs`, the cached
  lane-copy size, the train's start-of-run config copies, two hand-written quota marks.
- By the clean-up pass over the merged code: 9 unused imports, 2 unused locals, 2 exact-duplicate pairs merged
  (`ownerPub`, `readTextLf`), 4 leftover texts. It found no other exact duplicate and no dead export.
- The harness still grew: 17 items is new behaviour. The numbers are in the release notes.

## What the next session should know

1. **Two parts rewrote the same 80 lines of the rules check** (build once; peak removal). The merge was done by hand,
   conflict by conflict, and then proved by 14 rules units. When two briefs must touch one function, give it to one.
2. **Give a brief the question, not the answer, when permissions are at stake.** The brief for agy named the folders to
   make writable; the agent found that one of them holds agy's own settings, and narrowed it. Ask "what is the least
   that lets a porter work" and require checks of what is NOT allowed.
3. **A second lane under one task id is a rewrite, not a feature**: about 150 places key engine work by the task.
   `task split` gives the same throughput. Do not start lane 2 without a plan for the queue's key.
4. **The studio's part of the full run is not done until its land script honours `STUDIO_LAND_PART`.** Until then the
   harness only stops the loop. Read the first full run in parts before anything else next round.
5. **`290b` "the second gate's script moves the target" fails when two test runs share the two cores** (P-346) and
   passes alone. It is the first thing to make deterministic when the test suite gets its turn.
6. **Still two of a kind, on purpose for now**: `--slice` beside the checklist (tasks without one), the janitor's
   manual road beside the short-disk road (the manual one does not require "landed"), two readers of limit lines
   (different inputs). Each is a candidate once the newer one has run a week.
7. **Before a push:** units `235` and `2731c` with the static checks; `unused-exports` prints `DEAD 0`.

## Open decisions for the owner

- Whether a count ratchet may land with a fix task filed (today: handed back).
- Whether `tagsWhenIdle` should stay on by default: it is what the overseer asked for, and it changes what a tag means.
- Which unused features to retire (the list with line counts is in the maintainer's roadmap).
