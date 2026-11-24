# Studio logs

**2-minute read for the owner: the latest summary is first. Then open problems, then proposals waiting for you.**

## Latest summary — 2026-11-24 (2.98)
- **Done:** 2.97 (the rules green judged by what lands, a union merge for lengthened lines, the memory floor of the land kind, a drain that means no new train) is on main and has run three days in the one studio on record: 8-lane batches land green and a train often starts with 37 to 41 of 41 shards already checked.
- **In progress:** 2.98 on a branch, merged when its online checks pass: the daily full land run in parts with a back-off, rules parts that build once and never go red on a locked file, config read at each step, empty lanes refused, tasks with a checklist and child tasks, quick lanes before a slow head, tag groups when the queue is empty, quota marks on evidence, agy and the API pool on engine worktrees, disk pruning (off until set), a session's record written whole. Removed: the whole-machine memory learning and the `rules.peak` reader. Notes: docs/RELEASE-2.98.0.md, studio/notes/HANDOFF-2.98-2026-11-24.md.
- **Untested:** nothing of 2.98 has run on Windows, a real engine, a real `dotnet` or a real agy before the online checks; what a full-run part runs is the studio's land script's to define.
- **Open problems:** P-370, P-373, P-346, P-005, P-009.
- **Waiting for your OK:** whether a count ratchet may land with a fix task filed; whether tag groups should start by themselves by default; which unused features to retire.

## The files
| File | What | Format |
| --- | --- | --- |
| WORK-LOG.md | every task: what, how long, which tool or engine step, proof | one row per task, newest last |
| PROBLEMS.md | what happened, why, the workaround, harness fix candidate?, open or fixed | one block per problem |
| CREW-LOG.md | the Discord workflow: claims, owners, hand-offs, stalls, mistakes | one row per event, from the channel |
| PROPOSALS.md | repeated problems turned into harness upgrades, for Hatch to approve | one block per proposal |

Rules: no keys, tokens, passwords or licence files in any log. Link proof (a screenshot path, a recording, a
test result line); don't paste long output. The harness changes only when Hatch approves a proposal.
