# Pixel Art MCP: Python → strict TypeScript rewrite with a web IDE

## Context

`pixel-art-mcp` is a local, single-owner MCP server that lets an AI agent author "Pixel Agents"
pixel-art assets (furniture/character/pet) at native resolution and export installable
PNG/ZIP packages consumed by an external app ("pixel-index"). It was recently simplified by
removing an unused Blender dependency — the render pipeline is pure 2D pixel compositing
(named layered patches, last-writer-wins putpixel, no blending/antialiasing), and that PR's
whole point was trimming native/binary dependencies and Docker image size.

We are now rewriting the entire app from Python to **strict TypeScript**, as a **hard cutover**
(no Python/TS coexistence period; fresh data directory, no migration tooling). The schemas and
contracts — the Pydantic authoring/asset models and the pixel-index export contract — are the
most important thing to carry over faithfully, since they're both a wire contract with an
external system and, in the case of tool docstrings/Field descriptions, literally prompt text
an LLM agent reads. All 22 existing MCP tools are migrated. Two new tools are added: a
read-only Canvas/PixelArt API reference, and a script-editing tool that can create/replace a
project's render script but can never modify the protected Canvas/PixelArt core itself. A new
web server serves a CodeMirror-left / rendered-result-right IDE, backed by the same
job/revision model the MCP tools already use, so an agent and a human can work on the same
project and see the same result.

## Monorepo structure

