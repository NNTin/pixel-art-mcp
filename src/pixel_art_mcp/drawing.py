"""Bounded declarative commands rasterized by the mandatory native pixel helpers."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, model_validator

from pixel_art_mcp.pixel_art import Canvas

Symbol = Annotated[str, Field(pattern=r"^[A-Za-z0-9]$")]
PixelRow = Annotated[str, Field(min_length=1, max_length=512, pattern=r"^[A-Za-z0-9.]+$")]
Coordinate = Annotated[StrictInt, Field(ge=0, le=511)]
Dimension = Annotated[StrictInt, Field(ge=1, le=512)]


class PixelModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RepeatedCommand(PixelModel):
    repeat: StrictInt = Field(
        default=1, ge=1, le=128, description="Number of copies, including the first."
    )
    dx: StrictInt = Field(
        default=0, ge=-512, le=512, description="Pixel x offset added for each next copy."
    )
    dy: StrictInt = Field(
        default=0, ge=-512, le=512, description="Pixel y offset added for each next copy."
    )


class Rectangle(RepeatedCommand):
    op: Literal["rect"]
    x: Coordinate
    y: Coordinate
    width: Dimension
    height: Dimension
    color: Symbol

    def bounds(self) -> tuple[int, int, int, int]:
        return self.x, self.y, self.width, self.height

    def cost(self) -> int:
        return self.width * self.height * self.repeat


class Line(RepeatedCommand):
    """One-pixel integer line with inclusive endpoints. Use rectangles for thick posts."""

    op: Literal["line"]
    x1: Coordinate
    y1: Coordinate
    x2: Coordinate
    y2: Coordinate
    color: Symbol

    def bounds(self) -> tuple[int, int, int, int]:
        return (
            min(self.x1, self.x2),
            min(self.y1, self.y2),
            abs(self.x2 - self.x1) + 1,
            abs(self.y2 - self.y1) + 1,
        )

    def cost(self) -> int:
        return max(abs(self.x2 - self.x1), abs(self.y2 - self.y1), 0) * self.repeat + self.repeat


class Stamp(RepeatedCommand):
    """Small literal motif; dots reveal existing pixels, never erase them."""

    op: Literal["stamp"]
    x: Coordinate
    y: Coordinate
    rows: list[PixelRow] = Field(min_length=1, max_length=512)

    @model_validator(mode="after")
    def rectangular(self) -> "Stamp":
        Canvas.from_rows(self.rows)
        return self

    def bounds(self) -> tuple[int, int, int, int]:
        return self.x, self.y, len(self.rows[0]), len(self.rows)

    def cost(self) -> int:
        return len(self.rows[0]) * len(self.rows) * self.repeat


DrawCommand = Annotated[Rectangle | Line | Stamp, Field(discriminator="op")]


class PixelDrawing(PixelModel):
    """Exact integer drawing on a transparent patch, not vector rendering or resampling."""

    width: Dimension
    height: Dimension
    commands: list[DrawCommand] = Field(
        min_length=1,
        max_length=256,
        description="Paint in list order. Each command can repeat with dx/dy; all copies must fit "
        "this patch.",
    )
    mirror_x: StrictBool = Field(
        default=False,
        description="Mirror the completed patch left/right, preserving its dimensions.",
    )

    def cost(self) -> int:
        return sum(command.cost() for command in self.commands)

    def symbols(self) -> set[str]:
        return {
            symbol
            for command in self.commands
            for symbol in ("".join(command.rows) if isinstance(command, Stamp) else command.color)
            if symbol != "."
        }

    @model_validator(mode="after")
    def bounded(self) -> "PixelDrawing":
        if self.cost() > 1_048_576:
            raise ValueError("Drawing exceeds 1048576 paint operations; reduce repetition")
        for index, command in enumerate(self.commands):
            x, y, w, h = command.bounds()
            last_x, last_y = (
                x + command.dx * (command.repeat - 1),
                y + command.dy * (command.repeat - 1),
            )
            if (
                min(x, last_x, y, last_y) < 0
                or max(x, last_x) + w > self.width
                or max(y, last_y) + h > self.height
            ):
                raise ValueError(
                    f"commands[{index}] {command.op} (including repeats) exceeds "
                    f"{self.width}x{self.height} patch; use smaller coordinates/dimensions"
                )
        return self

    def canvas(self) -> Canvas:
        canvas = Canvas(self.width, self.height)
        for command in self.commands:
            for i in range(command.repeat):
                dx, dy = command.dx * i, command.dy * i
                if isinstance(command, Rectangle):
                    canvas.rect(
                        command.x + dx, command.y + dy, command.width, command.height, command.color
                    )
                elif isinstance(command, Line):
                    canvas.line(
                        command.x1 + dx,
                        command.y1 + dy,
                        command.x2 + dx,
                        command.y2 + dy,
                        command.color,
                    )
                else:
                    canvas.stamp(command.x + dx, command.y + dy, command.rows)
        return canvas.mirrored() if self.mirror_x else canvas
