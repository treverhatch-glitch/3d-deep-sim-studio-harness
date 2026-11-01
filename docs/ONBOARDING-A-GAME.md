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
- **A verify must not change the game's files (2.58.0).** The checks run with `CI=true`, so Vitest and Jest never
  write or rewrite snapshots during a verify: updating snapshots is a deliberate run with `-u`, committed with the
  change (`STUDIO_GAME_GATE_CI=off` leaves `CI` alone). Give generated test files fixed line endings in the game's
  `.gitattributes`, or a Windows checkout rewrites them on every run: `*.snap text eol=lf` (and the same for other
  generated files, such as `__snapshots__/**` or golden JSON). A verify that changes tracked files names them.
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
hasn't exported yet (export first), so nothing is lost or sent twice. A file under `game/<slug>/` that differs only in line endings (a
test snapshot rewritten on Windows) doesn't refuse it: it is named in a note and put back to its committed version
first (2.58.3); any other uncommitted change still refuses.

**Faster verifies for a big test suite.** With `STUDIO_WHOLE_GAME=on`, a lane's verify runs only the tests
related to the change (an adopted Vitest or Jest game's test check declares `related`), and the whole suite
runs after landing.

**Real key presses on the real game (2.45.0).** An adopted web game isn't a cartridge, so `npm run play:browser`
can't drive it. `npm run play:controls` can: it serves the game, clicks from the title screen to play, presses
every control in the Game Bible and checks what each must change. Adopting a Vite (or Next, or `npm run dev`)
game writes a starter `game/<slug>/studio.browser.json`; fill it in once:

```json
{
  "serve": { "command": "npx vite --port {port} --strictPort --host 127.0.0.1", "url": "http://127.0.0.1:{port}/" },
  "init": "localStorage.clear(); sessionStorage.clear()",
  "start": [{ "click": "[data-testid=new-game]" }, { "wait": 400 }, { "click": "[data-testid=start-pax]" }],
  "ready": "Boolean(window.__game)",
  "state": "({ cash: window.__game.cash, speed: window.__game.speed, view: window.__game.view })",
  "settleMs": 8000,
  "controls": { "view.hall": { "key": "KeyH", "before": "window.__game.buildStarterKit()" } }
}
```

- `state` is what the Bible's effects read; the game needs a dev-only handle on `window` for it.
- A Bible control whose `input` reads `key Space` or `key 2` needs no entry under `controls`; clicks, key
  combinations and set-up (`before`, run just before the press) go there.
- Each press waits up to `settleMs` for the effect, so a slow WebGL frame doesn't fail a live control.
- An effect may say where a value must end: `{ "path": "speed", "to": 0 }`. A value that was already there
  before the press fails (the press proved nothing): order the Bible's controls so each one moves something.
- The report (`qa/reports/controls-web-*.json`) is what `qa/controls-check.mjs` reads for the web track. The
  server it starts is stopped at the end, child processes included.

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

## Pins and union files for the merge train (2.60.0)

Two optional keys in `<game>/studio.gates.json` (a protected file: the owner approves changes) tell the merge train
(`harness/train.mjs`, see `docs/WORK-ORGANIZATION.md`) how to land lanes that touch the same seeded numbers or the
same import list:

```json
{
  "gates": [{ "id": "unit", "command": "npm test" }],
  "pins": {
    "tests": ["runwayCapacity", "curbWindow", "replays/start-*"],
    "report": "node game/mygame/pins.mjs report --out {out}",
    "refresh": "node game/mygame/pins.mjs refresh --in {in}",
    "invariants": ["goAroundCap", "stuckCheck"]
  },
  "unionFiles": ["src/game/modules.ts"]
}
```

- **pins.tests**: the game's pin tests (exact numbers from a seeded run, recordings), as names or `*` globs. A failing
  test is a pin test when an entry matches its name whole or as a token (`runwayCapacity` matches
  `pins > runwayCapacity` and `runwayCapacity: expected 10, got 11`). The game's checks name their failing tests in
  the log (lines like `FAIL <name>`, `× <name>`, `not ok N - <name>`): a check that fails without naming its tests is
  never treated as pins-only.
- **pins.report**: a command (run from the repo root of the tree being checked, `CI=true`) that runs the pins and
  writes a JSON object `{ "<pin>": <value>, ... }` to `{out}` (replaced by a quoted path). It must exit 0 when the
  values don't match the expectations: it reports the values, it doesn't judge them. Pin names are its keys.
- **pins.refresh**: a command that rewrites the pinned expectations from such a report at `{in}`. It may change only
  the expectation files; the train commits whatever it changes, then runs the full verify again.
- **pins.invariants**: pin names (or `*` globs) that are never refreshed: a red line, a cap, a "no divert", a
  stuck/gridlock check. A lane that moves one is handed back. Keep their expectations in protected files too.
- A lane declares the pins it means to move with a commit trailer on its own commits: `Pin-Moves: runwayCapacity,
  curbWindow` (globs allowed). `git commit -m "T-12: wider taxiway" -m "Pin-Moves: runwayCapacity"`.
- **unionFiles**: repo-relative paths (or globs) of files that hold ONE import or re-export per line, in no particular
  order (an import barrel). When two lanes (or a lane and main) conflict only inside these files, the train merges
  them with git's union driver: both sides' added lines are kept, the train's side first. Never list a file whose
  order matters (save/restore/reset spreads, registration lists that change hashes, anything with a closing bracket
  both sides edit): union merge would silently produce a wrong order or a broken file there. For those, prefer a
  generated, sorted registry so no lane edits a shared file. A game may also put `<file> merge=union` in its own
  `.gitattributes`, so agents' own merges and rebases union it too (git 2.43's `merge-tree --write-tree`, which the
  train uses for its "onto main alone?" check, honours that attribute).
