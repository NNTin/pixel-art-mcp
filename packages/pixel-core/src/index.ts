/**
 * Public surface of `@pixel-art-mcp/pixel-core`: the protected `Canvas`/`PixelArt` port of
 * `src/pixel_art_mcp/pixel_art.py` (see `docs/typescript-rewrite.md`, Phase 3).
 *
 * `Canvas` and `PixelArt` (and their prototypes) are frozen at module init in their own source
 * files (`canvas.ts` / `pixel-art.ts` -- see the comments there), not here, so the guarantee
 * holds regardless of which module within this package first triggers the freeze. This
 * package's `package.json` `exports` map only publishes this file, so `./canvas.js`/
 * `./pixel-art.js` are not importable from outside the package -- every external consumer only
 * ever sees the already-frozen classes.
 */

export { Canvas } from "./canvas.js";
export { PixelArt } from "./pixel-art.js";
export type {
  AssetLayout,
  AssetValidationSpec,
  Layer,
  LayerOptions,
  PaletteInput,
  PixelArtDict,
  Pose,
  ResolvedPose,
  Scene,
  ViewsInput,
} from "./types.js";
