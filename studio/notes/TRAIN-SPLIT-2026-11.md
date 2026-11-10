# Should the Unity landing train be split into stages? (`studio/notes/TRAIN-SPLIT-2026-11.md`)

Written 2026-11-10 by the harness maintainer session, on the owner's question for the round after 2.82. Nothing here
is built, except one fix to 2.82 itself that this analysis found (section 7). Every number is from the crew's own
records, read on the studio PC without changing anything: the land script's 65 result files (2026-11-01 to 11-10),
its logs and test result files, the harness's event log, and the engine repo's history. Where something could not be
measured it says UNMEASURED.

## The short answer

| Part | Verdict | Minutes saved per landing | Risk of new bugs or flakiness |
| --- | --- | --- | --- |
| 1. Rules first, outside the train | **Do it. It is 2.82; it needs two lines in the owner's `studio/game.json`.** | About 13 land-run minutes for each run that fails in the rule tests (25 of 65 did); the larger gain is that batches can pass at all (0 of 20 did) | Low. One real gap was found and fixed (section 7). |
| 2. Pipelined editor stages, a second editor | **Skip the second editor. Measure a lighter form first:** the next batch's rules check runs while the current land is in Play Mode. | Second editor: about 1 after 2.82 (Edit Mode is no longer long). Lighter form: 5 to 11 | Second editor: high (memory, timeouts). Lighter form: medium (Play Mode is timing-sensitive). |
| 3. Build off the train | **Skip.** | About 1 (0.7% of all land minutes) | Small, but it buys nothing. |
| 4. Split by what changed | **Do the safe half on Thursday** (a batch that changed no rule input reuses the target's rules result). **Measure first** for "rules-only skips Play Mode". | Safe half: 3 to 7 averaged (8 to 20 on the landings it applies to). Play Mode skip: 20 on about 1 landing in 12 | Safe half: low. Play Mode skip: real, and the records are too thin to judge it. |

Recommended order: turn on what 2.82 has (part 1), fix the shared rules pack on the game side (section 2, not one of
the four parts but the largest cause found), the safe half of part 4, then decide the lighter form of part 2 from two
weeks of stage times. Parts 3 and the second editor: not now.

The cheapest safe win is part 1, because it is already built and tested. The part that adds the most moving parts is
the second editor: a second project copy, a second 10 GB import cache, a second memory reservation and thrown-away
work, for a stage that 2.82 already shrinks to about a minute.

## 1. What the records say

65 land runs: 18 passed, 46 failed, 1 merge conflict. 3,547 minutes of land runs, 197 per landing.

| | Runs | Minutes | Note |
| --- | --- | --- | --- |
| Passed | 18 | 1,511 | 84 each |
| Failed first in the .NET rule tests | 25 | 319 | 11 never compiled (seconds), 14 failed tests (about 21 min each) |
| Failed first in Edit Mode | 7 | 485 | 69 each |
| Failed first in Play Mode | 14 | 1,231 | 88 each: Play Mode is last, so its failures pay for everything before it |

Where the minutes went, all runs: Edit Mode 1,878 (53%), .NET rule tests 1,003 (28%), Play Mode 624 (18%), build 24
(0.7%). Starting the editor costs almost nothing: in the last passing run Edit Mode took 22.6 minutes and its tests
22.4; Play Mode 20.6 and its tests 20.2. The import cache in the land script's worktree is already warm. **The time is
the tests, and the tests are slow because they run the web rules through an interpreter.** A warm editor kept between
runs would save under a minute.

Two more facts shape everything below.

**No batch ever passed.** 20 land runs were batches of 2 to 7 lanes (8 trains). All 20 failed: 14 in the .NET tests,
6 in Play Mode. Every one of the 18 landings was a single branch. The train's answer to a red batch on 2.79 is to
halve it and land again, so one bad lane costs several land runs: one train took 6 runs, one 5, one 4.

**The same tests take 20 minutes or 8.** The .NET tests took 17 to 31 minutes from 11-04 to the afternoon of 11-08, and 8.5 to 8.7 in the last
three runs of 11-08; Edit Mode fell from 53 to 23 minutes in the same three runs with the same 279 tests. On five
occasions a rule test that normally takes 80 to 190 seconds hit its 600-second limit. The crew was winding down on the
evening of the 8th (4 to 6 agents active per hour against 9 to 18 earlier), so load on the PC is the likely cause, but
this is UNMEASURED: a change in the rules pack would look the same.

## 2. Does a builder run the rule tests before queueing? Then why 25 failures at landing?

**No, nothing makes it.** The crew's how-to tells an agent that `dotnet test tools/SimTests` runs without the editor.
The harness has run a per-lane check at `task done` since 2.79, but only when `engines.unity.quickCheck` is set, and
the crew's `studio/game.json` sets neither `quickCheck` nor `preLand`. The event log holds no engine check event at
all. The land run was the first place the rule tests ran on a lane.

The 25 failures, by cause:

| Cause | Runs | What it is |
| --- | --- | --- |
| One lane that never compiled outside the editor | 9 (8 in batches, 1 alone) | Task T-427 added a class in a folder the .NET project does not compile and a test in a folder it does. `dotnet build` fails in 2 seconds on that lane alone. It was queued into three trains (the last on 2026-11-10) and turned each batch red. |
| Other compile errors | 2 | One batch, one single branch; seconds each. |
| The rules pack and the recorded results disagree | 11 of the 14 test failures | See below. 8 name the pack's hash in the failure text; 3 more fail the same replay comparisons. |
| One pinned-number test alone | 3 of the 14 | Cause not established: the pack, or the lane. |

One of the 14 also had a rule test hit its 600-second limit.

**Not stale base, not batch interaction, not random.** The rule tests replay recorded games through the packed web
rules and compare against results committed in the branch. The pack is git-ignored. The land script copies whatever
pack lies in the engine folder at that moment into its worktree. The failure text names the pack by its hash, and two
different hashes alternate through 11-06 and 11-07: the pack on disk was replaced while branches with results recorded
on the other pack were queued. A branch that is correct fails; the same commit passes later (two commits did exactly
that) once pack and results agree again. Visuals-only branches failed this way too.

This is one shared, unversioned input that every landing depends on. It is the largest single cause of rule-test
failures at landing, and no train layout fixes it. The fix is on the game side: keep packs by hash (the committed pin
names the pack a branch needs; packs live side by side under their hash; the tests load the pinned one), or commit
the pack now that the web game's repository is public. That is the owner's call and a porter's task, not harness work.

## 3. What stops a lane that passed alone from failing in a batch?

On 2.79, nothing before the land run: the land run on the merged batch is the only check, and it is the expensive one.

In the records no batch failure is a proven interaction between two good lanes. The 14 .NET batch failures are the
one lane above (9) and the pack (5). The 6 Play Mode batch failures: 4 are one test failing the same way on 11-08,
which also failed for one of the batch's lanes alone and passed for another, so a lane carried it; the other 2 are
tests that also failed on single branches.

2.82 adds the missing step. The train builds the batch as it would land, from refs, and runs the rules check on that
commit in a throwaway checkout: one run for the target (kept per target tip), one for the batch. A red batch is
narrowed with the same cheap check, not with land runs, and the lane that turns it red is handed back with the
failing tests. Cost today: 8.5 to 20 minutes per run, outside the editor. Cost once the rules are C#: seconds (the
first ported system runs 38 tests on 4,558 recorded cases in about 4 seconds).

