# Read First

Read `AGENTS.md` first. Its section 1 is the one read order for every agent; this page doesn't
repeat it, so the two can't disagree.

- Workers: `task start` writes a one-page brief (`.studio/briefs/<ID>.md`); read that first, then
  the code it names. Long history? `npm run brief -- <ID>`.
- Producers (including a new model taking over the role): run `npm run handoff`; it covers the read
  order and more. `studio/MASTER.md` maps every key document.
- Held-out checks that run only at the merge train, and why you can't read them: `docs/HOLDOUT.md`.
- Planning a game: `docs/GAME-PLANNING.md`.

Start here, then follow the task into the code: `npm run map -- find <name>` gets you to it.
