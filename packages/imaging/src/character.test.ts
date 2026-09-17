/**
 * Port of `tests/unit/test_character.py`'s export-behavior case (the pure-schema-validation
 * cases are already covered by `packages/schema`'s own contract-fixture tests).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { RenderOptionsSchema } from "@pixel-art-mcp/schema";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decodePngBuffer, readPng, setPixel, createImage, writePng } from "./image.js";
import { exportSheet, type RenderManifestLike } from "./pixels.js";

describe("exportSheet with options.character", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pixel-art-imaging-character-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("packs a 112x96 3-row character sheet whose manifest and pixels match the general spritesheet", () => {
    const options = RenderOptionsSchema.parse({
      tile_width: 1,
      tile_height: 2,
      angles: [0, 90, 180],
      frame_start: 0,
      frame_end: 6,
      supersampling: 1,
      character: { asset_id: "HERO", name: "Hero" },
    });
    const raw = path.join(dir, "raw");
    const out = path.join(dir, "out");
    const entries: { filename: string; angle: number; frame: number; pivot: [number, number] }[] = [];
    options.angles.forEach((angle, row) => {
      for (let frame = 0; frame <= 6; frame++) {
        const image = createImage(16, 32);
        const bottom = Math.min(31, 13 + frame);
        for (let y = 2; y <= bottom; y++) {
          for (let x = 2; x <= 13; x++) {
            setPixel(image, x, y, [(10 * frame) % 256, (20 * row) % 256, 40, 255]);
          }
        }
        const name = `${String(row)}_${String(frame)}.png`;
        writePng(path.join(raw, name), image);
        entries.push({ filename: name, angle, frame, pivot: [8, 28] });
      }
    });
    const manifest: RenderManifestLike = { frames: entries, camera: {} };
    exportSheet(raw, out, manifest, options, "p", "r");

    const metadataText = readFileSync(path.join(out, "spritesheet.json"), "utf-8");
    expect(metadataText).toContain('"character"');

    const sheet = readPng(path.join(out, "spritesheet.png"));
    const archive = unzipSync(readFileSync(path.join(out, "pixel-agents-character.zip")));
    expect(new Set(Object.keys(archive))).toEqual(new Set(["character.png", "manifest.json"]));
    expect(JSON.parse(Buffer.from(archive["manifest.json"] as Uint8Array).toString("utf-8"))).toEqual({
      id: "HERO",
      name: "Hero",
    });
    const characterBytes = archive["character.png"];
    expect(characterBytes).toBeDefined();
    if (!characterBytes) return;
    const character = decodePngBuffer(Buffer.from(characterBytes));
    expect([character.width, character.height]).toEqual([112, 96]);

    ([
      ["down", 0],
      ["up", 180],
      ["right", 90],
    ] as const).forEach(([, angle], rowIndex) => {
      const sourceRow = options.angles.indexOf(angle);
      for (let column = 0; column < 7; column++) {
        for (let y = 0; y < 32; y++) {
          for (let x = 0; x < 16; x++) {
            const expectedOffset = ((sourceRow * 32 + y) * sheet.width + (column * 16 + x)) * 4;
            const actualOffset = ((rowIndex * 32 + y) * character.width + (column * 16 + x)) * 4;
            expect(Array.from(character.data.slice(actualOffset, actualOffset + 4))).toEqual(
              Array.from(sheet.data.slice(expectedOffset, expectedOffset + 4)),
            );
          }
        }
      }
    });
  });
});
