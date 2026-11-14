# Problems and workarounds

One block per problem. **Harness fix?** says whether the harness itself should change (then it goes into
PROPOSALS.md for Hatch). Mark **open** or **fixed**, with the date.

### P-005 — Couldn't read the GPU model through Task Manager · open
- **What happened:** computer use opened Task Manager, but clicks on the GPU page didn't register. The visible label reads "NVIDIA GeForce R…" (cut off).
- **Why:** Task Manager is a protected Windows app, granted at "click" level; it likely ignored clicks from a non-elevated process.
- **Workaround:** ask Hatch for the model, or read it in the NVIDIA app or Settings → System → Display → Advanced display.
- **Harness fix?** No.

### P-009 — HDRP and its setup can't be run or tested from Claude's side · open
- **What happened:** the HDRP switch and every Unity editor step need Unity with a licence; Claude's machine has neither.
- **Workaround:** a one-click set-up script that logs DONE/SKIPPED per setting; Hatch (or a bot on his PC) runs it and
  sends the Console text; CI runs the Windows build once the licence secrets exist.
- **Harness fix?** Later: a bot on Hatch's PC runs `npm run engine:gate` and posts the result.

### Found by the crew (game bug, not harness): Windows case clash in src/branding
- T-026 (queued by opus-1): `Finance.tsx` and `finance.ts` in game/hatchfield/src/branding clash on Windows, which
  breaks the type check and build there. A real hatchfield-game bug; the crew has it queued.

### P-021 findings (2026-10-31, investigated by hand; the investigation agent was stopped)
- **No green CI run on any branch since 2026-10-16 22:26 UTC.** All 9 failures are timeouts; none is a wrong value.
- **The 8 browser tests: the game draws one frame every ~5 s in a headless browser** (software 3D, no GPU).
  Measured on a 2-core box with Playwright's Chromium (SwiftShader): title screen 0.2 fps, in game 0.2 fps; the
  game clock moved 0.1 game-seconds in 10 real seconds (game time advances per frame). A blank page runs at 52 fps
  and a plain WebGL page at 43 fps, so the browser is fine. A CPU profile shows the page's main thread 93% idle:
  it waits on the software renderer. The game's own "low" graphics setting and a small window barely help (0.2 to
  0.6 fps). **Skipping only the 3D draw call** (a scratch edit, never committed) gave 48 fps on the title screen,
  15 fps in game, and 9.4 game-seconds per 10 s: about 90 times faster. Run one at a time with nothing else
  running, 6 of the 7 that could start still timed out, so this is not mainly CPU contention.
- **The sim tests (security.serve in CI; occupancy, contractPacing and the hub-meltdown tests on Hatch's PC): a
  different cause, sharing the CPU.** They pass alone, but use much of their time limit: security.serve 10.7 s
  (limit 20 s), occupancy ~16 s, contractPacing at 3x 16.8 s (limit 60 s). In a full parallel run, alongside
  browser tests rendering in software for minutes, they cross the limits. Fixing the browser tests frees CPU.
- **One more:** infoViews.e2e finds Chrome only at /usr/bin/google-chrome; elsewhere it can't start.
- **Effect while red:** no PR in the game repo can show a green check, and a real regression would hide behind the
  red. With 2.54.0 the studio's done-check excuses exactly these failing test names (PU-06), so crew work isn't
  blocked. Players aren't affected: the tests are slow, not wrong (UNPROVEN on a machine with a real GPU).
- **The fix is one crew task (hatchfield-game, not the harness):**

  > Fix: main's red CI. (1) Add a test-only page switch (`?noRender=1`) that skips `renderer.render` in
  > src/render/world.ts and src/render/interior/InteriorView.ts (2 lines; never on in a normal page). (2) The 8
  > *.e2e.test.ts files open the page with it through one shared helper; the tests that save screenshots keep
  > drawing and move to a separate visual-test script in the game that CI doesn't run by default. (3) infoViews.e2e uses
  > PLAYWRIGHT_CHROME and Playwright's own Chromium like the others. (4) Heavy sim tests (security.serve,
  > atc/occupancy, contractPacing, hub live.edge) get time limits of at least 3x their measured time alone, and CI
  > runs `vitest run --maxWorkers=2`. Proof: `npm test` green 3 runs in a row locally and on GitHub, with a
  > before/after table of the browser tests' times. Size: half a day to a day. Files: 2 render lines, 8 e2e tests
  > (+1 helper), 4 sim tests, the CI workflow.

## Tests on 2026-10-31 evening (break tests, cloud checks, Unity)

