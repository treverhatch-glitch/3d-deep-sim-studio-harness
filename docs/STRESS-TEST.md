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

To pull later harness updates into the private copy: `git remote add upstream <public url>`, commit the board
(`npm run upgrade -- --check` says what isn't), then `git pull upstream main`. Never stash the board for an upgrade:
`docs/RELEASE.md` ("Taking a harness update into a studio").

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
| `STUDIO_BACKUP_DIR` | A Google Drive, Dropbox or OneDrive folder on your computer, shared with no one. The HUB backs up the studio's memory there daily, storing only what changed (`npm run learn -- backup` any time; `docs/BACKUPS.md`) |
| `STUDIO_BACKUP_KEEP` | Daily backups kept, plus the first of each month (default 60) |
| `STUDIO_BACKUP_MEDIA` | Newest screenshots kept in backups (default 20; 0 for none) |
| `STUDIO_REFERENCE_DIR` | Where the reference library keeps media; a synced folder keeps it reachable |
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

### The head model's first message

Give the Producer (the head model) its kickoff prompt, then this, so the run teaches the harness as
well as building the game:

> You are the overseer of this run as well as its Producer. Remember: the studio's memory is its
> files, so anything you don't write down is lost. Throughout the run, watch how it goes (agents
> following the loop, refusals and why, hand-backs, drift, spend, what the harness made easy or hard)
> and write it down: `npm run notes -- add --kind eval|well|bad|workaround|upgrade "…"`. At the end of
> each session, score it 1 to 5 with what worked, what didn't and what to change. Read `npm run learn`
> each session and act on the top item. Never delete earlier notes; add newer ones.

Start a Liaison too (`npm run kickoff -- --role liaison --agent liaison-1 --tool …`) and talk to it
whenever you have an idea, a change, a reference or an asset; the studio keeps running.

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
| What did the harness do well or badly? | `npm run notes -- list` (the overseer's evaluations included), then `npm run notes -- export` to bring it upstream |
| What keeps happening, and did lessons stick? | `npm run learn` (`studio/memory/LEARNED.md`); the backups in `STUDIO_BACKUP_DIR` |
| What did it cost? | Tokens per provider in the War Room's "Model calls today", `.studio/runs/` |

Keep the private copy's notes. The lessons that are about the harness rather than your game are worth
bringing back to the public repo as a pull request from a person, without the game's code, keys or data.
