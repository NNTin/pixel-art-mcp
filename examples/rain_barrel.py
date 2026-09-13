"""A 12x20 barrel on the existing 16x32 canvas, with explicit feature budgets."""

import bpy

from pixel_art_mcp.pixel_art import Canvas, PixelArt

art = PixelArt(
    {
        "D": "#293039",
        "S": "#805437",
        "W": "#b78752",
        "H": "#dfb87b",
        "M": "#71818b",
        "G": "#f3cf65",
        "C": "#358fa6",
        "L": "#9ddacb",
    },
    {angle: (16, 32) for angle in (0, 90, 180, 270)},
)
body = Canvas(16, 32)
body.rect(2, 13, 12, 16, "D").rect(3, 13, 10, 15, "W")
body.rect(3, 14, 1, 13, "H").rect(11, 14, 2, 13, "S")
body.rect(5, 10, 6, 1, "D").rect(3, 11, 10, 1, "D")
body.rect(4, 11, 8, 1, "H").rect(2, 12, 12, 1, "D")
body.rect(3, 12, 10, 1, "H").rect(3, 14, 10, 1, "H")
for y in (15, 16, 17, 25, 26, 27, 28):
    body.rect(2, y, 1, 1, ".").rect(13, y, 1, 1, ".")
    body.rect(3, y, 1, 1, "D").rect(12, y, 1, 1, "D")
for y, color in ((15, "D"), (16, "M"), (17, "D"), (26, "D"), (27, "M"), (28, "D")):
    body.rect(4, y, 8, 1, color)
body.rect(5, 29, 6, 1, "D")
tap = Canvas.from_rows([".GGG..", "..G...", ".GGGG.", "....G.", "....G."])
surround = Canvas.from_rows(["DDDDD.", ".DDD..", "DDDDDD", ".DDDDD", "...DDD", "....D."])
for angle in (0, 90, 180, 270):
    art.layer("barrel", angle, body)
    # Controls belong to the front: the side has a projecting spout, the rear plain staves.
    if angle == 0:
        art.layer("tap surround", angle, surround, x=2, y=19)
        art.layer("faucet", angle, tap, x=2, y=19, min_pixels=10, connected=True)
    elif angle in (90, 270):
        side = Canvas.from_rows(["GG.", ".G.", ".GG", "..G"])
        art.layer(
            "side faucet",
            angle,
            side if angle == 90 else side.mirrored(),
            x=12 if angle == 90 else 1,
            y=20,
            min_pixels=6,
            connected=True,
        )
    else:
        seams = Canvas(5, 7).rect(0, 0, 1, 7, "S").rect(4, 0, 1, 7, "S")
        art.layer("rear staves", angle, seams, x=6, y=18)
    for level in range(3):
        for phase in range(9):
            frame = level * 10 + phase
            opening = Canvas.from_rows([".DDDDDD.", "DDDDDDDD", ".DDDDDD."])
            if level:
                opening = Canvas.from_rows([".CCCCCC.", "CCCCCCCC", ".CCCCCC."])
                opening.rect(2 + (phase % 2), 0, 3, 1, "L")
            art.layer(
                "opening", angle, opening, x=4, y=12, frame=frame, min_pixels=20, connected=True
            )
            if angle == 0:
                gauge = Canvas(4, 7).rect(0, 0, 4, 7, "D").rect(1, 1, 2, 5, "M")
                fill = (0, 2, 5)[level]
                if fill:
                    gauge.rect(1, 6 - fill, 2, fill, "C").rect(1, 6 - fill, 2, 1, "L")
                art.layer(
                    "level gauge",
                    angle,
                    gauge,
                    x=9,
                    y=18,
                    frame=frame,
                    min_pixels=28,
                    connected=True,
                )
            if phase:
                rain = Canvas(10, 8)
                for x, shift in ((0, 0), (4, 3), (8, 5)):
                    y = (phase + shift) % 6
                    rain.rect(x, y, 1, 2, "L")
                art.layer("rain", angle, rain, x=3, y=2, frame=frame)
art.save(bpy.context.scene)
