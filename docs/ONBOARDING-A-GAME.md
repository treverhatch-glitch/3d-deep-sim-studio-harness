# Bringing an existing game into the studio (`docs/ONBOARDING-A-GAME.md`)

Best practices, not rules. They work for a finished game you keep improving and for one mid-development under another
workflow. The aim: every key fact about the game sits in a file the Producer and supervisors (reviewer, QA) read, so no agent
depends on a chat another model had. A tag such as (2.58.0) says which release added a feature. The manifest keys below
(`studio.gates.json`, `studio/game.json`) are protected: adding one needs the owner's approval.

## Scan, then adopt

```bash
npm run onboard -- --path ../my-game --name "My Game" --dry-run   # look first
npm run onboard -- --path ../my-game --name "My Game"             # then write
```

The scan only reads the game's folder. It writes `studio/game/GAME.md` (the fact sheet), `studio/game/inventory.json` (the
raw scan), onboarding tasks in `studio/NEXT.md` and a Producer-log note. It detects engine and tools, run commands, tests,
code size by language, assets, TODOs, and every call that makes a run unrepeatable (`Math.random`, `Date.now`, Godot `randi`,
Unity `Random` and `Time.deltaTime`). Rerun any time: it keeps your filled-in fact sheet unless `--force`, and never queues the
same task twice.

The scan only describes the game; the studio's checks, lanes, whole-game check and unwired-code check don't reach a game that
lives elsewhere. **Adopting** (2.43.0) brings it in:

```bash
npm run onboard -- --path ../my-game --name "My Game" --adopt --dry-run          # what it would do
npm run onboard -- --path ../my-game --name "My Game" --adopt --ref <branch>     # do it
cd game/my-game && npm ci                                                         # its packages
git add game/my-game studio && git commit -m "Adopt My Game" && npm run verify
```

- It copies the game's tracked files at `--ref` (default: what is checked out) into `game/<slug>/`, and says so if the game's
  own docs (CLAUDE.md, AGENTS.md, CONTRIBUTING.md, README.md) name a different trunk branch (a half-built game's `main` is
  often far behind).
- It declares the game's checks in `game/<slug>/studio.gates.json` from its scripts: type-check, `test` (required), `lint`,
  `e2e`, `build` (optional). Edit freely; the review task asks for it.
- It makes it the studio's game (`studio/game.json`) and records where it came from (`studio/game/ORIGIN.json`: repo, branch,
  commit).
- The Game Bible starts as an existing game: with design docs, the first task drafts it from them (an answers file for
  `npm run intake -- --answers`, each answer naming its source), a person checks and signs it, and pre-production asks for a
  style sheet from the existing art and storyboards from the current build, not placeholders.
- **A verify must not change the game's files (2.58.0).** Checks run with `CI=true`, so Vitest and Jest never write snapshots
  during a verify: updating snapshots is a deliberate run with `-u`, committed with the change (`STUDIO_GAME_GATE_CI=off`
  leaves `CI` alone). Give generated test files fixed line endings in the game's `.gitattributes` (`*.snap text eol=lf`, and
  the same for `__snapshots__/**` or golden JSON) or a Windows checkout rewrites them each run. A verify that changes tracked
  files names them.
- **Send work back:** `npm run onboard -- --export` writes the studio's committed changes to `game/<slug>/` since adoption (or
  the last sync) as one patch relative to the game's own repo (without `studio.gates.json`) and prints the commands to apply
  it there from the adopted commit (`git apply --3way`). The game's own repo, review and CI stay in charge.
- **Keep both in step (2.44.0):** `npm run onboard -- --sync [--ref <branch>]` brings the game repo's newer commits into
  `game/<slug>/` as one commit. It refuses while the studio has unexported changes (export first). A file differing only in
  line endings doesn't refuse: it is named and put back to its committed version first (2.58.3); any other uncommitted change
  refuses.
- **Whole-game check:** with `STUDIO_WHOLE_GAME=on` a lane's verify runs only tests related to the change (an adopted Vitest or
  Jest game's test check declares `related`), and the whole suite runs after landing.
