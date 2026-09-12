"""Game character: frames 1-3 walk, 4-5 type, 6-7 read. Use the character profile."""

import bpy


def material(name, color):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = mat.diffuse_color
    return mat


skin = material("Skin", (0.64, 0.34, 0.17))
hair = material("Hair", (0.07, 0.035, 0.025))
shirt = material("Blue shirt", (0.055, 0.25, 0.58))
trousers = material("Trousers", (0.055, 0.08, 0.12))
paper = material("Book pages", (0.85, 0.80, 0.61))


def box(name, location, size, mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    return obj


box("Head", (0, 0, 1.00), (0.46, 0.36, 0.40), skin)
box("Hair cap", (0, 0.015, 1.20), (0.49, 0.39, 0.12), hair)
box("Hair back", (0, 0.18, 1.06), (0.48, 0.08, 0.27), hair)
for x in (-0.105, 0.105):
    box(f"Eye {x}", (x, -0.185, 1.02), (0.065, 0.025, 0.06), hair)
box("Torso", (0, 0, 0.66), (0.40, 0.27, 0.37), shirt)
arms, legs = [], []
for side in (-1, 1):
    arms.append(box(f"Arm {side}", (side * 0.28, 0, 0.65), (0.14, 0.22, 0.36), shirt))
    box(f"Hand {side}", (side * 0.28, -0.005, 0.45), (0.14, 0.22, 0.12), skin).parent = arms[-1]
    # Keep parenting in world space so both sleeve and hand move together.
    hand = bpy.context.object
    hand.matrix_parent_inverse = arms[-1].matrix_world.inverted()
    legs.append(box(f"Leg {side}", (side * 0.115, 0, 0.23), (0.18, 0.26, 0.44), trousers))
book = box("Reading book", (0, -0.29, 0.61), (0.36, 0.11, 0.25), paper)
for frame in range(1, 8):
    walking = frame <= 3
    step = (frame - 2) if walking else 0
    for i, (arm, leg) in enumerate(zip(arms, legs, strict=True)):
        sign = -1 if i == 0 else 1
        leg.location.y = sign * step * 0.09
        arm.location.y = -sign * step * 0.09 if walking else -0.22
        arm.rotation_euler.x = 0 if walking else 0.9 + 0.12 * (frame % 2)
        for obj in (leg, arm):
            obj.keyframe_insert(data_path="location", frame=frame)
            obj.keyframe_insert(data_path="rotation_euler", frame=frame)
    book.hide_render = frame < 6
    book.keyframe_insert(data_path="hide_render", frame=frame)
scene = bpy.context.scene
scene.frame_start, scene.frame_end = 1, 7
scene.frame_set(1)
