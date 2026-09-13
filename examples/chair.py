"""Four native chair views with readable seat, backrest and separated legs."""

import bpy

from pixel_art_mcp.pixel_art import Canvas, PixelArt

art = PixelArt(
    {"D": "#263b3b", "W": "#946143", "H": "#d5a66d", "C": "#4f9c85", "T": "#94ceb0"},
    {a: (16, 32) for a in (0, 90, 180, 270)},
)
for angle in (0, 90, 180, 270):
    legs = Canvas(16, 32)
    legs.rect(3, 21, 2, 9, "D").rect(11, 21, 2, 9, "D")
    legs.rect(4, 23, 1, 5, "W").rect(11, 23, 1, 5, "W")
    art.layer("legs", angle, legs)
    seat = Canvas.from_rows(
        [
            "..DDDDDDDD..",
            ".DTTTTTTTTD.",
            "DCCCCCCCCCCD",
            "DCCCCCCCCCCD",
            ".DWWWWWWWWD.",
            "..DDDDDDDD..",
        ]
    )
    art.layer(
        "seat",
        angle,
        seat,
        x=2,
        y=18,
        min_pixels={0: 50, 90: 48, 180: 20, 270: 48}[angle],
        connected=True,
    )
    back = Canvas(16, 32)
    if angle in (0, 180):
        back.rect(3, 10, 10, 2, "D").rect(4, 10, 8, 1, "H")
        back.rect(3, 12, 2, 9, "D").rect(11, 12, 2, 9, "D")
        back.rect(4, 12, 1, 7, "W").rect(11, 12, 1, 7, "H")
        back.rect(5, 12, 6, 5, "C" if angle == 0 else "W")
        back.rect(5, 12, 6, 1, "T" if angle == 0 else "H")
        back.rect(5, 17, 6, 1, "D")
        if angle == 180:
            back.rect(5, 18, 6, 5, "W")
    else:
        back.rect(2, 10, 3, 13, "D").rect(3, 11, 1, 11, "H")
        back.rect(5, 13, 1, 6, "C")
        if angle == 270:
            back = back.mirrored()
    art.layer("backrest", angle, back, min_pixels=25, connected=True)
art.save(bpy.context.scene)
