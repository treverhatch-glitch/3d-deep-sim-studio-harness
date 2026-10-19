#!/usr/bin/env python3
"""
tools/blender/generate_glb.py — Headless Blender (bpy) Low-Poly .glb Generator

Agents write procedural Python scripts against Blender's built-in `bpy` module
(or coordinate via `mlolson/blender-orchestrator`) and export optimized `.glb`
assets headlessly with zero GUI overhead:

  blender -b --factory-startup -P tools/blender/generate_glb.py -- \
    --preset crate --out public/assets/crate.glb
"""

import argparse
import os
import sys


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    parser = argparse.ArgumentParser(description="Headless Blender low-poly .glb generator")
    parser.add_argument("--preset", default="crate", choices=["crate", "beacon", "hangar"], help="Procedural mesh preset")
    parser.add_argument("--out", default="public/assets/crate.glb", help="Output .glb path")
    return parser.parse_args(argv)


def build_scene(preset: str, out_path: str):
    import bpy  # type: ignore

    bpy.ops.wm.read_factory_settings(use_empty=True)

    # Create shared low-poly PBR material
    mat = bpy.data.materials.new(name=f"mat_{preset}")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        if preset == "crate":
            bsdf.inputs["Base Color"].default_value = (0.22, 0.58, 0.85, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.55
            bsdf.inputs["Metallic"].default_value = 0.25
        elif preset == "beacon":
            bsdf.inputs["Base Color"].default_value = (0.10, 0.78, 0.52, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.35
        else:
            bsdf.inputs["Base Color"].default_value = (0.45, 0.50, 0.58, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.65

    if preset == "crate":
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, 0.5))
    elif preset == "beacon":
        bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.35, depth=1.6, location=(0.0, 0.0, 0.8))
    else:
        bpy.ops.mesh.primitive_cube_add(size=2.0, location=(0.0, 0.0, 1.0))
        bpy.ops.transform.resize(value=(1.8, 1.2, 0.7))

    obj = bpy.context.active_object
    obj.name = f"sim_{preset}"
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(out_path),
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_yup=True,
    )
    print(f"[blender-bpy] Exported optimized GLB -> {out_path}")


if __name__ == "__main__":
    args = parse_args()
    try:
        import bpy  # type: ignore  # noqa: F401
    except ImportError:
        print(
            "[blender-bpy] Run inside headless Blender:\n"
            f"  blender -b --factory-startup -P tools/blender/generate_glb.py -- --preset {args.preset} --out {args.out}"
        )
        sys.exit(0)
    build_scene(args.preset, args.out)
