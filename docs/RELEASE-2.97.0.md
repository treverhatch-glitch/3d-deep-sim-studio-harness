# 2.97.0: what a day on the real machine showed (`docs/RELEASE-2.97.0.md`)

The overseer's brief of 2026-11-20 (7 items), written after the studio on record had run 2.96.0 for a day, with the
owner's standing order: keep the code base, add to it, trim where the records back it. Built on 2.96.0. Only this page
and the one for 2.96.0 are kept; older release notes are in git history.

## What the records said

- 2.96 worked: 18 tasks landed in about 8 hours against 6 to 8 a day before; a train without Play Mode took about 70
  minutes; the sharded rules check about 35; sampling found one shard at 12.5 GB with every other at 1.3 GB or less.
- One train's green check was thrown away: a session edited the lane copy of a lane in that train, the land run ran the
  whole rules stage again (about 50 minutes), and the check ahead never started. Nothing said why.
- Two lanes listed under `merge.union` were still deferred. The rule had run and refused, silently: both lanes
  lengthen the same one-line list, and the rule took added lines only.
- The learned memory floor of a land run (18.8 GB) came from runs with a stage this run skips. It was refused after 35
  minutes; the overseer tuned the floor by hand.
- 16 of 41 shards finish inside one sample interval and were stored as a peak of 0 GB.
- A train that had started 30 seconds before an upgrade waited on the drain, then ran the old release's modules over
  the new files. The upgrade itself merged a branch as last fetched hours before.

## What changed

| | What | Proof |
| --- | --- | --- |
| The green is judged by what lands | Inputs from a lane copy are read at the lane's commit (`git ls-tree`, `cat-file`), never from its working files. A batch landed through the train's own branch keeps its green whatever happens in a lane copy. A branch landed by name that moved after the check loses it, and the log says so. | `297a` |
| A green that is not used says why | One line: the batch changed, the target moved in files the tests read, an input changed (named, with where), a branch moved, a full land run is due; "it runs its own rules stage". | `297a` |
| The check ahead says what it did | With `rules.ahead` on, every land run logs that the check ahead started or why not. The last outcome is kept and `rules show` prints it: `check ahead (rules.ahead): on; last: did not start: <why>, train <id>, <time>`. | `297a` |
| A line both lanes only lengthen | `merge.union` also merges a line that each side made longer by one insertion: ours' text, then theirs'; the same insertion once. A rewritten line stays a conflict. | `297b` |
| A refused union says why | The lane's `why` ends with `merge.union did not apply: <file> line <n> was rewritten, not only lengthened`, or names the conflicted file that is not listed. | `297b` |
| The floor of the kind | A land run waits for the need of the kind it is about to run (`land no-rules play-skip`, `land with-rules play-full`...): the peak of that kind's passed sampled runs plus `STUDIO_ENGINE_RAM_MARGIN_GB`. The owner's setting and a tuned `ram-floor` still win. The wait line names the kind. | `297c` |
| Too short to sample | A run with no sample row is stored `gb: null, short: true`; 2.96 entries of `gb: 0` with no samples read the same. A kind with only such runs has no measured need: admission uses the plan's number and says "too short to sample". | `297c` |
| A red first test, by its own words | With no blame entry, a red `rules.first` reads its failure text: a folder or file name that only one lane of the batch changes makes that lane the first suspect (left out, the test run without it, put back in turn). None or all: the search as before. `rules.first` now also reaches `blame` entries with `names`, which it never did. | `297e` |
| A drain means no new train | `task train`, the daemon's `run`, `task done`'s own train and the Line Producer's engine window start nothing while the drain is on (exit 3 and one line). `drain off` starts the waiting web train. | `297d` |
| A train on the code it loaded | As a train takes its lock it compares the harness it loaded (version, and the trees of `harness/` and `scripts/`) with the one on disk. Changed: it starts the same command again as a new process, once (`STUDIO_TRAIN_RESTARTED`), and exits. | `297d` |
| The upgrade fetches first | `--merge <remote>/<branch>` fetches that branch and prints the commit it will merge. A failed fetch merges nothing (`--no-fetch` takes the copy that is here). A branch other than the remote's main needs `--not-main`. | `297d` |

## What was removed, and what was not

- Removed in passing: the 2.90 copy of the blame road for `rules.first` (it now uses the 2.96 one), three copies of
  the lane-folder lines, one of two per-file digest loops, `rulesGreen.same()`. About 100 lines.
- Not removed, and why: the old whole-machine learning of the land floor (`recordLandPeak` and friends). Split
  planning and part memory still read it, and a studio with sampling off has nothing else. One day of samples does
  not back removing `rules.peak` either: that waits for a week in which sampled peaks match it.

## Size, said plainly

`node scripts/size-report.mjs --against <2.96>`: harness code is 271 lines larger (87,347 to 87,618), one module more
(`harness/train-gate.mjs`). Tests 754 lines larger (five new units). One setting name more (`STUDIO_TRAIN_RESTARTED`,
set by the harness itself). This round adds more than it removes.

## Existing checks changed on purpose

- `260c`: its merges of a release branch now pass `--not-main`.

## Limits, said plainly

- **Nothing here ran on Windows, a real engine or a real test suite before the online checks.** Untested on Windows:
  the detached restart of a train through inherited log files, and the follower switching to the new process.
- **Only the web train's restart has a check.** The engine train and the daemon's `run` use the same code.
- **`task done` during a drain** exits 3 where it waited before, when it would run its own train. In a lane it queues
  as before and no train starts.
- **Engine queues after `drain off`** get their train at the Line Producer's next pass; with no supervisor, a person
  starts it, as before.
- **The union of a lengthened line cannot know meaning.** `x = 1` made `x = 12` by one lane and `x = 13` by another
  merges to `x = 123`. It applies only to files a studio lists; the compile check and the tests decide.
- **The first test's own words can name the wrong lane** (a top folder only one lane touches that every failure
  mentions). That costs one run of the first test and is never a hand-back by itself.
- **A kind with no passed sampled run** still falls back to the old learned number, and the line says so.
- **A one-lane batch whose branch moved after the check loses the green** even when the inputs are the same.
- `290b` "the second gate's script moves the target" failed once under load and passed alone (P-346).
- **Caught in the online runs:** a `rules show` line had lost a space an older check reads (`284m`). On Windows,
  `293b` "record" failed twice in the full run and never alone: `laneLive` with a window of 0 could still call a
  lane in use for a few milliseconds (P-384). Fixed as the likely cause; the state itself was not caught.

## For a studio taking it

`npm run upgrade -- --merge origin/main`, between trains. Everything is on by itself; there is no new setting. A
tuned `ram-floor` set as a workaround can be removed once `rules show` lists passed runs for the land kinds in use
(`npm run engine -- tune <engine> ram-floor --unset --by <you> --why "..."`, or leave it: it wins).
