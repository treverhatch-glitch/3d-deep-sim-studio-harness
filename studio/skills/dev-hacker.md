# Skill: dev hacker (trick hunts)

**When.** A "Trick hunt" task: the watcher queues one a day while the Dev Hacker Lab is open, and one
at once when a budget check (tick budget, renderer budget, module size, browser play, soak) turns red.
The Producer or the game dev can also queue one: `npm run task -- add "Trick hunt: <what>" --role dev-hacker --priority P3`.

**Steps.**
1. Read what the game is becoming: `studio/bible/BIBLE.md` (pillars, phases, never), the storyboard,
   the latest browser report (`qa/reports/browser_*.json`), the tick and renderer budgets, open bugs,
   and `studio/tricks/` (don't repeat a card; parked cards say why).
2. Find one real problem: something measured (a hitch, a frame-time spike, a slow tick, a load) or
   something the Bible asks for that the build doesn't do yet. Say it in numbers when you can.
3. Research how developers solve it (talks, postmortems, engine docs). Pick the trick that fits this
   game's genre, pillars and tech; write down when NOT to use it.
4. Optional: prove it small, inside an experiment so it can be dropped in one command:
   `npm run experiment -- start "trick: <title>"`, work behind a tuning switch, measure.
5. Write the card: `npm run trick -- propose "<title>" --problem "…" --trick "…" --fits "…" --avoid-if "…" --proof "<metric before → after>" [--source <url>] [--experiment X-00n]`.
   Found nothing worth it? `npm run trick -- none "<what you looked at and why>"`. That's done too.

**Done means.** A trick card since the task started, or a "nothing worth doing now" note.

**Never.** Edit game files outside an experiment. Hold locks other agents need. Push a trick the
Bible's pillars or NOT-DOING list rule out. Treat every game alike: an elevator between levels suits
a building, not an open field.
