# 3D Deep-Sim Studio Harness

A file-based workflow harness for building deep simulation games with any mix of AI agents and people. It is not a game
engine: you bring the game, and the harness keeps many agents from breaking it. The game's rules live in a pure sim
cartridge (no renderer, DOM, randomness or clock) that is replayed from a seed and checked against pinned SHA-256
hashes. Tasks, locks, gates and a merge train decide what lands; only the owner can change the checks that judge the work.

**Who it is for.** A game owner who runs a crew of AI agents (Claude, Codex, Cursor, Gemini, Grok, Aider) and wants the
crew's work checked, repeatable and safe to leave running. No game ships here except the example cartridge
`cartridges/example-sim`; each game lives in its own repo or private copy.

## Quick start

```bash
npm run setup                          # .env, git hooks, .studio/ state
npm run verify                         # every required gate in studio/gates.json
npm run new-game my-game               # your own cartridge, with real goldens, passing on day one
npm run playtest -- --cartridge my-game
npm run studio:status                  # is the studio running, and what needs you
npm run release                        # the one command before a merge
```

To bring a game that already exists under the studio: `npm run onboard -- --path ../my-game --name "My Game" --adopt`
(docs/ONBOARDING-A-GAME.md). `npm run help` lists the everyday commands; `npm run help -- --all` lists every one.

Keys go in `.env` only (gitignored). `node scripts/secret-scan.mjs` checks exactly what git would publish.

On Windows, PowerShell may refuse `npm run ...` ("running scripts is disabled on this system"; it blocks `npm.ps1`). Use
`npm.cmd run setup` (and `npm.cmd` for every other command), run `.\setup.cmd`, or use cmd.exe. Git Bash is not needed.

## How a studio is laid out

| Path | What is in it |
| --- | --- |
| `studio/` | The queue, current task, roles, rules, gates list, decisions, memory, logs and notes |
| `harness/` | The tooling: tasks, locks, events, model router, merge train, supervisor |
| `qa/` | Playtest, goldens, regressions, soak, the self-test |
| `docs/` | Longer guides, one per area (the settings map is `docs/SETTINGS.md`) |
| `cartridges/` | Game sims and the contract they meet (`cartridges/README.md`) |
| `engine/` | Starter projects for the Godot and Unity engine tracks |

Also: `scripts/` (gates, setup, release, hooks), `game/` or `web/` (an adopted game), `.studio/` (local state, not committed).

## What to read next

- `AGENTS.md` (or `AGENTS.lite.md` in a Lite studio): the rules every agent follows, and the read order.
- `docs/SECURITY.md`: what an agent may never do, and what stays the owner's.
- `docs/QUICKSTART-FOR-HUMANS.md` and `docs/GAME-PLANNING.md`: your first half hour, then how to plan a game.
- `docs/AGENT-TOOLS.md`: plugging in Claude Code, Codex, Cursor, Grok, Antigravity or Aider.
- `docs/RUN-UNATTENDED.md`: running the studio without watching it.
- `docs/RELEASE.md`: the release and upgrade steps. `studio/llms.txt` is the full command sheet.

## Upgrading

Read `docs/RELEASE.md`, then run `npm run upgrade -- --preflight --ref <ref>` (read-only), and take the new version with
`npm run upgrade -- --merge <ref> --by <person>`; `npm run upgrade -- --rollback` undoes it. What changed, release by
release, is in `CHANGELOG.md` (the newest four in full, older ones one line each; the rest is in git history:
`git log -p -- CHANGELOG.md`) and in the newest `docs/RELEASE-<version>.md` notes.

## Licence

Proprietary. Copyright (c) 2026 Trever Max Hatch, all rights reserved. See `LICENSE`.
