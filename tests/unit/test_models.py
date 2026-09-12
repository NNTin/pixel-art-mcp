import pytest
from pydantic import ValidationError

from pixel_art_mcp.models import RenderOptions


def test_meters_per_tile_defaults_to_one_meter_per_tile():
    options = RenderOptions()
    assert options.meters_per_tile == 1.0


def test_meters_per_tile_round_trips():
    options = RenderOptions(meters_per_tile=1.5)
    assert options.meters_per_tile == 1.5
    assert RenderOptions.model_validate(options.model_dump()) == options


def test_meters_per_tile_can_be_explicitly_disabled():
    options = RenderOptions.model_validate({"meters_per_tile": None})
    assert options.meters_per_tile is None
    assert RenderOptions.model_validate(options.model_dump()) == options


@pytest.mark.parametrize(
    "value",
    [0, -1, 1001, float("nan"), float("inf"), float("-inf")],
)
def test_meters_per_tile_rejects_out_of_range_values(value):
    with pytest.raises(ValidationError):
        RenderOptions.model_validate({"meters_per_tile": value})


@pytest.mark.parametrize(
    "extra",
    [
        {"pixel_agents": {"asset_id": "LAMP", "name": "Lamp"}},
        {
            "character": {"asset_id": "HERO", "name": "Hero"},
            "angles": [0, 90, 180],
            "width": 16,
            "height": 32,
            "frame_start": 1,
            "frame_end": 7,
        },
        {
            "pet": {"asset_id": "CAT", "name": "Cat"},
            "angles": [0, 90, 180],
            "width": 16,
            "height": 32,
            "states": [
                {"id": "walk", "name": "Walk", "frame_start": 1, "frame_end": 3},
                {"id": "idle", "name": "Idle", "frame_start": 4, "frame_end": 6},
            ],
        },
        {
            "states": [
                {"id": "empty", "name": "Empty", "frame_start": 1, "frame_end": 1},
            ]
        },
    ],
)
def test_meters_per_tile_coexists_with_every_export_kind(extra):
    RenderOptions.model_validate({"meters_per_tile": 1.0, **extra})
