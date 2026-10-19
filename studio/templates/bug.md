# Bug & Seed-Replay Report Template (`studio/templates/bug.md`)

> Automatically populated by `node harness/closed-loop.mjs` or `node qa/playtest.mjs` when a Stage 1 trajectory or Stage 2 visual/accessibility check fails.

```markdown
### [P0|P1|P2] <BUG-ID> — <One-line failure summary>
- **Stage**: Stage 1 (Programmatic `?playtest=1` `window.__hatch` / `window.__sim`) | Stage 2 (Playwright `ariaSnapshot` / `uisentinel`)
- **Closed-Loop Attempt**: `<attempt> / <maxRetries (default 3)>` (escalate to strong model or human after max retries)
- **Deterministic Replay Payload**:
  ```json
  {
    "seed": 42069,
    "tick": 120,
    "description": "<exact condition or action sequence that triggered the failure>",
    "actions": []
  }
  ```
- **Replay Command**: `node harness/replay.mjs --seed 42069 --tick 120`
- **State Hash**: `<8-char FNV-1a hex>`
- **Expected**: `<expected invariant, state property, or layout behavior>`
- **Actual**: `<actual state value, NaN drift, console error, or DOM overflow>`
- **Evidence**: `qa/reports/<runId>.json` (accessibility snapshot first; `qa/reports/<runId>.png` only if visual check failed)
- **Assigned Role**: `builder` | `designer-calibrator`
- **Post-Fix Memory Requirement**: Once fixed and verified, append a 4-point note (`What broke`, `Root cause`, `The fix that worked`, `How to avoid it next time`) to `studio/memory/failures.md`.
```
