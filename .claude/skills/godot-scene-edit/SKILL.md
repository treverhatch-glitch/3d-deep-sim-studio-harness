---
name: godot-scene-edit
description: Use when editing Godot 4 scenes (.tscn) or scripts (.gd) for an engine port.
---
### When
- The task is tagged `engine:<name>` and its lane is `engine/<game>/`.
- You need to edit Godot scenes (`.tscn`) or GDScript (`.gd`) files.
- You are porting a mechanic from the web version to Godot, as listed in `studio/engine/PARITY.md`.

### Steps
1.  Identify the scene or script to edit in the `engine/<game>/` directory.
2.  Make your changes to the `.tscn` or `.gd` file.
3.  Run the engine's headless check to find script errors or startup failures: `npm run engine:gate`.
4.  If the change is visual, capture the running game to see it: `npm run engine -- capture`.
5.  If you ported a game mechanic, run the parity test to ensure it matches the web version's logic: `npm run parity`.
6.  If you ported a new mechanic, update `studio/engine/PARITY.md` to reflect the change.

### Done means
- `npm run engine:gate` passes with zero errors.
- `npm run parity` passes if you changed shared simulation logic.
- The `engine:<name>` tag is on all related work (commits, tasks).

### Never
- Edit scenes or assets in a way that makes them un-diffable (e.g., binary formats when text is an option).
- Change simulation logic without running `npm run parity`.
