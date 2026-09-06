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

`render_preview` takes a project, angle (default 45°), frame (default 1), and optional revision.
After the job succeeds, call `get_artifact` with its `preview` artifact ID to return image content.
It also accepts `options` with the same settings as `render_sprites`, including sprite size,
elevation, palette, lighting, multiple angles, and animation frames. With `options` supplied,
its settings are used as-is; explicit `angle` or `frame` arguments override the corresponding
directions or frame range. Without `options`, the preview uses one 64px view and 16 samples.
To match the final framing and automatic palette fitting, preview all planned directions and
frames together. Reduce `samples` to speed up a draft; using identical options produces the same
pixels as the final export.

`render_sprites` takes a project, optional saved revision, and optional `options`:

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

Each render produces individual frame PNGs, `spritesheet.png`, `spritesheet.json`, `preview.png`,
`preview.html`, and `sprites.zip`. `preview.html` embeds the sprite sheet: download it or extract
the ZIP and open it in a browser without running a server. It displays every direction with angle
labels and supports play/pause, frame scrubbing, integer zoom, and light/dark/checkerboard backgrounds.
It respects the browser's reduced-motion preference and starts static exports paused.

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

## Animated oil lamp example

Create a project, submit [oil_lamp.py](../examples/oil_lamp.py) as the `script` argument to
`execute_blender_python`, and wait for success. The named bronze reservoir, spout, loop handle,
enamel collar, and flame remain editable in the saved scene. The flame changes scale and tilt
over eight frames; frame 9 repeats the first pose but is excluded from the export.

Use these options for `render_preview` and then `render_sprites`:

```json
{
  "width": 64,
  "height": 64,
  "angles": [0, 45, 90, 135, 180, 225, 270, 315],
  "frame_start": 1,
  "frame_end": 8,
  "fps": 12,
  "colors": 24,
  "samples": 32,
  "padding": 0.06
}
```

This produces 64 PNG sprites, a 512×512 sheet, eight APNGs, the player, metadata, and a ZIP.
0° faces the spout, and 180° faces the handle. Download generated files into the git-ignored
`tmp/oil-lamp/` directory by downloading the `sprites.zip` artifact and extracting it there.
Keep that directory entirely generated: change the model script or server, then rerender;
do not hand-edit sprites, metadata, or the player in the output directory.
The default studio lights illuminate all views consistently; the example also
has a keyframed point light for use with your own scene lighting and `lighting="scene"`.

## Errors and cancellation

Use `cancel_job` for queued or running work. A running job may briefly report `cancelling` before
its terminal state. Existing revisions are retained. Script failures include bounded Blender logs;
timeouts and service restarts require submitting a new job. Never automatically retry unknown
Python side effects. There is one worker: wait for an edit before submitting dependent edits.
