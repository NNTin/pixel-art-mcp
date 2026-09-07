import base64
import json
import zipfile

import pytest
from PIL import Image, ImageDraw
from pydantic import ValidationError

from pixel_art_mcp.imaging.pixels import export_sheet, pack_sprites, pixelate
from pixel_art_mcp.models import DomainError, RenderOptions


def test_shared_palette_alpha_and_motion():
    source = []
    for y in (2, 10):
        im = Image.new("RGBA", (32, 32), (255, 0, 255, 0))
        ImageDraw.Draw(im).rectangle((8, y, 20, y + 10), fill=(255, 80, 10, 255))
        source.append(im)
    options = RenderOptions(width=16, height=16, colors=4)
    result, palette = pixelate(source, options)
    assert len(palette) <= 4
    assert result[0].getbbox()[1] != result[1].getbbox()[1]
    for im in result:
        assert set(im.getchannel("A").get_flattened_data()) <= {0, 255}
        assert im.getpixel((0, 0)) == (0, 0, 0, 0)
        for r, g, b, a in im.get_flattened_data():
            if a:
                assert f"#{r:02x}{g:02x}{b:02x}" in palette
    again, same_palette = pixelate(source, options)
    assert same_palette == palette
    assert [im.tobytes() for im in result] == [im.tobytes() for im in again]


def test_custom_palette_and_transparent_frames():
    options = RenderOptions(width=8, height=8, palette=["#000000", "#ffffff"])
    images, palette = pixelate([Image.new("RGBA", (8, 8), (240, 240, 240, 255))], options)
    assert images[0].getpixel((0, 0)) == (255, 255, 255, 255)
    assert palette == ["#000000", "#ffffff"]
    images, _ = pixelate([Image.new("RGBA", (8, 8))], RenderOptions(width=8, height=8))
    assert images[0].getbbox() is None


def test_pack_preserves_converted_pixels_and_rejects_incomplete_frames(tmp_path):
    options = RenderOptions(width=8, height=8, angles=[0])
    sprite = Image.new("RGBA", (8, 8), (100, 100, 100, 255))
    sprite.putpixel((0, 0), (101, 101, 101, 255))
    manifest = {
        "frames": [{"angle": 0, "frame": 1, "pivot": [4, 7]}],
        "camera": {},
        "blender_version": "fixture",
    }
    out = tmp_path / "out"
    pack_sprites([sprite], ["#646464", "#656565"], out, manifest, options, "p", "r")
    with Image.open(out / "spritesheet.png") as packed:
        assert packed.tobytes() == sprite.tobytes()
    with pytest.raises(DomainError, match="incomplete"):
        pack_sprites([], [], tmp_path / "bad", manifest, options, "p", "r")
    with pytest.raises(DomainError, match="dimensions or color mode"):
        pack_sprites([sprite.convert("RGB")], [], tmp_path / "bad", manifest, options, "p", "r")


def test_sheet_order_metadata_zip_and_pivot(tmp_path):
    raw = tmp_path / "raw"
    raw.mkdir()
    options = RenderOptions(
        width=8, height=8, supersampling=1, angles=[0, 90], frame_start=1, frame_end=2, fps=10
    )
    frames = []
    for index, (angle, frame) in enumerate([(0, 1), (0, 2), (90, 1), (90, 2)]):
        name = f"{index}.png"
        Image.new("RGBA", (8, 8), (index * 60, 0, 0, 255)).save(raw / name)
        frames.append({"filename": name, "angle": angle, "frame": frame, "pivot": [4, 7]})
    manifest = {
        "frames": frames,
        "camera": {"projection": "orthographic"},
        "blender_version": "fixture",
    }
    out = tmp_path / "export"
    export_sheet(raw, out, manifest, options, "project", "revision")
    metadata = json.loads((out / "spritesheet.json").read_text())
    assert metadata["size"] == [16, 16]
    assert [f["rect"] for f in metadata["frames"]] == [
        [0, 0, 8, 8],
        [8, 0, 8, 8],
        [0, 8, 8, 8],
        [8, 8, 8, 8],
    ]
    assert all(f["pivot"] == [4, 7] and f["duration_ms"] == 100 for f in metadata["frames"])
    with zipfile.ZipFile(out / "sprites.zip") as archive:
        assert "spritesheet.png" in archive.namelist()
        assert "preview.html" in archive.namelist()
        assert len([name for name in archive.namelist() if name.startswith("frames/")]) == 4
        assert len([name for name in archive.namelist() if name.endswith(".apng")]) == 2
    with pytest.raises(DomainError, match="incomplete"):
        export_sheet(raw, tmp_path / "bad", {**manifest, "frames": frames[:1]}, options, "p", "r")


