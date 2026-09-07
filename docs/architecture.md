# Architecture

For the product goal—turning prompts into sprite sheets with rotation views and animation—and
diagrams of the MCP integration and rendering pipeline, start with the [project overview](overview.md).

One owner, one workspace volume, one service process, one active Blender job. FastAPI and the
official MCP SDK share an ASGI application. SQLite is the source of truth for project pointers,
references, artifact records, and the persistent FIFO queue. Saved `.blend` files are the source
of truth for model geometry, materials, and animation. There is no server-side AI model.

The application uses Python 3.12; Blender runs its own bundled Python. The bridge sends a JSON
request to a fresh background process. A repository-owned runner loads the input `.blend`,
executes user Python or performs an export, and writes a JSON result and files. No `bpy` dependency
is imported by the application. Script syntax must also be supported by Blender's bundled Python.

## Workflow and consistency

1. Create a project and upload a reference. The agent receives a thumbnail as MCP image content
   and models the visible object using `bpy`.
2. Submit Python with the current expected revision (null for the first model).
3. The worker rechecks that revision when the job starts. Concurrent queued edits based on the
   same revision cannot silently replace one another.
4. A successful script packs image resources and saves a new `.blend`, script, and scene summary.
   Publication of the revision pointer, artifact records, and successful job state uses one SQLite
   transaction after the new files are moved into persistent storage.
5. Preview/export jobs capture a revision at submission and never change that saved scene.

Exceptions and cancellations discard the job's unpublished output. Submitted scripts and bounded
logs remain in the job record for diagnosis. Process groups are terminated on timeout/cancellation.
An exclusive file lock prevents two application instances sharing a database. On restart, running
jobs become failed and disposable scratch files are cleared; queued jobs remain available.
There is no automatic replay of scripts. A crash between file publication and database commit may
leave unreferenced files; they are not exposed as artifacts. Retention is explicit: there is no
scheduled deletion of projects, references, revisions, or completed exports.

## Pixel export

Default framing is orthographic, with Z up, 0° viewing from negative Y, and positive angles orbiting
around +Z. Bounds are collected from evaluated geometry and instances over every requested frame
and view, then combined in camera coordinates. One scale and pivot are used for the entire job.
An object that bobs retains its screen-space movement. Studio lighting follows the export camera;
`lighting="scene"` uses saved scene lights and world instead.
Legacy curves, text, surfaces, and metaballs are bounded from their evaluated meshes. Blender can
expose both a curve object and its generated mesh instance; the curve's own evaluated bounding box
may include control geometry and inflate framing. Per-object mesh bounds are cached within each
frame and transformed separately for every instance.

Canvas dimensions default to one 16×16 tile; integer tile counts describe taller/wider objects.
Explicit width/height override the corresponding tile dimensions, even for non-multiples of 16.
The default directions are front/right/back/left (0/90/180/270°), and playback defaults to 5 fps.
CPU Cycles renders RGBA PNGs at 4x target size by default. Pillow downsamples coverage with BOX
filtering and thresholds alpha. Crisp mode (the default) computes one palette from visible
supersampled source colors across every frame, then maps the averaged target pixels back onto those
colors without dithering. This prevents the fitted palette itself from containing muddy colors that
exist only because two source colors were averaged. Average mode retains the earlier behavior of
fitting after downscaling, and a custom palette bypasses fitting. Transparent pixels have zero RGB.
The export preview uses nearest-neighbor scaling.

`inspect_sprite` converts one exported frame back into text for clients without vision support. It
reports the palette with approximate color names, a two-character palette-index grid, occupied
bounds, color component and singleton counts, longest runs, and low-contrast adjacent colors. It can
include the matching inspection and pixel deltas from a second render job. This keeps artistic
decisions in the agent workflow while giving a completion-only agent exact evidence instead of an
unusable image content block.

Preview jobs accept the full render options and run the same pipeline as final exports, so matching
options preserve framing, palette, and lighting. Pixel conversion and artifact packing are separate:
`pack_sprites` can package already converted RGBA frames without quantizing them again. Every export
includes a self-contained HTML player with embedded final and original supersampled sheets.
They are shown at equal display sizes with the export/game resolution highlighted. Raw high-res
comparisons are saved separately, not manufactured by enlarging the low-res sprites. With
supersampling=1 the player omits the higher-resolution panel. Animated exports also include one
lossless APNG loop per direction. APNG frames replace changed pixels (including transparency) to
avoid trails, and use the same floating-point frame duration as the JSON metadata. The encoder may
combine identical consecutive frames while preserving their total hold time. The player uses source
frame indices from the sheet, so every sampled frame remains individually inspectable.

`imaging/pixel_agents.py` optionally packages the existing pixel-agents furniture contract:
rotation groups containing static assets, or state groups containing an off PNG and an on animation
group. Leaf dimensions describe native PNG pixels; footprint metadata describes occupied floor
tiles independently. An explicit off source frame is rendered with the same camera and shared
palette as the on sequence, but kept outside the animation sheet/APNGs. pixel-agents hardcodes
0.2 seconds per furniture frame and only advances on-state animation near working agents; the
schema, validator, and player disclose these constraints. The target ZIP contains only its
manifest/PNG files under `assets/furniture/<ID>/`; the full ZIP includes this package plus previews
and generic sprite outputs. No target application changes or per-asset timing fields are needed.

The sheet uses rows for view directions in requested order and columns for sampled animation
frames in ascending order. `fps` is the playback rate of exported frames; `frame_step` selects
source frames. JSON includes rectangles, floating-point pixel pivots measured from the top-left,
frame durations, palette, render settings, Blender version, and scene revision. Custom palettes
may contain up to 255 opaque colors; transparency is separate. Reproducibility assumes the pinned
Blender/runtime image; pixel-identical rendering across different CPU architectures is not promised.

## Runtime and boundaries

The default Compose setup publishes only 127.0.0.1:8000, uses a named volume, drops capabilities,
and supplies no host credentials or Docker socket. Python scripts are trusted and can access all
writable container data and the network; project revisions protect ordinary editing failures, not
malicious scripts. HTTP host/origin checks reject browser cross-origin access. Reference URL
downloads allow only public HTTPS addresses, pin DNS results, revalidate redirects, and have size
and time limits. Image uploads are validated before normalization and storage.

HTTP request sizes, decoded image pixels, script size, queue length, total render frames, sheet
pixels, Blender threads, logs, and timeouts are bounded. Liveness is `/health/live`; readiness also
requires an available Blender executable and worker. Logs identify jobs without printing uploaded
content or signed reference URLs. Model and renderer versions are exposed by `get_capabilities`.
The render frame limit includes any additional off pose. The sheet pixel limit also applies to
the total supersampled comparison pixels (including the off pose), bounding in-memory sheet size;
large jobs can reduce supersampling, dimensions, directions, or frames.

The implementation pins MCP SDK 1.29.1 instead of the planned v2 because v2 could not be installed
in the offline implementation environment. MCP-specific code lives in `mcp/server.py`; domain,
storage, image processing, and Blender code do not depend on the SDK. API contracts use
`schema_version=1`; SQLite uses `PRAGMA user_version=1` and rejects unknown database versions.

## Structure

`mcp/` defines agent-facing tools. `api/` provides file transfer and health endpoints. `projects/`
contains application operations and reference ingestion. `jobs/` owns scheduling and subprocess
lifecycle. `blender/runner.py` runs inside Blender. `imaging/` implements pixel processing and
exports. `storage/` handles SQLite transactions and path resolution. Examples demonstrate creation,
modification, and transform animation; tests cover these boundaries independently and end to end.
