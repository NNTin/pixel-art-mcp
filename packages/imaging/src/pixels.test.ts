/**
 * Port of `tests/unit/test_pixels.py`. PIL's `ImageDraw.rectangle`/`getbbox`/`get_flattened_data`
 * have no equivalent here, so this file's `fillRectInclusive`/`bbox`/`flatten` helpers reimplement
 * exactly the semantics those tests rely on (inclusive both-endpoints fill, non-zero-region
 * bounding box, row-major RGBA tuples) rather than pulling in an imaging library.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { unzipSync } from "fflate";
import { DomainError, RenderOptionsSchema, renderOptionsFrames } from "@pixel-art-mcp/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parsePngChunks } from "./apng.js";
import { createImage, readPng, setPixel, writePng, type RGBAImage } from "./image.js";
import { at } from "./internal.js";
import {
  cellVote,
  exportSheet,
  packSprites,
  paletteFromSamples,
  pixelate,
  sampleSourceColors,
  type RenderManifestLike,
} from "./pixels.js";
import type { Rgb } from "./quantize.js";

function fillImage(
  width: number,
  height: number,
  color: readonly [number, number, number, number],
): RGBAImage {
  const image = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) setPixel(image, x, y, color);
  }
  return image;
}

/** PIL's `ImageDraw.rectangle((x0, y0, x1, y1))`: fills the inclusive box x0..x1, y0..y1. */
function fillRectInclusive(
  image: RGBAImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: readonly [number, number, number, number],
): void {
  for (let y = Math.max(0, y0); y <= Math.min(image.height - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(image.width - 1, x1); x++)
      setPixel(image, x, y, color);
  }
}

/** PIL's `Image.getbbox()`: the bounding box of pixels with any nonzero channel, or `null` if
 * every pixel is (0, 0, 0, 0) -- returned as [minX, minY, maxX+1, maxY+1], PIL's convention. */
function bbox(image: RGBAImage): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const offset = (y * image.width + x) * 4;
      if (
        image.data[offset] !== 0 ||
        image.data[offset + 1] !== 0 ||
        image.data[offset + 2] !== 0 ||
        image.data[offset + 3] !== 0
      ) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX === Infinity) return null;
  return [minX, minY, maxX + 1, maxY + 1];
}

function flatten(image: RGBAImage): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let i = 0; i < image.width * image.height; i++) {
    const offset = i * 4;
    out.push([
      at(image.data, offset),
      at(image.data, offset + 1),
      at(image.data, offset + 2),
      at(image.data, offset + 3),
    ]);
  }
  return out;
}

