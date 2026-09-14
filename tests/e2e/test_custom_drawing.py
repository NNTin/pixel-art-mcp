"""Deterministic large-asset workflow over MCP, not a model artistic-quality evaluation."""

import base64
import copy
import io
import json
import os
from zipfile import ZipFile

import httpx
import pytest
from helpers import MCPClient
from PIL import Image

pytestmark = pytest.mark.e2e


async def test_large_cat_tree_incremental_commands_and_package(example_dir):
    url = os.environ.get("PIXEL_E2E_URL")
    if not url:
        pytest.skip("Set PIXEL_E2E_URL to an isolated Docker service")
    definition = json.loads((example_dir / "cat_tree.json").read_text())
    async with httpx.AsyncClient(base_url=url, timeout=180) as http:
        client = MCPClient(http)
        initialized = await client.initialize()
        assert "rect/line/stamp" in initialized["instructions"]
        profile = await client.data(
            "get_asset_profile",
            {
                "kind": "furniture",
                "ground_width": 3,
                "ground_depth": 4,
                "background_tiles": 1,
            },
        )
        tools = {t["name"]: t for t in (await client.request("tools/list", {}))["tools"]}
        schema = tools["write_pixel_art"]["inputSchema"]["$defs"]
        assert {"PixelDrawing", "Rectangle", "Line", "Stamp"} <= schema.keys()
        pid = (await client.data("create_project", {"name": "Large numeric drawing"}))["id"]
        config = await client.data(
            "configure_asset",
            {
                "project_id": pid,
                "specification": {
                    **profile["specification"],
                    "name": "Cat Tree",
                    "asset_id": "CAT_TREE",
                },
            },
        )
        base = {**definition, "layers": definition["layers"][:1]}
        first = await client.data(
            "write_pixel_art",
            {
                "project_id": pid,
                "definition": base,
                "expected_revision_id": None,
            },
        )
        first = await client.wait(first["id"])
        revision = first["result_revision_id"]
        for layer in definition["layers"][1:]:
            edit = await client.data(
                "edit_pixel_art",
                {
                    "project_id": pid,
                    "expected_revision_id": revision,
                    "edits": [{"op": "set_layer", "layer": layer}],
                },
            )
            revision = (await client.wait(edit["id"]))["result_revision_id"]
        source = await client.data("get_pixel_art", {"project_id": pid})
        assert [layer["name"] for layer in source["definition"]["layers"]] == [
            layer["name"] for layer in definition["layers"]
        ]
        for layer in source["definition"]["layers"]:
            for pose in layer["poses"]:
                assert pose["drawing"] is None
                assert len({len(r) for r in pose["rows"]}) == 1
        bad_layer = copy.deepcopy(source["definition"]["layers"][0])
        bad_layer["poses"][0]["rows"] = ["O" * n for n in [40, 40, 40, 39, 40, 40]]
        bad = await client.call(
            "edit_pixel_art",
            {
                "project_id": pid,
                "expected_revision_id": revision,
                "edits": [{"op": "set_layer", "layer": bad_layer}],
            },
            allow_error=True,
        )
        assert bad["isError"]
        assert "row 3: expected 40, actual 39" in str(bad)
        assert (await client.data("get_pixel_art", {"project_id": pid})) == source
        render = await client.data("render_asset", {"project_id": pid})
        render = await client.wait(render["id"])
        for layout in config["layouts"]:
            inspected = await client.data(
                "inspect_sprite",
                {
                    "job_id": render["id"],
                    "angle": layout["angle"],
                },
            )
            assert inspected["size"] == [layout["width"], layout["height"]]
            assert inspected["analysis"]["opaque_connected_components"] == 1
            assert inspected["analysis"]["opaque_singleton_components"] == 0
            preview = await client.call(
                "get_asset_preview",
                {
                    "job_id": render["id"],
                    "angle": layout["angle"],
                    "scale": 1,
                    "context": False,
                },
            )
            block = next(b for b in preview["content"] if b["type"] == "image")
            with Image.open(io.BytesIO(base64.b64decode(block["data"]))) as im:
                pixels = set(im.get_flattened_data())
                assert {p[3] for p in pixels} == {0, 255}
                assert {p[:3] for p in pixels if p[3]} <= {
                    tuple(bytes.fromhex(c[1:])) for c in definition["palette"].values()
                }
                # Sisal highlights and the red toy survive export in every view.
                assert (240, 219, 173, 255) in pixels
                assert (234, 115, 94, 255) in pixels
        archive = await client.call(
            "get_artifact",
            {
                "artifact_id": render["outputs"]["pixel-agents.zip"]["id"],
            },
        )
        resource = next(b["resource"] for b in archive["content"] if b["type"] == "resource")
        with ZipFile(io.BytesIO(base64.b64decode(resource["blob"]))) as zipfile:
            assert zipfile.testzip() is None
            manifest = next(
                json.loads(zipfile.read(n))
                for n in zipfile.namelist()
                if n.endswith("manifest.json")
            )
            assert manifest["backgroundTiles"] == 1
            assert [(m["width"], m["height"]) for m in manifest["members"]] == [
                (48, 80),
                (64, 64),
                (48, 80),
                (64, 64),
            ]
