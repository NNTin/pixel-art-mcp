"""Golden dog, with a longer side silhouette and consumer-specific walk/idle poses."""

from pixel_art_mcp.pixel_art import Canvas, PixelArt

art = PixelArt(
    {
        "D": "#453c42",
        "S": "#ad7846",
        "W": "#dca354",
        "H": "#f2d38c",
        "N": "#292f39",
        "R": "#c75b62",
    },
    {0: (16, 32), 180: (16, 32), 90: (32, 32)},
)
for angle in (0, 180, 90):
    for frame in range(1, 7):
        phase = (0, -1, 1, 0, -1, 1)[frame - 1]
        canvas = Canvas(32 if angle == 90 else 16, 32)
        if angle == 90:
            canvas.stamp(
                6,
                18,
                [
                    "..WWWWWWWWWW....",
                    ".WHHHHHHHHHWW...",
                    "WWHHHHHHHHHWWW..",
                    "WWHHHHHHHHWWWW..",
                    ".WWWWWWWWWWWW...",
                    "..WWWWWWWWWW....",
                ],
            )
            canvas.rect(8 + phase, 24, 3, 5, "S").rect(17 - phase, 24, 3, 5, "W")
            canvas.rect(7 + phase, 28, 4, 2, "D").rect(17 - phase, 28, 4, 2, "D")
            canvas.stamp(
                20,
                13,
                [
                    "..WWWW..",
                    ".WHHHHW.",
                    "SWHHHNWW",
                    "SSHHHHHW",
                    "SSWWWNNN",
                    ".WWWHHH.",
                    "..WWW...",
                ],
            )
            canvas.stamp(2, 15 + phase, ["WW..", ".WW.", "..WW", "...W", "...W"])
        else:
            canvas.rect(4, 20, 8, 7, "S").rect(5, 20, 6, 6, "W")
            canvas.rect(4, 26 + min(phase, 0), 3, 3, "W")
            canvas.rect(9, 26 - max(phase, 0), 3, 3, "W")
            canvas.rect(4, 29 + min(phase, 0), 3, 1, "D")
            canvas.rect(9, 29 - max(phase, 0), 3, 1, "D")
            if angle == 0:
                canvas.stamp(
                    2,
                    13,
                    [
                        "...WWWWWW...",
                        "..WHHHHHHW..",
                        ".SWHHHHHHWS.",
                        ".SSHNHHNHSS.",
                        ".SSHNNNNHSS.",
                        "..SHHNNHHS..",
                        "...WHHHHW...",
                        "....WWWW....",
                    ],
                )
                if frame == 5:
                    canvas.rect(6, 16, 1, 1, "H").rect(9, 16, 1, 1, "H")
                if frame == 6:
                    canvas.rect(7, 19, 2, 2, "R")
            else:
                canvas.stamp(
                    2,
                    13,
                    [
                        "...WWWWWW...",
                        "..WWWHHWWW..",
                        ".SWWWHHWWWS.",
                        ".SSWWWWWWSS.",
                        ".SSWWWWWWSS.",
                        "..SWWWWWWS..",
                        "...WWWWWW...",
                        "....WWWW....",
                    ],
                )
                canvas.stamp(6 + phase, 21, ["WW", "HW", "HW", "WW"])
        art.layer("dog", angle, canvas, frame=frame, min_pixels=110)
art.save(scene)
