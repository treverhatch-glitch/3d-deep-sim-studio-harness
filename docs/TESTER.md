# The game tester (2.79)

A green task says its own tests passed. It doesn't say a player can play the game. The game tester is an agent session
that plays the game's real build in a real browser, the way a player would. It checks the Game Bible against what is
actually in the game, and it reports with screenshots. The owner's words: "a test to be sure that the game bible is being
applied into actual gameplay and to catch what is/isn't in the game as well as gameplay bugs".

- Code: `harness/tester.mjs` (schedule, plan, brief, build, report), `qa/tester-drive.mjs` (the browser driver the agent
  calls), `harness/tester-config.mjs` (the game's config). Role card: `studio/roles/qa-playtester.md`.
- The Line Producer owns the schedule (docs/LINE-PRODUCER.md). The launcher starts the agent (`harness/agent.mjs`) in its
  own lane copy, like a builder. Nobody starts a tester session by hand.

## Configure it: studio/game.json "tester"

```json
{
  "game": "<your game>",
  "tester": {
    "build": "npm --prefix game/<your game> run build",
    "dist": "game/<your game>/dist",
    "page": "index.html",
    "testids": true,
    "modes": [{ "name": "a quick start", "query": "start=quick" }, { "name": "sandbox", "query": "sandbox=1" }],
    "styles": ["cautious", "greedy", "ignore-staff", "max-speed", "idle"],
    "goals": ["reach the first milestone", "survive 10 minutes", "reach the first failure state"],
    "areas": ["first minutes", "core loop", "economy", "HUD and panels", "save and load"]
  }
}
```

| Key | What |
|---|---|
| `build` | The command that builds the game. It runs from the repo root of the tester's own clean copy, at the studio branch's commit. |
| `dist` | The folder the build makes, served as-is (its `page`, default `index.html`). |
| `url` | Optional: the game's own dev server. When this is set, nothing is built or served. |
| `testids` | `true` when the game marks its controls with `data-testid`. The tester then clicks by test id first. |
| `modes` | The start modes: names, or `{ "name", "query" }` where the query is added to the page URL. |
| `styles`, `goals` | The play styles and goals a run is picked from. The defaults are the ones shown above. |
| `areas` | The area names the tester gives verdicts for (green, amber, red). The regression sweep rotates through them, one area per run. |

`studio/game.json` is a protected file, so the owner approves the change (`npm run approve -- protected`). With no
`tester` object, the tester falls back to the cartridge's browser contract (`cartridges/<name>/qa.mjs` `browser`:
`{ dist, build }`, `{ url }` or `{ page }`) and says so in its brief and in `npm run tester -- status`.

## When it runs

- **On a schedule.** A run starts when BOTH of these are true: `STUDIO_TESTER_EVERY_HOURS` (24) have passed since the
  last run (or since the tester first looked, if there has been no run yet), AND `STUDIO_TESTER_MIN_LANDINGS` (10) game
  landings (`task.train.landed`, `lane.merged`) happened since then.
- **On demand.** Anyone may run `npm run tester -- now [--seed <n>]`. If a supervisor is running, the Line Producer
  starts the run on its next pass. If not, the command starts the run itself.
- `STUDIO_TESTER=off` turns the schedule off. On demand still works.
- Only one run goes at a time (`.studio/tester/run.lock`).

It never blocks production:

