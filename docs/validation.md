# Implementation validation

The implementation covers the agreed single-owner local service: full Blender Python creation
and modification, reference uploads, saved revisions, asynchronous jobs, multi-angle views,
transform animation, and PNG/JSON/ZIP sprite exports. No server-side AI provider is required.
Remote ChatGPT connectivity, authentication, and automatic image-to-3D reconstruction are deferred.

## Checks in the implementation environment

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

## Remaining release check

On a Docker-capable Linux x86-64 host with network access:

```sh
uv sync --frozen
uv run --frozen pytest -m 'not blender and not e2e'
docker compose up --build --wait --wait-timeout 120
PIXEL_E2E_URL=http://localhost:8000 uv run --frozen pytest -m e2e
```

The checked-in Docker CI job runs this path. It creates a chair, modifies its backrest/material,
renders a preview and three distinct directions, downloads the ZIP, and exports a short animated
sheet. This check is necessary before claiming the Blender rendering pipeline is runtime-verified.
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
