"""An office worker redrawn from scratch for pixel-agents' downward-tilted
3/4 camera: hair dominates the head box on every front/side view with eyes
pushed low, and the back view is pure hair with no face at all. Three walk
poses (left step / neutral / right step) plus two typing and two reading
poses -- an original interpretation, not copied from any reference sheet."""

import bpy

from pixel_art_mcp.pixel_art import Canvas, PixelArt

art = PixelArt(
    {
        "N": "#2c2420",
        "n": "#4a3c33",
        "S": "#d99b74",
        "s": "#b97852",
        "E": "#241f1c",
        "C": "#3a6ea5",
        "c": "#6fa8d8",
        "P": "#33465e",
        "B": "#e9e2c8",
        "R": "#c2564f",
    },
    {angle: (16, 32) for angle in (0, 180, 90)},
)

HEADS = {
    0: Canvas.from_rows(
        [
            "....NNNNNN....",
            "..NNNNNNNNNN..",
            ".NnnnnnnnnnnN.",
            "NNnnnnnnnnnnNN",
            "NNNNNNNNNNNNNN",
            "NNNNNNNNNNNNNN",
            "NNNNSSSSSSNNNN",
            "..SSSSSSSSSS..",
            "..SEsSSSsESS..",
            "...SssssssS...",
            "....SssssS....",
        ]
    ),
    180: Canvas.from_rows(
        [
            "....NNNNNN....",
            "..NNNNNNNNNN..",
            ".NnnnnnnnnnnN.",
            "NNnnnnnnnnnnNN",
            "NNnnnnnnnnnnNN",
            "NNnnnnnnnnnnNN",
            "NNnnnnnnnnnnNN",
            "..NNNNNNNNNN..",
            "..NNNNNNNNNN..",
            "...NNNNNNNN...",
            "....NNNNNN....",
        ]
    ),
    90: Canvas.from_rows(
        [
            "....NNNNNN....",
            "..NNNNNNNNNN..",
            ".NnnnnnnnnnnN.",
            "NNnnnnnnnnnnNN",
            "NNNNNNNNNNNNNN",
            "NNNNNNNNNSSSNN",
            "NNNNNNNNSEsSNN",
            "..NNNNNNSssS..",
            "..NNNNSsssS...",
            "...NNSsssS....",
            "....NSssS.....",
        ]
    ),
}

for angle in (0, 180, 90):
    head = HEADS[angle]
    for frame in range(1, 8):
        working = frame >= 4
        step = 0 if working else (1, 0, -1)[frame - 1]
        torso = Canvas(16, 32)
        if angle == 90:
            torso.rect(5, 16, 6, 8, "P").rect(6, 16, 4, 7, "C").rect(6, 16, 3, 1, "c")
            torso.rect(4 + step, 27, 4, 3, "N").rect(8 - step, 27, 4, 3, "N")
        else:
            torso.rect(4, 16, 8, 8, "P").rect(5, 16, 6, 7, "C").rect(5, 16, 6, 1, "c")
            torso.rect(4, 27 - max(step, 0), 4, 3, "N")
            torso.rect(8, 27 - max(-step, 0), 4, 3, "N")
        art.layer("torso", angle, torso, frame=frame)
        art.layer("head", angle, head, x=1, y=2, frame=frame, min_pixels=110, connected=True)
        arms = Canvas(16, 32)
        if working:
            desk_y = 19 + frame % 2
            if angle == 90:
                arms.rect(9, desk_y, 4, 2, "S").rect(6, desk_y, 4, 2, "s")
            else:
                arms.rect(3, desk_y, 3, 2, "S").rect(10, desk_y, 3, 2, "S")
            if frame >= 6:
                width = 6 if angle != 90 else 4
                x = 5 if angle != 90 else 8
                arms.rect(x, 20, width, 3, "B")
                arms.rect(x + width // 2, 20, 1, 3, "R")
        else:
            if angle == 90:
                arms.rect(9, 18 + step, 2, 4, "s")
            else:
                arms.rect(2, 18 + step, 2, 4, "S").rect(12, 18 - step, 2, 4, "S")
        art.layer("arms and work", angle, arms, frame=frame, min_pixels=6)
art.save(bpy.context.scene)
