"""Export a pixel-index custom-pet package: manifest.json + a 96x96 pet.png.

See docs/custom-asset-zip-contract.md (pixel-agents-hq/index): row 0 (y=0..32) is
walkDown[0..2]+idleDown[0..2] at 16x32 each; row 1 (y=32..64) is the same for `up`;
row 2 (y=64..96) is walkRight[0..2] at 32x32 each -- rendered at double width by
blender/runner.py's per-angle resolution_x (see angle_widths() below, shared with
jobs/worker.py). idleRight doesn't exist in the contract: idle-state right-facing
frames are still rendered (one shared render pass covers every state at every angle)
but are simply not used here.
"""

import json
from pathlib import Path
from typing import Any
from zipfile import ZIP_DEFLATED, ZipFile

from PIL import Image

from pixel_art_mcp.imaging.pixels import pixelate
from pixel_art_mcp.models import DomainError, RenderOptions

PET_PNG_SIZE = (96, 96)
PET_FRAME_HEIGHT = 32
PET_NARROW_WIDTH = 16
PET_WIDE_WIDTH = 32
PET_WIDE_ANGLE = 90.0
# Documented (not pixel-index-enforced) per-pet-PNG compatibility cap -- see the
# contract doc's note on upstream's own MAX_PET_PNG_SIZE.
MAX_PET_PNG_BYTES = 512 * 1024


def angle_widths(width: int, angles: list[float]) -> list[int]:
    """Per-angle render width for a pet job: double width for the `right` (90deg) row,
    matching the contract's wider side-view canvas. Used both by worker.py (to tell
    the Blender renderer, from the raw job options dict) and by this module (to decode
    the resulting raw PNGs, from a validated RenderOptions)."""
    return [PET_WIDE_WIDTH if angle == PET_WIDE_ANGLE else width for angle in angles]


def export_pet_sheet(
    raw_dir: Path,
    output_dir: Path,
    manifest: dict[str, Any],
    options: RenderOptions,
    project_id: str,
    revision_id: str,
) -> None:
    target = options.pet
    states = options.states
    assert target is not None and states is not None
    walk = next(state for state in states if state.id == "walk")
    idle = next(state for state in states if state.id == "idle")

    entries = manifest["frames"]
    rendered_frames = options.render_frames()
    if len(entries) != len(options.angles) * len(rendered_frames):
        raise DomainError("Blender returned an incomplete pet frame sequence")
    by_key = {(entry["angle"], entry["frame"]): entry for entry in entries}
    widths = dict(zip(options.angles, angle_widths(options.width, options.angles), strict=True))

    def load(angle: float, frame: int, width: int) -> Image.Image:
        entry = by_key.get((angle, frame))
        if entry is None:
            raise DomainError("Blender did not render a required pet frame")
        path = (raw_dir / entry["filename"]).resolve()
        if not path.is_relative_to(raw_dir.resolve()) or path.suffix != ".png":
            raise DomainError("Invalid render output path")
        with Image.open(path) as source:
            expected_size = (width * options.supersampling, options.height * options.supersampling)
            if source.size != expected_size:
                raise DomainError("Blender returned unexpected image dimensions")
            return source.convert("RGBA")

    # The ordered list of (angle, frame, width) cells this pet needs. One shared
    # palette is derived across all of them (via pixelate()) so the down/up rows and
    # the wider right row share consistent colors.
    cells: list[tuple[float, int, int]] = []
    for angle in (0.0, 180.0):
        for frame in walk.frames() + idle.frames():
            cells.append((angle, frame, widths[angle]))
    for frame in walk.frames():
        cells.append((PET_WIDE_ANGLE, frame, widths[PET_WIDE_ANGLE]))

    sources = (load(angle, frame, width) for angle, frame, width in cells)
    sizes = [(width, options.height) for _, _, width in cells]
    rendered, palette = pixelate(sources, options, sizes=sizes)
    by_cell = {
        (angle, frame): image for (angle, frame, _), image in zip(cells, rendered, strict=True)
    }

    sheet = Image.new("RGBA", PET_PNG_SIZE)

    def paste_row(y: int, angle: float, frames: list[int], width: int) -> None:
        x = 0
        for frame in frames:
            sheet.paste(by_cell[(angle, frame)], (x, y))
            x += width

    paste_row(0, 0.0, walk.frames() + idle.frames(), PET_NARROW_WIDTH)
    paste_row(PET_FRAME_HEIGHT, 180.0, walk.frames() + idle.frames(), PET_NARROW_WIDTH)
    paste_row(PET_FRAME_HEIGHT * 2, PET_WIDE_ANGLE, walk.frames(), PET_WIDE_WIDTH)

    output_dir.mkdir(parents=True, exist_ok=True)
    package_root = output_dir / "pixel-agents-pet"
    directory = package_root / target.asset_id
    directory.mkdir(parents=True)
    (directory / "manifest.json").write_text(
        json.dumps({"id": target.asset_id, "name": target.name}, indent=2), encoding="utf-8"
    )
    png_path = directory / "pet.png"
    sheet.save(png_path)
    if png_path.stat().st_size > MAX_PET_PNG_BYTES:
        raise DomainError(
            f"Generated pet.png exceeds pixel-agents' {MAX_PET_PNG_BYTES}-byte per-pet "
            "compatibility cap; reduce colors or simplify the model"
        )

    archive_name = "pixel-agents-pet.zip"
    with ZipFile(output_dir / archive_name, "w", ZIP_DEFLATED) as archive:
        for path in sorted(directory.iterdir()):
            archive.write(path, path.relative_to(package_root))

    metadata = {
        "schema_version": 1,
        "project_id": project_id,
        "revision_id": revision_id,
        "image": f"pixel-agents-pet/{target.asset_id}/pet.png",
        "size": list(PET_PNG_SIZE),
        "palette": palette,
        "transparent": True,
        "settings": options.model_dump(),
        "pet": {
            "asset_id": target.asset_id,
            "name": target.name,
            "manifest": f"pixel-agents-pet/{target.asset_id}/manifest.json",
            "archive": archive_name,
            "width": PET_PNG_SIZE[0],
            "height": PET_PNG_SIZE[1],
            "walk_frames": walk.frames(),
            "idle_frames": idle.frames(),
            "install": "Upload pet.png + manifest.json to pixel-index with assetKind=pet.",
        },
        "camera": manifest["camera"],
        "blender_version": manifest["blender_version"],
    }
    (output_dir / "spritesheet.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    with ZipFile(output_dir / "sprites.zip", "w", ZIP_DEFLATED) as archive:
        for path in sorted(output_dir.rglob("*")):
            if path.is_file() and path.name != "sprites.zip":
                archive.write(path, path.relative_to(output_dir))
