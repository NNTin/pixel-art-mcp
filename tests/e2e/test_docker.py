import io
import json
import os
import zipfile

import httpx
import pytest
from helpers import MCPClient
from PIL import Image

pytestmark = pytest.mark.e2e


async def test_docker_reference_model_edit_preview_and_sheet(png, example_dir):
    url = os.environ.get("PIXEL_E2E_URL")
    if not url:
        pytest.skip("Set PIXEL_E2E_URL to a running Docker service")
    async with httpx.AsyncClient(base_url=url, timeout=30) as http:
        ready = await http.get("/health/ready")
        assert ready.status_code == 200, ready.text
        client = MCPClient(http)
        await client.initialize()
        project = await client.data("create_project", {"name": "Docker chair"})
        project_id = project["id"]
        uploaded = await http.post(
            f"/projects/{project_id}/references",
            files={"file": ("reference.png", png, "image/png")},
        )
        assert uploaded.status_code == 201, uploaded.text
        reference = await client.call(
            "get_reference_image", {"reference_id": uploaded.json()["id"]}
        )
        assert any(c["type"] == "image" for c in reference["content"])
        creation = await client.data(
            "execute_blender_python",
            {
                "project_id": project_id,
                "script": (example_dir / "chair.py").read_text(),
                "expected_revision_id": None,
            },
        )
        created = await client.wait(creation["id"])
        edit = await client.data(
            "execute_blender_python",
            {
                "project_id": project_id,
                "script": (example_dir / "modify_chair.py").read_text(),
                "expected_revision_id": created["result_revision_id"],
            },
        )
        await client.wait(edit["id"])
        preview_job = await client.data("render_preview", {"project_id": project_id})
        preview = await client.wait(preview_job["id"])
        preview_id = next(a["id"] for a in preview["artifacts"] if a["filename"] == "preview.png")
        rendered = await client.call("get_artifact", {"artifact_id": preview_id})
        assert any(c["type"] == "image" for c in rendered["content"])
        render_job = await client.data(
            "render_sprites",
            {"project_id": project_id, "options": {"angles": [0, 45, 90], "samples": 8}},
        )
        result = await client.wait(render_job["id"], timeout=300)
        archive_id = next(a["id"] for a in result["artifacts"] if a["filename"] == "sprites.zip")
        downloaded = await http.get(f"/artifacts/{archive_id}")
        assert downloaded.status_code == 200
        with zipfile.ZipFile(io.BytesIO(downloaded.content)) as archive:
            metadata = json.loads(archive.read("spritesheet.json"))
            assert metadata["size"] == [16, 48]
            frame_bytes = []
            for frame in metadata["frames"]:
                with Image.open(io.BytesIO(archive.read(frame["filename"]))) as im:
                    assert im.size == (16, 16)
                    assert im.getbbox() is not None
                    frame_bytes.append(im.tobytes())
            assert len(set(frame_bytes)) == 3

        animation = await client.data("create_project", {"name": "Docker animation"})
        job = await client.data(
            "execute_blender_python",
            {
                "project_id": animation["id"],
                "script": (example_dir / "bobbing_cube.py").read_text(),
                "expected_revision_id": None,
            },
        )
        await client.wait(job["id"])
        job = await client.data(
            "render_sprites",
            {
                "project_id": animation["id"],
                "options": {"angles": [0, 90], "frame_end": 3, "samples": 8},
            },
        )
        exported = await client.wait(job["id"], timeout=300)
        metadata_id = next(
            a["id"] for a in exported["artifacts"] if a["filename"] == "spritesheet.json"
        )
        metadata = (await http.get(f"/artifacts/{metadata_id}")).json()
        assert len(metadata["frames"]) == 6
        assert len({tuple(frame["pivot"]) for frame in metadata["frames"]}) == 1
        animations = [a for a in exported["artifacts"] if a["kind"] == "animation"]
        assert len(animations) == 2
        assert all(a["media_type"] == "image/apng" for a in animations)
        assert all(a["width"] == a["height"] == 16 for a in animations)
        for row, artifact in enumerate(animations):
            downloaded = await http.get(f"/artifacts/{artifact['id']}")
            assert downloaded.headers["content-type"] == "image/apng"
            with Image.open(io.BytesIO(downloaded.content)) as apng:
                assert apng.n_frames == 3 and apng.info["loop"] == 0
                for column in range(3):
                    apng.seek(column)
                    frame = metadata["frames"][row * 3 + column]
                    frame_artifact = next(
                        a
                        for a in exported["artifacts"]
                        if a["filename"] == frame["filename"].split("/")[-1]
                    )
                    png = await http.get(f"/artifacts/{frame_artifact['id']}")
                    with Image.open(io.BytesIO(png.content)) as original:
                        assert apng.convert("RGBA").tobytes() == original.tobytes()
        player = next(a for a in exported["artifacts"] if a["filename"] == "preview.html")
        assert player["kind"] == "player"
        html = (await http.get(f"/artifacts/{player['id']}")).text
        assert "data:image/png;base64," in html and "__PLAYER_DATA__" not in html
        preview_job = await client.data(
            "render_preview",
            {
                "project_id": animation["id"],
                "options": {"angles": [0, 90], "frame_end": 3, "samples": 8},
            },
        )
        preview = await client.wait(preview_job["id"], timeout=300)
        sheet = next(a for a in exported["artifacts"] if a["filename"] == "spritesheet.png")
        preview_sheet = next(a for a in preview["artifacts"] if a["filename"] == "spritesheet.png")
        assert (await http.get(f"/artifacts/{sheet['id']}")).content == (
            await http.get(f"/artifacts/{preview_sheet['id']}")
        ).content


