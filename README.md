# Pixel Art MCP

A local MCP service for creating **Pixel Agents furniture, characters, and pets** at the
consumer's native pixel resolution. Author recognizable shapes on the final grid, save named
layers and animation poses in Blender revisions, and export installable packages.

`PixelArt` and `Canvas` support native pixel drawing or exact-pixel finishing layers anchored to
rendered Blender objects. Important features are designed explicitly, not recovered by adding
colors or shrinking a detailed model. A shared palette and local color voting keep rendered
surfaces stable; authored pixels bypass resampling entirely. Feature diagnostics check visibility,
connectivity and clipping, while offline previews support the necessary visual review.

For Pixel Agents, use `get_asset_profile` → `configure_asset` → `execute_blender_python` →
`render_asset` → `inspect_asset`. [Game asset profiles](docs/game-assets.md) give furniture,
characters, and pets readable sizes, stable placement, shared palettes, and the consumer's actual
pose sequences. Every render produces an installable package, exact pixel inspection, and offline
context previews. Named furniture clips become selectable variants such as empty/partial/full barrels.

The development webview harness checks generated packages against a read-only Pixel Agents checkout;
Node and Chromium are not production dependencies.

The AI lives in your MCP client. It interprets reference images, writes Blender Python, and calls
`execute_blender_python`. This service executes the code and saves editable `.blend` revisions.
No AI API key, automatic semantic redraw, or image-to-3D service is involved.

Read [what we are building](docs/overview.md) for the project goals and Mermaid diagrams of the
MCP integration and rendering pipeline.

## Start

```sh
docker compose up --build -d
```

Connect a local MCP client using Streamable HTTP at **http://localhost:8000/mcp**.
Open **http://localhost:8000/docs** for HTTP uploads and downloads.
The service has no authentication and is published on host loopback only. The container image
targets Linux x86-64 and pins Blender 4.5.13 LTS with CPU Cycles; no GPU or display is required.

See [client setup](docs/client-setup.md), [tool usage](docs/tools.md), and
[architecture](docs/architecture.md) for the workflow and operating constraints.
See [validation status](docs/validation.md) for the completed Docker rendering and playback checks.
See [contract testing](docs/contract-testing.md) for how the pixel-agents/character/pet exports
are checked live against pixel-index's real staging and production APIs.

## Development

Install Python 3.12 and uv, then:

```sh
uv sync --frozen
uv run pixel-art-mcp
uv run ruff check .
uv run ruff format --check .
uv run mypy src/pixel_art_mcp
uv run pytest -m 'not blender and not e2e'
```

Blender tests require a Blender executable (set `PIXEL_BLENDER_BINARY` when it is not on PATH).
`uv run pytest -m blender` exercises real modeling and rendering. With Compose running,
`PIXEL_E2E_URL=http://localhost:8000 uv run pytest -m e2e` exercises the whole service over HTTP.

Dependencies are locked in `uv.lock`. The implementation uses the supported official MCP SDK
1.29.1 maintenance release: its complete distribution was available for offline testing in the
implementation environment, whereas the v2 proposed during planning was not. The protocol and
application code are separated to keep a future SDK upgrade local to the MCP adapter.

## Data and execution

The named `pixel-data` volume stores the SQLite database, references, scripts, revisions, and
exports. Ordinary container restarts retain them. Back up the volume while the service is stopped.
Interrupted jobs become failed; queued jobs resume. Python scripts are never automatically retried.

Submitted Python is trusted code with access to the container's writable workspace, including
other projects, and outbound networking. The default container is non-root, has a read-only root
filesystem, and mounts no host directories or Docker socket. This deployment is for one local
owner, not for public or mutually untrusted users. ChatGPT on the web cannot connect directly to
your localhost endpoint; remote networking and authentication are outside this release.
