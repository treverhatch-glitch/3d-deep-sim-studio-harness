# Running the studio unattended

Run #1 stopped at 07:09 with 36 tasks queued: the laptop restarted, the War Room died, and nothing
started again until someone asked. The supervisor fixes that.

## Start it

```bash
npm run studio:start -- --until 23:00                 # until 23:00 (or --until 8h); runs on its own
npm run studio:start -- --until 23:00 --foreground    # stays attached to this terminal instead
npm run studio:start -- --window 09:00-23:00          # every day inside a window
npm run studio:start -- --until 8h --budget 50%       # stop when the plan reaches 50% of its week
npm run studio:start -- --until 8h --lanes auto       # one builder per lane, in parallel
npm run studio:start -- --install --window 09:00-23:00   # come back after a restart or login
npm run studio:stop                                   # agents finish their task; nothing new starts
npm run studio:status
```

Every minute it keeps the War Room hub up (and logs how long it was down), then starts a fresh agent
for the next waiting task of each role, one task per session, within the pace's caps. When a session
ends, the next minute starts the next. It starts nothing while "Stop all agents" is on, outside the
window, past `--until`, or past the budget. The Ops view shows "Running unattended", and the run
report has a section for it. `--install` uses launchd (macOS), systemd --user (Linux) or Task
Scheduler (Windows); `--uninstall` removes it.

- **A memory floor (2.59.0).** No new agent starts while free memory is under `STUDIO_RAM_FLOOR_GB` (3; `0`
  turns it off): a Unity editor and browser playtests beside a full verify took a PC down to 2.6 GB free. The
  pass says why in its status and a `supervisor.ram_low` event (at most every 15 min); running agents are never
  stopped. The watcher's and the Director's auto-start use the same pass; an agent a person starts is not held.

- **It runs on its own.** `studio:start` detaches by default, so it outlives the terminal or agent shell that
  started it (run #1: every agent died when the host shell restarted). Its output goes to `.studio/supervisor.log`.
- **Install from a terminal where the agent tool works.** The login job gets that terminal's PATH and HOME
  and the `node` on the PATH; install warns when `claude --version` (or your tool) wouldn't be found.
  Run #1 looped on exit 127 because launchd's PATH had no `~/.local/bin`.
- **Two identical failures stop it.** When two sessions in a row end with the same exit code (127: tool not
  found), the supervisor stops starting agents and shows one "Needs you" card with the reason. Fix the
  cause, then press "Fixed it: try again", or from a terminal (2.59.0, no hub token needed):
  `npm run studio:resume -- --by <your name> [--why "what you fixed"]`. It prints the halt it cleared, and the next
  pass's `supervisor.resumed` event names who asked (`meta.by`, `meta.why`). Not halted: it says so and does nothing.
  A person decides to retry after repeated failures, so it refuses inside a launched agent session (`STUDIO_ROLE` set)
  and for agents' names (`builder-s3`, `claude-a`, `opus-bot`, any name the launcher handed out). A chat bot that isn't
  launched by the harness can still type a person's name: to narrow who may resume, set `STUDIO_RESUME_BY=<name>[,<name>]`
  in `.env` (off by default). A session someone stopped or paused (`agent stop`, Pause, Stop all)
  never counts: the stop is written down before the kill, so its end reads "stopped by <name>"
  (`meta.stoppedBy`), not "exit 1", and its hand-back says "a stop, not a failure" (no park, breaker or tier-up).
  While the supervisor is halted, or nothing can start agents, a queued rescue's pick-up clock
  (`STUDIO_RESCUE_WAIT_MIN`) is stopped and the Producer is told once; it counts again from when agents can start.
- **Only real limit errors count as out of quota** (a 429, "usage limit reached", "credit balance is too
  low"). `STUDIO_QUOTA_SKIP=off` turns quota-skipping off entirely when you watch usage outside the harness.
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
(`STUDIO_STOP_COOLDOWN_MIN`). "Stop all" also stops running agents and hands their tasks back.

## Crew watchdog, futility cap, wind-down and janitor (2.68.0)

Each supervisor pass (code only, no model) also does three things:

- **Crew watchdog** (`harness/crew-watch.mjs`): per role, over the last `STUDIO_CREW_WINDOW_MIN` (60) minutes, its
  sessions, sessions with no commit, short exits (under `STUDIO_CREW_SHORT_SEC`, 180 s), tokens and tasks landed. More
  than `STUDIO_CREW_MAX_SESSIONS` (6) sessions and 0 landed: the role isn't launched (running sessions go on), one
  `crew.unhealthy` event goes to the Producer with the evidence, and the digest and `npm run status -- --brief` show it.
  It resumes on its own when a task the role worked lands or new work for it appears, or on
  `npm run crew -- resume <role> --by <name>` (a person, an agent under the owner's delegation for hold, or a
  Producer/Director session or outside agent with `--permission "<the person's words>"`; never a worker). `npm run crew`
  shows each role's hour. `STUDIO_CREW_WATCH=off` turns it off.
- **Futility cap, shadow first** (`harness/futility.mjs`): a running session past the 90th percentile of its task
  type's successful sessions (weighted tokens, or wall time) raises one `futility.check` ("past the p90 of good runs").
  Fewer than `STUDIO_FUTILITY_MIN_N` (20) successful sessions of that type: no cap. `STUDIO_FUTILITY=shadow` (default)
  stops nothing; when the session ends, `futility.shadow` and `.studio/futility-log.jsonl` record what a cap would have
  saved and whether it would have cut a good run short. `=on` also hands the task back (the diff is saved, the lane copy
  kept); `=off` turns it off.
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

## What the owner sees

- Ops: "Running unattended" (since when, sessions, tasks done, tokens, why nothing started), the
  budget per tool, and each agent's work in progress ("main.js +120/−40, last verify 2 min ago")
  and what it says it is doing (`npm run agent -- now "…"`).
- Progress by phase: "Phase 1: 12/15 · exit 3/5 · Phase 2: not planned yet". The exit checklist is
  `studio/bible/PHASE-<n>-EXIT.md`.
- Golden changes as cards: the commit's `Golden-Reason:` and which recorded numbers moved, with
  "Looks right".
- The Arcade: the last good build to play.
