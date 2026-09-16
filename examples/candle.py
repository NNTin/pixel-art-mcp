"""A surface candle: the entire silhouette fits the profile's seven useful rows."""

from pixel_art_mcp.pixel_art import Canvas, PixelArt

art = PixelArt(
    {"D": "#47404a", "W": "#f0dfb2", "S": "#b7a980", "F": "#ee9046", "L": "#fff2a5"},
    {a: (16, 16) for a in (0, 90, 180, 270)},
)
for angle in (0, 90, 180, 270):
    body = Canvas.from_rows([".WWW.", ".WSW.", ".WSW.", "DDDDD", ".DDD."])
    art.layer("wax and dish", angle, body, x=5, y=3, min_pixels=16, connected=True)
    art.layer(
        "flame",
        angle,
        Canvas.from_rows([".F.", "FLF", ".L."]),
        x=6,
        y=1,
        min_pixels=5,
        connected=True,
    )
art.save(scene)
