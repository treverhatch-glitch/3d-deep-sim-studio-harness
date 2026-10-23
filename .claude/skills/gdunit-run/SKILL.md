---
name: gdunit-run
description: Use to write, run, or fix gdUnit4 tests for a Godot project's simulation or economy rules.
---
### When
- You are changing simulation logic (e.g., in `sim/` or `scripts/`) in a Godot project.
- A builder task requires you to add or update a unit test for the changes.
- The `godot-unit` gate is failing.

### Steps
1.  Add or edit a test script in the `test_gdunit/` directory (e.g., `test_gdunit/test_economy.gd`).
2.  Run the gdUnit4 test suite via the harness gate: `node scripts/run-gates.mjs --only godot-unit`.
3.  If tests fail (exit 100), read the failing test names and messages in the gate output or `.studio/godot-unit-last.json` (they also appear in your retry brief and the HUD).
4.  Edit the game script or the test script to fix the failure.
5.  Repeat until the gate passes.

### Done means
- The `godot-unit` gate passes with exit code 0.
- For any change to simulation or economy rules, a new or updated test is included in your work.

### Never
- Change simulation logic without adding or updating a test.
- Place project tests inside the `addons/gdUnit4/` directory.
- Ignore a failing test. It indicates a regression or an incomplete feature.
