# Work Organization (`docs/WORK-ORGANIZATION.md`)

Agents must keep durable work in files, never trapped in chat history.

## Where to Store Work

| What | Where | When |
|------|--------|------|
| Active handoff / current focus | `studio/CURRENT_TASK.md` | Start and end of every session |
| Prioritized backlog | `studio/NEXT.md` | When priorities change or new work appears |
| Completed task summary | `studio/done/YYYY-MM-DD-short-title.md` | When a task is finished |
| Daily rollup + videos | `studio/daily/YYYY-MM-DD.md` | End of day or major session |
| Before/after videos | `studio/daily/videos/` | When gameplay visuals change |
| Bug report | `studio/templates/bug.md` → copy into `qa/reports/` | When a bug is found |
| Playtest report | `studio/templates/playtest.md` → copy into `qa/reports/` | After a playtest |
| Calibration notes | Inside the done summary or `studio/CURRENT_TASK.md` | During Designer-Calibrator work |

## How to Pull the Next Task

1. Read `studio/CURRENT_TASK.md`. If it has a clear next step in `IN_PROGRESS`, do that.
2. If `studio/CURRENT_TASK.md` is idle or marked done, inspect `studio/NEXT.md` (or run `node harness/task.mjs next`).
3. Take the highest-priority unchecked item (`node harness/task.mjs start <ID>`).
4. Do the work, logging passive progress via `node scripts/append-event.mjs` or `node harness/event.mjs`.
5. When finished:
   - Write a short summary in `studio/done/YYYY-MM-DD-short-title.md`.
   - Update `studio/CURRENT_TASK.md` and mark the item done in `studio/NEXT.md` (`node harness/task.mjs done <ID>`).
6. At the end of a day or major session, fill `studio/daily/YYYY-MM-DD.md` (copied from `studio/daily/TEMPLATE.md`), including the task checklist and any before/after gameplay videos.

## Many Agents, One Board (crash-safe state, 2.57.0)

Several agents change the board at once, and any of them can be killed mid-command. So the harness never
writes shared state in place: `studio/NEXT.md`, `studio/DONE.md`, `studio/task-holds.json`, `.studio/STOP.json`,
the trunk state and the claim files in `.studio/locks/` are written to a temp file and renamed over the old one
(`harness/fsafe.mjs`), so a reader sees the old file or the new one, never half of one. Every change to the board
(start, done, pause, add, drop, reorder, reopen, the watcher's requeue) and to the holds (park, block, lane) is
read, made and written under a short lock (`.studio/locks/board.mutex`, `holds.mutex`; a dead agent's lock is
broken at once, a stuck one after 10 s), so ten agents starting ten tasks together all land on the board. A claim
file that can't be read (an agent killed while making it under an older harness) is reported as "claimed (lock
being written)" for its first 10 s (`STUDIO_BROKEN_LOCK_GRACE_SEC`), then moved to `.studio/locks/broken/`
(kept, never deleted) by the next claim or `npm run watch`. A `STOP.json` that exists but can't be read counts as
stopped; `npm run task -- resume --by <name>` clears it. Don't hand-edit these files while agents run; use the
`npm run task` commands.

## Verify runs on its own (2.58.0)

`npm run verify` runs the gates in a process of its own and shows its output; it exits with the run's code, as
before. If the shell running it is killed (Claude Code's low-memory guard reaps idle background commands), the run
still finishes and writes its record. `npm run verify -- --wait` (or `npm run verify:wait`) re-attaches: it shows a
running verify until it ends, or the last one's output, commit and exit code. One verify per agent at a time: a
second call with the same options attaches to the running one; other options wait for it to end. Ctrl+C at a
terminal stops the run too. State and logs: `.studio/verify-running/<owner>.json` (pid, start, log, options) and
`<owner>.result.json`. `--no-detach` (or `STUDIO_VERIFY_DETACH=off`) runs in the shell itself; harness commands and
CI that call `node scripts/run-gates.mjs` always do.

Every verify compares the tracked files (outside `studio/`) before and after its gates. Any it changed (a test
rewriting a snapshot's line endings, a generated file) are named in a warning and listed as `changedByVerify` in
the verify record; the exit code is unchanged. Game checks run with `CI=true` so test runners don't write snapshots.

### Two rounds, then restart from the spec (2.72.0)

Each full verify of a task by the agent that holds it, and each merge-train hand-back of its lane, is one round
(a `task.round` event with the failing check's sub-id, e.g. `game:unit`, and its first FAIL line as the signature).
When the last `STUDIO_ROUND_CAP` (default 2; `0` turns it off) rounds of a task in one agent's session are red with
the same signature, the task is handed back with a summary the harness writes (files touched, gates, the sub-id, both
red signatures, the decisions logged on the task) and a note to restart from the spec instead of patching the last
attempt (`task.round_cap`). In that session a third attempt is refused: `npm run verify` while the agent still holds
the task, and `task start` of it again. A new session (after `agent.session.start` or `.end`) may take it; an agent
outside the launcher counts the last 12 hours as its session. `--force` on `task start` is a person's reassignment.

## Landing lanes: the merge train (2.59.0)

A lane copy's work reaches the studio's branch through a merge train (`harness/train.mjs`). Before 2.59.0 every
landing moved main, so every other lane rebased (often breaking its hook stamps) and verified again, one at a time.

- `npm run task -- done <ID> --train` (in the lane copy) runs every check task done runs before the game's checks
  (board, done-check, committed work, protected files, secrets, hooks, weakened tests) and queues the lane
  (`.studio/train/queue.json`); the task stays in progress. `npm run task -- train status` lists the queue. Its own
  full verify isn't required (the train's verify covers it); a refusal names the check that blocks on its first line
  and in the `task.not_done` event, and lists the verify rows as "(the train's verify covers this)" (2.60.1, B-33).
- `npm run task -- train [--max N] [--dry-run] [--by <name>] [--wait <min>]` lands the queue, oldest first: each lane
  is checked again in its own copy, then merged in order onto main in a scratch copy (`.lanes/_train-<id>`, branch
  `train/<id>`; never the main checkout's files or a lane's copy). A lane is merged as it is (a fast-forward, or a
  merge commit the hooks stamp), so its own commits and their stamps never change. ONE full verify
  (`scripts/run-gates.mjs`, scoped to the files the lanes change, as a lane's verify is; `--all` when a task is
  "whole") checks the final tree; a green full verify already recorded for exactly that tree stands for it. Green:
  main moves (compare-and-swap, under the land lock) to that tree and each task closes as task done closes it.
- Red (2.60.0, prefix bisection): only the failing checks run again (`run-gates --only`, scoped as the train's verify
  was), first on main, then on cumulative prefixes main+A, main+A+B, ... by binary search (about log2 N targeted
  runs; logs `.studio/train/<id>-recheck-<n>.log`). Red on main: main itself is red, nothing lands and nobody is
  handed back. 2.73.2 (B-75): the train remembers it (`.studio/train/red-streak.json`, also a game check red in two
  trains in a row; a train that lands anything clears it), and the next train puts the first queued lane that changes
  that check's configuration (the game's vitest/vite/jest configs and workspaces, `.npmrc`, its `studio.gates.json`, the
  test scripts of its package.json) first and alone (runAlone, `task.train.fix_first` with the reason), once per lane
  commit; the other lanes follow in the next train. A tier-C fix still waits for the owner's release.
  `STUDIO_TRAIN_FIX_FIRST=off` turns it off. A verify or re-check that ran no check (2.67.2, B-50: refused because a full verify of the same
  checkout runs, or `machine:heavy` stayed held past its wait) is busy, never red: the train waits and runs it again
  (`STUDIO_TRAIN_BUSY_WAIT_MIN`, 20 minutes in all, logged each time), then defers its lanes for the next train
  (`task.train.no_check`); it never hands anyone back or concludes that main is red from it (`harness/train-busy.mjs`).
  Each checkout has its own "full verify running" record (`.studio/verify-running/full.json` in the main checkout,
  `full.<hash>.json` in a lane or train copy), so a lane's verify no longer refuses the train's or another lane's. Otherwise the lane that turns the first prefix red is handed back (back in the queue, its claim freed,
  a hand-back note with the failing checks, the prefix and the log), whether it fails alone or only together with
  the lanes before it (an interaction culprit); the rest train again with one more full verify. When only the
  whole train is red, that red is re-run before anyone is blamed; if it passes, nobody is handed back and the lanes
  wait (event `task.train.flaky`). A check already red when every task in the train was claimed (its baseline)
  doesn't count, as at task done. `STUDIO_TRAIN_BISECT=alone` keeps the 2.59 way: each lane verified alone on main,
  one that fails alone handed back, lanes that pass alone but fail together: the last one waits.
