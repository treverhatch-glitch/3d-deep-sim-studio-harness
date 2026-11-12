# The Unity track (`docs/UNITY-TRACK.md`)

How the studio builds a game in Unity without its agents drifting: the rules in a pure C# assembly that anything can test,
the editor for what only the editor can check, and real input for every control. The engine train (board tasks, tuning,
the engine line, the rules check) is in [ENGINE-TRACKS.md](ENGINE-TRACKS.md) and [NATIVE-ENGINE.md](NATIVE-ENGINE.md);
this page is the Unity specifics. A tag such as (2.67.1) says which release added a feature.

## The shape of a Unity game here

| Part | Where | Checked by | Editor? |
| --- | --- | --- | --- |
| The rules (the sim) | `Assets/Sim/`, its own assembly with `noEngineReferences: true` | `npm run engine:sim`: the purity check, then its tests with .NET | No |
| Parity with the web game | `tools/SimCli` (same source as the build) | `npm run parity` | No |
| The game (input, drawing, UI) | `Assets/Game/`; `GameDriver` steps the sim in `FixedUpdate` | `npm run engine:gate`: Edit Mode and Play Mode tests in batch mode | Yes, plus a licence |
| Every control | `Assets/Tests/PlayMode/ControlsTests.cs` | the gate writes `qa/reports/controls-unity.json`; the controls check reads it (Bible `tracks` includes `unity`) | Yes |

- **Why split:** the editor needs an install and a licence on every machine and starts slowly; if every change waited for
  it, agents would skip it. The sim needs neither, so every lane runs it in seconds.
- **Purity check:** no `UnityEngine`, no `Time`, no `UnityEngine.Random` or unseeded `System.Random`, no wall clock,
  threads, files or network. The asmdef's `noEngineReferences` makes the compiler refuse engine code too.
- **Scenes are built in code.** Scene and prefab files are YAML full of GUIDs that agents break and can't review, so the
  template has none: `GameDriver` builds the camera, light, HUD and Buy button at start. Use prefabs for art an artist
  makes in the editor; keep the wiring in code.

## Start a Unity track

```bash
npm run engine -- propose unity --by <producer> --why "…"   # a question for the game dev
# the game dev answers yes: engine/<game>/ is copied from engine/_unity/
npm run engine:sim        # purity and tests with .NET (no editor)
npm run parity            # the C# sim against the web game, seed by seed (no editor)
npm run engine:gate       # the editor: Edit Mode and Play Mode tests, the controls test
npm run engine:build      # the playable Windows .exe (--target web for WebGL)
```

The template is a worked port of the template game: purity clean, 7 tests pass, parity matches seeds 1 to 5 and 1337, and a
planted `UnityEngine.Random` or a free purchase is caught (`scripts/check-unity-template.mjs`, CI job engine-unity-sim).
The editor side is proven by CI's engine-unity-editor job once the licence secrets exist (see Licence and CI).

## A port in its own repo (2.47.0)

When the Unity project is a separate repo cloned beside the studio, link it instead of using the template:

```bash
npm run engine -- link unity ../my-unity-port --build windows --web "<web runs command> {seeds}" --source game/<slug>/src/game
```

- It records `engine/<game>/engine.json` (the port's folder, remote and commit, the gate, the parity commands, the build
  target). Nothing is copied into the port's repo; porters work in it on its own branches.
