"""A tall native lamp with an uninterrupted two-pixel post and clear panes."""

import bpy

from pixel_art_mcp.pixel_art import Canvas, PixelArt

art = PixelArt(
    {"D": "#293743", "M": "#607f82", "H": "#a1c0bb", "G": "#e8ba61", "L": "#fff1b0"},
    {a: (16, 64) for a in (0, 90, 180, 270)},
)
for angle in (0, 90, 180, 270):
    body = Canvas(16, 64)
    body.rect(6, 19, 4, 40, "D").rect(7, 19, 2, 40, "M")
    body.rect(7, 20, 1, 36, "H")
    body.stamp(3, 57, ["...DDDD...", "..DMMMMD..", "..DMMMMD..", ".DMMMMMMD.", "DDDDDDDDDD"])
    body.stamp(
        3,
        3,
        [
            "....DD....",
            "...DMMD...",
            "..DMMMMD..",
            ".DMMMMMMD.",
            "DDDDDDDDDD",
            ".DGGDDGGD.",
            ".DLLDDLLD.",
            ".DLLDDLLD.",
            ".DLLDDLLD.",
            ".DLLDDLLD.",
            ".DGGDDGGD.",
            "..DDDDDD..",
            "...DMMD...",
            "....DD....",
        ],
    )
    body.rect(7, 16, 2, 3, "D")
    art.layer("post and housing", angle, body, min_pixels=220, connected=True)
art.save(bpy.context.scene)
