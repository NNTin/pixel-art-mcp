/**
 * Port of `tests/unit/test_pixel_art.py::test_budget_checks_final_ownership_clipping_and_connectivity`
 * (the only Python test that exercises `composite_features` with hand-authored patches rather
 * than a full `PixelArt` scene -- everything else in that file drives it through
 * `PixelArt.poses()`, which this package doesn't depend on, so the patches below are transcribed
 * literally from that test's `art.layer(...)` calls instead of constructed via `pixel-core`).
 */
import { describe, expect, it } from "vitest";

import {
  compositeFeatures,
  componentCount,
  connectedComponents,
  largestComponentSize,
  type FeaturePatch,
} from "./features.js";
import { createImage, getPixel } from "./image.js";

const PALETTE = { D: "#293039", G: "#f3cf65" };

describe("compositeFeatures", () => {
  it("reports final ownership, clipping, and connectivity after later patches overwrite earlier ones", () => {
    // art.layer("handle", 0, Canvas.from_rows(["GGGG"]), min_pixels=4, connected=True)
    // art.layer("occluder", 0, Canvas.from_rows(["DD"]), x=1)
    // art.layer("clipped", 0, Canvas.from_rows(["GG"]), x=-1, y=2)
    const patches: FeaturePatch[] = [
      { name: "handle", rows: ["GGGG"], x: 0, y: 0, min_pixels: 4, connected: true },
      { name: "occluder", rows: ["DD"], x: 1, y: 0, min_pixels: 0, connected: false },
      { name: "clipped", rows: ["GG"], x: -1, y: 2, min_pixels: 0, connected: false },
    ];
    const { image, reports } = compositeFeatures(createImage(16, 16), patches, PALETTE);

    // (0, 0) is only ever touched by "handle" -- G, #f3cf65.
    expect(getPixel(image, 0, 0)).toEqual([243, 207, 101, 255]);

    const handle = reports[0];
    expect(handle).toBeDefined();
    expect(handle?.authored_pixels).toBe(4);
    expect(handle?.visible_pixels).toBe(2); // (0,0) and (3,0) survive; (1,0)/(2,0) are overwritten.
    expect(handle?.overwritten_pixels).toBe(2);
    expect(handle?.clipped_pixels).toBe(0);
    // Two isolated surviving points -> 2 components -> connected=true still fails.
    expect(handle?.issues).toEqual(["feature_pixel_budget", "disconnected_feature"]);

    const clipped = reports[2];
    expect(clipped).toBeDefined();
    expect(clipped?.clipped_pixels).toBe(1); // (-1, 2) is off-canvas; (0, 2) survives.
    expect(clipped?.visible_pixels).toBe(1);
    expect(clipped?.issues).toEqual(["clipped_feature"]);
    expect(clipped?.bounds).toEqual([-1, 2, 2, 1]);
  });

  it("has no issues for a patch that fully lands, meets its budget, and stays connected", () => {
    const patches: FeaturePatch[] = [
      { name: "solid", rows: ["GGGG"], x: 0, y: 0, min_pixels: 4, connected: true },
    ];
    const { reports } = compositeFeatures(createImage(16, 16), patches, PALETTE);
    expect(reports[0]?.issues).toEqual([]);
    expect(reports[0]?.components).toBe(1);
  });

  it("throws on an unknown palette symbol, matching Python's colors[symbol] KeyError", () => {
    const patches: FeaturePatch[] = [
      { name: "bad", rows: ["X"], x: 0, y: 0, min_pixels: 0, connected: false },
    ];
    expect(() => compositeFeatures(createImage(4, 4), patches, PALETTE)).toThrow();
  });
});

describe("connectedComponents / componentCount / largestComponentSize", () => {
  it("groups four-neighbor-adjacent points and excludes diagonal neighbors", () => {
    const points = new Set(["0,0", "1,0", "0,1", "5,5", "9,9"]);
    const components = connectedComponents(points);
    const sizes = components.map((c) => c.size).sort((a, b) => a - b);
    expect(sizes).toEqual([1, 1, 3]);
    expect(componentCount(points)).toBe(3);
    expect(largestComponentSize(points)).toBe(3);
  });

  it("returns 0 for an empty point set (Python's max(..., default=0))", () => {
    expect(largestComponentSize(new Set())).toBe(0);
    expect(componentCount(new Set())).toBe(0);
  });
});
