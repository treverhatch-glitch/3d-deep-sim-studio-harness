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
| Remote (2.77.0) | When the local builders are at their target, the remote-eligible ready tasks (`npm run remote -- mark`) are offered to remote (cloud) workers, at most `STUDIO_REMOTE_MAX` out: a `remote` line and `remote: { on, out, queued, max, leases, offer, why }` in the status, one `remote.offer` event when the offer changes. With `STUDIO_REMOTE=on` the pass also ends leases that ran out (the claim released, the task back on the board) and starts a background `remote -- fetch` every `STUDIO_REMOTE_FETCH_MIN` minutes while a lease is out (docs/REMOTE-WORKERS.md). | Leases that ran out; a background fetch. |
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
| `STUDIO_LINE_PROTECTED_HOLD_MIN` | `120` | How long a task whose protected step was routed to an approver is held from new builders (or until an approval names it). |

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
