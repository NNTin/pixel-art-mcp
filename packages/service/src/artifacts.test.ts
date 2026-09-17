/**
 * Port of the artifact-delivery behavior exercised (at the MCP layer) by
 * `tests/integration/test_artifact_delivery.py` -- this package only ports `read_artifact_chunk`
 * itself (Phase 6a), not the MCP tool wiring around it (Phase 7), so these tests call it
 * directly rather than through a tool-call harness.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DomainError, type Artifact } from "@pixel-art-mcp/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_ARTIFACT_CHUNK_BYTES,
  MAX_INLINE_ARTIFACT_BYTES,
  readArtifactChunk,
} from "./artifacts.js";

// `node:fs/promises`' ESM module namespace can't be spied on directly ("Module namespace is not
// configurable in ESM") -- this wraps `open` in a `vi.fn` that passes through to the real
// implementation by default, so exactly one test below can swap in a one-shot truncated-read
// implementation via `mockImplementationOnce` while every other test keeps using the real
// filesystem untouched. (No outer-scope variable is captured in the factory itself -- `vi.mock`
// calls are hoisted above any such declaration, so the real implementation is re-fetched via
// `vi.importActual` inside the one test that needs it instead.)
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-service-artifacts-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeArtifact(overrides: Partial<Artifact> & { size_bytes: number }): Artifact {
  return {
    schema_version: 1,
    id: "11111111-1111-1111-1111-111111111111",
    project_id: "22222222-2222-2222-2222-222222222222",
    job_id: null,
    kind: "test",
    filename: "artifact.bin",
    media_type: "application/octet-stream",
    width: null,
    height: null,
    download_url: "",
    export_path: "",
    ...overrides,
  };
}

function writeFixture(name: string, data: Buffer): { filePath: string; artifact: Artifact } {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, data);
  return { filePath, artifact: makeArtifact({ size_bytes: data.length, filename: name }) };
}

describe("constants", () => {
  it("match the Python-ported byte limits", () => {
    expect(MAX_INLINE_ARTIFACT_BYTES).toBe(1_048_576);
    expect(MAX_ARTIFACT_CHUNK_BYTES).toBe(262_144);
  });
});

describe("readArtifactChunk", () => {
  it("delivers a small file across bounded chunks, with per-chunk sha256 and EOF at next_offset null", async () => {
    const data = Buffer.from("PK\x03\x04\x00\xff\x81binary", "binary");
    const { filePath, artifact } = writeFixture("sprites.zip", data);

    let offset: number | null = 0;
    const decoded: Buffer[] = [];
    while (offset !== null) {
      const chunk = await readArtifactChunk(filePath, artifact, offset, 5);
      const raw = Buffer.from(chunk.data_base64, "base64");
      expect(chunk.offset).toBe(offset);
      expect(chunk.bytes_read).toBe(raw.length);
      expect(chunk.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
      expect(chunk.size_bytes).toBe(data.length);
      expect(chunk.artifact_id).toBe(artifact.id);
      expect(chunk.filename).toBe(artifact.filename);
      expect(chunk.media_type).toBe(artifact.media_type);
      decoded.push(raw);
      offset = chunk.next_offset;
    }
    expect(Buffer.concat(decoded)).toEqual(data);
  });

  it("handles an empty artifact as an immediate EOF chunk", async () => {
    const { filePath, artifact } = writeFixture("empty.zip", Buffer.alloc(0));
    const chunk = await readArtifactChunk(filePath, artifact, 0, 5);
    expect(chunk.bytes_read).toBe(0);
    expect(chunk.next_offset).toBeNull();
    expect(chunk.data_base64).toBe("");
  });

  it("bounds every chunk to the requested length and reassembles a large file exactly", async () => {
    const pattern = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const buffer = Buffer.alloc(pattern.length * 4097);
    for (let i = 0; i < 4097; i++) pattern.copy(buffer, i * pattern.length);
    const { filePath, artifact } = writeFixture("large.zip", buffer);

    let offset: number | null = 0;
    const parts: Buffer[] = [];
    while (offset !== null) {
      const chunk = await readArtifactChunk(filePath, artifact, offset, MAX_ARTIFACT_CHUNK_BYTES);
      const raw = Buffer.from(chunk.data_base64, "base64");
      expect(raw.length).toBeLessThanOrEqual(MAX_ARTIFACT_CHUNK_BYTES);
      expect(chunk.bytes_read).toBe(raw.length);
      parts.push(raw);
      offset = chunk.next_offset;
    }
    expect(Buffer.concat(parts)).toEqual(buffer);

    const eof = await readArtifactChunk(filePath, artifact, buffer.length, 5);
    expect(eof.bytes_read).toBe(0);
    expect(eof.next_offset).toBeNull();
    expect(eof.data_base64).toBe("");
  }, 20_000); // Reads/hashes/base64-encodes ~1MB across many small chunks; can run slower under
  // full-suite parallel CI load than the default 5s per-test timeout allows.

  it.each([
    ["negative offset", { offset: -1, length: 5 }],
    ["boolean offset", { offset: true as unknown, length: 5 }],
    ["fractional offset", { offset: 1.5, length: 5 }],
    ["zero length", { offset: 0, length: 0 }],
    ["length over the cap", { offset: 0, length: MAX_ARTIFACT_CHUNK_BYTES + 1 }],
    ["boolean length", { offset: 0, length: true as unknown }],
    ["fractional length", { offset: 0, length: 1.5 }],
  ])("rejects invalid byte ranges: %s", async (_name, { offset, length }) => {
    const { filePath, artifact } = writeFixture("tiny.zip", Buffer.from("abc"));
    await expect(readArtifactChunk(filePath, artifact, offset, length)).rejects.toThrow(
      DomainError,
    );
  });

  it("rejects an offset beyond the recorded size", async () => {
    const { filePath, artifact } = writeFixture("tiny.zip", Buffer.from("abc"));
    await expect(readArtifactChunk(filePath, artifact, 4, 5)).rejects.toThrow(
      "offset exceeds artifact size_bytes",
    );
  });

  it("allows offset === size_bytes as a valid empty EOF read, not an error", async () => {
    const { filePath, artifact } = writeFixture("tiny.zip", Buffer.from("abc"));
    const chunk = await readArtifactChunk(filePath, artifact, 3, 5);
    expect(chunk.bytes_read).toBe(0);
    expect(chunk.next_offset).toBeNull();
  });

  it("refuses delivery when the on-disk file changed size since the artifact record was made", async () => {
    const { filePath, artifact } = writeFixture("changed.zip", Buffer.from("abc"));
    writeFileSync(filePath, Buffer.from("abcd"));
    await expect(readArtifactChunk(filePath, artifact, 0, 5)).rejects.toThrow(
      "Artifact size changed; refusing inconsistent byte delivery",
    );
  });

  it("rejects a missing artifact file", async () => {
    const artifact = makeArtifact({ size_bytes: 3, filename: "missing.zip" });
    await expect(
      readArtifactChunk(path.join(dir, "does-not-exist.zip"), artifact, 0, 5),
    ).rejects.toThrow();
  });

  it("reports a 409 when the underlying read returns fewer bytes than the size check promised", async () => {
    const { filePath, artifact } = writeFixture("racy.zip", Buffer.from("abcdefgh"));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const realRead = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(
        async (...readArgs: Parameters<typeof realRead>) => {
          const result = await realRead(...readArgs);
          return { ...result, bytesRead: Math.max(0, result.bytesRead - 1) };
        },
      );
      return handle;
    });
    await expect(readArtifactChunk(filePath, artifact, 0, 5)).rejects.toThrow(
      "Artifact was truncated while reading",
    );
  });
});