- Red, faster and said (2.65.3, B-43): a re-check runs only the failing test FILES of the failing game checks
  (read from the verify log; `STUDIO_GATE_FOCUS`, honoured only by a `run-gates --only` run, which stands for no
  verify): the manifest gate's `focus` command, else the files appended to a command that clearly runs vitest, jest
  or `node --test`, else the whole check (the log says why; also when no file is named, or the focused run fails
  without naming a test). The red event and the log name the failing tests; each re-check line says its question
  ("re-check 3 of about 4: lanes 1-9; green through lane 2 (T-a), red at 9; is the break in lanes 3-5?") and an ETA
  from this train's timings ("ETA unknown (no timing yet)" before any); a new round says "round 2: 8 lane(s) left
  without T-x; verify, then bisect again if red". The step is kept in `.studio/train/<id>/status.json`, shown by
  `npm run lanes` and `status --brief` (with a STUDIO_TRAIN_MAX note above 6 lanes). Once a culprit at position k > 1
  is named, main + lanes 1..k-1 get a full verify and, green, land at once (`STUDIO_TRAIN_LAND_PREFIX`, default on;
  `off` keeps 2.65.2); the culprit is handed back and the lanes after it wait for the next train, which runs right
  away (also after a task done's own train). Events `task.train.recheck`, `.prefix_landed`, `.prefix_red`.
- Parallel prefixes (2.69.0, `harness/train-parallel.mjs`): the prefix search is K-ary. Between a green lo and a red
  hi it re-checks K boundary prefixes at once (split into K+1 parts), each in its own scratch copy and each run-gates
  taking its own machine:heavy claim; the answer is the same first red prefix, in about log(K+1) N rounds instead of
  log2 N. K = how many focused re-check claims (2..8 test workers each) fit the machine budget now (the last machine
  scan, live heavy holders, slots, RAM, CPU), capped by `STUDIO_TRAIN_BISECT_PARALLEL` (default 4; `1`/`off`: one at
  a time). No scan: K = 1, the search above unchanged. The log says "bisect round 1: checking prefixes 3, 6 at once";
  event `task.train.bisect_round`.
- Remote verify (2.69.0, `harness/remote-verify.mjs`, `STUDIO_VERIFY_REMOTE=github`, off by default): the remote CI
  may stand for the game's own checks ONLY, never for a safety gate. The train first runs every other gate locally on
  its tree (`run-gates --only`, every studio gate but the game checks, engine and heavy ones: protected, secrets,
  hooks, weakened-tests, golden, regressions, ...; about 10 s). Red there (not excused by a baseline): the verify is
  red, the remote is not asked, and the prefix search re-checks those gates. Green: for a PUBLIC GitHub repo, with
  `GH_TOKEN` or `GITHUB_TOKEN` set by the owner (never printed, never on a command line), the train pushes its
  integration commit to `train/<id>` on origin and waits for the check run named by `STUDIO_VERIFY_REMOTE_CHECK` (a
  pattern, default `release-gate`): every matching run must complete with success (skipped or neutral is not green;
  other check runs don't count). Both parts green: the tree counts as verified, and
  `.studio/train/split/<id>-<n>.json` records which gate came from where. Anything else runs the full local verify:
  any error, a private repo, an existing `train/<id>`, no run of the named check (`STUDIO_VERIFY_REMOTE_START_MIN`,
  10; the workflow must run on pushes to any branch), no result within `STUDIO_VERIFY_REMOTE_TIMEOUT_MIN` (60; polled
  every `STUDIO_VERIFY_REMOTE_POLL_S`, 30), and red CI (the local record names the failing checks for the search). The
  train then deletes its own `train/<id>` branch (only that name, only if its push made it). Cost: GitHub's standard
  runners are free for public repos; a private repo would use paid minutes, so it is never used there. Event
  `task.train.remote_verify`.
- Chain tails (2.67.0, `harness/train-tail.mjs`, `STUDIO_TRAIN_CHAIN_TAIL`, default on; `off` keeps 2.66.0): when a
  train starts with a stacked chain (lanes linked by `--after` / `task block --until`) or a lane that declares
  `Pin-Moves:`, BEFORE its verify it builds main + the chain in a second scratch copy and runs the chain's touched test
  files there (the focused re-check machinery: the manifest gate's `focus` command, or a clear vitest/jest/`node --test`
  command) plus the pins' report on main and on the chain (the pin diff). Before rather than beside the verify: the
  verify holds a gate slot and the machine:heavy lock, so a second suite beside it would wait or double the load; the
  focused run is short and the tail task is on the board before the verify starts. Red (and not fixed by the pin
  refresh the train would make, tried in that copy): ONE builder bug task, P0, "Bug: chain tail for <lanes>: <tests>
  fail only on the combined chain", stacked on the chain's last lane (`--after`; that doesn't hold its start), its
  hand-off note (`studio/handoffs/<ID>.md`) naming the failing tests, the pin diff and the `git merge` lines that bring
  the chain into the copy. Never a second one for the same chain and failure signature (`.studio/train/chain-tails.json`).
  If the verify then fails on exactly those tests, the whole chain is deferred "waiting for its tail <ID>" (no
  bisection, nobody handed back; the other lanes go on), later trains leave it out before any verify, and once the
  tail is queued the chain and the tail land together. A red on any other test is handled as before. Event
  `task.train.chain_tail` (meta.action: opened, known, deferred, pin_refresh); `npm run lanes` notes each chain waiting
  for its tail. Only test files the chain touches are run early: a pin test in an untouched file shows up in the verify.
- Pins (2.60.0; the game declares them in its manifest, `docs/ONBOARDING-A-GAME.md`): when the red is only the game's
  pin tests, the pins' report runs on every prefix (main, main+A, ...) and each moved value is attributed to every
  lane whose step changed it. If each of those lanes declared the pin (`Pin-Moves: <pin>` trailer on its own commits)
  and no invariant pin moved, the refresh runs on the combined tree and ONE extra train commit lands with the lanes
  ("train <id>: pin refresh", trailers `Pin-Refresh: <lanes>` and a Golden-Reason, the moved values in its body),
  after a full verify of that tree. The before/after report, per pin and per prefix, is `.studio/train/<id>/pins.json`.
  An undeclared move or a moved invariant hands back the lane(s) it is attributed to; pins red on main itself are a
  regression on main (nobody handed back); a refresh that fails, changes nothing, is refused by the hooks or leaves
  the train red falls back to prefix bisection. All of this is code; no model decides it. Events `task.train.pins`,
  `.pin_refresh`, `.pin_refresh_red`.
- Union files (2.60.0): a conflict ONLY inside the manifest's `unionFiles` (one-import-per-line barrels, never an
  order-sensitive list) is merged with git's union driver for those files (both sides' added lines, the train's side
  first); the merge commit says `Union-Merge: <files>`. Any other conflict is handled as below.
