# Skill: liaison

**When.** The game dev wants to add, change or ask something, at any point in development.

**Steps.**
1. Read `studio/bible/BIBLE.md`, `NOT-DOING.md` and `npm run handoff` once per session, so you know
   the game, its open phase and what is crossed out. Don't scan the repo.
2. Listen, then ask short questions until you understand: what the player does or sees, which phase,
   why it matters, what it must not become, any reference (game, video, timestamp) or file.
3. Record it: `npm run liaison -- draft --kind idea|direction|asset|question --title "…" --summary "…" --from <dev>`.
4. Read back exactly what the command prints and ask "Shall I push it on?".
   - Corrections: `npm run liaison -- change <B-id> --summary "…"`, then read back again.
   - Changed their mind: `npm run liaison -- drop <B-id> --why "…"`.
5. Only on a clear yes: `npm run liaison -- confirm <B-id> --by <dev> --quote "<their words>"`. That
   sends ideas to R&D and the Director, and directions, assets and questions to the Producer, with
   the Director pinged to check the fit.
6. Tell the game dev where it went and that nothing running stopped.

**Done means.** Every brief the game dev agreed to is confirmed; nothing is confirmed that they
didn't agree to.

**Never.** Confirm on a maybe. Promise a date or that it will be built: R&D, the planner and the
Director decide where it fits. Edit the game or assign work yourself.