### Leads not re-checked yet
- The protected-files gate passed an uncommitted protected edit, and one already pushed: re-checked, real (with no remote even a committed edit passed); fixed in 2.56.1 (PU-20, PR #34).
- A stalled agent (no heartbeat for 40 min) keeps its slot: the launcher says "1 builder agent(s) already running" and another agent can't hand the task back.

### Held up fine
- Two agents racing for the same task: only one ever wins (5 rounds).
- 200,000 events (119 MB): `task next` 0.23 s, `task list` 0.12 s, `status` 0.46 s, watcher 0.49 s.
- Fresh clone, as a newcomer: `npm run setup` without prompts, `npm run help`, `npm run verify` 10/10 (about 3 s) and `--full` 30/30, `new-game`, its playtest and the hub all worked. (The walkthrough stopped before the crew docs.)

### Suspected, round 2 (read in code or simulated, not seen live)
- Case-only folder claims: `path:game/Branding` and `path:game/branding` are both granted (seen on Linux); on Windows that is one folder held by two agents (PU-43).
- Hook scripts have no line-ending rule; with Windows line endings `bash\r` isn't found and every commit fails, pushing agents toward `--no-verify` (simulated on Linux) (PU-43).
- `git commit --no-verify` skips everything the hooks enforce; weakened tests (`.skip`, removed asserts, wider tolerances) are forbidden only by the rules text (PU-29).
- fsafe's in-place fallback after about 1 s of EPERM writes the board exactly when another program has it open; it should at least leave a warning event.

### Held up fine (round 2)
- 2,000 tasks, 100 sessions, 300k events (roll-over off): `task next` 0.28 s, `task start` 3.1 s, `done --check` 2.6 s, watcher 1.4 s.
- CRLF in NEXT.md parses; IDs with `../` or case-only differences can't reach the board (the ID format is `[A-Z]+-\d+`).
- `npm run verify` 2.0 s and `task done --check` 0.31 s on a fresh copy.

## From the crew, 2026-11-01 (studio-hatchfield, harness 2.53 to 2.55; Hatch relayed grokbot's notes)
The crew's log numbers these P-034 and P-035; here they get new numbers, since P-034 and P-035 are already used above.

### Answered without code (crew report)
- Watchdog "6 sessions, no task finished in 2 h": fixed in 2.54.0 (P-022, P-023); studio-hatchfield runs 2.56.0+.
  `STUDIO_WATCHDOG_IDLE_HOURS=4` can go back to the default; keeping 4 while tasks take half a day is reasonable.
- `task done --force`: `--reason` and `--accepted-by` already existed; the owner-typed path is now written down
  (`docs/FORCED-CLOSE.md`, 2.57.1).
- Bots wake only on a person's @ping: written into `docs/DISCORD-CREW.md` (2.57.1) and the Unity repo's
  `docs/crew/BOT-RULES.md` rule 17 (Unity PR #12); the 👀/✅ rule was already rule 13 there.

## From the crew, 2026-11-01 night (studio-hatchfield on 2.56.0; their log numbers P-034 to P-037)
- Their **P-034** (size rule blames merged-in code) = P-061 here: fixed in 2.58.0 (part A).
- Their **P-035** (`buildingMass.test.ts.snap` line endings) = P-062 here: fixed in 2.58.0 (part F: game checks run with
  `CI=true`, verify names files it changed); the game repo should still add `*.snap text eol=lf` (crew task).

### Seen, not changed in code (proposals)
- **Verify load:** 84 verify runs (median 265 s), up to 4 at once, 43 overlapping; 39 not all green. e2e timeouts seen for alertStack (120 s) and negotiation/panel. Proposal: `STUDIO_GATE_SLOTS=1` on a single-PC studio (one heavy game check at a time), and in the game repo run e2e files serially with a free port (crew P-038). Needs Hatch's OK.
- **Planning cost:** the 45-minute development cycle woke an Opus Director and Producer 7 times while the supervisor was halted (9 producer and 12 director sessions, 16.6M tokens incl. cache reads; director-1 read 1.8M tokens with no progress, ev 1013). Proposal: skip the regular cycle while nothing can start.
- **Opus gaps over 15 min:** 9, mostly waits on a 4–7 minute verify (e.g. 23:06→23:25, 00:11→00:29); 2.58's detached verify (`verify -- --wait`) covers a killed shell.
- **No low-memory guard events** in the studio logs; the harness has no memory guard of its own. Launcher sessions peaked at 3 at once; extra Claude processes come from verify's test workers and the crew's own bots.
- **P-036 (crew) / P-066:** still present in the logs (node/npm commands blocked 205 times) because the studio runs 2.56.0; 2.58.1 fixes the quoting (Windows CI proof). Real installed claude.cmd/agy.cmd stay UNTESTED until the studio updates.

## Building the Hatchfield replay cartridge, 2026-11-01 (a side job for Hatch, in a copy of the studio)

### P-280 — asks reposted after they were acted on · fixed in 2.79.0
- **Evidence:** 252 `agent.ask` events against 20 `ask.answered` in six days, most "T-xxx is parked: 2 sessions in a row ended with no work".
- **Fix:** one post per task and subject, `ask.closed` when the task moves on, repeats only in the daily digest. qa/selftest-279c.mjs.

### P-281 — Vertex credit couldn't carry builder work · fixed in 2.79.1
- **Evidence:** the key works only with `x-goog-api-key`; the orchestrator's local proxy worked, but adding the tool command was refused by its auto-mode classifier ("Create Unsafe Agents"), so builders couldn't run on Vertex without the owner typing commands.
- **Fix:** a built-in `vertex` tool through a harness-owned proxy that holds the key; budgets on the owner's orders; owner-defined tools in a protected registry. qa/selftest-2791a.mjs.

### P-282 — one blocked task froze the whole builder line · fixed in 2.79.1
- **Evidence:** 3 times on 2026-11-06, 10–18 tasks ready and 1–2 of 6 builders running: a parked chain-breaker, lane-less ready tasks, a verify hold kept on while the chain-breaker's train ran.
- **Fix:** blocked items block only their dependants; lane-less tasks skipped and scoped; one page; the hold ends when the train runs it, max 20 min. qa/selftest-2791b.mjs.

### P-283 — an engine land waited 60 min for RAM and was refused · fixed in 2.79.1
- **Evidence:** T-215's land waited for 12 GB free while 6 builders ran, then was refused.
- **Fix:** the Line plans for a near land (hold new heavy starts, step down, learned floor, release at once, max 30 min) and an engine push mode. qa/selftest-2791b.mjs.

### P-284 — a Golden-Reason line under the subject wasn't a trailer · fixed in 2.79.1
- **Evidence:** T-322 handed back 3 times "no Golden-Reason trailer" while the builder had written the line.
- **Fix:** `task done` reads trailers the way git does and says exactly where the line goes. qa/selftest-2791c.mjs.

### P-285 — Vertex builders spent money and did no work · fixed in 2.79.2
- **Evidence:** 8 Vertex builder sessions on 2026-11-06, each "no work on T-xxx: it never claimed T-xxx", 1–3 requests of 438k–520k prompt tokens, $5.84; `STUDIO_VERTEX_SHARE=0` set at 17:56 and two more started at 18:04.
- **Fix:** the launcher runs the task protocol around one-shot aider; lane-only context with a prompt cap; the share holds on every start path. qa/selftest-2792a.mjs, qa/selftest-2792b.mjs.

### P-286 — a stale machine scan made a good train red · fixed in 2.80.0
- **Evidence:** the trial studio, supervisor off > 15 min: `.studio/machine.json` too old, the job claim fell back to 2 test workers, the game's tests blew the 600 s gate timeout; a train with 3 good lanes ran 35 min, 4 re-checks, landed nothing. After `npm run machine` the same lanes landed in 8.5 min (N1).
- **Fix:** a missing or stale scan is taken again at the claim and stored; the 2-worker fallback is only for a scan that is off or fails. qa/selftest-280c.mjs.

### P-287 — a lock outlived its owner's session · fixed in 2.80.0
- **Evidence:** a P0 "fix main" waited 1 h for a path lock whose owner had no live session; `lock release --owner X` ignored `--owner` (Patch #24, R3-14).
- **Fix:** the next claimer takes over a path or task lock of an ended launched session (`lock.taken_over`); `--owner` acts for X for a person, a Producer/Director or a named outside agent, and is refused out loud otherwise. qa/selftest-280c.mjs.

### P-288 — "everything off" still started paid builders · fixed in 2.80.0
- **Evidence:** during a manual wind-down the supervisor went on when the API pool or Vertex was ready; a usage wind-down outlived its removed setting; an agent could start one that only a person could end (Patch #14, R3-7).
- **Fix:** a manual wind-down returns before the pool and Vertex; the setting is read every pass; an agent's `--now` needs `--until`. qa/selftest-280c.mjs.

### P-289 — the train daemon re-ran the same lanes on a red main · fixed in 2.80.0
- **Evidence:** after `task.train.red_main` the daemon started the same 7 lanes again at once, about 30 min each, 6 times in one day (Patch #25).
- **Fix:** it waits while main's head and the queued lanes are unchanged; a moved main, a new or changed lane, or a train started by hand runs. qa/selftest-280c.mjs.

### P-290 — the War Room was the largest part nobody used · cut in 2.80.0
- **Evidence:** the crew's 7-day audit: no page opened, 0 events from any panel, the `hud` gate never ran; hub, pages, their modules and tests were about 17,000 lines, and the watcher, retro, learn pass and watchdog only ran while the hub was up.
- **Fix:** the timed passes moved into the supervisor (`harness/studio-passes.mjs`, qa/selftest-280b.mjs); the hub, the pages and what only they used are deleted. docs/RELEASE-2.80.0.md.

### P-291 — nobody could say how well the studio runs, round over round · measured from 2.81.0
- **Evidence:** the crew's 8.2 days read for the first time as one card: 29.6% of 358 landings hands-free, 567 overseer steps, 53.6% of $874.50 on Producer and Director sessions, 55.2% done on the first claim, 16.4% of 67 engine land runs passed, the machine under 25% CPU in 58.4% of samples.
- **Fix:** `npm run score` (harness/score.mjs, docs/SCORECARD.md), fifteen fixed measures with targets and `--record`; baseline studio/scores/2026-11-08-baseline.json. qa/selftest-281a.mjs.

### P-292 — tasks were relaunched against a blocker that had not changed · fixed in 2.81.0 (record mode)
- **Evidence:** 772 of 1,023 attempts ended in a hand-back; 2.3 claims per done task; the Fable trial counted 244 sessions and 52.8 h on strictly unsuccessful relaunches.
- **Fix:** the attempt ledger: a same-blocker task is offered last by `task next` and the supervisor (`STUDIO_ATTEMPTS=record`; `refuse` holds it). qa/selftest-281b1.mjs.

### P-293 — the overseer's role was spread over five files, and 2.80 refused its lock release · fixed in 2.81.0
- **Evidence:** the crew's orchestrator took 567 board steps in 8 days with no single statement of what it may do; 2.80's `lock release --owner` accepted only STUDIO_OUTSIDE_SIGNERS, and the orchestrator is the owner's proxy.
- **Fix:** `npm run overseer -- role | can | pass`, docs/OVERSEER.md; the proxy and beta mode's agents may release another's lock. qa/selftest-281a.mjs.

### P-294 — 71 private copies of "read a JSON file", and almost none skipped a byte-order mark · fixed in 2.81.0
- **Evidence:** 2.80 fixed `studio/game.json` saved with a byte-order mark for the cartridge reader and the tester's config (N11); the other readers of the same file (engine tracks, the Unity gate, the asset gate, perf tests and more) and the state-file readers still read such a file as missing.
- **Fix:** one `readJson` in harness/fsafe.mjs (skips the mark), one `pidAlive` (19 copies), one `.env` reader in harness/dotenv.mjs. qa/selftest-281a.mjs.

### P-295 — engine failures that need no editor were found by hour-long land runs · fixed in 2.82.0
- **Evidence:** the crew's 64 Unity land runs: 24 of 45 failures were in the .NET rule tests, each found under the engine's slot and narrowed with more land runs; 320 land-run minutes per landed lane.
- **Fix:** the rules check on the batch before the land run, narrowed with the cheap check (harness/engine-rules.mjs); a check red on the target judges nobody. qa/selftest-282a.mjs.

### P-296 — the harness could not see where a land run's time went · fixed in 2.82.0
- **Evidence:** the land script's own records showed Edit Mode at 53 of 92 minutes, re-running tests .NET had run; the harness's events held one number per run.
- **Fix:** STUDIO_LAND_RESULT (the land's stages on engine.land), STUDIO_UNITY_EDITMODE_ARGS (what the editor still has to run), the engine flow on the scorecard. qa/selftest-282a.mjs.

### P-297 — a studio whose game is the engine build still paid for the web path · fixed in 2.82.0
- **Evidence:** builder tasks got web lanes by default, the tester played the web build on a schedule, a web build was queued after every landing and web tasks grew engine twins, in a studio that ships the engine build.
- **Fix:** native-engine mode (harness/native.mjs, docs/NATIVE-ENGINE.md). qa/selftest-282a.mjs.

### P-298 — the attempt ledger recorded no main tip on Windows · fixed in 2.82.0 (found by 2.81.0's checks)
- **Evidence:** windows-selftest: 7 attempt-ledger checks failed; git prints the long path with forward slashes and the temp folder was the 8.3 short name, so "the same checkout" compared unequal.
- **Fix:** harness/attempts.mjs gitTip compares native real paths, case-folded on Windows.

### P-299 — the rules check's kept result did not know its git-ignored inputs · fixed in 2.82.0 (before release)
- **Evidence:** found while answering the owner's train-split question (studio/notes/TRAIN-SPLIT-2026-11.md): the crew's land records name two different hashes of the git-ignored rules pack on two days, and 11 of 14 rule-test failures at landing were that pack disagreeing with a branch's recorded results. The rules check kept its result per tree and command, so the same tree with another pack got the old answer, and the land run was told the rules were green.
- **Fix:** harness/engine-rules.mjs `inputsPrint`: the inputs' content is part of a kept result's key; harness/unity-train.mjs looks at the inputs again before the land run and withholds STUDIO_RULES_GREEN when they changed. qa/selftest-282a.mjs (two checks).

### P-300 — the porter's own check ran the rules command where its inputs were not · fixed in 2.82.0 (before release)
- **Evidence:** 2.82's fold ("with no quickCheck, the owner's rules command is the porter's check too") ran the command in the lane's folder when a porter ran `npm run engine -- check`. The crew's engine lanes are worktrees under `.lanes/engine/` with no copy of the git-ignored rules pack, so a good lane would read red, with no check of the target first. (`task done` was never affected: it runs an engine check only when `quickCheck` is set.) Found on the day the crew took 2.82 early.
- **Fix:** harness/engine-check.mjs `rulesAsQuickCheck`: the rules check (engine-rules.mjs) on the lane's HEAD chained on the target, skipped whenever it cannot judge. docs: for a check at `task done`, set `quickCheck` to a compile. qa/selftest-282a.mjs.

### P-301 — an engine task's session was scored in the wrong repository · fixed in 2.83.0
- **Evidence:** 26 hours on 2.82 in a native studio: 89 session ends said "no work" ($268 of $368 session spend) on 50 tasks, 32 of which later landed; 25 tasks were parked for "2 sessions with no work". The work was in the engine worktree; the session end looked at the studio lane copy.
- **Fix:** harness/engine-tracks.mjs `engineWork` (commits and unsaved files in `.lanes/engine/<task>`), used by the session end in harness/agent.mjs; a task in the engine train is "queued"; harness/crew-watch.mjs counts queued work. qa/selftest-283a.mjs.

### P-302 — `npm run engine -- rules` exited 13 without running · fixed in 2.83.0 (the overseer's B-124)
- **Evidence:** 2.82's P-300 change added a top-level `await import` to harness/engine-rules.mjs inside an import cycle with unity-train.mjs; run as a script, Node ended with "unsettled top-level await". The crew patched it locally.
- **Fix:** the command line runs in an async function; a check runs the file as a script. qa/selftest-283c.mjs.

### P-303 — the plan reported itself blocked 166 times for two causes · fixed in 2.83.0
- **Evidence:** `plan_blocked` 166 times in 26 hours: 41 for an `--after` that named a task that did not exist, 26 for one chain-breaker that was in the train; each woke the Producer (79 of 89 Producer sessions ended in under 3 minutes).
- **Fix:** harness/line-producer.mjs: a dangling `--after` asks once; `line.chain_gate`; the alert leads with the reason; the Producer is not woken again for the same blocker within `STUDIO_PRODUCER_BLOCKED_WAKE_MIN` (60). harness/task.mjs refuses an unknown `--after` id. qa/selftest-283f.mjs, 283d.

### P-304 — the rules check ran every test for every batch · fixed in 2.83.0
- **Evidence:** 24 batches, 50 runs, 514 machine minutes in 26 hours, and growing with every ported system; its throwaway checkout downloaded LFS files it never read and could not see the web game its vector test compares against (the overseer's B-129), so that test was skipped in the check and failed in the land run.
- **Fix:** harness/engine-rules.mjs: `rules.env`, `rules.paths`, `rules.focus`, merged inputs, `rules.share`. qa/selftest-283c.mjs.

### P-305 — the engine train blamed by elimination · fixed in 2.83.0
- **Evidence:** 10 of 30 land runs failed (first red stage: Play Mode 5, Edit Mode 3, .NET 2). A lane was handed back "first not green" after a Play Mode test failed under load, without ever being run by itself; a switch-over was batched with a port; a lane handed back could not be restarted until the train ended.
- **Fix:** harness/unity-train.mjs: land alone, one more run on a retry stage, blame by evidence, a culprit by elimination confirmed by itself, a handed-back lane released at once. qa/selftest-283b.mjs.

### P-306 — a task was closed on its studio half · fixed in 2.83.0
- **Evidence:** a task with commits in the studio repo and on an engine branch was closed when the merge train landed the studio half; the engine branch was never queued and was found by hand.
- **Fix:** harness/task.mjs `engineHalfOpen`: the task stays open (`task.half_landed`) and its engine branch is queued. qa/selftest-283b.mjs.

### P-307 — the land run's shortcuts could hide a difference between two runtimes for good · fixed in 2.83.0 (the overseer's B-127)
- **Evidence:** .NET 8 and the editor's runtime printed a number differently; the .NET rules check passed code that failed in the editor. With "Edit Mode only what .NET didn't run" and "trust the rules check" both on, no later run would have shown it.
- **Fix:** a full land run every 24 hours (`STUDIO_LAND_FULL=1`, no shortcuts); `engines.unity.editModeArgs` so the owner chooses what Edit Mode runs on the other runs. qa/selftest-283b.mjs.

### P-308 — a landed change to the land script changed nothing · fixed in 2.83.0 (the overseer's B-128)
- **Evidence:** the studio's land command named the script in another worktree of the engine repo, on an old branch.
- **Fix:** harness/unity-train.mjs `landScriptDrift`: the train reports the file and the branch it is on. qa/selftest-283b.mjs.

### P-309 — a model-pool route overrode every role's own model · fixed in 2.83.0 (the overseer's B-126)
- **Evidence:** Director tasks ran on the builders' route instead of the Director's model; a session ended by a refresh or a usage limit was counted as the route failing.
- **Fix:** `routeRoles` in studio/models.json (default builder, engine-porter); harness/busy.mjs `endNotAFailure`. qa/selftest-283e.mjs.

### P-310 — the owner was asked in person about removing code · fixed in 2.83.0
- **Evidence:** a task that removed three unwired modules was refused to the owner's proxy as "deleting data".
- **Fix:** harness/owner-acts.mjs `unless`: one narrow reading, undone by one word of data; a stand-in's answer records the reading. qa/selftest-283j.mjs.

### P-311 — board commands that did something else than asked · fixed in 2.83.0
- **Evidence:** `task train dequeue T-x` did not exist and the unknown word started a train; an `--after` could be added and not removed; the train status did not show what was queued.
- **Fix:** harness/task.mjs: `train dequeue`, an unknown train word exits 2, `after --remove|--set|--clear`, two lists in the status. qa/selftest-283d.mjs.

### P-312 — landed engine worktrees and old builds filled the disk · fixed in 2.83.0
- **Evidence:** about 3 GB per landed engine worktree and one build folder per land run, cleaned by hand.
- **Fix:** harness/engine-clean.mjs; the train removes a landed lane's worktree and prunes builds. qa/selftest-283h.mjs, 283b.

### P-313 — watchers that cried wolf · fixed in 2.83.0
- **Evidence:** "stalled" for lanes waiting in a train; 37 refusals of the same unchanged-shots review; the idle stop counted the hours the supervisor was off; a dead session's claim held its task.
- **Fix:** harness/watch.mjs `laneInTrain`, harness/gamedev-loop.mjs, harness/review-family.mjs, harness/watchdog.mjs, `deadClaimOwner`. qa/selftest-283g.mjs.

### P-314 — planning sessions were started on a timer, whatever the last one did · fixed in 2.84.0
- **Evidence:** a crew's 26 hours: the Director's 33 regular cycles cost $38.83 and left one board change; the Producer's 80 timer and queue wakes cost $31 for 17 tasks.
- **Fix:** harness/wake-gate.mjs: the wait doubles after a session that changed nothing, up to a ceiling; a person's answer, an owner order or a phase change ends it. qa/selftest-284a.mjs.

### P-315 — a session could make the same-family review fallback apply to itself · fixed in 2.84.0
- **Evidence:** 2.83's check read which model families are configured from the calling process's environment.
- **Fix:** harness/review-family.mjs reads the main checkout's files; the environment can add a family, never remove one. qa/selftest-284b.mjs.

### P-316 — the documents cost more to read than the code they describe · fixed in 2.84.0
- **Evidence:** CHANGELOG.md 304 KB, thirteen release notes 131 KB, this file 149 KB, docs/SECURITY.md 46 KB.
- **Fix:** the newest entries in full, one line for each older one, the rest in git history.

### P-317 — the Unity test runner's floating tag cannot activate a Personal licence · worked around in 2.84.0
- **Evidence:** the repository's first real editor run: `game-ci/unity-test-runner@v4` (a rewrite since v4.4.0) ended with "Code 400 … TimeStamp validation failed".
- **Fix:** pinned to v4.3.2 in .github/workflows/ci.yml.

### P-318 — the engine train's evidence never saw a crew's results · fixed in 2.84.0
- **Evidence:** a crew's first 21.5 hours on 2.83: engine land runs passed 34.8% (2.82: 64.5%), 36.2 land minutes per landed branch. The blame by evidence read the land command's output; the crew's land script writes results files. A red run was repeated in full.
- **Fix:** `engines.<x>.results`, the stage report's `failures`, retry by test name, `flakyTests`, `compileFirst`, a killed run retried. qa/selftest-284t.mjs. Untested on a real editor.

### P-319 — the rules check took 12.7 GB on a 17-branch batch · mitigated in 2.84.0
- **Evidence:** the overseer's note: one test process for the whole batch on a 31.8 GB machine.
- **Fix:** `rules.focus.split`, `rules.maxLanes`, `batchMax`. qa/selftest-284t.mjs, 284u. Not measured on a live studio.

### P-320 — a reviewer planned on another family's model was started with the wrong tool, and two crashes halted the supervisor · fixed in 2.84.0
- **Evidence:** a launch of the default tool with a `google/…` model id exited 1 twice; the supervisor's two-identical-failures halt fired.
- **Fix:** harness/model-tool.mjs `toolForModel`; a mismatch is refused before start; a reviewer's launch crash backs that role off. qa/selftest-284w.mjs.

### P-321 — the overseer was refused decisions beta mode had given it · fixed in 2.84.0
- **Evidence:** unpark of an owner-rank park refused to every stand-in name but one; the engine merge needed the task's claim; `--force` with `--train` always refused while a tier-C lane must use the train; an upgrade could remove `studio/beta.json`.
- **Fix:** `ownerStandInRole`, `standInMay`, the owner's decision on beta powers (docs/SECURITY.md). qa/selftest-284n.mjs, 284q.

### P-322 — a start refused for a full crew put the task to sleep for up to 30 minutes · fixed in 2.84.0
- **Evidence:** the start back-off keyed on the refusal text with numbers removed, so "N agents already running" repeated.
- **Fix:** harness/supervisor.mjs `crewWideRefusal`. qa/selftest-284v.mjs.

### P-323 — every verify ran every gate · fixed in 2.84.0
- **Evidence:** docs-only and engine-only tasks ran the web game's build, tests and replays.
- **Fix:** harness/gate-tracks.mjs. qa/selftest-284x.mjs.

### P-324 — 2.83 was projected to raise the engine pass rate and did not · measured again in P-325
- **Evidence:** projected about 75% of land runs passing and 65% of tasks without an overseer step; measured 34.8% and 22% on a crew's first day.
- **Lesson:** a projection is not a measurement; a release's notes give the measured numbers of the release before it, and nothing built without a real editor is called an improvement until a crew's log says so.

### P-325 — 2.84 landed nothing without an overseer step · fixes in 2.85.0, not measured
- **Evidence:** a crew's first 16.3 hours on 2.84: land runs passing 46.2% (34.8% on 2.83), passing run 32.9 min (51.1), 0 of 26 landed tasks with no overseer step, 59.5% of hand-backs with a harness or machine cause, 3 of 15 scorecard targets.
- **Lesson:** faster land runs did not make the studio hands-free; the overseer's steps came from the harness's own false alarms (P-326 to P-330).

### P-326 — a task waiting in a train queue was handed back for "no running session" · fixed in 2.85.0
- **Evidence:** 30 of 73 hand-backs in that log; three in two hours parked a task (9 parks, 12 unparks by the overseer).
- **Fix:** harness/director-flow.mjs releases the claim quietly; harness/handback-kind.mjs is the one reading. qa/selftest-285d.mjs.

### P-327 — `task done` from the main checkout judged other roles' commits · fixed in 2.85.0
- **Evidence:** a `Golden-Reason:` line above a blank line in another role's commit refused every task's done; three sessions looped in four minutes; the crew patched it locally.
- **Fix:** the check reads the task's own commits; the hook moves the line into the trailer block; the same refusal twice holds the task. qa/selftest-285d.mjs.

### P-328 — a game-rules question was refused as the owner's only · fixed in 2.85.0
- **Evidence:** an ask about a price rule in the game could be answered by nobody but the owner, even with the owner's permission quoted.
- **Fix:** the owner-only list is deleting data, keys, publishing, tool definitions and beta-off; a word list that guessed at a question's subject is gone. qa/selftest-285c.mjs.

### P-329 — the daily full land run was invisible and blamed its branches · fixed in 2.85.0
- **Evidence:** it fell on a one-branch train after a 37 s compile check and was reported as the compile check running everything; its failures on the target handed the branch back.
- **Fix:** announced, a baseline for target failures, suspect first. qa/selftest-285a.mjs. No real editor.

### P-330 — the web train's automatic mode stayed off for a week · fixed in 2.85.0
- **Evidence:** an agent ran `train auto off` on 2026-11-06 "until the engine land holds the lock"; nothing turned it on and the daemon wrote nothing while off.
- **Fix:** an agent's off switch lapses; the daemon says why it waits. qa/selftest-285e.mjs.

### P-331 — the maintainer's inventory overstated what could be cut · lesson
- **Evidence:** "56 settings with no reader" was 2; three "noise" event kinds had readers; a "duplicate" module was not one.
- **Lesson:** a cut needs proof per item; `check-docs` now proves the settings case on every run.

### P-332 — a running supervisor kept the old code after an upgrade · fixed in 2.86.0, not measured
- **Evidence:** a crew's supervisor started the day before its 2.85 upgrade and was never restarted: 32 of 91 hand-backs were the false "claim ran out" kind 2.85 removed, no `task.claim.released` event, the web train's off switch never lapsed.
- **Fix:** harness/code-stamp.mjs; the supervisor restarts itself on new code; `upgrade --merge` names what still runs old code. qa/selftest-286a.mjs.
- **Lesson:** a fix is not shipped until the process that runs it has loaded it. Read the process's start time before judging a release.

### P-333 — hand-written rules map entries never matched · fixed in 2.86.0
- **Evidence:** every rules check for two days ran in full mode, twice per train (40 min); `focusFilters` refused any entry whose pattern grouped its prefixes although the filter used no group. Confirmed against the crew's own settings on both versions.
- **Fix:** harness/engine-rules.mjs; `rules.focus.auto`; results kept per part. qa/selftest-286c.mjs.
- **Lesson:** a feature's tests used the maintainer's own style of pattern; the first real configuration was never run through it.

### P-334 — one listed flaky test cost an engine train 6.5 hours · fixed in 2.86.0, not measured
- **Evidence:** a test that fails about half the time: red, one retry, red, two branches tied to it by file rules, five more land runs, one of them the daily full run; the branch handed back was the fix for the test.
- **Fix:** retries by name, a probe of the target alone, narrowing by test name, the full run alone on the target. qa/selftest-286b.mjs. No real editor; by-name narrowing needs the land script to honour `STUDIO_LAND_PROBE`.

### P-335 — the 2.85 refresh rule handed off sessions that had done nothing · fixed in 2.86.0
- **Evidence:** 35 hand-offs at 60% of the window by sessions that start at 65 to 70%; three in two hours parked new tasks.
- **Fix:** the rule is measured from the session's first work; harness-caused ends count against no task. qa/selftest-286d.mjs.
- **Lesson:** a threshold on an absolute number was shipped without one reading of where real sessions start.

### P-336 — the dead-code tool's first file list missed a hook · caught before release
- **Evidence:** a list of files by extension called a function dead that scripts/hooks/commit-msg (no extension) imports; removing it would have broken every commit. A search of all tracked files caught it.
- **Fix:** scripts/unused-exports.mjs reads every text file of the checkout. qa/selftest-286g.mjs.

### P-337 — a name defined nowhere, in a branch no new check took · caught by the online checks
- **Evidence:** harness/unity-train.mjs read `bisectMax` in the capped hand-back, outside the block that declared it; qa/selftest-279e.mjs took that branch on the online run and the train ended with a ReferenceError. The local run before the push covered the 2.83 to 2.86 units only.
- **Fix:** the cap is read through a function in scope. scripts/check-names.mjs (`npm run check:names`, a step of the online checks) reads every script for such a name. qa/selftest-286h.mjs.

### P-338 — the disk stop used the warning's level and stopped a small test machine · caught before release
- **Evidence:** with 7 GB free, the supervisor in three checks of qa/selftest-pu19.mjs started nothing: STUDIO_DISK_MIN_FREE_GB (20 GB by default) had become a stop in 2.86.
- **Fix:** the stop stays (its reason is in the pass's line); the self-test's clean environment turns the budget off as it does the memory floor, and qa/selftest-286f.mjs runs a real supervisor pass under the budget and with it off. docs/RELEASE-2.86.0.md says what a studio under its budget sees.

## Older problems (one line each; the full entries are in git history: git log -p -- studio/logs/PROBLEMS.md)

- **P-001** (reopened on purpose 2026-10-31: Hatch made the harness and hatchfield-game public so the online checks run free; they go private again once their checks pass (Hatch decides)): The harness repo is public, and two old public copies exist
- **P-002** (fixed 2026-10-31 (2.47, U-001)): The harness works with one adopted game repo; Hatchfield has two (web + Unity)
- **P-003** (fixed 2026-10-31): Engine template copy skipped every file on Windows
- **P-004** (fixed 2026-10-31 (2.52, U-003; root cause unproven)): The 2.41 "two greens" selftest failed once on CI timing
- **P-006** (fixed with a workaround): The game's code can't run outside Vite (import.meta.glob)
- **P-007** (fixed): Tests that force random rolls by replacing Math.random stopped working
- **P-008** (fixed 2026-10-31): The public guard's hooks folder switched off Git LFS's hooks
- **P-010** (worked around 2026-10-31 (repo public again, online checks green on #22 to #31); comes back if it goes private without the self-hosted runner): The private harness's online checks won't start (billing)
- **P-011** (fixed with a workaround): The web rules use structuredClone, which an embedded JS engine (Jint) lacks
- **P-012** (fixed 2026-10-31): Unity Hub showed an active Personal licence but no Unity_lic.ulf existed
- **P-013** (fixed in the Unity repo (PR #4, merged 2026-10-31)): GameCI refused to build: "Branch is dirty"
- **P-014** (fixed (in 2.53, PR #22)): Selftest 249 failed once the real logs were merged
- **P-015** (workaround): A URP sample icon shows as changed in every clone
- **P-016** (kept out of the public repo): Unity wrote Hatch's account IDs into ProjectSettings.asset
- **P-017** (fixed (Unity repo PR #8, merged)): Unity CI build killed at start-up (exit 137) after restoring a cached Library
- **P-018** (rebuilt on main): The Unity-port branch was 657 commits behind hatchfield-game main
- **P-019** (fixed): main's tests steer Math.random (withSeed, spies), which the rules no longer read
- **P-020** (fixed): Creating a game took one extra Math.random roll, shifting 7 seeded tests
- **P-021** (investigated, fix is a crew task): hatchfield-game main has been red on GitHub since at least Oct 17
- **P-022** (fixed in 2.54.0 (PR #27, merged)): The watchdog stopped a 44-minute-old studio for "no task finished in 2 h"
- **P-023** (fixed in 2.54.0 (PR #27, merged)): Planning sessions count as "sessions that ran" for the idle stop
- **P-024** (fixed in 2.54.0 (PR #27, merged)): Two "director-1" sessions started at the same moment
- **P-025** (fixed in 2.54.0 (PR #27, merged)): A docs task was started with a file scope in a folder the game forbids
- **P-026** (fixed in 2.54.0 (PR #27, merged)): The Producer pre-approved Godot tools for a web/Unity game
- **P-027** (fixed in 2.54.0 (PR #27, merged)): The launcher started one more agent in the same pass that stopped the studio
- **P-028** (fixed in 2.55.0 (PR #29, merged)): A stale session record under the same name took a fresh claim away
- **P-029** (caught before it ran): I wrote a force-push into a background merge command
- **P-030** (fixed in 2.55.0 (PR #29, merged) (2026-10-31, opus-1)): `npm run onboard -- --sync --dry-run` applies and commits anyway
- **P-031** (fixed in 2.55.0 (PR #29, merged); tested on Windows 2026-10-31 by grokbot in a fresh clone: Node v24.14.0, commit 3eb0cf2, `EXIT 0`, no "*.tsx" or "No inputs were found" error (2026-10-31, opus-1)): `npm run hub:build` type check fails on Windows (`*.tsx` not expanded)
- **P-032** (fixed in 2.55.0 (PR #29, merged) (2026-10-31, opus-1)): An unchosen pace lets the Director auto-start agents
- **P-033** (fix in T-026 (2026-10-31, opus-1)): Game: `src/branding/Finance.tsx` and `finance.ts` clash on Windows
- **P-034** (fixed 2026-10-31): The Unity folder on Hatch's PC had a pre-merge rules file
- **P-035** (workaround): Screen control can't see the Unity Hub window
- **P-036** (fixed (Unity repo PR #11, PU-21); in-editor run UNTESTED): Unity's replay tests don't play the rules
- **P-037** (fixed in 2.57.0 (PU-16)): An empty lock file makes a task unclaimable
- **P-038** (fixed in 2.57.0 (PU-16; re-run by hand: 10 started, 10 locks, 10 on the board, 5 rounds)): Ten starts at once leave the board wrong
- **P-039** (fixed in 2.57.1 (PU-17 rework; real-Windows PowerShell path proven only by Windows CI)): `agent stop` can kill an unrelated program
- **P-040** (fixed in 2.57.0 (PU-18; re-run by hand with random values)): The secret scan misses the crew's own kind of token
- **P-041** (fixed in 2.57.0 (PU-16)): Lost writes and a stop that fails open (leads, partly re-checked)
- **P-042** (fixed in 2.57.0 (PU-19; wording UNTESTED against a live limit)): Some usage-limit messages aren't recognised
- **P-043** (fixed in 2.58.0 (part B: the land lock retries EPERM/EACCES/EBUSY)): A Windows land-lock selftest flakes with EPERM
- **P-044** (fixed in 2.58.2 (the check waits for the page state; `--only stop-pause --repeat 30` passed 30/30 under load and with refreshes 4.5 s late, where the old logic got 0/10)): The HUD "Stop ends it and hands its task back" check flakes on main
- **P-045** (fixed in 2.57.1 (rework: no process call at launch or in listings; a stop during start-up stops the launcher)): The first PU-17 fix regressed agent sessions on Windows
- **P-046** (fixed in 2.58.0 (PU-33)): A token can still be committed: the commit hook scans the file on disk, not what is staged
- **P-047** (fixed in 2.58.0 (PU-34)): A stale or hand-edited verify record can close a task
- **P-048** (fixed in 2.58.0 (PU-35)): A game's own check settings aren't protected
- **P-049** (fixed in 2.58.0 (PU-36)): Text planted in tasks, notes and pitfalls reaches agents' prompts unmarked
- **P-050** (fixed in 2.58.0 (PU-39)): A silent agent whose process is alive holds its slot and task forever
- **P-051** (fixed in 2.58.0 (PU-40)): A usage limit on a custom-command agent doesn't stop the next launch
- **P-052** (fixed in 2.58.0 (PU-37)): `task done` killed between its two board writes makes the task vanish
- **P-053** (fixed in 2.58.0 (PU-37)): `task done` killed after the board write leaks the claim; nothing recovers it
- **P-054** (fixed in 2.58.0 (PU-37)): A watcher requeue can release a claim made a moment earlier: two agents on one task
- **P-055** (fixed in 2.58.0 (PU-37)): An error in `task start`'s board step leaks the claim (EPERM on Windows)
- **P-056** (fixed in 2.58.0 (PU-38)): A slow but live lock holder loses the lock after 10 s, and an update is lost
- **P-057** (fixed in 2.58.0 (PU-37)): Hand-added board lines in a slightly different format are deleted without a word
- **P-058** (fixed in 2.58.0 (PU-41)): When the events log rolls over (25 MB), readers lose the task history
- **P-059** (fixed in 2.58.0 (PU-41)): `metrics` slows down with the square of the event count
- **P-060** (fixed in 2.58.0 (PU-42)): Temp files left by a killed write pile up outside `.studio/locks`
- **P-061** (fixed in 2.58.0 (part A)): The size-growth done-check measures from the task's start, so merges from main count as the task's growth
- **P-062** (fixed in 2.58.0 (part F; games add *.snap text eol=lf)): On Windows, `verify` rewrote the line endings of a game test snapshot (`*.snap`), dirtying main
- **P-063** (fixed in 2.58.0 (part A: chore type)): Build, toolchain and chore tasks are asked for a regression that fails on the old code
- **P-064** (fixed in 2.58.0 (part F: detached verify; UNTESTED on real Windows)): Claude Code's low-memory guard killed background verify runs four times
- **P-065** (fixed in 2.58.0 (part D: auto-start opt-in)): The hub's watcher started an unwanted Producer session
- **P-066** (fixed in 2.58.1): On Windows the launcher split agent arguments that contain spaces (crew P-036)
- **P-067** (fixed in 2.58.1 (owner runs it once)): agy in headless mode denies its own shell commands (crew P-037)
- **P-068** (fixed in 2.58.2 before release): PU-29's hooks gate would have failed every in-flight lane task after the upgrade
- **P-069** (fixed in 2.58.3): The Producer and Director were refused 62 times: claude's `-p` read as a profile
- **P-070** (fixed in 2.58.3): A person's stop was recorded as a crash and halted the supervisor for 5 hours
- **P-071** (fixed in 2.58.3): Lane agents couldn't read their own role and brief
- **P-072** (fixed in 2.58.3): Claims held by an agent working outside the launcher were handed to new agents
- **P-073** (fixed in 2.58.3): The watchdog ignored an unpark and parked three times at once
- **P-074** (fixed in 2.58.3): Code agents on a task with no lane worked in the main checkout (crew P-039)
- **P-075** (fixed in 2.58.3): Files left on the main checkout blocked unrelated tasks for 3 hours
- **P-076** (fixed in 2.58.3): Done-check fixes from the crew's P-041, P-034 and P-035
- **P-077** (changed in 2.58.3): agy permissions: exact commands only, and a session settings file exists (crew P-037 addendum)
- **P-078** (added in 2.58.3): No coding agent could use the NVIDIA NIM key (crew P-040)
- **P-079** (kickoff note in 2.58.3): Agents lost turns to chained shell commands
- **P-080** (fixed in 2.58.3): Rescues escalated while nothing could pick them up
- **P-081** (fixed in 2.58.4): "Fails before the fix" passed when the old code never ran
- **P-082** (fixed in 2.58.4): A studio game with its own checks left a real cartridge with no gates
- **P-083** (added in 2.58.4): One global tick budget for every cartridge
- **P-084** (fixed in 2.58.5): The hooks gate crashed with ERR_STRING_TOO_LONG (crew report H-7)
- **P-085** (fixed in 2.58.5): `task done` re-ran the game's checks and timed out under load (crew report H-3)
- **P-086** (fixed in 2.58.5): The 2.58.2 upgrade's stash dropped board entries (crew report H-4)
- **P-087** (fixed in 2.58.5 (the key itself is Hatch's to make)): "No owner key" notes didn't say how to make one (crew report H-11)
- **P-088** (fixed in 2.58.5): The weakened-tests seed rule flagged loops over seeds
- **P-089** (fixed in 2.58.5): Crew builders took built-but-unlanded tasks when a claim lapsed (crew report H-5)
- **P-090** (fixed in 2.58.5 (launcher part planned)): A crew builder locked a whole source folder for an hour (crew report H-10)
- **P-091** (fixed in 2.58.5): The lock gate blocked `git merge main` in a lane (crew report H-6)
- **P-092** (fixed in 2.58.5 (per-agent key planned)): A custom tool command got no lane copy and edited the main checkout (crew report H-9)
- **P-093** (fixed in 2.58.5 (untested on real agy)): agy launches failed on Windows: "unexpected argument" (crew report H-2)
- **P-094** (fixed in 2.58.5): `allow agy` wrote 30 rules where 16 were approved (crew report H-2b)
- **P-095** (fixed in 2.58.5): `--tool nim` ran the role's model, and its default was end-of-life (crew report H-1)
- **P-096** (fixed in 2.58.5 (untested against real aider)): `--tool nim` child got no Authorization header (crew report H-8)
- **P-097** (fixed in 2.58.5): A session making its lane copy didn't count against the role's cap
- **P-098** (added in 2.59.0): Serial landing forced rebases and repeated verifies (brief #1)
- **P-099** (fixed in 2.59.0): A fixed 600 s game-check timeout failed under load (brief #2)
- **P-100** (fixed in 2.59.0): A clean rebase invalidated hook stamps (H-13)
- **P-101** (fixed in 2.59.0): Studio-Task listed every task the agent held (H-12)
- **P-102** (fixed in 2.59.0): Bug tasks with no cartridge coverage couldn't close; retitling was the only way out (brief #5)
- **P-103** (fixed in 2.59.0): Lanes ran their own stale copy of the harness (brief #6)
- **P-104** (fixed in 2.59.0): The launcher held too-broad lane locks (brief #8)
- **P-105** (fixed in 2.59.0): Heavy jobs overlapped on one machine (brief #11)
- **P-106** (fixed in 2.59.0): A second full verify ran beside the first (brief #11)
- **P-107** (fixed in 2.59.0): Agents started with almost no free memory (brief #11)
- **P-108** (added in 2.59.0): No supported way to give one agent its own API key (brief #14)
- **P-109** (added in 2.59.0): Clearing a halted supervisor needed the hub token (brief #15)
- **P-110** (added in 2.59.0): No gate for the Unity engine track (brief #16)
- **P-111** (fixed in 2.59.0): Render tasks on a non-Godot game couldn't produce their visual proof
- **P-112** (changed in 2.59.1): Owner-only commands refused agents even with the owner's direct permission
- **P-113** (fixed in 2.60.0): Stale pins blocked parallel lanes (crew 2.60 #1)
- **P-114** (fixed in 2.60.0): A red train guessed its culprit ("the last one waits")
- **P-115** (fixed in 2.60.0): The train handled deferred lanes twice
- **P-116** (fixed in 2.60.0): Barrel import lines conflicted on every landing (crew #2c)
- **P-117** (fixed in 2.60.0): The size rule forced every lane onto one line (crew #2a)
- **P-118** (fixed in 2.60.0): Nobody saw shared-line conflicts coming (crew #2b)
- **P-119** (fixed in 2.60.0): Upgrade commands arrived with the upgrade, and the documented merge was refused (crew #3)
- **P-120** (fixed in 2.60.0): The hooks gate failed on the harness's own unmerged commit (crew #4)
- **P-121** (fixed in 2.60.0): Killing a landing loop left verify and vitest running on Windows (crew #5)
- **P-122** (fixed in 2.60.0): A guessed task id got a lane copy and a stale key (crew #6)
- **P-123** (fixed in 2.60.0): Per-test timeouts tripped under load (crew #6)
- **P-124** (fixed in 2.64.0): A game check's timeout didn't scale on Windows (B-17)
- **P-125** (fixed in 2.64.0): `--tool nim` couldn't find aider in the studio's venv (B-18)
- **P-126** (fixed in 2.64.0): The default NIM model returned 404 for the crew's key (B-19)
- **P-127** (fixed in 2.64.0): aider pulled harness files into its chat and printed terminal warnings (B-20, B-21)
- **P-128** (fixed in 2.64.0): A failed NIM session left no evidence (B-37)
- **P-129** (fixed in 2.64.0): A board-only commit restarted the train's verify (B-29)
- **P-130** (fixed in 2.64.0): The hook-stamp check and restamp judged against different bases (B-30, B-32)
- **P-131** (fixed in 2.64.0): Merging main into a lane asked for a Golden-Reason (B-31)
- **P-132** (fixed in 2.64.0): task done --train named a check the train covers as its reason (B-33)
- **P-133** (fixed in 2.64.0): Unity builds ran outside machine:heavy (B-35)
- **P-134** (fixed in 2.64.0): Owner-reclassified render tasks still needed a visual result (B-38)
- **P-135** (fixed in 2.64.0): Rescue tasks piled up for lanes parked on purpose (B-39)
- **P-136** (fixed in 2.64.0): A lane's edit to studio config landed in main (B-40)
- **P-137** (fixed in 2.64.0): The Unity land gate could land main into itself, guessed its folder, and called exit 3 busy (B-41)
- **P-138** (fixed in 2.64.0): Agent-written lessons reached planning prompts unreviewed
- **P-139** (fixed in 2.64.0): A tier C lane could skip its hold through the old landing path
- **P-140** (fixed in 2.65.0): The crew orchestrator rebuilt lane state, refreshed lanes, wrote status posts and polled logs by hand
- **P-141** (fixed in 2.65.0): A train conflict was found only after its verify started (B-34)
- **P-142** (fixed in 2.65.0): Task order lived in prompts, not in the train
- **P-143** (fixed in 2.65.0): A lane couldn't carry studio config (B-40)
- **P-144** (fixed in 2.65.0): Routine questions waited for the owner
- **P-145** (fixed in 2.65.0): A session that never started, or a lane holding another lane's work, went unnoticed
- **P-146** (fixed in 2.65.0): Any chat author could make a trigger respond
- **P-147** (fixed in 2.65.0): Visual proofs sat at the edge of their noise; a full verify's gates could leave Windows orphans
- **P-148** (fixed in 2.65.1): A game check near its base timeout never printed why, and never got a floor (B-17, 2.65.1 hitlist #1)
- **P-149** (fixed in 2.65.1): `npm run lanes` and the queue disagreed on conflicts
- **P-150** (fixed in 2.65.2): cache writes priced as plain input
- **P-151** (fixed in 2.65.2): scorecard counted cache reads at full weight by default
- **P-152** (fixed in 2.65.2): OpenAI-format cached tokens counted as fresh input or twice
- **P-153** (fixed in 2.65.2): example-sim allowed two entities with one id
- **P-154** (fixed in 2.65.3): a red merge train took over an hour to find the lane that broke it (B-43)
- **P-155** (fixed in 2.65.3): Unity Hub's background `Unity.exe ... serve` counted as an editor outside the lock (B-44)
- **P-156** (fixed in 2.66.0): the scorecard counted landings, not tokens that did work
- **P-157** (fixed in 2.66.0): no generated-input testing
- **P-158** (fixed in 2.66.0): hand-backs lost which files changed; permission denials were never read
- **P-159** (fixed in 2.66.0): gate failures had no next step; about 400 settings, 226 undocumented
- **P-160** (fixed in 2.66.0): a list that silences a check had no guard
- **P-161** (fixed in 2.67.0): a stacked chain that passes only with one more fix was bisected apart
- **P-162** (fixed in 2.67.0): every owner action by an outside agent cost an owner round-trip
- **P-163** (fixed in 2.67.0): `--help` ran the command (B-47)
- **P-164** (fixed in 2.67.0): seeded tests silently on shared Math.random (B-48/B-45)
- **P-165** (fixed in 2.67.0): every lane went stale after an upgrade (B-49); a hold commit restarted a train's verify (B-29)
- **P-166** (fixed in 2.67.0): the scorecard couldn't see the orchestrator; no prices; tiers n/a; a stale halt; UTC days
- **P-167** (fixed in 2.67.1): no checks on asset work at landing, and nothing queued the engine wiring
- **P-168** (fixed in 2.67.1): no single asset flow; the studio's own library was never searched first
- **P-169** (fixed in 2.67.1): fresh Unity copies re-imported Library (~10 min); one flaky Play Mode test turned the gate red; code checks waited behind another lane's editor
- **P-170** (fixed in 2.67.2): a refused verify read as red main (B-50)
- **P-171** (fixed in 2.67.2): `task hold` didn't keep a lane out of a train
- **P-172** (fixed in 2.67.2): sessions ended with no work and were relaunched blindly
- **P-173** (fixed in 2.67.2): the "Regression saved" refusal was vague
- **P-174** (fixed in 2.68.0): the harness didn't know the machine it ran on
- **P-175** (fixed in 2.68.0): the RAM floor never tripped on Windows
- **P-176** (fixed in 2.68.0): heavy work ignored the machine's size
- **P-177** (fixed in 2.68.0): sessions burned with nothing landed; hopeless runs weren't flagged
- **P-178** (fixed in 2.68.0): usage ran out at the wall
- **P-179** (fixed in 2.68.0): temporary files piled up
- **P-180** (fixed in 2.68.0 (and 2.67.1/2.67.2)): a halt was lost when --until came first
- **P-181** (fixed in 2.69.0): a train re-ran a full verify a lane had just passed
- **P-182** (fixed in 2.69.0): slow tests sat on every landing
- **P-183** (fixed in 2.69.0): a red train searched one prefix at a time on an idle machine
- **P-184** (fixed in 2.69.0): trains waited for someone to start them
- **P-185** (fixed in 2.69.0): a flaky test looked like a broken lane
- **P-186** (fixed in 2.69.0): overlapping tasks were found only at merge; the queue ran dry; upgrades waited
- **P-187** (fixed in 2.69.0): overlap advice hid a failed start and kept an expired claim alive
- **P-188** (fixed in 2.70.0): the GPU sat idle while GPU-type jobs queued behind CPU verifies
- **P-189** (fixed in 2.70.0): no playable build after a landing
- **P-190** (fixed in 2.70.0): Unity runs repeated work
- **P-191** (fixed in 2.70.0): asset previews landed with no one looking
- **P-192** (fixed in 2.70.0): lane copies filled the disk unseen
- **P-193** (fixed in 2.71.0): owner decisions had no single record and no autonomous path
- **P-194** (fixed in 2.71.0): status and what's-next were posted by hand
- **P-195** (fixed in 2.71.0): builder briefs drifted from the rules; research had no shape
- **P-196** (fixed in 2.71.0): workarounds of the harness were recorded only in the overseer's notes
- **P-197** (fixed in 2.71.1): a lane could edit the gate runners that judge it
- **P-198** (fixed in 2.71.1): test configs, setup files and .npmrc were open
- **P-199** (fixed in 2.71.1): skipIf(CI), early returns on CI and a proxied expect weren't weakened tests
- **P-200** (fixed in 2.71.1): gate-weakening env overrides worked inside a lane
- **P-201** (fixed in 2.71.1 (partly)): hand-written or dirty-tree verify records were reused
- **P-202** (fixed in 2.71.1): NODE_OPTIONS, git replace and quoted paths fooled the gates
- **P-203** (fixed in 2.71.1): locks, output floods, untracked session costs, no rollback
- **P-204** (fixed in 2.72.0): a red golden said only "hash differs"
- **P-205** (fixed in 2.72.0): every game red was "game"
- **P-206** (fixed in 2.72.0): timeouts under load blamed the lane
- **P-207** (fixed in 2.72.0): standing purity hits drowned new ones; nothing stopped new hits
- **P-208** (fixed in 2.72.0): a game check couldn't prove it can fail
- **P-209** (fixed in 2.72.0): patch loops on the same red
- **P-210** (fixed in 2.72.0): engine gates could pass without proof
- **P-211** (fixed in 2.72.0): contract items went unseen; the same red was re-diagnosed from scratch
- **P-212** (fixed in 2.72.0): game logic was written again per game; CI was one long serial run
- **P-213** (fixed in 2.73.0): no check before or after a big harness update
- **P-214** (fixed in 2.73.0): upgrades made no measurable claims and had no clean "before"
- **P-215** (fixed in 2.73.0): the overseer's stages existed only on paper
- **P-216** (fixed in 2.73.0): a lucky week could suggest L3; autonomous work was reviewed only by choice
- **P-217** (fixed in 2.73.0): every task used the same model tier
- **P-218** (fixed in 2.73.0): a forged record + run log was reused; an author could release its own golden re-record
- **P-219** (fixed in 2.73.1): the crew stopped three times in an hour waiting for owner-only actions
- **P-220** (fixed in 2.73.1): builders were ended mid-verify by the stall watchdog
- **P-221** (fixed in 2.73.1): two same-second deaths halted the studio and its train
- **P-222** (fixed in 2.73.1): an agent name in the studio's .env made the owner's terminal an agent
- **P-223** (fixed in 2.73.1): empty folders in .lanes counted as lanes
- **P-224** (fixed in 2.73.1): restarting the studio took the owner 2.5 h
- **P-225** (fixed in 2.73.1): console windows flashed for every process on Windows
- **P-226** (fixed in 2.73.2): tests failed on time alone when the harness ran many test workers
- **P-227** (fixed in 2.73.2): main red on a check deadlocked every train, the fix included
- **P-228** (fixed in 2.73.2): Unity started short of memory; its abort was recorded as FAIL
- **P-229** (fixed in 2.73.2): a stalled session was "ended" again and again and still listed STALLED
- **P-230** (fixed in 2.73.2): .env changes reached only new processes
- **P-231** (fixed in 2.74.0): the War Room's buttons failed on a refused hub token
- **P-232** (fixed in 2.74.0): the hub kept dropping
- **P-233** (fixed in 2.75.0): the Studio floor was cluttered with cut-off names and agents long gone
- **P-234** (fixed in 2.76.0): every permission step waited on the owner during the beta
- **P-235** (fixed in 2.76.0): nobody kept the line moving or reported it
- **P-236** (fixed in 2.76.0): green lanes dropped, dead trains unrecorded, mixed lanes trained
- **P-237** (fixed in 2.76.0): Gemini builders, stalls, usage and lane copies went wrong for the crew
- **P-238** (fixed in 2.76.0): every check took every core; yes-waits unnamed; divergence missed shared loaders
- **P-239** (fixed in 2.76.1): a trust-note landing left its task open
- **P-240** (fixed in 2.77.0): agy ran Claude, logged 0 tokens, and builders drifted off their task
- **P-241** (fixed in 2.77.0): trains threw away verifies and lanes missed their approvals
- **P-242** (fixed in 2.77.0): no way to use cloud workers or make a lane by hand
- **P-243** (fixed in 2.77.0): engine passes were refused at done and never trained
- **P-244** (fixed in 2.77.0): the War Room was light, long and covered its own content; the Train Room ETA was a guess
- **P-245** (fixed in 2.77.0): lanes waited in line behind one 25-minute verify
- **P-246** (fixed in 2.77.1): the supervisor exited after its first pass (exit 13, "unsettled top-level await")
- **P-247** (fixed in 2.77.1 (partly)): agy builders ended mid-task with exit 0 and the fallback never fired
- **P-248** (fixed in 2.77.1): a beta-mode approval of a config proposal was not applied
- **P-249** (fixed in 2.77.1): an update's own commits failed the hooks gate on main
- **P-250** (fixed in 2.77.1): `train leave` didn't stop the running train's checks
- **P-251** (fixed in 2.77.1): a reused agent name with a leftover lane copy idled for an hour
- **P-252** (fixed in 2.77.1): permission denials were recorded again at every session end
- **P-253** (fixed in 2.77.2): an agent that ended with no commits stalled every launch for 20 minutes
- **P-254** (fixed in 2.77.2): a speculative train still verifying was reported "died silently"
- **P-255** (fixed in 2.77.2): 2.77.1's own commits failed the hooks gate after its merge
- **P-256** (fixed in 2.77.3): beta-mode owner records were "recorded", then ignored
- **P-257** (fixed in 2.77.3): a train sat 35 minutes holding its lock after a "real" verdict
- **P-258** (fixed in 2.77.3): fixed e2e ports collided between verifies and were called flakes
- **P-259** (fixed in 2.77.3): the stall killer stopped a P0 session twice in its first minutes
- **P-260** (fixed in 2.77.3): board state that blocked launches or undid parks
- **P-261** (fixed in 2.78.0): lanes could not be refreshed after a harness upgrade
- **P-262** (fixed in 2.78.0): a timing test failed "alone" under load and finished work was handed back
- **P-263** (fixed in 2.78.1): ready tasks without a lane ran one at a time
- **P-264** (fixed in 2.78.1): agy refused the stream input, and the failover was refused
- **P-265** (fixed in 2.78.1): the owner's hooks approvals never verified on the main checkout
- **P-266** (fixed in 2.78.1): an old train chain-started on the new harness
- **P-267** (fixed in 2.78.1): Unity and game trains starved each other
- **P-268** (fixed in 2.78.1): work that had landed kept tasks open or waiting
- **P-269** (fixed in 2.78.2): trains died with the builder that started them
- **P-270** (fixed in 2.78.2): one red result cost 1–2 hours
- **P-271** (fixed in 2.78.2): green trains were re-verified after unrelated commits to main
- **P-272** (fixed in 2.78.2): quarantined tests ran anyway, and re-checks ran the whole suite
- **P-273** (fixed in 2.78.2): an uncommitted beta approval passed the protected check
- **P-274** (fixed in 2.79.0): every task landed green while the game's first minutes were broken
- **P-275** (fixed in 2.79.0): queued lanes lost their copy at session end (2.78.2 regression)
- **P-276** (fixed in 2.79.0): `train auto off` didn't stop a train
- **P-277** (fixed in 2.79.0): a passing note with the word "protected" re-held a task
- **P-278** (fixed in 2.79.0): a reused PID read as a live record
- **P-279** (fixed in 2.79.0): the owner had to sign by hand in beta mode