On the records this would have refused T-427 before any of its three trains reached a land run, and those batches
would have gone on without it.

## 4. Two editors at once on this PC?

**Memory says no while a crew runs.** The harness records the peak memory of each land run: 9.7 GB median on passing
runs, 11.7 GB the highest passing, 15.2 GB the highest of any run. The PC has 31.8 GB. With the crew running today it
had 5 GB free and 41 of 62 GB of commit in use. 16 of the 17 land runs that were refused or not run were refused for
memory, and land runs waited 20 to 35 minutes for the heavy-work lock that keeps them apart from the game's own
checks. A second editor needs a second 10 to 15 GB that is not there.

**Load says it would slow both.** Section 1: the same tests already take 2 to 3 times longer on a busy PC, and six
of the seven Edit Mode failures included a time limit or an editor that ended without results. A second editor adds to the
exact condition that produces them.

- Import cache: the land script's `Library` folder is 10.2 GB. A second project copy needs its own. Disk is not the
  limit (144 GB free). The time of a first full import is UNMEASURED: no record of one exists.
- File locks: one editor locks one project folder, which is why the land script already has its own worktree. A
  second editor means a second worktree, not a second window on the same one.
- Licence: UNVERIFIED here. The licence file was deliberately not read. Unity normally lets one seat run several
  editors on one machine.

