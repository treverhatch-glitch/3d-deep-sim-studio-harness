# Studio logs

**2-minute read for the owner: the latest summary is first. Then open problems, then proposals waiting for you.**

## Latest summary — 2026-11-18 (2.93)
- **Done:** 2.92 is on `main` and the one studio on record runs it: compile clashes are found at the queue door, no studio stop and no stalled session since, 1.1 land runs per train (2.2 on 2.83).
- **In progress:** 2.93 (one rules check per train, rules runs outside the train wait, the API pool and agy as engine porters, queue holds, slices and duplicates, a time limit ends the whole tree, train times; floors and the overnight summary removed) on a branch, merged when its online checks pass. Notes: docs/RELEASE-2.93.0.md, studio/notes/HANDOFF-2.93-2026-11-18.md.
- **Untested:** 2.93 has not run on a real engine, on real agy or with a real API pool. The studio's first trains on it are the test.
- **Open problems:** P-346 (timing checks under load), P-005 (GPU model), P-009 (no Unity on the maintainer's side).
- **Waiting for your OK:** remove the old status snapshot and its role loader; whether the scorecard's "landed" should stop counting a close; whether the next batch's rules check may run beside a land run.

## The files
| File | What | Format |
| --- | --- | --- |
| WORK-LOG.md | every task: what, how long, which tool or engine step, proof | one row per task, newest last |
| PROBLEMS.md | what happened, why, the workaround, harness fix candidate?, open or fixed | one block per problem |
| CREW-LOG.md | the Discord workflow: claims, owners, hand-offs, stalls, mistakes | one row per event, from the channel |
| PROPOSALS.md | repeated problems turned into harness upgrades, for Hatch to approve | one block per proposal |

Rules: no keys, tokens, passwords or licence files in any log. Link proof (a screenshot path, a recording, a
test result line); don't paste long output. The harness changes only when Hatch approves a proposal.
