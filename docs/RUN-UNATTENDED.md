# Running the studio unattended (`docs/RUN-UNATTENDED.md`)

The supervisor keeps the studio working without a person: every minute it starts a fresh agent for the next waiting task of
each role (one task per session, within the pace's caps) and starts the next when a session ends. It starts nothing while
"Stop all agents" is on, outside the window, past `--until`, or past the budget. This page is its commands, guards and
settings. A tag such as (2.73.1) says which release added a feature. An agent needs a tool to start with:
`STUDIO_AGENT_TOOL` (and `STUDIO_AGENT_MODEL`) in `.env`, per role `STUDIO_BUILDER_TOOL`, `STUDIO_ART_TOOL`, ..., or
`STUDIO_<ROLE>_CMD` with `{kickoff}`, `{agent}`, `{model}`, `{role}`, `{task}`.

## Start, stop, change

After a restart, one command brings the studio up (2.73.1):

```bash
npm run studio:boot                    # Windows PowerShell: npm.cmd run studio:boot
npm run studio:boot -- --check         # report only: nothing is cleared or started
npm run studio:boot -- --until 46h     # --until, --window, --budget, --lanes go to the supervisor it starts
npm run studio:boot -- --shortcut      # also put a "Studio boot" file on the Desktop (Windows: a .cmd running npm.cmd)
```

It checks node, npm (on Windows it says to type `npm.cmd` when the policy blocks `npm.ps1`) and `.env` (no session identity
in it); clears lock and status files whose process is gone (`train.lock`, `land.lock`, `unity-train.lock`,
`verify-running/full.json`, `train/daemon.json`, a "running" `supervisor.json`; one `boot.stale_cleared` event each; never a
lane copy or anyone's work); starts the supervisor if it isn't running, detached and hidden, output in `.studio/logs/` (the
train daemon runs inside the supervisor's pass); then prints one card (crew sessions, train, halts, what needs you, outside
agents, lane copies in `.lanes/`). There is no hub to start (2.80): `--hub`/`--no-hub` are ignored with one line. Chat
orchestrators outside the harness are not restarted. The supervisor never gets the shell's `STUDIO_LOCK_OWNER`,
`STUDIO_ROLE`, `STUDIO_AGENT` or `STUDIO_MAIN_ROOT`.

```bash
npm run studio:start -- --until 23:00                 # (or --until 8h); detaches by default and outlives the terminal; output in .studio/supervisor.log
npm run studio:start -- --until 23:00 --foreground    # stays attached to this terminal
npm run studio:start -- --window 09:00-23:00          # every day inside a window
npm run studio:start -- --until 8h --budget 50%       # stop when the plan reaches 50% of its week
npm run studio:start -- --until 8h --lanes auto       # one builder per lane, in parallel
npm run studio:start -- --install --window 09:00-23:00   # come back after a restart or login (--uninstall removes it)
npm run studio:stop                                   # agents finish their task; nothing new starts
npm run studio:status
```

- **After a harness update** (2.86): the supervisor checks each pass whether the installed harness (package.json version and
  the `harness/` tree at HEAD) is still the one it started with. When it isn't, it logs `harness.code_changed` once and, at
  a quiet point between passes, hands over to a fresh supervisor with the same options (its halt, extended end time and
  back-offs carry over; agent sessions and trains keep running untouched); under launchd or a systemd unit installed by
  2.86 or later it exits and the service manager starts it again. In a terminal you watch, or with
  `STUDIO_SUPERVISOR_SELF_RESTART=off`, it only warns (once, plus a line in the daily digest, `npm run studio:status` and
  `npm run harness-health`): restart it yourself. A `node harness/watch.mjs --loop` watcher warns the same way.
- `--install` uses launchd (macOS), systemd --user (Linux) or Task Scheduler (Windows). Install from a terminal where the
  agent tool works: the login job gets that terminal's PATH and HOME, and install warns when `claude --version` (or your
  tool) wouldn't be found.
- `studio:start` is you choosing to run the studio, so it starts agents whatever `npm run mode -- autostart` says; that
  switch is for the watcher's and supervisor passes' own starts (docs/PACE-AND-AGENTS.md).
- **Change the end time** (2.73.1): `npm run studio:extend -- --until <23:00 | +8h | ISO time | none> --by <your name>
  [--why "…"]` (`+8h`/`8h` count from now; `none` removes it) writes `.studio/supervisor-extend.json`; the next pass (within a
  minute) applies it and logs `supervisor.extended` (from, to, who). Who may: a person; an agent under the owner's
  delegation for `supervisor-extend`; a Producer/Director session or outside agent on a person's direct permission
  (`--by <the person> --permission "<their words or a link>"`); never a worker session or a worker's name.
- **Change `.env` while it runs** (2.73.2): the long-running loops re-read `.env` when its mtime or size changed (each
  supervisor pass with the train daemon's pass, each launcher heartbeat, the watchdog's and the watch pass), so a raised
  `STUDIO_STALL_MIN` reaches running sessions at their next heartbeat. `npm run studio:reload-env -- --by <your name>` asks
  for a reload now: a running supervisor answers within seconds with what changed; if busy it waits one pass
  (`STUDIO_SUPERVISOR_SEC` plus 10 s) and says "Queued: the supervisor reloads on its next pass" (exit 0); with no
  supervisor it exits 0 and says the settings apply at start. Each change is logged once (`env.reloaded`, key names only;
  values of keys that look secret (`*_TOKEN`, `*_KEY`, `*_SECRET`, `*PASSWORD*`, webhooks) are never written). 2.84: a name
  the harness no longer reads is named again after the list with the closest current name, or "none is close". It also lists
  the `STUDIO_*` names `.env` sets and marks those the harness no longer reads (not in `docs/SETTINGS.md`) "unknown (removed
  or misspelled)" (2.79).
  - Precedence: a variable in the environment a process was started with (your shell, a scheduled task) wins over `.env`; a
    value that came from `.env`, directly or through its parent (`STUDIO_ENV_FROM_FILE` is the internal note of which
    names, never values), follows the file; a line removed from `.env` gives the default back. Identity settings
    (`STUDIO_LOCK_OWNER`, `STUDIO_ROLE`, `STUDIO_AGENT`, `STUDIO_MAIN_ROOT`) are never taken from `.env`. Read once at start,
    so a restart is needed for `STUDIO_SUPERVISOR_SEC` and `STUDIO_HEARTBEAT_SEC`.