- **Faster red trains (2.65.3):** when a train is red, re-checks run only the failing test files. A test check may declare
  `"focus": "<command with {files}>"` (e.g. `"cd game/x && npx vitest run {files}"`; `{files}` are the failing files as printed,
  quoted, forward slashes). Without `focus`, a command whose last step runs vitest, jest or `node --test` gets the files
  appended; one that runs an npm script (`npm test`, `cd game/x && npm test`) whose last step runs vitest or jest gets a
  focus inferred from it (earlier steps, then `npx vitest run {files}` or `npx jest {files}`, with the script's `--config`),
  logged once as `focus inferred: …` (`STUDIO_FOCUS_INFER=off`: none) (2.78.2). Any other command re-runs whole, and the log
  says why; since a timeout-only red "can't be run alone" without focus, `npm run onboard -- --check` and `npm run upgrade --
  --preflight` FAIL such a test check (`game-tests/focus:<check>`). Adding `focus` is the owner's change.

### Real key presses on the real game (2.45.0)

An adopted web game isn't a cartridge, so `npm run play:browser` can't drive it; `npm run play:controls` can: it serves the
game, clicks from the title screen to play, presses every control in the Game Bible and checks what each must change.
Adopting a Vite (or Next, or any game with a `dev` script) game writes a starter `game/<slug>/studio.browser.json`; fill it in:

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
- A control whose `input` reads `key Space` or `key 2` needs no `controls` entry; clicks, key combinations and set-up
  (`before`, run just before the press) go there.
- Each press waits up to `settleMs` for the effect. An effect may say where a value must end: `{ "path": "speed", "to": 0 }`. A
  value already there before the press fails (the press proved nothing): order the Bible's controls so each moves something.
- The report `qa/reports/controls-web-*.json` is what `qa/controls-check.mjs` reads for the web track. The server it starts is
  stopped at the end, child processes included.

## Then fill in what a scan can't know

The top of `GAME.md` is for the game's owner: the pitch, the state (prototype, alpha, live), pillars, core loop, target
platforms, who signs off, what agents must not touch, and where the design lives. The Producer's briefing (`npm run handoff`)
shows it first. Rewrite `studio/PLAN.md` too: goal, current phase, next milestones.

| Step | Why | Task the scan queues |
| --- | --- | --- |
| Fact sheet and plan | Producer and supervisors need the same picture | `Docs: fill in … GAME.md`, `Docs: rewrite studio/PLAN.md` |
| Study your own build | Know what runs every frame and talks to the network before changing anything | `Study: our own build of …` |
| Find the sim boundary | Which systems own game state, randomness and time | `Study: map … game state` |
| Wrap, don't rewrite | A thin adapter gives the harness `init`, `step`, `getState` and a hash (`qa/browser.adapter.mjs` is an example) | `Wrap … in a cartridge adapter` |
| Make one run repeatable | Seed the RNG, fix the tick, record the first golden | `Playtest: first seeded run …` |
| Import known bugs | Each with steps or a seed, so it becomes a regression once fixed | `Docs: import … known bugs` |
| Choose gates | Turn on what passes today; add the rest as the game gets there | `Review: choose which gates apply …` |

Advice:

- The game's repo stays its home: scan with `--path` to look, `--adopt` to work on it, `--export` to send work back.
- Taming randomness is gradual: the scan's count is a to-do list. Start with the systems the first replay touches.
- Gates arrive in steps: secrets, session and a smoke playtest work on day one; golden, purity and soak follow once the
  adapter exists. Mark the rest optional in `studio/gates.json` until then.
- Bring the history briefly: decisions that still matter go to `studio/decisions/` as short records, the old tracker's open
  items to `studio/NEXT.md`.
- Note where art, audio and fonts came from and under what licence before agents change them
  (`studio/references/APPROVALS.md`).
- Name one owner who signs off design, balance and releases in the fact sheet; agents prepare, that person decides.
- Mid-development games: pick a freeze point, finish or park open branches, and keep the old CI running until the studio's
  gates cover the same ground.

## Tests: randomness, ports, probe

### Shared randomness (2.67.0)

 A seeded test is repeatable only if the game's dice are its own: if a setup file routes the
sim's random source to the worker's shared `Math.random`, `beginNew(42)` depends on which tests ran before. Declare your calls
in `studio.gates.json` (names are an example):

```json
{ "testRandomness": { "mode": "warn", "seededCalls": ["\\bbeginNew\\s*\\("],
    "sharedRandomSetup": ["\\bforceSimRandom\\s*\\(\\s*Math\\.random"], "isolateCall": "forceSimRandom(null)", "setupFiles": ["src/test/setup.ts"] } }
```

`node harness/test-rng.mjs` flags a file that makes a seeded call while a setup file (or the file) routes the dice to
`Math.random` and never makes the isolate call (`shared-random`), and a seeded call with no argument or one built from
`Math.random`/`Date.now` (`unseeded-game`). The game gate runs it as `game:test-rng`: a WARN, never a failure.
`"mode": "required"` (or `STUDIO_TEST_RNG=required` for one run) makes it fail; `"off"` turns it off. `setupFiles` defaults to
files named `*setup*`, `paths` (where tests live) to the game's folder. It reads text: a seeded call through a differently
named helper isn't seen.

### Test ports (2.77.3)

 Never give a browser or e2e test a fixed port with `strictPort` (or Playwright's
`reuseExistingServer`): two verifies running the same file at once fail with `EADDRINUSE` or drive the other tree's server. Ask
the OS for a free port (listen on port 0) and pass it to the server and test; the `serve` command above gets one through
`{port}`. The game gate prints `[game-gates] WARN game:test-ports: <file>:<line> …` for each fixed port in the e2e/browser
tests and test-runner configs (`node harness/test-ports.mjs`; advisory), and the flake triager labels such a red
`port-collision`. The rule: `studio/rules/test-ports.md`.

### The state probe (2.72.0)

 A golden says the final hash changed, not when the run first diverged. A probe prints the sim's
state digest at a few ticks, headless, and the game's checks compare them with main's:

```json
{ "stateProbe": { "command": "node game/<name>/tools/probe.mjs --ticks {ticks}", "ticks": [0, 100, 1000] } }
```

The command runs from the repo root; `{ticks}` becomes `0,100,1000`; it prints `tick <n> <digest>` per tick (or a JSON line
`{"tick": n, "digest": "…"}`). `node harness/state-probe.mjs record` writes the baseline (default `<game>/qa/state-probe.json`;
`"baseline"` moves it); commit it. `game:state-probe` then: same digests as main's baseline PASS; different with no
`Golden-Reason` trailer since main FAIL naming the first differing tick; different with one PASS only if the re-recorded
baseline is committed with the change; a probe that fails, times out or skips a tick FAIL; no baseline on main PASS with a
note. Main is the main checkout's branch, or `STUDIO_STATE_PROBE_BASE=<ref>`. Digests are plain strings, so a second
engine's probe can be held to the same baseline.

## Test timing, workers, slow and perf tiers

The checks run with `CI=true`, `VITEST_MAX_WORKERS` and `STUDIO_TEST_WORKERS` (the workers the machine's free memory allows;
docs/WORK-ORGANIZATION.md, "Heavy work shares the machine by budget"), and may get the variables below. Read them in the test
config, not `CI`; outside the gate they are unset. One `vitest.config.ts` shape covers all of them:

```ts
const num = (v?: string) => Number(v) || undefined;
const scale = Number(process.env.STUDIO_TEST_TIMEOUT_SCALE || 1);                        // slow tests under load
const only = process.env.STUDIO_TEST_ONLY?.split(',').filter(Boolean);                   // slow tier / perf step
const skip = process.env.STUDIO_TEST_EXCLUDE?.split(',').filter(Boolean) ?? [];          // slow and perf globs
const quarantined: string[] = JSON.parse(process.env.STUDIO_TEST_QUARANTINE || '[]');    // quarantined flakes
// in defineConfig({ test: { ... } }):
maxWorkers: num(process.env.VITEST_MAX_WORKERS), testTimeout: 5000 * scale, hookTimeout: 10000 * scale,
include: only?.length ? only : ['src/**/*.test.ts'], exclude: [...configDefaults.exclude, ...skip, ...quarantined],
```

### Per-test timeouts that fit the workers (2.73.2)

More workers make each test slower, so a timeout tuned on a quiet run trips on time alone. When a check's command runs vitest,
jest or `node --test` (directly, or as the last step of the npm script it calls), the gate passes a scaled per-test timeout:

- factor = ceil(4 x test workers / logical cores), between 1 and 4 (25 workers on 28 threads is x4), or the gate's load factor
  or the manifest's `slowTests` `minScale` if higher.
- vitest: `--testTimeout=<base x factor> --hookTimeout=<hook base x factor>`; jest: `--testTimeout`; `node --test`:
  `--test-timeout`, only when the command sets one.
- The base is the game's own: the largest number literal for `testTimeout` (`hookTimeout`) in the config the runner uses
  (vitest.config.* / vite.config.*, found upward from the command's folder, or `--config`; jest.config.* or package.json
  `"jest"`), else the runner default (vitest 5 s / 10 s, jest 5 s). One it can't read as a number (an expression, a workspace
  or `projects` config, a flag already in the script) is left alone, saying why. Never below what the game set.

