# Read First

Any new agent must read these files in order before doing other work:

1. `AGENTS.md` — operating rules, concurrent work rule, seed system, approval gates
2. `docs/GAME-PLANNING.md` — how to plan a game (layers, loops, tech tree, references)
3. `studio/CURRENT_TASK.md` — current checkpoint and status
4. `studio/memory/failures.md` — distilled lessons from past bugs
5. The concurrent work rule in `AGENTS.md` (do not edit files another agent has locked)

Producers (including a new model taking over the role): run `npm run handoff` and read
`studio/MASTER.md`, `studio/PLAN.md` and the newest entries in `studio/producer/LOG.md`.

Do not scan the whole repo. Start here.