## What a pass does

- A pass never stops the loop (2.77.1): passes never overlap, and each step (Line Producer, launch step, Director's flow,
  machine scan, Communicator, workaround pass, train daemon) is bounded. A step running past
  `STUDIO_SUPERVISOR_STEP_SEC` (300; the launch step twice that) is reported as `supervisor.step_timeout` and the pass
  goes on without it. A pass running past `STUDIO_SUPERVISOR_STUCK_MIN` (15) is reported once as `supervisor.pass_stuck`.
  `.studio/supervisor.json` counts finished `passes` and keeps each timed group's last run (`timed`).
- Timed groups (2.80, `harness/studio-passes.mjs`): every `STUDIO_WATCH_INTERVAL` seconds (300) the watch pass, the retro,
  the learn pass, the run report and the Director's daily ping (0 turns off the watch pass only; the others are then checked
  every 300 s, 2.81); every `STUDIO_GAMEDEV_INTERVAL` seconds (180; 0 off) the game-dev watchdog pass. Each group first
  runs one full interval after the supervisor started, never in a dry run; a pass that throws is logged without stopping
  the others.
- The loop waits `STUDIO_SUPERVISOR_SEC` +- `STUDIO_SUPERVISOR_JITTER` (0.1; 0 = fixed) so several studios on one PC don't
  fire together. A new agent name never reuses one with a leftover `.lanes/<name>` folder.
