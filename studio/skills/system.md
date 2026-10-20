# Skill: system

**When.** A task titled `System: …`: build a whole game system (a tech tree, an economy, weather,
visitors), prove it, and hand it off.

**Steps.**
1. **Spec first.** Write `studio/bible/systems/<name>.md`: what it does for the player, its phase and
   layer (from the Bible), its rules, the numbers that go in TUNING, the invariants that must always
   hold, and what it must not do. Check `NOT-DOING.md`.
2. **Build it in the sim** with the builder loop: pure, seeded, values in TUNING, invariants in the
   cartridge's `invariants()`.
3. **Prove it.** Add a scenario to the cartridge's `qa.mjs` that exercises it (name it after the
   system or its phase), regenerate the goldens (`npm run golden -- --update`), and run a playtest of
   the current build (`npm run playtest:stage1`).
4. **Hand it off.** End the spec with `## For the next agent`: where the code is, how to change a
   value safely, what to watch for, what's left.
5. **Verify**, commit with the task's tag, and ask for a review from a different model family
   (`node harness/task.mjs add "Review: System T-… <name>" --type review`).

**Done means.** A spec with a hand-off, a scenario in qa.mjs, updated goldens, a playtest of the
current build, a green verify after the last change, and an approving review from another model family
(the review note carries `model-family:` and `implementer-family:` lines).

**Never.** Build a system the Bible crossed out. Ship it without an invariant. Review it yourself.
