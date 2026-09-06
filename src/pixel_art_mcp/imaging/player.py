"""A downloadable, self-contained sprite player; no server or CDN needed."""

import base64
import json
from pathlib import Path

from pixel_art_mcp.models import RenderOptions


def export_player(output_dir: Path, options: RenderOptions) -> None:
    data = {
        "width": options.width,
        "height": options.height,
        "angles": options.angles,
        "frames": options.frames(),
        "fps": options.fps,
        "image": base64.b64encode((output_dir / "spritesheet.png").read_bytes()).decode("ascii"),
    }
    template = Path(__file__).with_name("player.html").read_text(encoding="utf-8")
    # Only validated numeric settings and base64 image bytes enter the inline script.
    html = template.replace("__PLAYER_DATA__", json.dumps(data))
    (output_dir / "preview.html").write_text(html, encoding="utf-8")
