from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    schema_version: Literal[1] = 1


class DomainError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


class Project(Model):
    id: UUID
    name: str
    created_at: str
    current_revision_id: UUID | None = None


class Artifact(Model):
    id: UUID
    project_id: UUID
    job_id: UUID | None = None
    kind: str
    filename: str
    media_type: str
    size_bytes: int
    width: int | None = None
    height: int | None = None
    download_url: str = ""


class Reference(Model):
    id: UUID
    project_id: UUID
    filename: str
    width: int
    height: int
    sha256: str
    original_artifact_id: UUID
    image_artifact_id: UUID
    thumbnail_artifact_id: UUID
    blender_path: str


class Revision(Model):
    id: UUID
    project_id: UUID
    parent_id: UUID | None
    created_at: str
    blend_artifact_id: UUID
    script_artifact_id: UUID
    summary: dict[str, Any]


class ProjectDetail(Model):
    project: Project
    references: list[Reference]
    revisions: list[Revision]


class Job(Model):
    id: UUID
    project_id: UUID
    operation: Literal["script", "preview", "sprites"]
    input_revision_id: UUID | None
    status: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None
    progress: float = 0
    stage: str = "queued"
    logs: str = ""
    error: str | None = None
    result_revision_id: UUID | None = None
    artifacts: list[Artifact] = []


class OpenAIFile(BaseModel):
    """Keep optional properties non-nullable in the advertised file schema."""

    model_config = ConfigDict(extra="forbid")
    download_url: str
    file_id: str
    mime_type: str = ""
    file_name: str = ""


class PixelAgentsOptions(Model):
    """An installable furniture folder for the unmodified pixel-agents application."""

    asset_id: str = Field(pattern=r"^[A-Z][A-Z0-9_]{0,63}$", description="Stable ID, e.g. OIL_LAMP")
    name: str = Field(min_length=1, max_length=120, description="Furniture label in the editor")
    category: Literal["desks", "chairs", "storage", "decor", "electronics", "wall", "misc"] = (
        "decor"
    )
    footprint_w: int | None = Field(
        default=None,
        ge=1,
        le=32,
        description="Occupied grid columns; defaults to ceil(sprite width / 16), not a resize",
    )
    footprint_h: int | None = Field(
        default=None,
        ge=1,
        le=32,
        description="Occupied grid rows; defaults to ceil(sprite height / 16), not a resize",
    )
    can_place_on_surfaces: bool = False
    can_place_on_walls: bool = False
    background_tiles: int = Field(default=0, ge=0, le=31)
    off_frame: int | None = Field(
        default=None,
        ge=0,
        le=100_000,
        description="Required for animation: source pose for the idle/off PNG. On frames use the "
        "normal frame range. pixel-agents only cycles on-state frames near an active agent.",
    )


class RenderState(Model):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{0,23}$")
    name: str = Field(min_length=1, max_length=48)
    frame_start: int = Field(ge=0, le=100_000)
    frame_end: int = Field(ge=0, le=100_000)
    frame_step: int = Field(default=1, ge=1)
    off_frame: int | None = Field(default=None, ge=0, le=100_000)

    @model_validator(mode="after")
    def ordered_range(self) -> "RenderState":
        if self.frame_end < self.frame_start:
            raise ValueError("State frame_end must be >= frame_start")
        return self

    def frames(self) -> list[int]:
        return list(range(self.frame_start, self.frame_end + 1, self.frame_step))


