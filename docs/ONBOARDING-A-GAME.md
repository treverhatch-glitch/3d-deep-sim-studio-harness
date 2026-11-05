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

**Faster red merge trains (2.65.3).** When a merge train is red, its re-checks run only the failing test files.
A test check may declare `"focus": "<command with {files}>"` (for example `"cd game/x && npx vitest run {files}"`);
`{files}` are the failing files as the runner printed them, quoted, with forward slashes. Without `focus`, a command
whose last step clearly runs vitest, jest or `node --test` gets the files appended; any other command (`npm test`)
re-runs whole, and the train's log says why. The manifest is protected: adding `focus` is the owner's change.

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

## Tests on shared randomness (2.67.0)

A test that starts a seeded game is only repeatable if the game's dice are its own. When a test setup file routes the
sim's random source to the worker's shared `Math.random`, `beginNew(42)` depends on which tests ran before it, and the
suite fails now and then. Declare what your calls look like in `studio.gates.json` (the names here are an example):

```json
{
  "testRandomness": {
    "mode": "warn",
    "seededCalls": ["\\bbeginNew\\s*\\("],
    "sharedRandomSetup": ["\\bforceSimRandom\\s*\\(\\s*Math\\.random"],
    "isolateCall": "forceSimRandom(null)",
    "setupFiles": ["src/test/setup.ts"]
  }
}
```

`node harness/test-rng.mjs` then flags a test file that makes a seeded call while a setup file (or the file itself)
routes the dice to `Math.random` and the file never makes the isolate call (`shared-random`), and a seeded call with no
argument or one built from `Math.random`/`Date.now` (`unseeded-game`). The game gate runs it as `game:test-rng`: a WARN
in verify, never a failure, and a hand-back lists the findings. `"mode": "required"` (or `STUDIO_TEST_RNG=required` for
a run) makes it fail; `"off"` turns it off. `setupFiles` defaults to files named `*setup*`, `paths` (where tests live)
to the game's folder. It reads text: a seeded call through a helper with another name isn't seen. The manifest is
protected: adding this needs the owner's approval.

## Test ports (2.77.3)

Never give a browser or e2e test a fixed port with `strictPort` (or Playwright's `reuseExistingServer`): a train's
verify and a builder's verify (or two trains) run the same file at once, and the second server fails ("Port 46117 is
already in use", `EADDRINUSE`) or, worse, the test drives the other tree's server. Ask the OS for a free port (listen
on port 0, or a small helper that does) and pass it to the server and the test; the browser-play `serve` command
above already gets one through `{port}`. The game gate prints `[game-gates] WARN game:test-ports: <file>:<line> …` for
each fixed port it finds in the game's e2e/browser tests and test-runner configs (`node harness/test-ports.mjs`;
advisory, never a failure; `STUDIO_TEST_PORTS=off` hides it), and the flake triager labels such a red
`port-collision`, not a flake and not the lane's failure. The rule: `studio/rules/test-ports.md`.

## The state probe (2.72.0)

A golden says the final hash changed, but not when the run first went another way. A probe prints the sim's state
digest at a few ticks, headless, and the game's checks compare those digests with main's. Declare it in
`studio.gates.json`:

```json
{ "stateProbe": { "command": "node game/<name>/tools/probe.mjs --ticks {ticks}", "ticks": [0, 100, 1000] } }
```

The command runs from the repo root. `{ticks}` becomes `0,100,1000`. It prints one line per tick, `tick <n> <digest>`
(or a JSON line `{"tick": n, "digest": "…"}`). `node harness/state-probe.mjs record` writes the baseline, by default
`<game>/qa/state-probe.json`; set `"baseline"` to put it elsewhere. Commit it. The game gate then runs
`game:state-probe`:

- The same digests as the baseline on main: PASS.
- Different, and no commit since main has a `Golden-Reason` trailer: FAIL, naming the first differing tick.
- Different with a `Golden-Reason`: PASS only if the re-recorded baseline is committed with the change.
- A probe that fails, times out or skips a tick: FAIL.
- No baseline on main yet: PASS with a note.

Main is the main checkout's branch, or `STUDIO_STATE_PROBE_BASE=<ref>`. The digests are plain strings, so a second
engine's probe (a C# sim beside the TS one) can later be held to the same baseline. The manifest is protected:
adding a probe needs the owner's approval.

## Slow tests under load (2.60.0)

The game check's own timeout grows with load (2.59.0), but a per-test timeout in the game's test config doesn't.
A game whose seeded tests are slow under a full suite declares them in `studio.gates.json`:

```json
{ "slowTests": { "pattern": "src/**/*.slow.test.ts", "timeoutScale": true, "minScale": 1 } }
```