pnpm workspaces, `tsc -b` project references (no Turborepo/Nx yet — keep tooling minimal,
matching the repo's existing bias against unnecessary dependencies).

```
pixel-art-mcp/
├── packages/
│   ├── schema/        # Zod port of authoring.py, models.py, assets.py (incl. verbatim prompt text)
│   ├── pixel-core/     # PROTECTED: Canvas/PixelArt port of pixel_art.py — its own package boundary
│   ├── imaging/        # features/pixels/asset_export/inspection/preview/context port
│   ├── storage/        # SQLite store (node:sqlite), records/jobs schema
│   ├── jobs/           # worker loop, process spawn/cancel, TS compile+run sandbox
│   ├── engine/         # what actually runs inside a job subprocess (port of engine/runner.py + render.py)
│   └── service/        # orchestration: port of projects/service.py + references.py + artifacts.py
├── apps/
│   ├── server/         # Fastify: MCP Streamable HTTP + parallel REST + serves apps/web
│   └── web/             # CodeMirror6 + render-pane SPA (Vite + React)
├── tools/
│   └── contracts-pixel-index/  # standalone Node/TS script, own package.json/deps — NOT in the main dep graph
├── contracts/
│   └── fixtures/        # golden fixture corpus generated once from the Python test suite (see Phase 1)
├── docs/
└── pnpm-workspace.yaml
```

`pixel-core` is its own package specifically so "cannot modify Canvas/PixelArt" becomes a real
package boundary (consumers only see its compiled `.d.ts`/`.js`), not a code-review convention.
`imaging` and `engine` depend on `pixel-core`; `jobs` never imports it directly — it only spawns
processes that do.

## Stack defaults (propose-and-confirm, per your "propose defaults" instruction)

| Concern                     | Choice                                                                                                      | Why                                                                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime                     | Node 22 LTS                                                                                                 | Matches existing Node 22 usage already in this repo's CI/scripts.                                                                                                                                                                        |
| MCP SDK                     | `@modelcontextprotocol/sdk`                                                                                 | Official TS SDK; `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined` reproduces today's `stateless_http=True`.                                                                                                          |
| Web framework               | Fastify + `fastify-type-provider-zod` + `@fastify/multipart`                                                | Needs multipart upload, raw req/res access for the MCP transport, and static hosting for `apps/web` — Fastify's schema-first async model fits "strict" better than Express; Hono's multipart/static story is less proven for this shape. |
| Schema/validation           | Zod                                                                                                         | `z.discriminatedUnion` maps directly onto `PixelEdits`; `.refine()`/`.superRefine()` map onto Pydantic's model/field validators.                                                                                                         |
| SQLite                      | `node:sqlite` (`DatabaseSync`), `better-sqlite3` as documented fallback                                     | Zero native deps (continues the Blender-removal trajectory); fully synchronous, which actually simplifies the transaction model (see Storage section).                                                                                   |
| Image encoding              | `pngjs` + a hand-rolled APNG muxer (for exact `disposal=0/blend=0` control) + `gifenc`/`omggif`             | Pure-JS/WASM, no native deps. **Flagged as the single highest fidelity-risk item in the plan** — needs a dedicated golden-image comparison pass (Phase 4).                                                                               |
| Editor                      | CodeMirror 6 + TS Language Service in a Web Worker (in-memory VFS with the script + `pixel-core`'s `.d.ts`) | Gives real strict-mode diagnostics/autocomplete client-side against the actual protected-core types — something the Python version never had.                                                                                            |
| Frontend                    | Vite + React                                                                                                | Two-pane app that will likely grow a status panel/log tail/conflict banner — enough state to justify a light framework. Least-constrained choice in this plan; easy to swap if preferred.                                                |
| Process cancellation        | `tree-kill` (SIGTERM → 2s grace → SIGKILL)                                                                  | Pure JS; ports `os.killpg` behavior, Linux/macOS first-class (matches today's POSIX-only `fcntl.flock` reality), Windows via Docker/WSL2 only.                                                                                           |
| Worker single-instance lock | `proper-lockfile`                                                                                           | mkdir-based with staleness detection — the closest pure-JS approximation of `flock`'s crash-safety property.                                                                                                                             |

## Core design decisions

**Script sandboxing (`execute_pixel_script` → `edit_pixel_script`).** Subprocess-per-job stays
the primary isolation boundary, matching today's model 1:1 — `vm`/`worker_threads` don't give
OS-level resource/crash isolation and the current docstring already tells agents scripts are
"trusted code with container filesystem/network access," which a real OS process naturally
provides. Flow: submitted TypeScript is written to a scratch dir → type-checked/compiled via the
TS Compiler API against an in-memory tsconfig (`strict: true`, ambient `scene`/`referenceImages`,
free `import { Canvas, PixelArt } from "@pixel-art-mcp/pixel-core"`) → compile diagnostics become
job failure/log output → on success, `spawn("node", [compiledEntry, requestPath], { detached: true })`
runs the compiled ES module, which must itself import Canvas/PixelArt and export a
`(scene, referenceImages) => void` function — nothing is implicitly available, matching today's
"a script must itself reference them" property, just via a real type-checked `import` instead of
`exec()` globals.

"Cannot modify Canvas/PixelArt" is enforced two ways:

1. **Tool level:** `edit_pixel_script`'s input schema has no path parameter at all — it only
   ever writes one fixed, server-owned path per project. There's no way to construct a request
   that touches `packages/pixel-core/**`.
2. **Runtime level:** `pixel-core` is a compiled, versioned dependency; even if a script did
   `Canvas.prototype.rect = () => {}`, that lives only in that job's OS process and dies with it
   — the next job gets a fresh `node` process and module cache. This is the same honest answer
   Python already gives ("new process per job, so mutations don't persist"), kept intact. On top
   of that, `pixel-core` freezes its exports at init (`Object.freeze(Canvas.prototype)`, etc.), so
   under ESM's implicit strict mode such a mutation throws immediately instead of silently
   succeeding — a free, independent second guarantee Python's dynamic classes never had.

**File model.** One render-script file per project (`projects/<id>/script.ts`), create-if-absent
then edit-in-place — not a multi-file workspace. No file tree needed in the CodeMirror UI.

**Storage.** Keep the current generic `records`/`jobs` JSON-blob schema (not typed tables) —
the shapes are governed by Zod at the application layer already, and typed tables would double
the maintenance surface for a single-owner JSON-document store. Add one improvement Python
didn't have: Zod `safeParse` on every read and write, so corruption is caught at the storage
boundary even though columns stay `TEXT`.

```sql
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, current_revision_id TEXT);
CREATE TABLE records (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX records_project ON records(project_id, kind);
CREATE TABLE jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), operation TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX jobs_queue ON jobs(status, created_at);
```

`node:sqlite`'s `DatabaseSync` is fully synchronous and Node is single-threaded, so the
`threading.RLock` Python needs for its reentrant-transaction guard becomes unnecessary — only
the **depth-counter** reentrancy guard needs porting (so `publish()` calling other store methods
that also "open a transaction" doesn't nest a real `BEGIN`). Invariant to preserve: transactions
stay short (single INSERT/UPDATE), since a slow synchronous write now blocks the whole event
loop. `fcntl.flock` on `worker.lock` is replaced by `proper-lockfile` (see stack table) — it's not
protecting the DB itself (SQLite's `BEGIN IMMEDIATE` already serializes that), it's protecting
the non-DB scratch-dir wipe-on-startup race.

**Web UI.** Poll-first (`GET /api/projects/:id/jobs/:jobId` every ~500ms, matching
`wait_for_job`'s semantics), with an SSE endpoint (`GET .../jobs/:jobId/events`) added as a
progressive enhancement over the same in-process job-update event emitter — no new data model,
just a push view of existing job data. An MCP agent and a human in the browser both call the
same `service.submitScript()` and share state through the **existing optimistic-concurrency
check** (`Store.publish()`'s 409 on stale `expected_revision_id`) — the web UI's "Save & Render"
just surfaces that 409 as a "changed elsewhere, reload?" banner rather than inventing a new
locking/presence system. `apps/web`'s build output is served from the same Fastify app/origin as
`/mcp` and `/api/*`, avoiding CORS, consistent with the existing local single-owner posture and
`allowed_hosts`/`allowed_origins` DNS-rebinding protection (ported as-is).

## New tools

**`get_pixel_engine_reference()`** — read-only, no `project_id` (it's a static API reference, not
per-project). Its `typeDeclarations` field is extracted from `pixel-core`'s own compiled `.d.ts`
output at server startup (the compiler's own artifact, not hand-transcribed prose, so it cannot
drift), plus hand-written `examples` that are unit-tested to actually type-check and produce a
valid `PixelArt`, plus hand-written `guidance` prose reviewed like `INSTRUCTIONS` is today.
Annotations: `readOnlyHint=true, destructiveHint=false, openWorldHint=false`.

**`edit_pixel_script(project_id, script, expected_revision_id)`** — returns a `Job`, same shape
and optimistic-concurrency semantics as today's `execute_pixel_script`. New behavior: the
script is strict TypeScript, compiled/type-checked before running (compile errors surface as
job failure/log output); it's file-based (creates `script.ts` if absent, else replaces it) and
is the exact same submission path the web UI's "Run" button uses. The read path ("what's the
current script") isn't new — it already exists via `get_project` → `revision.script_artifact_id`
→ `get_artifact`; no redundant read tool is added. Annotations match today's
`execute_pixel_script`: `readOnlyHint=false, destructiveHint=true, openWorldHint=true`. Docstring
should explicitly tell the agent to call `get_pixel_engine_reference` first, and that mutating
Canvas/PixelArt at runtime has no effect beyond that one job.

## Contract preservation strategy

Build a **golden fixture corpus** once, from the _current_ Python test suite: run the real
Pydantic models against their existing unit-test inputs and dump, per case, either the exact
`model_dump()` JSON (valid cases) or the exact `e.errors()` list (`msg`/`loc`/`type`, invalid
cases) into `contracts/fixtures/*.json`. A TS test suite then runs the same fixtures through the
Zod schemas and asserts byte-identical valid output and **identical error message strings**.
This is what turns "byte-identical wire shapes and error messages" from an aspiration into a
CI-enforced fact. Two disciplines this forces on every Zod schema: (1) every validator needs an
explicit `message:` matching Pydantic's wording verbatim (Zod's defaults don't match), and (2)
every field needs `.describe(...)` with the identical string as the Python `Field(description=...)`,
since that's the channel the MCP SDK's Zod→JSON-Schema conversion uses to surface it in
`inputSchema` — this is prompt text an agent reads, same verbatim-port discipline as
`INSTRUCTIONS` and tool docstrings.

`contracts/pixel_index/` (the live pixel-index schema-compatibility checker) ports to
`tools/contracts-pixel-index`: a standalone Node/TS script with its own `package.json`/deps
(`ajv` in place of `jsonschema`), same CLI invocation model, deliberately **not** part of the
main app's dependency graph — preserving today's isolation. `.github/workflows/contract-checks.yml`
is updated to invoke the Node script; the `vendor/pixel-index` submodule usage is untouched.

## Phased delivery plan

1. **Skeleton** — monorepo, strict base tsconfig, eslint(strict-type-checked)+prettier, CI
   skeleton, empty packages. Verify: `pnpm -r build && pnpm -r test` green.
2. **`packages/schema`** — authoring.py/models.py/assets.py port, incl. verbatim prompt strings.
   Verify: fixture-corpus contract tests (above) 100% pass.
3. **`packages/pixel-core`** — Canvas/PixelArt port with frozen-prototype hardening. Verify: port
   of `test_pixel_art.py`/drawing tests; package boundary established before anything else
   depends on importing it.
4. **`packages/storage` + `packages/jobs` skeleton** — `node:sqlite` store, reentrancy guard
   without a mutex, `proper-lockfile`, queue insert/claim/update/publish/recover, `tree-kill`
   process runner against a stub engine. Verify: port of storage/job tests; cancellation timing
   and crash-recovery asserted directly.
5. **`packages/engine` + `packages/imaging`** — runner/render, compositor, pixels
   (downscale/quantize/APNG/GIF/spritesheet), asset_export, inspection. Verify: golden-image
   comparison against Python-generated PNG/APNG/GIF for `examples/*`; inspection's exact-palette
   hard-fail behavior ported. **Highest fidelity risk in the plan.**
6. **`packages/service`** — references.py (SSRF-safe fetch, decompression-bomb guard, animated-
   image rejection), artifacts.py chunking, service.py orchestration. Verify: port of
   references tests — private-IP rejection across v4/v6, redirect-hop cap, no userinfo/non-443/
   fragment, pinned-IP-with-correct-Host/SNI. **Second-highest risk — deserves a dedicated spike**
   (undici custom `connect`/`lookup` for IP pinning has no drop-in equivalent).
7. **`apps/server`** — all 22 existing MCP tools + parallel REST routes, `INSTRUCTIONS` and every
   docstring ported verbatim (scripted diff-check against the Python source as a one-time
   migration gate). Verify: port of MCP/HTTP/artifact-delivery integration tests; manual pass
   with a real MCP client.
8. **New tools** — `get_pixel_engine_reference`, `edit_pixel_script`, TS-compile-in-subprocess
   sandbox. Verify: reference doc round-trips through a tested example; a deliberate
   `Canvas.prototype.rect = ...` mutation in one job proven not to leak into the next job
   (regression test).
9. **`apps/web`** — CodeMirror6 + in-browser TS worker diagnostics, SSE progress, render pane,
   409 conflict banner. Verify: Playwright e2e — edit → run → see updated render; simulated
   concurrent-edit conflict flow.
10. **`tools/contracts-pixel-index`** port + CI workflow update. Verify: contract-checks-style CI
    job green against the vendored pixel-index schema.
11. **Cutover** — single-Node Docker image (drop the Python/uv base entirely), perf pass, docs
    port, remove the Python source tree.

## Critical files (highest reference value during the port)

- `src/pixel_art_mcp/pixel_art.py` — the protected Canvas/PixelArt core
- `src/pixel_art_mcp/authoring.py` — versioned pixel authoring contract + edit operations
- `src/pixel_art_mcp/models.py` — AssetSpec/RenderOptions/Job/etc., all cross-field validators
- `src/pixel_art_mcp/assets.py` — native canvas sizing math + verbatim `get_asset_profile` prompt content
- `src/pixel_art_mcp/mcp/server.py` — all 22 tools, `INSTRUCTIONS`, per-tool docstrings (verbatim port source)
- `src/pixel_art_mcp/storage/store.py` — SQLite schema, transaction/queue mechanics
- `src/pixel_art_mcp/jobs/worker.py` + `jobs/process.py` — job lifecycle, subprocess spawn/cancel, progress protocol
- `src/pixel_art_mcp/engine/runner.py` + `engine/render.py` — script exec model, render manifest shape
- `src/pixel_art_mcp/imaging/*.py` — compositing/quantization/packaging pipeline
- `src/pixel_art_mcp/projects/references.py` + `projects/artifacts.py` — SSRF-safe fetch, chunked delivery
- `contracts/pixel_index/*.py` — the external contract-compatibility checker to port

## Verification (end-to-end, once implementation starts)

- Each phase's own unit/integration test port (listed above) must pass before moving on.
- The fixture-corpus contract tests (Phase 2) are the single most important gate — they're what
  makes "schemas and contracts are important, re-use those parts" concretely checkable rather
  than a vibe.
- After Phase 7 (MCP tool parity), connect a real MCP client (e.g. Claude Code / Claude Desktop)
  to the running TS server and walk through the same example workflow the Python
  `scripts/generate_examples.py` exercises: create project → configure asset → write_pixel_art
  → render_asset → inspect_asset/inspect_sprite → get_asset_preview, for at least one asset of
  each kind (furniture/character/pet).
- After Phase 8, exercise `edit_pixel_script` end-to-end including a deliberate compile-error
  script (verify it surfaces as a job failure with useful diagnostics, not a crash) and the
  Canvas/PixelArt-mutation-doesn't-leak regression test.
- After Phase 9, manually drive the web UI against a project an MCP client is simultaneously
  editing, to confirm the 409/conflict-banner flow actually surfaces real concurrent edits.
- After Phase 10, run the ported `tools/contracts-pixel-index` checker against the real
  staging/production pixel-index environments (same live-check posture as today) before cutover.