- **Start backoff** (2.78.0, `.studio/start-backoff.json`): a start of task T refused for the same reason as last time
  (`task.start_refused`, `task.lock_denied`, a launcher refusal) is skipped for 2, 4, 8 ... minutes, at most
  `STUDIO_START_BACKOFF_MAX_MIN` (30); a changed reason or task state resets it. The pass's `why` says so once.
  2.84: that line, the `supervisor.backoff` event (`meta.reason`) and `npm run task -- show <ID>` (`startBackoff`) give the
  refusal in its own words. A refusal about the crew and not the task (every seat taken, a budget stop) is not counted:
  it clears by itself, and counting it kept a startable task waiting up to 30 minutes.
- **Line Producer** (2.76.0, docs/LINE-PRODUCER.md): before the supervisor picks, `harness/line-producer.mjs` frees locks of
  ended sessions, recreates a train lane's lost copy, clears expired cooldowns, puts chain-breakers first on the strongest
  model, keeps a share of builders on research/expansion across phases, and holds builders back when the rig is full.
  `npm run line -- status`; `STUDIO_LINE_PRODUCER=report|off`.
- **Memory floor** (2.59.0): no new agent starts while free memory is under `STUDIO_RAM_FLOOR_GB` (3; `0` off). The pass
  says why in its status and a `supervisor.ram_low` event (at most every 15 min); running agents are never stopped; an agent
  a person starts is not held. On Windows the floor uses the smaller of free memory and commit headroom.

## Machine scan, disk and janitor

- **Machine scan** (2.68.0): `npm run machine` (`--json`, `--cached`; `harness/machine.mjs`) reads OS, cores, RAM (and on
  Windows commit charge), GPUs with VRAM and busy (nvidia-smi; macOS system_profiler), the studio's disk, power source and the
  top 10 processes by memory (names only). Each probe has a timeout (`STUDIO_MACHINE_PROBE_TIMEOUT_MS`, 15000) and fails soft.
  It writes `.studio/machine.json`; `STUDIO_MACHINE_SCAN=off` turns it all off. The supervisor samples it every
  `STUDIO_MACHINE_SAMPLE_S` (300) into a `machine.sample` event and `.studio/machine-history.jsonl` (kept under
  `STUDIO_MACHINE_HISTORY_KB`, 256). `status --brief` and `npm run lanes` show "Machine: RAM 26/32 GB (commit 55/60), CPU 32%,
  GPU 1% (1.8/12 GB), disk 130 GB free".
- **Disk budget:** under `STUDIO_DISK_MIN_FREE_GB` (default max(20, 5% of the disk)) the supervisor emits `machine.disk_low`
  (at most every 6 h), the digest has a line, and `task start` and the train warn, naming what the janitor can free.
