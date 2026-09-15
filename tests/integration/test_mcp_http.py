import base64

import httpx
from helpers import MCPClient

from pixel_art_mcp.app import create_app


async def test_mcp_initialize_tools_upload_script_and_inspect(settings, fake_blender, png):
    settings.blender_binary = fake_blender
    app = create_app(settings)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://localhost"
        ) as http,
    ):
        client = MCPClient(http)
        initialized = await client.initialize()
        assert "execute_blender_python" in initialized["instructions"]
        listing = await client.request("tools/list", {})
        tools = {tool["name"]: tool for tool in listing["tools"]}
        assert {
            "get_asset_profile",
            "configure_asset",
            "render_asset",
            "inspect_asset",
        } <= tools.keys()
        assert tools["execute_blender_python"]["annotations"]["readOnlyHint"] is False
        assert tools["inspect_scene"]["annotations"]["readOnlyHint"] is True
        assert tools["wait_for_job"]["annotations"]["readOnlyHint"] is True
        assert tools["inspect_sprite"]["annotations"]["readOnlyHint"] is True
        assert {"write_pixel_art", "get_pixel_art", "get_asset_preview"} <= tools.keys()
        assert not {"render_preview", "render_sprites"} & tools.keys()
        definitions = tools["write_pixel_art"]["inputSchema"]["$defs"]
        assert set(definitions["PixelDefinition"]["properties"]) == {
            "version",
            "palette",
            "layers",
        }
        assert "expected_revision_id" in tools["write_pixel_art"]["inputSchema"]["required"]
        assert definitions["PixelPose"]["properties"]["rows"]["description"]
        assert definitions["PixelLayer"]["properties"]["poses"]["description"]
        assert tools["get_pixel_art"]["outputSchema"]["properties"]["definition"]
        upload_schema = tools["add_reference_image"]["inputSchema"]
        file_schema = upload_schema["$defs"]["OpenAIFile"]
        assert file_schema["required"] == ["download_url", "file_id"]
        assert set(file_schema["properties"]) == {
            "download_url",
            "file_id",
            "mime_type",
            "file_name",
        }
        assert tools["add_reference_image"]["_meta"]["openai/fileParams"] == ["file"]

        project = await client.data("create_project", {"name": "Test chair"})
        reference = await client.data(
            "add_reference_image",
            {"project_id": project["id"], "data_base64": base64.b64encode(png).decode()},
        )
        image = await client.call("get_reference_image", {"reference_id": reference["id"]})
        assert any(content["type"] == "image" for content in image["content"])
        created = await client.data(
            "execute_blender_python",
            {"project_id": project["id"], "script": "print('chair')", "expected_revision_id": None},
        )
        completed = await client.wait(created["id"])
        scene = await client.data("inspect_scene", {"project_id": project["id"]})
        assert scene["summary"]["objects"][0]["name"] == "Seat"
        assert scene["revision_id"] == completed["result_revision_id"]
        script = next(a for a in completed["artifacts"] if a["filename"] == "script.py")
        artifact = await http.get(f"/artifacts/{script['id']}")
        assert artifact.text == "print('chair')"
        bad = await client.call("get_project", {"project_id": "not-a-uuid"}, allow_error=True)
        assert bad["isError"]


async def test_geometry_alone_cannot_render(settings, fake_blender):
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
        project = await client.data("create_project", {"name": "Geometry"})
        profile = await client.data("get_asset_profile", {"kind": "furniture"})
        await client.data(
            "configure_asset",
            {
                "project_id": project["id"],
                "specification": profile["specification"],
            },
        )
        job = await client.data(
            "execute_blender_python",
            {
                "project_id": project["id"],
                "script": "print('geometry')",
                "expected_revision_id": None,
            },
        )
        await client.wait(job["id"])
        for name in ("render_asset", "render_preview", "render_sprites"):
            result = await client.call(name, {"project_id": project["id"]}, allow_error=True)
            assert result["isError"]
        result = await client.call("get_pixel_art", {"project_id": project["id"]}, allow_error=True)
        assert result["isError"]


async def test_http_upload_validation_and_local_boundary(settings, png):
    app = create_app(settings)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://localhost"
        ) as http,
    ):
        assert (await http.get("/health/live")).status_code == 200
        assert (await http.get("/health/ready")).status_code == 503
        project = (await http.post("/projects", json={"name": "Reference"})).json()
        uploaded = await http.post(
            f"/projects/{project['id']}/references", files={"file": ("chair.png", png, "image/png")}
        )
        assert uploaded.status_code == 201, uploaded.text
        assert (await http.get("/artifacts/not-a-uuid")).status_code == 422
        blocked = await http.post(
            "/projects", json={"name": "Blocked"}, headers={"Origin": "https://unrelated.example"}
        )
        assert blocked.status_code == 403
        assert (
            await http.get("/health/live", headers={"Host": "attacker.example"})
        ).status_code == 400
        bad_image = await http.post(
            f"/projects/{project['id']}/references",
            files={"file": ("bad.png", b"not an image", "image/png")},
        )
        assert bad_image.status_code == 400
        mcp = MCPClient(http)
        await mcp.initialize()
        unavailable = await mcp.call(
            "execute_blender_python",
            {"project_id": project["id"], "script": "print('a')", "expected_revision_id": None},
            allow_error=True,
        )
        assert unavailable["isError"]


async def test_wait_for_job_collapses_polling_into_one_call(settings, fake_blender):
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
        project = await client.data("create_project", {"name": "Wait target"})
        job = await client.data(
            "execute_blender_python",
            {"project_id": project["id"], "script": "print('chair')", "expected_revision_id": None},
        )
        result = await client.data("wait_for_job", {"job_id": job["id"], "timeout_seconds": 10})
        assert result["status"] == "succeeded"


async def test_wait_for_job_returns_non_terminal_when_timeout_elapses_first(settings, fake_blender):
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
        project = await client.data("create_project", {"name": "Slow wait target"})
        job = await client.data(
            "execute_blender_python",
            {
                "project_id": project["id"],
                "script": "# slow\nprint('create')",
                "expected_revision_id": None,
            },
        )
        result = await client.data("wait_for_job", {"job_id": job["id"], "timeout_seconds": 0.1})
        assert result["status"] in ("queued", "running")


async def test_http_body_limit_before_parsing(settings):
    settings.max_upload_bytes = 1
    settings.max_script_bytes = 1
    app = create_app(settings)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://localhost"
        ) as http,
    ):
        response = await http.post(
            "/mcp", content=b"x" * 70_000, headers={"Content-Type": "application/json"}
        )
        assert response.status_code == 413


async def test_asset_configuration_shared_by_http_and_mcp(settings, fake_blender):
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
        profile = await client.data("get_asset_profile", {"kind": "character"})
        assert profile == (await http.get("/asset-profiles/character")).json()
        project = await client.data("create_project", {"name": "Configured"})
        response = await http.put(
            f"/projects/{project['id']}/asset", json={"kind": "character", "name": "Person"}
        )
        assert response.status_code == 200
        config = response.json()
        detail = await client.data("get_project", {"project_id": project["id"]})
        assert detail["asset_configuration"] == config
        assert (await http.get("/asset-profiles/unknown")).status_code == 400
        invalid = await http.put(
            f"/projects/{project['id']}/asset", json={"kind": "pet", "name": "No ID"}
        )
        assert invalid.status_code == 422
        # Configuration alone is insufficient: render requires an actual scene revision.
        response = await http.post(f"/projects/{project['id']}/asset/renders")
        assert response.status_code == 409
