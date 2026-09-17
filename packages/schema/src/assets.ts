/**
 * Port of `src/pixel_art_mcp/assets.py`: target profiles and deterministic translation into a
 * render job snapshot. Unlike `authoring.ts`/`models.ts`, this module is mostly real control
 * flow (tile-size math, per-angle layout derivation, `DomainError` raises), not just schemas --
 * ported as plain TypeScript functions operating on the Zod-inferred types from `models.ts`.
 */

import { DomainError } from "./errors.js";
import {
  AssetSpecSchema,
  RenderOptionsSchema,
  type AssetClip,
  type AssetSpec,
  type RenderOptions,
} from "./models.js";

interface Profile {
  kind: "furniture" | "character" | "pet";
  size: [number, number];
  contentHeight: number;
}

export const PROFILES: Record<string, Profile> = {
  small: { kind: "furniture", size: [16, 16], contentHeight: 14 },
  prop: { kind: "furniture", size: [16, 32], contentHeight: 30 },
  chair: { kind: "furniture", size: [16, 32], contentHeight: 24 },
  tall: { kind: "furniture", size: [16, 64], contentHeight: 62 },
  desk: { kind: "furniture", size: [48, 32], contentHeight: 24 },
  character: { kind: "character", size: [16, 32], contentHeight: 29 },
  pet: { kind: "pet", size: [16, 32], contentHeight: 22 },
};

export interface AssetLayout {
  angle: number;
  width: number;
  height: number;
  footprint_w: number;
  footprint_h: number;
  ground_width: number;
  ground_depth: number;
  background_tiles: number;
  margin: number;
  bottom: number;
  content_height: number;
}

const DEFAULT_CLIPS: Record<AssetSpec["kind"], Record<string, { frames: number[] }>> = {
  furniture: { default: { frames: [1] } },
  character: {
    walk: { frames: [1, 2, 3] },
    typing: { frames: [4, 5] },
    reading: { frames: [6, 7] },
  },
  pet: { walk: { frames: [1, 2, 3] }, idle: { frames: [4, 5, 6] } },
};

/**
 * Port of `normalize_asset`. Python decides whether to auto-derive `category` from a
 * chair/desk preset using `"category" not in spec.model_fields_set` -- pydantic-instance
 * metadata about which fields the caller actually passed, which a Zod-parsed plain object has
 * no equivalent of. This approximates it with `spec.category === "decor"` (the schema default):
 * true whenever category was omitted (the common, intended case), but also true if a caller
 * explicitly passed `category: "decor"` alongside `preset: "chair"`/`"desk"` -- that rare
 * explicit case gets overridden here where Python would have honored it. Flagged rather than
 * silently guessed, per this port's brief.
 */
export function normalizeAsset(spec: AssetSpec): AssetSpec {
  const preset = spec.preset ?? (spec.kind === "furniture" ? "small" : spec.kind);
  const clipsProvided = Object.keys(spec.clips).length > 0;
  const clips = clipsProvided ? spec.clips : DEFAULT_CLIPS[spec.kind];
  const category =
    (preset === "chair" || preset === "desk") && spec.category === "decor"
      ? preset === "chair"
        ? "chairs"
        : "desks"
      : spec.category;
  return AssetSpecSchema.parse({
    ...spec,
    preset,
    clips,
    category,
  });
}

