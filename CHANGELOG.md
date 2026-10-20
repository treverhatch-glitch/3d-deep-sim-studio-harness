# Changelog (`CHANGELOG.md`)

All notable upgrades to the **3D Deep Simulation & AI Game Studio Harness** are documented in this file.

---

## [2.15.0] — 2026-10-21
From the first real game run ("Next Floor", Jed, v2.14.0). Each fix was reproduced first and has a self-test.
### Fixed
- **B1, verify could never pass after `studio:reset`.** The self-test now starts every copy from a fixture board and an empty pre-production state (`qa/fixtures/studio/`), never the live studio, and runs with a clean environment (no inherited `STUDIO_LOCK_OWNER`, cartridge, folders or keys). Reproduced Jed's case (reset, a started task, the owner exported): 17/17 required gates green.
- **B2, gates tested the template.** The active game lives in `studio/game.json` (written by `new-game`, never frozen). Every gate run prints which game it tested; preflight warns while it is still the template.
- **B9, closing a handed-back task.** done-check counts commits tagged with the task from before its latest start. A forced done with `--reason` and `--accepted-by <person>` is logged without a follow-up task.
- **B11, over-broad locks.** Claims on whole top-level folders are refused unless `--wide "<why>"` is given; the refusal says how to narrow it.
- **B12, scope-guard false positives.** The refusal names the matched word and layer; `--not-layer <id>` queues the task and tells the Director.
- **B7, signed Bible rewritten silently.** Changing the core answers or phases after signing marks the Bible amended and holds new build tasks until a person re-signs (earlier signatures kept in `signHistory`). `bible pillars set … --by <person> --decision <file>`; `bible sign --via "<where they approved>"`.
- **B13:** intake accepts "one per line" answers as a newline string; `.gitignore` uses `/references/`; reports to keep go in `qa/reports/kept/`; new `task show <ID>`; `task next --role --agent` gives your own role's work, never another agent's; `idea --help`; shaping notes keep 20,000 characters and warn when cut; the idea done-check names the real idea; the Director kickoff handles storyboard tasks; macOS Drive paths in the docs.

---

## [2.14.2] — 2026-10-21
### Fixed
- Preflight reported router keys that weren't set: an empty `KEY=` line in `.env` borrowed the next line as its value. Found while setting up the first real test on Windows.

---

## [2.14.1] — 2026-10-21
### Added
- **`npm run review -- <ID> [--local]`**: a model from another company reviews a task's tagged commits (and its spec, for system tasks) through the router, and writes the review with `model-family:`, `implementer-family:` and one verdict. `--local` uses only your Ollama model, so a studio with one company's models can still close system tasks. Refuses a same-family reviewer; a reply with no clear verdict counts as changes.

---

