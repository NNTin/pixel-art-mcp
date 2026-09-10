import json
import math
import zipfile
from collections.abc import Iterable, Iterator
from itertools import repeat
from pathlib import Path
from typing import Any, cast

from PIL import Image

from pixel_art_mcp.imaging.character import export_character
from pixel_art_mcp.imaging.gif import save_animated_gif
from pixel_art_mcp.imaging.pixel_agents import export_pixel_agents
from pixel_art_mcp.imaging.player import export_player
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
    return palette_from_samples(samples, options)


def palette_from_samples(
    samples: list[tuple[int, int, int]], options: RenderOptions
) -> list[tuple[int, int, int]]:
    if options.palette:
        return [tuple(bytes.fromhex(color[1:])) for color in options.palette]  # type: ignore[misc]
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


def sample_source_colors(
    image: Image.Image, budget: int, alpha_threshold: int
) -> list[tuple[int, int, int]]:
    raw_pixels = image.tobytes()
    stride = max(1, math.ceil(image.width * image.height / max(1, budget)))
    return [
        (raw_pixels[i], raw_pixels[i + 1], raw_pixels[i + 2])
        for i in range(0, len(raw_pixels), stride * 4)
        if raw_pixels[i + 3] >= alpha_threshold
    ]


def pixelate(
    frames: Iterable[Image.Image],
    options: RenderOptions,
    *,
    sizes: Iterable[tuple[int, int]] | None = None,
) -> tuple[list[Image.Image], list[str]]:
    """Downscale + quantize to one shared palette. `sizes`, one (width, height) pair
    per frame, overrides the uniform (options.width, options.height) target -- used by
    pet export, whose right-facing row renders at double width (see imaging/pet.py)."""
    resized = []
    source_samples: list[tuple[int, int, int]] = []
    expected_frames = max(1, len(options.angles) * len(options.render_frames()))
    sample_budget = max(1, 262_144 // expected_frames)
    target_sizes = sizes if sizes is not None else repeat((options.width, options.height))
    for original, size in zip(frames, target_sizes, strict=False):
        source = original.convert("RGBA")
        if options.downscale_mode == "crisp" and options.palette is None:
            source_samples.extend(
                sample_source_colors(source, sample_budget, options.alpha_threshold)
            )
        im = source.resize(size, Image.Resampling.BOX)
        alpha = im.getchannel("A").point(lambda a: 255 if a >= options.alpha_threshold else 0)
        im.putalpha(alpha)
        resized.append(im)
    colors = (
        palette_from_samples(source_samples, options)
        if options.downscale_mode == "crisp" and options.palette is None
        else shared_palette(resized, options)
    )
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
    if options.pet:
        # Checked before options.states: pet also configures its walk/idle frame
        # roles through options.states, but its packaging (a single asymmetric-grid
        # PNG, no per-state player/variants) has nothing in common with the general
        # multi-state furniture machinery below.
        from pixel_art_mcp.imaging.pet import export_pet_sheet

        export_pet_sheet(raw_dir, output_dir, manifest, options, project_id, revision_id)
        return
    if options.states:
        from pixel_art_mcp.imaging.states import export_states

        export_states(raw_dir, output_dir, manifest, options, project_id, revision_id)
        return
    entries = manifest["frames"]
    rendered_frames = options.render_frames()
    expected = len(options.angles) * len(rendered_frames)
    if len(entries) != expected:
        raise DomainError("Blender returned an incomplete frame sequence")

    columns, rows = len(options.frames()), len(options.angles)
    high_width = options.width * options.supersampling
    high_height = options.height * options.supersampling
    high_sheet = Image.new("RGBA", (columns * high_width, rows * high_height))
    off = options.pixel_agents.off_frame if options.pixel_agents else None
    high_off = Image.new("RGBA", (high_width, rows * high_height)) if off is not None else None

    def source_images() -> Iterator[Image.Image]:
        # Decode and downsize one supersampled image at a time, bounding peak memory.
        for index, entry in enumerate(entries):
            row, column = divmod(index, len(rendered_frames))
            if entry["angle"] != options.angles[row] or entry["frame"] != rendered_frames[column]:
                raise DomainError("Blender returned frames in an unexpected order")
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
                if column < columns:
                    high_sheet.paste(
                        source.convert("RGBA"), (column * high_width, row * high_height)
                    )
                if high_off is not None and entry["frame"] == off:
                    high_off.paste(source.convert("RGBA"), (0, row * high_height))
                yield source

    rendered, palette = pixelate(source_images(), options)
    indices = [
        row * len(rendered_frames) + column for row in range(rows) for column in range(columns)
    ]
    frames = [rendered[i] for i in indices]
    off_frames = (
        [rendered[row * len(rendered_frames) + rendered_frames.index(off)] for row in range(rows)]
        if off is not None
        else None
    )
    directory = output_dir / "comparison"
    directory.mkdir(parents=True, exist_ok=True)
    high_sheet.save(directory / "high-resolution.png")
    if high_off is not None:
        high_off.save(directory / "off-high-resolution.png")
    comparison = {
        "image": "comparison/high-resolution.png",
        "width": high_width,
        "height": high_height,
        "off_image": "comparison/off-high-resolution.png" if high_off is not None else None,
        "usage": "comparison_only",
        "higher_resolution": options.supersampling > 1,
    }
    pack_sprites(
        frames,
        palette,
        output_dir,
        {**manifest, "frames": [entries[i] for i in indices]},
        options,
        project_id,
        revision_id,
        off_frames=off_frames,
        comparison=comparison,
    )


def pack_sprites(
    frames: list[Image.Image],
    palette: list[str],
    output_dir: Path,
    manifest: dict[str, Any],
    options: RenderOptions,
    project_id: str,
    revision_id: str,
    *,
    off_frames: list[Image.Image] | None = None,
    comparison: dict[str, Any] | None = None,
) -> None:
    """Package already converted sprites without changing their colors or placement."""
    entries = manifest["frames"]
    columns, rows = len(options.frames()), len(options.angles)
    if len(frames) != rows * columns or len(entries) != len(frames):
        raise DomainError("Cannot pack an incomplete frame sequence")
    if any(im.mode != "RGBA" or im.size != (options.width, options.height) for im in frames):
        raise DomainError("Cannot pack sprites with unexpected dimensions or color mode")
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
    if columns > 1:
        gif_size = (options.width, rows * options.height)
        gif_scale = min(4, max(1, 1024 // max(gif_size)))
        gif_frames = []
        for column in range(columns):
            composite = Image.new("RGBA", gif_size)
            for row in range(rows):
                composite.paste(frames[row * columns + column], (0, row * options.height))
            composite = composite.resize(
                (composite.width * gif_scale, composite.height * gif_scale),
                Image.Resampling.NEAREST,
            )
            if max(composite.size) > 1024:
                composite.thumbnail((1024, 1024), Image.Resampling.NEAREST)
            gif_frames.append(composite)
        save_animated_gif(gif_frames, palette, options.fps, output_dir / "preview.gif")
    directions = []
    for row, angle in enumerate(options.angles):
        indices = list(range(row * columns, (row + 1) * columns))
        animation = None
        if columns > 1:
            animation = f"animations/direction_{row:02d}.apng"
            path = output_dir / animation
            path.parent.mkdir(exist_ok=True)
            sequence = [frames[i] for i in indices]
            # SOURCE replaces changed pixels, including newly transparent pixels. OVER would
            # leave trails when a flame shrinks or an object moves. Keep the exported palette.
            sequence[0].save(
                path,
                format="PNG",
                save_all=True,
                append_images=sequence[1:],
                duration=1000 / options.fps,
                loop=0,
                disposal=0,
                blend=0,
            )
        directions.append(
            {"angle": angle, "row": row, "frame_indices": indices, "animation": animation}
        )
    off_image = None
    if off_frames is not None:
        off_sheet = Image.new("RGBA", (options.width, rows * options.height))
        for row, im in enumerate(off_frames):
            off_sheet.paste(im, (0, row * options.height))
        off_image = "off-spritesheet.png"
        off_sheet.save(output_dir / off_image)
    target = export_pixel_agents(output_dir, options, frames, off_frames)
    character = export_character(output_dir, options, frames)
    export_player(output_dir, options, comparison=comparison, target=target, off_image=off_image)
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
        "directions": directions,
        "player": "preview.html",
        "pixel_agents": target,
        "character": character,
        "comparison": comparison,
        "off_image": off_image,
        "camera": manifest["camera"],
        "blender_version": manifest["blender_version"],
    }
    (output_dir / "spritesheet.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    with zipfile.ZipFile(output_dir / "sprites.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(output_dir.rglob("*")):
            if path.is_file() and path.name != "sprites.zip":
                archive.write(path, path.relative_to(output_dir))
