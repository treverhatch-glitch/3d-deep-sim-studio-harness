# Handoff: round 2.97, what a day on the real machine showed (`studio/notes/HANDOFF-2.97-2026-11-21.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-21. Release notes: docs/RELEASE-2.97.0.md. Only the
two newest handoffs and release notes are kept; older ones are in git history.

## Where it stands

- 2.96 is on `main` (`0a4612b`). The studio on record took it from the release branch one commit before main (the
  commit before the Windows sampler fix); the older sampler helper works on its machine all the same.
- 2.97 is on `claude/297`; the maintainer merges it on green online checks, with a merge commit. `backup/pre-2.97.0`.

## How the round was built

The overseer's brief (7 items) came through the owner the same night. The maintainer first read the studio's records
read-only, and one item turned out to have another cause than the brief gave: the union rule did reach the batch's
conflict check; it refused because both lanes lengthen one line. Five scoped agents, each in its own checkout: the
rules green and the check ahead (design, `297a`); the union merge (mechanical, `297b`); the memory numbers
(mechanical, `297c`); drain, restart and upgrade (design, `297d`); the first test's blame (design, `297e`).

## What the next session should know

1. **Read the studio's records before believing a brief's cause.** The symptom in a brief is evidence; the cause is a
   guess until the files say so. Here ten minutes with `git diff -U0` on the two lanes found the real one.
2. **The first real samples are in.** One shard peaks at 12.5 GB, every other at 1.3 GB or less, 16 are too short to
   sample; `land no-rules play-skip` peaks near 10 GB in its own tree, `land with-rules play-full` near 15.
   `machine.admit` is still off in the studio. Turning it on is the next step, with the overseer.
3. **Do not move the process-identity lookup off `Get-CimInstance` in a hurry** (P-370). Locks recognise their owner
   by start time; two readings that differ by a millisecond would make a live lock look stale during an upgrade.
4. **A waiting train cannot hide any more**, but only the web train's restart has a check, and nothing of the restart
   ran on Windows. Read the first restart in a studio's train log before trusting it.
5. **`task done` during a drain exits 3** where it would run its own train. If an agent treats that as a failed task,
   say so in its brief text rather than bringing the wait back.
6. **Trims wait for records.** Candidates with what they need: `rules.peak` (a week of sampled peaks that match it),
   the whole-machine floor learning (split planning moved to sampled kinds), rules parts (read as shards).
7. **Before a push:** units `235` and `2731c` with the static checks; `unused-exports` prints `DEAD 0`.

## Open decisions for the owner

- Whether a count ratchet may land with a fix task filed (today: handed back, in minutes).
- Which unused features to retire (the list with line counts is in the maintainer's roadmap).
