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


class RenderOptions(Model):
    width: int = Field(default=64, ge=8, le=512)
    height: int = Field(default=64, ge=8, le=512)
    angles: list[float] = Field(
        default=[0, 45, 90, 135, 180, 225, 270, 315], min_length=1, max_length=32
    )
    elevation: float = Field(default=35.264, ge=-85, le=85)
    frame_start: int = Field(default=1, ge=0, le=100_000)
    frame_end: int = Field(default=1, ge=0, le=100_000)
    frame_step: int = Field(default=1, ge=1)
    fps: int = Field(default=12, ge=1, le=120)
    colors: int = Field(default=32, ge=2, le=255)
    palette: list[str] | None = Field(default=None, min_length=2, max_length=255)
    supersampling: int = Field(default=4, ge=1, le=4)
    alpha_threshold: int = Field(default=128, ge=1, le=255)
    samples: int = Field(default=32, ge=1, le=256)
    lighting: Literal["studio", "scene"] = "studio"
    padding: float = Field(default=0.1, ge=0, le=0.5)

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
        return self

    def frames(self) -> list[int]:
        return list(range(self.frame_start, self.frame_end + 1, self.frame_step))


ProjectName = Annotated[str, Field(min_length=1, max_length=120)]
