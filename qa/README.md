# QA / Playtest

Prefer programmatic playtesting over pure screenshots.

- Expose game state via `?playtest=1` → `window.__hatch`.
- Record trajectories / state snapshots.
- Screenshots and accessibility trees are secondary evidence.
- Use Playwright MCP for visual checks when needed.

See Recursive Game Creator pattern and your own prior playtests.
