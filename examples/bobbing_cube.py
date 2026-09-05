"""New project: render frames 1–8 at 12 FPS, with any desired directions."""

import math

import bpy

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
bpy.context.scene.frame_start = 1
bpy.context.scene.frame_end = 8
bpy.context.scene.render.fps = 12
for frame in range(1, 9):
    phase = (frame - 1) / 8 * math.tau
    cube.location.z = 0.75 + 0.25 * math.sin(phase)
    cube.rotation_euler.z = phase / 8
    cube.keyframe_insert(data_path="location", frame=frame)
    cube.keyframe_insert(data_path="rotation_euler", frame=frame)
