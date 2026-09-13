import copy

import httpx
from helpers import MCPClient

from pixel_art_mcp.app import create_app


async def test_source_roundtrip_atomic_replacement_and_reconfiguration(settings, fake_blender):
    settings.blender_binary = fake_blender
    app = create_app(settings)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://localhost"
        ) as http,
    ):
        client = MCPClient(http)
        await client.initialize()
        project = await client.data("create_project", {"name": "Typed source"})
        pid = project["id"]
        profile = await client.data("get_asset_profile", {"kind": "furniture"})
        definition = profile["pixel_authoring"]["example_definition"]
        args = {"project_id": pid, "definition": definition, "expected_revision_id": None}
        assert (await client.call("write_pixel_art", args, allow_error=True))["isError"]
        await client.data(
            "configure_asset", {"project_id": pid, "specification": profile["specification"]}
        )
        job = await client.data("write_pixel_art", args)
        first = await client.wait(job["id"])
        original = await client.data("get_pixel_art", {"project_id": pid})
        assert original["revision_id"] == first["result_revision_id"]
        assert original["authored_views"] == {str(a): [16, 16] for a in (0, 90, 180, 270)}
        script = next(a for a in first["artifacts"] if a["filename"] == "script.py")
        source = await client.data("get_artifact", {"artifact_id": script["id"]})
        assert "from pixel_art_mcp.pixel_art import PixelArt" in source["text"]
        definition = copy.deepcopy(original["definition"])
        definition["layers"].append({"name": "badge", "poses": [{"angle": 0, "rows": ["GG"]}]})
        edited = await client.data(
            "write_pixel_art",
            {
                "project_id": pid,
                "definition": definition,
                "expected_revision_id": original["revision_id"],
            },
        )
        await client.wait(edited["id"])
        current = await client.data("get_pixel_art", {"project_id": pid})
        assert len(current["definition"]["layers"]) == 2
        assert (await client.call("write_pixel_art", args, allow_error=True))["isError"]
        bad = copy.deepcopy(current["definition"])
        bad["layers"][0]["poses"][0]["rows"] = ["?bad"]
        assert (
            await client.call(
                "write_pixel_art",
                {
                    "project_id": pid,
                    "definition": bad,
                    "expected_revision_id": current["revision_id"],
                },
                allow_error=True,
            )
        )["isError"]
        # Advanced scripts cannot remove the required source. The old revision survives failure.
        removal = await client.data(
            "execute_blender_python",
            {
                "project_id": pid,
                "script": "del bpy.context.scene['pixel_art']",
                "expected_revision_id": current["revision_id"],
            },
        )
        failed = await client.data("wait_for_job", {"job_id": removal["id"]})
        assert failed["status"] == "failed" and "remove" in failed["error"]
        assert await client.data("get_pixel_art", {"project_id": pid}) == current
        # Whole replacement deletes the badge, rather than silently preserving omitted layers.
        restored = await client.data(
            "write_pixel_art",
            {
                "project_id": pid,
                "definition": original["definition"],
                "expected_revision_id": current["revision_id"],
            },
        )
        await client.wait(restored["id"])
        restored = await client.data("get_pixel_art", {"project_id": pid})
        assert restored["definition"] == original["definition"]
        historical = await client.data(
            "get_pixel_art",
            {
                "project_id": pid,
                "revision_id": original["revision_id"],
            },
        )
        assert historical == original
        await client.data(
            "configure_asset",
            {
                "project_id": pid,
                "specification": {
                    **profile["specification"],
                    "preset": "chair",
                },
            },
        )
        assert (await client.call("render_asset", {"project_id": pid}, allow_error=True))["isError"]
        # Rewriting after resizing derives the new canvas dimensions server-side.
        adapted = await client.data(
            "write_pixel_art",
            {
                "project_id": pid,
                "definition": restored["definition"],
                "expected_revision_id": restored["revision_id"],
            },
        )
        await client.wait(adapted["id"])
        assert (await client.data("get_pixel_art", {"project_id": pid}))["authored_views"]["0"] == [
            16,
            32,
        ]


async def test_typed_write_queue_cas_and_configuration_snapshot(service, fake_blender):
    from conftest import wait_job

    from pixel_art_mcp.assets import get_asset_profile
    from pixel_art_mcp.authoring import PixelDefinition
    from pixel_art_mcp.jobs.worker import Worker
    from pixel_art_mcp.models import AssetSpec

    service.settings.blender_binary = fake_blender
    service.worker_ready, service.blender_version = True, "fixture"
    pid = str(service.create_project("Queued").id)
    profile = get_asset_profile("furniture")
    service.configure_asset(pid, AssetSpec.model_validate(profile["specification"]))
    definition = PixelDefinition.model_validate(profile["pixel_authoring"]["example_definition"])
    first = service.write_pixel_art(pid, definition, None)
    stale = service.write_pixel_art(pid, definition, None)
    service.configure_asset(
        pid, AssetSpec(kind="furniture", name="Resized", asset_id="TEST", preset="chair")
    )
    worker = Worker(service)
    await worker.start()
    try:
        assert (await wait_job(service, str(first.id))).status == "succeeded"
        assert (await wait_job(service, str(stale.id))).status == "failed"
        assert service.get_pixel_art(pid).authored_views["0"] == [16, 16]
        assert len(service.get_project(pid).revisions) == 1
    finally:
        await worker.stop()
