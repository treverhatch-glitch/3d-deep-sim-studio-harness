# 2.82.0: native engine (`docs/RELEASE-2.82.0.md`)

The owner's order of 2026-11-10 ("Round 2.82: native Unity"): make the engine the fast main path, with a bar that can
be measured on the scorecard. Built on 2.81.0. Everything about a real Unity editor, Windows beyond the pull request's
checks, and a live studio is UNTESTED here and says so below.

## 1. What the records said first

Before building, the crew's own Unity landing records were read (64 land runs, 2026-11-01 to 11-08, one PC):

| | |
| --- | --- |
| Land runs that passed | 18 of 64 (45 failed, 1 merge conflict) |
| A passing run, median | 92 min: .NET rule tests 19, Edit Mode 53, Play Mode 20, build 1 |
| First stage that failed | .NET rule tests 24 (10 of them before any test ran), Play Mode 14, Edit Mode 7, merge 1 |
| Edit Mode | re-ran the rule tests the .NET stage had just run; the tests .NET doesn't run took seconds |
| From the harness's event log | 67 land runs, 11 lanes landed, 3,524 machine minutes: 320 per landed lane; 25% of runs refused or not run, 16 of those 17 for free memory |

So the two largest costs needed no new engine feature: failures that a test without the editor would have caught
were found by hour-long land runs, and the editor spent most of its time repeating tests.

## 2. What was built

| | What | Where |
| --- | --- | --- |
| Native-engine mode | A studio whose game is the engine build (`studio/game.json` `"native": "<engine>"`, or one engine and no web game) builds a feature once: builder tasks go on the engine track, and the web tester schedule, the web landing build, engine twins and the port queue are off. The planning roles' kickoffs say so. | `harness/native.mjs`, docs/NATIVE-ENGINE.md |
| The rules check before the land run | The engine train runs the engine's cheap rules tests on the batch as it would land, in a throwaway checkout. A lane that turns it red is handed back with cause `rules` and the failing tests, found by narrowing with the cheap check instead of land runs. A check that is red on the target itself judges nobody. Results are kept per tree. Unity default: `dotnet test tools/SimTests` when the target has it. | `harness/engine-rules.mjs`, `harness/unity-train.mjs` |
| The land's stage report | A land command writes what each stage took to `STUDIO_LAND_RESULT` (or prints `[land-stage]` lines); the stages go on the `engine.land` event. | `harness/unity-gate.mjs` `landStages` |
| Edit Mode once | A Unity land script is told which Edit Mode test assemblies the editor still has to run after its .NET tests passed (`STUDIO_UNITY_EDITMODE_ARGS`), and gets `STUDIO_RULES_GREEN=1` when the harness ran the rules green on exactly that batch. `node harness/unity.mjs editmode-plan <project>` prints the same. | `harness/unity.mjs` `editModePlan` |
| The engine flow on the scorecard | Land-run minutes per landed lane, shares passed and refused (and how many waits were for memory), the share of minutes in red runs, stage medians and where red runs failed first, and what the rules check refused. | `harness/score.mjs` `engineFlow` |
| The design link on the scorecard | The share of done tasks that trace to a Bible pillar, a kept layer, an approved idea or the owner's own ask, and the done work by what it serves: whether the landed work still follows the owner's design, round by round. | `harness/score.mjs` `visionFlow` |
| One role file for engine work | In a native studio a builder on the engine track is pointed at the engine porter's role file, and a builder task on the pushed engine's track heads the Line Producer's plan like a porter's. One cheap-check setting: with no `quickCheck`, the owner's `rules` command is the porter's check too. | `harness/native.mjs`, `harness/line-producer.mjs`, `harness/engine-check.mjs` |

Also in this release, from the last checks of 2.81.0 on Windows: the attempt ledger compared the checkout's path in a
way Windows spells differently (short names, slashes, case) and recorded no main tip. (The supervisor's sequence
test, red on and off on Windows since 2.79, was fixed in 2.81.0 itself: it keeps the timed jobs and machine probes out
of its loop, as `--no-hub` did before 2.80.)

**Fixed before release (P-299).** The rules check kept its result per tree and command, but the git-ignored inputs it
copies in were not part of that key. The crew's records show that input (the packed rules) changing between land
runs, so a kept "green" could have answered for inputs it never saw. Now the inputs' content is part of what a kept
result is valid for, and the train looks at them again right before the land run and leaves `STUDIO_RULES_GREEN` out
when they changed. Found while answering the owner's question about splitting the train
(studio/notes/TRAIN-SPLIT-2026-11.md).