describe("pixelate", () => {
  it("shares one palette across frames, keeps alpha binary, and is deterministic", () => {
    const source: RGBAImage[] = [];
    for (const y of [2, 10]) {
      const im = fillImage(32, 32, [255, 0, 255, 0]);
      fillRectInclusive(im, 8, y, 20, y + 10, [255, 80, 10, 255]);
      source.push(im);
    }
    const options = RenderOptionsSchema.parse({ width: 16, height: 16, colors: 4 });
    const [result, palette] = pixelate(source, options);
    expect(palette.length).toBeLessThanOrEqual(4);
    const box0 = bbox(at(result, 0));
    const box1 = bbox(at(result, 1));
    expect(box0).not.toBeNull();
    expect(box1).not.toBeNull();
    expect(box0?.[1]).not.toBe(box1?.[1]);
    for (const im of result) {
      const alphas = new Set(flatten(im).map((p) => p[3]));
      for (const a of alphas) expect([0, 255]).toContain(a);
      expect(im.data.slice(0, 4)).toEqual(new Uint8Array([0, 0, 0, 0]));
      for (const [r, g, b, a] of flatten(im)) {
        if (a) {
          const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
          expect(palette).toContain(hex);
        }
      }
    }
    const [again, samePalette] = pixelate(source, options);
    expect(samePalette).toEqual(palette);
    expect(result.map((im) => Array.from(im.data))).toEqual(again.map((im) => Array.from(im.data)));
  });

  it("honors a fixed palette (nearest match) and leaves fully transparent frames empty", () => {
    const options = RenderOptionsSchema.parse({
      width: 8,
      height: 8,
      palette: ["#000000", "#ffffff"],
    });
    const [images, palette] = pixelate([fillImage(8, 8, [240, 240, 240, 255])], options);
    const firstImage = at(images, 0);
    expect([
      at(firstImage.data, 0),
      at(firstImage.data, 1),
      at(firstImage.data, 2),
      at(firstImage.data, 3),
    ]).toEqual([255, 255, 255, 255]);
    expect(palette).toEqual(["#000000", "#ffffff"]);

    const [transparentResult] = pixelate(
      [createImage(8, 8)],
      RenderOptionsSchema.parse({ width: 8, height: 8 }),
    );
    expect(bbox(at(transparentResult, 0))).toBeNull();
  });

  it("keeps stationary pixels stable while a distant region animates (supersampling=4)", () => {
    const frames: RGBAImage[] = [];
    for (let offset = 0; offset < 8; offset++) {
      const image = createImage(64, 128);
      for (let x = 8; x < 56; x++) {
        for (let y = 50; y <= 115; y++) setPixel(image, x, y, [100 + x, 80 + x, 40 + x, 255]);
      }
      fillRectInclusive(image, 8 + offset * 4, 4, 14 + offset * 4, 12, [70, 220, 250, 255]);
      frames.push(image);
    }
    const options = RenderOptionsSchema.parse({
      width: 16,
      height: 32,
      supersampling: 4,
      colors: 6,
    });
    const [images] = pixelate(frames, options);

    function cropBytes(im: RGBAImage, x0: number, y0: number, x1: number, y1: number): string {
      const bytes: number[] = [];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * im.width + x) * 4;
          bytes.push(at(im.data, o), at(im.data, o + 1), at(im.data, o + 2), at(im.data, o + 3));
        }
      }
      return bytes.join(",");
    }

    const bottomCrops = new Set(images.map((im) => cropBytes(im, 0, 16, 16, 32)));
    expect(bottomCrops.size).toBe(1);
    const topCrops = new Set(images.map((im) => cropBytes(im, 0, 0, 16, 8)));
    expect(topCrops.size).toBeGreaterThan(1);
  });

  it("uses exact source colors on downscale, not invented averages", () => {
    const source = fillImage(16, 16, [255, 0, 0, 255]);
    for (let x = 1; x < 16; x += 2) {
      for (let y = 0; y < 16; y++) setPixel(source, x, y, [0, 0, 255, 255]);
    }
    const options = RenderOptionsSchema.parse({
      width: 8,
      height: 8,
      angles: [0],
      supersampling: 2,
      colors: 2,
    });
    const [crisp, crispPalette] = pixelate([source], options);
    expect(new Set(crispPalette)).toEqual(new Set(["#ff0000", "#0000ff"]));
    for (const [r, g, b] of flatten(at(crisp, 0))) {
      const isRed = r === 255 && g === 0 && b === 0;
      const isBlue = r === 0 && g === 0 && b === 255;
      expect(isRed || isBlue).toBe(true);
    }
  });
});

