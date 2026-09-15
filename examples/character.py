"""Native office worker: three walk poses and two distinct typing/reading poses.

Heads are drawn top-down 3/4 (more hair coverage, eyes pushed down near the
bottom of the head box) matching pixel-agents' own char_0.png reference
sprite sheet instead of a flat front elevation with a fully exposed face.
"""

import bpy

from pixel_art_mcp.pixel_art import Canvas, PixelArt

art = PixelArt(
    {
        "D": "#28333e",
        "H": "#543a3c",
        "h": "#855451",
        "S": "#d8a083",
        "L": "#f2c7a3",
        "C": "#348b90",
        "T": "#74bdb1",
        "P": "#465576",
        "B": "#e6dfc5",
        "R": "#b96662",
    },
    {a: (16, 32) for a in (0, 180, 90)},
)
HEADS = {
    0: Canvas.from_rows(
        [
            "...HHHHHH...",
            ".HHHHHHHHHH.",
            ".HhhhhhhhHH.",
            "HHhhhhhhhHHH",
            "HHHHHHHHHHHH",
            "HHHHHHHHHHHH",
            "HHHHHHHHHHHH",
            "HHHHLLLLLLHH",
            "HHLLLLLLLLHH",
            "HHLDLLLLDLHH",
            ".SLDLLLLDLS.",
            ".SLLLSSLLLS.",
            "..SLLHHLLS..",
            "...SSSSSS...",
        ]
    ),
    180: Canvas.from_rows(
        [
            "...HHHHHH...",
            ".HHHHHHHHHH.",
            ".HhhhhhhhHH.",
            "HHhhhhhhhHHH",
            "HHhhhhhhhHHH",
            "HHhhhhhhhHHH",
            "HHhhhhhhhHHH",
            "HHhhhhhhhHHH",
            ".HHHHHHHHHH.",
            ".HHHHHHHHHH.",
            "..SHHHHHHS..",
            "...HHHHHH...",
            ".....SS.....",
            ".....SS.....",
        ]
    ),
    90: Canvas.from_rows(
        [
            "...HHHHHH...",
            ".HHHHHHHHHH.",
            ".HhhhhhhhHH.",
            "HHhhhhhhhHHH",
            "HHHHHHHHHHHH",
            "HHHHHHHHHHHH",
            "HHHHHHHHHHHH",
            "HHHHHHHLLLLH",
            "HHHHHHHLLDLH",
            "HHHHHSSLLDLL",
            ".SSSSSSLLLLL",
            ".SSSSSLLLLS.",
            "..SSSSLLHH..",
            "...SSSSSS...",
        ]
    ),
}
for angle in (0, 180, 90):
    head = HEADS[angle]
    for frame in range(1, 8):
        work = frame >= 4
        step = (1, 0, -1)[frame - 1] if not work else 0
        body = Canvas(16, 32)
        if angle == 90:
            body.rect(5, 17, 6, 7, "D").rect(6, 17, 4, 6, "C")
            body.rect(6, 17, 2, 1, "T")
            body.rect(6, 24, 4, 4, "P")
            body.rect(4 + step, 28, 4, 2, "D").rect(8 - step, 28, 4, 2, "D")
        else:
            body.rect(4, 17, 8, 7, "D").rect(5, 17, 6, 6, "C")
            body.rect(5, 17, 6, 1, "T")
            body.rect(5, 24, 6, 4, "P").rect(7, 25, 2, 3, "D")
            body.rect(4, 28 - max(step, 0), 4, 2, "D")
            body.rect(8, 28 - max(-step, 0), 4, 2, "D")
        art.layer("body", angle, body, frame=frame)
        art.layer("head", angle, head, x=2, y=3, frame=frame, min_pixels=124, connected=True)
        hands = Canvas(16, 32)
        if work:
            y = 20 + frame % 2
            if angle == 90:
                hands.rect(10, y, 3, 2, "L").rect(8, y + 1, 3, 2, "S")
            else:
                hands.rect(3, y, 3, 2, "L").rect(10, y + (frame % 2), 3, 2, "S")
            if frame >= 6:
                hands.rect(5 if angle != 90 else 10, 21, 5 if angle != 90 else 3, 3, "B")
                hands.rect(7 if angle != 90 else 11, 21, 1, 3, "R")
        else:
            hands.rect(3 if angle != 90 else 8, 19 + step, 2, 3, "S")
            if angle != 90:
                hands.rect(11, 19 - step, 2, 3, "L")
        art.layer("hands and work", angle, hands, frame=frame, min_pixels=6)
art.save(bpy.context.scene)
