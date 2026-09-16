import { describe, expect, it } from "vitest";
import { Canvas } from "./index.js";

describe("Canvas", () => {
  describe("constructor", () => {
    it("rejects out-of-range dimensions", () => {
      expect(() => new Canvas(0, 4)).toThrow("Canvas dimensions must be in 1..512");
      expect(() => new Canvas(4, 0)).toThrow("Canvas dimensions must be in 1..512");
      expect(() => new Canvas(513, 4)).toThrow("Canvas dimensions must be in 1..512");
      expect(() => new Canvas(4, 513)).toThrow("Canvas dimensions must be in 1..512");
    });

    it("accepts the boundary dimensions", () => {
      expect(new Canvas(1, 1).rows).toEqual(["."]);
      expect(new Canvas(512, 1).rows).toHaveLength(1);
    });

    it("starts fully transparent", () => {
      const canvas = new Canvas(3, 2);
      expect(canvas.rows).toEqual(["...", "..."]);
    });
  });

  describe("fromRows", () => {
    it("rejects an empty list of rows", () => {
      expect(() => Canvas.fromRows([])).toThrow(
        "Pixel rows must form a nonempty rectangle; row 0 must not be empty",
      );
    });

    it("rejects an empty row 0", () => {
      expect(() => Canvas.fromRows([""])).toThrow(
        "Pixel rows must form a nonempty rectangle; row 0 must not be empty",
      );
    });

    it("rejects ragged rows with per-row detail, capped at 8, plus a remaining count", () => {
      const rows = ["DD", "D", "DDD", "D", "D", "D", "D", "D", "D", "D"];
      expect(() => Canvas.fromRows(rows)).toThrow(
        "Pixel rows must form a nonempty rectangle. row 1: expected 2, actual 1; " +
          "row 2: expected 2, actual 3; row 3: expected 2, actual 1; row 4: expected 2, actual 1; " +
          "row 5: expected 2, actual 1; row 6: expected 2, actual 1; row 7: expected 2, actual 1; " +
          "row 8: expected 2, actual 1; 1 more mismatched rows. " +
          "Row indices are zero-based; use numeric drawing commands for long shapes.",
      );
    });

    it("delegates the >512 dimension check to the constructor", () => {
      expect(() => Canvas.fromRows(["D".repeat(513)])).toThrow(
        "Canvas dimensions must be in 1..512",
      );
    });

    it("builds a canvas whose pixels match the given rows", () => {
      const canvas = Canvas.fromRows(["DG", ".D"]);
      expect(canvas.width).toBe(2);
      expect(canvas.height).toBe(2);
      expect(canvas.rows).toEqual(["DG", ".D"]);
    });
  });

  describe("rect", () => {
    it("rejects a non-single-character color or a negative argument", () => {
      expect(() => new Canvas(4, 4).rect(0, 0, 1, 1, "DD")).toThrow(
        "Use a palette symbol and nonnegative integer rectangle",
      );
      expect(() => new Canvas(4, 4).rect(-1, 0, 1, 1, "D")).toThrow(
        "Use a palette symbol and nonnegative integer rectangle",
      );
    });

    it("rejects a rectangle that exceeds the canvas", () => {
      expect(() => new Canvas(4, 4).rect(2, 0, 3, 1, "D")).toThrow("Rectangle exceeds canvas");
      expect(() => new Canvas(4, 4).rect(0, 2, 1, 3, "D")).toThrow("Rectangle exceeds canvas");
    });

    it("fills the given area and returns the canvas for chaining", () => {
      const canvas = new Canvas(4, 3);
      const result = canvas.rect(1, 1, 2, 2, "D");
      expect(result).toBe(canvas);
      expect(canvas.rows).toEqual(["....", ".DD.", ".DD."]);
    });
  });

  describe("stamp", () => {
    it("rejects a stamp that exceeds the canvas", () => {
      expect(() => new Canvas(2, 2).stamp(-1, 0, ["D"])).toThrow("Stamp exceeds canvas");
      expect(() => new Canvas(2, 2).stamp(0, 0, ["DDD"])).toThrow("Stamp exceeds canvas");
    });

    it("overwrites only non-transparent patch pixels, leaving the rest untouched", () => {
      const canvas = new Canvas(3, 3).rect(0, 0, 3, 3, "D");
      canvas.stamp(1, 1, ["G."]);
      expect(canvas.rows).toEqual(["DDD", "DGD", "DDD"]);
    });
  });

  describe("mirrored", () => {
    it("reverses every row", () => {
      const canvas = Canvas.fromRows(["DG.", "..G"]);
      expect(canvas.mirrored().rows).toEqual([".GD", "G.."]);
    });
  });

  describe("line", () => {
    it("rejects a non-single-character color or non-integer coordinates", () => {
      expect(() => new Canvas(4, 4).line(0, 0, 2, 2, "DD")).toThrow(
        "Use integer line coordinates and a palette symbol",
      );
      expect(() => new Canvas(4, 4).line(0.5, 0, 2, 2, "D")).toThrow(
        "Use integer line coordinates and a palette symbol",
      );
    });

    it("rejects coordinates outside the canvas", () => {
      expect(() => new Canvas(4, 4).line(0, 0, 4, 2, "D")).toThrow("Line exceeds canvas");
      expect(() => new Canvas(4, 4).line(-1, 0, 2, 2, "D")).toThrow("Line exceeds canvas");
    });

    it("draws an exact horizontal/vertical/diagonal integer Bresenham line", () => {
      expect(new Canvas(4, 1).line(0, 0, 3, 0, "D").rows).toEqual(["DDDD"]);
      expect(new Canvas(1, 4).line(0, 0, 0, 3, "D").rows).toEqual(["D", "D", "D", "D"]);
      expect(new Canvas(4, 4).line(0, 0, 3, 3, "D").rows).toEqual([
        "D...",
        ".D..",
        "..D.",
        "...D",
      ]);
    });

    it("returns the canvas for chaining", () => {
      const canvas = new Canvas(2, 2);
      expect(canvas.line(0, 0, 1, 1, "D")).toBe(canvas);
    });
  });
});
