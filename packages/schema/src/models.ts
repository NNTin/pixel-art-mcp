/**
 * Port of `src/pixel_art_mcp/models.py`: `AssetSpec`/`RenderOptions`/`Job`/etc. and every
 * cross-field validator.
 */

import { z } from "zod";
import {
  arrayField,
  DomainError,
  intField,
  literalField,
  modelObject,
  numberField,
  recordField,
  stringField,
  uuidField,
  valueError,
} from "./errors.js";

export { DomainError };

// pixel-index's live POST /api/v1/assets?name=... query param caps at 60 chars (confirmed
// against its openapi.json by contracts/pixel_index/checks.py) -- every pixel-agents asset-kind
// name field must stay within what the real upload accepts.
export const PIXEL_AGENTS_NAME_MAX_LENGTH = 60;

const FURNITURE_CATEGORY_VALUES = [
  "desks",
  "chairs",
  "decor",
  "electronics",
  "wall",
  "misc",
] as const;
export type FurnitureCategory = (typeof FURNITURE_CATEGORY_VALUES)[number];

// The webview still knows storage, but pixel-index's upload API now accepts misc instead.
// Normalize saved/legacy requests while advertising only the accepted wire values.
export const FurnitureCategorySchema = z.preprocess(
  (value) => (value === "storage" ? "misc" : value),
  literalField(FURNITURE_CATEGORY_VALUES),
);

function withSchemaVersion<Shape extends z.ZodRawShape>(shape: Shape) {
  return { schema_version: literalField([1] as const).default(1), ...shape };
}

/** `Model(BaseModel)`: `extra="forbid"`, `allow_inf_nan=False` (enforced by `numberField`). */
export function modelSchema<Shape extends z.ZodRawShape>(
  shape: Shape,
  refine?: (
    value: z.infer<z.ZodObject<ReturnType<typeof withSchemaVersion<Shape>>>>,
    ctx: z.RefinementCtx,
  ) => void,
) {
  return modelObject(withSchemaVersion(shape), refine);
}

const ASSET_ID_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const ASSET_ID_PATTERN_TEXT = "^[A-Z][A-Z0-9_]{0,63}$";

