# Pixel Art MCP

A local MCP service for creating **Pixel Agents furniture, characters, and pets** at the
consumer's native pixel resolution. Author recognizable shapes on the final grid, save named
layers and animation poses in scene revisions, and export installable packages.

Implemented as a strict TypeScript pnpm monorepo (`packages/`, `apps/`, `tools/`) with a web IDE
(CodeMirror editor + live render preview) alongside the MCP tools — see
[`docs/typescript-rewrite.md`](docs/typescript-rewrite.md) for the rewrite's design and phased
delivery plan.

`write_pixel_art` accepts a typed pixel definition and runs the mandatory `PixelArt` and `Canvas`
helpers on the server. No client-side imports or filesystem tools are needed. Important features
are designed explicitly, not recovered by adding colors or shrinking a detailed model. Authored
pixels bypass resampling entirely: every visible pixel is painted exactly as drawn, never
antialiased, dithered or requantized. Feature diagnostics check visibility, connectivity and
clipping, while offline previews support the necessary visual review.

Use `get_asset_profile` → `create_project` → `configure_asset` → `write_pixel_art` → `wait_for_job`
→ `render_asset` → `wait_for_job` → `inspect_asset` / `inspect_sprite` / `get_asset_preview`.
Use `get_pixel_art` to retrieve and revise the complete source. Profiles include full JSON starters
and compact `drawing` examples: numeric rectangles, inclusive lines, small stamps, repetition,
and mirroring, all rasterized by the mandatory helpers. Begin with a base in every view and
add features using `edit_pixel_art(set_layer)` instead of repeatedly replacing the whole asset.
Custom furniture uses occupied `ground_width`/`ground_depth` plus nonblocking `background_tiles`;
canvases are derived automatically at 16 pixels per tile. Profiles include specifications
and tool-call examples inline. [Game asset profiles](docs/game-assets.md) give furniture,
characters, and pets readable sizes, stable placement, shared palettes, and the consumer's actual
pose sequences. Every render produces an installable package, exact pixel inspection, and offline
context previews. Named furniture clips become selectable variants such as empty/partial/full barrels.

The development webview harness checks generated packages against a read-only Pixel Agents checkout;
Node and Chromium are not production dependencies.

The AI lives in your MCP client. It interprets reference images and authors exact native pixels.
`execute_pixel_script` remains available for computing a pixel-art definition with strict
TypeScript instead of a static JSON payload — call `get_pixel_engine_reference` first for the
`Canvas`/`PixelArt` API it runs against. Generic `render_preview` and `render_sprites` tools have
been removed. Every successful write saves an editable scene revision; failures preserve the prior
revision. No AI API key, automatic semantic redraw, or image-to-3D service is involved.

After upgrading, refresh cached client tool lists. `get_capabilities` reports
`authoring_contract_version: 1` and `pixel_authoring_required: true`.

Read [what we are building](docs/overview.md) for the project goals and Mermaid diagrams of the
MCP integration and rendering pipeline.

## Start

```sh
docker compose up --build -d
```

Connect a local MCP client using Streamable HTTP at **http://localhost:8000/mcp**.
Open **http://localhost:8000/** for the web IDE (CodeMirror editor + live render preview); the
same origin also serves the REST API (`/projects`, `/artifacts/:artifact_id`, ...) used for HTTP
uploads and downloads. The service has no authentication and is published on host loopback only.
The container image targets Linux x86-64 and runs pure Node; no GPU or display is required.

See [client setup](docs/client-setup.md), [tool usage](docs/tools.md), and
[architecture](docs/architecture.md) for the workflow and operating constraints.
See [rendering pipeline](docs/rendering-pipeline.md) for how a render actually executes: the
script subprocess boundary and native pixel compositing.
See [validation status](docs/validation.md) for the completed Docker rendering and playback checks.
See [contract testing](docs/contract-testing.md) for how the pixel-agents/character/pet exports
are checked live against pixel-index's real staging and production APIs, and by a real upload
to a pixel-index instance this repo stands up itself.

## Development

Install Node 22 and pnpm, then:

```sh
pnpm install --frozen-lockfile
pnpm -r build
pnpm lint
pnpm format
pnpm test
node apps/server/dist/index.js
```

Dependencies are locked in `pnpm-lock.yaml`. This is a pnpm workspace (`tsc -b` project
references) — `packages/` hold the schema/pixel-core/imaging/storage/jobs/engine/service layers,
`apps/server` is the Fastify MCP + REST + web-IDE host, `apps/web` is the CodeMirror IDE frontend,
and `tools/` holds standalone CI utilities (contract checker, example generator) kept out of the
main dependency graph. See [`docs/typescript-rewrite.md`](docs/typescript-rewrite.md) for the
full design.

## Data and execution

The named `pixel-data` volume stores the SQLite database, references, scripts, revisions, and
exports. Ordinary container restarts retain them. Back up the volume while the service is stopped.
Interrupted jobs become failed; queued jobs resume. Scripts are never automatically retried.

Submitted TypeScript is trusted code with access to the container's writable workspace, including
other projects, and outbound networking; it runs in its own OS subprocess and cannot modify the
protected `Canvas`/`PixelArt` core beyond that one job (see
[`docs/typescript-rewrite.md`](docs/typescript-rewrite.md)). The default container is non-root,
has a read-only root filesystem, and mounts no host directories or Docker socket. This deployment
is for one local owner, not for public or mutually untrusted users. ChatGPT on the web cannot
connect directly to your localhost endpoint; remote networking and authentication are outside
this release.
