"""Blender-only target rendering; imported by runner after deterministic scene setup."""

import math

import bpy
from camera_fit import fit_asset_views
from mathutils import Euler


def game_materials():
    """Replace render-time shading, retaining authored color/texture and emissive materials."""
    lights = []
    for material in bpy.data.materials:
        material.use_nodes = True
        nodes, links = material.node_tree.nodes, material.node_tree.links
        shader = nodes.get("Principled BSDF")
        source = shader.inputs["Base Color"] if shader else None
        color = source.default_value[:] if source else material.diffuse_color[:]
        emissive = shader and shader.inputs["Emission Strength"].default_value > 0
        emission = nodes.new("ShaderNodeEmission")
        emission.inputs["Color"].default_value = color
        if source and source.is_linked:
            links.new(source.links[0].from_socket, emission.inputs["Color"])
        if not emissive:
            geometry = nodes.new("ShaderNodeNewGeometry")
            dot = nodes.new("ShaderNodeVectorMath")
            dot.operation = "DOT_PRODUCT"
            links.new(geometry.outputs["Normal"], dot.inputs[0])
            lights.append(dot.inputs[1])
            steps = []
            for threshold in (0.0, 0.55):
                step = nodes.new("ShaderNodeMath")
                step.operation = "GREATER_THAN"
                step.inputs[1].default_value = threshold
                links.new(dot.outputs["Value"], step.inputs[0])
                steps.append(step)
            add = nodes.new("ShaderNodeMath")
            add.operation = "ADD"
            for i, step in enumerate(steps):
                links.new(step.outputs[0], add.inputs[i])
            strength = nodes.new("ShaderNodeMath")
            strength.operation = "MULTIPLY_ADD"
            strength.inputs[1].default_value = 0.22
            strength.inputs[2].default_value = 0.56
            links.new(add.outputs[0], strength.inputs[0])
            links.new(strength.outputs[0], emission.inputs["Strength"])
        output = next(
            (n for n in nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None
        )
        if output:
            links.new(emission.outputs[0], output.inputs["Surface"])
    return lights


def render_game(scene, options, output, evaluated_corners, camera_basis, progress):
    spec, layouts = options["asset"], options["asset_layouts"]
    frames = options["frame_sequence"]
    bases = [camera_basis(row["angle"], options["elevation"]) for row in layouts]
    bounds = [[math.inf, -math.inf, math.inf, -math.inf] for _ in layouts]
    object_bounds = [{} for _ in layouts]
    radius = 1.0
    anchors = None
    if spec["anchor_object"]:
        scene.frame_set(frames[0])
        obj = scene.objects.get(spec["anchor_object"])
        if obj is None:
            raise ValueError(f"Unknown anchor_object {spec['anchor_object']!r}")
        point = obj.matrix_world.translation.copy()
        anchors = [(point.dot(right), point.dot(up)) for _, _, right, up in bases]
    for frame in frames:
        scene.frame_set(frame)
        named = {}
        points = evaluated_corners(named)
        if not points:
            raise ValueError(f"No visible geometry at frame {frame}")
        radius = max(radius, max(p.length for p in points))
        for row, (_, _, right, up) in enumerate(bases):
            for name, corners in named.items():
                if not corners:
                    continue
                xs, ys = [p.dot(right) for p in corners], [p.dot(up) for p in corners]
                current = [min(xs), max(xs), min(ys), max(ys)]
                for destination in (
                    bounds[row],
                    object_bounds[row].setdefault(name, [math.inf, -math.inf, math.inf, -math.inf]),
                ):
                    for axis in range(4):
                        destination[axis] = (min if axis % 2 == 0 else max)(
                            destination[axis], current[axis]
                        )
    if not all(math.isfinite(v) for bound in bounds for v in bound):
        raise ValueError("Scene contains nonfinite bounds")
    fits = fit_asset_views(layouts, bounds, anchors)
    camera_data = bpy.data.cameras.new("PixelAssetCamera")
    camera_data.type = "ORTHO"
    camera = bpy.data.objects.new("PixelAssetCamera", camera_data)
    scene.collection.objects.link(camera)
    camera_data.clip_start = 0.001
    camera_data.clip_end = max(100, radius * 8)
    lights, sun = [], None
    if spec["shading"] == "game":
        lights = game_materials()
    elif spec["shading"] == "studio":
        for obj in scene.objects:
            if obj.type == "LIGHT":
                obj.hide_render = True
        world = bpy.data.worlds.new("PixelAssetWorld")
        world.use_nodes = True
        world.node_tree.nodes["Background"].inputs[1].default_value = 0.7
        scene.world = world
        data = bpy.data.lights.new("PixelAssetSun", "SUN")
        data.energy = 2
        sun = bpy.data.objects.new("PixelAssetSun", data)
        scene.collection.objects.link(sun)
    manifest = {
        "blender_version": bpy.app.version_string,
        "frames": [],
        "camera": {
            "projection": "orthographic",
            "elevation": options["elevation"],
            "pixels_per_unit": fits[0]["pixels_per_unit"],
            "views": [],
            "anchor_object": spec["anchor_object"],
            "alignment": "stable clip-union bottom-center",
        },
    }
    for row, (layout, fit, basis) in enumerate(zip(layouts, fits, bases, strict=True)):
        outward, rotation, right, up = basis
        w, h = layout["width"], layout["height"]
        scene.render.resolution_x = w * options["supersampling"]
        scene.render.resolution_y = h * options["supersampling"]
        camera_data.ortho_scale = 1
        corners = camera_data.view_frame(scene=scene)
        base_height = max(p.y for p in corners) - min(p.y for p in corners)
        camera_data.ortho_scale = fit["view_height"] / base_height
        camera.location = outward * max(10, radius * 3) + right * fit["cx"] + up * fit["cy"]
        camera.rotation_mode, camera.rotation_quaternion = "QUATERNION", rotation
        illumination = (up * 0.7 - right * 0.5 + outward * 0.7).normalized()
        for socket in lights:
            socket.default_value = illumination
        if sun:
            sun.rotation_mode = "QUATERNION"
            sun.rotation_quaternion = rotation @ Euler((0.4, -0.6, 0)).to_quaternion()
        ppu = fit["pixels_per_unit"]
        pivot = [w / 2 - fit["cx"] * ppu, h / 2 + fit["cy"] * ppu]
        objects = [
            {
                "name": name,
                "pixel_width": round((b[1] - b[0]) * ppu, 2),
                "pixel_height": round((b[3] - b[2]) * ppu, 2),
            }
            for name, b in object_bounds[row].items()
        ]
        manifest["camera"]["views"].append({**layout, **fit, "pivot": pivot, "objects": objects})
        for frame in frames:
            scene.frame_set(frame)
            scene.camera = camera
            filename = f"view_{row:02d}_frame_{frame:06d}.png"
            scene.render.filepath = str(output / filename)
            bpy.ops.render.render(write_still=True)
            manifest["frames"].append(
                {
                    "filename": filename,
                    "angle": layout["angle"],
                    "frame": frame,
                    "pivot": pivot,
                    "size": [w, h],
                }
            )
            progress("rendering", len(manifest["frames"]), len(frames) * len(layouts))
    return manifest
