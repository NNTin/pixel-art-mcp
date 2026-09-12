"""All targets share conversion, frames, diagnostics and previews; only packing differs."""

import json
from pathlib import Path
from typing import Any
from zipfile import ZIP_DEFLATED, ZipFile

from PIL import Image, ImageChops, ImageFilter

from pixel_art_mcp.assets import clip_duration_ms, clip_playback
from pixel_art_mcp.imaging.character import export_character
from pixel_art_mcp.imaging.context import export_context
from pixel_art_mcp.imaging.gif import save_animated_gif
from pixel_art_mcp.imaging.inspection import inspect_sprite
from pixel_art_mcp.imaging.pet import MAX_PET_PNG_BYTES
from pixel_art_mcp.imaging.pixel_agents import export_pixel_agents
from pixel_art_mcp.imaging.pixels import pixelate
from pixel_art_mcp.models import (
    AssetSpec,
    DomainError,
    PixelAgentsCharacterOptions,
    PixelAgentsOptions,
    RenderOptions,
)


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def zip_directory(root: Path, destination: Path) -> None:
    with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
        for path in sorted(root.rglob("*")):
            if path.is_file() and path != destination:
                archive.write(path, path.relative_to(root))


def package_asset(
    output: Path,
    spec: AssetSpec,
    layouts: list[dict[str, Any]],
    cells: dict[tuple[int, int], Image.Image],
) -> dict[str, Any]:
    angles = [row["angle"] for row in layouts]
    if spec.kind == "furniture":
        variants = []
        for key, clip in spec.clips.items():
            asset_id = f"{spec.asset_id}_{key.upper()}" if len(spec.clips) > 1 else spec.asset_id
            name = f"{spec.name} — {clip.name or key}" if len(spec.clips) > 1 else spec.name
            options = RenderOptions(
                width=layouts[0]["width"],
                height=layouts[0]["height"],
                angles=angles,
                frame_sequence=clip.frames,
                pixel_agents=PixelAgentsOptions(
                    asset_id=str(asset_id),
                    name=name,
                    category=spec.category,
                    can_place_on_surfaces=spec.placement == "surface",
                    can_place_on_walls=spec.placement == "wall",
                    background_tiles=layouts[0]["background_tiles"],
                    footprint_w=layouts[0]["footprint_w"],
                    footprint_h=layouts[0]["footprint_h"],
                    off_frame=clip.off_frame,
                ),
            )
            on = [cells[(angle, frame)] for angle in angles for frame in clip.frames]
            off = (
                [cells[(angle, clip.off_frame)] for angle in angles]
                if clip.off_frame is not None
                else None
            )
            variants.append(export_pixel_agents(output, options, on, off, layouts))
        zip_directory(output / "pixel-agents", output / "pixel-agents.zip")
        return {"kind": spec.kind, "archive": "pixel-agents.zip", "variants": variants}
    if spec.kind == "character":
        frames = [f for key in ("walk", "typing", "reading") for f in spec.clips[key].frames]
        options = RenderOptions(
            width=16,
            height=32,
            angles=angles,
            frame_sequence=frames,
            character=PixelAgentsCharacterOptions(asset_id=str(spec.asset_id), name=spec.name),
        )
        target = export_character(output, options, [cells[(a, f)] for a in angles for f in frames])
        return {"kind": spec.kind, **(target or {})}
    directory = output / "pixel-agents-pet" / str(spec.asset_id)
    directory.mkdir(parents=True)
    sheet = Image.new("RGBA", (96, 96))
    for row, angle in enumerate((0, 180, 90)):
        frames = spec.clips["walk"].frames + (spec.clips["idle"].frames if angle != 90 else [])
        width = 32 if angle == 90 else 16
        for column, frame in enumerate(frames):
            sheet.paste(cells[(angle, frame)], (column * width, row * 32))
    sheet.save(directory / "pet.png")
    if (directory / "pet.png").stat().st_size > MAX_PET_PNG_BYTES:
        raise DomainError("Pet PNG exceeds the consumer's 512 KiB limit")
    write_json(directory / "manifest.json", {"id": spec.asset_id, "name": spec.name})
    zip_directory(directory.parent, output / "pixel-agents-pet.zip")
    return {
        "kind": spec.kind,
        "archive": "pixel-agents-pet.zip",
        "image": f"pixel-agents-pet/{spec.asset_id}/pet.png",
    }