## [2.14.0] — 2026-10-20
### Added
- **`npm run preflight [-- --fix]`**: checks a clone is ready for a test run (Node, hooks, `.env`, HUB token, Producer name, backup and results folders writable, Python, keys and cap, the required gates). `--fix` installs the hooks, freezes the harness (`.studio/harness-frozen`: the pre-commit hook refuses commits to harness files), turns off `git push` for the clone, and makes `.env` with a strong token.
- **Stop all agents**: a War Room button and `npm run task -- stop | resume`. While stopped, no task can start; agents hand back and wait.
- **`npm run run-report`**: REPORT.md (progress, whether the checks held, models, what repeated, the harness as agents found it, the overseer's evaluations, what needed a person), hourly snapshots and the run's files, in `STUDIO_RESULTS_DIR`. The HUB writes it hourly.
- `docs/TEST-RUN.md`: clone, set up, run, finish.
- CI runs the War Room browser test (`war-room-browser` job). The test also covers Stop and Resume and the queue: 30 checks.
### Changed
- The queue lists every open task and scrolls inside its box (newest done shown first).
- Every command reads studio settings (`STUDIO_*`, `HUB_*`) from `.env`, not only the HUB, so backups and the Producer name work from the command line too. `.env.example` lists the backup, results and reference folders.
- Kickoffs tell agents about the stop switch and the frozen harness; the Producer writes run reports.
- War Room "add task" with the type `system` gets its prefix.

---

## [2.13.1] — 2026-10-20
### Added
- **`npm run hud:check`** (optional gate `hud`): opens the War Room in Chromium on a throwaway copy of the studio and uses it like a person: all three views at desktop and phone sizes (no errors, nothing off the side), the agent drawer, adding a task, messaging the Producer, live updates, pitching an idea, answering a follow-up, and the sharing box. 27 checks; skips without a browser.
### Fixed
- The queue's "Next up" lists the most urgent first and says how many more are in `studio/NEXT.md`; a task added from the page was hidden past the eighth.
- The Studio view's "Bugs" counted every open P0 and P1 task; it now counts bug tasks.
- The Producer (`STUDIO_PRODUCER_NAME`) and whoever signed the Game Bible sit in the Producer's office, not Engineering.
- The page has an icon (the missing favicon was a 404 on every load). On phones the activity list scrolls in place instead of pushing the controls far down.
- `system` is in the War Room's task-type list.

---

## [2.13.0] — 2026-10-20
### Fixed
- **Node and Python now hash every state alike.** Canonical JSON is built directly in both: keys in code-point order (`JSON.stringify` moved integer-like keys such as `"0"`, `"10"` to the front) and numbers in JavaScript's layout (Python wrote `1e-05` for `0.00001` and `1e-07` for `1e-7`). Emoji keys sorted differently too. `qa/hash-vectors.json` holds 20 edge cases both languages must match; a 5,000-state fuzz agreed. No existing golden changed.
- Determinism checks in the vertical slice, soak, balance sweep and playtest compare **SHA-256**, not the display hash. Playtest reports record `finalSha256`, and the playtest done-check requires it.
- Python output on Windows is UTF-8 (`PYTHONIOENCODING`), so `…` in output can't throw.
### Added
- Scenario goldens pin **`actionsSha256`**: the same end reached by different actions fails.
- A cartridge with its own display hash is marked `hashKind: custom`; Python then checks SHA-256 only. `qa/test-golden.py` also replays every regression, and `check-regressions` checks the display hash.
- **Signed results bind code, inputs and outputs:** a SHA-256 over each cartridge's files, each golden's and regression's file SHA-256, and the harness runner. Signing refuses gate runs that are stale or missing a required gate. `verify --replay` checks the code matches and re-runs purity, isolation and the vertical slice as well.
- **Backups that save space** (`docs/BACKUPS.md`): each file content stored once, gzipped; `latest/` with plain copies and STUDIO-MEMORY.md; `restore --at`; `prune` (the HUB keeps 60 daily plus one a month). Also keeps the newest 50 playtest reports and 20 screenshots.
- **The data-sharing answer** (`npm run data`): intake and the Game plan view ask whether the studio's records may be shared with AI research partners, pre-ticked to allow. Declining stops every export; manifests record whether the answer was the default, confirmed or declined.

---

## [2.12.0] — 2026-10-20
### Added
- **A bug's regression must fail before the fix.** The bug done-check replays the regression on the code before the task's first `Studio-Task` commit, in a temporary git worktree (`qa/fails-before.mjs`, cached). A regression that passes there too guards nothing and is refused. The bug skill now covers the whole loop: triage, reproduce, `git bisect run` with the replay, smallest fix, pinned SHA-256, lesson, hand-off.
- **`system` tasks** (`--type system`, skill `studio/skills/system.md`): a spec in `studio/bible/systems/` that ends with "## For the next agent", a scenario in `qa.mjs`, goldens, a playtest, a verify, and an approval from a reviewer of another model family.
- **Cross-family review.** `harness/families.mjs` maps model names to their maker. Reviews start with `model-family:` and `implementer-family:`; the reviewer gate is now **required** and refuses a same-family approval.
- **Measured renderer budget.** The game sets `window.__render = { drawCalls, triangles, lights, frameMs }` next to `__sim`; with `RENDER_URL`, `scripts/check-renderer-budget.mjs` samples it in Chromium and fails over the budget block in `studio/rules/renderer-budget.md`. The code scan remains as the fallback.
- Trajectory export: `--with-diffs` (scrubbed patches), the model behind each commit, provider families per record, and a terms warning in the manifest.
### Changed
- Learning backups include the event log, the last gate run and task briefs, which live only in `.studio/`.
- Roadmap: on-chain options as a later opt-in add-on (stamp, archive; fully on-chain games not planned) and data partnerships with AI labs.

---

## [2.11.0] — 2026-10-20
### Added
- **Agent identity**: core role cards (builder, playtester, reviewer, designer, fun tester, reference scout, 3D, Producer) gain "Who you are": what good work looks like, common mistakes, questions to ask, and an example. Every focus brief now includes it, plus where agents in that role get refused most (from the event log) and lessons filed for the role (`- **Role**:` in `failures.md`).
- **Player personas** (`studio/personas/`: first-timer, calm player, min-maxer, explorer; add your own). `npm run fun` reads the game through each persona's lens: time to first win and dead time, pressure from waiting, room to optimise, variety of actions.
- **The game's voice**: an intake question and three follow-ups (a winning line, a failing line, words to never use) build a voice guide in the Bible; `npm run bible -- voice` adds to it. Every brief for work players read or hear carries it.
- **Signed results** (`npm run sign`): Ed25519 key pair (private key never committed), signed manifests of the verified state (goldens' and regressions' SHA-256, gates, commit, Bible and asset manifests), `verify --replay` re-runs the goldens. Refuses to sign a red verify unless recorded with `--allow-red`.
- **Opt-in trajectory export** (`npm run trajectories`): one labelled record per finished task (clean, needed-fixes, caused-bug) with its commits and outcomes, scrubbed of secrets, with consent and terms in a manifest. `harness/secrets.mjs` shares the patterns with the secret scan.
- `docs/SIGNED-RESULTS-AND-DATA.md`, including what a public receipt would and wouldn't prove.
### Changed
- The assets gate also covers `public/assets/`.

---

## [2.10.0] — 2026-10-20
### Changed
- **Two-tier hashing.** Golden files and regressions now pin **SHA-256** of the canonical state (64 hex), checked in Node and independently in Python. The display hash for the HUD and reports is now a true **FNV-1a 64-bit** hash (one lane, standard test vectors in the self-test) instead of two correlated 32-bit lanes. Both hash the same bytes: canonical JSON as UTF-8. `harness/hash.mjs` stays browser-safe (SHA-256 loads Node's crypto only when called), so cartridges keep no imports. All goldens and the regression were regenerated in this release. Node 22.3 or newer.
- `docs/HASH.md` explains what each hash is for, and what a hash does and doesn't prove.
- Roadmap: signed results, opt-in trajectory export, and optional public timestamp receipts.

---

## [2.9.0] — 2026-10-20
### Added
- **The Liaison** (`npm run liaison`, role `liaison`, `kickoff --role liaison`): the agent the game dev talks to. It asks until it understands, sorts what it heard (idea, direction, asset, question), reads it back and asks "Shall I push it on?". Only the dev's yes sends it on: ideas to the Idea Board as "dev, confirmed" and straight to R&D with a Director ping; directions to a Producer task with the Director checking the fit; assets and questions to the Producer. Nothing running stops.
- **Labels on the Idea Board**: dev confirmed, dev pitched, agent, playtest, and "new" since you last looked. Dev-confirmed ideas go first.
- **Experiments** (`npm run experiment`): start one, work in it (its tasks, or `STUDIO_EXPERIMENT`), and every commit carries a `Studio-Experiment` trailer. `keep` it, or `drop` it in full or `--only` some files: undo commits that leave other work in place, refused rather than guessed where later work changed the same lines.
- **Reference library** (`npm run ref`): games, features, timestamps, what to take and avoid, with the media downloaded and kept in a folder per reference, in `references/` or `STUDIO_REFERENCE_DIR` (a synced Google Drive folder works). Web pages stay links until you attach a saved copy. `frames` pulls stills for image-reading models.
- **Game assets with a recorded statement** (`npm run asset`): a person states they own a file or hold a licence; it goes to `assets/` with who said so, when, the licence and a checksum. Reference-only files go to the library. New required **`assets` gate**: every shipped file recorded and unchanged, and no game code pointing at the reference library.
- **Intake**: first question "new or existing?"; **follow-up questions** for each phase and kept or explore layer from a fixed bank, plus `--model` questions from a cheap model checked by a script; answer in a terminal, with `--answers`, through the Liaison, or in the War Room.
- **A stronger learning loop** (`npm run learn`): the same failure on two or more days and the lesson that didn't stick, retro suggestions raised again and again, the overseer's evaluations (`notes --kind eval`). The HUB rewrites `studio/memory/LEARNED.md` daily and backs every learning file up to `STUDIO_BACKUP_DIR`, with a one-file `STUDIO-MEMORY.md`. The Producer's kickoff makes it the overseer of the run; `docs/STRESS-TEST.md` has the head model's first message.
- War Room Game plan view: follow-up questions to answer, experiments and the reference library. Endpoint `POST /api/followups`.

---

## [2.8.0] — 2026-10-20
### Added
- **Game Bible** (`studio/bible/bible.json`, written out as `BIBLE.md` and `NOT-DOING.md`): the game as structured data a future front end can drive. `npm run bible` shows what's missing, signs it (a person, not an agent), and opens phases.
- **Intake** (`npm run intake`, `--answers <file>`, `--ask`, `--questions`): about 19 questions with **play length first** (a 15 to 30 minute demo is the recommended start; longer games say how much of the game dev's time they need), three phases, and every progression layer (levels, tech tree, unlocks, factions and governance, …) answered yes, explore or no. It suggests the layers games like yours usually have, and can cross out the rest in one step. Queues pre-production once: a reference study, storyboards, R&D studies for explore layers, and the person's sign-off. Example: `studio/templates/intake-example.json`.
- **Task gates from the Bible**: until a person signs, build tasks wait (prototypes and `--infra` tooling allowed); after, build tasks need `--phase 1|2|3` (only open phases) and `--serves pillar:<name>|layer:<id>` or an approved `--idea`; titles that touch a crossed-out layer are refused. Pillars and crossed-out layers stay locked after signing.
- **The Director** (`npm run director`, role `director`): pinged daily by the HUB, by the Producer before it generates tasks (`task add` warns when it hasn't), when an idea is placed, and on phase changes. A ping queues one review task, writes `.studio/briefs/director.md`, and starts `STUDIO_DIRECTOR_CMD` (at most hourly, under the spend cap). Reviews in `studio/bible/reviews/` have their own done-check; a `phase-ready` verdict lets a person open the next phase. A free drift report flags work that serves nothing, touches crossed-out layers or runs ahead of the open phase.
- **The Idea Board** (`npm run idea`, roles `rnd` and `planner`): captured, shaped, placed, decided by the Director, then scheduled with `task add --idea`. The watcher's pass hands new ideas to the Producer in one task. Idea tasks have their own done-check.
- **War Room Game plan view** (`?skin=plan`): the three phases with the layers that enter each, crossed-out layers, approved ideas, the Idea Board, a box to pitch an idea, and the Director's verdict with the drift report. The Ops view has a box to message the Producer (`studio/producer/INBOX.md`, first in its briefing). New endpoints: `GET /api/bible`, `POST /api/intake`, `POST /api/bible/sign`, `GET|POST /api/ideas`, `POST /api/inbox`; every `/api/` write needs the token.
- `docs/GAME-BIBLE.md`; VoiceStudio as an optional audio plugin with best practices in `docs/AUDIO-AND-NARRATIVE.md`.
### Changed
- `npm run studio:reset` and `npm run onboard` start an unsigned Game Bible, so a new or onboarded game begins in pre-production. The Producer's briefing opens with the game plan, new messages and ideas; its kickoff prompt pings the Director before generating tasks.

---

## [2.7.0] — 2026-10-20
### Added
- **Cheap prepare, strong act is real** (`npm run brief -- <ID> --model`): reads a bounded window of the task's history (its last events, hand-off notes, matching lessons, newest QA result, files touched); a local or free model drafts a 300-word brief in five sections; a script checks it (sections, word cap, task named, only real files and task IDs) and throws a bad draft away for its own version. Skips the model when the history is short. The focus brief and kickoff prompts point to it; the Producer sees words in and out. Self-tested with a fake local model.
- **Windows CI job** running every required gate on `windows-latest`.
- **`docs` gate**: fails when a doc names an `npm run` script, or a `node`/`bash` file, that doesn't exist.
- `docs/ROADMAP.md`: what's next and how each known gap gets fixed, including pre-production, three game phases with layers kept or crossed out, the Idea Board and the Director.
### Fixed
- Gates run on a clean Windows machine: the isolation check and secret scan are Node scripts (the `.sh` files call them, and the pre-commit hook uses the Node scan), and Python is found as `python3`, `python` or `py -3` (skipping the Windows Store alias), or set with `STUDIO_PYTHON`.
- The focus brief path prints with forward slashes on Windows.
- Purity can no longer be dodged through the Function constructor (`(() => {}).constructor(…)`, `.constructor.constructor`): flagged statically and trapped at runtime.
- Claiming a folder and a file inside it at the same moment can no longer both succeed (short mutex around folder claims).
- One read order for agents (`AGENTS.md`); docs say `npm run hub`; `npm run setup` installs packages when they're missing.

---

## [2.6.0] — 2026-10-20
### Added
- **Agent drawer in the War Room**: click any agent (a row in Ops, a person or desk in the Studio view) to see its current task, who assigned it and when, the done checklist ticking live, the skill's steps, hand-off notes, its claims, what it finished today, what it assigned (for the Producer), its recent activity and its scorecard. `GET /api/agent?name=`. It reads the studio's files when opened and every 2 seconds while open; no AI is used.
- **Content-based done-checks**: a build task needs real changes (commits tagged with it, or edits) and a full verify after the last one; docs need a changed `.md`; a bug needs a regression with seed, tick and pinned hash and a lesson naming the task or bug; a balance sweep needs a `(current)` row and must be newer than the last game change; fun and playtest reports must cover the current build; a study needs 120+ words; a review must name what it reviews and give a verdict. `done` and `done-check` print a `[x]`/`[ ]` checklist.
- **Bugs traced through commit trailers**: the scorecard follows a bug's fix commits back to the last commit from another task that touched the same code, and counts it against that commit's model (`traced`), even without `--caused-by`. Retros use it too.
- **`npm run models:check`**: asks each provider you have a key for which models it serves (free model-list endpoints, no tokens) and names configured models that are gone, with close matches.
- **`kickoff --tool claude|codex|cursor|grok|agy|aider`**: prints a headless launch line for that tool with the agent's name and model set.
- **`docs/AGENT-TOOLS.md`**: how to plug in Claude Code, Codex, Cursor, Grok Build, Antigravity (which replaced Gemini CLI for personal accounts) and Aider + Ollama, with sources. Recommends one shared checkout over separate worktrees, and a free Aider + Ollama dry run before a paid run.
### Changed
- Anthropic's default model is `claude-sonnet-5-5`. Gemini models can be set with `GEMINI_PRO_MODEL` and `GEMINI_FLASH_MODEL`.
- Skills' "Done means" lines match the new checks.

---

## [2.5.0] — 2026-10-20
### Added
- **Focus briefs**: `task start` writes `.studio/briefs/<ID>.md`, one page an agent reads instead of the repo (done means, the skill's steps, notes from whoever worked on it before, meeting mentions, its claims and others', off-limits areas, related lessons, gate state, the exact finish and hand-back commands). `npm run focus -- <ID>` rebuilds it.
- **Kickoff prompts** (`npm run kickoff -- --role … --agent … --model …`): a paste-ready opening prompt for any agent tool, Producer included.
- **Harness notes** (`npm run notes`, `studio/harness-notes/NOTES.md`): what worked, what didn't, workarounds and upgrade ideas about the harness itself. Kept across `studio:reset`, shown in the briefing, exportable upstream.
- **Commit trailers**: a commit-msg hook adds `Studio-Agent`, `Studio-Model` and `Studio-Task`, so every change traces to who made it, on what model, for which task.
- **Studio view work animations**: debugging agents squash bugs, studies read a book, playtests hold a controller, balance work tips a scale, reviews sweep a magnifier, docs scribble, code changes float `{ }`. Reactions: confetti on done, a head shake on a refused done, a sweat drop on a forced one, a low battery on a hand-back.
- **The watcher sleeps and wakes**: it dozes in the Producer's office between passes, then wakes on each pass, looks around with its beacon flashing and says what it found.
### Changed
- Hatchfield is fully separate: `qa/hatchfield.adapter.mjs` is now the generic `qa/browser.adapter.mjs`, the example game no longer sets `window.__hatch`, the playtest global is configurable (`PLAYTEST_GLOBAL`, default `__sim`), and the OpenRouter referer names this repo.

---

## [2.4.0] — 2026-10-20
### Added
- **Model scorecard** (`npm run scorecard`): per model, tasks finished, task points (size 1-5, default by type, `--size` on `task add`), confirmed bugs (a bug filed with `--caused-by <task>`, or a task reopened with `task reopen`), bugs per 10 points so harder work isn't punished for its size, closed-loop failures shared among suspects, and refused, forced and handed-back work. Shown in the Ops view, as a bug badge on desks in the Studio view, and in the Producer briefing.
- **Self-improving retros** (`npm run retro`): a daily retrospective in `studio/memory/retros/` written by a script from the event log, ending in suggestions (tighten a skill, split big tasks, route away from a model, raise or lower the spend cap). The HUB writes one a day, `session:start` writes one if today's is missing, and the briefing lists the open suggestions for the Producer to accept or reject.
- **Daily spend cap** (`STUDIO_DAILY_TOKEN_CAP`): the router refuses calls past the day's token total and the watcher tells the Producer.
- **`npm run studio:reset`**: a fresh plan, log and queue for a new game in your own copy, archiving the previous project's notes.
- **`docs/STRESS-TEST.md`**: running a long test with real keys in a private copy.
- `STUDIO_PRODUCER_NAME` merges script events into the Producer agent; the event log rotates past `STUDIO_EVENTS_MAX_MB`.
### Changed
- **War Room v3 is the HUB's home page**, with buttons behind the token: start, pause, done and reopen tasks, add tasks (type, size, caused-by), sign off balance and fun, and run the watcher. The old React War Room is retired to `/legacy` for one release.
- The watcher's list of uncommitted files leaves out the studio's own bookkeeping.
- Sign-offs from the War Room count as signed in the briefing.
- In the Studio view, people using War Room buttons sit in the Producer's office in a gold cap, and the watcher is a small robot (it is a script), so neither is mistaken for an agent.

---

## [2.3.0] — 2026-10-20
### Added
- **Done-checks by task type** (`harness/done-check.mjs`): `task done` refuses until the proof for that kind of work exists, newer than the task's start. Change and docs: a full green verify. Bug: a pinned regression, a lesson in `failures.md` and a green verify. Balance and fun: a fresh report. Playtest: a report in `qa/reports/`. Study: a `study.md`. Review: a note in `studio/reviews/`. `--type` on `task add` sets the type.
- **`--force` pings the Producer**: it still closes the task, writes a `task.forced` event, flags it in the War Room and queues a P1 `Check forced done` task for the Producer.
- **Skills** (`studio/skills/`): one short file per kind of task (When, Steps, Done means, Never). The builder skill is the edit, test, stop loop.
- **War Room v3** (`/v3`): files-only HUD with two skins. Studio view: themed room per division, staff dressed by division, agents walk to the Producer's office to report and the Producer walks over to hand out work, live widgets (queue board, build light, test board, shipped trophies).
- **Plugin registry** (`studio/plugins.json`, `harness/plugins.mjs`) and the game study guide (`docs/GAME-STUDY.md`).
- `docs/BEST-PRACTICES.md`: recommendations, not rules.
- **Producer handoff** (`npm run handoff`): a briefing built from files for whoever holds the Producer role (plan, log, decisions, what needs attention first, queue with owners, claims, gates, playtest, last failing seed, open bugs, sign-offs, lessons, meetings, last 24 hours, key documents). Saved to `.studio/briefs/producer.md`.
- **Master documents**: `studio/MASTER.md` (the map of key documents and how to take over), `studio/PLAN.md` (the master plan), `studio/producer/LOG.md` (the Producer's reasons, newest first; `node harness/handoff.mjs note`).
- **Meetings** (`harness/meeting.mjs`): the Producer meets several agents at once; notes in `studio/meetings/`, actions become tasks, the outcome goes into the Producer log. In the Studio view everyone walks to a meeting table and back.
- **Handing work back**: `task pause <ID> --note` returns a task to the top of the queue with a note in `studio/handoffs/<ID>.md`; the next agent sees it on `task start`.
- **Watcher** (`npm run watch`; runs on its own every 5 minutes while the HUB is up and at `session:start`): a zero-token script that requeues work whose claim expired, flags silent agents, unclaimed handed-back work and provider outages, and gives the Producer one `Watch:` task at a time. Its requeue note carries the agent's last messages and the repo's uncommitted files. The Producer briefing shows a fresh, read-only watcher pass.
- **Onboarding an existing game** (`npm run onboard`, `docs/ONBOARDING-A-GAME.md`): read-only scan of the game's folder, a fact sheet in `studio/game/GAME.md` that the Producer's briefing shows, and the onboarding tasks.
- **Models in the War Room**: `STUDIO_AGENT_MODEL` or `task start --model` tags every event; desks show the model, and silent agents holding work fall asleep ("z") in the Studio view.
- Events can name who they are for (`--to producer`).
### Changed
- The self-test proves every done-check refuses unfinished work, that `--force` reaches the Producer, that the handoff briefing reflects the studio's state, and that meetings write notes and tasks.
- `studio/MASTER.md` and `studio/PLAN.md` are required by the session check.
### Fixed
- `.studio/usage.json` and the status fallback showed invented token savings and quota use. They now show zeros until something is actually measured.
- The status command and the old War Room estimated "tokens saved" from the number of events (and showed 84% and $4.68 by default). They now show only savings a tool measured.
- Handing a task back now frees the agent's folder and file claims too, so the next agent can take the same files.
- An agent named like `grok-producer` sits in the Producer's office, not Engineering.
- A fresh clone starts with a current starter queue and an idle checkpoint instead of notes from an older version.
- `npm run setup` pointed at a file that doesn't exist (`hub/server.js`); it now lists the current commands.
- The briefing's "how fresh" times use each document's last commit, so a fresh clone doesn't show everything as "1 min ago".
- Tasks queued by a meeting or the watcher are attributed to whoever queued them.

---

## [2.2.1] — 2026-10-20
### Changed (dependency and tooling refresh)
- Node: supported on 22 and 24 (the LTS lines; Node 20 is end-of-life). CI tests both.
- GitHub Actions: checkout v7, setup-node v7, setup-python v7 (no more Node 20 deprecation warning); Python 3.13 in CI.
- CI: new `war-room-build` job builds the War Room and type-checks its React components (`npm run hub:build`).
- Root dev tools: Playwright 1.64.1, Vite 8.3, TypeScript 5.9 (TypeScript 7 not adopted yet: it is the native rewrite and needs its own migration).
- War Room: React 19, @xyflow/react 12.12, xterm 6 (also in the CDN page), Vite 8, @vitejs/plugin-react 6. Lockfiles committed.
- MCP pins: Playwright MCP 0.0.83, Serena v2.1.0 (context `ide`; `ide-assistant` was renamed), blender-orchestrator pinned to a commit SHA.

---

## [2.2.0] — 2026-10-20
### Fixed
- **Purity gate was bypassable**: aliases (`const r = Math.random`), destructuring, `Date()`, `globalThis[...]`, dynamic `import('three')`, `crypto.randomUUID`, timers and `performance['now']` all passed. Now a wider static scan plus a runtime probe that plays every cartridge with those globals trapped.
- **Isolation gate exemptions**: any line containing `playtest`, `__sim` or `__hatch` was skipped. Removed; `.js/.cjs/.jsx` now scanned.
- **Secret scan missed the providers this harness routes to** (OpenAI `sk-proj-`, OpenRouter, NVIDIA, Groq, xAI, Google OAuth) and flagged a developer's own ignored `.env`. It now scans exactly what git would publish.
- **Golden stubs passed**: a missing or `REPLACE…` hash was silently rewritten and the gate passed. Now it fails unless `--update`; a game with no golden fails; Python re-hashes the real replayed state.
- **Regressions without a hash passed.** Now they fail.
- **Optional gates failed `npm run verify`**; optional failures now warn only.
- **Gates dirtied tracked files** (`studio/balance/latest.md`, `studio/fun/latest.md` on every run). They write only with `--write`; `npm run release` fails if a gate changes a tracked file.
- **Locks**: anyone could `task done` a task claimed by another agent, and the lock leaked; `task start` without `--agent` said "locked". `file:` and `path:` keys could collide and nested path locks overlapped. All fixed; shared tool and role names are refused as owners.
- **HUB**: the War Room page never sent the token, so its buttons and socket always got 401; a foreign Host header was served (DNS rebinding); `0.0.0.0` started with no token; the `.env.example` placeholder token unlocked writes if left unchanged; `GET /api/brief` wrote a file; frame telemetry and boot events showed invented numbers. All fixed and covered by `qa/hub-smoke.mjs`.
- **Closed loop recorded "ticks run" as the failing tick** and parsed stdout. It now records the tick the cartridge failed on, from a JSON report, and the trace replays to that tick.
- **Balance sweep was not a sweep**: it subtracted credits outside the sim and the example had no win state (0/4 wins everywhere).

### Added
- `harness/cartridge.mjs`: load any cartridge by name (`--cartridge`, `STUDIO_CARTRIDGE`, or `studio/gates.json`); every tool uses it.
- `npm run new-game <name>`: copies `cartridges/_template`, plays it, writes real golden files.
- `example-sim` gets a `TUNING` table, win/lose outcomes and invariants; `qa.mjs` scenarios with a `start-to-win` policy.
- Vertical slice with a golden hash (`qa/golden/example-sim-start-to-win.json`), checked by `qa/vertical-slice.mjs` for every game.
- `studio/balance/sweep.json` + a real `TUNING` sweep; fun proxies from real runs (idle vs played).
- `qa/selftest.mjs` now proves every required gate fails for its planted reason, after a clean-copy control, plus locks, claims, the pre-commit hook, the closed loop and new-game.
- `npm run hooks:install` (also run by setup): `scripts/hooks/pre-commit` blocks staged secrets and files locked by another owner.
- `npm run release`: syntax, required gates, closed-loop proof, read-only gates, changelog entry.
- Gates: `playtest`, `soak`, `hub-smoke`; `npm run setup` writes a random `HUB_TOKEN`.

---

## [2.1.0] — 2026-10-20
### Added
- **One-Command Setup (`npm run setup` / `scripts/setup.mjs`)**: Creates `.studio/`, `.env`, verifies `.studio/events.jsonl`, and checks readiness in one step.
- **Prepare-Then-Escalate Briefs (`harness/prepare-brief.mjs`)**: Cheap/local model reads `.studio/events.jsonl`, `studio/memory/failures.md`, `studio/CURRENT_TASK.md`, and `studio/NEXT.md` to write a `<= 300`-word execution brief for strong models.
- **Shared Improving Memory (`studio/memory/failures.md` & `docs/MEMORY.md`)**: Implements the Hermes Agent (Nous) 4-bullet post-fix distillation rule (`What broke`, `Root cause`, `The fix that worked`, `How to avoid it next time`).
- **Deterministic Seed Replay & Closed-Loop Gate (`harness/replay.mjs`, `harness/closed-loop.mjs`, `qa/hatchfield.adapter.mjs`, `qa/visual-check.mjs`)**: Enforces mandatory early seed + tick systems (`{ seed, tick, description }`), exposes `window.__hatch` / `window.__sim`, and auto-escalates after `3` failed retries.
- **Expanded Blender Primitives & Orchestrator Docs (`tools/blender/generate_glb.py`, `docs/BLENDER-ORCHESTRATOR.md`)**: Added `crate`, `cone`, `vehicle`, `beacon`, and `hangar` headless `bpy` presets plus `mlolson/blender-orchestrator` guide.
- **New Roles & Cartridge Example**: Added `studio/roles/asset-3d.md`, `studio/roles/playtester.md`, and `cartridges/example-sim/index.mjs`.
- **Daily Rollup & Demo Seeder (`scripts/daily-summary.sh`, `scripts/seed-demo-events.sh`)**: Rolls events + `NEXT.md` into `studio/daily/YYYY-MM-DD.md` with before/after video slots.
- **HUB `/health` Endpoint & Live Runtime Duration (`hub/server.mjs`, `hub/WarRoom.tsx`)**: Added `GET /health` and start-time → duration telemetry on agent nodes.

---

## [2.0.0] — 2026-10-19
### Added
- **7-Module Mission Control War Room (`hub/`)**: `@xyflow/react` uncapped agent graph, 4-source "Agent Eyes" viewport multiplexer (`noVNC`, `WebRTC`, `Playwright CDP`, `HMR`), `xterm.js` WebSocket terminal dock, and `.studio/usage.json` quota bar.

---

## [1.0.0] — 2026-10-19
### Added
- Initial public release of the generalized 3D Deep-Sim & AI Game Studio Harness (`AGENTS.md`, `harness/route.mjs`, `harness/task.mjs`, `qa/playtest.mjs`, `scripts/setup-token-savers.sh`).
