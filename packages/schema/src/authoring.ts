/**
 * Port of `src/pixel_art_mcp/authoring.py`: the versioned pixel authoring contract. The
 * `PixelPose.canvas()`/`PixelDefinition.to_art()`/`from_art()` methods that build a real
 * `PixelArt` (from `pixel_art.py`) are Phase-3 (`packages/pixel-core`) territory and are not
 * ported here -- see the note on `validatedArt` below for the one place that boundary shows up.
 */

import { z } from "zod";
import {
  arrayField,
  DomainError,
  intField,
  literalField,
  modelObject,
  recordField,
  stringField,
  taggedUnion,
  uuidField,
  valueError,
} from "./errors.js";
import {
  PixelDrawingSchema,
  pixelDrawingCost,
  pixelDrawingSymbols,
  rectangularRowsError,
  SYMBOL_PATTERN,
  PixelRow,
} from "./drawing.js";
import { AssetSpecSchema } from "./models.js";

export const AUTHORING_VERSION = 1;

/** `Color = Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")]` */
export const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
export const ColorSchema = stringField({
  pattern: COLOR_PATTERN,
  patternText: "^#[0-9a-fA-F]{6}$",
});

const ANGLE_VALUES = [0, 90, 180, 270] as const;
export type Angle = (typeof ANGLE_VALUES)[number];
export const AngleSchema = literalField(ANGLE_VALUES);

/** Formats a nullable int the way an f-string interpolates it in Python: `None`, not `null`. */
function pyNone(value: number | null): string {
  return value === null ? "None" : String(value);
}

/** Formats a Python `!r` string repr closely enough for these error messages' purposes. */
function pyRepr(value: string): string {
  if (value.includes("'") && !value.includes('"')) return `"${value}"`;
  return `'${value.replace(/'/g, "\\'")}'`;
}

/** `PixelPose(PixelModel)` */
export const PixelPoseSchema = modelObject(
  {
    angle: AngleSchema.describe(
      "0 front/down, 90 right, 180 back/up, 270 left. Use only configured views.",
    ),
    rows: arrayField(PixelRow, {
      minLength: 1,
      maxLength: 512,
      description:
        "Equal-width pixel rows, top to bottom. Letters/digits refer to palette " +
        "symbols; '.' is transparent. Supply exactly one of rows or drawing. Prefer drawing " +
        "for large shapes; literal rows are suited to small motifs.",
    })
      .nullable()
      .default(null),
    drawing: PixelDrawingSchema.describe(
      "Numeric rect/line/stamp commands using mandatory Canvas helpers. Alternative " +
        "to rows, not additional pixels. Source reads return canonical raster rows.",
    )
      .nullable()
      .default(null),
    frame: intField({
      ge: 0,
      le: 100_000,
      description:
        "Source frame, not playback index. null is this view's default; an exact " +
        "frame replaces the entire default patch. Without a default, unspecified " +
        "frames hide the layer.",
    })
      .nullable()
      .default(null),
    x: intField({
      ge: -512,
      le: 512,
      description: "Native pixel column of the patch's top-left.",
    }).default(0),
    y: intField({
      ge: -512,
      le: 512,
      description: "Native pixel row of the patch's top-left; positive goes down.",
    }).default(0),
    min_pixels: intField({
      ge: 0,
      le: 262_144,
      description:
        "Advisory minimum pixels still visible after compositing all layers. Use " +
        "for identifying details. A failed budget is an inspection finding, not a " +
        "structural error.",
    }).default(0),
    connected: z
      .boolean()
      .default(false)
      .describe(
        "Require one four-connected visible cluster as an advisory feature check. " +
          "False permits separated shapes such as a pair of eyes.",
      ),
  },
  (value, ctx) => {
    if ((value.rows === null) === (value.drawing === null)) {
      valueError(ctx, "Supply exactly one of rows or drawing");
      return;
    }
    if (value.rows !== null) {
      const error = rectangularRowsError(value.rows);
      if (error) valueError(ctx, error);
    }
  },
);
export type PixelPose = z.infer<typeof PixelPoseSchema>;

/** `PixelLayer(PixelModel)` */
export const PixelLayerSchema = modelObject(
  {
    name: stringField({
      minLength: 1,
      maxLength: 100,
      description:
        "Unique layer name, e.g. barrel, faucet, gauge, rain. Retain names when editing.",
    }),
    poses: arrayField(PixelPoseSchema, {
      minLength: 1,
      maxLength: 256,
      description:
        "At most one pose per (angle, frame), including a possible null-frame " +
        "default for each view.",
    }),
  },
  (value, ctx) => {
    const seen = new Set<string>();
    for (const pose of value.poses) {
      const key = `${String(pose.angle)}:${String(pose.frame)}`;
      seen.add(key);
    }
    if (seen.size !== value.poses.length) {
      valueError(ctx, `Duplicate (angle, frame) poses in layer ${value.name}`);
    }
  },
);
export type PixelLayer = z.infer<typeof PixelLayerSchema>;

