# 3D Deep-Sim Studio Harness

A file-based workflow harness for building deep simulation games with any mix of AI agents and people.
It is not a game engine. You bring the game; the harness keeps many agents from breaking it.

- **Pure sim cartridges.** Your simulation lives in `cartridges/<name>/` with no renderer, DOM, randomness
  or clock. Presentation reads state and never writes it, so the sim can be replayed, tested and ported.
- **Seed + tick replay.** Every run is reproducible from a seed and an action list. A failure is recorded
  as the exact tick the cartridge broke on, and `node harness/replay.mjs --trace` stops on that tick.
- **SHA-256 golden hashes.** Pinned SHA-256 hashes for replays and a start-to-win vertical slice,
  checked in Node and independently in Python, with a fast 64-bit display hash for the HUD
  (`docs/HASH.md`).
- **Locks and gates.** Agents claim tasks and paths with unique owners; a pre-commit hook refuses files
  locked by someone else and staged secrets. `npm run verify` runs every gate; `npm run release` is the
  one command before a merge.
- **A closed QA loop that records and escalates.** It never edits code.
- **A zero-token War Room.** A local page that tails the event log. Writes and the live socket need a
  token; it refuses to listen beyond localhost without one.

No game ships in this repo except the example cartridge (`cartridges/example-sim`). Each game lives in
its own repo or private copy and plugs in as a cartridge (`npm run new-game`) or through onboarding
(`npm run onboard`).

## Start

```bash
npm run setup                 # .env with a random HUB_TOKEN, git hooks, .studio/ state
npm run verify                # every gate in studio/gates.json
npm run new-game my-game      # your own cartridge, with real goldens, passing on day one
npm run playtest -- --cartridge my-game
npm run hub                   # War Room on http://127.0.0.1:3847/?token=<HUB_TOKEN from .env>
npm run release               # syntax, required gates, closed-loop proof, read-only gates, changelog
```

On Windows, PowerShell may refuse `npm run …` with "running scripts is disabled on this system" (it
blocks `npm.ps1`). Use `npm.cmd run setup` (and `npm.cmd` for every other command), run `.\setup.cmd`, or
use cmd.exe. Every script runs under plain Node; Git Bash is not needed.

Clone it, keep your copy private if you like, put keys only in `.env` (gitignored). The public repo
contains no keys; `node scripts/secret-scan.mjs` checks exactly what git would publish.

## How work flows

1. `studio/NEXT.md` is the queue. `node harness/task.mjs start T-002 --agent <unique-name>` claims a task;
   a second agent is refused until it is done (`task.mjs done T-002 --agent <same-name>`). `done` checks the
   proof for that kind of task first (a green verify, a regression and lesson for a bug, a sweep for balance;
   see `studio/skills/`). `--force` skips it, logs it and gives the Producer a task to check.
2. Claim the files you will touch: `node harness/lock.mjs claim path:cartridges/my-game --owner <name>`.
3. Change the sim, then `npm run verify`. If you meant to change behaviour: `npm run golden -- --update`.
4. `node harness/closed-loop.mjs` plays the slice; on failure it writes `.studio/last-seed-failure.json`
   and a bug report, then escalates after 3 attempts.
5. `npm run balance` sweeps one `TUNING` knob across seeds; `npm run fun` checks cheap fun proxies.
   A person still signs both off in `studio/balance/` and `studio/fun/`.

## The gates (`studio/gates.json`)

| Gate | Fails when |
| --- | --- |
| `purity` | the sim touches DOM, renderers, randomness, the clock, timers or `globalThis` (static scan + runtime traps), or there are 0 sim files |
| `isolation` | presentation imports or DOM access appear in sim folders, or there are 0 sim files |
| `golden`, `golden-py` | a replay hash differs, a hash is a stub, a game has no golden, or Python's hash of the replayed state disagrees |
| `regressions` | a fixed bug's pinned replay changes or has no hash |
| `vertical-slice` | a game's `start-to-win` scenario does not win, is not deterministic, or drifts from its golden |
| `playtest` | the cartridge throws, freezes, breaks an invariant, drifts on save/load, or replays differently |
| `soak`, `tick-budget` | many seeds expose a failure, or a tick costs more than 1 ms |
| `hub-smoke` | the War Room accepts a write or socket without the token, a foreign Host, or a placeholder token |
| `secrets` | a key-shaped string would be committed |
| `selftest` | any required gate cannot be shown to fail when its rule is broken |

