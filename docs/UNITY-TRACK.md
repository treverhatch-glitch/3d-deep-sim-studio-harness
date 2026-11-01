# The Unity track (2.46.0)

How the studio builds a game in Unity without its agents drifting: the rules in a pure C# assembly that
anything can test, the editor for what only the editor can check, and real input for every control.

## The shape of a Unity game here

| Part | Where | Checked by | Needs the editor? |
| --- | --- | --- | --- |
| The rules (the sim) | `Assets/Sim/`, its own assembly with `noEngineReferences: true` | `npm run engine:sim`: the purity check, then its tests with .NET | No |
| Parity with the web game | `tools/SimCli` (same source as the build) | `npm run parity` | No |
| The game (input, drawing, UI) | `Assets/Game/`, `GameDriver` steps the sim in `FixedUpdate` | `npm run engine:gate`: Edit Mode and Play Mode tests in batch mode | Yes, plus a licence |
| Every control | `Assets/Tests/PlayMode/ControlsTests.cs` | the gate writes `qa/reports/controls-unity.json`; the controls check reads it (Bible `tracks` includes `unity`) | Yes |

**Why it's split this way.** The editor needs an install and an active licence on every machine that runs
it, and it starts slowly. If every change waited for it, agents would skip it. The sim needs neither, so
every lane runs it in seconds, and the purity check keeps it portable. No `UnityEngine`, no `Time`, no
`UnityEngine.Random` or unseeded `System.Random`, no wall clock, threads, files or network. The asmdef's
`noEngineReferences` makes the compiler refuse engine code there too.

**Scenes are built in code.** Scene and prefab files are YAML full of GUIDs that agents break and can't
review. The template has none: `GameDriver` builds the camera, light, HUD and Buy button at start. Use
prefabs for art an artist makes in the editor, and keep the wiring in code.

## Start a Unity track

```bash
npm run engine -- propose unity --by <producer> --why "…"   # a question for the game dev
# the game dev answers yes: engine/<game>/ is copied from engine/_unity/
npm run engine:sim        # the sim: purity and tests with .NET (no editor)
npm run parity            # the C# sim against the web game, seed by seed (no editor)
npm run engine:gate       # the editor: Edit Mode and Play Mode tests, the controls test
npm run engine:build      # the playable Windows .exe (--target web for WebGL)
```

The template is a worked port of the template game, proven on .NET. Purity is clean and its 7 tests pass. Parity
matches the web game on seeds 1 to 5 and 1337, and a planted `UnityEngine.Random` or a free purchase is
caught (`scripts/check-unity-template.mjs`, CI job engine-unity-sim). The editor side is proven by CI's
engine-unity-editor job once the licence secrets exist (below).

## A port in its own repo (2.47.0)

When the port lives in its own repo (Hatchfield: the web game is adopted into the studio, and the Unity
project is a separate public repo cloned beside it), link it instead of starting from the template:

```bash
npm run engine -- link unity ../my-unity-port --build windows --web "<web runs command> {seeds}" --source game/<slug>/src/game
```

- It records `engine/<game>/engine.json`: the port's folder, its remote and commit, the gate, the parity
  commands and the build target. Nothing is copied into the port's repo; porters work in it on its own
  branches.
- `--build windows` makes the Windows `.exe` the default (`npm run engine:build`) and turns the browser
  export off; the Arcade lists native builds only.
- `--web` is the web side of parity for a game that isn't a cartridge: a command that prints one JSON line per
  seed, like the port's (`{"seed":1,"outcome":"won","tick":300,"cash":…}`). Both are compared field by field.
- `--source` names the web folders whose changes count as drift (`npm run engine -- drift`).

## The web side of parity for a Vite game (2.50.0)

A Vite game (three.js, React) can't run its code in plain Node: Vite-only features such as `import.meta.glob` need
Vite. Its test runner, Vitest, has them, so the web side of parity is a Vitest run that prints one JSON line per
seed. The harness passes the seeds in `STUDIO_PARITY_SEEDS` (and in `{seeds}`), so the same command works in
Windows' shell and in bash:

```bash
npm run engine -- link unity ../my-unity-port --build windows \
  --web "cd game/<slug> && npx vitest run tests/sim/replay.test.ts --silent=false"
```

In the game, the test prints the lines when the variable is set, for example
`const seeds = process.env.STUDIO_PARITY_SEEDS` → for each seed
`console.log(JSON.stringify({ seed, outcome, tick, cash, pax, flights }))`. Vitest's own output lines are
ignored; only lines that parse as JSON with a `seed` count. Hatchfield's `tests/sim/replay.test.ts` does
this.

