# Running the studio unattended

Run #1 stopped at 07:09 with 36 tasks queued: the laptop restarted, the War Room died, and nothing
started again until someone asked. The supervisor fixes that.

## Start it

After a restart, one command brings the studio up (2.73.1, B-69):

```bash
npm run studio:boot                    # Windows PowerShell: npm.cmd run studio:boot
npm run studio:boot -- --check         # report only: nothing is cleared or started
npm run studio:boot -- --until 46h     # --until, --window, --budget, --lanes go to the supervisor it starts
npm run studio:boot -- --shortcut      # also put a "Studio boot" file on the Desktop (Windows: a .cmd running npm.cmd)
```

It checks node, npm (on Windows it says to type `npm.cmd` when the execution policy blocks `npm.ps1`) and `.env` (no
session identity in it, a War Room token for the buttons); clears lock and status files whose process is gone
(`train.lock`, `land.lock`, `unity-train.lock`, `verify-running/full.json`, `train/daemon.json`, a "running"
`supervisor.json`), one `boot.stale_cleared` event each, never a lane copy or anyone's work; starts the hub and then
the supervisor, each only when it isn't running already, detached and hidden, with output in `.studio/logs/`; the train
daemon runs inside the supervisor's pass. Then one card: crew sessions, the train, halts, what needs you, outside agents
seen lately, lane copies and leftover folders in `.lanes/`, and the War Room address (the link with your token is in
`.studio/logs/hub.log`). Chat-based orchestrators outside the harness are not restarted. The hub and supervisor never
get the shell's `STUDIO_LOCK_OWNER`, `STUDIO_ROLE`, `STUDIO_AGENT` or `STUDIO_MAIN_ROOT`.

```bash
npm run studio:start -- --until 23:00                 # until 23:00 (or --until 8h); runs on its own
npm run studio:start -- --until 23:00 --foreground    # stays attached to this terminal instead
npm run studio:start -- --window 09:00-23:00          # every day inside a window
npm run studio:start -- --until 8h --budget 50%       # stop when the plan reaches 50% of its week
npm run studio:start -- --until 8h --lanes auto       # one builder per lane, in parallel
npm run studio:start -- --install --window 09:00-23:00   # come back after a restart or login
npm run studio:stop                                   # agents finish their task; nothing new starts
npm run studio:status
npm run studio:extend -- --until 2026-11-05T11:52:00Z --by <your name>   # move a running supervisor's end time
npm run studio:reload-env -- --by <your name>         # running processes pick up what you changed in .env now
```

**Changing the end time (2.73.1).** `npm run studio:extend -- --until <23:00 | +8h | ISO time | none> --by <your name>
[--why "…"]` moves a running supervisor's `--until` without a restart (`+8h` and `8h` count from now; `none` removes
the end time). It writes `.studio/supervisor-extend.json`; the next pass (within a minute) applies it and logs a
`supervisor.extended` event (from, to, who). Who may: a person; an agent the owner's delegation covers for
`supervisor-extend`; a Producer or Director session or an outside agent on a person's direct permission
(`--by <the person> --permission "<their words or a link>"`); never a worker session or a worker's name.

