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
