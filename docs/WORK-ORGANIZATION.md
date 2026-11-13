# Work Organization (`docs/WORK-ORGANIZATION.md`)

Agents keep durable work in files, never in chat history. This page covers where work is recorded, how the board stays safe
with many agents, how `verify` and the merge train land lanes, and how heavy jobs share the PC. Older wording is in git history
(`git log -p -- docs/WORK-ORGANIZATION.md`); a tag such as (2.78.2) says which release added a feature. Owner and permission rules:
`docs/SECURITY.md`. Engine lines: `docs/ENGINE-TRACKS.md`. Game manifest (pins, tiers, slow tier): `docs/ONBOARDING-A-GAME.md`.

## Where to store work

| What | Where | When |
|------|--------|------|
| Active handoff / current focus | `studio/CURRENT_TASK.md` | Start and end of every session |
| Prioritized backlog | `studio/NEXT.md` | When priorities change or new work appears |
| Completed task summary | `studio/done/YYYY-MM-DD-short-title.md` | When a task is finished |
| Daily rollup + videos | `studio/daily/YYYY-MM-DD.md` (from `studio/daily/TEMPLATE.md`); videos in `studio/daily/videos/` | End of day or major session; when visuals change |
| Bug / playtest report | `studio/templates/bug.md` or `playtest.md`, copied into `qa/reports/` | When found / after a playtest |
| Calibration notes | The done summary or `studio/CURRENT_TASK.md` | Designer-Calibrator work |

Never leave the only record of work in the chat. Keep `studio/CURRENT_TASK.md` short and current; the Producer keeps it and
`studio/NEXT.md` accurate. Prefer `node harness/task.mjs add "..."` over scattered tracking files. Done summary: `# YYYY-MM-DD —
Short Title`, then **Role** (Builder / QA-Playtester / Designer-Calibrator / Reviewer), **Task ID**, **What was done**, **Files
changed**, **Result / verification** (`node scripts/check-sim-isolation.mjs` + `node qa/playtest.mjs`), **Follow-ups** (or "none").

## Pulling the next task

Read `studio/CURRENT_TASK.md`; a clear next step in `IN_PROGRESS` is yours. If idle, read `studio/NEXT.md` (or
`node harness/task.mjs next`) and `node harness/task.mjs start <ID>` the top unchecked item. Log progress with
`node scripts/append-event.mjs` or `node harness/event.mjs`. Finish with the done summary, `studio/CURRENT_TASK.md`, then
`node harness/task.mjs done <ID>`; at day's end fill the daily file.

- **A session started with `--task` keeps it** (2.77.0): `STUDIO_TASK_PIN=<task>`; `task start <other>` and `task done <other>` (plain
  or `--train`; not `--check` / `--train-check`) are then refused (`harness/task-pin.mjs`). A person's shell has none.
- **Two rounds, then restart from the spec** (2.72.0): each full verify of a task by its holder, and each train hand-back, is a round.
  When the last `STUDIO_ROUND_CAP` (default 2; `0` off) rounds in a session are red with the same signature (failing sub-id + first
  FAIL line) the task is handed back and a third attempt (`npm run verify` while holding it, `task start`) is refused until a new
  session (outside the launcher: the last 12 hours). `--force` on `task start` is a person's reassignment.
- **`task start <ID> --agent <you> --dry-run`** (2.84) runs every check `task start` runs and prints what would happen (would start, with
  the lane, or the refusal and why); it claims nothing, makes no lane copy and logs no event. The board commands (`show`, `list`,
  `next`, `start --dry-run`) read the main checkout's board, also from a lane copy made by hand (it said "Task not found").
- **Held lanes**: `npm run task -- hold <ID> --by <name> --why "…"` (a person, Producer/Director session or outside agent; never a
  worker) marks a lane that waits to land on purpose; `task unhold <ID> --by <name>` ends it. A held or queued lane's claim clock
  (`STUDIO_TASK_MAX_MIN` 240; `STUDIO_TASK_MAX_SESSIONS` 6 and `STUDIO_TASK_MAX_TOKENS` 10M weighted tokens still count) stops, no
  rescue is filed, and `task next`, the supervisor and `task start` skip a queued task (another agent's start of an in-progress one
  needs `--force`).
- **Dependencies**: `npm run task -- after <ID> <T-x>[,<T-y>] | --remove <T-x> | --set <T-x>,<T-y> | --clear` (2.83) edits the
  `--after` list in `studio/task-holds.json` (an id on neither NEXT.md nor DONE.md is refused); `npm run task -- unblock <ID>` clears
  one. A task whose `--after` dependency is done but has commits on its lane branch (`.studio/lane-branches.json`) not on main waits,
  unless it landed another way (a landing record in the last 20000 events, older ones too up to `STUDIO_DEP_HISTORY_MB`, 200; a done
  rescue; a branch adding nothing to main). `STUDIO_DEP_LANDED_EVIDENCE=off`: only the window's own record counts.
- **Non-code tasks** (direction, review, docs, idea, research, study; changes all Markdown or under `studio/`, `docs/`, `.studio/`) skip
  the game suite at `task done` (2.78.2).
