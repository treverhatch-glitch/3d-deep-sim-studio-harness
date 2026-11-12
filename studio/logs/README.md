# Studio logs (private: Hatchfield detail lives here, never in a public game repo)

**2-minute read for Hatch: the latest summary is first. Then open problems, then proposals waiting for you.**

## Latest summary — 2026-11-12
- **Done:** harness 2.83.0 is merged (flow: session accounting, the engine train, a cheaper rules check, the planner); a crew runs it. Notes: docs/RELEASE-2.83.0.md, studio/notes/HANDOFF-2.83-2026-11-11.md.
- **In progress:** 2.84 on a branch (planning wakes that change nothing, the same-family review switch, the overseer's sheet, a real Unity editor in the online checks, shorter documents).
- **Untested:** nothing from 2.83 or 2.84 has run on a real Unity editor from the harness's side; the online editor job waits for working sign-in secrets.
- **Open problems:** P-005 (GPU model), P-009 (no Unity on the maintainer's side: the online job is the fix once it signs in).
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
