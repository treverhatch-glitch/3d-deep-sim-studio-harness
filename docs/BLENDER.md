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
