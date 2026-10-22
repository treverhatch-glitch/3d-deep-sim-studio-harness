# Harness roadmap (`docs/ROADMAP.md`)

What the harness does next, and how. Built from outside reviews (Grok, and read-only reviews run on
Windows) and the plans for pre-production, game phases, the Idea Board and the Director. Each item
says what is wrong or missing, then the fix.

Status words: **planned**, **doing**, **done (version)**.

**Words used here.** A **stage** is where the studio is (pre-production, production). A **phase** is
a part of the game the player plays: Phase 1 early game, Phase 2 mid game, Phase 3 endgame. A
**layer** is one kind of progression or system (a tech tree, levels and XP, an economy, factions).

---

## 2.7.0 — Runs anywhere, and cheap prepare is real

| # | Problem | Fix | Status |
| --- | --- | --- | --- |
| W1 | Gates and the pre-commit hook called `bash` and `python3`; on Windows `bash` is often missing and `python3` is the Microsoft Store stub (exit 9009), so 4 required gates failed on a clean machine. | `scripts/check-sim-isolation.mjs` and `scripts/secret-scan.mjs` in Node (the `.sh` files now just call them); `qa/run-python.mjs` finds a real Python 3 (`python3`, `python`, `py -3`, or `STUDIO_PYTHON`) and says how to install one; the hook and release use them. | done (2.7.0) |
| W2 | `secret-scan.sh` needed `/dev/fd`. | Gone with the Node port. | done (2.7.0) |
| W3 | The focus brief path printed with backslashes on Windows. | Repo paths are shown with forward slashes. | done (2.7.0) |
| W4 | No proof it works on Windows. | A `windows-latest` CI job runs every required gate. | done (2.7.0) |
| W5 | Docs disagreed: two read orders; three docs said `node hub/server.js`; `setup` only installed packages with `--install`. | One read order in `AGENTS.md`, which `READ-FIRST.md` points to; the docs say `npm run hub`; `setup` installs when `node_modules` is missing; a new required `docs` gate fails when a doc names an `npm run` script or a `node`/`bash` file that doesn't exist. | done (2.7.0) |
| P1 | "Cheap prepare, strong act" was a template only. | `npm run brief -- <ID> --model`: a bounded window of the task's history, a local or free model drafts a 300-word brief, a script checks it (sections, word cap, real files, real task IDs) and throws a bad draft away. Skips the model when the history is short. Focus briefs and kickoff prompts point to it. Self-tested with a fake local model. | done (2.7.0) |
| S5 | Purity could be dodged with `({}).constructor.constructor`. | The static check flags `.constructor.constructor` and `['constructor']`; the runtime probe traps the Function constructors on every function prototype. Self-tested both ways. | done (2.7.0) |
| S6 | Claiming a folder and a file inside it at the same moment could both succeed. | A short studio-wide mutex around the overlap check and the write (stale after 10 s). Self-tested with eight parallel claims. | done (2.7.0) |

## 2.8.0 — Pre-production, game phases, layers and the Director

**Status: done (2.8.0)**, as described below, with these left for later: phase scenarios
(`phase-1-early`, …) as a required check before a phase opens (today the gate is the Director's
`phase-ready` verdict plus a person opening it), storyboard pictures, and an intake form in the War
Room (the `POST /api/intake` endpoint is ready for it). Guide: `docs/GAME-BIBLE.md`.

Today a new game gets a vision lock, a plan and planning guides, but nothing makes the studio
settle the game before builders start. Agents then either put every mechanic in front of the player
at once, or polish the early game forever with no mid-game shift or endgame payoff. And a game dev
often doesn't know which progression layers the game needs until someone asks.

### The Game Bible (`studio/bible/`)

The authority on what the game is. Files, not chat:

| File | Holds |
| --- | --- |
| `PITCH.md` | One paragraph: the fantasy, the main verb, session length, audience |
| `PILLARS.md` | 3 to 5 pillars, each saying what it rules out |
| `PHASES.md` | Phase 1, 2 and 3: what the player does and feels, and what pushes them to the next phase |
| `LAYERS.md` | Every layer: kept (and the phase it enters), explore, or crossed out |
| `STORYBOARD.md` | Beat sheets screen by screen across the three phases, plus loop diagrams |
| `CONTENT.md` | Levels, unlocks, tech tree, economy curve across the phases (see 2.10.0) |
| `REFERENCES.md`, `NOT-DOING.md` | Comparable games; everything crossed out, with why |
| `IDEAS.md`, `ideas/` | The Idea Board (see the next section) |
| `reviews/` | The Director's dated reviews |