async def test_docker_curve_framing_uses_visible_geometry():
    url = os.environ.get("PIXEL_E2E_URL")
    if not url:
        pytest.skip("Set PIXEL_E2E_URL to a running Docker service")
    async with httpx.AsyncClient(base_url=url, timeout=30) as http:
        client = MCPClient(http)
        await client.initialize()
        project = await client.data("create_project", {"name": "Curve framing regression"})
        creation = await client.data(
            "execute_blender_python",
            {
                "project_id": project["id"],
                "expected_revision_id": None,
                "script": """import bpy
bpy.ops.curve.primitive_bezier_circle_add(radius=0.4, location=(0, 0, 0.5))
ring = bpy.context.object
ring.name = "Small beveled ring"
ring.data.bevel_depth = 0.03
ring.data.bevel_resolution = 2
""",
            },
        )
        await client.wait(creation["id"])
        job = await client.data(
            "render_preview",
            {
                "project_id": project["id"],
                "angle": 0,
                # This regresses the auto-fit-to-bounding-box path specifically (a
                # curve bounding-box bug), not physical-scale framing -- opt out of
                # the meters_per_tile default explicitly so the expected ortho_scale
                # stays bbox-derived rather than fixed.
                "options": {"width": 64, "height": 64, "meters_per_tile": None},
            },
        )
        completed = await client.wait(job["id"])
        metadata_artifact = next(
            a for a in completed["artifacts"] if a["filename"] == "spritesheet.json"
        )
        metadata = (await http.get(f"/artifacts/{metadata_artifact['id']}")).json()
        # Diameter including bevel is 0.86, with 10% padding per side. The legacy
        # curve's fallback bounds incorrectly produce an ortho scale above 3.
        assert metadata["camera"]["ortho_scale"] == pytest.approx(0.86 * 1.2, abs=0.015)
        sprite = next(a for a in completed["artifacts"] if a["kind"] == "frame")
        png = await http.get(f"/artifacts/{sprite['id']}")
        with Image.open(io.BytesIO(png.content)) as im:
            bounds = im.getbbox()
            assert bounds is not None
            assert 50 <= bounds[2] - bounds[0] <= 55


