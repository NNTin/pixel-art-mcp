/**
 * A minimal RGBA raster image type, plus the handful of pixel operations the rest of this
 * package needs (`features.ts`/`pixels.ts`/`gif.ts`/`apng.ts`/`context.ts`/`inspection.ts`).
 *
 * There is no PIL/Pillow equivalent in the TypeScript stack, so instead of porting a general
 * imaging library this module implements exactly the operations Python's source files use:
 * `Image.new("RGBA", ...)`, `putpixel`/`getpixel`, mask-less `paste` (full overwrite, no alpha
 * blending -- every call site in the ported Python always pastes without a mask), nearest-
 * neighbor resize (`Image.Resampling.NEAREST`), and a box-filter downscale for exact integer
 * ratios (`Image.Resampling.BOX`, used only by `pixels.ts`'s `cellVote` alpha channel).
 *
 * Storage matches `pngjs`'s own `PNG.data` layout exactly (interleaved 8-bit RGBA, row-major),
 * so encoding/decoding is a direct pass-through with no repacking.
 */

import fs from "node:fs";
import path from "node:path";

import { PNG } from "pngjs";

import { at } from "./internal.js";

export interface RGBAImage {
  readonly width: number;
  readonly height: number;
  /** Interleaved RGBA bytes, row-major, length === width * height * 4. */
  readonly data: Uint8Array;
}

export type Rgba = readonly [number, number, number, number];

/** `Image.new("RGBA", (width, height))`: fully transparent black by default. */
export function createImage(width: number, height: number): RGBAImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function cloneImage(image: RGBAImage): RGBAImage {
  return { width: image.width, height: image.height, data: Uint8Array.from(image.data) };
}

export function getPixel(image: RGBAImage, x: number, y: number): Rgba {
  const offset = (y * image.width + x) * 4;
  return [
    image.data[offset] ?? 0,
    image.data[offset + 1] ?? 0,
    image.data[offset + 2] ?? 0,
    image.data[offset + 3] ?? 0,
  ];
}

/** `Image.putpixel`: unconditional overwrite of one pixel, including alpha. */
export function setPixel(image: RGBAImage, x: number, y: number, color: Rgba): void {
  const offset = (y * image.width + x) * 4;
  image.data[offset] = color[0];
  image.data[offset + 1] = color[1];
  image.data[offset + 2] = color[2];
  image.data[offset + 3] = color[3];
}

/**
 * `dst.paste(src, (x, y))` with no mask: every source pixel unconditionally overwrites the
 * destination pixel underneath it (including alpha -- no blending), clipped to the overlap
 * between `src`'s placed rectangle and `dst`'s bounds (matching PIL's own silent clipping).
 */
export function pasteFull(dst: RGBAImage, src: RGBAImage, x: number, y: number): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dst.width) continue;
      const srcOffset = (sy * src.width + sx) * 4;
      const dstOffset = (dy * dst.width + dx) * 4;
      dst.data[dstOffset] = at(src.data, srcOffset);
      dst.data[dstOffset + 1] = at(src.data, srcOffset + 1);
      dst.data[dstOffset + 2] = at(src.data, srcOffset + 2);
      dst.data[dstOffset + 3] = at(src.data, srcOffset + 3);
    }
  }
}

/**
 * `dst.paste(src.crop((sx, sy, sx + sw, sy + sh)), (dx, dy))`: copies a rectangular region of
 * `src` into `dst` at `(dx, dy)`, no blending (same last-writer-wins semantics as `pasteFull`),
 * clipped to both images' bounds on both the source-read and destination-write side.
 */
export function pasteCrop(
  dst: RGBAImage,
  src: RGBAImage,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
): void {
  for (let y = 0; y < sh; y++) {
    const srcY = sy + y;
    const dstY = dy + y;
    if (srcY < 0 || srcY >= src.height || dstY < 0 || dstY >= dst.height) continue;
    for (let x = 0; x < sw; x++) {
      const srcX = sx + x;
      const dstX = dx + x;
      if (srcX < 0 || srcX >= src.width || dstX < 0 || dstX >= dst.width) continue;
      const srcOffset = (srcY * src.width + srcX) * 4;
      const dstOffset = (dstY * dst.width + dstX) * 4;
      dst.data[dstOffset] = at(src.data, srcOffset);
      dst.data[dstOffset + 1] = at(src.data, srcOffset + 1);
      dst.data[dstOffset + 2] = at(src.data, srcOffset + 2);
      dst.data[dstOffset + 3] = at(src.data, srcOffset + 3);
    }
  }
}

/** `image.resize((w, h), Image.Resampling.NEAREST)`. */
export function resizeNearest(image: RGBAImage, newWidth: number, newHeight: number): RGBAImage {
  const output = createImage(newWidth, newHeight);
  for (let y = 0; y < newHeight; y++) {
    // PIL's NEAREST sampling: source coordinate is the pixel center mapped back, floored.
    const sy = Math.min(image.height - 1, Math.floor(((y + 0.5) * image.height) / newHeight));
    for (let x = 0; x < newWidth; x++) {
      const sx = Math.min(image.width - 1, Math.floor(((x + 0.5) * image.width) / newWidth));
      const srcOffset = (sy * image.width + sx) * 4;
      const dstOffset = (y * newWidth + x) * 4;
      output.data[dstOffset] = at(image.data, srcOffset);
      output.data[dstOffset + 1] = at(image.data, srcOffset + 1);
      output.data[dstOffset + 2] = at(image.data, srcOffset + 2);
      output.data[dstOffset + 3] = at(image.data, srcOffset + 3);
    }
  }
  return output;
}

/**
 * `image.thumbnail((maxSize, maxSize), Image.Resampling.NEAREST)`: downscale in place to fit
 * within a `maxSize` x `maxSize` box, preserving aspect ratio; a no-op if already within bounds.
 */
export function thumbnailNearest(image: RGBAImage, maxSize: number): RGBAImage {
  const largest = Math.max(image.width, image.height);
  if (largest <= maxSize) return image;
  const scale = maxSize / largest;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  return resizeNearest(image, width, height);
}

/**
 * Exact-integer-ratio box downscale of one channel (alpha only -- the sole caller,
 * `pixels.ts::cellVote`, matches Python's `alpha.resize(size, Image.Resampling.BOX)`). Each
 * output pixel is the plain mean of its `sx` x `sy` source block, which is what PIL's box filter
 * reduces to for an exact integer ratio.
 */
export function boxDownscaleAlpha(
  source: RGBAImage,
  outWidth: number,
  outHeight: number,
  sx: number,
  sy: number,
): Uint8Array {
  const result = new Uint8Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let sum = 0;
      for (let dy = 0; dy < sy; dy++) {
        const rowStart = (y * sy + dy) * source.width + x * sx;
        for (let i = 0; i < sx; i++) sum += at(source.data, (rowStart + i) * 4 + 3);
      }
      result[y * outWidth + x] = Math.round(sum / (sx * sy));
    }
  }
  return result;
}

/** `image.save(path, format="PNG")` / `Image.open(path)`, via `pngjs`. Always decodes to RGBA
 * (pngjs normalizes every source color type to RGBA on read, matching `.convert("RGBA")`). */
export function encodePngBuffer(image: RGBAImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png);
}

export function decodePngBuffer(buffer: Buffer): RGBAImage {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

export function writePng(filePath: string, image: RGBAImage): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, encodePngBuffer(image));
}

export function readPng(filePath: string): RGBAImage {
  return decodePngBuffer(fs.readFileSync(filePath));
}

/** `candidate_path.is_relative_to(root)` -- used by the render-output path-traversal guards. */
export function isWithinDirectory(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
