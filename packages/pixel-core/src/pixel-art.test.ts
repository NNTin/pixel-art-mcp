import { describe, expect, it } from "vitest";
import { Canvas, PixelArt } from "./index.js";
import type { AssetLayout, AssetValidationSpec, Scene } from "./index.js";

const PALETTE = { D: "#293039", G: "#f3cf65" };

describe("PixelArt constructor", () => {
  it("rejects a palette outside 2..64 entries", () => {
    expect(() => new PixelArt({ D: "#293039" }, { 0: [16, 16] })).toThrow(
      "Use 2..64 single-symbol #rrggbb palette entries; reserve '.'",
    );
  });

  it("rejects a palette with a reserved '.' symbol", () => {
    expect(() => new PixelArt({ ".": "#000000", D: "#ffffff" }, { 0: [16, 16] })).toThrow(
      "Use 2..64 single-symbol #rrggbb palette entries; reserve '.'",
    );
  });

  it("rejects a palette with a multi-character symbol or a malformed color", () => {
    expect(() => new PixelArt({ DD: "#000000", G: "#ffffff" }, { 0: [16, 16] })).toThrow(
      "Use 2..64 single-symbol #rrggbb palette entries; reserve '.'",
    );
    expect(() => new PixelArt({ D: "black", G: "#ffffff" }, { 0: [16, 16] })).toThrow(
      "Use 2..64 single-symbol #rrggbb palette entries; reserve '.'",
    );
  });

  it("rejects duplicate palette colors, case-insensitively", () => {
    expect(() => new PixelArt({ D: "#ABCDEF", G: "#abcdef" }, { 0: [16, 16] })).toThrow(
      "Palette colors must be distinct",
    );
  });

  it("rejects an empty views map", () => {
    expect(() => new PixelArt(PALETTE, {})).toThrow(
      "Declare each consumer view and its native canvas",
    );
  });

  it("rejects a view with an invalid angle", () => {
    expect(() => new PixelArt(PALETTE, { 45: [16, 16] })).toThrow(
      "Declare each consumer view and its native canvas",
    );
  });

  it("rejects a view whose size isn't 2 in-range integers", () => {
    expect(() => new PixelArt(PALETTE, { 0: [16, 16, 16] })).toThrow(
      "Declare each consumer view and its native canvas",
    );
    expect(() => new PixelArt(PALETTE, { 0: [0, 16] })).toThrow(
      "Declare each consumer view and its native canvas",
    );
    expect(() => new PixelArt(PALETTE, { 0: [16, 513] })).toThrow(
      "Declare each consumer view and its native canvas",
    );
    expect(() => new PixelArt(PALETTE, { 0: [16.5, 16] })).toThrow(
      "Declare each consumer view and its native canvas",
    );
  });

  it("lowercases palette colors and stores views by string angle", () => {
    const art = new PixelArt({ D: "#ABCDEF", G: "#123456" }, { 0: [16, 32] });
    expect(art.palette).toEqual({ D: "#abcdef", G: "#123456" });
    expect(art.views).toEqual({ "0": [16, 32] });
  });
});

describe("PixelArt.layer", () => {
  it("rejects an empty or overlong name, or an undeclared view", () => {
    const art = new PixelArt(PALETTE, { 0: [16, 16] });
    expect(() => art.layer("", 0, Canvas.fromRows(["D"]))).toThrow(
      "Layer needs a name and a declared view",
    );
    expect(() => art.layer("x".repeat(101), 0, Canvas.fromRows(["D"]))).toThrow(
      "Layer needs a name and a declared view",
    );
    expect(() => art.layer("body", 90, Canvas.fromRows(["D"]))).toThrow(
      "Layer needs a name and a declared view",
    );
  });

  it("rejects non-integer offsets/budget or a negative budget", () => {
    const art = new PixelArt(PALETTE, { 0: [16, 16] });
    expect(() => art.layer("body", 0, Canvas.fromRows(["D"]), { x: 1.5 })).toThrow(
      "Offsets and pixel budgets must be integers",
    );
    expect(() => art.layer("body", 0, Canvas.fromRows(["D"]), { y: 1.5 })).toThrow(
      "Offsets and pixel budgets must be integers",
    );
    expect(() => art.layer("body", 0, Canvas.fromRows(["D"]), { min_pixels: -1 })).toThrow(
      "Offsets and pixel budgets must be integers",
    );
  });

  it("rejects an invalid pose frame", () => {
    const art = new PixelArt(PALETTE, { 0: [16, 16] });
    expect(() => art.layer("body", 0, Canvas.fromRows(["D"]), { frame: -1 })).toThrow(
      "Invalid pose frame",
    );
    expect(() => art.layer("body", 0, Canvas.fromRows(["D"]), { frame: 1_000_001 })).toThrow(
      "Invalid pose frame",
    );
    expect(() => art.layer("body", 0, Canvas.fromRows(["D"]), { frame: 1.5 })).toThrow(
      "Invalid pose frame",
    );
  });

  it("rejects an unknown palette symbol", () => {
    const art = new PixelArt(PALETTE, { 0: [16, 16] });
    expect(() => art.layer("bad", 0, Canvas.fromRows(["X"]))).toThrow(
      "Unknown palette symbol in pixel layer",
    );
  });

  it("allows the transparent '.' symbol", () => {
    const art = new PixelArt(PALETTE, { 0: [16, 16] });
    expect(() => art.layer("body", 0, Canvas.fromRows(["D."]))).not.toThrow();
  });

  it("returns the PixelArt instance for chaining", () => {
    const art = new PixelArt(PALETTE, { 0: [16, 16] });
    expect(art.layer("body", 0, Canvas.fromRows(["D"]))).toBe(art);
  });

  it("replaces an existing pose at the same (angle, frame), keeping others", () => {
    const art = new PixelArt(PALETTE, { 0: [16, 16] });
    art.layer("body", 0, Canvas.fromRows(["D"]));
    art.layer("body", 0, Canvas.fromRows(["G"]));
    expect(art.layers).toHaveLength(1);
    const [layer] = art.layers;
    expect(layer?.poses).toHaveLength(1);
    expect(layer?.poses[0]?.rows).toEqual(["G"]);
  });
});

