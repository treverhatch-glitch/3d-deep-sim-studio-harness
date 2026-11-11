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
| Unused room (2.81) | The rig only ever lowers N. When the pace is the limit (every builder slot it allows is taken), ready builder tasks wait, and the machine is idle (CPU under 25%, the scorecard's line, and RAM room for more builders than the pace allows), the plan carries `builders.room: { extra, cpuPct, byRam, waiting }` and the summary line says "the machine is idle … the pace is the limit". It starts nothing: the pace is the owner's spend decision (`npm run mode -- <pace>`). No note while an engine land holds the builders. |
| Blocked | For every waiting task, why it can't start: trunk, chain, park, cooldown, block, budget, lock, busy, merge, yes, held, lane. | Mechanical fixes only (below). |
| Fixes | A lock whose holder's session is over (freed); a lane queued for the train whose copy is gone (recreated from its branch, never while a train runs); a cooldown, block or park whose time has come (cleared). Each one is logged in `.studio/line/actions.jsonl` and as a `line.fixed` event. | Yes: routine harness housekeeping. |
| Chain-breakers | A task `STUDIO_LINE_CHAIN_MIN` (3) or more open tasks wait on (directly or down a chain): first in the order, on the strongest model. | The supervisor's order. |
| Models | Size 1-2 cheap, 3 (or none) mid, 4-5 top, one tier up per red round; models from the 2.73 routing tiers (`studio/policy.json` "routing".tiers, only listed models) else `STUDIO_TIER_<TIER>_MODEL`. A task that already started keeps its model; a rescue keeps the rescue model; no model for the tier: the launcher's default (nothing changes). Only on the role's preferred tool, never on a custom command. A routed start is a `model.routed` event with arm `line-producer`. | The model of a new session. |
| Expansion | round(N × `STUDIO_LINE_EXPANSION_SHARE`) builders on research/expansion work (a research/study/idea task, an engine track, or a `Research:` / `Expansion:` title), the least-covered phase (1 early, 2 mid, 3 late) first. Under `STUDIO_LINE_EXPANSION_MIN` such tasks open: ONE "Director: next ranked slice for phase N" task (never two open). | One Director task. |
| Lanes (2.78.1, B-123) | Each ready builder task with no lane (and not the whole game on purpose) gets one worked out from its `--scope` globs (their folders), the code paths its title, `--asked` text or its own hand-off note names (existing paths outside `studio/`, `docs/` and the harness), the files its title points at, and plan-waves' predicted files (its overlap history). The lane goes where the supervisor reads it (`studio/task-holds.json` "lane", as `task lane` writes it), as the Producer's decision (a `task.lane` event, `.studio/decisions.jsonl` action `task-lane`). A ready task it can't scope is listed as blocked kind `unscoped` (it still runs, alone) and in the Producer note when more than one builder could run; a running task with no lane is only reported. `STUDIO_LINE_LANES` (`harness/lane-plan.mjs`). | A task's lane. |
| Phase awareness (2.78.1) | A ready builder task whose lane or predicted files touch shared sim code (`STUDIO_SHARED_SIM`, else the game manifest's `"sharedSim"`, else the default: a cartridge's `index.*`/`sim.*`/`core/`/`systems/`, a sim folder's `sim.*`, `index.*`, `core/`, `systems/`, `shared/`, `types.*`) waits (`--after`) for the open task before it (in progress first, then the order) that touches the same shared files: a chain, never side by side. Logged as the Producer's decision (`task-stack`) and in the status (`lanes.stacked`, the "Stacked on shared sim code" line). | A task's `--after`. |
| Producer note | When the plan can't run (a chain-breaker waiting on a yes, a park or a hold; free builder slots and every builder task blocked; a red trunk; 2.83: a `--after` on a task that is on no list holds only that task and asks the Producer once, `npm run task -- after <task> --remove <missing>`, and is a plan reason only when nothing else can run): `.studio/line/producer-note.md`, and a `line.plan_blocked` event when the reasons change, or at most every 30 minutes while they stand (`line.plan_ok` when it clears). It never changes direction itself. | A note. |
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
| `STUDIO_LINE_HOLD_MAX_MIN` | `20` | 2.79.1: no Line Producer hold on builder verifies lasts longer than this. The chain-breaker hold also ends when its merge train starts running it, and a blocked plan item never stops the rest of the line: a parked chain-breaker pages the orchestrator once (`line.blocker_paged`), lane-less ready tasks are skipped while other work can run and the Producer is asked once to scope them (`line.scope_asked`). |
| `STUDIO_ENGINE_HOLD_MAX_MIN` | `30` | 2.79.1: how long the Line holds new verifies for a queued or near engine land (`0`: no hold). Then `line.engine_hold_expired` (free RAM, the floor, the holders); it comes back at the next natural gap. Docs: ENGINE-TRACKS.md "Room for an engine land". |
| `STUDIO_TESTER` | `on` | 2.79: `off`: the Line starts no scheduled game tester run (`npm run tester -- now` still works). The other `STUDIO_TESTER_*` settings: docs/TESTER.md. |
| `STUDIO_TESTER_WIRE_TASKS` | `on` | 2.79: `off`: no "Wire <module> into the game" task for a landed module nothing imports. |
| `STUDIO_LINE_TWINS` | `on` | 2.78.1: `off`: no engine twin tasks (`studio/game.json` `engines.<name>.twins` lists the game paths that have one). |

| `STUDIO_CHAIN_GATE_N` | `3` | 2.83: one task gating MORE than this many builder tasks that would otherwise start, for `STUDIO_CHAIN_GATE_MIN`, is said once as `line.chain_gate` (warn, to the Producer: which task, how many, since when, where it is, and "split off the parts that do not need it, or remove the dependency"); it repeats at most every 120 minutes while it lasts. State: `.studio/line/state.json`. |
| `STUDIO_CHAIN_GATE_MIN` | `60` | 2.83: how many minutes a task must have gated more than `STUDIO_CHAIN_GATE_N` builder tasks before `line.chain_gate` fires. |
| `STUDIO_PRODUCER_BLOCKED_WAKE_MIN` | `60` | 2.83: while the only blocker is a task in a train or a chain gate (`blocker` in the status), the Producer is woken (queue below target, "N stalled" Watch task) once, then at most once per this many minutes; one `agent.wake.skipped` (at most every 30 min) says why; `0` turns the back-off off. |
| `STUDIO_WAKE_SAME_MAX_H` | `6` | 2.84: the Producer's "queue is below its depth target" wake is skipped while its situation (the count ready, the target, the blocked areas with the kinds of their reasons, the open task ids) is the same as at the last wake and that wake's session changed nothing on the board; never for longer than this many hours since the last wake that ran. It is also the cap of the queue-depth back-off (2.84 a2). `0` or `off`: never skipped and no back-off (as before 2.84). See "Planning wakes need a change" below. |
| `STUDIO_CYCLE_QUIET_MAX_H` | `12` | 2.84: a role's regular development cycle (harness/dev-cycle.mjs, "its regular cycle") is skipped while nothing changed on the board since that role's last cycle session ended; never for longer than this many hours. It is also the cap of the cycle back-off (2.84 a2). `0` or `off`: never skipped and no back-off (2.83's cadence). |

| `STUDIO_LINE_PROTECTED_HOLD_MIN` | `120` | How long a task whose protected step was routed to an approver is held from new builders (or until an approval names it). |

## Planning wakes need a change (2.84)

In one crew's 26 hours about $60 of $82 of Producer and Director spend left no board event: the Director woken 33 times
for its regular cycle, the Producer 50 times because the queue was below its depth target with every area blocked.
`harness/wake-gate.mjs` asks each of those two kinds of wake what changed (a person's request, an ask's answer, an
alert or an owner order wakes as before):

- **Queue below target** (harness/queue-depth.mjs): a fingerprint of the situation. The same as the last wake's, and that
  session ended having emitted none of the board events below: skipped, until `STUDIO_WAKE_SAME_MAX_H`.
- **Regular cycle**, per role (harness/dev-cycle.mjs): a digest of what changed since that role's last cycle session
  ended (landed or done, handed back, held, parked or released, asks opened or answered, a person's messages and
  decisions, tester and playtest findings, a red train or trunk), from the recent-events reader. Empty: skipped, until
  `STUDIO_CYCLE_QUIET_MAX_H`. Not empty: the role is woken, and its brief `.studio/briefs/dev-cycle-<role>.md` opens with
  that digest (ten lines at most); the session's kickoff note says to read it first.
- **Back-off by outcome** (2.84 a2): the digest is rarely empty (hand-backs and parks fill it), so the wake also looks
  at what the last session did. After a cycle session with no board event, that role's next regular cycle waits twice the
  cycle's interval (`STUDIO_DEV_CYCLE_MIN`), then four times, eight times, up to `STUDIO_CYCLE_QUIET_MAX_H`; a session
  that changed the board resets it, a hand-back or a park in the digest does not. Strong news (`STRONG_NEWS_TYPES`: an
  ask answered by a person or the owner's stand-in, a decision made as a person or by the stand-in, a person's message,
  a playtest verdict, a dev yes, the Bible signed, a phase override, a milestone closed) makes the cycle due at once and
  keeps the count; a red train or a hand-back is not strong news. After a queue-depth session that added no task, the next
  queue-depth wake waits twice `STUDIO_QUEUE_DEPTH_ASK_MIN`, then four times, up to `STUDIO_WAKE_SAME_MAX_H`; a session
  that adds a task resets it, a blocked area that frees up or the queue reaching its target ends the wait, new task ids
  alone do not. The skip says "backing off: N cycles in a row changed nothing; next regular cycle at HH:MM UTC (or
  sooner on an answer, an owner order or a phase change)", and the mode line (`npm run mode`) adds the next time while a
  wake is backed off. One off switch per kind: its ceiling set to `0` or `off`.
- **Board events** (one list, `BOARD_EVENT_TYPES`): `task.added`, `task.dropped`, `task.reordered`, `task.reopened`,
  `task.retyped`, `task.hold`, `task.held`, `task.unheld`, `task.unblocked`, `task.dev_yes`, `decision`, `ask.open`,
  `ask.answered`. A Producer or Director session's `agent.session.end` carries `meta.outcome.boardEvents`, how many of
  them it emitted.
- **Events:** `agent.wake.skipped` (meta `kind` `queue-depth` or `cycle`, `role`, `last`: the session it compared with)
  with a plain reason, e.g. "nothing changed since producer-405's session at 14:02 UTC, which planned nothing: 0 ready,
  4 areas blocked". State: `.studio/line/wake-gate.json` (kept across supervisor restarts).
- **Scorecard** (`npm run score`, under the fifteen measures, kept in `--record`): "Planning sessions that changed
  nothing: N of M ($X of $Y)" and "Planning wakes skipped: K".
- **Builders and porters:** before the launcher starts a session for a named task (the supervisor's picks, `agent start
  --task`), it asks what `task start` would ask (holds, parks, trains, the budget, the round cap). A refusal starts no
  session: it says why in `task start`'s own words and emits `agent.start.refused` (the task and the reason).

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
  `protectedHours`, `routeRoles` (2.83: the roles a pool route applies to, default `["builder", "engine-porter"]`; the Director, Producer, Line Producer and reviewers keep their own role model). **The default limits are guesses** (no provider publishes agy's pools): set your own.
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

## Settings that no longer do anything

`STUDIO_PLANNING_ROOM` switched off the War Room's Planning Room page. The War Room went in 2.80.0, so nothing reads it now; setting it changes nothing.
