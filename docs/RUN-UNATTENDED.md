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

- **It runs on its own.** `studio:start` detaches by default, so it outlives the terminal or agent shell that
  started it (run #1: every agent died when the host shell restarted). Its output goes to `.studio/supervisor.log`.
- **Install from a terminal where the agent tool works.** The login job gets that terminal's PATH and HOME
  and the `node` on the PATH; install warns when `claude --version` (or your tool) wouldn't be found.
  Run #1 looped on exit 127 because launchd's PATH had no `~/.local/bin`.
- **Two identical failures stop it.** When two sessions in a row end with the same exit code (127: tool not
  found), the supervisor stops starting agents and shows one "Needs you" card with the reason. Fix the
  cause, then press "Fixed it: try again".
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

`npm run agent -- stop <name>` (and Pause) keep that task from restarting for 15 minutes
(`STUDIO_STOP_COOLDOWN_MIN`). "Stop all" also stops running agents and hands their tasks back.

## What the owner sees

- Ops: "Running unattended" (since when, sessions, tasks done, tokens, why nothing started), the
  budget per tool, and each agent's work in progress ("main.js +120/−40, last verify 2 min ago")
  and what it says it is doing (`npm run agent -- now "…"`).
- Progress by phase: "Phase 1: 12/15 · exit 3/5 · Phase 2: not planned yet". The exit checklist is
  `studio/bible/PHASE-<n>-EXIT.md`.
- Golden changes as cards: the commit's `Golden-Reason:` and which recorded numbers moved, with
  "Looks right".
- The Arcade: the last good build to play.
