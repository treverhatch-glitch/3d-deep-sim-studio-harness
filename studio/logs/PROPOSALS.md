# Harness upgrade proposals (Hatch approves each one; nothing changes before that)

Each proposal points at the problems it comes from. Status: **waiting**, **approved**, **declined**, **done**.

### U-001 — A second game repo for the engine port · waiting
- **From:** P-002.
- **Change:** an engine track can point at a port in its own repo (adopt it like the web game: record where it
  came from; export and sync both), so parity, drift and the Unity gate work without a hand-written track file.
- **Size:** about half a day, with tests. **Risk:** low; the current one-repo setup keeps working.

### U-002 — Keep the private harness's checks free · waiting
- **From:** P-001.
- **Change:** run the harness CI on a self-hosted runner on Hatch's PC (free, safe for a private repo), or trim
  it to the essentials per push with the full set nightly.
- **Size:** an hour once Hatch has added the runner. **Risk:** the checks run only while the PC is on.
