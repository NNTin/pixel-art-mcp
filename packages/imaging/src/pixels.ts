/**
 * The shared downscale/quantize/pack pipeline. Port of `src/pixel_art_mcp/imaging/pixels.py`
 * (340 lines).
 */

import fs from "node:fs";
import path from "node:path";

import { DomainError, renderOptionsFrames, renderOptionsRenderFrames } from "@pixel-art-mcp/schema";
import type { RenderOptions } from "@pixel-art-mcp/schema";

import { encodeApng } from "./apng.js";
import { exportAsset, type AssetExportManifest } from "./asset-export.js";
import { exportCharacter } from "./character.js";
import { saveAnimatedGif } from "./gif.js";
import {
  boxDownscaleAlpha,
  createImage,
  isWithinDirectory,
  pasteFull,
  readPng,
  resizeNearest,
  thumbnailNearest,
  writePng,
  type RGBAImage,
} from "./image.js";
import { at } from "./internal.js";
import { writeSpritesZip } from "./pack-zip.js";
import { exportPixelAgents } from "./pixel-agents.js";
import { exportPetSheet } from "./pet.js";
import { exportPlayer } from "./player.js";
import { hexToRgb, medianCutPalette, nearestPaletteIndex, rgbToHex, type Rgb } from "./quantize.js";
import { exportStates, type StatesExportManifest } from "./states.js";

// ---------------------------------------------------------------------------------------------
// palette_from_samples / sample_source_colors
// ---------------------------------------------------------------------------------------------

export function paletteFromSamples(samples: readonly Rgb[], options: RenderOptions): Rgb[] {
  if (options.palette) {
    return options.palette.map((color) => hexToRgb(color));
  }
  if (samples.length === 0) return [[0, 0, 0]];
  return medianCutPalette(samples, options.colors);
}

export function sampleSourceColors(
  image: RGBAImage,
  budget: number,
  alphaThreshold: number,
): Rgb[] {
  const totalPixels = image.width * image.height;
  const stride = Math.max(1, Math.ceil(totalPixels / Math.max(1, budget)));
  const samples: Rgb[] = [];
  for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex += stride) {
    const offset = pixelIndex * 4;
    const alpha = at(image.data, offset + 3);
    if (alpha >= alphaThreshold) {
      samples.push([
        at(image.data, offset),
        at(image.data, offset + 1),
        at(image.data, offset + 2),
      ]);
    }
  }
  return samples;
}

// ---------------------------------------------------------------------------------------------
// _cell_vote
// ---------------------------------------------------------------------------------------------

/**
 * Classifies once against the job palette, then votes locally with alpha weights. No per-frame
 * clustering: changing a flame cannot recolor an unchanged barrel. Ties use palette order, never
 * frame content or random state.
 */
export function cellVote(
  source: RGBAImage,
  size: readonly [number, number],
  palette: readonly Rgb[],
): RGBAImage {
  const [outWidth, outHeight] = size;
  if (source.width % outWidth !== 0 || source.height % outHeight !== 0) {
    throw new DomainError("Crisp conversion requires integer supersampling");
  }
  const sx = source.width / outWidth;
  const sy = source.height / outHeight;
  const totalSource = source.width * source.height;

  const labels = new Uint8Array(totalSource);
  for (let i = 0; i < totalSource; i++) {
    const offset = i * 4;
    labels[i] = nearestPaletteIndex(
      [at(source.data, offset), at(source.data, offset + 1), at(source.data, offset + 2)],
      palette,
    );
  }

  const output = createImage(outWidth, outHeight);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const votes = new Map<number, number>();
      for (let dy = 0; dy < sy; dy++) {
        const rowStart = (y * sy + dy) * source.width + x * sx;
        for (let i = rowStart; i < rowStart + sx; i++) {
          const alpha = at(source.data, i * 4 + 3);
          const label = at(labels, i);
          if (alpha) votes.set(label, (votes.get(label) ?? 0) + alpha);
        }
      }
      let winner = 0;
      if (votes.size > 0) {
        let bestVotes = -1;
        // Ascending key order + strict `>` keeps the lowest palette index on a tie.
        for (const label of [...votes.keys()].sort((a, b) => a - b)) {
          const count = votes.get(label) ?? 0;
          if (count > bestVotes) {
            bestVotes = count;
            winner = label;
          }
        }
      }
      const color = palette[winner] ?? [0, 0, 0];
      const offset = (y * outWidth + x) * 4;
      output.data[offset] = color[0];
      output.data[offset + 1] = color[1];
      output.data[offset + 2] = color[2];
      output.data[offset + 3] = 255;
    }
  }

  const alpha = boxDownscaleAlpha(source, outWidth, outHeight, sx, sy);
  for (let i = 0; i < outWidth * outHeight; i++) output.data[i * 4 + 3] = at(alpha, i);
  return output;
}

