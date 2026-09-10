"""A small pillar candle, real-world scale in meters; submit via execute_blender_python.

Modeled ~0.18m tall to the flame tip (0.14m wax body + 0.015m wick + flame), 0.035m
radius -- a typical pillar candle. Pairs with street_lamp.py to demonstrate
options.meters_per_tile: rendered with the same meters_per_tile, this candle should
come out tiny compared to the lamp, matching their real relative sizes, even though
both occupy a 1x1 pixel-agents tile.
"""

import bpy

WAX_HEIGHT = 0.14
WAX_RADIUS = 0.035
WICK_HEIGHT = 0.015


def material(name, color, emission=0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = 0.5
    shader.inputs["Emission Color"].default_value = (*color, 1)
    shader.inputs["Emission Strength"].default_value = emission
    return mat


wax_mat = material("Candle wax", (0.95, 0.90, 0.78))
wick_mat = material("Charred wick", (0.05, 0.03, 0.02))
flame_mat = material("Candle flame", (1.0, 0.55, 0.05), emission=1.3)

bpy.ops.mesh.primitive_cylinder_add(
    radius=WAX_RADIUS, depth=WAX_HEIGHT, location=(0, 0, WAX_HEIGHT / 2)
)
wax = bpy.context.object
wax.name = "Wax body"
wax.data.materials.append(wax_mat)
bevel = wax.modifiers.new("SoftEdges", "BEVEL")
bevel.width = 0.004
bevel.segments = 2

bpy.ops.mesh.primitive_cylinder_add(
    radius=0.003, depth=WICK_HEIGHT, location=(0, 0, WAX_HEIGHT + WICK_HEIGHT / 2)
)
wick = bpy.context.object
wick.name = "Wick"
wick.data.materials.append(wick_mat)

bpy.ops.mesh.primitive_cone_add(
    radius1=0.009,
    radius2=0.001,
    depth=0.025,
    location=(0, 0, WAX_HEIGHT + WICK_HEIGHT + 0.0125),
)
flame = bpy.context.object
flame.name = "Flame"
flame.data.materials.append(flame_mat)

light_data = bpy.data.lights.new("Flame glow", "POINT")
light_data.color = (1, 0.55, 0.1)
light_data.energy = 3
light_data.shadow_soft_size = 0.03
light = bpy.data.objects.new("Flame glow", light_data)
bpy.context.collection.objects.link(light)
light.location = flame.location

print("Created candle (~0.16m tall). Modify Wax body, Wick or Flame in follow-up scripts.")
