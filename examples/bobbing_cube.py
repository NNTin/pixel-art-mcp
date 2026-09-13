"""Hybrid example: rendered volume with an exact-pixel badge anchored to the cube."""

import math

import bpy

from pixel_art_mcp.pixel_art import Canvas, PixelArt

bpy.ops.mesh.primitive_cube_add(size=1)
cube = bpy.context.object
cube.name = "BobbingCube"
material = bpy.data.materials.new("Coral")
material.diffuse_color = (0.8, 0.16, 0.08, 1)
material.use_nodes = True
material.node_tree.nodes["Principled BSDF"].inputs[
    "Base Color"
].default_value = material.diffuse_color
cube.data.materials.append(material)
for frame in range(1, 9):
    cube.location.z = 0.75 + 0.1 * math.sin((frame - 1) / 8 * math.tau)
    cube.rotation_euler.z = math.radians(25)
    cube.keyframe_insert(data_path="location", frame=frame)
    cube.keyframe_insert(data_path="rotation_euler", frame=frame)

art = PixelArt(
    {
        "D": "#873d43",
        "S": "#bc5349",
        "C": "#e87854",
        "H": "#fca66a",
        "W": "#fff0be",
        "B": "#304c58",
    },
    {angle: (32, 32) for angle in (0, 90, 180, 270)},
    base="render",
)
badge = Canvas.from_rows([".BBB.", "BBWBB", "BWWWB", "BBWBB", ".BBB."])
for angle in (0, 90, 180, 270):
    art.layer(
        "badge", angle, badge, anchor="BobbingCube", x=-2, y=-1, min_pixels=21, connected=True
    )
art.save(bpy.context.scene)
