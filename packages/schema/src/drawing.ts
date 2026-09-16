/**
 * Port of `src/pixel_art_mcp/drawing.py`: bounded declarative commands rasterized by the
 * mandatory native pixel helpers. The actual rasterization (`Canvas.rect`/`.line`/`.stamp`) is
 * the protected core ported in Phase 3 (`packages/pixel-core`, per `docs/typescript-rewrite.md`)
 * -- this module only re-implements the *shape* checks that the authoring contract itself
 * depends on at parse time: `Canvas.from_rows`'s "rows must form a rectangle" check (used by
 * `Stamp.rectangular` and, via `authoring.ts`, `PixelPose.rectangular`), and `PixelDrawing`'s
 * pure-arithmetic cost/bounds accounting (`cost()`, `symbols()`, `bounded()`), none of which
 * require actually painting pixels.
 */

import { z } from "zod";
import {
  addPydanticIssue,
  arrayField,
  intField,
  literalField,
  patternMessage,
  stringField,
  modelObject,
  taggedUnion,
  valueError,
} from "./errors.js";

export const SYMBOL_PATTERN = /^[A-Za-z0-9]$/;
export const PIXEL_ROW_PATTERN = /^[A-Za-z0-9.]+$/;

/** `Symbol = Annotated[str, Field(pattern=r"^[A-Za-z0-9]$")]` */
export const Symbol = stringField({ pattern: SYMBOL_PATTERN, patternText: "^[A-Za-z0-9]$" });

/** `PixelRow = Annotated[str, Field(min_length=1, max_length=512, pattern=r"^[A-Za-z0-9.]+$")]` */
export const PixelRow = stringField({
  minLength: 1,
  maxLength: 512,
  pattern: PIXEL_ROW_PATTERN,
  patternText: "^[A-Za-z0-9.]+$",
});

/** `Coordinate = Annotated[StrictInt, Field(ge=0, le=511)]` */
export const Coordinate = intField({ ge: 0, le: 511 });

/** `Dimension = Annotated[StrictInt, Field(ge=1, le=512)]` */
export const Dimension = intField({ ge: 1, le: 512 });

/**
 * Reproduces `Canvas.from_rows`'s rectangle-shape check (`src/pixel_art_mcp/pixel_art.py`):
 * the actual `Canvas` class is ported in Phase 3, but this one check is invoked directly from
 * the authoring contract's own validators (`Stamp.rectangular`, `PixelPose.rectangular`), so it
 * has to be reproduced here rather than deferred.
 */
export function rectangularRowsError(rows: readonly string[]): string | null {
  if (rows.length === 0 || rows[0]?.length === 0) {
    return "Pixel rows must form a nonempty rectangle; row 0 must not be empty";
  }
  const width = rows[0]?.length ?? 0;
  const bad: [number, number][] = [];
  rows.forEach((row, i) => {
    if (row.length !== width) bad.push([i, row.length]);
  });
  if (bad.length > 0) {
    const details = bad
      .slice(0, 8)
      .map(([i, n]) => `row ${i}: expected ${width}, actual ${n}`)
      .join("; ");
    const remaining = bad.length > 8 ? `; ${bad.length - 8} more mismatched rows` : "";
    return (
      `Pixel rows must form a nonempty rectangle. ${details}${remaining}. ` +
      "Row indices are zero-based; use numeric drawing commands for long shapes."
    );
  }
  return null;
}

/** `RepeatedCommand(PixelModel)` */
const repeatedCommandShape = {
  repeat: intField({ ge: 1, le: 128, description: "Number of copies, including the first." }).default(1),
  dx: intField({ ge: -512, le: 512, description: "Pixel x offset added for each next copy." }).default(0),
  dy: intField({ ge: -512, le: 512, description: "Pixel y offset added for each next copy." }).default(0),
};

export interface RepeatedCommandBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const RectangleSchema = modelObject({
  ...repeatedCommandShape,
  op: literalField(["rect"] as const),
  x: Coordinate,
  y: Coordinate,
  width: Dimension,
  height: Dimension,
  color: Symbol,
});
export type Rectangle = z.infer<typeof RectangleSchema>;

export function rectangleBounds(r: Rectangle): RepeatedCommandBounds {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}
export function rectangleCost(r: Rectangle): number {
  return r.width * r.height * r.repeat;
}

