/**
 * Public surface of `@pixel-art-mcp/service`, Phase 6a: reference-image ingestion (upload +
 * SSRF-safe URL download) and chunked artifact delivery -- the two self-contained pieces the
 * rest of `packages/service` (project/job/revision orchestration, Phase 6b) will depend on. See
 * `references.ts`'s and `artifacts.ts`'s doc comments for what each ports and why.
 */

export {
  downloadReference,
  normalizeReference,
  publicTarget,
  type DnsLookup,
  type NormalizeReferenceResult,
  type PinnedTarget,
  type ReferenceLimits,
} from "./references.js";

export {
  MAX_ARTIFACT_CHUNK_BYTES,
  MAX_INLINE_ARTIFACT_BYTES,
  readArtifactChunk,
  type ArtifactChunk,
} from "./artifacts.js";

export { isGlobalAddress } from "./net/ip-range.js";
