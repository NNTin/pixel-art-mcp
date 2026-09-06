"""Bronze oil lamp with an eight-frame flame loop; submit via execute_blender_python.

Export frames 1..8 at 5 fps. Frame 9 repeats frame 1 for a seamless cycle.
Frame 0 is the extinguished pose for pixel-agents off/on furniture states.
The spout points toward -Y (the exporter's 0 degree view).
"""

import math

import bpy
from mathutils import Vector


def material(name, color, metallic=0.0, emission=0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = 0.38
    shader.inputs["Emission Color"].default_value = (*color, 1)
    shader.inputs["Emission Strength"].default_value = emission
    return mat


def lathe(name, profile, mat, segments=24):
    vertices = [
        (radius * math.cos(i * math.tau / segments), radius * math.sin(i * math.tau / segments), z)
        for radius, z in profile
        for i in range(segments)
    ]
    faces = []
    for ring in range(len(profile) - 1):
        for i in range(segments):
            a = ring * segments + i
            b = ring * segments + (i + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    faces.extend(
        [
            tuple(reversed(range(segments))),
            tuple((len(profile) - 1) * segments + i for i in range(segments)),
        ]
    )
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def tube(name, points, radius, mat, cyclic=False):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 1
    curve.bevel_depth = radius
    curve.bevel_resolution = 1
    curve.use_fill_caps = True
    spline = curve.splines.new("POLY")
    spline.points.add(len(points) - 1)
    for point, xyz in zip(spline.points, points, strict=True):
        point.co = (*xyz, 1)
    spline.use_cyclic_u = cyclic
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


bronze = material("Warm aged bronze", (0.32, 0.115, 0.028), 0.65)
gold = material("Polished brass edges", (0.67, 0.36, 0.085), 0.7)
dark = material("Dark oil and wick", (0.028, 0.016, 0.012))
patina = material("Turquoise enamel", (0.028, 0.20, 0.16), 0.3)
orange = material("Flame amber", (1.0, 0.20, 0.008), emission=1.0)
yellow = material("Flame gold", (1.0, 0.65, 0.025), emission=1.1)
cream = material("Flame hot tip", (1.0, 0.92, 0.46), emission=1.4)

lathe("Foot", [(0.30, 0.02), (0.40, 0.06), (0.40, 0.11), (0.31, 0.16)], gold)
lathe(
    "Oil reservoir",
    [(0.28, 0.13), (0.52, 0.22), (0.67, 0.39), (0.64, 0.53), (0.50, 0.65), (0.30, 0.69)],
    bronze,
)
lathe("Reservoir equator trim", [(0.665, 0.39), (0.68, 0.415), (0.665, 0.445)], gold)
lathe("Enamel collar", [(0.47, 0.625), (0.46, 0.66), (0.32, 0.70)], patina)
lathe("Lid rim", [(0.31, 0.69), (0.36, 0.715), (0.35, 0.75), (0.24, 0.78)], gold)
lathe("Domed lid", [(0.27, 0.765), (0.20, 0.83), (0.08, 0.88), (0.04, 0.89)], bronze)
lathe("Lid knob", [(0.04, 0.88), (0.085, 0.92), (0.065, 0.98), (0.015, 1.0)], gold, 12)

# A rising tapered spout gives the silhouette a clear front in every rotation.
spout = lathe("Long spout", [(0.22, 0), (0.19, 0.25), (0.11, 0.58), (0.12, 0.78)], bronze, 16)
spout.location = (0, -0.42, 0.43)
spout.rotation_euler = Vector((0, -0.86, 0.44)).to_track_quat("Z", "Y").to_euler()
wick_location = Vector(spout.location) + Vector((0, -0.86, 0.44)).normalized() * 0.78
rim = lathe("Spout brass lip", [(0.12, -0.035), (0.135, 0), (0.12, 0.045)], gold, 16)
rim.location = wick_location
rim.rotation_euler = spout.rotation_euler
wick = lathe("Charred wick", [(0.065, 0), (0.065, 0.11)], dark, 12)
wick.location = wick_location

handle_points = [
    (0, 0.69 + 0.30 * math.cos(i * math.tau / 32), 0.67 + 0.39 * math.sin(i * math.tau / 32))
    for i in range(32)
]
tube("Raised loop handle", handle_points, 0.065, gold, cyclic=True)
tube("Handle lower attachment", [(0, 0.45, 0.31), (0, 0.75, 0.35)], 0.09, bronze)

flame = lathe(
    "Animated flame",
    [(0.035, 0), (0.12, 0.09), (0.145, 0.22), (0.10, 0.37), (0.047, 0.52), (0.0, 0.69)],
    orange,
    10,
)
flame.location = wick_location + Vector((0, 0, 0.09))
flame.data.materials.append(yellow)
flame.data.materials.append(cream)
for polygon in flame.data.polygons:
    band = polygon.index // 10
    polygon.material_index = 0 if band == 0 else (1 if band < 3 else 2)
for vertex in flame.data.vertices:
    vertex.co.x += 0.085 * (vertex.co.z / 0.69) ** 2

light_data = bpy.data.lights.new("Flame glow", "POINT")
light_data.color = (1, 0.36, 0.07)
light_data.shadow_soft_size = 0.24
light = bpy.data.objects.new("Flame glow", light_data)
bpy.context.collection.objects.link(light)
light.location = flame.location + Vector((0, 0, 0.24))

scene = bpy.context.scene
scene.frame_start, scene.frame_end = 1, 8
scene.render.fps = 5
flame.hide_render = True
flame.keyframe_insert(data_path="hide_render", frame=0)
flame.hide_render = False
flame.keyframe_insert(data_path="hide_render", frame=1)
light_data.energy = 0
light_data.keyframe_insert(data_path="energy", frame=0)
for frame in range(1, 10):
    phase = (frame - 1) * math.tau / 8
    flame.scale = (
        1 + 0.14 * math.sin(phase),
        1 + 0.10 * math.cos(phase),
        1 + 0.17 * math.sin(phase + 0.5),
    )
    flame.rotation_euler = (0.08 * math.cos(phase), 0.15 * math.sin(phase), 0)
    flame.keyframe_insert(data_path="scale", frame=frame)
    flame.keyframe_insert(data_path="rotation_euler", frame=frame)
    light_data.energy = 9 + 2 * math.sin(phase + 0.5)
    light_data.keyframe_insert(data_path="energy", frame=frame)
scene.frame_set(1)