class RenderOptions(Model):
    states: list[RenderState] | None = Field(
        default=None,
        min_length=1,
        max_length=16,
        description="Named fill/appearance states with their own animation and idle frames. "
        "Overrides the top-level frame range. Uses one camera/palette, generates a comparison "
        "player and separate pixel-agents variants with asset IDs suffixed by state ID.",
    )
    tile_width: int = Field(
        default=1,
        strict=True,
        ge=1,
        le=32,
        description="Sprite canvas width in 16px tiles: 1=small/tall (16px), 2=wide (32px).",
    )
    tile_height: int = Field(
        default=1,
        strict=True,
        ge=1,
        le=32,
        description="Sprite canvas height in 16px tiles: 1=small (16px), 2=tall (32px), 3=48px.",
    )
    width: int = Field(
        default=16,
        ge=8,
        le=512,
        description="Explicit pixel width overrides tile_width; non-multiples of 16 are allowed.",
    )
    height: int = Field(
        default=16,
        ge=8,
        le=512,
        description="Explicit pixel height overrides tile_height; non-multiples of 16 are allowed.",
    )
    angles: list[float] = Field(
        default=[0, 90, 180, 270],
        min_length=1,
        max_length=32,
        description="Camera views in degrees. pixel-agents: 0=front, 90=right, 180=back, 270=left.",
    )
    elevation: float = Field(default=35.264, ge=-85, le=85)
    frame_start: int = Field(default=1, ge=0, le=100_000)
    frame_end: int = Field(default=1, ge=0, le=100_000)
    frame_step: int = Field(default=1, ge=1)
    fps: int = Field(
        default=5,
        ge=1,
        le=120,
        description="Playback rate. pixel-agents exports require exactly 5 fps (fixed in the app).",
    )
    colors: int = Field(default=32, ge=2, le=255)
    palette: list[str] | None = Field(default=None, min_length=2, max_length=255)
    downscale_mode: Literal["crisp", "average"] = Field(
        default="crisp",
        description="crisp derives the shared palette from supersampled source colors before "
        "mapping averaged target pixels, avoiding muddy colors invented by downscaling. average "
        "retains the legacy behavior of deriving the palette after BOX downscaling.",
    )
    supersampling: int = Field(
        default=4,
        ge=1,
        le=4,
        description="Render at this multiple of the export dimensions. Values 2–4 also supply a "
        "genuine higher-resolution reference in preview.html; 1 disables that comparison.",
    )
    alpha_threshold: int = Field(default=128, ge=1, le=255)
    samples: int = Field(default=32, ge=1, le=256)
    lighting: Literal["studio", "scene"] = "studio"
    padding: float = Field(default=0.1, ge=0, le=0.5)
    pixel_agents: PixelAgentsOptions | None = Field(
        default=None,
        description="Enable an installable pixel-agents furniture manifest + PNG package. "
        "Requires cardinal angles and 5 fps; animations require an off_frame.",
    )

    @model_validator(mode="before")
    @classmethod
    def tile_dimensions(cls, values: Any) -> Any:
        if isinstance(values, dict):
            values = dict(values)
            for axis in ("width", "height"):
                tile = values.get(f"tile_{axis}", 1)
                if axis not in values and isinstance(tile, int) and not isinstance(tile, bool):
                    values[axis] = tile * 16
        return values

    @field_validator("angles")
    @classmethod
    def normalize_angles(cls, values: list[float]) -> list[float]:
        import math

        if any(not math.isfinite(v) for v in values):
            raise ValueError("Angles must be finite")
        values = [round(v % 360, 6) for v in values]
        if len(set(values)) != len(values):
            raise ValueError("Angles must be distinct modulo 360")
        return values

    @field_validator("palette")
    @classmethod
    def validate_palette(cls, values: list[str] | None) -> list[str] | None:
        import re

        if values is not None:
            if any(not re.fullmatch(r"#[0-9a-fA-F]{6}", value) for value in values):
                raise ValueError("Palette colors must be #RRGGBB")
            if len(set(v.lower() for v in values)) != len(values):
                raise ValueError("Palette colors must be distinct")
        return values

    @model_validator(mode="after")
    def frame_range(self) -> "RenderOptions":
        if self.frame_end < self.frame_start:
            raise ValueError("frame_end must be >= frame_start")
        if self.states:
            if len({state.id for state in self.states}) != len(self.states):
                raise ValueError("State IDs must be distinct")
            if len({len(state.frames()) for state in self.states}) != 1:
                raise ValueError("States must have the same number of animation frames")
        if self.pixel_agents:
            if self.fps != 5:
                raise ValueError("pixel-agents furniture playback is fixed at 5 fps")
            if any(angle not in (0, 90, 180, 270) for angle in self.angles):
                raise ValueError("pixel-agents supports only 0/front, 90/right, 180/back, 270/left")
            if self.states:
                if self.pixel_agents.off_frame is not None:
                    raise ValueError("Use each state's off_frame for named-state exports")
                for state in self.states:
                    if len(state.frames()) > 1 and state.off_frame is None:
                        raise ValueError("Each animated pixel-agents state requires off_frame")
                    if len(f"{self.pixel_agents.asset_id}_{state.id}") > 64:
                        raise ValueError(
                            "Combined pixel-agents asset and state ID exceeds 64 chars"
                        )
                    if len(f"{self.pixel_agents.name} — {state.name}") > 120:
                        raise ValueError(
                            "Combined pixel-agents asset and state name exceeds 120 chars"
                        )
            elif len(self.frames()) > 1 and self.pixel_agents.off_frame is None:
                raise ValueError("pixel-agents animation requires off_frame for the idle/off state")
            footprint_h = self.pixel_agents.footprint_h or ((self.height + 15) // 16)
            if self.pixel_agents.background_tiles >= footprint_h:
                raise ValueError(
                    "background_tiles must be smaller than the furniture footprint height"
                )
        return self

    def frames(self) -> list[int]:
        if self.states:
            return list(dict.fromkeys(frame for state in self.states for frame in state.frames()))
        return list(range(self.frame_start, self.frame_end + 1, self.frame_step))

    def render_frames(self) -> list[int]:
        frames = self.frames()
        off = self.pixel_agents.off_frame if self.pixel_agents else None
        if off is not None and off not in frames:
            frames.append(off)
        for state in self.states or []:
            if state.off_frame is not None and state.off_frame not in frames:
                frames.append(state.off_frame)
        return frames


ProjectName = Annotated[str, Field(min_length=1, max_length=120)]
