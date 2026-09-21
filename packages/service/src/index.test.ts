import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  isGlobalAddress,
  MAX_ARTIFACT_CHUNK_BYTES,
  normalizeReference,
  readArtifactChunk,
} from "./index.js";

// End-to-end smoke test of the package's public surface: normalize a real uploaded PNG through
// the exported `normalizeReference`, then deliver the resulting `image.png` artifact byte-for-
// byte through the exported `readArtifactChunk` -- proving the two Phase 6a pieces (reference
// ingestion, chunked delivery) compose the way a real Phase 6b service layer will use them.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-service-index-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("@pixel-art-mcp/service public surface", () => {
  it("normalizes an uploaded reference, then delivers it byte-for-byte via chunked reads", async () => {
    const png = await sharp({
      create: { width: 12, height: 8, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .png()
      .toBuffer();

    const result = await normalizeReference(new Uint8Array(png), dir, {
      maxUploadBytes: 1024 * 1024,
      maxImagePixels: 1024 * 1024,
    });
    expect(result.width).toBe(12);
    expect(result.height).toBe(8);
    expect(result.extension).toBe("png");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

    const imagePath = path.join(dir, "image.png");
    const artifact = {
      schema_version: 1 as const,
      id: "11111111-1111-1111-1111-111111111111",
      project_id: "22222222-2222-2222-2222-222222222222",
      job_id: null,
      kind: "reference",
      filename: "image.png",
      media_type: "image/png",
      size_bytes: (await sharp(imagePath).png().toBuffer()).length,
      width: result.width,
      height: result.height,
      download_url: "",
      export_path: "",
    };
    // Re-derive the real on-disk size rather than trusting a second encode.
    const { statSync, readFileSync } = await import("node:fs");
    artifact.size_bytes = statSync(imagePath).size;
    const onDisk = readFileSync(imagePath);

    let offset: number | null = 0;
    const decoded: Buffer[] = [];
    while (offset !== null) {
      const chunk = await readArtifactChunk(imagePath, artifact, offset, MAX_ARTIFACT_CHUNK_BYTES);
      decoded.push(Buffer.from(chunk.data_base64, "base64"));
      offset = chunk.next_offset;
    }
    expect(Buffer.concat(decoded)).toEqual(onDisk);
  });

  it("rejects a loopback address as a public reference target", () => {
    expect(isGlobalAddress("127.0.0.1")).toBe(false);
  });
});
