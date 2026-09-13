# Rendering pipeline

This describes how a `write_pixel_art` call turns into published PNG/ZIP artifacts: the
process boundary between application Python and Blender's bundled Python, the native/hybrid
render split, and what compositing does today now that downscaling is a from-scratch
implementation rather than a vendored library. For the MCP-agent-facing workflow and contract,
see [overview](overview.md); for consistency/transaction guarantees, see
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
    Blender->>Blender: game_renderer.render_game(art)
    Blender-->>Worker: rendered PNGs + manifest (result.json)
    Worker->>Export: export_asset(manifest, sources)
    Export->>Export: pixelate() if hybrid, else blank canvas
    Export->>Export: composite_features (paint authored pixels)
    Export->>Export: spritesheet, previews, package ZIP, asset_report
    Worker->>Worker: publish(artifacts) [1 SQLite txn]
    Agent->>Service: inspect_asset / inspect_sprite / get_asset_preview
```

The only data that crosses the `bpy` process boundary is `request.json` (script/render options,
`input_blend`, reference images) in and `result.json` (scene summary or render manifest) out —
the application process never imports `bpy` (`docs/architecture.md`).

## Native vs. hybrid: one flag, two branch points

`PixelDefinition.base` (`Literal["native", "render"]`, set by the agent in `authoring.py`) is
checked at two separate points that must agree, and both converge back on the same pixel-painting
step:

```mermaid
flowchart TD
    Base["art.base"] -->|native| SkipCycles["game_renderer.native_render:\nno camera, no Cycles,\nsave blank transparent PNG per frame"]
    Base -->|render| Hybrid["game_renderer: fit camera to evaluated\ngeometry bounds across all frames,\nbpy.ops.render.render per view/frame"]
    Hybrid --> Anchor["project named anchor origins ->\noffset that pose's patch x/y"]

    SkipCycles --> Manifest["render manifest: pixel_layers\nordered pose list per angle/frame"]
    Anchor --> Manifest

    Manifest --> ExportBase{"art.base\n(asset_export.py)"}
    ExportBase -->|native| Blank["blank RGBA canvas, no resampling"]
    ExportBase -->|render| Pixelate["pixelate(): quantize + downscale\nthe broad Cycles colors"]

    Blank --> Composite["composite_features:\npaint authored patches pixel-by-pixel\nfrom the exact palette"]
    Pixelate --> Composite
    Composite --> Rest["spritesheet, .apng, preview.png/gif,\nconsumer package ZIP, asset_report"]
```

Native mode never touches Cycles or any resampling filter: the "render" Blender does for a native
asset is an empty image, and every visible pixel comes from `composite_features` painting the
authored patches directly (`image.putpixel(...)` with the exact `#RRGGBB` from the palette).
Hybrid mode adds one more step before that: its broad, correctly-lit Cycles colors are downscaled
and quantized by `pixelate()` first, then the same authored patches are painted on top — so
identifying detail is still never resampled, only the broad geometry underneath it is.

## Downscaling (`imaging/pixels.py`)

Hybrid mode's Cycles output is rendered supersampled and needs to come down to the target pixel
grid. This used to call into the vendored `pixel-art-fixer` submodule's `two_stage_pack`; that
submodule has been removed and `pixelate()` is now a self-contained reimplementation of the same
idea, selected by `downscale_mode`:

```mermaid
flowchart LR
    Source["Supersampled Cycles render"] --> Mode{downscale_mode}
    Mode -->|"crisp (default)"| Quantize["quantize full-res source\nagainst the target palette"]
    Quantize --> Vote["per output cell:\nalpha-weighted majority vote\nover its source sub-block"]
    Vote --> Crisp["crisp pixel grid"]
    Mode -->|average| BoxBlur["Image.Resampling.BOX\n(plain box-filter resize)"]
    BoxBlur --> Averaged["blended/averaged pixel grid"]
```

`crisp` keeps edges and flat regions intact instead of mixing them into a blurred average; legacy
`average` mode exists to reproduce a plain box resize. Alpha is always downscaled separately with
a plain `BOX` resize regardless of mode. Neither path depends on an external library or a vendored
submodule — both are plain Pillow/stdlib operations local to this repo.

## Job/worker/revision model

A single worker claims one job at a time. Only `"script"` jobs (from `write_pixel_art`) create a
new Blender revision; render jobs reuse the current revision and only produce new artifacts.
Publication — the new revision pointer (if any), artifacts, and job state — happens in one SQLite
transaction after files move into persistent storage, so a failed or cancelled job never leaves
partial output visible. See [architecture](architecture.md) for the full consistency and
concurrency guarantees this relies on.