- Main moved by board files only (2.60.1, B-29): if main moved while the train was verified and every file changed
  since is on the board/record list in `harness/train-board.json` (`studio/NEXT.md`, `studio/DONE.md`,
  `studio/task-types.json`, `studio/handoffs/**`, `studio/memory/**`, `studio/logs/**`, `studio/notes/**`; added or
  modified, never deleted or renamed), the train, under the land lock, merges its lanes again onto the new main and
  lands on the same verify, but only when that merge is clean and git shows the new tree is the verified tree plus
  exactly those files as main has them (event `task.train.board_move`; the `landed` event and the log say the verify
  was reused and which files moved). The train's copy never tests `studio/` from its tree (it is sparse-excluded and
  linked to the main checkout's), so these can't change what the verify saw. 2.67.0 (B-29): the task records listed
  under `"taskRecords"` there (`studio/task-holds.json`, which `task yes` and holds write, and
  `studio/pending-review.json`) count too, when every entry they change is for a task that is not a lane of this train;
  an entry of a train lane, another key or an entry without a task still means a new verify. Anything else (`studio/protected.json`,
  `studio/game.json`, gates, keys, approvals, code, goldens) or a train with a pin-refresh commit: built and verified
  again, as before.
- Conflict prediction at queue time (2.65.0, B-34, `harness/train-predict.mjs`): `task done <ID> --train` runs
  `git merge-tree --write-tree --name-only` (no index, no files touched) of the lane against main and against main +
  each lane already queued. A conflict with main refuses the queue, naming file:line ("merge main into the lane",
  or refresh the lane with the `lanes refresh` command). A conflict only with a queued lane queues it marked `after: <that task>`
  (`train status` shows it): the train leaves it out (no check, no verify; the `task.train.deferred` event once per
  reason) until that task has landed or left the queue. Conflicts only in the manifest's `unionFiles` count as none.
  Event `task.train.predicted_conflict`. Git older than 2.38, or `STUDIO_TRAIN_PREDICT=off`: no prediction (the
  queue says so) and the line-overlap warning stays the only hint.
- Dependencies (2.65.0, feedback 3.3, `harness/train-deps.mjs`): the train reads `--after` / `task block --until
  T-x` (`studio/task-holds.json`), which before only gated a start. A lane whose dependency is done, or queued in the
  same train, goes, and within a train lanes merge in dependency order; if that dependency drops out of the train,
  the lane leaves with it. A dependency still open and not in the train: the lane waits for a later train (says
  which). A dependency dropped from the board or not on it: the lane is handed back with a note (`npm run task --
  unblock <ID>` clears the dependency if the Producer decides so), never left waiting. Tasks the planner or a
  proposal adds keep their `--after` (addTask and `proposed promote` carry `meta.after`); nothing else writes tasks
  with dependencies.
- A lane that conflicts with the lanes before it waits for the next train; one that conflicts with main is handed
  back ("merge main into your copy"). A queued lane with uncommitted work waits; one whose claim moved to another
  agent leaves the queue; one that gained commits after its check lands as checked and stays queued.