- **Temp-file janitor** (`npm run janitor`, `harness/janitor.mjs`): a dry run by default; `--yes` deletes only the harness's
  own temporary files: train scratch copies of a train no longer running, `.studio/tmp` entries older than
  `STUDIO_JANITOR_TMP_H` (24) h, train logs beyond the newest `STUDIO_JANITOR_KEEP_LOGS` (40) or `STUDIO_JANITOR_LOGS_MB`
  (200), temp folders marked `.studio-temp.json` (system temp or `STUDIO_JANITOR_TMPDIR`) once old with their process gone,
  and the oldest cache entries while `.studio/unity-cache` and `.studio/assets/library` exceed `STUDIO_CACHE_MAX_GB` (20).
  It never deletes a lane copy with commits not on main, uncommitted changes, a running session or a held or parked task. One
  `janitor.run` event. After each train or verify job it runs `--yes` itself, at most every `STUDIO_JANITOR_EVERY_MIN` (30)
  minutes (never lanes); `STUDIO_JANITOR=off` turns that off. `janitorEstimate()` feeds the disk-low line.
  - Stale lane copies (untouched for `STUDIO_JANITOR_LANE_H`, 24 h, clean, nothing unique, nobody in them) are listed with
    `npm run janitor -- --lanes` and deleted only with `--lanes --yes --by <name>`. A copy whose work landed (its task done
    in `studio/DONE.md`, or a `lane.merged` event) is stale after `STUDIO_JANITOR_LANDED_H` (6). The supervisor runs these
    proposals as a dry run (never deleting) at most every `STUDIO_JANITOR_LANES_MIN` (360; `off`/0: never), in a detached
    child (`harness/lane-disk.mjs`); the digest, `status --brief` and `npm run status -- --json` (`staleLanes`) then show
    "N stale lane copies (X GB) proposed: npm run janitor -- --lanes --yes --by <name>" (`janitor.lanes_proposed`). Deleting
    is a decider's action: a person, a Producer/Director session or outside agent on a person's permission, or an agent
    under the owner's delegation for `janitor-lanes` (`npm run delegate -- grant <agent> --actions janitor-lanes …`; a `hold`
    delegation doesn't cover it).
  - Landed engine passes (2.79.1): `--yes` also removes an engine pass's worktree (`.lanes/engine/<task>`) once the engine
    train's `landed` event names its task, when clean and no session is on it (`janitor.engine_pass`; the branch stays). In
    the system temp folder it removes orphan copies named with a harness prefix (`studio-build-`) or one in
    `STUDIO_JANITOR_TEMP_PREFIXES` (comma list), untouched for `STUDIO_JANITOR_ORPHAN_H` (2) h, with no live owner process.
  - Idle lane copies (2.79): the automatic run also removes the worktree of a lane idle for `STUDIO_LANE_IDLE_HOURS` (4; `0` or
    `off`: never): session ended, task not queued for a train, held or parked, nobody working in it, no uncommitted change,
    no commit not on main. The branch is kept. `npm run lanes -- prune --idle <hours> [--dry-run] [--by <name>]` applies the
    rule now (`lanes.pruned` event). `npm run lanes` alone is a cheap listing; `--full` or a task/agent/branch name reads
    ahead/behind, dirty and stamps.
- **Orphaned gate runs** (2.78.1, `harness/gate-reaper.mjs`): each pass (at most every `STUDIO_ORPHAN_GATE_SCAN_MIN`, 10) ends
  every `scripts/run-gates.mjs` process whose parent is gone and that is older than `STUDIO_ORPHAN_GATE_MIN` (60) minutes,
  with its whole tree, and logs `gate.orphan_ended` (pid, age, why, command line). "Parent gone": no process has its parent's
  pid, or a newer one does (Windows reuses pids), or on POSIX it was re-parented to pid 1 or an init/systemd reaper.
  `npm run verify`'s host is parentless on purpose and counts as alive while its verify record names it running (at most
  `STUDIO_VERIFY_MAX_MIN`, 360). `STUDIO_ORPHAN_GATE_MIN=0` or `off`: never.

## When sessions fail or stop