/** Port of `asset_layouts`. */
export function assetLayouts(specInput: AssetSpec): AssetLayout[] {
  const spec = normalizeAsset(specInput);
  const profile = PROFILES[String(spec.preset)];
  if (!profile) throw new DomainError(`Unknown ${spec.kind} preset ${String(spec.preset)}`);
  const width = spec.width ?? (spec.ground_width ? spec.ground_width * 16 : profile.size[0]);
  let background = spec.background_tiles;
  background ??= spec.height
    ? Math.floor(spec.height / 16) - spec.ground_depth
    : Math.floor(profile.size[1] / 16) - 1;
  const height = spec.height ?? (spec.ground_depth + background) * 16;
  const angles = spec.kind === "furniture" ? [0, 90, 180, 270] : [0, 180, 90];
  const groundW = spec.ground_width ?? Math.floor(width / 16);

  if (spec.kind === "furniture") {
    if (width % 16 !== 0 || height % 16 !== 0 || width !== groundW * 16) {
      throw new DomainError(
        `Furniture width must equal ground_width * 16 = ${String(groundW * 16)}px; ` +
          "height must be a multiple of 16. Prefer " +
          "ground_width/ground_depth/background_tiles.",
      );
    }
    if (background < 0) {
      throw new DomainError(
        `height=${String(height)}px cannot include ground_depth=${String(spec.ground_depth)} tiles; ` +
          `minimum height is ${String(spec.ground_depth * 16)}px. ` +
          "Omit height and set background_tiles for automatic sizing.",
      );
    }
    if (height !== (spec.ground_depth + background) * 16) {
      throw new DomainError(
        "height conflicts with background_tiles: " +
          `expected ${String((spec.ground_depth + background) * 16)}px. ` +
          "Supply tile fields or matching pixel dimensions.",
      );
    }
  } else {
    background = 0;
  }

  const layouts: AssetLayout[] = [];
  for (const angle of angles) {
    let gw = groundW;
    let gd = spec.ground_depth;
    if (spec.kind === "furniture" && (angle === 90 || angle === 270)) {
      [gw, gd] = [gd, gw];
    }
    const w = spec.kind === "furniture" ? gw * 16 : spec.kind === "pet" && angle === 90 ? 32 : 16;
    const h = spec.kind === "furniture" ? (gd + background) * 16 : 32;
    if (w > 512 || h > 512) {
      throw new DomainError("Rotated furniture canvas exceeds 512 pixels");
    }
    // `spec.outline` is `Literal[False]`/`z.literal(false)` -- always false, so this is always 1;
    // kept as a named constant (not inlined) to mirror `asset_layouts`' `margin = 2 if outline
    // else 1` structure in the Python source.
    const margin = 1;
    const bottom = h - margin - (spec.placement === "surface" ? 7 : 0);
    let content = Math.min(h - 2 * margin, profile.contentHeight + h - profile.size[1]);
    if (spec.height) content = h - 2 * margin;
    layouts.push({
      angle,
      width: w,
      height: h,
      footprint_w: gw,
      footprint_h: gd + background,
      ground_width: gw,
      ground_depth: gd,
      background_tiles: background,
      margin,
      bottom,
      content_height: Math.min(content, bottom - margin),
    });
  }
  return layouts;
}

/** Port of `resolve_asset`. */
export function resolveAsset(
  specInput: AssetSpec,
  configurationId: string | null = null,
): RenderOptions {
  const spec = normalizeAsset(specInput);
  const layouts = assetLayouts(spec);
  const seen = new Map<number, true>();
  for (const clip of Object.values(spec.clips)) {
    for (const frame of clip.frames) seen.set(frame, true);
    if (clip.off_frame !== null) seen.set(clip.off_frame, true);
  }
  return RenderOptionsSchema.parse({
    asset: spec,
    asset_configuration_id: configurationId,
    asset_layouts: layouts,
    frame_sequence: [...seen.keys()],
    width: Math.max(...layouts.map((l) => l.width)),
    height: Math.max(...layouts.map((l) => l.height)),
    angles: layouts.map((l) => l.angle),
    fps: 5,
    colors: spec.colors,
    palette: spec.palette,
    supersampling: spec.supersampling,
    meters_per_tile: null,
    padding: 0,
  });
}

