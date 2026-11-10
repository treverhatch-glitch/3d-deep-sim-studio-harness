# 3D Deep Simulation & AI Game Studio — Agent Operating Rules (`AGENTS.md`)

This repository is a studio harness: it runs a crew of AI agents that build a deep simulation game. These are the
operating rules for every agent in the studio. Each says when it applies and why; where a rule and your task seem to
pull apart, the reason tells you which way to go.

---

## 0. One game per studio: starting a game

- This clone is one studio for one game. Its Game Bible, board and locks belong to that game.
- Asked to start a **new** game? Don't make a folder by hand or build it outside the harness. In an
  empty clone, run `npm run studio:reset -- --name "<game>" --yes`, then `npm run intake`.
- Asked to start **another** game next to this one? Run `npm run new-studio -- --name "<game>"`. It
  makes a second studio in a sibling folder (its own .env and play port). Then work there, from
  its START-HERE.md.
- Assets, art and code made outside the harness still come in through it: `npm run art -- propose`
  or `npm run asset`. Nothing goes into the game unrecorded.

## 1. Where to start

Start from the task, not from the repository: these files, in this order, tell you what the studio is doing and what
you are asked to do. Then read whatever the task needs, as deeply as it needs:

1. `studio/CURRENT_TASK.md` (Producers: run `npm run handoff` instead; it covers this list and more)
2. `studio/NEXT.md` (or `node harness/task.mjs next`)
3. `studio/memory/failures.md` (distilled notes only)
4. `studio/llms.txt` (the command sheet: open it when you need a command; it isn't loaded for you)
5. `studio/bible/BIBLE.md` and `NOT-DOING.md` (the game, its open phase, and what is never built)
6. `studio/VISION_LOCK.md`, `studio/PLAN.md` and `studio/decisions/` (`studio/MASTER.md` maps every key document)

To find a function, constant or key, run `npm run map -- find <name>` (one call: file, line range, arguments); `.studio/MAP.md` lists every code file in one line. Follow `studio/PITFALLS.md`: rules this game learned the hard way. `CHANGELOG.md` is the harness's release history: it describes behaviour later releases changed, so take no rule or command from it; `studio/llms.txt` lists every command as it is now. The owner's studio rules (autonomous mode, what no agent decides, notes for every agent): `npm run policy`.

See also `docs/READ-FIRST.md`.

---

## 2. Models and briefs

1. Which model runs a task is decided by the harness's routing and the owner's budget order, not by the agent on it.
2. A task with a long history (an escalated bug, many hand-backs) reads better from a prepared brief:
   `npm run brief -- <ID> --model` drafts one and a script checks it (`.studio/briefs/<ID>.prepared.md`). It is a
   starting point: open the history itself whenever the brief doesn't answer your question.

See `docs/ROUTING.md`.

---

## 3. Cartridges, Seed System & Closed-Loop QA

1. The game sim lives in `cartridges/<name>/` and follows the contract in `cartridges/README.md`.
   Start one with `npm run new-game <name>`. Pick it with `--cartridge <name>` or `"cartridge"` in `studio/gates.json`.
2. Every cartridge has a deterministic seed + fixed tick, a `TUNING` table, and a `start-to-win` scenario in `qa.mjs`.
3. Failures are recorded as `{ cartridge, seed, tick, description, actions }` where `tick` is the tick the cartridge broke on.
4. Replay with:
   - `node harness/replay.mjs --seed <seed> --tick <tick> [--cartridge <name>]`
   - or `node harness/replay.mjs --trace .studio/last-seed-failure.json` (stops on the failing tick)
5. Closed loop (`node harness/closed-loop.mjs`) records the real failure and escalates after `MAX_FIX_ATTEMPTS` (default 3). It does **not** auto-fix code.
6. A sim change that changes behaviour changes hashes: `npm run golden -- --update` and commit the hashes with the change.
7. After a human or strong model fixes a bug, add a replay to `qa/regressions/` and distill the lesson into `studio/memory/failures.md`.

---

## 4. Concurrent Work Rule (real locks)

Logging `editing` is not enough. Use the lock helper.

### Before starting work
0. New agent? Get your opening prompt: `npm run kickoff -- --role <role> --agent <unique-name> --model <model>`. `task start` writes your one-page brief to `.studio/briefs/<ID>.md`; read it first: it names what the task touches and what done means.
1. Use a unique owner name per running agent (`cursor-win2`, `claude-a`). Shared names such as `cursor`, `claude` or `builder` are refused.
   Export it once: `export STUDIO_LOCK_OWNER=cursor-win2`.
2. Claim the task: `node harness/task.mjs start <ID> --agent cursor-win2` (refuses work another agent claimed).
3. Claim the files or folder: `node harness/lock.mjs claim path:src/sim/ --owner cursor-win2` (a folder lock covers everything under it).
4. If a claim fails, do not edit. Wait or pick another task.
5. `npm run hooks:install` once per clone: the pre-commit hook refuses staged files locked by someone else and staged secrets.

### While working
- Stay inside what you claimed.
- Do not edit files locked by someone else.
- In a lane copy (`.lanes/<agent>`) `studio/` is the main checkout's (a link): only the board commands (`npm run task`,
  lock, proof ...) write there, and a Claude Code hook refuses an edit of studio config there. A lane changes top-level
  `studio/*.json` config through a proposal it commits, `studio-proposals/<ID>.json` (`{ "changes": [ { "file":
  "studio/<name>.json", "set": { "<a.b or /a/b>": <value> } } ], "why": "…" }`), which the landing applies to main
  (2.65.0, docs/WORK-ORGANIZATION.md); a protected file in it makes the lane tier C and waits for the owner. Other studio
  config (`studio/bible/*.json`, keys, approvals, presets) is changed on main by the owner or the Producer: hand the task
  back with a note naming the change. task done in a lane warns when main's studio config changed uncommitted.

