import json
import math
import zipfile
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any, cast

from PIL import Image

from pixel_art_mcp.models import DomainError, RenderOptions


def shared_palette(frames: list[Image.Image], options: RenderOptions) -> list[tuple[int, int, int]]:
    if options.palette:
        return [tuple(bytes.fromhex(color[1:])) for color in options.palette]  # type: ignore[misc]
    # Sample evenly across every frame, excluding transparent pixels.
    stride = max(1, math.ceil(sum(im.width * im.height for im in frames) / 262_144))
    samples: list[tuple[int, int, int]] = []
    for im in frames:
        raw_pixels = im.tobytes()
        samples.extend(
            (raw_pixels[i], raw_pixels[i + 1], raw_pixels[i + 2])
            for i in range(0, len(raw_pixels), stride * 4)
            if raw_pixels[i + 3] != 0
        )
    if not samples:
        return [(0, 0, 0)]
    strip = Image.new("RGB", (len(samples), 1))
    strip.putdata(samples)
    quantized = strip.quantize(
        colors=options.colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE
    )
    raw = quantized.getpalette()
    assert raw is not None
    indices = sorted(cast(int, index) for _, index in (quantized.getcolors() or []))
    return [(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]) for i in indices]


def pixelate(
    frames: Iterable[Image.Image], options: RenderOptions
) -> tuple[list[Image.Image], list[str]]:
    resized = []
    for original in frames:
        im = original.convert("RGBA").resize((options.width, options.height), Image.Resampling.BOX)
        alpha = im.getchannel("A").point(lambda a: 255 if a >= options.alpha_threshold else 0)
        im.putalpha(alpha)
        resized.append(im)
    colors = shared_palette(resized, options)
    palette = Image.new("P", (1, 1))
    padded = colors + [colors[0]] * (256 - len(colors))
    palette.putpalette([channel for color in padded for channel in color])
    outputs = []
    for im in resized:
        quantized = im.convert("RGB").quantize(palette=palette, dither=Image.Dither.NONE)
        result = quantized.convert("RGBA")
        alpha = im.getchannel("A")
        result.putalpha(alpha)
        # Transparent RGB is canonical, avoiding color fringes in consuming engines.
        result.paste((0, 0, 0, 0), mask=alpha.point(lambda a: 255 - a))
        outputs.append(result)
    return outputs, [f"#{r:02x}{g:02x}{b:02x}" for r, g, b in colors]


def export_sheet(
    raw_dir: Path,
    output_dir: Path,
    manifest: dict[str, Any],
    options: RenderOptions,
    project_id: str,
    revision_id: str,
) -> None:
    entries = manifest["frames"]
    expected = len(options.angles) * len(options.frames())
    if len(entries) != expected:
        raise DomainError("Blender returned an incomplete frame sequence")

    def source_images() -> Iterator[Image.Image]:
        # Decode and downsize one supersampled image at a time, bounding peak memory.
        for entry in entries:
            path = (raw_dir / entry["filename"]).resolve()
            if not path.is_relative_to(raw_dir.resolve()) or path.suffix != ".png":
                raise DomainError("Invalid render output path")
            with Image.open(path) as source:
                expected_size = (
                    options.width * options.supersampling,
                    options.height * options.supersampling,
                )
                if source.size != expected_size:
                    raise DomainError("Blender returned unexpected image dimensions")
                yield source

    frames, palette = pixelate(source_images(), options)
    columns, rows = len(options.frames()), len(options.angles)
    sheet = Image.new("RGBA", (columns * options.width, rows * options.height))
    output_dir.mkdir(parents=True, exist_ok=True)
    frame_dir = output_dir / "frames"
    frame_dir.mkdir()
    frame_metadata = []
    for index, (im, entry) in enumerate(zip(frames, entries, strict=True)):
        row, column = divmod(index, columns)
        if entry["angle"] != options.angles[row] or entry["frame"] != options.frames()[column]:
            raise DomainError("Blender returned frames in an unexpected order")
        name = f"direction_{row:02d}_frame_{entry['frame']:06d}.png"
        im.save(frame_dir / name)
        x, y = column * options.width, row * options.height
        sheet.paste(im, (x, y))
        frame_metadata.append(
            {
                "filename": f"frames/{name}",
                "angle": entry["angle"],
                "frame": entry["frame"],
                "rect": [x, y, im.width, im.height],
                "pivot": entry["pivot"],
                "duration_ms": 1000 / options.fps,
            }
        )
    sheet.save(output_dir / "spritesheet.png")
    scale = min(4, max(1, 1024 // max(sheet.size)))
    preview = sheet.resize((sheet.width * scale, sheet.height * scale), Image.Resampling.NEAREST)
    if max(preview.size) > 1024:
        preview.thumbnail((1024, 1024), Image.Resampling.NEAREST)
    preview.save(output_dir / "preview.png")
    metadata = {
        "schema_version": 1,
        "project_id": project_id,
        "revision_id": revision_id,
        "image": "spritesheet.png",
        "size": list(sheet.size),
        "columns": columns,
        "rows": rows,
        "palette": palette,
        "transparent": True,
        "settings": options.model_dump(),
        "frames": frame_metadata,
        "camera": manifest["camera"],
        "blender_version": manifest["blender_version"],
    }
    (output_dir / "spritesheet.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    with zipfile.ZipFile(output_dir / "sprites.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(output_dir.rglob("*")):
            if path.is_file() and path.suffix != ".zip":
                archive.write(path, path.relative_to(output_dir))
