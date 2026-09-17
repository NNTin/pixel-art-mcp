/**
 * Decodes `encodeApng`'s own output back (via the module's exported `parsePngChunks`) and checks
 * the exact byte-level framing this phase was scoped to guard against: `fcTL.dispose_op`/
 * `blend_op` must be 0/0 (SOURCE, no disposal -- see apng.ts's doc comment for why: `upng-js` was
 * rejected precisely because it silently picks `blend=1` for smaller files), `acTL.num_frames`
 * must match, and `fdAT` sequence numbers must be correctly interleaved and monotonically
 * increasing. There's no Python test file for this (Pillow's encoder is trusted, opaque C code;
 * this hand-rolled muxer is the actual fidelity risk this phase exists to cover).
 */
import zlib from "node:zlib";

import { describe, expect, it } from "vitest";

import { encodeApng, parsePngChunks, type PngChunk } from "./apng.js";
import { createImage, decodePngBuffer, setPixel, type RGBAImage } from "./image.js";
import { at } from "./internal.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function writeChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

interface DecodedFrame {
  fcTLSequence: number;
  delayNum: number;
  delayDen: number;
  disposeOp: number;
  blendOp: number;
  image: RGBAImage;
  fdATSequences: number[];
}

/** Reassembles each `fcTL` + its following `IDAT`/`fdAT` run into a standalone decodable PNG,
 * stripping `fdAT`'s 4-byte sequence-number prefix -- the inverse of `encodeApng`'s own framing. */
function decodeApng(buffer: Buffer): {
  ihdr: PngChunk;
  acTL: { numFrames: number; loop: number } | null;
  frames: DecodedFrame[];
} {
  const chunks = parsePngChunks(buffer);
  const ihdrChunk = chunks.find((c) => c.type === "IHDR");
  if (!ihdrChunk) throw new Error("no IHDR chunk");
  const ihdr = ihdrChunk;
  const ihdrData = ihdrChunk.data;
  const acTLChunk = chunks.find((c) => c.type === "acTL");
  const acTL = acTLChunk
    ? { numFrames: acTLChunk.data.readUInt32BE(0), loop: acTLChunk.data.readUInt32BE(4) }
    : null;

  const frames: DecodedFrame[] = [];
  let currentFcTL: PngChunk | null = null;
  let idatParts: Buffer[] = [];
  let fdATSequences: number[] = [];

  function flush(): void {
    if (!currentFcTL) return;
    const framePng = Buffer.concat([
      PNG_SIGNATURE,
      writeChunk("IHDR", ihdrData),
      writeChunk("IDAT", Buffer.concat(idatParts)),
      writeChunk("IEND", Buffer.alloc(0)),
    ]);
    const fc = currentFcTL.data;
    frames.push({
      fcTLSequence: fc.readUInt32BE(0),
      delayNum: fc.readUInt16BE(20),
      delayDen: fc.readUInt16BE(22),
      disposeOp: fc.readUInt8(24),
      blendOp: fc.readUInt8(25),
      image: decodePngBuffer(framePng),
      fdATSequences,
    });
    currentFcTL = null;
    idatParts = [];
    fdATSequences = [];
  }

  for (const chunk of chunks) {
    if (chunk.type === "fcTL") {
      flush();
      currentFcTL = chunk;
    } else if (chunk.type === "IDAT" && currentFcTL) {
      idatParts.push(chunk.data);
    } else if (chunk.type === "fdAT" && currentFcTL) {
      fdATSequences.push(chunk.data.readUInt32BE(0));
      idatParts.push(chunk.data.subarray(4));
    }
  }
  flush();
  return { ihdr, acTL, frames };
}

function solid(width: number, height: number, color: readonly [number, number, number, number]): RGBAImage {
  const image = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) setPixel(image, x, y, color);
  }
  return image;
}

describe("encodeApng", () => {
  it("round-trips exact RGBA pixel data for every frame, decoded back through its own chunks", () => {
    const red = solid(4, 4, [255, 0, 0, 255]);
    // A frame with a transparent hole -- the exact "newly transparent pixel" case blend=1 (OVER)
    // would leave as a ghost trail; blend=0 (SOURCE) must erase it cleanly.
    const greenWithHole = createImage(4, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        if (x === 1 && y === 1) continue; // stays (0,0,0,0)
        setPixel(greenWithHole, x, y, [0, 255, 0, 255]);
      }
    }
    const blue = solid(4, 4, [0, 0, 255, 255]);
    const frames = [red, greenWithHole, blue];

    const buffer = encodeApng(frames, { delayMs: 200 });
    const decoded = decodeApng(buffer);

    expect(decoded.acTL).toEqual({ numFrames: 3, loop: 0 });
    expect(decoded.frames).toHaveLength(3);

    decoded.frames.forEach((frame, index) => {
      expect(frame.image.width).toBe(4);
      expect(frame.image.height).toBe(4);
      expect(Array.from(frame.image.data)).toEqual(Array.from(at(frames, index).data));
      // The specific risk this phase guards against: every frame must be a full, unblended
      // repaint (SOURCE) with no disposal -- not upng-js's size-optimizing blend=1/OVER default.
      expect(frame.disposeOp).toBe(0);
      expect(frame.blendOp).toBe(0);
      expect(frame.delayNum).toBe(200);
      expect(frame.delayDen).toBe(1000);
    });

    // Sequence numbers: fcTL(0) IDAT, fcTL(1) fdAT(2), fcTL(3) fdAT(4) -- strictly increasing,
    // one consumed per fcTL and per fdAT, none reused, none skipped.
    expect(at(decoded.frames, 0).fcTLSequence).toBe(0);
    expect(at(decoded.frames, 0).fdATSequences).toEqual([]);
    expect(at(decoded.frames, 1).fcTLSequence).toBe(1);
    expect(at(decoded.frames, 1).fdATSequences).toEqual([2]);
    expect(at(decoded.frames, 2).fcTLSequence).toBe(3);
    expect(at(decoded.frames, 2).fdATSequences).toEqual([4]);

    const allSequences = decoded.frames.flatMap((f) => [f.fcTLSequence, ...f.fdATSequences]);
    expect(allSequences).toEqual([...allSequences].sort((a, b) => a - b));
    expect(new Set(allSequences).size).toBe(allSequences.length);
  });

  it("rounds delayMs to the nearest integer numerator over a 1000 denominator", () => {
    const frames = [solid(2, 2, [1, 2, 3, 255]), solid(2, 2, [4, 5, 6, 255])];
    const decoded = decodeApng(encodeApng(frames, { delayMs: 83.6 }));
    expect(at(decoded.frames, 0).delayNum).toBe(84);
    expect(at(decoded.frames, 0).delayDen).toBe(1000);
  });

  it("honors explicit non-default disposeOp/blendOp overrides", () => {
    const frames = [solid(2, 2, [1, 2, 3, 255]), solid(2, 2, [4, 5, 6, 255])];
    const decoded = decodeApng(encodeApng(frames, { delayMs: 50, disposeOp: 1, blendOp: 1 }));
    for (const frame of decoded.frames) {
      expect(frame.disposeOp).toBe(1);
      expect(frame.blendOp).toBe(1);
    }
  });

  it("throws when given no frames", () => {
    expect(() => encodeApng([], { delayMs: 100 })).toThrow("at least one frame");
  });

  it("throws when frames have mismatched dimensions", () => {
    const frames = [createImage(4, 4), createImage(4, 5)];
    expect(() => encodeApng(frames, { delayMs: 100 })).toThrow("same dimensions");
  });
});