The vision lock points at the Bible. Only a person changes a locked pillar or brings back a
crossed-out layer.

### Phases: why, and how they are split

**Why.** A phase describes how the player's relationship to the game changes, not a chore list.
Naming the three phases makes the studio answer "what does minute 10 look like, and hour 2, and the
end?" before building, gives each phase its own scenario and checks, and stops endgame work while
the early game isn't fun yet. Players never see a checklist; the studio does.

| Phase | The player | Moves on when | Proved by |
| --- | --- | --- | --- |
| **1 Early game** (footing) | Does the core verb by hand with one or two mechanics; low stakes, fast feedback, first win | The core loop works and doing it by hand starts to feel slow, which creates a wish for scale or tools | `phase-1-early` scenario + fun check + Director sign-off |
| **2 Mid game** (scale and friction) | Goes from doing the verb to building the machine; kept layers solve phase-1 bottlenecks and add system pressure (upkeep, congestion, rivals) | The operation runs on its own and opens bigger goals | `phase-2-mid` scenario + balance sweep + Director sign-off |
| **3 Endgame** (mastery) | Peak tests (crises, megaprojects), a final win, prestige or an endless sandbox | Wins, prestiges, or settles into self-directed play | `start-to-win` running 1 → 2 → 3 + soak + Director review |

Build tasks carry `--phase 1|2|3`. Phase 2 build work opens when Phase 1's scenario and fun check
pass; Phase 3 when Phase 2's do. Design, R&D and storyboards for later phases are allowed any time,
because you have to know where the game is going to build its start well.

### Layers: ask, keep or cross out

`npm run intake` (and `npm run onboard` for an existing game) goes through a catalog of layers and
asks about each one: **yes** (and which phase it enters), **explore** (R&D proposes two light
versions), or **no**. It also suggests layers from the dev's earlier answers ("you said two-hour
sessions of management: most games like that shift to automation in the mid game; keep it?"), so
the dev hears about systems they didn't know to ask for.

| Group | Layers |
| --- | --- |
| Growth | Levels and XP, skills and abilities, tech or research tree, unlocks by licence, rank or reputation, gear, loot and crafting, collections |
| Economy | Currencies, production chains, upkeep and loans, markets and prices |
| World | Map or space expansion, building and bases, hazards, wear and crisis events |
| People | Crew, staff and NPC needs, automation and delegation, factions, politics and governance (votes, laws, democracy), social or multiplayer |
| Story | Narrative beats, quests and contracts |
| The end | Victory, endless sandbox, prestige or new game plus, meta-progression across runs |

A **no** is recorded in `LAYERS.md` and `NOT-DOING.md` with the reason. Agents never make tasks for
a crossed-out layer, and the drift report flags any task whose title or files match one (each layer
has a short keyword list). A new game can start with Phase 1 and two layers, and grow.

### Pre-production stage

1. `npm run intake` asks about 12 core questions (fantasy, main verb, session length, audience,
   three comparable games, what it must never be, how you win and lose, the first playable slice,
   platforms, art direction, the one thing that has to feel great), then the three phases, then the
   layer catalog. It writes the first Bible draft.
2. An R&D team works it: reference scouts study the comparable games (`study` tasks); builders make
   two or three throwaway prototypes as their own cartridges, including any "explore" layers; each
   gets a fun check.
3. A storyboard pass turns the phases into beat sheets and diagrams. Agents write and diagram;
   pictures come later from an image model or Blender stills, never as the source of truth.
4. The stage ends when the Bible's done-check passes and a person signs it in the War Room. Until
   then `task add` refuses build tasks for the game; study, prototype and docs work is allowed.

### The Director

Role `director` (the Director of Knowledge, the master game overviewer). It guards and edits the
Bible and gives the final word on where things fit in the game; it does not assign work. The
Producer still generates, moderates and assigns tasks, from the Bible and for the open phase.

