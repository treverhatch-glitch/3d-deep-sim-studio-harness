# Studio logs

**2-minute read for the owner: the latest summary is first. Then open problems, then proposals waiting for you.**

## Latest summary — 2026-11-18 (2.94)
- **Done:** 2.93 is on `main` (one rules check per train, rules runs outside the train wait, the API pool and agy as engine porters, queue holds, slices and duplicates, a time limit ends the whole tree). The one studio on record still runs 2.92; its overseer has the upgrade note.
- **In progress:** 2.94 (the next batch's rules check beside the land run, as a setting; "landed" on the scorecards is train work only; the old status snapshot and role loader removed) on a branch, merged when its online checks pass. Notes: docs/RELEASE-2.94.0.md, studio/notes/HANDOFF-2.94-2026-11-18.md.
- **Untested:** 2.93 and 2.94 have not run on a real engine, on real agy or with a real API pool. `rules.ahead` is off by default for that reason.
- **Open problems:** P-346 (timing checks under load), P-005 (GPU model), P-009 (no Unity on the maintainer's side).
- **Waiting for your OK:** nothing from this round.

## The files
| File | What | Format |
| --- | --- | --- |
| WORK-LOG.md | every task: what, how long, which tool or engine step, proof | one row per task, newest last |
| PROBLEMS.md | what happened, why, the workaround, harness fix candidate?, open or fixed | one block per problem |
| CREW-LOG.md | the Discord workflow: claims, owners, hand-offs, stalls, mistakes | one row per event, from the channel |
| PROPOSALS.md | repeated problems turned into harness upgrades, for Hatch to approve | one block per proposal |

Rules: no keys, tokens, passwords or licence files in any log. Link proof (a screenshot path, a recording, a
test result line); don't paste long output. The harness changes only when Hatch approves a proposal.
