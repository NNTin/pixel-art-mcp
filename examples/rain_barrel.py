"""Simple 16x32 rain barrel for the pixel-art MCP Blender tool.

Export empty: 1..8, idle 0; partially filled: 11..18, idle 10;
full: 21..28, idle 20. Use four cardinal views, elevation 40, 5 fps,
and a pixel-agents footprint_w=1, footprint_h=2.
Use tile_width=1 and tile_height=2 without a larger pixel override.
The broad faucet and gauge take priority over wood grain and decorative fittings.
"""

import math

import bpy
from mathutils import Vector

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.frame_start = 0
scene.frame_end = 28
scene.render.fps = 5


def material(name, color, emission=0.0):
    rgb = [int(color[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*linear, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*linear, 1)
    shader.inputs["Roughness"].default_value = 0.85
    if emission:
        shader.inputs["Emission Color"].default_value = (*linear, 1)
        shader.inputs["Emission Strength"].default_value = emission
    return mat


woods = [
    material(f"Oak / stave {i}", color) for i, color in enumerate(["#ae733e", "#c68a4b", "#b77b41"])
]
inner = material("Oak / shadowed inner wall", "#60402d", 0.18)
endgrain = material("Oak / fresh rim endgrain", "#d7a363")
iron = material("Iron / blue charcoal", "#35434a")
brass = material("Brass / faucet body", "#e0aa44", 0.35)
brass_light = material("Brass / faucet handle", "#ffe29a", 0.6)
gauge_frame = material("Gauge / pale frame", "#d9d8a4", 0.3)
deep = material("Gauge / unfilled dark glass", "#203c43")
water_mat = material("Water / turquoise", "#228f9b", 0.45)
water_light = material("Water / pale moving highlights", "#aaf8ed", 1.0)
water_mid = material("Water / blue ripple", "#46bfc5", 0.5)

# Keep the tiny faucet's gold distinct from the brown wood in every viewing direction.
for mat in (brass, brass_light):
    nodes = mat.node_tree.nodes
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = mat.diffuse_color
    emission.inputs["Strength"].default_value = 1
    mat.node_tree.links.new(emission.outputs[0], nodes["Material Output"].inputs["Surface"])


def mesh(name, verts, faces, mat):
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def cylinder(name, radius, depth, location, mat, vertices=16, direction=None):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices, radius=radius, depth=depth, end_fill_type="NGON", location=location
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    if direction:
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = Vector(direction).to_track_quat("Z", "Y")
    return obj


def cube(name, location, dimensions, mat, angle=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    obj.rotation_euler.z = angle
    obj.data.materials.append(mat)
    return obj


def tube(name, coords, thickness, mat):
    data = bpy.data.curves.new(name, "CURVE")
    data.dimensions = "3D"
    data.resolution_u = 1
    data.bevel_depth = thickness
    data.bevel_resolution = 0
    data.resolution_u = 1
    data.use_fill_caps = True
    spline = data.splines.new("POLY")
    spline.points.add(len(coords) - 1)
    for point, co in zip(spline.points, coords, strict=True):
        point.co = (*co, 1)
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


profile = [
    (0.08, 0.68),
    (0.25, 0.73),
    (0.8, 0.8),
    (1.57, 0.84),
    (2.4, 0.8),
    (2.95, 0.73),
    (3.14, 0.72),
]
count = 12
for i in range(count):
    theta = math.tau * i / count
    a, b = theta + 0.010, theta + math.tau / count - 0.010
    verts = []
    for z, radius in profile:
        verts.extend(
            [
                (radius * math.cos(a), radius * math.sin(a), z),
                (radius * math.cos(b), radius * math.sin(b), z),
            ]
        )
    faces = [(2 * j, 2 * j + 1, 2 * j + 3, 2 * j + 2) for j in range(len(profile) - 1)]
    obj = mesh(f"Stave {i:02d} / outside", verts, faces, woods[i % len(woods)])
    inside_verts = []
    for z, radius in profile:
        inside_verts.extend(
            [
                ((radius - 0.10) * math.cos(a), (radius - 0.10) * math.sin(a), z),
                ((radius - 0.10) * math.cos(b), (radius - 0.10) * math.sin(b), z),
            ]
        )
    mesh(f"Stave {i:02d} / inside", inside_verts, [tuple(reversed(f)) for f in faces], inner)
    mesh(f"Stave {i:02d} / rim", verts[-2:] + inside_verts[-2:], [(0, 1, 3, 2)], endgrain)

cylinder("Interior / dry bottom", 0.655, 0.06, (0, 0, 0.16), inner)


def ring(name, z, radius, thickness, height, mat):
    verts = []
    for zz, rr in [
        (z - height / 2, radius),
        (z + height / 2, radius),
        (z + height / 2, radius - thickness),
        (z - height / 2, radius - thickness),
    ]:
        verts += [
            (rr * math.cos(math.tau * i / count), rr * math.sin(math.tau * i / count), zz)
            for i in range(count)
        ]
    faces = []
    for j in range(4):
        for i in range(count):
            ni = (i + 1) % count
            k = (j + 1) % 4
            faces.append((j * count + i, j * count + ni, k * count + ni, k * count + i))
    return mesh(name, verts, faces, mat)


for index, (z, radius) in enumerate([(0.36, 0.78), (2.87, 0.777)]):
    ring(f"Hoop {index} / iron band", z, radius, 0.055, 0.21, iron)
ring("Top / protective rim", 3.09, 0.744, 0.055, 0.13, iron)

# Exaggerated faucet: a readable 3-4 pixel T handle and a thick bent spout.
cube("Tap / dark backplate", (-0.30, -0.86, 1.34), (0.54, 0.09, 1.06), iron)
cylinder("Tap / mounting boss", 0.22, 0.13, (-0.30, -0.79, 1.15), iron, direction=(0, -1, 0))
tube(
    "Tap / bent brass spout",
    [(-0.30, -0.83, 1.05), (-0.30, -0.92, 1.05), (0, -0.92, 1.05), (0, -0.92, 0.80)],
    0.115,
    brass,
)
cylinder("Tap / dark mouth", 0.075, 0.015, (0, -0.92, 0.795), deep)
cylinder("Tap / valve stem", 0.075, 0.43, (-0.30, -0.92, 1.40), brass)
cube("Tap / T handle", (-0.30, -0.92, 1.68), (0.65, 0.16, 0.16), brass_light)

# Sight gauges show the fill level even where the near rim occludes the water.
gauges = []
for i in range(4):
    a = i * math.pi / 2
    outward = Vector((math.sin(a), -math.cos(a), 0))
    tangent = Vector((math.cos(a), math.sin(a), 0))
    center = outward * 0.86 + tangent * 0.35
    cube(f"Gauge {i} / pale case", (*center.xy, 2.05), (0.40, 0.10, 1.52), gauge_frame, a)
    center += outward * 0.065
    cube(f"Gauge {i} / unfilled glass", (*center.xy, 2.05), (0.25, 0.028, 1.30), deep, a)
    center += outward * 0.022
    fill = cube(f"Gauge {i} / water column", (*center.xy, 1.41), (0.25, 0.018, 0.015), water_mid, a)
    gauges.append(fill)

water = cylinder("Water / fill surface", 0.682, 0.022, (0, 0, 3.0), water_mat, vertices=32)
ripples = []
for i, (x, y) in enumerate([(0, 0)]):
    for j in range(1):
        coords = [
            (math.cos(t) * 0.3, math.sin(t) * 0.3, 0)
            for t in [k * math.tau / 24 for k in range(25)]
        ]
        obj = tube(
            f"Water / ripple {i}-{j}",
            coords,
            0.065,
            water_light if j == 0 else water_mid,
        )
        ripples.append((obj, x, y, i, j))

drops = []
for i, (x, y) in enumerate([(-0.28, 0.10), (0.26, -0.14)]):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=1, location=(x, y, 3.6))
    obj = bpy.context.object
    obj.name = f"Rain / falling drop {i}"
    obj.data.materials.append(water_light)
    drops.append(obj)

for frame in range(29):
    group = min(frame // 10, 2)
    local = frame % 10
    active = 1 <= local <= 8
    phase = ((local - 1) % 8) / 8
    level = [0.18, 2.50, 3.015][group]
    water.location.z = level
    water.hide_render = group == 0
    water.keyframe_insert(data_path="location", frame=frame)
    water.keyframe_insert(data_path="hide_render", frame=frame)
    for obj in gauges:
        h = [0.008, 0.65, 1.28][group]
        obj.scale.z = h
        obj.location.z = 1.40 + h / 2
        obj.hide_render = group == 0
        obj.keyframe_insert(data_path="scale", frame=frame)
        obj.keyframe_insert(data_path="location", frame=frame)
        obj.keyframe_insert(data_path="hide_render", frame=frame)
    for obj, x, y, i, j in ripples:
        p = (phase + i * 0.5 + j * 0.34) % 1 if active else 0.45 + j * 0.25
        obj.location = (x, y, level + 0.02)
        s = 0.18 + 0.8 * p
        obj.scale = (s, s, 0.7)
        obj.hide_render = group == 0 or (active and p > 0.90)
        obj.keyframe_insert(data_path="location", frame=frame)
        obj.keyframe_insert(data_path="scale", frame=frame)
        obj.keyframe_insert(data_path="hide_render", frame=frame)
    for i, obj in enumerate(drops):
        p = (phase + i / 3) % 1
        obj.location.z = 3.76 - p * 0.66
        obj.scale = (0.070, 0.070, 0.13 if p < 0.78 else 0.070)
        obj.hide_render = not active
        obj.keyframe_insert(data_path="location", frame=frame)
        obj.keyframe_insert(data_path="scale", frame=frame)
        obj.keyframe_insert(data_path="hide_render", frame=frame)

for action in bpy.data.actions:
    for fcurve in action.fcurves:
        for key in fcurve.keyframe_points:
            key.interpolation = "CONSTANT"
root = bpy.data.objects.new("Barrel / proportions", None)
scene.collection.objects.link(root)
for obj in list(scene.objects):
    if obj != root:
        obj.parent = root
root.scale.z = 1.08
scene["rain_barrel_states"] = "empty=0/1-8; partially_filled=10/11-18; full=20/21-28"
scene["pixel_agents_footprint"] = "1x2; PNG canvas 16x32"
scene.frame_set(21)
