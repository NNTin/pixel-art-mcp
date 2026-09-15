import pytest
from pydantic import TypeAdapter, ValidationError

from pixel_art_mcp.assets import get_asset_profile
from pixel_art_mcp.authoring import PixelDefinition, PixelEdits, apply_pixel_edits

EDITS = TypeAdapter(PixelEdits)


@pytest.fixture
def source():
    return PixelDefinition.model_validate(
        get_asset_profile("furniture")["pixel_authoring"]["example_definition"]
    )


def test_move_preserves_everything_except_selected_position(source):
    before = source.model_dump()
    changed = apply_pixel_edits(
        source,
        EDITS.validate_python(
            [{"op": "move_pose", "layer": "marker", "angle": 0, "frame": None, "x": 4, "y": 3}]
        ),
    )
    expected = source.model_dump()
    expected["layers"][0]["poses"][0].update(x=4, y=3)
    assert changed.model_dump() == expected
    assert source.model_dump() == before


def test_ordered_batch_layer_and_pose_replacement_defaults_and_deletion(source):
    changed = apply_pixel_edits(
        source,
        EDITS.validate_python(
            [
                {
                    "op": "set_layer",
                    "layer": {"name": "badge", "poses": [{"angle": 0, "rows": ["GG"]}]},
                },
                {
                    "op": "set_pose",
                    "layer": "marker",
                    "pose": {"angle": 0, "frame": 1, "rows": ["D"], "x": 2},
                },
                {"op": "move_pose", "layer": "marker", "angle": 0, "frame": 1, "x": 3, "y": 4},
                {
                    "op": "set_pose",
                    "layer": "marker",
                    "pose": {"angle": 0, "frame": 1, "rows": ["GG"]},
                },
                {
                    "op": "set_layer",
                    "layer": {"name": "badge", "poses": [{"angle": 90, "rows": ["D"]}]},
                },
                {
                    "op": "set_layer",
                    "layer": {"name": "temporary", "poses": [{"angle": 0, "rows": ["D"]}]},
                },
                {"op": "delete_layer", "name": "temporary"},
            ]
        ),
    )
    assert [layer.name for layer in changed.layers] == ["marker", "badge"]
    assert changed.layers[0].poses[:4] == source.layers[0].poses
    assert changed.layers[0].poses[-1].x == changed.layers[0].poses[-1].y == 0
    assert [pose.angle for pose in changed.layers[1].poses] == [90]
    restored = apply_pixel_edits(
        changed,
        EDITS.validate_python(
            [
                {"op": "delete_pose", "layer": "marker", "angle": 0, "frame": 1},
                {"op": "delete_layer", "name": "badge"},
            ]
        ),
    )
    assert restored == source


def test_only_final_document_is_validated(source):
    changed = apply_pixel_edits(
        source,
        EDITS.validate_python(
            [
                {"op": "set_pose", "layer": "marker", "pose": {"angle": 0, "rows": ["B"]}},
                {"op": "set_palette", "palette": {**source.palette, "B": "#778899"}},
            ]
        ),
    )
    assert changed.layers[0].poses[0].rows == ["B"]
    assert "B" not in source.palette


@pytest.mark.parametrize(
    "edit",
    [
        {"op": "move_pose", "layer": "marker", "angle": 0, "frame": 1, "x": 3, "y": 4},
        {"op": "delete_pose", "layer": "marker", "angle": 0, "frame": 1},
        {"op": "delete_layer", "name": "missing"},
        {"op": "set_pose", "layer": "missing", "pose": {"angle": 0, "rows": ["D"]}},
        {"op": "set_palette", "palette": {"D": "#000000", "X": "#ffffff"}},
        {"op": "delete_layer", "name": "marker"},
    ],
)
def test_invalid_batch_preserves_original(source, edit):
    before = source.model_dump()
    with pytest.raises(ValueError):
        apply_pixel_edits(
            source,
            EDITS.validate_python(
                [
                    {
                        "op": "move_pose",
                        "layer": "marker",
                        "angle": 0,
                        "frame": None,
                        "x": 4,
                        "y": 3,
                    },
                    edit,
                ]
            ),
        )
    assert source.model_dump() == before


@pytest.mark.parametrize(
    "edits",
    [
        [],
        [{"op": "unknown"}],
        [{"op": "delete_layer", "name": "marker"}] * 129,
        [{"op": "move_pose", "layer": "marker", "angle": 0, "x": 1, "y": 1}],
        [{"op": "move_pose", "layer": "marker", "angle": 0, "frame": None, "x": True, "y": 1}],
        [{"op": "move_pose", "layer": "marker", "angle": 0, "frame": None, "x": 513, "y": 1}],
        [{"op": "set_pose", "layer": "marker", "pose": {"angle": 0, "rows": ["GG", "G"]}}],
    ],
)
def test_edit_schema_rejects_invalid_input(edits):
    with pytest.raises(ValidationError):
        EDITS.validate_python(edits)