The line `[game-gates] <check>: per-test timeout 60 s (vitest, npm script "test": --testTimeout=60000 ...)` is printed and the
row keeps `"testTimeout": { ms, baseMs, factor, why, flags }`. It is a runtime flag (no test or config file changes, so the
weakened-tests gate has nothing to flag); a per-test `{ timeout }` in a test file is unchanged (read
`STUDIO_TEST_TIMEOUT_SCALE` there). `STUDIO_TEST_TIMEOUT_SCALE=<n>` (at least 1) replaces the worker-derived factor; `=off`
passes nothing. pnpm and yarn scripts get nothing. New games (`npm run new-game`) have plain node-script checks with no
per-test timeout; a web game's own config can keep one that fits a quiet worker, and the gate scales it.

### Slow tests under load (2.60.0)

The check's own timeout grows with load (2.59.0) but a per-test timeout in the game's config doesn't. Declare slow seeded tests:

```json
{ "slowTests": { "pattern": "src/**/*.slow.test.ts", "timeoutScale": true, "minScale": 1 } }
```

Each check then runs with `STUDIO_TEST_TIMEOUT_SCALE=<factor>` (the check's load factor, at least `minScale` and never below
1; printed for every check, kept as `testTimeoutScale`) and `STUDIO_SLOW_TESTS=<pattern>`; the config multiplies its timeouts
by it (snippet above, or `{ timeout: 6000 * scale }` on those tests). `"timeoutScale": false` turns it off.

