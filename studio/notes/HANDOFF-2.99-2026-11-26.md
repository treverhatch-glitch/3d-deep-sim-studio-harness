# Handoff: round 2.99, mixed trains that don't stall (`studio/notes/HANDOFF-2.99-2026-11-26.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-26. Release notes: docs/RELEASE-2.99.0.md. Only the
two newest handoffs and release notes are kept; older ones are in git history.

## Where it stands

- 2.98 is on `main` (`6159491`) and has run in the studio on record since 24 November.
- 2.99 is on `claude/299`; the maintainer merges it on green online checks, with a merge commit. `backup/pre-2.99.0`.

## How the round was built

The overseer's brief (14 items) came through the owner with two questions of his own (is the harness getting better,
and what must 3.0 be able to do) and the order to cut what is not used. The maintainer read the code and the studio's
records first, with six small read-only agents, before any brief was written. That changed four items:
- the Play Mode map the brief asked for has existed since 2.84, and the overseer had filled one by then; the gap was
  the rule that a skip path sends a mixed batch to the full stage;
- the tool's allow rule was there, in an unquoted spelling no session can type; the denial log showed the quoted one;
- the agent's own land run was what the porter's role file told porters to do;
- a score script, a registration script and the land script's part support are the studio's own files.
Then seven scoped agents, each in its own checkout: the red-lane cost and landing in parts (design, `299a`); the
engine slot and the check ahead (design, `299b`); Play Mode focus and times (mechanical, `299c`); allow rules (design,
`299d`); tags, waiting lanes and "newer wins" (design, `299e`); checklists and asks (mechanical, `299f`); the cut of
unused commands (mechanical). An eighth did the pass over the merged code.

## What was removed, counted

- Commands: `division`, `logs`, `commands-run`, the `event:sh` alias; with them the usage marks and their three
  settings. The evidence was the studio's own session logs: of 165 commands, 44 were never run by an agent; the
  other 40 are called by other code, a gate or a workflow, or are the owner's and the maintainer's own tools.
- By the parts: `idleTag`, `unionGlobs`, the unquoted allow rule, the fixed-set path of the check ahead, 2.84's
  mixed-batch rule, a duplicate worker test in the heavy lock.
- The numbers are in the pull request (the size report against 2.98.0).

## What the next session should know

1. **Read the code and the records before writing a brief.** Four of fourteen items had another cause than stated.
   A scout per topic costs minutes and saved a design agent from building a setting that already existed.
2. **The largest cost found this round is a studio setting, not code.** Shards kept by what they read also hash the
   files no shard takes. Where art and UI files are neither under `rules.ignore` nor outside `rules.paths`, every art
   lane makes all shards run again, in each train and after each dropped lane. Ask for the studio's `rules show`
   first next round.
3. **A new default must be safe for a studio that changes nothing.** A part gave an agent's land run a 45-minute
   limit everywhere; without an engine train that run is the verify itself. The maintainer limited it to engines
   with a train. Read each new default as a studio with other settings would meet it.
4. **The usage record is gone.** The next cut starts from the session logs (`.studio/agents/*.log`: count
   `npm run <name>` and `node harness/<name>.mjs`), then proves each candidate against the code.
5. **Still two of a kind:** the web train and the engine train (5,700 lines; four helpers are near-copies). This is
   the largest consolidation left and wants a round of its own, with the engine train's units as the safety net.
6. **Units of this round copy a cut-down environment from older units;** a setting removed in the same round then
   fails the settings check after the merge. Grep new units for removed names before the first push.
7. **Before a push:** units `235` and `2731c` with the static checks; `unused-exports` prints `DEAD 0`; then every
   old unit that names a changed module, in batches of six.

## Open decisions for the owner

- Whether a count ratchet may land with a fix task filed (today: handed back).
- Whether a tag group should run by itself after a day by default (`tagMaxWaitHours` 24): it is what the overseer
  asked for, and it changes what a tag means.
- Whether to turn `landParts` on: rule lanes land earlier, and each train pays one more Edit Mode stage.
- The 3.0 bar, in the maintainer's roadmap: a red lane costs one extra run; parts land without waiting; proven on a
  real engine in the harness's own checks; a second game set up from nothing in a day; one train instead of two and
  a test suite under 40 minutes; upgrades that cannot hurt; one page for the owner.
