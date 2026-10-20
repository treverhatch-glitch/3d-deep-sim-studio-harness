# __GAME_NAME__

Created from `cartridges/_template` by `npm run new-game __GAME_NAME__`.

| File | What to change |
| --- | --- |
| `index.mjs` | Your sim: state, `step`, `invariants`, `outcome`, and every balance number in `TUNING`. |
| `qa.mjs` | `scenarios['start-to-win']` must still win on its own. Add scenarios for each bug you fix. |
| `qa/golden/__GAME_NAME__-*.json` | Pinned hashes. After an intended sim change: `npm run golden -- --update`, commit with the change. |

Check it: `npm run verify -- --only purity,golden,vertical-slice` then `npm run playtest -- --cartridge __GAME_NAME__`.
Make it the default for every tool: set `"cartridge": "__GAME_NAME__"` in `studio/gates.json`.

Rules: no DOM, no Three.js, no `Math.random`, no `Date`, no timers. The renderer reads state; it never writes it.
