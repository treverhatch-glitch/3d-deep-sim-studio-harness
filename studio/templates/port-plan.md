# Port plan: <system> to <engine>

One plan per system ported (studio/roles/engine-porter.md). Units run in parallel only after step 1 has landed.

## 1. Shared state (one chore, first)
- One chore declares every member that more than one unit needs: state fields, shared enums, shared tables, helpers.
- Queue it before the units: `npm run task -- add "Chore: shared state for <system>" --role engine-porter`.
- Every unit below waits for it: `--after <the chore's ID>`.

| Type | Member | Its type | Units that use it |
|---|---|---|---|
| | | | |

## 2. Units (in parallel, each after step 1)
A unit declares nothing in a shared type. A member it finds missing goes back to step 1: it stops and names it.
Give each unit its source's line ranges in its title or `--scope` (`path/file.ts:120-340`): its brief tells it to read
only those lines.

| Unit | Source ranges | Methods | Lane (its own files) |
|---|---|---|---|
| | | | |

## 3. Parity
- `npm run parity` on seeds 1 to 5 after each unit lands; tick the system in `studio/engine/PARITY.md` when all have.
