# The Unity template for the engine track (`engine/_unity/`)

A worked Unity 6 port of the template game (`cartridges/example-sim`), copied into `engine/<game>/` when a
person says yes to a Unity engine track (`npm run engine -- propose unity`, docs/UNITY-TRACK.md). The rules
live in a pure C# assembly, so agents test them and compare them with the web game **without the editor or a
licence**; the editor is needed for the game itself and its Play Mode tests.

| File | What it is |
| --- | --- |
| `Assets/Sim/Sim.cs`, `Sim.asmdef` | The sim, ported 1:1: Mulberry32 bit for bit in `uint` maths, JavaScript's `Math.round` as `JsRound`, one `Step` per tick, the start-to-win policy. `noEngineReferences: true`: the compiler refuses UnityEngine here. |
| `Assets/Tests/EditMode/SimTests.cs` | The sim's checks (NUnit). Unity runs them in Edit Mode; `tools/SimTests` runs the same file with .NET. |
| `Assets/Game/GameDriver.cs` | The playable build: `FixedUpdate` steps the sim at 20 ticks a second; B and a Buy button (Input System, uGUI) ask the sim to buy a unit. The scene is built in code: no scene or prefab YAML. |
| `Assets/Tests/PlayMode/ControlsTests.cs` | Every Game Bible control pressed through the Input System (`InputTestFixture`): a real key, a real mouse click on the button. Results go to `$STUDIO_CONTROLS_OUT` for the controls check (track `unity`). |
| `Assets/Editor/StudioBuild.cs` | `npm run engine:build`: a playable WebGL build (the Arcade's engine tab, any browser) or a Windows `.exe`. |
| `Assets/Editor/Parity.cs` | Parity from inside the editor (`-executeMethod Parity.Run -seeds 1,2,3`). |
| `tools/SimTests/` | `npm run engine:sim`: the purity check, then `dotnet test` on the sim and its Edit Mode tests (C# 9, Unity 6's language version). |
| `tools/SimCli/` | `npm run parity`'s command: `dotnet run --project tools/SimCli -- parity 1,2,3,4,5`. |

Checked so far: the .NET side (purity, 7 sim tests, parity on seeds 1 to 5 and 1337, planted engine code and a
planted rule break both caught). The editor side (`GameDriver`, the controls test, `Parity.cs`) is checked by
CI's engine-unity-editor job once the licence secrets exist, and by `npm run engine:gate` on a machine with
Unity: until one of those runs, treat it as unproven.

First open: Unity Hub → Add → this folder, with Unity 6000.3 LTS. Unity writes its `.meta` files and fills in
`ProjectSettings/`; commit them (they hold the GUIDs). Point the harness at the editor with
`STUDIO_UNITY=<path to Unity.exe>` in `.env`, and pin the version with `STUDIO_UNITY_PIN=6000.3`.
