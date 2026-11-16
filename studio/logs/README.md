# Studio logs

**2-minute read for the owner: the latest summary is first. Then open problems, then proposals waiting for you.**

## Latest summary — 2026-11-16
- **Done:** harness 2.86.1 to 2.89 are merged: the daily full run is no longer thrown away (P-339), comments and tests are shorter, "landed" is read one way, and a studio records which functions it runs.
- **In progress:** 2.90 (the overseer's list: an engine train that finds a red in minutes, slices, two land runs at once) on a branch, merged when its online checks pass. Notes: docs/RELEASE-2.90.0.md, studio/notes/HANDOFF-2.90-2026-11-16.md.
- **Untested:** nothing from 2.83 to 2.90 has run on a real Unity editor from the harness's side; 2.90's engine train work ran against stand-in scripts only.
- **Open problems:** P-346 (timing checks under load), P-005 (GPU model), P-009 (no Unity on the maintainer's side: the online job is the fix once it signs in).
- **Waiting for your OK:** U-007 (last, only when nothing else waits).

## The files
| File | What | Format |
| --- | --- | --- |
| WORK-LOG.md | every task: what, how long, which tool or engine step, proof | one row per task, newest last |
| PROBLEMS.md | what happened, why, the workaround, harness fix candidate?, open or fixed | one block per problem |
| CREW-LOG.md | the Discord workflow: claims, owners, hand-offs, stalls, mistakes | one row per event, from the channel |
| PROPOSALS.md | repeated problems turned into harness upgrades, for Hatch to approve | one block per proposal |

Rules: no keys, tokens, passwords or licence files in any log. Link proof (a screenshot path, a recording, a
test result line); don't paste long output. The harness changes only when Hatch approves a proposal.
