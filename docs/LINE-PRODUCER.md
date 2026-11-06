# The Line Producer (2.76.0)

The owner asked for "the line producer with the logic of keeping things running and watching the rigs available
resources and handing out tasks based on priority and free resources as well (also considering additional research,
building out the game with early, mid, late game in mind, and working with and through the director and planning with
the producer)". It is `harness/line-producer.mjs`: code on the supervisor's loop, no model, no tokens. Its role card
is `studio/roles/line-producer.md` (the chain of command: the Director plans, the Producer approves, the Line Producer
executes and reports up).

## What one pass does

`npm run studio:start` runs `lineProducerPass()` once per pass, before the supervisor picks what to start:

| Step | What | Changes anything? |
|---|---|---|
| Builders | N = min(the pace's builder count, what the rig can carry): RAM room after the heavy claims (2.78.1: and a running engine train's RAM between its land runs, `heavy-budget.mjs` `engineTrainReserve`, `STUDIO_ENGINE_TRAIN_RESERVE`) / `STUDIO_LINE_BUILDER_GB`, and no new builder while the CPU is at `STUDIO_LINE_CPU_BUSY_PCT`. The rig comes from `harness/rig-budget.mjs` `rigBudget()` when it is there, else the machine scan and heavy claims (`harness/heavy-budget.mjs`). | It can hold builders back when the rig is full; it never starts more than the pace allows. |
| Blocked | For every waiting task, why it can't start: trunk, chain, park, cooldown, block, budget, lock, busy, merge, yes, held, lane. | Mechanical fixes only (below). |
| Fixes | A lock whose holder's session is over (freed); a lane queued for the train whose copy is gone (recreated from its branch, never while a train runs); a cooldown, block or park whose time has come (cleared). Each one is logged in `.studio/line/actions.jsonl` and as a `line.fixed` event. | Yes: routine harness housekeeping. |
| Chain-breakers | A task `STUDIO_LINE_CHAIN_MIN` (3) or more open tasks wait on (directly or down a chain): first in the order, on the strongest model. | The supervisor's order. |
| Models | Size 1-2 cheap, 3 (or none) mid, 4-5 top, one tier up per red round; models from the 2.73 routing tiers (`studio/policy.json` "routing".tiers, only listed models) else `STUDIO_TIER_<TIER>_MODEL`. A task that already started keeps its model; a rescue keeps the rescue model; no model for the tier: the launcher's default (nothing changes). Only on the role's preferred tool, never on a custom command. A routed start is a `model.routed` event with arm `line-producer`. | The model of a new session. |
| Expansion | round(N × `STUDIO_LINE_EXPANSION_SHARE`) builders on research/expansion work (a research/study/idea task, an engine track, or a `Research:` / `Expansion:` title), the least-covered phase (1 early, 2 mid, 3 late) first. Under `STUDIO_LINE_EXPANSION_MIN` such tasks open: ONE "Director: next ranked slice for phase N" task (never two open). | One Director task. |
| Lanes (2.78.1, B-123) | Each ready builder task with no lane (and not the whole game on purpose) gets one worked out from its `--scope` globs (their folders), the code paths its title, `--asked` text or its own hand-off note names (existing paths outside `studio/`, `docs/` and the harness), the files its title points at, and plan-waves' predicted files (its overlap history). The lane goes where the supervisor reads it (`studio/task-holds.json` "lane", as `task lane` writes it), as the Producer's decision (a `task.lane` event, `.studio/decisions.jsonl` action `task-lane`). A ready task it can't scope is listed as blocked kind `unscoped` (it still runs, alone) and in the Producer note when more than one builder could run; a running task with no lane is only reported. `STUDIO_LINE_LANES` (`harness/lane-plan.mjs`). | A task's lane. |
| Phase awareness (2.78.1) | A ready builder task whose lane or predicted files touch shared sim code (`STUDIO_SHARED_SIM`, else the game manifest's `"sharedSim"`, else the default: a cartridge's `index.*`/`sim.*`/`core/`/`systems/`, a sim folder's `sim.*`, `index.*`, `core/`, `systems/`, `shared/`, `types.*`) waits (`--after`) for the open task before it (in progress first, then the order) that touches the same shared files: a chain, never side by side. Logged as the Producer's decision (`task-stack`) and in the status (`lanes.stacked`, the "Stacked on shared sim code" line). | A task's `--after`. |
| Producer note | When the plan can't run (a chain-breaker waiting on a yes, a park or a hold; free builder slots and every builder task blocked; a chain on a task that isn't on the board; a red trunk): `.studio/line/producer-note.md`, and a `line.plan_blocked` event when the reasons change (`line.plan_ok` when it clears). It never changes direction itself. | A note. |
| Remote (2.77.0) | When the local builders are at their target, the remote-eligible ready tasks (`npm run remote -- mark`) are offered to remote (cloud) workers, at most `STUDIO_REMOTE_MAX` out: a `remote` line and `remote: { on, out, queued, max, leases, offer, why }` in the status, one `remote.offer` event when the offer changes. With `STUDIO_REMOTE=on` the pass also ends leases that ran out (the claim released, the task back on the board) and starts a background `remote -- fetch` every `STUDIO_REMOTE_FETCH_MIN` minutes while a lease is out (docs/REMOTE-WORKERS.md). | Leases that ran out; a background fetch. |
| Status | `.studio/line/status.json`: `{ at, builders: { running, target, why }, blocked: [{ task, why, fix }], lanes: { set, unscoped, running, stacked, shared }, chainBreakers, expansion: { share, byPhase }, rig, order, routes, actions, text }` (`text`: one plain line, "Line: 2/5 builders; 4 blocked (2 chain, 1 yes, 1 park); …") — what the Communicator posts (`lineStatus()`), and what the supervisor follows. | — |