- **Two identical failures halt it.** When two sessions in a row end with the same exit code (127: tool not found), the
  supervisor stops starting agents and shows one "Needs you" card. Fix the cause, then from a terminal (2.59.0):
  `npm run studio:resume -- --by <your name> [--why "what you fixed"]`; it prints the halt it cleared and the next pass's
  `supervisor.resumed` event names who asked (`meta.by`, `meta.why`); not halted: it says so. It refuses inside a launched
  session (`STUDIO_ROLE` set) and for agents' names (`builder-s3`, `claude-a`, any name the launcher handed out); to narrow
  who may resume further, set `STUDIO_RESUME_BY=<name>[,<name>]` in `.env` (off by default).
  2.84: a reviewer session that crashes at launch (under a minute, an exit that is not 126, 127 or 9009) does not count
  toward this halt: the reviewer role waits 2, 4, 8 ... minutes (at most `STUDIO_START_BACKOFF_MAX_MIN`,
  `supervisor.role_backoff`) and the other roles go on. A code-writing role's launch crashes still halt. A reviewer whose
  tool cannot run its planned model is refused before it starts (docs/AGENT-TOOLS.md).
  - A session someone stopped or paused (`agent stop`, Pause, Stop all) never counts: the stop is written before the kill,
    the end reads "stopped by <name>" (`meta.stoppedBy`) and its hand-back says "a stop, not a failure" (no park, breaker
    or tier-up). An end the launcher caused itself (stall watchdog, idle exit, task budget) never counts either.
  - Sessions ending within `STUDIO_HALT_SAME_DEATH_SEC` (5; 0 = off) of each other count as ONE end (one outside cause took
    them), only if they had run a minute or more and never exit 126, 127 or 9009 (the tool itself can't run). (2.73.1)
  - Each `agent.session.end` records `meta.exitCause` (`kind`: exit, signal, stall, idle, budget, stopped, spawn-error; with
    `code`, `signal`, `at`, `ranSec`); `supervisor.halted` lists `meta.causes`. On Windows a kill from outside reads as exit 1.
  - A halt stops new sessions only: merge trains for queued lanes still run (docs/WORK-ORGANIZATION.md). While halted, or
    nothing can start agents, a queued rescue's pick-up clock (`STUDIO_RESCUE_WAIT_MIN`) is stopped and the Producer told once.
- **Stop cooldown:** `npm run agent -- stop <name>` (and Pause) keep that task from restarting for 15 minutes
  (`STUDIO_STOP_COOLDOWN_MIN`), for the stopped role only (a stopped builder's task can't restart as a builder, but a
  reviewer can; time shown in UTC). "Stop all" also stops running agents and hands their tasks back.
- **The stall watchdog** (`harness/stall.mjs`): a session with no file write, commit or task change for `STUDIO_STALL_MIN` (15)
  minutes, or past its wall-clock cap (`STUDIO_SESSION_MAX_MIN`, 90; planning roles `STUDIO_SESSION_PLAN_MAX_MIN`, 25), is
  ended and its task handed back (`session.stall`).
  - 2.84: with `STUDIO_STALL_PLAN_MIN` unset a planning session gets 8 minutes, or 20 on a top-tier model (it thinks long
    before its first write), or the model's own `stallMin` in `studio/models.json`; a set `STUDIO_STALL_PLAN_MIN` always
    wins. The `session.stall` event says which limit applied and why.
  - Read-burn ratio (`STUDIO_STALL_RATIO`, 120:1 over `STUDIO_STALL_RATIO_WINDOW_TOKENS`; 0 = off) counts uncached input plus
    cache creation only, and gives no verdict in the first `STUDIO_STALL_GRACE_MIN` (15) minutes.
  - Each session is judged on its own tokens: the session record's `logFrom` says where its part of an agent's appended log
    starts, only the newest Claude session id counts, and its stall record starts fresh. A session the launcher ends
    records its usage from its stream and a cost estimated at `studio/prices.json` (`meta.costEstimated`).
  - A session waiting on its own verify (`npm run verify`, its `.studio/verify-running/<agent>.json` or a `full*.json` it
    owns, live process, no result) or its own background `task done` (`.studio/done-running/`) is busy, not stalled: the stall
    clock is held and the wall cap may run over by at most `STUDIO_STALL_VERIFY_MAX_MIN` (60) (a done:
    `STUDIO_DONE_RUNNING_MAX_MIN`, 90). `node harness/stall.mjs check` shows "waiting on its own verify".
  - A stall end is recorded once per session (`.studio/stall/<agent>.json` `ended`), whoever sees it first, counts as
    `exitCause.kind` stall and never toward the halt rule. Once the agent's process has exited the session lists as `ending`
    (not STALLED) while its launcher hands the work back (bounded by `STUDIO_DONE_RUNNING_MAX_MIN`); the watchdog, watch pass
    and silent-agent release leave it to the launcher. One `agent.session.end` per session.
- **A silent agent doesn't hold its task forever:** a session whose process is alive but whose heartbeat is older than
  `STUDIO_STALL_RELEASE_MIN` (30; 0 off) gets its work saved, its task handed back and its claims and slot freed by the
  watcher; the process is left alone (a machine waking from sleep, or a reused pid, is never killed): end it by hand if stuck.
  A pass right after the machine slept frees nothing and checks again.
- **A dead session ends in time** (2.81, `harness/gone-check.mjs`): a launched session whose process is gone (PID plus its
  start-time identity, `harness/proc-identity.mjs`; never the heartbeat alone) is ended by the supervisor's pass and by
  `task next` / `task start`, at most once per `STUDIO_GONE_CHECK_S` (60; `off` turns these extra passes off; stamp
  `.studio/gone-check.json`). Its `agent.session.end` keeps the detection time as `ts` and `meta.detectedAt`, and carries
  `meta.endedAt`: the last heartbeat (else the start) plus `STUDIO_GONE_GRACE_S` (120), never later than the detection. Session
  hours (`harness/model-pools.mjs`, `run-report.mjs`, `metrics.mjs`) read `meta.endedAt`.
- **No-work sessions** (2.67.2, `harness/session-outcome.mjs`): each `agent.session.end` carries `meta.outcome` (task, whether
  claimed, commits, done, and without a done why: `task.start_refused`, never claimed, `task done` refused and by what, or
  claimed and committed nothing). After `STUDIO_NO_WORK_EXITS` (2; 0 off) such exits in a row (a stop, refresh, usage limit or
  provider error doesn't count) the launcher parks the task with that reason and tells the Producer; `npm run task --
  unpark <ID> --by <name>` resets the count. A bug task's brief and done-check refusal name the regression:
  `qa/regressions/<ID>.json`, its fields, `node qa/check-regressions.mjs --update` and
  `node qa/fails-before.mjs qa/regressions/<ID>.json "<fix>^"` (`harness/regression-howto.mjs`).
- **Attempt ledger** (2.81, `harness/attempts.mjs`): every failed or owner-only hand-back is written to
  `.studio/attempts/<ID>.json` (reason, main's tip, what it waits for, and a signature of the three). While the current
  signature equals the last attempt's, a new session would meet the same wall. `STUDIO_ATTEMPTS`: `record` (default) writes
  the ledger, and `task next` and the supervisor offer that task after every other eligible one (nothing refused; the loop
  park, breaker, tier-up and usage-limit stop keep their own counts); `refuse` also refuses it in `task next`, `task start`,
  the supervisor and the Line Producer ("same blocker as attempt <n> (<reason>): main unchanged since <sha> and nothing it
  waits for landed"); `off` writes and reads nothing. A commit on main, a landed dependency, `npm run task -- unblock <ID>
  --by <name>` (even with no park), `unpark` or a done clears it. A hand-back the harness or a person caused (claim ran out,
  a stop, a refresh, a session cap) is never recorded, and the ledger never releases a lock or claim. `task next` and the
  supervisor's pick also ask `task start`'s budget and round-cap questions (`eligibility()`).
- **A task that waits for the owner** (2.78.2): when a hand-back note or a session's last output carries the harness's own
  refusal of an owner-only step ("Only the owner can approve these", "needs the owner's signature", "no owner key at", "only
  the owner approves weakening a test", "exceptions are the owner's call", or the builder's "owner-only step" / "waits for
  the owner" / "needs the owner's approval"), `harness/owner-only.mjs` parks the task with reason `owner-only` at the
  orchestrator's rank and sends the orchestrator an event (the Communicator turns it into an alert). No builder starts on it
  until `npm run task -- unpark <ID> --by <name>` (the orchestrator or the owner).
- **Launched agents inherit your MCP servers:** turn off any that open a tab per `claude -p` session in the server's own
  settings (Serena: `web_dashboard_open_on_launch: false` in `~/.serena/serena_config.yml`).

## Plans and quota

```bash
npm run budget                                                      # per tool, this week
npm run budget -- set claude --weekly 40000000 --reset thursday --hour 9 --target 100%
npm run budget -- order claude,codex,agy
```

- Usage is what each session's tool reported (Claude Code's JSON result, `codex exec --json`). Plans don't publish token
  counts, so `--weekly` is your own estimate. With it the supervisor paces: under the target for this point in the week it
  allows up to two more agents; over it, nothing new. A tool that hits its limit is skipped until its reset ("try again at
  6:12") and its lanes move to the next tool in the order.
- Only real limit errors count as out of quota (a 429, "usage limit reached", "credit balance is too low").
  `STUDIO_QUOTA_SKIP=off` turns quota-skipping off when you watch usage outside the harness.
- Claude Code's window limits count too ("5-hour limit reached ∙ resets 3pm", "Weekly limit reached ∙ resets Mon 9am", "Opus
  weekly limit reached ∙ resets Nov 3, 9am", "usage limit reached|<unix time>"), read in the zone the message names or else this
  machine's. Such a stop hands the task back as "stopped at its usage limit": waiting for the reset, not a failure (no
  breaker, park or halt).
- A role run by its own `STUDIO_<ROLE>_CMD` (or `STUDIO_AGENT_CMD`) is marked per program, `custom:<program>` (the command's
  program, or the script an interpreter runs: `python -m hermes …` is `custom:hermes`); every start of it waits the same way
  ("Not started: budget stop (custom:hermes is marked out until …)"); another command isn't held (2.58.0).
- Per-model marks (2.78.2): a 429 on one Gemini model through agy is marked `agy:<model>` in `.studio/tool-quota.json`, so the
  tool's other models keep running (launch, reviewer, router pools and fallback check `tool:model` first, then the tool).
  Tool-wide errors (auth, binary missing) and old tool-only marks still mark the whole tool. `STUDIO_QUOTA_MODEL_TOOLS`
  (default `agy,gemini`; `all`, or `off` for the old key) lists the tools with per-model marks.
- **Usage wind-down** (`harness/winddown.mjs`): with `STUDIO_USAGE_WINDDOWN_PCT` set (unset: off), when the highest share of a
  tool's week used (`npm run budget`; out of quota counts as 100%) reaches it, no new session starts, running ones finish,
  `.studio/restart-log.md` lists what was running, queued and held with the next steps, and `studio.winddown` is emitted.
  When usage resets the supervisor resumes (`studio.winddown_resumed` links the log). `npm run studio:winddown -- --now --by
  <name>` does it on demand (until the soonest reset); `-- --off --by <name>` ends it early.

## Lanes, dependencies and parked work

Two agents in the same files clash, so parallel work needs separate folders. Give tasks a lane (`npm run task -- add "…" --lane
game/<game>/src/floors`, or later `npm run task -- lane T-041 <folder>`). `--part sim` or `--part renderer` implies the
cartridge or renderer folder. Each lane gets its own agent holding that folder; a builder with no lane holds the whole game, so
no other builder runs beside it. Split big renderer files early (studio/rules/lanes.md; `node scripts/check-module-size.mjs`).

```bash
npm run task -- add "Playtest the merged build" --role qa-playtester --after T-146   # waits for T-146
npm run task -- block T-122 --until T-146 --by producer-1     # or --until 2026-10-22T09:00
npm run task -- park T-100 --by director-1 --why "after the Bible change"
npm run task -- unpark T-100 --by producer-1
npm run task -- holds                                         # everything that can't start yet, and why
```

- A park is undone by an unpark. The loop park and the watchdog's "handed back 3 times in 2 h" count only hand-backs since the
  last done, unblock or unpark; a park is written once however many passes reach it at once (2.58.3).
- `task park <ID> --why "…" --until "<condition>"` stores a condition that isn't a task id, `phase:N` or a time as a note
  (shown on every refusal). A park records its rank (owner > orchestrator > producer/director > any agent); `task unpark` and
  `task unblock` by a lower rank are refused, naming who parked it (2.77.3).
- A builder task added by `task add` must name its folders (`--lane <folders>`, `--paths`, `--part`, or `--lane all` on purpose)
  unless they can be worked out from its title: `STUDIO_REQUIRE_LANE=on` refuses it, `warn` (default) queues it with a warning,
  `off` is silent. Without folders it counts as working on the whole game. `task lane <ID> <folder> [<folder>…] --by <you>`
  sets them afterwards, also on a task in progress (from the next pass its builder counts in that lane; a person, the
  orchestrator or a Producer/Director session; a launched worker is refused) (2.78.1).
- The Line Producer sets lanes on unscoped ready builder tasks itself and reports the ones it can't as `unscoped`
  (`STUDIO_LINE_LANES`); builders with no lane run side by side when plan-waves predicts non-overlapping files
  (`STUDIO_UNSCOPED_PARALLEL=off` turns that off); a task on shared sim code waits for the open task on the same shared files
  (`STUDIO_SHARED_SIM`). Details: docs/LINE-PRODUCER.md.

## Crew watchdog and futility cap (2.68.0)

Each supervisor pass (code only, no model) also does these.

- **Crew watchdog** (`harness/crew-watch.mjs`): per role, over the last `STUDIO_CREW_WINDOW_MIN` (60) minutes, its sessions,
  sessions with no commit, short exits (under `STUDIO_CREW_SHORT_SEC`, 180 s), tokens and tasks landed. More than
  `STUDIO_CREW_MAX_SESSIONS` (6) sessions and 0 landed: the role isn't launched (running sessions go on), one `crew.unhealthy`
  event goes to the Producer with the evidence, and the digest and `npm run status -- --brief` show it. It resumes when a task
  the role worked lands or new work for it appears, or on `npm run crew -- resume <role> --by <name>` (a person, an agent
  under the owner's delegation for hold, or a Producer/Director session or outside agent with `--permission "<the person's
  words>"`; never a worker). `npm run crew` shows each role's hour. `STUDIO_CREW_WATCH=off` turns it off. A pause also ends
  itself after `STUDIO_CREW_BREAKER_RESUME_MIN` (30; `0` or `off`: never) when the evidence no longer trips the breaker, or once
  per cause (the same tasks): a second trip on the same tasks stays paused. Each is a `crew.resumed` event (`meta.auto`) (2.78.2).
  2.84: a session whose lane was checked and queued for a train, and a hand-back whose note says the work is ready for the
  train, count as progress; a session a person or the overseer started by hand (`meta.byHand`) is not counted.
- **Futility cap** (`harness/futility.mjs`): a running session past the 90th percentile of its task type's successful sessions
  (weighted tokens, or wall time) raises one `futility.check`. With fewer than `STUDIO_FUTILITY_MIN_N` (20) successful sessions
  of the type, no cap. `STUDIO_FUTILITY=auto` (default, 2.78.0) enforces for a type only with those 20 good runs and a shadow
  record (at least `STUDIO_FUTILITY_AUTO_MIN_SHADOW`, 5, ended flagged sessions) showing at most
  `STUDIO_FUTILITY_AUTO_MAX_LATE` (0.10) of the sessions the cap would have stopped went on to succeed (`taskDone` in the log),
  because a cap that cuts good runs short costs more than it saves; each switch-on emits `futility.auto_on`, a type without
  data stays in shadow. `=shadow` stops nothing (`futility.shadow` and `.studio/futility-log.jsonl` record what a cap would
  have saved). `=on` always hands the task back (diff saved, lane copy kept); `=off` turns it off.

## Which model rescues a stuck task

A rescue runs on a stronger model from a different family than the ones that got stuck. The model comes from
`STUDIO_RESCUE_MODEL`, then `STUDIO_RESCUE_MODELS` (comma-separated), then `STUDIO_TIER_TOP_MODEL`. Each step takes the first one
from another family, not out of quota or at its spend guard, and not used by an earlier step; then the same family; then the
launcher's own choice. `STUDIO_RESCUE_LEVELS` (default 2) sets how many rescue steps run before the task is shelved.
`STUDIO_RESCUE=off` sends budget stops straight to a person.

## What the owner sees

- Ops: "Running unattended" (since when, sessions, tasks done, tokens, why nothing started), the budget per tool, and each
  agent's work in progress ("main.js +120/−40, last verify 2 min ago") and what it says it is doing (`npm run agent -- now "…"`).
- Progress by phase ("Phase 1: 12/15 · exit 3/5 · Phase 2: not planned yet"); the exit checklist is
  `studio/bible/PHASE-<n>-EXIT.md`.
- Golden changes as cards (the commit's `Golden-Reason:`, which recorded numbers moved, "Looks right"); the Arcade: the last
  good build to play. `npm run studio:status` shows the supervisor, and the run report has a section for it.
