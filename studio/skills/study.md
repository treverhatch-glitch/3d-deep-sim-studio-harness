# Skill: study

**When.** The Producer orders a study: how another game does something, or a bug hunt through our
own build.

**Steps.**
1. Write the one question you are answering.
2. Study it with the tools in `docs/GAME-STUDY.md` (REA, Playwright MCP, Chrome DevTools MCP,
   your own recordings).
3. Write `studio/research/<subject>/study.md`. `docs/GAME-STUDY.md` has a suggested layout; use
   what helps.
4. Turn findings into tasks (`node harness/task.mjs add …`). For our own build, file each bug with
   `--type bug`.

**Done means.** A `study.md` under `studio/research/` written after the task started.

**Never.** Copy the studied game's code, art, audio or text into the repo. Study builds you don't
have a right to examine.
