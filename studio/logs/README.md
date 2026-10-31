# Studio logs (private: Hatchfield detail lives here, never in a public game repo)

**2-minute read for Hatch: the latest summary is first. Then open problems, then proposals waiting for you.**

## Latest summary — 2026-10-31 evening
- **Done:**
  - HDRP switch and the Unity side of the replay check (Unity repo PR #2).
  - Harness 2.47 (U-001, U-002), 2.48 (Windows by default), 2.49 (U-004), 2.50 (U-006), 2.51 (U-005) and 2.52 (U-003), each in its own PR.
- **Untested:** everything that needs the Unity editor (HDRP set-up, Edit/Play Mode in Unity, the Windows build).
- **Open problems:** P-001 (harness public), P-005 (GPU model), P-009 (no Unity on Claude's side).
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
