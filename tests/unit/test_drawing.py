import copy

import pytest
from pydantic import ValidationError

from pixel_art_mcp.assets import asset_layouts, get_asset_profile
from pixel_art_mcp.authoring import PixelDefinition, PixelPose
from pixel_art_mcp.drawing import PixelDrawing
from pixel_art_mcp.models import AssetSpec, DomainError
from pixel_art_mcp.pixel_art import Canvas


def rect(**changes):
    return {"op": "rect", "x": 0, "y": 0, "width": 4, "height": 3, "color": "A", **changes}


def test_commands_use_helper_pixels_in_order_and_mirror():
    commands = [
        rect(),
        {"op": "line", "x1": 0, "y1": 0, "x2": 3, "y2": 2, "color": "B"},
        {"op": "stamp", "x": 0, "y": 0, "rows": [".C"], "repeat": 2, "dy": 2},
    ]
    drawing = PixelDrawing(width=4, height=3, commands=commands)
    expected = Canvas(4, 3).rect(0, 0, 4, 3, "A").line(0, 0, 3, 2, "B")
    expected.stamp(0, 0, [".C"]).stamp(0, 2, [".C"])
    assert drawing.canvas().rows == expected.rows
    drawing.mirror_x = True
    assert drawing.canvas().rows == [r[::-1] for r in expected.rows]


@pytest.mark.parametrize("end", [(0, 0), (4, 0), (0, 4), (4, 4), (4, 2), (2, 4)])
def test_integer_lines_include_endpoints_and_never_antialias(end):
    canvas = Canvas(5, 5).line(0, 0, *end, "A")
    rows = canvas.rows
    assert rows[0][0] == rows[end[1]][end[0]] == "A"
    assert sum(r.count("A") for r in rows) == max(end) + 1
    reverse = Canvas(5, 5).line(*end, 0, 0, "A").rows
    assert reverse[0][0] == reverse[end[1]][end[0]] == "A"


def test_rectangles_do_not_require_counting_large_strings():
    drawing = PixelDrawing(width=40, height=6, commands=[rect(width=40, height=6)])
    assert drawing.canvas().rows == ["A" * 40] * 6
    with pytest.raises(ValueError, match="row 3: expected 40, actual 39"):
        Canvas.from_rows(["A" * n for n in [40, 40, 40, 39, 40, 40]])


@pytest.mark.parametrize(
    "command",
    [
        rect(x=True),
        rect(width=1.5),
        rect(color="?"),
        rect(repeat=129),
        rect(op="ellipse"),
        rect(x=1),
        rect(dx=1, repeat=2),
        rect(dx=-1, repeat=2),
        {"op": "line", "x1": 0, "y1": 0, "x2": 4, "y2": 0, "color": "A"},
        {"op": "stamp", "x": 0, "y": 0, "rows": ["AA", "A"]},
    ],
)
def test_invalid_commands_rejected_before_rasterization(command):
    with pytest.raises(ValidationError):
        PixelDrawing(width=4, height=3, commands=[command])


def test_negative_repeat_offsets_within_patch_and_paint_budget():
    drawing = PixelDrawing(
        width=4,
        height=3,
        commands=[
            rect(x=3, width=1, height=1, repeat=4, dx=-1),
        ],
    )
    assert drawing.canvas().rows == ["AAAA", "....", "...."]
    with pytest.raises(ValidationError, match="paint operations"):
        PixelDrawing(width=512, height=512, commands=[rect(width=512, height=512, repeat=5)])


def test_exactly_one_pose_representation_and_palette_validation():
    with pytest.raises(ValidationError, match="exactly one"):
        PixelPose(angle=0)
    with pytest.raises(ValidationError, match="exactly one"):
        PixelPose(angle=0, rows=["A"], drawing={"width": 4, "height": 3, "commands": [rect()]})
    definition = get_asset_profile("furniture")["pixel_authoring"]["example_definition"]
    pose = definition["layers"][0]["poses"][0]
    pose.pop("rows")
    pose["drawing"] = {"width": 4, "height": 3, "commands": [rect()]}
    with pytest.raises(ValidationError, match="palette"):
        PixelDefinition.model_validate(definition)


def test_total_drawing_cost_bounded_across_poses():
    definition = get_asset_profile("furniture")["pixel_authoring"]["example_definition"]
    for pose in definition["layers"][0]["poses"]:
        pose.pop("rows")
        pose["drawing"] = {
            "width": 128,
            "height": 128,
            "commands": [rect(width=128, height=128, repeat=32, color="G")],
        }
    with pytest.raises(ValidationError, match="paint operations"):
        PixelDefinition.model_validate(definition)


def test_custom_occupied_footprint_preserves_pixel_density_and_rotates():
    profile = get_asset_profile("furniture", "desk", ground_width=3, ground_depth=4)
    assert [(r["width"], r["height"]) for r in profile["layouts"]] == [
        (48, 80),
        (64, 64),
        (48, 80),
        (64, 64),
    ]
    assert profile["sizing"]["occupied_ground_tiles"] == [3, 4]
    explicit = get_asset_profile("furniture", ground_width=3, ground_depth=4, background_tiles=1)
    assert [(r["width"], r["height"]) for r in explicit["layouts"]] == [
        (48, 80),
        (64, 64),
        (48, 80),
        (64, 64),
    ]
    definition = PixelDefinition.model_validate(profile["pixel_authoring"]["example_definition"])
    definition.to_art(profile["layouts"])
    spec = copy.deepcopy(explicit["specification"])
    spec["height"] = 80
    assert asset_layouts(AssetSpec.model_validate(spec)) == explicit["layouts"]
    spec["height"] = 96
    with pytest.raises(DomainError, match="background_tiles"):
        asset_layouts(AssetSpec.model_validate(spec))
    spec["height"], spec["background_tiles"] = 32, None
    with pytest.raises(DomainError, match="minimum height is 64px"):
        asset_layouts(AssetSpec.model_validate(spec))


def test_rotated_custom_layout_limit_and_nonfurniture_restriction():
    for kind in ("character", "pet"):
        assert get_asset_profile(kind)["sizing"]["native_views"]["0"] == [16, 32]
    with pytest.raises(DomainError, match="512"):
        get_asset_profile("furniture", ground_width=16, background_tiles=31)
    with pytest.raises(ValidationError, match="furniture"):
        get_asset_profile("character", background_tiles=1)
