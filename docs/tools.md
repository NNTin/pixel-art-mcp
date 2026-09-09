# Tool workflow

Call `get_capabilities` first. Create or find a project, upload references, inspect those images,
then use `execute_blender_python` to create and modify the 3D model.

## Create a model

`create_project({"name":"Chair"})` returns a project with `current_revision_id: null`.
Pass that project ID to `execute_blender_python`:

```json
{
  "project_id": "PROJECT_UUID",
  "expected_revision_id": null,
  "script": "import bpy\nbpy.ops.mesh.primitive_cube_add(size=1, location=(0,0,1))\nseat=bpy.context.object\nseat.name='Seat'\nseat.dimensions=(1.1,1,0.15)\n"
}
```

This returns a job ID immediately. Poll `get_job` until it succeeds, fails, or is cancelled.
Successful jobs return `result_revision_id` and downloadable `.blend`/script/summary artifacts.
An entire chair example is in [chair.py](../examples/chair.py).

## Modify an existing model

Fetch the current revision with `get_project`, inspect named objects with `inspect_scene`, and
submit another Python script using that expected revision. The existing `.blend` is loaded first:

```python
import bpy

bpy.data.objects["Seat"].dimensions.x = 1.4
```

The service saves the modified scene automatically. A script may create arbitrary meshes,
modifiers, materials, parents, and transform keyframes using the full `bpy` API. The supplied
`reference_images` dictionary maps uploaded reference UUIDs to normalized image paths that can
be loaded as textures with `bpy.data.images.load(reference_images[reference_id])`. Imported images
are packed when saving the scene. No prompt-to-model AI runs in the container.

## Preview and export

`render_preview` takes a project, angle (default 0°), frame (default 1), and optional revision.
After the job succeeds, call `get_artifact` with its `preview` artifact ID to return image content.
It also accepts `options` with the same settings as `render_sprites`, including sprite size,
elevation, palette, lighting, multiple angles, and animation frames. With `options` supplied,
its settings are used as-is; explicit `angle` or `frame` arguments override the corresponding
directions or frame range. Without `options`, the preview uses one 16×16 view and 16 samples.
To match the final framing and automatic palette fitting, preview all planned directions and
frames together. Reduce `samples` to speed up a draft; using identical options produces the same
pixels as the final export.

`render_sprites` takes a project, optional saved revision, and optional `options`. Defaults are
16×16 pixels, four cardinal directions, one static frame, and 5 fps for animated exports.
Use tile counts to describe the object's canvas; each tile is 16×16 pixels:

| Object canvas | Options | Export size |
| --- | --- | --- |
| Small | `{}` | 16×16 |
| Tall | `{"tile_height":2}` | 16×32 |
| Extra tall | `{"tile_height":3}` | 16×48 |
| Wide | `{"tile_width":2}` | 32×16 |
| Large | `{"tile_width":2,"tile_height":2}` | 32×32 |
| Explicit override | `{"width":20,"height":30}` | 20×30 |

`width` and `height`, when supplied, override the corresponding tile count, including non-multiples
of 16. Tile counts range from 1–32; explicit dimensions range from 8–512 pixels. Dimensions describe
the image canvas, not the occupied floor area: pixel-agents footprints are configured separately.
For example, generic exports can still request non-cardinal views and another playback rate:

```json
{
  "width": 64,
  "height": 64,
  "angles": [0, 45, 90],
  "elevation": 35.264,
  "frame_start": 1,
  "frame_end": 8,
  "fps": 12,
  "colors": 32
}
```

Set `frame_start` and `frame_end` to the same value for static views. `palette` accepts a list of
`#RRGGBB` colors. `lighting` is `studio` by default or `scene` to retain the scene lighting.
`frame_step` selects source animation samples; `fps` sets their exported playback rate.
Unknown options, nonfinite numbers, duplicate directions, invalid palettes, and excessive jobs
are rejected before execution.

`downscale_mode` defaults to `"crisp"`. The renderer fits the shared palette from genuine
supersampled source colors, BOX-downscales coverage, then maps each target pixel back to that
source-derived palette. This keeps pale gauge frames, saturated water, brass, wood, and iron from
being represented by new muddy colors created only by averaging. Use `"average"` to reproduce the
legacy behavior and compare it with crisp mode. An explicit `palette` is authoritative in either
mode.

Each render produces individual frame PNGs, `spritesheet.png`, `spritesheet.json`, `preview.png`,
`preview.html`, `comparison/high-resolution.png`, and `sprites.zip`. `preview.html` embeds both
the final sprites and the supersampled source render: download it or extract
the ZIP and open it in a browser without running a server. It displays every direction with angle
labels and supports play/pause, frame scrubbing, integer zoom, and light/dark/checkerboard backgrounds.
It compares low/high resolution at equal display sizes, with the final PNG resolution highlighted
in gold. With a `pixel_agents` configuration, those panels explicitly say **USED BY PIXEL-AGENTS**.
The high-resolution reference retains the original render before downsampling and palette reduction;
it is not an enlarged copy of the small sprite. `supersampling` defaults to 4 (16×16 → 64×64 reference);
setting it to 1 disables the higher-resolution comparison. `preview.png` remains a nearest-neighbor
enlargement of the final sheet, not the high-resolution reference.
The player respects reduced-motion preferences and starts static exports paused.