- **A ping** queues a `director-review` task with the reason, writes the Director's brief
  (`.studio/briefs/director.md`: the Bible, the open phase, kept and crossed-out layers, the plan,
  what finished since the last review, the drift report, new ideas), and wakes the Director agent.
  If none is running, the HUB starts one with `STUDIO_DIRECTOR_CMD` (a `kickoff --tool` line), under
  the spend cap and at most once an hour; if that isn't set, the Producer and the person are told.
- **On a ping the Director** 1. reads the docs its brief lists, 2. writes a dated review in
  `studio/bible/reviews/`: on course, drifting or off course; whether the phase is ready to move on;
  which pillars and layers the next work should serve; what to stop; suggested tasks. It works back
  and forth with the Producer (`--to producer` events) until the Producer has what it needs.
- **When:** daily (the HUB, like the retro); every time the Producer is about to generate tasks
  (`npm run director -- ping --reason "…"`; `task add` warns if build tasks are added with no
  review in the last day or 10 tasks); on a phase change; on a failed slice; when the drift report
  crosses a line; when an idea reaches "placed" (next section).
- **Free drift report** (a script): tasks serving no pillar, phase or layer; tasks touching a
  crossed-out layer; later-phase build work while an earlier phase is red; a phase running long;
  kept layers with no work.
- **Every build task says what it serves:** `task add … --phase <1|2|3> --serves pillar:<name>|layer:<name>`.
- **Done-check for `director-review`:** a dated review naming the phase, pillars and layers it
  checked, a verdict, and next tasks.

### The Idea Board (fourth War Room tab)

Ideas come up during development. Sending them straight to builders is how games get messy, so
every idea goes through stages, and only an approved idea becomes build work.

| Stage | Who | What happens |
| --- | --- | --- |
| **Captured** | The game dev (Idea Board box, behind the token) or any agent | One line plus optional detail, saved as `studio/bible/ideas/I-001.md` |
| **Shaped** | R&D | Expands it: what the player does, which phase and layer, what it costs, conflicts with pillars or crossed-out layers, a tiny prototype if needed |
| **Placed** | Progression planner | Proposes where it lands in the player's progression (phase, layer, unlock point) and in the development schedule (which milestone, what it pushes back) |
| **Approved / parked / rejected** | Director decides, Producer consulted | Approved ideas are written into the Bible (and `CONTENT.md`); parked ideas wait; rejected ideas keep the reason |
| **Scheduled** | Producer | Only now: build tasks, each with `--idea I-001`. `task add` refuses an `--idea` that isn't approved |

The watcher's regular pass (every 5 minutes, no AI) collects new ideas and gives the Producer one
"Ideas: N new" task, never one per idea. The Bible only changes when an idea finishes planning and is
approved.

The tab shows the game's shape: the three phases as columns, the kept layers as rows (levels, tech
tree, unlocks, factions…), crossed-out layers greyed, where each approved idea sits, and the cards
moving through the stages. It reads files only, like the other tabs.

## 2.9.0 — The game dev's seat: a Liaison, follow-up questions, references, assets, experiments

**Status: G1 to G7 and G10 done (2.9.0); G8 and G9 done (2.11.0).**

**Why.** The studio runs on agents, but the game is the game dev's. Today they can answer the intake,
pitch an idea and message the Producer. They can't yet hold a real conversation about what they mean,
hand over a reference video or their own assets, or try something and take it all back out. This
release gives them that seat without ever stopping the studio mid-run: everything they bring goes
through a conversation, is confirmed in their words, and then flows to the Producer and the Director
while the agents keep working.

