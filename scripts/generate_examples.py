"""Generate every example through real MCP calls and download complete export artifacts."""

import argparse
import asyncio
import html
import json
from pathlib import Path
from zipfile import ZipFile

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

ROOT = Path(__file__).resolve().parents[1]


async def generate(base_url: str, output: Path, only: list[str]) -> None:
    examples = json.loads((ROOT / "examples/asset-specs.json").read_text())
    output.mkdir(parents=True, exist_ok=True)
    async with (
        httpx.AsyncClient(base_url=base_url, timeout=60) as http,
        streamable_http_client(base_url.rstrip("/") + "/mcp") as (read, write, _),
        ClientSession(read, write) as client,
    ):
        await client.initialize()

        async def call(name, arguments):
            result = await client.call_tool(name, arguments)
            if result.isError:
                raise RuntimeError(f"{name}: {result.content}")
            return result.structuredContent

        async def wait(job):
            while job["status"] not in ("succeeded", "failed", "cancelled"):
                job = await call("wait_for_job", {"job_id": job["id"], "timeout_seconds": 45})
            if job["status"] != "succeeded":
                raise RuntimeError(json.dumps(job, indent=2))
            return job

        for key, example in examples.items():
            if only and key not in only:
                continue
            print(f"{key}: modeling", flush=True)
            profile = await call(
                "get_asset_profile",
                {
                    "kind": example["specification"]["kind"],
                    "preset": example["specification"].get("preset"),
                },
            )
            project = await call("create_project", {"name": "Game examples / " + key})
            config = await call(
                "configure_asset",
                {"project_id": project["id"], "specification": example["specification"]},
            )
            revision = None
            for filename in example["scripts"]:
                modeled = await wait(
                    await call(
                        "execute_blender_python",
                        {
                            "project_id": project["id"],
                            "expected_revision_id": revision,
                            "script": (ROOT / "examples" / filename).read_text(),
                        },
                    )
                )
                revision = modeled["result_revision_id"]
            print(f"{key}: rendering", flush=True)
            rendered = await wait(
                await call("render_asset", {"project_id": project["id"], "revision_id": revision})
            )
            report = await call("inspect_asset", {"job_id": rendered["id"]})
            grid = await call("inspect_sprite", {"job_id": rendered["id"]})
            folder = output / key
            folder.mkdir(exist_ok=True)
            for artifact in [rendered["outputs"]["sprites.zip"], *modeled["artifacts"]]:
                await call("get_artifact", {"artifact_id": artifact["id"]})
                response = await http.get(f"/artifacts/{artifact['id']}")
                response.raise_for_status()
                assert len(response.content) == artifact["size_bytes"]
                (folder / artifact["filename"]).write_bytes(response.content)
            with ZipFile(folder / "sprites.zip") as archive:
                assert archive.testzip() is None
                for name in archive.namelist():
                    if not (folder / name).resolve().is_relative_to(folder.resolve()):
                        raise ValueError("Invalid archive path")
                archive.extractall(folder)
            (folder / "generation.json").write_text(
                json.dumps(
                    {
                        "project": project,
                        "configuration": config,
                        "revision_id": revision,
                        "render_job_id": rendered["id"],
                        "profile": profile,
                        "report": report,
                        "inspection": grid,
                    },
                    indent=2,
                )
            )
            print(
                f"{key}: {len(report['frames'])} frames, "
                f"{len(report['findings'])} advisory findings",
                flush=True,
            )
    cards = [
        f'<article><h2><a href="{html.escape(p.name)}/preview.html">{html.escape(p.name)}</a></h2>'
        f'<a href="{html.escape(p.name)}/preview.html">'
        f'<img src="{html.escape(p.name)}/context.png" '
        f'alt="{html.escape(p.name)} in approximate placement context"></a>'
        f'<p><a href="{html.escape(p.name)}/sprites.zip">Download all outputs</a> · '
        f'<a href="{html.escape(p.name)}/asset-report.json">Diagnostics</a></p></article>'
        for p in sorted(output.iterdir())
        if (p / "preview.html").is_file()
    ]
    webview = (
        '<p><a href="webview/index.html">Actual webview renderer: before / after gallery</a></p>'
        if (output / "webview/index.html").is_file()
        else ""
    )
    (output / "index.html").write_text(
        '<!doctype html><meta charset="utf-8"><title>Game assets</title>'
        "<style>body{font:16px system-ui;background:#182027;color:#e6eef4;margin:24px}"
        "a{color:#a4cefb}main{display:flex;flex-wrap:wrap;gap:24px}"
        "img{width:320px;image-rendering:pixelated}h2{font-size:20px}</style>"
        "<h1>Pixel Agents asset previews</h1><p>Generated through MCP. "
        "Open an example for animation, placement controls, and source comparison.</p>"
        + webview
        + "<main>"
        + "".join(cards)
        + "</main>"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:8000")
    parser.add_argument("--output", type=Path, default=ROOT / "tmp/asset-workflow")
    parser.add_argument("--only", nargs="*", default=[])
    args = parser.parse_args()
    asyncio.run(generate(args.base_url, args.output, args.only))
