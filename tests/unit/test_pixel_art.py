import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from pixel_art_mcp.assets import get_asset_profile, normalize_asset, resolve_asset
from pixel_art_mcp.imaging.asset_export import export_asset
from pixel_art_mcp.imaging.features import composite_features
from pixel_art_mcp.imaging.inspection import inspect_sprite
from pixel_art_mcp.models import AssetSpec
from pixel_art_mcp.pixel_art import Canvas, PixelArt

ROOT = Path(__file__).parents[2]
PALETTE = {"D": "#293039", "G": "#f3cf65"}


@pytest.mark.parametrize(
    "kind,preset",
    [
        ("furniture", "small"),
        ("furniture", "chair"),
        ("furniture", "desk"),
        ("furniture", "tall"),
        ("character", "character"),
        ("pet", "pet"),
    ],
)
def test_profile_code_example_uses_its_actual_consumer_layouts(kind, preset):
    profile = get_asset_profile(kind, preset)
    from pixel_art_mcp.authoring import PixelDefinition

    definition = PixelDefinition.model_validate(profile["pixel_authoring"]["example_definition"])
    art = definition.to_art(profile["layouts"])
    options = resolve_asset(AssetSpec.model_validate(profile["specification"]))
    art.validate_target(options.asset_layouts, options.frames(), options.asset.model_dump())
    assert art.views == {
        str(row["angle"]): [row["width"], row["height"]] for row in profile["layouts"]
    }


def test_roundtrip_and_pose_selection():
    art = PixelArt(PALETTE, {0: (16, 32)})
    art.layer("body", 0, Canvas(4, 4).rect(0, 0, 4, 4, "D"))
    art.layer("tap", 0, Canvas.from_rows(["GGG", ".G."]), frame=2, x=3)
    art.layer("body", 0, Canvas.from_rows(["DD"]), frame=2)
    scene = {}
    art.save(scene)
    restored = PixelArt.load(scene)
    assert restored.to_dict() == art.to_dict()
    assert [p["name"] for p in restored.poses(0, 1)] == ["body"]
    assert restored.poses(0, 2)[0]["rows"] == ["DD"]
    assert restored.poses(0, 2)[1]["x"] == 3
    assert restored.poses(90, 2) == []


def test_budget_checks_final_ownership_clipping_and_connectivity():
    art = PixelArt(PALETTE, {0: (16, 16)})
    art.layer("handle", 0, Canvas.from_rows(["GGGG"]), min_pixels=4, connected=True)
    art.layer("occluder", 0, Canvas.from_rows(["DD"]), x=1)
    art.layer("clipped", 0, Canvas.from_rows(["GG"]), x=-1, y=2)
    image, features = composite_features(Image.new("RGBA", (16, 16)), art.poses(0, 1), PALETTE)
    assert image.getpixel((0, 0)) == (243, 207, 101, 255)
    assert features[0]["visible_pixels"] == 2
    assert features[0]["overwritten_pixels"] == 2
    assert features[0]["issues"] == ["feature_pixel_budget", "disconnected_feature"]
    assert features[2]["clipped_pixels"] == 1
    assert features[2]["issues"] == ["clipped_feature"]


@pytest.mark.parametrize(
    "operation",
    [
        lambda: Canvas.from_rows(["DD", "D"]),
        lambda: Canvas(2, 2).rect(1, 1, 2, 1, "D"),
        lambda: Canvas(2, 2).stamp(-1, 0, ["D"]),
        lambda: PixelArt({".": "#000000", "D": "#ffffff"}, {0: (16, 16)}),
        lambda: PixelArt(PALETTE, {45: (16, 16)}),
        lambda: PixelArt(PALETTE, {0: (16, 16)}).layer("bad", 0, Canvas.from_rows(["X"])),
        lambda: PixelArt(PALETTE, {0: (16, 16)}).layer(
            "bad", 0, Canvas.from_rows(["D"]), anchor="x"
        ),
    ],
)
def test_invalid_authoring(operation):
    with pytest.raises(ValueError):
        operation()


def load_example(monkeypatch, key):
    data = json.loads((ROOT / "examples/asset-specs.json").read_text())[key]
    scene = {}
    monkeypatch.setitem(sys.modules, "bpy", SimpleNamespace(context=SimpleNamespace(scene=scene)))
    for script in data["scripts"]:
        path = ROOT / "examples" / script
        exec(compile(path.read_text(), str(path), "exec"), {})
    return PixelArt.load(scene), resolve_asset(AssetSpec.model_validate(data["specification"]))


