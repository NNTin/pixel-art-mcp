"""Pure-Python camera-fit arithmetic shared by blender/runner.py (inside the Blender
subprocess) and ordinary pytest outside it. No bpy/mathutils import -- callers pass
plain floats already reduced from mathutils.Vector world-space bounds.
"""

from dataclasses import dataclass

TILE_PIXELS = 16  # Mirrors RenderOptions.tile_width/tile_height: 1 tile == 16px.


@dataclass(frozen=True)
class CameraFit:
    ortho_scale: float
    cx: float
    cy: float
    view_height: float


def fit_camera(
    *,
    base_width: float,
    base_height: float,
    xmin: float,
    xmax: float,
    ymin: float,
    ymax: float,
    padding: float,
    height: int,
    meters_per_tile: float | None,
) -> CameraFit:
    """meters_per_tile=None reproduces the auto-fit-to-bounding-box formula exactly:
    the camera zooms to fill the object's own bounds. meters_per_tile=<value> ignores
    the bounds for scale (still uses them for cx/cy centering) and derives a scale
    fixed purely from height/meters_per_tile/padding, so unrelated render jobs sharing
    the same meters_per_tile come out at consistent real-world zoom."""
    cx, cy = (xmin + xmax) / 2, (ymin + ymax) / 2
    if meters_per_tile is None:
        scale = max((xmax - xmin) / base_width, (ymax - ymin) / base_height, 0.001)
    else:
        scale = (height * meters_per_tile / TILE_PIXELS) / base_height
    scale *= 1 + 2 * padding
    return CameraFit(ortho_scale=scale, cx=cx, cy=cy, view_height=base_height * scale)


def row_pivot(
    *,
    width: int,
    height: int,
    cx: float,
    cy: float,
    view_width: float,
    view_height: float,
) -> list[float]:
    return [width * (0.5 - cx / view_width), height * (0.5 + cy / view_height)]
