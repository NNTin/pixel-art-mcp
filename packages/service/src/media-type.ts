/**
 * Small local helpers `Service.artifactRecord`/the job executor need that don't belong to any
 * existing package: guessing a media type from a filename (port of Python's
 * `mimetypes.guess_type` call in `artifact_record`, plus its explicit `.apng` override) and
 * reading an image's pixel dimensions from just its header bytes (port of `PIL.Image.open(path).size`,
 * which likewise never decodes full pixel data just to read `width`/`height`).
 *
 * This intentionally does not import `packages/imaging`'s PNG decoder for this: decoding an
 * entire image just to read two header integers would be strictly more work than Python's
 * `Image.open().size` ever did, and `packages/imaging` has no public "just the dimensions"
 * export. `.png`/`.apng` (an ordinary PNG with extra ancillary chunks -- IHDR, which carries
 * width/height, is always the very first chunk after the 8-byte signature in *any* valid PNG,
 * animated or not) and `.gif` (a fixed 13-byte header: 6-byte magic, then a little-endian
 * `uint16` width/height pair) both have their dimensions at a fixed, tiny offset, so a bounded
 * header read is enough -- no new dependency needed.
 */

import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";

const MEDIA_TYPES_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".apng": "image/apng",
  ".gif": "image/gif",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
  // Python never emits these (its generated script is `.py`, real-mapped to `text/x-python` by
  // `mimetypes`); TS's generated/submitted script is `.ts`, a case Python has no equivalent for.
  // Flagged: this is a reasonable, not byte-parity-tested, choice.
  ".ts": "text/plain",
  ".py": "text/x-python",
};

/** Port of `artifact_record`'s `media_type` expression. */
export function guessMediaType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".apng") return "image/apng";
  return MEDIA_TYPES_BY_EXTENSION[ext] ?? "application/octet-stream";
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF_MAGIC = [0x47, 0x49, 0x46]; // "GIF"

/**
 * Reads `width`/`height` from a PNG/APNG's `IHDR` chunk or a GIF's logical screen descriptor,
 * without decoding any pixel data. Returns `null` for anything else (matching the Python source,
 * which only ever calls `Image.open` for `.png`/`.apng`/`.gif` artifacts -- see the job executor's
 * artifact-walking loop).
 */
export function readImageDimensions(filePath: string): { width: number; height: number } | null {
  const fd = openSync(filePath, "r");
  try {
    const header = Buffer.alloc(26);
    const bytesRead = readSync(fd, header, 0, 26, 0);
    if (bytesRead >= 24 && PNG_SIGNATURE.every((byte, index) => header[index] === byte)) {
      return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
    }
    if (bytesRead >= 10 && GIF_MAGIC.every((byte, index) => header[index] === byte)) {
      return { width: header.readUInt16LE(6), height: header.readUInt16LE(8) };
    }
    return null;
  } finally {
    closeSync(fd);
  }
}
