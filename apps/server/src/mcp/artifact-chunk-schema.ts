/**
 * `@pixel-art-mcp/service`'s `ArtifactChunk` (`packages/service/src/artifacts.ts`) is a plain TS
 * interface, not built through `@pixel-art-mcp/schema`'s `Model`/`modelObject` pattern (see that
 * file's own doc comment) -- so, unlike `Artifact`/`Job`/`Project`/etc., the object it returns has
 * no `schema_version` field. Python's `ArtifactChunk(Model)` does inherit one (`schema_version:
 * Literal[1] = 1`, like every other `Model` subclass) and it appears in the tool's advertised
 * `outputSchema` and every response. Rather than reach into `packages/service` to add a field
 * that package's own design intentionally left out (see this phase's port of `Service`'s public
 * API in `job-executor.ts`'s doc comment, which is careful about not duplicating bookkeeping
 * another package already owns), this is a small MCP-layer-only schema/helper: the tool handler
 * spreads `schema_version: 1` onto the object it hands back, and this schema describes exactly
 * that shape for `registerTool`'s `outputSchema`.
 */

import { z } from "zod";

import { uuidParam } from "./params.js";

export const ArtifactChunkOutputSchema = z.object({
  schema_version: z.literal(1).default(1),
  artifact_id: uuidParam(),
  filename: z.string(),
  media_type: z.string(),
  size_bytes: z.number().int().describe("Total raw file size, not base64 length."),
  offset: z.number().int().describe("Starting raw byte offset of this chunk."),
  bytes_read: z.number().int(),
  next_offset: z
    .number()
    .int()
    .nullable()
    .describe("Pass as offset for the next call; null means EOF."),
  data_base64: z
    .string()
    .describe("Decode each chunk separately, then concatenate raw bytes in offset order."),
  sha256: z
    .string()
    .describe("SHA-256 hex digest of this chunk's decoded bytes, not the whole file."),
});
