# Blender Headless Asset Generation

Default pattern for generating 3D assets without opening the Blender GUI.

Agents can write Python scripts that use Blender’s `bpy` module and run them headlessly:

```bash
blender --background --python generate_asset.py
```

## Typical flow

1. Agent writes a `bpy` script that builds low-poly (or mid-poly) geometry, assigns materials, and exports `.glb`.
2. Run headlessly.
3. Drop the `.glb` into the game’s asset folder.
4. The presentation layer (Three.js) loads it. The sim never imports Blender or Three.js.

## Example skeleton

```python
import bpy

# clear scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# create a simple object
bpy.ops.mesh.primitive_cube_add(size=2)
obj = bpy.context.active_object
obj.name = "CargoCrate"

# export
bpy.ops.export_scene.gltf(filepath="//CargoCrate.glb", export_format='GLB')
```

## Notes

- Keep asset scripts in something like `assets/blender/` inside the game repo.
- This stays on the presentation side of the graphics/sim boundary.
- For more advanced orchestration see community tools such as blender-orchestrator, but a plain `bpy` script is enough to start.

This is now part of the default toolkit guidance for 3D deep-sim games.