// ---------------------------------------------------------------------------------------------
// pixelate
// ---------------------------------------------------------------------------------------------

/**
 * Downscale + quantize to one shared palette. `sizes`, one `[width, height]` pair per frame,
 * overrides the uniform `(options.width, options.height)` target -- used by the (not yet ported,
 * Phase 5b-ii) pet export, whose right-facing row renders at double width.
 */
export function pixelate(
  frames: readonly RGBAImage[],
  options: RenderOptions,
  sizes?: readonly (readonly [number, number])[],
): [RGBAImage[], string[]] {
  const sources: { source: RGBAImage; size: [number, number] }[] = [];
  const sourceSamples: Rgb[] = [];
  const expectedFrames = Math.max(
    1,
    options.angles.length * renderOptionsRenderFrames(options).length,
  );
  const sampleBudget = Math.max(1, Math.floor(262_144 / expectedFrames));

  frames.forEach((source, index) => {
    const override = sizes?.[index];
    const size: [number, number] = override
      ? [override[0], override[1]]
      : [options.width, options.height];
    if (options.palette === null) {
      sourceSamples.push(...sampleSourceColors(source, sampleBudget, options.alpha_threshold));
    }
    sources.push({ source, size });
  });

  const colors = paletteFromSamples(sourceSamples, options);

  const outputs: RGBAImage[] = [];
  for (const { source, size } of sources) {
    const voted = cellVote(source, size, colors);
    const result = createImage(size[0], size[1]);
    const totalPixels = size[0] * size[1];
    for (let i = 0; i < totalPixels; i++) {
      const offset = i * 4;
      const alpha = at(voted.data, offset + 3);
      // Transparent RGB is canonical, avoiding color fringes in consuming engines: a pixel
      // below the alpha threshold stays (0, 0, 0, 0), the array's zero-initialized default.
      if (alpha >= options.alpha_threshold) {
        result.data[offset] = at(voted.data, offset);
        result.data[offset + 1] = at(voted.data, offset + 1);
        result.data[offset + 2] = at(voted.data, offset + 2);
        result.data[offset + 3] = 255;
      }
    }
    outputs.push(result);
  }

  return [outputs, colors.map((color) => rgbToHex(color))];
}

// ---------------------------------------------------------------------------------------------
// export_sheet
// ---------------------------------------------------------------------------------------------

export interface RenderManifestFrame {
  filename: string;
  angle: number;
  frame: number;
  pivot: [number, number];
}

export interface RenderManifestLike {
  frames: readonly RenderManifestFrame[];
  camera: Record<string, unknown>;
}

/**
 * Dispatches to the asset/pet/states-specific export functions (`asset-export.ts::exportAsset`/
 * `pet.ts::exportPetSheet`/`states.ts::exportStates`). Everything below those three branches is
 * the **generic fallback path** ("else" branch in the Python source): the shape every one of
 * those specific exports eventually calls back into (directly, or -- for `exportStates` -- via a
 * recursive `exportSheet` call per named state).
 */