- **Relaunch** (2.78.2): a new lane copy starts from the task's remembered lane branch when it has commits the studio's branch lacks
  (`STUDIO_LANE_START_FROM_PREV=off`: from the studio's branch). `npm run lanes -- carry` skips commits the target already has
  (`STUDIO_CARRY_SKIP_APPLIED=off`: stop on them).

## One board, many agents (crash-safe state)

Shared state (`studio/NEXT.md`, `studio/DONE.md`, `studio/task-holds.json`, `.studio/STOP.json`, claim files in `.studio/locks/`) is
written to a temp file and renamed (`harness/fsafe.mjs`), and every board and holds change runs under a short lock
(`.studio/locks/board.mutex`, `holds.mutex`). Never hand-edit these files while agents run; use `npm run task`.

- **Locks**: a dead holder's lock is broken at once, another machine's after 10 s, a live holder's after 10 min
  (`STUDIO_STATE_LOCK_LIVE_MAX_MS`); waiters give up after 15 s ("run the command again"). The land lock (`.studio/locks/land.lock`)
  retries on Windows EPERM/EACCES/EBUSY.
- **Unreadable claim file**: "claimed (lock being written)" for `STUDIO_BROKEN_LOCK_GRACE_SEC` (10 s), then moved to
  `.studio/locks/broken/` (kept). Folder claims ignore case. An unreadable `STOP.json` counts as stopped; `npm run task -- resume
  --by <name>` clears it.
- **NEXT.md / DONE.md move**: the file gaining the task is written first, so a kill leaves it in both, never neither
  (`.studio/board-move.json`); both with no note counts as done; `task reopen` brings it back; `npm run watch` keeps one.
- **Leaked claims** (on a task done, waiting or gone) are released by `npm run watch` after `STUDIO_CLAIM_LEAK_GRACE_SEC` (60) of
  quiet, never while its `task done` runs. Temp files (`.<name>.<pid>-….tmp`) older than `STUDIO_TEMP_SWEEP_MIN` (5) are swept.
- **Lines the board can't read** are never dropped: ASCII `-` for `—`, or a role without backticks, is rewritten; anything else moves
  under `## UNREADABLE (kept by the harness: fix the format)`. Fix or delete it.

## Verify

`npm run verify` runs the gates in a process of its own and exits with the run's code; if its shell is killed the run still finishes
and writes its record. `npm run verify -- --wait` (or `npm run verify:wait`) re-attaches or shows the last result. One verify per
agent: same options attach, other options wait. Records: `.studio/verify-running/<owner>.json` and `<owner>.result.json`.
`--no-detach` (or `STUDIO_VERIFY_DETACH=off`) runs in the shell; `node scripts/run-gates.mjs` always does. Tracked files (outside
`studio/`) a verify changed are warned about and listed as `changedByVerify`; game checks run with `CI=true`. `task done` skips the
game checks when a green full verify tested the same tree (`STUDIO_DONE_REUSE_VERIFY=off` re-runs them); after a rebase only checks
whose declared `paths` the incoming files touch re-run.

- **Sub-ids** (`harness/gate-subids.mjs`): a failed gate names its parts: `game:<check>:<test file>`, `game:<check>`,
  `golden:<file>`, `<gate>:<file>`, else the gate id (`meta.subIds`).
- **Timeout-only reds** (`harness/timeout-rerun.mjs`): a game-check red whose ONLY failures are per-test timeouts re-runs those files
  once alone at low load; all green counts green, each labelled `timeout-flake` (`.studio/flakes.jsonl`), the lane not blamed. A file
  red alone, a mixed red, or more files than `STUDIO_FLAKE_MAX_FILES`: a real red. `STUDIO_TIMEOUT_RERUN=off` disables it.
- **Gates by track** (2.84, `harness/gate-tracks.mjs`): gates run for the engine a task is on. A verify covers the tracks of the
  lane's changed paths plus the track of its task (`STUDIO_VERIFY_TASKS`, a comma list of task ids the merge train sets to its batch;
  else `STUDIO_JOB_TASK`; else the one task the owner holds). Gates on other tracks are not run, and the summary names them: "not run
  for this change: golden, vision (web track); this change touches engine:unity only". The record's `tracks` says what was covered;
  `task done` and the train accept it only when that includes every track their own changes and tasks need. No task track and no
  diff, a path outside every track, `--all` or `--only`: every gate runs. `STUDIO_GATES_BY_TRACK=off` runs every gate every time
  (default on); one line says which mode ran. The game gate passes the covered tracks on to its own checks (`STUDIO_GATE_TRACKS`):
  a manifest check is `web` unless its `"track"` says otherwise, a Godot project's gate is `engine:godot`.

  | Changed path | Track |
  |---|---|
  | `docs/`, `studio/` notes, logs, the board, a `.md` outside the game and engine folders | `docs`: only the gates that judge docs (docs, secrets, hooks, protected, approvals, session, reviewer) |
  | inside an engine project (`project.godot`, a Unity `ProjectSettings/`, a `.uproject`) | `engine:<that engine>` |
  | `engine/<game>/` | `engine:<the engine its engine.json names>` |
  | `game/<name>/`, `web/<name>/`, `cartridges/`, `src/`, `assets/`, `public/`, `qa/golden/`, `qa/regressions/` | `web` |
  | `harness/`, `scripts/`, `qa/`, `tools/`, `.github/` | `harness` (and the `all` gates) |
  | `studio/godot-unit.json` | `harness`, `engine:godot`; any other `studio/` .json, or any other path: every gate |

  | Gate track | Gates (a `"track"` on a gate in `studio/gates.json` or a game's `studio.gates.json` wins) |
  |---|---|
  | `all` (every change but a docs-only one) | approvals, protected, secrets, hooks, weakened-tests, holdout; any gate the table doesn't name |
  | `harness` | session, docs, reviewer, selftest |
  | `web` | purity, isolation, golden, golden-py, regressions, vertical-slice, playtest, browser-play, soak, tick-budget, assets, fidelity, content-schema, balance, fun, renderer-budget, module-size, function-size, vision, journey; the game's own checks (`game:<id>`) |
  | `web` + `engine:godot` | game |
  | `engine:godot` | godot-unit, a Godot project's gate (`engine:<project>`) |
  | `web` + `engine:*` | controls, parity |
  | `engine:<x>` | engine (the engines `engine/*/engine.json` name) |

## The merge train (`harness/train.mjs`)

A lane copy's work reaches the studio's branch through a train, so landing does not move main once per lane. Copies made before
2.59.0 land the old way.

### Queueing and starting

- `npm run task -- done <ID> --train` (in the lane copy) runs the checks `task done` runs before the game's checks (board,
  done-check, committed work, protected files, secrets, hooks, weakened tests) and queues the lane (`.studio/train/queue.json`); the
  task stays in progress, its own full verify is not required. A refusal names the blocking check first. `npm run task -- train
  status` lists the queue.