**Would a second copy drift?** The code cannot: both copies are worktrees of one repository at a named commit. What
is not in git can and does: the import cache (each copy re-imports whatever its last checkout did not have, so
changed assets are imported twice, once per copy) and the git-ignored rules pack and save, which is the failure of
section 2 with one more place to go wrong.

## 5. If A fails Play Mode while B is mid Edit Mode, is B thrown away?

If B was started on top of A: yes. Of the 32 runs that reached Play Mode, 14 failed there (44%). So speculative work
stacked on a run that is in Play Mode is wasted a little under half the time, on these records. That alone cancels
most of the gain, before the memory cost.

And after 2.82 there is little left to overlap. Edit Mode was 51 minutes because it re-ran the rule tests. With 2.82
the editor runs only the Edit Mode tests .NET does not compile (seconds of tests), so the stage a second editor would
run in parallel is about a minute long.

**The lighter form worth measuring.** The rules check needs no editor, no project copy and no licence. The next
batch's rules check can run while the current land run is in Play Mode. If the current run lands (56%), the result is
already there when the next train starts, because results are kept per tree. If it fails, one rules run is repeated.
Expected saving: 0.56 x 8.5 to 20 minutes, so 5 to 11 minutes per landing while a queue exists. The risk is Play Mode
itself: its tests are driven by frames and time (one failing test reported 37, 52, 63 and 69 overlaps in four runs of
similar code), so extra load during Play Mode may make it flakier. Measure before building: section 8.

## 6. Is skipping the build per landing safe? Is the change-based split reliable?

**Build.** 18 passing runs: 16 built, 2 skipped it. It never failed. Median 1.0 minute, 24 minutes in total. Moving
it to a nightly run saves under 1% and adds a schedule, a second way to be red and a later discovery of the things
only a player build finds (code that only compiles in the editor, stripped types, scenes missing from the build
list). It has caught nothing so far, but it costs nothing either. Leave it. Look again if it grows past 5 minutes.

**The split.** Each source was classed by the folders it changed against the target:

| | Single branches (39) | Batches (20) |
| --- | --- | --- |
| Rules and visuals both | 21 | 18 |
| Visuals only | 13 | 1 |
| Rules only | 3 | 1 |
| Docs or tools only | 2 | 0 |

Three things follow.

- It works against batching. A batch is "both" 18 times in 20. The more lanes land per run, the less often a split
  applies, and landing more lanes per run is the larger gain.
- Folder names are not reliable. T-427's class was a rule by intent and sat in a folder the rule tests do not
  compile. The reliable question is not "which folders changed" but "did anything the rules test project compiles or
  reads change", which git answers exactly.
- The two halves are not equally safe. **Visuals-only skips the rule tests** is safe by construction when it is
  decided by content: the rule assemblies have no engine references, so a change outside their inputs cannot change
  their result. **Rules-only skips Play Mode** is not: the Play Mode test assembly references the rules, and the Play
  Mode failures in the records are about what the rules drive on screen. The records hold 5 rules-only runs, none of
  which failed Play Mode. Five is not evidence.

## 7. One gap this analysis found in 2.82, fixed before merge

2.82's rules check kept its results per code tree and command. The git-ignored inputs it copies in (the rules pack)
were not part of that key. Section 2 shows that input changing between runs, so a kept "green" could have answered
for a pack it never saw, and a land script that trusts `STUDIO_RULES_GREEN` would then have skipped its own rule
tests. Fixed in 2.82 before merge: the inputs' content is part of what a kept result is valid for, and the train looks
at the inputs again right before the land run and withholds `STUDIO_RULES_GREEN` if they changed. Two new self-test
checks cover it (`qa/selftest-282a.mjs`).

