"""No local examples/imports or artifact HTTP GETs: all authoring inputs come from MCP."""

import base64
import io
import os

import httpx
import pytest
from helpers import MCPClient
from PIL import Image

pytestmark = pytest.mark.e2e


async def finished(client, job):
    for _ in range(10):
        job = await client.data("wait_for_job", {"job_id": job["id"]})
        if job["status"] in ("succeeded", "failed", "cancelled"):
            assert job["status"] == "succeeded", job
            return job
    raise AssertionError("Job did not finish")


@pytest.mark.parametrize("kind", ["furniture", "character", "pet"])
async def test_cold_mcp_only_author_edit_render_inspect(kind):
    url = os.environ.get("PIXEL_E2E_URL")
    if not url:
        pytest.skip("Set PIXEL_E2E_URL to a running Docker service")
    async with httpx.AsyncClient(base_url=url, timeout=180) as http:
        client = MCPClient(http)
        initialized = await client.initialize()
        assert "write_pixel_art" in initialized["instructions"]
        tools = {t["name"]: t for t in (await client.request("tools/list", {}))["tools"]}
        assert "PixelDefinition" in tools["write_pixel_art"]["inputSchema"]["$defs"]
        assert not {"render_preview", "render_sprites"} & tools.keys()
        capabilities = await client.data("get_capabilities", {})
        assert capabilities["authoring_contract_version"] == 1
        assert capabilities["pixel_authoring_required"] is True
        profile = await client.data("get_asset_profile", {"kind": kind})
        calls = profile["pixel_authoring"]["example_calls"]
        ids, render, source = {}, None, None
        for call in calls:
            args = {
                k: ids.get(v, v) if isinstance(v, str) else v for k, v in call["arguments"].items()
            }
            name = call["tool"]
            result = await client.data(name, args)
            if name == "create_project":
                ids["<project.id>"] = result["id"]
            elif name == "write_pixel_art":
                ids["<write job.id>"] = result["id"]
            elif name == "render_asset":
                ids["<render job.id>"] = result["id"]
            elif name == "wait_for_job":
                result = await finished(client, result)
                if result["id"] == ids.get("<render job.id>"):
                    render = result
            elif name == "get_pixel_art":
                source = result
        assert render and source
        original_revision = source["revision_id"]
        source["definition"]["palette"]["G"] = "#66d6c5"
        # Distinct frame patch using documented source-frame semantics, no hidden helper calls.
        first = source["definition"]["layers"][0]["poses"][0]
        selected_frame = next(iter(profile["specification"]["clips"].values()))["frames"][-1]
        source["definition"]["layers"][0]["poses"].append(
            {
                **first,
                "frame": selected_frame,
                "x": first["x"] + 1,
            }
        )
        edited = await client.data(
            "write_pixel_art",
            {
                "project_id": source["project_id"],
                "definition": source["definition"],
                "expected_revision_id": original_revision,
            },
        )
        edited = await finished(client, edited)
        assert edited["result_revision_id"] != original_revision
        script = next(a for a in edited["artifacts"] if a["filename"] == "script.py")
        assert (
            "PixelArt" in (await client.data("get_artifact", {"artifact_id": script["id"]}))["text"]
        )
        rendered = await finished(
            client,
            await client.data(
                "render_asset",
                {
                    "project_id": source["project_id"],
                },
            ),
        )
        report = await client.data("inspect_asset", {"job_id": rendered["id"]})
        assert report["visual_review_required"]
        source_artifact = await client.data(
            "get_artifact",
            {
                "artifact_id": rendered["outputs"]["pixel-art.json"]["id"],
            },
        )
        assert source_artifact["metadata"]["palette"]["G"] == "#66d6c5"
        for clip_id, clip in profile["specification"]["clips"].items():
            for layout in profile["layouts"]:
                frame = clip["frames"][-1]
                inspected = await client.data(
                    "inspect_sprite",
                    {
                        "job_id": rendered["id"],
                        "state_id": clip_id,
                        "angle": layout["angle"],
                        "frame": frame,
                        "compare_job_id": render["id"],
                    },
                )
                assert inspected["size"] == [layout["width"], layout["height"]]
                assert inspected["analysis"]["occupied_pixels"] == 36
                image = await client.call(
                    "get_asset_preview",
                    {
                        "job_id": rendered["id"],
                        "clip_id": clip_id,
                        "angle": layout["angle"],
                        "frame": frame,
                        "scale": 1,
                        "context": False,
                    },
                )
                block = next(c for c in image["content"] if c["type"] == "image")
                with Image.open(io.BytesIO(base64.b64decode(block["data"]))) as png:
                    assert set(png.getchannel("A").get_flattened_data()) == {0, 255}
                    assert (102, 214, 197, 255) in set(png.get_flattened_data())
        # Preview context and consumer-only left are available without a browser or downloads.
        for context in (True, False):
            preview = await client.call(
                "get_asset_preview",
                {
                    "job_id": rendered["id"],
                    "angle": 270,
                    "context": context,
                    "scale": 4,
                },
            )
            assert any(c["type"] == "image" for c in preview["content"])
            assert preview["structuredContent"]["context_is_approximate"] is context
