"""Target profiles and deterministic translation into a render job snapshot."""

from typing import Any

from pixel_art_mcp.imaging.context import BACKGROUND_COLOR
from pixel_art_mcp.models import AssetClip, AssetSpec, DomainError, RenderOptions

PROFILES: dict[str, dict[str, Any]] = {
    "small": {"kind": "furniture", "size": [16, 16], "content_height": 14},
    "prop": {"kind": "furniture", "size": [16, 32], "content_height": 30},
    "chair": {"kind": "furniture", "size": [16, 32], "content_height": 24},
    "tall": {"kind": "furniture", "size": [16, 64], "content_height": 62},
    "desk": {"kind": "furniture", "size": [48, 32], "content_height": 24},
    "character": {"kind": "character", "size": [16, 32], "content_height": 29},
    "pet": {"kind": "pet", "size": [16, 32], "content_height": 22},
}


def normalize_asset(spec: AssetSpec) -> AssetSpec:
    values = spec.model_dump()
    values["preset"] = spec.preset or ("small" if spec.kind == "furniture" else spec.kind)
    if not spec.clips:
        defaults = {
            "furniture": {"default": [1]},
            "character": {"walk": [1, 2, 3], "typing": [4, 5], "reading": [6, 7]},
            "pet": {"walk": [1, 2, 3], "idle": [4, 5, 6]},
        }
        values["clips"] = {key: {"frames": frames} for key, frames in defaults[spec.kind].items()}
    if values["preset"] in ("chair", "desk") and "category" not in spec.model_fields_set:
        values["category"] = "chairs" if values["preset"] == "chair" else "desks"
    return AssetSpec.model_validate(values)


