"""A downloadable, self-contained sprite player; no server or CDN needed."""

import base64
import json
from pathlib import Path
from typing import Any

from pixel_art_mcp.models import RenderOptions


def export_player(
    output_dir: Path,
    options: RenderOptions,
    *,
    comparison: dict[str, Any] | None = None,
    target: dict[str, Any] | None = None,
    off_image: str | None = None,
) -> None:
    def encode(filename: str) -> str:
        return base64.b64encode((output_dir / filename).read_bytes()).decode("ascii")

    data = {
        "width": options.width,
        "height": options.height,
        "angles": options.angles,
        "frames": options.frames(),
        "fps": options.fps,
        "image": encode("spritesheet.png"),
        "offImage": encode(off_image) if off_image else None,
        "target": target,
        "comparison": (
            {
                **comparison,
                "image": encode(comparison["image"]),
                "offImage": encode(comparison["off_image"]) if comparison["off_image"] else None,
            }
            if comparison
            else None
        ),
    }
    template = Path(__file__).with_name("player.html").read_text(encoding="utf-8")
    # Escape HTML delimiters so target metadata cannot terminate the inline script.
    html = template.replace("__PLAYER_DATA__", json.dumps(data).replace("<", "\\u003c"))
    (output_dir / "preview.html").write_text(html, encoding="utf-8")
