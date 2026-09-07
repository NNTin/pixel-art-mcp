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
        assert len(tools) == 14
        assert tools["execute_blender_python"]["annotations"]["readOnlyHint"] is False
        assert tools["inspect_scene"]["annotations"]["readOnlyHint"] is True
        assert tools["wait_for_job"]["annotations"]["readOnlyHint"] is True
        assert "options" in tools["render_preview"]["inputSchema"]["properties"]
        render_schema = tools["render_sprites"]["inputSchema"]["$defs"]["RenderOptions"]
        assert render_schema["properties"]["tile_width"]["default"] == 1
        assert "tall" in render_schema["properties"]["tile_height"]["description"]
        assert "override" in render_schema["properties"]["width"]["description"]
        assert render_schema["properties"]["fps"]["default"] == 5
        assert "pixel_agents" in render_schema["properties"]
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


async def test_preview_options_and_legacy_overrides(settings, fake_blender, monkeypatch):
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
        project = await client.data("create_project", {"name": "Preview settings"})
        job = await client.data(
            "execute_blender_python",
            {
                "project_id": project["id"],
                "script": "print('model')",
                "expected_revision_id": None,
            },
        )
        await client.wait(job["id"])
        service = app.state.service
        # Leave render jobs queued: this fixture tests the wire contract, not Blender rendering.
        monkeypatch.setattr(service.store, "claim_job", lambda: None)
        defaults = await client.data("render_preview", {"project_id": project["id"]})
        values = service.store.job(defaults["id"])["params"]["options"]
        assert values["angles"] == [0] and values["frame_start"] == values["frame_end"] == 1
        assert values["width"] == 16 and values["samples"] == 16
        options = {
            "angles": [0, 90],
            "width": 96,
            "height": 64,
            "elevation": 20,
            "frame_start": 2,
            "frame_end": 8,
            "frame_step": 2,
            "lighting": "scene",
            "palette": ["#000000", "#ffffff"],
            "samples": 4,
        }
        preview = await client.data(
            "render_preview", {"project_id": project["id"], "options": options}
        )
        values = service.store.job(preview["id"])["params"]["options"]
        assert all(values[key] == value for key, value in options.items())
        assert service.store.job(preview["id"])["operation"] == "preview"
        override = await client.data(
            "render_preview",
            {
                "project_id": project["id"],
                "options": options,
                "angle": 0,
                "frame": 0,
            },
        )
        values = service.store.job(override["id"])["params"]["options"]
        assert values["angles"] == [0] and values["frame_start"] == values["frame_end"] == 0
        assert values["width"] == 96 and values["lighting"] == "scene"
        invalid = await client.call(
            "render_preview",
            {
                "project_id": project["id"],
                "frame": -1,
            },
            allow_error=True,
        )
        assert invalid["isError"]
        excessive = await client.call(
            "render_preview",
            {
                "project_id": project["id"],
                "options": {"frame_end": 1000},
            },
            allow_error=True,
        )
        assert excessive["isError"]


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
