/**
 * Export a pixel-index custom-pet package: manifest.json + a 96x96 pet.png. Verbatim port of
 * `src/pixel_art_mcp/imaging/pet.py` (149 lines).
 *
 * See docs/custom-asset-zip-contract.md (pixel-agents-hq/index): row 0 (y=0..32) is
 * walkDown[0..2]+idleDown[0..2] at 16x32 each; row 1 (y=32..64) is the same for `up`; row 2
 * (y=64..96) is walkRight[0..2] at 32x32 each -- rendered at double width by the per-angle
 * render width (see `angleWidths` below, shared with the job worker that decides render
 * resolution). idleRight doesn't exist in the contract: idle-state right-facing frames are still
 * rendered (one shared render pass covers every state at every angle) but simply not used here.
 */

import fs from "node:fs";
import path from "node:path";

import { DomainError, renderOptionsRenderFrames, renderStateFrames, type RenderOptions } from "@pixel-art-mcp/schema";

import { createImage, isWithinDirectory, pasteFull, readPng, writePng, type RGBAImage } from "./image.js";
import { at, defined } from "./internal.js";
import { writeSpritesZip, zipDirectory } from "./pack-zip.js";
import { pixelate } from "./pixels.js";

export const PET_PNG_SIZE: readonly [number, number] = [96, 96];
export const PET_FRAME_HEIGHT = 32;
export const PET_NARROW_WIDTH = 16;
export const PET_WIDE_WIDTH = 32;
export const PET_WIDE_ANGLE = 90;
/** Documented (not pixel-index-enforced) per-pet-PNG compatibility cap -- see the contract doc's
 * note on upstream's own MAX_PET_PNG_SIZE. */
export const MAX_PET_PNG_BYTES = 512 * 1024;

/** Per-angle render width for a pet job: double width for the `right` (90deg) row, matching the
 * contract's wider side-view canvas. Used both by the job worker (to tell the renderer, from the
 * raw job options) and by this module (to decode the resulting raw PNGs, from a validated
 * RenderOptions). */
export function angleWidths(width: number, angles: readonly number[]): number[] {
  return angles.map((angle) => (angle === PET_WIDE_ANGLE ? PET_WIDE_WIDTH : width));
}

interface PetManifestFrame {
  angle: number;
  frame: number;
  filename: string;
}

interface PetManifest {
  frames: readonly PetManifestFrame[];
  camera: Record<string, unknown>;
}

function cellKey(angle: number, frame: number): string {
  return `${String(angle)}:${String(frame)}`;
}

