"""Pure-Python camera-fit arithmetic shared by blender/runner.py (inside the Blender
subprocess) and ordinary pytest outside it. No bpy/mathutils import -- callers pass
plain floats already reduced from mathutils.Vector world-space bounds.
"""

from dataclasses import dataclass
from typing import Any

TILE_PIXELS = 16  # Mirrors RenderOptions.tile_width/tile_height: 1 tile == 16px.


def fit_asset_views(
    layouts: list[dict[str, Any]],
    bounds: list[tuple[float, float, float, float]],
    anchors: list[tuple[float, float]] | None = None,
) -> list[dict[str, float]]:
    """One pixels-per-unit scale, stable per-view translation over the complete clip union."""
    limits = []
    centers = []
    for i, (layout, (xmin, xmax, ymin, ymax)) in enumerate(zip(layouts, bounds, strict=True)):
        x, y = anchors[i] if anchors else ((xmin + xmax) / 2, ymin)
        centers.append((x, y))
        half = max(xmax - x, x - xmin, 1e-6)
        limits.append((layout["width"] / 2 - layout["margin"]) / half)
        bottom = layout["bottom"] - (2 if anchors else 0)
        limits.append(
            min(layout["content_height"], bottom - layout["margin"]) / max(ymax - y, 1e-6)
        )
        if ymin < y:
            limits.append((layout["height"] - layout["margin"] - bottom) / (y - ymin))
    pixels_per_unit = min(limits)
    if pixels_per_unit <= 0:
        raise ValueError("Anchor lies above visible geometry; use its frontmost ground contact")
    return [
        {
            "pixels_per_unit": pixels_per_unit,
            "cx": x,
            "cy": y
            + (layout["bottom"] - (2 if anchors else 0) - layout["height"] / 2) / pixels_per_unit,
            "view_height": layout["height"] / pixels_per_unit,
        }
        for layout, (x, y) in zip(layouts, centers, strict=True)
    ]


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