export function exportSheet(
  rawDir: string,
  outputDir: string,
  manifest: RenderManifestLike,
  options: RenderOptions,
  projectId: string,
  revisionId: string,
): void {
  if (options.asset) {
    // The generic `RenderManifestLike` frame shape omits `pixel_layers`/`pixel_art` -- present at
    // runtime whenever `options.asset` is set (the engine's own render-manifest builder attaches
    // them), just not part of the shared type every `exportSheet` caller uses.
    exportAsset(
      rawDir,
      outputDir,
      manifest as unknown as AssetExportManifest,
      options,
      projectId,
      revisionId,
    );
    return;
  }
  if (options.pet) {
    // Checked before options.states: pet also configures its walk/idle frame roles through
    // options.states, but its packaging (a single asymmetric-grid PNG, no per-state
    // player/variants) has nothing in common with the general multi-state furniture machinery
    // below.
    exportPetSheet(rawDir, outputDir, manifest, options, projectId, revisionId);
    return;
  }
  if (options.states) {
    exportStates(
      rawDir,
      outputDir,
      manifest as StatesExportManifest,
      options,
      projectId,
      revisionId,
    );
    return;
  }

  const entries = manifest.frames;
  const renderedFrames = renderOptionsRenderFrames(options);
  const expected = options.angles.length * renderedFrames.length;
  if (entries.length !== expected) {
    throw new DomainError("Render output has an incomplete frame sequence");
  }

  const columns = renderOptionsFrames(options).length;
  const rows = options.angles.length;
  const highWidth = options.width * options.supersampling;
  const highHeight = options.height * options.supersampling;
  const highSheet = createImage(columns * highWidth, rows * highHeight);
  const off = options.pixel_agents ? options.pixel_agents.off_frame : null;
  const highOff = off !== null ? createImage(highWidth, rows * highHeight) : null;

  const resolvedRawDir = path.resolve(rawDir);
  const sources: RGBAImage[] = [];
  // The Python source decodes/downsizes one supersampled image at a time via a generator, to
  // bound peak memory. This port reads every source up front instead -- simpler, and acceptable
  // for the sprite-sized images this pipeline handles -- flagged in this package's final report
  // as a deliberate simplification a later phase could revisit if truly large sheets matter.
  entries.forEach((entry, index) => {
    const row = Math.floor(index / renderedFrames.length);
    const column = index % renderedFrames.length;
    if (entry.angle !== options.angles[row] || entry.frame !== renderedFrames[column]) {
      throw new DomainError("Render output has frames in an unexpected order");
    }
    const resolvedPath = path.resolve(rawDir, entry.filename);
    if (!isWithinDirectory(resolvedRawDir, resolvedPath) || path.extname(resolvedPath) !== ".png") {
      throw new DomainError("Invalid render output path");
    }
    const source = readPng(resolvedPath);
    const expectedWidth = options.width * options.supersampling;
    const expectedHeight = options.height * options.supersampling;
    if (source.width !== expectedWidth || source.height !== expectedHeight) {
      throw new DomainError("Render output has unexpected image dimensions");
    }
    if (column < columns) {
      pasteFull(highSheet, source, column * highWidth, row * highHeight);
    }
    if (highOff !== null && entry.frame === off) {
      pasteFull(highOff, source, 0, row * highHeight);
    }
    sources.push(source);
  });

  const [rendered, palette] = pixelate(sources, options);
  const indices: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++)
      indices.push(row * renderedFrames.length + column);
  }
  const frames = indices.map((i) => at(rendered, i));
  const offFrames =
    off !== null
      ? Array.from({ length: rows }, (_unused, row) =>
          at(rendered, row * renderedFrames.length + renderedFrames.indexOf(off)),
        )
      : undefined;

  const comparisonDir = path.join(outputDir, "comparison");
  fs.mkdirSync(comparisonDir, { recursive: true });
  writePng(path.join(comparisonDir, "high-resolution.png"), highSheet);
  if (highOff !== null) writePng(path.join(comparisonDir, "off-high-resolution.png"), highOff);

  const comparison = {
    image: "comparison/high-resolution.png",
    width: highWidth,
    height: highHeight,
    off_image: highOff !== null ? "comparison/off-high-resolution.png" : null,
    usage: "comparison_only",
    higher_resolution: options.supersampling > 1,
  };

  packSprites(
    frames,
    palette,
    outputDir,
    { ...manifest, frames: indices.map((i) => at(entries, i)) },
    options,
    projectId,
    revisionId,
    { offFrames, comparison },
  );
}

// ---------------------------------------------------------------------------------------------
// pack_sprites
// ---------------------------------------------------------------------------------------------

interface FrameMetadataEntry {
  filename: string;
  angle: number;
  frame: number;
  rect: [number, number, number, number];
  pivot: [number, number];
  duration_ms: number;
}

interface DirectionEntry {
  angle: number;
  row: number;
  frame_indices: number[];
  animation: string | null;
}

