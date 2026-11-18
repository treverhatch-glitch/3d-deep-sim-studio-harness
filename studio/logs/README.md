# Studio logs

**2-minute read for the owner: the latest summary is first. Then open problems, then proposals waiting for you.**

## Latest summary — 2026-11-18 (2.95)
- **Done:** 2.94 (the next batch's rules check beside the land run, as a setting; "landed" is train work only) is built and its online checks pass. The one studio on record runs it, taken from the branch.
- **In progress:** 2.95 on a branch, merged when its online checks pass: the full rules check in shards with a kept green per shard, the test run's own peak memory, a playtest build in one command with `PLAYTEST.md`, `Systems ON: n of m`, no session on a held and queued branch, a check that starts pool and agy porters end to end. Notes: docs/RELEASE-2.95.0.md, studio/notes/HANDOFF-2.95-2026-11-18.md.
- **Untested:** 2.93, 2.94 and 2.95 have not run on a real engine, on real agy or with a real API pool. Every new setting is off until a studio sets it.
- **Open problems:** P-370 (a train cancel from a cut-down environment on Windows), P-346 (timing checks under load), P-005 (GPU model), P-009 (no Unity on the maintainer's side).
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