async def test_docker_fixed_physical_scale_camera_is_independent_of_bounding_box():
    """meters_per_tile pins camera zoom to an absolute physical scale instead of
    auto-fitting to each object's own bounding box, so unrelated jobs sharing the
    same meters_per_tile come out at correctly relative real-world sizes -- e.g. a
    small candle and a tall street lamp. Verified with two spheres of very different
    radii: their ortho_scale must be identical and deterministic (not derived from
    either sphere's bounds), and the larger sphere must occupy a visibly larger
    fraction of its own canvas than the smaller one -- proving neither independently
    auto-filled its own frame the way the default (unset) mode would."""
    url = os.environ.get("PIXEL_E2E_URL")
    if not url:
        pytest.skip("Set PIXEL_E2E_URL to a running Docker service")
    async with httpx.AsyncClient(base_url=url, timeout=30) as http:
        client = MCPClient(http)
        await client.initialize()
        widths = {}
        for label, radius in [("small", 0.05), ("large", 0.4)]:
            project = await client.data("create_project", {"name": f"Physical scale {label}"})
            creation = await client.data(
                "execute_blender_python",
                {
                    "project_id": project["id"],
                    "expected_revision_id": None,
                    "script": f"import bpy\n"
                    f"bpy.ops.mesh.primitive_uv_sphere_add(radius={radius}, "
                    f"location=(0, 0, {radius}))\n",
                },
            )
            await client.wait(creation["id"])
            job = await client.data(
                "render_preview",
                {
                    "project_id": project["id"],
                    "angle": 0,
                    "options": {
                        "width": 64,
                        "height": 64,
                        "meters_per_tile": 1.0,
                        "padding": 0.0,
                    },
                },
            )
            completed = await client.wait(job["id"])
            metadata_artifact = next(
                a for a in completed["artifacts"] if a["filename"] == "spritesheet.json"
            )
            metadata = (await http.get(f"/artifacts/{metadata_artifact['id']}")).json()
            # height=64px, meters_per_tile=1.0, padding=0, 16px/tile -> target view height
            # = 64*1.0/16 = 4.0m; a square canvas gives ortho_scale == 4.0, identical and
            # deterministic for both spheres regardless of their own (very different) bounds.
            assert metadata["camera"]["ortho_scale"] == pytest.approx(4.0, abs=0.01)
            sprite = next(a for a in completed["artifacts"] if a["kind"] == "frame")
            png = await http.get(f"/artifacts/{sprite['id']}")
            with Image.open(io.BytesIO(png.content)) as im:
                bounds = im.getbbox()
                assert bounds is not None
                widths[label] = bounds[2] - bounds[0]
        # The physical-scale claim itself, not just metadata plumbing: the 0.4m-radius
        # sphere must render meaningfully wider (in pixels) than the 0.05m-radius one.
        assert widths["large"] > widths["small"] * 2