def asset_report(output: Path, metadata: dict[str, Any]) -> dict[str, Any]:
    spec = metadata["asset"]
    reports, findings = [], []
    layouts = {row["angle"]: row for row in metadata["layouts"]}
    for entry in metadata["frames"]:
        clip_id = next(
            key
            for key, clip in spec["clips"].items()
            if entry["frame"] in clip["frames"] or entry["frame"] == clip.get("off_frame")
        )
        inspected = inspect_sprite(output, clip_id, entry["angle"], entry["frame"])
        analysis = inspected["analysis"]
        bounds = analysis["occupied_bounds"]
        width, height = inspected["size"]
        if not bounds:
            raise DomainError(
                f"Empty sprite at angle {entry['angle']}, frame {entry['frame']}; enlarge geometry"
            )
        x, y, w, h = bounds
        reports.append(
            {
                "angle": entry["angle"],
                "frame": entry["frame"],
                "size": [width, height],
                "occupied_bounds": bounds,
                "occupied_pixels": analysis["occupied_pixels"],
                "margins": {"left": x, "top": y, "right": width - x - w, "bottom": height - y - h},
                "bottom_gap": height - y - h,
                "contact_offset": layouts[entry["angle"]]["bottom"] - y - h,
                "center_offset": round(x + w / 2 - width / 2, 2),
                "singleton_color_clusters": analysis["singleton_components"],
            }
        )
        with Image.open(output / entry["filename"]) as image:
            opaque = [
                p
                for p in image.convert("RGBA").get_flattened_data()
                if isinstance(p, tuple) and p[3]
            ]
        background_luma = 0.2126 * 52 + 0.7152 * 62 + 0.0722 * 66
        similar = sum(
            abs(0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2] - background_luma) < 16
            for p in opaque
        )
        if similar / len(opaque) > 0.85:
            findings.append(
                {
                    "code": "low_context_contrast",
                    "angle": entry["angle"],
                    "frame": entry["frame"],
                    "suggestion": (
                        "Most pixels blend into the dark preview floor; "
                        "brighten broad materials or add an outline."
                    ),
                }
            )
        if analysis["occupied_pixels"] < 12 or w < 3 or h < 3:
            findings.append(
                {
                    "code": "small_silhouette",
                    "angle": entry["angle"],
                    "frame": entry["frame"],
                    "suggestion": "Increase the useful pixel area or exaggerate slender geometry.",
                }
            )
        if analysis["singleton_components"] > max(12, analysis["occupied_pixels"] * 0.4):
            findings.append(
                {
                    "code": "fragmented_colors",
                    "angle": entry["angle"],
                    "frame": entry["frame"],
                    "suggestion": "Simplify materials/details or reduce colors.",
                }
            )
    animation = []
    by_key = {(e["angle"], e["frame"]): e for e in metadata["frames"]}
    for clip_id, clip in spec["clips"].items():
        for direction in metadata["directions"]:
            angle = direction["angle"]
            images = []
            for frame in clip["frames"]:
                with Image.open(output / by_key[(angle, frame)]["filename"]) as im:
                    images.append(im.convert("RGBA"))
            changes = []
            for a, b in zip(images, images[1:] + images[:1], strict=True):
                changes.append(
                    sum(
                        p != q
                        for p, q in zip(a.get_flattened_data(), b.get_flattened_data(), strict=True)
                    )
                )
            animation.append({"clip": clip_id, "angle": angle, "changed_pixels": changes})
            if len(images) > 1 and max(changes) < 2:
                findings.append(
                    {
                        "code": "static_animation",
                        "clip": clip_id,
                        "angle": angle,
                        "suggestion": "Exaggerate the animated part if visible motion is intended.",
                    }
                )
    features = [
        {"angle": view["angle"], **obj}
        for view in metadata["camera"]["views"]
        for obj in view["objects"]
    ]
    thin = [f for f in features if min(f["pixel_width"], f["pixel_height"]) < 2]
    return {
        "status": "review" if findings else "ready",
        "kind": spec["kind"],
        "configuration_id": metadata["configuration_id"],
        "frames": reports,
        "layouts": metadata["layouts"],
        "animation": animation,
        "findings": findings,
        "projected_objects": features,
        "thin_objects": thin,
        "notes": [
            "Projected object bounds do not establish visibility or occlusion.",
            "Readability is advisory; review contextual previews and the exact pixel grid.",
            "Framing is fixed across clips; intentional motion is not re-centered per frame.",
        ],
        "outputs": {
            "preview": "preview.html",
            "context": "context.png",
            "package": metadata["package"]["archive"],
        },
    }


