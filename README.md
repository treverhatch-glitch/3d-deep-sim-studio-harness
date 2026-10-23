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

MIT licensed.