**Changing a setting in .env while the studio runs (2.73.2, B-74).** The long-running loops re-read `.env` when its
mtime or size changed: each supervisor pass (with the train daemon's pass in it), each launcher heartbeat (the stall
limits, the idle exit), the watchdog's pass and the watch pass. So a raised `STUDIO_STALL_MIN` reaches the sessions
already running at their next heartbeat, not only new ones. `npm run studio:reload-env` asks for a reload now; a
running supervisor answers within seconds with what changed; if it is busy in a pass, the command waits one pass
(`STUDIO_SUPERVISOR_SEC` plus 10 s) and then says "Queued: the supervisor reloads on its next pass" (exit 0); with no
supervisor running it exits 0 and says the settings apply when it starts. Each change is logged once (`env.reloaded`, naming the
keys; values of keys that look secret, `*_TOKEN`, `*_KEY`, `*_SECRET`, `*PASSWORD*`, webhooks, are never written).
Precedence: a variable set in the environment a process was started with (your shell, a scheduled task's
environment) still wins over `.env`; a value that came from `.env`, in the process or through its parent (a launcher
inherits the supervisor's; `STUDIO_ENV_FROM_FILE` is the internal note of which names those are, never their values),
follows the file; a line removed from `.env` gives that setting its default back. Identity settings (`STUDIO_LOCK_OWNER`,
`STUDIO_ROLE`, `STUDIO_AGENT`, `STUDIO_MAIN_ROOT`) are never taken from `.env`. Read once at start, so a restart is still
needed: `STUDIO_SUPERVISOR_SEC`, `STUDIO_HEARTBEAT_SEC`, `HUB_PORT`.
`studio:reload-env` (2.79) also lists the `STUDIO_*` names the `.env` sets (names only, never values) and marks any the
harness no longer reads (not in `docs/SETTINGS.md`) as "unknown (removed or misspelled)".

2.77.1 (B-102): a pass never stops the loop. The loop is set before the first pass, passes never overlap, and each step of
a pass (the hub, the Line Producer, the launch step, the Director's flow, the machine scan, the Communicator, the
workaround pass, the train daemon) is bounded: a step still running after `STUDIO_SUPERVISOR_STEP_SEC` (300; the launch
step twice that) is reported as `supervisor.step_timeout` and the pass goes on without it. A whole pass still running after
`STUDIO_SUPERVISOR_STUCK_MIN` (15) minutes is reported once as `supervisor.pass_stuck`. `.studio/supervisor.json` counts
the finished passes (`passes`). Before 2.77.1 the first pass could wait on itself (a pass that imports supervisor.mjs back,
such as the Communicator's needs-a-person list) and Node exited with code 13 ("unsettled top-level await").

Every minute it keeps the War Room hub up (and logs how long it was down; 2.74.0: harness/hub-keeper.mjs, below), then starts a fresh agent
for the next waiting task of each role, one task per session, within the pace's caps. When a session
ends, the next minute starts the next. It starts nothing while "Stop all agents" is on, outside the
window, past `--until`, or past the budget. The Ops view shows "Running unattended", and the run
report has a section for it. `--install` uses launchd (macOS), systemd --user (Linux) or Task
Scheduler (Windows); `--uninstall` removes it.

- **A memory floor (2.59.0).** No new agent starts while free memory is under `STUDIO_RAM_FLOOR_GB` (3; `0`
  turns it off): a Unity editor and browser playtests beside a full verify took a PC down to 2.6 GB free. The
  pass says why in its status and a `supervisor.ram_low` event (at most every 15 min); running agents are never
  stopped. The watcher's and the Director's auto-start use the same pass; an agent a person starts is not held.

- **The machine scan and resource monitor (2.68.0).** `npm run machine` (`--json`, `--cached`) reads the hardware the
  studio runs on (harness/machine.mjs): OS, logical and performance/efficiency cores, RAM and (Windows) the commit
  charge, GPUs with VRAM and busy (nvidia-smi; macOS system_profiler), the studio's disk, the power source and the
  top 10 processes by memory (names only). Each probe has a timeout (`STUDIO_MACHINE_PROBE_TIMEOUT_MS`, 15000) and
  fails soft (null + reason). It writes `.studio/machine.json`; `STUDIO_MACHINE_SCAN=off` turns it all off. The
  supervisor samples it every `STUDIO_MACHINE_SAMPLE_S` (300) into a `machine.sample` event and
  `.studio/machine-history.jsonl` (kept under `STUDIO_MACHINE_HISTORY_KB`, 256). `status --brief`, `npm run lanes`
  and the War Room's `/api/state` (`machine`) show "Machine: RAM 26/32 GB (commit 55/60), CPU 32%, GPU 1% (1.8/12 GB),
  disk 130 GB free". On Windows the memory floor uses the smaller of free memory and commit headroom.
  **Disk budget:** under `STUDIO_DISK_MIN_FREE_GB` (default max(20, 5% of the disk)) the supervisor emits
  `machine.disk_low` (at most every 6 h), the daily digest has a line, and `task start` and the train warn, naming
  what the temp-file janitor can free when it is installed.

- **The hub keeper (2.74.0, B-70).** The hub counts as up when `/health` answers within 5 s (it was 2 s, so a busy hub
  building a big page was logged as down). A hub process of the supervisor's that is still there but silent is left
  alone for `STUDIO_HUB_HANG_MIN` (5) minutes, then ended and restarted; a hub someone else started (the pid in
  `.studio/hub.json`, alive) is never touched. A dead hub is started again (hidden on Windows) at most once per
  backoff step (30 s, 1, 2, 4, 8, then every 10 minutes; the steps start over after 10 minutes up), each restart a
  `supervisor.hub_restart` event with its cause. The cause is the hub's own line in `.studio/logs/hub-exit.log`: the hub
  writes one on every exit (a signal, an uncaught error, `port … is in use`), on an error it survived (a request whose
  handler threw now answers 500 instead of ending the hub), and when building `/api/hud` took over 2 s.
  `npm run studio:status` ends with "Hub last restarted 12:05 UTC (<cause>); 3 restarts this run."
- **It runs on its own.** `studio:start` detaches by default, so it outlives the terminal or agent shell that
  started it (run #1: every agent died when the host shell restarted). Its output goes to `.studio/supervisor.log`.
- **Install from a terminal where the agent tool works.** The login job gets that terminal's PATH and HOME
  and the `node` on the PATH; install warns when `claude --version` (or your tool) wouldn't be found.
  Run #1 looped on exit 127 because launchd's PATH had no `~/.local/bin`.
- **Two identical failures stop it.** When two sessions in a row end with the same exit code (127: tool not
  found), the supervisor stops starting agents and shows one "Needs you" card with the reason. Fix the
  cause, then press "Fixed it: try again" (2.74.0: in a paired browser it runs this same command as the paired person
  and shows its answer, docs/WAR-ROOM-V3.md), or from a terminal (2.59.0, no hub token needed):
  `npm run studio:resume -- --by <your name> [--why "what you fixed"]`. It prints the halt it cleared, and the next
  pass's `supervisor.resumed` event names who asked (`meta.by`, `meta.why`). Not halted: it says so and does nothing.
  A person decides to retry after repeated failures, so it refuses inside a launched agent session (`STUDIO_ROLE` set)
  and for agents' names (`builder-s3`, `claude-a`, `opus-bot`, any name the launcher handed out). A chat bot that isn't
  launched by the harness can still type a person's name: to narrow who may resume, set `STUDIO_RESUME_BY=<name>[,<name>]`
  in `.env` (off by default). A session someone stopped or paused (`agent stop`, Pause, Stop all)
  never counts: the stop is written down before the kill, so its end reads "stopped by <name>"
  (`meta.stoppedBy`), not "exit 1", and its hand-back says "a stop, not a failure" (no park, breaker or tier-up).
  2.73.1 (B-66): sessions that end within `STUDIO_HALT_SAME_DEATH_SEC` (5; 0 = off) seconds of each other count as ONE
  end for this rule (one outside cause took them together). Only sessions that had run a minute or more are merged,
  and never exit 126, 127 or 9009 (the tool itself can't run): sessions that crash at launch each count,
  and an end the launcher caused itself (the stall
  watchdog, the idle exit, the task's budget) never counts, like a stop. Each `agent.session.end` records how the
  process ended in `meta.exitCause` (`kind`: exit, signal, stall, idle, budget, stopped, spawn-error; with `code`,
  `signal`, `at` and `ranSec`), and `supervisor.halted` lists the causes (`meta.causes`). On Windows a kill from outside
  (taskkill /F) reads as exit 1, since Windows has no signals. A halt stops new sessions only: merge trains for lanes
  already queued still run (the train daemon, docs/WORK-ORGANIZATION.md).
  While the supervisor is halted, or nothing can start agents, a queued rescue's pick-up clock
  (`STUDIO_RESCUE_WAIT_MIN`) is stopped and the Producer is told once; it counts again from when agents can start.
- **The Line Producer (2.76.0, docs/LINE-PRODUCER.md).** Each pass, before the supervisor picks what to start,
  `harness/line-producer.mjs` frees locks of ended sessions, recreates a train lane's lost copy from its branch, clears
  cooldowns whose time has passed, puts chain-breakers first on the strongest model, keeps a share of builders on
  research/expansion across the early/mid/late phases, and holds builders back when the rig is full (never more than
  the pace allows). `npm run line -- status`; `STUDIO_LINE_PRODUCER=report|off`.
- **Only real limit errors count as out of quota** (a 429, "usage limit reached", "credit balance is too
  low"). `STUDIO_QUOTA_SKIP=off` turns quota-skipping off entirely when you watch usage outside the harness.
- **A usage limit is saved per model for tools with a quota per model (2.78.2).** A 429 on one Gemini model through agy is
  marked `agy:<model>` in `.studio/tool-quota.json`, not `agy`, so the tool's other models keep running (a launch, the
  reviewer, the router's pools and the fallback check the `tool:model` mark first, then the tool's). Errors that are
  really tool-wide (auth, binary missing) and old tool-only marks still mark the whole tool. `STUDIO_QUOTA_MODEL_TOOLS`
  (default `agy,gemini`; `all`, or `off` for the old tool-wide key) lists the tools that get per-model marks.
- **A task that waits for the owner (2.78.2).** When a hand-back note, or the end of a session's output, carries the
  harness's own refusal of a step only the owner can do ("Only the owner can approve these" from the protected check, "needs
  the owner's signature", "no owner key at", "only the owner approves weakening a test", "exceptions are the owner's call",
  or the builder's own "owner-only step" / "waits for the owner" / "needs the owner's approval"), harness/owner-only.mjs parks
  the task with reason `owner-only` at the orchestrator's rank, sends an event to the orchestrator (the Communicator turns it
  into an alert) and the supervisor starts no builder on it until `npm run task -- unpark <ID> --by <name>` (the orchestrator
  or the owner).
- **The stall watchdog (harness/stall.mjs).** A session with no file write, commit or task change for
  `STUDIO_STALL_MIN` (15) minutes, or past its wall-clock cap (`STUDIO_SESSION_MAX_MIN`, 90; planning roles
  `STUDIO_SESSION_PLAN_MAX_MIN`, 25), is ended and its task handed back (`session.stall`). 2.77.3 (B-109): the
  read-burn ratio (`STUDIO_STALL_RATIO`, 120:1 over `STUDIO_STALL_RATIO_WINDOW_TOKENS`; 0 = off) counts uncached input
  plus cache creation only (a cache read is the same context re-read each turn, not new work), and gives no read-burn
  verdict in the first `STUDIO_STALL_GRACE_MIN` (15) minutes of a session. 2.76.0 (B-83, the crew's
  W-0070): each session is judged on its own tokens only. An agent's log is appended to across sessions under one name,
  so a relaunch counted the last session's tokens and was ended within seconds ("read 837668 tokens … 3 s into the new
  session", every builder). The session record's `logFrom` says where its part of the log starts (the launcher's
  heartbeat and the watchdog read only that part), only the newest Claude session id in it counts, its stall record
  starts fresh, and a count that starts over restarts the read-burn window there. 2.76.0 (B-82): a session the launcher
  ends (stall, idle, budget) records its usage from its stream and a cost estimated at `studio/prices.json`
  (`meta.costEstimated`); before, it recorded the previous session's result line (the same cost twice) or nothing.
  2.73.1 (B-68): a session
  waiting on its own verify (`npm run verify`, its `.studio/verify-running/<agent>.json` or a `full*.json` it owns,
  with a live process and no result yet) or on its own background `task done` (`.studio/done-running/`) is busy, not
  stalled: the stall clock is held and the wall-clock cap may run over while it waits, by at most
  `STUDIO_STALL_VERIFY_MAX_MIN` (60) minutes. A verify counts for at most that long from its start (a done for
  `STUDIO_DONE_RUNNING_MAX_MIN`, 90), so a hung verify can't keep a session alive. `node harness/stall.mjs check`
  shows "waiting on its own verify" for such a session. 2.73.2 (B-72): a stall end is recorded once per session
  (`.studio/stall/<agent>.json` `ended`), whether the launcher's heartbeat or the watchdog's pass saw it first, and the
  watchdog's end counts as a stall end (`exitCause.kind` stall), never toward the "two sessions in a row" halt. Once the
  agent's process has exited, the session lists as `ending` (not STALLED) while its launcher hands the work back, which
  can take minutes when it closes the task itself; the watchdog, the watch pass and the silent-agent release leave it
  to the launcher (bounded by `STUDIO_DONE_RUNNING_MAX_MIN`, 90). One `agent.session.end` per session, whoever records it.
- **A silent agent doesn't hold its task forever.** A session whose process is alive but whose heartbeat
  is older than `STUDIO_STALL_RELEASE_MIN` (30 min; 0 turns it off) gets its work saved, its task handed back
  and its claims and slot freed by the watcher; the process itself is left alone (a machine waking from sleep,
  or a process id now used by something else, is never killed). End it by hand if it is stuck. A pass right
  after the machine slept (the watcher's own last pass as old) frees nothing and checks again next pass.
- **The supervisor doesn't need auto-start.** `studio:start` is you choosing to run the studio, so it starts
  agents whatever `npm run mode -- autostart` says; the switch is for the watcher and the HUB starting
  agents on their own (docs/PACE-AND-AGENTS.md).
- **Launched agents inherit your MCP servers.** Jed's Serena server opened its dashboard tab for every
  `claude -p` session and hid the War Room. Turn that off in the server's own settings
  (Serena: `web_dashboard_open_on_launch: false` in `~/.serena/serena_config.yml`).

It needs a tool to start agents with: `STUDIO_AGENT_TOOL` (and `STUDIO_AGENT_MODEL`) in `.env`, or per
role `STUDIO_BUILDER_TOOL`, `STUDIO_ART_TOOL`, …, or `STUDIO_<ROLE>_CMD` with `{kickoff}`, `{agent}`,
`{model}`, `{role}` and `{task}` for anything else.

## Plans and quota

```bash
npm run budget                                                      # per tool, this week
npm run budget -- set claude --weekly 40000000 --reset thursday --hour 9 --target 100%
npm run budget -- order claude,codex,agy
```

Usage is what each session's tool reported (Claude Code's JSON result, `codex exec --json`). Plans
don't publish token counts, so `--weekly` is your own estimate of a week on that plan. With it, the
supervisor paces: under the target for this point in the week it allows up to two more agents; over
it, it starts nothing new. A tool that hits its limit is skipped until its reset ("try again at 6:12")
and its lanes move to the next tool in the order, instead of stalling.
Claude Code's window limits count too ("5-hour limit reached ∙ resets 3pm", "Weekly limit reached ∙ resets
Mon 9am", "Opus weekly limit reached ∙ resets Nov 3, 9am", "usage limit reached|<unix time>"), read in the
zone the message names ("(Asia/Bangkok)") or else this machine's; such a stop hands the task back as
"stopped at its usage limit", which is waiting for the reset, not a failure (no breaker, park or halt). A
role run by its own `STUDIO_<ROLE>_CMD` (or `STUDIO_AGENT_CMD`) is marked per program, `custom:<program>`
(the command's program, or the script an interpreter runs: `python -m hermes …` is `custom:hermes`), and
every start of that command waits the same way: `npm run agent -- start` says "Not started: budget stop
(custom:hermes is marked out until …)". Another command isn't held by it. Since 2.58.0; marks saved as plain
`custom` by 2.57.0 run out on their own.

## Lanes, dependencies and parked work

Two agents in the same files clash, so parallel work needs separate folders. Give tasks a lane
(`npm run task -- add "…" --lane game/<game>/src/floors`, or later `npm run task -- lane T-041 <folder>`).
`--part sim` or `--part renderer` implies the cartridge or renderer folder. Each lane gets its own agent
holding that folder, and a builder with no lane holds the whole game, so no other builder runs beside it.
Split big renderer files early (studio/rules/lanes.md; `node scripts/check-module-size.mjs`).

```bash
npm run task -- add "Playtest the merged build" --role qa-playtester --after T-146   # waits for T-146
npm run task -- block T-122 --until T-146 --by producer-1     # or --until 2026-10-22T09:00
npm run task -- park T-100 --by director-1 --why "after the Bible change"
npm run task -- unpark T-100 --by producer-1
npm run task -- holds                                         # everything that can't start yet, and why
```

A park is undone by an unpark: the launcher's loop park and the watchdog's "handed back 3 times in 2 h" both
count only hand-backs since the last done, unblock or unpark, and a park is written once however many passes
reach it at the same moment (2.58.3).

A session that ends with no work is recorded and counted too (2.67.2, `harness/session-outcome.mjs`): each
`agent.session.end` carries `meta.outcome` (its task, whether it claimed it, its commits, whether it was done, and,
without a done, why: its `task start` was refused (`task.start_refused`), it never claimed the task, `task done` was
refused and by what, or it claimed and committed nothing). After `STUDIO_NO_WORK_EXITS` (2; 0 turns it off) such exits
in a row (no done, and no commit or a refused task done; a person's stop, a refresh, a usage limit or a provider error
don't count) the launcher parks the task with that reason and tells the Producer, instead of starting it again; `npm
run task -- unpark <ID> --by <name>` resets the count. A bug task's brief and its done-check refusal name the
regression exactly: `qa/regressions/<ID>.json`, its fields, `node qa/check-regressions.mjs --update` and
`node qa/fails-before.mjs qa/regressions/<ID>.json "<fix>^"` (`harness/regression-howto.mjs`).

`npm run agent -- stop <name>` (and Pause) keep that task from restarting for 15 minutes
(`STUDIO_STOP_COOLDOWN_MIN`). "Stop all" also stops running agents and hands their tasks back. The cooldown (2.77.3)
holds only the stopped role: a stopped builder's task can't restart as a builder for 15 minutes, but a reviewer can start;
the restart time is shown in UTC.

2.77.3: `task park <ID> --why "…" --until "<condition>"` stores the condition as a note (shown on every refusal) when it
isn't a task id, `phase:N` or a time. A park records its rank (owner > orchestrator > producer/director > any agent);
`task unpark` (and `task unblock`) by a lower rank is refused, naming who parked it. A builder task added by `task add` must name its folders
(`--lane <folders>`, `--paths`, `--part`, or `--lane all` for the whole game on purpose) unless they can be worked out from
its title: `STUDIO_REQUIRE_LANE=on` refuses it, `warn` (the default) queues it with a warning, `off` is silent. Without folders
it counts as working on the whole game and no other builder runs beside it. `task lane <ID> <folder> [<folder>…]` sets them afterwards.

2.78.1 (B-123): `npm run task -- lane <ID> <folder> [<folder>…] --by <you>` (a person, the orchestrator, or a Producer or
Director session; a launched worker session is refused) also scopes a task already in progress: from the supervisor's
next pass its builder counts as working in that lane, not on the whole game (a session's lane used to be fixed at
launch). The Line Producer's pass sets lanes on unscoped ready builder tasks itself and reports the ones it can't scope
as `unscoped` (`STUDIO_LINE_LANES`); builders with no lane run side by side when plan-waves predicts files for both and
they don't overlap (`STUDIO_UNSCOPED_PARALLEL=off` turns that off); a task on shared sim code waits for the open task on
the same shared files (`STUDIO_SHARED_SIM`). docs/LINE-PRODUCER.md has the details.

## Orphaned gate runs (2.78.1)

A `run-gates.mjs --only protected` once ran 13 h on the main checkout with no live parent. Each supervisor pass (at most
every `STUDIO_ORPHAN_GATE_SCAN_MIN`, 10, minutes; `harness/gate-reaper.mjs`) ends every `scripts/run-gates.mjs` process
whose parent is gone and that is older than `STUDIO_ORPHAN_GATE_MIN` (60) minutes, with its whole tree (taskkill /T on
Windows, the process and its children on POSIX), and logs a `gate.orphan_ended` event (pid, age, why, its command line).
"Parent gone": no process has its parent's pid, or a newer one does (Windows reuses pids and keeps the dead parent's
number), or on POSIX it was re-parented to pid 1 or an init/systemd reaper. `npm run verify`'s host is parentless on
purpose: it counts as alive while its verify record still names it as running (no longer than `STUDIO_VERIFY_MAX_MIN`,
360). `STUDIO_ORPHAN_GATE_MIN=0` or `off`: never.

## Crew watchdog, futility cap, wind-down and janitor (2.68.0)

Each supervisor pass (code only, no model) also does three things:

- **Crew watchdog** (`harness/crew-watch.mjs`): per role, over the last `STUDIO_CREW_WINDOW_MIN` (60) minutes, its
  sessions, sessions with no commit, short exits (under `STUDIO_CREW_SHORT_SEC`, 180 s), tokens and tasks landed. More
  than `STUDIO_CREW_MAX_SESSIONS` (6) sessions and 0 landed: the role isn't launched (running sessions go on), one
  `crew.unhealthy` event goes to the Producer with the evidence, and the digest and `npm run status -- --brief` show it.
  It resumes on its own when a task the role worked lands or new work for it appears, or on
  `npm run crew -- resume <role> --by <name>` (a person, an agent under the owner's delegation for hold, or a
  Producer/Director session or outside agent with `--permission "<the person's words>"`; never a worker). `npm run crew`
  shows each role's hour. `STUDIO_CREW_WATCH=off` turns it off. 2.78.2: a pause also ends by itself after
  `STUDIO_CREW_BREAKER_RESUME_MIN` (30; `0` or `off`: never) minutes, when the evidence no longer trips the breaker
  (for example the supervisor was down and the sessions aged out of the hour), or once for that cause (the same
  tasks): the window starts again and a second trip on the same tasks stays paused. Each is a `crew.resumed` event
  (`meta.auto`).
- **Futility cap, auto** (`harness/futility.mjs`): a running session past the 90th percentile of its task
  type's successful sessions (weighted tokens, or wall time) raises one `futility.check` ("past the p90 of good runs").
  Fewer than `STUDIO_FUTILITY_MIN_N` (20) successful sessions of that type: no cap. `STUDIO_FUTILITY=auto` (the default,
  2.78.0) enforces for a type only when it has those 20 good runs and its shadow record (at least
  `STUDIO_FUTILITY_AUTO_MIN_SHADOW`, 5, ended flagged sessions) shows that at most `STUDIO_FUTILITY_AUTO_MAX_LATE`
  (0.10) of the sessions the cap would have stopped went on to succeed anyway (`taskDone` in the log: their task was done by
  the time they ended). Why: the cap was measured in shadow first, and a cap that cuts good runs short costs more than it
  saves, so each type is switched on only by its own data; a type without that data stays in shadow. Each type that
  switches on emits one `futility.auto_on` event. `=shadow` stops nothing; when the session ends, `futility.shadow` and
  `.studio/futility-log.jsonl` record what a cap would have saved and whether it would have cut a good run short. `=on` always
  hands the task back (the diff is saved, the lane copy kept); `=off` turns it off.
- **Start backoff and loop jitter** (`harness/supervisor.mjs`, 2.78.0): a start of task T refused for the same reason as
  last time (`task.start_refused`, `task.lock_denied`, a start the launcher refused) is skipped in later passes for 2, 4, 8
  ... minutes, at most `STUDIO_START_BACKOFF_MAX_MIN` (30); a changed reason or a changed task state (held, unheld,
  handed back, started, its lock taken or freed) resets it. The pass's `why` says so once per backoff; state in
  `.studio/start-backoff.json`. Why: a launcher once retried one refused start 61 times in 85 minutes, and 18 of 40 "can't
  start yet" refusals came back to the same agent within an hour. The loop waits `STUDIO_SUPERVISOR_SEC` +-
  `STUDIO_SUPERVISOR_JITTER` (0.1; 0 = fixed) so several studios on one PC don't fire together. A new agent name never reuses
  one with a leftover `.lanes/<name>` folder or one another launch just took.
- **Usage wind-down** (`harness/winddown.mjs`): with `STUDIO_USAGE_WINDDOWN_PCT` set (unset: off), when the highest
  share of a tool's week used (`npm run budget`; a tool out of quota counts as 100%) reaches it, no new session starts,
  the running ones finish, `.studio/restart-log.md` lists what was running, queued and held with the next steps, and a
  `studio.winddown` event says so. When the usage resets the supervisor resumes and its `studio.winddown_resumed` event
  links the restart log. `npm run studio:winddown -- --now --by <name>` does it on demand (until the soonest known
  reset); `npm run studio:winddown -- --off --by <name>` ends it early.

**Temp-file janitor** (`npm run janitor`, `harness/janitor.mjs`): a dry run by default (what, and how much);
`--yes` deletes only the harness's own temporary files: train scratch copies left by a train that is no longer running
(clean, nothing of their own), `.studio/tmp` entries older than `STUDIO_JANITOR_TMP_H` (24) hours, train logs beyond
the newest `STUDIO_JANITOR_KEEP_LOGS` (40) or `STUDIO_JANITOR_LOGS_MB` (200), temp folders the harness marked for this
studio (`.studio-temp.json`; in the system temp folder or `STUDIO_JANITOR_TMPDIR`) once old and their process gone,
and the oldest cache entries while `.studio/unity-cache` and `.studio/assets/library` are over `STUDIO_CACHE_MAX_GB`
(20). It never deletes a lane copy with commits not on main, uncommitted changes, a running session or a held or parked
task. Lane copies that are merely stale (untouched for `STUDIO_JANITOR_LANE_H`, 24 h, clean, nothing unique, nobody in
them) are listed with `npm run janitor -- --lanes` and deleted only with `--lanes --yes --by <name>` (the same deciders
as above). One `janitor.run` event. After each train or verify job it runs `--yes` by itself, at most every
`STUDIO_JANITOR_EVERY_MIN` (30) minutes (never lanes); `STUDIO_JANITOR=off` turns that off. `janitorEstimate()` gives a
disk-low warning its "the janitor can free N GB" line.

**Idle lane copies (2.79).** The automatic janitor run also removes the worktree of a lane copy that has been idle for
`STUDIO_LANE_IDLE_HOURS` (12; 0 or `off`: never): its session ended, its task isn't queued for a train (read through the
train queue's reader), held or parked, nobody works in it (no process, no live claim, no recent change), it has no
uncommitted change and no commit that isn't on main. Only the worktree goes; the branch is kept (the train or the next
session makes the copy again from it). `npm run lanes -- prune --idle <hours> [--dry-run] [--by <name>]` applies the same
rule now and prints what it removed and the disk freed (`lanes.pruned` event). `npm run lanes` with no arguments is a
cheap listing (no git process per copy); `--full` or a task/agent/branch name reads ahead/behind, dirty and stamps.

**Stale-lane proposals surfaced (2.70.0).** A lane copy whose work has landed (its task is done in `studio/DONE.md`,
or a `lane.merged` event names it) is stale after `STUDIO_JANITOR_LANDED_H` (6) hours instead of 24. The supervisor
runs the janitor's lane proposals as a dry run (it never deletes) at most every `STUDIO_JANITOR_LANES_MIN` (360)
minutes (`off` or 0: never), in a detached child (`harness/lane-disk.mjs`), with the lane disk report; the digest,
`status --brief` and the War Room snapshot (`staleLanes`) then show "N stale lane copies (X GB) proposed: npm run
janitor -- --lanes --yes --by <name>" (one `janitor.lanes_proposed` event). Deleting stays a decider's action: a
person, a Producer/Director session or outside agent on a person's permission, or an agent under the owner's
delegation for `janitor-lanes` (`npm run delegate -- grant <agent> --actions janitor-lanes …`; a `hold` delegation no
longer covers it).

## What the owner sees

- Ops: "Running unattended" (since when, sessions, tasks done, tokens, why nothing started), the
  budget per tool, and each agent's work in progress ("main.js +120/−40, last verify 2 min ago")
  and what it says it is doing (`npm run agent -- now "…"`).
- Progress by phase: "Phase 1: 12/15 · exit 3/5 · Phase 2: not planned yet". The exit checklist is
  `studio/bible/PHASE-<n>-EXIT.md`.
- Golden changes as cards: the commit's `Golden-Reason:` and which recorded numbers moved, with
  "Looks right".
- The Arcade: the last good build to play.