export const ProjectSchema = modelSchema({
  id: uuidField(),
  name: z.string(),
  created_at: z.string(),
  current_revision_id: uuidField().nullable().default(null),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ArtifactSchema = modelSchema({
  id: uuidField(),
  project_id: uuidField(),
  job_id: uuidField().nullable().default(null),
  kind: z.string(),
  filename: z.string(),
  media_type: z.string(),
  size_bytes: intField(),
  width: intField().nullable().default(null),
  height: intField().nullable().default(null),
  download_url: z.string().default(""),
  export_path: z.string().default(""),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ReferenceSchema = modelSchema({
  id: uuidField(),
  project_id: uuidField(),
  filename: z.string(),
  width: intField(),
  height: intField(),
  sha256: z.string(),
  original_artifact_id: uuidField(),
  image_artifact_id: uuidField(),
  thumbnail_artifact_id: uuidField(),
  image_path: z.string(),
});
export type Reference = z.infer<typeof ReferenceSchema>;

export const RevisionSchema = modelSchema({
  id: uuidField(),
  project_id: uuidField(),
  parent_id: uuidField().nullable(),
  created_at: z.string(),
  state_artifact_id: uuidField(),
  script_artifact_id: uuidField(),
  summary: z.record(z.string(), z.unknown()),
});
export type Revision = z.infer<typeof RevisionSchema>;

export const ProjectDetailSchema = modelSchema({
  project: ProjectSchema,
  references: arrayField(ReferenceSchema),
  revisions: arrayField(RevisionSchema),
  asset_configuration: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;

export const JobSchema = modelSchema({
  id: uuidField(),
  project_id: uuidField(),
  operation: literalField(["script", "preview", "sprites"] as const),
  input_revision_id: uuidField().nullable(),
  status: literalField(["queued", "running", "succeeded", "failed", "cancelled"] as const),
  created_at: z.string(),
  started_at: z.string().nullable().default(null),
  finished_at: z.string().nullable().default(null),
  progress: numberField().default(0),
  stage: z.string().default("queued"),
  logs: z.string().default(""),
  error: z.string().nullable().default(null),
  result_revision_id: uuidField().nullable().default(null),
  artifacts: arrayField(ArtifactSchema).default([]),
  outputs: z.record(z.string(), ArtifactSchema).default({}),
});
export type Job = z.infer<typeof JobSchema>;

/** `OpenAIFile(BaseModel)`: keeps optional properties non-nullable in the advertised schema. */
export const OpenAIFileSchema = modelObject({
  download_url: z.string(),
  file_id: z.string(),
  mime_type: z.string().default(""),
  file_name: z.string().default(""),
});
export type OpenAIFile = z.infer<typeof OpenAIFileSchema>;

export const PixelAgentsOptionsSchema = modelSchema({
  asset_id: stringField({
    pattern: ASSET_ID_PATTERN,
    patternText: ASSET_ID_PATTERN_TEXT,
    description: "Stable ID, e.g. OIL_LAMP",
  }),
  name: stringField({
    minLength: 1,
    maxLength: PIXEL_AGENTS_NAME_MAX_LENGTH,
    description: "Furniture label in the editor",
  }),
  category: FurnitureCategorySchema.default("decor"),
  footprint_w: intField({
    ge: 1,
    le: 32,
    description: "Occupied grid columns; defaults to ceil(sprite width / 16), not a resize",
  })
    .nullable()
    .default(null),
  footprint_h: intField({
    ge: 1,
    le: 32,
    description: "Occupied grid rows; defaults to ceil(sprite height / 16), not a resize",
  })
    .nullable()
    .default(null),
  can_place_on_surfaces: z.boolean().default(false),
  can_place_on_walls: z.boolean().default(false),
  background_tiles: intField({ ge: 0, le: 31 }).default(0),
  off_frame: intField({
    ge: 0,
    le: 100_000,
    description:
      "Required for animation: source pose for the idle/off PNG. On frames use the " +
      "normal frame range. pixel-agents only cycles on-state frames near an active agent.",
  })
    .nullable()
    .default(null),
});
export type PixelAgentsOptions = z.infer<typeof PixelAgentsOptionsSchema>;

export const PixelAgentsCharacterOptionsSchema = modelSchema({
  asset_id: stringField({
    pattern: ASSET_ID_PATTERN,
    patternText: ASSET_ID_PATTERN_TEXT,
    description: "Stable ID, e.g. KNIGHT",
  }),
  name: stringField({ minLength: 1, maxLength: PIXEL_AGENTS_NAME_MAX_LENGTH }),
});
export type PixelAgentsCharacterOptions = z.infer<typeof PixelAgentsCharacterOptionsSchema>;

export const PixelAgentsPetOptionsSchema = modelSchema({
  asset_id: stringField({
    pattern: ASSET_ID_PATTERN,
    patternText: ASSET_ID_PATTERN_TEXT,
    description: "Stable ID, e.g. TABBY_CAT",
  }),
  name: stringField({ minLength: 1, maxLength: PIXEL_AGENTS_NAME_MAX_LENGTH }),
});
export type PixelAgentsPetOptions = z.infer<typeof PixelAgentsPetOptionsSchema>;

export const RenderStateSchema = modelSchema(
  {
    id: stringField({ pattern: /^[a-z][a-z0-9_]{0,23}$/, patternText: "^[a-z][a-z0-9_]{0,23}$" }),
    name: stringField({ minLength: 1, maxLength: 48 }),
    frame_start: intField({ ge: 0, le: 100_000 }),
    frame_end: intField({ ge: 0, le: 100_000 }),
    frame_step: intField({ ge: 1 }).default(1),
    off_frame: intField({ ge: 0, le: 100_000 }).nullable().default(null),
  },
  (value, ctx) => {
    if (value.frame_end < value.frame_start) {
      valueError(ctx, "State frame_end must be >= frame_start");
    }
  },
);
export type RenderState = z.infer<typeof RenderStateSchema>;

/** `RenderState.frames()` */
export function renderStateFrames(state: RenderState): number[] {
  const frames: number[] = [];
  for (let f = state.frame_start; f <= state.frame_end; f += state.frame_step) frames.push(f);
  return frames;
}

export const AssetClipSchema = modelSchema(
  {
    frames: arrayField(intField(), { minLength: 1, maxLength: 64 }),
    name: stringField({ minLength: 1, maxLength: 48 }).nullable().default(null),
    off_frame: intField({ ge: 0, le: 100_000 }).nullable().default(null),
  },
  (value, ctx) => {
    if (value.frames.some((frame) => frame < 0 || frame > 100_000)) {
      valueError(ctx, "Source frames must be between 0 and 100000", ["frames"]);
    }
  },
);
export type AssetClip = z.infer<typeof AssetClipSchema>;

function pyRepr(value: string): string {
  if (value.includes("'") && !value.includes('"')) return `"${value}"`;
  return `'${value.replace(/'/g, "\\'")}'`;
}

const ASSET_SPEC_KIND_VALUES = ["furniture", "character", "pet"] as const;
const ASSET_SPEC_PRESET_VALUES = [
  "small",
  "prop",
  "chair",
  "tall",
  "desk",
  "character",
  "pet",
] as const;
const PLACEMENT_VALUES = ["floor", "surface", "wall"] as const;

export const AssetSpecSchema = modelSchema(
  {
    kind: literalField(ASSET_SPEC_KIND_VALUES),
    name: stringField({ minLength: 1, maxLength: PIXEL_AGENTS_NAME_MAX_LENGTH }),
    asset_id: stringField({ pattern: ASSET_ID_PATTERN, patternText: ASSET_ID_PATTERN_TEXT })
      .nullable()
      .default(null),
    preset: literalField(ASSET_SPEC_PRESET_VALUES)
      .describe(
        "Furniture: small=16x16, prop=neutral 16x32, chair=16x32 with chair category, " +
          "tall=16x64, desk=48x32 with desk category. Set placement/category for the actual " +
          "object; profiles explain rotated footprints.",
      )
      .nullable()
      .default(null),
    placement: literalField(PLACEMENT_VALUES).default("floor"),
    category: FurnitureCategorySchema.default("decor"),
    ground_width: intField({
      ge: 1,
      le: 16,
      description:
        "Occupied ground columns in 16px tiles. Front pixel width is ground_width * " +
        "16; defaults from preset.",
    })
      .nullable()
      .default(null),
    ground_depth: intField({
      ge: 1,
      le: 16,
      description:
        "Occupied ground rows in tiles, not sprite height. Rotated views swap ground " +
        "width/depth.",
    }).default(1),
    background_tiles: intField({
      ge: 0,
      le: 31,
      description:
        "Nonblocking sprite rows above occupied ground. Front " +
        "height=(ground_depth+background_tiles)*16; sides swap ground width/depth. Omit to " +
        "preserve preset headroom, or derive from explicit height.",
    })
      .nullable()
      .default(null),
    width: intField({
      ge: 16,
      le: 512,
      description:
        "Optional front width in pixels; must equal ground_width * 16. Prefer tile fields.",
    })
      .nullable()
      .default(null),
    height: intField({
      ge: 16,
      le: 512,
      description:
        "Optional front sprite height in pixels, a multiple of 16 >= ground_depth*16. " +
        "Extra rows are nonblocking background. Prefer background_tiles; do not increase " +
        "pixel density.",
    })
      .nullable()
      .default(null),
    clips: recordField(AssetClipSchema, { maxLength: 16 }).default({}),
    colors: intField({ ge: 2, le: 64, description: "Maximum authored palette size." }).default(16),
    palette: arrayField(z.string(), {
      minLength: 2,
      maxLength: 64,
      description: "Optional fixed hex colors; write_pixel_art.palette must match exactly.",
    })
      .nullable()
      .default(null),
    outline: literalField([false] as const)
      .describe("Must be false. Draw outlines explicitly in required pixel layers.")
      .default(false),
    supersampling: intField({
      ge: 1,
      le: 4,
      description:
        "Scale factor for the exported high-resolution comparison image. Never " +
        "increases or resamples authored pixels.",
    }).default(4),
  },
  (value, ctx) => {
    if (value.kind !== "character" && value.asset_id === null) {
      valueError(ctx, "Furniture and pets require asset_id");
      return;
    }
    const preset = value.preset ?? (value.kind === "furniture" ? "small" : value.kind);
    const allowed: readonly string[] =
      value.kind === "furniture" ? ["small", "prop", "chair", "tall", "desk"] : [value.kind];
    if (!allowed.includes(preset)) {
      valueError(ctx, `Invalid preset for ${value.kind}: ${preset}`);
      return;
    }
    if (value.kind !== "furniture") {
      if (value.background_tiles !== null) {
        valueError(ctx, "background_tiles applies only to furniture");
        return;
      }
      if (value.placement !== "floor" || value.ground_width !== null || value.ground_depth !== 1) {
        valueError(ctx, "Placement and ground tiles apply only to furniture");
        return;
      }
      if (
        (value.width !== null && value.width !== 16) ||
        (value.height !== null && value.height !== 32)
      ) {
        valueError(ctx, "Characters and pets require 16x32 front/back frames");
        return;
      }
    }
    const clipKeys = Object.keys(value.clips);
    for (const key of clipKeys) {
      const clip = value.clips[key];
      if (!clip) continue;
      if (!/^[a-z][a-z0-9_]{0,23}$/.test(key)) {
        valueError(ctx, "Clip IDs must be lowercase identifiers, up to 24 characters");
        return;
      }
      if (value.kind !== "furniture" && clip.off_frame !== null) {
        valueError(ctx, "Only furniture clips have off_frame");
        return;
      }
      if (value.kind === "furniture") {
        if (clip.frames.length > 1 && clip.off_frame === null) {
          valueError(ctx, "Animated furniture clips require off_frame");
          return;
        }
        if (clipKeys.length > 1) {
          if (`${value.asset_id ?? ""}_${key.toUpperCase()}`.length > 64) {
            valueError(ctx, "Combined asset and variant ID exceeds 64 characters");
            return;
          }
          if (`${value.name} — ${clip.name ?? key}`.length > 60) {
            valueError(ctx, "Combined asset and variant name exceeds 60 characters");
            return;
          }
        }
      }
    }
    const required: Record<string, number> =
      value.kind === "character" ? { walk: 3, typing: 2, reading: 2 } : { walk: 3, idle: 3 };
    if (value.kind !== "furniture" && clipKeys.length > 0) {
      const requiredKeys = Object.keys(required);
      if (
        clipKeys.length !== requiredKeys.length ||
        !requiredKeys.every((k) => clipKeys.includes(k))
      ) {
        valueError(ctx, `${value.kind} clips must be ${pyDictRepr(required)}`);
        return;
      }
      if (requiredKeys.some((key) => value.clips[key]?.frames.length !== required[key])) {
        valueError(ctx, `${value.kind} clip frame counts must be ${pyDictRepr(required)}`);
        return;
      }
    }
    if (value.palette !== null) {
      const hexPattern = /^#[0-9a-fA-F]{6}$/;
      if (value.palette.some((color) => !hexPattern.test(color))) {
        valueError(ctx, "Palette colors must be #RRGGBB");
        return;
      }
      const distinct = new Set(value.palette.map((c) => c.toLowerCase()));
      if (distinct.size !== value.palette.length) {
        valueError(ctx, "Palette colors must be distinct");
      }
    }
  },
);
export type AssetSpec = z.infer<typeof AssetSpecSchema>;

function pyDictRepr(d: Record<string, number>): string {
  return `{${Object.entries(d)
    .map(([k, v]) => `'${k}': ${v}`)
    .join(", ")}}`;
}

function tileDimensionsPreprocess(raw: unknown): unknown {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const values: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    for (const axis of ["width", "height"] as const) {
      const tileKey = `tile_${axis}`;
      const tile = Object.prototype.hasOwnProperty.call(values, tileKey)
        ? values[tileKey]
        : 1;
      const isPlainInt = typeof tile === "number" && Number.isInteger(tile);
      if (!(axis in values) && isPlainInt) {
        values[axis] = (tile) * 16;
      }
    }
    return values;
  }
  return raw;
}

function pyModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function setEquals<T>(a: Iterable<T>, b: readonly T[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const v of setA) if (!setB.has(v)) return false;
  return true;
}

const AnglesSchema = arrayField(numberField(), {
  minLength: 1,
  maxLength: 32,
  description: "Camera views in degrees. pixel-agents: 0=front, 90=right, 180=back, 270=left.",
}).superRefine((values, ctx) => {
  if (values.some((v) => !Number.isFinite(v))) {
    valueError(ctx, "Angles must be finite");
    return;
  }
  const normalized = values.map((v) => round6(pyModulo(v, 360)));
  if (new Set(normalized).size !== normalized.length) {
    valueError(ctx, "Angles must be distinct modulo 360");
  }
}).transform((values) => values.map((v) => round6(pyModulo(v, 360))));

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const RenderOptionsPaletteSchema = arrayField(z.string(), { minLength: 2, maxLength: 255 })
  .nullable()
  .default(null)
  .superRefine((values, ctx) => {
    if (values === null) return;
    if (values.some((color) => !HEX_COLOR_PATTERN.test(color))) {
      valueError(ctx, "Palette colors must be #RRGGBB");
      return;
    }
    const distinct = new Set(values.map((c) => c.toLowerCase()));
    if (distinct.size !== values.length) {
      valueError(ctx, "Palette colors must be distinct");
    }
  });

const renderOptionsShape = {
  asset: AssetSpecSchema.nullable().default(null),
  asset_configuration_id: z.string().nullable().default(null),
  frame_sequence: arrayField(intField()).nullable().default(null),
  asset_layouts: arrayField(z.record(z.string(), z.unknown())).nullable().default(null),
  states: arrayField(RenderStateSchema, {
    minLength: 1,
    maxLength: 16,
    description:
      "Named fill/appearance states with their own animation and idle frames. " +
      "Overrides the top-level frame range. Uses one camera/palette, generates a comparison " +
      "player and separate pixel-agents variants with asset IDs suffixed by state ID. States " +
      "may have different frame counts, e.g. a static empty state alongside animated fill " +
      "states; shorter animations loop within the longest state's cycle in combined previews.",
  })
    .nullable()
    .default(null),
  tile_width: intField({
    ge: 1,
    le: 32,
    description: "Sprite canvas width in 16px tiles: 1=small/tall (16px), 2=wide (32px).",
  }).default(1),
  tile_height: intField({
    ge: 1,
    le: 32,
    description: "Sprite canvas height in 16px tiles: 1=small (16px), 2=tall (32px), 3=48px.",
  }).default(1),
  width: intField({
    ge: 8,
    le: 512,
    description: "Explicit pixel width overrides tile_width; non-multiples of 16 are allowed.",
  }).default(16),
  height: intField({
    ge: 8,
    le: 512,
    description: "Explicit pixel height overrides tile_height; non-multiples of 16 are allowed.",
  }).default(16),
  angles: AnglesSchema.default([0, 90, 180, 270]),
  frame_start: intField({ ge: 0, le: 100_000 }).default(1),
  frame_end: intField({ ge: 0, le: 100_000 }).default(1),
  frame_step: intField({ ge: 1 }).default(1),
  fps: intField({
    ge: 1,
    le: 120,
    description: "Playback rate. pixel-agents exports require exactly 5 fps (fixed in the app).",
  }).default(5),
  colors: intField({ ge: 2, le: 255 }).default(32),
  palette: RenderOptionsPaletteSchema,
  downscale_mode: literalField(["crisp"] as const)
    .describe(
      "Classifies source pixels against one shared palette, then uses local " +
        "alpha-weighted color votes without per-frame clustering. Native PixelArt layers " +
        "bypass conversion.",
    )
    .default("crisp"),
  supersampling: intField({
    ge: 1,
    le: 4,
    description:
      "Render at this multiple of the export dimensions. Values 2–4 also supply a " +
      "genuine higher-resolution reference in preview.html; 1 disables that comparison.",
  }).default(4),
  alpha_threshold: intField({ ge: 1, le: 255 }).default(128),
  padding: numberField({ ge: 0, le: 0.5 }).default(0.1),
  meters_per_tile: numberField({
    gt: 0,
    le: 1000,
    description:
      "Fixes camera zoom to an absolute physical scale instead of auto-fitting to " +
      "this object's own bounding box: a 16px tile spans this many world units (meters, by " +
      "convention) at zero padding. Defaults to 1.0 (1 tile == 1m) so sizing is driven by the " +
      "object's actual real-world scale, not a canvas-size guess -- model geometry at accurate " +
      "relative real-world size (world units == meters) so unrelated objects rendered in " +
      "separate jobs -- e.g. a small candle and a tall street lamp -- come out at correctly " +
      "relative sizes to each other. padding still applies on top (default 0.1 adds ~20% " +
      "margin, i.e. a tile maps to meters_per_tile*(1+2*padding) meters); set padding=0 for an " +
      "exact mapping. Objects that overflow the fixed frame are simply cropped -- choose " +
      "width/height (or tile_width/tile_height) generously for large objects. Set explicitly " +
      "to null to fall back to legacy per-job auto-fit-to-bounding-box framing, e.g. for a " +
      "quick preview where absolute scale doesn't matter.",
  })
    .nullable()
    .default(1.0),
  pixel_agents: PixelAgentsOptionsSchema.describe(
    "Enable an installable pixel-agents furniture manifest + PNG package. " +
      "Requires cardinal angles and 5 fps; animations require an off_frame.",
  )
    .nullable()
    .default(null),
  character: PixelAgentsCharacterOptionsSchema.describe(
    "Enable a pixel-index custom-character export: manifest.json + a 112x96 PNG. " +
      "Requires angles={0,90,180} (down/up/right), width=16, height=32, and exactly 7 frames. " +
      "Mutually exclusive with pixel_agents.",
  )
    .nullable()
    .default(null),
  pet: PixelAgentsPetOptionsSchema.describe(
    "Enable a pixel-index custom-pet export: manifest.json + a 96x96 pet.png. " +
      "Requires angles={0,90,180} (down/up/right), width=16, height=32, and states=[3-frame " +
      "'walk', 3-frame 'idle']. Mutually exclusive with pixel_agents/character.",
  )
    .nullable()
    .default(null),
};

export const RenderOptionsSchema = z.preprocess(
  tileDimensionsPreprocess,
  modelSchema(renderOptionsShape, (value, ctx) => {
    if (value.frame_end < value.frame_start) {
      valueError(ctx, "frame_end must be >= frame_start");
      return;
    }
    if (value.states) {
      const ids = value.states.map((s) => s.id);
      if (new Set(ids).size !== ids.length) {
        valueError(ctx, "State IDs must be distinct");
        return;
      }
    }
    const targets = [value.pixel_agents, value.character, value.pet];
    if (targets.filter((t) => t !== null).length > 1) {
      valueError(ctx, "Only one of pixel_agents/character/pet may be set per render");
      return;
    }
    const frames = renderOptionsFrames(value);
    if (value.character) {
      if (value.states) {
        valueError(ctx, "character export does not support named states");
        return;
      }
      if (!setEquals(value.angles, [0, 90, 180])) {
        valueError(ctx, "character export requires angles={0,90,180} (down/up/right)");
        return;
      }
      if (value.width !== 16 || value.height !== 32) {
        valueError(ctx, "character export requires width=16, height=32");
        return;
      }
      if (frames.length !== 7) {
        valueError(ctx, "character export requires exactly 7 frames");
        return;
      }
    }
    if (value.pet) {
      if (!setEquals(value.angles, [0, 90, 180])) {
        valueError(ctx, "pet export requires angles={0,90,180} (down/up/right)");
        return;
      }
      if (value.width !== 16 || value.height !== 32) {
        valueError(
          ctx,
          "pet export requires width=16, height=32 (the down/up canvas; " +
            "right is doubled automatically)",
        );
        return;
      }
      const stateIds = new Set((value.states ?? []).map((s) => s.id));
      if (!setEquals(stateIds, ["walk", "idle"])) {
        valueError(ctx, "pet export requires exactly two states: 'walk' and 'idle'");
        return;
      }
      for (const state of value.states ?? []) {
        if (renderStateFrames(state).length !== 3) {
          valueError(ctx, `pet '${state.id}' state requires exactly 3 frames`);
          return;
        }
        if (state.off_frame !== null) {
          valueError(ctx, "pet states do not use off_frame");
          return;
        }
      }
    }
    if (value.pixel_agents) {
      if (value.fps !== 5) {
        valueError(ctx, "pixel-agents furniture playback is fixed at 5 fps");
        return;
      }
      if (value.angles.some((angle) => ![0, 90, 180, 270].includes(angle))) {
        valueError(ctx, "pixel-agents supports only 0/front, 90/right, 180/back, 270/left");
        return;
      }
      if (value.states) {
        if (value.pixel_agents.off_frame !== null) {
          valueError(ctx, "Use each state's off_frame for named-state exports");
          return;
        }
        for (const state of value.states) {
          if (renderStateFrames(state).length > 1 && state.off_frame === null) {
            valueError(ctx, "Each animated pixel-agents state requires off_frame");
            return;
          }
          if (`${value.pixel_agents.asset_id}_${state.id}`.length > 64) {
            valueError(ctx, "Combined pixel-agents asset and state ID exceeds 64 chars");
            return;
          }
          const combinedName = `${value.pixel_agents.name} — ${state.name}`;
          if (combinedName.length > PIXEL_AGENTS_NAME_MAX_LENGTH) {
            valueError(
              ctx,
              "Combined pixel-agents asset and state name exceeds " +
                `${String(PIXEL_AGENTS_NAME_MAX_LENGTH)} chars`,
            );
            return;
          }
        }
      } else if (frames.length > 1 && value.pixel_agents.off_frame === null) {
        valueError(ctx, "pixel-agents animation requires off_frame for the idle/off state");
        return;
      }
      const footprintH = value.pixel_agents.footprint_h ?? Math.floor((value.height + 15) / 16);
      if (value.pixel_agents.background_tiles >= footprintH) {
        valueError(ctx, "background_tiles must be smaller than the furniture footprint height");
      }
    }
  }),
);
export type RenderOptions = z.infer<typeof RenderOptionsSchema>;

/** `RenderOptions.frames()` */
export function renderOptionsFrames(options: RenderOptions): number[] {
  if (options.frame_sequence !== null) return options.frame_sequence;
  if (options.states) {
    const seen = new Map<number, true>();
    for (const state of options.states) {
      for (const frame of renderStateFrames(state)) seen.set(frame, true);
    }
    return [...seen.keys()];
  }
  const frames: number[] = [];
  for (let f = options.frame_start; f <= options.frame_end; f += options.frame_step) frames.push(f);
  return frames;
}

/** `RenderOptions.render_frames()` */
export function renderOptionsRenderFrames(options: RenderOptions): number[] {
  const frames = renderOptionsFrames(options);
  const off = options.pixel_agents ? options.pixel_agents.off_frame : null;
  if (off !== null && !frames.includes(off)) frames.push(off);
  for (const state of options.states ?? []) {
    if (state.off_frame !== null && !frames.includes(state.off_frame)) frames.push(state.off_frame);
  }
  return frames;
}

/** `ProjectName = Annotated[str, Field(min_length=1, max_length=120)]` */
export const ProjectNameSchema = stringField({ minLength: 1, maxLength: 120 });
export type ProjectName = z.infer<typeof ProjectNameSchema>;

export { pyRepr };