- `--build windows` makes the Windows `.exe` the default and turns the browser export off (the Arcade lists native builds
  only). Windows is the default for every Unity track (2.48.0, CI's engine-unity-build); `--target web` on
  `engine:build`, or `link ... --build web`, makes a WebGL build.
- `--web` is the web side of parity for a game that isn't a cartridge: a command printing one JSON line per seed, like
  `{"seed":1,"outcome":"won","tick":300,"cash":…}`. Both sides are compared field by field.
- `--source` names the web folders whose changes count as drift (`npm run engine -- drift`).
- **Vite game (2.50.0):** Vite-only features (`import.meta.glob`) don't run in plain Node, so the web side is a Vitest run.
  The harness passes the seeds in `STUDIO_PARITY_SEEDS` (and `{seeds}`), which works in Windows' shell and bash:
  `--web "cd game/<slug> && npx vitest run tests/sim/replay.test.ts --silent=false"`. The test reads
  `process.env.STUDIO_PARITY_SEEDS` and prints `console.log(JSON.stringify({ seed, outcome, tick, cash, pax, flights }))`
  per seed. Only output lines that parse as JSON with a `seed` count.

## Render pipeline: URP or HDRP

The template uses neither in particular. A Windows-only game can take HDRP (its lack of a browser build doesn't matter
there); a game that also ships to the browser takes URP. Know first: Unity's 2026 plan puts new lighting work into URP (HDRP gets stability fixes only);
HDRP's first build compiles thousands of shaders (30-60 minutes on CI); ray tracing needs DirectX 12 and an RTX-class card.
To switch by hand: install **High Definition RP** (Package Manager, the 17.x line of URP); **Window > Rendering > HDRP Wizard
> Fix All**; **Edit > Rendering > Materials > Convert All Built-in/URP Materials to HDRP**, then recheck every scene's
lighting (physical light units); assign the HDRP asset to every Quality level; set ray tracing only if every target PC has
an RTX-class card. Builds are Windows only; the sim (`Assets/Sim`) never touches rendering and doesn't change.

## Adopt an existing Unity game

`npm run onboard -- --path ../my-unity-game --name "…" --adopt` declares its checks in `game/<slug>/studio.gates.json`:
`sim-purity` and `sim` (required) when it has `Assets/Sim` and `tools/SimTests`; `unity-editmode` and `unity-playmode`
(optional; make them required once every machine that runs checks has the editor). A game with no pure sim gets a warning:
moving its rules into `Assets/Sim` is the first port task, because until then nothing outside the editor can test them or
stop engine time and randomness leaking in.

## Porting a web game to Unity

1. **Make the web sim repeatable first:** seeded RNG and the tick instead of every `Math.random` and `Date.now`, and record
   goldens. Without that there is nothing to compare with.
2. **Port one module at a time into `Assets/Sim`** like the template: `uint` for 32-bit maths, `JsRound` for `Math.round`,
   one `Step` per tick, state as plain data.
3. **Parity per module:** `npm run parity` compares outcome, tick and any field in `engine.json` `parity.compare`. Add
   fields as modules land (cash, passengers served, queue lengths); a module is ported only when it matches.
4. **Art:** `.glb` models import with glTFast (`com.unity.cloud.gltfast`); the approvals and licence checks of
   `docs/ART-PIPELINE.md` apply unchanged.
5. **Controls:** the Bible's controls list gets `unity` in its tracks; each control gets a Play Mode test that presses it
   through the Input System and checks the sim value it must change.

## Playing it while it's built

- Editor: open `engine/<game>` in Unity Hub and press Play (the game boots itself in any scene).
- Windows build (default): `npm run engine:build` makes `Build/Windows/Game.exe`.
- Browser (only if wanted): `npm run engine:build -- --target web` makes `Build/WebGL`, compressed with the browser-side
  fallback so any static host can serve it.
- CI, once the licence secrets exist: every push to main builds the Windows game as the `unity-windows` artifact.

## Web and Unity at the same time

The web game can keep growing while it is ported.

- **Separate folders, separate lanes:** web work in `cartridges/<game>` or `game/<slug>`, Unity work in `engine/<game>`;
  each lane runs only its own checks. The engine gate and parity are optional, so a web change the port hasn't caught up
  with never fails a web lane.
- **The port follows a pin.** `npm run engine -- port --from <sha>` pins the web rules the port matches (an adopted game
  names its rule folders once: `--source game/<name>/src/game`). Parity compares the Unity sim with the pin, not the
  live web rules.
- **The lag is work, not a failure.** `npm run engine -- drift` lists the web commits since the pin; `--queue` adds one port
  task per commit to the porters' lane, each ending by moving the pin forward. The five-line status shows "Unity port N
  web change(s) behind".
- **When to stop growing the web version:** keep both while the browser is where you find the fun. Freeze new web features
  once drift is 0 and the Unity build is the one people play; then fixes only, or a lightweight demo. If drift grows week on
  week, the porters can't keep up: move feature work to Unity.

## Landing Unity work: the Unity gate (2.59.0)

The Unity repo keeps its own landing script (tests in batch mode, a build, a merge into its main branch); the harness only
runs it. Set it once in `studio/game.json` (protected: only the owner changes it, so a branch can't swap in a script that
always passes):

```json
{ "engines": { "unity": { "land": "<the Unity repo's land command> {branch}", "cwd": "<folder>", "timeoutMin": 120 } } }
```

- `{branch}` is `--branch`, else the task's Unity branch (`task add "<title>" --track engine:unity --branch <b>`, or later
  `node harness/unity-gate.mjs branch <ID> <b>`). With neither the gate refuses and says how to set it; it never uses the
  Unity folder's checked-out branch (2.60.1). `{task}` is the task ID. `{folder}` is `"folder"` in the same settings
  (relative to the studio, or absolute), else the Unity track's folder; a missing folder is an error. The command runs in
  `cwd` (relative to the studio), else that folder.
