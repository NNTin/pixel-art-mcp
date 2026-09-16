import json

from conftest import wait_job
from PIL import Image

from pixel_art_mcp.jobs.worker import Worker
from pixel_art_mcp.models import AssetSpec


async def test_real_chair_edit_and_sprite_export(service, example_dir, png):
    worker = Worker(service)
    await worker.start()
    try:
        project_id = str(service.create_project("Real chair").id)
        specs = json.loads((example_dir / "asset-specs.json").read_text())
        service.configure_asset(
            project_id, AssetSpec.model_validate(specs["chair"]["specification"])
        )
        await service.add_reference(project_id, png, "reference.png")
        job = service.submit_script(project_id, (example_dir / "chair.py").read_text(), None)
        created = await wait_job(service, str(job.id), 120)
        assert created.status == "succeeded", created
        summary = service.revision(project_id)["summary"]
        assert any(layer["name"] == "body" for layer in summary["pixel_art"]["layers"])
        edited = service.submit_script(
            project_id,
            (example_dir / "modify_chair.py").read_text(),
            str(created.result_revision_id),
        )
        assert (await wait_job(service, str(edited.id), 120)).status == "succeeded"
        render = service.render_asset(project_id)
        completed = await wait_job(service, str(render.id), 300)
        assert completed.status == "succeeded", completed
        frame_artifacts = [a for a in completed.artifacts if a.kind == "frame"]
        pixels = []
        for artifact in frame_artifacts:
            with Image.open(service.artifact_path(str(artifact.id))) as im:
                assert im.size == (16, 32)
                assert im.getbbox() is not None
                assert set(im.getchannel("A").get_flattened_data()) <= {0, 255}
                pixels.append(im.tobytes())
        assert len(set(pixels)) == 4
    finally:
        await worker.stop()
