# Rendering pipeline

This describes how a `write_pixel_art` call turns into published PNG/ZIP artifacts: the
process boundary between application Python and Blender's bundled Python, and what
compositing does today. For the MCP-agent-facing workflow and contract, see
[overview](overview.md); for consistency/transaction guarantees, see
[architecture](architecture.md).

## End-to-end flow

Only one step ever runs Blender's `bpy`: the subprocess spawned in step 3. Everything else,
including all pixel compositing, is application Python (Pillow/stdlib).

```mermaid
sequenceDiagram
    participant Agent
    participant Service as projects/service.py
    participant Worker as jobs/worker.py
    participant Blender as blender subprocess (bpy)
    participant Export as imaging/asset_export.py

    Agent->>Service: configure_asset
    Service->>Service: resolve_asset -> per-angle canvas layouts
    Agent->>Service: write_pixel_art(PixelDefinition)
    Service->>Service: validate + PixelDefinition.to_art(layouts)
    Service->>Worker: submit_script(save script)
    Worker->>Blender: request.json (script, input_blend, options)
    Blender->>Blender: exec script, then art.save(scene)
    Blender->>Blender: PixelArt.load(scene).validate_target(...)
    Blender-->>Worker: scene.blend + result.json
    Worker->>Worker: publish(new revision, artifacts) [1 SQLite txn]
    Agent->>Service: render_asset
    Service->>Worker: submit_render (current revision)
    Worker->>Blender: request.json (render options)
    Blender->>Blender: game_renderer.native_render(art): no camera, no Cycles,
    Blender->>Blender: blank transparent PNG per view/frame
    Blender-->>Worker: rendered PNGs + manifest (result.json)
    Worker->>Export: export_asset(manifest, sources)
    Export->>Export: composite_features (paint authored pixels onto blank canvas)
    Export->>Export: spritesheet, previews, package ZIP, asset_report
    Worker->>Worker: publish(artifacts) [1 SQLite txn]
    Agent->>Service: inspect_asset / inspect_sprite / get_asset_preview
```

The only data that crosses the `bpy` process boundary is `request.json` (script/render options,
`input_blend`, reference images) in and `result.json` (scene summary or render manifest) out —
the application process never imports `bpy` (`docs/architecture.md`).

## Native rendering (`blender/game_renderer.py`)

Every asset renders through `game_renderer.native_render`: no camera, no Cycles, and no
resampling filter. Blender's own "render" step for an asset is an empty transparent image per
view/frame; every visible pixel comes from `imaging/features.py`'s `composite_features` painting
the authored patches directly onto that blank canvas (`image.putpixel(...)` with the exact
`#RRGGBB` from the palette). `execute_blender_python` can still build arbitrary Blender geometry
for scripting convenience (e.g. computing a `PixelArt` definition with a Python loop instead of a
static JSON payload — see `examples/chair.py`), but that geometry has no effect on the render:
only the saved `pixel_art` definition is ever exported.

## Job/worker/revision model

A single worker claims one job at a time. Only `"script"` jobs (from `write_pixel_art` or
`execute_blender_python`) create a new Blender revision; render jobs reuse the current revision
and only produce new artifacts. Publication — the new revision pointer (if any), artifacts, and
job state — happens in one SQLite transaction after files move into persistent storage, so a
failed or cancelled job never leaves partial output visible. See [architecture](architecture.md)
for the full consistency and concurrency guarantees this relies on.
