# Studio logs

**2-minute read for the owner: the latest summary is first. Then open problems, then proposals waiting for you.**

## Latest summary — 2026-11-17 (2.92)
- **Done:** 2.91 is on `main` (no full run ahead of a waiting batch). The one studio on record still runs 2.90.
- **In progress:** 2.92 (checks at the queue door, a red compile names its branch, a red target gets a fix task) on a branch, merged when its online checks pass. Notes: docs/RELEASE-2.92.0.md, studio/notes/HANDOFF-2.92-2026-11-17.md.
- **Untested:** 2.91 and 2.92 have not run on a real engine. The studio's first trains on them are the test.
- **Open problems:** P-346 (timing checks under load: five fixed, six known left), P-005 (GPU model), P-009 (no Unity on the maintainer's side).
- **Waiting for your OK:** which unused features to remove (the list is in docs/RELEASE-2.92.0.md, "Size"); whether the scorecard's "landed" should stop counting a close; whether the next batch's rules check may run beside a land run.

## The files
| File | What | Format |
| --- | --- | --- |
| WORK-LOG.md | every task: what, how long, which tool or engine step, proof | one row per task, newest last |
| PROBLEMS.md | what happened, why, the workaround, harness fix candidate?, open or fixed | one block per problem |
| CREW-LOG.md | the Discord workflow: claims, owners, hand-offs, stalls, mistakes | one row per event, from the channel |
| PROPOSALS.md | repeated problems turned into harness upgrades, for Hatch to approve | one block per proposal |

Rules: no keys, tokens, passwords or licence files in any log. Link proof (a screenshot path, a recording, a
test result line); don't paste long output. The harness changes only when Hatch approves a proposal.
