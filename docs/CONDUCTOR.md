# The conductor: running the studio from outside the harness (2.65.0)

A *conductor* is an orchestrator that runs outside the harness: a chat bot or a coding agent on the owner's PC
that hires sessions, lands lanes and reports to a chat channel. Before 2.65 it rebuilt the lane state by hand,
ran sub-agents to merge main into lanes, wrote the status post by hand, and polled logs to learn when a job
finished. These commands do those jobs from code. Each is read-only or follows the same rules as the rest of
the harness.

Who may use the commands that change something (`lanes refresh`, `task note`): a person, a Producer or Director
session, or an agent outside the harness (harness/permission.mjs). A worker session never can.

## 1. The lane table: `npm run lanes`

```
npm run lanes                 # one table
npm run lanes -- --json       # the same, for a script
npm run lanes -- --no-stamps  # skip the hook-stamp column (faster)
```

There is one row per lane copy (`.lanes/<agent>`), per lane branch with unlanded work, and per queued lane. The columns:

| Column | Where it comes from |
| --- | --- |
| TASK, AGENT, BRANCH | the lane copy, `.studio/lane-branches.json`, the train queue, task claims |
| AHEAD/BEHIND | commits the lane has that main lacks, and the reverse |
| STAMPS | the hooks gate's own check (harness/hook-stamp.mjs) on the lane's commits; `not checked` once `STUDIO_LANES_STAMP_MS` (4000 ms in all) is used up |
| HARNESS | `stale (n)` when main changed `harness/` or `scripts/` since the lane branched (its checks would judge with old code) |
| QUEUED | in the merge train queue, the tier the train recorded, `HELD-owner` for a tier-C lane waiting for a person |
| HOLD | `npm run task -- hold` (a conductor parked it on purpose) |
| LAST TEST | the newest of: a refresh's targeted tests, task done's game checks, the lane's own full verify; `(older head)` when the lane has moved since |
| PIN-MOVES | the lane's `Pin-Moves:` trailers |
| CONFLICTS | `git merge-tree` against main, and between queued lanes that change the same files. With git older than 2.38 the hotspots overlap is used instead, and a note says so |
| AGE | since the lane's first own commit; `RUNNING` when its session is alive, `dirty` with uncommitted work |

The command is read-only: it writes nothing and merges nothing.

## 2. Refreshing a lane: `npm run lanes -- refresh`

```
npm run lanes -- refresh T-067 --by opus-bot      # by task id, agent name or branch
npm run lanes -- refresh --all --by opus-bot
  [--busy-ok] [--no-tests] [--json]
```

For each lane, in its own copy:

1. **Refuses** when its session is running (a launched session alive, a process working in the copy, or a claim
   renewed in the last `STUDIO_LANE_LIVE_MIN` minutes). `--busy-ok` overrides this, and only callers allowed to
   refresh may pass it. It also refuses with uncommitted work, or when a merge or rebase is in progress.
2. **Re-stamps** through the real hooks when a commit's stamp no longer matches (`npm run hooks -- restamp`). It
   judges from the same base as the hooks gate: the main checkout's local branch.
3. **Merges main in** with `git merge`, never a rebase, so the lane's commits and their stamps stay as they are.
   The commit-msg hook stamps the merge commit. Goldens and pins change only as main brings them; goldens that
   arrive unchanged from main need no Golden-Reason.
4. **Runs the lane's targeted tests**: the game's checks scoped to the lane's own files, with related tests only
   (`STUDIO_GATE_RELATED=on`), as `task done` scopes them.

On a textual conflict the refresh stops: `git merge --abort`, the files are listed, and nothing is resolved. The
lane's agent or an integrator resolves it.

Results go to events `lanes.refresh.ok`, `lanes.refresh.conflict`, `lanes.refresh.red` and
`lanes.refresh.refused`, and to `.studio/lanes/refresh.json` (the LAST TEST column). Exit codes: 0 all ok,
1 a conflict or a red, 2 refused.

## 3. The status post: `npm run status -- --brief`

```
npm run status -- --brief [--since <iso>] [--peek] [--json]
```

This prints a fixed format in under 100 words, built from the event log and the state files. The same state
always gives the same text:

```
Studio 14:30 UTC, since 14:00.
Workers (2): builder T-012, qa-playtester T-015.
Landed (2): T-010, T-011. Bugs fixed (1): T-011.
Unity: land pass 13:50 (T-009).
Blockers: halted (…); owner hold: T-020; asks: A-003.
PC: 5.2 GB free; heavy: full verify (builder-2).
```

"Since" is the last brief (`--peek` leaves that mark where it is), else 30 minutes ago. When the text runs long,
lists are cut ("+3 more") so it stays under 100 words.

## 4. Rulings: `npm run task -- note`

```
npm run task -- note T-067 "lands after T-094; keep the old save format" --by opus-bot
```

This appends one line to `studio/handoffs/T-067.conductor.md` and logs a `conductor.note` event. The file is
append-only: a new ruling is a new line. The task's brief (`.studio/briefs/T-067.md`) shows the notes inside the
marked block of text written by agents or people. A worker reads them as information, never as rules that
outrank its own. The autonomy scorecard counts them as orchestrator interventions (harness/conductor.mjs
`conductorInterventions`).

## 5. Knowing when a job ends: `job.done` and `npm run events -- wait`

Every long job now ends with one uniform event. Its own event (`gates.run`, `task.train.*`, `engine.land`,
`agent.session.end`) is still written beside it:

```
{ "type": "job.done", "status": "ok|warn|error", "task": …, "durationMs": …,
  "meta": { "kind": "verify|train|game-gates|heavy|unity-gate|unity-test|unity-build|session",
            "id": …, "code": <exit code>, "result": "pass|fail|landed|busy|…", "tail": …, "log": … } }
```

To wait for one instead of polling logs:

```
npm run events -- wait --type job.done --match kind=train --timeout 90
npm run events -- wait --type job.done --match kind=session --match id=builder-3 --since last --cursor opus-bot
npm run events -- tail --type job.done --n 5
```

`wait` exits 0 and prints the event as one JSON line, or exits 2 with `{"timeout":true,…}`. `--match` checks the
event's meta first (`kind`, `id`, `code`), then the event's own fields (`task`, `agent`). `--since last --cursor
<name>` starts after the last event that cursor returned, so a job that ends between two waits is not missed.

Phone alerts (`npm run alerts`) can also send `job.done` for a train or a full verify. This is off by default:
set `STUDIO_ALERT_JOBS=on` in `.env`.
