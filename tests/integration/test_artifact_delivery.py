import base64
import hashlib
from contextlib import asynccontextmanager

import httpx
import pytest
from helpers import MCPClient

from pixel_art_mcp.app import create_app


@asynccontextmanager
async def delivery(settings):
    settings.base_url = "https://assets.example.test/pixel"
    app = create_app(settings)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://localhost"
        ) as http,
    ):
        client = MCPClient(http)
        await client.initialize()
        service = app.state.service
        pid = str(service.create_project("Delivery").id)

        def publish(filename, data):
            path = service.store.root / "projects" / pid / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            record = service.artifact_record(pid, path, "test")
            service.store.put_record("artifact", record)
            return record["id"], path

        yield client, publish


@pytest.mark.parametrize(
    "filename,data",
    [
        ("sprites.zip", b"PK\x03\x04\x00\xff\x81binary"),
        ("scene.bin", b"OPAQUE-BINARY-v1\x00\xfe"),
        ("empty.zip", b""),
    ],
)
async def test_binary_embedded_and_tool_bytes_need_no_http_get(settings, filename, data):
    async with delivery(settings) as (client, publish):
        aid, _ = publish(filename, data)
        result = await client.call("get_artifact", {"artifact_id": aid})
        resource = next(
            block["resource"] for block in result["content"] if block["type"] == "resource"
        )
        assert base64.b64decode(resource["blob"], validate=True) == data
        assert resource["uri"] == f"pixel-art://artifacts/{aid}"
        details = result["structuredContent"]
        assert details["download_url"] == f"https://assets.example.test/pixel/artifacts/{aid}"
        assert details["byte_retrieval"]["tool"] == "get_artifact_chunk"
        offset, decoded = 0, bytearray()
        while offset is not None:
            chunk = await client.data(
                "get_artifact_chunk", {"artifact_id": aid, "offset": offset, "length": 5}
            )
            raw = base64.b64decode(chunk["data_base64"], validate=True)
            assert chunk["offset"] == offset and chunk["bytes_read"] == len(raw)
            assert chunk["sha256"] == hashlib.sha256(raw).hexdigest()
            assert chunk["size_bytes"] == len(data)
            decoded.extend(raw)
            offset = chunk["next_offset"]
        assert decoded == data


async def test_large_file_has_bounded_chunks_and_metadata_only(settings):
    async with delivery(settings) as (client, publish):
        data = bytes(range(256)) * 4097
        aid, _ = publish("large.zip", data)
        result = await client.call("get_artifact", {"artifact_id": aid})
        assert all(block["type"] == "text" for block in result["content"])
        assert result["structuredContent"]["byte_retrieval"]["arguments"]["artifact_id"] == aid
        offset, parts = 0, []
        while offset is not None:
            chunk = await client.data(
                "get_artifact_chunk", {"artifact_id": aid, "offset": offset, "length": 262144}
            )
            raw = base64.b64decode(chunk["data_base64"], validate=True)
            assert len(raw) <= 262144 and chunk["bytes_read"] == len(raw)
            assert chunk["sha256"] == hashlib.sha256(raw).hexdigest()
            parts.append(raw)
            offset = chunk["next_offset"]
        assert b"".join(parts) == data
        eof = await client.data("get_artifact_chunk", {"artifact_id": aid, "offset": len(data)})
        assert eof["bytes_read"] == 0 and eof["next_offset"] is None and eof["data_base64"] == ""


@pytest.mark.parametrize(
    "args",
    [
        {"offset": -1},
        {"offset": True},
        {"offset": 1.5},
        {"offset": 4},
        {"length": 0},
        {"length": 262145},
        {"length": True},
        {"length": 1.5},
    ],
)
async def test_byte_ranges_reject_invalid_values(settings, args):
    async with delivery(settings) as (client, publish):
        aid, _ = publish("tiny.zip", b"abc")
        assert (
            await client.call("get_artifact_chunk", {"artifact_id": aid, **args}, allow_error=True)
        )["isError"]


async def test_changed_missing_and_non_uuid_artifacts_fail(settings):
    async with delivery(settings) as (client, publish):
        aid, path = publish("changed.zip", b"abc")
        path.write_bytes(b"abcd")
        assert (await client.call("get_artifact_chunk", {"artifact_id": aid}, allow_error=True))[
            "isError"
        ]
        path.unlink()
        assert (await client.call("get_artifact_chunk", {"artifact_id": aid}, allow_error=True))[
            "isError"
        ]
        assert (
            await client.call(
                "get_artifact_chunk", {"artifact_id": "../../etc/passwd"}, allow_error=True
            )
        )["isError"]


async def test_delivery_and_edit_contracts_are_discoverable(settings):
    async with delivery(settings) as (client, _):
        tools = {tool["name"]: tool for tool in (await client.request("tools/list", {}))["tools"]}
        capabilities = await client.data("get_capabilities", {})
        assert capabilities["limits"]["max_artifact_chunk_bytes"] == 262144
        assert capabilities["artifact_delivery"]["chunk_tool"] == "get_artifact_chunk"
        chunk = tools["get_artifact_chunk"]
        assert chunk["annotations"]["readOnlyHint"] is True
        assert chunk["inputSchema"]["properties"]["length"]["maximum"] == 262144
        assert "decoded bytes" in chunk["outputSchema"]["properties"]["sha256"]["description"]
        edit = tools["edit_pixel_art"]
        assert edit["annotations"]["destructiveHint"] is True
        assert "expected_revision_id" in edit["inputSchema"]["required"]
        schema = edit["inputSchema"]
        assert schema["properties"]["edits"]["maxItems"] == 128
        assert schema["properties"]["edits"]["items"]["discriminator"]["propertyName"] == "op"
        assert "frame" in schema["$defs"]["MovePose"]["required"]
