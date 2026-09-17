/**
 * Hand-rolled APNG muxer: PNG `acTL`/`fcTL`/`fdAT` chunks stacked on top of per-frame `pngjs`
 * encoding, for exact `disposal_op`/`blend_op` control.
 *
 * Library choice (see `docs/typescript-rewrite.md`'s stack table and this package's final
 * report): `upng-js` was evaluated first, since it's a maintained pure-JS PNG/APNG encoder. Its
 * `UPNG.encode()` does support animated output, but its frame writer (`UPNG.js`, the
 * `frms.push(...)` loop around the `tlim`/`tarea` bounding-box search) is a *size-optimizing*
 * encoder: it diffs consecutive frames, shrinks each `fcTL` rect to the changed region, and
 * chooses `blend: 1` (APNG_BLEND_OP_OVER) over `blend: 0` (SOURCE) whenever that produces a
 * smaller file -- exactly the "ghost trail when an object shrinks or moves" failure mode
 * `docs/typescript-rewrite.md` calls out, and it exposes no public option to force full-frame
 * `SOURCE` writes. Given that, and per the plan's documented fallback, this module hand-rolls the
 * muxer instead, which guarantees every frame is disposal=0/blend=0/full-canvas, matching
 * Pillow's `save_all(disposal=0, blend=0)` (used by the Python source) exactly.
 *
 * Implementation: each frame is encoded as its own standalone PNG via `pngjs` (reusing its
 * filtering/deflate, which is already tested by `pngjs` itself), then that PNG's `IDAT` chunk
 * payload is reused verbatim -- as `IDAT` for frame 0, or prefixed with a 4-byte sequence number
 * as `fdAT` for every later frame -- which sidesteps re-implementing PNG filtering/compression.
 * Only `acTL`/`fcTL`/chunk-length-prefix/CRC32 framing (via `node:zlib`'s built-in `crc32`,
 * Node >= 21) is hand-written.
 *
 * `disposal=0` (APNG_DISPOSE_OP_NONE) vs. `gif.ts`'s `disposal=2` (GIF's restore-to-background)
 * are deliberately different encoders' defaults for the same underlying "don't leave ghost
 * trails" goal: dispose=0 works here because every frame is written blend=0/SOURCE (a full,
 * unblended repaint each frame already erases anything the previous frame left behind), whereas
 * GIF's `disposal=2` is what performs the equivalent "clear to background before the next frame"
 * job for a format with no SOURCE-blend option. Conflating the two would be a bug, not a
 * simplification -- see `docs/typescript-rewrite.md`.
 */

import zlib from "node:zlib";

import type { RGBAImage } from "./image.js";
import { encodePngBuffer } from "./image.js";
import { at, defined } from "./internal.js";

export interface PngChunk {
  type: string;
  data: Buffer;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Splits a PNG buffer into its raw chunks (type + payload, CRC verified implicitly by the
 * caller re-computing it on write). Exported so tests can inspect `acTL`/`fcTL` byte-for-byte. */
export function parsePngChunks(buffer: Buffer): PngChunk[] {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Not a PNG file (bad signature)");
  }
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = Buffer.from(buffer.subarray(offset + 8, offset + 8 + length));
    chunks.push({ type, data });
    offset += 12 + length;
  }
  return chunks;
}

function writeChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(crcInput) >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

export interface ApngOptions {
  /** Per-frame display duration, in milliseconds (matches Pillow's `duration=`). */
  delayMs: number;
  /** `fcTL.dispose_op`. Default 0 (APNG_DISPOSE_OP_NONE), matching the Python source. */
  disposeOp?: 0 | 1 | 2;
  /** `fcTL.blend_op`. Default 0 (APNG_BLEND_OP_SOURCE), matching the Python source. */
  blendOp?: 0 | 1;
}

/**
 * Encodes `frames` (all sharing one width/height) as an animated PNG. Every frame participates
 * in the animation directly (no separate hidden "default image" -- matching Pillow's default
 * `default_image=False`), so `acTL.num_frames === frames.length` and viewers see the same
 * sequence whether or not they understand `acTL`.
 */
export function encodeApng(frames: readonly RGBAImage[], options: ApngOptions): Buffer {
  if (frames.length === 0) throw new Error("encodeApng requires at least one frame");
  const first = at(frames, 0);
  if (frames.some((frame) => frame.width !== first.width || frame.height !== first.height)) {
    throw new Error("encodeApng requires every frame to share the same dimensions");
  }
  const disposeOp = options.disposeOp ?? 0;
  const blendOp = options.blendOp ?? 0;
  const delayNum = Math.max(0, Math.round(options.delayMs));
  const delayDen = 1000;

  const framePngs = frames.map((frame) => parsePngChunks(encodePngBuffer(frame)));
  const ihdr = defined(
    at(framePngs, 0).find((chunk) => chunk.type === "IHDR"),
    "pngjs IHDR chunk",
  );

  const parts: Buffer[] = [PNG_SIGNATURE, writeChunk("IHDR", ihdr.data)];

  if (frames.length > 1) {
    const acTL = Buffer.alloc(8);
    acTL.writeUInt32BE(frames.length, 0);
    acTL.writeUInt32BE(0, 4); // num_plays = 0: loop forever, matching Pillow's loop=0.
    parts.push(writeChunk("acTL", acTL));
  }

  let sequence = 0;
  framePngs.forEach((chunks, index) => {
    const idatPayload = Buffer.concat(
      chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data),
    );

    const fcTL = Buffer.alloc(26);
    fcTL.writeUInt32BE(sequence, 0);
    sequence += 1;
    fcTL.writeUInt32BE(first.width, 4);
    fcTL.writeUInt32BE(first.height, 8);
    fcTL.writeUInt32BE(0, 12); // x_offset
    fcTL.writeUInt32BE(0, 16); // y_offset
    fcTL.writeUInt16BE(delayNum, 20);
    fcTL.writeUInt16BE(delayDen, 22);
    fcTL.writeUInt8(disposeOp, 24);
    fcTL.writeUInt8(blendOp, 25);
    parts.push(writeChunk("fcTL", fcTL));

    if (index === 0) {
      parts.push(writeChunk("IDAT", idatPayload));
    } else {
      const fdAT = Buffer.alloc(4 + idatPayload.length);
      fdAT.writeUInt32BE(sequence, 0);
      sequence += 1;
      idatPayload.copy(fdAT, 4);
      parts.push(writeChunk("fdAT", fdAT));
    }
  });

  parts.push(writeChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}
