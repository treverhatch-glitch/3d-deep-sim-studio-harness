# Studying existing games

Agents can study how other games are built, the way a designer studies games they admire: how the UI
is laid out, how systems are structured, how a web game organises its code. The goal is to learn
patterns and turn them into a plan for your own game, built with your own code and art.

## Tools

| Tool | What it studies | Plugin |
| --- | --- | --- |
| [REA](https://github.com/morluto/rea) (MIT) | Web bundles and Electron apps (modules, routes, state), Godot PCK and Unity IL2CPP metadata, native binaries with Ghidra, Hopper or IDA | `node harness/plugins.mjs enable rea` |
| Playwright MCP | Live web games: layout, accessibility tree, screenshots | on by default |
| [Watch Skill](https://github.com/oxbshw/watch-skill) (MIT, trial) | Your own screen recordings of games: frames, OCR text, timestamps | `node harness/plugins.mjs enable watch-skill` |

## How a study runs

1. The developer names the game and what they want to learn from it ("its build menu", "how it
   stores save data"). A person approves the study before an agent runs REA.
2. The agent studies only copies the developer owns or is allowed to examine, on the developer's
   own machine, and writes `studio/research/<game>/study.md`: what it found, with evidence.
3. It ends with "how our game gets there": each pattern mapped to our own systems and tasks.
4. The Producer queues those tasks. Nothing from the studied game is copied into the repo.

## Limits (from REA's own disclaimer, and good practice)

- Analyse software you own or are authorised to examine; licences and local law can restrict
  reverse engineering.
- No bypassing DRM, licence checks or anti-cheat, no cheats, no tampering with online services.
- Don't copy protected code, art, audio or text into the game. Patterns and structure, written fresh.
- Prefer your own recordings and screenshots over downloading other people's videos.