def export_asset(
    raw_dir: Path,
    output: Path,
    manifest: dict[str, Any],
    options: RenderOptions,
    project_id: str,
    revision_id: str,
) -> None:
    spec, layouts = options.asset, options.asset_layouts
    assert spec is not None and layouts is not None
    entries = manifest["frames"]
    expected = [(row["angle"], f) for row in layouts for f in options.frames()]
    if [(e["angle"], e["frame"]) for e in entries] != expected:
        raise DomainError("Blender returned incomplete or unordered asset frames")
    by_angle = {row["angle"]: row for row in layouts}
    sizes = [(by_angle[e["angle"]]["width"], by_angle[e["angle"]]["height"]) for e in entries]
    sources = []
    for entry, size in zip(entries, sizes, strict=True):
        path = (raw_dir / entry["filename"]).resolve()
        if not path.is_relative_to(raw_dir.resolve()) or path.suffix != ".png":
            raise DomainError("Invalid Blender image path")
        with Image.open(path) as opened:
            if opened.size != tuple(v * options.supersampling for v in size):
                raise DomainError("Blender returned wrong asset canvas dimensions")
            source = opened.convert("RGBA")
        bounds = source.getchannel("A").getbbox()
        if bounds and (
            bounds[0] == 0
            or bounds[1] == 0
            or bounds[2] == source.width
            or bounds[3] == source.height
        ):
            raise DomainError(
                f"Geometry reaches render boundary at {entry['angle']}°, frame {entry['frame']}; "
                "fix anchor or enlarge canvas"
            )
        sources.append(source)
    rendered, palette = pixelate(sources, options, sizes=sizes)
    if spec.outline:
        color = min(palette, key=lambda c: sum(bytes.fromhex(c[1:])))
        for i, im in enumerate(rendered):
            alpha = im.getchannel("A")
            expanded = alpha.filter(ImageFilter.MaxFilter(3))
            border = ImageChops.subtract(expanded, alpha)
            outlined = Image.new("RGBA", im.size, color)
            outlined.putalpha(border)
            outlined.alpha_composite(im)
            transparent = outlined.getchannel("A").point(lambda alpha: 255 if alpha == 0 else 0)
            outlined.paste((0, 0, 0, 0), mask=transparent)
            rendered[i] = outlined
    cells = {(int(e["angle"]), e["frame"]): im for e, im in zip(entries, rendered, strict=True)}
    output.mkdir(parents=True, exist_ok=True)
    (output / "frames").mkdir()
    (output / "comparison").mkdir()
    max_width, max_height = max(s[0] for s in sizes), max(s[1] for s in sizes)
    columns = len(options.frames())
    sheet = Image.new("RGBA", (max_width * columns, max_height * len(layouts)))
    high_sheet = Image.new(
        "RGBA", (sheet.width * options.supersampling, sheet.height * options.supersampling)
    )
    frame_metadata = []
    for index, (entry, im, source) in enumerate(zip(entries, rendered, sources, strict=True)):
        row, column = divmod(index, columns)
        name = f"frames/direction_{row:02d}_frame_{entry['frame']:06d}.png"
        high_name = "comparison/" + Path(name).name
        im.save(output / name)
        source.save(output / high_name)
        x, y = column * max_width, row * max_height
        sheet.paste(im, (x, y))
        high_sheet.paste(source, (x * options.supersampling, y * options.supersampling))
        frame_metadata.append(
            {
                **entry,
                "filename": name,
                "source": high_name,
                "rect": [x, y, im.width, im.height],
            }
        )
    sheet.save(output / "spritesheet.png")
    high_sheet.save(output / "comparison/high-resolution.png")
    preview_scale = min(4, max(1, 1024 // max(sheet.size)))
    sheet.resize(tuple(v * preview_scale for v in sheet.size), Image.Resampling.NEAREST).save(
        output / "preview.png"
    )
    (output / "animations").mkdir()
    animation_files = []
    for key, clip in spec.clips.items():
        if len(clip.frames) < 2:
            continue
        for angle in by_angle:
            source_angle = 0 if spec.kind == "pet" and key == "idle" and angle == 90 else angle
            sequence = [cells[(source_angle, f)] for f in clip_playback(spec.kind, key, clip)]
            name = f"animations/{key}_{angle:03d}.apng"
            sequence[0].save(
                output / name,
                format="PNG",
                save_all=True,
                append_images=sequence[1:],
                duration=clip_duration_ms(spec.kind, key),
                loop=0,
                disposal=0,
                blend=0,
            )
            animation_files.append(name)
    if animation_files:
        first_key, first_clip = next((k, c) for k, c in spec.clips.items() if len(c.frames) > 1)
        save_animated_gif(
            [
                cells[(layouts[0]["angle"], f)].resize(
                    (layouts[0]["width"] * 4, layouts[0]["height"] * 4), Image.Resampling.NEAREST
                )
                for f in clip_playback(spec.kind, first_key, first_clip)
            ],
            palette,
            1000 / clip_duration_ms(spec.kind, first_key),
            output / "preview.gif",
        )
    package = package_asset(output, spec, layouts, cells)
    metadata = {
        "schema_version": 1,
        "project_id": project_id,
        "revision_id": revision_id,
        "configuration_id": options.asset_configuration_id,
        "asset": spec.model_dump(),
        "settings": options.model_dump(),
        "layouts": layouts,
        "palette": palette,
        "image": "spritesheet.png",
        "size": list(sheet.size),
        "frames": frame_metadata,
        "directions": [{"angle": row["angle"]} for row in layouts],
        "package": package,
        "camera": manifest["camera"],
        "blender_version": manifest["blender_version"],
        "animations": animation_files,
        "playback": {
            key: {
                "frames": clip_playback(spec.kind, key, clip),
                "duration_ms": clip_duration_ms(spec.kind, key),
            }
            for key, clip in spec.clips.items()
        },
        "player": "preview.html",
    }
    write_json(output / "spritesheet.json", metadata)
    write_json(output / "asset-specification.json", spec.model_dump())
    write_json(output / "asset-report.json", asset_report(output, metadata))
    export_context(output, metadata)
    zip_directory(output, output / "sprites.zip")
