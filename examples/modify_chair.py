"""Edit the previous saved chair revision, retaining named views and layers."""

import bpy

from pixel_art_mcp.pixel_art import Canvas, PixelArt

art = PixelArt.load(bpy.context.scene)
art.palette["C"], art.palette["T"] = "#aa466b", "#e69eb0"
for layer in art.layers:
    if layer["name"] != "backrest":
        continue
    for pose in layer["poses"]:
        canvas = Canvas.from_rows(pose["rows"])
        if pose["angle"] in (0, 180):
            canvas.rect(3, 8, 10, 2, "D").rect(4, 8, 8, 1, "H")
            canvas.rect(4, 9, 8, 2, "C").rect(5, 9, 6, 1, "T")
        else:
            x = 2 if pose["angle"] == 90 else 11
            canvas.rect(x, 8, 3, 3, "D").rect(x + 1, 9, 1, 2, "H")
        pose["rows"] = canvas.rows
art.save(bpy.context.scene)