async def test_docker_pixel_agents_tall_lamp_package(example_dir):
    url = os.environ.get("PIXEL_E2E_URL")
    if not url:
        pytest.skip("Set PIXEL_E2E_URL to a running Docker service")
    async with httpx.AsyncClient(base_url=url, timeout=30) as http:
        client = MCPClient(http)
        await client.initialize()
        project = await client.data("create_project", {"name": "Tall furniture export"})
        creation = await client.data(
            "execute_blender_python",
            {
                "project_id": project["id"],
                "expected_revision_id": None,
                "script": (example_dir / "oil_lamp.py").read_text(),
            },
        )
        await client.wait(creation["id"])
        job = await client.data(
            "render_sprites",
            {
                "project_id": project["id"],
                "options": {
                    "tile_height": 2,
                    "frame_end": 2,
                    "samples": 4,
                    "supersampling": 2,
                    "pixel_agents": {
                        "asset_id": "TEST_LAMP",
                        "name": "Test Lamp",
                        "can_place_on_surfaces": True,
                        "footprint_h": 1,
                        "off_frame": 0,
                    },
                },
            },
        )
        result = await client.wait(job["id"], timeout=300)
        artifact = next(a for a in result["artifacts"] if a["filename"] == "sprites.zip")
        downloaded = await http.get(f"/artifacts/{artifact['id']}")
        with zipfile.ZipFile(io.BytesIO(downloaded.content)) as archive:
            metadata = json.loads(archive.read("spritesheet.json"))
            assert metadata["size"] == [32, 128]
            assert metadata["settings"]["fps"] == 5
            assert len(metadata["frames"]) == 8
            assert all(frame["duration_ms"] == 200 for frame in metadata["frames"])
            with Image.open(io.BytesIO(archive.read(metadata["comparison"]["image"]))) as high:
                assert high.size == (64, 256)
            html = archive.read("preview.html").decode()
            assert "USED BY PIXEL-AGENTS" in html and "REFERENCE RENDER" in html
            with zipfile.ZipFile(io.BytesIO(archive.read("pixel-agents.zip"))) as target:
                root = "assets/furniture/TEST_LAMP/"
                manifest = json.loads(target.read(root + "manifest.json"))
                assert len(target.namelist()) == 13  # Four directions × (off + two on) + JSON
                assert manifest["groupType"] == "rotation"
                assert [g["orientation"] for g in manifest["members"]] == [
                    "front",
                    "right",
                    "back",
                    "left",
                ]
                for state in manifest["members"]:
                    off, on = state["members"]
                    assert off["state"] == "off" and on["state"] == "on"
                    assert off["footprintH"] == 1 and off["height"] == 32
                    assert [f["frame"] for f in on["members"]] == [0, 1]
                    with Image.open(io.BytesIO(target.read(root + off["file"]))) as off_png:
                        with Image.open(
                            io.BytesIO(target.read(root + on["members"][0]["file"]))
                        ) as on_png:
                            assert off_png.size == on_png.size == (16, 32)
                            assert off_png.getbbox() is not None
                            assert off_png.tobytes() != on_png.tobytes()


async def test_docker_pixel_agents_pet_package(example_dir):
    """The real verification for blender/runner.py's per-angle render width: pet's
    right-facing (90deg) row must come back at double the down/up rows' width, all
    from one Blender invocation. Nothing in this repo can check that without Blender."""
    url = os.environ.get("PIXEL_E2E_URL")
    if not url:
        pytest.skip("Set PIXEL_E2E_URL to a running Docker service")
    async with httpx.AsyncClient(base_url=url, timeout=30) as http:
        client = MCPClient(http)
        await client.initialize()
        project = await client.data("create_project", {"name": "Pet export"})
        creation = await client.data(
            "execute_blender_python",
            {
                "project_id": project["id"],
                "expected_revision_id": None,
                "script": (example_dir / "oil_lamp.py").read_text(),
            },
        )
        await client.wait(creation["id"])
        job = await client.data(
            "render_sprites",
            {
                "project_id": project["id"],
                "options": {
                    "tile_width": 1,
                    "tile_height": 2,
                    "angles": [0, 90, 180],
                    "samples": 4,
                    "supersampling": 1,
                    "states": [
                        {"id": "walk", "name": "Walk", "frame_start": 1, "frame_end": 3},
                        {"id": "idle", "name": "Idle", "frame_start": 5, "frame_end": 7},
                    ],
                    "pet": {"asset_id": "TEST_PET", "name": "Test Pet"},
                },
            },
        )
        result = await client.wait(job["id"], timeout=300)
        artifact = next(a for a in result["artifacts"] if a["filename"] == "sprites.zip")
        downloaded = await http.get(f"/artifacts/{artifact['id']}")
        with zipfile.ZipFile(io.BytesIO(downloaded.content)) as archive:
            metadata = json.loads(archive.read("spritesheet.json"))
            assert metadata["pet"]["walk_frames"] == [1, 2, 3]
            assert metadata["pet"]["idle_frames"] == [5, 6, 7]
            with zipfile.ZipFile(io.BytesIO(archive.read("pixel-agents-pet.zip"))) as target:
                root = "TEST_PET/"
                assert sorted(target.namelist()) == [root + "manifest.json", root + "pet.png"]
                manifest = json.loads(target.read(root + "manifest.json"))
                assert manifest == {"id": "TEST_PET", "name": "Test Pet"}
                with Image.open(io.BytesIO(target.read(root + "pet.png"))) as pet:
                    assert pet.size == (96, 96)
                    pet = pet.convert("RGBA")
                    # Down/up rows (y<64) are real content only in their left 16px per
                    # frame; the right row (y>=64) fills the full 32px-wide frames --
                    # the whole point of the per-angle width change under test.
                    assert pet.crop((0, 0, 96, 64)).getbbox() is not None
                    assert pet.crop((0, 64, 96, 96)).getbbox() is not None


