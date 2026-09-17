/**
 * `context.py` has no dedicated Python test file (its `BACKGROUND_COLOR`/`luma`/`context_geometry`
 * helpers are only exercised indirectly, inside `test_pixel_art.py`'s rain-barrel example tests,
 * which depend on `asset_export.py` -- Phase 5b-ii's territory). These tests instead check the
 * fully-ported (non-stubbed) pieces of `context.ts` directly against `context.py`'s source
 * formulas.
 */
import { describe, expect, it } from "vitest";

import {
  BACKGROUND_COLOR,
  contextGeometry,
  contextImage,
  luma,
  referenceAgent,
} from "./context.js";
import { createImage, getPixel } from "./image.js";

describe("luma", () => {
  it("matches the standard Rec. 709 luma coefficients", () => {
    expect(luma([255, 255, 255])).toBeCloseTo(255, 5);
    expect(luma([0, 0, 0])).toBe(0);
    expect(luma(BACKGROUND_COLOR)).toBeCloseTo(0.2126 * 0x34 + 0.7152 * 0x3e + 0.0722 * 0x42, 5);
  });
});

describe("referenceAgent", () => {
  it("produces a 16x32 RGBA image with the schematic figure's colors present", () => {
    const agent = referenceAgent();
    expect(agent.width).toBe(16);
    expect(agent.height).toBe(32);
    // (5, 8): inside the skin-colored head box (y 3..12) but below the hair box drawn over it
    // (y 2..5), so it's still the skin color -- boxes are painted in order, later wins.
    expect(getPixel(agent, 5, 8)).toEqual([0xdb, 0xaa, 0x79, 255]);
    expect(getPixel(agent, 5, 4)).toEqual([0x52, 0x3b, 0x35, 255]); // hair box overwrites here.
    expect(getPixel(agent, 0, 0)).toEqual([0, 0, 0, 0]); // outside every box: still transparent.
  });
});

describe("contextGeometry", () => {
  const layout = { angle: 0, width: 32, height: 48, background_tiles: 1 };

  it("centers non-furniture (character/pet) on a fixed stage position", () => {
    const geometry = contextGeometry("character", layout, "npc", 0);
    expect(geometry).toEqual({
      x: 80 - Math.floor(layout.width / 2),
      y: 96 - layout.height,
      agent_x: 104,
      agent_y: 64,
      agent_in_front: true,
    });
  });

  it("derives furniture seat/agent placement from ground/background geometry", () => {
    const geometry = contextGeometry("furniture", layout, "decor", 0);
    expect(geometry.x).toBe(48);
    expect(geometry.y).toBe(32);
    expect(geometry.agent_x).toBe(48 + layout.width + 16);
    expect(geometry.agent_y).toBe(32 + layout.height - 32);
    expect(geometry.seat_x).toBe(48 + Math.floor(layout.width / 2) - 8);
    const seatY = 32 + layout.background_tiles * 16 + 8;
    expect(geometry.seat_y).toBe(seatY - 32); // category !== "chairs": no +6 offset.
    expect(geometry.seat_in_front).toBe(true);
  });

  it("adds the chair seat-height offset and flips seat_in_front only for chairs facing 180", () => {
    const front = contextGeometry("furniture", layout, "chairs", 0);
    const back = contextGeometry("furniture", layout, "chairs", 180);
    const seatY = 32 + layout.background_tiles * 16 + 8;
    expect(front.seat_y).toBe(seatY + 6 - 32);
    expect(front.seat_in_front).toBe(true);
    expect(back.seat_in_front).toBe(false); // chairs at 180 degrees: the seat back occludes.
  });
});

describe("contextImage", () => {
  it("renders a stage at least as large as the sprite plus margins, with the sprite pasted at its geometry position", () => {
    const layout = { angle: 0, width: 16, height: 16, background_tiles: 0 };
    const sprite = createImage(16, 16);
    // Paint the sprite fully opaque red so we can find it in the composited stage.
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) sprite.data[(y * 16 + x) * 4 + 0] = 255;
    }
    for (let i = 3; i < sprite.data.length; i += 4) sprite.data[i] = 255; // alpha=255 everywhere.

    const stage = contextImage(
      sprite,
      { kind: "furniture", category: "decor", placement: "floor" },
      layout,
    );
    expect(stage.width).toBeGreaterThanOrEqual(layout.width + 96);
    expect(stage.height).toBeGreaterThanOrEqual(layout.height + 80);
    // The sprite was pasted at geometry.x=48, geometry.y=32 (furniture, background_tiles=0).
    expect(getPixel(stage, 48, 32)).toEqual([255, 0, 0, 255]);
    // A background-only corner should be the floor color (no grid line at (1,1)).
    expect(getPixel(stage, 1, 1)).toEqual([...BACKGROUND_COLOR, 255]);
  });
});
