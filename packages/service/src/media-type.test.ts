import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { encodeApng } from "@pixel-art-mcp/imaging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { guessMediaType, readImageDimensions } from "./media-type.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-service-media-type-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("guessMediaType", () => {
  it("maps common extensions", () => {
    expect(guessMediaType("x.png")).toBe("image/png");
    expect(guessMediaType("x.apng")).toBe("image/apng");
    expect(guessMediaType("x.gif")).toBe("image/gif");
    expect(guessMediaType("x.json")).toBe("application/json");
    expect(guessMediaType("x.html")).toBe("text/html");
    expect(guessMediaType("x.zip")).toBe("application/zip");
  });

  it("falls back to application/octet-stream for unknown extensions", () => {
    expect(guessMediaType("x.bin")).toBe("application/octet-stream");
    expect(guessMediaType("x")).toBe("application/octet-stream");
  });
});

function minimalPng(width: number, height: number): Buffer {
  // A real, tiny 1-bit-deep grayscale PNG's IHDR chunk is enough for this test -- no need for a
  // full valid image; only the header bytes this module ever reads matter here.
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type (RGBA)
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  const type = Buffer.from("IHDR", "ascii");
  const crc = Buffer.alloc(4); // not verified by this module
  return Buffer.concat([signature, length, type, ihdrData, crc]);
}

describe("readImageDimensions", () => {
  it("reads PNG dimensions from the IHDR chunk header", () => {
    const filePath = path.join(dir, "x.png");
    writeFileSync(filePath, minimalPng(37, 21));
    expect(readImageDimensions(filePath)).toEqual({ width: 37, height: 21 });
  });

  it("reads real APNG dimensions produced by packages/imaging's own encoder", () => {
    const frame = { width: 12, height: 8, data: new Uint8Array(12 * 8 * 4) };
    const apng = encodeApng([frame], { delayMs: 100 });
    const filePath = path.join(dir, "x.apng");
    writeFileSync(filePath, apng);
    expect(readImageDimensions(filePath)).toEqual({ width: 12, height: 8 });
  });

  it("reads GIF dimensions from the logical screen descriptor", () => {
    const filePath = path.join(dir, "x.gif");
    const header = Buffer.alloc(10);
    header.write("GIF89a", 0, "ascii");
    header.writeUInt16LE(50, 6);
    header.writeUInt16LE(30, 8);
    writeFileSync(filePath, header);
    expect(readImageDimensions(filePath)).toEqual({ width: 50, height: 30 });
  });

  it("returns null for a file that isn't a recognized image header", () => {
    const filePath = path.join(dir, "x.json");
    writeFileSync(filePath, "{}");
    expect(readImageDimensions(filePath)).toBeNull();
  });
});