export const LineSchema = modelObject({
  ...repeatedCommandShape,
  op: literalField(["line"] as const),
  x1: Coordinate,
  y1: Coordinate,
  x2: Coordinate,
  y2: Coordinate,
  color: Symbol,
});
export type Line = z.infer<typeof LineSchema>;

export function lineBounds(l: Line): RepeatedCommandBounds {
  return {
    x: Math.min(l.x1, l.x2),
    y: Math.min(l.y1, l.y2),
    width: Math.abs(l.x2 - l.x1) + 1,
    height: Math.abs(l.y2 - l.y1) + 1,
  };
}
export function lineCost(l: Line): number {
  return Math.max(Math.abs(l.x2 - l.x1), Math.abs(l.y2 - l.y1), 0) * l.repeat + l.repeat;
}

export const StampSchema = modelObject(
  {
    ...repeatedCommandShape,
    op: literalField(["stamp"] as const),
    x: Coordinate,
    y: Coordinate,
    rows: arrayField(PixelRow, { minLength: 1, maxLength: 512 }),
  },
  (value, ctx) => {
    const error = rectangularRowsError(value.rows);
    if (error) valueError(ctx, error);
  },
);
export type Stamp = z.infer<typeof StampSchema>;

export function stampBounds(s: Stamp): RepeatedCommandBounds {
  return { x: s.x, y: s.y, width: s.rows[0]?.length ?? 0, height: s.rows.length };
}
export function stampCost(s: Stamp): number {
  return (s.rows[0]?.length ?? 0) * s.rows.length * s.repeat;
}

export type DrawCommand = Rectangle | Line | Stamp;

export const DrawCommandSchema = taggedUnion("op", {
  rect: RectangleSchema,
  line: LineSchema,
  stamp: StampSchema,
});

export function commandBounds(command: DrawCommand): RepeatedCommandBounds {
  switch (command.op) {
    case "rect":
      return rectangleBounds(command);
    case "line":
      return lineBounds(command);
    case "stamp":
      return stampBounds(command);
  }
}

export function commandCost(command: DrawCommand): number {
  switch (command.op) {
    case "rect":
      return rectangleCost(command);
    case "line":
      return lineCost(command);
    case "stamp":
      return stampCost(command);
  }
}

/** `PixelDrawing(PixelModel)` */
export const PixelDrawingSchema = modelObject(
  {
    width: Dimension,
    height: Dimension,
    commands: arrayField(DrawCommandSchema, {
      minLength: 1,
      maxLength: 256,
      description:
        "Paint in list order. Each command can repeat with dx/dy; all copies must fit " +
        "this patch.",
    }),
    mirror_x: z
      .boolean()
      .default(false)
      .describe("Mirror the completed patch left/right, preserving its dimensions."),
  },
  (value, ctx) => {
    const error = boundedDrawingError(value);
    if (error) valueError(ctx, error);
  },
);
export type PixelDrawing = z.infer<typeof PixelDrawingSchema>;

export function pixelDrawingCost(drawing: PixelDrawing): number {
  return (drawing.commands as DrawCommand[]).reduce((sum, c) => sum + commandCost(c), 0);
}

export function pixelDrawingSymbols(drawing: PixelDrawing): Set<string> {
  const symbols = new Set<string>();
  for (const command of drawing.commands as DrawCommand[]) {
    const chars = command.op === "stamp" ? command.rows.join("").split("") : [command.color];
    for (const symbol of chars) {
      if (symbol !== ".") symbols.add(symbol);
    }
  }
  return symbols;
}

function boundedDrawingError(drawing: PixelDrawing): string | null {
  if (pixelDrawingCost(drawing) > 1_048_576) {
    return "Drawing exceeds 1048576 paint operations; reduce repetition";
  }
  const commands = drawing.commands as DrawCommand[];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    if (!command) continue;
    const { x, y, width: w, height: h } = commandBounds(command);
    const lastX = x + command.dx * (command.repeat - 1);
    const lastY = y + command.dy * (command.repeat - 1);
    if (
      Math.min(x, lastX, y, lastY) < 0 ||
      Math.max(x, lastX) + w > drawing.width ||
      Math.max(y, lastY) + h > drawing.height
    ) {
      return (
        `commands[${index}] ${command.op} (including repeats) exceeds ` +
        `${drawing.width}x${drawing.height} patch; use smaller coordinates/dimensions`
      );
    }
  }
  return null;
}

// Re-exported so callers that only need the literal wording (e.g. tests) don't need to import
// the Zod-issue-shaped helper from errors.ts directly.
export { patternMessage, addPydanticIssue };
