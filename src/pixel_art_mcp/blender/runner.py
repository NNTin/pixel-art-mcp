"""Blender entrypoint. Uses only Blender's bundled Python and bpy; no app imports."""

import json
import math
import sys
import traceback
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parents[2]))

from pixel_art_mcp.pixel_art import PixelArt  # noqa: E402


def progress(stage, completed, total):
    print(
        "PIXEL_PROGRESS " + json.dumps({"stage": stage, "completed": completed, "total": total}),
        flush=True,
    )


def scene_summary():
    scene = bpy.context.scene
    return {
        "blender_version": bpy.app.version_string,
        "frame_start": scene.frame_start,
        "frame_end": scene.frame_end,
        "fps": scene.render.fps / scene.render.fps_base,
        "object_count": len(scene.objects),
        "objects": [
            {
                "name": obj.name,
                "type": obj.type,
                "location": list(obj.location),
                "rotation_euler": list(obj.rotation_euler),
                "scale": list(obj.scale),
                "dimensions": list(obj.dimensions),
                "parent": obj.parent.name if obj.parent else None,
                "materials": [
                    slot.material.name if slot.material else None for slot in obj.material_slots
                ],
                "bounds_world": [list(obj.matrix_world @ Vector(p)) for p in obj.bound_box],
                "animated": obj.animation_data is not None,
            }
            for obj in list(scene.objects)[:1000]
        ],
        "objects_truncated": len(scene.objects) > 1000,
        "pixel_art": PixelArt.load(scene).to_dict() if "pixel_art" in scene else None,
        "materials": [
            {"name": mat.name, "diffuse_color": list(mat.diffuse_color)}
            for mat in list(bpy.data.materials)[:256]
        ],
    }


def camera_basis(angle, elevation):
    az, el = math.radians(angle), math.radians(elevation)
    outward = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
    rotation = (-outward).to_track_quat("-Z", "Y")
    return outward, rotation, rotation @ Vector((1, 0, 0)), rotation @ Vector((0, 1, 0))


def evaluated_corners(named=None):
    graph = bpy.context.evaluated_depsgraph_get()
    points = []
    local_bounds = {}
    for instance in graph.object_instances:
        obj = instance.object
        if obj.type not in {"MESH", "CURVE", "SURFACE", "FONT", "META", "VOLUME"}:
            continue
        if obj.original.hide_render:
            continue
        # Generated curve mesh objects are temporary: Blender reuses their pointers while
        # iterating. Key by the stable original object and evaluated type, or one curve's
        # bounds can be applied to another curve (and shift/resize the whole export).
        key = (obj.original.as_pointer(), obj.type)
        if key not in local_bounds:
            if obj.type in {"CURVE", "SURFACE", "FONT", "META"}:
                # Blender can expose both a legacy curve and its generated mesh instance.
                # The curve's evaluated bound_box may include non-rendered control geometry
                # and a unit-sized fallback, dwarfing a small bevel. Bound its visible mesh.
                mesh = obj.to_mesh()
                try:
                    if mesh is None or not mesh.vertices:
                        local_bounds[key] = []
                    else:
                        low = [min(v.co[axis] for v in mesh.vertices) for axis in range(3)]
                        high = [max(v.co[axis] for v in mesh.vertices) for axis in range(3)]
                        local_bounds[key] = [
                            Vector((x, y, z))
                            for x in (low[0], high[0])
                            for y in (low[1], high[1])
                            for z in (low[2], high[2])
                        ]
                finally:
                    obj.to_mesh_clear()
            else:
                local_bounds[key] = [Vector(p) for p in obj.bound_box]
        world = [instance.matrix_world @ point for point in local_bounds[key]]
        points.extend(world)
        if named is not None:
            named.setdefault(obj.original.name, []).extend(world)
    return points


def render(request, output):
    options = request["options"]
    if not options.get("asset"):
        raise ValueError("Use configure_asset, write_pixel_art and render_asset")
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = options["samples"]
    scene.cycles.use_denoising = False
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    scene.render.film_transparent = True
    scene.render.use_motion_blur = False
    scene.render.use_compositing = False
    scene.render.use_sequencer = False
    scene.render.use_border = False
    scene.render.use_multiview = False
    scene.render.dither_intensity = 0
    scene.render.resolution_percentage = 100
    scene.render.resolution_x = options["width"] * options["supersampling"]
    scene.render.resolution_y = options["height"] * options["supersampling"]
    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1

    from game_renderer import render_game

    return render_game(scene, options, output, evaluated_corners, camera_basis, progress)


def main():
    request_path = Path(sys.argv[sys.argv.index("--") + 1])
    request = json.loads(request_path.read_text(encoding="utf-8"))
    output = Path(request["output_dir"])
    output.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if request.get("input_blend"):
        bpy.ops.wm.open_mainfile(filepath=request["input_blend"])
    bpy.context.scene.render.threads_mode = "FIXED"
    bpy.context.scene.render.threads = request["threads"]
    if request["operation"] == "script":
        script_path = Path(request["script_path"])
        scope = {
            "__name__": "__main__",
            "__file__": str(script_path),
            "bpy": bpy,
            "reference_images": request["references"],
        }
        exec(compile(script_path.read_text(encoding="utf-8"), str(script_path), "exec"), scope)
        bpy.context.view_layer.update()
        scene = bpy.context.scene
        if "pixel_art" in scene:
            options = request.get("authoring_options")
            if not options:
                raise ValueError("Call configure_asset before saving pixel art")
            PixelArt.load(scene).validate_target(
                options["asset_layouts"],
                options["frame_sequence"],
                options["asset"],
                {obj.name for obj in scene.objects},
            )
        elif request.get("pixel_art_required"):
            raise ValueError("A required pixel-art definition cannot be removed")
        bpy.ops.file.pack_all()
        bpy.context.preferences.filepaths.save_version = 0
        bpy.ops.wm.save_as_mainfile(filepath=str(output / "scene.blend"))
        result = {"summary": scene_summary()}
    else:
        result = render(request, output)
    (output / "result.json").write_text(json.dumps(result), encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        traceback.print_exc()
        sys.exit(1)
