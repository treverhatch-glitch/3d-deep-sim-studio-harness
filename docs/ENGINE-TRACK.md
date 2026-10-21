# The engine track (`docs/ENGINE-TRACK.md`)

A port of a proven web game to Godot, Unity or Unreal, run as its own team beside the web game. The two
versions are linked only by a parity test.

## When

Only after Phase 1 is proven: the Phase 1 exit checklist is ticked and a person played a build and said
it's fun (or Phase 2 is already open). A port doubles the agents, and every open bug doubles with it.
Jed's run: keep it in web until playtests show it plays the way the dev imagined.

## How it starts

1. The Producer proposes it: `npm run engine -- propose godot --by <producer> --why "…"`. It refuses while
   Phase 1 isn't proven.
2. The game dev gets a "Needs you" question with the expected usage and the trade-offs, and answers yes in
   the War Room (or `npm run ask -- answer <id> yes --by <name>`).
3. A yes runs `npm run engine -- start godot`:
   - `engine/<game>/` is created (for Godot, from `engine/_godot/`, a worked port of the template game);
   - `engine/<game>/engine.json` records the engine, the gate, the parity and capture commands and the game's ID;
   - the Engine Transfer department opens;
   - the first `engine-porter` tasks are queued, tagged `engine:<name>`, with `engine/<game>/` as their lane;
   - `studio/engine/PARITY.md` lists the mechanics and where each one is ported.

`npm run engine` shows the options and the track if there is one.

## The engines

| Engine | Usage (vs Godot) | Why | Watch |
| --- | --- | --- | --- |
| Godot 4 (recommended) | the baseline | Text scenes and GDScript agents can read and diff; a free headless command line for tests, smoke runs and parity. SendIt went from nothing to a playable game in about 3 hours. | Fewer high-end effects than Unreal. |
| Unity | about 1.5 to 2 times | C#, batch-mode tests. | YAML scenes with GUIDs agents break easily; much of the work needs the editor; licence terms. |
| Unreal 5 | about 3 to 5 times | The best visuals. | Binary Blueprints and assets agents can't read or diff, slow C++ builds, huge installs. SendIt's attempt was slow for about 7 hours. |

The numbers are estimates from one experiment, not measurements. Point the harness at the program with
`STUDIO_GODOT`, `STUDIO_UNITY` or `STUDIO_UNREAL` in `.env`; otherwise `godot`, `unity` or
`UnrealEditor-Cmd` must be on the PATH.

## The three commands

- `npm run engine:gate`: the engine's own headless run (for Godot, `tools/gate.gd`: the tests in
  `tests/`, then a 300-frame smoke run of the main scene). It fails on a non-zero exit or any script
  error, and keeps the log in `qa/reports/engine_*.log`. With no track it passes with a note.
- `npm run parity [-- --seeds 1,2,3,4,5]`: the web cartridge's start-to-win and the engine's parity
  command play the same seeds; the outcome and tick (and any other field in `engine.json`'s
  `parity.compare`, such as `resources.credits`) must agree. The engine prints one JSON line per seed.
- `npm run engine -- capture [--frames 120]`: frames of the real engine build in `engine/<game>/captures/`.
  Godot's movie writer needs a display; on a Linux server it runs under `xvfb-run`.

Both `engine` and `parity` are optional gates in `studio/gates.json`: they report, and a game with a
track can make them required.

## What stays shared, and what doesn't

Shared: the Game Bible, the phase exits, the sim's numbers (`TUNING`), the game ID. Separate: the code,
the department and its agents, the gate, and the recordings (hashes differ by engine; parity compares
results, not hashes). A mechanic is proven in web first, then ported.

## In the War Room

The Arcade shows the engine build next to the web build: "Play it here" puts its web export
(`engine.json` `webExport`, for Godot `engine/<game>/export/web/index.html`) in the same screen, and its
last frame is a click away. Export Godot for the web without thread support so it plays inside the
Arcade's frame; a Godot web export needs its export templates installed on that machine.

## Following how it is made

- `studio/engine/LOG.md`: every gate, parity and capture run (when, who, which commit, the result), and the track's start.
- Tasks, notes, events and builds carry the `engine:<name>` tag, so a run can be filtered to the port.
- The run report's Engine track section: gate and parity results, and the porters' sessions, tasks and cache reads.
- `studio/engine/PARITY.md`: which mechanics are ported.
