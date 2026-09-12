# Pixel Agents asset workflow

Use this workflow for furniture, characters, and pets. Blender remains the editable source;
the server derives framing, game shading, placement metadata, packages, and previews. Generic
`render_preview`/`render_sprites` remain available for existing clients and physical-scale work.

## Model, render, inspect, refine

1. Call `get_asset_profile({"kind":"furniture","preset":"chair"})` for canvas sizes,
   animation roles, coordinates, and modeling guidance.
2. Create a project, then call `configure_asset` with a complete specification:

   ```json
   {
     "project_id": "PROJECT_UUID",
     "specification": {
       "kind": "furniture", "asset_id": "CHAIR", "name": "Chair", "preset": "chair"
     }
   }
   ```

3. Use `execute_blender_python` to model named parts and poses, then `wait_for_job`.
   Use +Z up and face the front toward -Y. Keep locomotion in place. Exaggerate thin details
   until they survive at least two pixels; real-world dimensions do not determine game size.
4. Call `render_asset({"project_id":"PROJECT_UUID"})`, then `wait_for_job`.
5. Read `inspect_asset({"job_id":"JOB_UUID"})`. For exact pixels call `inspect_sprite`;
   its `state_id` selects a clip, `frame` is a Blender source frame, and `angle` selects the view.
6. Download `job.outputs["sprites.zip"]` with `get_artifact`. Extract and open `preview.html`.
   Change named Blender objects or replace the configuration, then rerender. All output files
   are generated; do not repair exported PNGs, metadata, or HTML by hand.

`configure_asset` replaces the configuration and returns an immutable configuration ID and
resolved per-direction layouts. `get_project` returns the current configuration. Each render
captures both that configuration and a scene revision when submitted; later edits cannot change
queued jobs. Pass `revision_id` to render an earlier scene using the current configuration.
All clips, including off poses, share a palette, scale, and stable framing.

## Sizes and placement

| Preset | Front canvas | Default occupied ground | Upper background rows |
| --- | --- | --- | --- |
| small | 16×16 | 1×1 | 0 |
| chair | 16×32 | 1×1 | 1 |
| tall | 16×64 | 1×1 | 3 |
| desk | 48×32 | 3×1 | 1 |
| character | 16×32 | bottom-center anchor | — |
| pet | 16×32, right 32×32 | bottom-center anchor | — |

Furniture canvas width equals `ground_width * 16`; width and height must be tile multiples.
`ground_depth` counts occupied rows. `height / 16 - ground_depth` becomes `backgroundTiles`.
When rotated, ground width/depth swap while the upper background-row count stays the same.
A desk therefore has a 16×64 side canvas and a 1×4 manifest footprint, with one walkable top row.
The `chair` and `desk` presets also select the corresponding consumer category by default.
The legacy `storage` category is normalized to `misc`, matching the current Pixel Index upload API.

Pixel Agents draws furniture at the tile's top-left; it does not read sprite pivots. Its
`backgroundTiles` means **top rows that remain walkable**, not a downward overhang. The manifest
footprint includes these rows. Chair seating comes from the remaining ground tiles, with
orientation-specific drawing order. Characters and pets are drawn at bottom-center; working
characters additionally move down by six pixels in the consumer.

`placement` is `floor`, `surface`, or `wall`. Surface sprites reserve seven pixels below the
content to sit higher on a desk tile. Place small props on a tile over the visible desktop; the
upper background tile of a desk can be empty. More detailed props may need `height: 32`, as in
the oil-lamp example. Review them in context before choosing their canvas.

The default alignment uses each view's union of visible geometry. Optional `anchor_object` names
an object or empty whose origin should be a stable ground-contact point; two pixels are reserved
below that anchor. It is evaluated at the first source frame. Moving poses retain their motion.

## Semantic clips and consumer playback

`clips` maps lowercase identifiers to `{frames, name?, off_frame?}`. Frames are explicit source
frame numbers; they may be noncontiguous or repeated. Omit clips to use these defaults:

| Kind / clip | Source frames | Playback pose order | Interval |
| --- | --- | --- | --- |
| Furniture / default | 1 | static | — |
| Character / walk | 1,2,3 | 0,1,2,1 | 150 ms |
| Character / typing | 4,5 | 0,1 | 300 ms |
| Character / reading | 6,7 | 0,1 | 300 ms |
| Pet / walk | 1,2,3 | 0,1,0,2 | 150 ms |
| Pet / idle | 4,5,6 | 0,1,2,1 | 300 ms |

Author character walk poses as left step / neutral / right step, and pet walk poses as
neutral / left step / right step, to match their different playback sequences.

Character sheets are 112×96: down/up/right rows, each with three walk, two typing, and two reading
poses. Left mirrors right. Pet sheets are 96×96: down/up rows each contain three walk then three
idle poses at 16×32; right contains three walk poses at 32×32. Pet left walking mirrors right;
right idle uses down idle and left idle uses up idle, without mirroring. Authored right idle
renders remain available for inspection but are unused by the package; previews use consumer idle.

For animated furniture, supply `off_frame`. Each clip becomes a selectable variant when more
than one clip is supplied. The consumer shows off by default, then plays on frames at 200 ms near
an active agent facing the furniture. There is no always-on animation or automatic transition
between named variants. See [asset-specs.json](../examples/asset-specs.json) for the lamp and
empty/partial/full barrel configurations.

## Shading, diagnostics, and artifacts

`shading: "game"` uses three broad directional shade bands from authored base colors and textures,
with unlit emissive materials. `studio` and `scene` retain conventional lighting alternatives.
The default shared palette has 16 colors; use `colors` or an explicit `palette` to simplify it.
`outline: true` adds a one-pixel silhouette outline and reserves its margin during camera fitting.
These changes only affect the render copy, leaving the saved scene editable.

Every target exports individual frames, supersampled source comparisons, `spritesheet.json`,
`asset-specification.json`, `asset-report.json`, `context.png`, and an offline `preview.html`.
Animated clips also produce APNGs and a GIF overview. The full `sprites.zip` includes everything,
including the installable `pixel-agents.zip`, `pixel-agents-character.zip`, or `pixel-agents-pet.zip`.
`job.outputs` names top-level artifacts; every artifact's `export_path` preserves its relative
path so nested frames with identical filenames can be distinguished.

Diagnostics report occupied bounds, margins, center/contact offsets, color fragmentation,
changed animation pixels, and named-object projected dimensions. Small silhouettes, weak contrast
against the dark preview floor, fragmented colors, and imperceptible animation are advisory.
Projected object bounds cannot establish visibility or occlusion; a hidden bulb can have a large
bounding box. Empty sprites, invalid canvases/packages, and geometry touching the raw render
boundary fail the export. A `ready` report means no detected issues, not an artistic-quality guarantee.

The offline preview approximates a 16-pixel grid, reference agent, desktop, wall, seating,
directions, activation, and playback. It does not embed the consumer or require Node/Chromium in
the production container. Exact consumer compatibility is checked separately by a development harness.

## Reproduce examples and webview checks

With the updated service running:

```sh
uv run python scripts/generate_examples.py --base-url http://localhost:8000
node scripts/check_webview.mjs --consumer ../pixel-index/vendor/pixel-agents
```

The first script uses actual MCP tools to generate every example, inspect it, and download outputs
to `tmp/asset-workflow/`. `--only chair pet` reruns selected examples. It never modifies previous
outputs under `tmp/chair/` and the other original example folders.

The second script reads an existing consumer checkout and its development dependencies (`esbuild`,
`@playwright/test`, and installed Chromium). It bundles the consumer's real PNG decoders, catalog,
layout, sprite selection, office activation logic, and canvas renderer outside that checkout.
It checks package pose identity, rotation, seating, walkability, surface layering, off/on activation,
mirroring, and playback, then exercises the generated HTML controls. It writes an offline gallery,
per-example screenshots, and `report.json` under `tmp/asset-workflow/webview/`, including the tested
consumer commit and an unchanged-repository check. If original outputs exist, the gallery also
shows before/after comparisons. It reads built-in artwork only for this local validation gallery.

HTTP equivalents are `GET /asset-profiles/{kind}`, `PUT /projects/{id}/asset`,
`POST /projects/{id}/asset/renders?revision_id=...`, and `GET /jobs/{id}/asset-inspection`.