/** Port of `get_asset_profile`. Every prompt string is copied verbatim from `assets.py`. */
export function getAssetProfile(
  kind: string,
  preset: string | null = null,
  opts: { groundWidth?: number; groundDepth?: number; backgroundTiles?: number } = {},
): Record<string, unknown> {
  if (kind !== "furniture" && kind !== "character" && kind !== "pet") {
    throw new DomainError("Choose furniture, character, or pet");
  }
  const selected = preset ?? (kind === "furniture" ? "small" : kind);
  const profile = PROFILES[selected];
  if (profile?.kind !== kind) {
    throw new DomainError(`Unknown ${kind} preset ${pyRepr(selected)}`);
  }
  const overrides: Record<string, number> = {};
  if (opts.groundWidth !== undefined) overrides["ground_width"] = opts.groundWidth;
  if (opts.groundDepth !== undefined) overrides["ground_depth"] = opts.groundDepth;
  if (opts.backgroundTiles !== undefined) overrides["background_tiles"] = opts.backgroundTiles;
  const spec = normalizeAsset(
    AssetSpecSchema.parse({
      kind,
      name: "Example",
      asset_id: "EXAMPLE",
      preset: selected,
      ...overrides,
    }),
  );
  const layouts = assetLayouts(spec);
  const firstLayout = layouts[0];
  if (!firstLayout) throw new DomainError("No layouts derived for profile");
  const starter = {
    version: 1,
    palette: { D: "#293039", G: "#f3cf65" },
    layers: [
      {
        name: "marker",
        poses: layouts.map((row) => ({
          angle: row.angle,
          frame: null,
          rows: ["DDDDDD", "DGGGGD", "DGDDGD", "DGDDGD", "DGGGGD", "DDDDDD"],
          x: Math.floor(row.width / 2) - 3,
          y: row.bottom - 6,
          min_pixels: 36,
          connected: true,
        })),
      },
    ],
  };
  const firstMarkerPose = starter.layers[0]?.poses[0];
  const clipKeys = Object.keys(spec.clips);
  const firstClipKey = clipKeys[0];
  const firstClip = firstClipKey ? spec.clips[firstClipKey] : undefined;

  return {
    kind,
    preset: selected,
    presets: Object.entries(PROFILES)
      .filter(([, value]) => value.kind === kind)
      .map(([key]) => key),
    specification: spec,
    layouts,
    sizing:
      kind === "furniture"
        ? {
            tile_pixels: 16,
            occupied_ground_tiles: [firstLayout.ground_width, firstLayout.ground_depth],
            background_tiles: firstLayout.background_tiles,
            rule:
              "Front/back = 16*ground_width by 16*(ground_depth+background_tiles). " +
              "Right/left swap ground width/depth. Background rows are nonblocking; " +
              "they are not additional occupied ground tiles.",
            example_3x4: {
              ground_width: 3,
              ground_depth: 4,
              background_tiles: 1,
              front_pixels: [48, 80],
              side_pixels: [64, 64],
            },
          }
        : {
            native_views: Object.fromEntries(
              layouts.map((row) => [String(row.angle), [row.width, row.height]]),
            ),
            rule: "Fixed consumer canvases; furniture tile fields do not apply.",
          },
    preset_guidance:
      "For a generic 16x32 object use furniture preset=prop, which defaults " +
      "to category=decor. chair/desk imply chairs/desks unless category is explicit. Set " +
      "placement and category for the actual object: a thermometer uses placement=wall, " +
      "category=wall. Presets choose native canvas/footprint, not the drawing; never increase " +
      "pixel density to add detail.",
    camera_perspective:
      kind === "furniture"
        ? "pixel-agents renders every asset from a downward-tilted 3/4 camera, never a flat " +
          "front elevation. The object's TOP-FACING surface must dominate the sprite -- most " +
          "of its visible height -- with only a thin front/side edge and legs/base visible at " +
          "the very bottom few pixels. A true front face (a chair's backrest, a desk's front " +
          "apron, a barrel's side wall) is barely visible from this camera; drawing it as the " +
          "main content is the most common mistake. Before adding side/front detail, decide " +
          "how much of the canvas the topmost visible surface should fill -- usually well over " +
          "half the height for floor furniture."
        : "pixel-agents renders every asset from a downward-tilted 3/4 camera, never a " +
          "flat front elevation. On the front ('down') and side views the top of the head/fur " +
          "dominates and eyes/face sit low, near the bottom of the head box -- not a " +
          "conventional face with a visible forehead. The back ('up') view is entirely " +
          "hair/fur with no face at all.",
    pixel_authoring: {
      contract_version: 1,
      required: true,
      tool: "write_pixel_art",
      helpers: "Canvas and PixelArt run on the server. Supply JSON, never imports.",
      schema: "write_pixel_art.definition describes all fields and limits.",
      incremental_workflow:
        "First publish only a small valid base/body covering all " +
        "configured views, then wait. Add one named feature at a time with " +
        "edit_pixel_art(set_layer), render and inspect. Do not resend the whole asset " +
        "after a small error. Initial creation uses write_pixel_art, not edit_pixel_art. " +
        "Use the successful job's result_revision_id for the next edit; get_pixel_art " +
        "is needed only when reading/changing existing source.",
      drawing:
        "For large shapes supply drawing instead of rows: width/height plus " +
        "ordered rect, line, stamp commands. Commands repeat with repeat/dx/dy; mirror_x " +
        "reflects the whole patch. Integer helper pixels only; no antialiasing. Prefer " +
        "rectangles for thick connected posts/platforms and small stamps for motifs. " +
        "Source reads return canonical rows, never executable code.",
      drawing_example: {
        angle: 0,
        frame: null,
        x: 0,
        y: 0,
        drawing: {
          width: 6,
          height: 6,
          commands: [
            { op: "rect", x: 0, y: 0, width: 6, height: 6, color: "D" },
            { op: "rect", x: 1, y: 1, width: 4, height: 4, color: "G" },
          ],
        },
      },
      coordinates: "Native integer pixels, top-left origin; '.' reveals lower layers.",
      views: "Use only configured angles. The server derives exact canvas dimensions.",
      layers:
        "Ordered back to front. Exact-frame pose replaces the null-frame default; " +
        "without a default a layer is hidden in unspecified frames. Every view/frame needs " +
        "a resolved pose with visible ink.",
      editing:
        "get_pixel_art returns definition and revision_id. Use edit_pixel_art " +
        "for targeted move_pose/set_pose/delete_pose/set_layer/delete_layer/set_palette " +
        "operations with expected_revision_id=revision_id. Untouched source is preserved. " +
        "Alternatively write_pixel_art replaces the entire definition: omitted layers/poses " +
        "are deleted. Both validate all source and use mandatory helpers. Wait for the job.",
      example_edit_call: {
        tool: "edit_pixel_art",
        arguments: {
          project_id: "<project.id>",
          expected_revision_id: "<get_pixel_art.revision_id>",
          edits: [
            {
              op: "move_pose",
              layer: "marker",
              angle: 0,
              frame: null,
              x: (firstMarkerPose?.x ?? 0) + 1,
              y: firstMarkerPose?.y ?? 0,
            },
          ],
        },
      },
      features:
        "Reserve connected contrasting clusters, separating gaps and usually " +
        "2px thickness for identifying details before texture. Exaggerate a faucet or gauge; " +
        "simplify nonessential parts. More colors cannot add pixels. Do not enlarge native " +
        "resolution. min_pixels and connected measure visibility after all layers are drawn.",
      palette:
        "2..64 distinct alphanumeric-symbol-to-#RRGGBB colors within the configured " +
        "budget. This palette is fixed for every frame/view. Draw outlines explicitly; " +
        "configure_asset.outline must be false.",
      example_definition: starter,
      example_calls: [
        { tool: "create_project", arguments: { name: "Pixel starter" } },
        {
          tool: "configure_asset",
          arguments: { project_id: "<project.id>", specification: spec },
        },
        {
          tool: "write_pixel_art",
          arguments: {
            project_id: "<project.id>",
            definition: starter,
            expected_revision_id: null,
          },
        },
        { tool: "wait_for_job", arguments: { job_id: "<write job.id>" } },
        { tool: "render_asset", arguments: { project_id: "<project.id>" } },
        { tool: "wait_for_job", arguments: { job_id: "<render job.id>" } },
        { tool: "inspect_asset", arguments: { job_id: "<render job.id>" } },
        {
          tool: "inspect_sprite",
          arguments: {
            job_id: "<render job.id>",
            state_id: firstClipKey,
            angle: 0,
            frame: firstClip?.frames[0],
          },
        },
        {
          tool: "get_asset_preview",
          arguments: { job_id: "<render job.id>", context: true, scale: 4 },
        },
        { tool: "get_pixel_art", arguments: { project_id: "<project.id>" } },
      ],
      example_notes:
        "Replace angle-bracket ID placeholders with prior tool results. " +
        "The starter is a valid small pixel marker, not a finished design; default patches " +
        "are static across all semantic clips. Author the documented distinct poses. " +
        "On nonterminal wait results call wait_for_job again; on failure inspect get_job. " +
        "example_edit_call moves just the front default marker one native pixel right. " +
        "Substitute the current source revision, wait for success, render and inspect again. " +
        "Retrieve job.outputs PNG/JSON/text and small binary resources through get_artifact; " +
        "get_artifact_chunk delivers any file in bounded base64 chunks, no HTTP needed. " +
        "Decode each chunk separately and concatenate raw bytes until next_offset=null. " +
        "Saving locally requires client attachment support.",
    },
    animation: {
      furniture:
        "Each clip is a variant. Animated clips require off_frame; on plays at " +
        "5 fps near working agents, otherwise off is shown.",
      character:
        "walk has 3 poses (left step, neutral, right step), played 0,1,2,1; " +
        "typing and reading each have 2 poses. " +
        "Walking advances every 150ms; work every 300ms. " +
        "Left mirrors right. Work poses are displayed with a 6px sitting offset.",
      pet:
        "walk and idle each have 3 poses. " +
        "Author walk as neutral, left step, right step. " +
        "Walk plays 0,1,0,2 every 150ms; idle " +
        "plays 0,1,2,1 every 300ms. Right walk is 32px wide; left walk mirrors " +
        "right. Right idle uses down idle; left idle uses up idle, without mirroring.",
    }[kind],
    workflow: [
      "create_project",
      "configure_asset",
      "write_pixel_art",
      "wait_for_job",
      "render_asset",
      "wait_for_job",
      "inspect_asset",
      "inspect_sprite",
      "get_asset_preview",
      "get_pixel_art",
    ],
    preview: "Generated context is an approximation; actual webview checked separately.",
  };
}

