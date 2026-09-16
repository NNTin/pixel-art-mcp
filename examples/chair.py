"""A cushioned chair, drawn from scratch for pixel-agents' downward-tilted
3/4 camera: the cushion top dominates the sprite, with only a thin frame
edge and legs visible at the very bottom -- no reference art was consulted,
this is an original top-down interpretation."""

import bpy

from pixel_art_mcp.pixel_art import Canvas, PixelArt

art = PixelArt(
    {"D": "#2c2018", "F": "#6b4a34", "C": "#caa06a", "T": "#efd9ab", "L": "#efe6cf"},
    {angle: (16, 32) for angle in (0, 90, 180, 270)},
)

# The seat cushion, seen almost flat-on from above: a wide rounded pad
# (T highlight center, C shading toward the edges) framed by a thin wood
# lip (F). This single "body" layer carries the whole silhouette so every
# view stays one connected shape.
front = Canvas(16, 32)
front.rect(2, 4, 12, 2, "F")  # backrest sliver, barely visible from this camera
front.rect(1, 6, 14, 18, "F")  # cushion frame
front.rect(2, 7, 12, 16, "C")  # cushion pad
front.rect(3, 8, 10, 12, "T")  # cushion highlight (top-lit center)
front.rect(1, 24, 14, 2, "D")  # seat apron
front.rect(2, 26, 2, 5, "D").rect(12, 26, 2, 5, "D")  # front legs
front.rect(2, 30, 2, 1, "L").rect(12, 30, 2, 1, "L")  # floor contact glint

back = Canvas(16, 32)
back.rect(2, 2, 12, 5, "F")  # backrest, fully exposed from behind
back.rect(3, 3, 10, 3, "D")
back.rect(1, 7, 14, 17, "F")
back.rect(2, 8, 12, 15, "C")
back.rect(3, 9, 10, 11, "T")
back.rect(1, 24, 14, 2, "D")
back.rect(2, 26, 2, 5, "D").rect(12, 26, 2, 5, "D")
back.rect(2, 30, 2, 1, "L").rect(12, 30, 2, 1, "L")

side = Canvas(16, 32)
side.rect(1, 3, 4, 3, "F")  # backrest post, seen edge-on
side.rect(1, 6, 14, 18, "F")
side.rect(2, 7, 12, 16, "C")
side.rect(2, 8, 8, 12, "T")
side.rect(1, 24, 14, 2, "D")
side.rect(2, 26, 2, 5, "D").rect(11, 26, 2, 5, "D")
side.rect(2, 30, 2, 1, "L").rect(11, 30, 2, 1, "L")

for angle, body in ((0, front), (180, back), (90, side), (270, side.mirrored())):
    art.layer("body", angle, body, min_pixels=140, connected=True)
art.save(bpy.context.scene)