- It takes no `machine:heavy` slot and no train or gate slot.
- It waits, and never preempts, while the machine is starved (the Line's CPU and RAM check). It also waits while every
  gate slot is taken, while the train runs or waits, or while a quiet hold is on.
- Its build runs as a normal child process, but only once a gate slot is free.
- Its session takes its own seat (the launcher's extra allowance), so no builder is displaced.
- Its verdicts hold nothing up: no task hold, no gate, no blocked plan slice or landing.

## What a run does

1. **Plan.** A seeded RNG picks a start mode, a play style and a goal. The seed is in `run.json`, and
   `npm run tester -- now --seed <n>` repeats the same plan.
2. **Brief.** The brief (`.studio/tester/runs/<id>/brief.md`) lists three things:
   - the features that landed since the last run, with their titles and plan items;
   - this run's regression area;
   - every feature in the Game Bible: kept layers, approved ideas, system specs and controls (`harness/bible.mjs`).

   Every `STUDIO_TESTER_COMPARE_EVERY`th run (default 3; `0` turns it off), the brief also lists the Bible's genre
   references, and the tester reports where the game drifts from them or has gaps.
3. **Build.** The tester builds at the studio branch's commit in `.studio/tester-wt` and keeps the dist in the run
   folder. A failed build ends the run red, without starting an agent.
4. **Play.** The launcher starts a `qa-playtester` session. The tool comes from `STUDIO_TESTER_TOOLS` (default: the
   studio's builder tool). A comma list such as `claude,agy` alternates runs between two model families, and
   `tool:model` pins a model. agy runs with the same flags the launcher gives builders. The agent drives the build with
   `qa/tester-drive.mjs`, looks at its screenshots, and writes `report.md` and `summary.json`.
5. **Finish.** The agent runs `npm run tester -- finish`. If the session ends without doing that, the next pass
   finishes the run.

## Reading the report

Each run is published in `qa/reports/tester/<date>-r<n>/`:

- `report.md`: what the tester did and saw.
- `summary.json`: `{ run, plan, verdicts: { <area>: green|amber|red }, bible: { <feature>: { status, shot } }, bugs: [...], compare, problems }`.
  A Bible feature's `status` is `working` (in the game and working), `broken` (in the game but broken), `missing`
  (not in the game) or `not-reached` (not reached this run).
- `shots/`, `actions.jsonl` (every action, with its step and time), `brief.md`, `build.json`.

When a run ends:

- **Bug tasks.** Each bug becomes a P1 task titled `Bug: <title>`. Its repro steps and the replay command go in the
  task, and its images are copied to `studio/proof/<task>/`, along with `tester-<run>.md`. A bug whose title matches an
  open task is not filed again.
- **One inbox item** for the Producer, the Director and the orchestrator, in `studio/producer/INBOX.md`, plus a
  `tester.report` event.
- **One Studio Status line** through the Communicator.

To reproduce a bug: `node qa/tester-drive.mjs replay qa/reports/tester/<run>/actions.jsonl --to <step>`. This replays
the run in a fresh browser up to that step and saves `replay-<step>.png`, with the game's state when the game exposes it.

`npm run tester -- status` shows the last run, its verdicts and bugs, the run going if there is one, and when the next
run is due.

## The driver (for the tester agent)

```
node qa/tester-drive.mjs serve | open [--query q] | click --testid <id> | --text "<label>" | --xy x,y
node qa/tester-drive.mjs key <Key> [--times n] | drag --from x,y --to x,y | wait <ms> | shot <name>
node qa/tester-drive.mjs console | state | close | replay <log> [--to <step>]
```

The browser stays open between calls. The first call starts a background driver (its port and pid are in
`<run>/driver.json`). The driver ends on `close`, or after `STUDIO_TESTER_DRIVER_IDLE_MIN` (20) idle minutes. It serves
the dist with the shared static server (`qa/static-serve.mjs`), the same one `npm run shot` uses.

## Wire-it tasks

Sometimes a task lands with game code that nothing in the game imports. Its done-check notes this as `task.unwired`.
For each module that is still unreached on the main checkout, the Line Producer then files ONE follow-up task, "Wire
<module> into the game" (P2). It files only one per module, and none if a task with that title is already open.
`STUDIO_TESTER_WIRE_TASKS=off` turns this off.

## The stage-1 playtest

If a studio's game has its own build (`studio/game.json` "tester") or its own checks (its `studio.gates.json`, or
`<sim>/qa.mjs`), the template cartridge's stage-1 playtest no longer runs for each task. The done-check's playtest rows
and the `playtest` gate say "replaced by the game tester (npm run tester)" instead. A template studio (no game, or a
cartridge game) keeps the stage-1 playtest as before, and so does `STUDIO_STAGE1_PLAYTEST=on`. Where a playtest row is still
asked (a game with no build or checks of its own yet), a tester run (`qa/reports/tester/<run>/summary.json`) newer than the task
start and the last change to the game meets it (2.79.1); with `STUDIO_STAGE1_PLAYTEST=on` it does not.

## Settings

| Setting | Default | What |
|---|---|---|
| `STUDIO_TESTER` | `on` | `off`: no scheduled runs (on demand still works). |
| `STUDIO_TESTER_EVERY_HOURS` | `24` | The minimum hours between scheduled runs. |
| `STUDIO_TESTER_MIN_LANDINGS` | `10` | The minimum game landings between scheduled runs. Both this and the hours must be met. |
| `STUDIO_TESTER_TOOLS` | the builder tool | The tool for the tester session. A comma list alternates runs (`claude,agy`), and `tool:model` pins a model. |
| `STUDIO_TESTER_COMPARE_EVERY` | `3` | Every Nth run also compares the game with the Bible's genre references (`0`/`off`: never). |
| `STUDIO_TESTER_WIRE_TASKS` | `on` | `off`: no "Wire <module> into the game" tasks. |
| `STUDIO_TESTER_BUILD_TIMEOUT_MIN` | `20` | How long the tester's build may run before the run ends red. |
| `STUDIO_TESTER_DRIVER_IDLE_MIN` | `20` | How many idle minutes before the background driver closes the browser and exits. |
| `STUDIO_STAGE1_PLAYTEST` | `auto` | `on`: keep the template cartridge's per-task stage-1 playtest even in a studio whose game has its own build or checks (as in 2.78.2). |
| `STUDIO_VISUAL_GATE` | (unset) | `off`: a render task needs no visual result. `on`: it always does. Unset: it does, unless the game has its own folder and no capture command (`"visual": { "capture" }` in its `studio.gates.json`, or a Godot project): then the gate is off and `task done` says so (2.79.1). |
| `STUDIO_HEARTBEAT_EVENT_MIN` | `10` | Minutes between a session's `agent.heartbeat` events (the beat itself, and `lastBeat`, stay every `STUDIO_HEARTBEAT_SEC`); `0`: every beat. |
| `STUDIO_TESTER_RUN_DIR` | (the run going) | The run folder the driver uses when `--run` isn't given. |
