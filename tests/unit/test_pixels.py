import json
import zipfile

import pytest
from PIL import Image, ImageDraw
from pydantic import ValidationError

from pixel_art_mcp.imaging.pixels import export_sheet, pixelate
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
        assert len([name for name in archive.namelist() if name.startswith("frames/")]) == 4
    with pytest.raises(DomainError, match="incomplete"):
        export_sheet(raw, tmp_path / "bad", {**manifest, "frames": frames[:1]}, options, "p", "r")


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