### The slow tier (2.69.0)

Long tests (a 60-day soak) put a floor under every verify and train. The manifest can move them to a nightly slow tier:

```json
{ "slowTests": ["src/**/*.soak.test.ts"], "gates": [ { "id": "unit", "command": "npx vitest run", "related": "npx vitest related --run --passWithNoTests {files}" }, { "id": "soak", "command": "npx vitest run --config soak.config.ts", "tier": "slow" } ] }
```

A check with `"tier": "slow"` is skipped in verifies and trains. The slow globs reach the test checks as `STUDIO_TEST_EXCLUDE`
(comma-separated) in every verify; in the slow tier the test checks (with a `related` or `focus` command, or
`"slowTests": true`) run with `STUDIO_TEST_ONLY` instead. `npm run gates -- --tier slow` runs it on the checkout
(`STUDIO_GATE_TIER=slow`); the supervisor runs it on main daily at `STUDIO_SLOW_HOUR` (3), base timeout
`STUDIO_SLOW_TIMEOUT_MS` (60 min). Each new failure is one bug task (`.studio/slow-tier.json` keeps what was filed,
`.studio/slow-tier-last.log` the last run). `STUDIO_SLOW_TIER=off` puts everything back in every verify. The object form of
`"slowTests"` only scales timeouts unless it also says `"tier": "slow"` (then its `pattern` is a slow glob).

