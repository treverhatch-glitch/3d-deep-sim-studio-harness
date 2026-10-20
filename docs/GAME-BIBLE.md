# The Game Bible, phases, layers, the Director and the Idea Board

How a game starts in this studio, and how it stays the game it set out to be. Every piece is a
file (`studio/bible/`) and a HUB endpoint, so a friendlier front end can drive the same flow later.

## 1. Intake: what is this game?

```bash
npm run intake                          # asks in the terminal; run again to fill in the rest
npm run intake -- --answers game.json   # the same answers from a file (example: studio/templates/intake-example.json)
```

About 19 questions: the fantasy, the main verb, genres, **play length**, one sitting, audience, three
comparable games, what it must never be, how you win and lose, the first playable slice, platforms,
art, the one thing that must feel great, 3 to 5 pillars, and the three phases.

**Play length comes first for a reason.** Shorter games are much easier to finish:

| Play length | Layers that fit | What it asks of you |
| --- | --- | --- |
| demo (15 to 30 min) | about 3 | The best first project. The studio can finish most of it; you sign the plan and playtest. |
| short (1 to 3 h) | about 5 | Reviews and a playtest most weeks. |
| medium (5 to 15 h) | about 8 | Ideas, sign-offs at each phase, playtests. |
| long (20 h+) | about 12 | A lot of your time; long games need a person steering often. Some people enjoy exactly that. |
| endless | about 10 | Ongoing design, phase after phase. |

Start with a demo, then grow it phase by phase.

**New or existing?** The first question. An existing game gets a read-only scan first
(`npm run onboard -- --path <folder> --name "<name>"`), and the intake carries on with what you know.

