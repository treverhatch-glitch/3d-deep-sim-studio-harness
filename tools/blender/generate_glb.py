#!/usr/bin/env python3
"""
tools/blender/generate_glb.py — Headless Blender (bpy) Low-Poly .glb Generator

Agents write procedural Python scripts against Blender's built-in `bpy` module
(or coordinate via `mlolson/blender-orchestrator`) and export optimized `.glb`
assets headlessly with zero GUI overhead:

  blender -b --factory-startup -P tools/blender/generate_glb.py -- \
    --preset vehicle --out public/assets/vehicle.glb

Supported presets:
  - crate   : Low-poly cargo crate (1x1x1m)
  - cone    : Traffic / safety marker cone with base plinth
  - vehicle : Low-poly utility vehicle (chassis + cabin + 4 wheel cylinders)
  - beacon  : Navigation / telemetry tower cylinder
  - hangar  : Wide industrial hangar / warehouse structure
"""

import argparse
import os
import sys

PRESETS = ["crate", "cone", "vehicle", "beacon", "hangar"]


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    parser = argparse.ArgumentParser(description="Headless Blender low-poly .glb generator")
    parser.add_argument("--preset", default="crate", choices=PRESETS, help="Procedural mesh preset")
    parser.add_argument("--out", default="public/assets/crate.glb", help="Output .glb path")
    return parser.parse_args(argv)


def make_material(name: str, color: tuple, roughness: float = 0.55, metallic: float = 0.2):
    import bpy  # type: ignore

    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
    return mat


def assign_material(obj, mat):
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)


def build_scene(preset: str, out_path: str):
    import bpy  # type: ignore

    bpy.ops.wm.read_factory_settings(use_empty=True)

    if preset == "crate":
        mat = make_material("mat_crate", (0.82, 0.52, 0.22, 1.0), roughness=0.65, metallic=0.1)
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, 0.5))
        obj = bpy.context.active_object
        obj.name = "sim_crate"
        assign_material(obj, mat)

    elif preset == "cone":
        mat_orange = make_material("mat_cone_orange", (0.98, 0.36, 0.05, 1.0), roughness=0.45, metallic=0.05)
        mat_base = make_material("mat_cone_base", (0.12, 0.14, 0.18, 1.0), roughness=0.8, metallic=0.1)
        # Base plinth
        bpy.ops.mesh.primitive_cube_add(size=0.5, location=(0.0, 0.0, 0.04))
        base = bpy.context.active_object
        base.scale = (1.0, 1.0, 0.16)
        assign_material(base, mat_base)
        # Cone body
        bpy.ops.mesh.primitive_cone_add(vertices=12, radius1=0.22, radius2=0.04, depth=0.75, location=(0.0, 0.0, 0.42))
        cone = bpy.context.active_object
        cone.name = "sim_cone"
        assign_material(cone, mat_orange)

    elif preset == "vehicle":
        mat_body = make_material("mat_vehicle_body", (0.15, 0.55, 0.88, 1.0), roughness=0.4, metallic=0.35)
        mat_cab = make_material("mat_vehicle_cabin", (0.75, 0.88, 0.98, 1.0), roughness=0.2, metallic=0.1)
        mat_wheel = make_material("mat_vehicle_wheel", (0.10, 0.11, 0.13, 1.0), roughness=0.85, metallic=0.1)

        # Chassis
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, 0.45))
        chassis = bpy.context.active_object
        chassis.name = "sim_vehicle_chassis"
        chassis.scale = (2.2, 1.1, 0.45)
        assign_material(chassis, mat_body)

        # Cabin
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.35, 0.0, 0.88))
        cabin = bpy.context.active_object
        cabin.name = "sim_vehicle_cabin"
        cabin.scale = (1.0, 0.95, 0.42)
        assign_material(cabin, mat_cab)

        # 4 Wheels
        wheel_offsets = [(-0.7, -0.58, 0.24), (-0.7, 0.58, 0.24), (0.7, -0.58, 0.24), (0.7, 0.58, 0.24)]
        for idx, (wx, wy, wz) in enumerate(wheel_offsets):
            bpy.ops.mesh.primitive_cylinder_add(
                vertices=12, radius=0.24, depth=0.18, location=(wx, wy, wz), rotation=(1.5708, 0.0, 0.0)
            )
            w = bpy.context.active_object
            w.name = f"sim_vehicle_wheel_{idx}"
            assign_material(w, mat_wheel)

    elif preset == "beacon":
        mat = make_material("mat_beacon", (0.10, 0.78, 0.52, 1.0), roughness=0.35, metallic=0.3)
        bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.35, depth=1.6, location=(0.0, 0.0, 0.8))
        obj = bpy.context.active_object
        obj.name = "sim_beacon"
        assign_material(obj, mat)

    else:  # hangar
        mat = make_material("mat_hangar", (0.45, 0.50, 0.58, 1.0), roughness=0.65, metallic=0.25)
        bpy.ops.mesh.primitive_cube_add(size=2.0, location=(0.0, 0.0, 1.0))
        obj = bpy.context.active_object
        obj.name = "sim_hangar"
        obj.scale = (1.8, 1.2, 0.7)
        assign_material(obj, mat)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(out_path),
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_yup=True,
    )
    print(f"[blender-bpy] Exported optimized GLB ({preset}) -> {out_path}")


if __name__ == "__main__":
    args = parse_args()
    try:
        import bpy  # type: ignore  # noqa: F401
    except ImportError:
        print(
            f"[blender-bpy] Preset '{args.preset}' verified. Run inside headless Blender:\n"
            f"  blender -b --factory-startup -P tools/blender/generate_glb.py -- --preset {args.preset} --out {args.out}"
        )
        sys.exit(0)
    build_scene(args.preset, args.out)
