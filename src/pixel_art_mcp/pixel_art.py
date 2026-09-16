"""Native-grid authoring shared by authoring scripts and the exporter (stdlib only)."""

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
        if not rows or not rows[0]:
            raise ValueError("Pixel rows must form a nonempty rectangle; row 0 must not be empty")
        bad = [(i, len(row)) for i, row in enumerate(rows) if len(row) != len(rows[0])]
        if bad:
            details = "; ".join(f"row {i}: expected {len(rows[0])}, actual {n}" for i, n in bad[:8])
            remaining = f"; {len(bad) - 8} more mismatched rows" if len(bad) > 8 else ""
            raise ValueError(
                f"Pixel rows must form a nonempty rectangle. {details}{remaining}. "
                "Row indices are zero-based; use numeric drawing commands for long shapes."
            )
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

    def line(self, x1: int, y1: int, x2: int, y2: int, color: str) -> "Canvas":
        if len(color) != 1 or any(type(v) is not int for v in (x1, y1, x2, y2)):
            raise ValueError("Use integer line coordinates and a palette symbol")
        if not (
            0 <= x1 < self.width
            and 0 <= x2 < self.width
            and 0 <= y1 < self.height
            and 0 <= y2 < self.height
        ):
            raise ValueError("Line exceeds canvas")
        # Integer Bresenham: inclusive endpoints, no fractional coverage or antialiasing.
        dx, dy = abs(x2 - x1), -abs(y2 - y1)
        sx, sy = (1 if x1 < x2 else -1), (1 if y1 < y2 else -1)
        error = dx + dy
        while True:
            self.pixels[y1][x1] = color
            if (x1, y1) == (x2, y2):
                return self
            twice = 2 * error
            if twice >= dy:
                error += dy
                x1 += sx
            if twice <= dx:
                error += dx
                y1 += sy


class PixelArt:
    """Named, ordered layers with explicit per-view/per-frame pixel poses.

    Every layer draws the complete sprite through pixel helpers: these are
    finishing layers, not depth-tested textures, so author only the visible views.
    """

    def __init__(self, palette: dict[str, str], views: dict[int, tuple[int, int]]):
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
        min_pixels: int = 0,
        connected: bool = False,
    ) -> "PixelArt":
        if not name or len(name) > 100 or str(angle) not in self.views:
            raise ValueError("Layer needs a name and a declared view")
        if any(type(v) is not int for v in (x, y, min_pixels)) or min_pixels < 0:
            raise ValueError("Offsets and pixel budgets must be integers")
        if frame is not None and (type(frame) is not int or not 0 <= frame <= 1_000_000):
            raise ValueError("Invalid pose frame")
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
            "palette": self.palette,
            "views": self.views,
            "layers": self.layers,
        }

    def validate_target(
        self,
        layouts: list[dict[str, Any]],
        frames: list[int],
        spec: dict[str, Any],
    ) -> None:
        expected = {str(v["angle"]): [v["width"], v["height"]] for v in layouts}
        if self.views != expected:
            raise ValueError(f"Pixel views must match the configured canvases: {expected}")
        if spec["outline"]:
            raise ValueError("Draw outlines in pixel rows; configure_asset.outline must be false")
        if len(self.palette) > spec["colors"]:
            raise ValueError("Pixel palette exceeds configure_asset.colors")
        if spec.get("palette") and {v.lower() for v in spec["palette"]} != set(
            self.palette.values()
        ):
            raise ValueError("Pixel palette must match configure_asset.palette")
        if not self.layers:
            raise ValueError("A pixel-art definition with named layers is required")
        if not any(
            c != "."
            for layer in self.layers
            for p in layer["poses"]
            for row in p["rows"]
            for c in row
        ):
            raise ValueError("Pixel layers must contain authored ink")
        for layer in self.layers:
            for pose in layer["poses"]:
                w, h = expected[str(pose["angle"])]
                if len(pose["rows"]) > h or len(pose["rows"][0]) > w:
                    raise ValueError(f"Patch in {layer['name']!r} exceeds its view dimensions")
        for layout in layouts:
            for frame in frames:
                poses = self.poses(layout["angle"], frame)
                if not poses:
                    raise ValueError(
                        f"Missing pixel pose at angle {layout['angle']}, frame {frame}; add a "
                        f"default or exact-frame pose"
                    )
                ink = any(
                    c != "."
                    and 0 <= p["x"] + x < layout["width"]
                    and 0 <= p["y"] + y < layout["height"]
                    for p in poses
                    for y, row in enumerate(p["rows"])
                    for x, c in enumerate(row)
                )
                if not ink:
                    raise ValueError(f"Empty pose at angle {layout['angle']}, frame {frame}")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PixelArt":
        if data.get("version") != 1:
            raise ValueError("Unsupported pixel art version")
        art = cls(data["palette"], {int(k): tuple(v) for k, v in data["views"].items()})
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
