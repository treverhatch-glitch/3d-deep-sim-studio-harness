# Bringing an existing game into the studio

Best practices, not rules. They work for a finished game you want to keep improving and for a game
in the middle of development under another workflow. The aim: every key fact about the game sits in
a file the Producer and the supervisors (reviewer, QA) read, so no agent depends on a chat that
another model had.

## Start with the scan

```bash
npm run onboard -- --path ../my-game --name "My Game" --dry-run   # look first
npm run onboard -- --path ../my-game --name "My Game"             # then write
```

It only reads the game's folder. In this studio it writes `studio/game/GAME.md` (the fact sheet),
`studio/game/inventory.json` (the raw scan), a set of onboarding tasks in `studio/NEXT.md`, and a
note in the Producer log. It detects the engine and tools, run commands, tests, code size by
language, assets, TODOs, and every call that makes a run unrepeatable (`Math.random`, `Date.now`,
Godot `randi`, Unity `Random` and `Time.deltaTime`). Rerun it any time; it keeps your filled-in fact
sheet unless you pass `--force`, and it never queues the same task twice.

## Then fill in what a scan can't know

The top of `GAME.md` is for the person who owns the game: the pitch, the state (prototype, alpha,
live), the pillars, the core loop, target platforms, who signs off, what agents must not touch, and
where the design lives. Twenty minutes here saves every future agent from guessing. The Producer's
briefing (`npm run handoff`) shows this part first.

Rewrite `studio/PLAN.md` for the game too: its goal, the phase it is in, and the next milestones.

## Suggested order

| Step | Why | Task the scan queues |
| --- | --- | --- |
| Fact sheet and plan | The Producer and supervisors need the same picture | `Docs: fill in … GAME.md`, `Docs: rewrite studio/PLAN.md` |
| Study your own build | Know what runs every frame and what talks to the network before changing anything | `Study: our own build of …` |
| Find the sim boundary | Which systems own game state, randomness and time | `Study: map … game state` |
| Wrap, don't rewrite | A thin adapter gives the harness `init`, `step`, `getState` and a hash without touching the rest (`qa/browser.adapter.mjs` is an example) | `Wrap … in a cartridge adapter` |
| Make one run repeatable | Seed the RNG, fix the tick, then record the first golden | `Playtest: first seeded run …` |
| Import known bugs | Each with steps or a seed, so it becomes a regression once fixed | `Docs: import … known bugs` |
| Choose gates | Turn on what passes today; add the rest as the game gets there | `Review: choose which gates apply …` |

## Advice

- **Keep the game in its own repo.** Point the studio at it with `--path`; don't copy it in. Game
  code that does land here goes under `cartridges/<game>/`.
- **Taming randomness is gradual.** The scan's count is a to-do list, not a verdict. Start with the
  systems the first replay touches.
- **Gates arrive in steps.** Secrets, session and a smoke playtest work on day one. Golden, purity
  and soak follow once the adapter exists. Mark the rest optional in `studio/gates.json` until then.
- **Bring the history, briefly.** Past decisions that still matter go into `studio/decisions/` as
  short records; the old tracker's open items go into `studio/NEXT.md`. Leave the rest where it was.
- **Assets keep their origin.** Note where art, audio and fonts came from and under what licence
  before agents change them (`studio/references/APPROVALS.md`).
- **One owner signs off.** Name the person who approves design, balance and releases in the fact
  sheet; agents prepare, that person decides.
- **Mid-development games:** pick a freeze point, finish or park open branches, and let the old
  workflow's CI keep running alongside until the studio's gates cover the same ground.
