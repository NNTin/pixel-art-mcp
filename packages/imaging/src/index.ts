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
  type ContextFrameEntry,
  type ContextGeometry,
  type ContextLayout,
  type ExportContextMetadata,
} from "./context.js";

export {
  compareInspections,
  inspectSprite,
  selectSpriteFrame,
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
  pasteCrop,
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

export { zipDirectory, writeSpritesZip } from "./pack-zip.js";

export {
  ACTIVATION,
  ORIENTATIONS,
  exportPixelAgents,
  type PixelAgentsLayout,
} from "./pixel-agents.js";

export { CHARACTER_PNG_SIZE, DIRECTIONS, exportCharacter } from "./character.js";

export { exportPlayer, type ExportPlayerExtras } from "./player.js";

export {
  MAX_PET_PNG_BYTES,
  PET_FRAME_HEIGHT,
  PET_NARROW_WIDTH,
  PET_PNG_SIZE,
  PET_WIDE_ANGLE,
  PET_WIDE_WIDTH,
  angleWidths,
  exportPetSheet,
} from "./pet.js";

export {
  assetReport,
  exportAsset,
  packageAsset,
  type AssetExportManifest,
  type AssetExportManifestFrame,
} from "./asset-export.js";

export { exportStates } from "./states.js";

export { assetPreview, type AssetPreviewMetadata, type AssetPreviewResult } from "./preview.js";
