"""Native office worker: three walk poses and two distinct typing/reading poses."""

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
for angle in (0, 180, 90):
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
        head = Canvas(12, 14)
        head.rect(3, 0, 6, 1, "H").rect(1, 1, 10, 2, "H")
        head.rect(0, 3, 12, 5, "H").rect(1, 8, 10, 2, "S")
        head.rect(2, 10, 8, 1, "S").rect(3, 11, 6, 1, "S")
        head.rect(5, 12, 2, 2, "S").rect(2, 2, 7, 2, "h")
        if angle == 180:
            head.rect(1, 4, 10, 6, "H").rect(2, 4, 7, 4, "h")
            head.rect(3, 10, 6, 2, "H")
        elif angle == 90:
            head.rect(7, 5, 4, 4, "L").rect(6, 9, 4, 2, "L")
            head.rect(10, 7, 2, 2, "L").rect(9, 6, 1, 2, "D")
            head.rect(5, 7, 2, 2, "S").rect(8, 10, 2, 1, "H")
        else:
            head.rect(2, 5, 8, 5, "L").rect(2, 5, 2, 1, "H")
            head.rect(3, 7, 1, 2, "D").rect(8, 7, 1, 2, "D")
            head.rect(5, 9, 2, 1, "S").rect(3, 10, 6, 1, "L")
            head.rect(5, 10, 2, 1, "H")
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
