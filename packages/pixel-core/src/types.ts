/**
 * Structural types shared by `pixel-art.ts`. Field names on the JSON-shaped interfaces
 * (`Pose`, `Layer`, `PixelArtDict`) are intentionally snake_case, matching Python's `to_dict()`
 * output verbatim -- `pixel-core` stores its internal layer/pose data in the same shape it
 * serializes, exactly like the Python source, so there is no separate camelCase-to-snake_case
 * mapping layer to keep in sync (see `docs/typescript-rewrite.md`, Phase 3 / Phase 2's fixture
 * corpus, which asserts this wire shape byte-for-byte).
 *
 * Per the Phase 3 brief, `pixel-core` has zero workspace dependencies: `AssetLayout` and
 * `AssetValidationSpec` below are plain local structural types for what `validateTarget` reads,
 * not imports from `packages/schema`. Later phases are responsible for passing in values that
 * conform (their richer, real `AssetSpec`/layout objects already do).
 */

/** One authored palette+view input, as accepted by `new PixelArt(palette, views)`. */
export type PaletteInput = Record<string, string>;
/**
 * Loosely typed on purpose (a `readonly number[]`, not a fixed 2-tuple): Python's own type hint
 * (`tuple[int, int]`) isn't enforced at runtime either, so `PixelArt`'s constructor validates the
 * shape itself (see its `Declare each consumer view and its native canvas` check) rather than
 * relying on the type checker to guarantee it -- this class must defend itself against
 * untrusted-but-type-checked script input, not just malformed call sites.
 */
export type ViewsInput = Record<number, readonly number[]>;

/** A single authored pose: one layer's pixels at one (angle, frame) combination. */
export interface Pose {
  angle: number;
  frame: number | null;
  rows: string[];
  x: number;
  y: number;
  min_pixels: number;
  connected: boolean;
}

/** A named, ordered stack of poses (one per distinct angle/frame the layer was drawn for). */
export interface Layer {
  name: string;
  poses: Pose[];
}

/** `PixelArt.poses()`'s return shape: a pose plus the name of the layer it came from. */
export interface ResolvedPose extends Pose {
  name: string;
}

/**
 * `PixelArt.toDict()`/`fromDict()`'s wire shape -- the exact JSON Python's `to_dict()` emits.
 * `version` is typed `number`, not the literal `1`: `fromDict` is the entry point for untrusted
 * (e.g. storage-loaded) data and must runtime-check it against `1` itself, the same way Python's
 * `from_dict` does (`data.get("version") != 1`) -- a literal-`1` type would make that check look
 * statically "always true" to the type checker even though the whole point is that real input
 * might not conform.
 */
export interface PixelArtDict {
  version: number;
  palette: Record<string, string>;
  views: Record<string, [number, number]>;
  layers: Layer[];
}

/** Keyword-argument equivalent of `layer(..., *, x=0, y=0, frame=None, ...)`. */
export interface LayerOptions {
  x?: number;
  y?: number;
  frame?: number | null;
  min_pixels?: number;
  connected?: boolean;
}

/** One consumer-declared render view: `validate_target`'s `layouts` entries. */
export interface AssetLayout {
  angle: number;
  width: number;
  height: number;
}

/** The subset of `configure_asset`'s spec that `validate_target` reads. */
export interface AssetValidationSpec {
  outline: boolean;
  colors: number;
  palette?: readonly string[] | null;
}

/**
 * The render "scene": a plain, mutable, injected object other packages read/write project state
 * onto (see `docs/typescript-rewrite.md`, "Core design decisions" -- this replaces the
 * Blender-specific scene concept the Python version briefly had; `pixel-core` itself only reads
 * and writes a single string field, `pixel_art`, so everything else on it is `unknown` here and
 * a later phase's concern).
 */
export type Scene = Record<string, unknown>;
