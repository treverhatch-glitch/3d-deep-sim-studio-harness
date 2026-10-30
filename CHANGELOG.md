# Changelog (`CHANGELOG.md`)

All notable upgrades to the **3D Deep Simulation & AI Game Studio Harness** are documented in this file.

---

## [2.31.0] — 2026-10-31
2.31.0: tracks really check in parallel, and no task can burn a day. Owner review of the Marina run (2.30o/q events, FOR_CLAUDE.md through Oct 30): `npm run verify` was never scoped, so a Godot-only lane ran every web check (~11.5 min per landing, which done-check then demanded again) and never ran the Godot gate; game gates timed out under parallel load (Gap 3); the session cap and stall check end one session, but nothing capped a task across sessions (refresh relaunches, watchdog restarts and re-claims by builders outside the harness could keep one task going for hours); a verify where no gate ran printed "all required gates green".
### Added
- **A budget per task, across every session** (harness/task-budget.mjs). Sessions on the task (launched ones, plus each claim by a builder the harness never launched), minutes it was claimed (summed over every claim) and weighted tokens (launched sessions plus `task done --usage` reports), counted since it was last done, reopened or unparked. Limits: `STUDIO_TASK_MAX_SESSIONS` (6), `STUDIO_TASK_MAX_MIN` (240), `STUDIO_TASK_MAX_TOKENS` (10M weighted); 0 turns one off, `STUDIO_TASK_BUDGET=off` all of them. A task over budget is parked by "budget" with the numbers and a "needs you" to the Producer; checked at `task start` (a re-claim of work in progress too), before every launch (first start, refresh relaunch, failover), on every launcher heartbeat (the running session is ended), and on every watchdog pass (catches outside builders' long claims). `npm run task -- unpark <ID> --by <name>` lets it run again and resets the count. `node harness/task-budget.mjs <ID>` shows the spend.
- **Gate slots (Gap 3)** (`withGateSlot` in harness/merge-lane.mjs). Each game check and the Godot engine gate takes one of `STUDIO_GATE_SLOTS` (2) box-wide slots in the main checkout's `.studio/locks/`, so a web lane and a Godot lane check at the same time but five lanes no longer pile onto one machine. The wait is logged and never counts toward a gate's timeout; a slot held by a dead process (or older than `STUDIO_GATE_SLOT_STALE_MIN`, 120) is taken over; after `STUDIO_GATE_SLOT_WAIT_MIN` (60) a gate runs anyway with a note. `STUDIO_GATE_SLOTS=0` turns slots off. A game gate that times out now says so.
- **`npm run verify -- --all`** runs every game check unscoped in a lane copy.
### Changed
- **`npm run verify` in a lane copy is scoped to the lane's changes** (scripts/run-gates.mjs): the files changed since the merge-base with the studio's branch, committed or not, go to the game gates as `STUDIO_GATE_CHANGED` and to the engine gate as `STUDIO_GATE_PATHS`. A Godot-only lane skips the web checks and now runs the Godot gate. Shared files (harness, scripts, gates.json, the manifest's `shared`) still run everything. The verify record carries `scoped`, `changed` and `base`.
- **done-check accepts a scoped verify only when it covers the task** (`gatesAfter`): every file the task changed must be in the verify's scope, or done asks for `npm run verify` again (or `--all`).
- **A verify where no gate ran fails** instead of printing "0/0 passed, all required gates green".
### Fixed
- **Engine cache files no longer block a landing** (deliver in harness/worktree.mjs): `.godot/`, `*.import`, `*.uid` files a headless Godot run rewrote don't count as uncommitted work, and tracked ones are set aside in a named stash (`studio land <T>: engine cache set aside`; recoverable, nothing deleted) so the rebase can run.
- **"Commit your work first" names the full path**: the porcelain output was trimmed before `slice(3)`, which ate the first letter of the first path ("odot/youda-marina-v2/...").
- qa/selftest-231.mjs: 12 checks (task spend across launched, late-claimed and outside sessions; each limit on its own, off switch, unpark reset; task start refuses and parks, unpark lets it start; gate slots serialize at 1 and overlap at 2, wait logged, dead holder taken over; scoped verify in a real lane copy incl. uncommitted files and engine paths; `--all`; empty verify fails; done-check coverage both ways; landing past a rewritten Godot cache; full path in the refusal).
### Not changed
- Refresh points (40 turns / 120k context), the 80-turn ceiling, the stall check (15 min no progress, 90 min per session) and the daily token cap (50M) are as before; the task budget sits on top of them.

## [2.30.0-q] — 2026-10-24
2.30q: the rest of the merge audit (12:23 ICT). Found in the Marina run (2.30.0-o events, 2026-10-23 04:52 to 2026-10-24 05:41 UTC): 12 landings refused by the main checkout's index, 37 of 83 hand-backs caused by the harness itself (all 6 watchdog parks rested on them), 88 watchdog "filed" actions naming only 31 tasks, 69 Gemini sessions started after Gemini's spend guard marked it out, and 40 of 94 dones by builders the ledger never saw.
### Fixed
- **Landing no longer depends on the main checkout's index** (harness/worktree.mjs `landFastForward`). deliver proves the fast-forward in a dedicated merge worktree (`.studio/merge-wt`, detached, no files; `git merge-tree --write-tree`), moves the branch with a compare-and-swap `git update-ref <branch> <new> <old>`, then brings the main checkout's index and files along (`read-tree -m -u old new`, waits out another process's index.lock). The main checkout's own uncommitted edits to files the landing changes are kept in a named git stash (`studio land <T>: ...`, `land.stashed` event to the human); `STUDIO_LAND_STASH=off` refuses instead, as before. If the checkout can't follow, the ref is swapped back and done says why.
- **Busy is not stalled** (harness/busy.mjs). `task done` marks `.studio/done-running/<T>.json` while its checks and landing run; a task with a running done, or whose lane has commits queued to land in a live lane copy, is busy: the Director's flow pass no longer hands it back ("claim ran out"), the stall check counts the wait as progress, and the watchdog never parks it.
- **Harness-caused hand-backs don't count toward parking** (watchdog step 2 and the launcher's parkIfLooping): claim ran out, the main checkout refused the merge, the land lock, the branch kept moving.
- **Watchdog filing noise.** A review or visual filing key files at most once per `STUDIO_REVIEW_FILE_MIN` (60) minutes; a duplicate key is never logged as "filed"; unchanged cameras are one task per pass; landings without a visual result are one task per pass.
- **The budget stop is checked before every launch** (`budgetStopFor` in harness/budget.mjs, `launchStop` in harness/agent.mjs): startAgent (manual, watcher, watchdog, Director flow, wake), a refresh relaunch and a failover. A mark stops a session when it names the session's tool, tool:model, the model's family (gemini-3.1-pro-preview -> gemini) or a word of the launch command, so custom launchers are covered; a `.studio/credit.json` meter at its guard stops launches before any mark exists. With every tool marked out nothing starts (it used to keep the original tool). One `launch.skipped` event per role/tool/model per `STUDIO_SKIP_LOG_MIN` (10) min. `STUDIO_BUDGET_STOP=off` opts out.
### Added
- **`task drain on|off|wait|status`** (harness/busy.mjs). While drain is on, a new `task done` waits before anything closes (polls every `STUDIO_DRAIN_POLL_MS`, 15 s; refuses after `STUDIO_DRAIN_WAIT_MIN`, 120, with nothing closed) and dones already running finish. `drain wait [--max <min>]` blocks until no done is running; `drain status` exits 3 while on, so builder wait scripts can check it. Upgrades start with drain on + drain wait.
- **`task done|pause <ID> --usage <model>:<in>/<out>`** (k/M suffixes, comma-separated models): builders launched outside the harness report their own tokens (`usage.reported`). `npm run ledger` shows an "Untracked (outside the harness, self-reported)" line and counts dones by agents with no usage at all.
- **Compact harness output in launched sessions** (`STUDIO_COMPACT_OUTPUT`, on for sessions the launcher starts): verify writes each gate's output to `.studio/gates/out/<gate>.log` and prints only failures (last `STUDIO_COMPACT_FAIL_LINES`, 40, lines) and the plain-words summary; `task list` shows what you hold, what is in progress and your role's next 8 (`--all` for the board). The kickoff's stable prefix says so (one stable change per role).
- **Stable-prefix check** (`volatileLeaks` in harness/prompt-layout.mjs): an agent name, model, task id or timestamp in a role's stable prefix logs `prompt.prefix.volatile`.
- qa/selftest-230q.mjs: 24 checks (drain: waiting done refused with nothing closed, drain wait; dirty main checkout lands and keeps the edit; the old merge refuses it; held index.lock; moved branch; busy marker; harness-caused hand-backs; watchdog parks; stall; filing cap; budget stop for custom launchers, credit meters, startAgent and refresh relaunch; usage parse, ledger bucket and CLI refusal; compact verify and task list; stable prefix).
### Not changed
- Graphics and quality settings, gate scope and the refresh limits. Gap 3 (game gates time out when several builders verify at once) stays open: proposed fix is one box-wide gate lock (FOR_CLAUDE.md).

## [2.30.0-p] — 2026-10-24
2.30p: tracks land on their own. Found in a live run with a browser build and an engine build in one repo: an engine-only task spent 695 s in browser gates, every landing re-ran every gate for every other in-flight `task done` (one chain ran 23 min, then failed), and a done read the board at its start and wrote it ~11 min later, wiping 5 tasks queued meanwhile.
### Added
- **Path-scoped gates.** A gate in `<game>/studio.gates.json` may declare `"paths"` (globs) and `"track"`; the manifest may declare `"shared"` globs (and `"layoutPaths"` for the layout gate). `task done` in a lane copy passes its diff against the studio's branch (`game-gates.mjs --changed`, or `STUDIO_GATE_CHANGED`) and only the gates whose paths it touches run; each skipped gate is logged with the reason (`gates.skipped` event). A gate with no paths always runs, and no known diff runs everything, so older manifests behave exactly as before. `harness/**`, `scripts/**`, `studio/gates.json`, package files and the manifest itself always count as shared.
- **Lane verify results are reused** (harness/merge-lane.mjs, `.studio/gate-pass/<task>.json`). A passing done records its commit, diff and gate scope. After a clean rebase, when every file the studio's branch brought in is outside that scope, deliver reuses the pass (`gates.reused` event) instead of re-running; otherwise it re-runs, scoped to the lane's own diff. `STUDIO_GATE_REUSE=off` always re-runs.
- **Short land lock** (`.studio/locks/land.lock`). Only the final "did the branch move?" check, the fast-forward and the board write hold it (seconds); gates run outside it, so different tracks verify and land in parallel. If the branch moved meanwhile, deliver rebases and re-checks scope (up to `STUDIO_LAND_TRIES`, 6). A lock older than `STUDIO_LAND_LOCK_STALE_MS` (120 s) or held by a dead process is broken; waits give up after `STUDIO_LAND_LOCK_WAIT_MS` (180 s).
### Fixed
- **Stale board overwrite.** `task done` re-reads `studio/NEXT.md` under the land lock right before writing and applies only its own move to DONE, so tasks queued, edited or closed while its gates ran are kept. Every other board write (`writeNextQueue`) also takes the lock, re-reads the board and keeps any task its snapshot never saw (added by another agent after the read); the lock is re-entrant within a process.
- qa/selftest-230p.mjs: gate selection, skip logging, reuse rules, a 4-process lock race, a concurrent done + board-write race and a stale-writer race (both fail on 2.30o), and a real lane copy landing over the other track (reused) and its own track (re-run, scoped).

## [2.30.0-o] — 2026-10-24
2.30o: the studio supervises itself. Ideas (not code) from a study of OhMyGame, plus fixes from the Marina overnight run: a Director planning session read ~2M tokens and landed nothing in 56 minutes, Godot tasks passed with no visible change, docks sat on the sand, the queue ran dry after the early game, and the watchdog only ran in away mode.
### Added
- **Stall check and wall-clock cap per session** (harness/stall.mjs). Every heartbeat and watchdog pass: no file write, commit or task change for `STUDIO_STALL_MIN` (15) min (`STUDIO_STALL_PLAN_MIN`, 8, for Producer/Director/planner), an input:output ratio past `STUDIO_STALL_RATIO` (120:1) over `STUDIO_STALL_RATIO_WINDOW_TOKENS` (300k) with no progress, or past `STUDIO_SESSION_MAX_MIN` (90; planning `STUDIO_SESSION_PLAN_MAX_MIN`, 25) ends the session, hands its task back and logs `session.stall`.
- **Idle sessions exit.** Any role holding no task (and making no progress) for `STUDIO_IDLE_EXIT_MIN` (5) min ends itself (`agent.idle_exit`) and frees its slot; the supervisor only starts sessions for ready tasks.
- **Visual proof for render tasks** (harness/visual-proof.mjs, harness/png.mjs). Before/after captures from fixed, named cameras in `.studio/proof/<T>/visual/`; a blank or transparent frame, a missing pair or a near-identical pair (`STUDIO_VISUAL_DIFF_MIN`, 1%) fails. `npm run visual -- capture <T> before|after --godot <project> [--cams a,b]` takes a real Godot frame: headless import, then the main scene under OpenGL (`--rendering-driver opengl3`, xvfb when there is no display), one PNG per camera.
- **Split verdict** (harness/verdict-split.mjs): build / logic / runtime / visual / viewport recorded separately, with an explicit unchecked list. `task done` refuses a render task (Godot, graphics, scene, water, piers ... or the Godot track) without a passing visual result (`STUDIO_VISUAL_GATE=off` turns it off).
- **Layout gate** (harness/layout-gate.mjs). A game exports its world layout as JSON and declares rules in `<game>/studio.layout.json` (reach-depth, on-water, at-anchor, no-overlap, scale, spread, count); the game gate runs it as `game:layout`.
- **Producer refill and milestones** (harness/producer-refill.mjs). Under 4 open builder tasks, tasks are derived from unmet charter exit criteria (round-robin across ladders), the asset list and failed visual/layout checks, tagged `[ref:]`, never re-listing open or done work. `npm run refill -- milestones | met M2 1 --by <who> | close M2 --by director`.
- **Development cycle** (harness/dev-cycle.mjs). Every 45 min, on a low queue or a closed milestone: a brief of landings, captures, playtests and unmet criteria for the Director and Producer; a thin bible gets Director tasks to write the core loop, feel, progression or late game as marked assumptions; a ladder near its end gets a task to propose the next milestone. Role prompts for the Producer and Director rewritten for ownership.
- **Profile check before launch** (harness/profile-guard.mjs). A Producer/Director/planner never starts on a profile in `STUDIO_SHARED_PROFILES`/`STUDIO_BUILDER_PROFILES` or one a builder is using; `STUDIO_PROFILE_MAX_SESSIONS` / `STUDIO_PROFILE_<NAME>_MAX` limit sessions per profile. The profile comes from `STUDIO_<ROLE>_PROFILE` or `-p/--profile` in the launch command.
- **Generic takeover.** Any launcher can join the budget order with `STUDIO_TOOL_<TOOL>_CMD`; entries may be `tool:model`. A run-out of any kind (quota, 429, credit refused, a spend or token cap, three or more 5xx refusals) marks the entry out and the next one in the order takes the task over at once (`tool.takeover`, to the human). Spend guards (harness/spend-guard.mjs: `.studio/credit.json` meters or `STUDIO_SPEND_GUARD_TOKENS_<TOOL>`) set the same mark.
### Changed
- **The watchdog is on whenever a studio game is active** (no away mode needed; `STUDIO_WATCHDOG=off` opts out) and runs the game-dev loop (harness/gamedev-loop.mjs): stall, refill, milestones, landings, spend guards, launches, a zero-token review of the newest captures every hour, and the development cycle. The hub runs it every `STUDIO_GAMEDEV_INTERVAL` (180) s; `npm run gamedev` runs it without the hub.
- **Away mode means more autonomy:** a 6-task queue, launches whatever the pace, reviews every 30 min.
### Fixed
- Windows CI (2.30n): the Godot engine-gate test used a shell script (EFTYPE on Windows); it now uses a node stand-in with a .cmd wrapper, and the gate runs .cmd/.bat Godot wrappers through the shell. The live-process lane test needs /proc; on other platforms it tests the claim/recent-change path instead.

## [2.30.0-n] — 2026-10-23
2.30n: the gates check the game the studio is building, not the bundled example. Found in the Marina build: every `npm run verify` and `task done` gated cartridges/example-sim, so the real game was never gated and builders had to --force.
### Fixed
- **Gates follow the studio's game.** With `task game <name>` set to a game that isn't a cartridge, the new `game` gate (harness/game-gates.mjs) runs the game's own checks: `<game>/studio.gates.json` if present, else `<game>/sim/qa.mjs`, `sim/playtest.mjs`, `sim/golden.mjs`. The cartridge gates (gates.json `"cartridge": true`: purity, isolation, golden, golden-py, regressions, vertical-slice, playtest, browser-play, soak, tick-budget) are skipped for it. A game that declares no checks fails the gate. No game set: example-sim's gates, as before.
- **`task done` runs them**, plus the engine gate, and refuses when they fail (`STUDIO_DONE_GAME_GATES=skip` turns it off).
- **Engine gate.** When a task's files (claims or lane) are in a Godot project, Godot runs headless: `--import`, then `tools/gate.gd` if the project has one. A non-zero exit or a SCRIPT ERROR / Parse Error / ERROR: line fails it. Binary: `STUDIO_GODOT`, else `godot`. Generated `.godot/`, `*.import` and `*.uid` files never count as code or as uncommitted work.
- **Lane copies.** A lane copy finds its main checkout from its own path (`<main>/.lanes/<agent>`) when `STUDIO_MAIN_ROOT` is missing (a shared tool gateway lost it in the Marina run, and T-034's forced done left its commit on the lane branch). When the path names no checkout, `task done` refuses instead of skipping the merge.
- **Identity.** `task start/done/pause` act as `--agent`, else the lane copy's name, and only then `STUDIO_LOCK_OWNER`; an inherited owner that disagrees with the lane is overridden with a warning.
- **`--force` needs `--reason`** of 10+ characters.
- **The system done-check's spec must name this task** (its ID in the file name or text), not any spec written since it started. The qa.mjs scenario check also accepts `web|game/<game>/sim/qa.mjs`.
- **Lane cleanup never removes a live copy.** preflight --fix, the gone-session sweep and lane re-creation keep a copy when a process works in it, its agent holds a claim renewed in the last `STUDIO_LANE_LIVE_MIN` minutes (20), or it changed that recently (T-024: a live externally launched builder's copy was deleted).

## [2.30.0-m] — 2026-10-23
2.30m: a build task has to change code.
### Fixed
- `task done` refuses a builder's change, system, bug, fun or balance task when no code changed since it started (committed or not; studio/ and .studio/ don't count). If the work truly is already there, close it with `task done <ID> --no-op "<what already does it, and where>"` (10+ characters, logged as task.noop). `STUDIO_DONE_NOOP=allow` turns it off. In the Marina run T-017 was closed with no change: its done check most likely counted an unrelated orchestrator commit whose message mentions "T-017".

## [2.30.0-l] — 2026-10-23
2.30l: two fixes from the 2.30k Marina run.
### Fixed
- One builder per task: two passes at once (the watcher and the Director flow) started T-025 twice at 17:13. The supervisor now skips a task with a live agent or a task lock, and takes an atomic launch lock (`launch:<task>`, 120 s, `STUDIO_LAUNCH_LOCK_SEC`) before it starts one.
- The studio's game is set apart from the gates' cartridge: `npm run task -- game <name>` (studio/game.json "game", or `STUDIO_GAME`). Lanes and file guesses use it, and a web game's sim is found at web/<game>/sim, so a web game like Marina gets file lanes instead of none.

## [2.30.0-k] — 2026-10-23
2.30k: builders lock only the files a task touches, so builders on different files run side by side.
### Changed
- A lane can be several files (`a.js,b.js`). `task add --paths a.js,b.js` sets them; `task lane <ID> a.js,b.js` changes them.
- With no lane given, the files are guessed from the task's title and brief against the game's own code files (boats, water, world, HUD, copy, sim hints; vendored three.js/jsm never). Nothing matched: the whole game folder, as before. `STUDIO_LANE_INFER=off` turns the guess off.
- The launcher claims each file and lets go of all of them; the Director's overlap check is per file.
### Fixed
- `task done` refuses uncommitted changes in the task's claimed files (or the game's folders when it claimed none), so they aren't committed later under another task. `--force` still saves them as a patch; `STUDIO_DONE_UNCOMMITTED=allow` turns the check off.

## [2.30.0-j] — 2026-10-23
2.30j: fixes from driving a real game (Marina) from the War Room. No new features.
### Fixed
- **Tasks added in the HUD sat idle when no pace was chosen.** The Director's flow pass now starts builders for ready tasks when the dev never chose a pace (`fillAgents({ byDirector: true })`); a pace the dev chose that doesn't auto-start is still respected. The flow's activity line is only repeated when it changes or after 30 minutes.
- **Latest playtest showed the example game.** The panel (and the Tycoon test light) read only reports for the active cartridge, and say "No playtest for <game> yet" instead of falling back to another one.
- **Liaison replied "User Safety: safe".** Safety-classifier lines and empty replies are no longer shown as answers (`isClassifierReply`); routes that answer 404/410 cool down for a day instead of being retried every message.
- **Token ledger, budget and sessions empty for sessions started by scripts.** New `npm run session:report -- start|end --agent A --model M [--role] [--tool] [--task] [--in N] [--out N]` (harness/session-report.mjs) records outside sessions with their model, so the panels count them.
- **Producer messages with no tool set.** The hub raises one "No tool is set to start the Producer" warning an hour, naming the .env setting.
- **Stale HUB-token banner.** When a token is loaded for the tab, the banner says so.
- **Duplicate Needs-you cards.** One card per task and reason (numbers in the text don't make a new card).
- **Danger buttons beside Sign off.** "Stop all agents" and "Throw it all away and restart" moved to their own danger row (restart still asks twice).
- **Cheat-sheet tips on unrelated tasks.** A tip needs two tag hits, or one hit on a narrow entry (at least a fifth of its tags), or a tag given explicitly; one word hitting a broad rule no longer attaches it.
- **Arcade had nothing playable.** After the launcher closes a task it runs the browser check (`qa/browser-play.mjs`, best effort, 5 min cap) so a passing build reaches the Arcade; `STUDIO_POST_BROWSER_PLAY=off` turns it off.
- **Small labels.** "Phase not planned yet" explains itself; the Tycoon clock is labelled Time, not Day.

## [2.30.0-i] — 2026-10-23
2.30i: two fixes from real game builds (Marina, and a two-task A/B on another studio) plus NIM limits. No new features.
### Fixed
- **Sessions that end without `task done`.** When a session ends without `task done` (a clean exit, or a crash after it committed) and the task has a new commit from that session, the launcher runs `npm run verify` in the foreground itself; if it passes it closes the task with a logged reason (exit code, verify passed, commit). Otherwise the task is handed back with the last lines of the verify output in the note. A crash without a commit, provider trouble, a reasoning-only reply or a refresh is handed back as before. `STUDIO_AUTO_FINISH=off` turns it off. The builder loop now says never to run verify, checks or tests in the background (no `&`, `run_in_background` or `nohup`).
- **`agent start` reads `.env`.** The agent CLI loads `.env` (harness/dotenv.mjs) before it starts anything, so keys like `ANTHROPIC_API_KEY` reach the session without a wrapper. It never overrides what the shell already set and never prints a value.
- **NVIDIA NIM: one session at a time, and 429s in the stream.** NIM sessions default to one at a time (`STUDIO_NIM_MAX_SESSIONS` raises it); a second is refused at start. An HTTP 429 the provider writes into the stream json (`error.code`, `error.status`, `status`, `api_error_status`) now counts as a rate limit, not only one on stderr, so the session fails over: to `--fallback`, or to `STUDIO_NIM_FALLBACK` (tool:model, another family) when none was given.
### Tests
- qa/selftest-230i.mjs: which ended sessions get the launcher verify, 429 in stream json vs an agent mentioning 429, .env loading without override, NIM detection and default of one, and the builder loop's no-background rule.

## [2.30.0-h] — 2026-10-23
2.30h, in the reviewer's order: the cheap false-green stoppers first (reasoning-only replies fail, Godot gates fail on scripts that don't parse or on frames-only smoke runs, CI is watched after a push), then the Director keeps builders fed from clean work only, model limits (Claude/Opus included) as Director awareness, and design fidelity as a scored report the Director reads. Details in docs/DIRECTOR-FLOW.md.
### Added — false-green stoppers
- **Reasoning-only replies are failed hand-offs (#3).** In the router, a reply with reasoning and no answer is `route.reasoning_only`: the attempt fails (no cooldown) and that model family is passed over for the rest of the call. A launched session that ends with an empty result after spending output tokens is handed back as failed (`agent.reasoning_only`), and its next session is rerouted to another family (`STUDIO_REROUTE_MODELS`, or suggested to the Director when none is set).
- **GDScript parse check (#7).** `harness/gdscript-parse.mjs` (`npm run gdscript:parse -- <project>`) parses every .gd on its own with `godot --check-only`. The engine gate, the Godot template check (CI's engine-godot job) and the godot-unit gate fail, naming the file and Godot's error, when one doesn't parse, even when the engine's run exited 0.
- **Frames alone are not a check (#7).** The Godot template's gate.gd fails when no test in res://tests/ ran or the main scene has no `smoke_report()`, and prints how many test scripts ran; `npm run engine:gate` fails a Godot run that reports smoke frames but no test (a 300-frame smoke run showed PASS before).
- **CI watch (#5).** `npm run ci:watch [-- --sha <c>] [--detach]` waits for CI on a commit, re-runs failed jobs once, and when still red raises `ci.failed` (Director card, phone alert), runs `STUDIO_CI_NOTIFY_CMD` (a notification hook) and records .studio/ci-watch.json. `npm run release -- <version>` uses it for its CI step.
### Added — flow, limits, fidelity
- **The Director keeps the builders fed (#2).** `npm run director -- flow`, and a pass every minute in the hub (STUDIO_FLOW_INTERVAL) and in the supervisor's loop. It frees locks held by agents whose process is gone, hands back claims that ran out, counts idle builder slots against ready work, refills them through the launcher (same caps, lanes and pace), and raises `director.flow.starved` (a phone-alert kind) after STUDIO_FLOW_IDLE_MIN (10) idle minutes. It refills only from work that isn't parked or held, behind the circuit breakers: a task whose last hand-back was a failure is listed as failing and never counts as ready (it is never re-fed); the breaker or a person decides what happens to it.
- **Model limits as Director awareness (#4).** `npm run models:limits`: each model's context ceiling and rate limits (built-in approximate figures for Gemini, NVIDIA and other free models and for Claude/Opus/Sonnet, GPT and Grok, overridden by studio/model-limits.json), use in the last 24 h, and flags (near the day's cap, a prompt near the context ceiling, 429s, reasoning-only replies), in the Director's brief and the Director card. Nothing reads it to block a model; the Director decides what to hand each model.
- **Design fidelity as a scored report (#1).** `npm run fidelity` scores the build against the reference game's mechanics read from the Game Bible (bible.json's `fidelity` section; fallback studio/fidelity.json), a probe per mechanic in qa/fidelity/. It is a report the Director reads, not a hard gate: it exits 0 (1 only for a bad checklist, e.g. an entry asking to copy the reference's code or art); `--strict` fails on a missing required mechanic. `npm run fidelity -- send-back` (and the Director's flow pass) queues one `[fidelity:<id>]` builder task per missing mechanic, once. Mechanics only.
- **Director-adjustable trick cap.** `npm run cheatsheet -- cap N` sets how many cheat sheet tricks each new task gets pre-approved (default 3, 1 to 6; .studio/cheatsheet-cap.json, logged as `cheatsheet.cap`). `task add --tricks N` and `--max N` on `cheatsheet match`/`attach` override it for one task.
- **Port from a pinned commit.** `npm run engine -- port --from <sha>` copies the web rules (cartridges/<game>/) at that commit to engine/<game>/port-src/ and records `portFrom` in engine.json, so the Godot port isn't blocked by a moving web game.
- **HUD check in the gate cache (#6).** The HUD gate (`cacheDeep`) reuses its last pass when nothing it reads changed, in the fast tier and in `--deep` runs; the merge tier always runs it.
### Fixed
- Locks held by agents whose process is gone are freed by the Director's flow pass at once (`lock.dead_released`), not left to run out. Owners with no launcher session (a person) are never touched.
- `npm run engine -- capture`: Godot resolved the relative `--write-movie` path against the project folder, so frames went to engine/<game>/engine/<game>/captures/ or nowhere; the path is now absolute.
- `npm run release` sets package-lock.json's version itself outside CI (scripts/lock-version.mjs, shared with the release ship), so a bumped package.json can't ship with a lagging lock (the 2.30d miss). In CI it still only checks.
### Notes
- `hire` already starts agents detached by default (`--foreground` to stay attached); unchanged.
- The daily token cap is on by default: 50M weighted tokens per UTC day across all models. `STUDIO_DAILY_TOKEN_CAP` in .env changes it (`off` or `0` turns it off); see README, "The daily token cap".
### Self-test
More checks in qa/selftest-230h.mjs (fidelity as a report and from the Bible, flow skips failing tasks, dead-agent locks, frames-only Godot runs, the absolute capture path, the port pin, the Claude/Opus context ceiling, the trick cap). The fidelity sabotage is gone: it is no longer a required gate. The HUD check adds the Director card (a starved flow and a red CI job).

---

## [2.30.0-g] — 2026-10-23
2.30g, token savers: every session of a role starts with the same bytes, long output is trimmed before an agent reads it, know-how loads only when a task needs it, and a Godot unit gate. Details in docs/TOKEN-SAVERS.md.
### Added
- **Cache-friendly kickoff.** Fixed role text first, per-session text last; prefix hashes in `.studio/prefix-ledger.jsonl` with a `prompt.prefix.changed` event; cache write and hit rate on every session end; 1-hour cache for the Director and Producer; a quiet SessionStart for launched sessions. `npm run prefix`.
- **Hooks.** Output trimming (PostToolUse), a guard on generated folders (PreToolUse), and a Stop gate that runs the fast checks. The Stop gate is fast-only: a 6 s budget (hook timeout 10 s), and checks that don't finish in time are skipped rather than blocking, so it can never add minutes to a run.
- **Skills on demand.** `.claude/skills/` (Godot, gdUnit, web build, assets, the Producer's playbook).
- **Token norms per task type** (`npm run token-norms`, HUD flags only, never a cap) and **verdict notes** in briefs (context, not rules).
- **`godot-unit` gate** (gdUnit4 v6.2.2, Godot 4.7.2), opt-in per game.
### Not possible here
- Server-side clearing of old tool results is an API option; the harness runs Claude through the CLI, so trimming and the session cap stand in for it.
### Self-test
11 more checks (one proves a hanging check is skipped inside the Stop gate's budget), plus a sabotage that proves the godot-unit gate fails on a failing gdUnit run and names the test.

## [2.30.0-f] — 2026-10-23
2.30f: parallel floors. A later phase can start its own pipeline while the one before it is in art or polish, behind an objective scenario gate, and game content becomes data with a schema per layer. Details in docs/FLOORS.md.
### Added
- **Parallel floors.** `studio/floors.json` (`maxParallel`, `autoOpen`, `requireScenarios`) turns them on; without it nothing changes. The main phase gets a stage (`bible.phase.stage`: build, art, polish, done) and each extra floor is listed in `bible.phase.floors`. `npm run floors -- status | open <n> --by <person> | stage <n> <stage> --by <name> | tick`. A floor opens only as the next phase number (up to 3), never twice, and manually only by a person (the same rule as signing the Bible). With `autoOpen` the supervisor opens the next floor once the newest one is in art or polish, fewer than `maxParallel` phases (the main phase counted) are in build, and the scenarios pass. `task add --phase N` accepts an open floor. Build tasks on a floor default to the lane `cartridges/<game>/floors/phase-<n>`, so the existing lane and lock checks keep floors apart.
- **Phase scenarios (ROADMAP 2.8.0 leftover).** Scripts in `qa/scenarios/phase-<n>/*.mjs` (`export default async () => ({ ok, why })`) must pass before the next phase or floor opens (`npm run check:scenarios -- --phase <n>`). Each scenario has a time limit (60 s, `STUDIO_SCENARIO_TIMEOUT_MS`); a refusal names the failing scenario and its reason.
- **Content as data (C1).** `npm run check:content` checks `cartridges/<game>/content/<layer>.json` against `studio/bible/schemas/<layer>.schema.json`: every item needs an id and an integer phase, content for a crossed-out layer fails. Optional gate for now.
- **HUD:** a Floors card in Ops shows the main phase, its stage and each open floor.
### Self-test
New checks: floor open refuses a skipped number, a duplicate, phase 4 and an agent; tick waits while the main phase is in build and opens after art; the parallel limit counts the main phase; failing and hanging scenarios block; floor lanes clash only when they overlap; the content gate passes clean data and fails schema, phase-tag and crossed-out-layer errors. The HUD check sees the Floors card.

---

## [2.30.0-e] — 2026-10-23
2.30e: art the game can use (found and adapted), one token ledger across every provider, faster checks while working, and a rehearsal with no model.
### Added
- **Art scout, wider (G7).** `npm run scout -- find "<what>" --kind model|texture|palette|reference|any` filters Poly Haven by type (textures, models, HDRIs), keeps ambientCG for textures and adds Lospec for palettes. `npm run scout -- palette <slug>` pulls a palette only when its page says CC0 or CC-BY, records it in the asset ledger (`kind: palette`, with the credit for CC-BY) and makes it the art department's palette (studio/art/palette.json). References (2D or 3D) stay in the reference library and are never shipped. Every pulled asset carries a `kind`. The allowlist and CREDITS.md work as before.
- **Adapt step for the art agent.** `npm run adapt -- <asset-id|file> [--palette <json>] [--max 1024] [--lod N]`. PNG textures (8-bit RGB or RGBA): box-filter resize so the longest side fits, rounded to a power of two, then every pixel recoloured to the nearest palette colour (alpha kept); the palette defaults to studio/art/palette.json. OBJ meshes: duplicate vertices welded, degenerate faces dropped, and LODs by vertex clustering (`<name>.lod1.obj`, ...). Each output lands in assets/adapted/ and goes in the ledger with `derivedFrom`, the steps, and the source's licence, author and credit, so CREDITS.md still credits a CC-BY source. glTF and other formats are refused with a message.
- **Token ledger (#14).** `npm run ledger -- [--since 24h] [--by task|agent|role|model|provider] [--json]` joins launched sessions (Claude result lines, Codex, Hermes), router calls, vision checks and proxy call logs (`studio/ledger/*.jsonl` or `STUDIO_LEDGER_LOGS`, for example a Gemini proxy's log). Tokens only, no prices. A free model that reports no usage is estimated at 4 characters per token and marked "est." everywhere; the router now records the characters sent and received for this. Metrics: tokens per finished task, sessions with no task done, turns p50 and p95, and today's budget used against the daily cap. Every token count names its model: one model by name, or `mixed: gemini-2.5-pro 60%, claude-sonnet 40%` by token share (the top three, then others); each group line in the breakdown carries its own model mix. A session that recorded no model reads "model not recorded".
- **Scout quality score (G7).** Every `npm run scout -- find` hit gets a 0-10 quality score from what its source reports: resolution (4k full marks), texture maps (albedo, normal, roughness), a sane poly count for models (500 to 200k triangles), popularity (a rating, or downloads on a log scale) and tags. Parts the source doesn't report don't count either way. Hits are listed best first with the reasons; `--min-quality <n>` drops those under the bar and says how many. `--vision` (or `STUDIO_SCOUT_VISION=1`) with `STUDIO_VISION_URL` and `STUDIO_VISION_MODEL` asks a vision model to rate the thumbnail, averages it in, and logs its tokens to studio/ledger/scout-vision.jsonl, which the token ledger reads under that model. `pull --quality <n>` keeps the score in the asset ledger. OpenGameArt, Kenney and Sketchfab stay as check-by-hand links: their search pages give titles only, so there is nothing to score without opening every item.
- **glTF/GLB in adapt.** A `.glb` or self-contained `.gltf` is checked (magic, version 2, declared length, chunks, `asset.version` 2.0, buffers, buffer views, accessors, images) and copied unchanged to assets/adapted/ with the credit carried. A broken file, or a `.gltf` pointing at files beside it, is refused with the reasons and nothing is written. No recolour or LODs for glTF yet.
- **Token ledger tiles in Ops.** Four tiles above Tokens used: tokens per finished task, no-done %, turns p50 / p95, daily budget used (or "cap off"), each token tile naming its model or model mix, with the providers and models listed and estimated ones flagged. They wrap on a phone.
- **Tiered checks (#7).** `npm run verify -- --tier fast` is the in-session check: only the lite gates, and a gate whose command and files are unchanged since its last pass is skipped (`PASS <id> (cached <hash>)`). The key is a hash of the command, the cartridge picked in env, and every file in the checkout (git's list, or a walk of the folder outside git); a gate can narrow it with `"inputs"` in gates.json. Only passes are stored; a failure removes the entry. `--tier merge` (full and deep) and everyday verify never read the cache, and a fast run never counts as a full verify for task done. `--no-cache` or `STUDIO_GATE_CACHE=0` turns it off. Deep and browser gates are marked `"cache": false`.
- **Rehearsal mode (R6).** `STUDIO_REHEARSAL=1` makes the router answer from a script (studio/rehearsal/script.json, or a built-in one per role) with zero tokens, and makes the launcher start harness/rehearsal-agent.mjs when no command is set for the role. `npm run rehearse -- --tasks N` takes N builder tasks from the board through the real launcher (claim, lock, work, done, session events) and prints what happened, with the model tokens (0).
- **Vision check (F15), opt-in.** `npm run vision -- [T-012 | --shot <png>] --on [--min <score>]` (or `STUDIO_VISION=1`) sends a task's proof screenshots and the art reference to an OpenAI-compatible vision model (`STUDIO_VISION_URL`, `STUDIO_VISION_MODEL`, `STUDIO_VISION_KEY`) and prints a 0-100 score with what matches and what differs, saved to qa/reports/vision-<task>.json; tokens go in the ledger. Advisory by default; `--min` makes it block. An optional `vision` gate checks the newest proof.
### Fixed
- Found by the new self-test while building this: the gate cache hashed nothing in a folder outside git (every run looked unchanged); the adapt step recoloured before resizing (averaging left colours off the palette); LODs pointed faces at vertices that no longer existed.
- The art scout no longer drops ambientCG results that its own search already matched, and `--kind any` lists the model and texture sites to check by hand (palette lists only Lospec).
- The HUD check's ledger tile compared the no-done share with a fixed 50%, but earlier steps in the same run start and pause agents; it now checks the tile against the ledger's own number for that run.
### Self-test
15 more checks: palette pull and refusal, texture recolour and resize with the credit carried, mesh fix and LODs, the assets gate with adapted art, ledger metrics, estimated free calls, proxy logs, no prices in the output, the fast tier's cache hit and its miss after a planted fault, the merge tier ignoring the cache, rehearsal through the launcher with zero tokens, the scripted router, and the vision check's off, block, pass, advisory and no-model paths. The HUD check adds the ledger tiles on desktop and phone.

---

## [2.30.0-d] — 2026-10-23
2.30d, the steering batch: forced work waits for a second opinion without stopping the lane, big tasks split themselves, only the leads add to the live queue, fun checks run in batches, and the dev can step away and review every call on return. Details in docs/AWAY-AND-ALERTS.md.
### Added
- **Forced work is "done (pending)" (plan #9).** `task done --force --reason "…"` records the reason and opens an approval card (studio/pending-review.json, event task.pending_review); the task is done and its lane moves on. A person, or a reviewer from another model family, closes or reopens it (`task pending`, `task review <ID> --close|--reopen --by <name> [--model m]`, or Accept / Reopen in Your call). The forcing agent and same-family reviewers are refused.
- **Size cap and auto-split (plan #5).** Builder tasks are size 3 at most; `task add --size 4|5` queues a linked planner task ("Split T-x into builder tasks of size 3 or less") and holds the big task until it is done.
- **Director-only queue (plan #6).** Only the Director, Producer and planner (and people) add to studio/NEXT.md. Other roles' adds go to studio/proposed.json with a one-line `--why`; the Producer promotes them in batches (`task proposed`, `task promote P-1,P-2 | --all [--drop P-3] --by <name>`). The dev's own asks, the watcher and the liaison queue directly.
- **Model escalation (plan #3).** After a failed hand-back the next session on that task starts one tier up (cheap → mid → top) on `STUDIO_TIER_<TIER>_MODEL`; with none set it is suggested in the event log (model.escalation_suggested), never enforced.
- **Tricks on add.** `task add` matches up to 3 cheat sheet tricks (never a director line) and attaches them pre-approved, logged as cheatsheet.preapproved. `STUDIO_AUTO_TRICKS=0` turns it off.
- **Fun check in waves.** A gameplay task closes into the open wave (studio/waves.json) instead of waiting for its own browser play. `npm run wave -- ready` marks the batch ready; `npm run wave -- check` reads the next browser play: pass → the wave passes; fail → one linked "Fix wave" task. Other lanes keep building; new gameplay work joins the next wave. `STUDIO_FUN_WAVES=0` restores the per-task check.
- **The watchdog in the studio.** A dog in its own kennel room on the Studio Tycoon floor: asleep on its bed while the watchdog is off, awake and patrolling the room while it is on.
- **Away mode and "While you were away".** `npm run away -- on|back` or I'm away / I'm back in Your call. On return every Director and Producer decision made while away is a card with its screenshots, clip or details; ✅ Great, ❌ Redo (reopens the work) or 💬 Comment (to the workers' hand-off notes). Verdicts are kept in studio/away/reviews.json and studio/memory/decisions-learned.md; the leads read `npm run away -- learned`.
- **Phone alerts, opt-in.** `npm run alerts -- on --channel ntfy|telegram`: studio stopped, watchdog actions, pending reviews, the away summary and parked tasks reach the dev's phone, at most 5 per watch pass, never the backlog. Keys only in .env.
- **Phone access with a secure login (H3), opt-in.** `npm run phone -- on` prints a one-time code (only its scrypt hash is stored); /phone logs one phone in with a 12-hour HttpOnly cookie, writes need its per-session CSRF value, 5 wrong codes lock that address for 15 minutes.
### Changed
- The 2.30b per-task fun check is the fallback mode (STUDIO_FUN_WAVES=0); sim features (J4) are still per task.
- An agent's own add (builder, QA, art, reviewer, R&D and other non-lead roles) now needs `--why` and waits for promotion.
### Self-test
18 more checks: the pending card and who may close it, reopening forced work, the split task and its hold, the proposed list and promotion, escalation one tier per failed hand-back, tricks on add, waves (done check, batch, fix task, pass), away items with media and the three verdicts, alerts (opt-in, no flood, no key leak), phone login (one-time code, lockout, CSRF, nothing stored in clear), the hub's phone routes, the kennel and the War Room state.

---

## [2.30.0-c] — 2026-10-23
2.30c, the quick wins: agents read less at the start, a task that keeps failing the same way stops costing sessions, the Producer starts only when something happened, and a release ships with one command. Details in docs/RELEASE.md.
### Added
- **Short command output (#4).** `task start` prints the brief's path and a 10-line summary; its JSON carries `carryForward` (the newest hand-off notes, at most 3k characters) in place of the whole hand-off history, which stays in studio/handoffs/<ID>.md. Hand-back notes stay under 3k characters (20 lines). `npm run handoff` prints at most 3k characters (`-- --full` prints all; the full briefing is always saved).
- **Circuit breakers (#8).** After one failed hand-back, a second with the same reason (numbers, ids and paths ignored) parks the task with that reason and a War Room card with Unblock. Refreshes, stops and quota hand-backs never count. Other tasks and lanes keep starting. `npm run task -- unblock <ID> --by <name>`; `STUDIO_BREAKER=off`.
- **The Producer on events (#11).** The supervisor and the watcher's check-in start a Producer session only after a task is done, forced or tripped, or a card or question appears; at most once per 15 min unless urgent (a P0 Producer task, an escalation); the wait doubles while nothing changes, up to 4 h. A person starting it is never held back. The status line says when it starts next. `STUDIO_PRODUCER_MIN_MIN`, `STUDIO_PRODUCER_WAKE=always`.
- **Dependency-aware handout (#12).** The supervisor skips a task whose `--after` prerequisite is done but still on an unmerged lane branch, or whose folder another agent holds, tries the next task in that group, and marks it "waiting on X" in the queue.
- **studio/DONE.md (#13).** Finished tasks move there; NEXT.md keeps only open work. An older NEXT.md's DONE section still counts and moves on the next write; `studio:reset` resets both.
- **The allowlist in every kickoff (#15).** Builder, Producer, Director and Liaison kickoffs list exactly what runs without asking; it is the same 2.23 list the launcher passes to Claude Code (harness/allowlist.mjs).
- **Gates in plain words (G3).** `npm run verify`, the run report and the release report list failing gates first, one plain sentence each; "not run" is listed apart and never read as a pass.
- **Overnight summary (G6).** At `--until` the supervisor writes studio/daily/overnight-<date>.md: tasks done, tokens per finished task with the model named, sessions that finished nothing, forced closes, reviews, the top 5 sessions by tokens and open cards. `npm run overnight -- --since 8h` by hand. The status line links the latest one.
- **Release tooling.** `npm run release -- <version> [--notes f] [--title "…"] [--shots dir] [--backup-dir dir] [--dry-run]`: checks main is in step with origin, bumps the version, writes the CHANGELOG entry, makes one squashed commit, runs verify --deep (self-test included) and the War Room browser check in a fresh clone, bundles origin/main to the backup folder, pushes to main without force, waits for CI (a failed job is re-run once) and reports failing first. Any red step before the push undoes the commit and pushes nothing. `npm run release` with no version is still the check CI runs. This release shipped with it.
### Self-test
14 more checks: the 3k carry-forward and the 10-line start, the hand-back and briefing caps, the breaker (trips on the same reason, not on refreshes or different reasons, other work goes on, unblock), the Producer's events, 15-minute floor, urgency and doubling wait, the handout's unmerged prerequisite and held folder, DONE.md and the old layout, the allowlist in every kickoff and the launcher, gates in plain words in verify and the run report, the overnight summary, and the release command's refusals. The War Room browser check adds 2: the breaker card with Unblock plus the Producer and overnight lines, and Unblock clearing it.

- Docs: ROADMAP marks F16 (qa/fails-before.mjs, since 2.12.0), H2 and H6 (the Arcade, since 2.21.0) done; SESSIONS.md names 2.30d for the remaining planned items.

---

## [2.30.0-b] — 2026-10-22
2.30b, the hard batch: gameplay is checked with real keys and clicks, a sim feature counts only once the build shows it, and free art comes in with its licence and credit on record.
### Added
- **Real-input fun check (J1).** A cartridge lists `browser.probes` in its qa.mjs (`move`, `sprint`, `jump`, `aim`, `camera`); `npm run play:browser` drives them with real keys and clicks (qa/fun-probes.mjs) and reads `window.__view()`: WASD moves along the camera's forward and right, sprint covers at least 1.2x the ground, jump lifts the player, a shot hits the enemy under the crosshair, the camera is never inside geometry. A failing probe is a FUN-PROBE finding; a probe the build has no view for is PROBE-UNWIRED, never a pass. A gameplay task (movement, sprint, jump, aim, shooting, camera, controls) closes only on a browser play after its last change with every probe passing, plus a clip since it started. The Arcade shows the fun check.
- **Not done until the build shows it (J4).** A cartridge lists `simFeatures`; each must be a probe or a `browser.features[name] = { key | click, expect(before, after) }` that changes the screen. One that isn't bound, or shows nothing, is SIM-ONLY, and a sim task on that game stays open while any feature is.
- **Asset scout (G7).** `npm run scout -- find "<what>"` searches Poly Haven and ambientCG (CC0) and links Kenney, OpenGameArt and Sketchfab with licence filters; `npm run scout -- pull <url|file> --licence --author --source --title` takes only CC0 or CC-BY (anything else is refused and pointed at `asset add --use reference`), puts the file in assets/scouted/<source>/, marks it `scouted` in the asset ledger and rewrites CREDITS.md. The assets gate fails on a disallowed licence, a CC-BY file with no author, or (once anything is scouted) a stale CREDITS.md. The Asset studio lists scouted art with its licence, author, source and credit state. References stay in the reference library and are never shipped.
### Self-test
11 more checks: each probe passes a good game and fails its own fault, unwired probes, sim features bound and unbound, browser-play wiring, the gameplay and sim-feature done checks, scout search offline, the licence allowlist, pull into the ledger and CREDITS.md, and the gate on stale credits or a bad licence.

---

## [2.30.0-a] — 2026-10-22
2.30a, the moderate batch: the dev's words drive the queue, the dev can overrule a gate, and the War Room says plainly what waits on whom. Details in docs/STEERING.md.
### Added
- **Intent card and task origin (J2).** Tasks are tagged dev-asked or agent-proposed (`task add --origin dev --asked "…"`; an agent's add is agent-proposed). `npm run intent -- echo --asked … --wont … --tasks …` puts "You asked for: X. I will NOT change: Y." in the War Room's new **Your call** box; one click confirms. An agent-proposed mechanic (a phrase, not a lone word) waits for the dev's yes (`task yes <ID> --by <dev>` or the button); other work never waits.
- **"Do it now" (J3).** `npm run bible -- phase open <n> --now "<the dev's words>" --by <dev>` (or **Open Phase N now**) opens the gate at once and logs what it skipped as the risk (`bible.phase_override`). Agents can only relay it, with the dev's words and where.
- **Plain status line (J10).** Building now · Waiting on you (what) · Tokens today (models named), at the top of Ops. Every waiting task names its owner and why.
- **Steering commands (J11).** `task drop <ID> --why "…"` and `task reorder <ID> --to top|bottom|<n>|--before <ID>`.
- **Watchdog (G1), opt-in.** `npm run watchdog -- on|off|status`, or the switch in Your call. Off by default. When on: unanswered refresh checks hand off after 15 min, a task handed back 3 times in 2 h parks, no task done in 2 h stops the studio.
- **Arcade: what changed (J8).** Each build lists the tasks finished since the build before; the Arcade shows what changed since you last played. With no saved web build, the engine's web export plays instead of "Nothing to play yet".
- **Plugins, opt-in:** godot-mcp (pinned 0.1.1) and ccusage (pinned 20.0.40). `npm run budget -- ccusage` copies Claude Code's own daily totals into the ledger; the Budget meter shows them.
### Fixed
- **False "limit hit" stops (J12).** A session killed while its last lines were its own transcript (a test's output quoting "usage limit reached" or "429") was marked out of quota. Stream events are now skipped; the quota probe and the cross-family reviewer read only the failed command's error output (a review that mentioned "quota" marked the reviewer out for an hour); the War Room's "out of quota" badge uses the same provider-message test instead of any mention of "quota". A stop now records the counted tokens of the last 5 h and the model, and `npm run budget` shows them.
- **Scope checks match phrases (J11):** "licence", "mood" and other lone words no longer refuse unrelated tasks; "add a licence system" still does.
- **HUD noise (J13):** Serena starts with its dashboard closed; no desk or bot in a locked room.
### Deferred to 2.30b
J1 real-input fun check, J4 "not done until the build shows it", G7 asset scout. Also not in 2.30a: model escalation, size cap with auto-split, director-only queueing, tiered checks (plan #3, #5, #6, #7).
### Self-test
13 more checks: origin tags and the mechanic hold, the dev-only yes (and relays), the intent card, drop and reorder, phrase scope checks, the phase override and its risk, the false quota path and the provider's real one, the stop's numbers, the watchdog off and on, the plugin entries, ccusage into the ledger, and the status line, owners and what-changed in the War Room state.

---

## [2.29.2] — 2026-10-22
Stop the waste, finished: the two 2.29 items that didn't ship (the turn budget for one-task sessions and the shorter start), plus the quick wins from the overnight test run on 2.28 (Oct 22, 104 sessions, one top-tier model on every role: 261.6M cache reads, 7.9M fresh input, 1.5M output, all counted by Claude Code; 16 sessions finished nothing; context grew to 315k tokens, up to 126 turns). None of it slows a build: caps hand off, checks are cards. docs/SESSIONS.md.
### Added
- **Refresh context by default.** A launched session does one task, or refreshes at 40 turns or 120k tokens of context, whichever comes first: it commits, hands back with done / failed / next / standing rules (under 3k characters) and stops; a fresh session continues the task from the note. Claude Code gets `--max-turns 80` (the ceiling). A session that reaches it, or is told to hand off, is a refresh, not a failure: the launcher saves the work and starts a fresh session on the same task at once (no failover, no cooldown, not counted as looping; `STUDIO_REFRESH_RELAUNCH`, default 5). Limits: `STUDIO_SESSION_TURNS`, `STUDIO_SESSION_CONTEXT`, `STUDIO_SESSION_CEILING_TURNS`, `STUDIO_CHECK_TURNS`, `STUDIO_CHECK_TOKENS`.
- **Mid-debug exception, flagged and checked.** `npm run session -- exception "<repro>"` lets an agent with a live repro go on to the ceiling. The heartbeat reads turns and context from the session's own log and raises a "Check <agent>" card for the Producer and Director at every 20 turns / 40k tokens past the refresh point (an unflagged session one step later); `npm run session -- check <agent> continue|handoff`. `npm run session` lists every session, with the model next to its counts.
- **Per-role model suggestion and the top-tier warning.** `.env.example` and `npm run models:check` suggest tiers per role (builders and Producer mid, Director and planner top, check-ins cheap, reviewer another family). Nothing is enforced. With the top tier on every role, every War Room view shows "Overpowered models on every task may not be efficient and can weaken cross-family checks." until the game dev clicks I accept (or `models:check -- --accept-top-tier <name>`); a different set of models asks again.
- **The cheat sheet check, with pre-approved tricks.** `studio/CHEATSHEET.md` (one line per trick: id, tags, trick, link; under 150 lines). `npm run cheatsheet -- attach <ID> --by <name>` attaches up to 3 matching tricks to a task's brief as **pre-approved**: the agent may use them for that task without asking, and the approval is recorded (`cheatsheet.preapproved`: task, trick ids, approved_by). Anything not attached follows the normal approval rules (AGENTS.md section 5). A **director section** (dependency-aware handout, size-3 split, one owner per lane, check-ins, routing by tier) is matched only for planning (`match --for director`) and never attached to a builder's task; the Director and Producer consult it when planning or queueing. Seeded with 65 entries: the harness's own tricks, Godot tools and tests (godot-mcp, Gut, gdUnit4), token and context tools (ccusage, context7, the warm-compaction hand-off on a cached prefix), QA eyes (Playwright MCP, Chrome DevTools MCP, browser-use, Stagehand), web prototype engines (real builds still go through the Godot web export), free CC0/CC-BY asset sources for the art role (Poly Haven, Kenney, ambientCG, OpenGameArt, Sketchfab; recorded through `npm run asset`), and a physics rule: moving objects use real collision shapes and the engine's physics, never scripted moves that skip collision.
- **War Room (Ops view):** a Budget meter (today's counted tokens against the daily cap; per model: sessions, in, out, cache reads); Sessions and context (turns and context against the refresh point, refresh due, mid-debug flagged, checks owed, Continue / Hand off); the top-tier warning with I accept and a "Check an agent" signal on every view; the attached tricks under each task in the queue, marked pre-approved with who approved them and the trick ids.
### Changed
- **The budget meter counts cache reads,** at a weight (`STUDIO_CACHE_READ_WEIGHT` or `cacheReadWeight` in studio/budget.json, default 0.1): `npm run budget`, the supervisor's `--budget`, the daily cap. It saw 4.66M against 100M+ in that run, so `--budget 95%` could never trip. Each tool's line names its models. `studio:start --budget <n>%` warns when no week's tokens are set.
- **The daily token cap has a default:** empty means 50,000,000 counted tokens a day (about 1.4x that whole run, counted this way); a number sets it, `off` or 0 turns it off. The router, the Director's auto-start and preflight use the same value.
- **A shorter carry-forward:** the brief shows the newest 3k characters of a task's notes, not all of them (median hand-off was 21k characters); `studio/handoffs/<ID>.md` keeps everything.
### Deferred to 2.30
The opt-in overnight watchdog (G1), model escalation after a failed hand-back, the size cap with auto-split, director-only queueing, tiered checks, auto-matching tricks inside `task add`, and the 2.29.2 slot's other quick wins (breakers and unblock, producer backoff, dependency-aware handout, DONE.md, the allowlist note, plain failing-test reporting, the overnight summary).
### Self-test
22 more checks: the refresh rule, the exception and its checks, the turn ceiling end to end, cache reads in the meter, the daily cap default, the model warning (shown, accepted, never blocking), the cheat sheet (pre-approval recorded, the director section), the 3k carry-forward and the War Room state.

---

## [2.29.1] — 2026-10-22
2.29.0's CI was red: three self-test checks (map find, the function-size check, the size ratchet) failed on Linux and Windows.
### Fixed
- **No parser is an error, not an empty answer.** `harness/codeindex.mjs` reads JavaScript with the `typescript` dev dependency; where it wasn't installed it returned nothing, so `npm run map -- find` found nothing and the size check passed. Now `map find` and `scripts/check-function-size.mjs` fail and say to run `npm install`, and the done-check's size ratchet names the file it couldn't check.
- **CI installs the packages** (`npm ci`) before the release gate and the Windows verify; neither did, so the parser was never there.
- The self-test's 2.29 checks link the harness's `node_modules` into their copy (the copies don't carry it), and a new check proves map find fails loudly without it (404).

---

## [2.29.0] — 2026-10-22
Stop the waste: test #3's top open items (Jed's list) and the Grok Bot + Gemini list, item 10.
### Added
- **One working copy per lane.** An agent the launcher starts with a code lane works in its own git worktree, `.lanes/<agent>/`, on its own branch, so another builder's half-done edits can't reach its tests or commits (test #3: 2 browser-play fails and several forced-done tasks came from the shared checkout).
  - `studio/` and `.studio/` stay shared (linked, and left out of the copy's own checkout), so there is one board, one set of claims and one event log. `.env` is copied; `node_modules` folders are linked (junctions on Windows).
  - `task done` in a copy refuses uncommitted work, rebases on the studio's branch, runs the everyday checks again if that branch moved, then fast-forwards the studio's branch. A conflict or a red check is the agent's to fix; nothing is merged half-checked.
  - A session that ends without finishing keeps its commits on its branch; the next agent on that task gets them merged into its copy, and uncommitted files are saved in `.studio/wip/`. Stop all, Pause and a dead session's clean-up do the same.
  - Each agent's verify is kept in `.studio/gates/<agent>.json`, and its done-check reads its own.
  - Needs git 2.42 or newer; on older git or with `STUDIO_WORKTREES=off` agents share one checkout as before. Preflight says which, and `--fix` removes copies left by ended sessions (keeping unmerged commits on their branches).
- **The launcher finishes what an agent forgot to.** 18 of 64 sessions in test #3 ended without `task done`, most while a full verify ran in the background, which dies with the session. When a session ends cleanly holding a task, the launcher runs its done-check (and the everyday verify if only that is missing) and closes the task when it passes; otherwise it is handed back as before. Not for tasks whose done is a decision (type none). `STUDIO_AUTO_FINISH=off` turns it off.
- **Long commands stay in the foreground:** Claude Code agents get a 10-minute shell timeout (`BASH_DEFAULT_TIMEOUT_MS`), and the kickoff says how long the last full verify took.
- **`npm run map -- find <name>`:** where a function, constant or TUNING key is, with its arguments and line range, in one call (a real parse with the TypeScript compiler; GDScript by line scan). The kickoff now points to it instead of "read the map first": Jed's sandbox A/B found that reading a map, then line ranges, added turns and cost 27% more.
- **The size ratchet:** `scripts/check-function-size.mjs` (optional gate) lists game functions over 80 lines and files over 400 lines or 30 KB. A task can't finish if it made one bigger or made a new one; edits inside one that don't grow it pass. On Next Floor it finds `step()` at 227 lines.
### Decided
- **Closed-loop auto-fix (the PDF's item 11):** the middle way. A failing gate already becomes a P0 "Fix" task with the trace (escalated after 3); now that task is worked in its own copy and reaches the studio's branch only after its checks pass. Nothing is committed without an agent and the gates.
### Fixed
- **The done-check counts commits from the commit a task started from** (recorded on `task.start`), not by the clock: git keeps whole seconds, so a quick agent's commit in the start's second was missed. A task started before 2.29 still goes by time.
- When the launcher can't close a task, it says why (`agent.finish_refused`).
- The hub smoke test waits up to 10 s per request (one timed out at 3 s on a busy machine).
- Self-test: 8 more checks (403).

---

## [2.28.0] — 2026-10-22
From the Grok Bot and Gemini reviews (their combined list, items 1–7), Jed's test #3 report on 2.27.2, and the notes his agents left during the run.
### Windows
- **Setup from PowerShell:** PowerShell can block `npm.ps1` ("running scripts is disabled"). The README says to use `npm.cmd run …`, `setup.cmd` runs the setup without npm, and `npm run help` prints `npm.cmd` on Windows.
- **No Git Bash needed:** session start, the pre-compaction checkpoint, the daily summary, demo events, the token-saver setup, the virtual display, append-event, snapshot-state and distill-bug are Node scripts now (`scripts/*.mjs`). The `.sh` files only call them, and the Claude Code hooks in `.claude/settings.json` run `node`.
- **Self-test and HUD check timing:** the self-test's supervisor runs and deadlines scale on Windows (`STUDIO_SELFTEST_SLOW`, 2.5 there by default); the HUD check waits for Stop and Pause to land instead of a fixed second.
### Tokens: measured, or labelled
- **`npm run tokens`** and a **Tokens used** panel in the War Room: input, output and cache reads by role, model, agent or tool, for the last 5 h, today or the whole log, from what each tool reported when its session ended. Sessions whose tool reported nothing are listed as not measured; work outside the launcher is named as not counted.
- **Turns per session:** the launcher records Claude's `num_turns` (and Codex's turn count). Cost follows turns more than file size: Jed's sandbox A/B found a map-first workflow added turns and cost 27% more cache reads.
- **The made-up numbers are gone:** the old War Room's 248,500 tokens, 84% and $4.68, the War Room buttons that wrote `tokensSaved` into real events, and the fake savings in the pre-compact hook, append-event and the token-saver setup. `npm run seed:events` adds demo events only to an empty log, marked `[demo]`, with no token numbers.
### Lite scope
- **`npm run mode -- scope lite|full`**, separate from the pace. Lite runs 6 gates in everyday verify (purity, isolation, golden, regressions, playtest, secrets; marked `"lite"` in `studio/gates.json`), shows ten commands in `npm run help`, and makes Claude Code load `AGENTS.lite.md` (about 400 tokens) instead of `AGENTS.md`.
- A fresh clone (still on the template game) is Lite; a studio that already builds a game stays Full until someone chooses. `new-game` keeps the scope the studio had. Preflight keeps `CLAUDE.md` in step with the scope (`--fix`).
- `CLAUDE.md` no longer auto-loads `studio/llms.txt` (about 6k tokens in every session); agents open it when they need a command.
### Verify and setup hygiene
- **Everyday verify skips the harness self-checks** (selftest, hub-smoke, hud: `"deep"` in gates.json). `--deep` runs them; `npm run release` and CI always do. The done-check accepts an everyday full verify.
- **`package-lock.json` matches `package.json`.** It said 2.2.0, so every `npm install` rewrote it and it showed as changed in every agent's hand-back. Setup uses `npm ci`, preflight `--fix` sets a lagging lock's version, and the release refuses a mismatch.
- **Setup installs Playwright's Chromium** (skip with `--no-browsers`).
- **A retro never rewrites a day that already has one**, so a committed retro doesn't show up as changed.
- **The parity gate waits for real porting:** while `engine/<game>/sim/sim.gd` is still the template, parity skips with a note (test #3: 13 parity fails in builders' verify runs, all "still the template").
### From test #3
- **FIX 06:** a same-family review note that says it isn't an approval no longer blocks READY. `npm run preflight -- --fix` moves it to `studio/reviews/same-family/` and records the cross-family review as owed.
- **Hire runs in the background** unless `--foreground`, so a hired agent no longer dies with the shell that hired it.
- **Dead sessions are cleaned up:** the watcher marks a session whose process is gone as ended (with an `agent.session.end`), hands its task back and releases the path claims it left.
- **The heartbeat renews the agent's claims,** so a long task doesn't lose its claim under a working agent.
- **Forced done saves the owner's uncommitted work** in its claimed folders to `.studio/wip/<task>-<agent>-forced.patch` and names it in the event.
- **`task park … --until T-ID|phase:N|time`:** a park that ends by itself (tasks parked until Phase 2 stayed parked 5 h after it opened).
- **"blocked by T-12" in a hand-back note** holds the task until T-12 is done, so it isn't picked up again for the same reason.
- **The done-check counts from the first `task.start`** since the task was last finished or reopened, so work done before a hand-back counts; another agent's uncommitted work in its own claimed folder no longer counts as this task's change.
- **A bug in the docs** ("Bug: docs gate …", a `.md` file) closes like a docs task, not with a sim replay.
- **`task pause` says why** when the task isn't in progress (already queued, done, or not on the board).
- **The kickoff** tells launched agents their environment is already set, and to run `npm run verify` in the foreground before `task done`.
- **`balance-sweep --write`** replaces only its own block in `studio/balance/latest.md` and keeps what people wrote around it.
- **War Room:** the Asset studio names the meshopt and Draco decoders for compressed GLBs; the pace buttons wrap on a phone; the HUD check skips the Arcade checks that need a build when the game's browser check failed, instead of failing three times for one game bug.
- Self-test: 9 more checks (395). HUD check: 61.

---

## [2.27.2] — 2026-10-21
From Hatch's notes on the War Room and the engine track.
### Fixed
- **The Arcade plays bundled builds.** A vite game (the default base `/`) asks for `/assets/index-….js` at the root, not under `/play/<id>/`, so its saved build showed a black screen in the Arcade while it played in `npm run play:browser`. The hub now serves those requests from the build the Arcade opened last.
### Added
- **The engine build in the Arcade's own screen:** "Play it here" puts the engine's web export in the same frame as the web build ("Back to the web build" returns). Export Godot without thread support to play it framed.
- **Following how the port is made:**
  - `studio/engine/LOG.md` records every engine gate, parity and capture run: when, who, on which commit, the result;
  - the run report has an **Engine track** section (gate and parity results, the porters' sessions, tasks and cache reads);
  - the run report has a **Tokens by role** table: sessions, tasks done, cache reads per session and per task done.
- **The Asset studio's next round:** approving the last design waiting gives the art department a "next round" task at once (and wakes it), so a new set comes in. Approved files still move to `assets/approved/`.
- **A narrator role** (`studio/roles/narrator.md`, in the Narrative department, off by default): a storyteller with a personality who turns the dev's brief and the Bible into story pitches on the Idea Board, never canon until the dev says yes.
- Self-test: 3 more checks (386).

---

## [2.27.1] — 2026-10-21
### Fixed
- **`npm run task -- stop` now stops the running agents.** Since 2.24 it set the stop switch but never reached the agents: it imported the launcher, which imports it back, and the command exited 13. The War Room's Stop all was not affected. It now stops them in a child process. Found while writing test #3's update steps.
- **Stop all and Pause save each agent's uncommitted work as a patch** (`.studio/wip/<task>-<agent>.patch`) before they hand its task back. Before, the hand-back freed the claims first, so the launcher's clean-up found nothing to save.
- **A supervisor halt names the missing program on Windows too** (cmd.exe exits 1, not 127, for an unknown command).
- Self-test: 1 more check; the hand-back cap test no longer passes a multi-line note through cmd.exe.

---

## [2.27.0] — 2026-10-21
The engine track: a Godot (or Unity, Unreal) version of a game that is proven in web, run as its own team and linked to the web game only by a parity test. From the SendIt experiment (Godot playable in about 3 hours, Unreal slow for 7) and Jed's test #2 ("Godot first needs a custom gate and a capture-based equivalent of browser-play").
### Added
- **`npm run engine`** (harness/engine.mjs, docs/ENGINE-TRACK.md):
  - shows the engines with their expected usage and trade-offs (Godot recommended);
  - `propose <engine>` refuses until Phase 1 is proven, then asks the game dev (a Needs-you question with the cost);
  - a person's yes (War Room, or `npm run ask -- answer <id> yes`) starts it: `engine/<game>/` (for Godot from the template), `engine.json` with the game ID and the commands, the Engine Transfer department, `engine-porter` tasks tagged `engine:<name>` in that lane, and `studio/engine/PARITY.md`;
  - `capture` writes frames of the real engine build (Godot's movie writer; `xvfb-run` on a Linux server).
- **`engine/_godot/`**: a worked Godot 4 port of the template game. Its sim is mulberry32 bit for bit (u32, i32, imul), its policy is the web scenario's, and its scene is built in code. It has a gate (`tools/gate.gd`: tests, then a 300-frame smoke run) and parity (`tools/parity.gd`, one JSON line per seed). Checked with Godot 4.5.1: the same outcome, tick and credits as the web game on seeds 1–5 and 1337, the gate passes, and the frames render.
- **`npm run engine:gate`**: the engine's own headless run; a non-zero exit or any script error fails it, even when the engine exits 0. The log goes to `qa/reports/engine_*.log`.
- **`npm run parity`**: the same seeds in the web cartridge and the engine; outcome and tick (and any field or state path in `parity.compare`) must agree, and a mismatch names the seed and the field.
- `engine` and `parity` are optional gates; preflight checks the engine program (`STUDIO_GODOT`, `STUDIO_UNITY`, `STUDIO_UNREAL`, or on the PATH).
- The Arcade links the engine's web build and its last frame.
- An ask that carries an action (a hire, an engine track) runs it from `npm run ask -- answer` too, not only the War Room.
- The `engine-porter` role card.
- CI: an `engine-godot` job downloads Godot and proves the template (`scripts/check-engine-template.mjs`). Self-test: 10 more checks, 2 of them only with a Godot.

---

## [2.26.0] — 2026-10-21
From Jed's test #2 (Next Floor on 2.24.1 and 2.25.0, its FIXES/01–05 and about twenty harness notes) and the token numbers from run #1 (580M cached reads against 3.7M written: the cost is re-reading context).
### Fixed
- **One launcher (FIX 02).** The watcher's auto-start did its own thing beside the supervisor, ignored lanes and named agents by count: four builders landed in one folder in 15 minutes.
  - While the supervisor runs, the watcher starts nothing.
  - Otherwise it uses the supervisor's own picker (lanes, holds, task claims, caps, quota) with `-auto-` names from the name list.
  - An agent is never started on a task another one holds.
- **Quota marks (FIX 04).**
  - A limit error that names another tool (agy's `AGY_ERROR … 429` printed by a command a Claude session ran) marks that tool, never the session's.
  - Resets are read from the provider's words: "Resets in 80h54m54s", "in 3 days", "in 45 minutes", ISO times. "80h54m" used to read as one hour.
  - Every mark keeps the provider's own line, and `npm run budget` quotes it with the reset date and the last 5 hours apart from the week.
  - `npm run budget -- probe [tool]` asks the tool with one tiny call and clears a wrong mark; the supervisor probes a mark older than 10 minutes by itself (STUDIO_QUOTA_PROBE=off). `budget -- clear <tool>` by hand.
  - Preflight clears marks written before 2.26 or quoting another tool's error.
- **The selftest reads only the template (FIX 03, FIX 05).**
  - A studio counts as building a game when `studio/game.json` exists, `STUDIO_CARTRIDGE` names another cartridge, or `cartridges/` has a folder the release doesn't. Next Floor picked its game in `.env` and got 8 FAILs.
  - Preflight writes `studio/game.json` when it's missing.
  - The copy skips everything git ignores (`references/`, `hub/node_modules`, generated models), so it matches CI and is quicker.
- **browser-play when the bot can lose (FIX 01).** A loss with the screen matching the sim at every check passes with a note; `browser.mustWin: true` makes it fail. Every input is saved with its tick (`qa/reports/<run>-inputs.json`, or the sim's own log from `window.__sim.getActions()`), replayable with `replay --trace`. `input` may return `{ move: [x, y] }` to look without clicking.
- **A session that ends without `task done` hands its task back at once,** with what it last said, its work in progress and a patch. Claims used to sit until they expired (up to an hour). The watcher does the same for ended sessions instead of calling them "silent".
- **A task handed back three times in two hours is parked** with its last note, and the Producer is told. T-110 went to 12 sessions in a row, each refused the same command. `STUDIO_LOOP_HANDBACKS` sets the count.
- **Anyone may hand back a task whose agent has ended**; only a running holder's task is owner-only.
- **The watcher:** a held task is reported as held, not "waiting for an agent"; an outage needs two failed calls and never pages again after the Producer closed it; a Watch task whose findings cleared closes itself.
- **A partial verify (`--only`) never replaces the full one** a done-check reads (`.studio/gates-last-full.json`).
- **The docs check skips free text** people and agents write (the Producer's log and inbox, the pitfall list).
- **The supervisor's halt names the program** (`no-such-agent-tool wasn't found`), not "custom".
- **Game tools go in `game/<game>/tools/`:** the kickoff and the art and asset-3d roles say so, and preflight names any new file in a harness folder. Agents had written six game tools into the harness's `tools/`, and the frozen-harness hook refused the game's commit.
### Added
- **Cheaper to read:**
  - `npm run map`: `.studio/MAP.md`, every code file in one line (what it is, its exports, its lane, who holds it); agents read it before searching, and the launcher refreshes it when code changed.
  - `npm run pitfall`: `studio/PITFALLS.md`, one-line rules every agent's prompt carries; a "didn't work" note that reads as a rule is added too. The newest 40 are kept.
  - Prompts say never to read CHANGELOG.md, and hand-back notes are cut to 20 lines (done, not done, files, next step, proof).
- **Real token counts:** from the tool's final report (Claude's `result`, Codex's `turn.completed`), with cache reads kept apart, on every session-end event.
- **Readable sessions:** claude runs with `--output-format stream-json --verbose`, so the log keeps every message and tool call; `npm run agent -- logs <name>` shows it as a conversation (`--raw` for the lines).
- **Owed reviews:** when no reviewer of another family answers (all out of quota), the review is owed (`studio/reviews/OWED.json`) and the watcher tries again when the reviewer resets; a reviewer that says it hit its limit is marked.
- **Relayed verdicts:** `npm run verdict -- yes --by jed --quote "…" --source "…" --relayed-by art-1`. From inside an agent session a verdict must be a relay; it's marked as relayed and the person is told.
- `npm run balance -- --cartridge <game> --knob <key> --values a,b,c` sweeps your game without a config file.
- Self-test: 27 more checks (`2.26` block and two browser-play checks).

---

## [2.25.0] — 2026-10-21
Make "good" a gate, not a guess. Both test runs went green on every check while the person playing found the game wrong; this batch puts the person's verdict where a phase closes, and gives every game an identity.
### Added
- **Proven fun closes a phase.** `bible -- phase open <n+1>` now also needs:
  - every item in `PHASE-<n>-EXIT.md` ticked;
  - a person's "yes, it's fun" on a build played since the phase opened (the Arcade's new "Is it fun?" buttons, or `npm run verdict -- yes|not-yet --by <name>`).
  - Agents can't answer it, and `--force "reason"` still overrides. A "not yet" goes to the Producer's inbox with its note.
  - Phase progress shows the verdict.
- **Game IDs** (`harness/game-id.mjs`, `npm run game-id`, docs/HASH.md):
  - every game gets a random public ID once (`cartridges/<game>/cartridge.json`), made by new-game, or by the next preflight or watcher pass for an older game;
  - goldens, regressions, signed results, saved builds and events carry it;
  - a recording from another game fails the gates even when its hashes match;
  - a game started from a setup's game template gets a new ID with the original as `parent`;
  - not mixed into seeds or hashes, so anyone can still replay a game and a port can match it.
- **Every control is pressed:**
  - the browser contract's `controls` list (`{ name, key | click | mouse, when?, expect }`) is tried before the play, and a control that does nothing fails (CONTROL-DEAD; Solar Outpost's dead pads);
  - the example game lists its B key.
- **A pace note:** when a perfect player wins in under 5% of the Bible's play length, the browser check's report says so.
- **The Prototype sprint pace** (`npm run mode -- set prototype`), SendIt's way of working:
  - one lead, and builders in their own lanes;
  - merge only on the gate that plays the game, after the lead looks at before/after frames;
  - the Director reviews at the end of the phase. The Producer's brief says how.
- **Version tags:** `task add --track web|engine:<name>`, `notes add --track …`; an agent working a tagged task tags its events (STUDIO_TRACK); builds record theirs. Ready for the engine track.
- hud-check: 61 checks (the fun verdict).

---

## [2.24.1] — 2026-10-21
### Fixed
- The self-test for a stopped agent's cooldown waits for the hand-back before trying to restart the task (Windows hands back more slowly, so the restart was refused for the lock instead of the cooldown). No harness behaviour changed.

---

## [2.24.0] — 2026-10-21
From Jed's run #1 feedback on 2.22.2 (its P0, P1 and P2 lists) and Gemini's Solar Outpost run. These fix what stalled a real run or let a broken game look green.
### Fixed
- **False "out of quota":**
  - only a real usage-limit, 429 or credit error counts, read from a failed session's last lines or an error result object, never the whole transcript (run #1: a normal `end_turn` and selftest output idled the studio for an hour);
  - `STUDIO_QUOTA_SKIP=off` turns quota-skipping off when usage is watched outside the harness.
- **macOS `studio:start --install` looped on exit 127:**
  - the login job (launchd, systemd) now carries this terminal's PATH and HOME and the `node` on the PATH;
  - install warns when the agent tool isn't on the PATH;
  - after two sessions in a row end with the same exit code, the supervisor stops starting agents and raises one "Needs you" card with the reason and a "Fixed it: try again" button.
- **`studio:start` survives the shell that started it:** it runs on its own by default (`--foreground` keeps it attached). Run #1's agents all died with the host shell.
- **Dependencies and parking:**
  - `task add --after T-011`, `task block <ID> --until <T-ID|time>`, `task park|unpark <ID>`, `task holds`;
  - parked tasks and tasks waiting on unfinished ones never start;
  - Ops shows why each one waits.
- **Stop cooldown:** `agent stop` and `agent pause` keep the task from restarting for 15 minutes (`STUDIO_STOP_COOLDOWN_MIN`). Run #1's stopped task came back within seconds under a new name.
- **Builders never share files:**
  - lanes always count, not only with `--lanes auto`;
  - `task lane <ID> <folder|none>` sets one after the fact;
  - `--part sim|renderer` implies the cartridge or renderer folder;
  - a builder with no lane holds the whole game, so no other builder runs beside it;
  - the supervisor counts agents it started in the same pass.
- **"Stop all" reaches running agents:** it hands their tasks back with a note and stops them. `agent list` also shows claude, codex and agy processes in the repo that the launcher didn't start.
- **Agent names never repeat** across supervisor restarts (`.studio/agent-names.json`).
- **The selftest never reads the live game:** in a studio building a game, its scratch copies take studio/, cartridges/, web/, game/, assets/, goldens and regressions from the harness release the clone last merged (`git merge-base HEAD origin/main`). Jed's selftest was red on a real studio, and Gemini edited it to pass.
- **The browser check:**
  - fails when a game has a renderer folder but no browser contract (run #1 printed SKIP and PASS);
  - when a `PLAYTEST_URL` is set but nothing answers it, plays the cartridge's own build and says so;
  - `.env.example` no longer sets `PLAYTEST_URL`.
- **Chromium on Windows and macOS:** every browser check (`play:browser`, `hud:check`, `clip`, the renderer budget) tries PLAYWRIGHT_CHROMIUM, Playwright's own browser, then the installed Chrome or Edge (qa/chromium.mjs).
- **The Arcade's black screen:** `npm run play` and `/play/<id>/` redirect to the page in its own folder, so `./main.mjs` loads (Gemini).
- **Reviews without router keys:** they go to an agent CLI made by another company (`STUDIO_REVIEWER_TOOL`, `STUDIO_REVIEW_TOOLS`, then codex, agy, claude), read-only, instead of a "503: All channels exhausted" card.
- **Data-sharing consent** is recorded as seen only after a person clicks or types on the Game plan, never on a page load or in an automated browser.
- **Docs check:** "npm run asset." at the end of a sentence reads as the `asset` script.
- **Reviewer gate:** a Director drift review in studio/reviews/ is pointed to studio/bible/reviews/ instead of failing.
### Added
- **Throw it all away and restart** (War Room Ops, two warnings back to back; `npm run studio:restart -- --by <name> --yes --yes`):
  - the whole working tree is saved as a git tag `archive/<game>-<time>` first (undo: `git checkout <tag> -- .`);
  - then the game's code, recorded runs, assets, board, Bible and builds go;
  - the harness, roles, departments, budget and pace stay;
  - the server needs both presses (a ticket from the first, spent by the second within two minutes).
- **A frozen harness stays unedited:** `preflight -- --fix` fingerprints the harness files, and preflight fails when one has changed since (or, for older freezes, when git shows it modified). Gemini's run loosened two self-tests without committing them.
- hud-check: 60 checks, including the two restart warnings and the consent rule.

---

## [2.23.0] — 2026-10-21
From Hatch's request and art-1's hire-agents spec: hire agents into departments from the CLI or the War Room, and a new role, the dev hacker.
### Added
- **Hiring** (`npm run agent -- hire --role <r> --division <id> [--next] [--open] [--note "…"] [--loop until-empty|N] --by <name>`):
  - an agent hired into a department sits in that room, whatever its name;
  - names are generated when not given; `--note` reaches its prompt;
  - `pause <name> --note "…"` hands its task back; `logs <name>` shows its output.
- **War Room hiring:** "+ Hire" in every open room, and Pause on agents started from the War Room. A yes to a hire question starts the agent.
- **Limits on hiring:**
  - the Producer hires on its own up to `producerMayHireUpTo` (studio/budget.json, default 4); past that it becomes a Needs-you question;
  - the Director never hires;
  - a frozen clone refuses lanes inside harness/, hub/, qa/ or scripts/.
- **Departments as commands:**
  - `npm run division -- open|close <id> --reason "…" --by <name>`, logged in studio/decisions/divisions.md;
  - every department lists its roles;
  - a saved studio/divisions.json picks up departments added in later versions.
- **Missing role cards:** sound-designer, composer, artist, art-director.
- **The dev hacker** (Dev Hacker Lab, off by default; docs/DEV-HACKER.md):
  - researches how developers solve problems this game has, and writes trick cards (`npm run trick`): the problem here, the trick, why it fits, when not to use it, and how to prove it helped;
  - while the lab is open, the watcher queues a P3 hunt daily, or at once when a budget, module-size, browser-play or soak check is red;
  - new cards reach the Producer in one "Tricks:" task, and the Producer adopts each one (queuing build work) or parks it;
  - nothing waits on the dev hacker.
- Run report: a **Staffing** section (who was hired, by whom, into which room, for how long, and their tokens).
- `STUDIO_CLAUDE_BYPASS=1` (frozen clone only) runs claude agents without permission prompts, and claude agents may run node, npm, git, ffmpeg and blender.
- **Several games on one computer:**
  - `new-studio` picks the first War Room port that no sibling studio uses (3848, 3849, …), and gives each studio its own `npm run play` port.
  - START-HERE.md now covers hiring and running unattended.
- **Studio setups** (scripts/studio-setup.mjs):
  - `npm run new-studio -- --name "<game>" --setup <folder>|this` starts a game from a setup. A setup can hold:
    - roles, skills, presets and rules;
    - divisions, budget and pace;
    - a cartridge or web template;
    - `intake-answers.json`, which fills the intake (a person still signs);
    - `settings.env`.
  - `--save-setup <folder>` saves this studio's setup.
  - Keys, tokens and ports never travel in a setup, and harness code in one is skipped.
- War Room check: "+ Hire" in an open room hires an agent that Pause hands back (hud-check, 59 checks).
### Changed
- The departments code moved to harness/divisions.mjs (hud.mjs re-exports it), which removes an import cycle between the launcher and the HUD.
- The supervisor starts the most urgent work first and the dev hacker last.

---

## [2.22.2] — 2026-10-21
### Added
- The browser check plays bundled games: `browser.dist` (and `browser.build`, run first) in qa.mjs serves the build folder instead of a dev server. A failing build fails the check.

---

## [2.22.1] — 2026-10-21
### Fixed
- "Needs you" no longer shows golden-change cards for a fresh clone's history: only commits by the studio's agents, or with a Golden-Reason, are checked.
- The "studio is idle" alarm waits for the studio to have done something first, instead of firing on a brand-new studio.

---

## [2.22.0] — 2026-10-21
From the notes on run #1's overnight stop: the studio keeps itself running and uses the plan.
### Added
- **The supervisor** (`npm run studio:start`, `studio:stop`, `studio:status`; docs/RUN-UNATTENDED.md): keeps the War Room hub up (and logs downtime), starts a fresh agent per task as sessions end, within the pace's caps; stops at `--until`, outside a daily `--window`, past a `--budget`, or while "Stop all" is on. `--install` brings it back after a restart (launchd, systemd --user, Task Scheduler).
- **Budget pacing** (`npm run budget`, `studio/budget.json`): tokens each tool reported this week against a target for this point in the week; under target the supervisor allows two more agents, over target none. A tool that hits its limit is skipped until its reset time and its work goes to the next tool in the order.
- **Lanes**: `task add --lane <folder>`, `agent start --lane <folder>` (the folder is claimed for the session), `studio:start --lanes auto` (one agent per lane). `studio/rules/lanes.md` and an optional `module-size` check: split renderer files over 300 lines so builders can work in parallel.
- **One task per session**: supervisor sessions finish their task and stop, so no agent carries a long history. `{task}` in `STUDIO_<ROLE>_CMD`.
- **Work in progress on the HUD**: each heartbeat carries a diff summary of the agent's lane and when verify last ran; agents post a one-line status with `npm run agent -- now "…"`.
- **Progress by phase**: Ops and the Studio view show "Phase 1: 12/15 · exit 3/5 · Phase 2: not planned yet" from task phases and `studio/bible/PHASE-<n>-EXIT.md`; one overall % only when every phase is planned.
- **Golden changes need a reason**: the commit-msg hook refuses a `qa/golden/` change without a `Golden-Reason:` trailer and adds `Golden-Diff:` (which recorded numbers moved); the War Room shows each as a card with "Looks right".
- Run report: a section for the supervisor (sessions, tasks done, tokens, hub downtime).

---

## [2.21.0] — 2026-10-21
### Added
- **The Arcade** (War Room view 5, docs/ARCADE.md): play the last good build in the page while agents keep working, with older builds one click away; take notes while playing (to the Producer, as a bug for a builder, or as an idea), saved with the build in `studio/playtest/NOTES.md`; watch recent clips; and walk **the dungeon**, a read-only mini-game where floors are phases, rooms are tasks, the party is the agents at work, slimes are open bugs and P0 bugs are bosses.
- **Saved playable builds**: every pass of the browser check saves the build it played in `.studio/builds/` (unchanged builds once; the last 6 kept). `npm run play` serves the newest on a fixed port, `--lan` for phones on the same Wi-Fi. Bundled games declare `browser.dist` and `browser.build`.
- **`npm run clip`**: an mp4 of the real build played with real input (Chromium's screencast and ffmpeg), optionally kept with a task; **`npm run shot`**: one screenshot of the real build with extra query parameters.
### Fixed
- `npm run new-studio` on Windows: names with spaces no longer split (only npm runs through a shell).

---

## [2.20.0] — 2026-10-21
### Added
- **The Asset studio** (War Room view 4, `npm run art`, docs/ART-DEPARTMENT.md): every asset the art department makes, by number (#4) and round, with its picture (3D files spin in a viewer). Thumbs up, or "Change this" with your words, per card; or type "yellow gun #4 is still clunky, #7 is perfect" and each named asset gets the words for its next round. Sections: Waiting for you, In the works, Approved, References.
- **Rounds without waiting**: the art department proposes new rounds of an asset (`--round-of 4`) whenever it likes; feedback on an asset already being redone joins its open round instead of a new task.
- **Staging and approved folders**: proposed game files live in `assets/staging/<pack>/`; a thumbs up moves them to `assets/approved/`, records them in the ledger and queues "Import: wire asset #4 … into the game" for a builder. The assets gate fails when game code loads a staging file.
- **The Producer steps in** when the dev is slow: a design waiting past the pace's limit (precise 24 h, fast 8 h, extreme 4 h, half with MAX SPEED) is approved provisionally, logged under "Decided without you", marked on its card, and can still be sent back. The style sheet always waits for the dev.
- **References from the dev**, labelled: "Look like this" (reference library, never shipped) or "Use this in the game" (recorded as the dev's own asset). Upload them in the Asset studio or `npm run art -- ref`; the art department reads `studio/art/references.json`.
- **The asset ledger, reworked** (from run #1's notes): files already in `assets/`, `public/` or `web/` are recorded in place, others copied into `assets/<pack>/` (no flat folder, no duplicate copies); separate `author`, `source`, `licence`, `creditRequired`, `rightsHolder`, `declaredBy` and `madeBy` fields; a `generated` class for AI art (tool, model, prompt, terms); `npm run asset -- update` and `import-manifest`.
### Changed
- The Game plan's art panel is now a summary with a button to the Asset studio. "Needs you" shows one line for all waiting designs.

---

## [2.19.0] — 2026-10-21
From the art agent's notes on run #1, and the owner's notes on the Studio view.
### Added
- **Forced work grouped by cause** (`npm run causes`): a task forced past the same failing check joins the open check task instead of adding another, the War Room shows one "Needs you" card per cause with **Accept for this run**, and an accepted cause stops asking. A different cause still raises a new card. Cards are ranked: money, licences, publishing and deleting first, then what breaks play, then housekeeping.
- **"The studio is idle"** in Needs you when tasks wait, nothing runs and nobody has been heard from for an hour, with a button to start the Producer.
- **`npm run new-studio -- --name "<game>"`**: a second game gets its own studio next to this one (cloned harness, copied .env with its own War Room port, setup, preflight, a fresh board, START-HERE.md). AGENTS.md now says: one game per studio, never a game started in a folder by hand.
- **Annex rooms** in the Studio view: a room holds five desks; the sixth agent opens "Engineering 2" next to it.
### Changed
- **Walking in the Studio view**: doors are in the middle of each room's bottom wall, and staff walk along the hallways between rows and the corridor nearest the middle, instead of along the edge of the screen.
- **Attribution**: notes and added tasks are credited to the acting agent (STUDIO_AGENT or STUDIO_LOCK_OWNER) before the Producer's name.
- **Every agent gets a desk in the right room**: names that say the work ("audio-1", "concept-artist", "mesh-bot") find their division, and a division opens by itself (★) when one of its agents is at work. A locked room can be switched on with a click.
- **Honest labels**: desk badges show bugs traced to that agent's own work ("CAUSED 2"), not its model's record; "Fans" is "Checks 16/17 · selftest ✗"; "Bugs" is "Open bugs"; tokens add what launched agents reported and say "not tracked" instead of 0.
- **Out of quota** is shown on the agent's desk with its reset time ("OUT OF QUOTA TILL 06:12") and no longer counts as stalled.
- Ops "Now" lists every task with activity in the last 30 minutes, and who is on it.
- `npm run hub` prints the War Room link with the token in it, so the buttons work straight away on this machine.
- agy is started with `--print-timeout 900s` and a closed stdin (it exited early before); `STUDIO_AGY_BYPASS=1` skips its prompts in a frozen test clone.
- Hidden views are inert, so scripted and assistive-technology clicks reach only the visible view.

---

## [2.18.0] — 2026-10-21
### Added
- **The browser play gate** (`npm run play:browser`, required gate `browser-play`, docs/BROWSER-PLAY.md): opens the game's browser build in Chromium and plays start-to-win with real key presses and clicks chosen by the scenario's policy, reading `window.__sim` and `window.__view()` in the same instant every step. Fails on script errors, a blank canvas, a frozen clock, a screen that disagrees with the sim, the camera inside geometry, or no win. Saves start, middle and end screenshots. Metal on macOS, a pointer-lock stand-in headless. A real game without a browser to play it in fails; only the template skips. Also runs in CI.
- **The example game's browser build** (`web/example-sim/`): a small 2D view of the example sim with a HUD and real input, and the `browser` contract in its qa.mjs.
- **Renderer work is proved, not assumed.** `task add --part sim|renderer|both`. Renderer and both tasks need screenshots with a line each saying what they show (`npm run proof -- add`, copied to `studio/proof/<task>/`) and a check by someone other than the builder (`npm run proof -- check --verdict matches|wrong`).
- **Renderer bugs close with a browser regression** (`qa/regressions/browser/<task>.mjs`, a check on the live page) that a passing browser play ran after the fix, instead of a sim seed and tick (B8).
### Fixed
- Proof files (studio/proof/) are bookkeeping, so adding screenshots after a verify doesn't demand another verify.

---

## [2.17.0] — 2026-10-21
### Added
- **Art department from day one.** The Art division is on by default. Pre-production queues "Art: style sheet and five placeholder assets" for the new `art` role (`studio/roles/art.md`, `studio/skills/art.md`). `npm run art -- propose|approve|changes`: the game dev approves designs in the Game plan view (images shown, listed under Needs you). An approved style sheet becomes the Game Bible's art reference; an approved asset under `assets/` is recorded in the asset ledger with who approved it and its licence and source. "Ask for changes" gives the art department a task with the dev's words. Art tasks have their own done-check (the designs the title asks for were proposed). `docs/ART-DEPARTMENT.md`.
- **War Room actions reach agents.** A pitch goes straight to R&D and starts an R&D agent; a message starts the Producer; follow-up answers start the Director; a confirmed Liaison brief starts R&D or the Producer; design changes start the art department. Within the pace's caps, when a tool is set for the role. Every answer says what happens next.
- **Liaison chat** in the Game plan view: a cheap model through the router asks until it understands, then reads a brief back; nothing is sent until the dev says yes, and corrections change the same brief. Transcript in `studio/liaison/chat.md`.
- Ops: a new task says who picks it up (a running agent, the watcher, or nobody yet); `art` and `rnd` in the role list.
### Fixed
- Windows: stopping an agent ends its whole process tree (`taskkill /T`), so no agent keeps running in a folder after Stop. The self-test no longer fails when Windows is slow to release its temp folder.
- The Bible check notes when there is no art reference yet.

---

## [2.16.0] — 2026-10-21
### Added
- **Pace** (`npm run mode`, intake, the Game plan view): Precise and slow, Budget, Fast and furious, Extreme speed. It sets how many agents run at once, which work needs a cross-family review, whether agents start automatically, and how often the Director and Producer check in. Logged in `studio/mode.json`.
- **MAX SPEED lever** in every War Room view: twice the agents (up to 12), automatic starts, the Director about four times as often and the Producer every hour. Optional `--hours` auto-off.
- **The launcher** (`npm run agent`, the War Room's Start agent and Stop): starts any tool with the agent's kickoff and real model, the same way on Windows, macOS and Linux; heartbeats every 2 minutes; when an agent dies (usage limit, 429, auth, crash) it hands the task back, saves the uncommitted work as a patch, frees the claims, and can fail over to the next tool. Caps from the pace, the stop switch and the token cap. `STUDIO_<ROLE>_CMD`/`_TOOL`/`_MODEL`; the Director starts through it too. The watcher starts agents in fast paces.
- **Questions with a deadline** (`npm run ask`): one-click answers in the Game plan; after the deadline the asker's default applies with its reason, logged in `studio/decisions/decided-without-you.md` and the run report, and the dev can reverse it. Never for signing, pillars, money or deleting; agents can't answer for a person.
- **Three signals** on every view: Needs you (with the reason), A check is red (the gate's name; the BUILD lamp says it too), Agent stalled (no heartbeat). The pace is shown beside them.
- Run report: pace, the agents the launcher ran, and what was decided without the dev. Preflight: pace and which roles can start on their own.
### Changed
- Hand-back notices say which role the task waits for, and point at saved work.
- The War Room browser test covers the lever, the pace, questions and starting and stopping an agent: 37 checks.

---

## [2.15.0] — 2026-10-21
From the first real game run ("Next Floor", Jed, v2.14.0). Each fix was reproduced first and has a self-test.
### Fixed
- **B1, verify could never pass after `studio:reset`.** The self-test now starts every copy from a fixture board and an empty pre-production state (`qa/fixtures/studio/`), never the live studio, and runs with a clean environment (no inherited `STUDIO_LOCK_OWNER`, cartridge, folders or keys). Reproduced Jed's case (reset, a started task, the owner exported): 17/17 required gates green.
- **B2, gates tested the template.** The active game lives in `studio/game.json` (written by `new-game`, never frozen). Every gate run prints which game it tested; preflight warns while it is still the template.
- **B9, closing a handed-back task.** done-check counts commits tagged with the task from before its latest start. A forced done with `--reason` and `--accepted-by <person>` is logged without a follow-up task.
- **B11, over-broad locks.** Claims on whole top-level folders are refused unless `--wide "<why>"` is given; the refusal says how to narrow it.
- **B12, scope-guard false positives.** The refusal names the matched word and layer; `--not-layer <id>` queues the task and tells the Director.
- **B7, signed Bible rewritten silently.** Changing the core answers or phases after signing marks the Bible amended and holds new build tasks until a person re-signs (earlier signatures kept in `signHistory`). `bible pillars set … --by <person> --decision <file>`; `bible sign --via "<where they approved>"`.
- **B13:** intake accepts "one per line" answers as a newline string; `.gitignore` uses `/references/`; reports to keep go in `qa/reports/kept/`; new `task show <ID>`; `task next --role --agent` gives your own role's work, never another agent's; `idea --help`; shaping notes keep 20,000 characters and warn when cut; the idea done-check names the real idea; the Director kickoff handles storyboard tasks; macOS Drive paths in the docs.

---

## [2.14.2] — 2026-10-21
### Fixed
- Preflight reported router keys that weren't set: an empty `KEY=` line in `.env` borrowed the next line as its value. Found while setting up the first real test on Windows.

---

## [2.14.1] — 2026-10-21
### Added
- **`npm run review -- <ID> [--local]`**: a model from another company reviews a task's tagged commits (and its spec, for system tasks) through the router, and writes the review with `model-family:`, `implementer-family:` and one verdict. `--local` uses only your Ollama model, so a studio with one company's models can still close system tasks. Refuses a same-family reviewer; a reply with no clear verdict counts as changes.

---

## [2.14.0] — 2026-10-20
### Added
- **`npm run preflight [-- --fix]`**: checks a clone is ready for a test run (Node, hooks, `.env`, HUB token, Producer name, backup and results folders writable, Python, keys and cap, the required gates). `--fix` installs the hooks, freezes the harness (`.studio/harness-frozen`: the pre-commit hook refuses commits to harness files), turns off `git push` for the clone, and makes `.env` with a strong token.
- **Stop all agents**: a War Room button and `npm run task -- stop | resume`. While stopped, no task can start; agents hand back and wait.
- **`npm run run-report`**: REPORT.md (progress, whether the checks held, models, what repeated, the harness as agents found it, the overseer's evaluations, what needed a person), hourly snapshots and the run's files, in `STUDIO_RESULTS_DIR`. The HUB writes it hourly.
- `docs/TEST-RUN.md`: clone, set up, run, finish.
- CI runs the War Room browser test (`war-room-browser` job). The test also covers Stop and Resume and the queue: 30 checks.
### Changed
- The queue lists every open task and scrolls inside its box (newest done shown first).
- Every command reads studio settings (`STUDIO_*`, `HUB_*`) from `.env`, not only the HUB, so backups and the Producer name work from the command line too. `.env.example` lists the backup, results and reference folders.
- Kickoffs tell agents about the stop switch and the frozen harness; the Producer writes run reports.
- War Room "add task" with the type `system` gets its prefix.

---

## [2.13.1] — 2026-10-20
### Added
- **`npm run hud:check`** (optional gate `hud`): opens the War Room in Chromium on a throwaway copy of the studio and uses it like a person: all three views at desktop and phone sizes (no errors, nothing off the side), the agent drawer, adding a task, messaging the Producer, live updates, pitching an idea, answering a follow-up, and the sharing box. 27 checks; skips without a browser.
### Fixed
- The queue's "Next up" lists the most urgent first and says how many more are in `studio/NEXT.md`; a task added from the page was hidden past the eighth.
- The Studio view's "Bugs" counted every open P0 and P1 task; it now counts bug tasks.
- The Producer (`STUDIO_PRODUCER_NAME`) and whoever signed the Game Bible sit in the Producer's office, not Engineering.
- The page has an icon (the missing favicon was a 404 on every load). On phones the activity list scrolls in place instead of pushing the controls far down.
- `system` is in the War Room's task-type list.

---

## [2.13.0] — 2026-10-20
### Fixed
- **Node and Python now hash every state alike.** Canonical JSON is built directly in both: keys in code-point order (`JSON.stringify` moved integer-like keys such as `"0"`, `"10"` to the front) and numbers in JavaScript's layout (Python wrote `1e-05` for `0.00001` and `1e-07` for `1e-7`). Emoji keys sorted differently too. `qa/hash-vectors.json` holds 20 edge cases both languages must match; a 5,000-state fuzz agreed. No existing golden changed.
- Determinism checks in the vertical slice, soak, balance sweep and playtest compare **SHA-256**, not the display hash. Playtest reports record `finalSha256`, and the playtest done-check requires it.
- Python output on Windows is UTF-8 (`PYTHONIOENCODING`), so `…` in output can't throw.
### Added
- Scenario goldens pin **`actionsSha256`**: the same end reached by different actions fails.
- A cartridge with its own display hash is marked `hashKind: custom`; Python then checks SHA-256 only. `qa/test-golden.py` also replays every regression, and `check-regressions` checks the display hash.
- **Signed results bind code, inputs and outputs:** a SHA-256 over each cartridge's files, each golden's and regression's file SHA-256, and the harness runner. Signing refuses gate runs that are stale or missing a required gate. `verify --replay` checks the code matches and re-runs purity, isolation and the vertical slice as well.
- **Backups that save space** (`docs/BACKUPS.md`): each file content stored once, gzipped; `latest/` with plain copies and STUDIO-MEMORY.md; `restore --at`; `prune` (the HUB keeps 60 daily plus one a month). Also keeps the newest 50 playtest reports and 20 screenshots.
- **The data-sharing answer** (`npm run data`): intake and the Game plan view ask whether the studio's records may be shared with AI research partners, pre-ticked to allow. Declining stops every export; manifests record whether the answer was the default, confirmed or declined.

---

## [2.12.0] — 2026-10-20
### Added
- **A bug's regression must fail before the fix.** The bug done-check replays the regression on the code before the task's first `Studio-Task` commit, in a temporary git worktree (`qa/fails-before.mjs`, cached). A regression that passes there too guards nothing and is refused. The bug skill now covers the whole loop: triage, reproduce, `git bisect run` with the replay, smallest fix, pinned SHA-256, lesson, hand-off.
- **`system` tasks** (`--type system`, skill `studio/skills/system.md`): a spec in `studio/bible/systems/` that ends with "## For the next agent", a scenario in `qa.mjs`, goldens, a playtest, a verify, and an approval from a reviewer of another model family.
- **Cross-family review.** `harness/families.mjs` maps model names to their maker. Reviews start with `model-family:` and `implementer-family:`; the reviewer gate is now **required** and refuses a same-family approval.
- **Measured renderer budget.** The game sets `window.__render = { drawCalls, triangles, lights, frameMs }` next to `__sim`; with `RENDER_URL`, `scripts/check-renderer-budget.mjs` samples it in Chromium and fails over the budget block in `studio/rules/renderer-budget.md`. The code scan remains as the fallback.
- Trajectory export: `--with-diffs` (scrubbed patches), the model behind each commit, provider families per record, and a terms warning in the manifest.
### Changed
- Learning backups include the event log, the last gate run and task briefs, which live only in `.studio/`.
- Roadmap: on-chain options as a later opt-in add-on (stamp, archive; fully on-chain games not planned) and data partnerships with AI labs.

---

## [2.11.0] — 2026-10-20
### Added
- **Agent identity**: core role cards (builder, playtester, reviewer, designer, fun tester, reference scout, 3D, Producer) gain "Who you are": what good work looks like, common mistakes, questions to ask, and an example. Every focus brief now includes it, plus where agents in that role get refused most (from the event log) and lessons filed for the role (`- **Role**:` in `failures.md`).
- **Player personas** (`studio/personas/`: first-timer, calm player, min-maxer, explorer; add your own). `npm run fun` reads the game through each persona's lens: time to first win and dead time, pressure from waiting, room to optimise, variety of actions.
- **The game's voice**: an intake question and three follow-ups (a winning line, a failing line, words to never use) build a voice guide in the Bible; `npm run bible -- voice` adds to it. Every brief for work players read or hear carries it.
- **Signed results** (`npm run sign`): Ed25519 key pair (private key never committed), signed manifests of the verified state (goldens' and regressions' SHA-256, gates, commit, Bible and asset manifests), `verify --replay` re-runs the goldens. Refuses to sign a red verify unless recorded with `--allow-red`.
- **Opt-in trajectory export** (`npm run trajectories`): one labelled record per finished task (clean, needed-fixes, caused-bug) with its commits and outcomes, scrubbed of secrets, with consent and terms in a manifest. `harness/secrets.mjs` shares the patterns with the secret scan.
- `docs/SIGNED-RESULTS-AND-DATA.md`, including what a public receipt would and wouldn't prove.
### Changed
- The assets gate also covers `public/assets/`.

---

## [2.10.0] — 2026-10-20
### Changed
- **Two-tier hashing.** Golden files and regressions now pin **SHA-256** of the canonical state (64 hex), checked in Node and independently in Python. The display hash for the HUD and reports is now a true **FNV-1a 64-bit** hash (one lane, standard test vectors in the self-test) instead of two correlated 32-bit lanes. Both hash the same bytes: canonical JSON as UTF-8. `harness/hash.mjs` stays browser-safe (SHA-256 loads Node's crypto only when called), so cartridges keep no imports. All goldens and the regression were regenerated in this release. Node 22.3 or newer.
- `docs/HASH.md` explains what each hash is for, and what a hash does and doesn't prove.
- Roadmap: signed results, opt-in trajectory export, and optional public timestamp receipts.

---

## [2.9.0] — 2026-10-20
### Added
- **The Liaison** (`npm run liaison`, role `liaison`, `kickoff --role liaison`): the agent the game dev talks to. It asks until it understands, sorts what it heard (idea, direction, asset, question), reads it back and asks "Shall I push it on?". Only the dev's yes sends it on: ideas to the Idea Board as "dev, confirmed" and straight to R&D with a Director ping; directions to a Producer task with the Director checking the fit; assets and questions to the Producer. Nothing running stops.
- **Labels on the Idea Board**: dev confirmed, dev pitched, agent, playtest, and "new" since you last looked. Dev-confirmed ideas go first.
- **Experiments** (`npm run experiment`): start one, work in it (its tasks, or `STUDIO_EXPERIMENT`), and every commit carries a `Studio-Experiment` trailer. `keep` it, or `drop` it in full or `--only` some files: undo commits that leave other work in place, refused rather than guessed where later work changed the same lines.
- **Reference library** (`npm run ref`): games, features, timestamps, what to take and avoid, with the media downloaded and kept in a folder per reference, in `references/` or `STUDIO_REFERENCE_DIR` (a synced Google Drive folder works). Web pages stay links until you attach a saved copy. `frames` pulls stills for image-reading models.
- **Game assets with a recorded statement** (`npm run asset`): a person states they own a file or hold a licence; it goes to `assets/` with who said so, when, the licence and a checksum. Reference-only files go to the library. New required **`assets` gate**: every shipped file recorded and unchanged, and no game code pointing at the reference library.
- **Intake**: first question "new or existing?"; **follow-up questions** for each phase and kept or explore layer from a fixed bank, plus `--model` questions from a cheap model checked by a script; answer in a terminal, with `--answers`, through the Liaison, or in the War Room.
- **A stronger learning loop** (`npm run learn`): the same failure on two or more days and the lesson that didn't stick, retro suggestions raised again and again, the overseer's evaluations (`notes --kind eval`). The HUB rewrites `studio/memory/LEARNED.md` daily and backs every learning file up to `STUDIO_BACKUP_DIR`, with a one-file `STUDIO-MEMORY.md`. The Producer's kickoff makes it the overseer of the run; `docs/STRESS-TEST.md` has the head model's first message.
- War Room Game plan view: follow-up questions to answer, experiments and the reference library. Endpoint `POST /api/followups`.

---

## [2.8.0] — 2026-10-20
### Added
- **Game Bible** (`studio/bible/bible.json`, written out as `BIBLE.md` and `NOT-DOING.md`): the game as structured data a future front end can drive. `npm run bible` shows what's missing, signs it (a person, not an agent), and opens phases.
- **Intake** (`npm run intake`, `--answers <file>`, `--ask`, `--questions`): about 19 questions with **play length first** (a 15 to 30 minute demo is the recommended start; longer games say how much of the game dev's time they need), three phases, and every progression layer (levels, tech tree, unlocks, factions and governance, …) answered yes, explore or no. It suggests the layers games like yours usually have, and can cross out the rest in one step. Queues pre-production once: a reference study, storyboards, R&D studies for explore layers, and the person's sign-off. Example: `studio/templates/intake-example.json`.
- **Task gates from the Bible**: until a person signs, build tasks wait (prototypes and `--infra` tooling allowed); after, build tasks need `--phase 1|2|3` (only open phases) and `--serves pillar:<name>|layer:<id>` or an approved `--idea`; titles that touch a crossed-out layer are refused. Pillars and crossed-out layers stay locked after signing.
- **The Director** (`npm run director`, role `director`): pinged daily by the HUB, by the Producer before it generates tasks (`task add` warns when it hasn't), when an idea is placed, and on phase changes. A ping queues one review task, writes `.studio/briefs/director.md`, and starts `STUDIO_DIRECTOR_CMD` (at most hourly, under the spend cap). Reviews in `studio/bible/reviews/` have their own done-check; a `phase-ready` verdict lets a person open the next phase. A free drift report flags work that serves nothing, touches crossed-out layers or runs ahead of the open phase.
- **The Idea Board** (`npm run idea`, roles `rnd` and `planner`): captured, shaped, placed, decided by the Director, then scheduled with `task add --idea`. The watcher's pass hands new ideas to the Producer in one task. Idea tasks have their own done-check.
- **War Room Game plan view** (`?skin=plan`): the three phases with the layers that enter each, crossed-out layers, approved ideas, the Idea Board, a box to pitch an idea, and the Director's verdict with the drift report. The Ops view has a box to message the Producer (`studio/producer/INBOX.md`, first in its briefing). New endpoints: `GET /api/bible`, `POST /api/intake`, `POST /api/bible/sign`, `GET|POST /api/ideas`, `POST /api/inbox`; every `/api/` write needs the token.
- `docs/GAME-BIBLE.md`; VoiceStudio as an optional audio plugin with best practices in `docs/AUDIO-AND-NARRATIVE.md`.
### Changed
- `npm run studio:reset` and `npm run onboard` start an unsigned Game Bible, so a new or onboarded game begins in pre-production. The Producer's briefing opens with the game plan, new messages and ideas; its kickoff prompt pings the Director before generating tasks.

---

## [2.7.0] — 2026-10-20
### Added
- **Cheap prepare, strong act is real** (`npm run brief -- <ID> --model`): reads a bounded window of the task's history (its last events, hand-off notes, matching lessons, newest QA result, files touched); a local or free model drafts a 300-word brief in five sections; a script checks it (sections, word cap, task named, only real files and task IDs) and throws a bad draft away for its own version. Skips the model when the history is short. The focus brief and kickoff prompts point to it; the Producer sees words in and out. Self-tested with a fake local model.
- **Windows CI job** running every required gate on `windows-latest`.
- **`docs` gate**: fails when a doc names an `npm run` script, or a `node`/`bash` file, that doesn't exist.
- `docs/ROADMAP.md`: what's next and how each known gap gets fixed, including pre-production, three game phases with layers kept or crossed out, the Idea Board and the Director.
### Fixed
- Gates run on a clean Windows machine: the isolation check and secret scan are Node scripts (the `.sh` files call them, and the pre-commit hook uses the Node scan), and Python is found as `python3`, `python` or `py -3` (skipping the Windows Store alias), or set with `STUDIO_PYTHON`.
- The focus brief path prints with forward slashes on Windows.
- Purity can no longer be dodged through the Function constructor (`(() => {}).constructor(…)`, `.constructor.constructor`): flagged statically and trapped at runtime.
- Claiming a folder and a file inside it at the same moment can no longer both succeed (short mutex around folder claims).
- One read order for agents (`AGENTS.md`); docs say `npm run hub`; `npm run setup` installs packages when they're missing.

---

## [2.6.0] — 2026-10-20
### Added
- **Agent drawer in the War Room**: click any agent (a row in Ops, a person or desk in the Studio view) to see its current task, who assigned it and when, the done checklist ticking live, the skill's steps, hand-off notes, its claims, what it finished today, what it assigned (for the Producer), its recent activity and its scorecard. `GET /api/agent?name=`. It reads the studio's files when opened and every 2 seconds while open; no AI is used.
- **Content-based done-checks**: a build task needs real changes (commits tagged with it, or edits) and a full verify after the last one; docs need a changed `.md`; a bug needs a regression with seed, tick and pinned hash and a lesson naming the task or bug; a balance sweep needs a `(current)` row and must be newer than the last game change; fun and playtest reports must cover the current build; a study needs 120+ words; a review must name what it reviews and give a verdict. `done` and `done-check` print a `[x]`/`[ ]` checklist.
- **Bugs traced through commit trailers**: the scorecard follows a bug's fix commits back to the last commit from another task that touched the same code, and counts it against that commit's model (`traced`), even without `--caused-by`. Retros use it too.
- **`npm run models:check`**: asks each provider you have a key for which models it serves (free model-list endpoints, no tokens) and names configured models that are gone, with close matches.
- **`kickoff --tool claude|codex|cursor|grok|agy|aider`**: prints a headless launch line for that tool with the agent's name and model set.
- **`docs/AGENT-TOOLS.md`**: how to plug in Claude Code, Codex, Cursor, Grok Build, Antigravity (which replaced Gemini CLI for personal accounts) and Aider + Ollama, with sources. Recommends one shared checkout over separate worktrees, and a free Aider + Ollama dry run before a paid run.
### Changed
- Anthropic's default model is `claude-sonnet-5-5`. Gemini models can be set with `GEMINI_PRO_MODEL` and `GEMINI_FLASH_MODEL`.
- Skills' "Done means" lines match the new checks.

---

## [2.5.0] — 2026-10-20
### Added
- **Focus briefs**: `task start` writes `.studio/briefs/<ID>.md`, one page an agent reads instead of the repo (done means, the skill's steps, notes from whoever worked on it before, meeting mentions, its claims and others', off-limits areas, related lessons, gate state, the exact finish and hand-back commands). `npm run focus -- <ID>` rebuilds it.
- **Kickoff prompts** (`npm run kickoff -- --role … --agent … --model …`): a paste-ready opening prompt for any agent tool, Producer included.
- **Harness notes** (`npm run notes`, `studio/harness-notes/NOTES.md`): what worked, what didn't, workarounds and upgrade ideas about the harness itself. Kept across `studio:reset`, shown in the briefing, exportable upstream.
- **Commit trailers**: a commit-msg hook adds `Studio-Agent`, `Studio-Model` and `Studio-Task`, so every change traces to who made it, on what model, for which task.
- **Studio view work animations**: debugging agents squash bugs, studies read a book, playtests hold a controller, balance work tips a scale, reviews sweep a magnifier, docs scribble, code changes float `{ }`. Reactions: confetti on done, a head shake on a refused done, a sweat drop on a forced one, a low battery on a hand-back.
- **The watcher sleeps and wakes**: it dozes in the Producer's office between passes, then wakes on each pass, looks around with its beacon flashing and says what it found.
### Changed
- Hatchfield is fully separate: `qa/hatchfield.adapter.mjs` is now the generic `qa/browser.adapter.mjs`, the example game no longer sets `window.__hatch`, the playtest global is configurable (`PLAYTEST_GLOBAL`, default `__sim`), and the OpenRouter referer names this repo.

---

## [2.4.0] — 2026-10-20
### Added
- **Model scorecard** (`npm run scorecard`): per model, tasks finished, task points (size 1-5, default by type, `--size` on `task add`), confirmed bugs (a bug filed with `--caused-by <task>`, or a task reopened with `task reopen`), bugs per 10 points so harder work isn't punished for its size, closed-loop failures shared among suspects, and refused, forced and handed-back work. Shown in the Ops view, as a bug badge on desks in the Studio view, and in the Producer briefing.
- **Self-improving retros** (`npm run retro`): a daily retrospective in `studio/memory/retros/` written by a script from the event log, ending in suggestions (tighten a skill, split big tasks, route away from a model, raise or lower the spend cap). The HUB writes one a day, `session:start` writes one if today's is missing, and the briefing lists the open suggestions for the Producer to accept or reject.
- **Daily spend cap** (`STUDIO_DAILY_TOKEN_CAP`): the router refuses calls past the day's token total and the watcher tells the Producer.
- **`npm run studio:reset`**: a fresh plan, log and queue for a new game in your own copy, archiving the previous project's notes.
- **`docs/STRESS-TEST.md`**: running a long test with real keys in a private copy.
- `STUDIO_PRODUCER_NAME` merges script events into the Producer agent; the event log rotates past `STUDIO_EVENTS_MAX_MB`.
### Changed
- **War Room v3 is the HUB's home page**, with buttons behind the token: start, pause, done and reopen tasks, add tasks (type, size, caused-by), sign off balance and fun, and run the watcher. The old React War Room is retired to `/legacy` for one release.
- The watcher's list of uncommitted files leaves out the studio's own bookkeeping.
- Sign-offs from the War Room count as signed in the briefing.
- In the Studio view, people using War Room buttons sit in the Producer's office in a gold cap, and the watcher is a small robot (it is a script), so neither is mistaken for an agent.

---

## [2.3.0] — 2026-10-20
### Added
- **Done-checks by task type** (`harness/done-check.mjs`): `task done` refuses until the proof for that kind of work exists, newer than the task's start. Change and docs: a full green verify. Bug: a pinned regression, a lesson in `failures.md` and a green verify. Balance and fun: a fresh report. Playtest: a report in `qa/reports/`. Study: a `study.md`. Review: a note in `studio/reviews/`. `--type` on `task add` sets the type.
- **`--force` pings the Producer**: it still closes the task, writes a `task.forced` event, flags it in the War Room and queues a P1 `Check forced done` task for the Producer.
- **Skills** (`studio/skills/`): one short file per kind of task (When, Steps, Done means, Never). The builder skill is the edit, test, stop loop.
- **War Room v3** (`/v3`): files-only HUD with two skins. Studio view: themed room per division, staff dressed by division, agents walk to the Producer's office to report and the Producer walks over to hand out work, live widgets (queue board, build light, test board, shipped trophies).
- **Plugin registry** (`studio/plugins.json`, `harness/plugins.mjs`) and the game study guide (`docs/GAME-STUDY.md`).
- `docs/BEST-PRACTICES.md`: recommendations, not rules.
- **Producer handoff** (`npm run handoff`): a briefing built from files for whoever holds the Producer role (plan, log, decisions, what needs attention first, queue with owners, claims, gates, playtest, last failing seed, open bugs, sign-offs, lessons, meetings, last 24 hours, key documents). Saved to `.studio/briefs/producer.md`.
- **Master documents**: `studio/MASTER.md` (the map of key documents and how to take over), `studio/PLAN.md` (the master plan), `studio/producer/LOG.md` (the Producer's reasons, newest first; `node harness/handoff.mjs note`).
- **Meetings** (`harness/meeting.mjs`): the Producer meets several agents at once; notes in `studio/meetings/`, actions become tasks, the outcome goes into the Producer log. In the Studio view everyone walks to a meeting table and back.
- **Handing work back**: `task pause <ID> --note` returns a task to the top of the queue with a note in `studio/handoffs/<ID>.md`; the next agent sees it on `task start`.
- **Watcher** (`npm run watch`; runs on its own every 5 minutes while the HUB is up and at `session:start`): a zero-token script that requeues work whose claim expired, flags silent agents, unclaimed handed-back work and provider outages, and gives the Producer one `Watch:` task at a time. Its requeue note carries the agent's last messages and the repo's uncommitted files. The Producer briefing shows a fresh, read-only watcher pass.
- **Onboarding an existing game** (`npm run onboard`, `docs/ONBOARDING-A-GAME.md`): read-only scan of the game's folder, a fact sheet in `studio/game/GAME.md` that the Producer's briefing shows, and the onboarding tasks.
- **Models in the War Room**: `STUDIO_AGENT_MODEL` or `task start --model` tags every event; desks show the model, and silent agents holding work fall asleep ("z") in the Studio view.
- Events can name who they are for (`--to producer`).
### Changed
- The self-test proves every done-check refuses unfinished work, that `--force` reaches the Producer, that the handoff briefing reflects the studio's state, and that meetings write notes and tasks.
- `studio/MASTER.md` and `studio/PLAN.md` are required by the session check.
### Fixed
- `.studio/usage.json` and the status fallback showed invented token savings and quota use. They now show zeros until something is actually measured.
- The status command and the old War Room estimated "tokens saved" from the number of events (and showed 84% and $4.68 by default). They now show only savings a tool measured.
- Handing a task back now frees the agent's folder and file claims too, so the next agent can take the same files.
- An agent named like `grok-producer` sits in the Producer's office, not Engineering.
- A fresh clone starts with a current starter queue and an idle checkpoint instead of notes from an older version.
- `npm run setup` pointed at a file that doesn't exist (`hub/server.js`); it now lists the current commands.
- The briefing's "how fresh" times use each document's last commit, so a fresh clone doesn't show everything as "1 min ago".
- Tasks queued by a meeting or the watcher are attributed to whoever queued them.

---

## [2.2.1] — 2026-10-20
### Changed (dependency and tooling refresh)
- Node: supported on 22 and 24 (the LTS lines; Node 20 is end-of-life). CI tests both.
- GitHub Actions: checkout v7, setup-node v7, setup-python v7 (no more Node 20 deprecation warning); Python 3.13 in CI.
- CI: new `war-room-build` job builds the War Room and type-checks its React components (`npm run hub:build`).
- Root dev tools: Playwright 1.64.1, Vite 8.3, TypeScript 5.9 (TypeScript 7 not adopted yet: it is the native rewrite and needs its own migration).
- War Room: React 19, @xyflow/react 12.12, xterm 6 (also in the CDN page), Vite 8, @vitejs/plugin-react 6. Lockfiles committed.
- MCP pins: Playwright MCP 0.0.83, Serena v2.1.0 (context `ide`; `ide-assistant` was renamed), blender-orchestrator pinned to a commit SHA.

---

## [2.2.0] — 2026-10-20
### Fixed
- **Purity gate was bypassable**: aliases (`const r = Math.random`), destructuring, `Date()`, `globalThis[...]`, dynamic `import('three')`, `crypto.randomUUID`, timers and `performance['now']` all passed. Now a wider static scan plus a runtime probe that plays every cartridge with those globals trapped.
- **Isolation gate exemptions**: any line containing `playtest`, `__sim` or `__hatch` was skipped. Removed; `.js/.cjs/.jsx` now scanned.
- **Secret scan missed the providers this harness routes to** (OpenAI `sk-proj-`, OpenRouter, NVIDIA, Groq, xAI, Google OAuth) and flagged a developer's own ignored `.env`. It now scans exactly what git would publish.
- **Golden stubs passed**: a missing or `REPLACE…` hash was silently rewritten and the gate passed. Now it fails unless `--update`; a game with no golden fails; Python re-hashes the real replayed state.
- **Regressions without a hash passed.** Now they fail.
- **Optional gates failed `npm run verify`**; optional failures now warn only.
- **Gates dirtied tracked files** (`studio/balance/latest.md`, `studio/fun/latest.md` on every run). They write only with `--write`; `npm run release` fails if a gate changes a tracked file.
- **Locks**: anyone could `task done` a task claimed by another agent, and the lock leaked; `task start` without `--agent` said "locked". `file:` and `path:` keys could collide and nested path locks overlapped. All fixed; shared tool and role names are refused as owners.
- **HUB**: the War Room page never sent the token, so its buttons and socket always got 401; a foreign Host header was served (DNS rebinding); `0.0.0.0` started with no token; the `.env.example` placeholder token unlocked writes if left unchanged; `GET /api/brief` wrote a file; frame telemetry and boot events showed invented numbers. All fixed and covered by `qa/hub-smoke.mjs`.
- **Closed loop recorded "ticks run" as the failing tick** and parsed stdout. It now records the tick the cartridge failed on, from a JSON report, and the trace replays to that tick.
- **Balance sweep was not a sweep**: it subtracted credits outside the sim and the example had no win state (0/4 wins everywhere).

### Added
- `harness/cartridge.mjs`: load any cartridge by name (`--cartridge`, `STUDIO_CARTRIDGE`, or `studio/gates.json`); every tool uses it.
- `npm run new-game <name>`: copies `cartridges/_template`, plays it, writes real golden files.
- `example-sim` gets a `TUNING` table, win/lose outcomes and invariants; `qa.mjs` scenarios with a `start-to-win` policy.
- Vertical slice with a golden hash (`qa/golden/example-sim-start-to-win.json`), checked by `qa/vertical-slice.mjs` for every game.
- `studio/balance/sweep.json` + a real `TUNING` sweep; fun proxies from real runs (idle vs played).
- `qa/selftest.mjs` now proves every required gate fails for its planted reason, after a clean-copy control, plus locks, claims, the pre-commit hook, the closed loop and new-game.
- `npm run hooks:install` (also run by setup): `scripts/hooks/pre-commit` blocks staged secrets and files locked by another owner.
- `npm run release`: syntax, required gates, closed-loop proof, read-only gates, changelog entry.
- Gates: `playtest`, `soak`, `hub-smoke`; `npm run setup` writes a random `HUB_TOKEN`.

---

## [2.1.0] — 2026-10-20
### Added
- **One-Command Setup (`npm run setup` / `scripts/setup.mjs`)**: Creates `.studio/`, `.env`, verifies `.studio/events.jsonl`, and checks readiness in one step.
- **Prepare-Then-Escalate Briefs (`harness/prepare-brief.mjs`)**: Cheap/local model reads `.studio/events.jsonl`, `studio/memory/failures.md`, `studio/CURRENT_TASK.md`, and `studio/NEXT.md` to write a `<= 300`-word execution brief for strong models.
- **Shared Improving Memory (`studio/memory/failures.md` & `docs/MEMORY.md`)**: Implements the Hermes Agent (Nous) 4-bullet post-fix distillation rule (`What broke`, `Root cause`, `The fix that worked`, `How to avoid it next time`).
- **Deterministic Seed Replay & Closed-Loop Gate (`harness/replay.mjs`, `harness/closed-loop.mjs`, `qa/hatchfield.adapter.mjs`, `qa/visual-check.mjs`)**: Enforces mandatory early seed + tick systems (`{ seed, tick, description }`), exposes `window.__hatch` / `window.__sim`, and auto-escalates after `3` failed retries.
- **Expanded Blender Primitives & Orchestrator Docs (`tools/blender/generate_glb.py`, `docs/BLENDER-ORCHESTRATOR.md`)**: Added `crate`, `cone`, `vehicle`, `beacon`, and `hangar` headless `bpy` presets plus `mlolson/blender-orchestrator` guide.
- **New Roles & Cartridge Example**: Added `studio/roles/asset-3d.md`, `studio/roles/playtester.md`, and `cartridges/example-sim/index.mjs`.
- **Daily Rollup & Demo Seeder (`scripts/daily-summary.sh`, `scripts/seed-demo-events.sh`)**: Rolls events + `NEXT.md` into `studio/daily/YYYY-MM-DD.md` with before/after video slots.
- **HUB `/health` Endpoint & Live Runtime Duration (`hub/server.mjs`, `hub/WarRoom.tsx`)**: Added `GET /health` and start-time → duration telemetry on agent nodes.

---

## [2.0.0] — 2026-10-19
### Added
- **7-Module Mission Control War Room (`hub/`)**: `@xyflow/react` uncapped agent graph, 4-source "Agent Eyes" viewport multiplexer (`noVNC`, `WebRTC`, `Playwright CDP`, `HMR`), `xterm.js` WebSocket terminal dock, and `.studio/usage.json` quota bar.

---

## [1.0.0] — 2026-10-19
### Added
- Initial public release of the generalized 3D Deep-Sim & AI Game Studio Harness (`AGENTS.md`, `harness/route.mjs`, `harness/task.mjs`, `qa/playtest.mjs`, `scripts/setup-token-savers.sh`).
