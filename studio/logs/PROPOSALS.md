# Harness upgrade proposals (Hatch approves each one; nothing changes before that)

Each proposal points at the problems it comes from. Status: **waiting**, **approved**, **declined**, **done**.

### U-001 — A second game repo for the engine port · approved 2026-10-31, done in 2.47 (PR #15)
- **From:** P-002.
- **Change:** an engine track can point at a port in its own repo (adopt it like the web game: record where it
  came from; export and sync both), so parity, drift and the Unity gate work without a hand-written track file.
- **Size:** about half a day, with tests. **Risk:** low; the current one-repo setup keeps working.

### U-002 — Keep the private harness's checks free · approved 2026-10-31, done in 2.47 (PR #15)
- **From:** P-001.
- **Change:** run the harness CI on a self-hosted runner on Hatch's PC (free, safe for a private repo), or trim
  it to the essentials per push with the full set nightly.
- **Size:** an hour once Hatch has added the runner. **Risk:** the checks run only while the PC is on.

### U-003 — Make the 2.41 "two greens" selftest independent of timing · approved 2026-10-31, done in 2.52
- **From:** P-004. **Change:** the test stops depending on file and report times landing in a set order.
- **Risk:** low (a test only). **Advice:** yes; it costs a re-run now and then.

### U-004 — `npm run logs`: the 2-minute read from the command line · approved 2026-10-31, done in 2.49
- **From:** the logs set-up. **Change:** prints the latest summary, open problems and waiting proposals from studio/logs/.
- **Risk:** none. **Advice:** yes, small; useful for the Ops bot's hourly post.

### U-005 — The public-repo guard as a harness feature · approved 2026-10-31, done in 2.51
- **From:** the hand-off (the guard lives only in hatchfield-unity-harness today). **Change:** `npm run public-guard -- install <repo>` copies the guard, hook and CI check into any public game repo, and keeps them up to date.
- **Risk:** low. **Advice:** yes, before a second public game repo exists.

### U-006 — Parity for a Vite game through Vitest · approved 2026-10-31, done in 2.50
- **From:** P-006. **Change:** docs plus a ready-made `--web` command shape for Vite/Vitest games (`REPLAY_PARITY={seeds} npx vitest run …`).
- **Risk:** none. **Advice:** yes, with the Hatchfield link.

### U-007 — Look into the one-time Windows land-lock stress flake (2.30p test) · waiting
- **From:** seen once on main. **Change:** investigation; a fix only if it reproduces.
- **Risk:** none. **Advice:** low priority; only if it shows again.

## Later (ideas to keep, not tasks; nothing starts until Hatch says so)

### L-001 — How fast the Jint rules run in the Unity game, and a native C# port only if needed · LATER
Logged 2026-10-31 on Hatch's request. The Unity game runs the web game's packed rules (hatchfield-sim.mjs)
through Jint on a background thread, so slow rules make the game unable to keep up at high speed rather than
lowering the frame rate. Order:
1. **The rules running in the Windows .exe.** Not started. The CI .exe has no rules file in it yet.
2. **Task A: measure.** On a busy airport in the Windows .exe: the fastest game speed it holds, frame time and
   memory stutters. Plus: profile the same JavaScript rules in Node to find the slowest functions. UNTESTED.
   Known so far: in plain .NET (not Unity), one 3-second step of a starter airport takes ~0.4 s (about 7x game
   speed at most). Unity's runtime may be slower; nothing measured inside Unity at speed.
3. **Task B: a native C# port, only if Task A shows a real limit.** Stable parts only (those that haven't
   changed for a while; `npm run engine -- drift` shows which), slowest first, Jint kept as the reference. A
   ported part replaces the Jint version only when all 3 recorded replays give identical numbers. UNTESTED.
   Risk: the rules are one 28,000-line class, so swapping single parts means C# called from inside Jint.
Already exists: the replay check against any rules engine (`IReplayPlayer`, `ReplayCheck.Compare` in the
Unity repo); no port-task template, no speed measurement inside Unity, no native port.