describe("paletteFromSamples", () => {
  it("returns the fixed options.palette verbatim (as RGB tuples), ignoring samples", () => {
    const options = RenderOptionsSchema.parse({ palette: ["#010203", "#040506"] });
    const result = paletteFromSamples([[9, 9, 9]], options);
    expect(result).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it("returns a single black entry for an empty sample set", () => {
    const options = RenderOptionsSchema.parse({});
    expect(paletteFromSamples([], options)).toEqual([[0, 0, 0]]);
  });
});

describe("sampleSourceColors", () => {
  it("samples every pixel at budget >= pixel count and filters by the alpha threshold", () => {
    const image = createImage(2, 2);
    setPixel(image, 0, 0, [10, 20, 30, 255]);
    setPixel(image, 1, 0, [40, 50, 60, 0]); // below threshold -- excluded.
    setPixel(image, 0, 1, [70, 80, 90, 200]);
    setPixel(image, 1, 1, [1, 2, 3, 128]);
    const samples = sampleSourceColors(image, 4, 128);
    expect(samples).toEqual([
      [10, 20, 30],
      [70, 80, 90],
      [1, 2, 3],
    ]);
  });
});

describe("cellVote", () => {
  it("breaks a genuine alpha-weighted vote tie by the lowest palette index, not frame content", () => {
    // A 2x1 supersampled cell voting for two palette entries with EXACTLY equal alpha-weighted
    // support (128 apiece): entry 0 must win purely because it's the lower index, not because of
    // iteration order or magnitude.
    const palette: Rgb[] = [
      [10, 10, 10],
      [200, 200, 200],
    ];
    const source = createImage(2, 1);
    setPixel(source, 0, 0, [10, 10, 10, 128]); // classifies as palette[0], weight 128.
    setPixel(source, 1, 0, [200, 200, 200, 128]); // classifies as palette[1], weight 128.
    const result = cellVote(source, [1, 1], palette);
    expect([result.data[0], result.data[1], result.data[2]]).toEqual([10, 10, 10]);
  });

  it("picks the higher-vote label outright when the tie is broken by weight, not index", () => {
    const palette: Rgb[] = [
      [10, 10, 10],
      [200, 200, 200],
    ];
    const source = createImage(2, 1);
    setPixel(source, 0, 0, [10, 10, 10, 10]); // low weight.
    setPixel(source, 1, 0, [200, 200, 200, 250]); // higher weight, higher index -- must still win.
    const result = cellVote(source, [1, 1], palette);
    expect([result.data[0], result.data[1], result.data[2]]).toEqual([200, 200, 200]);
  });

  it("throws when the supersampling ratio isn't an exact integer", () => {
    const source = createImage(5, 4);
    expect(() => cellVote(source, [2, 2], [[0, 0, 0]])).toThrow("integer supersampling");
    expect(() => cellVote(source, [2, 2], [[0, 0, 0]])).toThrow(DomainError);
  });

  it("outputs (0,0,0) for a cell where every source pixel is fully transparent", () => {
    const source = createImage(2, 2); // all (0,0,0,0)
    const result = cellVote(source, [1, 1], [[9, 9, 9]]);
    expect(Array.from(result.data.slice(0, 3))).toEqual([9, 9, 9]); // winner defaults to index 0
    expect(result.data[3]).toBe(0); // box-downscaled alpha of an all-zero source is 0.
  });
});

describe("packSprites", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pixel-art-imaging-pack-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves converted pixels exactly and rejects incomplete/malformed frame sequences", () => {
    const options = RenderOptionsSchema.parse({ width: 8, height: 8, angles: [0] });
    const sprite = fillImage(8, 8, [100, 100, 100, 255]);
    setPixel(sprite, 0, 0, [101, 101, 101, 255]);
    const manifest: RenderManifestLike = {
      frames: [{ filename: "", angle: 0, frame: 1, pivot: [4, 7] }],
      camera: {},
    };
    const out = path.join(dir, "out");
    packSprites([sprite], ["#646464", "#656565"], out, manifest, options, "p", "r");
    const packed = readPng(path.join(out, "spritesheet.png"));
    expect(Array.from(packed.data)).toEqual(Array.from(sprite.data));

    expect(() => {
      packSprites([], [], path.join(dir, "bad1"), manifest, options, "p", "r");
    }).toThrow(/incomplete/);
    const wrongSize = createImage(7, 8); // wrong dimensions -- the "unexpected dimensions or color mode" guard.
    expect(() => {
      packSprites([wrongSize], [], path.join(dir, "bad2"), manifest, options, "p", "r");
    }).toThrow(/dimensions or color mode/);
  });
});