| # | What | How | Status |
| --- | --- | --- | --- |
| G1 | New game or existing one | The intake's first question: starting from scratch, or bringing something already started? Existing games go through `npm run onboard` first (read-only scan, fact sheet), and the intake starts with what the scan found (engine, size, unrepeatable calls) filled in. | done (2.9.0) |
| G2 | Follow-up questions | After the base intake, a follow-up round per kept or explore layer and per phase ("How many tiers does the tech tree have, and what does the first unlock solve?"). Two sources: a fixed question bank per layer that always works (no keys, no tokens), and a cheap model that writes extra questions from the dev's own answers, checked by a script (count, no repeats, only real layers and phases) like `npm run brief`. Answers are stored in `bible.json` under the layer they explain. Can run any time, not only at the start. | done (2.9.0) |
| G3 | References with features and videos, kept | A reference library: the game, the feature, a timestamp, what to take and what to avoid, and the media itself, downloaded and kept in a folder per reference. The library can live in a Google Drive (or Dropbox, OneDrive) folder on the dev's computer via `STUDIO_REFERENCE_DIR`, so it syncs and stays reachable through development. Web pages (YouTube, stores) are kept as links until the dev attaches a saved copy, respecting each site's terms. For models that read images, a script pulls stills with ffmpeg. | done (2.9.0) |
| G4 | The dev's own assets | `npm run asset -- add <file or link>` (and a drop box in the War Room) for 3D models, music, sound, maps, art, anything. Each asset gets a provenance record in `studio/assets/manifest.json`: **use in the game** (the dev declares they own it or have a licence: which, from where, by whom, when) or **reference only** (to design from, never shipped). A gate fails when a reference-only asset, or one with no record, ends up in the game's files. The declaration is recorded and shown on every use. This is not legal advice: the harness records what the dev states, and a product built on it would need proper terms written by a lawyer. Large files stay in the private copy (Git LFS or an ignored folder), never the public repo. Extends the existing approval gate. | done (2.9.0) |
| G5 | The Liaison: a conversation, then a confirmed brief | A new role, `liaison`: the agent the game dev talks to, any time. It asks until it understands, sorts what it heard into an **idea** (new feature: Idea Board), a **direction** (change to something that exists), an **asset** (G4) or a **question**, then restates it in plain words and asks the dev to confirm. Only a confirmed brief moves on, to both the Producer (work) and the Director (where it fits in the game's logic and phases). Nothing already running stops; the brief is just new input. The conversation runs in the dev's own agent tool first (a kickoff prompt and a skill), and later as a chat panel in the War Room through the router (a cheap model by default, under the spend cap and the token). | done (2.9.0) |
| G6 | Labels on the Idea Board | Each idea shows where it came from: **dev, confirmed** (from the Liaison), **dev, pitched** (the quick box), **agent**, **playtest**, and whether it's new since the dev last looked. Dev-confirmed ideas are routed first. | done (2.9.0) |
| G7 | Experiments you can keep or take back | `npm run experiment -- start "<what>"` opens a tracked experiment (X-001): its own git branch, a `Studio-Experiment` commit trailer, and, inside the game, a flag in the TUNING table so a prototype can be played without touching the main path. `keep` merges it; `drop` removes every commit tagged with it (or deletes the branch if unmerged); `drop --only <files or parts>` takes back just those. The registry (`studio/experiments/`) lists each experiment's idea, files, tasks and status, and the Game plan view shows them. Goldens are regenerated in the same commit either way. | done (2.9.0) |
| G8 | Deeper agent identity | Richer role cards: who the agent is, what good work looks like, its common mistakes (from the scorecard and retros), the questions it should ask, and a worked example. Lessons filed per role, so a builder reads builder lessons. Player personas for playtests and fun checks (a calm player, a min-maxer, a first-timer), so agents judge the game from a player's side. | done (2.11.0) |
| G10 | A stronger learning loop | `npm run learn`: the same failure on two or more days, and the lesson that didn't stick; retro suggestions raised again and again; the overseer's evaluations (`notes --kind eval`). Rewritten daily by the HUB and backed up with every learning file to `STUDIO_BACKUP_DIR` (a synced Google Drive folder works), plus one combined file. The Producer's prompt makes it the overseer of every run. | done (2.9.0) |
| G9 | The game's voice | A voice and tone section in the Bible (how the game talks: UI text, tutorial lines, dialogue, with do and don't examples), read by every agent that writes words the player sees. With VoiceStudio (optional), the same script files turn into voice lines. | done (2.11.0) |

## 2.12.0 — Deeper skills and stricter slices