/** `PixelDefinition(PixelModel)` */
export const PixelDefinitionSchema = modelObject(
  {
    version: literalField([1] as const).default(1),
    palette: recordField(ColorSchema, {
      minLength: 2,
      maxLength: 64,
      keyPattern: SYMBOL_PATTERN,
      keyPatternText: "^[A-Za-z0-9]$",
      description:
        "Distinct symbol-to-#RRGGBB colors, e.g. {D: #293039, G: #f3cf65}. Must " +
        "fit configure_asset.colors and match configure_asset.palette if supplied. " +
        "This is the whole job's authoritative palette.",
    }),
    layers: arrayField(PixelLayerSchema, {
      minLength: 1,
      maxLength: 128,
      description:
        "Complete ordered layer list, painted back to front. Omitted old layers " +
        "are deleted. Separate a static body from small animated patches; " +
        "views/dimensions come from configure_asset, not this document.",
    }),
  },
  (value, ctx) => {
    const layerNames = new Set(value.layers.map((l) => l.name));
    if (layerNames.size !== value.layers.length) {
      valueError(ctx, "Layer names must be unique");
      return;
    }
    const paletteColors = new Set(Object.values(value.palette).map((c) => c.toLowerCase()));
    if (paletteColors.size !== Object.keys(value.palette).length) {
      valueError(ctx, "Palette colors must be distinct");
      return;
    }
    let pixels = 0;
    let paintOperations = 0;
    for (const layer of value.layers) {
      for (const pose of layer.poses) {
        let symbols: Set<string>;
        if (pose.drawing !== null) {
          const drawing = pose.drawing;
          pixels += drawing.width * drawing.height;
          paintOperations += pixelDrawingCost(drawing);
          symbols = pixelDrawingSymbols(drawing);
        } else {
          const rows = pose.rows;
          if (rows === null) {
            // PixelPoseSchema's own refine already enforces exactly one of rows/drawing;
            // unreachable for a pose that parsed successfully.
            throw new Error("Invariant violated: validated pose has neither rows nor drawing");
          }
          pixels += rows.reduce((sum, row) => sum + row.length, 0);
          symbols = new Set(
            rows
              .join("")
              .split("")
              .filter((c) => c !== "."),
          );
        }
        const unknown = [...symbols].filter((s) => !(s in value.palette));
        if (unknown.length > 0) {
          valueError(ctx, `Unknown palette symbol in layer ${pyRepr(layer.name)}`);
          return;
        }
      }
    }
    if (pixels > 262_144) {
      valueError(ctx, "Definition exceeds 262144 authored pixel cells; reuse default poses");
      return;
    }
    if (paintOperations > 1_048_576) {
      valueError(ctx, "Definition exceeds 1048576 drawing paint operations");
    }
  },
);
export type PixelDefinition = z.infer<typeof PixelDefinitionSchema>;

/** `PixelArtSource(Model)` */
export const PixelArtSourceSchema = modelObject({
  schema_version: literalField([1] as const).default(1),
  contract_version: literalField([1] as const).default(1),
  project_id: uuidField(),
  revision_id: uuidField(),
  definition: PixelDefinitionSchema,
  authored_views: recordField(arrayField(intField()), {
    description:
      "Canvas dimensions saved with this revision. Reconfiguration may require " +
      "adapting the definition before rendering.",
  }),
  configuration_id: uuidField().nullable(),
});
export type PixelArtSource = z.infer<typeof PixelArtSourceSchema>;

/** `PoseTarget(PixelModel)` -- inlined into each edit variant below (Zod has no base-class reuse
 * for discriminated union members beyond spreading the same field definitions). */
const poseTargetShape = {
  layer: stringField({ minLength: 1, maxLength: 100, description: "Existing, exact layer name." }),
  angle: AngleSchema,
  frame: intField({
    ge: 0,
    le: 100_000,
    description: "Exact stored pose key. null selects the view default, not all frames.",
  }).nullable(),
};

export const MovePoseSchema = modelObject({
  ...poseTargetShape,
  op: literalField(["move_pose"] as const),
  x: intField({ ge: -512, le: 512, description: "New absolute native x, not a delta." }),
  y: intField({ ge: -512, le: 512, description: "New absolute native y, not a delta." }),
});
export type MovePose = z.infer<typeof MovePoseSchema>;

export const SetPoseSchema = modelObject({
  op: literalField(["set_pose"] as const),
  layer: stringField({ minLength: 1, maxLength: 100 }),
  pose: PixelPoseSchema.describe("Complete patch. Omitted properties use PixelPose defaults."),
});
export type SetPose = z.infer<typeof SetPoseSchema>;

export const DeletePoseSchema = modelObject({
  ...poseTargetShape,
  op: literalField(["delete_pose"] as const),
});
export type DeletePose = z.infer<typeof DeletePoseSchema>;

export const SetLayerSchema = modelObject({
  op: literalField(["set_layer"] as const),
  layer: PixelLayerSchema.describe("Complete layer; omitted previous poses are deleted."),
});
export type SetLayer = z.infer<typeof SetLayerSchema>;

export const DeleteLayerSchema = modelObject({
  op: literalField(["delete_layer"] as const),
  name: stringField({ minLength: 1, maxLength: 100 }),
});
export type DeleteLayer = z.infer<typeof DeleteLayerSchema>;

