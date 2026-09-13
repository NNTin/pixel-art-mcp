"""Selected, nearest-neighbor asset previews delivered directly through MCP."""

import io
import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

from pixel_art_mcp.imaging.context import context_image
from pixel_art_mcp.imaging.inspection import _selection
from pixel_art_mcp.models import DomainError


def asset_preview(
    root: Path,
    clip_id: str | None,
    angle: int | None,
    frame: int | None,
    scale: int,
    context: bool,
) -> tuple[bytes, dict[str, Any]]:
    if not 1 <= scale <= 8:
        raise DomainError("Preview scale must be an integer from 1 to 8")
    metadata = json.loads((root / "spritesheet.json").read_text())
    kind = metadata["asset"]["kind"]
    clip_id = clip_id or next(iter(metadata["asset"]["clips"]))
    requested_angle = metadata["layouts"][0]["angle"] if angle is None else angle
    source_angle = requested_angle
    mirrored = kind != "furniture" and requested_angle == 270
    if mirrored:
        source_angle = 90
    if kind == "pet" and clip_id == "idle" and requested_angle in (90, 270):
        source_angle = 0 if requested_angle == 90 else 180
        mirrored = False
    metadata, entry, path, _ = _selection(root, clip_id, source_angle, frame)
    with Image.open(path) as opened:
        sprite = opened.convert("RGBA")
    if mirrored:
        sprite = ImageOps.mirror(sprite)
    native_size = list(sprite.size)
    layout = next(row for row in metadata["layouts"] if row["angle"] == source_angle)
    if context:
        sprite = context_image(sprite, metadata["asset"], layout)
    size = (sprite.width * scale, sprite.height * scale)
    if size[0] * size[1] > 4_194_304:
        raise DomainError("Preview exceeds 4194304 pixels; choose a smaller scale")
    sprite = sprite.resize(size, Image.Resampling.NEAREST)
    stream = io.BytesIO()
    sprite.save(stream, "PNG")
    return stream.getvalue(), {
        "clip_id": clip_id,
        "angle": requested_angle,
        "source_angle": source_angle,
        "frame": entry["frame"],
        "mirrored": mirrored,
        "native_size": native_size,
        "display_size": list(size),
        "scale": scale,
        "context": context,
        "context_is_approximate": context,
        "visual_review_required": True,
    }
