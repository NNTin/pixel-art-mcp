"""Blender entrypoint. Uses only Blender's bundled Python and bpy; no app imports."""

import json
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


def render(request, output):
    options = request["options"]
    if not options.get("asset"):
        raise ValueError("Use configure_asset, write_pixel_art and render_asset")
    scene = bpy.context.scene
    if "pixel_art" not in scene:
        raise ValueError("Call write_pixel_art before rendering")
    art = PixelArt.load(scene)
    art.validate_target(options["asset_layouts"], options["frame_sequence"], options["asset"])

    from game_renderer import native_render

    return native_render(scene, options, output, art, progress)


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