- If the land script has its own exit codes, declare them so the harness never guesses:

```json
{ "engines": { "unity": { "land": "node \"{folder}/tools/land.mjs\" {branch}", "folder": "../my-game-unity",
  "exits": { "1": { "status": "red", "why": "a test or the build failed" },
             "3": { "status": "error", "why": "bad branch: no such branch in the Unity repo" } } } } }
```

  `status` is pass, red, conflict, refused (busy: try later), error, or `not-run` (below). With `exits` set, an unlisted
  code is an error naming it. The output's last lines come with every non-pass result.
- `node harness/unity-gate.mjs [--task T-012] [--branch <name>] [--json]` runs it under the `machine:heavy` lock (it waits,
  naming the holder).
- Default contract (no `exits`): 0 pass (landed), 1 red, 2 conflict, 3 refused (busy, not a failure of the work), 4 error;
  anything else, a signal or a timeout (`timeoutMin`, `STUDIO_UNITY_GATE_TIMEOUT_MIN`, 120) is an error.
- `task done` runs it for a task added with `--track engine:unity`, after its other checks; the task closes only on a pass,
  and a refusal leaves it in progress ("run task done again later"). `STUDIO_DONE_UNITY_GATE=skip` turns that off; with no
  land command it is skipped with a note.
- Each run is kept: `.studio/gates/unity-last.json`, output in `.studio/gates/out/unity.log`, an `engine.land` event, a line
  in `studio/engine/LOG.md`. It is not part of `npm run verify` (a verify checks, never lands).

## The Unity merge train (2.63.0)

Several porters finishing together land on ONE run of the land command, one train at a time, always under `machine:heavy`.