- A plain `task done` in a lane copy with commits (2.78.2, `harness/train-detach.mjs`) does the same and exits 0 with "queued"; the
  task closes or is handed back when the train ends. The daemon runs it, else `task done` starts one detached (`train-daemon.mjs run`,
  log `.studio/train/daemon.log`) after waiting for a running one (`STUDIO_TRAIN_LOCK_WAIT_MIN` 120; old name `STUDIO_TRAIN_WAIT_MIN`,
  read when unset). Tier C is queued and held (exit 1). `STUDIO_DONE_QUEUE=0|off`, `STUDIO_TRAIN=off`, `--force`, or a copy with no
  commits: the old path (train inside `task done`).
- `npm run task -- train [--max N] [--dry-run] [--by <name>] [--wait <min>] [--now]` lands the queue oldest first; one train at a time
  (`.studio/locks/train.lock`; waits only with `--wait`); none while stopped; drain on makes it wait. An unknown subcommand prints
  usage (exit 2). `train status --engine <name>` lists an engine's batch and queue.
- **Detached starts**: trains started for someone else go through a launcher that exits at once, so killing the starter's tree doesn't
  reach them; `train` from an agent's shell (a launched session, `CLAUDECODE`, `AI_AGENT`, `CODEX_SANDBOX`, `GEMINI_CLI`, an agent's
  `STUDIO_LOCK_OWNER`) does the same and follows it (`STUDIO_TRAIN_FOLLOWED`). `STUDIO_TRAIN_DETACH`: `auto` (agent shells only), `on`,
  `off`; `--detach` / `--foreground` per run.
- **Batching**: waits up to `STUDIO_TRAIN_WAIT_MIN` (10, from the oldest queued lane; poll `STUDIO_TRAIN_POLL_S` 15) for
  `STUDIO_TRAIN_MIN` (1) unheld lanes; caps `STUDIO_TRAIN_MAX` (0: none; `--max`) and `STUDIO_TRAIN_BATCH` (4; `0`/`off`: none), the
  smallest wins. A "runAlone" lane (manifest: over `maxFiles` files, or a file under its `paths`) gets its own train. A lone `task
  done` takes queued lanes (not held, not run-alone) along; `STUDIO_TRAIN_RIDE_ALONG=off` stops that.
- **Daemon** (`harness/train-daemon.mjs`): with a supervisor running (`STUDIO_TRAIN_AUTO`, default on) each pass starts a detached
  train (`.studio/train/daemon.json`, `daemon.log`) when lanes are ready and the machine budget admits a verify; never beside another
  train, nor while winding down, "Stop all" or drain (`npm run task -- drain on`) is on. `npm run task -- train auto off|on --by <name>
  [--why "…"]` (a person, the owner's delegation, or a Producer/Director session or outside agent on a person's `--permission`; never a
  worker) stops or starts every automatic game-train start (`.studio/train/auto.json`; a person's own `train` still runs; engine
  trains are separate); `npm run task -- train auto` shows it. 2.85: an agent's `train auto off` lapses after
  `STUDIO_TRAIN_AUTO_OFF_HOURS` (4; `0`: until turned on), or after `--hours N`; a person's lasts until they turn it on. Why no
  train starts is said once per reason (`train.daemon.waiting`) and in `train status` ("The automatic start is waiting: …");
  lanes waiting only for the owner (tier C) are named with `train release <ID> --by <name>`, never released by the daemon.
  A web train runs beside an engine land when the heavy budget admits its verify (an engine land takes no machine:heavy slot;
  its RAM counts), so free RAM covering the web verify's measured need is enough.
- **Leaving**: a held task stays out of every train (`OUT (held)` in `npm run lanes`, `OUT OF TRAINS` in `train status`). `npm run
  task -- train leave <ID> --by <name> --why "…"` takes a queued lane out (as `task hold`); `task done <ID> --train` queues it again.
  `npm run task -- train dequeue <ID> [--engine <name>] [--by <name>]` (2.83) takes it out of the game's or that engine's queue and
  hands the task back (a lane in a running train is refused).
- **Conflict prediction** (`harness/train-predict.mjs`): `done --train` runs `git merge-tree --write-tree --name-only` against main and
  each queued lane: a conflict with main refuses the queue (merge main in, or `lanes refresh`); with a queued lane it queues `after:
  <task>`. Conflicts only in `unionFiles` count as none. `STUDIO_TRAIN_PREDICT=off` (or git older than 2.38): none.
