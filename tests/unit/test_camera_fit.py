import math

import pytest

from pixel_art_mcp.blender.camera_fit import TILE_PIXELS, fit_camera, row_pivot


def legacy_scale(xmin, xmax, ymin, ymax, base_width, base_height, padding):
    scale = max((xmax - xmin) / base_width, (ymax - ymin) / base_height, 0.001)
    return scale * (1 + 2 * padding)


@pytest.mark.parametrize(
    "bounds,base,padding",
    [
        ((-1, 1, -1, 1), (2, 2), 0.1),
        ((-2, 3, -1, 4), (4, 8), 0.0),
        ((0, 0.5, -1, 1), (10, 2), 0.5),
    ],
)
def test_legacy_path_reproduces_auto_fit_formula(bounds, base, padding):
    xmin, xmax, ymin, ymax = bounds
    base_width, base_height = base
    fit = fit_camera(
        base_width=base_width,
        base_height=base_height,
        xmin=xmin,
        xmax=xmax,
        ymin=ymin,
        ymax=ymax,
        padding=padding,
        height=16,
        meters_per_tile=None,
    )
    expected = legacy_scale(xmin, xmax, ymin, ymax, base_width, base_height, padding)
    assert fit.ortho_scale == pytest.approx(expected)


def test_legacy_path_floors_degenerate_bounds():
    fit = fit_camera(
        base_width=2,
        base_height=2,
        xmin=1,
        xmax=1,
        ymin=1,
        ymax=1,
        padding=0.0,
        height=16,
        meters_per_tile=None,
    )
    assert fit.ortho_scale == pytest.approx(0.001)


@pytest.mark.parametrize(
    "bounds",
    [
        (-0.01, 0.01, -0.01, 0.01),
        (-500, 500, -500, 500),
    ],
)
def test_fixed_scale_is_independent_of_bounding_box(bounds):
    xmin, xmax, ymin, ymax = bounds
    fit = fit_camera(
        base_width=2,
        base_height=2,
        xmin=xmin,
        xmax=xmax,
        ymin=ymin,
        ymax=ymax,
        padding=0.1,
        height=16,
        meters_per_tile=1.0,
    )
    assert fit.ortho_scale == pytest.approx(0.6)


def test_fixed_scale_exact_value():
    fit = fit_camera(
        base_width=2,
        base_height=2,
        xmin=-1,
        xmax=1,
        ymin=-1,
        ymax=1,
        padding=0.0,
        height=16,
        meters_per_tile=1.0,
    )
    assert fit.ortho_scale == pytest.approx(0.5)

    padded = fit_camera(
        base_width=2,
        base_height=2,
        xmin=-1,
        xmax=1,
        ymin=-1,
        ymax=1,
        padding=0.1,
        height=16,
        meters_per_tile=1.0,
    )
    assert padded.ortho_scale == pytest.approx(0.6)


@pytest.mark.parametrize("meters_per_tile", [0.5, 1.0, 2.5])
def test_fixed_scale_linear_in_meters_per_tile(meters_per_tile):
    fit = fit_camera(
        base_width=2,
        base_height=2,
        xmin=-1,
        xmax=1,
        ymin=-1,
        ymax=1,
        padding=0.0,
        height=16,
        meters_per_tile=meters_per_tile,
    )
    assert fit.ortho_scale == pytest.approx(meters_per_tile / 2)


@pytest.mark.parametrize("height", [16, 32, 48])
def test_fixed_scale_linear_in_height(height):
    fit = fit_camera(
        base_width=2,
        base_height=2,
        xmin=-1,
        xmax=1,
        ymin=-1,
        ymax=1,
        padding=0.0,
        height=height,
        meters_per_tile=1.0,
    )
    assert fit.ortho_scale == pytest.approx((height * 1.0 / TILE_PIXELS) / 2)


@pytest.mark.parametrize("meters_per_tile", [None, 1.0])
def test_cx_cy_always_bounds_derived(meters_per_tile):
    fit = fit_camera(
        base_width=2,
        base_height=2,
        xmin=-1,
        xmax=3,
        ymin=-2,
        ymax=6,
        padding=0.1,
        height=16,
        meters_per_tile=meters_per_tile,
    )
    assert fit.cx == pytest.approx(1.0)
    assert fit.cy == pytest.approx(2.0)


def test_row_pivot_formula():
    pivot = row_pivot(width=16, height=32, cx=1.0, cy=-2.0, view_width=4.0, view_height=8.0)
    assert pivot == [16 * (0.5 - 1.0 / 4.0), 32 * (0.5 + -2.0 / 8.0)]


def test_row_pivot_centered_when_cx_cy_zero():
    pivot = row_pivot(width=16, height=32, cx=0.0, cy=0.0, view_width=4.0, view_height=8.0)
    assert pivot == pytest.approx([8.0, 16.0])


def test_row_pivot_pet_style_only_horizontal_changes():
    narrow = row_pivot(width=16, height=32, cx=0.5, cy=0.25, view_width=4.0, view_height=8.0)
    wide = row_pivot(width=32, height=32, cx=0.5, cy=0.25, view_width=8.0, view_height=8.0)
    assert narrow[1] == pytest.approx(wide[1])
    assert narrow[0] != pytest.approx(wide[0])


def test_ortho_scale_never_nan_or_inf_for_finite_inputs():
    fit = fit_camera(
        base_width=2,
        base_height=2,
        xmin=-1,
        xmax=1,
        ymin=-1,
        ymax=1,
        padding=0.1,
        height=16,
        meters_per_tile=1.0,
    )
    assert math.isfinite(fit.ortho_scale)
