# Pixel Agents asset workflow

Use this workflow for furniture, characters, and pets. Blender remains the editable source,
including named native pixel layers. The server derives placement metadata, packages and
previews from the exact authored pixel grid.

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

3. Use `write_pixel_art` to author typed named pixel layers and poses, then `wait_for_job`.
   `get_asset_profile.pixel_authoring` contains a complete JSON starter and tool-call examples.
   The server invokes the helpers; clients need no Python import or source files.
   Reserve space for identifying features first. Keep locomotion in place and follow the
   configured layouts; real-world dimensions do not determine game size.
4. Call `render_asset({"project_id":"PROJECT_UUID"})`, then `wait_for_job`.
5. Read `inspect_asset({"job_id":"JOB_UUID"})`. For exact pixels call `inspect_sprite`;
   its `state_id` selects a clip, `frame` is a Blender source frame, and `angle` selects the view.
6. Use `get_asset_preview` for inline image content: select clip, source frame, direction, integer
   scale and approximate context. Use `get_pixel_art` to retrieve source, then `edit_pixel_art`
   for targeted layer/pose edits with its revision as `expected_revision_id`. `write_pixel_art`
   remains a complete replacement. `get_artifact` returns PNG/JSON/source text and small binary
   resources inline; `get_artifact_chunk` delivers any artifact without HTTP. Client integration
   is needed for local saving/installing. Do not repair generated output PNGs by hand.

Generic 16x32 objects use the neutral furniture `prop` preset. Set placement/category explicitly
for the actual object; `chair` and `desk` carry chair/desk category defaults.

`configure_asset` replaces the configuration and returns an immutable configuration ID and
resolved per-direction layouts. `get_project` returns the current configuration. Each render
captures both that configuration and a scene revision when submitted; later edits cannot change
queued jobs. Pass `revision_id` to render an earlier scene using the current configuration.
All clips, including off poses, share a palette, scale, and stable framing.

## Native pixel authoring

pixel-agents renders every asset from a downward-tilted 3/4 camera, never a flat front
elevation (see `get_asset_profile`'s `camera_perspective` field, read by any MCP-only agent
before authoring). For floor furniture, the top-facing surface must dominate the sprite --
usually well over half its visible height -- with only a thin front/side edge and legs/base
at the very bottom few pixels; a true front face (a chair's backrest, a desk's front apron)
is barely visible from this camera. For characters/pets, the front and side views show mostly
the top of the head/fur with eyes/face pushed down near the bottom of the head box, not a
conventional face with a visible forehead; the back view is entirely hair/fur, no face.

The primary API is typed JSON through `write_pixel_art`; see [the MCP contract](tools.md).
`render_asset` rejects missing or invalid definitions; generic render tools are removed.
The following is an advanced developer example of the helper used internally by the server.
Independent MCP agents do not need to discover or execute this import:

```python
import bpy
from pixel_art_mcp.pixel_art import Canvas, PixelArt

art = PixelArt(
    {"D": "#293039", "G": "#f3cf65"},
    {angle: (16, 16) for angle in (0, 90, 180, 270)},
)
tap = Canvas.from_rows(["GGG.", ".G..", "GGGG", "...G", "...G"])
for angle in (0, 90, 180, 270):
    art.layer("faucet", angle, tap, x=5, y=3, min_pixels=10, connected=True)
art.save(bpy.context.scene)
```

This minimal example shows the same glyph in every direction; actual assets must author the
appropriate view. Coordinates are integer pixels from the top-left, not Blender units. A dot
is transparent. `Canvas.rect(x, y, width, height, symbol)` and `stamp(x, y, rows)` draw exact
pixels; `mirrored()` returns a reflected canvas. Out-of-bounds drawing raises an error.

Layers composite in insertion order. Omit `frame` for a static default; `frame=...` overrides it
for that source frame. A layer without a default is absent in unspecified frames. A dot reveals
the preceding layer, not an eraser. Use a separate static body and small animated patches.
`min_pixels` is a budget for pixels remaining visible **after all layers composite**, and
`connected=True` requires one four-connected cluster. Set budgets per view to account for
intentional occlusion. Diagnostics cannot decide whether the shape actually resembles a faucet.

