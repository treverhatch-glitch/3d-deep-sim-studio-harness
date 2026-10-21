# Starting a new game (and running several at once)

One studio is one game. A second game gets its own studio, a sibling folder made by one command:

```bash
npm run new-studio -- --name "Tin Moon"                       # a fresh studio next to this one
npm run new-studio -- --name "Tin Moon" --setup this          # ...with this studio's roles, departments, budget and pace
npm run new-studio -- --name "Tin Moon" --setup ../my-setup   # ...with a setup you or your agent made
npm run new-studio -- --save-setup ../my-setup                # save this studio's setup to reuse later
```

What the command does:
1. Clones the harness into `../tin-moon`, or the folder you give with `--dir`.
2. Copies this studio's `.env`, so the keys stay on this machine.
3. Picks the first War Room port no sibling studio uses (3848, 3849, …), and a matching `npm run play` port.
4. Installs, starts a fresh board with the name, and freezes the harness.
5. Writes `START-HERE.md`.

Several studios run at once, each with its own War Room window, agents and supervisor.
`npm run studio:start -- --install` registers each folder separately.

## Setups

A setup is a folder with the reusable parts of a studio, laid out like the studio:

| In the setup | What it gives the new game |
| --- | --- |
| `studio/roles/`, `studio/skills/`, `studio/presets/`, `studio/rules/` | your own roles, skills, presets and rules |
| `studio/divisions.json`, `studio/budget.json`, `studio/mode.json` | which departments are open, plan limits (`producerMayHireUpTo`), the pace |
| `cartridges/<id>/`, `web/<id>/` | a game template to start from |
| `intake-answers.json` | fills the intake (shape: `npm run intake -- --questions`); a person still reads and signs the Bible |
| `settings.env` | `STUDIO_*`, `HUB_*`, `AGENT_*` and `PLAYTEST_*` settings, such as which tool and model agents use |

What a setup never carries:
- **Keys, tokens or passwords.** Lines that look like one are dropped and named.
- **Ports.** Each studio picks its own.
- **Harness code.** Anything under harness/, hub/, qa/ or scripts/ is skipped.
- **A game's progress.** The board, events and the Bible stay with their game.

Applying a setup to a studio that already exists: `node scripts/studio-setup.mjs apply <folder>`.
