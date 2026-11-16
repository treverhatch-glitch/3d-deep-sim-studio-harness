# Studio logs

**2-minute read for the owner: the latest summary is first. Then open problems, then proposals waiting for you.**

## Latest summary — 2026-11-17
- **Done:** harness 2.90 is merged and a crew runs it. On a real engine its compile search put two clashing branches out in one minute and the test run first named a stale-pin branch in minutes.
- **In progress:** 2.91 (no full run ahead of a waiting batch; a rules pass that survives a record commit; the idle stop, the two stops and the stall rule) on a branch, merged when its online checks pass. Notes: docs/RELEASE-2.91.0.md, studio/notes/HANDOFF-2.91-2026-11-17.md.
- **Untested:** 2.91's train rules ran against stand-in land scripts only. The crew's logs are the first real test.
- **Open problems:** P-346 (timing checks under load: three made independent of load in 2.91, six known left), P-005 (GPU model), P-009 (no Unity on the maintainer's side: the online job is the fix once it signs in).
- **Waiting for your OK:** U-007 (last, only when nothing else waits). Two decisions: whether the scorecard's "landed" should stop counting a close; whether the next batch's rules check may run beside a land run.

## The files
| File | What | Format |
| --- | --- | --- |
| WORK-LOG.md | every task: what, how long, which tool or engine step, proof | one row per task, newest last |
| PROBLEMS.md | what happened, why, the workaround, harness fix candidate?, open or fixed | one block per problem |
| CREW-LOG.md | the Discord workflow: claims, owners, hand-offs, stalls, mistakes | one row per event, from the channel |
| PROPOSALS.md | repeated problems turned into harness upgrades, for Hatch to approve | one block per proposal |

Rules: no keys, tokens, passwords or licence files in any log. Link proof (a screenshot path, a recording, a
test result line); don't paste long output. The harness changes only when Hatch approves a proposal.