### Perf tests: the game:perf step (2.78.2)

Wall-clock tests (a millisecond budget for a layout pass) pass alone and fail when several verifies share the PC. List their
globs so they run alone on a quiet machine, in `studio/game.json`:

```json
{ "game": "my-game", "perfTests": ["src/**/*.perf.test.ts"] }
```

Until the owner adds `"perfTests"` (or to try it), `STUDIO_PERF_TESTS` (comma list of globs) does the same; `=off` runs them in
the unit checks again. The test checks (a `related` or `focus` command, `"slowTests": true`, or vitest, jest or `node --test` as
the last step) get the globs in `STUDIO_TEST_EXCLUDE`; after the other checks a `game:perf` step reruns them with
`STUDIO_TEST_ONLY` set to the globs and one worker, once the machine is quiet (no other heavy job, game check, Unity editor or
engine-porter session: `harness/flake-quiet.mjs`).

- A train's verify waits up to `STUDIO_PERF_WAIT_MIN` (10) for quiet and holds new builder and lane verifies back meanwhile; a
  builder's or lane's verify runs the step only if already quiet.
- Never quiet: `WARN game:perf: not run (busy)`, never red (in a train's focused re-check it is a busy refusal and judges
  nothing). Quiet and red: fails like any required check, naming its files.
- A lane verify that said "not run (busy)" is marked `perfNotRun` in the game gate's row: a train reusing it for the same tree
  first runs just `game:perf` on it (alone, waiting up to `STUDIO_PERF_WAIT_MIN`); still busy: the train defers its lanes,
  judging nobody; red: the tree is red.
- **Wall-clock asserts outside perf tests:** `[game-gates] WARN game:test-timing: <file>:<line> asserts on wall-clock time …`
  names files outside the perf globs asserting on an elapsed time (`performance.now()`, `Date.now()`, `process.hrtime`
  differences, or a value derived from one, compared in `expect(...).toBeLessThan(...)`, `assert(elapsed < 40)`). Taking a time
  without asserting is never flagged. Advisory only; `STUDIO_TEST_TIMING=off` hides it; `node harness/test-timing.mjs` lists
  them. Move each into a `perfTests` glob.

### Quarantined flaky tests (2.69.0)

A test the train's flake triager labelled flaky 3 times in a week is proposed on `studio/quarantine.json`
(docs/WORK-ORGANIZATION.md, "The flake triager"); once a person confirms it (or at once with `"autoQuarantine": true` in the
manifest or that file), the checks get `STUDIO_TEST_QUARANTINE`, a JSON list of the active entries' test files as the runner
printed them (unset when none); skip them in the config (snippet above). A fix task is filed for each; when it lands a game dev
releases the test: `npm run flakes -- release <test> --by <name>`.

- Game-gates says a quarantined file is "skipped" only after checking that the config honours the variable (2.78.2): it runs
  the runner's list mode (`npx --no vitest list --filesOnly`, or `npx --no jest --listTests`, in the check's folder with its
  `--config`) without the variable and again with it, once per test config (hash of runner command, config file and
  package.json; cached in `.studio/test-config-check.json`; each run bounded by `STUDIO_TEST_LIST_TIMEOUT_MS`, 120000). Still
  listed: `WARN game:quarantine: quarantine NOT honoured by the game's test config (<file>): N quarantined tests still run`,
  and none count as skipped. Can't tell (another runner, list mode failed): "passed to the game's runner … not verified".
  `STUDIO_QUARANTINE_VERIFY=off` skips the check.
- `npm run onboard -- --check` and `npm run upgrade -- --preflight` run the same check and FAIL a config that ignores
  `STUDIO_TEST_QUARANTINE` (`game-tests/quarantine:<check>`), or `STUDIO_TEST_EXCLUDE` when perf or slow-tier tests are
  declared (`game-tests/exclude:<check>`), with the line to add to its `exclude`.
