/**
 * Port of `src/pixel_art_mcp/projects/artifacts.py`: bounded binary delivery for MCP clients
 * with no HTTP or resource-reading tools. A client fetches a large artifact by repeatedly
 * calling `readArtifactChunk` with the `next_offset` from the previous response until it comes
 * back `null` (EOF).
 */

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

import { DomainError, type Artifact } from "@pixel-art-mcp/schema";

export const MAX_INLINE_ARTIFACT_BYTES = 1_048_576;
export const MAX_ARTIFACT_CHUNK_BYTES = 262_144;

/** Wire shape returned by `readArtifactChunk`; field names match the Python `ArtifactChunk` model
 * verbatim since this is exactly what an MCP tool call returns to the client. */
export interface ArtifactChunk {
  artifact_id: string;
  filename: string;
  media_type: string;
  /** Total raw file size, not base64 length. */
  size_bytes: number;
  /** Starting raw byte offset of this chunk. */
  offset: number;
  bytes_read: number;
  /** Pass as offset for the next call; null means EOF. */
  next_offset: number | null;
  /** Decode each chunk separately, then concatenate raw bytes in offset order. */
  data_base64: string;
  /** SHA-256 hex digest of this chunk's decoded bytes, not the whole file. */
  sha256: string;
}

/**
 * Reads one bounded chunk of `path` on disk, validating it against `artifact`'s recorded
 * metadata. `offset`/`length` are typed `unknown` deliberately: this function is the last line
 * of defense against a dynamically-typed (e.g. JSON-decoded) caller passing a bool, float,
 * `NaN`, or out-of-range value -- exactly the case Python's `type(offset) is not int` guard
 * exists for, since a JS/JSON boolean or non-integer number would otherwise satisfy a merely
 * structural `number` check.
 *
 * Detects concurrent modification two ways: a changed `size_bytes` (409) and a short read that
 * doesn't match the expected byte count (409, "truncated"). `offset === size_bytes` is a valid
 * empty EOF chunk, not an error.
 */
export async function readArtifactChunk(
  filePath: string,
  artifact: Artifact,
  offset: unknown,
  length: unknown,
): Promise<ArtifactChunk> {
  if (
    typeof offset !== "number" ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < 1 ||
    length > MAX_ARTIFACT_CHUNK_BYTES
  ) {
    throw new DomainError("offset must be a nonnegative integer; length must be 1..262144 bytes");
  }

  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size !== artifact.size_bytes) {
      throw new DomainError("Artifact size changed; refusing inconsistent byte delivery", 409);
    }
    if (offset > artifact.size_bytes) {
      throw new DomainError("offset exceeds artifact size_bytes");
    }
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const data = buffer.subarray(0, bytesRead);
    const expected = Math.min(length, artifact.size_bytes - offset);
    if (bytesRead !== expected) {
      throw new DomainError("Artifact was truncated while reading", 409);
    }
    const end = offset + bytesRead;
    return {
      artifact_id: artifact.id,
      filename: artifact.filename,
      media_type: artifact.media_type,
      size_bytes: artifact.size_bytes,
      offset,
      bytes_read: bytesRead,
      next_offset: end < artifact.size_bytes ? end : null,
      data_base64: data.toString("base64"),
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}
