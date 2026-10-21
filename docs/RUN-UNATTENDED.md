# Running the studio unattended

Run #1 stopped at 07:09 with 36 tasks queued: the laptop restarted, the War Room died, and nothing
started again until someone asked. The supervisor fixes that.

## Start it

```bash
npm run studio:start -- --until 23:00                 # until 23:00 (or --until 8h)
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

## Lanes

Two agents in the same files clash, so parallel work needs separate folders. Give tasks a lane
(`npm run task -- add "…" --lane game/<game>/src/floors`); with `--lanes auto` each lane gets its own
agent holding that folder. Split big renderer files early (studio/rules/lanes.md;
`node scripts/check-module-size.mjs`).

## What the owner sees

- Ops: "Running unattended" (since when, sessions, tasks done, tokens, why nothing started), the
  budget per tool, and each agent's work in progress ("main.js +120/−40, last verify 2 min ago")
  and what it says it is doing (`npm run agent -- now "…"`).
- Progress by phase: "Phase 1: 12/15 · exit 3/5 · Phase 2: not planned yet". The exit checklist is
  `studio/bible/PHASE-<n>-EXIT.md`.
- Golden changes as cards: the commit's `Golden-Reason:` and which recorded numbers moved, with
  "Looks right".
- The Arcade: the last good build to play.