`fidelity` is a scored report, not a gate: it scores the build against the reference game's mechanics listed in the Game Bible's `fidelity` section (fallback `studio/fidelity.json`) and the Director reads it; `npm run fidelity -- --strict` makes it fail on a missing required mechanic.

## The daily token cap (on by default)

Every studio has a daily cap of **50M tokens** (50,000,000 weighted tokens per UTC day, summed across all models, cache reads at a reduced weight set by `STUDIO_CACHE_READ_WEIGHT`; `harness/budget.mjs`, `DEFAULT_DAILY_TOKEN_CAP`). When the day's use reaches it, the launcher stops starting new sessions until the next day. Change it with `STUDIO_DAILY_TOKEN_CAP` in `.env` (a number of tokens, e.g. `STUDIO_DAILY_TOKEN_CAP=80000000`); `off` or `0` turns it off. `npm run budget` shows the day's use against the cap.

## No agent runs forever (2.31.0)

Limits stack, from one session up to the whole studio:

| Limit | Default | What happens |
|---|---|---|
| Refresh point | 40 turns or 120k context | the session hands off and a fresh one continues from the notes |
| Turn ceiling | 80 turns | the session is ended |
| Stall | 15 min with no file, commit or task change | the session is ended, the task handed back |
| Session wall clock | 90 min (25 for planners) | the session is ended |
| **Task budget** | 6 sessions, 240 claimed minutes or 10M tokens per task | the task is parked and climbs the rescue ladder (below) |
| Daily cap | 50M tokens a day | no new session starts until tomorrow |

The task budget counts every session on a task, including builders the harness didn't launch (their claims count). `node harness/task-budget.mjs <ID>` shows the spend; `STUDIO_TASK_MAX_SESSIONS`, `STUDIO_TASK_MAX_MIN` and `STUDIO_TASK_MAX_TOKENS` change it.

## Web and engine tracks land in parallel (2.30p, 2.31.0)

In a lane copy, `npm run verify` and `task done` check only what the lane changed: a Godot-only change runs the Godot gate and skips the web checks, and the reverse. Heavy checks share `STUDIO_GATE_SLOTS` (2) slots on the machine, so one web and one Godot check run at once without timing each other out. Only the final fast-forward and board write take the short land lock.

## Every control is pressed, and only the owner changes the judges (2.32.0)

- **Controls.** The Game Bible lists every control a player has (`studio/bible/controls.json`). Each track's input test presses them for real (the browser check for web, `tools/controls.gd` in the Godot gate) and the `controls` gate fails when one was never pressed or did nothing.
- **Protected files.** Scenarios' expected outcomes, regressions, the controls list, the gates and the checks themselves (`studio/protected.json`) change only with the owner's signed approval: `npm run approve -- keygen` once on your own machine, then `npm run approve -- protected --note "why"` for a change you want. CI checks it with the main branch's copy of the checker, so a branch can't weaken it. A forced `task done` needs `npm run approve -- force <ID>`.

## A stuck task climbs a ladder, not a wall (2.35.0)

A task that uses its whole budget isn't handed straight to you, and no step can jam the studio:

1. **Rescue** on a stronger model from a **different family** than the ones that got stuck, so the same blind spot doesn't repeat. It reads the hand-backs and refusals, writes `studio/rescues/<ID>.md` (a diagnosis and one decision) and either clears the blocker and retries, splits the task into smaller ones, or says a person must decide.
2. **Split rescue** on the next model on the list, when the first rescue is stuck too (its own budget ran out, nobody picked it up in an hour, or its retry got stuck again). This one may only split or ask a person.
3. **Shelved**: the task is parked with the diagnoses, the studio works around it, and it waits in the morning report's "Needs you". Nothing blocks on it.

The models: `STUDIO_RESCUE_MODEL`, then `STUDIO_RESCUE_MODELS` (comma-separated), then `STUDIO_TIER_TOP_MODEL`. Each step picks the first one that is from another family, isn't out of quota or at its spend guard, and wasn't used by an earlier step; then the same family; then the launcher's own choice. `STUDIO_RESCUE_LEVELS` (2) sets the steps before the shelf, `STUDIO_RESCUE_WAIT_MIN` (60) how long a rescue may sit unclaimed, `STUDIO_RESCUE=off` sends budget stops straight to you. A person is needed only for protected files, forced closes, design calls the Bible doesn't settle, or money and accounts.

## The Game Bible says what each control must change (2.39.0)

