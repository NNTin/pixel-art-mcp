import io
import json
import os
import zipfile

import httpx
import pytest
from helpers import MCPClient
from PIL import Image

pytestmark = pytest.mark.e2e


async def generate_example(client, example_dir, key):
    example = json.loads((example_dir / "asset-specs.json").read_text())[key]
    project = await client.data("create_project", {"name": "Native test / " + key})
    await client.data(
        "configure_asset",
        {
            "project_id": project["id"],
            "specification": example["specification"],
        },
    )
    revision = None
    for script in example["scripts"]:
        queued = await client.data(
            "execute_blender_python",
            {
                "project_id": project["id"],
                "expected_revision_id": revision,
                "script": (example_dir / script).read_text(),
            },
        )
        modeled = await client.wait(queued["id"])
        revision = modeled["result_revision_id"]
    queued = await client.data("render_asset", {"project_id": project["id"]})
    return project, await client.wait(queued["id"], timeout=300)


async def test_docker_reference_and_saved_pixel_layer_edit(png, example_dir):
    url = os.environ.get("PIXEL_E2E_URL")
    if not url:
        pytest.skip("Set PIXEL_E2E_URL to a running Docker service")
    async with httpx.AsyncClient(base_url=url, timeout=60) as http:
        client = MCPClient(http)
        await client.initialize()
        project, result = await generate_example(client, example_dir, "modify-chair")
        uploaded = await http.post(
            f"/projects/{project['id']}/references",
            files={"file": ("reference.png", png, "image/png")},
        )
        assert uploaded.status_code == 201
        reference = await client.call(
            "get_reference_image", {"reference_id": uploaded.json()["id"]}
        )
        assert any(c["type"] == "image" for c in reference["content"])
        preview = await client.call(
            "get_artifact",
            {
                "artifact_id": result["outputs"]["preview.png"]["id"],
            },
        )
        assert any(c["type"] == "image" for c in preview["content"])
        downloaded = await http.get(result["outputs"]["sprites.zip"]["download_url"])
        with zipfile.ZipFile(io.BytesIO(downloaded.content)) as archive:
            art = json.loads(archive.read("pixel-art.json"))
            assert art["palette"]["C"] == "#aa466b"
            assert any(layer["name"] == "backrest" for layer in art["layers"])
            metadata = json.loads(archive.read("spritesheet.json"))
            assert metadata["size"] == [16, 128]
            assert metadata["source_kind"] == "native-grid"
            assert all(not f["issues"] for e in metadata["frames"] for f in e["pixel_features"])
            assert len({archive.read(e["filename"]) for e in metadata["frames"]}) == 4


async def test_docker_hybrid_badge_follows_object_without_resampling(example_dir):
    url = os.environ.get("PIXEL_E2E_URL")
    if not url:
        pytest.skip("Set PIXEL_E2E_URL to a running Docker service")
    async with httpx.AsyncClient(base_url=url, timeout=60) as http:
        client = MCPClient(http)
        await client.initialize()
        _, result = await generate_example(client, example_dir, "bobbing-cube")
        downloaded = await http.get(result["outputs"]["sprites.zip"]["download_url"])
        with zipfile.ZipFile(io.BytesIO(downloaded.content)) as archive:
            metadata = json.loads(archive.read("spritesheet.json"))
            art = json.loads(archive.read("pixel-art.json"))
            assert metadata["source_kind"] == "blender-render"
            assert len(metadata["frames"]) == 32
            ys = set()
            for entry in metadata["frames"]:
                patch = entry["pixel_layers"][0]
                feature = entry["pixel_features"][0]
                assert feature["visible_pixels"] == 21 and feature["components"] == 1
                assert not feature["issues"]
                ys.add(patch["y"])
                with Image.open(io.BytesIO(archive.read(entry["filename"]))) as sprite:
                    for y, row in enumerate(patch["rows"]):
                        for x, symbol in enumerate(row):
                            if symbol != ".":
                                expected = (*bytes.fromhex(art["palette"][symbol][1:]), 255)
                                assert sprite.getpixel((patch["x"] + x, patch["y"] + y)) == expected
            assert len(ys) > 1


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


@pytest.mark.parametrize(
    "key,archive_name",
    [
        ("oil-lamp", "pixel-agents.zip"),
        ("pet", "pixel-agents-pet.zip"),
        ("rain-barrel", "pixel-agents.zip"),
    ],
)
async def test_native_animated_packages(example_dir, key, archive_name):
    url = os.environ.get("PIXEL_E2E_URL")
    if not url:
        pytest.skip("Set PIXEL_E2E_URL to a running Docker service")
    async with httpx.AsyncClient(base_url=url, timeout=60) as http:
        client = MCPClient(http)
        await client.initialize()
        _, result = await generate_example(client, example_dir, key)
        downloaded = await http.get(result["outputs"]["sprites.zip"]["download_url"])
        with zipfile.ZipFile(io.BytesIO(downloaded.content)) as archive:
            assert archive.testzip() is None
            metadata = json.loads(archive.read("spritesheet.json"))
            report = json.loads(archive.read("asset-report.json"))
            assert report["status"] == "checks_passed" and report["visual_review_required"]
            assert metadata["source_kind"] == "native-grid"
            assert all(not f["issues"] for e in metadata["frames"] for f in e["pixel_features"])
            with zipfile.ZipFile(io.BytesIO(archive.read(archive_name))) as target:
                assert target.testzip() is None
                if key == "pet":
                    with Image.open(io.BytesIO(target.read("GOLDEN_DOG/pet.png"))) as pet:
                        assert pet.size == (96, 96)
                        assert pet.crop((0, 64, 96, 96)).getbbox()
            if key == "rain-barrel":
                images = []
                for entry in metadata["frames"]:
                    if entry["angle"] == 0 and entry["frame"] in range(9):
                        with Image.open(io.BytesIO(archive.read(entry["filename"]))) as im:
                            images.append(im.crop((0, 18, 16, 32)).tobytes())
                assert len(images) == 9 and len(set(images)) == 1


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
            assert metadata["asset"]["outline"] is False
            assert metadata["configuration_id"] == config["id"]
            assert metadata["camera"]["projection"] == "native-grid"
            assert "pixel-art.json" in zipped.namelist()
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
