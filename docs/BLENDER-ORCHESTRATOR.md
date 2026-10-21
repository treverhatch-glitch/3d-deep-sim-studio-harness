# Connecting `blender-orchestrator` for See-and-Act 3D Agents (`docs/BLENDER-ORCHESTRATOR.md`)

Upstream MCP Bridge: **[`mlolson/blender-orchestrator`](https://github.com/mlolson/blender-orchestrator)**

While [`tools/blender/generate_glb.py`](../tools/blender/generate_glb.py) handles deterministic headless `bpy` batch exports (`crate`, `cone`, `vehicle`, `beacon`, `hangar`), 3D agents (`studio/roles/asset-3d.md`) often need to **both see and act** inside an interactive Blender 4.x session—inspecting object hierarchy, checking bounding boxes, previewing materials, and optionally invoking external mesh generators.

---

## 1. Pre-Wired MCP Configuration (`.mcp.json`)

`blender-orchestrator` is pre-configured in [`.mcp.json`](../.mcp.json):

```json
{
  "mcpServers": {
    "blender-orchestrator": {
      "command": "npx",
      "args": ["-y", "github:mlolson/blender-orchestrator"],
      "env": {
        "BLENDER_BIN": "blender",
        "BLENDER_ORCHESTRATOR_PORT": "3011"
      }
    }
  }
}
```

---

## 2. How Agents "See and Act" in Blender

1. **Launch Blender (or Live Virtual Display `:99`)**:
   - Local desktop: open Blender 4.x with the orchestrator socket active on port `3011`.
   - Headless Linux / WSL2 / War Room stream: run `node scripts/start-agent-display.mjs` (`DISPLAY=:99`) so the live Blender viewport streams into the War Room's **1. noVNC :6080** panel.
2. **Inspect Scene State (See)**:
   - Query scene objects, world-space bounding boxes, triangle counts, and material slots before exporting.
3. **Execute `bpy` Operations (Act)**:
   - Run procedural Python (`bpy.ops.mesh.*`, modifiers, UV unwrapping, PBR roughness/metallic assignment) and export `.glb` with `export_apply=True, export_yup=True`.
4. **Distill 3D Lessons**:
   - If a mesh scale, pivot, or material issue is fixed, append a 4-bullet note to [`studio/memory/failures.md`](../studio/memory/failures.md).
