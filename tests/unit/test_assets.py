import json
from zipfile import ZipFile

import pytest
from PIL import Image, ImageDraw
from pydantic import ValidationError

from pixel_art_mcp.assets import asset_layouts, get_asset_profile, resolve_asset
from pixel_art_mcp.blender.camera_fit import fit_asset_views
from pixel_art_mcp.imaging.asset_export import export_asset
from pixel_art_mcp.imaging.inspection import inspect_sprite
from pixel_art_mcp.models import AssetSpec, DomainError


def fixture_export(tmp_path, kind="furniture", **kwargs):
    spec = AssetSpec(kind=kind, name="Fixture", asset_id="FIXTURE", **kwargs)
    options = resolve_asset(spec, "configuration-1")
    raw, out = tmp_path / "raw", tmp_path / "out"
    raw.mkdir()
    entries, views = [], []
    for row in options.asset_layouts:
        views.append({**row, "objects": [{"name": "Body", "pixel_width": 12, "pixel_height": 20}]})
        for frame in options.frames():
            size = (row["width"] * options.supersampling, row["height"] * options.supersampling)
            im = Image.new("RGBA", size)
            draw = ImageDraw.Draw(im)
            inset = 3 * options.supersampling
            draw.rectangle(
                (inset, inset, size[0] - inset, size[1] - inset),
                fill=(40 + frame * 10 % 200, 70 + row["angle"] // 2, 120, 255),
            )
            filename = f"{row['angle']}_{frame}.png"
            im.save(raw / filename)
            entries.append(
                {
                    "angle": row["angle"],
                    "frame": frame,
                    "filename": filename,
                    "pivot": [row["width"] / 2, row["bottom"]],
                }
            )
    manifest = {"frames": entries, "camera": {"views": views}, "blender_version": "fixture"}
    export_asset(raw, out, manifest, options, "project", "revision")
    return out, options, manifest


def test_profiles_and_character_pose_roles():
    profile = get_asset_profile("character")
    assert profile["specification"]["clips"]["walk"]["frames"] == [1, 2, 3]
    assert profile["specification"]["clips"]["typing"]["frames"] == [4, 5]
    assert profile["specification"]["clips"]["reading"]["frames"] == [6, 7]
    assert get_asset_profile("furniture", "chair")["specification"]["category"] == "chairs"
    explicit = resolve_asset(
        AssetSpec(
            kind="furniture", name="Barrel", asset_id="BARREL", preset="chair", category="decor"
        )
    )
    assert explicit.asset.category == "decor"
    with pytest.raises(DomainError):
        get_asset_profile("pet", "chair")
    with pytest.raises(ValidationError):
        AssetSpec(kind="character", name="Bad", clips={"walk": {"frames": list(range(7))}})
    with pytest.raises(ValidationError):
        AssetSpec(kind="furniture", name="Bad", asset_id="BAD", clips={"on": {"frames": [1, 2]}})


def test_rotated_desk_has_shared_background_and_rotated_ground():
    rows = asset_layouts(AssetSpec(kind="furniture", name="Desk", asset_id="DESK", preset="desk"))
    assert [(r["width"], r["height"]) for r in rows] == [(48, 32), (16, 64), (48, 32), (16, 64)]
    assert [r["background_tiles"] for r in rows] == [1] * 4
    assert [(r["footprint_w"], r["footprint_h"]) for r in rows] == [(3, 2), (1, 4), (3, 2), (1, 4)]
    wide = asset_layouts(AssetSpec(kind="furniture", name="Wide", asset_id="WIDE", ground_width=2))
    assert [(r["width"], r["height"]) for r in wide] == [(32, 16), (16, 32), (32, 16), (16, 32)]
    with pytest.raises(DomainError):
        resolve_asset(AssetSpec(kind="furniture", name="Bad", asset_id="BAD", width=24))


def test_shared_game_scale_and_stable_bottom_alignment():
    rows = asset_layouts(AssetSpec(kind="pet", name="Pet", asset_id="PET"))
    bounds = [(-0.2, 0.2, -0.1, 0.6), (-0.2, 0.2, -0.1, 0.6), (-0.6, 0.6, -0.1, 0.6)]
    fits = fit_asset_views(rows, bounds)
    assert len({fit["pixels_per_unit"] for fit in fits}) == 1
    for row, bound, fit in zip(rows, bounds, fits, strict=True):
        assert row["height"] / 2 + (fit["cy"] - bound[2]) * fit["pixels_per_unit"] == pytest.approx(
            row["bottom"]
        )
    # Body size in meters doesn't determine on-screen readability.
    smaller = fit_asset_views(rows, [tuple(v / 10 for v in b) for b in bounds])
    assert smaller[0]["pixels_per_unit"] == pytest.approx(fits[0]["pixels_per_unit"] * 10)


def test_explicit_anchor_reserves_contact_clearance():
    rows = asset_layouts(AssetSpec(kind="character", name="Person"))
    fits = fit_asset_views(rows, [(-0.2, 0.2, -0.05, 1)] * 3, [(0, 0)] * 3)
    for row, fit in zip(rows, fits, strict=True):
        assert row["height"] / 2 + fit["cy"] * fit["pixels_per_unit"] == pytest.approx(29)
        assert 29 + 0.05 * fit["pixels_per_unit"] <= 31


@pytest.mark.parametrize("kind", ["furniture", "character", "pet"])
def test_all_targets_have_complete_inspectable_export(tmp_path, kind):
    out, options, _ = fixture_export(tmp_path, kind, outline=True)
    metadata = json.loads((out / "spritesheet.json").read_text())
    assert metadata["configuration_id"] == "configuration-1"
    for entry in metadata["frames"]:
        with Image.open(out / entry["filename"]) as image:
            assert all(p == (0, 0, 0, 0) for p in image.get_flattened_data() if p[3] == 0)
    assert (out / metadata["package"]["archive"]).is_file()
    assert (out / "context.png").is_file()
    assert "__ASSET_DATA__" not in (out / "preview.html").read_text()
    assert "Approximate Pixel Agents context" in (out / "preview.html").read_text()
    with ZipFile(out / "sprites.zip") as archive:
        assert archive.testzip() is None
        assert {"asset-report.json", "context.png", "preview.html"} <= set(archive.namelist())
    for row in options.asset_layouts:
        inspected = inspect_sprite(out, angle=row["angle"])
        assert inspected["size"] == [row["width"], row["height"]]
        assert inspected["analysis"]["occupied_pixels"] > 0
    if kind == "pet":
        assert inspect_sprite(out, "idle", 90, 4)["size"] == [32, 32]


def test_semantic_character_slots_allow_noncontiguous_and_reused_frames(tmp_path):
    out, _, _ = fixture_export(
        tmp_path,
        "character",
        clips={
            "walk": {"frames": [12, 2, 12]},
            "typing": {"frames": [8, 5]},
            "reading": {"frames": [1, 9]},
        },
    )
    with Image.open(out / "pixel-agents-character/character.png") as sheet:
        assert sheet.size == (112, 96)
        for row, angle in enumerate([0, 180, 90]):
            for col, frame in enumerate([12, 2, 12, 8, 5, 1, 9]):
                entry = next(
                    e
                    for e in json.loads((out / "spritesheet.json").read_text())["frames"]
                    if e["angle"] == angle and e["frame"] == frame
                )
                with Image.open(out / entry["filename"]) as original:
                    assert (
                        sheet.crop((col * 16, row * 32, col * 16 + 16, row * 32 + 32)).tobytes()
                        == original.tobytes()
                    )


def test_furniture_variants_package_matches_per_direction_sizes(tmp_path):
    out, _, _ = fixture_export(
        tmp_path,
        preset="desk",
        clips={
            "empty": {"frames": [1]},
            "full": {"frames": [2, 3], "off_frame": 0},
        },
    )
    with ZipFile(out / "pixel-agents.zip") as archive:
        manifests = [
            json.loads(archive.read(n)) for n in archive.namelist() if n.endswith("manifest.json")
        ]
        assert {m["id"] for m in manifests} == {"FIXTURE_EMPTY", "FIXTURE_FULL"}
        static = next(m for m in manifests if m["id"] == "FIXTURE_EMPTY")
        assert static["backgroundTiles"] == 1
        assert [(m["width"], m["height"]) for m in static["members"]] == [
            (48, 32),
            (16, 64),
            (48, 32),
            (16, 64),
        ]
    assert inspect_sprite(out, "full", 90, 0)["size"] == [16, 64]


def test_configuration_persistence(service):
    project_id = str(service.create_project("Asset").id)
    first = service.configure_asset(project_id, AssetSpec(kind="character", name="First"))
    second = service.configure_asset(
        project_id, AssetSpec(kind="pet", name="Second", asset_id="PET")
    )
    assert first["id"] != second["id"]
    assert service.get_project(project_id).asset_configuration == second
    assert (
        service.store.record(first["id"], "asset_configuration")["specification"]["name"] == "First"
    )


@pytest.mark.parametrize("kind", ["character", "pet"])
def test_animation_playback_and_duration_match_consumer(tmp_path, kind):
    out, options, _ = fixture_export(tmp_path, kind, colors=64)
    metadata = json.loads((out / "spritesheet.json").read_text())
    walk = metadata["playback"]["walk"]
    assert walk == {
        "frames": [1, 2, 3, 2] if kind == "character" else [1, 2, 1, 3],
        "duration_ms": 150,
    }
    for clip, playback in metadata["playback"].items():
        with Image.open(out / f"animations/{clip}_000.apng") as animation:
            duration = 0
            for index in range(animation.n_frames):
                animation.seek(index)
                duration += animation.info["duration"]
            assert duration == len(playback["frames"]) * playback["duration_ms"]
    if kind == "pet":
        with Image.open(out / "animations/idle_090.apng") as sideways:
            assert sideways.size == (16, 32)  # Consumer uses front idle when facing right.
        with Image.open(out / "pixel-agents-pet/FIXTURE/pet.png") as sheet:
            for row, angle in enumerate([0, 180, 90]):
                frames = [1, 2, 3] + ([4, 5, 6] if angle != 90 else [])
                width = 32 if angle == 90 else 16
                for col, frame in enumerate(frames):
                    source = next(
                        e for e in metadata["frames"] if e["angle"] == angle and e["frame"] == frame
                    )
                    with Image.open(out / source["filename"]) as image:
                        assert (
                            sheet.crop(
                                (col * width, row * 32, (col + 1) * width, (row + 1) * 32)
                            ).tobytes()
                            == image.tobytes()
                        )
    palette = {tuple(bytes.fromhex(c[1:])) for c in metadata["palette"]}
    for entry in metadata["frames"]:
        with Image.open(out / entry["filename"]) as image:
            assert set(image.getchannel("A").get_flattened_data()) <= {0, 255}
            assert {p[:3] for p in image.get_flattened_data() if p[3]} <= palette


@pytest.mark.parametrize("problem", ["empty", "clipped", "wrong_size", "path"])
def test_asset_export_rejects_invalid_source_frames(tmp_path, problem):
    out, options, manifest = fixture_export(tmp_path)
    raw = tmp_path / "raw"
    first = raw / manifest["frames"][0]["filename"]
    if problem == "path":
        manifest["frames"][0]["filename"] = "../outside.png"
    else:
        with Image.open(first) as im:
            size = (8, 8) if problem == "wrong_size" else im.size
        image = Image.new("RGBA", size)
        if problem == "clipped":
            ImageDraw.Draw(image).rectangle((0, 0, 10, 10), fill="white")
        image.save(first)
    with pytest.raises(
        DomainError,
        match={
            "empty": "Empty sprite",
            "clipped": "render boundary",
            "wrong_size": "canvas dimensions",
            "path": "image path",
        }[problem],
    ):
        export_asset(raw, tmp_path / "invalid", manifest, options, "project", "revision")


async def test_render_captures_configuration_and_scene_revision(service, fake_blender):
    from conftest import wait_job

    from pixel_art_mcp.jobs.worker import Worker

    service.settings.blender_binary = fake_blender
    worker = Worker(service)
    await worker.start()
    project = str(service.create_project("Snapshot").id)
    try:
        created = await wait_job(
            service, str(service.submit_script(project, "print('model')", None).id)
        )
        assert created.status == "succeeded"
    finally:
        await worker.stop()
    # Hold the queue so subsequent configuration edits happen before rendering starts.
    service.worker_ready = True
    service.blender_version = "fixture"
    first = service.configure_asset(project, AssetSpec(kind="character", name="First"))
    job = service.render_asset(project)
    second = service.configure_asset(project, AssetSpec(kind="pet", name="Second", asset_id="PET"))
    snapshot = service.store.job(str(job.id))
    assert snapshot["input_revision_id"] == str(created.result_revision_id)
    assert snapshot["params"]["options"]["asset_configuration_id"] == first["id"]
    assert snapshot["params"]["options"]["asset"]["kind"] == "character"
    assert service.get_project(project).asset_configuration == second


def test_storage_category_normalizes_to_upload_compatible_misc():
    from pixel_art_mcp.models import PixelAgentsOptions

    for model in [AssetSpec, PixelAgentsOptions]:
        values = {"name": "Barrel", "asset_id": "BARREL", "category": "storage"}
        if model is AssetSpec:
            values["kind"] = "furniture"
        assert model.model_validate(values).category == "misc"
        assert "storage" not in model.model_json_schema()["properties"]["category"]["enum"]
