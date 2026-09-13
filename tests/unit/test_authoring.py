import copy
import io
import json

import pytest
from PIL import Image, ImageOps
from pydantic import ValidationError
from unit.test_assets import fixture_export

from pixel_art_mcp.assets import get_asset_profile, resolve_asset
from pixel_art_mcp.authoring import PixelDefinition, validated_art
from pixel_art_mcp.imaging.asset_export import export_asset
from pixel_art_mcp.imaging.preview import asset_preview
from pixel_art_mcp.models import AssetSpec, DomainError


@pytest.fixture
def starter():
    return get_asset_profile("furniture")["pixel_authoring"]["example_definition"]


@pytest.mark.parametrize(
    "change",
    [
        lambda d: d.update(version=2),
        lambda d: d.update(views={"0": [32, 32]}),
        lambda d: d["palette"].update(G="#293039"),
        lambda d: d["palette"].update({"!": "#ffffff"}),
        lambda d: d["layers"][0]["poses"][0].update(rows=["GG", "G"]),
        lambda d: d["layers"][0]["poses"][0].update(rows=["XX"]),
        lambda d: d["layers"][0]["poses"][0].update(x=1.5),
        lambda d: d["layers"][0]["poses"][0].update(x=True),
        lambda d: d["layers"][0]["poses"][0].update(anchor="Body"),
        lambda d: d["layers"][0]["poses"].append(d["layers"][0]["poses"][0]),
        lambda d: d["layers"].append(d["layers"][0]),
    ],
)
def test_invalid_definitions_rejected(starter, change):
    change(starter)
    with pytest.raises(ValidationError):
        PixelDefinition.model_validate(starter)


@pytest.mark.parametrize(
    "change,message",
    [
        (lambda d: d["layers"][0]["poses"].pop(), "Missing pixel pose"),
        (lambda d: d["layers"][0]["poses"][0].update(rows=["G" * 17]), "exceeds"),
        (lambda d: d["layers"][0]["poses"][0].update(frame=2), "Missing pixel pose"),
    ],
)
def test_target_contract(starter, change, message):
    options = resolve_asset(AssetSpec(kind="furniture", name="Test", asset_id="TEST"))
    change(starter)
    art = PixelDefinition.model_validate(starter).to_art(options.asset_layouts)
    with pytest.raises(DomainError, match=message):
        validated_art(art.to_dict(), options.model_dump())


def test_transparent_hybrid_document_is_not_a_geometry_bypass(starter):
    starter["base"] = "render"
    for pose in starter["layers"][0]["poses"]:
        pose["rows"] = ["."]
    options = resolve_asset(AssetSpec(kind="furniture", name="Test", asset_id="TEST"))
    art = PixelDefinition.model_validate(starter).to_art(options.asset_layouts)
    with pytest.raises(DomainError, match="authored ink"):
        validated_art(art.to_dict(), options.model_dump())


def test_target_rejects_outline_palette_and_unknown_anchors(starter):
    options = resolve_asset(AssetSpec(kind="furniture", name="Test", asset_id="TEST"))
    art = PixelDefinition.model_validate(starter).to_art(options.asset_layouts)
    for change, message in [
        ({"outline": True}, "outlines"),
        ({"colors": 1}, "colors"),
        ({"palette": ["#000000", "#ffffff"]}, "palette"),
    ]:
        with pytest.raises(ValueError, match=message):
            art.validate_target(
                options.asset_layouts, options.frames(), {**options.asset.model_dump(), **change}
            )
    starter["base"] = "render"
    starter["layers"][0]["poses"][0]["anchor"] = "Missing"
    art = PixelDefinition.model_validate(starter).to_art(options.asset_layouts)
    with pytest.raises(ValueError, match="Unknown pixel anchor"):
        art.validate_target(
            options.asset_layouts, options.frames(), options.asset.model_dump(), set()
        )


def test_authored_cell_limit(starter):
    pose = starter["layers"][0]["poses"][0]
    pose["rows"] = ["G" * 512] * 512
    with pytest.raises(ValidationError, match="262144"):
        PixelDefinition.model_validate(starter)


@pytest.mark.parametrize("base", ["native", "render"])
def test_only_off_canvas_ink_is_rejected(starter, base):
    starter["base"] = base
    for pose in starter["layers"][0]["poses"]:
        pose["x"] = 512
    options = resolve_asset(AssetSpec(kind="furniture", name="Test", asset_id="TEST"))
    art = PixelDefinition.model_validate(starter).to_art(options.asset_layouts)
    with pytest.raises(DomainError, match="Empty native|inside their canvases"):
        validated_art(art.to_dict(), options.model_dump())


