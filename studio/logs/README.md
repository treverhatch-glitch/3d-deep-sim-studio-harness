# Studio logs

**2-minute read for the owner: the latest summary is first. Then open problems, then proposals waiting for you.**

## Latest summary — 2026-11-20 (2.96)
- **Done:** 2.95 (the full rules check in shards, the playtest build, Systems ON) is on main and in use in the one studio on record.
- **In progress:** 2.96 on a branch, merged when its online checks pass: every run sampled, admission by measured RAM and CPU (a setting), narrowing by the failing tests only, one green per tree, held lanes left out of the batch, union merge for list files, landing posts, the test-cost report, a smoke start for every pool, an upgrade that waits for the train. Notes: docs/RELEASE-2.96.0.md, studio/notes/HANDOFF-2.96-2026-11-20.md.
- **Untested:** nothing of 2.93 to 2.96 has run on a real engine from the maintainer's side; the Windows sampler runs for real only in one online check; measured admission has decided nothing on a real machine yet.
- **Open problems:** P-374 (first real samples needed), P-370, P-373, P-346, P-005, P-009.
- **Waiting for your OK:** whether a count ratchet may land with a fix task filed; which unused features to retire.

## The files
| File | What | Format |
| --- | --- | --- |
| WORK-LOG.md | every task: what, how long, which tool or engine step, proof | one row per task, newest last |
| PROBLEMS.md | what happened, why, the workaround, harness fix candidate?, open or fixed | one block per problem |
| CREW-LOG.md | the Discord workflow: claims, owners, hand-offs, stalls, mistakes | one row per event, from the channel |
| PROPOSALS.md | repeated problems turned into harness upgrades, for Hatch to approve | one block per proposal |

Rules: no keys, tokens, passwords or licence files in any log. Link proof (a screenshot path, a recording, a
test result line); don't paste long output. The harness changes only when Hatch approves a proposal.