- `npm run task -- done <ID> --train [--branch <name>]` (on a `--track engine:unity` task) runs every check `task done` runs
  before the Unity gate, then queues the Unity branch (`--branch`, else the Unity folder's current branch) in
  `.studio/train/unity-queue.json`. The task stays in progress.
- `npm run task -- train --unity [--max N] [--dry-run]` lands the queue, oldest first. `npm run task -- train status` shows
  the queue and the train running (`node harness/unity-train.mjs status --json`).
- Conflicts are found first from refs only (`git merge-tree`, no files touched): a branch conflicting with the target is
  handed back; one conflicting only with an earlier branch waits for the next train.
- Pass: the target must then contain every branch (else nothing closes); every task closes.
- Red (1) or conflict (2): prefix bisection like the web train (the land command reruns on target + first half, about log2 N
  more runs). A green prefix lands and its tasks close; the first red prefix names the culprit, handed back with the run's
  last lines.
- Refused (3), error (4), other, a timeout, or not-run: nobody is blamed and the branches stay queued. A refusal is retried
  (`STUDIO_UNITY_TRAIN_RETRIES`, 2, every `STUDIO_UNITY_TRAIN_RETRY_MIN`, 10); after that, run the train again later.
- One Unity train at a time (`.studio/locks/unity-train.lock`; a dead holder's lock is taken over); every land run takes
  `machine:heavy` as a landing.

**The land-command contract for a train** (`studio/game.json` `engines.unity`, protected: the owner sets it):

```json
{ "engines": { "unity": {
  "land": "<land script> {branch}",
  "landMany": "<land script> {branches}",
  "target": "<the branch the land script lands on>",
  "gateWorktree": "<the land script's own worktree>",
  "cwd": "<folder>", "timeoutMin": 120
} } }
```

- `target` is required: the harness checks each branch against it, and after a pass that it contains them. `{target}` puts
  it on the command line.
- A command landing a list gets `{branches}` (names in order, space separated): merged onto the target in that order, gates
  run once on the result, committed on green, exit 0/1/2/3/4 as before. Put it in `landMany`, or use `{branches}` in `land`.
- A command landing one `{branch}`: the harness builds an integration branch `unity-train/<id>` (target plus each branch in
  order, merge commits made from refs and objects only), hands that name to the command, and deletes it after. The harness
  never checks out, merges or resets anything in the Unity repo; only the land script works in its gate worktree.
  `gateWorktree` (else the Unity folder, else `cwd`) tells the harness where to read refs.
- `{task}` is the train's task IDs, comma-separated. Branch and task names with anything but letters, digits, `.`, `_`, `/`
  and `-` are refused before any command runs (the line goes through a shell).
- The harness never runs Unity itself.

### Editor runs and the machine:heavy lock (2.60.1)

A Unity editor run takes 6-7 GB, so it shares `machine:heavy` with full verifies and browser playtests.

- `node harness/unity.mjs gate` and `build` take the lock themselves (one hold for Edit Mode and Play Mode). If it stays
  busy, or free memory stays under `STUDIO_RAM_FLOOR_GB`, the editor doesn't start and they exit 3 (busy).
- Other editor batch work goes through the wrapper, so it waits its turn and can be stopped with its whole process tree:
  `node harness/heavy.mjs run --label "unity import" -- "<Unity.exe>" -batchmode -quit -projectPath <folder> ...`.
- An editor opened by hand is outside the lock: `node harness/heavy.mjs status` lists it as an implicit holder and game
  checks scale their timeouts, but heavy jobs still start beside it, so close it before a long verify.
  `STUDIO_HEAVY_PROGRAMS` (default `Unity.exe,Unity`) names the programs counted. A background service (Unity Hub's
  `Unity.exe ... serve`) doesn't count: a command line matching `STUDIO_HEAVY_IGNORE_ARGS` (a regex, default the word
  `serve`; `off`: none) is skipped (2.65.3).

### Faster Unity checks (2.67.1)

`node harness/unity.mjs gate <folder>` runs in this order:

1. **Code-only steps, without the lock:** the commands in `studio/game.json` `engines.unity.codeOnly` (one command or a
   list; `{folder}` is the project; each gets `codeOnlyTimeoutMin` minutes, default 20). Unset, the step is
   `dotnet test tools/SimTests` when the project has that folder and .NET is installed. `"codeOnly": []` means none, and
   `STUDIO_UNITY_CODE_ONLY=off` skips them. They never wait for `machine:heavy`; a failure makes the gate red right away
   without waiting for the editor. The file is protected: only the owner sets them.
2. **The editor steps, under one `machine:heavy` hold:** Edit Mode, then Play Mode.
   - **Warm Library.** A copy with no `Library/` gets the cached one before the editor starts, skipping the ~10 min import;
     after a green run (or a passing `build`) the copy's `Library/` becomes the cache. `STUDIO_UNITY_LIBRARY_CACHE`
     (default `<main checkout>/.studio/unity-cache`; `off` turns it off). Key: project, Unity version, branch base
     (`STUDIO_UNITY_LIBRARY_BASE`, else `engines.unity.target`, else `main`) and a hash of `Packages/manifest.json` and
     `packages-lock.json`; a version or package change makes that first run cold. Each project keeps its newest
     `STUDIO_UNITY_LIBRARY_CACHE_KEEP` (2) keys.
   - The cache is **copied, never linked** (the editor rewrites Library files in place; a hard link, junction or symlink
     would leak a lane's changes into the cache or share one live Library). Lock files are not copied. While another run
     copies a key in or out (`<cache>/<key>.lock`) a run neither seeds from nor saves over it: it imports from scratch
     and says so. By hand, and usable by a land script around its own editor steps:
     `node harness/unity-cache.mjs status [<folder>] | seed <folder> | save <folder> | clear [<folder>]`.
   - **Play Mode flake retry.** A Play Mode run whose tests ran and failed gets one retry. A pass on the retry is green: the
     gate prints a WARN naming the tests, appends a record to `.studio/unity-flakes.jsonl` (tests, both results, both logs
     `.studio/gates/out/unity-PlayMode-try1.log` and `-try2.log`) and the day's digest gets a line. Two failures are red.
     Edit Mode, compile errors, a missing results file and licence problems are never retried.

The land gate (`harness/unity-gate.mjs`) is unchanged: the land script merges `{branch}` in its own worktree, so the harness
has no checkout to run code-only steps on; the script can run its own first.

### Unity speed (2.70.0)

Each is a setting. Those resting on Unity behaviour nobody has checked on a real editor are **off by default**, marked
UNVERIFIED.

- **Unity Accelerator** (`STUDIO_UNITY_ACCELERATOR=<host:port>`, default unset: off; the Accelerator's default port is
  10080). Every editor start the harness makes (Edit Mode, Play Mode, `build`) then gets `-EnableCacheServer
  -cacheServerEndpoint <host:port> -cacheServerEnableDownload true -cacheServerEnableUpload true
  -cacheServerNamespacePrefix <the project's Unity version>`. First it tries a TCP connect, waiting up to
  `STUDIO_UNITY_ACCELERATOR_TIMEOUT_MS` (1500); if nothing answers the run goes on without it and says so once, so it never
  fails a gate. The summary line ends `cache server on` or `cache server off`.
  `node harness/unity.mjs accelerator [<folder>]` checks the endpoint and prints the arguments, for other editor batch work
  through `heavy.mjs run` (such as a bake).
- **No duplicate Edit Mode** (`STUDIO_UNITY_EDITMODE_REUSE`, default on; `off` always runs it). The code-only
  `dotnet test tools/SimTests` already compiles and runs `Assets/Tests/EditMode/**/*.cs` (see the template's `.csproj`).
  - *From .NET:* the editor skips Edit Mode when the .NET run passed in this same gate and the `.csproj` compiles every Edit
    Mode test file (a file under an Editor-only test assembly: an asmdef with `UNITY_INCLUDE_TESTS` or a TestRunner
    reference). It needs Play Mode in the same gate; a `--platform EditMode` gate always runs Edit Mode.
  - *From an earlier gate:* a passing editor Edit Mode run is recorded in `.studio/gates/unity-editmode.json` (per checkout:
    git tree, Unity version, editor path). A later gate skips it only on the same clean tree, version and editor, within
    24 h; any uncommitted change, other commit or other editor reruns it (the 2.69 verify-reuse rules).
  - The gate says which reuse it used. Risk: .NET and Unity's runtime could disagree on float maths; keep the sim's maths
    integer, as the template does, or turn the reuse off.
- **One editor start** (`STUDIO_UNITY_ONE_EDITOR=on`, default off, UNVERIFIED). Edit Mode and Play Mode run in one editor
  through `-executeMethod StudioHarnessRunAll.Run`. The harness writes `Assets/StudioHarnessTemp/` (a small `TestRunnerApi`
  script, its asmdef, a `.gitignore` of `*`) and removes it and its `.meta` afterwards, even on failure. Unchecked on a real
  editor: that both modes run in one Execute chain, and that callbacks return after Play Mode's domain reload. If both
  result files aren't written the same gate falls back to two starts, logging to `.studio/gates/out/unity-one-editor.log`.
- **Graphics split** (`STUDIO_UNITY_GRAPHICS_SPLIT`; default on when any test source has `[Category("Graphics")]` outside a
  comment; `off`: all headless). On a platform with Graphics tests, one start runs `-nographics -testCategory "!Graphics"`,
  a second runs `-testCategory Graphics` with a graphics device; results are added. The `machine:heavy` hold claims the GPU
  area: the `unity-visual` (or `unity-graphics`) job kind's VRAM when the budget defines one, else `unity`'s. Tag render,
  HDRP-visual and lightmap tests `Graphics`; the rest stays headless with no VRAM.
- **Landing build options** (`STUDIO_UNITY_LANDING_BUILD=fast`, default off). Builds the harness starts
  (`npm run engine:build`) pass `-studioBuildSpeed fast` to the build method; `--release` never does. The harness never
  edits ProjectSettings: the game's `Assets/Editor/StudioBuild.cs` decides what "fast" means and puts back what it changed.
  The sketch is UNTESTED on an editor: read `Arg("-studioBuildSpeed", "") == "fast"` in `Run()` before `BuildPlayer`; on
  WebGL `PlayerSettings.SetIl2CppCodeGeneration(named, Il2CppCodeGeneration.OptimizeSize)`, else
  `SetScriptingBackend(named, ScriptingImplementation.Mono2x)`; restore both settings in a `finally`. Release builds stay as
  the owner sets them.
- **Code optimization** (`STUDIO_UNITY_CODE_OPT=release`, default unset). The build method gets
  `-studioCodeOptimization release`. **TODO:** no documented editor command-line flag for release code optimization was
  found, so the harness adds no editor flag; check Unity's command-line reference for 6000.x before adding one. Until then
  a build script can apply it itself (for example `UnityEditor.Compilation.CompilationPipeline.codeOptimization`, also
  unverified here).
- **Faster Library copy** (`STUDIO_UNITY_CACHE_COPY=parallel|serial`, default parallel). A child process copies up to
  `STUDIO_UNITY_CACHE_COPY_JOBS` files at once (default twice the cores, 4 to 16). Copies are real (`copyFile`, timestamps
  kept, lock files skipped, never hard-linked; a ReFS Dev Drive clones the blocks). The cache line measures the copy, e.g.
  `in 7 s (parallel copy, 16 at a time, 30123 file(s), 830 MB)`. If the parallel copy fails it copies serially and says why.

### An editor run has to prove it ran (2.72.0)

A green results file is not enough. The gate counts a run (Edit Mode, Play Mode, the one-editor start, the Graphics split's
two starts, and the Godot unit gate) only when all hold (`harness/engine-proof.mjs`):

- **Fresh results:** the editor writes `TestResults-<platform>-<nonce>.xml` (this run's nonce), older results files are
  removed first, and the file must be newer than the run's start.
- **Tests ran:** more than 0 test cases, unless `studio/game.json` `engines.unity.allowEmpty` is `true` or lists the
  platform (`["PlayMode"]`) (the owner's file). Godot: `"allowEmpty": true` in `studio/godot-unit.json`.
- **A clean log:** no `error CS…`, licence problem or `Aborting batchmode` line, even with a results file.
- **One story:** the exit code agrees with the results. A non-zero exit, kill or timeout behind all-passed results is not a
  pass; for gdUnit4 neither is exit 0 with a failing test in the report.

Each failure prints `[engine-gate] FAIL <kind> (unity|godot): …` and `[engine-gate] Fix: …` (`harness/gate-fix.mjs`
`ENGINE_FIXES`). Kinds: `stale-results`, `no-results`, `empty-run`, `compile-error`, `licence`, `aborted`, `exit-mismatch`,
`test-failed`. The Godot gate counts only a `reports/report_*` folder that did not exist before the run; one merely touched
is `stale-results`.

### Enough free memory first, and "not run" is not red (2.73.2)

An editor start beside a web verify's test workers ran out of memory twice and was recorded as FAIL. Now:

- **A free-RAM floor.** Every editor run the harness starts (`unity.mjs gate` and `build`, the land gate, the Unity train,
  `heavy run --kind unity`) takes `machine:heavy` as a Unity job and waits until free RAM is at least
  `STUDIO_UNITY_MIN_FREE_GB` (default 12; `0`: no floor; never above 60% of the RAM, so 16 GB waits for 9.6). Free RAM is
  the live figure (on Windows the lower of available memory and commit headroom). It waits up to `STUDIO_HEAVY_WAIT_MIN`,
  then the run is **not run** (`ram-floor`) and the editor never starts.
- **An infrastructure abort is NOT RUN, not FAIL:** out of memory, the editor ended from outside, a licence or launch
  failure, `Aborting batchmode` before any results file, a floor wait timed out. The gate prints
  `[engine-gate] NOT RUN <kind> (unity): …` with a Fix line and exits 3. Kinds: `out-of-memory`, `editor-killed`,
  `launch-failed`, `licence`, `aborted`, `ram-floor`, `busy`. The land gate records `not-run` ("not run: <why>") in
  `.studio/gates/unity-last.json`, the `engine.land` event (warn) and `studio/engine/LOG.md`; the train retries it like a
  refusal, then leaves the branch queued, blaming nobody; `task done` says "run task done again later"; a verify gate
  showing `NOT RUN <id>: not run: <why>` is still not a pass.
- **A real failure is still FAIL:** a compile error or failing test in the log or results keeps a run red, even beside an
  out-of-memory or `Aborting batchmode` line. With a results file, `Aborting batchmode` stays `FAIL aborted`.
- A land script can name its own not-run exit: `"exits": { "5": { "status": "not-run", "why": "…" } }`.

**A studio's own landing script.** The harness doesn't run a script you start yourself, so call it before Unity starts.
`heavy run` is better (the slot is let go when the command ends):

```powershell
# tools/land/land-unity.ps1. The Unity call is in its own script: `heavy run` joins its command into one shell line.
node harness/heavy.mjs run --kind unity --min-free-gb 12 --timeout-min 30 --label "unity land" -- powershell -NoProfile -File tools/land/run-unity-tests.ps1
if ($LASTEXITCODE -eq 3) { Write-Host "NOT RUN: not enough free memory, or machine:heavy stayed busy"; exit 3 }  # no FAIL record
```

Or hold the slot yourself: `node harness/heavy.mjs wait --min-free-gb 12 --timeout-min 30 --hold "unity land"` (exit 0:
held; 3: NOT RUN, so `exit 3`), run Unity in a `try`, and `node harness/heavy.mjs release --label "unity land"` in the
`finally`.

`npm run heavy -- …` is the same command. `heavy wait` without `--hold` only checks (exit 0 when the floor holds and a slot is
free). A `--hold` ends itself after `--hold-max-min` (120). When Unity's own run aborts, say "not run" in the script, never
FAIL: exit 3, or a code your `exits` maps to `not-run`.

## Unity passes as board tasks (2.77.0)

Don't hand-roll a gate script that runs Unity once per branch. Each Unity pass is a board task and the Unity train is its
normal landing path; the full pattern for any engine is in [ENGINE-TRACKS.md](ENGINE-TRACKS.md).

```bash
npm run task -- add "Pass 11: …" --role engine-porter --track engine:unity --branch unity/pass-11 --scope "…" [--visual-check --refs <photos>]
npm run task -- done T-031 --agent porter-a --train   # checks the pass in the Unity repo (commits the target lacks, all committed, the visual check), queues it
npm run task -- train --unity [--max 4]               # ONE land run for the queue (bisects a red one); `train status` shows it
```

A launched porter gets `.lanes/engine/<T-ID>`, a worktree of the Unity repo. The Line Producer starts
`task train --engine unity` in a quiet window ([ENGINE-TRACKS.md](ENGINE-TRACKS.md)); the land run is a `machine:heavy`
`unity` job (8 GB, 4 threads) whose median length becomes the expected minutes (30 until recorded). Your own land script goes
in `engines.unity.land` / `landMany` (`{flags}` = the lane's tuned batch flags); keep its RAM floor in
`STUDIO_UNITY_MIN_FREE_GB` or the lane's tuned `ram-floor`; a nested `heavy` call joins the train's hold.

Self-tuning: `npm run engine -- tune unity <quality-level|volume|lod-bias|batch-flags|ram-floor> <value> --by <you> --why "…"`
(logged in the decisions log).

## Rules first, and Edit Mode once (2.82)

Most land failures were in the .NET rule tests, and a passing run spent over half its time re-running them in Edit Mode.
The Unity train now runs the rules check (`dotnet test tools/SimTests` by default, or `engines.unity.rules`) on the batch
before the land run and hands back the lane that breaks it ([NATIVE-ENGINE.md](NATIVE-ENGINE.md)). A land script gets
`STUDIO_UNITY_EDITMODE_ARGS` (the Edit Mode assemblies the editor still has to run after the .NET tests passed),
`STUDIO_RULES_GREEN=1` (the rules ran green on exactly this batch) and `STUDIO_LAND_RESULT` (where to write what each stage
took). Keep the rules' maths in plain C# with no engine types: compiled tests take seconds, rules run through an interpreter
inside .NET take minutes, and every land run pays twice.

## A warm editor and an editor service (2.84, untested on a real editor)

Off by default: a land run may reuse one open editor, and agents may queue a compile and capture of their branch
(`npm run editor -- check`). See docs/NATIVE-ENGINE.md "The editor service".

## Settings and licence

In `.env`:

```bash
STUDIO_UNITY=C:\Program Files\Unity\Hub\Editor\6000.3.26f1\Editor\Unity.exe   # the editor
STUDIO_UNITY_PIN=6000.3      # the editor line the project stays on: an upgrade rewrites project files, so it's a decision
STUDIO_DOTNET=dotnet         # the .NET 8 SDK, if it isn't on the PATH
STUDIO_UNITY_MIN_FREE_GB=12  # free RAM a Unity run waits for (never above 60% of the RAM; 0: no floor)
```

- **On your PC:** install Unity Hub and Unity 6000.3 LTS and sign in. A Personal licence is free under Unity's revenue
  limit; check the current terms.
- **In CI:** add three repository secrets: `UNITY_LICENSE` (the contents of your `Unity_lic.ulf`), `UNITY_EMAIL` and
  `UNITY_PASSWORD`. The engine-unity-editor job then runs the template's Edit Mode and Play Mode tests with GameCI; until
  they exist it prints a notice and passes. Never paste the licence file or the password into a chat, an issue or a commit.