Reload `PixelArt.load(bpy.context.scene)` in a later revision to change its palette or named poses.
See `modify_chair.py`. Every native export includes `pixel-art.json`, and inspection exposes
the resolved feature bounds, visible pixels, clipping, overwritten pixels and components.

Declare exactly the canvas sizes returned by `configure_asset`. The authored palette is fixed
for the complete job, must fit `colors`, and must match `palette` if configured. Rendering never
runs Cycles or downscales artwork: its source comparison is always labeled **authored grid**,
an upscaled copy of the exact exported pixels, not a higher-detail source render. Automatic
`outline` is rejected with pixel layers; draw outlines explicitly on the native grid.

The rain barrel's mouth tops its 16x32 canvas, matching the top-down 3/4 camera, with an
18-row cask starting at y=13. The mouth is narrower than the cask and sits low enough (y=1)
to overlap the cask's own top hoop, which is wider than the mouth and shows through on both
sides as a wood-toned collar framing whatever fills it -- water reads as sitting in a hole in
the barrel, not as a flat patch on top of it. The mouth's rows exposed against open background
(above that overlap) get their own one-pixel metal-rim highlight instead, since nothing sits
behind them to frame them: see `background_contrast` from `get_asset_profile` and
`asset_report`'s `low_context_contrast` finding, which both exist because an unrimmed dark
fill there sits close enough in luma to the webview's own floor tile to read as a hole into
the background. Its faucet, side spout, rear seams and gauge sit in the mid-band of staves, at
absolute canvas offsets independent of the cask's own top -- not crammed against the bottom
rim, and static across every animation phase. The faucet is a connected 12-pixel gold glyph;
the gauge is a 4x6 frame with a 2x4 interior that recolors (not resizes) as the water level
rises, so it stays exactly as visible full as empty. The opening and fill are broad clusters;
rain moves independently above the cask. Screws, threads and repeated wood texture yield space
to these identifying features. This is deliberate pixel art direction, not a promise that
every small detail can survive at this footprint.

## Sizes and placement

| Preset | Front canvas | Default occupied ground | Upper background rows |
| --- | --- | --- | --- |
| small | 16×16 | 1×1 | 0 |
| prop | 16×32 | 1×1 | 1 |
| chair | 16×32 | 1×1 | 1 |
| tall | 16×64 | 1×1 | 3 |
| desk | 48×32 | 3×1 | 1 |
| character | 16×32 | bottom-center anchor | — |
| pet | 16×32, right 32×32 | bottom-center anchor | — |

Furniture canvas width equals `ground_width * 16`; width and height must be tile multiples.
`ground_depth` counts occupied rows. Prefer `background_tiles` and omit `width`/`height`:
front height becomes `(ground_depth + background_tiles) * 16`. Omitted background tiles preserve
preset headroom. An explicit `height` instead derives `height / 16 - ground_depth` background
rows; if both fields are supplied they must agree. A 3x4 cat tree with one background row is
48x80 front/back and 64x64 on its sides, without increasing the native tile pixel density.
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

## Diagnostics and artifacts

The default shared palette has 16 colors; use `colors` or an explicit `palette` to simplify it.
Automatic `outline` must remain false because pixel helpers are mandatory; draw outlines in rows.

Every target exports individual frames, supersampled source comparisons, `spritesheet.json`,
`asset-specification.json`, `asset-report.json`, `context.png`, and an offline `preview.html`.
Animated clips also produce APNGs and a GIF overview. The full `sprites.zip` includes everything,
including the installable `pixel-agents.zip`, `pixel-agents-character.zip`, or `pixel-agents-pet.zip`.
`job.outputs` names top-level artifacts; every artifact's `export_path` preserves its relative
path so nested frames with identical filenames can be distinguished.

Diagnostics report occupied bounds, margins, center/contact offsets, color fragmentation, and
changed animation pixels. Small silhouettes, weak contrast against the dark preview floor,
fragmented colors, and imperceptible animation are advisory. Empty sprites and invalid
canvases/packages fail the export. `checks_passed` means no detected issues, not an
artistic-quality guarantee; `visual_review_required` is always true. Feature clipping, lost
pixel budgets and disconnected required features produce review findings even when the package
is valid.

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