function pyRepr(value: string): string {
  if (value.includes("'") && !value.includes('"')) return `"${value}"`;
  return `'${value.replace(/'/g, "\\'")}'`;
}

/** Frame lookup by index, throwing instead of returning `undefined` (matches Python's IndexError
 * behavior for a too-short list, and avoids a non-null assertion under `noUncheckedIndexedAccess`
 * for indices this module's callers already guarantee are in range). */
function frameAt(frames: readonly number[], index: number): number {
  const value = frames[index];
  if (value === undefined) {
    throw new DomainError(`Clip has no frame at index ${String(index)}`);
  }
  return value;
}

/** Port of `clip_playback`. */
export function clipPlayback(kind: string, name: string, clip: AssetClip): number[] {
  if (kind === "character" && name === "walk") {
    return [
      frameAt(clip.frames, 0),
      frameAt(clip.frames, 1),
      frameAt(clip.frames, 2),
      frameAt(clip.frames, 1),
    ];
  }
  if (kind === "pet") {
    const indices = name === "walk" ? [0, 1, 0, 2] : [0, 1, 2, 1];
    return indices.map((i) => frameAt(clip.frames, i));
  }
  return clip.frames;
}

/** Port of `clip_duration_ms`. */
export function clipDurationMs(kind: string, name: string): number {
  if (kind === "furniture") return 200;
  return name === "walk" ? 150 : 300;
}

export type { AssetClip };
