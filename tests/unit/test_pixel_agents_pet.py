import io
import json
import zipfile

import pytest
from PIL import Image
from pydantic import ValidationError

from pixel_art_mcp.imaging.pixels import export_sheet
from pixel_art_mcp.models import RenderOptions

WALK = {"id": "walk", "name": "Walk", "frame_start": 0, "frame_end": 2}
IDLE = {"id": "idle", "name": "Idle", "frame_start": 10, "frame_end": 12}


def base_options(**overrides):
    return {
        "tile_width": 1,
        "tile_height": 2,
        "angles": [0, 90, 180],
        "states": [WALK, IDLE],
        "pet": {"asset_id": "TABBY_CAT", "name": "Tabby Cat"},
        **overrides,
    }


@pytest.mark.parametrize(
    "values",
    [
        {"angles": [0, 45, 180]},
        {"angles": [0, 90]},
        {"width": 32},
        {"height": 16},
        {"states": [WALK]},  # missing idle
        {"states": [WALK, {**IDLE, "id": "empty"}]},  # wrong id
        {"states": [{**WALK, "frame_end": 3}, IDLE]},  # 4 frames, not 3
        {"states": [{**WALK, "off_frame": 0}, IDLE]},
    ],
)
def test_pet_constraints_are_rejected_before_render(values):
    with pytest.raises(ValidationError):
        RenderOptions.model_validate(base_options(**values))


def test_pet_and_character_are_mutually_exclusive():
    with pytest.raises(ValidationError, match="Only one of pixel_agents/character/pet"):
        RenderOptions.model_validate(
            {
                **base_options(),
                "character": {"asset_id": "HERO", "name": "Hero"},
                "angles": [0, 90, 180],
            }
        )


def color(angle, frame):
    return (frame * 15 % 256, (int(angle) * 2) % 256, 50, 255)


def test_pet_package_manifest_and_asymmetric_grid(tmp_path):
    options = RenderOptions.model_validate({**base_options(), "supersampling": 1})
    raw, out = tmp_path / "raw", tmp_path / "out"
    raw.mkdir()
    entries = []
    frames = options.render_frames()
    for row, angle in enumerate(options.angles):
        width = 32 if angle == 90 else 16
        for frame in frames:
            image = Image.new("RGBA", (width, 32), color(angle, frame))
            name = f"{row}_{frame}.png"
            image.save(raw / name)
            entries.append({"filename": name, "angle": angle, "frame": frame, "pivot": [0, 0]})

    export_sheet(
        raw, out, {"frames": entries, "camera": {}, "blender_version": "test"}, options, "p", "r"
    )

    with zipfile.ZipFile(out / "pixel-agents-pet.zip") as archive:
        assert sorted(archive.namelist()) == ["TABBY_CAT/manifest.json", "TABBY_CAT/pet.png"]
        manifest = json.loads(archive.read("TABBY_CAT/manifest.json"))
        assert manifest == {"id": "TABBY_CAT", "name": "Tabby Cat"}
        with Image.open(io.BytesIO(archive.read("TABBY_CAT/pet.png"))) as pet:
            assert pet.size == (96, 96)
            pet = pet.convert("RGBA")

            def cell(x, y, w, h):
                return pet.crop((x, y, x + w, y + h)).getpixel((0, 0))

            walk_frames = [WALK["frame_start"] + i for i in range(3)]
            idle_frames = [IDLE["frame_start"] + i for i in range(3)]
            for column, frame in enumerate(walk_frames):
                assert cell(column * 16, 0, 16, 32) == color(0, frame)
                assert cell(column * 16, 32, 16, 32) == color(180, frame)
                assert cell(column * 32, 64, 32, 32) == color(90, frame)
            for column, frame in enumerate(idle_frames, start=3):
                assert cell(column * 16, 0, 16, 32) == color(0, frame)
                assert cell(column * 16, 32, 16, 32) == color(180, frame)

    metadata = json.loads((out / "spritesheet.json").read_text())
    assert metadata["pet"]["walk_frames"] == [0, 1, 2]
    assert metadata["pet"]["idle_frames"] == [10, 11, 12]