export function exportPetSheet(
  rawDir: string,
  outputDir: string,
  manifest: PetManifest,
  options: RenderOptions,
  projectId: string,
  revisionId: string,
): void {
  const target = options.pet;
  const states = options.states;
  if (!target || !states) {
    throw new Error("exportPetSheet requires options.pet and options.states");
  }
  const walk = defined(
    states.find((state) => state.id === "walk"),
    "pet walk state",
  );
  const idle = defined(
    states.find((state) => state.id === "idle"),
    "pet idle state",
  );

  const entries = manifest.frames;
  const renderedFrames = renderOptionsRenderFrames(options);
  if (entries.length !== options.angles.length * renderedFrames.length) {
    throw new DomainError("Render output has an incomplete pet frame sequence");
  }
  const byKey = new Map<string, PetManifestFrame>();
  for (const entry of entries) byKey.set(cellKey(entry.angle, entry.frame), entry);
  const widthsByAngle = new Map<number, number>();
  angleWidths(options.width, options.angles).forEach((width, index) => {
    widthsByAngle.set(at(options.angles, index), width);
  });

  const resolvedRawDir = path.resolve(rawDir);
  function load(angle: number, frame: number, width: number): RGBAImage {
    const entry = byKey.get(cellKey(angle, frame));
    if (!entry) throw new DomainError("Render output is missing a required pet frame");
    const resolvedPath = path.resolve(rawDir, entry.filename);
    if (!isWithinDirectory(resolvedRawDir, resolvedPath) || path.extname(resolvedPath) !== ".png") {
      throw new DomainError("Invalid render output path");
    }
    const source = readPng(resolvedPath);
    const expectedWidth = width * options.supersampling;
    const expectedHeight = options.height * options.supersampling;
    if (source.width !== expectedWidth || source.height !== expectedHeight) {
      throw new DomainError("Render output has unexpected image dimensions");
    }
    return source;
  }

  const walkFrames = renderStateFrames(walk);
  const idleFrames = renderStateFrames(idle);

  // The ordered list of (angle, frame, width) cells this pet needs. One shared palette is
  // derived across all of them (via `pixelate()`) so the down/up rows and the wider right row
  // share consistent colors.
  const cells: [number, number, number][] = [];
  for (const angle of [0, 180]) {
    for (const frame of [...walkFrames, ...idleFrames]) {
      cells.push([angle, frame, defined(widthsByAngle.get(angle), `render width for angle ${String(angle)}`)]);
    }
  }
  for (const frame of walkFrames) {
    cells.push([
      PET_WIDE_ANGLE,
      frame,
      defined(widthsByAngle.get(PET_WIDE_ANGLE), "render width for the wide angle"),
    ]);
  }

  const sources = cells.map(([angle, frame, width]) => load(angle, frame, width));
  const sizes: [number, number][] = cells.map(([, , width]) => [width, options.height]);
  const [rendered, palette] = pixelate(sources, options, sizes);
  const byCell = new Map<string, RGBAImage>();
  cells.forEach(([angle, frame], index) => byCell.set(cellKey(angle, frame), at(rendered, index)));

  const sheet = createImage(PET_PNG_SIZE[0], PET_PNG_SIZE[1]);

  function pasteRow(y: number, angle: number, frames: readonly number[], width: number): void {
    let x = 0;
    for (const frame of frames) {
      pasteFull(sheet, defined(byCell.get(cellKey(angle, frame)), "pet cell"), x, y);
      x += width;
    }
  }
  pasteRow(0, 0, [...walkFrames, ...idleFrames], PET_NARROW_WIDTH);
  pasteRow(PET_FRAME_HEIGHT, 180, [...walkFrames, ...idleFrames], PET_NARROW_WIDTH);
  pasteRow(PET_FRAME_HEIGHT * 2, PET_WIDE_ANGLE, walkFrames, PET_WIDE_WIDTH);

  fs.mkdirSync(outputDir, { recursive: true });
  const packageRoot = path.join(outputDir, "pixel-agents-pet");
  const directory = path.join(packageRoot, target.asset_id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({ id: target.asset_id, name: target.name }, null, 2),
    "utf-8",
  );
  const pngPath = path.join(directory, "pet.png");
  writePng(pngPath, sheet);
  if (fs.statSync(pngPath).size > MAX_PET_PNG_BYTES) {
    throw new DomainError(
      `Generated pet.png exceeds pixel-agents' ${String(MAX_PET_PNG_BYTES)}-byte per-pet ` +
        "compatibility cap; reduce colors or simplify the model",
    );
  }

  const archiveName = "pixel-agents-pet.zip";
  zipDirectory(packageRoot, path.join(outputDir, archiveName));

  const metadata = {
    schema_version: 1,
    project_id: projectId,
    revision_id: revisionId,
    image: `pixel-agents-pet/${target.asset_id}/pet.png`,
    size: [PET_PNG_SIZE[0], PET_PNG_SIZE[1]],
    palette,
    transparent: true,
    settings: options,
    pet: {
      asset_id: target.asset_id,
      name: target.name,
      manifest: `pixel-agents-pet/${target.asset_id}/manifest.json`,
      archive: archiveName,
      width: PET_PNG_SIZE[0],
      height: PET_PNG_SIZE[1],
      walk_frames: walkFrames,
      idle_frames: idleFrames,
      install: "Upload pet.png + manifest.json to pixel-index with assetKind=pet.",
    },
    camera: manifest.camera,
  };
  fs.writeFileSync(path.join(outputDir, "spritesheet.json"), JSON.stringify(metadata, null, 2), "utf-8");
  writeSpritesZip(outputDir);
}
