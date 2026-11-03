# Gameplay logic library (`docs/LOGIC-LIBRARY.md`)

2.72.0. Code a game already landed (a path finder, a queue, an easing curve, a step function) is found before an
agent writes it again, the way `npm run asset -- need` finds an asset before one is made (docs/ART-PIPELINE.md).
Code: `harness/logic-library.mjs`. The library lives in `studio/logic-library/`: `library.json` (one record per
module), `INDEX.md` (its readable copy, one line per module), `modules/<name>/` (the code and its `spec.json`) and
`CREDITS.md` (outside code). It ships empty except one made-up example, `example-step-toward`.

## Before writing gameplay logic

`npm run logic -- need "<what>" [--stack ts|cs|gd]` prints at most ~15 lines: the confirmed modules that match (what
each does, its interface, stack, assumptions, the game and harness version it landed in, its tests and golden), the
same stack first; another stack's module is offered as a port its spec checks. Nothing matches: "not in the library:
search open source next (a research task, 2.71), else write it"; `--research` files that research task once
(`Research: …`, the 2.71 type: its write-up needs sources with links).

## Adding a module (after it landed)

`npm run logic -- add <file or folder> --name <name> --task <T-ID> --does "<what it does>" --by <you>` with optional
`--interface`, `--stack`, `--assumptions`, `--tests a,b`, `--golden <file>`, `--spec <file>`, `--game`, `--tags`.
Only code that passed the gates: every file (code, spec, tests, golden) must be on the studio's branch exactly as on
disk, and the task must be done. The module needs a language-neutral test spec beside the code (`spec.json`):
`{ "function": "<exported name>", "cases": [{ "name": "…", "args": [ … ], "expect": …, "tolerance"?: 0.001 }] }`;
a JS or TS module's spec must pass on it. The code and spec are copied into `modules/<name>/` and the module is
*proposed*. A game dev, an outside agent or a person confirms it: `npm run logic -- confirm <name> --by <name>` (the
decider rules of harness/decider.mjs: a person, a Producer or Director session or an outside agent on a person's
`--permission`, or an agent under the owner's delegation for `logic-library`; never a worker, never its author).
The confirm is logged (`npm run decisions`) and records the files' checksums: a module whose library files changed
since is not offered until it is confirmed again.

## Code from outside

Pass `--source <url> --licence <id> [--author <name>]`. MIT, BSD, Apache-2.0 and ISC are allowed and get a credit
line (in the record, INDEX.md and, once confirmed, CREDITS.md; keep the original licence notice with the code). GPL,
AGPL and LGPL are held until the owner says yes (tier C, the asset gate's share-alike rule):
`npm run logic -- licence-yes <name> --by <person> --permission "<their words>"`, never a worker or the author. No
licence is refused (all rights reserved), and so is a licence not on the list. Code added without `--source` counts
as the studio's own: the harness can't tell copied code from written code, so the source is the adder's word.

## Upkeep

`npm run logic -- use <name> --game <game>` records that a game uses a module. `npm run logic -- list` flags a module
no game used (nor landed) for `STUDIO_LOGIC_STALE_DAYS` days (default 90; `off` never flags) as STALE.
`npm run logic -- check <name> [--impl <port.mjs|port.ts>]` runs the spec on the module or on a JS/TS port; a C# or
GDScript port runs the same `spec.json` cases with its own test runner (not run by the harness). The owner can
delegate confirming to an outside agent: `npm run delegate -- grant <agent> --actions logic-library …`.
