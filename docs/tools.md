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
and `sprites.zip`. `get_artifact` returns download URLs and inline images up to 1 MiB; for large
sheets, use the preview artifact. Artifacts are also available at `GET /artifacts/{artifact_id}`.

## Errors and cancellation

Use `cancel_job` for queued or running work. A running job may briefly report `cancelling` before
its terminal state. Existing revisions are retained. Script failures include bounded Blender logs;
timeouts and service restarts require submitting a new job. Never automatically retry unknown
Python side effects. There is one worker: wait for an edit before submitting dependent edits.