- **Dependencies** (`harness/train-deps.mjs`): the train reads `--after` / `task block --until T-x` (also set by the planner and
  `proposed promote`): a done or same-train dependency goes, merged in order; an open one outside the train makes the lane wait; a
  dropped one hands it back.
- A lane conflicting with main is handed back; with earlier lanes it waits. A queued lane with uncommitted work waits; one whose claim
  moved leaves; one that gained commits after its check lands as checked and stays queued, unless they are only merges of main
  (`onlyMainMerges`): then it closes as landed (`STUDIO_TRAIN_CLOSE_MAIN_MERGES=off` keeps it queued). A queued lane's copy is kept
  when its session ends; a gone copy is made again from its branch.
- **Empty-diff lane** (2.78.1): a tier-A lane changing no file against main lands without a verify (`STUDIO_TRAIN_EMPTY_DIFF=off`: it
  rides the verify).
- **Mixed lanes** (2.76.0): a lane whose own commits carry another OPEN task's `Studio-Task:` trailer is refused: make a clean lane (a
  branch off main with only its own commits). A new lane copy likewise does not merge such an earlier branch (`carryTaskBranch` in
  `harness/worktree.mjs`; `lane.mixed_skipped`, `MIXED LANE NOT MERGED: …`). `STUDIO_TRAIN_MIXED=off` skips both.

### Landing tiers (`harness/tiers.mjs`)

A lane's tier comes from its diff and its commits' trailers, by code. A game may extend the table through its protected manifest
("tiers") and never lowers a tier-C rule.

