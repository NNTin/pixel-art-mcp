"""Six-color lamp with a stable glass outline and a separately authored flame."""

from pixel_art_mcp.pixel_art import Canvas, PixelArt

art = PixelArt(
    {
        "D": "#303a42",
        "M": "#769b9c",
        "G": "#e0b854",
        "C": "#315963",
        "F": "#ea823d",
        "L": "#fff0af",
    },
    {a: (16, 32) for a in (0, 90, 180, 270)},
)
for angle in (0, 90, 180, 270):
    body = Canvas(16, 32)
    body.stamp(4, 3, ["..DDDD..", ".D....D.", "D......D", "D......D", "D......D", "D......D"])
    body.stamp(
        4,
        8,
        [
            "..DDDD..",
            ".DGGGGD.",
            "..DCCD..",
            "..MCCM..",
            ".MCCCCM.",
            ".MCCCCM.",
            ".MCCCCM.",
            ".MCCCCM.",
            ".MCCCCM.",
            "..MCCM..",
            "..DDDD..",
        ],
    )
    body.stamp(3, 19, ["..DDDDDD..", ".DGGGGGGD.", "DGGGGGGGGD", ".DDDDDDDD."])
    body.rect(7, 10, 1, 3, "L").rect(7, 18, 2, 1, "G")
    art.layer("lantern", angle, body)
    for frame in range(9):
        flame = Canvas(4, 6)
        if frame:
            flame.stamp(0, 0 if frame % 2 else 1, [".F..", ".FF.", "FLF.", "FLLF", ".FF."])
        art.layer(
            "flame",
            angle,
            flame,
            x=6,
            y=12,
            frame=frame,
            min_pixels=12 if frame else 0,
            connected=bool(frame),
        )
art.save(scene)
