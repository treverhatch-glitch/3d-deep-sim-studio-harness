# Harness upgrade proposals (Hatch approves each one; nothing changes before that)

Each proposal points at the problems it comes from. Status: **waiting**, **approved**, **declined**, **done**.

### U-007 — Look into the one-time Windows land-lock stress flake (2.30p test) · waiting
- **From:** seen once on main. **Change:** investigation; a fix only if it reproduces.
- **Risk:** none. **Advice:** low priority; only if it shows again.

## Done or closed (one line each; the full text is in git history: git log -p -- studio/logs/PROPOSALS.md)

- **U-001** (approved 2026-10-31, done in 2.47 (PR #15)): A second game repo for the engine port
- **U-002** (approved 2026-10-31, done in 2.47 (PR #15)): Keep the private harness's checks free
- **U-003** (approved 2026-10-31, done in 2.52): Make the 2.41 "two greens" selftest independent of timing
- **U-004** (approved 2026-10-31, done in 2.49): `npm run logs`: the 2-minute read from the command line
- **U-005** (approved 2026-10-31, done in 2.51): The public-repo guard as a harness feature
- **U-006** (approved 2026-10-31, done in 2.50): Parity for a Vite game through Vitest
- **L-001** (closed 2026-11-10): how fast the interpreted rules run in the Unity game, and a native C# port only if needed. The owner chose the native port (round 2.82).
- **Planned updates, 2026-10-31 to 2026-11-05** (research, two rounds of break tests, the harness-ideas research, the 2.79 cleanup plan): built or dropped in releases 2.57 to 2.80; see CHANGELOG.md.