## 8. What to measure on the crew's first 2.82 landings

2.82 records each land run's stages (`engine.land`, from `STUDIO_LAND_RESULT`; the land script's own result files
hold the same) and each rules check (`engine.rules`). `npm run score` prints both. Two weeks, or 30 land runs.

| Measure | Where | Decides |
| --- | --- | --- |
| Batches that land in one run (was 0 of 20) and lanes per land run | `engine.land` | Whether part 1 did its job. Target: over half of the batches. |
| Rules checks that "judge no lane" because the target is red | `engine.rules` | The size of the rules-pack problem. More than 1 in 10: fix the pack before anything else. |
| Lanes refused by the rules check, and at `task done` | `engine.rules`, engine check events | How many land runs part 1 saved. |
| Edit Mode minutes after the filter, and how often the filter found no test and fell back | stages | Target: 2 minutes or less. Confirms the editor stage is no longer worth pipelining. |
| Rules check minutes per batch, next to agents active and free memory at that time | `engine.rules`, machine scans | Whether 8 or 20 minutes is load. If load: fewer heavy jobs beside a land run beats any split. |
| Play Mode: failures per test, and whether the same commit passes on a second run | stages, result files | Real failures against flaky ones. More than 1 in 5 flaky: fix those tests before any overlap. |
| Peak memory per land run and land runs refused for memory | `.studio/engine-ram.json`, `engine.land` | A second editor stays off the table while refusals exist. |
| Share of landed batches whose rule inputs equal the target's | rules check keys | How often the safe half of part 4 applies. |
| Play Mode failures on batches that changed only rule inputs | stages plus the line above | Whether "rules-only skips Play Mode" is ever safe. Needs 20 such runs with no failure before a trial. |

Build the lighter form of part 2 only if the rules check still takes 5 minutes or more per batch after the first
systems are C#, and a trial shows Play Mode no slower than 10% with a rules check beside it. If the migration brings
the rules check under a minute first, part 2 has nothing left to save and should be dropped.

## 9. A sketch for Thursday: a batch that changed no rule input reuses the target's result

Small, and safe by construction. Not built.

- **Setting.** `engines.<x>.rules.paths`: the folders and files the rules test project compiles or reads, for example
  the rule assemblies' folders, the test folder, the test project's folder and the recorded games. The owner's file.
  Unset: today's behaviour, per whole tree.
- **Key.** In `harness/engine-rules.mjs` `runRulesAt`, with `paths` set, the kept result's key is made of git's own
  ids for those paths at the commit (`git rev-parse <commit>:<path>`, one id each), the command, and the inputs'
  fingerprint (section 7), in place of the id of the whole tree.
- **Effect.** The train already checks the target first. A batch that touches none of the listed paths has the same
  key as the target, so its check is answered from the kept result without a run, and the land run is told the rules
  are green as today. A batch that touches any of them runs as today.
- **What it must not do.** Guess the paths from folder names (section 6). A path missing from the list is the one
  way this goes wrong, so: the CLI prints which paths the key was made of; `--fresh` ignores kept results; and one
  land run a day runs everything with no filter and no kept result as the backstop.
- **Size.** About 40 lines and three self-test checks (same paths: no run; a listed path changed: a run; `paths`
  unset: unchanged).
- **Saving.** On the records 13 of 37 code-changing single branches were visuals-only: their rules run (8.5 to 20
  minutes today) disappears. Averaged over all landings: 3 to 7 minutes. It shrinks as the rules move to C#, and it
  costs nothing to keep.

## Untested

- Everything in 2.82 on a real editor and a live crew: the crew ran 2.79.2 during all 65 runs.
- That the 8-against-20-minute difference is load.
- Two editors at once, the licence, and a first full import: none was tried.
- The projections in the first table. They are arithmetic on eight days of one crew on one PC.