- A red whose only failures are per-test timeouts reruns just those files alone with one worker (2.72.0; needs a `"focus"`
  command, or a command that clearly runs vitest, jest or `node --test`): green alone counts green (`timeout-flake`), red stays
  red (docs/WORK-ORGANIZATION.md, "Timeout-only reds"). A golden check can name where it first went wrong with a `"divergence"`
  entry (docs/HASH.md, "Where a red golden first went wrong").

## The purity ratchet and must-fail canaries (2.72.0)

A real game switched to the sim purity check (or a lint check) can start with hundreds of hits. Record them once as standing;
from then on only new ones fail:

```
npm run purity -- baseline --write --by <person>     # writes <game>/purity-baseline.json (a cartridge's: cartridges/<name>/)
npm run purity                                       # standing, new and fixed hits
```

- The baseline (`harness/ratchet.mjs`) keys each hit by file, rule and source line (spaces normalised), never the line number.
  It covers the purity check (`scripts/check-sim-purity.mjs`) and every manifest check with `"ratchet": true` (one section per
  check id), whose hits are output lines `<file>:<line>[:<col>] [<RULE>] <message>` or `<file>:<line>:<col>: <message> [<rule>]`
  (ESLint's unix formatter); a run exiting non-zero with no such line still fails.
- Any new hit fails and only new ones are printed, with a Fix line. A fixed hit leaves the baseline at task done (one commit of
  that file in the task's copy; `npm run purity -- baseline --shrink` by hand). It never grows from a lane: in a lane copy a
  hit counts as standing only as far as the studio's branch lists it, and the train holds a lane that grows it as tier C.
  Growing it is a person's call (their terminal; an agent with `--permission "<their words>"`; an outside agent under a
  `purity-baseline` delegation; never a worker). No baseline file: every hit fails.
- A check may declare `"canary"`: a command that runs it on something broken, or a fixture path (passed through the check's
  `focus` command, or appended when its command clearly runs vitest, jest or node --test; the run gets `STUDIO_CANARY`, the
  fixture's absolute path, or `1` for a command). The canary must make the check fail:

```json
{ "gates": [ { "id": "lint", "command": "npx eslint -f unix src", "ratchet": true, "canary": "npx eslint -f unix tools/canary/bad.ts" } ] }
```

`npm run gates -- --canaries` runs every canary (and the nightly slow tier does after its run; a game with canaries and no slow
tier gets the nightly run for them). A check green on its canary is "silently green": a `gate.silently_green` event, a digest
line and one harness task in `studio/HARNESS-TASKS.md`; a check with no canary is "unproven". Report only: it never blocks a
landing, and exits 1 when a check is silently green so a scheduled run shows red.

## Landing tiers and batching for the merge train (2.63.0)

The train gives each lane a blast-radius tier from its diff (`harness/tiers.mjs`; docs/WORK-ORGANIZATION.md): C waits for a
person's release, B verifies the whole game and needs its Golden-Reason / Pin-Moves, A lands as before. These keys in
`<game>/studio.gates.json` tell it about the game:

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

- **simPaths**, **shared**, **registry** (with `unionFiles`): tier B. `game/*/sim/**`, `web/*/sim/**`, `cartridges/**`,
  `**/lib/**`, `**/utils/**`, `**/shared/**`, package files and `index.*` barrels are B already. **ui**: tier A unless also in
  the sim paths.
- **irreversible**: files a wrong change can't be undone in (a save or schema format): tier C, a person releases each lane.
- **pins.files**: pinned expectation files; a lane changing one without a `Pin-Moves:` trailer is handed back.
- **runAlone**: a lane with more than `maxFiles` changed files, or one under `paths`, trains by itself.
- **tiers**: `rules` add rules (a file gets the highest tier of the rules it matches), `set` changes a default rule's tier by id
  (`DEFAULT_TIER_RULES`), `default` is the tier of a file no rule names (B). A tier-C rule (protected files, harness code,
  deleted tests, irreversible files, upgrade merges) can't be lowered: the train notes and ignores it.

## Path-scoped gates and parallel tracks (2.30p)

A game with more than one build (a browser build under `web/`, an engine build under `godot/`) should scope its gates:

```json
{
  "shared": ["data/rules/**"],
  "gates": [
    { "id": "playtest", "command": "npm run playtest", "paths": ["web/mygame/**", "tools/mygame/**"], "track": "web" },
    { "id": "engine-smoke", "command": "npm run godot-unit", "paths": ["godot/**"], "track": "engine" }
  ]
}
```

- `task done` in a lane copy runs only the gates whose `paths` its diff touches, logging each skipped gate with the reason. A
  change under `shared` (or `harness/`, `scripts/`, `studio/gates.json`, package files, the manifest) runs every gate; a gate
  without `paths` always runs.
- The pass is recorded with its commit and scope; if the studio's branch moves before the lane lands and everything it brought
  in is outside that scope, the pass is reused. Only the final fast-forward and board write take the short land lock, so tracks
  verify and land in parallel.
- **Stage-1 playtest (2.78.1):** with a game that has checks of its own, `npm run playtest:stage1` has nothing of the game to
  play unless a cartridge drives its sim (without `--cartridge` it plays the template, example-sim). It always prints what it
  stepped (`[playtest] stage 1: … stepped N tick(s) of cartridge X …; the studio's game is Y`) and records `studioGame`,
  `ofStudioGame`, `gameCheck` in its report. When it played only the template, `STUDIO_PLAYTEST_GAME_CHECK` decides: `warn`
  (default) passes with `[playtest] WARN QA-STAGE1-NOT-THE-GAME: stage 1 played the template, not the studio's game …` (also in
  the report's `warnings`, and as a `WARN` line from `task done` and `node harness/done-check.mjs <ID>` for a playtest or
  system task); `fail` makes it a P0 finding; `off` is the 2.78.0 behaviour. A stage that stepped 0 ticks always fails
  (`QA-STAGE1-RAN-NOTHING`, 2.77.3). To test the game, use its own checks (`npm run gates -- --only game`, or the manifest's
  playtest check) or `--cartridge <a cartridge that drives the game's sim>`; the verify itself skips the cartridge gates for
  such a game.

## Pins and union files for the merge train (2.60.0)

Two optional keys in `<game>/studio.gates.json` tell the train (`harness/train.mjs`, docs/WORK-ORGANIZATION.md) how to land
lanes that touch the same seeded numbers or the same import list:

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

- **pins.tests**: the pin tests (exact numbers from a seeded run, recordings), as names or `*` globs. A failing test is a pin
  test when an entry matches its name whole or as a token (`throughput` matches `pins > throughput` and `throughput: expected
  10, got 11`). The checks must name failing tests in the log (`FAIL <name>`, `× <name>`, `not ok N - <name>`): a check that
  fails without naming them is never treated as pins-only.
- **pins.report**: a command (from the repo root of the tree checked, `CI=true`) writing a JSON object `{ "<pin>": <value>, ...
  }` to `{out}` (a quoted path). It must exit 0 when values don't match expectations: it reports, it doesn't judge.
- **pins.refresh**: a command rewriting the pinned expectations from a report at `{in}`. It may change only expectation files;
  the train commits what it changes, then runs the full verify again.
- **pins.invariants**: pin names (or globs) never refreshed: a red line, a cap, a "no divert", a stuck/gridlock check. A lane
  that moves one is handed back. Keep their expectations in protected files too.
- A lane declares the pins it means to move with a commit trailer: `Pin-Moves: throughput, queueWindow` (globs allowed), e.g.
  `git commit -m "T-12: wider taxiway" -m "Pin-Moves: throughput"`.
- **unionFiles**: repo-relative paths or globs of files holding ONE import or re-export per line, in no particular order (an
  import barrel). When two lanes (or a lane and main) conflict only inside them, the train merges with git's union driver: both
  sides' added lines are kept, the train's side first. Never list a file whose order matters (save/restore/reset spreads,
  registration lists that change hashes, anything with a closing bracket both sides edit): union merge would silently produce
  a wrong order or a broken file; prefer a generated, sorted registry. A game may also put `<file> merge=union` in its own
  `.gitattributes`, so agents' merges and rebases union it too (git 2.43's `merge-tree --write-tree`, used for the train's "onto
  main alone?" check, honours it).
