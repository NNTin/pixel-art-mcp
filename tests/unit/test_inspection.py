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
    assert first["analysis"]["opaque_connected_components"] == 1
    assert first["analysis"]["color_components"] == 2
    assert comparison["opaque_connected_component_delta"] == 0
    assert comparison["color_component_delta"] == 0


def test_color_singletons_are_not_detached_opaque_pixels(tmp_path):
    root = make_export(tmp_path, 2)
    original = inspect_sprite(root)
    path = root / original["filename"]
    with Image.open(path) as opened:
        image = opened.convert("RGBA")
    image.putpixel((2, 3), (64, 223, 224, 255))
    image.save(path)
    marked = inspect_sprite(root)
    analysis = marked["analysis"]
    assert analysis["opaque_connected_components"] == 1
    assert analysis["opaque_singleton_components"] == 0
    assert analysis["color_components"] == 3
    assert analysis["color_singleton_components"] == 1
    assert "opaque_components" not in analysis and "singleton_components" not in analysis
    delta = compare_inspections(original, marked)
    assert delta["opaque_connected_component_delta"] == 0
    assert delta["color_component_delta"] == delta["color_singleton_component_delta"] == 1
    image.putpixel((0, 0), (96, 48, 16, 255))
    image.save(path)
    detached = inspect_sprite(root)
    assert detached["analysis"]["opaque_connected_components"] == 2
    assert detached["analysis"]["opaque_singleton_components"] == 1
    assert detached["analysis"]["color_singleton_components"] == 2
    assert (
        "not necessarily detached" in detached["metric_definitions"]["color_singleton_components"]
    )


def test_empty_and_diagonal_alpha_connectivity(tmp_path):
    root = make_export(tmp_path, 2)
    path = root / inspect_sprite(root)["filename"]
    image = Image.new("RGBA", (8, 8))
    image.save(path)
    empty = inspect_sprite(root)["analysis"]
    for key in (
        "opaque_connected_components",
        "opaque_singleton_components",
        "color_components",
        "color_singleton_components",
    ):
        assert empty[key] == 0
    image.putpixel((0, 0), (96, 48, 16, 255))
    image.putpixel((1, 1), (64, 223, 224, 255))
    image.save(path)
    assert inspect_sprite(root)["analysis"]["opaque_connected_components"] == 2
