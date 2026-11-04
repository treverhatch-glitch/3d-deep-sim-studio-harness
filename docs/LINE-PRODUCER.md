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
| Builders | N = min(the pace's builder count, what the rig can carry): RAM room after the heavy claims / `STUDIO_LINE_BUILDER_GB`, and no new builder while the CPU is at `STUDIO_LINE_CPU_BUSY_PCT`. The rig comes from `harness/rig-budget.mjs` `rigBudget()` when it is there, else the machine scan and heavy claims (`harness/heavy-budget.mjs`). | It can hold builders back when the rig is full; it never starts more than the pace allows. |
| Blocked | For every waiting task, why it can't start: trunk, chain, park, cooldown, block, budget, lock, busy, merge, yes, held, lane. | Mechanical fixes only (below). |
| Fixes | A lock whose holder's session is over (freed); a lane queued for the train whose copy is gone (recreated from its branch, never while a train runs); a cooldown, block or park whose time has come (cleared). Each one is logged in `.studio/line/actions.jsonl` and as a `line.fixed` event. | Yes: routine harness housekeeping. |
| Chain-breakers | A task `STUDIO_LINE_CHAIN_MIN` (3) or more open tasks wait on (directly or down a chain): first in the order, on the strongest model. | The supervisor's order. |
| Models | Size 1-2 cheap, 3 (or none) mid, 4-5 top, one tier up per red round; models from the 2.73 routing tiers (`studio/policy.json` "routing".tiers, only listed models) else `STUDIO_TIER_<TIER>_MODEL`. A task that already started keeps its model; a rescue keeps the rescue model; no model for the tier: the launcher's default (nothing changes). Only on the role's preferred tool, never on a custom command. A routed start is a `model.routed` event with arm `line-producer`. | The model of a new session. |
| Expansion | round(N × `STUDIO_LINE_EXPANSION_SHARE`) builders on research/expansion work (a research/study/idea task, an engine track, or a `Research:` / `Expansion:` title), the least-covered phase (1 early, 2 mid, 3 late) first. Under `STUDIO_LINE_EXPANSION_MIN` such tasks open: ONE "Director: next ranked slice for phase N" task (never two open). | One Director task. |
| Producer note | When the plan can't run (a chain-breaker waiting on a yes, a park or a hold; free builder slots and every builder task blocked; a chain on a task that isn't on the board; a red trunk): `.studio/line/producer-note.md`, and a `line.plan_blocked` event when the reasons change (`line.plan_ok` when it clears). It never changes direction itself. | A note. |
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
