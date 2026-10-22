# Parallel Floors

Floors allow parallel work streams for different phases of the game.

## Configuration
Opt-in via `studio/floors.json`:
```json
{
  "maxParallel": 1,
  "autoOpen": true,
  "requireScenarios": true
}
```

## Commands
- `npm run floors -- status`: Show current floors status.
- `npm run floors -- open <n> --by <name>`: Open a floor manually.
- `npm run floors -- stage <n> <build|art|polish|done> --by <name>`: Change the stage of a floor or the main phase.
- `npm run floors -- tick`: Auto-open the next floor if conditions are met.

## Scenarios
Phase scenarios in `qa/scenarios/phase-<n>/` are run before a floor can open. They must export a default async function returning `{ ok: boolean, why?: string }`.

## Content as Data
Content schemas in `studio/bible/schemas/` validate JSON content in `cartridges/<game>/content/`.

## Limits
- Maximum phase is 3.
- `maxParallel` limits the number of floors (including the main phase) in the `build` stage.
- Scenarios run synchronously; with `autoOpen` on, a slow scenario holds a supervisor pass for up to its time limit.
- When the main phase is later opened with `npm run bible -- phase open`, a floor with the same number stays listed; close it with `floors -- stage <n> done`.
- A floor's default lane only applies when `studio/game.json` names the cartridge.