When more than one source frame is sampled, the export also includes
`animations/direction_00.apng`, etc.: transparent, lossless animation loops at the sprite resolution
and exported `fps`. APNGs use the same pixels and palette as the individual PNGs. Unchanged samples
may be combined into longer holds by the encoder (an entirely unchanged sequence can be static).
The JSON `directions` array maps each angle and sheet row to its frame indices and animation file;
`animation` is null for single-frame exports. Existing `frames` and rectangle metadata are unchanged.
APNG artifacts have kind `animation`, MIME type `image/apng`, and width/height metadata.

`get_artifact` returns download URLs and inline PNG images up to 1 MiB; for large sheets, use the
preview artifact. APNGs and the HTML player are downloads; MCP clients can use `preview.png` for
static inspection. Artifacts are also available at `GET /artifacts/{artifact_id}`.

## Text-only sprite inspection

`inspect_sprite` lets a completion-only client inspect a succeeded `render_preview` or
`render_sprites` job without image or vision support. Select a named state, angle, and source frame:

```json
{
  "job_id": "RENDER_JOB_UUID",
  "state_id": "full",
  "angle": 0,
  "frame": 21
}
```

Omitted selectors use the first available state, direction, and frame. The response includes:

- an exact 16x32 palette-index grid using two-character tokens (`..` is transparent);
- hex colors with plain-language names, usage bounds, connected components, singleton counts, and
  longest horizontal/vertical runs;
- occupied bounds, pivot, and low-contrast adjacent palette pairs;
- guidance for deciding whether to enlarge/recolor a named Blender object or change render options.

For example, a text agent can locate a one-pixel-wide cyan gauge from its palette bounds and
longest vertical run. It can then increase the gauge width or contrast using
`execute_blender_python`, rerender, and verify that the run and occupied pixel count increased.
This keeps visual feedback in tool text rather than assuming the client can consume `ImageContent`.

To compare two render configurations, pass the second completed job as `compare_job_id`:

```json
{
  "job_id": "CRISP_RENDER_JOB_UUID",
  "compare_job_id": "AVERAGE_RENDER_JOB_UUID",
  "state_id": "full",
  "angle": 0,
  "frame": 21
}
```

The matching frame, palette legend, grid, pixel-change count, alpha changes, and occupancy delta are
returned together. Palette symbols are local to each export, so the agent should compare their hex
legends and feature runs rather than assuming the same symbol means the same color.

## pixel-agents furniture package

Set `options.pixel_agents` to an object with `asset_id` (uppercase letters, digits, underscores;
starting with a letter) and `name`. This adds `pixel-agents.zip`, containing
`assets/furniture/<ASSET_ID>/manifest.json` and individual PNGs. Extract this ZIP into
`pixel-agents/webview-ui/public`, then reload/rebuild assets using that application's workflow.
The complete `sprites.zip` also includes this installable ZIP and its contents under `pixel-agents/`.
No code changes in pixel-agents are required. Installing a matching asset ID replaces that asset;
use a new ID for a new item.

The manifest uses the application's rotation → state → animation hierarchy, not APNG files or
this service's `spritesheet.json`. Angles map to `0=front`, `90=right`, `180=back`, `270=left`;
other angles are rejected for this package. A static export only needs the rotation group.

Furniture playback in pixel-agents is fixed at **5 fps** (`FURNITURE_ANIM_INTERVAL_SEC = 0.2`);
there is no per-asset timing field. Consequently, `pixel_agents` exports reject another `fps`.
Generic exports without this configuration can still override `fps`.

Importantly, the current app only cycles furniture's **on** frames when activated by a nearby
working agent. Otherwise it displays the **off** pose; it does not support always-on furniture
animation. Animated exports therefore require `pixel_agents.off_frame`, a source scene frame
for the idle appearance. The normal frame range supplies the on-state sequence. The renderer
includes the off pose in shared framing/palette fitting and exports it separately; it does not
add it to the animation loop. The HTML player lets you inspect both states, but its playback
control is a preview, not a simulation of the app's activation rules.

Optional furniture metadata includes `category`, `can_place_on_surfaces`, `can_place_on_walls`,
`footprint_w`, `footprint_h`, and `background_tiles`. Footprints default to the sprite dimensions
rounded up to 16px tiles. Override them for a tall sprite standing on a smaller floor area, or a
small object sitting on a desk; footprints do not resize the PNG. `background_tiles` must be less
than the footprint height.

## pixel-agents character package

Set `options.character` to an object with just `name` (a label for this export's own summary —
pixel-index's custom-character format carries no id or name at all; characters are identified
purely positionally). This requires `angles=[0, 90, 180]` (any order), `width=16`, `height=32`,
and exactly 7 frames, and adds `pixel-agents-character.zip` containing a single manifest-less
`character.png`, 112×96: three direction rows top to bottom (`down`, `up`, `right`) of seven
16×32 walk-cycle frames each. `left` is derived by the pixel-agents client from a horizontal flip
of `right` and is never part of the export — do not model a fourth row for it. States and
`pixel_agents` are not supported alongside `character`.

