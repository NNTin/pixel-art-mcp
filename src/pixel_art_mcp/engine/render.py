"""Builds blank per-view/per-frame canvases and the frame manifest that
imaging/asset_export.py and friends composite authored pixels onto."""

from collections.abc import Callable
from pathlib import Path
from typing import Any

from PIL import Image

from pixel_art_mcp.pixel_art import PixelArt


def native_render(
    options: dict[str, Any],
    output: Path,
    art: PixelArt,
    progress: Callable[[str, int, int], None],
) -> dict[str, Any]:
    manifest: dict[str, Any] = {
        "pixel_art": art.to_dict(),
        "frames": [],
        "camera": {"projection": "native-grid", "views": [], "alignment": "authored pixels"},
    }
    for row, layout in enumerate(options["asset_layouts"]):
        w, h = layout["width"], layout["height"]
        pivot = [w / 2, layout["bottom"]]
        manifest["camera"]["views"].append({**layout, "pivot": pivot, "objects": []})
        blank = Image.new(
            "RGBA",
            (w * options["supersampling"], h * options["supersampling"]),
            (0, 0, 0, 0),
        )
        for frame in options["frame_sequence"]:
            filename = f"view_{row:02d}_frame_{frame:06d}.png"
            blank.save(output / filename)
            manifest["frames"].append(
                {
                    "filename": filename,
                    "angle": layout["angle"],
                    "frame": frame,
                    "pivot": pivot,
                    "size": [w, h],
                    "pixel_layers": art.poses(layout["angle"], frame),
                }
            )
            progress(
                "rendering",
                len(manifest["frames"]),
                len(options["frame_sequence"]) * len(options["asset_layouts"]),
            )
    return manifest
