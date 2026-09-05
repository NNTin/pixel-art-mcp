import json
import os
import shutil

import pytest
from conftest import wait_job
from PIL import Image

from pixel_art_mcp.jobs.worker import Worker
from pixel_art_mcp.models import RenderOptions

pytestmark = pytest.mark.blender


async def test_real_chair_edit_and_animated_sprite_export(service, example_dir, png):
    binary = os.environ.get("PIXEL_BLENDER_BINARY", "blender")
    if not shutil.which(binary):
        pytest.skip("A real Blender executable is required")
    service.settings.blender_binary = binary
    worker = Worker(service)
    await worker.start()
    try:
        project_id = str(service.create_project("Real chair").id)
        await service.add_reference(project_id, png, "reference.png")
        job = service.submit_script(project_id, (example_dir / "chair.py").read_text(), None)
        created = await wait_job(service, str(job.id), 120)
        assert created.status == "succeeded", created
        summary = service.revision(project_id)["summary"]
        assert any(o["name"] == "Seat" for o in summary["objects"])
        edited = service.submit_script(
            project_id,
            (example_dir / "modify_chair.py").read_text(),
            str(created.result_revision_id),
        )
        assert (await wait_job(service, str(edited.id), 120)).status == "succeeded"
        options = RenderOptions(angles=[0, 45, 90], samples=8)
        render = service.submit_render(project_id, options)
        completed = await wait_job(service, str(render.id), 300)
        assert completed.status == "succeeded", completed
        frame_artifacts = [a for a in completed.artifacts if a.kind == "frame"]
        pixels = []
        for artifact in frame_artifacts:
            with Image.open(service.artifact_path(str(artifact.id))) as im:
                assert im.size == (64, 64)
                assert im.getbbox() is not None
                assert set(im.getchannel("A").get_flattened_data()) <= {0, 255}
                pixels.append(im.tobytes())
        assert len(set(pixels)) == 3

        animated_id = str(service.create_project("Animation").id)
        job = service.submit_script(
            animated_id, (example_dir / "bobbing_cube.py").read_text(), None
        )
        assert (await wait_job(service, str(job.id), 120)).status == "succeeded"
        render = service.submit_render(
            animated_id, RenderOptions(angles=[0], frame_end=3, samples=8)
        )
        completed = await wait_job(service, str(render.id), 300)
        assert completed.status == "succeeded", completed
        metadata_artifact = next(a for a in completed.artifacts if a.filename == "spritesheet.json")
        metadata = json.loads(service.artifact_path(str(metadata_artifact.id)).read_text())
        assert len({tuple(f["pivot"]) for f in metadata["frames"]}) == 1
        assert metadata["size"] == [192, 64]
    finally:
        await worker.stop()
