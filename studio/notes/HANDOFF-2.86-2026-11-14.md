# Handoff: round 2.86, the engine train (`studio/notes/HANDOFF-2.86-2026-11-14.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-14. Release notes: docs/RELEASE-2.86.0.md. Only the
two newest handoffs and release notes are kept; older ones are in git history.

## Where it stands

- 2.86 is on `claude/286`. It is not merged: the owner says when.
- 2.85 is merged (pull request #86). A crew's first 19.5 hours on it are scored in docs/RELEASE-2.86.0.md.
- The crew's supervisor was still running 2.84 code a day after its 2.85 upgrade (P-332). The overseer was told in a
  note; whether it was restarted is not known here.
- The online Unity editor jobs still fail at Unity's sign-in: the repository's secrets are the owner's to correct.

## How the round was built

Seven parts, each in its own branch and worktree with its own test unit (286a to 286g), merged one at a time with the
recipe of the 2.85 handoff. Before any part was specified, the crew's event log and state files were read; three of
the overseer's items turned out to have a different cause than his note gave (the web train: old code; the rules
check: a matching bug, not memory; the narrowing: a flaky test, not the order of steps).

## Decisions made on judgment

1. **Read the process, not the version.** `package.json` said 2.85; the supervisor's own state file said it started
   before the upgrade. Start every field review with the start times of the long-running processes.
2. **No way around the hooks check.** The overseer asked for a beta-mode exemption of one commit. The cause (an
   upgrade that could not commit the board cleanly) is fixed instead.
3. **Narrowing by test name, landing on a complete run.** A by-name step decides who is handed back; it never lands.
   The confirm step of 2.83 stays, by name. A land script must show it honours `STUDIO_LAND_PROBE` first.
4. **A red target blames nobody and lands nothing.** The lanes wait; the page asks for a fix. The optional
   `knownRedHours` contract is the studio's to turn on, never the harness's default.
5. **Main-checkout access for lane sessions is off by default.** As first built it gave every lane prompt-free edit
   of the main checkout. Lane isolation is a design rule; the setting exists for a studio that chooses otherwise.
6. **One disk setting.** The new stop level reuses `STUDIO_DISK_MIN_FREE_GB`; only the warning level is new.
7. **Dead code is proven against every tracked file** (P-336). The list by extension was wrong once in twenty.
8. **Six older checks were rewritten** (285a, 283b, 284h) because the daily full run no longer rides a batch; each
   asserts the new rule for the same subject.

## Open, most valuable first

1. Score a day on 2.86 with a restarted supervisor (`npm run score -- --days 1`): engine land runs passing, engine
   queue wait, rules-check minutes per train, hand-backs with a harness cause.
2. The studio's side of 2.86 is configuration: `rules.focus.auto` and `shared`, `rules.paths`, `sparse`, and a land
   script that honours `STUDIO_LAND_PROBE`. Until then several parts do nothing.
3. Timing-sensitive self-tests that fail once in a few runs on the online runners (listed on pull request #86).
4. Tasks stacked on a parent that waits in an engine queue: still not built.
5. 14 exports only tests use and nothing else: decide each (a test of an unwired feature, or a feature to wire in).
6. The plan's judge before landing waits for a release whose hands-free number holds.
