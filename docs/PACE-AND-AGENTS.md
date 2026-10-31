# Pace, MAX SPEED and starting agents

## Pace

The game dev chooses how fast the studio works, at intake, in the War Room's Game plan view, or with
`npm run mode -- set <mode> --by <name>`. Every change is logged in `studio/mode.json`.

| Pace | Agents at once | Reviews from another model family | Starts agents itself | Director / Producer check-ins |
| --- | --- | --- | --- | --- |
| Precise and slow (default) | 2 (1 builder) | every build task | no | 24 h / 8 h |
| Budget: cheaper and slower | 1 | whole systems | no | 24 h / 12 h |
| Fast and furious | 4 (3 builders) | whole systems | yes | 12 h / 4 h |
| Prototype sprint | 4 (3 builders, one per lane) | whole systems | yes | at phase end / 2 h |
| Extreme speed | 8 (5 builders) | whole systems | yes | 6 h / 2 h |

**Prototype sprint** is SendIt's way of working inside the harness, for getting to something you can
play:
- **One lead:** the Producer is the one accountable lead.
- **Folders first:** the game is split into folders from the start, and each builder holds its own lane.
- **Merge rules:** a builder's work merges only when the gate that plays the game passes and the lead has
  looked at its before/after frames (`npm run shot`).
- **One Director review per phase,** not one per task.
- **The phase closes** when a person plays a build in the Arcade and says it's fun.

## MAX SPEED

A lever in every War Room view (and `npm run mode -- boost on|off --by <name> [--hours 4]`). On top
of any pace: twice the agents (up to 12), agents start automatically, the Director checks in about
four times as often and the Producer every hour. Going faster without the leads looking more often is
how studios drift; the lever does both.

## Starting agents

```bash
npm run agent -- start --role builder --agent builder-1 --tool claude --model claude-sonnet-5-5
npm run agent -- list
npm run agent -- stop builder-1
```

Or the War Room's **Start agent**. Set defaults in `.env`: `STUDIO_AGENT_TOOL` and `STUDIO_AGENT_MODEL`,
or per role (`STUDIO_BUILDER_TOOL`, `STUDIO_DIRECTOR_MODEL`, …). `STUDIO_<ROLE>_CMD` replaces the whole
command for tools the launcher doesn't know (Hermes, a script); `{kickoff}`, `{agent}`, `{model}` and
`{role}` are filled in.

The launcher:
- refuses to start past the pace's caps, while the studio is stopped, or when the daily token cap is spent;
- passes the kickoff on stdin or as one argument, so the same command works on Windows, macOS and Linux
  (agy gets `--print-timeout 900s` and a closed stdin; in a frozen clone Codex can run without its
  sandbox with `STUDIO_CODEX_BYPASS=1`, and agy without its prompts with `STUDIO_AGY_BYPASS=1`);
