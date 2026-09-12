"""Small dog: frames 1-3 walk, 4-6 idle. Use the pet profile; side frames widen automatically."""

import bpy


def material(name, color):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = mat.diffuse_color
    return mat


tan = material("Golden fur", (0.58, 0.28, 0.075))
dark = material("Dark nose and ears", (0.06, 0.033, 0.021))
cream = material("Cream muzzle", (0.8, 0.65, 0.4))


def box(name, location, size, mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    return obj


box("Body", (0, 0.05, 0.35), (0.35, 0.61, 0.31), tan)
head = box("Head", (0, -0.32, 0.54), (0.37, 0.32, 0.33), tan)
box("Muzzle", (0, -0.50, 0.48), (0.24, 0.13, 0.14), cream)
box("Nose", (0, -0.58, 0.52), (0.12, 0.05, 0.07), dark)
for side in (-1, 1):
    box(f"Ear {side}", (side * 0.19, -0.29, 0.66), (0.12, 0.18, 0.22), dark)
    box(f"Eye {side}", (side * 0.12, -0.49, 0.60), (0.055, 0.02, 0.055), dark)
legs = [
    box(f"Leg {i}", (x, y, 0.115), (0.11, 0.12, 0.23), tan)
    for i, (x, y) in enumerate([(-0.13, -0.18), (0.13, -0.18), (-0.13, 0.26), (0.13, 0.26)])
]
tail = box("Tail", (0, 0.43, 0.46), (0.11, 0.28, 0.12), tan)
tail.rotation_euler.x = 0.6
for frame in range(1, 7):
    step = {1: 0, 2: -1, 3: 1}.get(frame, 0)
    for i, leg in enumerate(legs):
        leg.rotation_euler.x = step * (0.32 if i in (0, 3) else -0.32)
        leg.keyframe_insert(data_path="rotation_euler", frame=frame)
    tail.rotation_euler.z = (frame % 3 - 1) * (0.3 if frame > 3 else 0.1)
    tail.keyframe_insert(data_path="rotation_euler", frame=frame)
scene = bpy.context.scene
scene.frame_start, scene.frame_end = 1, 6
scene.frame_set(1)