@pytest.mark.parametrize("frame_end", [2, 6])
def test_animation_pixels_timing_transparency_and_offline_player(tmp_path, frame_end):
    raw = tmp_path / "raw"
    raw.mkdir()
    options = RenderOptions(
        width=16,
        height=8,
        supersampling=1,
        angles=[90, 0],
        frame_start=2,
        frame_end=frame_end,
        frame_step=2,
        fps=12,
        palette=["#ff0000", "#00ff00"],
    )
    entries = []
    for row, angle in enumerate(options.angles):
        for column, frame in enumerate(options.frames()):
            name = f"{row}_{frame}.png"
            im = Image.new("RGBA", (16, 8))
            # Motion plus a fully transparent frame exposes APNG ghosting/disposal bugs.
            if column != 1:
                ImageDraw.Draw(im).rectangle(
                    (column * 4, 2, column * 4 + 3, 5),
                    fill=(255, 0, 0, 255) if row == 0 else (0, 255, 0, 255),
                )
            im.save(raw / name)
            entries.append({"filename": name, "angle": angle, "frame": frame, "pivot": [8, 6]})
    out = tmp_path / "out"
    manifest = {"frames": entries, "camera": {}, "blender_version": "fixture"}
    export_sheet(raw, out, manifest, options, "p", "r")
    metadata = json.loads((out / "spritesheet.json").read_text())
    for row, direction in enumerate(metadata["directions"]):
        assert direction["angle"] == options.angles[row]
        assert direction["row"] == row
        indices = direction["frame_indices"]
        assert [metadata["frames"][i]["frame"] for i in indices] == options.frames()
        if len(options.frames()) == 1:
            assert direction["animation"] is None
            assert not (out / "animations").exists()
            continue
        with Image.open(out / direction["animation"]) as animated:
            assert animated.n_frames == len(indices)
            assert animated.info["loop"] == 0
            for column, index in enumerate(indices):
                animated.seek(column)
                assert animated.info["duration"] == pytest.approx(1000 / options.fps)
                with Image.open(out / metadata["frames"][index]["filename"]) as expected:
                    assert animated.convert("RGBA").tobytes() == expected.tobytes()
    html = (out / metadata["player"]).read_text()
    embedded = json.loads(html.split("const data = ", 1)[1].split(";", 1)[0])
    assert base64.b64decode(embedded["image"]) == (out / "spritesheet.png").read_bytes()
    assert embedded["angles"] == [90, 0]
    assert embedded["frames"] == options.frames()
    assert embedded["width"] == 16 and embedded["height"] == 8
    assert "__PLAYER_DATA__" not in html
    if len(options.frames()) == 1:
        assert not (out / "preview.gif").exists()
    else:
        with Image.open(out / "preview.gif") as gif:
            assert gif.n_frames == len(options.frames())
            assert gif.info["loop"] == 0
            gif.seek(0)
            # GIF stores duration in centiseconds, so it rounds to the nearest 10ms.
            assert gif.info["duration"] == round(1000 / options.fps / 10) * 10
        with zipfile.ZipFile(out / "sprites.zip") as archive:
            assert "preview.gif" in archive.namelist()


@pytest.mark.parametrize(
    "options",
    [
        {"angles": [0, 360]},
        {"angles": [float("nan")]},
        {"elevation": float("inf")},
        {"frame_start": 10, "frame_end": 1},
        {"width": 0},
        {"palette": ["red", "#ffffff"]},
        {"palette": ["#ffffff", "#FFFFFF"]},
        {"unknown": True},
    ],
)
def test_invalid_options(options):
    with pytest.raises(ValidationError):
        RenderOptions(**options)