- sends a heartbeat every 2 minutes; the War Room shows "Agent stalled" when it stops. A session whose
  process is still alive but whose heartbeat is older than `STUDIO_STALL_RELEASE_MIN` (30 min; 0 turns it off)
  is freed by the watcher: its uncommitted work is saved to `.studio/wip/`, its task goes back to the queue with
  a note, its claims are released and the session is marked ended ("stalled"), so its slot is free. Nothing is
  killed (event `agent.stall_released`): end the process by hand if it is stuck. Right after the machine slept
  (the watcher's own last pass is as old as the threshold) it waits one pass for the heartbeats to come back;
- when an agent dies (exit code, usage limit, 429, auth), hands its task back with a note, saves its
  uncommitted work under its claims to `.studio/wip/<task>-<agent>.patch`, frees its claims, and with
  `--fallback codex:gpt-6-sol,claude:claude-sonnet-5-5` starts the next tool on the same task.

In fast paces and with MAX SPEED, the watcher (run by the HUB) starts agents for waiting tasks itself.

A `--note` reaches the agent's prompt inside the block marked "written by agents or people", labelled with its
sender (`--by`, or "unknown"); see docs/SECURITY.md.

## Hiring into departments

The Producer runs the studio. It opens departments, writes tasks, and hires agents into them. The game dev
can do the same from the War Room. The Director doesn't hire: it files corrections, and the Producer
acts on them.

```bash
npm run division                                    # every department, on or off, and its roles
npm run division -- open sound --reason "floor one needs footsteps" --by producer-1
npm run division -- close sound --reason "done for phase 1" --by producer-1
npm run agent -- hire --role sound-designer --division sound --next --by producer-1 \
  [--open] [--note "keep it subtle"] [--loop until-empty|3] [--lane public/audio]
npm run agent -- pause audio-1 --note "wrong floor"  # stops it and hands its task back with the note
npm run agent -- logs audio-1                        # its output so far
```

- `hire` is `start` with a department. The agent is named for you (`sound-designer-2`) unless you give `--agent`.
  `--next` takes the top waiting task for its role.
  - `--division` seats the agent in that room whatever its name, and `--open` opens the room if it's locked.
  - `--note` goes into its prompt as "Note from producer-1: …".
  - `--loop` keeps it taking tasks until the queue is empty, or for N tasks.
- Opening or closing a department needs a reason. Reasons are logged in `studio/decisions/divisions.md`.
- In the War Room, every open room has a **+ Hire** button. It hires the room's first role on the next waiting
  task, and the desk appears within seconds. Agents started from the War Room have a **Pause** button in Ops.
- **The Producer's limit:** it hires on its own up to `producerMayHireUpTo` running agents (in `studio/budget.json`;
  the default is 4). Past that, the hire becomes a "Needs you" question. Saying yes starts the agent.
- **Refused:**
  - a hire by the Director;
  - in a frozen clone, a lane inside `harness/`, `hub/`, `qa/` or `scripts/`;
  - any hire past the pace's caps, while the studio is stopped, or once the daily token cap is spent.
- **Departments and their roles.** Always on:
  - Producer
  - Engineering: builder
  - QA Lab: qa-playtester
  - Design & Balance: rnd, designer-calibrator, planner
  - Review: reviewer

  On by default:
  - Art: art, artist, art-director

  Off until opened:
  - Sound Studio: sound-designer, composer
  - 3D: asset-3d
  - Localization: localizer
  - UI & Accessibility: ui-designer
  - Narrative: writer
  - Release & Store: release-manager
  - Devlog: devlogger
  - Engine Transfer: engine-porter
  - Dev Hacker Lab: dev-hacker (docs/DEV-HACKER.md)
- The run report's **Staffing** section lists who was hired, by whom, into which room, how long they worked, and their tokens.
- In a frozen clone, `STUDIO_CLAUDE_BYPASS=1` lets claude agents run without permission prompts.

## War Room actions reach agents

What the game dev does in the War Room starts the agent that should act on it, if a tool is set for
that role and the pace's caps allow it (a person asked, so this works in every pace):

| In the War Room | Goes to | Starts |
| --- | --- | --- |
| Pitch an idea | the Idea Board, straight to R&D | an R&D agent |
| Message the Producer | the Producer's inbox | the Producer, if none is running |
| Answer follow-up questions | the Game Bible | the Director |
| Say yes to a Liaison brief | R&D (an idea) or the Producer | that agent |
| Ask for changes to a design | an art task with your words | the art department |

Each answer says what happens next in one line: who has it, whether an agent started, or what to set
so one can (`STUDIO_AGENT_TOOL` or `STUDIO_<ROLE>_TOOL`).

## The Liaison chat

The Game plan view has a chat with the Liaison, on a cheap model through the router (Ollama or a free
key; the daily token cap applies). It asks until it understands, then reads back a brief: an idea, a
direction, an asset or a question. Nothing is sent until you press **Yes, send it**; correcting it in
the chat changes the same brief. The conversation is kept in `studio/liaison/chat.md`.

## Questions with a deadline

```bash
npm run ask -- "Which floor first?" --options "Cubicle,Food court" --default Cubicle --timeout 4h --why "it teaches the controls"
```

The question shows under **Needs you** and in the Game plan, answered with one click. If nobody answers
in time, the default applies, logged in `studio/decisions/decided-without-you.md` and the run report;
the dev can reverse it. Signing, pillars, money and deleting never get a deadline.