| # | Problem | Fix | Status |
| --- | --- | --- | --- |
| S1 | The bug skill is a short note; agents need the whole loop. | A full bug skill: triage and severity, reproduce from seed and tick, find the breaking commit (`git bisect` with the replay), smallest fix, a regression that fails before the fix and passes after, lesson, hand-off. The done-check proves "fails before" by replaying against the parent commit in a temporary folder. | done (2.12.0) |
| S2 | No skill for "build this system, prove it, hand it off". | A `system` skill and task type: a one-page spec in the Bible (its phase and layer), the sim module, its invariants, a phase scenario in `qa.mjs`, goldens, a playtest, a short doc for the next agent. The done-check checks each piece. | done (2.12.0) |
| S3 | The reviewer check is optional and passes with no reviews. | A phase slice or `system` task isn't done without a review from a different model family that names it and approves it; the reviewer gate becomes required for them. | done (2.12.0) |
| S4 | Renderer budget greps for the word `Light`. | Measure it: the playtest loads the game in Chromium, reads the renderer's counters (draw calls, triangles, lights, frame time) through a hook next to `__sim`, and fails over the budget. The grep stays as a fallback when there's no browser build. | done (2.12.0) |

## 2.13.0 — Trust in the results, and safe memory

From a read-only review of 2.11.0 by Gemini on Windows (2026-10-20), each finding reproduced first.

| # | Problem | Fix | Status |
| --- | --- | --- | --- |
| T1 | Node and Python wrote different canonical JSON for integer-like keys, floats below 0.0001 and emoji keys, so those states hashed differently. | Both build the text directly: code-point key order, JavaScript's number layout. 20 shared vectors and a 5,000-state fuzz agree byte for byte. | done (2.13.0) |
| T2 | The slice, soak, balance sweep and playtest compared the 64-bit display hash. | All compare SHA-256; playtest reports carry `finalSha256` and the done-check requires it. | done (2.13.0) |
| T3 | A scenario golden pinned only the end state. | It also pins `actionsSha256`, the SHA-256 of every action taken. | done (2.13.0) |
| T4 | A custom `hashState()` broke the Python gate; Python never checked regressions. | `hashKind: custom` goldens are checked on SHA-256 in Python; regressions are replayed in Python too. | done (2.13.0) |
| T5 | Signed results didn't bind code or inputs, and trusted any gate run. | Cartridge tree SHA-256, spec file SHA-256; refuses gate runs that are stale or missing a required gate; `verify --replay` also checks the code and re-runs purity, isolation and the slice. | done (2.13.0) |
| T6 | Backups copied everything every day. | Content stored once, gzipped; restore and prune; screenshots capped. | done (2.13.0) |
| T7 | No place to record the game dev's answer on sharing data. | `npm run data`, intake and a pre-ticked box in the Game plan view; exports stop if declined and record the basis. | done (2.13.0) |

## 2.14.0 — Ready for the run

| # | What | Status |
| --- | --- | --- |
| R1 | `npm run preflight [-- --fix]`: checks a clone is ready; freezes the harness, turns off push, installs hooks | done (2.14.0) |
| R2 | Stop all agents (War Room button, `task stop`/`resume`): no task starts while stopped | done (2.14.0) |
| R3 | `npm run run-report`: REPORT.md, hourly snapshots and the run's files in a shared results folder | done (2.14.0) |
| R4 | The browser test of the War Room runs in CI | done (2.14.0) |
| R5 | Every command reads studio settings from `.env` (backup and results folders, Producer name) | done (2.14.0) |
| R6 | Rehearsal mode with a fake model, phone alerts | after the first test |

## 2.15.0 — Content and craft pipelines

| # | Problem | Fix | Status |
| --- | --- | --- | --- |
| C1 | No content pipeline for a big game. | Content as data under `cartridges/<game>/content/` (JSON with a schema per kept layer, tagged by phase), checked by a gate, written by generators, with a sweep for the economy and unlock curve across the phases. Crossed-out layers need no content. | planned |
| C2 | Art, audio and narrative are folders and notes, not tools. | One tool each that an agent drives and a gate checks (when the layer is kept): art through Blender presets plus a budget check; audio through a sound preset generator plus loudness and length checks; narrative as structured dialogue files with a lint (missing speakers, dead branches). | planned |

## 2.15.x to 2.18.0 — After the first real run

From the Producer's notes on the first real game run (B1 to B13) and the owner's requests.

