# Master plan (`studio/PLAN.md`)

> Owned by the Producer. Keep it to a page: the long reasoning goes in `studio/decisions/` and
> `studio/producer/LOG.md`. When you clone the harness for your game, rewrite this file first.

## Goal

Prove the harness end to end on the example cartridge (`cartridges/example-sim`) so a real game
can join with gates, replays, done-checks and the War Room already working.

## Now

- **Phase**: 1, harden the harness on its own example game.
- **Focus**: the War Room v3 as the default page, producer handoffs, done-checks by task type.
- **Blocked on**: nothing.

## Milestones

| # | Milestone | Done means | Status |
| --- | --- | --- | --- |
| M1 | Gates that can fail | Every required gate fails when broken (self-test) | done |
| M2 | Done-checks and skills | `task done` refuses unfinished work for every task type | done |
| M3 | Producer handoff | `npm run handoff` briefs a new Producer from files alone | done |
| M4 | War Room v3 default | v3 is the page the HUB opens, with write actions behind the token | in progress |
| M5 | Divisions scaffolded | Folders, roles and switches for the nine optional divisions | next |
| M6 | First real game joins | A second cartridge passes every gate with its own goldens | later |

## Risks and open questions

- The Studio view is a prototype page; it needs the token-protected write actions before it replaces the old War Room.
- Port parity (web to Godot or Unity) is untested until a second engine build exists.

## Not doing yet

- Paid asset generators.
- Agent frameworks (LangGraph, CrewAI, AutoGen): the queue, locks and gates already coordinate.
