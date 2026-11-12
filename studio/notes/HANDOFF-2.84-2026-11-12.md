# Handoff: round 2.84, less waste (`studio/notes/HANDOFF-2.84-2026-11-12.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-12. Release notes: docs/RELEASE-2.84.0.md. Only the
two newest handoffs and release notes are kept; older ones are in git history.

## Where it stands

- 2.84 is on `claude/284` (pull request #85). It is not merged: the owner says when.
- The online Unity editor jobs fail at Unity's sign-in ("Failed to login"): the repository's `UNITY_EMAIL` and
  `UNITY_PASSWORD` secrets are the owner's to correct. `game-ci/unity-test-runner` is pinned to v4.3.2 because the
  floating v4 cannot activate a Personal licence file; `game-ci/unity-builder@v4` is not pinned and not yet tried.

## The second pass (same day)

The owner asked for the overseer's list to be cross-checked and built, more trimming, and for the overseer and the
outside signer to keep (and get) the authority to run the studio unattended while he travels. A crew's first 21.5 hours
on 2.83 measured worse than 2.82 on most scorecard lines (docs/RELEASE-2.84.0.md has the numbers): 2.83's projection
did not hold. The second pass is twelve parts, each with its own test unit (284n, q, s, t, u, v, w, x, y).

The owner's decisions, in his words to the maintainer: the outside signer gets the same power as the overseer; both
get the commands that refused them; the same-family review stays a switch the overseer flips; and "in beta an agent
can approve its own protected file change". Built as said, logged (`beta.use`, `self`), nothing else loosened.

Not built: the engine adapter for a third engine (a plan, not a patch); the web train's own auto mode; removing gates
nobody runs (waits for `commands-run` evidence).

## Decisions made on judgment

1. **Back off by outcome, not by news.** Replayed on the crew's log, "skip when nothing changed" skipped 1 cycle of 32.
2. **The same-family switch is a protected decision** ('tests'): the owner and the owner's stand-ins, not a Producer
   session. The owner asked that the overseer may flip it; the file is deliberately not a protected file.
3. **No feature cut on five days of one crew's log.** `npm run commands-run` collects the evidence from here on.
4. **The batch window and Play Mode focus are off until a studio sets them.** A focused Play Mode run is a weaker
   check; the daily full land run is its backstop.
5. **The top-level-await check flags only the exact failing shape** (an awaited import that reaches back to the module).
   43 more modules have a top-level await and static importers: `node scripts/check-top-level-await.mjs --all`.
6. **Two newest kept** for release notes and handoffs; four newest changelog entries in full.

## Open, most valuable first

1. The Unity sign-in secrets, then read the `engine-unity-real` job: it is the first time the harness's readers meet a
   real editor. Expect it to find something.
2. The first real run of the harness-owned editor on a PC (docs/NATIVE-ENGINE.md, "The first run on a PC"), and a land script
   that honours the new variables. Then score a day on 2.84 against P-324.
3. After a month of markers: `npm run commands-run`, and cut what nobody runs.
4. Large pages left: docs/WORK-ORGANIZATION.md (38 KB), docs/AGENT-TOOLS.md, docs/ENGINE-TRACKS.md, docs/AUTONOMY.md
   (33 KB each). Comments are a quarter of the code's bytes: `npm run check:same-code` proves a comment-only
   change (docs/RELEASE.md).
5. `harness/review.mjs`'s command line still uses top-level await while other modules import it.
