# Studio logs

**2-minute read for the owner: the latest summary is first. Then open problems, then proposals waiting for you.**

## Latest summary — 2026-11-26 (2.99)
- **Done:** 2.98 (the full land run in parts, build once, checklists, empty lanes refused, disk pruning) is on main and has run two days in the one studio on record: mixed trains of art, UI and translation lanes land, eight lanes at once; green translation trains take 33 to 54 minutes. Landed engine tasks per day went from 15-23 (16 to 19 November) to 42-64 (22 to 25 November).
- **In progress:** 2.99 on a branch, merged when its online checks pass: one red lane costs one extra land run (the group without it is checked again and told green; the by-name run never widens), an agent's own engine run gives way to the train, the check ahead lends its results instead of fixing the batch, Play Mode for a mixed batch runs the mapped fixtures only, a studio's allowed tool works in the spellings a session types, tag groups run after a day, waiting lanes are tested early, "newer wins" for listed files, long checklists, asks that clear. Removed: three commands nobody ran and the usage marks. Notes: docs/RELEASE-2.99.0.md, studio/notes/HANDOFF-2.99-2026-11-26.md.
- **Untested:** nothing of 2.99 has run on Windows, a real engine or a real session before the online checks; the allow rules follow the tool's documentation, not a real session; how much a dropped lane re-runs depends on the studio's `rules.paths`.
- **Open problems:** P-370, P-373, P-346, P-005, P-009.
- **Waiting for your OK:** whether a count ratchet may land with a fix task filed; whether a tag should run by itself after a day by default; whether to turn `landParts` on; the 3.0 bar (the maintainer's roadmap).

## The files
| File | What | Format |
| --- | --- | --- |
| WORK-LOG.md | every task: what, how long, which tool or engine step, proof | one row per task, newest last |
| PROBLEMS.md | what happened, why, the workaround, harness fix candidate?, open or fixed | one block per problem |
| CREW-LOG.md | the Discord workflow: claims, owners, hand-offs, stalls, mistakes | one row per event, from the channel |
| PROPOSALS.md | repeated problems turned into harness upgrades, for Hatch to approve | one block per proposal |

Rules: no keys, tokens, passwords or licence files in any log. Link proof (a screenshot path, a recording, a
test result line); don't paste long output. The harness changes only when Hatch approves a proposal.
