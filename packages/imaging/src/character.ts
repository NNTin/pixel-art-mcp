/**
 * Export a pixel-index custom-character package: manifest.json + a 112x96 PNG. Verbatim port of
 * `src/pixel_art_mcp/imaging/character.py` (59 lines).
 *
 * See docs/custom-asset-zip-contract.md (pixel-agents-hq/index): 3 direction rows (down, up,
 * right -- top to bottom) x 7 walk-cycle columns, each frame 16x32. manifest.json carries
 * {id, name}, the same minimal shape `pet.ts` writes -- `left` is derived by the pixel-agents
 * client via a horizontal flip of `right` and is never part of the export.
 */

import fs from "node:fs";
import path from "node:path";

import { renderOptionsFrames, type RenderOptions } from "@pixel-art-mcp/schema";

import { createImage, pasteFull, writePng, type RGBAImage } from "./image.js";
import { at } from "./internal.js";
import { zipDirectory } from "./pack-zip.js";

export const CHARACTER_PNG_SIZE: readonly [number, number] = [112, 96];
/** Row order pixel-index's decodeCharacterPng expects, paired with the camera angle (matching
 * furniture's front/right/back/left convention) that produces each one. */
export const DIRECTIONS: readonly (readonly [string, number])[] = [
  ["down", 0],
  ["up", 180],
  ["right", 90],
];

export function exportCharacter(
  outputDir: string,
  options: RenderOptions,
  frames: readonly RGBAImage[],
): Record<string, unknown> | null {
  const target = options.character;
  if (!target) return null;
  const columns = renderOptionsFrames(options).length;
  const sheet = createImage(CHARACTER_PNG_SIZE[0], CHARACTER_PNG_SIZE[1]);
  DIRECTIONS.forEach(([, angle], rowIndex) => {
    const sourceRow = options.angles.indexOf(angle);
    for (let column = 0; column < columns; column++) {
      const frame = at(frames, sourceRow * columns + column);
      pasteFull(sheet, frame, column * options.width, rowIndex * options.height);
    }
  });

  const directory = path.join(outputDir, "pixel-agents-character");
  fs.mkdirSync(directory, { recursive: true });
  writePng(path.join(directory, "character.png"), sheet);
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({ id: target.asset_id, name: target.name }, null, 2),
    "utf-8",
  );
  const archiveName = "pixel-agents-character.zip";
  zipDirectory(directory, path.join(outputDir, archiveName));

  return {
    id: target.asset_id,
    name: target.name,
    archive: archiveName,
    width: CHARACTER_PNG_SIZE[0],
    height: CHARACTER_PNG_SIZE[1],
    directions: DIRECTIONS.map(([name]) => name),
    frames_per_direction: columns,
    install: "Upload the zip to pixel-index — kind, name, and id come from the manifest.",
  };
}
