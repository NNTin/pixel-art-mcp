import { describe, expect, it } from "vitest";
import { Canvas, PixelArt } from "./index.js";

describe("@pixel-art-mcp/pixel-core runtime protection", () => {
  it("freezes the Canvas constructor and its prototype", () => {
    expect(Object.isFrozen(Canvas)).toBe(true);
    expect(Object.isFrozen(Canvas.prototype)).toBe(true);
  });

  it("freezes the PixelArt constructor and its prototype", () => {
    expect(Object.isFrozen(PixelArt)).toBe(true);
    expect(Object.isFrozen(PixelArt.prototype)).toBe(true);
  });

  it("throws instead of silently succeeding when a script tries to replace a Canvas method", () => {
    expect(() => {
      // @ts-expect-error -- deliberately mutating a frozen prototype to prove it's rejected.
      Canvas.prototype.rect = () => "hijacked";
    }).toThrow(TypeError);
  });

  it("throws instead of silently succeeding when a script tries to add a static to Canvas", () => {
    expect(() => {
      // @ts-expect-error -- deliberately mutating the frozen constructor to prove it's rejected.
      Canvas.fromRows = () => "hijacked";
    }).toThrow(TypeError);
  });

  it("throws instead of silently succeeding when a script tries to replace a PixelArt method", () => {
    expect(() => {
      // @ts-expect-error -- deliberately mutating a frozen prototype to prove it's rejected.
      PixelArt.prototype.layer = () => "hijacked";
    }).toThrow(TypeError);
  });

  it("throws instead of silently succeeding when a script tries to add a static to PixelArt", () => {
    expect(() => {
      // @ts-expect-error -- deliberately mutating the frozen constructor to prove it's rejected.
      PixelArt.fromDict = () => "hijacked";
    }).toThrow(TypeError);
  });

  it("still lets normal code construct instances and call methods after freezing", () => {
    const canvas = new Canvas(2, 2).rect(0, 0, 2, 2, "D");
    expect(canvas.rows).toEqual(["DD", "DD"]);
    const art = new PixelArt({ D: "#000000", G: "#ffffff" }, { 0: [2, 2] });
    art.layer("body", 0, canvas);
    expect(art.poses(0, 1)).toHaveLength(1);
  });
});
