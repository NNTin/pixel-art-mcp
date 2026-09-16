"""Public, typed pixel authoring contract. The engine runner uses the stdlib-only helper."""

from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import Field, StrictBool, StrictInt, model_validator

from pixel_art_mcp.drawing import PixelDrawing, PixelModel, PixelRow, Symbol
from pixel_art_mcp.models import AssetSpec, DomainError, Model
from pixel_art_mcp.pixel_art import Canvas, PixelArt

AUTHORING_VERSION = 1
Color = Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")]


class PixelPose(PixelModel):
    """One view/frame patch. Dots reveal lower layers; rows are not resampled."""

    angle: Literal[0, 90, 180, 270] = Field(
        description="0 front/down, 90 right, 180 back/up, 270 left. Use only configured views."
    )
    rows: list[PixelRow] | None = Field(
        default=None,
        min_length=1,
        max_length=512,
        description="Equal-width pixel rows, top to bottom. Letters/digits refer to palette "
        "symbols; '.' is transparent. Supply exactly one of rows or drawing. Prefer drawing "
        "for large shapes; literal rows are suited to small motifs.",
    )
    drawing: PixelDrawing | None = Field(
        default=None,
        description="Numeric rect/line/stamp commands using mandatory Canvas helpers. Alternative "
        "to rows, not additional pixels. Source reads return canonical raster rows.",
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
        description="Native pixel column of the patch's top-left.",
    )
    y: StrictInt = Field(
        default=0,
        ge=-512,
        le=512,
        description="Native pixel row of the patch's top-left; positive goes down.",
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
        if (self.rows is None) == (self.drawing is None):
            raise ValueError("Supply exactly one of rows or drawing")
        if self.rows is not None:
            Canvas.from_rows(self.rows)
        return self

    def canvas(self) -> Canvas:
        if self.drawing is not None:
            return self.drawing.canvas()
        assert self.rows is not None
        return Canvas.from_rows(self.rows)


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
        paint_operations = 0
        for layer in self.layers:
            for pose in layer.poses:
                if pose.drawing is not None:
                    pixels += pose.drawing.width * pose.drawing.height
                    paint_operations += pose.drawing.cost()
                    symbols = pose.drawing.symbols()
                else:
                    assert pose.rows is not None
                    pixels += sum(map(len, pose.rows))
                    symbols = set("".join(pose.rows)) - {"."}
                if symbols - self.palette.keys():
                    raise ValueError(f"Unknown palette symbol in layer {layer.name!r}")
        if pixels > 262_144:
            raise ValueError("Definition exceeds 262144 authored pixel cells; reuse default poses")
        if paint_operations > 1_048_576:
            raise ValueError("Definition exceeds 1048576 drawing paint operations")
        return self

    def to_art(self, layouts: list[dict[str, Any]]) -> PixelArt:
        art = PixelArt(self.palette, {v["angle"]: (v["width"], v["height"]) for v in layouts})
        for layer in self.layers:
            for pose in layer.poses:
                art.layer(
                    layer.name,
                    canvas=pose.canvas(),
                    **pose.model_dump(exclude={"rows", "drawing"}),
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


class PoseTarget(PixelModel):
    layer: str = Field(min_length=1, max_length=100, description="Existing, exact layer name.")
    angle: Literal[0, 90, 180, 270]
    frame: StrictInt | None = Field(
        ge=0,
        le=100_000,
        description="Exact stored pose key. null selects the view default, not all frames.",
    )


class MovePose(PoseTarget):
    """Move one existing patch without resending rows or changing any other property."""

    op: Literal["move_pose"]
    x: StrictInt = Field(ge=-512, le=512, description="New absolute native x, not a delta.")
    y: StrictInt = Field(ge=-512, le=512, description="New absolute native y, not a delta.")


class SetPose(PixelModel):
    """Replace an exact pose in place, or append it; the named layer must already exist."""

    op: Literal["set_pose"]
    layer: str = Field(min_length=1, max_length=100)
    pose: PixelPose = Field(
        description="Complete patch. Omitted properties use PixelPose defaults."
    )


class DeletePose(PoseTarget):
    """Delete an exact stored pose. Deleting an override may reveal its view default."""

    op: Literal["delete_pose"]


class SetLayer(PixelModel):
    """Replace a named layer at its current order, or append a new topmost layer."""

    op: Literal["set_layer"]
    layer: PixelLayer = Field(description="Complete layer; omitted previous poses are deleted.")


class DeleteLayer(PixelModel):
    """Delete an existing named layer. Missing targets fail the entire edit batch."""

    op: Literal["delete_layer"]
    name: str = Field(min_length=1, max_length=100)


class SetPalette(PixelModel):
    """Replace the palette; all retained poses must use symbols from the final palette."""

    op: Literal["set_palette"]
    palette: dict[Symbol, Color] = Field(min_length=2, max_length=64)


PixelEdit = Annotated[
    MovePose | SetPose | DeletePose | SetLayer | DeleteLayer | SetPalette,
    Field(discriminator="op"),
]
PixelEdits = Annotated[
    list[PixelEdit],
    Field(
        min_length=1,
        max_length=128,
        description="Ordered atomic operations; only the final document is validated.",
    ),
]


def apply_pixel_edits(definition: PixelDefinition, edits: PixelEdits) -> PixelDefinition:
    """Work on a detached document so any failure leaves the original source untouched."""
    data = definition.model_dump()
    layers = data["layers"]
    for index, edit in enumerate(edits):
        if isinstance(edit, SetPalette):
            data["palette"] = dict(edit.palette)
            continue
        if isinstance(edit, SetLayer):
            name = edit.layer.name
        elif isinstance(edit, DeleteLayer):
            name = edit.name
        else:
            name = edit.layer
        layer_index = next((i for i, layer in enumerate(layers) if layer["name"] == name), None)
        if isinstance(edit, SetLayer):
            if layer_index is None:
                layers.append(edit.layer.model_dump())
            else:
                layers[layer_index] = edit.layer.model_dump()
            continue
        if layer_index is None:
            raise ValueError(f"edits[{index}] {edit.op}: unknown layer {name!r}")
        if isinstance(edit, DeleteLayer):
            layers.pop(layer_index)
            continue
        poses = layers[layer_index]["poses"]
        target = edit.pose if isinstance(edit, SetPose) else edit
        pose_index = next(
            (
                i
                for i, pose in enumerate(poses)
                if (pose["angle"], pose["frame"]) == (target.angle, target.frame)
            ),
            None,
        )
        if isinstance(edit, SetPose):
            if pose_index is None:
                poses.append(edit.pose.model_dump())
            else:
                poses[pose_index] = edit.pose.model_dump()
        elif pose_index is None:
            raise ValueError(
                f"edits[{index}] {edit.op}: no stored pose ({target.angle}, {target.frame}) "
                f"in {name!r}; defaults are not implicit edit targets"
            )
        elif isinstance(edit, DeletePose):
            poses.pop(pose_index)
        else:
            poses[pose_index].update(x=edit.x, y=edit.y)
    return PixelDefinition.model_validate(data)


def validated_art(data: dict[str, Any], options: dict[str, Any]) -> PixelArt:
    try:
        PixelDefinition.from_art(data)
        art = PixelArt.from_dict(data)
        spec = AssetSpec.model_validate(options["asset"])
        art.validate_target(options["asset_layouts"], options["frame_sequence"], spec.model_dump())
        return art
    except (ValueError, KeyError, TypeError) as exc:
        raise DomainError(f"Invalid pixel-art definition: {exc}") from exc