describe("exportSheet", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pixel-art-imaging-sheet-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("orders the sheet by angle/frame, writes exact metadata, and zips the whole export", () => {
    const raw = path.join(dir, "raw");
    mkdirSync(raw, { recursive: true });
    const options = RenderOptionsSchema.parse({
      width: 8,
      height: 8,
      supersampling: 1,
      angles: [0, 90],
      frame_start: 1,
      frame_end: 2,
      fps: 10,
    });
    const entries: { filename: string; angle: number; frame: number; pivot: [number, number] }[] =
      [];
    const angleFramePairs: [number, number][] = [
      [0, 1],
      [0, 2],
      [90, 1],
      [90, 2],
    ];
    angleFramePairs.forEach(([angle, frame], index) => {
      const name = `${String(index)}.png`;
      writePng(path.join(raw, name), fillImage(8, 8, [index * 60, 0, 0, 255]));
      entries.push({ filename: name, angle, frame, pivot: [4, 7] });
    });
    const manifest: RenderManifestLike = {
      frames: entries,
      camera: { projection: "orthographic" },
    };
    const out = path.join(dir, "export");
    exportSheet(raw, out, manifest, options, "project", "revision");

    const metadata = JSON.parse(readFileSync(path.join(out, "spritesheet.json"), "utf-8")) as {
      size: [number, number];
      frames: {
        rect: [number, number, number, number];
        pivot: [number, number];
        duration_ms: number;
      }[];
    };
    expect(metadata.size).toEqual([16, 16]);
    expect(metadata.frames.map((f) => f.rect)).toEqual([
      [0, 0, 8, 8],
      [8, 0, 8, 8],
      [0, 8, 8, 8],
      [8, 8, 8, 8],
    ]);
    for (const f of metadata.frames) {
      expect(f.pivot).toEqual([4, 7]);
      expect(f.duration_ms).toBe(100);
    }

    const archive = unzipSync(readFileSync(path.join(out, "sprites.zip")));
    const names = Object.keys(archive);
    expect(names).toContain("spritesheet.png");
    expect(names).toContain("preview.html");
    expect(names.filter((n) => n.startsWith("frames/"))).toHaveLength(4);
    expect(names.filter((n) => n.endsWith(".apng"))).toHaveLength(2);

    expect(() => {
      exportSheet(
        raw,
        path.join(dir, "bad"),
        { ...manifest, frames: entries.slice(0, 1) },
        options,
        "p",
        "r",
      );
    }).toThrow(/incomplete/);
  });

  it.each([2, 6])(
    "produces correctly timed/transparent APNG animations and an offline player (frame_end=%i)",
    (frameEnd) => {
      const raw = path.join(dir, `raw-${String(frameEnd)}`);
      mkdirSync(raw, { recursive: true });
      const options = RenderOptionsSchema.parse({
        width: 16,
        height: 8,
        supersampling: 1,
        angles: [90, 0],
        frame_start: 2,
        frame_end: frameEnd,
        frame_step: 2,
        fps: 12,
        palette: ["#ff0000", "#00ff00"],
      });
      const frames = renderOptionsFrames(options);
      const entries: { filename: string; angle: number; frame: number; pivot: [number, number] }[] =
        [];
      options.angles.forEach((angle, row) => {
        frames.forEach((frame, column) => {
          const name = `${String(row)}_${String(frame)}.png`;
          const im = createImage(16, 8);
          if (column !== 1) {
            fillRectInclusive(
              im,
              column * 4,
              2,
              column * 4 + 3,
              5,
              row === 0 ? [255, 0, 0, 255] : [0, 255, 0, 255],
            );
          }
          writePng(path.join(raw, name), im);
          entries.push({ filename: name, angle, frame, pivot: [8, 6] });
        });
      });
      const out = path.join(dir, `out-${String(frameEnd)}`);
      const manifest: RenderManifestLike = { frames: entries, camera: {} };
      exportSheet(raw, out, manifest, options, "p", "r");

      const metadata = JSON.parse(readFileSync(path.join(out, "spritesheet.json"), "utf-8")) as {
        directions: {
          angle: number;
          row: number;
          frame_indices: number[];
          animation: string | null;
        }[];
        frames: { filename: string; angle: number; frame: number }[];
        player: string;
      };

      metadata.directions.forEach((direction, row) => {
        expect(direction.angle).toBe(options.angles[row]);
        expect(direction.row).toBe(row);
        const frameNumbers = direction.frame_indices.map((i) => at(metadata.frames, i).frame);
        expect(frameNumbers).toEqual(frames);

        if (frames.length === 1) {
          expect(direction.animation).toBeNull();
          return;
        }
        const animationPath = direction.animation;
        expect(animationPath).not.toBeNull();
        if (animationPath === null) return;
        const apngBuffer = readFileSync(path.join(out, animationPath));
        const chunks = parsePngChunks(apngBuffer);
        const acTL = chunks.find((c) => c.type === "acTL");
        expect(acTL).toBeDefined();
        if (!acTL) return;
        expect(acTL.data.readUInt32BE(0)).toBe(direction.frame_indices.length);
        expect(acTL.data.readUInt32BE(4)).toBe(0); // loop=0
        const fcTLs = chunks.filter((c) => c.type === "fcTL");
        for (const fcTL of fcTLs) {
          expect(fcTL.data.readUInt8(24)).toBe(0); // dispose_op
          expect(fcTL.data.readUInt8(25)).toBe(0); // blend_op
          expect(fcTL.data.readUInt16BE(20)).toBe(Math.round(1000 / options.fps)); // delay numerator
        }
      });

      const html = readFileSync(path.join(out, metadata.player), "utf-8");
      const afterMarker = at(html.split("const data = ", 2), 1);
      const embedded = JSON.parse(at(afterMarker.split(";", 1), 0)) as {
        image: string;
        angles: number[];
        frames: number[];
        width: number;
        height: number;
      };
      expect(Buffer.from(embedded.image, "base64")).toEqual(
        readFileSync(path.join(out, "spritesheet.png")),
      );
      expect(embedded.angles).toEqual([90, 0]);
      expect(embedded.frames).toEqual(frames);
      expect(embedded.width).toBe(16);
      expect(embedded.height).toBe(8);
      expect(html).not.toContain("__PLAYER_DATA__");

      if (frames.length === 1) {
        expect(() => readFileSync(path.join(out, "preview.gif"))).toThrow();
      } else {
        expect(readFileSync(path.join(out, "preview.gif")).length).toBeGreaterThan(0);
        const archive = unzipSync(readFileSync(path.join(out, "sprites.zip")));
        expect(Object.keys(archive)).toContain("preview.gif");
      }
    },
  );
});
