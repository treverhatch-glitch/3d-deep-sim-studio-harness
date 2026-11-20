# Handoff: round 2.96, measured memory and CPU, each test once per tree (`studio/notes/HANDOFF-2.96-2026-11-20.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-20. Release notes: docs/RELEASE-2.96.0.md. Only the
two newest handoffs and release notes are kept; older ones are in git history.

## Where it stands

- 2.95 is on `main` (`9e91114`); the studio on record runs it with shards, `rules.peak`, switches and the playtest build.
- 2.96 is on `claude/296`; the maintainer merges it on green online checks, with a merge commit. `backup/pre-2.96.0`.

## How the round was built

The overseer's brief (16 items) came through the owner, then a corrected version an hour later: the memory spike is
one fixture (14.2 GB), not the test first blamed; the hand-made sampler had summed every test process on the machine.
Six scoped agents, each in its own checkout: sampling and admission (design, `296a`); narrowing and one green per
tree (design, `296b`); the queue and the union merge (design, `296c`); the reports (mechanical, `296d`); the smoke
start, the upgrade guard and two timing checks (mechanical, `296e`); the clean-up (mechanical). The maintainer read
the studio's records read-only first, merged the parts, wired the test-cost report to the sampled numbers, added
`rules.memory`, and made the porter spending order opt-in.

## What the next session should know

1. **Read the first real samples before anything else.** `.studio/engine/<x>-samples/` and `<x>.kinds` in
   `.studio/engine-ram.json` in the studio: is the Windows helper alive, what does one sample cost, what do a land run
   and the heavy shard really take. Until then measured admission is a design, not a result.
2. **`machine.admit` falls back to the old rule whenever a number is missing, stale or doubtful.** Keep that: this
   code decides whether a second heavy job starts on a machine where running out of memory kills processes.
3. **A filtered run chooses suspects; only a whole check calls a batch green or hands a lane back.** Do not weaken
   that to save the last whole run.
4. **The count ratchet is still a hand-back.** The brief asked that it not be; letting a red test land is the
   owner's decision and was not taken. It is on the roadmap as a question.
5. **`rules.peak` (2.95) stays as the fallback.** It is not wrong: it reports one process, where the sampler reports
   the run's tree. Remove it only after sampled numbers exist in a studio.
6. **Porters follow the builder order only with `STUDIO_BUILDER_ORDER_ROLES`.** The first version applied the order to
   engine porters at once; an upgrade would then have moved them onto API credit by itself.
7. **The clean-up found no dead modules.** Shrinking means retiring features or merging twins: the web train and the
   engine train, parts and shards, slots and reservations. Each is a design round with records first.
8. **P-346:** the two supervisor-window checks now wait for what they check. "--lanes auto" and "a ping starts
   STUDIO_DIRECTOR_CMD once" are still timing-dependent.
9. **Before a push:** units `235` and `2731c` with the static checks; `unused-exports` prints `DEAD 0` now.

## Open decisions for the owner

- Whether a count ratchet may land with a fix task filed (today: handed back, in minutes).
- Which unused features to retire (the list with line counts is in the maintainer's roadmap).
