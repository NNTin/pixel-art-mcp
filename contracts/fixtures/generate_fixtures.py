#!/usr/bin/env python3
"""Generate the golden fixture corpus for `packages/schema`'s contract tests.

Migration-only tooling (see `docs/typescript-rewrite.md`'s "Contract preservation strategy"),
not shipped or imported by the app. Run with `uv run python contracts/fixtures/generate_fixtures.py`
from the repo root. It imports the real Pydantic models from `src/pixel_art_mcp/` and, for a
curated set of representative cases per model/validator, dumps either the exact
`model_dump(mode="json")` (valid cases) or the exact `e.errors()` list reduced to
`{msg, loc, type}` per error (invalid cases) into `contracts/fixtures/*.json`.

The TypeScript test suite (`packages/schema/src/contract-fixtures.test.ts`) runs the same cases
through the Zod port and asserts byte-identical valid output and identical error messages.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from pydantic import BaseModel, TypeAdapter, ValidationError  # noqa: E402

from pixel_art_mcp.assets import (  # noqa: E402
    asset_layouts,
    clip_duration_ms,
    clip_playback,
    get_asset_profile,
    normalize_asset,
    resolve_asset,
)
from pixel_art_mcp.authoring import (  # noqa: E402
    PixelArtSource,
    PixelDefinition,
    PixelEdit,
    PixelEdits,
    PixelLayer,
    PixelPose,
    apply_pixel_edits,
)
from pixel_art_mcp.models import (  # noqa: E402
    AssetClip,
    AssetSpec,
    DomainError,
    RenderOptions,
    RenderState,
)

FIXTURES_DIR = Path(__file__).resolve().parent


def errors_of(exc: ValidationError) -> list[dict[str, Any]]:
    return [{"msg": e["msg"], "loc": list(e["loc"]), "type": e["type"]} for e in exc.errors()]


def model_case(name: str, model_cls: type[BaseModel], data: Any) -> dict[str, Any]:
    try:
        instance = model_cls.model_validate(data)
    except ValidationError as exc:
        return {"name": name, "status": "invalid", "input": data, "errors": errors_of(exc)}
    return {
        "name": name,
        "status": "valid",
        "input": data,
        "output": json.loads(instance.model_dump_json()),
    }


def adapter_case(name: str, adapter: TypeAdapter[Any], data: Any) -> dict[str, Any]:
    try:
        instance = adapter.validate_python(data)
    except ValidationError as exc:
        return {"name": name, "status": "invalid", "input": data, "errors": errors_of(exc)}
    return {
        "name": name,
        "status": "valid",
        "input": data,
        "output": json.loads(adapter.dump_json(instance)),
    }


def write(filename: str, cases: list[dict[str, Any]]) -> None:
    path = FIXTURES_DIR / filename
    path.write_text(json.dumps({"cases": cases}, indent=2) + "\n")
    print(f"wrote {path.relative_to(FIXTURES_DIR.parents[1])} ({len(cases)} cases)")


# ---------------------------------------------------------------------------
# authoring.py
# ---------------------------------------------------------------------------

ROWS_6X6 = ["DDDDDD", "DGGGGD", "DGDDGD", "DGDDGD", "DGGGGD", "DDDDDD"]
DRAWING_6X6 = {
    "width": 6,
    "height": 6,
    "commands": [
        {"op": "rect", "x": 0, "y": 0, "width": 6, "height": 6, "color": "D"},
        {"op": "rect", "x": 1, "y": 1, "width": 4, "height": 4, "color": "G"},
    ],
}


def pixel_pose_cases() -> list[dict[str, Any]]:
    return [
        model_case("valid rows", PixelPose, {"angle": 0, "rows": ROWS_6X6, "x": 0, "y": 0}),
        model_case("valid drawing", PixelPose, {"angle": 90, "drawing": DRAWING_6X6}),
        model_case(
            "both rows and drawing",
            PixelPose,
            {"angle": 0, "rows": ROWS_6X6, "drawing": DRAWING_6X6},
        ),
        model_case("neither rows nor drawing", PixelPose, {"angle": 0}),
        model_case(
            "mismatched row widths",
            PixelPose,
            {"angle": 0, "rows": ["AB", "A", "ABCD"]},
        ),
        model_case("invalid angle", PixelPose, {"angle": 45, "rows": ["A"]}),
    ]


def pixel_layer_cases() -> list[dict[str, Any]]:
    pose_a = {"angle": 0, "rows": ["A"]}
    pose_b = {"angle": 90, "rows": ["A"]}
    return [
        model_case(
            "valid distinct poses",
            PixelLayer,
            {"name": "body", "poses": [pose_a, pose_b]},
        ),
        model_case(
            "duplicate angle/frame poses",
            PixelLayer,
            {"name": "body", "poses": [pose_a, dict(pose_a)]},
        ),
        model_case("empty poses list", PixelLayer, {"name": "body", "poses": []}),
    ]


def pixel_definition_cases() -> list[dict[str, Any]]:
    base_palette = {"D": "#293039", "G": "#f3cf65"}
    minimal = {
        "version": 1,
        "palette": base_palette,
        "layers": [{"name": "marker", "poses": [{"angle": 0, "rows": ROWS_6X6}]}],
    }
    cases = [model_case("valid minimal definition", PixelDefinition, minimal)]

    dup_layer_names = {
        "version": 1,
        "palette": base_palette,
        "layers": [
            {"name": "body", "poses": [{"angle": 0, "rows": ["D"]}]},
            {"name": "body", "poses": [{"angle": 90, "rows": ["D"]}]},
        ],
    }
    cases.append(model_case("duplicate layer names", PixelDefinition, dup_layer_names))

    dup_palette = {
        "version": 1,
        "palette": {"D": "#293039", "G": "#293039"},
        "layers": [{"name": "body", "poses": [{"angle": 0, "rows": ["D"]}]}],
    }
    cases.append(model_case("duplicate palette colors", PixelDefinition, dup_palette))

    unknown_symbol = {
        "version": 1,
        "palette": base_palette,
        "layers": [{"name": "body", "poses": [{"angle": 0, "rows": ["X"]}]}],
    }
    cases.append(model_case("unknown palette symbol", PixelDefinition, unknown_symbol))

    huge_rows = "A" * 512
    over_pixel_budget = {
        "version": 1,
        "palette": {"A": "#000000", "B": "#ffffff"},
        "layers": [
            {
                "name": "body",
                "poses": [
                    {"angle": 0, "frame": None, "rows": [huge_rows] * 512},
                    {"angle": 0, "frame": 1, "rows": [huge_rows] * 512},
                ],
            }
        ],
    }
    cases.append(model_case("exceeds authored pixel-cell budget", PixelDefinition, over_pixel_budget))

    big_drawing = {
        "width": 64,
        "height": 64,
        "commands": [
            {"op": "rect", "x": 0, "y": 0, "width": 64, "height": 64, "color": "A", "repeat": 128}
        ],
    }
    over_paint_budget = {
        "version": 1,
        "palette": {"A": "#000000", "B": "#ffffff"},
        "layers": [
            {
                "name": "body",
                "poses": [
                    {"angle": 0, "frame": None, "drawing": big_drawing},
                    {"angle": 0, "frame": 1, "drawing": big_drawing},
                    {"angle": 0, "frame": 2, "drawing": big_drawing},
                ],
            }
        ],
    }
    cases.append(model_case("exceeds paint-operation budget", PixelDefinition, over_paint_budget))

    return cases


def pixel_drawing_cases() -> list[dict[str, Any]]:
    from pixel_art_mcp.drawing import PixelDrawing

    cases = [
        model_case("valid drawing", PixelDrawing, DRAWING_6X6),
        model_case("empty commands", PixelDrawing, {"width": 2, "height": 2, "commands": []}),
        model_case(
            "unknown discriminator tag",
            PixelDrawing,
            {"width": 2, "height": 2, "commands": [{"op": "bogus"}]},
        ),
        model_case(
            "command exceeds patch bounds",
            PixelDrawing,
            {
                "width": 4,
                "height": 4,
                "commands": [{"op": "rect", "x": 2, "y": 2, "width": 4, "height": 4, "color": "A"}],
            },
        ),
        model_case(
            "drawing exceeds paint-operation budget",
            PixelDrawing,
            {
                "width": 512,
                "height": 512,
                "commands": [
                    {"op": "rect", "x": 0, "y": 0, "width": 512, "height": 512, "color": "A", "repeat": 5}
                ],
            },
        ),
        model_case(
            "stamp with mismatched row widths",
            PixelDrawing,
            {
                "width": 4,
                "height": 4,
                "commands": [{"op": "stamp", "x": 0, "y": 0, "rows": ["AB", "A"]}],
            },
        ),
    ]
    return cases


def pixel_edits_cases() -> list[dict[str, Any]]:
    edit_adapter: TypeAdapter[Any] = TypeAdapter(PixelEdits)
    single_adapter: TypeAdapter[Any] = TypeAdapter(PixelEdit)
    return [
        adapter_case(
            "valid move_pose",
            single_adapter,
            {"op": "move_pose", "layer": "body", "angle": 0, "frame": None, "x": 1, "y": 2},
        ),
        adapter_case(
            "valid set_palette",
            single_adapter,
            {"op": "set_palette", "palette": {"A": "#000000", "B": "#ffffff"}},
        ),
        adapter_case(
            "unknown op discriminator",
            single_adapter,
            {"op": "bogus", "layer": "body", "angle": 0, "frame": None, "x": 0, "y": 0},
        ),
        adapter_case(
            "valid edits list",
            edit_adapter,
            [{"op": "delete_layer", "name": "body"}],
        ),
        adapter_case("empty edits list", edit_adapter, []),
    ]


def pixel_edits_apply_cases() -> list[dict[str, Any]]:
    definition = {
        "version": 1,
        "palette": {"D": "#293039", "G": "#f3cf65"},
        "layers": [
            {
                "name": "marker",
                "poses": [{"angle": 0, "frame": None, "rows": ["D"], "x": 0, "y": 0}],
            }
        ],
    }
    parsed = PixelDefinition.model_validate(definition)

    def run(name: str, edits: list[dict[str, Any]]) -> dict[str, Any]:
        try:
            edits_parsed = TypeAdapter(PixelEdits).validate_python(edits)
            result = apply_pixel_edits(parsed, edits_parsed)
        except ValidationError as exc:
            # Re-validation failure (the resulting document itself is invalid): reduce to the
            # same {msg, loc, type} shape as every other model-level fixture, not the full
            # pydantic-formatted exception text (which embeds doc URLs/version strings that
            # aren't practical -- or useful -- to byte-match from the TS side).
            return {
                "name": name,
                "definition": definition,
                "edits": edits,
                "status": "revalidation_error",
                "errors": errors_of(exc),
            }
        except ValueError as exc:
            # A plain ValueError raised by apply_pixel_edits itself (unknown layer/pose target).
            return {
                "name": name,
                "definition": definition,
                "edits": edits,
                "status": "error",
                "error": str(exc),
            }
        return {
            "name": name,
            "definition": definition,
            "edits": edits,
            "status": "ok",
            "output": json.loads(result.model_dump_json()),
        }

    return [
        run(
            "move_pose on existing pose",
            [{"op": "move_pose", "layer": "marker", "angle": 0, "frame": None, "x": 5, "y": 5}],
        ),
        run(
            "move_pose on unknown layer",
            [{"op": "move_pose", "layer": "nope", "angle": 0, "frame": None, "x": 5, "y": 5}],
        ),
        run(
            "move_pose on unstored pose",
            [{"op": "move_pose", "layer": "marker", "angle": 90, "frame": None, "x": 5, "y": 5}],
        ),
        run(
            "set_layer appends new layer",
            [{"op": "set_layer", "layer": {"name": "extra", "poses": [{"angle": 0, "rows": ["D"]}]}}],
        ),
        run("delete_layer leaves definition with no layers (re-validation fails)", [{"op": "delete_layer", "name": "marker"}]),
        run("delete_layer unknown", [{"op": "delete_layer", "name": "nope"}]),
        run(
            "set_palette replaces palette keeping symbols in use",
            [{"op": "set_palette", "palette": {"D": "#000000", "G": "#ffffff"}}],
        ),
        run(
            "set_palette drops a symbol still in use (re-validation fails)",
            [{"op": "set_palette", "palette": {"A": "#000000", "B": "#ffffff"}}],
        ),
    ]


def pixel_art_source_cases() -> list[dict[str, Any]]:
    valid = {
        "contract_version": 1,
        "project_id": "12345678-1234-4123-8123-123456789abc",
        "revision_id": "12345678-1234-4123-8123-123456789abd",
        "definition": {
            "version": 1,
            "palette": {"D": "#293039", "G": "#f3cf65"},
            "layers": [{"name": "marker", "poses": [{"angle": 0, "rows": ["D"]}]}],
        },
        "authored_views": {"0": [16, 16]},
        "configuration_id": None,
    }
    extra_field = dict(valid, bogus="nope")
    return [
        model_case("valid source", PixelArtSource, valid),
        model_case("extra field forbidden", PixelArtSource, extra_field),
    ]


# ---------------------------------------------------------------------------
# models.py
# ---------------------------------------------------------------------------


def asset_spec_cases() -> list[dict[str, Any]]:
    cases = [
        model_case(
            "valid minimal furniture",
            AssetSpec,
            {"kind": "furniture", "name": "Oil Lamp", "asset_id": "OIL_LAMP"},
        ),
        model_case("valid minimal character", AssetSpec, {"kind": "character", "name": "Knight"}),
        model_case(
            "valid minimal pet", AssetSpec, {"kind": "pet", "name": "Tabby Cat", "asset_id": "TABBY_CAT"}
        ),
        model_case("missing name", AssetSpec, {"kind": "furniture", "asset_id": "X"}),
        model_case("invalid kind literal", AssetSpec, {"kind": "bogus", "name": "x"}),
        model_case(
            "invalid asset_id pattern", AssetSpec, {"kind": "furniture", "name": "x", "asset_id": "bad"}
        ),
        model_case(
            "extra field forbidden",
            AssetSpec,
            {"kind": "furniture", "name": "x", "asset_id": "X", "bogus": 1},
        ),
        model_case(
            "furniture missing asset_id",
            AssetSpec,
            {"kind": "furniture", "name": "x"},
        ),
        model_case(
            "invalid preset for kind",
            AssetSpec,
            {"kind": "furniture", "name": "x", "asset_id": "X", "preset": "character"},
        ),
        model_case(
            "background_tiles only for furniture",
            AssetSpec,
            {"kind": "character", "name": "x", "background_tiles": 1},
        ),
        model_case(
            "placement/ground only for furniture",
            AssetSpec,
            {"kind": "character", "name": "x", "placement": "wall"},
        ),
        model_case(
            "character/pet require 16x32",
            AssetSpec,
            {"kind": "character", "name": "x", "width": 32},
        ),
        model_case(
            "lowercase clip id required",
            AssetSpec,
            {
                "kind": "furniture",
                "name": "x",
                "asset_id": "X",
                "clips": {"BAD": {"frames": [1]}},
            },
        ),
        model_case(
            "off_frame only for furniture clips",
            AssetSpec,
            {"kind": "character", "name": "x", "clips": {"walk": {"frames": [1], "off_frame": 5}}},
        ),
        model_case(
            "animated furniture clip requires off_frame",
            AssetSpec,
            {
                "kind": "furniture",
                "name": "x",
                "asset_id": "X",
                "clips": {"default": {"frames": [1, 2]}},
            },
        ),
        model_case(
            "combined asset/variant id too long",
            AssetSpec,
            {
                "kind": "furniture",
                "name": "x",
                "asset_id": "A" * 60,
                "clips": {
                    "one": {"frames": [1], "off_frame": 2},
                    "twotwotwotwotwo": {"frames": [1], "off_frame": 2},
                },
            },
        ),
        model_case(
            "combined asset/variant name too long",
            AssetSpec,
            {
                "kind": "furniture",
                "name": "N" * 55,
                "asset_id": "X",
                "clips": {
                    "one": {"frames": [1], "off_frame": 2, "name": "Variant One"},
                    "two": {"frames": [1], "off_frame": 2, "name": "Variant Two"},
                },
            },
        ),
        model_case(
            "character clips wrong set",
            AssetSpec,
            {"kind": "character", "name": "x", "clips": {"walk": {"frames": [1, 2, 3]}}},
        ),
        model_case(
            "character clip frame counts wrong",
            AssetSpec,
            {
                "kind": "character",
                "name": "x",
                "clips": {
                    "walk": {"frames": [1, 2]},
                    "typing": {"frames": [4, 5]},
                    "reading": {"frames": [6, 7]},
                },
            },
        ),
        model_case(
            "pet clips wrong set",
            AssetSpec,
            {
                "kind": "pet",
                "name": "x",
                "asset_id": "X",
                "clips": {"walk": {"frames": [1, 2, 3]}},
            },
        ),
        model_case(
            "invalid palette hex",
            AssetSpec,
            {
                "kind": "furniture",
                "name": "x",
                "asset_id": "X",
                "palette": ["#zzzzzz", "#ffffff"],
            },
        ),
        model_case(
            "duplicate palette colors",
            AssetSpec,
            {
                "kind": "furniture",
                "name": "x",
                "asset_id": "X",
                "palette": ["#ffffff", "#FFFFFF"],
            },
        ),
        model_case(
            "clips dict too long",
            AssetSpec,
            {
                "kind": "furniture",
                "name": "x",
                "asset_id": "X",
                "clips": {f"c{i}": {"frames": [1], "off_frame": 2} for i in range(17)},
            },
        ),
    ]
    return cases


def render_options_cases() -> list[dict[str, Any]]:
    cases = [
        model_case("valid defaults", RenderOptions, {}),
        model_case("tile_width derives width", RenderOptions, {"tile_width": 2}),
        model_case("explicit width wins over tile_width", RenderOptions, {"tile_width": 2, "width": 48}),
        model_case("angles distinct modulo 360", RenderOptions, {"angles": [10, 370]}),
        model_case("palette invalid hex", RenderOptions, {"palette": ["#zzzzzz", "#ffffff"]}),
        model_case("palette duplicate", RenderOptions, {"palette": ["#ffffff", "#FFFFFF"]}),
        model_case("frame_end before frame_start", RenderOptions, {"frame_start": 5, "frame_end": 1}),
        model_case(
            "duplicate state ids",
            RenderOptions,
            {
                "states": [
                    {"id": "walk", "name": "walk", "frame_start": 1, "frame_end": 3},
                    {"id": "walk", "name": "walk", "frame_start": 4, "frame_end": 6},
                ]
            },
        ),
        model_case(
            "more than one export target",
            RenderOptions,
            {
                "pixel_agents": {"asset_id": "X", "name": "X"},
                "character": {"asset_id": "Y", "name": "Y"},
            },
        ),
        model_case(
            "character export forbids states",
            RenderOptions,
            {
                "character": {"asset_id": "K", "name": "Knight"},
                "angles": [0, 90, 180],
                "width": 16,
                "height": 32,
                "frame_start": 1,
                "frame_end": 7,
                "states": [{"id": "walk", "name": "walk", "frame_start": 1, "frame_end": 3}],
            },
        ),
        model_case(
            "character export requires cardinal angles",
            RenderOptions,
            {
                "character": {"asset_id": "K", "name": "Knight"},
                "angles": [0, 90],
                "width": 16,
                "height": 32,
                "frame_start": 1,
                "frame_end": 7,
            },
        ),
        model_case(
            "character export requires 16x32",
            RenderOptions,
            {
                "character": {"asset_id": "K", "name": "Knight"},
                "angles": [0, 90, 180],
                "width": 32,
                "height": 32,
                "frame_start": 1,
                "frame_end": 7,
            },
        ),
        model_case(
            "character export requires exactly 7 frames",
            RenderOptions,
            {
                "character": {"asset_id": "K", "name": "Knight"},
                "angles": [0, 90, 180],
                "width": 16,
                "height": 32,
                "frame_start": 1,
                "frame_end": 6,
            },
        ),
        model_case(
            "valid character export",
            RenderOptions,
            {
                "character": {"asset_id": "K", "name": "Knight"},
                "angles": [0, 90, 180],
                "width": 16,
                "height": 32,
                "frame_start": 1,
                "frame_end": 7,
            },
        ),
        model_case(
            "pet export requires cardinal angles",
            RenderOptions,
            {
                "pet": {"asset_id": "P", "name": "Pet"},
                "angles": [0, 90],
                "width": 16,
                "height": 32,
                "states": [
                    {"id": "walk", "name": "walk", "frame_start": 1, "frame_end": 3},
                    {"id": "idle", "name": "idle", "frame_start": 4, "frame_end": 6},
                ],
            },
        ),
        model_case(
            "pet export requires 16x32",
            RenderOptions,
            {
                "pet": {"asset_id": "P", "name": "Pet"},
                "angles": [0, 90, 180],
                "width": 32,
                "height": 32,
                "states": [
                    {"id": "walk", "name": "walk", "frame_start": 1, "frame_end": 3},
                    {"id": "idle", "name": "idle", "frame_start": 4, "frame_end": 6},
                ],
            },
        ),
        model_case(
            "pet export requires walk+idle states",
            RenderOptions,
            {
                "pet": {"asset_id": "P", "name": "Pet"},
                "angles": [0, 90, 180],
                "width": 16,
                "height": 32,
                "states": [{"id": "walk", "name": "walk", "frame_start": 1, "frame_end": 3}],
            },
        ),
        model_case(
            "pet state requires exactly 3 frames",
            RenderOptions,
            {
                "pet": {"asset_id": "P", "name": "Pet"},
                "angles": [0, 90, 180],
                "width": 16,
                "height": 32,
                "states": [
                    {"id": "walk", "name": "walk", "frame_start": 1, "frame_end": 2},
                    {"id": "idle", "name": "idle", "frame_start": 4, "frame_end": 6},
                ],
            },
        ),
        model_case(
            "pet states forbid off_frame",
            RenderOptions,
            {
                "pet": {"asset_id": "P", "name": "Pet"},
                "angles": [0, 90, 180],
                "width": 16,
                "height": 32,
                "states": [
                    {"id": "walk", "name": "walk", "frame_start": 1, "frame_end": 3, "off_frame": 9},
                    {"id": "idle", "name": "idle", "frame_start": 4, "frame_end": 6},
                ],
            },
        ),
        model_case(
            "valid pet export",
            RenderOptions,
            {
                "pet": {"asset_id": "P", "name": "Pet"},
                "angles": [0, 90, 180],
                "width": 16,
                "height": 32,
                "states": [
                    {"id": "walk", "name": "walk", "frame_start": 1, "frame_end": 3},
                    {"id": "idle", "name": "idle", "frame_start": 4, "frame_end": 6},
                ],
            },
        ),
        model_case(
            "pixel_agents requires 5 fps",
            RenderOptions,
            {"pixel_agents": {"asset_id": "X", "name": "X"}, "fps": 10},
        ),
        model_case(
            "pixel_agents requires cardinal angles",
            RenderOptions,
            {"pixel_agents": {"asset_id": "X", "name": "X"}, "angles": [0, 45]},
        ),
        model_case(
            "pixel_agents named states forbid options.off_frame",
            RenderOptions,
            {
                "pixel_agents": {"asset_id": "X", "name": "X", "off_frame": 1},
                "states": [{"id": "empty", "name": "empty", "frame_start": 1, "frame_end": 1}],
            },
        ),
        model_case(
            "pixel_agents animated state requires off_frame",
            RenderOptions,
            {
                "pixel_agents": {"asset_id": "X", "name": "X"},
                "states": [{"id": "fill", "name": "fill", "frame_start": 1, "frame_end": 3}],
            },
        ),
        model_case(
            "pixel_agents combined asset/state id too long",
            RenderOptions,
            {
                "pixel_agents": {"asset_id": "A" * 60, "name": "X"},
                "states": [{"id": "s" * 20, "name": "s" * 20, "frame_start": 1, "frame_end": 1}],
            },
        ),
        model_case(
            "pixel_agents combined asset/state name too long",
            RenderOptions,
            {
                "pixel_agents": {"asset_id": "X", "name": "N" * 55},
                "states": [{"id": "s", "name": "S" * 10, "frame_start": 1, "frame_end": 1}],
            },
        ),
        model_case(
            "pixel_agents animation requires off_frame",
            RenderOptions,
            {
                "pixel_agents": {"asset_id": "X", "name": "X"},
                "frame_start": 1,
                "frame_end": 3,
            },
        ),
        model_case(
            "pixel_agents background_tiles vs footprint height",
            RenderOptions,
            {
                "pixel_agents": {"asset_id": "X", "name": "X", "background_tiles": 1},
                "height": 16,
            },
        ),
        model_case(
            "valid pixel_agents furniture",
            RenderOptions,
            {
                "pixel_agents": {"asset_id": "X", "name": "X", "off_frame": 1},
                "frame_start": 1,
                "frame_end": 3,
            },
        ),
    ]
    return cases


def render_state_cases() -> list[dict[str, Any]]:
    return [
        model_case("valid state", RenderState, {"id": "walk", "name": "walk", "frame_start": 1, "frame_end": 3}),
        model_case(
            "frame_end before frame_start", RenderState, {"id": "walk", "name": "walk", "frame_start": 5, "frame_end": 1}
        ),
    ]


def asset_clip_cases() -> list[dict[str, Any]]:
    return [
        model_case("valid clip", AssetClip, {"frames": [1, 2, 3]}),
        model_case("frame out of range", AssetClip, {"frames": [100001]}),
    ]


# ---------------------------------------------------------------------------
# assets.py (real functions, not just schemas)
# ---------------------------------------------------------------------------


def spec_case(name: str, fn: Callable[[AssetSpec], Any], spec_input: dict[str, Any]) -> dict[str, Any]:
    """Like `function_case`, but for functions taking a single `AssetSpec` -- captures the raw
    kwargs used to build it as `input`, so the TS side can rebuild the same `AssetSpec` via
    `AssetSpecSchema.parse(input)` and call the equivalent ported function."""
    spec = AssetSpec.model_validate(spec_input)
    try:
        result = fn(spec)
    except DomainError as exc:
        return {"name": name, "input": spec_input, "status": "domain_error", "error": str(exc)}
    if isinstance(result, BaseModel):
        result = json.loads(result.model_dump_json())
    return {"name": name, "input": spec_input, "status": "ok", "output": result}


def asset_layouts_cases() -> list[dict[str, Any]]:
    return [
        spec_case("furniture small default", asset_layouts, {"kind": "furniture", "name": "x", "asset_id": "X"}),
        spec_case(
            "furniture custom ground tiles",
            asset_layouts,
            {
                "kind": "furniture",
                "name": "x",
                "asset_id": "X",
                "preset": "prop",
                "ground_width": 3,
                "ground_depth": 4,
                "background_tiles": 1,
            },
        ),
        spec_case("character default", asset_layouts, {"kind": "character", "name": "x"}),
        spec_case("pet default", asset_layouts, {"kind": "pet", "name": "x", "asset_id": "X"}),
        spec_case(
            "width must equal ground_width*16",
            asset_layouts,
            {"kind": "furniture", "name": "x", "asset_id": "X", "width": 17, "ground_width": 1},
        ),
        spec_case(
            "height smaller than ground_depth",
            asset_layouts,
            {"kind": "furniture", "name": "x", "asset_id": "X", "ground_depth": 4, "height": 32},
        ),
        spec_case(
            "height conflicts with background_tiles",
            asset_layouts,
            {
                "kind": "furniture",
                "name": "x",
                "asset_id": "X",
                "ground_depth": 1,
                "background_tiles": 1,
                "height": 48,
            },
        ),
        spec_case(
            "rotated canvas exceeds 512px",
            asset_layouts,
            {
                "kind": "furniture",
                "name": "x",
                "asset_id": "X",
                "preset": "tall",
                "ground_width": 1,
                "ground_depth": 16,
                "background_tiles": 31,
            },
        ),
    ]


def resolve_asset_cases() -> list[dict[str, Any]]:
    return [
        spec_case("resolve furniture default", resolve_asset, {"kind": "furniture", "name": "x", "asset_id": "X"}),
        spec_case("resolve character default", resolve_asset, {"kind": "character", "name": "x"}),
        spec_case("resolve pet default", resolve_asset, {"kind": "pet", "name": "x", "asset_id": "X"}),
    ]


def normalize_asset_cases() -> list[dict[str, Any]]:
    return [
        spec_case(
            "furniture default clips filled in",
            normalize_asset,
            {"kind": "furniture", "name": "x", "asset_id": "X"},
        ),
        spec_case(
            "character default clips filled in", normalize_asset, {"kind": "character", "name": "x"}
        ),
        spec_case(
            "chair preset derives chairs category",
            normalize_asset,
            {"kind": "furniture", "name": "x", "asset_id": "X", "preset": "chair"},
        ),
        spec_case(
            "desk preset derives desks category",
            normalize_asset,
            {"kind": "furniture", "name": "x", "asset_id": "X", "preset": "desk"},
        ),
        spec_case(
            "explicit category preserved over preset",
            normalize_asset,
            {
                "kind": "furniture",
                "name": "x",
                "asset_id": "X",
                "preset": "chair",
                "category": "electronics",
            },
        ),
    ]


def asset_profile_cases() -> list[dict[str, Any]]:
    def case(name: str, kind: str, preset: str | None = None) -> dict[str, Any]:
        try:
            result = get_asset_profile(kind, preset)
        except DomainError as exc:
            return {"name": name, "kind": kind, "preset": preset, "status": "domain_error", "error": str(exc)}
        return {"name": name, "kind": kind, "preset": preset, "status": "ok", "output": result}

    cases = [case(f"{kind} default profile", kind) for kind in ("furniture", "character", "pet")]
    cases.append(case("invalid kind", "bogus"))
    cases.append(case("invalid preset for kind", "furniture", "character"))
    return cases


def clip_playback_cases() -> list[dict[str, Any]]:
    walk = AssetClip.model_validate({"frames": [1, 2, 3]})
    idle = AssetClip.model_validate({"frames": [4, 5, 6]})
    furniture_default = AssetClip.model_validate({"frames": [1]})

    def case(name: str, kind: str, clip_name: str, clip: AssetClip) -> dict[str, Any]:
        return {
            "name": name,
            "kind": kind,
            "clip_name": clip_name,
            "clip": json.loads(clip.model_dump_json()),
            "playback": clip_playback(kind, clip_name, clip),
            "duration_ms": clip_duration_ms(kind, clip_name),
        }

    return [
        case("character walk", "character", "walk", walk),
        case("pet walk", "pet", "walk", walk),
        case("pet idle", "pet", "idle", idle),
        case("furniture default", "furniture", "default", furniture_default),
    ]


def main() -> None:
    write("pixel-pose.json", pixel_pose_cases())
    write("pixel-layer.json", pixel_layer_cases())
    write("pixel-definition.json", pixel_definition_cases())
    write("pixel-drawing.json", pixel_drawing_cases())
    write("pixel-edits.json", pixel_edits_cases())
    write("pixel-edits-apply.json", pixel_edits_apply_cases())
    write("pixel-art-source.json", pixel_art_source_cases())
    write("asset-spec.json", asset_spec_cases())
    write("render-options.json", render_options_cases())
    write("render-state.json", render_state_cases())
    write("asset-clip.json", asset_clip_cases())
    write("asset-layouts.json", asset_layouts_cases())
    write("resolve-asset.json", resolve_asset_cases())
    write("normalize-asset.json", normalize_asset_cases())
    write("asset-profile.json", asset_profile_cases())
    write("clip-playback.json", clip_playback_cases())


if __name__ == "__main__":
    main()
