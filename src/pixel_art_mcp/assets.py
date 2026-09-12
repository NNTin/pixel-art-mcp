"""Target profiles and deterministic translation into a render job snapshot."""

from typing import Any

from pixel_art_mcp.models import AssetClip, AssetSpec, DomainError, RenderOptions

PROFILES: dict[str, dict[str, Any]] = {
    "small": {"kind": "furniture", "size": [16, 16], "content_height": 14},
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
    height = spec.height or profile["size"][1]
    angles = [0, 90, 180, 270] if spec.kind == "furniture" else [0, 180, 90]
    ground_w = spec.ground_width or width // 16
    if spec.kind == "furniture":
        if width % 16 or height % 16 or width != ground_w * 16:
            raise DomainError("Furniture canvas width must equal ground_width * 16; use tile sizes")
        background = height // 16 - spec.ground_depth
        if background < 0:
            raise DomainError("Furniture canvas must include all occupied ground rows")
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
        samples=spec.samples,
        supersampling=spec.supersampling,
        meters_per_tile=None,
        padding=0,
        elevation=spec.elevation,
        lighting="scene" if spec.shading == "scene" else "studio",
    )


def get_asset_profile(kind: str, preset: str | None = None) -> dict[str, Any]:
    if kind not in ("furniture", "character", "pet"):
        raise DomainError("Choose furniture, character, or pet")
    selected = preset or ("small" if kind == "furniture" else kind)
    if selected not in PROFILES or PROFILES[selected]["kind"] != kind:
        raise DomainError(f"Unknown {kind} preset {selected!r}")
    spec = normalize_asset(
        AssetSpec.model_validate(
            {"kind": kind, "name": "Example", "asset_id": "EXAMPLE", "preset": selected}
        )
    )
    return {
        "kind": kind,
        "preset": selected,
        "presets": [key for key, value in PROFILES.items() if value["kind"] == kind],
        "specification": spec.model_dump(),
        "layouts": asset_layouts(spec),
        "modeling": [
            "+Z is up; front faces -Y. Model near the origin with named parts.",
            "Game sizing fits the silhouette, independently of meters. Exaggerate thin features.",
            "Use broad colors and simple geometry; aim for features at least 2 pixels wide.",
            "All poses share a scale and stable framing. Keep locomotion in place.",
            "Default alignment uses the union of visible bounds. anchor_object optionally fixes a "
            "named ground-contact point near bottom-center, with 2px reserved below the anchor.",
        ],
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
            "execute_blender_python",
            "render_asset",
            "wait_for_job",
            "inspect_asset",
            "inspect_sprite",
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