Each of the game's checks then runs with `STUDIO_TEST_TIMEOUT_SCALE=<factor>` (the same load factor as the check's
timeout, at least `minScale` and never below 1; printed for every check and kept in its row as `testTimeoutScale`) and
`STUDIO_SLOW_TESTS=<pattern>`. The game's test config multiplies its timeouts by it, for example in `vitest.config.ts`:

```ts
const scale = Number(process.env.STUDIO_TEST_TIMEOUT_SCALE || 1);
// in defineConfig({ test: { ... } }):
testTimeout: 5000 * scale, hookTimeout: 10000 * scale,
```

or only for the slow files, with `{ timeout: 6000 * scale }` on those tests. Outside the gate the variable is unset, so
the factor is 1. `"timeoutScale": false` turns it off. The manifest is protected: adding this needs the owner's approval.

## The slow tier (2.69.0)

Long tests (a 60-day soak) put a floor under every verify and every merge train. The game's manifest (protected: the
owner approves) can move them to a nightly slow tier:

```json
{ "slowTests": ["src/**/*.soak.test.ts"], "gates": [ { "id": "unit", "command": "npx vitest run", "related": "npx vitest related --run --passWithNoTests {files}" }, { "id": "soak", "command": "npx vitest run --config soak.config.ts", "tier": "slow" } ] }
```

A check with `"tier": "slow"` is skipped in verifies and trains. The slow test globs are passed to the game's test
checks as `STUDIO_TEST_EXCLUDE` (comma-separated globs) in every verify; in the slow tier the test checks (those with a
`related` or `focus` command, or `"slowTests": true`) run with `STUDIO_TEST_ONLY` instead. Read both in the test config,
like `VITEST_MAX_WORKERS`, for example in `vitest.config.ts`:

```ts
const only = process.env.STUDIO_TEST_ONLY?.split(',').filter(Boolean);
const skip = process.env.STUDIO_TEST_EXCLUDE?.split(',').filter(Boolean) ?? [];
// in defineConfig({ test: { ... } }):
include: only?.length ? only : ['src/**/*.test.ts'], exclude: [...configDefaults.exclude, ...skip],
```

`npm run gates -- --tier slow` runs the slow tier on the checkout (game-gates with `STUDIO_GATE_TIER=slow`; the supervisor runs it on main once a day at
`STUDIO_SLOW_HOUR`, default 3); its base timeout is `STUDIO_SLOW_TIMEOUT_MS` (60 min). Each new failure is one bug task
(`.studio/slow-tier.json` keeps what was filed; `.studio/slow-tier-last.log` the last run). `STUDIO_SLOW_TIER=off`
puts everything back into every verify. The object form of `"slowTests"` (above) still only scales timeouts, unless it
also says `"tier": "slow"` (then its `pattern` is a slow glob).

## The purity ratchet and must-fail canaries (2.72.0)

A real game switched to the sim purity check (or a lint check) can start with hundreds of hits. Record them once as
standing, and from then on only new ones fail:

```
npm run purity -- baseline --write --by <person>     # writes <game>/purity-baseline.json (a cartridge's: cartridges/<name>/)
npm run purity                                       # standing, new and fixed hits
```

