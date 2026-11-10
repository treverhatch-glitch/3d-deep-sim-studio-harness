# Handoff: round 2.82, native engine (`studio/notes/HANDOFF-2.82-2026-11-10.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-10, after `HANDOFF-2.81-2026-11-10.md`. The owner's
order: "Round 2.82: native Unity. Build it now", with the OK to merge 2.80, 2.81 and 2.82 in that order, each on fully
green online checks.

## Where it stands

- 2.80.0 is merged. 2.81.0 and 2.82.0 merge when their checks are green (the pull requests say where they are).
- Release notes: docs/RELEASE-2.82.0.md. The new page: docs/NATIVE-ENGINE.md.
- Nothing on the crew's PC was changed by the harness work. It was read: the land script and its 64 result records,
  the landing logs, the studio's settings.

- Later the same day: the owner asked whether the Unity train should be split into stages. The answer, from the
  crew's records, is studio/notes/TRAIN-SPLIT-2026-11.md (nothing built, one sketch for the next round). It found a gap
  in this round's rules check (P-299: kept results did not know their git-ignored inputs), fixed before merge.
- The crew was running again on 2026-11-10 (a land run and a verify that afternoon), still on 2.79.2.

## Decisions made on judgment (change them if the next score says so)

1. **Native mode is explicit for any studio with a web game.** Inference covers only a studio with one engine and no
   web game at all; the template is never native.
2. **The rules check is on by default for Unity** when the target has `tools/SimTests`, because it calibrates itself:
   red on the target means it judges nobody. A studio turns it off with `"rules": false`.
3. **The check narrows with itself, not with land runs**, and stops at 12 runs for one batch.
4. **A land script decides** whether to trust `STUDIO_RULES_GREEN` and whether to use `STUDIO_UNITY_EDITMODE_ARGS`.
   The harness gives both and requires neither.
5. **The engine flow and the design link are not among the fifteen measures.** They have no targets yet: set them
   after the first measured week.
6. **`token-norms.mjs` and `ledger.mjs` stay** (the owner's 2.80 rule: keep measurement), though nothing in
   production imports them.

## Open, most valuable first

1. The crew's upgrade to 2.82 and its restart (the owner's or the overseer's: protected files are signed at upgrade,
   and a restart spends the owner's model usage). Then a week, then `npm run score -- --record 2.82-week1`.
2. In the studio's `studio/game.json` (the owner's file): `"native"`, and the rules check's `inputs`.
3. The studio's land script: use `STUDIO_UNITY_EDITMODE_ARGS`, write `STUDIO_LAND_RESULT`, and decide on
   `STUDIO_RULES_GREEN`.
4. Play Mode: 14 of the 45 failed land runs failed there, 13 with a single failing test; read which (the stage report
   will show it per run) and whether they are timing tests.
5. A warm editor kept between land runs, and smaller test scenes per feature: both need a real editor to build and
   measure, so they wait for the crew's PC.
6. The rig: turn-taking between an engine land and the game's verifies is policy since 2.81 (engine first) and is
   still unmeasured; the engine flow's "waits for free memory" is its measure.
7. Targets for the engine flow and the design link, after the first measured week.

## How to check this round

`node qa/selftest.mjs --only selftest-282a` runs its own tests in under two minutes; the full self-test is the pull
request's checks.
