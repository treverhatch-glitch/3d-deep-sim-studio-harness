# 2.84.0: less waste (`docs/RELEASE-2.84.0.md`)

The owner's order of 2026-11-12: keep building toward a studio that runs itself, trim what is not used, and cut the
old write-ups that cost tokens every time someone works on the harness. Built on 2.83.0. Only this page and the one for
2.83.0 are kept; older release notes are in git history.

## What the records said

A crew's 26 hours on 2.82: 113 planning sessions were started by a timer or by an empty queue. The Director's 33
regular cycles cost $38.83 and left one change on the board. The Producer's 80 cost $31 and added 17 tasks. A first
design (skip a cycle when nothing changed since the last) was replayed on the log and would have skipped 1 cycle in
32: a hand-back appears in nearly every hour. So the rule is by outcome, not by news.

## What was built

| | What | Where | Checks |
| --- | --- | --- | --- |
| Planning wakes | After a cycle or queue-depth session that changed nothing, the next waits twice as long, up to a ceiling; a person's answer, an owner order, a playtest verdict or a phase change ends the wait; a freed area ends the queue wait. Replay: 66 of 113 wakes skipped, $43 of $70. | `harness/wake-gate.mjs`, `dev-cycle.mjs`, `queue-depth.mjs`; docs/LINE-PRODUCER.md | `qa/selftest-284a.mjs` (12) |
| Dead starts | A session is not started on a task whose `task start` would be refused. | `harness/attempts.mjs` `startRefusal`, `agent.mjs` | 284a |
| Same-family review | `studio/review.json` `sameFamily`: `auto` (as 2.83), `on`, `off`. The owner, the owner's stand-ins and outside agents flip it; a Producer session only with `STUDIO_PRODUCER_APPROVES=protected`; a worker never. Families are read from the main checkout's `.env` and `studio/models.json`; the environment can add one, never remove one. | `harness/review-family.mjs`, `review.mjs`; docs/REVIEWER.md | `qa/selftest-284b.mjs` (10), `284g` (17) |
| The overseer's sheet | `npm run overseer -- sheet [--json]`: asks, held and parked tasks, train holds, engine hand-backs, chain gates, dangling waits, dead ends. | `harness/overseer.mjs`; docs/OVERSEER.md | `qa/selftest-284c.mjs` (11) |
| A real editor | Three copies of the Unity template, one editor run each (GameCI), then `editModePlan`, `failingTests` and `compileErrorFiles` against what the editor wrote. A fork's pull request has no secrets and skips it. | `scripts/unity-real.mjs`, `.github/workflows/ci.yml` | the job itself |
| Commands run | `.studio/usage/<YYYY-MM>/<script>~<word>` markers; `npm run commands-run`. `STUDIO_USAGE_MARKS=off`. | `harness/event.mjs`, `scripts/commands-run.mjs`; docs/SCORECARD.md | none yet |

## What was cut

| | Before | After |
| --- | --- | --- |
| `CHANGELOG.md` | 304 KB | 30 KB (four newest in full) |
| `docs/RELEASE-*.md` | 13 files, 131 KB | 2 files |
| `studio/logs/PROBLEMS.md` | 149 KB | 53 KB (P-280 on and the open ones in full) |
| `studio/logs/PROPOSALS.md` | 43 KB | 2 KB |
| `docs/SECURITY.md` | 46 KB | 17 KB, every rule kept |
| `README.md` | 18 KB | 4 KB |
| `docs/CLEANUP-2.79-AUDIT.md`, four old notes | 107 KB | gone |

No feature was removed. Seventy modules that left no trace in five days of a crew's log were checked one by one: the
two that looked unreachable are reached as subprocesses and were asked for by the owner. A feature is cut when a month
of `commands-run` markers from a live studio says nobody runs it.

## Untested

- The real-editor job: licence activation reaches Unity's sign-in and is refused there. Nothing after that has run.
- The back-off on a live studio. The replay assumes each session did what it really did.
- `boardEvents` on a real session's end (the counting function and the scorecard are tested).

## For a studio on 2.83

Nothing to set. To let same-family reviews count: `npm run review -- same-family on --by <you> --why "…"`.
To keep 2.83's planning cadence: `STUDIO_CYCLE_QUIET_MAX_H=off` and `STUDIO_WAKE_SAME_MAX_H=off`.