@pytest.mark.parametrize(
    "key",
    [
        "candle",
        "chair",
        "modify-chair",
        "oil-lamp",
        "rain-barrel",
        "street-lamp",
        "character",
        "pet",
    ],
)
def test_examples_respect_native_layouts_and_feature_budgets(monkeypatch, key):
    art, options = load_example(monkeypatch, key)
    assert options.asset
    assert len(art.palette) <= options.asset.colors
    for layout in options.asset_layouts:
        angle, size = layout["angle"], (layout["width"], layout["height"])
        assert art.views[str(angle)] == list(size)
        for frame in options.frames():
            image, features = composite_features(
                Image.new("RGBA", size), art.poses(angle, frame), art.palette
            )
            assert image.getbbox(), (key, angle, frame)
            assert not [(f["name"], f["issues"]) for f in features if f["issues"]], (
                key,
                angle,
                frame,
                features,
            )
            assert set(image.getchannel("A").get_flattened_data()) <= {0, 255}


def test_barrel_controls_and_lower_body_are_temporally_stable(monkeypatch):
    art, options = load_example(monkeypatch, "rain-barrel")
    assert normalize_asset(options.asset).clips["full"].off_frame == 20
    for level in range(3):
        images = [
            composite_features(
                Image.new("RGBA", (16, 32)), art.poses(0, level * 10 + f), art.palette
            )[0]
            for f in range(9)
        ]
        assert len({im.crop((0, 18, 16, 32)).tobytes() for im in images}) == 1
        assert images[0].getbbox() == (2, 10, 14, 30)
        _, features = composite_features(
            Image.new("RGBA", (16, 32)), art.poses(0, level * 10), art.palette
        )
        faucet = next(f for f in features if f["name"] == "faucet")
        gauge = next(f for f in features if f["name"] == "level gauge")
        assert faucet["visible_pixels"] == 10 and faucet["components"] == 1
        assert gauge["visible_pixels"] == 28 and gauge["components"] == 1


@pytest.mark.parametrize("base", ["native", "render"])
def test_export_keeps_exact_pixels_and_reports_lost_features(tmp_path, base, monkeypatch):
    options = resolve_asset(AssetSpec(kind="furniture", name="Test", asset_id="TEST"))
    art = PixelArt(PALETTE, {a: (16, 16) for a in (0, 90, 180, 270)}, base=base)
    raw, output = tmp_path / "raw", tmp_path / "out"
    raw.mkdir()
    entries = []
    for layout in options.asset_layouts:
        angle = layout["angle"]
        art.layer("body", angle, Canvas(10, 10).rect(0, 0, 10, 10, "D"), x=3, y=3)
        art.layer(
            "control",
            angle,
            Canvas.from_rows(["GGG", ".G."]),
            x=5,
            y=5,
            min_pixels=4,
            connected=True,
        )
        art.layer(
            "clipped control",
            angle,
            Canvas.from_rows(["GG"]),
            x=15,
            y=8,
            min_pixels=2,
            connected=True,
        )
        name = f"{angle}.png"
        Image.new("RGBA", (64, 64)).save(raw / name)
        entries.append(
            {
                "angle": angle,
                "frame": 1,
                "filename": name,
                "pivot": [8, 15],
                "pixel_layers": art.poses(angle, 1),
            }
        )
    if base == "native":

        def forbidden(*args, **kwargs):
            raise AssertionError("Native artwork must bypass conversion")

        monkeypatch.setattr("pixel_art_mcp.imaging.asset_export.pixelate", forbidden)
    manifest = {
        "frames": entries,
        "pixel_art": art.to_dict(),
        "blender_version": "fixture",
        "camera": {"views": [{**v, "objects": []} for v in options.asset_layouts]},
    }
    export_asset(raw, output, manifest, options, "project", "revision")
    metadata = json.loads((output / "spritesheet.json").read_text())
    report = json.loads((output / "asset-report.json").read_text())
    assert report["status"] == "review" and report["visual_review_required"]
    assert {f["code"] for f in report["findings"]} == {
        "clipped_feature",
        "feature_pixel_budget",
        "low_context_contrast",
    }
    assert json.loads((output / "pixel-art.json").read_text()) == art.to_dict()
    inspected = inspect_sprite(output, angle=0)
    assert inspected["pixel_features"][1]["visible_pixels"] == 4
    entry = metadata["frames"][0]
    with Image.open(output / entry["filename"]) as image:
        assert image.getpixel((5, 5)) == (243, 207, 101, 255)
        if base == "native":
            with Image.open(output / entry["source"]) as source:
                assert (
                    source.resize(image.size, Image.Resampling.NEAREST).tobytes() == image.tobytes()
                )