def test_ink_in_unused_hybrid_frames_is_not_a_bypass(starter):
    starter["base"] = "render"
    for pose in starter["layers"][0]["poses"]:
        pose["rows"] = ["."]
    starter["layers"][0]["poses"].append({"angle": 0, "frame": 999, "rows": ["G"]})
    options = resolve_asset(AssetSpec(kind="furniture", name="Test", asset_id="TEST"))
    art = PixelDefinition.model_validate(starter).to_art(options.asset_layouts)
    with pytest.raises(DomainError, match="Configured frames must use authored ink"):
        validated_art(art.to_dict(), options.model_dump())


def test_preview_scale_and_output_limits(tmp_path, monkeypatch):
    root, _, _ = fixture_export(tmp_path)
    for scale in (0, 9):
        with pytest.raises(DomainError, match="scale"):
            asset_preview(root, None, None, None, scale, False)
    monkeypatch.setattr(
        "pixel_art_mcp.imaging.preview.context_image", lambda *_: Image.new("RGBA", (1024, 1024))
    )
    with pytest.raises(DomainError, match="4194304"):
        asset_preview(root, None, None, None, 8, True)


def test_automatic_outline_is_not_advertised_as_usable():
    schema = AssetSpec.model_json_schema()
    assert schema["properties"]["outline"]["const"] is False
    with pytest.raises(ValidationError):
        AssetSpec(kind="furniture", name="Test", asset_id="TEST", outline=True)


def test_render_limits_include_off_frames_and_duplicate_clip_slots(service, monkeypatch, starter):
    spec = AssetSpec(
        kind="furniture",
        name="Test",
        asset_id="TEST",
        clips={"full": {"frames": [1, 2], "off_frame": 0}},
    )
    options = resolve_asset(spec)
    art = PixelDefinition.model_validate(starter).to_art(options.asset_layouts)
    monkeypatch.setattr(
        service, "revision", lambda *_: {"id": "r", "summary": {"pixel_art": art.to_dict()}}
    )
    service.settings.max_render_frames = 11
    with pytest.raises(DomainError, match="total frame"):
        service.submit_render("p", options)
    service.settings.max_render_frames = 256
    service.settings.max_sheet_pixels = 4000
    with pytest.raises(DomainError, match="High-resolution"):
        service.submit_render("p", options)
    # Reused source frames still occupy separate package slots.
    spec.clips = {f"s{i}": spec.clips["full"] for i in range(16)}
    with pytest.raises(DomainError, match="Sprite sheet"):
        service.submit_render("p", resolve_asset(spec))


@pytest.mark.parametrize(
    "kind,clip,angle,source_angle,mirrored",
    [
        ("furniture", "default", 270, 270, False),
        ("character", "reading", 270, 90, True),
        ("pet", "walk", 270, 90, True),
        ("pet", "idle", 90, 0, False),
        ("pet", "idle", 270, 180, False),
    ],
)
def test_preview_is_exact_selected_sprite(tmp_path, kind, clip, angle, source_angle, mirrored):
    root, _, _ = fixture_export(tmp_path, kind)
    metadata = json.loads((root / "spritesheet.json").read_text())
    frame = metadata["asset"]["clips"][clip]["frames"][-1]
    png, details = asset_preview(root, clip, angle, frame, 3, False)
    entry = next(
        e for e in metadata["frames"] if e["angle"] == source_angle and e["frame"] == frame
    )
    with Image.open(root / entry["filename"]) as source, Image.open(io.BytesIO(png)) as actual:
        expected = ImageOps.mirror(source) if mirrored else source
        expected = expected.resize((source.width * 3, source.height * 3), Image.Resampling.NEAREST)
        assert actual.tobytes() == expected.tobytes()
    assert details["mirrored"] is mirrored
    assert details["source_angle"] == source_angle
    assert not details["context_is_approximate"]
    _, context = asset_preview(root, clip, angle, frame, 1, True)
    assert context["context_is_approximate"]
    with pytest.raises(DomainError, match="Unknown clip"):
        asset_preview(root, "missing", angle, frame, 1, False)
    with pytest.raises(DomainError):
        asset_preview(root, clip, angle, 9999, 1, False)


def test_export_requires_source_even_for_hybrid(tmp_path):
    _, options, manifest = fixture_export(tmp_path)
    manifest = copy.deepcopy(manifest)
    del manifest["pixel_art"]
    with pytest.raises(DomainError, match="required pixel-art"):
        export_asset(tmp_path / "raw", tmp_path / "invalid", manifest, options, "p", "r")
