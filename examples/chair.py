"""Submit this entire file to execute_blender_python in a new project.

Modeled at 2x scale for editing convenience, then uniformly rescaled to a real ~0.94m
tall dining chair via a parent empty's scale (CHAIR_SCALE) -- see the bottom of this
file. Follow-up scripts (e.g. modify_chair.py) can keep editing objects in the same
oversized local coordinates; the parent scale applies transparently to every edit.

Three distinct materials (frame wood, backrest wood, seat cushion) instead of one --
a single flat color leaves nothing for the pixel-art downscale to preserve, so the
16x16 export reads as a plain silhouette. Separate color regions with real contrast
give per-cell structure (see #11) that survives quantization instead of averaging away.
"""

import bpy


def material(name, color, roughness=0.85):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = mat.diffuse_color
    shader.inputs["Roughness"].default_value = roughness
    return mat


frame_wood = material("WarmWood / frame", (0.38, 0.16, 0.06))
backrest_wood = material("WarmWood / backrest", (0.24, 0.10, 0.035))
cushion_fabric = material("Cushion / red fabric", (0.55, 0.09, 0.10), roughness=0.95)


def box(name, location, dimensions, mat=frame_wood):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    bevel = obj.modifiers.new("SoftEdges", "BEVEL")
    bevel.width = 0.025
    bevel.segments = 1
    return obj


box("Seat", (0, 0, 1), (1.1, 1, 0.15))
box("Cushion", (0, 0, 1.09), (0.94, 0.84, 0.09), cushion_fabric)
for x in (-0.43, 0.43):
    for y in (-0.38, 0.38):
        box(f"Leg_{x}_{y}", (x, y, 0.5), (0.13, 0.13, 1))
for x in (-0.43, 0.43):
    box(f"BackPost_{x}", (x, 0.4, 1.5), (0.13, 0.13, 1.1), backrest_wood)
box("Backrest", (0, 0.4, 1.85), (1, 0.12, 0.25), backrest_wood)

# Rescale the whole (oversized, for editing convenience) assembly to a real ~0.94m
# chair via one parent empty -- geometry, modifier widths, and any follow-up script's
# edits to these objects' local transforms all scale through this uniformly.
CHAIR_SCALE = 0.46
root = bpy.data.objects.new("Chair / proportions", None)
bpy.context.collection.objects.link(root)
for obj in list(bpy.context.scene.objects):
    if obj is not root:
        obj.parent = root
root.scale = (CHAIR_SCALE, CHAIR_SCALE, CHAIR_SCALE)
print("Created chair (~0.94m tall). Modify named objects such as Seat or Backrest in follow-ups.")