| # | What | Status |
| --- | --- | --- |
| F1 | Green is reachable and honest: a clean self-test, the active game in `studio/game.json`, done-check counts tagged commits, wide claims refused, scope refusals name the word (B1, B2, B9, B11, B12, B13) | done (2.15.0) |
| F2 | Pace chosen by the game dev (precise, budget, fast, extreme), and the MAX SPEED lever in every view | done (2.16.0) |
| F3 | The launcher: starts any tool the same way on every OS, heartbeats, and cleans up a dead agent's task, claims and work (B3, B4, B5) | done (2.16.0) |
| F4 | Three signals: Needs you, A check is red, Agent stalled (B10) | done (2.16.0) |
| F5 | Questions with a deadline; the Producer's default applies and is logged, reviewable and reversible | done (2.16.0) |
| F6 | The art department from day one: style sheet and placeholders, approved by the dev, the art reference in the Bible | done (2.17.0) |
| F7 | War Room actions start the right agent; a Liaison chat in the Game plan | done (2.17.0) |
| F8 | A Stage-2 browser gate that plays start to win with real input and checks the scene matches the sim (B6) | done (2.18.0) |
| F9 | Screenshot proof for renderer tasks, checked against the art reference | done (2.18.0) |
| F10 | Bugs carry a layer (sim, renderer, both); renderer bugs close with a browser regression (B8) | done (2.18.0) |
| F11 | Run #1 art agent's notes: forced work grouped by cause, attribution, rooms that open, honest labels, quota on desks; Studio view walks the middle, annex rooms; new-studio | done (2.19.0) |
| F12 | The Asset studio: rounds, thumbs up into assets/approved/, feedback by number, Producer provisional approval, labelled references, a reworked ledger | done (2.20.0) |
| F13 | The Arcade: play the last good build, playtest notes, clips, the read-only dungeon | done (2.21.0) |
| F14 | Run unattended: supervisor, budget pacing and quota fallback, lanes, WIP on the HUD, progress by phase, golden reasons | done (2.22.0) |
| F14b | Hire agents into departments (CLI and War Room), department commands, the Producer's hiring limit; the dev hacker and trick cards | done (2.23.0) |
| F14d | Run #1 and Solar Outpost fixes: real quota errors only, login PATH, dependencies, parking, stop cooldown, lanes always, selftest from the template release, browser contract required, restart with undo | done (2.24.0) |
| F14e | Proven fun: a person's Arcade verdict on a real build closes a phase; game IDs; prototype pace; every declared control pressed; a pace note; version tags | done (2.25.0); version tags in, a version filter in the War Room with the engine track |
| F14f | Test #2 fixes: one launcher, quota marks from the right tool with real resets and a probe, selftest reads only the template, a bot's loss isn't a red gate, auto hand-back and parking of looping tasks, owed reviews, relayed verdicts; cheaper to read: repo map, pitfall list, real token counts, readable sessions | done (2.26.0) |
| F14g | Engine track after Phase 1 and the dev's approval: engine/<name>/ from a worked Godot template, its own gate, a parity test against the web sim, frames, the Arcade links its build | done (2.27.0); a Godot-first game (no web version) next |
| F14c | A Producer staffing plan applied by one "Staff the studio" click; "close?" hints for idle departments | planned |
| F15 | A cheap vision model checks screenshot proof against the art reference | planned |
| F16 | A browser regression proven to fail on the code before the fix | done (2.12.0, qa/fails-before.mjs) |
| F17 | Room spec export and a dressing gate (keep-out zones, per-floor budgets) for set dressing | planned |

## 2.10.0 and later — Verifiable results, data, and the platform

Groundwork for a platform where results are shared, sold or rewarded. Each piece is optional for a
person using the harness on their own.

