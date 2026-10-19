# Bug & Playtest Report Template (`studio/templates/bug.md`)

```markdown
### [P0|P1|P2] <BUG-ID> — <One-line summary>
- **Stage**: Stage 1 (Programmatic `?playtest=1` API) | Stage 2 (Visual Playwright / UISentinel)
- **Seed & Tick**: `seed=<number>, tick=<number>`
- **State Hash**: `<8-char FNV-1a hex>`
- **Expected**: `<expected invariant or layout behavior>`
- **Actual**: `<actual state value, console error, or layout overflow>`
- **Evidence**: `qa/reports/<runId>.json` / `qa/reports/<runId>-stage2.png`
- **Assigned Role**: `builder` | `designer-calibrator`
```
