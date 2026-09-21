/**
 * Exercises `nativeRender` directly against a real `PixelArt` (from `@pixel-art-mcp/pixel-core`)
 * and a small synthetic `NativeRenderOptions`: manifest shape, blank-transparent-PNG output at
 * the right size (including `supersampling`), and progress-callback bookkeeping.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Canvas, PixelArt } from "@pixel-art-mcp/pixel-core";
import type { AssetLayout } from "@pixel-art-mcp/schema";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nativeRender, type NativeRenderOptions } from "./render.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-engine-render-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function layout(overrides: Partial<AssetLayout> & { angle: number }): AssetLayout {
  return {
    width: 4,
    height: 4,
    footprint_w: 1,
    footprint_h: 1,
    ground_width: 1,
    ground_depth: 1,
    background_tiles: 0,
    margin: 1,
    bottom: 3,
    content_height: 2,
    ...overrides,
  };
}

function makeArt(): PixelArt {
  const art = new PixelArt({ D: "#111111", G: "#eeeeee" }, { 0: [4, 4], 90: [4, 4] });
  art.layer("body", 0, Canvas.fromRows(["D...", ".D..", "..D.", "...D"]));
  art.layer("body", 90, Canvas.fromRows(["D...", ".D..", "..D.", "...D"]));
  return art;
}

describe("nativeRender", () => {
  it("builds the manifest shape and writes a blank transparent PNG per view/frame", () => {
    const art = makeArt();
    const options: NativeRenderOptions = {
      asset_layouts: [layout({ angle: 0 }), layout({ angle: 90, width: 6, height: 4, bottom: 3 })],
      frame_sequence: [1, 2],
      supersampling: 2,
    };
    const seen: { stage: string; completed: number; total: number }[] = [];
    const manifest = nativeRender(options, dir, art, (stage, completed, total) => {
      seen.push({ stage, completed, total });
    });

    expect(manifest.pixel_art).toEqual(art.toDict());
    expect(manifest.camera.projection).toBe("native-grid");
    expect(manifest.camera.alignment).toBe("authored pixels");
    expect(manifest.camera.views).toHaveLength(2);
    expect(manifest.camera.views[0]).toMatchObject({
      angle: 0,
      width: 4,
      height: 4,
      pivot: [2, 3],
      objects: [],
    });
    expect(manifest.camera.views[1]).toMatchObject({
      angle: 90,
      width: 6,
      height: 4,
      pivot: [3, 3],
      objects: [],
    });

    // 2 views * 2 frames = 4 manifest entries, in row-major (view, then frame) order.
    expect(manifest.frames).toHaveLength(4);
    expect(manifest.frames.map((f) => f.filename)).toEqual([
      "view_00_frame_000001.png",
      "view_00_frame_000002.png",
      "view_01_frame_000001.png",
      "view_01_frame_000002.png",
    ]);
    expect(manifest.frames[0]).toMatchObject({
      angle: 0,
      frame: 1,
      pivot: [2, 3],
      size: [4, 4],
    });
    expect(manifest.frames[0]?.pixel_layers).toEqual(art.poses(0, 1));
    expect(manifest.frames[2]?.pixel_layers).toEqual(art.poses(90, 1));

    // Progress is called once per written frame, with a running total of 4.
    expect(seen).toEqual([
      { stage: "rendering", completed: 1, total: 4 },
      { stage: "rendering", completed: 2, total: 4 },
      { stage: "rendering", completed: 3, total: 4 },
      { stage: "rendering", completed: 4, total: 4 },
    ]);

    const files = readdirSync(dir).sort();
    expect(files).toEqual([
      "view_00_frame_000001.png",
      "view_00_frame_000002.png",
      "view_01_frame_000001.png",
      "view_01_frame_000002.png",
    ]);

    // View 0 is supersampled 4x4 * 2 = 8x8, fully transparent (alpha 0 everywhere, and RGB 0
    // too, matching PIL's Image.new("RGBA", size, (0, 0, 0, 0))).
    const png = PNG.sync.read(readFileSync(path.join(dir, files[0] ?? "")));
    expect(png.width).toBe(8);
    expect(png.height).toBe(8);
    expect(png.data.every((byte) => byte === 0)).toBe(true);

    // View 1 (width 6) is supersampled to 12x4.
    const png1 = PNG.sync.read(readFileSync(path.join(dir, files[2] ?? "")));
    expect(png1.width).toBe(12);
    expect(png1.height).toBe(8);
  });

  it("produces no frames and an empty camera when there are no declared views", () => {
    const art = makeArt();
    const options: NativeRenderOptions = {
      asset_layouts: [],
      frame_sequence: [1],
      supersampling: 1,
    };
    const manifest = nativeRender(options, dir, art, () => {
      /* never called */
    });
    expect(manifest.frames).toEqual([]);
    expect(manifest.camera.views).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
});
