# Handoff: round 2.95, the full rules check in shards, a playtest build in one command (`studio/notes/HANDOFF-2.95-2026-11-18.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-18. Release notes: docs/RELEASE-2.95.0.md. Only the
two newest handoffs and release notes are kept; older ones are in git history.

## Where it stands

- 2.94 is on `claude/294` with its online checks passing but for one known load-dependent job being re-run; it is
  merged first, with a merge commit. The studio on record took 2.94 from that branch before the merge.
- 2.95 is on `claude/295`, built on 2.94's head; the maintainer merges it on green online checks, with a merge commit.

## How the round was built

The overseer's brief came through the owner at 20:50 Shanghai time with eight items and a later note on the cause of
the memory growth (game side). Four scoped agents, each in its own checkout: the shards, the measured peak, names from
files and the check ahead by shard (design, `295a`); the playtest build and "Systems ON" (design, `295b`); the pool
and agy start check and `agent list` (mechanical, `295c`); the held, queued branch (mechanical, `295d`). The
maintainer read the studio's land script and switch files read-only first, merged the parts and wrote the notes.

## What the next session should know

1. **A sharded run is full only with `rest`, and the harness cannot check `rest`.** If a studio reports a test that
   never ran, look at its `rest` filter before the code.
2. **`keep: "reads"` is the studio's trade.** The default (`tree`) is always sound. Do not make `reads` the default.
3. **The peak is the test command's own word** (`rules.peak`), kept in `partStats` in `.studio/engine/<x>-rules.json`.
   There is no second store. Parts run at once are not measured.
4. **The check ahead still keeps nothing unless the land run landed the batch unchanged,** shards included. An
   exact-tree green would be safe to keep regardless; that was left for a round with real records.
5. **The playtest command holds the train lock while it builds.** A stuck build stands in the trains' way until its
   time limit (the engine's `timeoutMin`). `train status` names it.
6. **Builds are known from the first green land run after the upgrade** (`<x>-land-builds.json`). There is no scan of
   the builds folder on purpose: a folder there says nothing about its commit or whether its run was green.
7. **`engine.mjs` starts `switches` and `playtest` as their own processes** because `unity-gate.mjs` imports
   `engine.mjs` (a cycle that waits on itself).
8. **P-370 is open:** from a cut-down environment on Windows the process list could not be read, although `psEnv`
   fills the system variables in. Every engine unit passes them through; nobody knows which one matters.
9. **Before a push:** units `235` and `2731c` with the static checks (P-359, P-366). A new engine unit copies the
   Windows pass-through lines from `294a`.
10. **The larger cut by evidence** still waits for a month of function records (from about 14 December).

## Open decisions for the owner

None from this round. Whether the studio turns on `keep: "reads"` is its overseer's call with the owner's rules for
protected settings.
