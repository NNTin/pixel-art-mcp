"""Export a pixel-index custom-character package: manifest.json + a 112x96 PNG.

See docs/custom-asset-zip-contract.md (pixel-agents-hq/index): 3 direction rows
(down, up, right -- top to bottom, CHARACTER_DIRECTIONS) x 7 walk-cycle columns, each
frame 16x32. manifest.json carries {id, name}, the same minimal shape pet.py writes --
`left` is derived by the pixel-agents client via a horizontal flip of `right` and is
never part of the export.
"""

import json
from pathlib import Path
from typing import Any
from zipfile import ZIP_DEFLATED, ZipFile

from PIL import Image

from pixel_art_mcp.models import RenderOptions

CHARACTER_PNG_SIZE = (112, 96)
# Row order pixel-index's decodeCharacterPng expects, paired with the camera angle
# (matching furniture's front/right/back/left convention) that produces each one.
DIRECTIONS = (("down", 0), ("up", 180), ("right", 90))


def export_character(
    output_dir: Path, options: RenderOptions, frames: list[Image.Image]
) -> dict[str, Any] | None:
    target = options.character
    if target is None:
        return None
    columns = len(options.frames())
    sheet = Image.new("RGBA", CHARACTER_PNG_SIZE)
    for row_index, (_, angle) in enumerate(DIRECTIONS):
        source_row = options.angles.index(angle)
        for column in range(columns):
            frame = frames[source_row * columns + column]
            sheet.paste(frame, (column * options.width, row_index * options.height))

    directory = output_dir / "pixel-agents-character"
    directory.mkdir(parents=True)
    png_path = directory / "character.png"
    sheet.save(png_path)
    (directory / "manifest.json").write_text(
        json.dumps({"id": target.asset_id, "name": target.name}, indent=2), encoding="utf-8"
    )
    archive_name = "pixel-agents-character.zip"
    with ZipFile(output_dir / archive_name, "w", ZIP_DEFLATED) as archive:
        for path in sorted(directory.iterdir()):
            archive.write(path, path.relative_to(directory))
    return {
        "id": target.asset_id,
        "name": target.name,
        "archive": archive_name,
        "width": CHARACTER_PNG_SIZE[0],
        "height": CHARACTER_PNG_SIZE[1],
        "directions": [name for name, _ in DIRECTIONS],
        "frames_per_direction": columns,
        "install": "Upload the zip to pixel-index — kind, name, and id come from the manifest.",
    }
