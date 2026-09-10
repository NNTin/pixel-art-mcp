import io
import zipfile

import pytest
from PIL import Image, ImageDraw
from pydantic import ValidationError

from pixel_art_mcp.imaging.pixels import export_sheet
from pixel_art_mcp.models import RenderOptions


@pytest.mark.parametrize(
    "values",
    [
        {"angles": [0, 45, 180]},
        {"angles": [0, 90]},
        {"width": 32},
        {"height": 16},
        {"frame_end": 5},  # only 6 frames
        {"states": [{"id": "walk", "name": "Walk", "frame_start": 0, "frame_end": 6}]},
        {"pixel_agents": {"asset_id": "HERO", "name": "Hero"}},
    ],
)
def test_character_constraints_are_rejected_before_render(values):
    base = {
        "tile_width": 1,
        "tile_height": 2,
        "angles": [0, 90, 180],
        "frame_start": 0,
        "frame_end": 6,
        "character": {"name": "Hero"},
    }
    with pytest.raises(ValidationError):
        RenderOptions.model_validate({**base, **values})


def test_character_and_pixel_agents_are_mutually_exclusive():
    with pytest.raises(ValidationError, match="Only one of pixel_agents/character"):
        RenderOptions.model_validate(
            {
                "angles": [0],
                "pixel_agents": {"asset_id": "LAMP", "name": "Lamp"},
                "character": {"name": "Hero"},
            }
        )


def test_character_package_is_manifest_less_and_matches_the_general_spritesheet(tmp_path):
    options = RenderOptions(
        tile_width=1,
        tile_height=2,
        angles=[0, 90, 180],
        frame_start=0,
        frame_end=6,
        supersampling=1,
        character={"name": "Hero"},
    )
    raw, out = tmp_path / "raw", tmp_path / "out"
    raw.mkdir()
    entries = []
    for row, angle in enumerate(options.angles):
        for frame in options.frames():
            image = Image.new("RGBA", (16, 32), (0, 0, 0, 0))
            ImageDraw.Draw(image).ellipse(
                (2, 2, 13, 13 + frame), fill=(10 * frame, 20 * row, 40, 255)
            )
            name = f"{row}_{frame}.png"
            image.save(raw / name)
            entries.append({"filename": name, "angle": angle, "frame": frame, "pivot": [8, 28]})
    export_sheet(
        raw, out, {"frames": entries, "camera": {}, "blender_version": "test"}, options, "p", "r"
    )

    metadata = out / "spritesheet.json"
    assert '"character"' in metadata.read_text()
    with (
        Image.open(out / "spritesheet.png") as sheet,
        zipfile.ZipFile(out / "pixel-agents-character.zip") as archive,
    ):
        sheet = sheet.convert("RGBA")
        assert archive.namelist() == ["character.png"]
        with Image.open(io.BytesIO(archive.read("character.png"))) as character:
            assert character.size == (112, 96)
            character = character.convert("RGBA")
            for row_index, (direction, angle) in enumerate(
                [("down", 0), ("up", 180), ("right", 90)]
            ):
                source_row = options.angles.index(angle)
                for column in range(7):
                    expected = sheet.crop(
                        (column * 16, source_row * 32, (column + 1) * 16, (source_row + 1) * 32)
                    )
                    actual = character.crop(
                        (column * 16, row_index * 32, (column + 1) * 16, (row_index + 1) * 32)
                    )
                    assert actual.tobytes() == expected.tobytes(), (
                        f"{direction} frame {column} mismatch"
                    )
