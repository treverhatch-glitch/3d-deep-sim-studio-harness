# 2.84.0: less waste (`docs/RELEASE-2.84.0.md`)

The owner's order of 2026-11-12: keep building toward a studio that runs itself, trim what is not used, and cut the
old write-ups that cost tokens every time someone works on the harness. Built on 2.83.0. Only this page and the one for
2.83.0 are kept; older release notes are in git history.

## What the records said

A crew's 26 hours on 2.82: 113 planning sessions were started by a timer or by an empty queue. The Director's 33
regular cycles cost $38.83 and left one change on the board. The Producer's 80 cost $31 and added 17 tasks. A first
design (skip a cycle when nothing changed since the last) was replayed on the log and would have skipped 1 cycle in
32: a hand-back appears in nearly every hour. So the rule is by outcome, not by news.

A studio's first 100 minutes on 2.83 added three: sessions told to run a `git merge` they may not run (three tasks,
three dead sessions each, merged by hand), a never-touched file that git reports as modified blocking `task done`, and
a batch whose Play Mode and UI files forced the full 28-minute rules run. The drift check fired 10 times on files that
were already changed in the main checkout.

## What was built

| | What | Where | Checks |
| --- | --- | --- | --- |
| Planning wakes | After a cycle or queue-depth session that changed nothing, the next waits twice as long, up to a ceiling; a person's answer, an owner order, a playtest verdict or a phase change ends the wait; a freed area ends the queue wait. Replay: 66 of 113 wakes skipped, $43 of $70. | `harness/wake-gate.mjs`, `dev-cycle.mjs`, `queue-depth.mjs`; docs/LINE-PRODUCER.md | `qa/selftest-284a.mjs` (12) |
| Dead starts | A session is not started on a task whose `task start` would be refused. | `harness/attempts.mjs` `startRefusal`, `agent.mjs` | 284a |
| Same-family review | `studio/review.json` `sameFamily`: `auto` (as 2.83), `on`, `off`. The owner, the owner's stand-ins and outside agents flip it; a Producer session only with `STUDIO_PRODUCER_APPROVES=protected`; a worker never. Families are read from the main checkout's `.env` and `studio/models.json`; the environment can add one, never remove one. | `harness/review-family.mjs`, `review.mjs`; docs/REVIEWER.md | `qa/selftest-284b.mjs` (10), `284g` (17) |
| The overseer's sheet | `npm run overseer -- sheet [--json]`: asks, held and parked tasks, train holds, engine hand-backs, chain gates, dangling waits, dead ends. | `harness/overseer.mjs`; docs/OVERSEER.md | `qa/selftest-284c.mjs` (11) |
| A real editor | Three copies of the Unity template, one editor run each (GameCI), then `editModePlan`, `failingTests` and `compileErrorFiles` against what the editor wrote. A fork's pull request has no secrets and skips it. | `scripts/unity-real.mjs`, `.github/workflows/ci.yml` | the job itself |
| Batch window | `engines.<x>.batchMin` and `batchWaitMin` (default 1 and 0: off): the automatic engine train waits for more queued branches while sessions still work on that engine's tasks; a branch that lands alone and a person's own `task train` never wait. A crew landed 6 branches on one 41-minute run; most trains started with one. | `harness/line-producer.mjs` `engineBatchWait`; docs/ENGINE-TRACKS.md | `qa/selftest-284h.mjs` (10) |
| Play Mode focus | `engines.<x>.play.focus` (`map`, `smoke`, `join`): when every changed path maps, the land command gets `STUDIO_PLAY_MODE=focus`, `STUDIO_PLAY_FILTER` and, for Unity, `STUDIO_UNITY_PLAYMODE_ARGS`; never on the daily full run. A focused run is a weaker check than a full one. | `harness/engine-rules.mjs` `playSelection`, `unity-train.mjs`; docs/NATIVE-ENGINE.md | 284h |
| Commands that end before they run | `npm run check:tla` in the release gate: a top-level await of an import that reaches back to the module itself. Four found and fixed. | `scripts/check-top-level-await.mjs` | `qa/selftest-284i.mjs` (11) |
| Drift check | Files dirty in the main checkout when a session started are not the session's. | `harness/drift-baseline.mjs`, `stall.mjs` | `qa/selftest-284j.mjs` (7) |
| Online checks | The Windows self-test in 8 shards. | `.github/workflows/ci.yml` | |
| Engine target merge | `npm run engine -- merge <ID>`: the merge the launch could not make, left in the worktree with its conflict; `--continue` refuses while markers remain; `--abort`. Only the task's own session or a person. The same conflict again, with no new commit, parks the task once. | `harness/engine-tracks.mjs`, `agent.mjs` | `qa/selftest-284m.mjs` (11) |
| Phantom changes | An unstaged "modified" path whose bytes equal the committed blob (a filter or line-ending rule) is left out of every "uncommitted work" list, and the command says so. | `harness/eol-only.mjs` `splitPhantom` | 284m |
| Focus ignore | `rules.focus.ignore`, `play.focus.ignore`: regexes for changed paths that cannot affect the tests. | `harness/engine-rules.mjs` | 284m |
| Commands run | `.studio/usage/<YYYY-MM>/<script>~<word>` markers; `npm run commands-run`. `STUDIO_USAGE_MARKS=off`. | `harness/event.mjs`, `scripts/commands-run.mjs`; docs/SCORECARD.md | none yet |

