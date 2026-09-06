"""Export the existing pixel-agents furniture contract without changing that app."""

import json
import math
import zipfile
from pathlib import Path
from typing import Any

from PIL import Image

from pixel_art_mcp.models import RenderOptions

ORIENTATIONS = {0: "front", 90: "right", 180: "back", 270: "left"}
ACTIVATION = (
    "pixel-agents plays on-state furniture at 5 fps only when activated by a nearby working agent. "
    "Otherwise it shows the off pose. Always-on furniture animation is not supported by that app."
)


def export_pixel_agents(
    output_dir: Path,
    options: RenderOptions,
    frames: list[Image.Image],
    off_frames: list[Image.Image] | None,
) -> dict[str, Any] | None:
    target = options.pixel_agents
    if target is None:
        return None
    directory = output_dir / "pixel-agents" / "assets" / "furniture" / target.asset_id
    directory.mkdir(parents=True)
    columns = len(options.frames())
    animated = columns > 1
    if animated and (off_frames is None or len(off_frames) != len(options.angles)):
        raise ValueError("Missing pixel-agents off-state renders")

    def asset(im: Image.Image, orientation: str, suffix: str = "", **extra: Any) -> dict[str, Any]:
        asset_id = f"{target.asset_id}_{orientation.upper()}{suffix}"
        filename = f"{asset_id}.png"
        im.save(directory / filename)
        return {
            "type": "asset",
            "id": asset_id,
            "file": filename,
            "width": options.width,
            "height": options.height,
            "footprintW": target.footprint_w or math.ceil(options.width / 16),
            "footprintH": target.footprint_h or math.ceil(options.height / 16),
            "orientation": orientation,
            **extra,
        }

    members = []
    for row, angle in enumerate(options.angles):
        orientation = ORIENTATIONS[int(angle)]
        if animated:
            assert off_frames is not None
            # OFF goes first, then ON frames in ascending order. This matches the PC manifest
            # and gives the app an off->on state transition through which animation is applied.
            members.append(
                {
                    "type": "group",
                    "groupType": "state",
                    "orientation": orientation,
                    "members": [
                        asset(off_frames[row], orientation, "_OFF", state="off"),
                        {
                            "type": "group",
                            "groupType": "animation",
                            "state": "on",
                            "members": [
                                asset(
                                    frames[row * columns + column],
                                    orientation,
                                    f"_ON_{column + 1}",
                                    frame=column,
                                )
                                for column in range(columns)
                            ],
                        },
                    ],
                }
            )
        else:
            members.append(asset(frames[row * columns], orientation))
    manifest = {
        "id": target.asset_id,
        "name": target.name,
        "category": target.category,
        "canPlaceOnWalls": target.can_place_on_walls,
        "canPlaceOnSurfaces": target.can_place_on_surfaces,
        "backgroundTiles": target.background_tiles,
        "type": "group",
        "groupType": "rotation",
        "rotationScheme": "4-way",
        "members": members,
    }
    manifest_path = directory / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    package_root = output_dir / "pixel-agents"
    with zipfile.ZipFile(output_dir / "pixel-agents.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(directory.iterdir()):
            archive.write(path, path.relative_to(package_root))
    return {
        "manifest": manifest_path.relative_to(output_dir).as_posix(),
        "archive": "pixel-agents.zip",
        "asset_id": target.asset_id,
        "width": options.width,
        "height": options.height,
        "fps": 5,
        "activation": ACTIVATION if animated else "Static furniture",
        "install": "Extract pixel-agents.zip into webview-ui/public, then reload/rebuild assets.",
    }
