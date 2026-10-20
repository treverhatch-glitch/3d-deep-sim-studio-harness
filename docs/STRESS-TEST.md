# Running a stress test with real API keys

Best practices for a long run where real agents, on real keys, build a real mini game. The public
repo never sees any of it.

## 1. Make a private copy

A fork of a public repo can't be private on GitHub, so mirror it into a new private repo instead:

```bash
gh repo create <you>/<studio-name> --private
git clone --bare https://github.com/<owner>/3d-deep-sim-studio-harness.git tmp-mirror
cd tmp-mirror && git push --mirror https://github.com/<you>/<studio-name>.git && cd .. && rm -rf tmp-mirror
git clone https://github.com/<you>/<studio-name>.git && cd <studio-name>
```

To pull later harness updates into the private copy: `git remote add upstream <public url>` and
`git pull upstream main`.

## 2. Set it up

```bash
npm ci && npm run setup                 # writes .env with a HUB token
npm run studio:reset -- --name "Mini Farm" --yes
npm run hooks:install                   # pre-commit refuses secrets and other agents' locked files
npm run intake                          # the game: play length (start with a demo), phases, layers
npm run bible -- sign --by <your name>  # when BIBLE.md reads right; build tasks wait until then
```

In `.env` (gitignored; `node scripts/secret-scan.mjs` checks what git would publish):

| Setting | Why |
| --- | --- |
| Provider keys (and `_2` keys if you have them) | The router fails over across all of them |
| `STUDIO_DAILY_TOKEN_CAP` | **Set this first.** Calls past it are refused and the Producer is told |
| `STUDIO_PRODUCER_NAME` | So script events and your Producer agent show as one person |
| `STUDIO_WATCH_INTERVAL` | 300 is fine; lower it to see hand-offs sooner during the test |
| `STUDIO_DIRECTOR_CMD` | The launch line from `npm run kickoff -- --role director --agent director-1 --tool …`, so pings start the Director |

Before any agent starts, check the models: `npm run models:check`. It asks each provider you have a
key for which models it serves (free, no tokens) and names any configured model that is gone; set the
matching `*_MODEL` in `.env`. A free dry run first is worth it: one builder on Aider + Ollama through a
few small tasks (`docs/AGENT-TOOLS.md`).

Give each agent its opening prompt: `npm run kickoff -- --role builder --agent claude-a --model claude-opus-5-5 --tool claude`
(one per agent, Producer included). `--tool` also prints the headless launch line for that tool.
Run every agent in this one checkout, not in separate worktrees, so they share the queue and locks. It sets the agent's name and model and gives it the work loop;
`task start` then hands it a one-page brief per task. Commits get `Studio-Agent`, `Studio-Model` and
`Studio-Task` trailers, so every change can be traced to who made it, on what model, for which task.

## 3. Run it

- `npm run hub`, then open `http://localhost:3847/?token=<HUB_TOKEN>`. The watcher and the daily
  retro run inside the HUB. Keep it on a second screen; switch to the Studio view to watch. Click
  any agent to see its task, its done checklist and who assigned it.
- The Producer starts with `npm run handoff` and works the queue; workers follow `studio/skills/`.
- Let agents hit real limits: hand-backs, the spend cap, provider failover and the watcher are part
  of what is being tested.

## 4. What to read afterwards

| Question | Where |
| --- | --- |
| Did the game get built, and do the gates pass? | `npm run verify`, `qa/reports/` |
| Which models made the most bugs for the work they did? | `npm run scorecard` |
| What did the studio learn, and what should change? | `studio/memory/retros/`, the Producer log |
| Where did agents stall, run out or get refused? | `studio/handoffs/`, `npm run watch`, the retro |
| What did the harness do well or badly? | `npm run notes -- list`, then `npm run notes -- export` to bring it upstream |
| What did it cost? | Tokens per provider in the War Room's "Model calls today", `.studio/runs/` |

Keep the private copy's notes. The lessons that are about the harness rather than your game are worth
bringing back to the public repo as a pull request from a person, without the game's code, keys or data.