- **C, needs the owner**: a protected file (`studio/protected.json` at main's tip plus the shipped list), `harness/`, `scripts/`,
  `qa/*.mjs`, a deleted test, golden or regression, a file the game declares `irreversible`, an upgrade merge (`Upgrade-Ref:`), a
  golden or snapshot re-recorded with the lane's own `Golden-Reason:` (rule `golden-rerecord`; the manifest may set it to B; the
  releaser is never the lane's author), a game's test toolchain, a config proposal for a protected file (`docs/SECURITY.md`). It is
  held (`train status` says NEEDS THE OWNER) until `npm run task -- train release <ID> --by <name> [--permission "<their words or a
  link>"]`: a person in their terminal, or a Producer/Director session or outside agent recording a person's permission
  (`harness/permission.mjs`); never a worker; with an owner key, only the owner's terminal. A release holds for that head only.
- **B, checks plus history**: sim paths, goldens, declared pin moves or pin files, shared utilities, the registry/barrel, a changed
  test, any file no rule names. Verified with `--all`; a golden changed with no `Golden-Reason:`, or a pin file (`pins.files`) with no
  `Pin-Moves:`, is handed back. Handed back more than `STUDIO_TRAIN_MAX_HANDBACKS` (3) times: held for a person like C; in beta mode
  (`npm run beta`) held for the orchestrator and Producer (`held.beta`; `train release <ID> --by <their name>`) and ONE Producer task
  "Rescue <ID>: handed back N times" is filed. Infrastructure hand-backs never count (missing lane copy, CRLF/hash mismatch, re-queue,
  dead train, a timeout-only red re-run alone, a mixed lane: `INFRA_HANDBACK` in `harness/train-lanes.mjs`, `meta.infra`).
- **A, contained**: docs, added tests, the game's tools folders, assets, UI outside the sim. The normal verify.

### Verify and landing

- Lanes are merged in order onto main in a scratch copy (`.lanes/_train-<id>`, branch `train/<id>`; never the main checkout or a
  lane's copy); a conflict only in `unionFiles` is merged by git's union driver (`Union-Merge: <files>`). ONE full verify
  (`scripts/run-gates.mjs`, scoped to the files the lanes change, `--all` for a "whole" task) checks the final tree; a green full
  verify already recorded for exactly that tree stands for it (`.studio/gates/trees/`). Green: main moves (compare-and-swap, under the
  land lock) and each task closes as `task done` closes it. A lane whose own tree has a green recorded verify goes first.
- **Related tests first** (multi-lane): each lane's related tests (the game's `related` command, `STUDIO_GATE_RELATED_ONLY=on`) run
  on the combined tree first; a lane red there whose tests pass on main's tip is handed back at once. `STUDIO_TRAIN_RELATED_FIRST=on|off`
  (unset: on when the manifest declares `related`).
- **Slow tier**: checks and test globs the game marks slow stay out of verifies and trains; `npm run gates -- --tier slow` runs only
  them on main; the supervisor runs it daily at `STUDIO_SLOW_HOUR` (local hour, 3; `off`). One bug task per new failure (at most
  `STUDIO_SLOW_MAX_TASKS`, 10, per run). Landing never waits for it.
- **Chain tails** (`harness/train-tail.mjs`, `STUDIO_TRAIN_CHAIN_TAIL`, default on): for a stacked chain (`--after` / `task block
  --until`) or a `Pin-Moves:` lane, the train runs the chain's touched tests before its verify. Red and not fixed by a pin refresh: ONE
  P0 builder task "Bug: chain tail for <lanes>: <tests> fail only on the combined chain" (`studio/handoffs/<ID>.md`; one per signature,
  `.studio/train/chain-tails.json`); the chain then waits for its tail and lands with it, nobody handed back.
- **Pins**: when the red is only the game's pin tests, each moved value is attributed to the lanes that moved it
  (`.studio/train/<id>/pins.json`). If each declared it (`Pin-Moves: <pin>` trailer) and no invariant pin moved, ONE extra commit "train
  <id>: pin refresh" (`Pin-Refresh: <lanes>`, a Golden-Reason) lands with them after a full verify; otherwise the lane(s) attributed are
  handed back (pins red on main itself: nobody); a failed refresh falls back to bisection.

### When the verify is red

- **Bisection**: only the failing checks re-run (`run-gates --only`), first on main, then on prefixes main+A, main+A+B, ... Red on
  main: nothing lands, nobody is handed back. Otherwise the lane that turns the first prefix red is handed back and the rest train
  again. A red only in the whole train is re-run first; if it passes nobody is handed back. A check red at claim time (baseline) doesn't
  count. `STUDIO_TRAIN_BISECT=alone`: verify each lane alone on main. Re-checks run only the failing test FILES (`STUDIO_GATE_FOCUS`,
  honoured only by `run-gates --only`): the manifest gate's `focus` command, else files appended to a clear vitest, jest or `node
  --test` command, else the whole check. Once a culprit at position k > 1 is named, main + lanes 1..k-1 get a full verify and, green,
  land (`STUDIO_TRAIN_LAND_PREFIX`, default on). K prefixes re-check at once (`harness/train-parallel.mjs`), at most
  `STUDIO_TRAIN_BISECT_PARALLEL` (4; `1`/`off`: one) and max(1, slots - `STUDIO_TRAIN_BISECT_SPARE`) (1 slot kept for builders;
  `0`/`off`: none); no scan: 1.
- **Fix first**: after a red main or a game check red in two trains in a row (`.studio/train/red-streak.json`) the next train runs
  first and alone the first queued lane that changes that check's configuration. `STUDIO_TRAIN_FIX_FIRST=off`.
- **Busy is never red** (`harness/train-busy.mjs`): a verify that ran no check (a full verify of the same checkout runs, or
  `machine:heavy` stayed held) makes the train wait and retry (`STUDIO_TRAIN_BUSY_WAIT_MIN`, 20 in all), then defer its lanes; nobody
  is handed back. `task.train.verify` `meta.exitCause` (`harness/verify-cause.mjs`): `green`, `fail`, `exit`, `signal`, `timeout`,
  `busy`, `no-check`, `no-record`, `tree-mismatch`, `not-clean`.
- **Red budget** (`STUDIO_TRAIN_RED_BUDGET_MIN`, 30; `0`/`off`: none), from the first red verify: past it the NEWEST lane is handed back,
  the longest prefix whose exact tree a full verify passed lands, the rest keep their place.
- **Known red on main** (`harness/known-red.mjs`): main's failing test files are listed in `.studio/train/known-red.json`; a later train
  whose only red parts are listed tests in files none of its lanes change re-runs them on main's tip alone: still red, it lands and
  reports them; green, they clear. A test a lane changed is never excused.
- **Flake triager** (`harness/flakes.mjs`; `STUDIO_FLAKE_TRIAGE=off` turns it off): each failing test file (at most
  `STUDIO_FLAKE_MAX_FILES`, 5; once per train) runs ALONE on the same tree: fails `real`; passes with a test-randomness finding
  (`harness/test-rng.mjs`) `seed-flake`; passes, and again with one worker `load-flake`; passes then fails `intermittent`. Labels go to
  `.studio/flakes.jsonl` and change nothing except `load-sensitive` and `port-collision`; the triage stops at the first `real`. Failing
  files run TOGETHER by default (`STUDIO_FLAKE_TOGETHER=off`: one at a time).
  - A file failing alone re-runs at low load once the machine is quiet (no other `machine:heavy` holder, no Unity outside the lock, no
    live session in `STUDIO_QUIET_BUSY_ROLES`, default `engine-porter,engine-worker`, `off`: none; `harness/flake-quiet.mjs`), waiting up
    to `STUDIO_FLAKE_QUIET_WAIT_MIN` (10): fails again `real`; passes `load-sensitive` (`.studio/load-sensitive.json`; never quarantined).
    A train whose red is ONLY load-sensitive files lands and reports them. A file with at least `STUDIO_LOAD_SENSITIVE_TRUST` (2;
    `0`/`off`: never) quiet-confirmed labels within `STUDIO_FLAKE_WINDOW_DAYS` (7) and no `real` since skips the quiet wait.
  - The quiet re-run holds new non-landing heavy work back (`.studio/locks/machine-heavy-quiet-hold-<pid>.json`), at most
    `STUDIO_FLAKE_HOLD_MIN` (default quiet wait + `STUDIO_FLAKE_WAIT_MIN` + `STUDIO_GAME_GATE_TIMEOUT_MS`, 30; `0`/`off`: none); running
    verifies are never stopped (the marker tagged `-chain-breaker` is the Line Producer's, `docs/LINE-PRODUCER.md`). Each alone-run waits
    at most `STUDIO_FLAKE_WAIT_MIN` (10) for a slot; one refused as busy is "not run" and the triage stops.
  - `port-collision` (`harness/test-ports.mjs`: a test server couldn't take its port; give the test a free port) is neither `real` nor
    flaky; when every failing file is one nobody is handed back; a second time at the same head: held for the Producer.
  - **Quarantine**: `STUDIO_FLAKE_QUARANTINE_AFTER` (3) flaky labels in the window put the test on `studio/quarantine.json` (`{ test,
    label, since, why, by, status, evidence, task }`) as PROPOSED and file ONE fix task. A proposed entry still runs until a person, an
    agent under the owner's delegation, or an outside agent or Producer/Director session with `--permission` confirms it: `npm run
    flakes -- confirm <test> --by <name>` (never a worker); then the game's runner skips it (`STUDIO_TEST_QUARANTINE`).
    `"autoQuarantine": true` (in `{ "autoQuarantine": true, "tests": [...] }` or the game's `studio.gates.json`) activates the harness's
    entries at once. A real failure is never quarantined. A lane changing the list is tier C (`STUDIO_TRAIN_QUARANTINE_MOVE=off`: any
    change, not only one that skips more tests, verifies again). `npm run flakes -- release <test> --by <name>` releases one.

### When main moves, and train variants

- **Main moved by board files only** (the list is `harness/train-board.json`): the train lands on the same verify when the merge onto
  the new main is clean and the new tree is the verified tree plus exactly those files. Any other change (`studio/protected.json`,
  `studio/game.json`, gates, keys, code, goldens) or a pin-refresh train verifies again.
- **Non-code commits only** (`harness/train.mjs nonCodeReaders`, `harness/check-reads.mjs`): if no file in main's new commits has a
  reader among the checks, the train lands its tree and merges them on top without a new verify, only if the merge is clean and the
  secrets check is green. Any doubt, or over `STUDIO_TRAIN_LAND_OVER_NONCODE_MAX` (200) commits: verify again. The docs check skips
  `studio/producer/`, `studio/reviews/`, `studio/handoffs/`, `studio/notes/`.
- **Pipelined trains** (2.77.0, `harness/train-pipeline.mjs`): while train A verifies, ONE speculative train B verifies A's tree + the
  next ready lanes in its own copy (`node harness/train-daemon.mjs run-next <A>`, `.studio/locks/train-next.lock`) and lands right
  after A without verifying again if main is then exactly A's verified tree (or that plus record files); otherwise it is discarded and
  its lanes keep their place. B never holds, hands back or bisects. `STUDIO_TRAIN_PIPELINE`: unset starts B only when the machine
  budget has room (no scan: none); `on` whenever lanes are queued; `off` never.
- **Harness guard** (`harness/harness-version.mjs`): a train never starts another train from a process whose harness changed since it
  started (the daemon does); a red re-check of main on another harness is "not run": nobody blamed or handed back.
  `STUDIO_TRAIN_HARNESS_GUARD=off`.
- **Death and stall** (`harness/train-life.mjs`, `harness/train-watch.mjs`): each train writes `.studio/train/<id>/life.json` and a 30 s
  heartbeat; the reaper records a dead one when its process is gone or the heartbeat is older than `STUDIO_TRAIN_DEAD_MIN` (30).
  `status.json` unchanged for `STUDIO_TRAIN_STALL_MIN` (90; `0`/`off`: no watch) while it works (a wait in the `machine:heavy` queue,
  bounded by `STUDIO_HEAVY_WAIT_MIN`, counts as moving) stops its children; still not moving `STUDIO_TRAIN_STALL_GRACE_S` (300) later:
  the process is ended. Neither hands anyone back; lanes keep their place (a second death or stall at the same head: held for the
  Producer).
- **Cancel**: `npm run task -- train cancel [<train id>] --by <name> [--why "…"]` (`harness/train-cancel.mjs`; a person, the orchestrator
  or Producer/Director session, never a worker) stops the running train, waiting up to `STUDIO_TRAIN_CANCEL_WAIT_S` (120); nobody is
  handed back. `train auto off --by <name>` stops the next start.
- **After a landing** (`harness/landing-build.mjs`): ONE low-priority `build-clip` job saves landed main as a playable build
  (`npm run play`, `docs/ARCADE.md`) and records a clip (`qa/clip.mjs`); skipped with no browser build, for the template, or
  `STUDIO_LANDING_BUILD=off`. `STUDIO_LANDING_CLIP_SECONDS` (15), `STUDIO_LANDING_CLIP_CMD` (`{seconds}`, `{name}`),
  `STUDIO_LANDING_CLIP_TIMEOUT_MIN` (10). `node harness/landing-build.mjs status`.

## Studio config from a lane copy

`studio/` in a lane copy is the main checkout's (a link): only the board commands write there, and a lane's commits never carry
studio config. A config change (`studio/*.json`, `studio/bible/*.json`, keys, approvals, presets) goes to the owner or Producer on
main: hand the task back with a note. A hook (`.claude/hooks/lane-studio-guard.mjs`) refuses such an edit.

**Config proposal** (the sanctioned route): commit `studio-proposals/<ID>.json` = `{ "changes": [ { "file": "studio/<name>.json",
"set": { "<a.b or /a/b>": <value> } } ], "why": "…" }` (top-level `studio/*.json` only; keys are set, nothing deleted). When the lane
lands, the harness applies it to main in its next commit (`Config-From: <ID>`) and removes the file. A key main changed since the lane
started, or an unreadable proposal, hands the lane back. A protected file in it makes the lane tier C (rule
`config-proposal-protected`): without an owner key the person's release decides; with one, only the owner's signed `npm run approve --
proposal <ID> --note "…"` applies that part. Until then it stays in the file (`"held"`) and `npm run task -- train config <ID> [--by
<name>]` applies it once settled. Nothing is dropped silently.

## Heavy work shares the machine by budget

Full verifies, Unity editor runs, browser playtests, Blender previews and asset round trips take the `machine:heavy` lock
(`harness/heavy.mjs`, budget in `harness/heavy-budget.mjs`): each job declares a claim and starts when it fits what the last machine
scan (`.studio/machine.json`) says is free. `node harness/heavy.mjs status` shows the budget, claims and GPU-area holders; `node
harness/heavy.mjs stop [--label <x> | --all] --by <name>` kills a holder's tree and frees the slot (a worker is refused;
`STUDIO_HEAVY_REAP=off`: leftovers of a killed holder are only named).

- **Default claims**: game verify 1 GB + 0.45 GB per test worker; Unity editor 8 GB + 2 GB VRAM; browser playtest 5 GB + 1 GB VRAM;
  Blender preview 2 GB + 1 GB VRAM (GPU only); asset round trip 1 GB; `art-bake` (`--kind art-bake`, 2.77.0) 6 GB, 4 threads, 20
  minutes; anything else run by `node harness/heavy.mjs run` 4 GB (`--kind <kind>`, `--ram-gb`, `--vram-gb`, `--gpu-only`).
  `studio/machine-budget.json` overrides: `{ "jobs": { "unity": { "ramGb": 10 }, "art-bake": { "ramGb": 9, "cpuThreads": 6,
  "minutes": 45 } } }` (`minutes` works for any kind).
- **Priority** is one table, `RIG_PRIORITY` in `harness/heavy-budget.mjs`: train > builder verifies > Unity/art > soaks (playtest and
  other fixed-claim jobs share Unity/art's rank). `node harness/rig-budget.mjs [--json]` lists what runs, with an `artBake` share.
- **Limits**: RAM = free memory less `STUDIO_RESERVE_RAM_GB` (4 GB or 10% of RAM, the larger) and claims since the scan; GPU = the
  largest GPU's free VRAM less `STUDIO_GPU_RESERVE_GB` (2.5 when it drives the display); CPU = claimed threads within
  `STUDIO_CPU_OVERCOMMIT` (1.5) x cores; slots = `STUDIO_HEAVY_SLOTS` (default from the scan, 1 to 6; `0`: lock off; waiters also read
  the main checkout's `.env`, lower wins, `STUDIO_HEAVY_SLOTS_LIVE=off`: own value only). A job that doesn't fit waits (landings first),
  says why, and fails after `STUDIO_HEAVY_WAIT_MIN` (60); a claim bigger than the budget runs alone. An engine land takes the engine line
  (`STUDIO_ENGINE_SLOTS`), not a slot. No scan, a scan older than `STUDIO_MACHINE_MAX_AGE_MIN` (15), or `STUDIO_MACHINE_SCAN=off`: one
  slot and the `STUDIO_RAM_FLOOR_GB` floor (a job also waits under it, up to `STUDIO_HEAVY_RAM_WAIT_MIN` 10). The supervisor starts at
  most (RAM - reserve - claims) / `STUDIO_SESSION_RAM_GB` (0.6) sessions. Tests stub the scan with `STUDIO_TEST_MACHINE` (JSON, a path,
  or `none`).
- **Per-kind caps**: one Unity editor run and one browser playtest at a time. Change with `"maxConcurrent": { "unity": 2 }` in
  `studio/machine-budget.json` or `STUDIO_HEAVY_MAX_<KIND>` (`STUDIO_HEAVY_MAX_UNITY`, `STUDIO_HEAVY_MAX_BROWSER_PLAYTEST`,
  `STUDIO_HEAVY_MAX_BLENDER`; `0`/`off`: no cap). `STUDIO_HEAVY_MAX_VERIFY` caps game verifies (unset: none; `3` suits a PC that also
  runs Unity gates). `STUDIO_GATE_SLOTS` (2) is how many heavy game checks run at once; a landing's checks go first.
- **Train priority**: while the daemon finds no room for a verify, `.studio/locks/machine-heavy-train-wait.json` keeps builder verifies
  from taking a freed slot, at most `STUDIO_TRAIN_SLOT_PRIORITY_MIN` (15; `0`/`off`: none) at a time; it is fresh for 3 x
  `STUDIO_SUPERVISOR_SEC` (at least 5 min).
- **Timeouts**: a game check's timeout (`STUDIO_GAME_GATE_TIMEOUT_MS`, 600 s) is stretched up to 3 times for load, never shortened;
  without a load average (Windows) a CPU-busy sample over `STUDIO_CPU_BUSY_THRESHOLD` (0.6) counts; never below
  `STUDIO_GAME_GATE_TIMEOUT_FLOOR` (1.5) x the check's last quiet passing run. A Unity editor outside the lock
  (`STUDIO_HEAVY_PROGRAMS`) counts as a heavy job. A job killed for memory (0xC0000017, heap out of memory, exit 137) is queued once
  more, not counted red (`STUDIO_HEAVY_OOM_RETRY=off`); a second counts.
- **Unity free RAM**: a Unity job waits for live free RAM of `STUDIO_UNITY_MIN_FREE_GB` (12, at most 60% of RAM); a wait that runs
  out is "not run" (exit 3), never red. Scripts: `npm run heavy -- wait [--min-free-gb N] [--timeout-min M] [--hold <label>]`,
  `npm run heavy -- release --label <label>`, `heavy run --min-free-gb N --timeout-min M -- <command>` (`docs/UNITY-TRACK.md`).
- **Test workers**: game checks get `STUDIO_TEST_WORKERS` and `VITEST_MAX_WORKERS` = free RAM for the job / `STUDIO_TEST_WORKER_GB`
  (0.45), 2..cores - 2 (2 with no scan), bounded by the job's share of the cores (weight 4 train verify, 2 builder verify or lane
  check, 1 soak; `"priority"` in `studio/machine-budget.json`; a train holding its lock or with lanes waiting counts as coming,
  `STUDIO_TRAIN_RESERVE=off`: not). `STUDIO_TEST_WORKERS` always wins; `STUDIO_RIG_SHARE=off` sizes by RAM only. Per-test timeouts
  scale by ceil(4 x workers / cores), 1..4 (`STUDIO_TEST_TIMEOUT_SCALE`; `docs/ONBOARDING-A-GAME.md`, "Per-test timeouts that fit the
  workers").

### GPU area (2.70.0)

With a GPU in the scan, mostly-GPU jobs claim VRAM plus a small RAM and CPU share (RAM / CPU threads / VRAM) instead of a slot, so
they start beside a CPU verify: `browser-playtest` 5 / 1 / 1 GB and `gpu-playtest` 2 / 1 / 1 GB (only with browser GPU flags on,
`STUDIO_BROWSER_GPU`, `docs/BROWSER-PLAY.md`; off, they keep a slot); `blender-preview` 2 / 1 / 1 GB and `asset-roundtrip` 1 / 1 / 0.5 GB
(the harness's Blender jobs); `unity-bake` 8 / 2 / 4 GB and `unity-visual` 8 / 2 / 2 GB (callers pass the kind); `build-clip` 3 / 1 / 0.5 GB
(the post-landing build + clip, with browser GPU flags on). No GPU, no scan, or `STUDIO_GPU_AREA=off`: a slot claim. `"gpuJobs": {
"<kind>": { "ramGb", "cpuThreads", "vramGb" } }` in `studio/machine-budget.json` changes a claim. Caps count by group (every Unity
kind is `unity`, the Blender jobs one `blender`, the clip a `browser-playtest`); a Blender opened by hand is never counted or touched.
A Blender command gets `-t <n>` render threads unless it sets its own: `STUDIO_BLENDER_THREADS`, else logical cores / 3 (1 to 8), never 0
(`harness/blender-job.mjs`; unverified with a real Blender).

## Plan-time scope and waves (shadow mode, 2.78.0)

`harness/plan-waves.mjs` (not `harness/waves.mjs`, the fun-check module) measures what scheduling by task overlap
(`harness/task-overlap.mjs`, `harness/hotspots.mjs`) would do. It changes nothing: no task is started, held or blocked by it.

- A task may carry a **scope**: `task add --scope "src/sim/**,docs/A.md"` (entries with spaces are ignored); without one it borrows
  the files its `hotspot.overlap` and `task.overlap` history names.
- `node harness/plan-waves.mjs [--json]` colours the overlap graph of **ready** builder tasks into waves (tasks in one wave don't
  overlap) and prints the **serialized share** (ready tasks forced into wave 2 or later). Over `STUDIO_WAVES_MAX_SHARE` (0.6), waves
  would over-serialize the crew: don't switch scheduling by them on.
- The watcher logs `waves.shadow` at most every `STUDIO_WAVES_MIN` minutes (30); `STUDIO_WAVES=off` stops it.
- `node harness/plan-waves.mjs replay --events <events.jsonl> --days 14` reports how many recorded overlaps waves would have avoided
  and roughly the extra wall time.

## Evidence behind a claim (2.85 g)

Five places that took a name or a sentence on trust now ask for something that exists.

- **A milestone is met with evidence.** `npm run refill -- met M2 1 --by <name> --evidence <file|commit|evt_id> [...]`: each item
  must be a file in the repo, a commit git finds or an event id in the log, and is stored with the record (`milestones` lists it).
  An agent without evidence is refused with one line saying what counts. A person may give `--evidence none --why "<reason>"`.
- **A Golden-Reason names its task.** The trailer must be 20+ characters and name a task on the board (open or done, `T-123`);
  a shorter or anonymous one no longer waives the golden check (`harness/test-weakening.mjs`). `STUDIO_GOLDEN_REASON=strict|loose`
  sets it; the default is strict when the board has tasks and loose on an empty board (a fresh studio).
- **Sim or rules code changes with a test or a stated reason.** A `change` task whose files include game sim code (the "sim" rule
  of `harness/tiers.mjs`) and no test file gets a WARN line at `task done` unless a commit carries `No-Test-Reason: <20+ characters>`.
  It is a note by default: the `task.done` event records it (`meta.noTest`, or `meta.noTestReason` with the reason) and
  `npm run score` counts both. `STUDIO_RULES_TEST=require` makes it a refusal. Docs, assets and tooling are not asked.
- **The browser check plays the studio's game.** `qa/browser-play.mjs` plays the active game's cartridge (`studio/game.json` `game`,
  then `cartridge`), never the template's sample unless it is the active game. A game with no cartridge manifest is skipped with
  "not applicable: <why>" (`qa.browser_play` status `skipped`); its own `studio.gates.json` play or smoke check covers play.
- **A hand-back note's files are looked for.** A repo path the note says it added, wrote or changed ("added X", "see X", "in X")
  that exists in neither the lane nor main adds a line to the hand-back facts and a `task.note_unverified` event (warn); never a refusal.
