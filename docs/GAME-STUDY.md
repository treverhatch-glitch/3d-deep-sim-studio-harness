# Game study: best-practice layout

A study answers one question about how a game is built, then turns the answer into tasks. The
Producer can order one like any other task, about another game or about our own build.

```bash
node harness/task.mjs add "Study: how <game> lays out its build menu" --role reference-scout --priority P2
node harness/task.mjs add "Study our web build: what runs on every frame" --role qa-playtester --priority P1
```

## Two kinds of study

| Study | Good for | Tools |
| --- | --- | --- |
| Another game | UI layout, menus, flows, how systems are organised, save formats, performance tricks | [REA](https://github.com/morluto/rea), Playwright MCP, [Watch Skill](https://github.com/oxbshw/watch-skill) on your own recordings |
| Our own build | Bug hunting the shipped bundle: dead code, unexpected network calls, state that leaks between systems, slow paths, what changed between two builds | REA on `dist/` or the Tauri app, Chrome DevTools MCP traces, `qa/playtest.mjs` |

Turn a plugin on with `node harness/plugins.mjs enable rea` (or `watch-skill`, `chrome-devtools-mcp`).

## Suggested layout for `studio/research/<subject>/study.md`

1. **Question.** One sentence: what we want to learn and why.
2. **Material.** What was examined (build, version, recordings, screenshots) and where it came from.
3. **Findings.** Each with its evidence: the REA result, a screenshot, a frame timestamp, a trace.
4. **Patterns worth using.** What we'd adapt, in our own words.
5. **How our game gets there.** Each pattern mapped to our systems, with the tools and tasks it needs.
6. **Tasks.** Lines ready for `studio/NEXT.md`.

For a study of our own build, add a **Bugs** section: each finding as a bug file
(`studio/templates/bug.md`), with a seed and tick when the playtest can reproduce it.

## Advice

- Ask one clear question per study; broad "study everything" runs burn tokens and return little.
- Work from copies you own, on your own machine. REA's own disclaimer asks the same, and licences
  and local law can limit reverse engineering.
- Keep the game's own code, art, audio and text out of our repo; write the patterns fresh.
- Prefer your own recordings and screenshots to downloading other people's videos.
- Pin the plugin version in `studio/plugins.json` so two studies months apart are comparable.