### When finished
- `node harness/lock.mjs release <key> --owner cursor-win2`
- `node harness/task.mjs done <ID> --agent cursor-win2` (only the owner can finish a claimed task, and only once its
  done-check passes: `node harness/done-check.mjs <ID>` shows what is missing; how each kind of task finishes is in `studio/skills/`)
- `--force` finishes anyway, but it is logged and the Producer gets a P1 `Check forced done` task. Agents don't force: ask the owner, who types it (docs/FORCED-CLOSE.md)
- Out of usage or being swapped? `node harness/task.mjs pause <ID> --agent <you> --note "where you stopped"` hands it back with a note for the next agent
- A task that contradicts itself, or can't be done without bending a check? Use the honest exit, not a changed check: `npm run task -- impossible <ID> --why "<what contradicts what>" --agent <you>` releases it, holds it for the Producer and is not counted as a failure (no loop park, breaker or model escalation).
- `npm run verify` before calling it done; `npm run release` before a merge
- Update `CURRENT_TASK.md`

### Producer
- Assign non-overlapping work.
- Work through `Check forced done` tasks: run the skipped check (or order it) and accept or reopen the work.
- If two agents want the same area, pick one.

---

## 5. Human Approval Gate

Get a person's or the Producer's approval before these three, because each changes what every other lane builds on
or brings in something the studio then has to answer for:
- Pulling external assets (their licence and source must be recorded)
- Large refactors (every open lane conflicts with them)
- Changing core simulation rules (goldens, balance and the Bible all move)

An approval the protected check (`qa/protected-check.mjs`) passes counts, whoever recorded it: the owner's key, the owner's
proxy and beta mode are all the owner's (`npm run beta -- status`). The check judges approvals, not you: don't hand a task
back over who signed one it accepts.

Tricks attached to your brief as pre-approved (`studio/CHEATSHEET.md`, by the Director or Producer when the task was handed out) are approved for that task; use them without asking. Anything else still needs approval.

---

## 6. Usage numbers and assets

- Token numbers are what each tool reported when its session ended (`npm run tokens`).
- 3D assets come from headless Blender or blender-orchestrator (`docs/BLENDER-ORCHESTRATOR.md`), so they can be
  rebuilt from a script.

---

## 7. Sim Purity

The sim must replay identically from a seed: that is what lets a change be checked without a person playing it.

- No DOM, `window`, WebGL, or `three` inside simulation logic.
- Fixed timestep only.
- Seeded RNG only.
- JSON-serializable state only.
- Run `npm run verify` before calling work done. The purity gate also plays every cartridge with randomness, clock, timers and DOM trapped.
- Snapshot state before risky changes (commit it, or `git stash push -u -m <tag>`).

---

## 8. External tools

Optional external tools are listed in `docs/EXTERNAL-TOOLS.md`. Do not vendor them into this repo.


---

## 9. Best practices (recommended)

Not rules, but they keep accounts in good standing and the team fast: commit locally and push in batches,
stay in your own repos, use fine-grained tokens, use only keys you are entitled to (extra free accounts break most providers' terms), tools before freehand.
See `docs/BEST-PRACTICES.md`.

## 10. The attending game dev is optional

The harness must run without anyone watching. While a studio has an active game, the supervisor runs the
game-dev loop every few minutes (`STUDIO_GAMEDEV_INTERVAL`, 180 s; without the supervisor: `npm run gamedev`;
`STUDIO_WATCHDOG=off` opts out): stalled sessions end, a low queue is refilled from unmet charter exit
criteria, met milestones close, idle builder slots fill, landings are checked (layout, visual), a tool at
its quota or spend guard hands over to the next in the budget order, and the Director/Producer
development cycle keeps planning forward.

Expected role of an attending game dev (a person or an agent): **optional**. Their input adds tasks or
reprioritises them, approves assumptions the Director marked, and judges whether it is fun. Nothing in
production waits for them; if it does, that is a harness defect.