describe("PixelArt.poses: exact-frame-or-default resolution", () => {
  it("resolves the default pose, an exact-frame pose, and no pose for an unauthored angle", () => {
    const art = new PixelArt(PALETTE, { 0: [16, 32] });
    art.layer("body", 0, new Canvas(4, 4).rect(0, 0, 4, 4, "D"));
    art.layer("tap", 0, Canvas.fromRows(["GGG", ".G."]), { frame: 2, x: 3 });
    art.layer("body", 0, Canvas.fromRows(["DD"]), { frame: 2 });

    expect(art.poses(0, 1).map((p) => p.name)).toEqual(["body"]);
    const framedPoses = art.poses(0, 2);
    expect(framedPoses[0]?.rows).toEqual(["DD"]);
    expect(framedPoses[1]?.x).toBe(3);
    expect(art.poses(90, 2)).toEqual([]);
  });
});

describe("PixelArt.toDict / fromDict / save / load", () => {
  it("round-trips through toDict/fromDict and save/load", () => {
    const art = new PixelArt(PALETTE, { 0: [16, 32] });
    art.layer("body", 0, new Canvas(4, 4).rect(0, 0, 4, 4, "D"));
    art.layer("tap", 0, Canvas.fromRows(["GGG", ".G."]), { frame: 2, x: 3 });
    art.layer("body", 0, Canvas.fromRows(["DD"]), { frame: 2 });

    const scene: Scene = {};
    art.save(scene);
    expect(typeof scene["pixel_art"]).toBe("string");
    const restored = PixelArt.load(scene);
    expect(restored.toDict()).toEqual(art.toDict());
    expect(restored.poses(0, 1).map((p) => p.name)).toEqual(["body"]);
    expect(restored.poses(0, 2)[0]?.rows).toEqual(["DD"]);
    expect(restored.poses(0, 2)[1]?.x).toBe(3);
  });

  it("toDict emits the exact wire shape (version/palette/views/layers, snake_case keys)", () => {
    const art = new PixelArt(PALETTE, { 0: [16, 16] });
    art.layer("body", 0, Canvas.fromRows(["D"]));
    expect(art.toDict()).toEqual({
      version: 1,
      palette: { D: "#293039", G: "#f3cf65" },
      views: { "0": [16, 16] },
      layers: [
        {
          name: "body",
          poses: [
            { angle: 0, frame: null, rows: ["D"], x: 0, y: 0, min_pixels: 0, connected: false },
          ],
        },
      ],
    });
  });

  it("fromDict rejects an unsupported version", () => {
    expect(() => {
      PixelArt.fromDict({ version: 2, palette: PALETTE, views: { "0": [16, 16] }, layers: [] });
    }).toThrow("Unsupported pixel art version");
  });

  it("fromDict re-validates every stored pose (rejects a corrupted unknown-symbol pose)", () => {
    expect(() =>
      PixelArt.fromDict({
        version: 1,
        palette: PALETTE,
        views: { "0": [16, 16] },
        layers: [
          {
            name: "body",
            poses: [
              {
                angle: 0,
                frame: null,
                rows: ["X"],
                x: 0,
                y: 0,
                min_pixels: 0,
                connected: false,
              },
            ],
          },
        ],
      }),
    ).toThrow("Unknown palette symbol in pixel layer");
  });

  it("toDict returns independent copies (mutating the result never mutates internal state)", () => {
    const art = new PixelArt(PALETTE, { 0: [16, 16] });
    art.layer("body", 0, Canvas.fromRows(["D"]));
    const dict = art.toDict();
    const [layer] = dict.layers;
    if (!layer) throw new Error("expected toDict() to have produced a layer");
    const [pose] = layer.poses;
    if (!pose) throw new Error("expected toDict() to have produced a pose");
    pose.rows[0] = "MUTATED";
    dict.palette["D"] = "#ffffff";
    expect(art.toDict().layers[0]?.poses[0]?.rows).toEqual(["D"]);
    expect(art.palette["D"]).toBe("#293039");
  });
});