## Second pass: a crew's first day on 2.83, and the overseer's list

2.83 was projected to raise the engine train's pass rate and cut the overseer's steps. A crew's first 21.5 hours on it
said otherwise (`npm run score` on its log): 4 of 15 targets met (2.82: 8 of 14); engine land runs passed 34.8% (64.5%);
36.2 land minutes per landed branch (30.4); 22% of landed tasks with no overseer step (51%); $8.21 per landed task
($7.21); 47 tasks a day (46). Part was the day (a reboot, a 17-branch batch); part was the harness: the evidence blame
read only the land command's own output while the crew's land script writes results files, a red run was repeated in
full, the rules check took 12.7 GB on a large batch, a reviewer planned on another family's model was started with the
wrong tool and halted the supervisor twice, and the overseer was refused decisions beta mode had already given it.
The overseer wrote a list; this pass builds it.

| | What | Where | Checks |
| --- | --- | --- | --- |
| Results files | `engines.<x>.results` (globs): failing tests and compiler errors are read from the files a land run writes, and from the stage report's `failures`. Blame also by namespace or class file. | `harness/unity-gate.mjs`, `unity-train.mjs` | `qa/selftest-284t.mjs` (21) |
| Retry by name | A red stage is run again with only the tests that failed (`STUDIO_LAND_RETRY`, `STUDIO_LAND_RETRY_STAGE`, `STUDIO_LAND_RETRY_TESTS`; for Play Mode also `STUDIO_UNITY_PLAYMODE_ARGS`). A name that is not safe on a command line, or more than 50 names: the whole land again. `engines.<x>.flakyTests`: known-flaky names are retried before anyone is blamed. | `harness/unity-train.mjs` | 284t, `284h` |
| Play Mode skip | `play.focus.skip`: paths that need no Play Mode run at all (`STUDIO_PLAY_MODE=skip`); never on the daily full run. | `harness/engine-rules.mjs` | 284t |
| Compile first | `engines.<x>.compileFirst`: one run with `STUDIO_LAND_ONLY=compile` before the land; a compile error is blamed by file without a test run. | `harness/unity-train.mjs` | 284t |
| A killed land | An exit that looks like the OS killed the run (`engines.<x>.killedExits`) is retried once and never blamed on a branch. | `harness/unity-gate.mjs` | 284t |
| Rules check memory | `rules.focus.split` (one test process per system) and `rules.maxLanes` (a large batch is checked in slices; a slice only refuses early, the land still judges). | `harness/engine-rules.mjs` | 284t |
| Picking a batch | `task train --engine <x> --only <ids>` and `--tag <name>` (`task tag <ID> <name>`; a tagged branch never joins the automatic train); `engines.<x>.batchMax`; `batchGroup` keeps branches that need Play Mode apart from those that do not. Replaces a crew's local `STUDIO_UNITY_TRAIN_ONLY` patch (still read). | `harness/engine-train-control.mjs`, `unity-train.mjs` | `qa/selftest-284u.mjs` (9) |
| Cancel, auto off | `task train cancel --engine <x> --by <name>`: kills the train's process tree, puts the gate worktree back at the target, frees the lock and the lanes; never moves the target back. `task train auto off\|on --engine <x> [--hours N]`. | `harness/engine-train-control.mjs` | 284u |
| After a reboot | `npm run studio:boot -- install` registers the studio's start at log-on; a boot sweeps every engine's stale train lock. | `harness/boot.mjs` | 284u |
| Gates by track | A verify runs the gates of the tracks its change touches (`web`, `engine:<x>`, `harness`, docs-only); the safety gates run on every change; an unplaced path, `--all` or `STUDIO_GATES_BY_TRACK=off` runs everything. `done` and the train refuse a verify that skipped a track the change needs. | `harness/gate-tracks.mjs`, `scripts/run-gates.mjs` | `qa/selftest-284x.mjs` (11) |
| The reviewer's tool | One function says which tool runs a model id; a mismatch is refused before a process starts; a reviewer's launch crash backs the reviewer role off instead of halting the supervisor. `npm run review -- ask <ID> --model <id>`: the harness asks a model whose tool cannot run commands, records the review and closes the review task. | `harness/model-tool.mjs`, `review-ask.mjs` | `qa/selftest-284w.mjs` (11) |
| Supervisor and crew | A skipped task says why (`supervisor.backoff`, `task show`); a refusal about the crew (every seat taken, a budget stop) is not counted against the task; the crew breaker counts queued and ready work and ignores hand starts; a planning session's stall limit follows its model; `task start <ID> --dry-run`; the board is read from the main checkout in a lane made by hand; `studio:reload-env` names the settings it no longer reads. | `harness/supervisor.mjs`, `crew-watch.mjs`, `stall.mjs`, `task.mjs` | `qa/selftest-284v.mjs` (14) |
| The overseer keeps its decisions | Engine merge without the claim, unpark at the owner's rank, the overseer's own decisions end the planning back-off; a table of who may run what. | `harness/permission.mjs`, `task-hold.mjs`; docs/OVERSEER.md | `qa/selftest-284n.mjs` (19) |
| Beta powers (the owner's decision, 2026-11-12) | While beta mode is on, a beta-mode agent and an outside signer each release a tier-C lane, force a done (with the train too, when a force approval is on file), approve protected files including their own change (marked `self`), unpark at any rank, resume a crew, cancel or switch an engine train. One rule, `standInMay`; every use is a `beta.use` event and a digest line. Never: the owner-only list, a launched session, a worker's name, beta off. An upgrade keeps `studio/beta.json`. | `harness/beta-mode.mjs`, `approve.mjs`, `upgrade-guard.mjs`; docs/SECURITY.md | `qa/selftest-284q.mjs` (12) |
| A harness-owned editor | One editor kept open, spoken to through files: warm land runs (`engines.<x>.warm: "land"`, the land command gets `STUDIO_EDITOR_SERVICE*`) and a queue any session may use (`npm run editor -- check`, `engines.<x>.service.check`) that returns compiler errors and PNGs. Off by default; falls back to a cold start. | `harness/editor-service.mjs`, `engine/_unity/Assets/Editor/StudioService/`; docs/NATIVE-ENGINE.md | `qa/selftest-284s.mjs` (11), a stand-in editor only |

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

In the second pass three unused features went, with their tests, pages and 14 settings: remote workers and the remote
verify, the harness scout, signed results (`qa/selftest-284y.mjs`). The run report and the causes list were proposed
and kept: both are in use. Five more pages were shortened (ROADMAP 32 KB → 5 KB).

In the first pass no feature was removed. Seventy modules that left no trace in five days of a crew's log were checked one by one: the
two that looked unreachable are reached as subprocesses and were asked for by the owner. A feature is cut when a month
of `commands-run` markers from a live studio says nobody runs it.

## Untested

- The real-editor job: licence activation reaches Unity's sign-in and is refused there. Nothing after that has run.
- The back-off on a live studio. The replay assumes each session did what it really did.
- `boardEvents` on a real session's end (the counting function and the scorecard are tested).
- The batch window and Play Mode focus on a live studio; `-testFilter` on a real editor.
- The drift record is made at a session's first observation, not at its launch.
- Everything in the second pass on a real editor and on a live studio: results files, retry by name, compile first,
  the killed-run retry, the rules split and slices. The stand-in land script honours the variables; a studio's own
  script has to.
- The harness-owned editor: the C# side has never been compiled. Least sure: `TestRunnerApi.SaveResultToFile`, whether
  `EditorApplication.update` keeps running in batch mode without `-quit`, callbacks across the Play Mode domain reload,
  `Camera.Render` under URP.
- `train cancel` and `studio:boot -- install` on Windows (`taskkill`, `schtasks`).
- `--force` with `--train` end to end on a real lane copy (the refusal is gone and the lane check passes it on).
- `review ask` on an engine task's diff.

## For a studio on 2.83

Nothing must be set. Optional, under `engines.<engine>` in `studio/game.json`:

```json
"batchMin": 4, "batchWaitMin": 12,
"play": { "focus": { "map": [ { "match": "^Assets/Scripts/([A-Za-z]+)/", "filter": "Game.PlayTests.$1" } ],
                     "smoke": "Game.PlayTests.Smoke", "join": ";" } }
```

More, all optional and off until set:

```json
"results": ["TestResults/*.xml"], "flakyTests": ["Game.PlayTests.Some.FlakyOne"], "compileFirst": true,
"batchMax": 8, "batchGroup": "play",
"play": { "focus": { "skip": ["^Assets/Art/"] } },
"rules": { "maxLanes": 6, "focus": { "split": true } },
"warm": "land", "service": { "check": true }
```

A land script should honour: `STUDIO_LAND_ONLY=compile`, `STUDIO_LAND_RETRY_TESTS` (names joined by `;`),
`STUDIO_PLAY_MODE` (`full`, `focus`, `skip`), `STUDIO_UNITY_PLAYMODE_ARGS`, and may write `failures` into
`STUDIO_LAND_RESULT` (docs/NATIVE-ENGINE.md has the whole table). A studio that set its own
`STUDIO_HEAVY_IGNORE_ARGS` adds `|-studioService` to it before turning the editor on (the default already has it).

To let same-family reviews count: `npm run review -- same-family on --by <you> --why "…"`.
Gates by track is on; `STUDIO_GATES_BY_TRACK=off` runs every gate on every change as before.
To keep 2.83's planning cadence: `STUDIO_CYCLE_QUIET_MAX_H=off` and `STUDIO_WAKE_SAME_MAX_H=off`.
