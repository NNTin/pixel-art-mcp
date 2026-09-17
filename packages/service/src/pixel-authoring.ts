/**
 * The one gap `packages/schema`'s `authoring.ts` doc comment explicitly flags and defers:
 * `PixelPose.canvas()` / `PixelDefinition.to_art()` (Python's `authoring.py`) need a real
 * `Canvas`/`PixelArt` engine, which `packages/schema` deliberately has zero dependency on.
 * `packages/service` depends on both `packages/schema` and `packages/pixel-core`, so this is the
 * integration-boundary module that wires the conversion in -- the same pattern
 * `packages/imaging/src/asset-export.ts`'s own (private, unexported) `validatedArt` helper
 * already uses for the *other* half of that same gap (the engine-level `validate_target` check
 * inside `validated_art`), mirrored here for `write_pixel_art`'s use of `validated_art` and for
 * `to_art` itself, which nothing in this repo has ported yet.
 */

import {
  Canvas,
  PixelArt,
  type AssetLayout as CoreAssetLayout,
  type PixelArtDict,
  type ViewsInput,
} from "@pixel-art-mcp/pixel-core";
import {
  AssetSpecSchema,
  DomainError,
  PixelDefinitionSchema,
  renderOptionsFrames,
  type AssetLayout,
  type DrawCommand,
  type PixelDefinition,
  type PixelDrawing,
  type PixelPose,
  type RenderOptions,
} from "@pixel-art-mcp/schema";

/** Port of `PixelDrawing.canvas()` (`src/pixel_art_mcp/drawing.py`): rasterizes numeric
 * rect/line/stamp commands (with `repeat`/`dx`/`dy` copies) onto a transparent patch via the
 * mandatory `Canvas` helpers, then mirrors if requested. */
function drawingToCanvas(drawing: PixelDrawing): Canvas {
  const canvas = new Canvas(drawing.width, drawing.height);
  for (const command of drawing.commands as DrawCommand[]) {
    for (let i = 0; i < command.repeat; i += 1) {
      const dx = command.dx * i;
      const dy = command.dy * i;
      if (command.op === "rect") {
        canvas.rect(command.x + dx, command.y + dy, command.width, command.height, command.color);
      } else if (command.op === "line") {
        canvas.line(command.x1 + dx, command.y1 + dy, command.x2 + dx, command.y2 + dy, command.color);
      } else {
        canvas.stamp(command.x + dx, command.y + dy, command.rows);
      }
    }
  }
  return drawing.mirror_x ? canvas.mirrored() : canvas;
}

/** Port of `PixelPose.canvas()`. */
function poseCanvas(pose: PixelPose): Canvas {
  if (pose.drawing !== null) return drawingToCanvas(pose.drawing);
  if (pose.rows === null) {
    // Unreachable for a pose that parsed successfully: `PixelPoseSchema`'s own refine already
    // enforces exactly one of rows/drawing (see `authoring.ts`).
    throw new Error("Invariant violated: validated pose has neither rows nor drawing");
  }
  return Canvas.fromRows(pose.rows);
}

/**
 * Port of `PixelDefinition.to_art`: builds a real, engine-validated `PixelArt` from an authored
 * definition plus the target's resolved per-angle canvases.
 */
export function definitionToArt(definition: PixelDefinition, layouts: readonly AssetLayout[]): PixelArt {
  const views: ViewsInput = Object.fromEntries(
    layouts.map((layout): [number, readonly number[]] => [layout.angle, [layout.width, layout.height]]),
  );
  const art = new PixelArt(definition.palette, views);
  for (const layer of definition.layers) {
    for (const pose of layer.poses) {
      art.layer(layer.name, pose.angle, poseCanvas(pose), {
        x: pose.x,
        y: pose.y,
        frame: pose.frame,
        min_pixels: pose.min_pixels,
        connected: pose.connected,
      });
    }
  }
  return art;
}

/**
 * Combined schema-level + engine-level port of `validated_art` (`src/pixel_art_mcp/authoring.py`):
 * `PixelDefinition.from_art` (drop a stray `views` key, then validate) is `packages/schema`'s
 * `validatedArt`'s job; `PixelArt.fromDict` + `.validateTarget` (authored poses actually match the
 * configured canvases and contain visible ink) needs `packages/pixel-core`'s real engine. Mirrors
 * `packages/imaging/src/asset-export.ts`'s identically-shaped private helper exactly, including
 * the one-try/one-`DomainError`-wrapper structure.
 */
export function validateAuthoredArt(data: Record<string, unknown>, options: RenderOptions): PixelArt {
  try {
    const { views: _views, ...rest } = data;
    PixelDefinitionSchema.parse(rest);
    const art = PixelArt.fromDict(data as unknown as PixelArtDict);
    const spec = AssetSpecSchema.parse(options.asset);
    if (!options.asset_layouts) {
      throw new Error("Render options are missing asset_layouts");
    }
    art.validateTarget(
      options.asset_layouts as unknown as CoreAssetLayout[],
      renderOptionsFrames(options),
      { outline: spec.outline, colors: spec.colors, palette: spec.palette },
    );
    return art;
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    throw new DomainError(`Invalid pixel-art definition: ${message}`);
  }
}

/**
 * Builds the tiny generated "save script" `write_pixel_art` submits through the normal
 * `submit_script` path (see that method's own doc comment on the Python side for why: "a
 * generated script uses the same worker/revision transaction as authoring edits"). Python's
 * current version (post-Blender-removal) is a 3-line script that reconstructs a `PixelArt` from
 * embedded JSON and calls `.save(scene)` -- this is the TypeScript-script equivalent, valid
 * input to `packages/engine`'s script sandbox (`export default (scene, referenceImages) => void`,
 * importing only `@pixel-art-mcp/pixel-core`, per that package's `script-runtime.ts`).
 */
export function buildSaveScript(data: PixelArtDict): string {
  const literal = JSON.stringify(JSON.stringify(data));
  return [
    'import { PixelArt } from "@pixel-art-mcp/pixel-core";',
    "",
    "export default function main(scene: Scene): void {",
    `  const art = PixelArt.fromDict(JSON.parse(${literal}));`,
    "  art.save(scene);",
    "}",
    "",
  ].join("\n");
}
