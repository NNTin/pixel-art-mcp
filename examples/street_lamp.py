"""A tall street lamp, real-world scale in meters; submit via execute_blender_python.

Modeled ~3.7m tall overall (0.08m base plate + 3.4m pole + 0.22m lamp head) -- a
typical single-arm street lamp. Pairs with candle.py to demonstrate
options.meters_per_tile: rendered with the same meters_per_tile, this lamp should
dominate its canvas the way the candle stays tiny in its own, matching their real
relative sizes, even though both occupy a 1x1 pixel-agents tile (this lamp needs
options.pixel_agents.background_tiles to keep that footprint while overflowing the
tile visually -- see docs/tools.md).
"""

import bpy

BASE_HEIGHT = 0.08
POLE_HEIGHT = 3.4
HEAD_HEIGHT = 0.22


def material(name, color, metallic=0.0, emission=0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = 0.4
    shader.inputs["Emission Color"].default_value = (*color, 1)
    shader.inputs["Emission Strength"].default_value = emission
    return mat


iron = material("Cast iron", (0.05, 0.05, 0.06), metallic=0.6)
glass = material("Warm lamp glass", (1.0, 0.78, 0.42), emission=1.6)

bpy.ops.mesh.primitive_cylinder_add(
    radius=0.14, depth=BASE_HEIGHT, location=(0, 0, BASE_HEIGHT / 2)
)
base = bpy.context.object
base.name = "Base plate"
base.data.materials.append(iron)

bpy.ops.mesh.primitive_cylinder_add(
    radius=0.045, depth=POLE_HEIGHT, location=(0, 0, BASE_HEIGHT + POLE_HEIGHT / 2)
)
pole = bpy.context.object
pole.name = "Pole"
pole.data.materials.append(iron)
taper = pole.modifiers.new("Taper", "SIMPLE_DEFORM")
taper.deform_method = "TAPER"
taper.factor = -0.4

head_z = BASE_HEIGHT + POLE_HEIGHT + HEAD_HEIGHT / 2
bpy.ops.mesh.primitive_cone_add(
    radius1=0.16, radius2=0.02, depth=HEAD_HEIGHT, location=(0, 0, head_z)
)
head = bpy.context.object
head.name = "Lamp head"
head.data.materials.append(iron)

bpy.ops.mesh.primitive_uv_sphere_add(radius=0.09, location=(0, 0, BASE_HEIGHT + POLE_HEIGHT + 0.05))
bulb = bpy.context.object
bulb.name = "Glass"
bulb.data.materials.append(glass)

light_data = bpy.data.lights.new("Lamp glow", "POINT")
light_data.color = (1, 0.8, 0.5)
light_data.energy = 40
light_data.shadow_soft_size = 0.1
light = bpy.data.objects.new("Lamp glow", light_data)
bpy.context.collection.objects.link(light)
light.location = bulb.location

print("Created street lamp (~3.7m tall). Modify Pole, Lamp head or Glass in follow-up scripts.")
