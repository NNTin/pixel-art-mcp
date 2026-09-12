"""Blender entrypoint. Uses only Blender's bundled Python and bpy; no app imports."""

import json
import math
import sys
import traceback
from pathlib import Path

import bpy
from mathutils import Euler, Vector

sys.path.insert(0, str(Path(__file__).parent))
import camera_fit  # noqa: E402


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


def evaluated_corners():
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
        points.extend(instance.matrix_world @ point for point in local_bounds[key])
    return points


def render(request, output):
    options = request["options"]
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

    camera_data = bpy.data.cameras.new("PixelExportCamera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 1
    camera = bpy.data.objects.new("PixelExportCamera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    corners = camera_data.view_frame(scene=scene)
    base_width = max(p.x for p in corners) - min(p.x for p in corners)
    base_height = max(p.y for p in corners) - min(p.y for p in corners)

    # Per-row render width, in output (non-supersampled) pixels. Every existing kind
    # (furniture/character) renders every angle at the same options["width"], so this
    # defaults to a uniform list and nothing about their framing changes. Pet is the
    # only kind that varies this today -- its right-facing row renders at double
    # width (see imaging/pet.py) -- supplied by jobs/worker.py.
    widths = options.get("angle_widths") or [options["width"]] * len(options["angles"])

    states = options.get("states")
    ranges = states or [options]
    frames = list(
        dict.fromkeys(
            frame
            for state in ranges
            for frame in range(state["frame_start"], state["frame_end"] + 1, state["frame_step"])
        )
    )
    target = options.get("pixel_agents")
    off_frame = target.get("off_frame") if target else None
    if off_frame is not None and off_frame not in frames:
        frames.append(off_frame)
    for state in states or []:
        off = state.get("off_frame")
        if off is not None and off not in frames:
            frames.append(off)
    bases = [camera_basis(angle, options["elevation"]) for angle in options["angles"]]
    xmin = ymin = math.inf
    xmax = ymax = -math.inf
    radius = 0.0
    # Common bounds in each view's camera basis, over all animation samples.
    for frame in frames:
        scene.frame_set(frame)
        points = evaluated_corners()
        if not points:
            raise ValueError(f"No renderable geometry at frame {frame}")
        radius = max(radius, max(p.length for p in points))
        for _, _, right, up in bases:
            xs, ys = [p.dot(right) for p in points], [p.dot(up) for p in points]
            xmin, xmax = min(xmin, min(xs)), max(xmax, max(xs))
            ymin, ymax = min(ymin, min(ys)), max(ymax, max(ys))
    if not all(math.isfinite(v) for v in (xmin, xmax, ymin, ymax, radius)):
        raise ValueError("Scene contains invalid or unbounded geometry")
    fit = camera_fit.fit_camera(
        base_width=base_width,
        base_height=base_height,
        xmin=xmin,
        xmax=xmax,
        ymin=ymin,
        ymax=ymax,
        padding=options["padding"],
        height=options["height"],
        meters_per_tile=options.get("meters_per_tile"),
    )
    scale, cx, cy, view_height = fit.ortho_scale, fit.cx, fit.cy, fit.view_height
    camera_data.ortho_scale = scale
    distance = max(10.0, radius * 3)
    camera_data.clip_start = 0.001
    camera_data.clip_end = distance + radius * 3 + 100

    def row_pivot(width):
        # view_frame() depends on the camera's current resolution_x aspect, so this
        # also has the side effect of setting resolution_x for that row's renders --
        # ortho_scale (fixed above) keeps every row's real-world zoom identical;
        # only the horizontal framing/pivot changes with a wider or narrower canvas.
        scene.render.resolution_x = width * options["supersampling"]
        frame_corners = camera_data.view_frame(scene=scene)
        view_width = max(p.x for p in frame_corners) - min(p.x for p in frame_corners)
        return camera_fit.row_pivot(
            width=width,
            height=options["height"],
            cx=cx,
            cy=cy,
            view_width=view_width,
            view_height=view_height,
        )

    sun = None
    if options["lighting"] == "studio":
        for obj in scene.objects:
            if obj.type == "LIGHT":
                obj.hide_render = True
        world = bpy.data.worlds.new("PixelExportWorld")
        world.use_nodes = True
        world.node_tree.nodes["Background"].inputs[0].default_value = (0.6, 0.6, 0.6, 1)
        world.node_tree.nodes["Background"].inputs[1].default_value = 0.7
        scene.world = world
        light = bpy.data.lights.new("PixelExportSun", "SUN")
        light.energy = 2
        light.angle = 0.15
        sun = bpy.data.objects.new("PixelExportSun", light)
        scene.collection.objects.link(sun)

    manifest = {
        "blender_version": bpy.app.version_string,
        "frames": [],
        "camera": {
            "projection": "orthographic",
            "ortho_scale": scale,
            "elevation": options["elevation"],
            # A single top-level pivot, for uniform-width jobs (every kind but pet,
            # where it's identical for every row anyway). Each frame entry below
            # carries its own row's pivot, which is what packaging actually reads.
            "pivot": row_pivot(options["width"]),
            "zero_angle": "negative_y",
            "positive_rotation": "around_positive_z",
        },
    }
    total = len(bases) * len(frames)
    for row, (outward, rotation, right, up) in enumerate(bases):
        pivot = row_pivot(widths[row])
        camera.location = outward * distance + right * cx + up * cy
        camera.rotation_mode = "QUATERNION"
        camera.rotation_quaternion = rotation
        if sun:
            sun.rotation_mode = "QUATERNION"
            sun.rotation_quaternion = rotation @ Euler((0.4, -0.6, 0)).to_quaternion()
        for frame in frames:
            scene.frame_set(frame)
            # Saved timeline camera markers must not replace the export camera.
            scene.camera = camera
            filename = f"view_{row:02d}_frame_{frame:06d}.png"
            scene.render.filepath = str(output / filename)
            bpy.ops.render.render(write_still=True)
            manifest["frames"].append(
                {
                    "filename": filename,
                    "angle": options["angles"][row],
                    "frame": frame,
                    "pivot": pivot,
                }
            )
            progress("rendering", len(manifest["frames"]), total)
    return manifest


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
