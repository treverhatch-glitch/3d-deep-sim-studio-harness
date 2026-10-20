# Running a test

A test run builds a real game with real agents on a clone of the harness, without changing the
harness, and sends the results to a shared folder. For long runs on paid keys in a private repo, see
also `docs/STRESS-TEST.md`.

## 1. Clone and set up

You need Node 22.3 or newer, Python 3, Git, and (to send results) Google Drive for desktop or another
synced-folder app.

```bash
git clone https://github.com/treverhatch-glitch/3d-deep-sim-studio-harness.git my-test-run
cd my-test-run
npm install
npm run setup                                  # .env with a fresh HUB token
npm run preflight -- --fix                     # hooks on, harness frozen, git push off
npm run studio:reset -- --name "<game name>" --yes   # a fresh studio for this game
```

`--fix` freezes the harness (commits to `harness/`, `hub/`, `scripts/`, `tools/`, the `qa/` scripts
and `studio/gates.json` are refused) and turns off `git push` for this clone, so nothing reaches the
public repo. Game work (`cartridges/`, `studio/`, `qa/golden/`, `src/`, assets) commits as normal.

## 2. Fill in `.env`

```
STUDIO_PRODUCER_NAME=producer-1
STUDIO_BACKUP_DIR=<synced folder for backups>
STUDIO_RESULTS_DIR=<synced folder for results>
STUDIO_DAILY_TOKEN_CAP=<a number, if you add router keys>
```

On Windows with Google Drive for desktop, a folder shared with you appears under
`G:\My Drive\` once you add a shortcut to it in My Drive. Keys are optional: agents running in their
own tools (Claude Code, Codex, Cursor) don't need router keys. Never commit `.env`.

Run `npm run preflight` again. It should say READY.

## 3. Run it

```bash
npm run hub                                    # the War Room: http://localhost:3847
npm run kickoff -- --role producer --agent producer-1 --model <model>
```

Paste the kickoff into the Producer's session. The Producer starts with `npm run intake` (the person
answers; a 15 to 30 minute demo is the easiest first game), then the Bible is signed by the person,
then work is queued. Each worker gets its own kickoff:
`npm run kickoff -- --role builder --agent builder-1 --model <model>`.

While it runs:

- The HUB writes `REPORT.md` and a snapshot to the results folder every hour, and backs up daily.
- **Stop all agents** in the War Room (or `npm run task -- stop --by <name>`) holds every new start.
- Harness problems go in notes (`npm run notes -- add --kind bad "..."`), not in harness code.

## 4. Finish

```bash
npm run run-report -- --final
npm run learn -- backup
```

To return the clone to normal: delete `.studio/harness-frozen`, and
`git remote set-url --push origin <the clone URL>`.