describe("PixelArt.validateTarget", () => {
  const layouts: AssetLayout[] = [{ angle: 0, width: 16, height: 16 }];
  const spec: AssetValidationSpec = { outline: false, colors: 8, palette: null };

  function inkedArt(): PixelArt {
    const art = new PixelArt(PALETTE, { 0: [16, 16] });
    art.layer("body", 0, Canvas.fromRows(["D"]));
    return art;
  }

  it("accepts a fully authored, matching definition", () => {
    const art = inkedArt();
    expect(() => {
      art.validateTarget(layouts, [1], spec);
    }).not.toThrow();
  });

  it("rejects mismatched views with a Python-dict-style repr of the expected views", () => {
    const art = new PixelArt(PALETTE, { 90: [16, 16] });
    art.layer("body", 90, Canvas.fromRows(["D"]));
    expect(() => {
      art.validateTarget(layouts, [1], spec);
    }).toThrow("Pixel views must match the configured canvases: {'0': [16, 16]}");
  });

  it("orders the expected-views repr by layouts order, not ascending numeric key order", () => {
    const art = new PixelArt(PALETTE, { 0: [16, 16] });
    art.layer("body", 0, Canvas.fromRows(["D"]));
    const outOfOrderLayouts: AssetLayout[] = [
      { angle: 90, width: 8, height: 8 },
      { angle: 0, width: 16, height: 16 },
    ];
    expect(() => {
      art.validateTarget(outOfOrderLayouts, [1], spec);
    }).toThrow("Pixel views must match the configured canvases: {'90': [8, 8], '0': [16, 16]}");
  });

  it("rejects when spec.outline is true", () => {
    const art = inkedArt();
    expect(() => {
      art.validateTarget(layouts, [1], { ...spec, outline: true });
    }).toThrow("Draw outlines in pixel rows; configure_asset.outline must be false");
  });

  it("rejects when the palette exceeds spec.colors", () => {
    const art = inkedArt();
    expect(() => {
      art.validateTarget(layouts, [1], { ...spec, colors: 1 });
    }).toThrow("Pixel palette exceeds configure_asset.colors");
  });

  it("rejects when spec.palette doesn't match the authored palette", () => {
    const art = inkedArt();
    expect(() => {
      art.validateTarget(layouts, [1], { ...spec, palette: ["#000000", "#ffffff"] });
    }).toThrow("Pixel palette must match configure_asset.palette");
  });

  it("accepts a matching spec.palette (case-insensitively)", () => {
    const art = inkedArt();
    expect(() => {
      art.validateTarget(layouts, [1], { ...spec, palette: ["#293039", "#F3CF65"] });
    }).not.toThrow();
  });

  it("rejects a definition with no layers", () => {
    const art = new PixelArt(PALETTE, { 0: [16, 16] });
    expect(() => {
      art.validateTarget(layouts, [1], spec);
    }).toThrow("A pixel-art definition with named layers is required");
  });

  it("rejects a definition whose layers contain no authored ink", () => {
    const art = new PixelArt(PALETTE, { 0: [16, 16] });
    art.layer("body", 0, Canvas.fromRows(["."]));
    expect(() => {
      art.validateTarget(layouts, [1], spec);
    }).toThrow("Pixel layers must contain authored ink");
  });

  it("rejects a pose patch that exceeds its view dimensions, naming the offending layer", () => {
    const art = new PixelArt(PALETTE, { 0: [4, 4] });
    art.layer("wide body", 0, Canvas.fromRows(["DDDDD"]));
    expect(() => {
      art.validateTarget([{ angle: 0, width: 4, height: 4 }], [1], spec);
    }).toThrow("Patch in 'wide body' exceeds its view dimensions");
  });

  it("rejects a missing pose at a declared (angle, frame)", () => {
    const art = new PixelArt(PALETTE, { 0: [16, 16] });
    art.layer("body", 0, Canvas.fromRows(["D"]), { frame: 1 });
    expect(() => {
      art.validateTarget(layouts, [2], spec);
    }).toThrow("Missing pixel pose at angle 0, frame 2; add a default or exact-frame pose");
  });

  it("rejects a pose whose ink falls entirely out of the view bounds", () => {
    const art = new PixelArt(PALETTE, { 0: [4, 4] });
    art.layer("offscreen", 0, Canvas.fromRows(["D"]), { x: 10, y: 10 });
    expect(() => {
      art.validateTarget([{ angle: 0, width: 4, height: 4 }], [1], spec);
    }).toThrow("Empty pose at angle 0, frame 1");
  });
});
