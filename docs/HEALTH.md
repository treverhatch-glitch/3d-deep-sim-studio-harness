# Healthy Game Checklist

A game in this harness is considered healthy when:

- A deterministic seed + tick system exists and is used
- `scripts/check-sim-isolation.sh` passes
- At least one playtest report exists (using `studio/templates/playtest-report.md`)
- No open P0 bugs
- Core loop is playable from a fresh seed

Agents should aim for this state before calling a milestone done.