**Fixed before release (P-300).** With the owner's `rules` command and no `quickCheck`, a porter's `npm run engine --
check` ran that command in the lane's own folder. The rules' git-ignored inputs are not there, so a good lane could
read red. It is now the rules check itself on the lane's commit as it would land: a throwaway checkout, the inputs
copied in, the target checked first, skipped when it cannot judge. `task done` is unchanged: it runs an engine check
only when `quickCheck` is set, so a studio that sets `quickCheck` runs the same code as before this fix.

## 3. The scorecard: before, and what "after" can honestly say

The fifteen measures are unchanged from the 2.81 baseline (this round ran no crew). The two new blocks, counted on the
same log (`studio/scores/2026-11-08-engine-baseline.json`):

| Engine flow, 2026-10-31 to 11-08 | |
| --- | --- |
| Land runs, lanes landed | 67, 11 |
| Land-run minutes per landed lane | 320.3 |
| Land runs that passed | 16.4% |
| Refused or not run | 25.4% (495 min waiting; 16 of 17 for free memory) |
| Minutes spent in red runs | 53% |
| A passing run, a red run (median) | 101 min, 27.4 min |

| Design link, same window | |
| --- | --- |
| Done tasks that trace to a pillar, a kept layer, an approved idea or the owner's ask | 57.3% of 358 |
| Asked for by the owner; proposed by agents | 7.8%; 92.2% |

**After.** No land run has happened on 2.82, so there is no measured "after" for the engine flow. What the records
allow, as a projection and not a measurement: with Edit Mode running only what .NET did not, a passing land run drops
from about 92 to about 41 minutes (19 + about 1 + 20 + 1), and the 64 recorded runs would have used about half of
their 3,547 minutes. The first week of the crew on 2.82 gives the real number:
`npm run score -- --record 2.82-week1`, read against the table above.

## 4. Cut and folded

| | Lines | Note |
| --- | --- | --- |
| One cheap-check setting (`rules` also serves the porter's quick check) | fold | no setting removed |
| Engine porter and builder in a native studio | fold | one role file for engine work; the porter role stays for studios that port |

Not cut, with the reason. `harness/token-norms.mjs` and `harness/ledger.mjs` (382 lines) have no production importer
and their numbers are in `npm run score`, `metrics` and `tokens`; the owner's rule in 2.80 was to keep measurement, so
they stay until the owner says otherwise. `floors`, `whole-game`, `ideas` and `waves` (743 lines) were checked again:
each is called from the running loop (the supervisor, the watchdog, the watch pass, `task done`), so none is a leaf.
`closed-loop.mjs` (137) is CI's release gate. The rehearsal pair (138) is reached only with `STUDIO_REHEARSAL=1` and
is used by two self-tests.

## 5. Size

2.82.0 against 2.81.0: 27 files, +1,951 / −58 lines (net +1,893). This round adds and cuts nothing of size: harness
code +637 / −11 (two new modules, `native.mjs` 93 and `engine-rules.mjs` 234, and the scorecard's two blocks), the
self-test +391 / −1, docs, notes and records +923 / −46.

| | 2.79.2 | 2.80.0 | 2.81.0 | 2.82.0 |
|---|---|---|---|---|
| Tracked lines | 175,491 | 157,794 | 159,485 | 161,378 |
| `harness/` modules | 319 | 310 | 314 | 316 |
| npm scripts | 179 | 165 | 165 | 165 |
| `STUDIO_*` settings | 729 | 712 | 716 | 726 |
| Literal event types | 477 | 438 | 430 | 431 |
| Gates | 37 | 35 | 35 | 35 |

## Untested

- Native mode, the rules check, the stage report and the Edit Mode plan with a real Unity editor, a real land script
  and a live studio. The self-test uses a made-up engine repo and stand-in commands.
- `-assemblyNames` on the editor's command line (the Unity Test Framework documents it; nothing here ran it).
- Everything on Windows beyond the pull request's checks.
- The projection in section 3.

## Upgrade note

- A studio that is not native sees three changes: the Unity train runs `dotnet test tools/SimTests` on a batch before
  the land run when the target branch has that folder (`"rules": false` in `studio/game.json` `engines.unity`, or
  `STUDIO_ENGINE_RULES=off`, turns it off; a check that is red on the target itself is skipped with the reason); a land
  command gets three more environment variables; `npm run score` prints two more blocks.
- Tests that read git-ignored inputs: name them in `engines.<x>.rules.inputs`, or the check is skipped as "red on the
  target".
- Native mode is off until `studio/game.json` says `"native": "<engine>"` (the owner's file) for any studio with a web
  game.
