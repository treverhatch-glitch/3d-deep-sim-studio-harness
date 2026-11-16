# 2.89.0: which functions a studio runs (`docs/RELEASE-2.89.0.md`)

The owner's word of 2026-11-16: merging look-alike code is not worth its risk for the lines it saves; cut what is not
essential, and upgrade what is needed. Built on 2.88.0. Only this page and the one for 2.88.0 are kept; older release
notes are in git history.

## What the records said

`harness/` and `scripts/` hold about 90,000 lines, 70,400 of them code. Against a crew's event log of ten days and its
command record of four:

| Level | Files | Code lines | Share |
| --- | --- | --- | --- |
| Ran for sure (a command on record, or the only file that names an event the log has) | 90 | 30,904 | 44% |
| Loaded when those ran | 244 | 52,473 | 75% |
| Reachable from those (loaded on demand, or started as a command) | 320 | 64,963 | 92% |
| Not reachable from anything on record | 58 | 5,470 | 8% |

The 8% is mostly setup and maintainer tooling. So whole files to retire are few. What a studio never runs, if anything
large, is inside files it does run, and no record showed that.

## What changed

| | What | Lines | Proof |
| --- | --- | --- | --- |
| The record | `harness/usage-functions.mjs`: a `harness/` or `scripts/` command in a studio has V8 count its function calls (`node:inspector`, function level) and at exit appends the functions not yet on record to `.studio/usage/functions/<version>.tsv`: file, start offset, line, name. No arguments, values or source. A process that runs long writes every `STUDIO_USAGE_FUNCTIONS_MIN` minutes (10). `STUDIO_USAGE_FUNCTIONS=off` turns it off. | +88 | `qa/selftest-289a.mjs`, five checks |
| The page | `npm run commands-run -- --functions` (`--all`, `--json`): per file, the functions that ran and the lines inside functions that never did. | +57 | the same unit, three checks |
| The self-test | Its commands run with the record off; the unit turns it on. | | |

On by default, like the command markers of 2.84, so a studio's record starts with its upgrade. Measured on one
machine: about 25 ms per command (200 ms against 175 for `task list`).

## How it will be used

After about four weeks of a live studio's record, the page lists what never ran. Each item is then read before it is
cut: a restore, a new studio's setup and an engine a studio does not use run rarely or never, and are not dead. The
recorder is a measuring tool: it comes out, or goes off by default, when the cut is made.

## Not tested, and not done

- No studio has run it yet; the cost was measured on one Linux machine with one command.
- A process ended by a signal writes nothing at its end (a long-running one has written on its timer). A function
  called only before the record starts in a process is missed.
- The record is per harness version: an upgrade starts a new file, so the first weeks after 2.89 are split if a
  studio upgrades again. The page reads the current version's file only.
- The timer for a long-running process has no check of its own.
