import base64
import io
import json
import zipfile

import pytest
from PIL import Image, ImageDraw
from pydantic import ValidationError

from pixel_art_mcp.imaging.pixels import export_sheet
from pixel_art_mcp.models import DomainError, RenderOptions


@pytest.mark.parametrize(
    "tiles,size",
    [
        ((1, 1), (16, 16)),
        ((1, 2), (16, 32)),
        ((1, 3), (16, 48)),
        ((2, 1), (32, 16)),
        ((2, 2), (32, 32)),
    ],
)
def test_tile_sizes_and_explicit_override(tiles, size):
    options = RenderOptions(tile_width=tiles[0], tile_height=tiles[1])
    assert (options.width, options.height) == size
    assert options.fps == 5 and options.angles == [0, 90, 180, 270]
    assert RenderOptions.model_validate(options.model_dump()) == options
    override = RenderOptions(tile_width=tiles[0], tile_height=tiles[1], width=19, height=27)
    assert (override.width, override.height) == (19, 27)


@pytest.mark.parametrize(
    "values",
    [
        {"fps": 12},
        {"angles": [45]},
        {"frame_end": 8},
        {"tile_width": 33},
        {"tile_height": 1.5},
        {"tile_width": True},
        {"pixel_agents": {"asset_id": "../BAD", "name": "Bad"}},
        {"pixel_agents": {"asset_id": "BAD", "name": "Bad", "background_tiles": 1}},
    ],
)
def test_target_constraints_are_rejected_before_render(values):
    with pytest.raises(ValidationError):
        RenderOptions.model_validate(
            {"pixel_agents": {"asset_id": "LAMP", "name": "Lamp"}, **values}
        )


@pytest.mark.parametrize("animated", [False, True])
def test_installable_package_and_real_high_resolution_comparison(tmp_path, animated):
    options = RenderOptions(
        tile_height=3,
        angles=[90, 0],
        supersampling=2,
        frame_start=2,
        frame_end=4 if animated else 2,
        frame_step=2,
        pixel_agents={
            "asset_id": "LAMP",
            "name": "Lamp",
            "can_place_on_surfaces": True,
            "footprint_w": 1,
            "footprint_h": 1,
            "off_frame": 0 if animated else None,
        },
    )
    raw, out = tmp_path / "raw", tmp_path / "out"
    raw.mkdir()
    entries = []
    originals = []
    for row, angle in enumerate(options.angles):
        for frame in options.render_frames():
            image = Image.new("RGBA", (32, 96))
            ImageDraw.Draw(image).rectangle(
                (8 + frame, 55, 24, 90), fill=(150, 80 + row * 50, 20, 255)
            )
            if frame:
                # Isolated pixels survive here, but not in nearest-upscaled low-res.
                image.putpixel((10 + frame, 20), (255, 230, 10, 255))
            name = f"{row}_{frame}.png"
            image.save(raw / name)
            originals.append(image)
            entries.append({"filename": name, "angle": angle, "frame": frame, "pivot": [8, 44]})
    export_sheet(
        raw, out, {"frames": entries, "camera": {}, "blender_version": "test"}, options, "p", "r"
    )
    metadata = json.loads((out / "spritesheet.json").read_text())
    assert metadata["settings"]["fps"] == 5
    assert all(f["duration_ms"] == 200 for f in metadata["frames"])
    with Image.open(out / metadata["comparison"]["image"]) as high:
        assert high.crop((0, 0, 32, 96)).tobytes() == originals[0].tobytes()
        with Image.open(out / "spritesheet.png") as low:
            enlarged = low.crop((0, 0, 16, 48)).resize((32, 96), Image.Resampling.NEAREST)
            assert enlarged.tobytes() != high.crop((0, 0, 32, 96)).tobytes()
    with zipfile.ZipFile(out / "pixel-agents.zip") as archive:
        root = "assets/furniture/LAMP/"
        manifest = json.loads(archive.read(root + "manifest.json"))
        assert manifest["groupType"] == "rotation" and manifest["rotationScheme"] == "4-way"
        assert manifest["canPlaceOnSurfaces"] is True
        assert [m["orientation"] for m in manifest["members"]] == ["right", "front"]
        for row, member in enumerate(manifest["members"]):
            if animated:
                assert member["groupType"] == "state"
                off, on = member["members"]
                assert off["state"] == "off"
                assert on["groupType"] == "animation" and on["state"] == "on"
                assert [leaf["frame"] for leaf in on["members"]] == [0, 1]
                leaves = [off, *on["members"]]
                with Image.open(out / "off-spritesheet.png") as sheet:
                    with Image.open(io.BytesIO(archive.read(root + off["file"]))) as image:
                        assert (
                            image.tobytes()
                            == sheet.crop((0, row * 48, 16, (row + 1) * 48)).tobytes()
                        )
            else:
                assert member["type"] == "asset"
                leaves = [member]
            for leaf in leaves:
                assert leaf["width"] == 16 and leaf["height"] == 48
                assert leaf["footprintW"] == leaf["footprintH"] == 1
                with Image.open(io.BytesIO(archive.read(root + leaf["file"]))) as image:
                    assert image.size == (16, 48)
        assert len(archive.namelist()) == (7 if animated else 3)
    html = (out / "preview.html").read_text()
    data = json.loads(html.split("const data = ", 1)[1].split(";", 1)[0])
    assert data["target"]["width"] == 16 and data["target"]["height"] == 48
    assert data["comparison"]["width"] == 32 and data["comparison"]["height"] == 96
    assert (
        base64.b64decode(data["comparison"]["image"])
        == (out / "comparison/high-resolution.png").read_bytes()
    )
    assert bool(data["offImage"]) == animated
    assert "USED BY PIXEL-AGENTS" in html


def test_high_resolution_and_off_frames_count_toward_limits(service, monkeypatch):
    monkeypatch.setattr(service, "revision", lambda *args: {"id": "r"})
    with pytest.raises(DomainError, match="High-resolution"):
        service.submit_render("p", RenderOptions(width=512, height=512, angles=[0], frame_end=5))
    service.settings.max_render_frames = 2
    with pytest.raises(DomainError, match="total frame"):
        service.submit_render(
            "p",
            RenderOptions(
                angles=[0],
                frame_end=2,
                pixel_agents={"asset_id": "LAMP", "name": "Lamp", "off_frame": 0},
            ),
        )
