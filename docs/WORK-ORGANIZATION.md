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
  handed back. Otherwise the lane that turns the first prefix red is handed back (back in the queue, its claim freed,
  a hand-back note with the failing checks, the prefix and the log), whether it fails alone or only together with
  the lanes before it (an interaction culprit); the rest train again with one more full verify. When only the
  whole train is red, that red is re-run before anyone is blamed; if it passes, nobody is handed back and the lanes
  wait (event `task.train.flaky`). A check already red when every task in the train was claimed (its baseline)
  doesn't count, as at task done. `STUDIO_TRAIN_BISECT=alone` keeps the 2.59 way: each lane verified alone on main,
  one that fails alone handed back, lanes that pass alone but fail together: the last one waits.
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
  linked to the main checkout's), so these can't change what the verify saw. Anything else (`studio/protected.json`,
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
  `.pin_refresh`, `.pin_refresh_red`, `.tier`, `.held`, `.released`, `.waiting`, `.done`.
- Lane copies made before 2.59.0 run their own older `harness/task.mjs`: `task done` there lands the old way, and a
  queued lane whose copy's harness predates the train is taken out of the queue with a note (merge main into it).
- Landing tiers (2.63.0, `harness/tiers.mjs`): every lane gets a tier from its own diff (merge-base with main ..
  its head) and its own commits' trailers, by code, never by a model's confidence. The tier and why are printed by
  `task done --train`, in the train log and in a `task.train.tier` event.
  - **C, needs the owner** (a closed lane, not a threshold): a protected file (`studio/protected.json` at main's tip
    plus the shipped list), `harness/`, `hub/`, `scripts/`, `qa/*.mjs`, a deleted test, golden or regression file, a
    file the game declares `irreversible`, an upgrade merge (`Upgrade-Ref:`). It is held in the queue
    (`task.train.held`, `task train status` says NEEDS THE OWNER) and lands only after
    `npm run task -- train release <ID> --by <name> [--permission "<their words or a link>"]`: a person in their own
    terminal, or a Producer/Director session or an agent outside the harness recording a person's direct permission
    (`harness/permission.mjs`); a worker never; with an owner key, only the owner's own terminal. The release is
    recorded (`task.train.released`, in the queue entry) for the lane's head at that moment: new commits need a new one.
  - **B, checks plus history**: the game's sim paths, goldens, declared pin moves or pin files, shared utilities, the
    registry/barrel, a changed test, any file no rule names. The train verifies with `--all`; a golden changed with no
    `Golden-Reason:` trailer, or a pin file (`pins.files`) with no `Pin-Moves:`, is handed back; a task handed back
    more than `STUDIO_TRAIN_MAX_HANDBACKS` (3) times is held for a person like tier C.
  - **A, contained**: docs, added tests, the game's tools folders, assets, UI outside the sim paths. The normal verify.
  The rules are a table in `harness/tiers.mjs`; a game extends or changes them only through its protected manifest
  ("tiers", docs/ONBOARDING-A-GAME.md), and never lowers a tier-C rule.
- Batching (2.63.0): `task train` waits up to `STUDIO_TRAIN_WAIT_MIN` (10, from when the oldest lane was queued; poll
  `STUDIO_TRAIN_POLL_S`, 15) for `STUDIO_TRAIN_MIN` (1) lanes that aren't held, then runs with what is queued
  (`--now` skips the wait; `task.train.waiting`); never more than `STUDIO_TRAIN_MAX` lanes (0: no cap; `--max` too).
  A lane the manifest marks "runAlone" (more than `maxFiles` files, or a file under its `paths`) gets a train of its
  own: the oldest lane decides, the rest wait and `task train` runs the next train right after (`trains` in its
  output). A lone `task done` in a lane copy takes the lanes already queued (not held, not run-alone) along in its
  one verify; only its own lane's result is its answer (a rider that fails is handed back as in any train).
  `STUDIO_TRAIN_RIDE_ALONG=off` turns that off.
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
  config changed uncommitted while the task was worked. Planned (2.64): a config proposal file in the lane that the
  train applies to main's studio/ in the same landing.

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