**Follow-up questions.** After the first round, the intake offers follow-ups: two fixed questions
for each phase and for every layer you kept or are exploring ("How many tiers does the tech tree
have, and what does the first unlock solve?"). They never need a model. Add `--model` and a cheap or
local model writes a few more from your own answers; a script drops any that repeat, run long, or
touch a crossed-out layer. Answer any time: `npm run intake -- --followups`, the Game plan view, or in
conversation with the Liaison. Answers land in `BIBLE.md` under "Details".

## 2. Phases: the three parts of the game the player plays

| Phase | The player | Moves on when |
| --- | --- | --- |
| 1 Early game | Does the core verb by hand; low stakes, fast feedback, a first win | Doing it by hand starts to feel slow, which makes them want scale or tools |
| 2 Mid game | Builds the machine; new systems ease the early grind and add pressure | It runs on its own and opens bigger goals |
| 3 Endgame | Peak tests, then a win, prestige, or endless play | It ends, resets with bonuses, or becomes self-directed |

Build tasks say which phase they are for (`--phase 1|2|3`) and only open phases take build work.
A phase opens when the Director's review says the one before is ready (`Verdict: phase-ready`) and a
person opens it: `npm run bible -- phase open 2 --by <name>`. Designing later phases (studies,
storyboards, docs) is always fine.

## 3. Layers: ask about everything, keep what fits, cross out the rest

The intake asks about each kind of progression or system: levels and XP, skills, a tech tree,
unlocks by licence or reputation, gear and crafting, collections, currencies, production chains,
upkeep and loans, markets, map expansion, building, hazards and crises, NPC needs, automation,
factions, politics and governance, multiplayer, narrative, quests, victory, endless play, prestige,
meta-progression. It suggests the ones games like yours usually have, so you hear about systems you
didn't know to ask for.

Each is **yes** (and the phase it enters), **explore** (R&D tries two light versions first), or
**no**. A no is crossed out in `NOT-DOING.md`, `task add` refuses titles that touch it, and the
drift report flags it. Only a person brings one back. Players never see any of this as a checklist;
it is so the studio builds what the game needs and nothing else.

## 4. Pre-production

Intake queues, once: a reference study, a storyboard of all three phases, an R&D study per
"explore" layer, and a sign-off task for the person. Until a person signs
(`npm run bible -- sign --by <name>`, or the War Room), build tasks wait. Allowed meanwhile:
studies, docs, throwaway prototypes (`--prototype`) and tooling that isn't game content (`--infra`).

After signing, every build task needs `--phase` and `--serves pillar:<name>` or
`--serves layer:<id>` (or `--idea <approved idea>`).

## 5. The Director

The Director (role `director`) guards the Bible; the Producer still creates and assigns every task.

- **Pinged** daily by the HUB, by the Producer before it generates tasks
  (`npm run director -- ping --reason "…"`; `task add` warns if it hasn't), when an idea is placed,
  and on phase changes.
- **A ping** queues one `Director review` task (later pings add their reason to it), writes
  `.studio/briefs/director.md` (docs to read, open phase, layers, what finished, the drift report,
  ideas waiting), and starts a Director agent if `STUDIO_DIRECTOR_CMD` is set, at most once an hour
  and under the spend cap. To set it: run `npm run kickoff -- --role director --agent director-1 --tool claude`
  once (it writes the prompt file) and put the printed launch line in `.env` as `STUDIO_DIRECTOR_CMD`.
- **Its answer** is a dated file in `studio/bible/reviews/` with `Phase:`, `Verdict:` (on course,
  drifting, off course, phase-ready), `Checked:` (pillars and layers) and a `## Next` list.
- **The drift report** (`npm run director -- drift`) is a script: tasks that serve nothing, tasks on
  crossed-out layers, work ahead of the open phase, a phase open too long, kept layers with no work,
  ideas waiting.

## 6. The Idea Board

Ideas never go straight to builders.

1. **Captured**: anyone pitches one (`npm run idea -- add "…"`, or the War Room's Game plan view).
2. The watcher's regular pass gives the Producer one "Ideas: N new" task. The Producer routes each to
   R&D: `npm run idea -- route I-001`.
3. **Shaped**: R&D works it out (what the player does, phase, layer, cost, conflicts):
   `npm run idea -- shape I-001 --notes "…"`. That queues placing.
4. **Placed**: the planner puts it in the player's progression and the schedule:
   `npm run idea -- place I-001 --phase 2 --layer map-expansion --unlock "…" --schedule "…"`. That
   pings the Director.
5. **Decided**: the Director approves, parks or rejects (`npm run idea -- decide I-001 approve --by …`).
   Approved ideas are written into the Bible.
6. **Scheduled**: the Producer makes the build tasks with `--idea I-001`; `task add` refuses an idea
   that isn't approved.

## 7. The Liaison: talk to the studio any time

The Liaison (role `liaison`, `npm run kickoff -- --role liaison --agent liaison-1 --tool claude`) is
the agent the game dev talks to. It asks until it understands, sorts what it heard into an idea, a
direction, an asset or a question, reads it back in plain words and asks "Shall I push it on?". Only
a clear yes moves it:

| Kind | Where it goes |
| --- | --- |
| idea | The Idea Board, labelled "dev, confirmed", straight to R&D, and the Director is pinged |
| direction | A Producer task to turn it into work, and the Director checks it against the Bible |
| asset | A Producer task to record it (owned or reference only) |
| question | A Producer task to answer you |

Nothing running stops. Commands: `npm run liaison -- draft | change | confirm | drop | list`.
Ideas on the board carry where they came from: dev confirmed, dev pitched, agent, playtest.

## 8. References: keep what you design from

```bash
npm run ref -- add <link or file> --game "A Short Hike" --feature "climbing stamina" --at 0:42 --take "…" --avoid "…"
npm run ref -- attach R-001 <file>       # a clip you saved, a screenshot
npm run ref -- frames R-001              # stills for agents whose model reads images (needs ffmpeg)
```

Each reference gets a folder with the media and a note. Set `STUDIO_REFERENCE_DIR` to a Google Drive,
Dropbox or OneDrive folder on your computer and the library syncs and stays reachable as development
goes on; otherwise it is `references/` in the repo (ignored by git). A link to a file is downloaded.
A link to a web page (a YouTube video, a store page) is kept as a link with its timestamp: save the
clip with the site's own download or offline feature, or record it yourself, and `attach` it. Check a
source's terms before downloading from it. References are never shipped.

## 9. Your own assets

```bash
npm run asset -- add boat.glb --use game --owner "Hatch" --licence "own work" --by hatch
npm run asset -- add map.png --use reference --game "our old prototype" --feature "island shape"
```

**Use in the game:** you state you own it or hold a licence; the file goes to `assets/` and
`studio/assets/manifest.json` records who said so, when, the licence and a checksum. The harness
records the statement but can't verify it, and this isn't legal advice: a product built on this needs
proper terms from a lawyer. **Reference only:** it goes to the reference library and never ships. The
`assets` gate fails when a file in `assets/` has no record or changed since, or when game code points
at the reference library.

## 10. Experiments: try it, keep it, or take it back out

```bash
npm run experiment -- start "Glowing moss at night"     # X-001
npm run experiment -- task X-001 "night glow prototype"  # work inside it
npm run experiment -- drop X-001 --by hatch --only cartridges/my-game/glow.mjs   # take back part
npm run experiment -- drop X-001 --by hatch               # or all of it
npm run experiment -- keep X-001 --by hatch
```

Every commit for an experiment carries a `Studio-Experiment: X-001` trailer (its tasks add it, or
set `STUDIO_EXPERIMENT=X-001`), so `drop` finds exactly what to remove even after other work landed
on top. Dropping adds commits that undo it, which is safe while other agents share the checkout; a
part that later work changed is refused rather than guessed. Inside the game, keep a prototype behind
a switch in TUNING (`experiments: { X001: true }`). Commits made with `--no-verify` skip the hook and
aren't tagged.

## 11. In the War Room

The **Game plan** view shows the three phases side by side with the layers that enter each, the
crossed-out layers, approved ideas pinned where they land, the Idea Board with source labels and
"new" marks, follow-up questions to answer, experiments and the reference library, a box to pitch an
idea, and the Director's latest verdict with the drift report. It reads files only (no AI). The Ops
view has a box to message the Producer; messages land in `studio/producer/INBOX.md` and its briefing.

## HUB endpoints (for a future front end)

| Endpoint | What |
| --- | --- |
| `GET /api/bible` | The Bible, its check, suggestions, drift, the latest review, ideas, and the question and layer catalogs |
| `POST /api/intake` | Apply answers (`{ answers, layers }`), the same shape as `--answers` |
| `POST /api/bible/sign` | A person signs (`{ by }`) |
| `GET /api/ideas`, `POST /api/ideas` | List ideas; pitch one (`{ title, detail, by }`) |
| `POST /api/inbox` | Message the Producer (`{ msg, by }`) |
| `POST /api/followups` | Answer follow-up questions (`{ answers: { "<key>": "…" }, by }`) |

Writes need the HUB token header, like every other write.