## Windows by default (2.48.0)

A Unity track builds a Windows `.exe` by default (`npm run engine:build`, CI's engine-unity-build), with no
browser export: the web version is the browser game, and the Arcade lists the Unity build as native.
`--target web` (or `npm run engine -- link unity <repo> --build web`) makes a WebGL build when a game wants one.

## Render pipeline: URP or HDRP

The template uses no particular pipeline. **Hatchfield uses HDRP at maximum quality** (decided 2026-10-31): a
Windows game, so HDRP's lack of a browser build doesn't matter. Its Unity repo has a one-click set-up
(`Assets/Editor/HdrpSetup.cs`, menu Hatchfield > Switch to HDRP). Know before choosing: Unity's 2026 plan puts
new lighting work into URP, and HDRP gets stability fixes but no new features. HDRP's first build compiles
thousands of shaders, so expect 30–60 minutes on CI. Ray tracing needs DirectX 12 and an RTX-class card. To
switch a project by hand:

1. In Unity, Package Manager → install **High Definition RP** (the same 17.x line as URP).
2. **Window → Rendering → HDRP Wizard → Fix All**: it creates the HDRP asset and global settings and makes
   them active.
3. **Edit → Rendering → Materials → Convert All Built-in/URP Materials to HDRP** (the Render Pipeline
   Converter), then check every scene's lighting: HDRP uses physical light units.
4. Assign the HDRP asset to every Quality level; set the ray tracing level only if every target PC has an
   RTX-class card (DirectX 12).
5. Builds: Windows only; the first build compiles many more shaders (expect 30–60 minutes on CI).
6. The sim (`Assets/Sim`) doesn't change: it never touches rendering.

## Adopt an existing Unity game

`npm run onboard -- --path ../my-unity-game --name "…" --adopt` declares its checks in
`game/<slug>/studio.gates.json`:

- `sim-purity` and `sim` (required) when it has `Assets/Sim` and `tools/SimTests`.
- `unity-editmode` and `unity-playmode` (optional), the editor's tests. Make them required once every machine
  that runs checks has the editor.

A Unity game with no pure sim gets a warning. Moving its rules into `Assets/Sim` is the first port task:
until then nothing outside the editor can test them, and nothing stops engine time or randomness from
leaking in.

## Porting a web game to Unity (the Hatchfield path)

1. **Make the web sim repeatable first.** Replace every `Math.random` and `Date.now` in the sim with a
   seeded RNG and the tick, and record goldens. Without that, there's nothing to compare the port with.
2. **Port one module at a time into `Assets/Sim`**, the same way the template ports the example game: `uint`
   for 32-bit maths, `JsRound` for `Math.round`, one `Step` per tick, state as plain data.
3. **Parity per module.** `npm run parity` compares outcome, tick and any listed field (`engine.json`
   `parity.compare`). Add fields as modules land (cash, passengers served, queue lengths), so a module
   counts as ported only when it matches.
4. **Art.** `.glb` models import with glTFast (`com.unity.cloud.gltfast`); the art department's approvals
   and licence checks (docs/ART-PIPELINE.md) apply unchanged.
5. **Controls.** The Game Bible's controls list gets `unity` in its tracks; each control gets a Play Mode
   test that presses it through the Input System and checks the sim value it must change.

## Playing it while it's built

- **In the editor:** open `engine/<game>` in Unity Hub and press Play. The game boots itself in any scene.
- **A Windows build** (the default): `npm run engine:build` makes `Build/Windows/Game.exe`.
- **In a browser** (only if the game wants it): `npm run engine:build -- --target web` makes `Build/WebGL`,
  compressed with the browser-side fallback so any static host can serve it.
- **From CI:** once the licence secrets exist, every push to main builds the Windows game and attaches it to the
  run as the `unity-windows` artifact.

The web build stays playable the whole time. Once the Unity build catches up, it's the one to play.

## Web and Unity at the same time

The web game can keep growing while it's ported. Both land side by side:

- **Separate folders, separate lanes.** Web work lands in its own folder (`cartridges/<game>` or
  `game/<slug>`), Unity work in `engine/<game>`. Each lane runs only its own checks, so they never conflict
  and never wait for each other.
- **Web lanes never wait for Unity.** The engine gate and parity are optional checks: a web change the port
  hasn't caught up with doesn't fail a web lane.
- **The port follows a pin.** `npm run engine -- port --from <sha>` pins the web rules the port matches (an
  adopted game names its rule folders once: `--source game/hatchfield/src/game`). Parity compares the
  Unity sim with that pin, not the live web rules, so porters aren't failed by web work still in flight.
- **The lag is work, not a failure.** `npm run engine -- drift` lists the web commits since the pin.
  `--queue` adds one port task per commit to the porters' lane. Each task ends by moving the pin forward, and
  the five-line status shows "Unity port N web change(s) behind".

**When to stop growing the web version.** Keep both while the web build is where you find the fun: a new
mechanic is quickest to try in the browser, and parity turns it into a precise port task. Freeze new web
features once the Unity port is caught up (drift at 0) and the Unity build is the one people play. From then
on the web build gets fixes only, or becomes a lightweight demo. The cost of running both is the port lag: if
drift keeps growing week on week, the porters can't keep up, and it's time to move feature work to Unity.

## Landing Unity work: the Unity gate (2.59.0)

The Unity repo keeps its own landing script (its tests in batch mode, a build, a merge into its main branch).
The harness only runs it: set the command once in `studio/game.json` (a protected file, so only the owner
changes it and a branch can't swap it for one that always passes):

```json
{ "engines": { "unity": { "land": "<the Unity repo's land command> {branch}", "cwd": "<folder>", "timeoutMin": 120 } } }
```

`{branch}` is `--branch`, else the task's Unity branch: `task add "<title>" --track engine:unity --branch <b>`, or
later `node harness/unity-gate.mjs branch <ID> <b>`. With neither the gate refuses and says how to set it; it never
uses the Unity folder's checked-out branch (2.60.1: that was main, which would land main into itself). `{task}` is
the task ID; `{folder}` is `"folder"` in the same settings (relative to the studio, or absolute) when set, else the
Unity track's folder; a folder that doesn't exist is an error. It runs in `cwd` (relative to the studio), else that
folder.

If the land script has its own exit codes, write them down with it, so the harness never guesses what a code means:

```json
{ "engines": { "unity": { "land": "node \"{folder}/tools/land.mjs\" {branch}", "folder": "../my-game-unity",
  "exits": { "1": { "status": "red", "why": "a test or the build failed" },
             "3": { "status": "error", "why": "bad branch: no such branch in the Unity repo" } } } } }
```

`status` is pass, red, conflict, refused (busy: try again later) or error. With `exits` set, a code it doesn't list
is an error naming the code; without it the contract below applies. The output's last lines come with every
result that isn't a pass.

- `node harness/unity-gate.mjs [--task T-012] [--branch <name>] [--json]` runs it under the `machine:heavy`
  lock (a Unity editor run never overlaps a full verify or a browser playtest; it waits, naming the holder).
- The exit code decides (the default contract, when `exits` isn't set): 0 pass (landed), 1 red, 2 conflict,
  3 refused (busy: not a failure of the work), 4 error;
  anything else, a signal or a timeout (`timeoutMin`, `STUDIO_UNITY_GATE_TIMEOUT_MIN`, 120) is an error.
- `task done` runs it for a task added with `--track engine:unity`, after the task's other checks; the task closes
  only on a pass, and a refusal leaves it in progress ("run task done again later"). `STUDIO_DONE_UNITY_GATE=skip`
  turns that off. With no land command it is skipped with a note.
- Each run is kept: `.studio/gates/unity-last.json`, its output in `.studio/gates/out/unity.log`, an `engine.land`
  event and a line in `studio/engine/LOG.md`.
- It is not part of `npm run verify`: a verify checks, it never lands work.

## The Unity merge train (2.63.0)

When several porters finish together, landing each branch alone means one Unity build after another. The Unity
train lands them on ONE run of the land command, one train at a time, always under `machine:heavy`:

- `npm run task -- done <ID> --train [--branch <name>]` on a task added with `--track engine:unity` runs every check
  `task done` runs before the Unity gate, then queues the task's Unity branch (`--branch`, else the Unity folder's
  current branch) in `.studio/train/unity-queue.json`. The task stays in progress.
- `npm run task -- train --unity [--max N] [--dry-run]` lands the queue, oldest first. `npm run task -- train status`
  shows how many Unity branches wait and the Unity train running now (`node harness/unity-train.mjs status --json`).
- Conflicts are found first from refs only (`git merge-tree`, no files touched): a branch that conflicts with the
  target is handed back; one that conflicts only with a branch before it waits for the next train.
- Pass: the target must then contain every branch (else nothing closes), and every task closes.
- Red (1) or conflict (2): prefix bisection, like the web train. The land command runs again on the target + the
  first half, and so on (about log2 N more runs). A green prefix run lands that prefix, since it's the land command,
  so those tasks close. The first red prefix names the culprit, which is handed back with the run's last lines.
- Refused (3) or error (4, other, a timeout): nobody is blamed and the branches stay queued. A refusal is tried
  again (`STUDIO_UNITY_TRAIN_RETRIES`, 2, every `STUDIO_UNITY_TRAIN_RETRY_MIN`, 10 min). After that, run the train again later.
- One Unity train at a time (`.studio/locks/unity-train.lock`; a dead holder's lock is taken over); every land run
  takes `machine:heavy` as a landing, so a Unity build never overlaps a full verify or another Unity build.

**The land-command contract for a train** (in `studio/game.json` `engines.unity`, protected: the owner sets it):

```json
{ "engines": { "unity": {
  "land": "<land script> {branch}",
  "landMany": "<land script> {branches}",
  "target": "<the branch the land script lands on>",
  "gateWorktree": "<the land script's own worktree>",
  "cwd": "<folder>", "timeoutMin": 120
} } }
```

- `target` is required for the train. The harness checks each branch against it and, after a pass, checks that it
  contains them. `{target}` puts it on the command line.
- A command that lands a list gets `{branches}`: the branch names in order, separated by spaces. Each one is
  merged onto the target in that order, the gates run once on the result, the result is committed on green, and the
  command exits 0/1/2/3/4 as before. Put it in `landMany`, or use `{branches}` in `land` itself.
- A command that lands one `{branch}` only: the harness builds an integration branch, `unity-train/<id>` (the target
  plus each branch in order, as merge commits made from refs and objects only), and hands that one name to the land
  command. The harness never checks out, merges or resets anything in the Unity repo. Only the land script works in
  its gate worktree; `gateWorktree` (else the Unity folder, else `cwd`) tells the harness where to read the repo's
  refs. The integration branch is deleted after the run.
- `{task}` is the train's task IDs, comma-separated. Branch and task names other than letters, digits, `.`, `_`, `/`
  and `-` are refused before any command runs, because the command line goes through a shell.
- The harness never runs Unity itself.

### Editor runs and the machine:heavy lock (2.60.1)

A Unity editor run takes 6-7 GB, so it shares the `machine:heavy` lock with full verifies and browser playtests:

- `node harness/unity.mjs gate` and `build` take the lock themselves (one hold for Edit Mode and Play Mode). When
  it stays busy, or free memory stays under `STUDIO_RAM_FLOOR_GB`, the editor doesn't start and they exit 3 (busy).
- Any other editor batch work a Unity lane runs goes through the wrapper, so it waits its turn and can be stopped
  with its whole process tree: `node harness/heavy.mjs run --label "unity import" -- "<Unity.exe>" -batchmode -quit -projectPath <folder> ...`.
- An editor someone opened by hand is outside the lock. `node harness/heavy.mjs status` lists it as an implicit
  holder and game checks scale their timeouts for it; heavy jobs still start beside it, so close it before a long
  verify. `STUDIO_HEAVY_PROGRAMS` (default `Unity.exe,Unity`) names the programs counted this way.
  A background service of one (Unity Hub's `Unity.exe ... serve`, alive for days) doesn't count: a command line
  matching `STUDIO_HEAVY_IGNORE_ARGS` (a regex, default the word `serve`; `off`: none) is skipped (2.65.3, B-44).

## Settings

In `.env`:

```bash
STUDIO_UNITY=C:\Program Files\Unity\Hub\Editor\6000.3.26f1\Editor\Unity.exe   # the editor
STUDIO_UNITY_PIN=6000.3      # the editor line the project stays on: an upgrade rewrites project files, so it's a decision
STUDIO_DOTNET=dotnet         # the .NET 8 SDK, if it isn't on the PATH
```

## Licence and CI

- **On your PC:** install Unity Hub and Unity 6000.3 LTS, and sign in. A Personal licence is free under
  Unity's revenue limit; check the current terms.
- **In CI:** add three repository secrets: `UNITY_LICENSE` (the contents of your `Unity_lic.ulf`),
  `UNITY_EMAIL` and `UNITY_PASSWORD`. The engine-unity-editor job then runs the template's Edit Mode and
  Play Mode tests with GameCI. Until they exist it prints a notice and passes. Never paste the licence file
  or the password into a chat, an issue or a commit.