- `npm run task -- done <ID>` in a lane copy with commits of its own is a one-lane train: main + the lane, verified
  (or the lane's own green verify of that tree reused), then main moves. Unlike the old path, a lane main has moved
  past is merged (not rebased) and main + lane gets a full verify before main moves (the old path re-checked only
  what main brought in). `STUDIO_TRAIN=off`, `--force`, or a copy with no commits of its own use the old path.
- One train at a time (`.studio/locks/train.lock`; `task done` waits up to `STUDIO_TRAIN_LOCK_WAIT_MIN`, 120, for a
  running one (before 2.63.0 this was `STUDIO_TRAIN_WAIT_MIN`, still read when the new name is unset); `task train`
  doesn't wait unless `--wait`). A stopped studio runs no train; drain on makes a train
  wait like a done. The verify takes gate slots as a landing. Events: `task.train.start`, `.queued`, `.verify`,
  `.red`, `.bisect`, `.dropped`, `.deferred`, `.moved`, `.landed`, `.partial`, `.red_main`, `.flaky`, `.pins`,
  `.pin_refresh`, `.pin_refresh_red`, `.tier`, `.held`, `.released`, `.waiting`, `.done`; 2.76.0: `.died`, `.trust_note`,
  `.lane_recreated`, `.mixed`.
- Lane copies made before 2.59.0 run their own older `harness/task.mjs`: `task done` there lands the old way, and a
  queued lane whose copy's harness predates the train is taken out of the queue with a note (merge main into it).
- Landing tiers (2.63.0, `harness/tiers.mjs`): every lane gets a tier from its own diff (merge-base with main ..
  its head) and its own commits' trailers, by code, never by a model's confidence. The tier and why are printed by
  `task done --train`, in the train log and in a `task.train.tier` event.
  - **C, needs the owner** (a closed lane, not a threshold): a protected file (`studio/protected.json` at main's tip
    plus the shipped list), `harness/`, `hub/`, `scripts/`, `qa/*.mjs`, a deleted test, golden or regression file, a
    file the game declares `irreversible`, an upgrade merge (`Upgrade-Ref:`); 2.71.1: a golden or snapshot the lane
    re-records with its own `Golden-Reason:` (rule `golden-rerecord`: a person, a delegation or autonomous review releases
    it; the game's manifest may set it to B; 2.73.0: the hold shows the harness's first-divergence report, the releaser
    can't be the lane's author, and without a report only a person releases it: docs/SECURITY.md), and a game's test toolchain (its test configs, the setup files they name,
    `.npmrc`, package.json's test scripts; docs/SECURITY.md). It is held in the queue
    (`task.train.held`, `task train status` says NEEDS THE OWNER) and lands only after
    `npm run task -- train release <ID> --by <name> [--permission "<their words or a link>"]`: a person in their own
    terminal, or a Producer/Director session or an agent outside the harness recording a person's direct permission
    (`harness/permission.mjs`); a worker never; with an owner key, only the owner's own terminal. The release is
    recorded (`task.train.released`, in the queue entry) for the lane's head at that moment: new commits need a new one.
  - **B, checks plus history**: the game's sim paths, goldens, declared pin moves or pin files, shared utilities, the
    registry/barrel, a changed test, any file no rule names. The train verifies with `--all`; a golden changed with no
    `Golden-Reason:` trailer, or a pin file (`pins.files`) with no `Pin-Moves:`, is handed back; a task handed back
    more than `STUDIO_TRAIN_MAX_HANDBACKS` (3) times is held for a person like tier C. 2.76.0: in beta mode
    (`npm run beta`, `harness/beta-mode.mjs`) it is held for the orchestrator and the Producer instead (`held.beta`; they
    release it with `train release <ID> --by <their name>`, no owner key, recorded as a beta use) and ONE Producer task
    "Rescue <ID>: handed back N times" is filed. Infrastructure hand-backs never count toward the cap: a missing lane
    copy, a CRLF/hash mismatch, a re-queue, a dead train, a timeout-only red re-run alone, a mixed lane
    (`harness/train-lanes.mjs` INFRA_HANDBACK, or `meta.infra`). A release is also kept by task and head
    (`.studio/train/releases.json`), so a lane that leaves the queue and is queued again at the same commit stays released.
  - 2.76.0 (W-0081): a queued lane whose copy folder (`.lanes/<name>`) is gone is made again from its branch
    (`task.train.lane_recreated`; links, `.env`, exclude file as a lane copy; the sparse checkout is the plain one) when the
    branch still holds the queued commit and no other worktree has it checked out; otherwise it leaves the queue as before.
  - 2.76.0 (B-91/B-92): a lane whose own commits (those main doesn't already have, by patch) carry another OPEN task's
    `Studio-Task:` trailer and not its own is refused before its verify (`task.train.mixed`): the hand-back names the
    commits and how to make a clean lane (a branch off main with only its own commits). `STUDIO_TRAIN_MIXED=off` skips
    the check.
  - A task held for landing (`npm run task -- hold <ID>`) stays out of every train (queued, riding along or its own
    `task done --train`): deferred with the hold's reason, `OUT (held)` in `npm run lanes`, `OUT OF TRAINS` in
    `task train status` (2.67.2). `npm run task -- train leave <ID> --by <name> --why "…"` takes a queued lane out of the
    queue on purpose (who may: as for `task hold`; recorded in `.studio/train/left.json` and `task.train.left`; `npm run
    lanes` shows `left (by …)`); `task done <ID> --train` queues it again.
  - **A, contained**: docs, added tests, the game's tools folders, assets, UI outside the sim paths. The normal verify.
  The rules are a table in `harness/tiers.mjs`; a game extends or changes them only through its protected manifest
  ("tiers", docs/ONBOARDING-A-GAME.md), and never lowers a tier-C rule.
- Batching (2.63.0): `task train` waits up to `STUDIO_TRAIN_WAIT_MIN` (10, from when the oldest lane was queued; poll
  `STUDIO_TRAIN_POLL_S`, 15) for `STUDIO_TRAIN_MIN` (1) lanes that aren't held, then runs with what is queued
  (`--now` skips the wait; `task.train.waiting`); never more than `STUDIO_TRAIN_MAX` lanes (0: no cap; `--max` too)
  and, since 2.77.0, never more than `STUDIO_TRAIN_BATCH` (default 4; `0`/`off`: no cap): the smallest cap wins.
  A lane the manifest marks "runAlone" (more than `maxFiles` files, or a file under its `paths`) gets a train of its
  own: the oldest lane decides, the rest wait and `task train` runs the next train right after (`trains` in its
  output). A lone `task done` in a lane copy takes the lanes already queued (not held, not run-alone) along in its
  one verify; only its own lane's result is its answer (a rider that fails is handed back as in any train).
  `STUDIO_TRAIN_RIDE_ALONG=off` turns that off.
- The train daemon (2.69.0, `harness/train-daemon.mjs`): while a supervisor runs (`STUDIO_TRAIN_AUTO`, default on),
  each pass starts a train on its own, in a detached child (`.studio/train/daemon.json`, its log `daemon.log`), when
  lanes are ready by the batching rules above (`STUDIO_TRAIN_MIN` lanes not held, or the oldest waited
  `STUDIO_TRAIN_WAIT_MIN`) AND the machine budget admits a verify claim (the machine:heavy admission below); never
  beside another train (the train lock) or its own last one, never while winding down, "Stop all" is on or drain is on
  (`npm run task -- drain on`; `task.train.auto_waiting` says why, once per reason). 2.73.1 (B-66): the supervisor's
  halt ("two sessions in a row ended with exit N") stops new sessions only, not trains: a lane already queued and
  verified still lands while the halt waits for a person. Only "Stop all", drain, a wind-down, `train auto off` and
  `studio:stop` (which ends the supervisor and with it the daemon) stop trains. After it, each handed-back lane whose task
  has no running session is made sure to be back on the board with the hand-back facts (only what is missing is
  added), and ONE `job.done` (kind train, `meta.auto`, `requeued`) sums it. `npm run task -- train auto off|on --by
  <name> [--why "…"]` switches it (a person, the owner's delegation, or a Producer/Director session or an outside agent
  on a person's `--permission`; never a worker); `npm run task -- train auto` shows it.
- A train that dies (2.76.0, B-88, `harness/train-life.mjs`): each train writes `.studio/train/<id>/life.json` (its pid,
  its lanes) and a heartbeat file (every 30 s, from a worker thread, so a train inside a 30-minute verify still beats).
  An exception in a step, an uncaught exception or unhandled rejection, Ctrl+C, a closed console (SIGINT/SIGHUP/SIGBREAK)
  or `process.exit` mid-train records `task.train.died` ("died: <last step>"), a `job.done` (result `died`) and the
  status `died` before the process ends. A SIGTERM or a kill (on Windows, a session's process tree ended by the
  launcher: nothing in the process runs) is found by the reaper, which runs before every train and in every train
  daemon pass: a train with no recorded end whose process is gone (or alive with a heartbeat older than
  `STUDIO_TRAIN_DEAD_MIN`, 30, minutes on two looks a minute apart: Windows reuses process ids) is recorded the same
  way, its train lock freed, and its lanes kept moving: a queued lane keeps its place, a `task done`'s own lane is
  queued again, a lane two trains died with at the same head is held for the Producer. None of it is a hand-back.
  A train from before 2.76.0 (a `status.json` only) is judged by the pid in its id when its status changed in the last
  24 h.
- The flake triager (2.69.0, `harness/flakes.mjs`): when a train's verify or re-check is red, each failing test file
  (at most `STUDIO_FLAKE_MAX_FILES`, 5; once per train) runs ALONE on the same tree, a focused run as a re-check:
  fails → `real`; passes and the file has a test-randomness finding (`harness/test-rng.mjs`) → `seed-flake`; passes,
  and again with one test worker → `load-flake`; passes then fails → `intermittent`. Labels go to
  `.studio/flakes.jsonl`; they never change what the train does. A test labelled flaky `STUDIO_FLAKE_QUARANTINE_AFTER`
  (3) times in `STUDIO_FLAKE_WINDOW_DAYS` (7) goes on `studio/quarantine.json` (`{ test, label, since, why, by,
  status, evidence, task }`) as PROPOSED, and ONE fix task is filed. The harness never silences a test on its own
  authority: a proposed entry still runs; the digest and `npm run flakes` list it until a person, an agent under the
  owner's delegation, or an outside agent (or a Producer/Director session) with `--permission` confirms it (`npm run
  flakes -- confirm <test> --by <name>`; never a worker). Then it is active and the game's runner skips it
  (`STUDIO_TEST_QUARANTINE`, docs/ONBOARDING-A-GAME.md). `"autoQuarantine": true` in `studio/quarantine.json` (then
  `{ "autoQuarantine": true, "tests": [...] }`) or in the game's `studio.gates.json` (the owner's or a game dev's
  choice) makes the harness's entries active at once, still recorded with evidence. A real failure is never
  quarantined. The list silences a check, so a lane changing it is tier C; a game dev releases an entry (`npm run
  flakes -- release <test> --by <name>`, same rules). Events: `test.quarantine_proposed`, `test.quarantined`
  (confirmed or automatic), `test.quarantine_released`. `STUDIO_FLAKE_TRIAGE=off` turns the triage off.
- Timeout-only reds (2.72.0, `harness/timeout-rerun.mjs`): in any game check (a verify, a train's verify or
  re-check, task done), a red whose ONLY failures are per-test timeouts (vitest "Test timed out in N ms", jest
  "Exceeded timeout of N ms", `node --test` `testTimeoutFailure` / "test timed out after", each in a named file, the
  runner's own failure count agreeing) re-runs just those files, each once ALONE at low load (one test worker), through
  the check's focus command. Every file green alone: the check counts green, each file labelled `timeout-flake` in
  `.studio/flakes.jsonl` (a `test.timeout_flake` event, the digest's flake line, `meta.timeoutFlakes` on `gates.run`,
  `timeout-flake in <check>: [...]` in the log) and counted toward quarantine like any flaky label; the lane is not
  blamed for it. A file red alone: a real red, naming only the red files. A mixed red (a timeout plus a real failure),
  output the harness can't read, or more files than `STUDIO_FLAKE_MAX_FILES`: a real red, as before. A file that was
  not re-run green never counts green. `STUDIO_TIMEOUT_RERUN=off` keeps 2.71.1's behaviour; the flake triager's own
  runs set it off (they want the raw answer).
- Sub-ids (2.72.0, `harness/gate-subids.mjs`): a failed gate names its parts: `game:<check>:<test file>` (paths
  relative to the checkout), `game:<check>` for a check that names no file, `golden:<file>` for a red golden,
  `<gate>:<file>` for another gate whose output names failing test files, else the gate id. They are in the run's
  rows (`sub`), the `gates.run` event (`meta.subIds`, beside the unchanged `meta.failed`), a `[gates] <id> failed in:`
  line, the train's `red` and `verify` events and the hand-back facts ("Failing sub-ids"). `subIdsOf(event)` reads
  them (falling back to `meta.failed` for older events).
- Held lanes (2.60.1, B-39): `npm run task -- hold <ID> --by <name> --why "…"` (a person, a Producer or Director
  session, or an agent outside the harness such as a merge conductor; workers are refused) marks a lane that waits to
  land on purpose, e.g. in a hand-built merge chain; `task unhold <ID> --by <name>` ends it. While a lane is held or
  queued for the train its claim clock (`STUDIO_TASK_MAX_MIN`) doesn't run, no rescue is filed or escalated for it,
  its rescue tasks can't start, and holding it lifts a budget park and closes its waiting rescues. When a task lands
  (task done, a train) its open rescues are closed with a note (event `task.rescue.closed`; one already claimed gets
  `task.rescue.obsolete`). A lane that is neither held nor queued is clocked and rescued as before.
- `studio/` in a lane copy is the main checkout's (a link, 2.60.1, B-40): only the board commands (`npm run task`,
  lock, proof ...) write there, and a lane's commits can never carry studio config. A config change (`studio/*.json`,
  `studio/bible/*.json`, keys, approvals, presets) goes to the owner or the Producer on main: hand the task back with
  a note naming it. A Claude Code hook (`.claude/hooks/lane-studio-guard.mjs`) refuses such an edit in a lane copy
  (`STUDIO_LANE_STUDIO_GUARD=off` turns it off), and task done in a lane warns, naming the files, when main's studio
  config changed uncommitted while the task was worked.
- Config proposals (2.65.0, B-40): the sanctioned route for a lane's studio config change. The lane commits
  `studio-proposals/<ID>.json`, `{ "changes": [ { "file": "studio/<name>.json", "set": { "<a.b or /a/b>": <value> } } ],
  "why": "…" }` (top-level `studio/*.json` only, not the board's records; keys are set, nothing is deleted). When the lane
  lands (the merge train, or the old one-lane `task done` with `STUDIO_TRAIN=off`), the harness applies it to main in the
  next commit (`Config-From: <ID>`, `Studio-Harness: config-from`; the hooks gate exempts exactly such a commit: only
  `studio/*.json` and `studio-proposals/`) and removes the file; the main checkout's files follow; event `config.applied`.
  A key main changed since the lane started (and not already to the proposed value) hands the lane back with a note naming
  the key and both values; a proposal that can't be read or names another file is handed back too. A proposal for a
  protected file (`studio/protected.json` at main's tip plus the shipped list) makes the lane tier C (rule
  `config-proposal-protected`; the hold names the keys and values): without an owner key the person's release is the
  decision and the protected part applies with it; with an owner key it applies only with the owner's signed approval of
  exactly that part (`npm run approve -- proposal <ID> --note "…"` on the owner's device, the approval committed to main).
  Otherwise that part is held: it stays on main in the proposal file (`"held"` says why), event `config.held` goes to a
  person, and `npm run task -- train config <ID> [--by <name>]` applies it once settled. Nothing is dropped silently. The
  train's verify can't see the config first (a train copy's studio/ is main's live folder); the next verify does.

### When a command is killed halfway (2.58.0)

- **Moving a task between NEXT.md and DONE.md** takes two writes. The file that gains the task is written first
  (DONE.md on `task done`, NEXT.md on `task reopen`), so a kill between them leaves the task in both files, never in
  neither. It still shows once: the move that was cut off counts as made (done stays done; a reopened task waits).
  Which way it was moving is noted in `.studio/board-move.json` during the write. A task in both files with no such
  note (a hand edit, a merge) counts as done; `task reopen` brings it back. `npm run watch` keeps one copy.
- **Claims nobody can be using** are released by `npm run watch`: a `task:` claim on a task that is done, waiting
  or gone from the board (a `task done` killed after its board write kept it, and heartbeats renewed it; a killed
  start or pause). Only once the claim and the board have both been quiet for `STUDIO_CLAIM_LEAK_GRACE_SEC` (60),
  never while a `task done` for it is running; logged as `lock.released`. `task reopen` also frees an old claim left
  on the task it reopens. `task start` releases its claim if anything goes wrong while it updates the board.
- **The watcher's own hand-backs** (a claim ran out, a session ended) go ahead only if the claim is still what the
  pass saw; an agent that re-claimed the task meanwhile keeps it.
- **Board locks** (`board.mutex` and the others) are never broken on age while their holder's process is alive on
  this machine (a console paused by a click, a sleeping laptop): others wait, or give up after 15 s with "run the
  command again". A dead holder's lock is broken at once; one held by another machine after 10 s; a live holder's
  only after 10 min (`STUDIO_STATE_LOCK_LIVE_MAX_MS`: by then the pid most likely belongs to another program). A
  holder whose lock was broken anyway stops before writing (`ELOCKLOST`).
- **Temp files** a killed write left (`.<name>.<pid>-….tmp`) are removed from `studio/` and `.studio/` by
  `npm run watch` once older than `STUDIO_TEMP_SWEEP_MIN` (5).
- **Lines the board can't read** are never dropped. A task line with an ASCII `-` instead of `—`, or a role without
  backticks, is read as a task and rewritten in the board's format. Anything else (another format, a note, the same
  id twice) is moved under `## UNREADABLE (kept by the harness: fix the format)` at the end of the file, with one
  warning and a `board.unreadable` event; fix the line there (it then counts as waiting work) or delete it.
- **Folder claims** are compared without regard to case: `path:game/Branding` and `path:game/branding` are one
  claim (on Windows they are one folder).
- A state file written in place because another program kept it open (Windows) leaves a `fsafe.warning` event.
- The land lock (`.studio/locks/land.lock`, taken for a landing's fast-forward and board write) treats Windows'
  EPERM/EACCES/EBUSY while it is created or removed as busy and retries, instead of crashing the command.

## Pipelined trains (2.77.0, P9.6)

A full verify takes about 25 minutes on a busy PC, so lanes waited in line. Two trains verifying side by side would
each verify against a main that is about to move, so the trains are pipelined instead (`harness/train-pipeline.mjs`):

- While train A verifies, at most ONE speculative train B takes the next ready lanes (up to `STUDIO_TRAIN_BATCH`) and
  verifies **A's tree + its lanes** in its own scratch copy, under its own lock (`.studio/locks/train-next.lock`), as a
  detached child (`node harness/train-daemon.mjs run-next <A>`, output in `.studio/train/next.log`). A starts it right
  before its verify; the train daemon's pass also starts it while A verifies (`task.train.next_started`).
- When A ends: main is exactly A's verified tree (A landed it), or that tree plus record files only (the B-29 board and
  record rule; `nextBaseVerdict` in `harness/train.mjs` is the one check): B lands right after A, under the train lock
  (never two trains landing at once; main moves by compare-and-swap from the tree B built on), **without verifying
  again**. Anything else (A red, re-checking or bisecting, rebuilt on a moved main, held, ending without landing, main
  moved by anything but records) discards B: `task.train.next_discarded` says why, its lanes keep their place in the
  queue (no hand-back, nothing counted toward `STUDIO_TRAIN_MAX_HANDBACKS`) and go in the next normal train, which B's
  process runs when the train daemon is on. A red B verify only discards B; the normal train bisects.
- B is conservative: it never holds, hands back or bisects. A lane held for the owner or out of trains, tier C not
  released, missing a Golden-Reason or Pin-Moves, over the hand-back cap, waiting on `--after` or a chain tail, refused
  by its precheck, conflicting on A's tree, or run-alone behind other lanes is left for the next normal train, which
  applies the rules as before; a fix-first lane (B-75) means no B at all. A run-alone lane first in line is B on its own.
- `STUDIO_TRAIN_PIPELINE`: unset (auto) starts B only when the machine budget has room for a second train verify beside
  A's (the machine:heavy admission; no machine scan: no room, trains wait as before); `on` starts it whenever lanes are
  queued (its verify still waits for its own machine:heavy claim); `off` never. Drain, "Stop all" and a halt stop it.
- A train that would start while a B can land (its A ended, main is the tree B built on) gives the train lock back and
  waits for it (`task train` without `--wait` says so and lands nothing; the daemon doesn't start one).
- Status: `npm run task -- train status` prints `Running: train <A> ...` and `Next: train <B> ... speculative on train
  <A>'s tree`; `studio:status` prints the same two lines; `npm run lanes` and `status --brief` add `; next: ...`.
  `readTrainStatus()` (harness/train-status.mjs) keeps its fields (train, step, text, eta, lanes, round, by, since) and
  adds `next` (the speculative train's own status: train, step, text, eta, lanes, after, base, tasks, speculative: true;
  null when none); every status write also refreshes `.studio/train/status.json`, a snapshot of it. The War Room's web
  train adds `next` ({ id, step, text, after, base, lanes, laneCount, eta } or null). B has its own life record
  (B-88): a dead B is found by the reaper and its `train-next.lock` freed.

## Less repeated work in the merge train (2.69.0)

- **A lane's green verify stands for a train of one.** When a train holds ONE lane and its integration tree is the tree
  that lane's verify tested (green, full, clean, same rules as task done's reuse), the train doesn't verify again; the
  log says `reused <lane>'s green verify of tree <x>`. A clean full verify is now also kept by tree
  (`.studio/gates/trees/<tree>.json`, the newest 64), so the agent's next verify no longer hides it; a lane copy whose
  `.studio/` is its own (not the link) is searched too.
- **Prechecked lanes first.** In a multi-lane train, a lane whose own tree on main's tip (merge-tree of tip and its head)
  has a green recorded verify goes first (`prechecked first: ...` in the log; the rest keep their order, `--after`
  order still wins). `STUDIO_TRAIN_GREEN_FIRST=off` keeps queue order.
- **Related tests first on the combined tree.** Before the full verify of a multi-lane train, each lane's related tests
  (the game's `related` command on the lane's own changed files, the same machinery as `STUDIO_GATE_RELATED`, with
  `STUDIO_GATE_RELATED_ONLY=on` so checks without one don't run) run on the combined tree in the scratch copy. A lane
  red there whose failing tests pass on main's tip is handed back at once, with the failing tests, the log and the
  facts block: no full verify, no bisection. Red on main's tip too: nobody is dropped, the full verify decides.
  `STUDIO_TRAIN_RELATED_FIRST=on|off`; unset, it is on when the game's manifest declares a `related` command.
- **The slow tier.** Checks and test globs the game marks slow (docs/ONBOARDING-A-GAME.md, "The slow tier") are left
  out of verifies and trains; `npm run gates -- --tier slow` runs only them on main, and the supervisor starts it once a
  day at `STUDIO_SLOW_HOUR` (local hour, default 3; `off` never). One bug task per new failure (deduped by check and
  test while its task is open; at most `STUDIO_SLOW_MAX_TASKS`, 10, per run). Landing never waits for it.

## Heavy work shares the machine by budget (2.68.0)

Full verifies, Unity editor runs, browser playtests, Blender previews and asset round trips take the `machine:heavy`
lock (`harness/heavy.mjs`). It is a budgeted pool now (`harness/heavy-budget.mjs`): each job declares a claim and
starts when the claim fits what the last machine scan (`.studio/machine.json`, from the machine scan or the
supervisor's monitor) says is free. Default claims: game verify 1 GB + 0.45 GB per test worker; Unity editor 8 GB
and 2 GB VRAM; browser playtest 5 GB and 1 GB VRAM; Blender preview 2 GB and 1 GB VRAM (GPU only); asset round trip
1 GB; anything else wrapped with `node harness/heavy.mjs run` 4 GB (`--kind <kind>`, `--ram-gb`, `--vram-gb`,
`--gpu-only` change it). `studio/machine-budget.json` overrides them: `{ "jobs": { "unity": { "ramGb": 10 } } }`.

- **RAM**: the scan's free memory (commit headroom on Windows) less `STUDIO_RESERVE_RAM_GB` (default 4 GB or 10% of
  RAM, whichever is more) and the claims of jobs started since the scan. **GPU**: the largest GPU's free VRAM less
  `STUDIO_GPU_RESERVE_GB` (2.5 when it drives the display). **CPU**: claimed threads stay within
  `STUDIO_CPU_OVERCOMMIT` (1.5) times the cores. **Slots**: at most `STUDIO_HEAVY_SLOTS` jobs (default computed from
  the scan, 1 to 6). A GPU-only job takes no slot or CPU share, so it runs beside a verify (2.70.0: the GPU area
  below).
- **Per kind**: at most one Unity editor run and one browser playtest at a time, whatever the slots (others: no cap
  within the budget). `studio/machine-budget.json` `"maxConcurrent": { "unity": 2 }` or `STUDIO_HEAVY_MAX_<KIND>`
  (`STUDIO_HEAVY_MAX_UNITY`, `STUDIO_HEAVY_MAX_BROWSER_PLAYTEST`; `0` or `off`: no cap) changes it. A job at its cap
  waits: `waiting: 1 unity job already running (max 1)`.
- A job that doesn't fit waits in a queue (a landing first, then first come) and says why: `waiting for RAM: needs
  8 GB, 3.1 free`. It waits up to `STUDIO_HEAVY_WAIT_MIN` like any wait; a claim bigger than the whole budget runs
  alone. `node harness/heavy.mjs status` shows the budget and each holder's claim.
- No scan, a scan older than `STUDIO_MACHINE_MAX_AGE_MIN` (15), or `STUDIO_MACHINE_SCAN=off`: one slot and the
  `STUDIO_RAM_FLOOR_GB` floor, as in 2.67.
- A job killed for memory (Windows 0xC0000017, Node's "JavaScript heap out of memory", exit 137 elsewhere) is queued
  once more with a note instead of counting red (`heavy run`, game checks, the Unity land gate, the asset round trip;
  `STUDIO_HEAVY_OOM_RETRY=off` turns it off). A second one counts.
- 2.73.2: a Unity job also waits for live free RAM of at least `STUDIO_UNITY_MIN_FREE_GB` (12, never above 60% of the
  RAM). A wait that runs out is "not run" (exit 3), never red. For a studio's own scripts: `npm run heavy -- wait
  [--min-free-gb N] [--timeout-min M] [--hold <label>]`, `npm run heavy -- release --label <label>`, and `heavy run
  --min-free-gb N --timeout-min M -- <command>` (docs/UNITY-TRACK.md).
- Game checks get `STUDIO_TEST_WORKERS` and `VITEST_MAX_WORKERS`: free RAM for the job / `STUDIO_TEST_WORKER_GB`
  (0.45), between 2 and cores - 2. Inside a verify that is the verify's claim; a lane's check shares the free budget
  with the other lane checks running. `STUDIO_TEST_WORKERS` sets it; 2 with no scan. The game's test config reads it
  (docs/ONBOARDING-A-GAME.md). 2.73.2: a vitest/jest/`node --test` check also gets its per-test timeout scaled for that
  many workers (ceil(4 x workers / cores), 1..4; `STUDIO_TEST_TIMEOUT_SCALE`; ONBOARDING-A-GAME.md, "Per-test timeouts
  that fit the workers").
- 2.76.0 (B-89): the cores are shared too. A job that sizes its test workers (a full verify, a lane check, a soak) gets
  its share of the logical cores beside what runs: weight 4 for the merge train's verify, 2 for a builder's verify or
  lane check, 1 for a soak (studio/machine-budget.json `"priority"` overrides); Unity, Blender, asset and playtest jobs
  take the threads they claim off the top. While a train holds its lock, or lanes wait in its queue and the supervisor
  runs, its verify counts as coming, so a builder's verify leaves it room (`STUDIO_TRAIN_RESERVE=off`: not). Workers =
  the smallest of that share, the RAM figure and the CPU headroom (`STUDIO_CPU_OVERCOMMIT` x cores - the others'
  threads), 2..cores - 2.
  The gate's line and the check's row (`testWorkers`: workers, share, why, machineWorkers) say which and why; the
  per-test timeout reads every check's workers on the machine (machineWorkers), so a smaller share never shortens it.
  `STUDIO_TEST_WORKERS` still wins; `STUDIO_RIG_SHARE=off` sizes by RAM only (2.75). `node harness/rig-budget.mjs
  [--json]` (rigBudget()) lists what runs (kind, workers, RAM, start, ETA) and what each kind would get now.
- The supervisor starts at most (RAM - reserve - heavy claims) / `STUDIO_SESSION_RAM_GB` (0.6) agent sessions, and
  says so when that holds one back. Tests stub the scan with `STUDIO_TEST_MACHINE` (a profile as JSON, a path, or
  `none`).

### The GPU area for jobs (2.70.0)

The PC's GPU sat at 1-7% while CPU verifies queued, because browser playtests, Blender and Unity graphics runs all
waited for the one heavy slot. When the machine scan shows a GPU, jobs that are mostly GPU work claim **VRAM plus a
small RAM and CPU share** instead of a slot, so they start beside a CPU verify when VRAM and RAM allow:

| Kind | GPU-area claim (RAM / CPU threads / VRAM) | When |
|---|---|---|
| `browser-playtest`, `gpu-playtest` | 5 / 1 / 1 GB, 2 / 1 / 1 GB | only with browser GPU flags on (`STUDIO_BROWSER_GPU`, docs/BROWSER-PLAY.md); off, the browser renders on the CPU and keeps its slot |
| `blender-preview`, `asset-roundtrip` | 2 / 1 / 1 GB, 1 / 1 / 0.5 GB | the harness's own Blender jobs |
| `unity-bake`, `unity-visual` | 8 / 2 / 4 GB, 8 / 2 / 2 GB | a Unity lightmap bake, a Unity graphics test run (callers pass the kind) |
| `build-clip` | 3 / 1 / 0.5 GB | the playable build + clip after a landing (below), with browser GPU flags on |

- No GPU in the scan, no scan, or `STUDIO_GPU_AREA=off`: the 2.69 claims exactly (a slot). `studio/machine-budget.json`
  `"gpuJobs": { "<kind>": { "ramGb", "cpuThreads", "vramGb" } }` changes a GPU-area claim; `"jobs"` still sets the slot claim.
- Per-kind caps stay and count by group: every Unity kind is one `unity` (one editor), the harness's Blender jobs are one
  `blender` (one at a time, `STUDIO_HEAVY_MAX_BLENDER`), the landing clip counts as a `browser-playtest`. A Blender
  someone opened by hand is never counted, closed or taken over.
- Each such job logs one line: `[heavy] asset round trip took the GPU area: mostly GPU work and the scan shows <GPU>`,
  or `took a machine:heavy slot: no GPU in the machine scan`. `node harness/heavy.mjs status` marks GPU-area holders.
- **Blender** (`harness/blender-job.mjs`): the asset round trip claims by its program (Blender: `asset-roundtrip`;
  a Unity batchmode command: `unity`) and a Blender command gets `-t <n>` render threads unless it sets its own:
  `STUDIO_BLENDER_THREADS`, else logical cores / 3 from the scan (1 to 8); never 0 (Blender's 0 is every core).
  UNVERIFIED with a real Blender: tests use a stub.

### A playable build and a clip after each landing (2.70.0)

After a merge train lands (task done's train and the train daemon's), the train queues ONE low-priority `build-clip`
job (`harness/landing-build.mjs`) and goes on: a detached worker at below-normal priority saves the landed main as a
playable build (`npm run play`, docs/ARCADE.md) and records a short clip (`qa/clip.mjs`), then records `build.snapshot`
and `clip.recorded` events with the landed tasks. `npm run status -- --brief` and the daily digest show the latest
("Playable build <id> (T-1, T-2); clip <file>"). At most one is queued: a newer landing replaces a queued one (its
tasks added). Skipped when the game has no browser build (`browser.page` / `browser.dist` in its qa.mjs) or is the
template, and with `STUDIO_LANDING_BUILD=off`. `STUDIO_LANDING_CLIP_SECONDS` (15), `STUDIO_LANDING_CLIP_CMD` (the
clip command, `{seconds}` and `{name}` placeholders), `STUDIO_LANDING_CLIP_TIMEOUT_MIN` (10);
`STUDIO_LANDING_BUILD_WORKER=off` queues without starting the worker. `node harness/landing-build.mjs status` shows
what is queued or running.

## Summary Format (`studio/done/YYYY-MM-DD-short-title.md`)

```markdown
# YYYY-MM-DD — Short Title

- **Role:** Builder / QA-Playtester / Designer-Calibrator / Reviewer
- **Task ID:** T-XXX
- **What was done:**
- **Files changed:**
- **Result / verification:** (`node scripts/check-sim-isolation.mjs` + `node qa/playtest.mjs`)
- **Follow-ups:** (or "none")
```

## Rules

- Never leave the only record of work in the chat.
- Keep `studio/CURRENT_TASK.md` short and current.
- Prefer appending to `studio/NEXT.md` (`node harness/task.mjs add "..."`) over creating scattered tracking files.
- The Producer role is responsible for keeping `studio/CURRENT_TASK.md` and `studio/NEXT.md` accurate.
