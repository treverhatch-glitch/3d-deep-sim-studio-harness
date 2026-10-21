# The Godot template for the engine track (`engine/_godot/`)

A worked Godot 4 port of the template game (`cartridges/example-sim`), copied into `engine/<game>/` when
a person says yes to an engine track (`npm run engine -- propose godot`, docs/ENGINE-TRACK.md). Everything
runs headless, so agents never need the editor:

| File | What it is |
| --- | --- |
| `project.godot` | The project, Compatibility renderer (it exports to the web). |
| `sim/sim.gd` | The sim, ported 1:1: mulberry32 bit for bit (`u32`, `i32`, `imul`), JS `Math.round` as `floor(x + 0.5)`, one step per tick, the start-to-win policy. |
| `tests/test_sim.gd` | The port's checks: deterministic, invariants hold, the slice is won, the RNG matches the web's first value. |
| `tools/gate.gd` | `npm run engine:gate`: the tests, then a 300-frame smoke run of the main scene; any failure or script error fails it. |
| `tools/parity.gd` | `npm run parity`: one JSON line per seed, compared with the web cartridge (outcome, tick, credits). |
| `main.gd`, `main.tscn` | The playable build: the sim on a fixed tick, the scene built in code so every change is a readable diff. |

Checked with Godot 4.5.1: parity matches the web game on seeds 1 to 5 and 1337, and the gate passes.

Frames: `npm run engine -- capture` (Godot's movie writer; it needs a display, so a Linux server runs it
under `xvfb-run`). Point the harness at your Godot with `STUDIO_GODOT=/path/to/godot` in `.env`.