The baseline (harness/ratchet.mjs) keys each hit by file, rule and source line (spaces normalised), never the line
number, so moving code keeps its key. It covers the purity check ("purity": `scripts/check-sim-purity.mjs`, its
static rules and required deterministic math) and every check in this manifest with `"ratchet": true` (a section
per check id). A ratchet check's hits are its output lines `<file>:<line>[:<col>] [<RULE>] <message>` or
`<file>:<line>:<col>: <message> [<rule>]` (ESLint's unix formatter); a run that exits non-zero with no such line still
fails. Any new hit fails the check, and only the new ones are printed, with a Fix line. A fixed hit leaves the
baseline at task done (one commit of that file in the task's copy; `npm run purity -- baseline --shrink` by hand).
It never grows from a lane: in a lane copy a hit counts as standing only as far as the studio's branch lists it, and
the merge train holds a lane that grows it as tier C. Growing it is a person's call (their terminal; an agent with
`--permission "<their words>"`; an outside agent under a `purity-baseline` delegation; never a worker). No baseline
file: every hit fails, as before.

A check may also declare `"canary"`: a command that runs it on something broken, or a fixture path (passed through
the check's `focus` command, or appended when its command clearly runs vitest, jest or node --test; the run also gets
`STUDIO_CANARY`, the fixture's absolute path, or `1` for a command). The canary must make the check fail:

```json
{ "gates": [ { "id": "lint", "command": "npx eslint -f unix src", "ratchet": true, "canary": "npx eslint -f unix tools/canary/bad.ts" } ] }
```

`npm run gates -- --canaries` runs every canary (and the nightly slow tier does, after its run; a game with canaries
and no slow tier gets the nightly run for them). A check that stays green on its canary is "silently green": a
`gate.silently_green` event, a digest line and one harness task in `studio/HARNESS-TASKS.md` (the workaround queue);
a check with no canary is "unproven". Report only: it never blocks a landing, and exits 1 when a check is silently
green so a scheduled run shows red.

## Test workers sized to the machine (2.68.0)

The game's checks run with `CI=true` (no snapshot writes), and with `VITEST_MAX_WORKERS` and `STUDIO_TEST_WORKERS`:
the number of test workers the machine's free memory allows for this run (docs/WORK-ORGANIZATION.md, "Heavy work
shares the machine by budget"). Read that variable in the test config, not `CI`, for example in `vitest.config.ts`:

```ts
const workers = Number(process.env.VITEST_MAX_WORKERS) || undefined;
// in defineConfig({ test: { ... } }):
maxWorkers: workers,
```

Outside the gate the variable is unset and Vitest picks its own count.

### Per-test timeouts that fit the workers (2.73.2)

More workers make each test slower, so a per-test timeout tuned on a quiet run trips on time alone. When a check's
command runs vitest, jest or `node --test` (directly, or as the last step of the npm script it calls, such as the
`test` script an adopted game's check runs), the gate passes the runner a scaled per-test timeout:

- factor = ceil(4 x test workers / logical cores), between 1 and 4 (a test's timeout is taken as fitting a quarter
  load; 25 workers on 28 threads is x4), or the gate's load factor or the manifest's `slowTests` `minScale` if higher;
- vitest: `--testTimeout=<base x factor> --hookTimeout=<hook base x factor>`; jest: `--testTimeout`; `node --test`:
  `--test-timeout`, only when the command sets one (it has no per-test timeout by default);
- the base is the game's own: the largest number literal given for `testTimeout` (`hookTimeout`) in the config the
  runner uses (vitest.config.* / vite.config.*, found upward from the command's folder, or its `--config`; jest.config.*
  or package.json `"jest"`), else the runner's default (vitest 5 s / 10 s, jest 5 s). One it can't read as a number (an
  expression, a workspace or `projects` config, a flag already in the npm script) is left alone, saying why. The
  result is never below what the game set.

The line `[game-gates] <check>: per-test timeout 60 s (vitest, npm script "test": --testTimeout=60000 ...)` is printed
and the check's row keeps `"testTimeout": { ms, baseMs, factor, why, flags }`. It is a runtime flag: no test or config
file changes, so the weakened-tests gate has nothing to flag; a per-test `{ timeout }` in a test file is not changed
(read `STUDIO_TEST_TIMEOUT_SCALE` there, "Slow tests under load"). `STUDIO_TEST_TIMEOUT_SCALE=<n>` (at least 1)
replaces the worker-derived factor; `STUDIO_TEST_TIMEOUT_SCALE=off` passes nothing. pnpm and yarn scripts get nothing.

New games: `npm run new-game` makes a cartridge whose checks are plain node scripts (`qa.mjs`, golden, playtest) with
no per-test timeout, so nothing needs to fit. A web game's own vitest config can keep a timeout that fits one quiet
worker (the runner default, or e.g. `testTimeout: 15_000` for a heavy render test): the gate scales it for the load.

## Quarantined flaky tests (2.69.0)

A test the merge train's flake triager labelled flaky 3 times in a week is proposed on `studio/quarantine.json`
(docs/WORK-ORGANIZATION.md, "The flake triager"); once a person confirms it (or at once with `"autoQuarantine": true`
in this manifest or in that file), the game's checks get it in `STUDIO_TEST_QUARANTINE`, a JSON list of the active
entries' test files as the runner printed them (unset when none). Skip them in the test config, for example in
`vitest.config.ts`:

```ts
const quarantined: string[] = JSON.parse(process.env.STUDIO_TEST_QUARANTINE || '[]');
// in defineConfig({ test: { ... } }):
exclude: [...configDefaults.exclude, ...quarantined],
```

A fix task is filed for each; when it lands, a game dev releases the test: `npm run flakes -- release <test> --by <name>`.

A red whose only failures are per-test timeouts re-runs just those files alone with one test worker (2.72.0; needs a
`"focus"` command with `{files}`, or a command that clearly runs vitest, jest or `node --test`): green alone counts
green for that file (`timeout-flake`), red alone stays red (docs/WORK-ORGANIZATION.md, "Timeout-only reds"). A golden
check can name where it first went wrong with a `"divergence"` entry (docs/HASH.md, "Where a red golden first went
wrong").

## Landing tiers and batching for the merge train (2.63.0)

The merge train gives each lane a blast-radius tier from its diff (`harness/tiers.mjs`; docs/WORK-ORGANIZATION.md):
C waits for a person's release, B verifies the whole game and needs its Golden-Reason / Pin-Moves, A lands as before.
These keys in `<game>/studio.gates.json` (protected: the owner approves changes) tell it about the game:

```json
{
  "simPaths": ["src/sim/**"],
  "shared": ["src/util/**"],
  "registry": ["src/systems/registry.ts"],
  "ui": ["src/panels/**"],
  "irreversible": ["src/save/format.ts", "data/schema/**"],
  "pins": { "tests": ["throughput"], "report": "…", "refresh": "…", "files": ["src/sim/pins.expected.json"] },
  "runAlone": { "maxFiles": 40, "paths": ["src/sim/core/**"] },
  "tiers": {
    "rules": [{ "id": "render", "tier": "A", "paths": ["src/render/**"], "why": "drawing only, no game state" }],
    "set": { "registry": "A" },
    "default": "B"
  }
}
```

- **simPaths**, **shared**, **registry** (with `unionFiles`): tier B (behaviour, shared code, the registry or barrel).
  `game/*/sim/**`, `web/*/sim/**`, `cartridges/**`, `**/lib/**`, `**/utils/**`, `**/shared/**`, package files and
  `index.*` barrels are B already. **ui**: tier A unless the file is also in the sim paths.
- **irreversible**: files a wrong change can't be undone in (a save or schema format players' saves depend on):
  tier C, so a person releases each lane that changes them.
- **pins.files**: the pinned expectation files; a lane that changes one without a `Pin-Moves:` trailer is handed back.
- **runAlone**: a lane with more than `maxFiles` changed files, or one under `paths`, trains by itself.
- **tiers**: `rules` add rules (a file's tier is the highest rule it matches), `set` changes a default rule's tier by
  id (see `DEFAULT_TIER_RULES`), `default` is the tier of a file no rule names (B). A tier-C rule (protected files,
  harness code, deleted tests, irreversible files, upgrade merges) can't be lowered: the train notes and ignores it.

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
    "tests": ["throughput", "queueWindow", "replays/start-*"],
    "report": "node game/mygame/pins.mjs report --out {out}",
    "refresh": "node game/mygame/pins.mjs refresh --in {in}",
    "invariants": ["retryCap", "stuckCheck"]
  },
  "unionFiles": ["src/game/modules.ts"]
}
```

- **pins.tests**: the game's pin tests (exact numbers from a seeded run, recordings), as names or `*` globs. A failing
  test is a pin test when an entry matches its name whole or as a token (`throughput` matches
  `pins > throughput` and `throughput: expected 10, got 11`). The game's checks name their failing tests in
  the log (lines like `FAIL <name>`, `× <name>`, `not ok N - <name>`): a check that fails without naming its tests is
  never treated as pins-only.
- **pins.report**: a command (run from the repo root of the tree being checked, `CI=true`) that runs the pins and
  writes a JSON object `{ "<pin>": <value>, ... }` to `{out}` (replaced by a quoted path). It must exit 0 when the
  values don't match the expectations: it reports the values, it doesn't judge them. Pin names are its keys.
- **pins.refresh**: a command that rewrites the pinned expectations from such a report at `{in}`. It may change only
  the expectation files; the train commits whatever it changes, then runs the full verify again.
- **pins.invariants**: pin names (or `*` globs) that are never refreshed: a red line, a cap, a "no divert", a
  stuck/gridlock check. A lane that moves one is handed back. Keep their expectations in protected files too.
- A lane declares the pins it means to move with a commit trailer on its own commits: `Pin-Moves: throughput,
  queueWindow` (globs allowed). `git commit -m "T-12: wider taxiway" -m "Pin-Moves: throughput"`.
- **unionFiles**: repo-relative paths (or globs) of files that hold ONE import or re-export per line, in no particular
  order (an import barrel). When two lanes (or a lane and main) conflict only inside these files, the train merges
  them with git's union driver: both sides' added lines are kept, the train's side first. Never list a file whose
  order matters (save/restore/reset spreads, registration lists that change hashes, anything with a closing bracket
  both sides edit): union merge would silently produce a wrong order or a broken file there. For those, prefer a
  generated, sorted registry so no lane edits a shared file. A game may also put `<file> merge=union` in its own
  `.gitattributes`, so agents' own merges and rebases union it too (git 2.43's `merge-tree --write-tree`, which the
  train uses for its "onto main alone?" check, honours that attribute).
