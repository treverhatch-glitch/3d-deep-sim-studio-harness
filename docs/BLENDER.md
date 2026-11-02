# Blender Headless Asset Generation & `blender-orchestrator` MCP (`docs/BLENDER.md`)

Default pattern for generating and orchestrating 3D assets without opening the Blender GUI or polluting the simulation layer (`src/sim/`).

We base the 3D asset / agent pipeline on two complementary layers:
1. **Headless Blender `bpy` scripts** (`blender --background --python ...`) for deterministic procedural low-poly/mid-poly meshes and `.glb` export.
2. **`blender-orchestrator`** (`https://github.com/mlolson/blender-orchestrator`) as the MCP bridge that lets coding agents control a live or headless Blender instance and optionally call external AI 3D mesh generators (Meshy, Replicate, Tripo3D, Rodin) with post-processing/decimation inside Blender.

---

## 1. Headless `bpy` Generation Pattern (Default, $0 Cost)

Agents write Python scripts that use Blender’s built-in `bpy` module and run them headlessly:

```bash
blender --background --python tools/blender/generate_glb.py -- --preset crate --out public/assets/CargoCrate.glb
```

### Typical Flow
1. Agent writes a `bpy` script that builds low-poly (or mid-poly) geometry, assigns PBR materials (`Principled BSDF`), applies transforms, and exports `.glb`.
2. Run headlessly (`blender -b --factory-startup -P ...`).
3. Drop the `.glb` into the game’s asset folder (`public/assets/`).
4. The presentation layer (Three.js) loads the `.glb` (using `InstancedMesh` for repeated props). **The simulation layer (`src/sim/`) never imports Blender or Three.js.**

### Example Skeleton (`CargoCrate.glb`)

```python
import bpy

# Clear scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Create a simple low-poly object
bpy.ops.mesh.primitive_cube_add(size=2)
obj = bpy.context.active_object
obj.name = "CargoCrate"

# Assign PBR material
mat = bpy.data.materials.new(name="CargoCrateMat")
mat.use_nodes = True
bsdf = mat.node_tree.nodes.get("Principled BSDF")
if bsdf:
    bsdf.inputs["Base Color"].default_value = (0.22, 0.58, 0.85, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.55
obj.data.materials.append(mat)

# Export optimized binary glTF (.glb)
bpy.ops.export_scene.gltf(
    filepath="//CargoCrate.glb",
    export_format='GLB',
    export_apply=True,
    export_yup=True,
)
```

See the full parameterized script in [`tools/blender/generate_glb.py`](../tools/blender/generate_glb.py).

---

## 2. Agent-to-Blender MCP Bridge: `mlolson/blender-orchestrator`

Upstream: **https://github.com/mlolson/blender-orchestrator**

When a task requires interactive scene inspection, multi-part rigging, UV unwrapping, decimation, or calling AI 3D mesh generators from an agent, wire `blender-orchestrator` as an MCP tool (pre-configured in [`.mcp.json`](../.mcp.json)):

```json
{
  "mcpServers": {
    "blender-orchestrator": {
      "command": "npx",
      "args": ["-y", "github:mlolson/blender-orchestrator"]
    }
  }
}
```

### What `blender-orchestrator` Gives Agents
- **Direct Scene & Object Control**: Create/modify meshes, modifiers, armatures, lights, cameras, and materials in Blender via structured MCP tool calls.
- **Render Preview Loop**: Render viewport frames to disk so a vision-capable QA/Reviewer agent (`vertex-gemini-flash`) can inspect proportions and materials before exporting `.glb`.
- **Optional External AI Mesh Generators**: Can pull raw high-poly meshes from optional text/image-to-3D APIs (`MESHY_API_KEY`, `REPLICATE_API_TOKEN`) into Blender, run automatic **Decimate / Remesh / Bake** passes via `bpy` to meet your draw-call and triangle budgets, and export game-ready `.glb` files.

---

## 3. Rules & Boundaries
- Keep asset scripts in `tools/blender/` or `assets/blender/`.
- All Blender and `.glb` logic stays strictly on the **presentation** side of [`studio/rules/graphics-sim-boundary.md`](../studio/rules/graphics-sim-boundary.md).

---

## 4. Asset track (2.67.1)

Asset work runs as its own track: `npm run task -- add "<asset>" --role asset-3d --track asset`. The role's brief
template (what, where it's used, real-world size in metres, triangle budget per LOD, texture budget, style refs,
licence) is [`studio/templates/asset-brief.md`](../studio/templates/asset-brief.md) (a stable path: anything that queues
a make task copies it); the role is [`studio/roles/asset-3d.md`](../studio/roles/asset-3d.md). Blender runs headless only
(`blender -b --factory-startup -P <script>`).

**The asset gate** (`harness/asset-gate.mjs`) runs at `task done` for a task on `--track asset`, and for any task whose
change adds or changes files under the game's declared asset paths. Its limits come from `studio/game.json`
(protected: the owner's), with defaults:

```json
"assets": {
  "paths": ["assets", "public/assets"],
  "manifest": "studio/assets/manifest.json",
  "triangleBudget": { "lod0": 2500, "lod1": 1200, "lod2": 500 },
  "textureMaxPx": 2048,
  "previewRequired": true,
  "sizeTolerance": 0.15,
  "sizeRequired": false,
  "brandNames": [],
  "licences": { "allow": ["own work", "CC0", "MIT", "CC-BY", "..."], "ask": ["SA", "GPL"], "block": ["NC", "ND"] },
  "roundTrip": { "command": "blender -b --factory-startup -P tools/roundtrip.py -- {file}", "timeoutMin": 20 }
}
```

| Check | Fails when |
|---|---|
| licence | a new asset file has no row in the manifest (`npm run asset -- add`), or its licence is blocked (NC, ND) or not on the allow list; an AI-made row has no recorded terms |
| licence-ask | a share-alike licence has no game dev's yes (tier C): `node harness/asset-gate.mjs allow <file> --by <person> --permission "<their words>"` (never a worker) |
| credit | CC-BY (or a row marked credit required) without a credit line |
| triangles | a LOD (mesh or node named `<name>_LOD<n>`, else LOD 0) is over its budget; counted from the glTF JSON (indices / 3) |
| texture | a PNG/JPEG (loose or inside a .glb) is bigger than `textureMaxPx` |
| scale | the model's bounding box (LOD 0 meshes' POSITION min/max through their nodes' transforms, metres; Y-up: w = x, h = y, d = z) is outside the stated size ± `sizeTolerance`; the size is `"size": { "w", "d", "h" }` in its manifest row or in `<name>.asset.json` next to it (none: a note, or a failure with `sizeRequired`). A game's own engine-side model check can run as the round-trip command |
| preview | a model has no `<name>.preview.png` (or `_preview`, `.jpg`, `.webp`) next to it |
| roundtrip | the configured command exits non-zero (it runs under the machine:heavy lock; `{file}` runs it per model). No command, or the program isn't installed: skipped with a note |
| brand | a configured brand name is in a file name, a glTF node/mesh/material/texture/image name, or the manifest row |

Every failure prints a `Fix:` line (`harness/gate-fix.mjs` ASSET_FIXES) and goes into the task's next hand-back facts.
AI-made files are listed for the Steam AI disclosure (pre-generated content). `task done --check` runs every check
but the round trip.

**Hand-off.** When an asset task lands (task done or the merge train), the harness queues one "Wire in <asset>" task
naming the files, `--after` the asset task: on the Unity track (`--track engine:unity`, an engine-porter) when the
studio has the Unity engine configured, else a builder task. It is filed once per asset task (an `asset.handoff`
event).

