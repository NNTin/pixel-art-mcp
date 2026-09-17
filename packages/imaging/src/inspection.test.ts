/**
 * Port of `tests/unit/test_inspection.py`, plus a hard-fail test for the correctness guarantee
 * the whole pipeline depends on (an opaque pixel that doesn't exactly match a declared palette
 * entry) which the Python suite doesn't exercise directly but `inspect_sprite`'s own source
 * (`raise DomainError("Sprite contains opaque colors outside its declared shared palette")`)
 * documents as load-bearing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DomainError, RenderOptionsSchema } from "@pixel-art-mcp/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createImage, readPng, setPixel, writePng, type RGBAImage } from "./image.js";
import { compareInspections, inspectSprite } from "./inspection.js";
import { at } from "./internal.js";
import { packSprites, type RenderManifestLike } from "./pixels.js";

function makeExport(dir: string, gaugeHeight: number): string {
  const options = RenderOptionsSchema.parse({
    width: 8,
    height: 8,
    angles: [0],
    palette: ["#603010", "#40dfe0"],
  });
  const sprite = createImage(8, 8);
  for (let y = 2; y < 8; y++) {
    for (let x = 1; x < 7; x++) setPixel(sprite, x, y, [96, 48, 16, 255]);
  }
  for (let y = 7 - gaugeHeight; y < 7; y++) setPixel(sprite, 5, y, [64, 223, 224, 255]);
  const manifest: RenderManifestLike = { frames: [{ filename: "", angle: 0, frame: 1, pivot: [4, 7] }], camera: {} };
  const output = path.join(dir, String(gaugeHeight));
  packSprites([sprite], ["#603010", "#40dfe0"], output, manifest, options, "project", "revision");
  return output;
}

describe("inspectSprite / compareInspections", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pixel-art-imaging-inspect-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports grid/palette/cluster analysis and compares two exports", () => {
    const first = inspectSprite(makeExport(dir, 2));
    const second = inspectSprite(makeExport(dir, 4));

    expect(first.state).toBeNull();
    expect(first.angle).toBe(0);
    expect(first.frame).toBe(1);
    expect(first.analysis.occupied_bounds).toEqual([1, 2, 6, 6]);
    expect(first.grid.rows).toHaveLength(8);
    expect(first.grid.rows[0]).toBe("00 .. .. .. .. .. .. .. ..");

    const cyan = second.palette.find((c) => c.hex === "#40dfe0");
    expect(cyan).toBeDefined();
    expect(cyan?.description).toBe("light cyan");
    expect(cyan?.pixels).toBe(4);
    expect(cyan?.longest_vertical_run).toBe(4);

    const comparison = compareInspections(first, second);
    expect(comparison.changed_pixels).toBe(2);
    expect(comparison.alpha_changed_pixels).toBe(0);
    expect(first.analysis.opaque_connected_components).toBe(1);
    expect(first.analysis.color_components).toBe(2);
    expect(comparison.opaque_connected_component_delta).toBe(0);
    expect(comparison.color_component_delta).toBe(0);
  });

  it("counts a same-color singleton distinctly from a detached opaque pixel", () => {
    const root = makeExport(dir, 2);
    const original = inspectSprite(root);
    const filePath = path.join(root, original.filename);
    const image = readPng(filePath);
    setPixel(image, 2, 3, [64, 223, 224, 255]); // A cyan pixel inside the brown blob: a color
    // singleton, but still opaque-connected to its neighbors.
    writePng(filePath, image);
    const marked = inspectSprite(root);
    expect(marked.analysis.opaque_connected_components).toBe(1);
    expect(marked.analysis.opaque_singleton_components).toBe(0);
    expect(marked.analysis.color_components).toBe(3);
    expect(marked.analysis.color_singleton_components).toBe(1);
    expect(Object.keys(marked.analysis)).not.toContain("opaque_components");
    expect(Object.keys(marked.analysis)).not.toContain("singleton_components");

    const delta = compareInspections(original, marked);
    expect(delta.opaque_connected_component_delta).toBe(0);
    expect(delta.color_component_delta).toBe(1);
    expect(delta.color_singleton_component_delta).toBe(1);

    setPixel(image, 0, 0, [96, 48, 16, 255]); // Genuinely detached opaque pixel this time.
    writePng(filePath, image);
    const detached = inspectSprite(root);
    expect(detached.analysis.opaque_connected_components).toBe(2);
    expect(detached.analysis.opaque_singleton_components).toBe(1);
    expect(detached.analysis.color_singleton_components).toBe(2);
    expect(detached.metric_definitions["color_singleton_components"]).toContain("not necessarily detached");
  });

  it("handles an empty sprite and treats diagonal-only neighbors as disconnected", () => {
    const root = makeExport(dir, 2);
    const filePath = path.join(root, inspectSprite(root).filename);
    writePng(filePath, createImage(8, 8));
    const empty = inspectSprite(root).analysis;
    for (const key of [
      "opaque_connected_components",
      "opaque_singleton_components",
      "color_components",
      "color_singleton_components",
    ] as const) {
      expect(empty[key]).toBe(0);
    }
    const image = readPng(filePath);
    setPixel(image, 0, 0, [96, 48, 16, 255]);
    setPixel(image, 1, 1, [64, 223, 224, 255]); // diagonal only -- not 4-connected to (0,0).
    writePng(filePath, image);
    expect(inspectSprite(root).analysis.opaque_connected_components).toBe(2);
  });

  it("hard-fails when a composited opaque pixel doesn't exactly match a declared palette entry", () => {
    const root = makeExport(dir, 2);
    const filePath = path.join(root, inspectSprite(root).filename);
    const image: RGBAImage = readPng(filePath);
    setPixel(image, 0, 0, [1, 2, 3, 255]); // not in ["#603010", "#40dfe0"]
    writePng(filePath, image);
    expect(() => inspectSprite(root)).toThrow(DomainError);
    expect(() => inspectSprite(root)).toThrow("Sprite contains opaque colors outside its declared shared palette");
  });

  it("reports the ASCII grid with zero-padded row labels and two-character palette tokens", () => {
    const root = makeExport(dir, 2);
    const result = inspectSprite(root);
    expect(result.grid.rows).toHaveLength(8);
    for (const row of result.grid.rows) {
      // "NN " + 8 two-character tokens space-joined.
      expect(row).toMatch(/^\d{2} (\.\.|[0-9A-F]{2})( (\.\.|[0-9A-F]{2})){7}$/);
    }
  });

  it("orders lowest_contrast_boundaries by ascending RGB distance", () => {
    const root = makeExport(dir, 2);
    const result = inspectSprite(root);
    const boundaries = result.analysis.lowest_contrast_boundaries;
    expect(boundaries.length).toBeGreaterThan(0);
    for (let i = 1; i < boundaries.length; i++) {
      expect(at(boundaries, i).rgb_distance).toBeGreaterThanOrEqual(at(boundaries, i - 1).rgb_distance);
    }
    const [a, b] = at(boundaries, 0).colors;
    expect(a < b).toBe(true); // symbols within a pair are always emitted low-to-high.
  });
});
