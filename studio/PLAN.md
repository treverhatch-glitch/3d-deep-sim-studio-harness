# Master plan (`studio/PLAN.md`)

> Owned by the Producer. Keep it to a page: the long reasoning goes in `studio/decisions/` and
> `studio/producer/LOG.md`. When you clone the harness for your game, rewrite this file first.
> The harness's own detailed roadmap, with how each problem gets fixed, is `docs/ROADMAP.md`.

## Goal

Prove the harness end to end on the example cartridge (`cartridges/example-sim`) so a real game
can join with gates, replays, done-checks, a Game Bible and the War Room already working, on
Windows, macOS, Linux or a cloud server.

## Now

- **Stage**: harness phase 2, give every game a real start.
- **Focus**: pre-production, the Game Bible with three game phases and opt-out layers, the Idea
  Board and the Director (2.8.0).
- **Blocked on**: nothing.

## Milestones

| # | Milestone | Done means | Status |
| --- | --- | --- | --- |
| M1 | Gates that can fail | Every required gate fails when broken (self-test) | done |
| M2 | Done-checks and skills | `task done` refuses unfinished work for every task type, by content | done (2.6.0) |
| M3 | Producer handoff | `npm run handoff` briefs a new Producer from files alone | done |
| M4 | War Room v3 default | v3 is the page the HUB opens, with write actions behind the token | done (2.4.0) |
| M5 | Runs anywhere | `npm run verify` passes on a clean Windows machine and in CI on Windows | done (2.7.0) |
| M6 | A real start | Intake questions, Game Bible, three phases, layers kept or crossed out, R&D and storyboards; build tasks wait for a signed Bible | next (2.8.0) |
| M7 | Director on duty | Pinged daily and before new tasks; reviews in `studio/bible/reviews/`; free drift report | planned (2.8.0) |
| M7b | Idea Board | Ideas go captured, shaped, placed, approved, then scheduled; nothing unapproved becomes build work | planned (2.8.0) |
| M8 | Deeper skills, stricter slices | Full bug loop, `system` skill, required cross-family review, measured renderer budget | planned (2.9.0) |
| M9 | Content and craft pipelines | Content as validated data; art, audio and narrative each with a tool and a check | planned (2.10.0) |
| M10 | One studio across machines | The HUB holds tasks, locks and events, so cloud and multi-machine agents share them | planned |
| M11 | First real game joins | A second cartridge passes every gate with its own goldens and Bible | later |

## Risks and open questions

- The Director could become a second boss. Keep the Bible as the authority and the Producer as the
  one who assigns; the Director only reviews and edits the Bible.
- Auto-starting a Director agent spends tokens. It runs under the daily spend cap and only on a ping.
- Port parity (web to Godot or Unity) is untested until a second engine build exists.

## Not doing yet

- Paid asset generators.
- Agent frameworks (LangGraph, CrewAI, AutoGen): the queue, locks and gates already coordinate.
- Game-specific loops for Hatchfield; they belong in the Hatchfield repo.
