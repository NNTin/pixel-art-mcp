"""A rain barrel redrawn from scratch: the mouth/opening dominates the sprite
as pixel-agents' downward-tilted 3/4 camera expects, and its dark "empty"
interior is deliberately kept far from the webview floor's own luma (see
asset_report's low_context_contrast check) instead of relying on a flat fill
that happens to read the same as the background."""

import bpy

from pixel_art_mcp.pixel_art import Canvas, PixelArt

art = PixelArt(
    {
        "D": "#20262c",
        "W": "#c98a4b",
        "S": "#8a5a30",
        "M": "#b7c4c9",
        "H": "#e4c98a",
        "C": "#2f8fae",
        "L": "#bdeff0",
        "G": "#d7b23a",
    },
    {angle: (16, 32) for angle in (0, 90, 180, 270)},
)

# The cask: a static cylinder of staves, unaffected by fill level or rain.
# STAVE_TOP is the absolute row where the barrel's own body begins; the
# mouth (drawn separately, below) overlaps its top two collar rows so that
# collar shows through on both sides of the opening and frames it, instead
# of the opening sitting on the body as a borderless patch.
STAVE_TOP = 13


def build_cask(seam_x: tuple[int, ...]) -> Canvas:
    # Seams are baked into this same canvas/feature (not a separate occluding
    # layer) so decorative texture never fragments the cask's own connectivity.
    cask = Canvas(16, 32)
    cask.rect(2, STAVE_TOP, 12, 2, "H")  # top hoop, lets the mouth's taper overlap it
    cask.rect(1, STAVE_TOP + 2, 14, 15, "W")  # main cylinder
    cask.rect(1, STAVE_TOP + 2, 1, 15, "D").rect(14, STAVE_TOP + 2, 1, 15, "D")
    for x in seam_x:
        cask.rect(x, STAVE_TOP + 5, 1, 9, "S")
    cask.rect(1, 29, 14, 1, "D")  # bottom hoop
    return cask


front_cask = build_cask((4, 11))
side_cask = build_cask((7,))
back_cask = build_cask((5, 8, 11))

# The mouth: a rounded 14-row-tall opening, built the same way as any other
# feature -- a point set, not a stack of rects -- so the rim and fill can
# share one shape. Only its top rows (y<STAVE_TOP-1) are exposed against
# open background; the bottom two rows sink into the cask's own hoop.
MOUTH = (
    {(x, y) for x in range(5, 11) for y in (1, 2)}
    | {(x, y) for x in range(3, 13) for y in range(3, 12)}
    | {(x, y) for x in range(5, 11) for y in range(12, 15)}
)
DELTAS = ((1, 0), (-1, 0), (0, 1), (0, -1))
EXPOSED = {p for p in MOUTH if p[1] < STAVE_TOP - 1}
RIM = {p for p in EXPOSED if any((p[0] + dx, p[1] + dy) not in MOUTH for dx, dy in DELTAS)}
WATERLINE = {0: 15, 1: 6, 2: 2}  # local y within the mouth; empty/partial/full

for angle in (0, 90, 180, 270):
    cask = {0: front_cask, 180: back_cask}.get(angle, side_cask)
    art.layer("cask", angle, cask, min_pixels=180, connected=True)
    if angle == 0:
        tap = Canvas.from_rows([".GG..", "GGGG.", ".GG..", "..GG.", "..GG."])
        art.layer("faucet", angle, tap, x=2, y=21, min_pixels=9, connected=True)
    elif angle in (90, 270):
        spout = Canvas.from_rows(["GG.", ".G.", ".GG"])
        art.layer(
            "side faucet",
            angle,
            spout if angle == 90 else spout.mirrored(),
            x=12 if angle == 90 else 1,
            y=22,
            min_pixels=5,
            connected=True,
        )
    for level in range(3):
        for phase in range(9):
            frame = level * 10 + phase
            waterline = WATERLINE[level]
            opening = Canvas(12, 14)
            for x, y in MOUTH:
                lx, ly = x - 3, y - 1
                if not 0 <= lx < 12 or not 0 <= ly < 14:
                    continue
                if (x, y) in RIM:
                    color = "M"
                elif ly >= waterline:
                    color = "C"
                else:
                    color = "S" if ly < 3 else "D"
                opening.pixels[ly][lx] = color
            if level and phase:
                glint_x = 3 + (phase % 3)
                for gy in range(waterline, min(waterline + 2, 14)):
                    if opening.pixels[gy][glint_x] != ".":
                        opening.pixels[gy][glint_x] = "L"
            art.layer(
                "opening", angle, opening, x=3, y=1, frame=frame, min_pixels=48, connected=True
            )
            if angle == 0:
                gauge = Canvas(4, 6).rect(0, 0, 4, 6, "D").rect(1, 1, 2, 4, "M")
                fill = (0, 2, 4)[level]
                if fill:
                    gauge.rect(1, 5 - fill, 2, fill, "C").rect(1, 5 - fill, 2, 1, "L")
                art.layer(
                    "level gauge",
                    angle,
                    gauge,
                    x=10,
                    y=19,
                    frame=frame,
                    min_pixels=24,
                    connected=True,
                )
            if phase:
                rain = Canvas(10, 10)
                for x, shift in ((0, 0), (4, 4), (8, 2)):
                    y = (phase * 2 + shift) % 9
                    rain.rect(x, y, 1, 2, "L")
                art.layer("rain", angle, rain, x=3, y=0, frame=frame)
art.save(bpy.context.scene)
