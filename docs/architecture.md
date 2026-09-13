# Architecture

One owner, one workspace volume, one service process, one active Blender job. FastAPI and the
official MCP SDK share an ASGI application. SQLite stores project pointers, target configurations,
artifacts and the FIFO queue. Blender revisions store native pixel definitions plus optional
geometry. No server-side AI model is involved.

## Public contract

`authoring.py` defines the strict versioned Pydantic pixel document. `write_pixel_art` takes the
complete document and an expected revision; `get_pixel_art` returns editable source and its
revision. The server derives view sizes from the current target configuration. The MCP schema
documents fields, bounds, overrides and replacement semantics. `get_asset_profile` includes a
complete JSON starter and ordered tool-call examples inline, not a reference to inaccessible files.

The source definition has version 1; capabilities expose `authoring_contract_version=1` and
`pixel_authoring_required=true`. Generic MCP rendering has been removed. Every public render
requires a target configuration and a valid pixel definition. Geometry scripts remain an advanced
preparation/editing path, not a geometry-only rendering fallback.

`pixel_art.py` is the stdlib-only Canvas/PixelArt helper shared with Blender. The typed write
validates and converts its document through these helpers, generates a server-owned save script,
then uses the existing script job/revision transaction. No second mutable source store is added.

## Consistency

1. Configure the asset, then write source with the current expected revision, null only initially.
2. Submission captures configuration and revision. The worker rechecks the revision when it starts.
3. Blender loads the previous scene, executes the write, validates canvas/pose/palette/anchor
   requirements and saves the result. The application validates the returned definition again.
4. Publication of revision pointer, artifacts and successful job state is one SQLite transaction
   after files move into persistent storage. Concurrent queued edits cannot silently overwrite.
5. Render submission captures the selected revision and current configuration. Both Blender and
   exporter require pixel art; reconfiguring a target can require rewriting the source.

Advanced Python edits preserve existing definitions. Removing or invalidating required source
fails the job. This protects normal editing mistakes, not malicious trusted Python.

Failed jobs and cancellation discard unpublished outputs. Process groups terminate on timeout
or cancellation. An exclusive file lock prevents multiple application instances sharing a DB.
On restart, running jobs fail and scratch files are cleared; queued jobs remain. Scripts are
never automatically replayed. Unreferenced files from a interrupted publication are not exposed
as artifacts. There is no scheduled retention/deletion.

## Rendering and inspection

`assets.py` resolves immutable target specifications into native canvases, clips and package
settings. `blender/game_renderer.py` handles two paths:

- Native: resolve exact patches for each native view/frame, bypassing Cycles and quantization.
- Hybrid: evaluate geometry bounds across all frames/views, fit one stable scale, render broad
  colors, and project optional named-object origins for integer-snapped pixel overlays.

`imaging/asset_export.py` composites required layers after any geometry conversion. The authored
palette is authoritative throughout. `features.py` measures final ownership, visibility,
clipping and connectivity. Structural invalidity and empty output fail; artistic findings remain
advisory and `visual_review_required` is always true.

`inspect_sprite` exposes an exact indexed grid and feature metrics, optionally compared with
another job. `preview.py` selects a clip, consumer direction and frame, including mirrored left
and mapped pet idle, and returns an inline nearest-neighbor PNG. Context is schematic and marked
approximate. `get_artifact` returns bounded PNG/JSON/Python/text directly in MCP. ZIP and Blender
downloads remain available for human use.

The server-generated offline player also supports playback and placement review. Node and
Chromium are development-only dependencies. `scripts/check_webview.mjs` reads the consumer
checkout without editing it and validates actual package decoding and rendering.

## Runtime boundaries

Application Python is 3.12; Blender uses its bundled Python. A JSON request bridges them in a
fresh background process. The application never imports bpy. Default Compose exposes only
loopback, uses a named volume and read-only root, and mounts no host credentials or Docker socket.

Submitted Python is trusted code with access to writable container data and outbound networking.
This is a single-owner service, not multi-tenant isolation. Host/origin checks reject browser
cross-origin access. Reference downloads require public HTTPS, pinned DNS, redirect revalidation,
and byte/time limits. Uploaded images are validated and normalized.

Pixel source cells, layers, poses, script bytes, request sizes, queue length, frames, sheet pixels,
threads, logs and timeouts are bounded. Preview output is capped at 4194304 pixels; artifact inline
content at 1 MiB. Limits are discoverable. Readiness requires Blender and a running worker.
Existing records need no migration; authoring versioning is separate from SQLite's schema version.

## Verification

Unit tests cover schema validation, helper target rules, package pixels and preview mapping.
Integration tests exercise MCP schemas, source retrieval, replacement, queued conflicts,
configuration snapshots and failed-edit rollback. Real-Blender tests cover evaluated geometry.
Cold-client Docker tests use only MCP tool discovery and inline profile examples to create, edit,
render and inspect all three asset kinds, without reading repository examples or HTTP artifacts.
Python examples additionally regress advanced helper usage and hybrid geometry.
