---
id: line-producer
title: Line Producer (the flow desk)
tier: lead
department: direction
swarm: core
tools: [line, task, event]
rules: [AGENTS.lite.md]
---

# Role: Line Producer (`line-producer`)

The Line Producer keeps the work moving. It is **harness code on the supervisor's loop**
(`harness/line-producer.mjs`, every pass, no model and no tokens), not a chat session. A small model may be asked for
a judgement call later; the routine part never needs one.

## Chain of command

| Who | Owns | Does |
|---|---|---|
| **Director** | creative direction and the Game Bible | turns the direction into a **ranked, sized plan** (tasks with `--phase`, `--size`, `--after`) |
| **Producer** | approval and the board | approves the plan against the Bible, says yes, parks, holds, re-scopes |
| **Line Producer** | execution | orders the launches, routes the models, schedules the machine, unblocks what is mechanical, **reports up** |

The Line Producer **never changes direction**: it does not add game work, change priorities, say yes to a proposal,
unpark or unhold. When a plan can't run it writes one Producer note, `.studio/line/producer-note.md` ("this plan can't
run because …", with a `line.plan_blocked` event when the reasons change), and keeps it up to date until the plan runs.

## Each pass

1. **Builders:** how many the rig can carry now (the rig budget; the machine scan and heavy claims until it lands),
   against the pace's builder count. It only holds builders back when the machine is full; it never starts more than
   the pace allows.
2. **Why each waiting task can't start:** trunk, chain, park, cooldown, block, budget, lock, busy, merge, waiting on a
   yes, held, a lost lane copy. It fixes the mechanical ones itself and logs each (`.studio/line/actions.jsonl`,
   `line.fixed` events): a lock whose holder's session is over, a train lane whose copy is gone (recreated from its
   branch, never while a train runs), a cooldown, block or park whose time has come. Everything else names who acts.
3. **Chain-breakers first:** a task 3 or more open tasks wait on starts before anything else, on the strongest model
   (no model trials on it).
4. **Models by size:** size 1-2 cheap, 3 mid, 4-5 top, one tier up per red round, from the 2.73 routing tiers
   (`studio/policy.json` "routing".tiers, else `STUDIO_TIER_<TIER>_MODEL`). A task already started keeps its model; a
   rescue keeps the rescue model; no tier model set means the launcher's default.
5. **Research and expansion:** a share of the builders (1 in 6 by default) on research/expansion work, balanced across
   the Bible's phases (early, mid, late). When that queue runs low it files **one** task for the Director: "Director:
   next ranked slice for phase N". Director: answer it with ranked tasks titled `Research: …` or `Expansion: …`, each
   with `--phase N --size 1-5`.
6. **Lanes (2.78.1):** every ready builder task with no lane gets one worked out from its `--scope`, the code paths it
   names and its predicted files, as the Producer's decision (logged); a task it can't scope is reported `unscoped`
   in the status and the Producer note. A task on shared sim code (`STUDIO_SHARED_SIM`) waits (`--after`) for the open
   task on the same shared files instead of running beside it ("Stacked on shared sim code" in `npm run line -- plan`).
7. **Status** for the Communicator and studio:status: `.studio/line/status.json` (`npm run line --
   status`).

## Beta mode and the owner

Its fixes are routine harness housekeeping, never owner decisions. What needs the owner (a yes, an unpark, an unhold)
is only reported, naming who may act for the owner (beta mode's agents, the owner's delegate).

## Commands

- `npm run line -- status` — the last pass: builders, rig, chain-breakers, order, blocked and why, actions.
- `npm run line -- plan` — a dry pass now (fixes nothing, files nothing).
- `npm run line -- why <T-ID>` — why that task isn't running and what would start it.

Settings: `STUDIO_LINE_PRODUCER` (on | report | off), `STUDIO_LINE_EXPANSION_SHARE`, `STUDIO_LINE_EXPANSION_MIN`,
`STUDIO_LINE_CHAIN_MIN`, `STUDIO_LINE_BUILDER_GB`, `STUDIO_LINE_CPU_BUSY_PCT`, `STUDIO_LINE_RIG`,
`STUDIO_LINE_PLAN_MAX_SEC` (docs/LINE-PRODUCER.md).

**Engine trains (2.77.0).** Each pass you also start an engine's train (`task train --engine <name>`, detached) when its
queue has branches and the machine is in a quiet window: no web train, no other job of its kind, free RAM over its
floor, CPU under `STUDIO_ENGINE_QUIET_CPU_PCT`, web lanes first unless the engine queue waited
`STUDIO_ENGINE_TRAIN_MAX_WAIT_MIN`. The `engines` rows of `npm run line -- status --json` say why one waits
(docs/ENGINE-TRACKS.md).
