/**
 * `saveAnimatedGif` writes a real GIF file via `gifenc`; there's no GIF decoder in this package's
 * dependency graph, so this test hand-parses just enough of the GIF89a structure (Graphic Control
 * Extension blocks, Application Extension, Image Descriptors) to verify the specific fidelity risk
 * flagged in gif.ts's doc comment: the disposal method actually written is 2 (restore-to-
 * background), matching Python's `disposal=2` -- and specifically *not* conflated with apng.ts's
 * `disposeOp: 0`, which means something different for a different encoder.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saveAnimatedGif } from "./gif.js";
import { createImage, setPixel, type RGBAImage } from "./image.js";

interface GraphicControlExtension {
  disposalMethod: number;
  transparentColorFlag: boolean;
  delayCentiseconds: number;
  transparentColorIndex: number;
}

interface ParsedGif {
  loopCount: number | null;
  graphicControlExtensions: GraphicControlExtension[];
  imageDescriptorCount: number;
  globalColorTableSize: number;
}

/** Minimal GIF89a parser covering exactly what this test needs: the Application Extension's loop
 * count, each frame's Graphic Control Extension, and a count of Image Descriptor blocks. Skips
 * over LZW-compressed image data via its sub-block length-prefix framing without decompressing. */
function parseGif(buffer: Buffer): ParsedGif {
  if (buffer.toString("ascii", 0, 6) !== "GIF89a" && buffer.toString("ascii", 0, 6) !== "GIF87a") {
    throw new Error("Not a GIF file");
  }
  const packedFields = buffer.readUInt8(10);
  const globalColorTableFlag = (packedFields & 0x80) !== 0;
  const globalColorTableSize = globalColorTableFlag ? 2 << (packedFields & 0x07) : 0;
  let offset = 13 + (globalColorTableFlag ? globalColorTableSize * 3 : 0);

  let loopCount: number | null = null;
  const graphicControlExtensions: GraphicControlExtension[] = [];
  let imageDescriptorCount = 0;

  function skipSubBlocks(start: number): number {
    let pos = start;
    for (;;) {
      const size = buffer.readUInt8(pos);
      pos += 1;
      if (size === 0) return pos;
      pos += size;
    }
  }

  while (offset < buffer.length) {
    const marker = buffer.readUInt8(offset);
    if (marker === 0x3b) break; // Trailer.
    if (marker === 0x21) {
      const label = buffer.readUInt8(offset + 1);
      if (label === 0xf9) {
        // Graphic Control Extension: 0x21 0xF9 <block size=4> <packed> <delay:2> <transparent idx> 0x00
        const packed = buffer.readUInt8(offset + 3);
        graphicControlExtensions.push({
          disposalMethod: (packed >> 2) & 0x07,
          transparentColorFlag: (packed & 0x01) !== 0,
          delayCentiseconds: buffer.readUInt16LE(offset + 4),
          transparentColorIndex: buffer.readUInt8(offset + 6),
        });
        offset += 8;
      } else if (label === 0xff) {
        // Application Extension. NETSCAPE2.0's sub-block is [0x03, 0x01, loopLo, loopHi].
        const blockSize = buffer.readUInt8(offset + 2);
        const appId = buffer.toString("ascii", offset + 3, offset + 3 + 11);
        const pos = offset + 2 + blockSize + 1;
        if (appId === "NETSCAPE2.0") {
          const subBlockSize = buffer.readUInt8(pos);
          if (subBlockSize === 3) loopCount = buffer.readUInt16LE(pos + 2);
        }
        offset = skipSubBlocks(pos);
      } else {
        offset = skipSubBlocks(offset + 2);
      }
    } else if (marker === 0x2c) {
      imageDescriptorCount += 1;
      const localPacked = buffer.readUInt8(offset + 9);
      const localColorTableFlag = (localPacked & 0x80) !== 0;
      const localColorTableSize = localColorTableFlag ? 2 << (localPacked & 0x07) : 0;
      let pos = offset + 10 + localColorTableSize * 3;
      pos += 1; // LZW minimum code size byte.
      offset = skipSubBlocks(pos);
    } else {
      throw new Error(`Unrecognized GIF block marker 0x${marker.toString(16)} at offset ${String(offset)}`);
    }
  }
  return { loopCount, graphicControlExtensions, imageDescriptorCount, globalColorTableSize };
}

function solid(width: number, height: number, color: readonly [number, number, number, number]): RGBAImage {
  const image = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) setPixel(image, x, y, color);
  }
  return image;
}

describe("saveAnimatedGif", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pixel-art-imaging-gif-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes disposal=2 (restore-to-background) on every frame, loops forever, and reserves a transparent slot", () => {
    const red = solid(2, 2, [255, 0, 0, 255]);
    const green = createImage(2, 2);
    setPixel(green, 0, 0, [0, 255, 0, 255]);
    // (1, 1) stays fully transparent -- exercises the reserved transparency palette slot.
    const filePath = path.join(dir, "preview.gif");

    saveAnimatedGif([red, green], ["#ff0000", "#00ff00"], 10, filePath);

    const parsed = parseGif(readFileSync(filePath));
    expect(parsed.imageDescriptorCount).toBe(2);
    expect(parsed.loopCount).toBe(0); // loop=0: infinite, matching Pillow's loop=0.
    expect(parsed.graphicControlExtensions).toHaveLength(2);
    for (const gce of parsed.graphicControlExtensions) {
      // The exact risk flagged in gif.ts's doc comment: GIF's disposal=2 must never be conflated
      // with APNG's disposeOp=0 -- they are deliberately different encoders' defaults.
      expect(gce.disposalMethod).toBe(2);
      expect(gce.transparentColorFlag).toBe(true);
      expect(gce.transparentColorIndex).toBe(2); // len(palette) == 2: reserved slot index.
      // duration=1000/fps=100ms -> 10 centiseconds.
      expect(gce.delayCentiseconds).toBe(10);
    }
  });

  it("uses a global color table sized to include the reserved transparent slot", () => {
    const filePath = path.join(dir, "preview.gif");
    saveAnimatedGif(
      [solid(1, 1, [10, 20, 30, 255]), solid(1, 1, [40, 50, 60, 255])],
      ["#0a141e", "#28323c", "#ff00ff"],
      5,
      filePath,
    );
    const parsed = parseGif(readFileSync(filePath));
    // 3 declared colors + 1 reserved transparency slot = 4 -> next power of two >= 4 is 4.
    expect(parsed.globalColorTableSize).toBeGreaterThanOrEqual(4);
  });

  it("creates parent directories that don't exist yet", () => {
    const filePath = path.join(dir, "nested", "deep", "preview.gif");
    saveAnimatedGif([solid(1, 1, [1, 2, 3, 255]), solid(1, 1, [4, 5, 6, 255])], ["#010203", "#040506"], 5, filePath);
    expect(readFileSync(filePath).length).toBeGreaterThan(0);
  });
});
