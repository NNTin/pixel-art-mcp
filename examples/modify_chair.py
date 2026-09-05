"""Run after chair.py, using the current expected_revision_id."""

import bpy

bpy.data.objects["Backrest"].location.z += 0.25
for obj in bpy.context.scene.objects:
    if obj.name.startswith("BackPost_"):
        obj.scale.z *= 1.45
        obj.location.z += 0.125

material = bpy.data.materials["WarmWood"]
material.diffuse_color = (0.12, 0.32, 0.6, 1)
material.node_tree.nodes["Principled BSDF"].inputs[
    "Base Color"
].default_value = material.diffuse_color
