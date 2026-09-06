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
            assert metadata["size"] == [64, 192]
            frame_bytes = []
            for frame in metadata["frames"]:
                with Image.open(io.BytesIO(archive.read(frame["filename"]))) as im:
                    assert im.size == (64, 64)
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
        assert all(a["width"] == a["height"] == 64 for a in animations)
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
        job = await client.data("render_preview", {"project_id": project["id"], "angle": 0})
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