export const SetPaletteSchema = modelObject({
  op: literalField(["set_palette"] as const),
  palette: recordField(ColorSchema, {
    minLength: 2,
    maxLength: 64,
    keyPattern: SYMBOL_PATTERN,
    keyPatternText: "^[A-Za-z0-9]$",
  }),
});
export type SetPalette = z.infer<typeof SetPaletteSchema>;

export type PixelEdit = MovePose | SetPose | DeletePose | SetLayer | DeleteLayer | SetPalette;

export const PixelEditSchema = taggedUnion("op", {
  move_pose: MovePoseSchema,
  set_pose: SetPoseSchema,
  delete_pose: DeletePoseSchema,
  set_layer: SetLayerSchema,
  delete_layer: DeleteLayerSchema,
  set_palette: SetPaletteSchema,
});

/** `PixelEdits = Annotated[list[PixelEdit], Field(min_length=1, max_length=128, ...)]` */
export const PixelEditsSchema = arrayField(PixelEditSchema, {
  minLength: 1,
  maxLength: 128,
  description: "Ordered atomic operations; only the final document is validated.",
});
export type PixelEdits = z.infer<typeof PixelEditsSchema>;

/**
 * Port of `apply_pixel_edits`: works on a deep-cloned plain object so a failure partway through
 * leaves the caller's `definition` untouched, then re-validates the whole result through
 * `PixelDefinitionSchema` exactly like the Python version re-validates through
 * `PixelDefinition.model_validate`.
 */
export function applyPixelEdits(definition: PixelDefinition, edits: PixelEdits): PixelDefinition {
  const data = structuredClone(definition) as {
    palette: Record<string, string>;
    layers: {
      name: string;
      poses: { angle: number; frame: number | null; x: number; y: number }[];
    }[];
  };
  const layers = data.layers;

  edits.forEach((edit, index) => {
    if (edit.op === "set_palette") {
      data.palette = { ...edit.palette };
      return;
    }
    const name =
      edit.op === "set_layer"
        ? edit.layer.name
        : edit.op === "delete_layer"
          ? edit.name
          : edit.layer;
    const layerIndex = layers.findIndex((layer) => layer.name === name);

    if (edit.op === "set_layer") {
      const clonedLayer = structuredClone(edit.layer);
      if (layerIndex === -1) layers.push(clonedLayer);
      else layers[layerIndex] = clonedLayer;
      return;
    }
    if (layerIndex === -1) {
      throw new Error(`edits[${index}] ${edit.op}: unknown layer ${pyRepr(name)}`);
    }
    if (edit.op === "delete_layer") {
      layers.splice(layerIndex, 1);
      return;
    }
    const layer = layers[layerIndex];
    if (!layer) throw new Error(`edits[${index}] ${edit.op}: unknown layer ${pyRepr(name)}`);
    const poses = layer.poses;
    const target = edit.op === "set_pose" ? edit.pose : edit;
    const poseIndex = poses.findIndex((p) => p.angle === target.angle && p.frame === target.frame);

    if (edit.op === "set_pose") {
      const clonedPose = structuredClone(edit.pose);
      if (poseIndex === -1) poses.push(clonedPose);
      else poses[poseIndex] = clonedPose;
    } else if (poseIndex === -1) {
      throw new Error(
        `edits[${index}] ${edit.op}: no stored pose (${String(target.angle)}, ${pyNone(target.frame)}) ` +
          `in ${pyRepr(name)}; defaults are not implicit edit targets`,
      );
    } else if (edit.op === "delete_pose") {
      poses.splice(poseIndex, 1);
    } else {
      const pose = poses[poseIndex];
      if (pose) {
        pose.x = edit.x;
        pose.y = edit.y;
      }
    }
  });

  return PixelDefinitionSchema.parse(data);
}

/**
 * Partial port of `validated_art`. Python's version also builds a real `PixelArt` (from
 * `pixel_art.py`) and calls `art.validate_target(asset_layouts, frame_sequence, spec_dump())`,
 * which checks that authored poses actually match the configured canvases and contain visible
 * ink -- that requires the Canvas/PixelArt engine, which is ported in Phase 3
 * (`packages/pixel-core`); `packages/schema` has zero internal dependencies and can't reach it
 * yet (see `docs/typescript-rewrite.md`). This function therefore only reproduces the
 * schema-level half Python does before constructing `PixelArt`: `PixelDefinition.from_art` (drop
 * a stray `views` key, then validate) and `AssetSpec` validation, wrapped in the same
 * `DomainError` Python raises on any failure. **The engine-level `validate_target` check must be
 * wired in once `packages/pixel-core` exists** -- flagged here rather than silently omitted.
 */
export function validatedArt(
  data: Record<string, unknown>,
  options: { asset: unknown },
): PixelDefinition {
  try {
    const { views: _views, ...rest } = data;
    const definition = PixelDefinitionSchema.parse(rest);
    AssetSpecSchema.parse(options.asset);
    return definition;
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    throw new DomainError(`Invalid pixel-art definition: ${message}`);
  }
}
