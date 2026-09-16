"""Edit the previously saved chair revision in place: recolor the cushion and
add a stitched tuft mark, without resending any row the chair.py script
already authored. Demonstrates PixelArt.load(bpy.context.scene) for reading
back an existing scene's pixel_art definition inside execute_blender_python."""

import bpy

from pixel_art_mcp.pixel_art import Canvas, PixelArt

art = PixelArt.load(bpy.context.scene)
art.palette["C"] = "#aa466b"  # recolor the cushion pad from tan to a dusty rose
for layer in art.layers:
    if layer["name"] != "body":
        continue
    for pose in layer["poses"]:
        canvas = Canvas.from_rows(pose["rows"])
        if pose["angle"] in (0, 180):
            canvas.rect(6, 12, 4, 1, "D").rect(7, 13, 2, 3, "D")  # a small tufted stitch
        else:
            canvas.rect(5, 12, 2, 3, "D")
        pose["rows"] = canvas.rows
art.save(bpy.context.scene)
