# Pixel Art MCP

A local Docker service for turning natural-language prompts and optional reference images into
pixel-art sprite sheets with multiple viewing directions and animation frames.

Describe an object, ask for changes, and export consistent views of the same model: for example,
a chair viewed at 0°, 45°, and 90°, or an animated object rendered from eight directions. Blender
provides the editable 3D geometry, materials, and animation; the pixel-art converter turns its
renders into transparent sprites and packs them into a sheet with playback metadata.
Animated exports include transparent APNG loops for each direction and a self-contained browser
player for checking playback, individual frames, and backgrounds. See the
[animated oil lamp example](docs/tools.md#animated-oil-lamp-example) for a complete modeling recipe.
Clients without vision can call `inspect_sprite` for a palette-index text grid, color descriptions,
cluster metrics, and comparisons between render jobs. Source-derived palettes are used by default
so supersampled colors remain distinct instead of turning into muddy downscale averages.

Exports default to 16×16 pixels and four cardinal views at 5 fps. Tile dimensions express small,
tall, and wide objects; explicit pixel dimensions can override them. An optional
[pixel-agents package](docs/tools.md#pixel-agents-furniture-package) provides ready-to-install
furniture manifests and PNGs for its fixed-rate, agent-activated animations, alongside
[character](docs/tools.md#pixel-agents-character-package) exports for pixel-index's custom-asset
API. The preview compares
the final sprites with genuine higher-resolution renders and highlights the game's resolution.
[Named appearance states](docs/tools.md#named-appearance-states), such as empty/partial/full rain
barrels, share one camera and palette and automatically get a combined HTML player and furniture ZIP.

The AI lives in your MCP client. It interprets reference images, writes Blender Python, and calls
`execute_blender_python`. This service executes the code, saves `.blend` revisions, and renders
consistent views. No AI API key or image-to-3D service is required.

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
