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
- In a lane copy (`.lanes/<you>`) `studio/` is the main checkout's (a link): only the board commands write there.
  Don't edit studio config (`studio/*.json`): it would land straight in main and your commits can't carry it (a hook
  refuses the edit). Commit a proposal instead: `studio-proposals/<ID>.json` = `{ "changes": [ { "file":
  "studio/<name>.json", "set": { "<a.b>": <value> } } ], "why": "…" }`; it is applied to main when your lane lands. A
  protected file in it waits for the owner. Not your task's change? Hand it back with a note (`npm run task -- pause`).
- Done: `npm run task -- done <ID> --agent <you> --check` first (seconds), then `npm run verify` in the foreground, then `npm run task -- done <ID> --agent <you>`.
  If your verify's shell was killed, the run goes on: `npm run verify -- --wait` shows it and its result.
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
- Never commit with `--no-verify`, and never weaken a test to pass (skip it, remove an assert, raise a timeout or tolerance, special-case a seed): the `hooks` and `weakened-tests` gates catch both, and only the owner approves an intended change.
- Never print, paste or commit keys or tokens.
- Ask a person before pulling outside assets, a large refactor, or changing core sim rules.
