"""Submit this entire file to execute_blender_python in a new project."""

import bpy

wood = bpy.data.materials.new("WarmWood")
wood.diffuse_color = (0.38, 0.16, 0.06, 1)
wood.use_nodes = True
shader = wood.node_tree.nodes.get("Principled BSDF")
shader.inputs["Base Color"].default_value = wood.diffuse_color
shader.inputs["Roughness"].default_value = 0.85


def box(name, location, dimensions):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(wood)
    bevel = obj.modifiers.new("SoftEdges", "BEVEL")
    bevel.width = 0.025
    bevel.segments = 1
    return obj


box("Seat", (0, 0, 1), (1.1, 1, 0.15))
for x in (-0.43, 0.43):
    for y in (-0.38, 0.38):
        box(f"Leg_{x}_{y}", (x, y, 0.5), (0.13, 0.13, 1))
for x in (-0.43, 0.43):
    box(f"BackPost_{x}", (x, 0.4, 1.5), (0.13, 0.13, 1.1))
box("Backrest", (0, 0.4, 1.85), (1, 0.12, 0.25))
print("Created chair. Modify named objects such as Seat or Backrest in follow-up scripts.")