export interface PackSpritesExtras {
  offFrames?: readonly RGBAImage[];
  comparison?: Record<string, unknown> | null;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Package already converted sprites without changing their colors or placement. */
export function packSprites(
  frames: readonly RGBAImage[],
  palette: readonly string[],
  outputDir: string,
  manifest: RenderManifestLike,
  options: RenderOptions,
  projectId: string,
  revisionId: string,
  extras: PackSpritesExtras = {},
): void {
  const entries = manifest.frames;
  const framesList = renderOptionsFrames(options);
  const columns = framesList.length;
  const rows = options.angles.length;
  if (frames.length !== rows * columns || entries.length !== frames.length) {
    throw new DomainError("Cannot pack an incomplete frame sequence");
  }
  const isValidRgba = (im: RGBAImage): boolean =>
    im.width === options.width &&
    im.height === options.height &&
    im.data.length === im.width * im.height * 4;
  if (frames.some((im) => !isValidRgba(im))) {
    throw new DomainError("Cannot pack sprites with unexpected dimensions or color mode");
  }

  const sheet = createImage(columns * options.width, rows * options.height);
  fs.mkdirSync(outputDir, { recursive: true });
  const frameDir = path.join(outputDir, "frames");
  fs.mkdirSync(frameDir, { recursive: true });

  const frameMetadata: FrameMetadataEntry[] = frames.map((im, index) => {
    const entry = at(entries, index);
    const row = Math.floor(index / columns);
    const column = index % columns;
    if (entry.angle !== options.angles[row] || entry.frame !== framesList[column]) {
      throw new DomainError("Render output has frames in an unexpected order");
    }
    const name = `direction_${pad(row, 2)}_frame_${pad(entry.frame, 6)}.png`;
    writePng(path.join(frameDir, name), im);
    const x = column * options.width;
    const y = row * options.height;
    pasteFull(sheet, im, x, y);
    return {
      filename: `frames/${name}`,
      angle: entry.angle,
      frame: entry.frame,
      rect: [x, y, im.width, im.height],
      pivot: entry.pivot,
      duration_ms: 1000 / options.fps,
    };
  });

  writePng(path.join(outputDir, "spritesheet.png"), sheet);

  const scale = Math.min(4, Math.max(1, Math.floor(1024 / Math.max(sheet.width, sheet.height))));
  let preview = resizeNearest(sheet, sheet.width * scale, sheet.height * scale);
  if (Math.max(preview.width, preview.height) > 1024) preview = thumbnailNearest(preview, 1024);
  writePng(path.join(outputDir, "preview.png"), preview);

  if (columns > 1) {
    const gifWidth = options.width;
    const gifHeight = rows * options.height;
    const gifScale = Math.min(4, Math.max(1, Math.floor(1024 / Math.max(gifWidth, gifHeight))));
    const gifFrames: RGBAImage[] = [];
    for (let column = 0; column < columns; column++) {
      let composite = createImage(gifWidth, gifHeight);
      for (let row = 0; row < rows; row++) {
        pasteFull(composite, at(frames, row * columns + column), 0, row * options.height);
      }
      composite = resizeNearest(composite, composite.width * gifScale, composite.height * gifScale);
      if (Math.max(composite.width, composite.height) > 1024)
        composite = thumbnailNearest(composite, 1024);
      gifFrames.push(composite);
    }
    saveAnimatedGif(gifFrames, palette, options.fps, path.join(outputDir, "preview.gif"));
  }

  const directions: DirectionEntry[] = options.angles.map((angle, row) => {
    const frameIndices = Array.from(
      { length: columns },
      (_unused, column) => row * columns + column,
    );
    let animation: string | null = null;
    if (columns > 1) {
      animation = `animations/direction_${pad(row, 2)}.apng`;
      fs.mkdirSync(path.join(outputDir, "animations"), { recursive: true });
      const sequence = frameIndices.map((i) => at(frames, i));
      // SOURCE replaces changed pixels, including newly transparent pixels. OVER would leave
      // trails when a flame shrinks or an object moves. See apng.ts's doc comment.
      const apng = encodeApng(sequence, { delayMs: 1000 / options.fps, disposeOp: 0, blendOp: 0 });
      fs.writeFileSync(path.join(outputDir, animation), apng);
    }
    return { angle, row, frame_indices: frameIndices, animation };
  });

  let offImage: string | null = null;
  if (extras.offFrames) {
    const offSheet = createImage(options.width, rows * options.height);
    extras.offFrames.forEach((im, row) => {
      pasteFull(offSheet, im, 0, row * options.height);
    });
    offImage = "off-spritesheet.png";
    writePng(path.join(outputDir, offImage), offSheet);
  }

  const target = exportPixelAgents(outputDir, options, frames, extras.offFrames ?? null);
  const character = exportCharacter(outputDir, options, frames);
  exportPlayer(outputDir, options, {
    comparison: extras.comparison ?? null,
    target,
    offImage,
  });

  const metadata = {
    schema_version: 1,
    project_id: projectId,
    revision_id: revisionId,
    image: "spritesheet.png",
    size: [sheet.width, sheet.height],
    columns,
    rows,
    palette,
    transparent: true,
    settings: options,
    frames: frameMetadata,
    directions,
    player: "preview.html",
    pixel_agents: target,
    character,
    comparison: extras.comparison ?? null,
    off_image: offImage,
    camera: manifest.camera,
  };
  fs.writeFileSync(
    path.join(outputDir, "spritesheet.json"),
    JSON.stringify(metadata, null, 2),
    "utf-8",
  );

  // `sprites.zip`: every file `packSprites` wrote under `outputDir`, deflated (see `pack-zip.ts`
  // for the `fflate` archiver, split out to keep this already-large module focused).
  writeSpritesZip(outputDir);
}