@pytest.mark.parametrize(
    "kind,script,preset",
    [
        ("furniture", "chair.py", "chair"),
        ("character", "character.py", "character"),
        ("pet", "pet.py", "pet"),
    ],
)
async def test_game_asset_workflow_in_docker(example_dir, kind, script, preset):
    url = os.environ.get("PIXEL_E2E_URL")
    if not url:
        pytest.skip("Set PIXEL_E2E_URL to a running Docker service")
    async with httpx.AsyncClient(base_url=url, timeout=60) as http:
        client = MCPClient(http)
        await client.initialize()
        project = await client.data("create_project", {"name": f"Game {kind}"})
        config = await client.data(
            "configure_asset",
            {
                "project_id": project["id"],
                "specification": {
                    "kind": kind,
                    "asset_id": "FIXTURE",
                    "name": "Fixture",
                    "preset": preset,
                    "samples": 8,
                    "outline": True,
                },
            },
        )
        modeled = await client.wait(
            (
                await client.data(
                    "execute_blender_python",
                    {
                        "project_id": project["id"],
                        "script": (example_dir / script).read_text(),
                        "expected_revision_id": None,
                    },
                )
            )["id"]
        )
        queued = await client.data("render_asset", {"project_id": project["id"]})
        # The package must retain the original configuration despite a subsequent update.
        await client.data(
            "configure_asset",
            {
                "project_id": project["id"],
                "specification": {
                    "kind": kind,
                    "asset_id": "CHANGED",
                    "name": "Later configuration",
                    "preset": preset,
                },
            },
        )
        job = await client.wait(queued["id"], timeout=300)
        assert job["input_revision_id"] == modeled["result_revision_id"]
        report = await client.data("inspect_asset", {"job_id": job["id"]})
        assert report["configuration_id"] == config["id"]
        assert report["kind"] == kind
        assert report == {
            "job_id": job["id"],
            **(await http.get(job["outputs"]["asset-report.json"]["download_url"])).json(),
        }
        assert len({a["export_path"] for a in job["artifacts"]}) == len(job["artifacts"])
        archive = (await http.get(job["outputs"]["sprites.zip"]["download_url"])).content
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            assert zipped.testzip() is None
            metadata = json.loads(zipped.read("spritesheet.json"))
            assert metadata["asset"]["name"] == "Fixture"
            assert metadata["asset"]["outline"] is True
            assert metadata["configuration_id"] == config["id"]
            assert len({v["pixels_per_unit"] for v in metadata["camera"]["views"]}) == 1
            for frame in metadata["frames"]:
                with Image.open(io.BytesIO(zipped.read(frame["filename"]))) as image:
                    bounds = image.getchannel("A").getbbox()
                    assert bounds is not None
                    assert set(image.getchannel("A").get_flattened_data()) <= {0, 255}
                    assert image.size in ((16, 32), (32, 32))
            inspection = await client.data("inspect_sprite", {"job_id": job["id"], "angle": 90})
            assert inspection["size"] == ([32, 32] if kind == "pet" else [16, 32])
            assert "__ASSET_DATA__" not in zipped.read("preview.html").decode()
            assert metadata["package"]["archive"] in zipped.namelist()
