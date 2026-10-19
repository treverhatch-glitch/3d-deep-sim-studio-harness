# New game template

1. Copy this folder to `cartridges/<game-name>/`
2. Keep `init`, `step`, and `invariants`
3. Add a 64-bit golden file under `qa/golden/`
4. Run `npm run verify`

Do not put Three.js, DOM, or unseeded random in this folder.
