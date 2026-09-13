"""Public, typed pixel authoring contract. Blender uses the stdlib-only helper."""

from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, model_validator

from pixel_art_mcp.models import AssetSpec, DomainError, Model
from pixel_art_mcp.pixel_art import Canvas, PixelArt

AUTHORING_VERSION = 1
Symbol = Annotated[str, Field(pattern=r"^[A-Za-z0-9]$")]
Color = Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")]
PixelRow = Annotated[str, Field(min_length=1, max_length=512, pattern=r"^[A-Za-z0-9.]+$")]


class PixelModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PixelPose(PixelModel):
    """One view/frame patch. Dots reveal lower layers; rows are not resampled."""

    angle: Literal[0, 90, 180, 270] = Field(
        description="0 front/down, 90 right, 180 back/up, 270 left. Use only configured views."
    )
    rows: list[PixelRow] = Field(
        min_length=1,
        max_length=512,
        description="Equal-width pixel rows, top to bottom. Letters/digits refer to palette "
        "symbols; '.' is transparent. A transparent pose explicitly hides a layer.",
    )
    frame: StrictInt | None = Field(
        default=None,
        ge=0,
        le=100_000,
        description="Source frame, not playback index. null is this view's default; an exact "
        "frame replaces the entire default patch. Without a default, unspecified "
        "frames hide the layer.",
    )
    x: StrictInt = Field(
        default=0,
        ge=-512,
        le=512,
        description="Native pixel column of the patch's top-left. With anchor, offset from its "
        "projected object origin.",
    )
    y: StrictInt = Field(
        default=0,
        ge=-512,
        le=512,
        description="Native pixel row of the patch's top-left; positive goes down. With "
        "anchor, offset from its projected object origin.",
    )
    anchor: str | None = Field(
        default=None,
        min_length=1,
        max_length=120,
        description="Hybrid render mode only: existing Blender object name. Screen-space "
        "overlay follows its origin, not its rotation/scale, and is not "
        "depth-tested.",
    )
    min_pixels: StrictInt = Field(
        default=0,
        ge=0,
        le=262_144,
        description="Advisory minimum pixels still visible after compositing all layers. Use "
        "for identifying details. A failed budget is an inspection finding, not a "
        "structural error.",
    )
    connected: StrictBool = Field(
        default=False,
        description="Require one four-connected visible cluster as an advisory feature check. "
        "False permits separated shapes such as a pair of eyes.",
    )

    @model_validator(mode="after")
    def rectangular(self) -> "PixelPose":
        Canvas.from_rows(self.rows)
        return self


class PixelLayer(PixelModel):
    """Stable name plus complete per-view poses. Document order is back to front."""

    name: str = Field(
        min_length=1,
        max_length=100,
        description="Unique layer name, e.g. barrel, faucet, gauge, rain. Retain names when "
        "editing.",
    )
    poses: list[PixelPose] = Field(
        min_length=1,
        max_length=256,
        description="At most one pose per (angle, frame), including a possible null-frame "
        "default for each view.",
    )

    @model_validator(mode="after")
    def unique_poses(self) -> "PixelLayer":
        if len({(p.angle, p.frame) for p in self.poses}) != len(self.poses):
            raise ValueError("Duplicate (angle, frame) poses in layer " + self.name)
        return self


class PixelDefinition(PixelModel):
    """Complete editable source; write replaces it atomically, never merges it."""

    version: Literal[1] = 1
    base: Literal["native", "render"] = Field(
        default="native",
        description="native draws the complete sprite through pixel helpers. render uses "
        "Blender geometry beneath pixel overlays; prepare geometry with "
        "execute_blender_python first. Both require this definition.",
    )
    palette: dict[Symbol, Color] = Field(
        min_length=2,
        max_length=64,
        description="Distinct symbol-to-#RRGGBB colors, e.g. {D: #293039, G: #f3cf65}. Must "
        "fit configure_asset.colors and match configure_asset.palette if supplied. "
        "This is the whole job's authoritative palette.",
    )
    layers: list[PixelLayer] = Field(
        min_length=1,
        max_length=128,
        description="Complete ordered layer list, painted back to front. Omitted old layers "
        "are deleted. Separate a static body from small animated patches; "
        "views/dimensions come from configure_asset, not this document.",
    )

    @model_validator(mode="after")
    def valid_document(self) -> "PixelDefinition":
        if len({layer.name for layer in self.layers}) != len(self.layers):
            raise ValueError("Layer names must be unique")
        if len({color.lower() for color in self.palette.values()}) != len(self.palette):
            raise ValueError("Palette colors must be distinct")
        pixels = 0
        for layer in self.layers:
            for pose in layer.poses:
                if pose.anchor is not None and self.base != "render":
                    raise ValueError("Object anchors require base=render")
                pixels += sum(map(len, pose.rows))
                if any(
                    symbol != "." and symbol not in self.palette
                    for row in pose.rows
                    for symbol in row
                ):
                    raise ValueError(f"Unknown palette symbol in layer {layer.name!r}")
        if pixels > 262_144:
            raise ValueError("Definition exceeds 262144 authored pixel cells; reuse default poses")
        return self

    def to_art(self, layouts: list[dict[str, Any]]) -> PixelArt:
        art = PixelArt(
            self.palette, {v["angle"]: (v["width"], v["height"]) for v in layouts}, base=self.base
        )
        for layer in self.layers:
            for pose in layer.poses:
                art.layer(
                    layer.name,
                    canvas=Canvas.from_rows(pose.rows),
                    **pose.model_dump(exclude={"rows"}),
                )
        return art

    @classmethod
    def from_art(cls, data: dict[str, Any]) -> "PixelDefinition":
        return cls.model_validate({k: v for k, v in data.items() if k != "views"})


class PixelArtSource(Model):
    """Resumable source. Send only definition back to write_pixel_art."""

    contract_version: Literal[1] = 1
    project_id: UUID
    revision_id: UUID
    definition: PixelDefinition
    authored_views: dict[str, list[int]] = Field(
        description="Canvas dimensions saved with this revision. Reconfiguration may require "
        "adapting the definition before rendering."
    )
    configuration_id: UUID | None


def validated_art(data: dict[str, Any], options: dict[str, Any]) -> PixelArt:
    try:
        PixelDefinition.from_art(data)
        art = PixelArt.from_dict(data)
        spec = AssetSpec.model_validate(options["asset"])
        art.validate_target(options["asset_layouts"], options["frame_sequence"], spec.model_dump())
        return art
    except (ValueError, KeyError, TypeError) as exc:
        raise DomainError(f"Invalid pixel-art definition: {exc}") from exc
