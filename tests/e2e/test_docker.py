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
    for script in example.get("scripts", []):
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
    if "definition" in example:
        queued = await client.data(
            "write_pixel_art",
            {
                "project_id": project["id"],
                "expected_revision_id": revision,
                "definition": json.loads((example_dir / example["definition"]).read_text()),
            },
        )
        await client.wait(queued["id"])
    queued = await client.data("render_asset", {"project_id": project["id"]})
    return project, await client.wait(queued["id"], timeout=300)


async def test_thermometer_json_example_roundtrip(example_dir):
    url = os.environ.get("PIXEL_E2E_URL")
    if not url:
        pytest.skip("Set PIXEL_E2E_URL to a running Docker service")
    async with httpx.AsyncClient(base_url=url, timeout=60) as http:
        client = MCPClient(http)
        await client.initialize()
        project, result = await generate_example(client, example_dir, "thermometer")
        source = await client.data("get_pixel_art", {"project_id": project["id"]})
        assert source["authored_views"] == {str(a): [16, 32] for a in (0, 90, 180, 270)}
        report = await client.data("inspect_asset", {"job_id": result["id"]})
        assert len(report["frames"]) == 12 and report["findings"] == []
        for clip, frame, count in [("cold", 1, 22), ("room", 2, 32), ("hot", 3, 42)]:
            sprite = await client.data(
                "inspect_sprite",
                {
                    "job_id": result["id"],
                    "state_id": clip,
                    "angle": 0,
                    "frame": frame,
                },
            )
            fluid = next(f for f in sprite["pixel_features"] if f["name"] == "red-column-and-bulb")
            assert fluid["visible_pixels"] == count and fluid["components"] == 1
        metadata = (
            await client.data(
                "get_artifact",
                {
                    "artifact_id": result["outputs"]["spritesheet.json"]["id"],
                },
            )
        )["metadata"]
        assert len(metadata["frames"]) == 12


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
            assert any(layer["name"] == "body" for layer in art["layers"])
            metadata = json.loads(archive.read("spritesheet.json"))
            assert metadata["size"] == [16, 128]
            assert all(not f["issues"] for e in metadata["frames"] for f in e["pixel_features"])
            assert len({archive.read(e["filename"]) for e in metadata["frames"]}) == 4


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
            assert report["visual_review_required"]
            # Rain/flames and diagonal-only contacts can form separate four-connected regions.
            # These remain installable, but are now surfaced for visual review.
            assert {finding["code"] for finding in report["findings"]} <= {
                "disconnected_silhouette"
            }
            assert report["status"] == ("review" if report["findings"] else "checks_passed")
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