def asset_layouts(spec: AssetSpec) -> list[dict[str, Any]]:
    spec = normalize_asset(spec)
    profile = PROFILES[str(spec.preset)]
    width = spec.width or (spec.ground_width * 16 if spec.ground_width else profile["size"][0])
    background = spec.background_tiles
    if background is None:
        background = (
            (spec.height // 16 - spec.ground_depth) if spec.height else profile["size"][1] // 16 - 1
        )
    height = spec.height or (spec.ground_depth + background) * 16
    angles = [0, 90, 180, 270] if spec.kind == "furniture" else [0, 180, 90]
    ground_w = spec.ground_width or width // 16
    if spec.kind == "furniture":
        if width % 16 or height % 16 or width != ground_w * 16:
            raise DomainError(
                f"Furniture width must equal ground_width * 16 = {ground_w * 16}px; "
                "height must be a multiple of 16. Prefer "
                "ground_width/ground_depth/background_tiles."
            )
        if background < 0:
            raise DomainError(
                f"height={height}px cannot include ground_depth={spec.ground_depth} tiles; "
                f"minimum height is {spec.ground_depth * 16}px. "
                "Omit height and set background_tiles for automatic sizing."
            )
        if height != (spec.ground_depth + background) * 16:
            raise DomainError(
                "height conflicts with background_tiles: "
                f"expected {(spec.ground_depth + background) * 16}px. "
                "Supply tile fields or matching pixel dimensions."
            )
    else:
        background = 0
    layouts = []
    for angle in angles:
        gw, gd = ground_w, spec.ground_depth
        if spec.kind == "furniture" and angle in (90, 270):
            gw, gd = gd, gw
        w = (
            gw * 16
            if spec.kind == "furniture"
            else 32
            if spec.kind == "pet" and angle == 90
            else 16
        )
        h = (gd + background) * 16 if spec.kind == "furniture" else 32
        if w > 512 or h > 512:
            raise DomainError("Rotated furniture canvas exceeds 512 pixels")
        margin = 2 if spec.outline else 1
        bottom = h - margin - (7 if spec.placement == "surface" else 0)
        content = min(h - 2 * margin, profile["content_height"] + h - profile["size"][1])
        if spec.height:
            content = h - 2 * margin
        layouts.append(
            {
                "angle": angle,
                "width": w,
                "height": h,
                "footprint_w": gw,
                "footprint_h": gd + background,
                "ground_width": gw,
                "ground_depth": gd,
                "background_tiles": background,
                "margin": margin,
                "bottom": bottom,
                "content_height": min(content, bottom - margin),
            }
        )
    return layouts


def resolve_asset(spec: AssetSpec, configuration_id: str | None = None) -> RenderOptions:
    spec = normalize_asset(spec)
    layouts = asset_layouts(spec)
    frames = list(
        dict.fromkeys(
            frame
            for clip in spec.clips.values()
            for frame in [*clip.frames, *([clip.off_frame] if clip.off_frame is not None else [])]
        )
    )
    return RenderOptions(
        asset=spec,
        asset_configuration_id=configuration_id,
        asset_layouts=layouts,
        frame_sequence=frames,
        width=max(row["width"] for row in layouts),
        height=max(row["height"] for row in layouts),
        angles=[row["angle"] for row in layouts],
        fps=5,
        colors=spec.colors,
        palette=spec.palette,
        supersampling=spec.supersampling,
        meters_per_tile=None,
        padding=0,
    )


def get_asset_profile(
    kind: str,
    preset: str | None = None,
    *,
    ground_width: int | None = None,
    ground_depth: int | None = None,
    background_tiles: int | None = None,
) -> dict[str, Any]:
    if kind not in ("furniture", "character", "pet"):
        raise DomainError("Choose furniture, character, or pet")
    selected = preset or ("small" if kind == "furniture" else kind)
    if selected not in PROFILES or PROFILES[selected]["kind"] != kind:
        raise DomainError(f"Unknown {kind} preset {selected!r}")
    spec = normalize_asset(
        AssetSpec.model_validate(
            {
                "kind": kind,
                "name": "Example",
                "asset_id": "EXAMPLE",
                "preset": selected,
                **{
                    key: value
                    for key, value in {
                        "ground_width": ground_width,
                        "ground_depth": ground_depth,
                        "background_tiles": background_tiles,
                    }.items()
                    if value is not None
                },
            }
        )
    )
    layouts = asset_layouts(spec)
    starter: dict[str, Any] = {
        "version": 1,
        "palette": {"D": "#293039", "G": "#f3cf65"},
        "layers": [
            {
                "name": "marker",
                "poses": [
                    {
                        "angle": row["angle"],
                        "frame": None,
                        "rows": ["DDDDDD", "DGGGGD", "DGDDGD", "DGDDGD", "DGGGGD", "DDDDDD"],
                        "x": row["width"] // 2 - 3,
                        "y": row["bottom"] - 6,
                        "min_pixels": 36,
                        "connected": True,
                    }
                    for row in layouts
                ],
            }
        ],
    }
    return {
        "kind": kind,
        "preset": selected,
        "presets": [key for key, value in PROFILES.items() if value["kind"] == kind],
        "specification": spec.model_dump(),
        "layouts": layouts,
        "sizing": {
            "tile_pixels": 16,
            "occupied_ground_tiles": [layouts[0]["ground_width"], layouts[0]["ground_depth"]],
            "background_tiles": layouts[0]["background_tiles"],
            "rule": "Front/back = 16*ground_width by 16*(ground_depth+background_tiles). "
            "Right/left swap ground width/depth. Background rows are nonblocking; "
            "they are not additional occupied ground tiles.",
            "example_3x4": {
                "ground_width": 3,
                "ground_depth": 4,
                "background_tiles": 1,
                "front_pixels": [48, 80],
                "side_pixels": [64, 64],
            },
        }
        if kind == "furniture"
        else {
            "native_views": {str(row["angle"]): [row["width"], row["height"]] for row in layouts},
            "rule": "Fixed consumer canvases; furniture tile fields do not apply.",
        },
        "preset_guidance": "For a generic 16x32 object use furniture preset=prop, which defaults "
        "to category=decor. chair/desk imply chairs/desks unless category is explicit. Set "
        "placement and category for the actual object: a thermometer uses placement=wall, "
        "category=wall. Presets choose native canvas/footprint, not the drawing; never increase "
        "pixel density to add detail.",
        "camera_perspective": (
            "pixel-agents renders every asset from a downward-tilted 3/4 camera, never a flat "
            "front elevation. The object's TOP-FACING surface must dominate the sprite -- most "
            "of its visible height -- with only a thin front/side edge and legs/base visible at "
            "the very bottom few pixels. A true front face (a chair's backrest, a desk's front "
            "apron, a barrel's side wall) is barely visible from this camera; drawing it as the "
            "main content is the most common mistake. Before adding side/front detail, decide "
            "how much of the canvas the topmost visible surface should fill -- usually well over "
            "half the height for floor furniture."
            if kind == "furniture"
            else "pixel-agents renders every asset from a downward-tilted 3/4 camera, never a "
            "flat front elevation. On the front ('down') and side views the top of the head/fur "
            "dominates and eyes/face sit low, near the bottom of the head box -- not a "
            "conventional face with a visible forehead. The back ('up') view is entirely "
            "hair/fur with no face at all."
        ),
        "background_contrast": (
            f"The schematic preview/webview floor is #{bytes(BACKGROUND_COLOR).hex()}, a "
            "mid-dark tone. Broad materials (a barrel's dry interior, a chair's dark frame, "
            "a character's hair) must read as clearly lighter or clearly darker than that, "
            "not a close match -- a large connected patch within a similar brightness range "
            "reads as a hole into the background instead of a surface. inspect_asset's report "
            "flags this after rendering (finding code low_context_contrast), but choosing "
            "palette colors with deliberate contrast up front avoids the rework."
        ),
        "pixel_authoring": {
            "contract_version": 1,
            "required": True,
            "tool": "write_pixel_art",
            "helpers": "Canvas and PixelArt run on the server. Supply JSON, never imports.",
            "schema": "write_pixel_art.definition describes all fields and limits.",
            "incremental_workflow": "First publish only a small valid base/body covering all "
            "configured views, then wait. Add one named feature at a time with "
            "edit_pixel_art(set_layer), render and inspect. Do not resend the whole asset "
            "after a small error. Initial creation uses write_pixel_art, not edit_pixel_art. "
            "Use the successful job's result_revision_id for the next edit; get_pixel_art "
            "is needed only when reading/changing existing source.",
            "drawing": "For large shapes supply drawing instead of rows: width/height plus "
            "ordered rect, line, stamp commands. Commands repeat with repeat/dx/dy; mirror_x "
            "reflects the whole patch. Integer helper pixels only; no antialiasing. Prefer "
            "rectangles for thick connected posts/platforms and small stamps for motifs. "
            "Source reads return canonical rows, never executable code.",
            "drawing_example": {
                "angle": 0,
                "frame": None,
                "x": 0,
                "y": 0,
                "drawing": {
                    "width": 6,
                    "height": 6,
                    "commands": [
                        {"op": "rect", "x": 0, "y": 0, "width": 6, "height": 6, "color": "D"},
                        {"op": "rect", "x": 1, "y": 1, "width": 4, "height": 4, "color": "G"},
                    ],
                },
            },
            "coordinates": "Native integer pixels, top-left origin; '.' reveals lower layers.",
            "views": "Use only configured angles. The server derives exact canvas dimensions.",
            "layers": "Ordered back to front. Exact-frame pose replaces the null-frame default; "
            "without a default a layer is hidden in unspecified frames. Every view/frame needs "
            "a resolved pose with visible ink.",
            "editing": "get_pixel_art returns definition and revision_id. Use edit_pixel_art "
            "for targeted move_pose/set_pose/delete_pose/set_layer/delete_layer/set_palette "
            "operations with expected_revision_id=revision_id. Untouched source is preserved. "
            "Alternatively write_pixel_art replaces the entire definition: omitted layers/poses "
            "are deleted. Both validate all source and use mandatory helpers. Wait for the job.",
            "example_edit_call": {
                "tool": "edit_pixel_art",
                "arguments": {
                    "project_id": "<project.id>",
                    "expected_revision_id": "<get_pixel_art.revision_id>",
                    "edits": [
                        {
                            "op": "move_pose",
                            "layer": "marker",
                            "angle": 0,
                            "frame": None,
                            "x": starter["layers"][0]["poses"][0]["x"] + 1,
                            "y": starter["layers"][0]["poses"][0]["y"],
                        }
                    ],
                },
            },
            "features": "Reserve connected contrasting clusters, separating gaps and usually "
            "2px thickness for identifying details before texture. Exaggerate a faucet or gauge; "
            "simplify nonessential parts. More colors cannot add pixels. Do not enlarge native "
            "resolution. min_pixels and connected measure visibility after all layers are drawn.",
            "palette": "2..64 distinct alphanumeric-symbol-to-#RRGGBB colors within the configured "
            "budget. This palette is fixed for every frame/view. Draw outlines explicitly; "
            "configure_asset.outline must be false.",
            "example_definition": starter,
            "example_calls": [
                {"tool": "create_project", "arguments": {"name": "Pixel starter"}},
                {
                    "tool": "configure_asset",
                    "arguments": {"project_id": "<project.id>", "specification": spec.model_dump()},
                },
                {
                    "tool": "write_pixel_art",
                    "arguments": {
                        "project_id": "<project.id>",
                        "definition": starter,
                        "expected_revision_id": None,
                    },
                },
                {"tool": "wait_for_job", "arguments": {"job_id": "<write job.id>"}},
                {"tool": "render_asset", "arguments": {"project_id": "<project.id>"}},
                {"tool": "wait_for_job", "arguments": {"job_id": "<render job.id>"}},
                {"tool": "inspect_asset", "arguments": {"job_id": "<render job.id>"}},
                {
                    "tool": "inspect_sprite",
                    "arguments": {
                        "job_id": "<render job.id>",
                        "state_id": next(iter(spec.clips)),
                        "angle": 0,
                        "frame": next(iter(spec.clips.values())).frames[0],
                    },
                },
                {
                    "tool": "get_asset_preview",
                    "arguments": {"job_id": "<render job.id>", "context": True, "scale": 4},
                },
                {"tool": "get_pixel_art", "arguments": {"project_id": "<project.id>"}},
            ],
            "example_notes": "Replace angle-bracket ID placeholders with prior tool results. "
            "The starter is a valid small pixel marker, not a finished design; default patches "
            "are static across all semantic clips. Author the documented distinct poses. "
            "On nonterminal wait results call wait_for_job again; on failure inspect get_job. "
            "example_edit_call moves just the front default marker one native pixel right. "
            "Substitute the current source revision, wait for success, render and inspect again. "
            "Retrieve job.outputs PNG/JSON/text and small binary resources through get_artifact; "
            "get_artifact_chunk delivers any file in bounded base64 chunks, no HTTP needed. "
            "Decode each chunk separately and concatenate raw bytes until next_offset=null. "
            "Saving locally requires client attachment support.",
        },
        "animation": {
            "furniture": "Each clip is a variant. Animated clips require off_frame; on plays at "
            "5 fps near working agents, otherwise off is shown.",
            "character": "walk has 3 poses (left step, neutral, right step), played 0,1,2,1; "
            "typing and reading each have 2 poses. "
            "Walking advances every 150ms; work every 300ms. "
            "Left mirrors right. Work poses are displayed with a 6px sitting offset.",
            "pet": "walk and idle each have 3 poses. "
            "Author walk as neutral, left step, right step. "
            "Walk plays 0,1,0,2 every 150ms; idle "
            "plays 0,1,2,1 every 300ms. Right walk is 32px wide; left walk mirrors "
            "right. Right idle uses down idle; left idle uses up idle, without mirroring.",
        }[kind],
        "workflow": [
            "create_project",
            "configure_asset",
            "write_pixel_art",
            "wait_for_job",
            "render_asset",
            "wait_for_job",
            "inspect_asset",
            "inspect_sprite",
            "get_asset_preview",
            "get_pixel_art",
        ],
        "preview": "Generated context is an approximation; actual webview checked separately.",
    }


def clip_playback(kind: str, name: str, clip: AssetClip) -> list[int]:
    if kind == "character" and name == "walk":
        return [clip.frames[0], clip.frames[1], clip.frames[2], clip.frames[1]]
    if kind == "pet":
        indices = [0, 1, 0, 2] if name == "walk" else [0, 1, 2, 1]
        return [clip.frames[i] for i in indices]
    return clip.frames


def clip_duration_ms(kind: str, name: str) -> int:
    if kind == "furniture":
        return 200
    return 150 if name == "walk" else 300
