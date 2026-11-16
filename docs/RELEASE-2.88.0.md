# 2.88.0: one reading of "landed" (`docs/RELEASE-2.88.0.md`)

The owner's order of 2026-11-16: the consolidation map's second step, the low-risk merges. Built on 2.87.0. Only this
page and the one for 2.87.0 are kept; older release notes are in git history.

## What the records said

A crew's event log, ten days, a studio with a web train and an engine train:

| Reading | Tasks |
| --- | --- |
| Landed on the web main (`lane.merged`, or a lane of `task.train.landed`) | 140 |
| Landed on the engine target (a lane of `task.train.<engine>.landed`) | 186 |
| Landed anywhere (2 tasks landed on both) | 324 |
| Closed (`task.done`), landed or not | 404 |

The harness asked "which tasks landed" in about twenty places and read it five ways. A report that read only the web
records missed 57% of that studio's landings; one that read every close counted 80 planning, watch and director tasks
that landed nothing.

## What changed

| | What | Lines | Proof |
| --- | --- | --- | --- |
| One reading | `harness/landings.mjs`: a caller names its measure (`web`, `engine`, `landed` for either, `closed`, `forced`). A lane entry may be a task id or an object with `.task`. | +64 | `qa/selftest-288a.mjs`, four checks |
| Health report | Landings are distinct tasks that reached main or an engine target; the morning list names them. It counted `lane.merged` records only. | | fails on 2.87 |
| Brief status | "Landed" no longer lists a plan closed with no branch or a forced close, and lists engine landings. | | fails on 2.87 |
| Development cycle, game-dev loop | The brief's landed list and the landing step (layout check, visual results) follow landings, not every close. | | fails on 2.87, two checks |
| Score, engine flow | The landed-lanes count reads an engine whose name has a hyphen. | | fails on 2.87 |
| Same result, one reader | The crew watch, tester, hand-out order, done check, model pools, routing, whole-game check, janitor and the autonomy measures read through the module with the measure they had. | | the units that cover them |
| Small helpers | `harness/helpers.mjs`: 53 helpers that 170 files defined 323 times. A copy was replaced only where its body was the same; a variant that differs in any token is its own export. | −26 | 16 units before and after, the same lines |

A studio with no lanes or trains closes tasks in the main checkout and writes no landing record. For such a log the
changed reports count closes, as before (`landedMeasure`).

Against 2.87.0: 191 files, about 200 lines more. This step was planned as a cut; it is a correction instead.

## Not changed, for the owner to decide

- **The scorecard's "landed" counts closes.** Measures 1, 3, 4 and 15 read `harness/autonomy.mjs`, which counts a
  close or a forced close as a landing. On the log above that is 80 of 404 tasks. Narrowing it would make the
  hands-free rate and the cost per landed task stricter and break the comparison with earlier rounds.
- **The upgrade comparison (`harness/impact.mjs`, `harness/upgrade-baseline.mjs`) counts closes per hour.** Snapshots
  written by older releases use that reading; a narrower one would show a false drop on the first comparison.

## Not tested, and not done

- The callers that keep their result have no new checks of their own; the units that already cover them pass.
- Locally 93 units ran: 981 checks passed, 5 failed in two units that need 20 GB of free disk (the machine had 6).
  The online run covers every unit.
- The map's other small merges (the folder-size walk beyond the helper, the two code stamps, briefs and planning
  helpers, release history repeated in guides) are not in this release.