## Animated oil lamp example

Create a project, submit [oil_lamp.py](../examples/oil_lamp.py) as the `script` argument to
`execute_blender_python`, and wait for success. The named bronze reservoir, spout, loop handle,
enamel collar, and flame remain editable in the saved scene. The flame changes scale and tilt
over eight frames at 5 fps; frame 9 repeats the first pose but is excluded from the export.
Frame 0 hides the flame and turns off its point light for the idle state.

Use these options for `render_preview` and then `render_sprites`:

```json
{
  "tile_width": 1,
  "tile_height": 1,
  "angles": [0, 90, 180, 270],
  "frame_start": 1,
  "frame_end": 8,
  "fps": 5,
  "colors": 24,
  "samples": 32,
  "padding": 0.06,
  "pixel_agents": {
    "asset_id": "OIL_LAMP",
    "name": "Oil Lamp",
    "category": "decor",
    "can_place_on_surfaces": true,
    "footprint_w": 1,
    "footprint_h": 1,
    "off_frame": 0
  }
}
```

This produces 32 on-state 16×16 sprites, four idle poses, a 128×64 on-state sheet, four APNGs,
64×64-per-frame reference renders, the comparison player, metadata, and both ZIP packages.
The furniture package contains a manifest and 36 PNGs for the four orientations and off/on states.
0° faces the spout, and 180° faces the handle. Download generated files into the git-ignored
`tmp/oil-lamp/` directory by downloading the `sprites.zip` artifact and extracting it there.
Keep that directory entirely generated: change the model script or server, then rerender;
do not hand-edit sprites, metadata, or the player in the output directory.
The default studio lights illuminate all views consistently; the example also
has a keyframed point light for use with your own scene lighting and `lighting="scene"`.

## Named appearance states

Use `options.states` to export related appearances in one job. Each state supplies `id`, `name`,
`frame_start`, `frame_end`, optional `frame_step` (default 1), and a Pixel Agents `off_frame`.
State IDs are lowercase letters, digits and underscores, starting with a letter. States override
the top-level frame range and may use different animation lengths — for example a single-frame
static state (an empty vessel) alongside multi-frame animated states (partially filled, full).
Shorter states loop within the longest state's frame count in the combined `spritesheet.png`,
`preview.gif` and `preview.html`, while each state's own export under `states/<id>/` stays exactly
as long as that state's own frame range. All states and idle poses share a camera, pivot and
palette. With named states, set preview ranges on each state instead of using the top-level
`render_preview.frame` override.

The server automatically generates `preview.html` with state comparisons, direction selection,
playback, scrubbing, idle poses, zoom, backgrounds and source-render comparison. It also produces
individual exports under `states/<id>/`, a combined `spritesheet.png` and state-aware JSON, and
one combined `pixel-agents.zip`. Each fill state becomes a separate selectable furniture variant;
Pixel Agents' on/off activation behavior is retained. This does not install automatic transitions
between fill levels.

For the [rain barrel model](../examples/rain_barrel.py), submit the script through
`execute_blender_python`, wait for success, then call `render_sprites` with:

```json
{
  "tile_width": 1,
  "tile_height": 2,
  "angles": [0, 90, 180, 270],
  "elevation": 40,
  "fps": 5,
  "samples": 48,
  "padding": 0.035,
  "colors": 16,
  "states": [
    {"id":"empty", "name":"Empty", "frame_start":1, "frame_end":8, "off_frame":0},
    {"id":"partial", "name":"Partially filled", "frame_start":11, "frame_end":18, "off_frame":10},
    {"id":"full", "name":"Full", "frame_start":21, "frame_end":28, "off_frame":20}
  ],
  "pixel_agents": {
    "asset_id": "RAIN_BARREL", "name": "Rain Barrel", "category": "decor",
    "footprint_w": 1, "footprint_h": 2
  }
}
```

This produces 96 animation PNGs, 12 idle PNGs, 12 transparent APNG loops, and the three furniture
IDs `RAIN_BARREL_EMPTY`, `RAIN_BARREL_PARTIAL`, and `RAIN_BARREL_FULL`. The combined sheet has eight
time columns and twelve rows: four directions per state. Each sprite is **16×32 pixels**, matching
the 1×2 footprint on Pixel Agents' 16×16 grid. The simplified model gives the faucet and gauge
larger shapes; wood grain, rivets and small handles are omitted. Download the `sprites.zip` artifact and
extract it into git-ignored `tmp/rain-barrel/`. The HTML is generated by the server and belongs in
the downloaded output; no asset-specific HTML file is needed under `examples/`.

## Errors and cancellation

Use `cancel_job` for queued or running work. A running job may briefly report `cancelling` before
its terminal state. Existing revisions are retained. Script failures include bounded Blender logs;
timeouts and service restarts require submitting a new job. Never automatically retry unknown
Python side effects. There is one worker: wait for an edit before submitting dependent edits.
