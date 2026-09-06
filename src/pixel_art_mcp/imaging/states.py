"""Export named appearance states from one render, with shared framing and palette."""

import base64
import json
import shutil
import zipfile
from pathlib import Path
from typing import Any

from PIL import Image

from pixel_art_mcp.imaging.pixel_agents import ACTIVATION
from pixel_art_mcp.imaging.pixels import export_sheet, shared_palette
from pixel_art_mcp.models import DomainError, RenderOptions


def export_states(
    raw_dir: Path,
    output_dir: Path,
    manifest: dict[str, Any],
    options: RenderOptions,
    project_id: str,
    revision_id: str,
) -> None:
    assert options.states
    render_frames = options.render_frames()
    entries = manifest["frames"]
    expected_keys = [(angle, frame) for angle in options.angles for frame in render_frames]
    if [(e["angle"], e["frame"]) for e in entries] != expected_keys:
        raise DomainError("Blender returned an incomplete or unordered state sequence")
    by_key = {(e["angle"], e["frame"]): e for e in entries}
    samples = []
    for entry in entries:
        path = (raw_dir / entry["filename"]).resolve()
        if not path.is_relative_to(raw_dir.resolve()) or path.suffix != ".png":
            raise DomainError("Invalid render output path")
        with Image.open(path) as source:
            if source.size != (
                options.width * options.supersampling,
                options.height * options.supersampling,
            ):
                raise DomainError("Blender returned unexpected image dimensions")
            im = source.convert("RGBA").resize(
                (options.width, options.height), Image.Resampling.BOX
            )
            im.putalpha(
                im.getchannel("A").point(lambda a: 255 if a >= options.alpha_threshold else 0)
            )
            samples.append(im)
    palette = ["#{:02x}{:02x}{:02x}".format(*c) for c in shared_palette(samples, options)]
    if len(palette) == 1:
        palette.append("#ffffff" if palette[0] == "#000000" else "#000000")
    del samples
    columns = len(options.states[0].frames())
    direction_count = len(options.angles)
    sheet = Image.new(
        "RGBA", (columns * options.width, len(options.states) * direction_count * options.height)
    )
    overview = Image.new(
        "RGBA", (len(options.states) * options.width, direction_count * options.height)
    )
    states = []
    embedded = []
    all_frames = []
    target = options.pixel_agents
    for state_index, state in enumerate(options.states):
        state_dir = output_dir / "states" / state.id
        state_options = options.model_dump()
        state_options.update(
            states=None,
            frame_start=state.frame_start,
            frame_end=state.frame_end,
            frame_step=state.frame_step,
            palette=palette,
        )
        if target:
            state_options["pixel_agents"] = {
                **target.model_dump(),
                "asset_id": f"{target.asset_id}_{state.id.upper()}",
                "name": f"{target.name} — {state.name}",
                "off_frame": state.off_frame,
            }
        child = RenderOptions.model_validate(state_options)
        child_entries = [
            by_key[(angle, frame)] for angle in child.angles for frame in child.render_frames()
        ]
        export_sheet(
            raw_dir,
            state_dir,
            {**manifest, "frames": child_entries},
            child,
            project_id,
            revision_id,
        )
        metadata = json.loads((state_dir / "spritesheet.json").read_text())
        prefix = f"states/{state.id}"
        with Image.open(state_dir / "spritesheet.png") as im:
            sheet.paste(im, (0, state_index * direction_count * options.height))
            for direction in range(direction_count):
                cell = im.crop(
                    (0, direction * options.height, options.width, (direction + 1) * options.height)
                )
                overview.paste(cell, (state_index * options.width, direction * options.height))
        for frame in metadata["frames"]:
            rect = list(frame["rect"])
            rect[1] += state_index * direction_count * options.height
            all_frames.append(
                {
                    **frame,
                    "state": state.id,
                    "filename": f"{prefix}/{frame['filename']}",
                    "rect": rect,
                }
            )
        states.append(
            {
                "id": state.id,
                "name": state.name,
                "row_start": state_index * direction_count,
                "frames": child.frames(),
                "metadata": f"{prefix}/spritesheet.json",
                "player": f"{prefix}/preview.html",
                "pixel_agents": metadata["pixel_agents"],
                "directions": [
                    {
                        **d,
                        "row": state_index * direction_count + d["row"],
                        "frame_indices": [
                            state_index * direction_count * columns + i for i in d["frame_indices"]
                        ],
                        "animation": f"{prefix}/{d['animation']}" if d["animation"] else None,
                    }
                    for d in metadata["directions"]
                ],
            }
        )

        def encode(filename: str | None, directory: Path = state_dir) -> str | None:
            if not filename:
                return None
            return base64.b64encode((directory / filename).read_bytes()).decode("ascii")

        embedded.append(
            {
                "name": state.name,
                "image": encode("spritesheet.png"),
                "offImage": encode(metadata["off_image"]),
                "highImage": encode("comparison/high-resolution.png"),
                "highOffImage": encode(metadata["comparison"]["off_image"]),
            }
        )
        if target:
            package_source = state_dir / "pixel-agents" / "assets" / "furniture"
            shutil.copytree(
                package_source,
                output_dir / "pixel-agents" / "assets" / "furniture",
                dirs_exist_ok=True,
            )
    sheet.save(output_dir / "spritesheet.png")
    preview_scale = min(4, max(1, 1024 // max(overview.size)))
    preview = overview.resize(
        (overview.width * preview_scale, overview.height * preview_scale), Image.Resampling.NEAREST
    )
    if max(preview.size) > 1024:
        preview.thumbnail((1024, 1024), Image.Resampling.NEAREST)
    preview.save(output_dir / "preview.png")
    if target:
        package_root = output_dir / "pixel-agents"
        with zipfile.ZipFile(output_dir / "pixel-agents.zip", "w", zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(package_root.rglob("*")):
                if path.is_file():
                    archive.write(path, path.relative_to(package_root))
    metadata = {
        "schema_version": 1,
        "project_id": project_id,
        "revision_id": revision_id,
        "image": "spritesheet.png",
        "size": list(sheet.size),
        "columns": columns,
        "rows": len(options.states) * direction_count,
        "palette": palette,
        "transparent": True,
        "settings": options.model_dump(),
        "frames": all_frames,
        "states": states,
        "player": "preview.html",
        "camera": manifest["camera"],
        "blender_version": manifest["blender_version"],
        "pixel_agents": {
            "archive": "pixel-agents.zip",
            "activation": ACTIVATION,
            "state_selection": "Separate furniture variants; no automatic transitions",
        }
        if target
        else None,
    }
    (output_dir / "spritesheet.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    player = {
        "name": target.name if target else "Sprite states",
        "states": embedded,
        "width": options.width,
        "height": options.height,
        "angles": options.angles,
        "fps": options.fps,
        "columns": columns,
        "supersampling": options.supersampling,
        "pixelAgents": bool(target),
    }
    template = Path(__file__).with_name("states_player.html").read_text(encoding="utf-8")
    (output_dir / "preview.html").write_text(
        template.replace("__PLAYER_DATA__", json.dumps(player).replace("<", "\\u003c")),
        encoding="utf-8",
    )
    with zipfile.ZipFile(output_dir / "sprites.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(output_dir.rglob("*")):
            if path.is_file() and path.name != "sprites.zip":
                archive.write(path, path.relative_to(output_dir))
