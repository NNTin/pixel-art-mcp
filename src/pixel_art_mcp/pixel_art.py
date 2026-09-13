"""Native-grid authoring shared by Blender scripts and the exporter (stdlib only)."""

import json
import re
from typing import Any


class Canvas:
    """Integer pixels, top-left origin. A dot is transparent, never an eraser."""

    def __init__(self, width: int, height: int):
        if not 1 <= width <= 512 or not 1 <= height <= 512:
            raise ValueError("Canvas dimensions must be in 1..512")
        self.width, self.height = width, height
        self.pixels = [["."] * width for _ in range(height)]

    @classmethod
    def from_rows(cls, rows: list[str]) -> "Canvas":
        if not rows or not rows[0] or any(len(row) != len(rows[0]) for row in rows):
            raise ValueError("Pixel rows must form a nonempty rectangle")
        canvas = cls(len(rows[0]), len(rows))
        canvas.pixels = [list(row) for row in rows]
        return canvas

    @property
    def rows(self) -> list[str]:
        return ["".join(row) for row in self.pixels]

    def rect(self, x: int, y: int, width: int, height: int, color: str) -> "Canvas":
        if len(color) != 1 or min(x, y, width, height) < 0:
            raise ValueError("Use a palette symbol and nonnegative integer rectangle")
        if x + width > self.width or y + height > self.height:
            raise ValueError("Rectangle exceeds canvas")
        for row in self.pixels[y : y + height]:
            row[x : x + width] = [color] * width
        return self

    def stamp(self, x: int, y: int, rows: list[str]) -> "Canvas":
        patch = Canvas.from_rows(rows)
        if min(x, y) < 0 or x + patch.width > self.width or y + patch.height > self.height:
            raise ValueError("Stamp exceeds canvas")
        for dy, row in enumerate(patch.pixels):
            for dx, color in enumerate(row):
                if color != ".":
                    self.pixels[y + dy][x + dx] = color
        return self

    def mirrored(self) -> "Canvas":
        return Canvas.from_rows([row[::-1] for row in self.rows])


class PixelArt:
    """Named, ordered layers with explicit per-view/per-frame pixel poses.

    Native mode replaces geometry. Render mode overlays exact pixels on geometry;
    an optional object anchor moves a patch with its projected origin. These are
    finishing layers, not depth-tested textures: author only the visible views.
    """

    def __init__(
        self, palette: dict[str, str], views: dict[int, tuple[int, int]], *, base: str = "native"
    ):
        if base not in {"native", "render"}:
            raise ValueError("Pixel art base must be native or render")
        if not 2 <= len(palette) <= 64 or any(
            len(k) != 1 or k == "." or not re.fullmatch(r"#[0-9a-fA-F]{6}", v)
            for k, v in palette.items()
        ):
            raise ValueError("Use 2..64 single-symbol #rrggbb palette entries; reserve '.'")
        if len({v.lower() for v in palette.values()}) != len(palette):
            raise ValueError("Palette colors must be distinct")
        if not views or any(
            angle not in (0, 90, 180, 270)
            or len(size) != 2
            or any(type(v) is not int or not 1 <= v <= 512 for v in size)
            for angle, size in views.items()
        ):
            raise ValueError("Declare each consumer view and its native canvas")
        self.palette = {k: v.lower() for k, v in palette.items()}
        self.views = {str(k): list(v) for k, v in views.items()}
        self.base = base
        self.layers: list[dict[str, Any]] = []

    def layer(
        self,
        name: str,
        angle: int,
        canvas: Canvas,
        *,
        x: int = 0,
        y: int = 0,
        frame: int | None = None,
        anchor: str | None = None,
        min_pixels: int = 0,
        connected: bool = False,
    ) -> "PixelArt":
        if not name or len(name) > 100 or str(angle) not in self.views:
            raise ValueError("Layer needs a name and a declared view")
        if any(type(v) is not int for v in (x, y, min_pixels)) or min_pixels < 0:
            raise ValueError("Offsets and pixel budgets must be integers")
        if frame is not None and (type(frame) is not int or not 0 <= frame <= 1_000_000):
            raise ValueError("Invalid pose frame")
        if anchor is not None and (self.base != "render" or not anchor):
            raise ValueError("Object anchors require render mode and a nonempty object name")
        if any(c not in self.palette and c != "." for row in canvas.rows for c in row):
            raise ValueError("Unknown palette symbol in pixel layer")
        layer = next((item for item in self.layers if item["name"] == name), None)
        if layer is None:
            layer = {"name": name, "poses": []}
            self.layers.append(layer)
        pose = {
            "angle": angle,
            "frame": frame,
            "rows": canvas.rows,
            "x": x,
            "y": y,
            "anchor": anchor,
            "min_pixels": min_pixels,
            "connected": connected,
        }
        layer["poses"] = [
            p for p in layer["poses"] if (p["angle"], p["frame"]) != (angle, frame)
        ] + [pose]
        return self

    def poses(self, angle: int, frame: int) -> list[dict[str, Any]]:
        selected = []
        for layer in self.layers:
            choices = {p["frame"]: p for p in layer["poses"] if p["angle"] == angle}
            pose = choices.get(frame, choices.get(None))
            if pose is not None:
                selected.append({"name": layer["name"], **pose})
        return selected

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": 1,
            "base": self.base,
            "palette": self.palette,
            "views": self.views,
            "layers": self.layers,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PixelArt":
        if data.get("version") != 1:
            raise ValueError("Unsupported pixel art version")
        art = cls(
            data["palette"], {int(k): tuple(v) for k, v in data["views"].items()}, base=data["base"]
        )
        for layer in data["layers"]:
            for pose in layer["poses"]:
                values = {k: v for k, v in pose.items() if k != "rows"}
                art.layer(layer["name"], canvas=Canvas.from_rows(pose["rows"]), **values)
        return art

    def save(self, scene: Any) -> None:
        # Round-trip validation also catches accidental direct edits to the layer data.
        data = self.from_dict(self.to_dict()).to_dict()
        scene["pixel_art"] = json.dumps(data, separators=(",", ":"))

    @classmethod
    def load(cls, scene: Any) -> "PixelArt":
        return cls.from_dict(json.loads(scene["pixel_art"]))