| # | What | How | Status |
| --- | --- | --- | --- |
| V1 | Verification hashes | Goldens and regressions pin SHA-256 of the canonical state, checked in Node and Python; the HUD keeps a fast FNV-1a 64 display hash (now one true 64-bit lane). `docs/HASH.md`. | done (2.10.0) |
| V2 | Signed results | A hash proves two states match, not who produced them. Sign result manifests (the golden, the gate report, the cartridge version, the creator) with Ed25519 from Node's built-in crypto; keys stay in the private copy. Needed before any marketplace or credits. | done (2.11.0) |
| V3 | Trajectory export, opt-in | `npm run trajectories -- export`: each finished task as one record (the brief, the plan, the diff summary, the done-check, gates and review outcome, bugs traced back to it), with secrets scrubbed and the game dev's consent and licence on every record. Local only by default. Uses: evaluating and routing models today; fine-tuning a local model on a studio's own successful work; and, with consent and terms, datasets for others. Off unless the game dev turns it on. | done (2.11.0) |
| V5 | Data partnerships | Talk to AI labs with sample exports from our own games: records with verified outcomes. Before any deal: written consent from every game dev whose work is in the records, terms per buyer, and a check of each model provider's terms (several limit using their outputs to train competing models). Collection is already on and local; export stays opt-in. | later |
| V4 | Optional public timestamp receipts (see `docs/SIGNED-RESULTS-AND-DATA.md`) | Stage 3 and later, opt-in and never required: write the SHA-256 of a signed manifest to a public ledger as a receipt that a version existed at a time. Free route: OpenTimestamps (anchored in Bitcoin, no wallet). Paid route for a marketplace: a low-cost chain, posted server-side so users never need a wallet. Verification stays off-chain (replays, gates, signatures); a receipt proves a hash existed at a time, not ownership and not that the code works. No tokens. | later |

## On-chain options (a paid add-on, later)

Offered as an opt-in extra; a game dev who clicks no loses nothing. The game itself never needs a
wallet, a token or a chain, so it can still ship on Steam and other stores that refuse games which
issue or trade crypto or NFTs.

| # | Option | What it means | Effort | Status |
| --- | --- | --- | --- | --- |
| B1 | Stamp | The SHA-256 of a signed release manifest (V2) written to a public chain: a receipt that this exact build existed at that time. OpenTimestamps for free; a low-cost chain posted server-side for a paid badge. | Easy: the manifests and hashes already exist. | later |
| B2 | Archive | The web build itself stored on a permanent network (Arweave-style), with its stamp, so it can be played years later. Permanent means no takedowns: only for builds the dev owns outright, with every asset cleared. | Easy to medium. | later |
| B3 | On-chain game | Ownership of items or game logic on a chain. Wallets, fees, security audits, store bans, and financial rules. A separate product, not an add-on. | Hard. | not planned |

## HUD, access and scale

| # | What | How | Status |
| --- | --- | --- | --- |
| H1 | Talk to the Producer | A "Message the Producer" box on the Ops tab writes to the Producer's inbox (no AI, behind the token); the briefing lists new messages first. Replies in the HUD come later. | done (2.8.0) |
| H2 | A fourth view: Dungeon | Each phase is a floor; a task opens a room, finishing it clears it and drops loot; P0 bugs are bosses; task points are XP; agents are the party. Reads HUD data only. | done (2.21.0, the Arcade in hub/v3) |
| H3 | Phone access | Tailscale in the docs, never port-forwarding. A one-time login sets an `HttpOnly; SameSite=Strict` cookie for reads and the WebSocket, and writes still need the token header, so the token never sits in an address. | planned |
| H4 | Phone alerts | ntfy or Telegram when a person is needed: a forced done, a Bible or phase sign-off, an idea waiting for approval, the spend cap, a Director verdict of "off course". | planned |
| H5 | Agents on several machines | Make the HUB the single home for tasks, locks and events (agents call it with their token; locks keep a heartbeat so a dead remote worker's claims expire), so separate clones and cloud sandboxes share one studio. | planned |
| H6 | Play the latest build | A link to the latest web build with the seed and phase scenario shown. | done (2.21.0, the Arcade in hub/v3) |
| H8 | A friendly front end | The same flow (intake, follow-ups, references, assets, the Liaison, ideas, experiments) for people who don't use GitHub or a terminal, on the HUB endpoints. Asks play length first and suggests a demo; says plainly that longer games need more of the dev's own time. | later |
| H7 | Game plan view with the Idea Board | Phases, layers, crossed-out layers, approved ideas, the Idea Board, a box to pitch an idea, the Director's verdict and drift. | done (2.8.0) |

## Not here

- Hatchfield's own loops (its airport loop, for example) are built in the Hatchfield repo, which
  uses this harness. This repo stays a template with only the example game.
- Agent frameworks (LangGraph, CrewAI, AutoGen): the queue, locks and gates already coordinate.

## Sources

- Grok notes on what agents still can't carry, what's worth adding, and phased progression (2026-10-20).
- Read-only reviews of 2.6.0 on Windows (2026-10-20): gates, self-test, security, doc mismatches,
  and a phased roadmap draft.
