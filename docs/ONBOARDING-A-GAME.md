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

## Adopt it so the studio can work on it (2.43.0)

The scan alone only describes the game: the studio's checks, lanes, whole-game check and unwired-code check
don't reach a game that lives elsewhere. Adopting brings it in:

```bash
npm run onboard -- --path ../my-game --name "My Game" --adopt --dry-run          # what it would do
npm run onboard -- --path ../my-game --name "My Game" --adopt --ref <branch>     # do it
cd game/my-game && npm ci                                                         # its packages
git add game/my-game studio && git commit -m "Adopt My Game" && npm run verify
```

- It copies the game's tracked files at `--ref` (default: what is checked out) into `game/<slug>/`. If the
  game's own docs (CLAUDE.md, AGENTS.md, CONTRIBUTING.md, README.md) name a trunk or integration branch other
  than the one checked out, it says so: a half-built game's `main` is often far behind.
- It declares the game's own checks in `game/<slug>/studio.gates.json` from its scripts and config:
  type-check, `test` (required), `lint`, `e2e`, `build` (optional). Edit them freely; the review task asks for it.
- It makes it the studio's game (`studio/game.json`) and records where it came from (`studio/game/ORIGIN.json`:
  repo, branch, commit).
- The Game Bible starts as an existing game. When the game has design docs, the first task drafts the Bible
  from them (an answers file for `npm run intake -- --answers`, each answer naming its source), and a person
  checks and signs it; pre-production then asks for a style sheet from the game's existing art and storyboards
  from its current build, not placeholders.

**Sending the work back.** The game's own repo, review and CI stay in charge of it:

```bash
npm run onboard -- --export
```

writes the studio's committed changes to `game/<slug>/` since it was adopted (or last synced) as one patch, relative to the
game's own repo (without `studio.gates.json`), and prints the commands to apply it on a branch there from the
adopted commit (`git apply --3way`). Open the PR the way that repo wants.

**Keeping both in step (2.44.0).** When work also lands in the game's own repo:

```bash
npm run onboard -- --sync [--ref <branch>]
```

brings its newer commits into `game/<slug>/` as one commit. It refuses while the studio has changes it
hasn't exported yet (export first), so nothing is lost or sent twice.

**Faster verifies for a big test suite.** With `STUDIO_WHOLE_GAME=on`, a lane's verify runs only the tests
related to the change (an adopted Vitest or Jest game's test check declares `related`), and the whole suite
runs after landing.

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

- **The game's repo stays the home of the game.** For a look, scan it with `--path`. To have the studio work
  on it, adopt it (`--adopt`): it lands under `game/<slug>/`, and `--export` sends the work back as a patch
  for the game's own review.
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

## Path-scoped gates and parallel tracks (2.30p)

A game with more than one build (for example a browser build under `web/` and an engine build under `godot/`) should scope its gates, so a change to one build doesn't run the other's checks:

```json
{
  "shared": ["data/rules/**"],
  "gates": [
    { "id": "playtest", "command": "npm run playtest", "paths": ["web/mygame/**", "tools/mygame/**"], "track": "web" },
    { "id": "engine-smoke", "command": "npm run godot-unit", "paths": ["godot/**"], "track": "engine" }
  ]
}
```

- `task done` in a lane copy runs only the gates whose `paths` its diff touches and logs each skipped gate with the reason. A change under `shared` (or `harness/`, `scripts/`, `studio/gates.json`, package files, the manifest) runs every gate. A gate without `paths` always runs, so manifests without them behave as before.
- The pass is recorded with its commit and scope. If the studio's branch moves before the lane lands, and everything it brought in is outside that scope, the pass is reused instead of re-run.
- Only the final fast-forward and the board write take the short land lock, so the tracks verify and land in parallel.
