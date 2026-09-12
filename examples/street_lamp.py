"""A readable game-scale street lamp; submit via execute_blender_python.

Use the tall furniture preset. The pole and glowing glass are exaggerated so
they survive quantization. The glass sits below the opaque roof, not inside it.
"""

import bpy

BASE_HEIGHT = 0.08
POLE_HEIGHT = 3.4
HEAD_HEIGHT = 0.32


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


iron = material("Cast iron", (0.22, 0.28, 0.34), metallic=0.6)
glass = material("Warm lamp glass", (1.0, 0.78, 0.42), emission=1.6)

bpy.ops.mesh.primitive_cylinder_add(
    radius=0.14, depth=BASE_HEIGHT, location=(0, 0, BASE_HEIGHT / 2)
)
base = bpy.context.object
base.name = "Base plate"
base.data.materials.append(iron)

bpy.ops.mesh.primitive_cylinder_add(
    radius=0.09, depth=POLE_HEIGHT, location=(0, 0, BASE_HEIGHT + POLE_HEIGHT / 2)
)
pole = bpy.context.object
pole.name = "Pole"
pole.data.materials.append(iron)
taper = pole.modifiers.new("Taper", "SIMPLE_DEFORM")
taper.deform_method = "TAPER"
taper.factor = -0.4

head_z = BASE_HEIGHT + POLE_HEIGHT + 0.38 + HEAD_HEIGHT / 2
bpy.ops.mesh.primitive_cone_add(
    radius1=0.27, radius2=0.04, depth=HEAD_HEIGHT, location=(0, 0, head_z)
)
head = bpy.context.object
head.name = "Lamp head"
head.data.materials.append(iron)

bpy.ops.mesh.primitive_uv_sphere_add(
    segments=12,
    ring_count=6,
    radius=0.22,
    location=(0, 0, BASE_HEIGHT + POLE_HEIGHT + 0.16),
)
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
