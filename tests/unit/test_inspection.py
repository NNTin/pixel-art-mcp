from PIL import Image

from pixel_art_mcp.imaging.inspection import compare_inspections, inspect_sprite
from pixel_art_mcp.imaging.pixels import pack_sprites
from pixel_art_mcp.models import RenderOptions


def make_export(tmp_path, gauge_height):
    options = RenderOptions(
        width=8,
        height=8,
        angles=[0],
        palette=["#603010", "#40dfe0"],
    )
    sprite = Image.new("RGBA", (8, 8))
    for y in range(2, 8):
        for x in range(1, 7):
            sprite.putpixel((x, y), (96, 48, 16, 255))
    for y in range(7 - gauge_height, 7):
        sprite.putpixel((5, y), (64, 223, 224, 255))
    manifest = {
        "frames": [{"angle": 0, "frame": 1, "pivot": [4, 7]}],
        "camera": {},
        "blender_version": "fixture",
    }
    output = tmp_path / str(gauge_height)
    pack_sprites(
        [sprite],
        ["#603010", "#40dfe0"],
        output,
        manifest,
        options,
        "project",
        "revision",
    )
    return output


def test_text_inspection_reports_grid_palette_clusters_and_comparison(tmp_path):
    first = inspect_sprite(make_export(tmp_path, 2))
    second = inspect_sprite(make_export(tmp_path, 4))
    assert first["state"] is None
    assert first["angle"] == 0 and first["frame"] == 1
    assert first["analysis"]["occupied_bounds"] == [1, 2, 6, 6]
    assert len(first["grid"]["rows"]) == 8
    assert first["grid"]["rows"][0] == "00 .. .. .. .. .. .. .. .."
    cyan = next(color for color in second["palette"] if color["hex"] == "#40dfe0")
    assert cyan["description"] == "light cyan"
    assert cyan["pixels"] == 4
    assert cyan["longest_vertical_run"] == 4
    comparison = compare_inspections(first, second)
    assert comparison["changed_pixels"] == 2
    assert comparison["alpha_changed_pixels"] == 0
