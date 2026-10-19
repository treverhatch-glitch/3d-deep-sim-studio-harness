# Two-Stage Playtest & Closed-Loop QA (`qa/README.md`)

This directory implements a **closed-loop verification harness** synthesizing lessons from **Recursive Game Creator**, **OhMyGame**, **`microsoft/playwright-mcp`**, and **`mhjabreel/uisentinel`**.

---

## 1. Why Direct State Access Beats Pure GUI Clicking (OhMyGame & Recursive Game Creator Critique)

- **The Open-Loop Failure Mode (`OhMyGame` critique)**: Standard multi-agent frameworks generate code and blindly click canvas coordinates without knowing whether simulation entities actually moved, whether `NaN` corrupted the economy, or whether the RNG drifted.
- **The Closed-Loop Solution (`Recursive Game Creator` pattern)**: When launched with `?playtest=1`, the game exposes `window.__hatch` (and alias `window.__sim`). Agents and `qa/playtest.mjs` drive ticks deterministically (`step(120)`), inspect the JSON state directly (`getState()`), and verify state hashes before touching the GUI.

---

## 2. Accessibility Tree First, Screenshots Only When Needed

Full-resolution screenshots consume thousands of vision tokens and slow down agent loops. Always follow this order:

1. **Direct Sim State (`window.__hatch` / `window.__sim`)**: Verify `{ seed, tick, hash, entities }` via `qa/hatchfield.adapter.mjs`.
2. **Accessibility Snapshot (`microsoft/playwright-mcp` / `locator('body').ariaSnapshot()`)**: Inspect the semantic DOM tree in ~150 tokens (`qa/visual-check.mjs`).
3. **Layout Bounds Check (`mhjabreel/uisentinel`)**: Detect viewport overflow or overlapping HUD panels programmatically.
4. **Targeted Screenshots**: Capture `.png` screenshots **only** when a layout/visual invariant fails or when recording milestone B-roll for `studio/daily/`.

---

## 3. Commands

```bash
# Run Stage 1 (Programmatic seed+tick trajectory) + Stage 2 (Playwright + UISentinel)
node qa/playtest.mjs

# Replay a specific failing seed and tick deterministically
node harness/replay.mjs --seed 42069 --tick 120

# Run the full Closed-Loop Auto-Bug + Retry gate (escalates after 3 failures)
node harness/closed-loop.mjs

# Run minimal Playwright accessibility-first visual check against a local URL
node qa/visual-check.mjs http://127.0.0.1:5173/?playtest=1
```