A control's own test is written by the agents that build the game, so a weak one can pass a button that does nothing. In `studio/bible/controls.json` (which only the owner changes) a control can say what it must change in the game's state, for example `"effect": { "path": "entities.length", "change": "up" }`. The browser check presses it for real and checks that, whatever the game's own test says. Pick a value only that control moves in the moment after the press (income can outrun a purchase's cost).

## Built but not wired (2.38.0)

A system can be finished and tested and still never reach the player, because nothing in the game uses it. `task done` now walks the game from its entry points (index.html, cartridges, Godot's main scene and autoloads) and notes any game file the task changed that nothing reaches. Tests and demo pages don't count. `STUDIO_REACHABILITY=fail` makes it refuse; `npm run reach -- <files>` checks by hand. A game with other entry pages lists them as `"entries"` in its studio.gates.json.

## The whole game is checked after every landing (2.37.0)

A task's own verify only covers the files it touched, so it can't see that it broke something elsewhere. With `STUDIO_WHOLE_GAME=on`, every commit that lands on the studio's branch gets every required check on the whole game, in the background, in a clean copy of exactly that commit. A failure is re-run alone first (so a busy machine isn't blamed on the game); if it is still red, a P0 task names the failing checks and the tasks that landed since the last green run, and the morning report says so. `npm run whole-game` runs it by hand; `-- --status` shows the last result.

## A check that ran nothing is not a pass (2.36.0)

Some test runners exit 0 when no test ran (GUT prints "Nothing was run"; vitest and jest can find no test files). The studio game's checks and the Godot unit gate now spot that and say so in a WARN line; `STUDIO_SILENT_GREEN=fail` makes it fail the check (recommended once a game's tests are set up), `off` turns it off.

## The harness's own numbers (2.34.0)

`npm run harness-health -- --morning` is the morning report: what landed, what needs you (parked tasks, forced work, protected changes waiting for your approval), and how the harness itself did: refusals per landing (target ≤ 1.5), hand-backs the harness caused (target ≤ 5%), verify time, tokens per landing, and builders whose usage wasn't recorded. The hourly run report carries the same numbers.

## The attending game dev is optional (2.30o)

The harness must run without anyone watching. While a studio has an active game, the hub runs the
game-dev loop every few minutes (`STUDIO_GAMEDEV_INTERVAL`, 180 s; without the hub: `npm run gamedev`;
`STUDIO_WATCHDOG=off` opts out): stalled sessions end, a low queue is refilled from unmet charter exit
criteria, met milestones close, idle builder slots fill, landings are checked (layout, visual), a tool at
its quota or spend guard hands over to the next in the budget order, and the Director/Producer
development cycle keeps planning forward. Away mode means more autonomy, not just review logging.

Expected role of an attending game dev (a person or an agent): **optional**. Their input adds tasks or
reprioritises them, approves assumptions the Director marked, and judges whether it is fun. Nothing in
production waits for them; if it does, that is a harness defect.

## Where things are

| Path | What |
| --- | --- |
| `AGENTS.md` | Rules every agent follows (Claude, Cursor, Codex, Gemini, Grok, people) |
| `cartridges/` | Game sims and the contract ([cartridges/README.md](cartridges/README.md)) |
| `harness/` | Loader, replay, closed loop, tasks, locks, events, model router |
| `qa/` | Playtest, goldens, regressions, slice, soak, HUB smoke test, self-test |
| `scripts/` | Gates, setup, new-game, release, balance and fun sweeps, hooks |
| `studio/` | Queue, current task, roles, rules, decisions, memory, balance and fun notes |
| `hub/` | The War Room server and pages |
| `docs/` | Longer guides: routing, Blender, porting, War Room, security |

Model routing (`harness/route.mjs`) fails over between local, free-tier and paid providers using keys
from `.env`. Token-saver tools (rtk, qmd, serena) are optional: `npm run setup:token-savers`.

Recommended habits for GitHub, model providers and multi-agent teams: [docs/BEST-PRACTICES.md](docs/BEST-PRACTICES.md).
Plugging in Claude Code, Codex, Cursor, Grok, Antigravity or Aider: [docs/AGENT-TOOLS.md](docs/AGENT-TOOLS.md).
How a game starts (intake, phases, layers) and stays on course (Director, Idea Board): [docs/GAME-BIBLE.md](docs/GAME-BIBLE.md).
What's next for the harness, and how each known gap gets fixed: [docs/ROADMAP.md](docs/ROADMAP.md).

Proprietary. Copyright (c) 2026 Trever Max Hatch, all rights reserved. See LICENSE.