| Chain-breaker push (2.78.1) | While a chain-breaker is queued for the merge train (`.studio/train/queue.json`, not held for a person), a quiet hold (`harness/heavy.mjs` `markQuietHold`, tag `chain-breaker`, the 2.78.0 C2c mechanism): heavy work that isn't a game landing (builders' verifies, an engine land) waits in the heavy queue, so the train's checks get a quiet machine. Running jobs are never stopped. Bounded by `STUDIO_LINE_CHAIN_HOLD_MIN` from when the chain-breaker was queued; cleared when none is queued or the supervisor is gone. `chainPush` in the status. | A hold marker in `.studio/locks/`. |
| Engine twins (2.78.1) | When a game task lands (a `task.done` event) and its commits on the main branch (messages naming the task) change a file an engine's twin paths list (`studio/game.json` `engines.<name>.twins`: globs, or `{ "paths": [...], "role", "priority", "branch": "<engine>/twin-{task}", "lane" }`; none listed by default), ONE twin task: `<Label> twin of T-n: <title>`, role `engine-porter`, track `engine:<name>`, its branch, stacked `--after` the landed task and that engine's open twins. A task that matches nothing is reported "no twin needed". Each landed task is looked at once (`.studio/line/twins.json`; the first pass only starts the record). `twins` in the status; `STUDIO_LINE_TWINS=off` turns it off. | One engine task per matching landing. |
| Game tester (2.79) | The Line owns the game tester's schedule (`harness/tester.mjs`, docs/TESTER.md): a run is due when `STUDIO_TESTER_EVERY_HOURS` (24) AND `STUDIO_TESTER_MIN_LANDINGS` (10) game landings passed since the last one, or someone ran `npm run tester -- now`. It starts only while the rig isn't starved (the same CPU and RAM check as builders) and a gate slot is free; it takes no slot itself and waits rather than preempts. A run goes build, then the tester agent (its own seat), then the report. Its verdicts hold nothing. A landed module nothing in the game imports (its done-check's `task.unwired` note) gets ONE "Wire <module> into the game" task (P2, `STUDIO_TESTER_WIRE_TASKS`). `tester` in the status. | A build in its own clean copy, one agent session, bug and wire tasks. |
| Status | `.studio/line/status.json`: `{ at, builders: { running, target, why }, blocked: [{ task, why, fix }], chainBreakers, expansion: { share, byPhase }, rig, order, routes, actions, text }` (`text`: one plain line, "Line: 2/5 builders; 4 blocked (2 chain, 1 yes, 1 park); …") — what the Communicator posts (`lineStatus()`), and what the supervisor follows. | — |

Beta mode: the fixes above are housekeeping, never an owner decision. A yes, an unpark or an unhold is only reported,
naming who may act for the owner (beta mode's agents; the owner's delegate via `harness/delegation.mjs`).

## Commands

- `npm run line -- status [--json]` — the last pass (a dry pass when there is none).
- `npm run line -- plan [--json]` — a dry pass now: the order, the routes, what it would fix. Changes nothing.
- `npm run line -- why <T-ID> [--json]` — why that task isn't running and what would start it.

## Settings

| Setting | Default | What |
|---|---|---|
| `STUDIO_LINE_PRODUCER` | `on` | `on`: the pass fixes, files and the supervisor follows its plan. `report`: status only (no fixes, no task, the supervisor ignores it). `off`: nothing. |
| `STUDIO_LINE_EXPANSION_SHARE` | `1/6` | The share of builders on research/expansion (`1/6`, `0.2`, `20%`; `0` off). |
| `STUDIO_LINE_EXPANSION_MIN` | `2` | Fewer open research/expansion tasks than this: ask the Director for the next slice. |
| `STUDIO_LINE_CHAIN_MIN` | `3` | How many waiting tasks make a chain-breaker. |
| `STUDIO_LINE_BUILDER_GB` | `1` | RAM per builder session when sizing N from the rig. |
| `STUDIO_LINE_CPU_BUSY_PCT` | `90` | CPU busy at or above this (the last machine scan): no new builder. |
| `STUDIO_LINE_RIG` | (auto) | `heavy`: read the heavy budget even when `harness/rig-budget.mjs` is there. |
| `STUDIO_LINE_PLAN_MAX_SEC` | `300` | The supervisor ignores a status older than this. |
| `STUDIO_LINE_LANES` | `on` | 2.78.1 (B-123): `on`: the pass sets lanes on unscoped ready builder tasks. `report`: it says what it would set (`lanes.set`, `dry`). `off`: it sets none (unscoped tasks are still reported). |
| `STUDIO_SHARED_SIM` | (the default list) | 2.78.1: shared sim code for phase awareness, comma-separated globs; `off` stacks nothing. Unset: the game manifest's `"sharedSim"`, else the default (above). |
| `STUDIO_REGION_FILES` | (none) | 2.78.2 (item 9): files that allow region lanes, comma-separated globs (`off`: none). Unset: the game manifest's `"regionFiles"`, else none. See "Region lanes" below. |
| `STUDIO_UNSCOPED_PARALLEL` | `on` | 2.78.1 (B-123): the supervisor runs builders with no lane side by side when both have a prediction (a lane, else plan-waves' `--scope` or overlap history) and they don't overlap. `off`: no lane = the whole game, as before. |

| `STUDIO_LINE_CHAIN_HOLD_MIN` | `60` | 2.78.1: minutes from a chain-breaker's queueing that new builder verifies wait for its train (`0`/`off`: no push). |
| `STUDIO_TESTER` | `on` | 2.79: `off`: the Line starts no scheduled game tester run (`npm run tester -- now` still works). The other `STUDIO_TESTER_*` settings: docs/TESTER.md. |
| `STUDIO_TESTER_WIRE_TASKS` | `on` | 2.79: `off`: no "Wire <module> into the game" task for a landed module nothing imports. |
| `STUDIO_LINE_TWINS` | `on` | 2.78.1: `off`: no engine twin tasks (`studio/game.json` `engines.<name>.twins` lists the game paths that have one). |

| `STUDIO_PLANNING_ROOM` | `on` | 2.78.1 (g): the Line Producer's Planning Room on the War Room's Studio floor (below). `off`: no room; the Line Producer sits in the Production room as before. |
| `STUDIO_LINE_PROTECTED_HOLD_MIN` | `120` | How long a task whose protected step was routed to an approver is held from new builders (or until an approval names it). |

## The Planning Room in the War Room (2.78.1, g)

The owner asked for the Line Producer's own room in the Studio view, "big … so it shows the line producer's plans
plainly and clearly". The **Planning Room** is a room of its own (harness/war-room.mjs `roomFor` seats the role there; the
page draws the room from the HUD's `planning`, beside the Rail Yard and Watchtower) that takes the whole width of the
Studio floor, sits right under the Production room and is taller than the others; the role `line-producer` (its
desk, and any session started in that role, even one hired into Production) sits there. Its wall board shows the plan
in plain text, read from the harness's own files by `harness/planning-room.mjs` (the HUD's `planning` in `/api/hud`, on
the War Room's usual poll; nothing estimated, a field that isn't on file is left out): **Now**, the running builders
(task, title, lane or "whole game", who, model, when it started: the board, the launcher's sessions, `task.start`);
**Next up**, the ready queue in this pass's order (`.studio/line/status.json` "order") with each task's lane, "unscoped"
in the warning color, its wave from plan-waves' last `waves.shadow` event and its model route; **Waiting**, tasks
stacked with `--after` (on what, and why: "shared sim code: <file>" from the pass's stack, which its `task.hold` event
now carries as `meta.via`, else the hold's own words) and the pass's blocked and unscoped tasks with the reason and the
fix; **Last pass**, when, the lanes it set, the stacks it added, its fixes, its one-line status, its Producer-note
blockers, builders running against the target and its recent decisions. With no status on file it says "No plan yet:
the Line Producer hasn't run"; a plan older than `STUDIO_LINE_PLAN_MAX_SEC`, or with the supervisor down, is shown with
its age as "Last plan". The room has no buttons. `STUDIO_PLANNING_ROOM=off` takes it away.

## Model pools: quota-aware routing that prefers Gemini (2.77.0)

The owner: "i'd love to lean on gemini for more tasks and use its usage more than claudes... argon is a solid model,
gemini flash has a bigger usage pool available but less capable". With model pools on (`harness/model-pools.mjs`), the
Models step above routes each task to a **pool**, and the route names its tool too, so the supervisor starts agy for a
Gemini pool and claude for a Claude pool:

| Task | First choice, then the fallbacks |
|---|---|
| small or mechanical (size 1-2, or a chore/docs/test task) | Gemini Flash (the big pool), Argon, Sonnet, Opus |
| normal (size 3, or no size) | Gemini Argon, Sonnet, Opus |
| hard (size 4-5) and chain-breakers | Claude Opus, Sonnet, Argon |
| after a Gemini failure (a hand-back for its own reasons) | Claude Sonnet, Opus (Opus first for hard work, a second red round, or a Claude failure) |

A pool is passed over when it is **near its limit** (`nearPct`, 85 %, of its sessions or tokens in the last 5 hours or
24 hours, or of agy's own quota when it can be read), **marked out** (a usage-limit line: `npm run budget`), or
**dropped for that size class** (it landed under `success.floor`, 34 %, of its last `success.last`, 6, decided sessions
there, with at least `success.minSamples`, 3). A task that keeps handing back a protected step never goes to a pool that
handed one back in the last `protectedHours` (24). A task that already started keeps its model until it lands or fails;
a rescue keeps the rescue model. With every pool on the list passed over, the least-used near one is taken.

- **Data:** `studio/models.json` (optional; `npm run models -- init` writes the defaults to edit): `pools.<name>` `{ tool,
  model, match, sessions5h, sessionsDay, tokens5h, tokensDay, off }`, `routes`, `escalate`, `nearPct`, `success`,
  `protectedHours`. **The default limits are guesses** (no provider publishes agy's pools): set your own.
- **Use** is counted from the studio's own events (sessions started per pool; tokens from session ends, agy's often
  estimated: harness/agent.mjs `agyUsage` records "not reported" and an estimate from text length when agy prints no usage).
- **agy's own quota:** no `agy usage` or `agy quota` command shows in the crew's evidence (only `agy models`), so it is
  read only when `STUDIO_AGY_QUOTA_CMD` names one (for example `agy usage --json`): JSON with per-model
  used/limit/remaining/percent, or text lines like `gemini-… 37%` or `… 120/500`, cached `STUDIO_AGY_QUOTA_SEC` (600)
  seconds in `.studio/routing/agy-quota.json`. **UNTESTED on real agy.**
- **Outcomes:** `.studio/routing/outcomes.json`, rebuilt from the events each pass: per session, its task, model, pool,
  size class and result (landed, handed back, open, or not counted: a usage limit, a person's stop, a refresh), and
  whether the hand-back was a protected step.
- **On:** `STUDIO_MODEL_ROUTING=on`, or by itself (`auto`, the default) when `studio/models.json` exists or agy is
  enrolled (`.studio/agy-settings.json`, `npm run agent -- allow agy`). `STUDIO_MODEL_ROUTING=off`: the tiers above.
- `npm run models -- status [--json]`: the pools (use against the limits, near or out), agy's quota source, the success
  rates per pool and size, and what routing would pick now for small, normal and hard tasks (and after a Gemini
  failure), with why.

### Protected steps go to an approver

A builder (Gemini does this correctly) hands back the part of a task that changes a protected file. In beta mode
(`harness/beta-mode.mjs`: its named agents, else a Producer session) or with the owner proxy (`harness/delegation.mjs`
`delegationFor`; it signs with the owner's recorded yes), the Line Producer routes that step to the one who may approve
it: one `line.protected_routed` event to them per hand-back (the approve command in it), the task shown as blocked
`protected` and held from new builders until an approval names it (`approval.protected` / `.proposal`, or a beta or
proxy approve use) or `STUDIO_LINE_PROTECTED_HOLD_MIN` passes. Without beta mode or a proxy it is only reported: only
the owner approves.

## Region lanes (2.78.2, item 9)

Lane overlap is file-level: two lanes that both touch one big shared sim file never run side by side, and the shared
sim stacking above chains them. A file can opt in to **region lanes**: a lane entry then names a region of it,
`path/sim.ts#symbolName` (a function, method, class or top-level name, as `npm run map -- find` reads them) or
`path/sim.ts#L120-L340` (lines). Several regions are several entries: `task lane T-12 web/<game>/src/sim/sim.ts#tickFlights,web/<game>/src/sim/sim.ts#tickGates --by <you>`
(also `task add --paths …` and `--scope`).

- Two lanes on the same opted-in file run side by side when both name regions and the regions don't overlap, read on
  the main checkout's copy of the file. The same symbol, nested symbols, overlapping lines, a symbol that can't be
  found, a whole-file entry or a folder that holds the file: they clash, as before. A file that isn't opted in is
  always file-level, regions or not.
- The supervisor (`lanesClash`) and the shared sim stacking agree: a region task on an opted-in file is stacked only
  when its regions overlap the earlier task's. Predictions (plan-waves) stay file-level.
- A launched builder whose lane names an opted-in file only by regions doesn't hold it as a file lock while it works in
  its own lane copy (a `lane.unlocked` event says so); with no copy the file is locked as before.
- Landing is unchanged: the train rebases each lane on main, and a real conflict hands the later lane back.
- Everything that works on files (sparse checkouts, gates, path claims, the drift watch, remote leases) sees the file.

Off by default. To turn it on for one file, put it in `.env`: `STUDIO_REGION_FILES=web/<game>/src/sim/sim.ts` (or
`"regionFiles": ["src/sim/sim.ts"]` paths from the repo root in the game's `studio.gates.json`), then give its tasks
region lanes. `STUDIO_REGION_FILES=off` turns it off again.
