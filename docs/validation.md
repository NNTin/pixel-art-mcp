# Implementation validation

The implementation covers the agreed single-owner local service: full Blender Python creation
and modification, reference uploads, saved revisions, asynchronous jobs, multi-angle views,
transform animation, and PNG/JSON/ZIP sprite exports. No server-side AI provider is required.
Remote ChatGPT connectivity, authentication, and automatic image-to-3D reconstruction are deferred.

## Tile sizing and pixel-agents validation (2026-09-06)

- The rebuilt Docker service advertises 16px tile dimensions, explicit width/height overrides,
  four cardinal directions, 5 fps, and the optional pixel-agents furniture schema through MCP.
  Schema/validation tests cover small, tall, wide, large, and non-tile-aligned overrides, invalid
  target settings, and render limits including the extra off pose and supersampled comparisons.
- 55 unit/integration tests and three Docker end-to-end tests passed. The new Docker test models
  the lamp and exports a 16×32 canvas with a separate 1×1 floor footprint, four directions,
  off/on states, 200 ms frame durations, high-resolution references, and the nested installable ZIP.
  Ruff lint/formatting and strict mypy passed.
- The oil lamp was regenerated through the rebuilt MCP service: 16×16 game sprites, 64×64 source
  references, four directions, eight on-state samples at 5 fps, and one extinguished pose per
  direction. The installable package contains 36 PNGs and its furniture manifest. At this smaller
  resolution, some flame samples become identical (8/6/7/8 distinct frames by direction); APNG
  hold times still reproduce all eight samples correctly at 5 fps.
- `tmp/oil-lamp/` contains only the downloaded `sprites.zip` and its extracted contents, including
  `pixel-agents.zip`. Every extracted file was checked byte-for-byte against the server ZIP, with
  no extra files. The previous 64px export is preserved in `tmp/oil-lamp-64px-20260906/`.
- Read-only compatibility checks imported the existing pixel-agents `buildFurnitureCatalog`,
  `decodeAllFurniture`, and frontend catalog helpers. All 36 PNGs decoded; the manifest produced
  one editor item, four orientations, off/on state pairs, and eight ordered on frames per direction.
  Both on/off rotation cycles work. No files in pixel-agents were changed or installed.
- The target's `FURNITURE_ANIM_INTERVAL_SEC` is 0.2 seconds (fixed 5 fps). Its engine only selects
  animation frames when a placed off-state item overlaps a working agent's auto-on area. The
  export schema, docs, and preview disclose that this is not always-on animation.
- Headless Chromium verified the downloaded offline player: native 16×16 and 64×64 canvases at
  equal display sizes, gold game-resolution highlights, off/on switching, scrubbing, zoom,
  backgrounds, reduced-motion behavior, and play/pause without JavaScript errors.

## Earlier 64px oil lamp workflow validation (2026-09-06)

- The Docker service was rebuilt and is healthy with the preview, animation, and framing changes.
  The connected MCP modeled `examples/oil_lamp.py` in Blender 4.5.13 LTS and rendered 64 transparent
  64×64 sprites: eight viewing angles and eight flame poses at 12 fps.
- The rebuilt server generated the PNGs, eight APNG loops, metadata, self-contained HTML player,
  and ZIP. `tmp/oil-lamp/` contains only that downloaded ZIP and its extracted contents. Every
  extracted file was checked byte-for-byte against the ZIP, with no extra files. All directions
  are distinct, every direction has eight distinct flame frames, pivots stay constant, and the
  decoded APNG pixels and timing match the individual PNGs.
- 39 unit/integration tests passed with the normal pytest command, plus two Docker end-to-end
  tests. The Docker tests verify APNG downloads/MIME/dimensions/pixels, player publication, and
  identical preview/final pixels when options match. A curve-framing regression checks both the
  orthographic scale and actual rendered coverage for a small beveled ring.
- The lamp exposed inflated bounds for evaluated legacy curves: Blender exposed control/fallback
  bounds as well as the generated mesh. The renderer now bounds the visible converted mesh and
  caches those bounds per object within each frame. The lamp was rerendered with this fix.
- Headless Chromium verified the downloaded player: eight direction views, play/pause, scrubbing,
  changed frame pixels, zoom, backgrounds, and reduced-motion behavior. Ruff, formatting, mypy,
  wheel packaging (including the HTML template), and Compose configuration validation passed.

## Initial implementation checks (historical)

- 35 tests passed; two tests requiring real Blender/a running Docker service were skipped.
- Ruff lint and formatting, strict mypy checks, and lockfile consistency passed.
- The application wheel built successfully and installed without dependencies from the wheel.
- `docker compose config --quiet` passed. Docker daemon access was denied; no image build or
  actual Blender rendering was performed here.

The local tests cover MCP initialization and tool schemas, image-content responses, uploads,
script jobs, saved revisions, stale-edit conflicts, failed edits, cancellation, descendant
termination, bounded logs/timeouts, restart recovery, transactional publication, image validation,
public HTTPS URL validation, shared palettes, transparency, sheet metadata, and ZIP contents.
Job lifecycle tests use an explicitly identified fake Blender subprocess, not a geometry renderer.
HTTP integration tests exercise serialized MCP messages through the ASGI app in-process.

This sandbox intermittently misses asyncio I/O wakeups, also reproduced by a standalone stdlib
subprocess test. Tests were run with a temporary pytest loop factory that caps selector waits at
1 ms, including executor teardown. The workaround changes no application operations, is not part
of this repository, and is not required/configured in CI. Dependencies were installed from cached
wheels because the shell could not access the package registry. Mypy ran from the available Python
3.13 toolchain against the application's Python 3.12 environment. Normal verification commands
are in the README and CI workflow.

## Repeating the Docker release check

On a Docker-capable Linux x86-64 host with network access:

```sh
uv sync --frozen
uv run --frozen pytest -m 'not blender and not e2e'
docker compose up --build --wait --wait-timeout 120
PIXEL_E2E_URL=http://localhost:8000 uv run --frozen pytest -m e2e
```

The checked-in Docker CI job runs this path. It creates a chair, modifies its backrest/material,
renders a preview and three distinct directions, downloads the ZIP, and exports a short animated
sheet. It now also verifies directional APNGs, the offline player, preview/export parity, and curve
framing. This check passed on the host during the oil lamp workflow above.
The image pins a patch release from the official [Blender 4.5 release archive](https://download.blender.org/release/Blender4.5/)
and verifies its archive against the published SHA-256 list at build time.

## Reviewed adjustments

- MCP SDK 1.29.1 replaces the originally proposed v2 because a complete v2 distribution was
  unavailable for offline verification. The MCP adapter is separate from domain/rendering code.
- The review tightened native loopback binding, Compose host/origin configuration, cancellation
  cleanup for image threads, renderer readiness validation, and per-frame export-camera selection.
- Supersampled frames are decoded one at a time before fitting the shared palette, limiting peak
  image-processing memory. Actual Blender scene complexity remains controlled by container limits
  and job timeouts, not by a geometry quota or a secure Python sandbox.
