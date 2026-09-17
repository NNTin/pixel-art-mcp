/**
 * Port of `tests/unit/test_pixel_agents_pet.py`'s export-behavior case.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { RenderOptionsSchema, renderOptionsRenderFrames } from "@pixel-art-mcp/schema";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decodePngBuffer, createImage, setPixel, writePng } from "./image.js";
import { exportSheet, type RenderManifestLike } from "./pixels.js";

const WALK = { id: "walk", name: "Walk", frame_start: 0, frame_end: 2 };
const IDLE = { id: "idle", name: "Idle", frame_start: 10, frame_end: 12 };

function baseOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tile_width: 1,
    tile_height: 2,
    angles: [0, 90, 180],
    states: [WALK, IDLE],
    pet: { asset_id: "TABBY_CAT", name: "Tabby Cat" },
    ...overrides,
  };
}

function color(angle: number, frame: number): [number, number, number, number] {
  return [(frame * 15) % 256, (Math.trunc(angle) * 2) % 256, 50, 255];
}

describe("exportSheet with options.pet", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pixel-art-imaging-pet-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("packages the pet manifest and asymmetric pet.png grid", () => {
    const options = RenderOptionsSchema.parse({ ...baseOptions(), supersampling: 1 });
    const raw = path.join(dir, "raw");
    const out = path.join(dir, "out");
    const entries: { filename: string; angle: number; frame: number; pivot: [number, number] }[] = [];
    const frames = renderOptionsRenderFrames(options);
    options.angles.forEach((angle, row) => {
      const width = angle === 90 ? 32 : 16;
      for (const frame of frames) {
        const image = createImage(width, 32);
        const [r, g, b, a] = color(angle, frame);
        for (let y = 0; y < 32; y++) for (let x = 0; x < width; x++) setPixel(image, x, y, [r, g, b, a]);
        const name = `${String(row)}_${String(frame)}.png`;
        writePng(path.join(raw, name), image);
        entries.push({ filename: name, angle, frame, pivot: [0, 0] });
      }
    });
    const manifest: RenderManifestLike = { frames: entries, camera: {} };
    exportSheet(raw, out, manifest, options, "p", "r");

    const archive = unzipSync(readFileSync(path.join(out, "pixel-agents-pet.zip")));
    expect(Object.keys(archive).sort()).toEqual(["TABBY_CAT/manifest.json", "TABBY_CAT/pet.png"]);
    const manifestJson = JSON.parse(
      Buffer.from(archive["TABBY_CAT/manifest.json"] as Uint8Array).toString("utf-8"),
    ) as Record<string, unknown>;
    expect(manifestJson).toEqual({ id: "TABBY_CAT", name: "Tabby Cat" });
    const petBytes = archive["TABBY_CAT/pet.png"];
    expect(petBytes).toBeDefined();
    if (!petBytes) return;
    const pet = decodePngBuffer(Buffer.from(petBytes));
    expect([pet.width, pet.height]).toEqual([96, 96]);

    function cellPixel(x: number, y: number): [number, number, number, number] {
      const offset = (y * pet.width + x) * 4;
      return [pet.data[offset] ?? 0, pet.data[offset + 1] ?? 0, pet.data[offset + 2] ?? 0, pet.data[offset + 3] ?? 0];
    }
    const walkFrames = [0, 1, 2];
    const idleFrames = [10, 11, 12];
    walkFrames.forEach((frame, column) => {
      expect(cellPixel(column * 16, 0)).toEqual(color(0, frame));
      expect(cellPixel(column * 16, 32)).toEqual(color(180, frame));
      expect(cellPixel(column * 32, 64)).toEqual(color(90, frame));
    });
    idleFrames.forEach((frame, index) => {
      const column = index + 3;
      expect(cellPixel(column * 16, 0)).toEqual(color(0, frame));
      expect(cellPixel(column * 16, 32)).toEqual(color(180, frame));
    });

    const metadata = JSON.parse(readFileSync(path.join(out, "spritesheet.json"), "utf-8")) as {
      pet: { walk_frames: number[]; idle_frames: number[] };
    };
    expect(metadata.pet.walk_frames).toEqual([0, 1, 2]);
    expect(metadata.pet.idle_frames).toEqual([10, 11, 12]);
  });
});
