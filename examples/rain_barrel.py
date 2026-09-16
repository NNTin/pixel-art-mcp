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
# The body is 20 rows tall (was 16), for a taller, more cylindrical barrel
# rather than one squashed short by an oversized mouth. BODY_TOP keeps the
# body's bottom at the same y=29 it always had (10 + 20 - 1).
BODY_TOP = 10
# The mouth is narrower than the body (8 wide at its band, vs. the body's 12)
# and sits low enough to overlap the body's own H highlight collar (rows 1-3
# of `body`, immediately below BODY_TOP): that collar is wider than the mouth,
# so it shows through on both sides as a wood-toned rim framing the opening --
# the same technique the pre-#22 design used to make the mouth read as a hole
# in the barrel rather than a flat patch sitting on top of it. Without this
# overlap the mouth had no visible frame and the faucet/gauge, offset from a
# stale pre-shrink BODY_TOP, sat far lower on the body than intended.
MOUTH = (
    {(x, y) for x in range(2, 9) for y in range(0, 2)}
    | {(x, y) for x in range(1, 10) for y in range(2, 5)}
    | {(x, y) for x in range(2, 9) for y in range(5, 7)}
)
DELTAS = ((1, 0), (-1, 0), (0, 1), (0, -1))
MOUTH_RIM = {p for p in MOUTH if any((p[0] + dx, p[1] + dy) not in MOUTH for dx, dy in DELTAS)}
for angle in (0, 90, 180, 270):
    art.layer("barrel", angle, body, y=BODY_TOP)
    # Controls sit in the mid-band of staves, not crammed against the bottom
    # rim -- these are absolute canvas offsets, independent of BODY_TOP.
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
            # A wide mouth seen from above: a 2-row taper, a 3-row wide band,
            # then another 2-row taper. Sits low enough (y=6, not y=2) to
            # overlap the body's own H highlight collar, which is wider than
            # the mouth and frames it in wood on both sides.
            #
            # Rows below `waterline` are wet (C); above it, dry (D). Partial
            # and full must show different water lines -- filling the whole
            # mouth for both looked identical and hid which state was which.
            # The rim (M) takes priority over both: it borders the part of
            # the mouth exposed against open background (y<4) regardless of
            # whether what's inside is dry or full to the brim, so a "full"
            # mouth still reads as a rimmed opening instead of a borderless
            # water patch merging straight into the background.
            waterline = {0: 7, 1: 3, 2: 0}[level]
            opening = Canvas(12, 7)
            for x, y in MOUTH:
                if (x, y) in MOUTH_RIM and y < 4:
                    color = "M"
                elif y < waterline:
                    color = "D"
                else:
                    color = "C"
                opening.rect(x, y, 1, 1, color)
            if level:
                glint_y = max(waterline, 0)
                opening.rect(2 + (phase % 2), glint_y, 5, min(2, 7 - glint_y), "L")
            art.layer(
                "opening", angle, opening, x=2, y=6, frame=frame, min_pixels=45, connected=True
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
