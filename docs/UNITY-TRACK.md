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
```

The template is a worked port of the template game, proven on .NET. Purity is clean and its 7 tests pass. Parity
matches the web game on seeds 1 to 5 and 1337, and a planted `UnityEngine.Random` or a free purchase is
caught (`scripts/check-unity-template.mjs`, CI job engine-unity-sim). The editor side is proven by CI's
engine-unity-editor job once the licence secrets exist (below).

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
