"""A barrel drawn top-down 3/4 (dominant mouth/opening, compressed staves
below), matching pixel-agents' own camera convention instead of a flat front
elevation. Explicit feature budgets throughout."""

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
body = Canvas.from_rows(
    [
        "..DDDDDDDDDDDD..",
        "...DHHHHHHHHD...",
        "..DHHHHHHHHHHD..",
        "..DHHHHHHHHHHD..",
        "...DDDDDDDDDD...",
        "...DMMMMMMMMD...",
        "..DHWWWWWWWSSD..",
        "..DHWWWWWWWSSD..",
        "..DHWWWWWWWSSD..",
        "..DHWWWWWWWSSD..",
        "..DHWWWWWWWSSD..",
        "..DHWWWWWWWSSD..",
        "...DWWWWWWWSD...",
        "...DDDDDDDDDD...",
        "...DDDDDDDDDD...",
        ".....DDDDDD.....",
    ]
)
tap = Canvas.from_rows([".GGG..", "..G...", ".GGGG.", "....G.", "....G."])
surround = Canvas.from_rows(["DDDDD.", ".DDD..", "DDDDDD", ".DDDDD", "...DDD", "....D."])
# Feature-budget shift: the barrel body now starts 4 rows lower (y=14 instead
# of y=10) to make room for the enlarged opening above it -- every small
# accessory attached to the body (tap, gauge, side spout, rear seams) moves
# down by the same 4 rows so it still sits against the body correctly.
BODY_TOP = 14
SHIFT = 4
# The mouth's D fill (barrel-body dark) is only 13 luma units from the webview
# floor's own dark tile color, and now dominates most of the sprite -- solid D
# reads as a hole punched through the sprite into the background rather than
# an opening. Trace a lighter metal-rim highlight (M, already the barrel's
# hoop-band color) one pixel in from the mouth's outline so it stays a single
# connected surface but no longer merges with the floor.
MOUTH = (
    {(x, y) for x in range(1, 11) for y in range(0, 4)}
    | {(x, y) for x in range(0, 12) for y in range(4, 9)}
    | {(x, y) for x in range(1, 11) for y in range(9, 13)}
)
DELTAS = ((1, 0), (-1, 0), (0, 1), (0, -1))
MOUTH_RIM = {p for p in MOUTH if any((p[0] + dx, p[1] + dy) not in MOUTH for dx, dy in DELTAS)}
for angle in (0, 90, 180, 270):
    art.layer("barrel", angle, body, y=BODY_TOP)
    # Controls belong to the front: the side has a projecting spout, the rear plain staves.
    if angle == 0:
        art.layer("tap surround", angle, surround, x=2, y=19 + SHIFT)
        art.layer("faucet", angle, tap, x=2, y=19 + SHIFT, min_pixels=10, connected=True)
    elif angle in (90, 270):
        side = Canvas.from_rows(["GG.", ".G.", ".GG", "..G"])
        art.layer(
            "side faucet",
            angle,
            side if angle == 90 else side.mirrored(),
            x=12 if angle == 90 else 1,
            y=20 + SHIFT,
            min_pixels=6,
            connected=True,
        )
    else:
        seams = Canvas(5, 7).rect(0, 0, 1, 7, "S").rect(4, 0, 1, 7, "S")
        art.layer("rear staves", angle, seams, x=6, y=18 + SHIFT)
    for level in range(3):
        for phase in range(9):
            frame = level * 10 + phase
            # A wide, mostly-full mouth (dominant top surface): a 4-row taper,
            # a 5-row wide band, then another 4-row taper -- see it from above.
            opening = Canvas(12, 13)
            for x, y in MOUTH:
                opening.rect(x, y, 1, 1, "M" if (x, y) in MOUTH_RIM else "D")
            if level:
                opening = Canvas(12, 13)
                opening.rect(1, 0, 10, 4, "C").rect(0, 4, 12, 5, "C").rect(1, 9, 10, 4, "C")
                opening.rect(3 + (phase % 2), 0, 5, 4, "L")
            art.layer(
                "opening", angle, opening, x=2, y=2, frame=frame, min_pixels=60, connected=True
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
                    y=18 + SHIFT,
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
