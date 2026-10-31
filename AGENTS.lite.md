# Agent rules, Lite (`AGENTS.lite.md`)

This studio runs in Lite scope (`npm run mode -- scope lite`): fewer gates, a shorter read. The full
rules are in `AGENTS.md`; open them only if something here doesn't cover your case.

## Start

1. Read `studio/CURRENT_TASK.md`, then your brief in `.studio/briefs/<ID>.md`.
2. To find code, `npm run map -- find <name>` gives the file, line range and arguments in one call.
3. Follow `studio/PITFALLS.md`. Never read `CHANGELOG.md`. `npm run help` lists the commands.

## Claim, work, finish

- Use a unique name (`claude-a`, not `claude`): `export STUDIO_LOCK_OWNER=claude-a`.
- Claim: `npm run task -- start <ID> --agent <you>`. If it refuses, pick another task.
- Edit only inside your task's lane or a path you claimed (`node harness/lock.mjs claim path:<dir> --owner <you>`).
- Done: `npm run task -- done <ID> --agent <you> --check` first (seconds), then `npm run verify` in the foreground, then `npm run task -- done <ID> --agent <you>`.
  `node harness/done-check.mjs <ID>` says what is missing.
- Stopping early: `npm run task -- pause <ID> --agent <you> --note "where you stopped"`.

## The game's sim (`cartridges/<name>/`)

- No DOM, `window`, WebGL or `three`. Fixed ticks. Seeded RNG only (no `Math.random`, no `Date.now`).
- State is plain JSON.
- A change that changes behaviour changes hashes: `npm run golden -- --update`, committed with the change.
- A fixed bug gets a replay in `qa/regressions/`.

## Never

- Never edit `harness/`, `hub/`, `scripts/`, `tools/` or `qa/*.mjs` to make a check pass. Game tools go in `game/<name>/tools/`.
- Protected files (`studio/protected.json`: scenarios' expected outcomes, regressions, the Bible's controls list, gates, the game's check settings in `studio/game.json` and `game|web/*/studio.gates.json`) change only with the owner's signed approval. If your task needs one changed, hand it back with a note saying which and why; never sign, force or work around it.
- Never print, paste or commit keys or tokens.
- Ask a person before pulling outside assets, a large refactor, or changing core sim rules.
