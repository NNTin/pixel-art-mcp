/**
 * Public surface of `@pixel-art-mcp/imaging`: compositing, quantization, encoding, and
 * diagnostics (Phase 5b-i; see `docs/typescript-rewrite.md`). The asset/pet/character/states
 * packaging layer and the offline sprite/context previews are Phase 5b-ii -- see each module's
 * doc comment and this package's final report for exactly what's stubbed.
 */

export {
  compositeFeatures,
  componentCount,
  connectedComponents,
  largestComponentSize,
  type FeaturePatch,
  type FeatureReport,
} from "./features.js";

export {
  cellVote,
  exportSheet,
  packSprites,
  paletteFromSamples,
  pixelate,
  sampleSourceColors,
  type PackSpritesExtras,
  type RenderManifestFrame,
  type RenderManifestLike,
} from "./pixels.js";

export { saveAnimatedGif } from "./gif.js";

export { encodeApng, parsePngChunks, type ApngOptions, type PngChunk } from "./apng.js";

export {
  BACKGROUND_COLOR,
  contextGeometry,
  contextImage,
  exportContext,
  luma,
  referenceAgent,
  type ContextGeometry,
  type ContextLayout,
} from "./context.js";

export {
  compareInspections,
  inspectSprite,
  type ComparisonResult,
  type ContrastBoundary,
  type InspectionResult,
  type PaletteColorReport,
  type SelectionState,
  type SpritesheetFrameEntry,
  type SpritesheetMetadata,
} from "./inspection.js";

export {
  boxDownscaleAlpha,
  cloneImage,
  createImage,
  decodePngBuffer,
  encodePngBuffer,
  getPixel,
  isWithinDirectory,
  pasteFull,
  readPng,
  resizeNearest,
  setPixel,
  thumbnailNearest,
  writePng,
  type Rgba,
  type RGBAImage,
} from "./image.js";

export {
  hexToRgb,
  medianCutPalette,
  nearestPaletteIndex,
  rgbToHex,
  type Rgb,
} from "./quantize.js";
